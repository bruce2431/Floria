/**
 * localGateway.ts —— 内置私有化网关（feature: PRIVATE_GATEWAY）。
 *
 * 2026-08-17 网关独立化：网关以「同一 exe 的 --gateway 模式」作为独立进程运行（/server on
 * detached spawn 自身 exe），本模块即该网关进程的主体。CLI 进程（非网关宿主）启动后作为
 * WS 客户端连 /clients 注册自己的 sessionId（见 src/utils/gatewayClient.ts）；遥测端（浏览器）
 * 经 /ws 发消息，网关按 sessionId 跨进程路由转发给对应 CLI，由 CLI 侧 enqueue 注入其 REPL
 * （与打字同路径）。token 落盘便携根 .claude/gateway-token，供各 CLI 进程读取后上报/连接。
 *
 * 生命周期（2026-08-17）：网关以独立进程长驻，不随任何 CLI 退出而消失；「无客户端空闲自动回收」
 * ——CLI 注册(cliClients)/遥测 WS(sockets)/SSE(sseClients) 三集合全空持续 GATEWAY_IDLE_MINUTES
 * （默认 10，可用环境变量调）分钟后自动 stopLocalGateway + 清盘 token + 退出，避免孤儿网关占端口。
 * 停止途径：/server off（POST /gateway/shutdown）、空闲自动回收、SIGINT/SIGTERM、taskkill、系统关机。
 *
 * 复用已有实现：
 *  - 会话展示由 CLI 侧 conversationDisplay.ts 导出（POST /gateway/conversation），/gateway/session
 *    命中时优先返回 display；此处 jsonl 兜底读取仅用于 CLI 未导出的情况。
 *  - 注入路径与 useReplBridge.handleInboundMessage 相同：enqueue({mode:'prompt', bridgeOrigin:true})
 *    —— 现在在 CLI 进程（gatewayClient）内执行，而非本网关进程。
 *
 * HTTP/WS 用 node:http + ws（已验证可打包进 bun 编译产物），不依赖 Bun.serve。
 */
import { createServer, request as httpRequest, type Server } from 'node:http'
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, openSync, closeSync, truncateSync, watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, resolve, extname, basename, sep, isAbsolute } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import type { UUID } from 'crypto'
import { networkInterfaces } from 'node:os'
import { createSocket, type RemoteInfo } from 'node:dgram'
import { createServer as netCreateServer, createConnection as netCreateConnection } from 'node:net'
import { spawn, spawnSync } from 'node:child_process'
import { WebSocketServer, WebSocket } from 'ws'
import { getPortableRoot, getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { getProjectRoot } from '../bootstrap/state.js'
import {
  extractJsonStringField,
  findLastCustomTitleCached,
  readSessionLite,
} from '../utils/sessionStoragePortable.js'
import { parseSessionInfoFromLite } from '../utils/listSessionsImpl.js'
import { filterConversationForDisplay } from '../utils/conversationDisplay.js'
import {
  setGatewayToken,
  saveGatewayTokenToDisk,
  clearGatewayTokenFromDisk,
  saveGatewayPortToDisk,
  clearGatewayPortFromDisk,
  isGatewayTicket,
  touchGatewayTicket,
} from '../utils/gatewayToken.js'

// 复用官方凭据池：模型校验与 CLI 同一来源（credentials.json activeProvider.models），
// 每会话切换不写全局凭据池（不 switchModel）；getActiveModel 与 CLI getUserSpecifiedModelSetting 同源。
// 设为默认模型 = switchModel 写凭据池 activeModel（全局默认，2026-08-23）。
import { ensureProviderForModel, findModelProvider, getActiveModel, getActiveProviderConfig, loadCredentials, switchModelAuto } from '../utils/credentials/pool.js'
import { modelSupportsVision } from '../utils/model/vision.js'
// 上下文占用（dsh ContextMeter 数据源）：复用 auto-compact 同源的模型上下文窗口解析，不本地复刻。
import { getContextWindowForModel } from '../utils/context.js'
// 会话重命名（2026-08-24 修复）：直接复用 CLI /rename 的落盘函数（saveCustomTitle + saveAgentName），
// 不本地复刻写盘格式——与 CLI 完全同路径，保证含 sessionId、CLI resume 能读到、退出不回退。
import { saveAgentName, saveCustomTitle } from '../utils/sessionStorage.js'
import { webAssets } from './web-assets.generated.js'
// 统一设置服务（2026-08-26 E）：写 effortLevel 走官方 updateSettingsForSource、读侧走官方
// getSettingsForSource（带缓存，写后自动失效），均不本地手解 settings.json。
// userSettings 在便携模式下解析到便携根 .claude/settings.json。
import { getSettingsFilePathForSource, getSettingsForSource, updateSettingsForSource } from '../utils/settings/settings.js'
import type { SettingsJson } from '../utils/settings/types.js'
// P2 探活收敛（2026-08-27）：signal-0 探活唯一实现在官方 genericProcessUtils，不再保留本文件第二份
import { isProcessRunning } from '../utils/genericProcessUtils.js'

// ============================================================================
// 状态
// ============================================================================
let server: Server | null = null
let wss: WebSocketServer | null = null
let currentToken = ''
let currentHost = '0.0.0.0'
let currentPort = 8124
const sockets = new Set<WebSocket>()
// 2026-08-17 网关独立化：CLI 进程（非网关宿主）作为 WS 客户端连 /clients 注册自己的
// sessionId。遥测端发消息时网关按 sessionId 路由转发给对应 CLI，由 CLI 注入其 REPL。
const cliClients = new Map<string, WebSocket>()
// 2026-08-31 防双进程（遥测端同步异常根修）：/clients 注册时间戳（每会话最近一次）。
// 普通 CLI 断连重连的 ~1s 窗口内 cliClients 暂 miss，此前 resume 链路直接 spawn → 与重连中的
// 原进程形成同会话双进程（每秒互踢乒乓 + 双写 jsonl，永不自愈，2026-08-30 92bbd49b 实锤）。
// 10s 内有注册痕迹 = 活进程在重连 → 复用不 spawn。痕迹不清理（仅时间戳，内存开销可忽略）。
const cliRegisterAt = new Map<string, number>()
const CLI_RECENT_REGISTER_MS = 10_000
const sseClients = new Set<{ res: import('node:http').ServerResponse }>()
let ssePrimed = false
const sseSizes = new Map<string, { size: number; mtime: number }>()
// O4：SSE 事件驱动 —— 用 fs.watch 监听各项目会话目录，替代 2s 轮询。sseWatches 持所有 watcher
// （key = 会话目录绝对路径），sseDebounce 合并同一波文件写入的多个 change/rename 事件（250ms 去抖），
// 避免频繁扫描。
const sseWatches = new Map<string, FSWatcher>()
let sseDebounce: NodeJS.Timeout | null = null
// 2026-08-17 空闲自动回收：三集合（cliClients/sockets/sseClients）全空持续 GATEWAY_IDLE_MINUTES
// 分钟后自动关闭网关，避免「所有 CLI/遥测端都退出、网关空转占端口」的孤儿状态。仅 --gateway
// 独立进程模式启用（进程内模式网关随 CLI 同生共死，无孤儿问题）。阈值可用 GATEWAY_IDLE_MINUTES 调。
const GATEWAY_IDLE_MINUTES = Number(process.env.GATEWAY_IDLE_MINUTES || 10)
const ENABLE_IDLE_RECLAIM = process.argv.includes('--gateway')
let idleTimer: NodeJS.Timeout | null = null

// ============================================================================
// Web 容器 backend 进程管理（2026-08-19；2026-08-28 生命周期与网关解耦）
// preview.json 声明 backend 的项目 → 网关懒加载 spawn 后端进程 + 动态端口分配，
// 前端 iframe 本机直连 http://127.0.0.1:<port>/；远程宿主走同源代理 /backend/<label>/。
// 生命周期（2026-08-28 解耦定案）：后端进程不再随网关关停（/server off/restart、空闲退出、
// 网关硬杀均不 kill）——注册表落盘 .claude/backend-registry.json，网关重启后 ensureBackend
// 按注册表收养存活进程（pid 活着 + 端口就绪），预览页刷新/重进秒开不再冷启动；后端仅由
// 空闲回收（preview.json idleMinutes）与用户手动关闭管理。根治「网关重启 → 后端冷启动 + 孤儿占端口漂移」。
// ============================================================================
interface BackendCfg {
  name?: string // 显示名（前端启动覆盖层提示用），缺省 = 项目 label；可插拔：任意后端在 preview.json 声明
  cmd: string[] // 命令数组，{port} 占位符在 spawn 时替换为实际分配端口
  cwd?: string // 工作目录，缺省 = 该项目 .claude/preview 目录
  port: number // 0 = 动态分配（网关从 8130 起探测顺延）
  idleMinutes?: number // 空闲回收阈值，缺省继承 GATEWAY_IDLE_MINUTES
  readyPath?: string // 就绪探测路径，缺省 /api/system_stats（项目后端自身 API，非网关前缀）
}
interface BackendProc {
  pid: number
  port: number
  cfg: BackendCfg
  startedAt: number
  lastActive: number // 最近一次活跃（/gateway/backend 被调用/就绪探测），用于空闲回收
  // 网关亲 spawn 的进程持有句柄；收养的（网关重启后接管现存进程）为 null，存活判定走 isPidAlive(pid)
  child: import('node:child_process').ChildProcess | null
}
const backendProcesses = new Map<string, BackendProc>()

// 后端注册表落盘（2026-08-28 生命周期解耦）：label → {pid, port, startedAt}。
// 写点 = Map 变化处（spawn 就绪/收养/kill/异常退出）；网关死后记录仍在，重启后收养。
function backendRegistryPath(): string {
  return join(getPortableRoot(), '.claude', 'backend-registry.json')
}
function readBackendRegistry(): Record<string, { pid: number; port: number; startedAt: number }> {
  if (!existsSync(backendRegistryPath())) return {}
  const parsed: unknown = JSON.parse(readFileSync(backendRegistryPath(), 'utf8'))
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, { pid: number; port: number; startedAt: number }>)
    : {}
}
function persistBackendRegistry(): void {
  try {
    const reg: Record<string, { pid: number; port: number; startedAt: number }> = {}
    for (const [label, p] of backendProcesses) reg[label] = { pid: p.pid, port: p.port, startedAt: p.startedAt }
    writeFileSync(backendRegistryPath(), JSON.stringify(reg, null, 2))
  } catch {
    /* 忽略：磁盘瞬时故障由下个写点重试 */
  }
}
const BACKEND_PORT_BASE = 8130
const BACKEND_PORT_MAX = 8160
// 网关正在停止标志（O1 修复）：/server off → stopLocalGateway 置位，doSpawnBackend 就绪探测
// 循环据此提前退出并 kill 已 spawn 的子进程，避免「探测期网关停止 → 孤儿后端进程」竞态。
let gatewayStopping = false

// 2026-08-27 同源代理 /backend/<label>/（2026-08-29 全称定案，旧 /bp/ 保留解析兼容）：Web 容器 iframe 直连方案写死 http://127.0.0.1:<port>/，
// 仅在本机浏览器成立——遥测端（手机）打开预览时 127.0.0.1 指向手机自身 → 连接拒绝、页面永远转圈。
// 解法：后端仍只绑回环（访问面不变），流量经网关主端口转发（/backend/<label>/）。鉴权不靠 query token
// （页面内相对子请求不带 token，参考 /preview/* 子资源全 401 的教训），改用票证 cookie：
// /gateway/backend 本身受 token 校验，成功时种 HttpOnly cookie 作为 /backend/* 凭据（票证内含 label 白名单）。
const BP_COOKIE_NAME = 'floria_bp'
// 2026-08-28 floria 设备记忆票证：首链 ?token= 校验通过 → 种 HttpOnly cookie，之后 URL 不再携带 token。
// 校验二选一（query token 或本 cookie），票证落盘见 gatewayToken.ts；/server off 清盘全设备掉线。
const AUTH_COOKIE_NAME = 'floria_auth'
const BP_COOKIE_TTL_MS = 24 * 60 * 60 * 1000
const BP_COOKIE_KEY_RE = /^[0-9a-f]{32}$/
interface BpSession {
  labels: Set<string>
  expires: number
}
const bpSessions = new Map<string, BpSession>()

/** 解析 Cookie 请求头为键值表（值按 URI 组件反转义；无头/坏段安全跳过） */
function parseCookieHeader(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
    } catch {
      /* 反转义失败跳过该段 */
    }
  }
  return out
}

/** 清扫过期票证（拷贝遍历防迭代中删除） */
function sweepBpSessions(now = Date.now()): void {
  for (const [k, s] of [...bpSessions]) if (s.expires <= now) bpSessions.delete(k)
}

// ============================================================================
// Web 独立会话（2026-08-23 遥测端会话与 CLI 等权）
// 每个 web 独立会话 = 网关 spawn 一个 cli-dev exe headless 子进程
// （-p --verbose --input-format stream-json --output-format stream-json），
// 复用同一 CLI 会话引擎/工具/权限/落盘格式，天然与 CLI 等权、真并行（独立进程，
// CLI 主进程退出不影响 web 会话）。web 消息经子进程 stdin 喂入，stdout NDJSON
// 逐行转发给订阅该会话的遥测端 WS；can_use_tool 审批请求转 approval 卡片。
// ============================================================================
interface WebSessionProc {
  sessionId: string
  /** 真实 CLI 进程 pid（2026-09-07 起由 cli-hello 上报补填——wt.exe 中转即退拿不到 pid。gracefulStopCli 用它做 3s 树杀兜底） */
  pid?: number
  clients: Set<WebSocket>
  startedAt: number
  lastActive: number // 最近活跃（消息/审批），用于空闲回收
}
const webSessions = new Map<string, WebSessionProc>()
// ============================================================================
// web 会话注册表落盘 + 重启收养（2026-08-29）
// 根因：/server restart → /gateway/shutdown → stopLocalGateway 曾 killAllWebSessions，
// 把「正在执行 restart 的 web 会话窗口自己」也杀了（CLI 死 → doOn 重拉网关永远不执行，
// restart 断在半路）。定案：web 会话与普通 CLI 会话同等权重——网关关停/重启一律不杀
// 存活窗口（gatewayClient 自动重连新网关）。代价是重启后内存注册表丢失 → resume 幂等
// （spawnWebSession 防双进程写同一 jsonl）失效，故注册表落盘（变更即写，防 kill -9 留脏），
// 网关启动时收养 pid 仍存活的条目。
// ============================================================================
const webSessionsRegistryPath = (): string => join(getPortableRoot(), '.claude', 'gateway-websessions.json')
function persistWebSessions(): void {
  const entries: Array<{ sessionId: string; pid: number; startedAt: number }> = []
  for (const p of webSessions.values()) {
    if (p.pid) entries.push({ sessionId: p.sessionId, pid: p.pid, startedAt: p.startedAt })
  }
  try {
    writeFileSync(webSessionsRegistryPath(), JSON.stringify(entries), 'utf8')
  } catch {
    /* 落盘失败不影响运行：最坏情况重启后收养不到，退化为 resume 重开窗口 */
  }
}
function adoptWebSessions(): void {
  const regPath = webSessionsRegistryPath()
  if (!existsSync(regPath)) return
  const raw: unknown = JSON.parse(readFileSync(regPath, 'utf8'))
  if (!Array.isArray(raw)) return
  const entries = raw as Array<{ sessionId: string; pid: number; startedAt: number }>
  for (const e of entries) {
    if (!e?.sessionId || !Number.isFinite(e.pid) || webSessions.has(e.sessionId)) continue
    if (!isPidAlive(e.pid)) continue
    webSessions.set(e.sessionId, {
      sessionId: e.sessionId,
      pid: e.pid,
      clients: new Set(),
      startedAt: Number(e.startedAt) || Date.now(),
      lastActive: Date.now(),
    })
    console.log(`[gateway] 收养存活 web 会话 ${e.sessionId} (PID ${e.pid})`)
  }
  persistWebSessions()
}
// 会话 → 项目根定位（2026-08-25 用户定案：resume 不依赖 web 注册表，改按磁盘会话文件定位）。
// 会话转录在 <项目根>/.claude/projects/<sessionId>.jsonl；扫描 findProjects 各组找该文件 →
// 项目 scope → {projectLabel}（供 webSessionProjectRoot/webSessionExe 路由 cwd 与 exe），
// 全局根命中 → {projectLabel: undefined}。找不到 → null（会话不存在于本机磁盘）。
// web 与 CLI 会话一视同仁：CLI 会话同样落 <cwd>/.claude/projects/，文件在即能恢复。
function sessionProjectRootOf(sessionId: string): { projectLabel?: string } | null {
  for (const g of findProjects(getPortableRoot())) {
    if (existsSync(join(g.dir, sessionId + '.jsonl'))) {
      return g.scope === 'project' ? { projectLabel: g.label } : {}
    }
  }
  return null
}
// web 会话启动 cwd（2026-08-24 用户定案：笔=全局根，项目=项目目录内）：
//  CLI 的 getProjectRoot() = 进程启动时的 cwd（state.ts getInitialState projectRoot: resolvedCwd），
//  会话 jsonl 自然落 <cwd>/.claude/projects/——所以只需把 cwd 指对，落盘位置即正确，无需额外落盘逻辑。
//  - project 指定（findProjects 命中的项目组，防任意路径）→ 该项目根目录
//  - 未指定（笔/首页消息发送）→ 全局根（便携根 getPortableRoot() = @WrokSpace 散装对话区）
function webSessionProjectRoot(project: string | undefined): string {
  if (project && project.trim()) {
    const g = findProjects(getPortableRoot()).find((x) => x.scope === 'project' && x.label === project)
    if (g) return resolve(g.dir, '..', '..') // dir = <项目根>/.claude/projects → 上两级 = 项目根
  }
  return getPortableRoot()
}

// web 会话 exe 定位（2026-08-31 根修，取代 2026-08-24 目录扫描旧案）：
//  一律用网关自身 exe（process.execPath）——与网关同二进制，探测/注册协议必然匹配。
//  旧案「笔=全局根/项目=项目根下扫 cli-dev*.exe」废弃：08-30 网关 API 前缀迁 /gateway/* 且根
//  /api 撤空后，目录里的旧 exe（全局根仅 08-29 版 140859，Pj1/Pj11/Pj14/Pj17/Pj2 项目根更旧）
//  探测 /api/health 404 → 永不注册 → wsession 20s 超时 =「遥测端无法启动新会话」
//  （20260830222122 委派，异常1/2 双会话独立实锤）。会话落盘位置与 exe 来源无关
//  （cwd 由 webSessionProjectRoot 决定，08-24 落盘定案不受影响）。
function webSessionExe(): string {
  return process.execPath
}

// CLI 侧 conversationDisplay.ts 上报的展示结果（内存，进程退出即消失）
const conversationDisplays = new Map<string, { messages: unknown[]; updatedAt: number }>()
// CLI 侧 sendSessionActivity 上报的活动状态（内存，进程退出即消失）
const sessionActivity = new Map<string, { status: string; pid: number; cwd?: string; updatedAt: number }>()
// 2026-08-24 模型 web/CLI 同步：CLI 侧 reportCurrentModel 上报的每会话实际模型（内存，进程退出即消失）。
// 每会话模型 override 只存在于 CLI 进程内存，web 端 /gateway/session 据此读取校准模型 seat。
const sessionModels = new Map<string, { model: string; updatedAt: number }>()
// 2026-08-30 共同后端队列快照（接力文档清单#2）：CLI 侧 /clients WS queue-state 上报的当前
// 排队项（仅用户 prompt）。web 排队区置底数据源：/gateway/session.queued 首载 + SSE queue-state 增量。
// 纯引擎内存态镜像，CLI 断开即随 detach 删除。
const sessionQueues = new Map<string, { items: Array<{ content: string; ts: number }>; updatedAt: number }>()
// 2026-09-06 web 打断收口二轮：回合被中止的网关权威时刻（per-session）。打断后 jsonl 零写入，
// 本时刻是刷新后恢复收口判定的唯一持久源（turn-state SSE 只覆盖不刷新的实时路径）；无 TTL、
// 不入 sweepStaleMaps——被打断的回合永无回复，语义同前端 turnEndFlags「无 TTL 防运行态复活」。
// 2026-09-07 落盘持久化（gateway-turnend.json，变更即写、启动恢复）：重启不杀 CLI 进程（09-05
// 不杀定案），重启前被打断的回合其收口信号必须跨重启存活——否则 CLI 重连重报 activity 后 state
// 恢复非 null，两收口信号全失，「正在处理」无限计时复活（09-06 2h26m 挂死的重启回归路径）。
// 旧注释「重启连坐杀全部 CLI 进程 → state=null 先行收口」系不杀定案前的时代残留，已作废。
const turnEndAt = new Map<string, number>()
const turnEndAtPath = (): string => join(getPortableRoot(), '.claude', 'gateway-turnend.json')
function persistTurnEndAt(): void {
  try {
    writeFileSync(turnEndAtPath(), JSON.stringify(Object.fromEntries(turnEndAt)), 'utf8')
  } catch {
    /* 落盘失败不影响运行：最坏情况重启后该次打断收口退化为内存态丢失 */
  }
}
function loadTurnEndAt(): void {
  try {
    const raw: unknown = JSON.parse(readFileSync(turnEndAtPath(), 'utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    for (const [sid, ts] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) turnEndAt.set(sid, ts)
    }
  } catch {
    /* 无文件/坏 JSON：视为空（首次启动常态） */
  }
}
// 2026-09-07 web 僵死感知：CLI 引擎每产出真实增量经 /clients 上报 turn-beat（gatewayClient 4s
// 节流），记每会话最后活性时刻；SSE 群发 → web 运行态计时 tick 对账，beat 落后超阈值显「无响应」。
// 进程/WS 活但 query 链僵死时 beat 恒停 = web 唯一可判信号（60s activity 心跳测不出 query 僵死）。
// 仅内存运行态：turn-state(live:false) 即删、detach 进 3s 复核窗到期未重连才删（09-08），
// 不入落盘与 sweep（过期由 web 阈值判定消化）。
const turnBeatAt = new Map<string, number>()
// 2026-09-08 事件流统一 P1（方案 20260908135557）：session-delta 的 per-session 单调 seq 记账。
// 网关只做去重（seq <= last 丢弃，防 CLI 重发/广播竞态）与重置（cli-hello = 新 CLI 进程 seq 流
// 重启），不缓存 delta 历史——丢失靠 web 端 seq gap → 全量对账恢复（无状态转发定案 §3.5）。
// 仅内存：网关重启即空，CLI 重连（session-up → web 全量对账 + /gateway/session 附 deltaSeq）自然对齐。
const sessionDeltaSeq = new Map<string, number>()
// 2026-09-08 detach 复核窗：/clients WS 断开后延迟收口（activity null 群发/表清理）的定时器表。
// 窗口内重连即静默跳过；同 sid 重复 detach 由 clearTimeout 去重。兜底语义与 session-down 一致：
// 进程失联确认才收口，重连窗内 web 保持最后快照不感知。
const detachTimers = new Map<string, ReturnType<typeof setTimeout>>()
// C1 修复：两个内存 Map 无上限（只增不删）→ 长跑泄漏。加 TTL + 死进程惰性清扫。
const DISPLAY_TTL_MS = 10 * 60 * 1000 // conversationDisplays 10 分钟无刷新视为过期
const ACTIVITY_TTL_MS = 10 * 60 * 1000 // sessionActivity 10 分钟无上报视为过期
const SESSION_MODEL_TTL_MS = 10 * 60 * 1000 // sessionModels 10 分钟无上报视为过期
const SESSION_QUEUE_TTL_MS = 10 * 60 * 1000 // sessionQueues 10 分钟无上报视为过期
const MAX_REPORT_BODY_BYTES = 1024 * 1024

// ============================================================================
// 小工具
// ============================================================================
const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function isPathInside(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(parent + sep)
}

class ReportBodyTooLargeError extends Error {}

async function readReportBody(req: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += part.length
    if (size > MAX_REPORT_BODY_BYTES) throw new ReportBodyTooLargeError()
    chunks.push(part)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}
function lanAddress(): string | null {
  const addrs: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) addrs.push(ni.address)
    }
  }
  // 优先真实私有局域网网段，跳过 VPN/代理虚拟网卡（198.18.x benchmark 段、Tailscale 100.x 等）
  const pick = (re: RegExp) => addrs.find((a) => re.test(a))
  return (
    pick(/^192\.168\./) ||
    pick(/^10\./) ||
    pick(/^172\.(1[6-9]|2\d|3[01])\./) ||
    addrs[0] ||
    null
  )
}

// ============================================================================
// mDNS 应答器（2026-08-29 floria.local 自广播）：网关在 UDP 5353 多播组应答 floria.local
// 的 A 查询，返回本机全部局域网 IPv4 —— 任何同 WiFi/热点设备打开 http://floria.local:<port>/
// 即免配置连入（Apple/Windows 原生 mDNS 解析 .local；Android 浏览器支持差，IP 直连兜底）。
// 地址发现与 HTTP 绑定解耦：HTTP 仍绑 0.0.0.0，mDNS 只解决「设备怎么找到本机 IP」——
// 应答时实时读网卡，无需配置路由器 DNS（热点场景同样工作）。
// 手写最小应答器（查询解析 + A 记录构造），不引 multicast-dns 依赖（bun compile 下
// dgram 多播 bind/addMembership/send 已实测可用）；5353 被其它 mDNS 服务占用时静默
// 放弃（自动路径禁抢端口，回落 IP 直连）。
// ============================================================================
const MDNS_NAME = 'floria.local'
const MDNS_PORT = 5353
const MDNS_GROUP = '224.0.0.251'
// 120s：IP 变化后旧缓存两分钟过期，设备重新查询即拿新地址
const MDNS_RECORD_TTL = 120
// 2026-08-31 多接口根修：旧版单 socket bind 首个 LAN 地址，Windows 上绑定具体单播 IP 的
// socket 只收该接口的组播（addMembership 指定其它接口对其无效）——热点（移动热点虚拟适配器
// 192.168.137.1）与 WLAN 并存时，热点侧 iPad 的查询 WLAN socket 收不到 → floria.local 永不
// 解析。改为每 LAN IP 一个 socket（bind 该 IP + 该接口入组）：应答从查询到达的 socket 发出，
// 源 IP/出接口天然正确；A 记录只回该 socket 的 bind IP（查询来自哪个网段就回哪个可达地址，
// 不再让设备先试到别的网段 IP 拖慢/失败）。
const mdnsSockets = new Map<string, ReturnType<typeof createSocket>>() // bind IP → socket
const mdnsPendingBinds = new Set<string>() // bind 异步期间占位，防 watch 轮询重复发起
// 网络切换自愈（2026-08-30 热点根修）：30s 轮询实时读网卡，LAN 地址集合变化即全量重建。
let mdnsWatchTimer: ReturnType<typeof setInterval> | null = null
const MDNS_WATCH_INTERVAL = 30_000
// 单播 announce（2026-09-01 iPhone 热点根修）：iPhone 个人热点/AP 隔离网络吞 mDNS 多播，
// 设备查询永远到不了 PC（现场实测：iPad↔PC IP 直连通、floria.local 恒不解析）——应答器
// 空转。不再等查询：周期性向各 LAN IP 所在子网全部主机地址单播推送 announce（cache-flush
// A 记录，目的端口 5353），单播穿多播抑制，iOS mDNSResponder 收到即建/刷缓存，floria.local
// 免查询恒可解析；设备接入/锁屏唤醒后最多一个周期自动恢复。周期取 TTL 之半保无断档。
let mdnsAnnounceTimer: ReturnType<typeof setInterval> | null = null
const MDNS_ANNOUNCE_INTERVAL = 60_000
// 查询触发回推的节流表（源 IP → 上次回推时刻）
const mdnsAnnounceSeen = new Map<string, number>()
// 名字内联编码（announce 无问题段，压缩指针无处可指）：\x06floria\x05local\x00
const MDNS_NAME_ENC = Buffer.concat([
  Buffer.from([6]),
  Buffer.from('floria', 'latin1'),
  Buffer.from([5]),
  Buffer.from('local', 'latin1'),
  Buffer.from([0]),
])

interface MdnsIf {
  address: string
  netmask: string
}

function mdnsLanIfs(): MdnsIf[] {
  const out: MdnsIf[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ address: ni.address, netmask: ni.netmask })
    }
  }
  // 过滤不可用网段（169.254 link-local、198.18 benchmark 段、Tailscale 100.64-127 CGNAT 段），
  // 避免设备先试到不可达地址拖慢连接
  return out.filter(
    (x) =>
      !x.address.startsWith('169.254.') &&
      !/^198\.18\./.test(x.address) &&
      !/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(x.address),
  )
}

function mdnsLanAddrs(): string[] {
  return mdnsLanIfs().map((x) => x.address)
}

// 读 DNS 报文 QNAME（标签序列 + 压缩指针防御）：返回点分名与问题段结束所需 next 偏移
function mdnsReadName(buf: Buffer, offset: number): { name: string; next: number } | null {
  const labels: string[] = []
  let ptr = offset
  let next = -1
  for (let i = 0; i < 32; i++) {
    const len = buf[ptr]
    if (len === undefined) return null
    if (len === 0) {
      return { name: labels.join('.'), next: next === -1 ? ptr + 1 : next }
    }
    if ((len & 0xc0) === 0xc0) {
      if (next === -1) next = ptr + 2
      const target = ((len & 0x3f) << 8) | buf[ptr + 1]
      if (target === undefined) return null
      ptr = target
      continue
    }
    labels.push(buf.subarray(ptr + 1, ptr + 1 + len).toString('latin1'))
    ptr += 1 + len
  }
  return null
}

function mdnsStart(): void {
  if (mdnsSockets.size) return
  // 每个 LAN IP 一个 socket（多接口根修，见 mdnsSockets 注释）。Meta TUN（198.18.0.1）等
  // 已被 mdnsLanAddrs 过滤，bind 恒为真实接口地址（2026-08-29 Meta TUN 根修延续：Windows 上
  // 绑定特定单播地址压过多播路由 metric，bun 的 setMulticastInterface 无效）。
  // 无 LAN 地址（DHCP 未就绪等）不建 socket，等 mdnsWatch 下轮重试（旧版降级 bind 0.0.0.0
  // 会被 Meta TUN 吸走多播，弃用）。
  for (const ip of mdnsLanAddrs()) mdnsStartOne(ip)
  // timer 无条件启动（2026-08-31 自旋根修）：bind 是异步的，mdnsStart 返回时 mdnsSockets 尚空，
  // 旧条件 `mdnsSockets.size &&` 恒 false → watch 从未启动 → 网络切换后应答器永远绑死旧地址
  // （热点场景 floria.local 永不解析的直接根因）。watch 对比集合自动收敛，无需 map 非空前置。
  if (!mdnsWatchTimer) mdnsWatchTimer = setInterval(mdnsWatch, MDNS_WATCH_INTERVAL)
  if (!mdnsAnnounceTimer) {
    mdnsAnnounceTimer = setInterval(() => {
      for (const ip of mdnsSockets.keys()) mdnsAnnounceOne(ip, false)
    }, MDNS_ANNOUNCE_INTERVAL)
  }
}

function mdnsStartOne(ip: string): void {
  if (mdnsPendingBinds.has(ip) || mdnsSockets.has(ip)) return
  mdnsPendingBinds.add(ip)
  const sock = createSocket({ type: 'udp4', reuseAddr: true })
  sock.on('error', () => {
    // 5353 被占/防火墙拒绝等：该接口静默退出（其余接口照常），不拖垮网关
    mdnsPendingBinds.delete(ip)
    try {
      sock.close()
    } catch {
      /* 忽略 */
    }
    if (mdnsSockets.get(ip) === sock) mdnsSockets.delete(ip)
    console.error(`[gateway] mDNS 应答器启动失败（${ip}，该接口回落 IP 直连）`)
  })
  sock.on('message', (msg: Buffer, rinfo: RemoteInfo) => {
    try {
      mdnsHandleQuery(sock, ip, msg, rinfo)
    } catch {
      /* 忽略坏包 */
    }
  })
  sock.bind(MDNS_PORT, ip, () => {
    mdnsPendingBinds.delete(ip)
    try {
      sock.addMembership(MDNS_GROUP, ip)
      mdnsSockets.set(ip, sock)
      console.log(`[gateway] mDNS 应答器就绪：floria.local → ${ip}`)
      // RFC 6762 §8.3 announce 应连发 ≥2 次（间隔 ≥1s）：三连发覆盖新设备刚入网窗口，
      // UDP 丢包不必等 60s 周期（周期轮保持单发）
      for (const delay of [0, 1000, 2000]) setTimeout(() => mdnsAnnounceOne(ip, false), delay)
      console.log(`[gateway] mDNS 单播 announce 推发启动：floria.local → ${ip}（3 连发）`)
    } catch (e) {
      try {
        sock.close()
      } catch {
        /* 忽略 */
      }
      if (mdnsSockets.get(ip) === sock) mdnsSockets.delete(ip)
      console.error(`[gateway] mDNS 入组失败（${ip}）: ${(e as Error).message}`)
    }
  })
}

// 轮询检测网络变化：与 socket 集合 diff 增量增删（2026-09-01 抖动根修：旧版集合不等即
// 全量 stop/start——日志实证热点 IP 每分钟在 172.20.10.x 与其它接口间抖动，一次抖动就把
// 健康接口一起拆掉，服务网段出现 30s 无人应答窗口；增量化后未变化接口的 socket/announce
// 常驻，仅补缺失、关多余）。
// 无地址（断网抖动瞬间）不动，保持旧 socket 自生自灭，避免中途降级。
function mdnsWatch(): void {
  const cur = new Set(mdnsLanAddrs())
  let changed = false
  for (const [ip, sock] of [...mdnsSockets]) {
    if (cur.has(ip)) continue
    changed = true
    try {
      sock.close()
    } catch {
      /* 忽略 */
    }
    mdnsSockets.delete(ip)
  }
  for (const ip of cur) {
    if (mdnsSockets.has(ip) || mdnsPendingBinds.has(ip)) continue
    changed = true
    mdnsStartOne(ip)
  }
  if (changed) console.log(`[gateway] mDNS 接口变化，现绑：${[...mdnsSockets.keys()].join('/') || '无'}`)
}

function mdnsHandleQuery(sock: ReturnType<typeof createSocket>, bindIp: string, msg: Buffer, rinfo: RemoteInfo): void {
  if (msg.length < 12 + 5) return
  // QR=1（应答）不处理：无参 addMembership 落在默认多播接口（Meta TUN 时 = 198.18.0.1），
  // 本机自发的多播应答经 IP_MULTICAST_LOOP 回环后会被自己收到——无此检查会形成应答→再应答
  // 的本地反馈循环（2026-08-29 实证：单条查询收到 2 条应答）
  if (msg.readUInt16BE(2) & 0x8000) return
  // 任一 mDNS 查询到达即单播回推 announce（30s/源节流）：设备刚入网/亮屏时 iOS 先发系统
  // 服务查询（_companion-link/_rdlink 等），此刻回推让 floria.local 缓存立即建立，不等周期
  const lastSeen = mdnsAnnounceSeen.get(rinfo.address) ?? 0
  if (Date.now() - lastSeen > 30_000) {
    mdnsAnnounceSeen.set(rinfo.address, Date.now())
    console.log(`[gateway] mDNS 单播回推 announce → ${rinfo.address}（30s/源节流）`)
    mdnsAnnounceToPeer(bindIp, rinfo.address)
  }
  const qdcount = msg.readUInt16BE(4)
  console.log(`[gateway] mDNS 查询到达：${rinfo.address}:${rinfo.port}（QD=${qdcount}）`)
  if (qdcount < 1) return
  // 逐问题扫描（2026-08-29 打包查询根修）：iOS mDNSResponder 会把 floria.local 与
  // _companion-link/_rdlink 等系统服务发现打包进同一查询（QD>1），floria.local 常不在首位；
  // 旧逻辑只读首个 QNAME → 整包忽略 → iPad 侧永不解析成功（现场取证：iPad 5 连查零应答，
  // 同窗本机单问题查询秒应答）。取首个匹配 floria.local 的问题（A/ANY）作答。
  let off = 12
  let hitStart = -1
  let hitEnd = -1
  for (let qi = 0; qi < qdcount && off + 1 < msg.length; qi++) {
    const parsed = mdnsReadName(msg, off)
    if (!parsed || parsed.next + 4 > msg.length) return
    const qtype = msg.readUInt16BE(parsed.next)
    if (hitStart < 0 && parsed.name.toLowerCase() === MDNS_NAME && (qtype === 1 || qtype === 255)) {
      hitStart = off
      hitEnd = parsed.next + 4
    }
    off = parsed.next + 4
  }
  if (hitStart < 0) return
  // A 记录只回查询到达接口的 bind IP（多接口根修）：设备从哪个网段问，就答哪个网段的可达地址
  const addrs = [bindIp]
  // 应答：header(QR=1 AA=1) + 原样问题段（仅匹配问题）+ 1 条 A 记录（NAME 用压缩指针
  // 0xc00c 指向应答包内偏移 12 = 问题起始，问题段虽来自打包查询中段，指针仍指向正确）
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0x8400, 2)
  header.writeUInt16BE(1, 4)
  header.writeUInt16BE(addrs.length, 6)
  const question = msg.subarray(hitStart, hitEnd)
  const parts: Buffer[] = [header, question]
  for (const ip of addrs) {
    const rec = Buffer.alloc(16)
    rec.writeUInt16BE(0xc00c, 0)
    rec.writeUInt16BE(1, 2) // TYPE A
    rec.writeUInt16BE(1, 4) // CLASS IN
    rec.writeUInt32BE(MDNS_RECORD_TTL, 6)
    rec.writeUInt16BE(4, 10) // RDLENGTH
    const octets = ip.split('.').map(Number)
    for (let i = 0; i < 4; i++) rec[12 + i] = octets[i] & 0xff
    parts.push(rec)
  }
  const reply = Buffer.concat(parts)
  // 双发（2026-08-29）：多播应答（组内标准路径）+ 单播回源——iOS 查询（源端口 5353）可达 PC，
  // 但应答走多播组回程时常被 AP 的 IGMP snooping/多播抑制丢弃（实测设备解析不到 floria.local），
  // 单播直达查询者穿该抑制；mDNS 应答幂等，设备收两份无害。legacy 查询（随机源端口）本就单播。
  sock.send(reply, MDNS_PORT, MDNS_GROUP, () => {})
  sock.send(reply, rinfo.port, rinfo.address, () => {})
}

// ---- 单播 announce（2026-09-01，见 mdnsAnnounceTimer 注释）----

// announce 报文（2026-09-01 legacy 格式化）：header(QR=1 AA=1, QD=1 AN=1) + 问题段
// floria.local A IN + 1 条 A 记录（0xc00c 压缩指针指向偏移 12 问题段起始）。
// 带问题段是关键：无问题段的纯 answer 单播属 unsolicited，iPad mDNSResponder 实测无视
// （08-31 无 announce 与 09-01 纯 answer announce 两次热点实测均不解析，其余链路相同）；
// 带问题段的 legacy unicast response 走 mDNSResponder 常规应答通道（商用 mDNS 网关同款做法）。
function mdnsAnnouncePacket(bindIp: string): Buffer {
  const octets = bindIp.split('.').map(Number)
  const question = Buffer.concat([MDNS_NAME_ENC, Buffer.from([0, 1, 0, 1])]) // QTYPE=A QCLASS=IN
  const rec = Buffer.alloc(16)
  rec.writeUInt16BE(0xc00c, 0) // NAME → 问题段起始
  rec.writeUInt16BE(1, 2) // TYPE A
  // CLASS IN：RFC 6762 §18.11 单播应答中 cache-flush 位必须为 0（0x8001 仅多播合法，
  // iOS mDNSResponder 严格实现会拒收）——单播 announce 不依赖该位，靠周期重发保新鲜
  rec.writeUInt16BE(1, 4)
  rec.writeUInt32BE(MDNS_RECORD_TTL, 6)
  rec.writeUInt16BE(4, 10) // RDLENGTH
  for (let i = 0; i < 4; i++) rec[12 + i] = octets[i] & 0xff
  const header = Buffer.alloc(12)
  header.writeUInt16BE(0x8400, 2) // QR=1 AA=1（ID=0：legacy 应答无匹配查询时规范值）
  header.writeUInt16BE(1, 4) // QDCOUNT=1
  header.writeUInt16BE(1, 6) // ANCOUNT=1
  return Buffer.concat([header, question, rec])
}

const ipToU32 = (s: string) =>
  s.split('.').reduce((acc, o) => (acc << 8) + (Number(o) & 0xff), 0) >>> 0

function mdnsSameSubnet(a: string, b: string, netmask: string): boolean {
  const m = ipToU32(netmask)
  return ((ipToU32(a) & m) >>> 0) === ((ipToU32(b) & m) >>> 0)
}

// 同子网全部主机地址（排除网络地址/广播地址/自身）；网段总地址数 > 512 返回空——
// 大网段（校园网 /16 等）全网枚举推送纯属浪费，定向推（mdnsPushToReachableClient）不受此限
function mdnsSubnetPeers(ip: string, netmask: string): string[] {
  const ipN = ipToU32(ip)
  const maskN = ipToU32(netmask)
  const base = (ipN & maskN) >>> 0
  const size = (~maskN >>> 0) + 1
  if (size > 512) return []
  const out: string[] = []
  for (let n = 1; n < size - 1; n++) {
    const a = (base + n) >>> 0
    if (a === ipN) continue
    out.push([(a >>> 24) & 0xff, (a >>> 16) & 0xff, (a >>> 8) & 0xff, a & 0xff].join('.'))
  }
  return out
}

function mdnsAnnounceOne(bindIp: string, log: boolean): void {
  const sock = mdnsSockets.get(bindIp)
  if (!sock) return
  const netmask = mdnsLanIfs().find((x) => x.address === bindIp)?.netmask
  if (!netmask) return
  const pkt = mdnsAnnouncePacket(bindIp)
  const peers = mdnsSubnetPeers(bindIp, netmask)
  for (const peer of peers) sock.send(pkt, MDNS_PORT, peer, () => {})
  if (log) {
    console.log(`[gateway] mDNS 单播 announce：floria.local → ${bindIp} → ${peers.length} 个地址（热点吞多播场景免查询可达）`)
  }
}

// 单播推送一份 announce 到指定地址（收到该设备任一 mDNS 查询时用）
function mdnsAnnounceToPeer(bindIp: string, peer: string): void {
  const sock = mdnsSockets.get(bindIp)
  if (!sock) return
  sock.send(mdnsAnnouncePacket(bindIp), MDNS_PORT, peer, () => {})
}

// 请求来源 IPv4 归一化：剥 ::ffff: 前缀，非 IPv4（IPv6/Unix socket）返回空串。
// mDNS 定向推与设备票证回写（touchGatewayTicket）共用。
function remoteIPv4(raw: string | undefined): string {
  const ip = (raw ?? '').replace(/^::ffff:/, '')
  return /^\d+\.\d+\.\d+\.\d+$/.test(ip) ? ip : ''
}

// 直连客户端定向推送（2026-09-01 校园网单播互通场景）：设备（iPad/iPhone）的 mDNS 多播被
// AP 吞（查询到不了 PC、PC 多播应答回不去），但设备 HTTP 直连 8124 证明**单播双向可达**
// （iPad 分流实证：IP 直连页面正常打开）——此刻向该客户端定向单播推 legacy announce（3 连发
// 覆盖丢包），设备 mDNSResponder 收到后 floria.local 免查询可解析，形成「直连一次 → 域名
// 永通」的自愈闭环。回环/非同网段地址跳过；30s/IP 节流（与查询回推共用 mdnsAnnounceSeen）。
// 全网枚举推（mdnsAnnounceOne）在校园网 /16 因 >512 跳过，定向推不受该限——只推已知可达地址。
function mdnsPushToReachableClient(remoteIpRaw: string): void {
  const remoteIp = remoteIPv4(remoteIpRaw)
  if (!remoteIp) return // IPv6 等非 IPv4 跳过
  if (remoteIp.startsWith('127.')) return // 本机访问（PC 端有 hosts 兜底，无需 mDNS）
  for (const bindIp of mdnsSockets.keys()) {
    const netmask = mdnsLanIfs().find((x) => x.address === bindIp)?.netmask
    if (!netmask || !mdnsSameSubnet(remoteIp, bindIp, netmask)) continue
    const lastSeen = mdnsAnnounceSeen.get(remoteIp) ?? 0
    if (Date.now() - lastSeen > 30_000) {
      mdnsAnnounceSeen.set(remoteIp, Date.now())
      console.log(`[gateway] mDNS 定向推（直连客户端 ${remoteIp}）：floria.local → 3 连发`)
      for (const delay of [0, 1000, 2000]) {
        setTimeout(() => mdnsAnnounceToPeer(bindIp, remoteIp), delay)
      }
    }
    return
  }
}

function mdnsStop(): void {
  if (mdnsWatchTimer) {
    clearInterval(mdnsWatchTimer)
    mdnsWatchTimer = null
  }
  if (mdnsAnnounceTimer) {
    clearInterval(mdnsAnnounceTimer)
    mdnsAnnounceTimer = null
  }
  mdnsAnnounceSeen.clear()
  mdnsPendingBinds.clear()
  for (const sock of mdnsSockets.values()) {
    try {
      sock.close()
    } catch {
      /* 忽略 */
    }
  }
  mdnsSockets.clear()
}

// 静态资源根：SubPj1 前端优先，SubPj2 本地 public 兜底。
// SubPj 是当前项目的子项目（Pj16-CodeAgent构建/SubPj1-遥测网页/...），故项目根优先；
// 便携根兜底兼容旧假设（2026-08-14 修：原只按便携根 @WrokSpace 定位，SubPj1 在项目根内导致磁盘兜底恒 404）。
function publicDir(root: string): string {
  const bases = [getProjectRoot(), root]
  for (const base of bases) {
    const subPj1 = join(base, 'SubPj1-遥测网页', 'public')
    if (isDir(subPj1)) return subPj1
  }
  for (const base of bases) {
    const subPj2 = join(base, 'SubPj2-私有化网关', 'public')
    if (isDir(subPj2)) return subPj2
  }
  return join(root, 'SubPj1-遥测网页', 'public')
}

// 内嵌 web 资源（打包进 exe，gen-web-assets.ts 生成）；命中则内存 serve，磁盘 SubPj public 仅作开发兜底。
// base64 解码结果惰性缓存，避免每次静态请求重复解码 index.html/app.js 等常驻资源。
const webAssetCache = new Map<string, Buffer>()
function readWebAsset(name: string): Buffer | null {
  const cached = webAssetCache.get(name)
  if (cached) return cached
  const b64 = webAssets[name]
  if (b64 === undefined) return null
  const buf = Buffer.from(b64, 'base64')
  webAssetCache.set(name, buf)
  return buf
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.canvas': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

// ============================================================================
// 会话列表 / 读取（基于便携根扫描；逻辑对齐旧 gateway.mjs）
// ============================================================================
const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i

interface ProjectInfo {
  label: string
  dir: string
  scope: string
  hasPreview: boolean
  hasBackend?: boolean
  backendCfg?: BackendCfg
}

function findProjects(root: string): ProjectInfo[] {
  const groups: ProjectInfo[] = []
  const global = join(root, '.claude', 'projects')
  if (isDir(global)) groups.push({ label: '全局根 · 散装对话', dir: global, scope: 'global', hasPreview: false })
  const entries = readdirSync(root, { withFileTypes: true })
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name.startsWith('.')) continue
    if (/^\d{8,14}-/.test(e.name)) continue // 根级临时任务目录
    const pd = join(root, e.name, '.claude', 'projects')
    if (isDir(pd)) {
      // hasPreview：项目自带 .claude/preview/（网页渲染，点击项目胶囊时前端 iframe 加载替换界面）
      const previewDir = join(root, e.name, '.claude', 'preview')
      const info: ProjectInfo = { label: e.name, dir: pd, scope: 'project', hasPreview: isDir(previewDir) }
      // hasBackend：preview.json 声明 backend → 该项目预览以「Web 容器」方式运行（网关 spawn 后端进程，iframe 直连）
      if (info.hasPreview) {
        const cfg = readBackendCfg(previewDir)
        if (cfg) {
          info.hasBackend = true
          info.backendCfg = cfg
        }
      }
      groups.push(info)
    }
  }
  return groups
}

// 读 <previewDir>/preview.json 的 backend 声明；不存在或结构非法 → undefined
function readBackendCfg(previewDir: string): BackendCfg | undefined {
  const pj = join(previewDir, 'preview.json')
  if (!existsSync(pj)) return undefined
  const raw = JSON.parse(readFileSync(pj, 'utf-8')) as {
    backend?: { name?: unknown; cmd?: unknown; cwd?: string; port?: number; idleMinutes?: number; readyPath?: string }
  }
  const b = raw?.backend
  if (!b || !Array.isArray(b.cmd) || !b.cmd.length) return undefined
  return {
    name: typeof b.name === 'string' && b.name ? b.name : undefined,
    cmd: b.cmd.map(String),
    // cwd 相对 preview.json 所在目录解析（如 "../../comfyui-backend" → 项目根下 comfyui-backend），
    // 缺省 = preview 目录本身
    cwd: typeof b.cwd === 'string' && b.cwd ? resolve(previewDir, b.cwd) : previewDir,
    port: typeof b.port === 'number' ? b.port : 0,
    idleMinutes: typeof b.idleMinutes === 'number' ? b.idleMinutes : GATEWAY_IDLE_MINUTES,
    readyPath: typeof b.readyPath === 'string' && b.readyPath ? b.readyPath : '/api/system_stats', // 项目后端(如 ComfyUI)自身 API,勿随网关前缀迁移
  }
}

function countUserAssistant(text: string): number {
  let n = 0
  for (const line of text.split('\n')) {
    if (line.includes('"type":"user"') || line.includes('"type":"assistant"')) n++
  }
  return n
}

type SessionMeta = { sidechain: true } | { title: string; messageCount: number; updatedAt: number }

// B2（2026-08-26）大文件兜底（反向扫描 findLastCustomTitle 及其 (size, mtime) 缓存）
// 2026-08-31 迁入共享权威 sessionStoragePortable.ts（findLastCustomTitleCached），
// 与 CLI readLiteMetadata 同源；共享版并修复原本地副本在 start===0 时
// end=start+OVERLAP 的自旋缺陷（无任何 custom-title 记录的文件会死循环）。
// 标题写入仍只由 sessionStorage.ts 的 saveCustomTitle/saveAgentName 负责，网关不另造标题存储。

async function parseMeta(file: string): Promise<SessionMeta | null> {
  const lite = await readSessionLite(file)
  if (!lite) return null
  const { head, tail, mtime } = lite
  if (head.includes('"isSidechain":true') || head.includes('"isSidechain": true')) return { sidechain: true }
  const teamName = extractJsonStringField(head, 'teamName')
  if (teamName) return { sidechain: true }
  const messageCount =
    countUserAssistant(head) + (tail === head ? 0 : countUserAssistant(tail))
  const uuid = basename(file).replace(/\.jsonl$/, '')
  // 复用 CLI 权威标题提取（parseSessionInfoFromLite：customTitle → aiTitle →
  // lastPrompt → summary → firstPrompt 回退链），不再本地复刻标题逻辑。
  const info = parseSessionInfoFromLite(uuid, lite)
  let title = info ? info.summary : '（空会话）'
  // B2（2026-08-26，二次修正）触发条件：仅当 tail 窗口内无 custom-title 时反向扫描。
  // 尾窗内任意 custom-title 都是文件里最后一条（重命名记录按位置递增，最新一条若已被
  // 推出窗口则更早的也必然在窗外）→ info.summary 的 customTitle 已是正确最新值，无需扫描；
  // 正常退出会话 tail 有 re-append 标题 → 不扫（count_scan 实证 122 个大文件仅 2 个需扫）。
  // 首版 B2 无条件扫（`tail !== head`）导致 /gateway/sessions 全量反向扫描所有大文件超时；
  // 原条件 `&& !info?.customTitle` 会从 head 回退到旧标题（B1 磁盘实证 d95e3566）不触发。
  // 小文件（tail === head，窗口即全文件）tail 提取天然是最新，无需扫描。
  if (tail !== head && extractJsonStringField(tail, 'customTitle') === undefined) {
    const last = await findLastCustomTitleCached(file, { size: lite.size, mtime: lite.mtime })
    if (last) title = last
  }
  return { title, messageCount, updatedAt: mtime }
}

// SessionMeta 全量缓存（2026-08-30）：listSessions 原先每次刷新都对所有会话文件重读 head/tail
// + 全量 countUserAssistant 同步正则扫描（122 文件 ≈ 15MB），而活动会话逐消息触发 SSE → 前端
// refreshList 风暴 → 网关事件循环被扫描窗口频繁占住 → rename 等 HTTP 请求排队（web 实测「点确定
// 后弹窗偶发悬挂数秒」）。键 = (size, mtimeMs)：转录只有 append（append 必变 size）→ 无假命中，
// 键设计与 B2 lastCustomTitleCache 同源（线上实证可靠）。null（读不到）不缓存，保持每次重试语义。
const sessionMetaCache = new Map<string, { size: number; mtimeMs: number; meta: SessionMeta }>()
async function parseMetaCached(file: string): Promise<SessionMeta | null> {
  let st: Awaited<ReturnType<typeof stat>>
  try {
    st = await stat(file)
  } catch {
    return null
  }
  const cached = sessionMetaCache.get(file)
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return cached.meta
  const meta = await parseMeta(file)
  if (meta) {
    sessionMetaCache.set(file, { size: st.size, mtimeMs: st.mtimeMs, meta })
    if (sessionMetaCache.size > 500) {
      // 防无限增长：清掉最旧一半（Map 保持插入序），同 lastCustomTitleCache
      const keys = [...sessionMetaCache.keys()]
      for (const k of keys.slice(0, 250)) sessionMetaCache.delete(k)
    }
  }
  return meta
}

// B 探活收敛（2026-08-27 P2）：与 utils/genericProcessUtils.isProcessRunning 同为 signal-0 探活，
// 唯一差异是 EPERM 语义——锁恢复方保守报「不在跑」（防误抢他人锁），网关场景 EPERM=进程存在但属
// 他人所有 → 应视为存活（活动记录不误删、子进程不误判退出）。差异用选项表达，全部调用点经由本别名。
const isPidAlive = (pid: number): boolean =>
  Number.isInteger(pid) && pid > 0 && isProcessRunning(pid, { epermMeansRunning: true })

/** Windows 杀进程树兜底：child.kill() 只杀直接进程，taskkill /F /T 连同子孙进程一并结束。 */
function killTree(pid: number): void {
  spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true })
}

/**
 * 杀进程树但豁免某进程及其子树（2026-09-05 网关自保）：网关是「跑 /server restart 或被自愈
 * 拉起」的那个 CLI 会话的子进程，web「关闭会话」命中宿主 CLI 时 taskkill /T 会连坐杀掉网关
 * 自身 → 先枚举全量进程表建父子索引，豁免进程在目标树内时逐个 taskkill 并整体跳过豁免子树；
 * 不在树内则走 taskkill /T 快路径。枚举失败直接抛错（交由调用方 sendError），不做降级。
 */
function killTreeExcept(pid: number, exempt: number): void {
  if (pid === exempt) return // 防 pid 复用巧合自杀
  const res = spawnSync(
    'powershell',
    ['-NoProfile', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress'],
    { encoding: 'utf8', windowsHide: true },
  )
  if (res.status !== 0 || !res.stdout?.trim()) {
    throw new Error(`进程树枚举失败（拒绝盲杀，防连坐网关）：${res.stderr || 'stdout 为空'}`)
  }
  const parsed: unknown = JSON.parse(res.stdout)
  const rows = (Array.isArray(parsed) ? parsed : [parsed]) as { ProcessId: number; ParentProcessId: number }[]
  const childMap = new Map<number, number[]>()
  for (const row of rows) {
    const cpid = Number(row.ProcessId)
    if (!Number.isInteger(cpid) || cpid <= 0) continue
    const ppid = Number(row.ParentProcessId)
    const list = childMap.get(ppid)
    if (list) list.push(cpid)
    else childMap.set(ppid, [cpid])
  }
  // BFS 收集 root 的整棵子树（seen 防 PID 环）
  const collectSubtree = (root: number): number[] => {
    const out = [root]
    const seen = new Set<number>([root])
    for (let i = 0; i < out.length; i++) {
      for (const c of childMap.get(out[i]) ?? []) {
        if (!seen.has(c)) {
          seen.add(c)
          out.push(c)
        }
      }
    }
    return out
  }
  const subtree = collectSubtree(pid)
  if (!subtree.includes(exempt)) {
    killTree(pid) // 网关不在目标树内：原 taskkill /T 快路径
    return
  }
  const skip = new Set(collectSubtree(exempt))
  for (const p of subtree) {
    if (skip.has(p)) continue
    spawnSync('taskkill', ['/F', '/PID', String(p)], { stdio: 'ignore', windowsHide: true })
  }
}

// C1 修复：惰性清扫。删除超过 TTL 的展示/活动记录，以及进程已退出的活动记录。
// 挂在 listSessions / pollSse / 上报入口上（这些是 Map 写入与读取的高频点），
// 不设独立定时器，避免无前端连接时空转。规模 = 活跃会话数，O(n) 遍历无碍。
function sweepStaleMaps(now = Date.now()): void {
  for (const [sid, v] of conversationDisplays) {
    if (now - v.updatedAt > DISPLAY_TTL_MS) conversationDisplays.delete(sid)
  }
  for (const [sid, v] of sessionActivity) {
    if (now - v.updatedAt > ACTIVITY_TTL_MS || !isPidAlive(v.pid)) sessionActivity.delete(sid)
  }
  for (const [sid, v] of sessionModels) {
    if (now - v.updatedAt > SESSION_MODEL_TTL_MS) sessionModels.delete(sid)
  }
  for (const [sid, v] of sessionQueues) {
    if (now - v.updatedAt > SESSION_QUEUE_TTL_MS) sessionQueues.delete(sid)
  }
}

async function listSessions(root: string) {
  sweepStaleMaps()
  ensureSseWatches(root) // P0 自愈兜底：前端拉列表即按当前项目布局增量补齐 watch
  const groups = findProjects(root)
  const sessions: unknown[] = []
  for (const g of groups) {
    let files: string[] = []
    try {
      files = readdirSync(g.dir).filter((f) => f.endsWith('.jsonl') && SESSION_UUID_RE.test(f))
    } catch {
      continue
    }
    // 并行读各会话 head/tail 元数据（异步 I/O，不再同步阻塞事件循环）；未变文件命中
    // sessionMetaCache 直接复用，只有真正变化的文件重读+重扫（2026-08-30）
    const metas = await Promise.all(files.map((f) => parseMetaCached(join(g.dir, f))))
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      const meta = metas[i]
      if (!meta || meta.sidechain) continue
      const p = join(g.dir, f)
      const uuid = f.replace(/\.jsonl$/, '')
      const act = sessionActivity.get(uuid)
      // 会话状态（2026-08-25 定案「web 与 CLI 一视同仁」；2026-09-04 根修恒绿）：一律经 activity
      // 上报（act + 存活 pid）判定——busy=绿 · idle/waiting=红/橘 · 停止/进程退出 → 无点（透明）。
      // 旧案 webSessions 短路恒报 busy：web 会话回合结束进程常驻仍显示绿点，已废；
      // webSessions 仅保留 spawn 幂等/stop 路由/重启收养用途，不再参与显示判定。
      const state = act && isPidAlive(act.pid) ? act.status : null
      sessions.push({
        id: Buffer.from(p).toString('base64url'),
        projectLabel: g.label,
        projectScope: g.scope,
        preview: g.hasPreview,
        file: basename(p),
        title: meta.title,
        messageCount: meta.messageCount,
        updatedAt: meta.updatedAt,
        state,
        // 2026-09-06 回合中止权威时刻（有才有键）：web 首载恢复 turnEndFlags，防打断后刷新
        // 「正在处理」无限计时复活（closeSeg 二信号之一）。
        turnEndAt: turnEndAt.get(uuid),
      })
    }
  }
  sessions.sort((a, b) => ((b as { updatedAt: number }).updatedAt) - ((a as { updatedAt: number }).updatedAt))
  return { workspace: root, groups, sessions }
}

function decodeSessionPath(id: string, root: string): { path: string; uuid: string } {
  const p = Buffer.from(id, 'base64url').toString('utf8')
  const rootWithSep = root.endsWith(sep) ? root : root + sep
  if (!p.startsWith(rootWithSep)) throw new Error('越界路径被拒绝: ' + p)
  return { path: p, uuid: basename(p).replace(/\.jsonl$/, '') }
}

// 上下文占用（2026-08-23 dsh ContextMeter 移植数据源）：取转录最后一条 assistant 的 message.usage，
// usedTokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens（该轮发送的完整
// 上下文 token 数），除以 getContextWindowForModel(model)（auto-compact 同源窗口）。无 usage 返回 null。
function extractContextUsage(records: Record<string, unknown>[]): Record<string, unknown> | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    if (!r || r.type !== 'assistant') continue
    const msg = r.message as Record<string, unknown> | undefined
    const usage = msg?.usage as Record<string, unknown> | undefined
    if (!usage) continue
    const input = Number(usage.input_tokens) || 0
    const cacheCreate = Number(usage.cache_creation_input_tokens) || 0
    const cacheRead = Number(usage.cache_read_input_tokens) || 0
    if (!(input || cacheCreate || cacheRead)) continue
    const model = typeof msg?.model === 'string' && msg.model ? msg.model : ''
    const contextWindow = model ? getContextWindowForModel(model) : 0
    if (!contextWindow) continue
    const usedTokens = input + cacheCreate + cacheRead
    const percent = Math.min(100, Math.round((usedTokens / contextWindow) * 100))
    return { usedTokens, contextWindow, percent, model }
  }
  return null
}

function readSession(id: string, root: string) {
  const { path: p } = decodeSessionPath(id, root)
  // 2026-08-23 web 独立会话：新会话进程刚 spawn 时 jsonl 可能尚未落盘 → 返回空消息而非 500
  if (!existsSync(p) || !statSync(p).isFile()) return { file: basename(p), path: p, messages: [], context: null, cwd: undefined }
  const raw = readFileSync(p, 'utf8')
  const records: Record<string, unknown>[] = []
  let cwd: string | undefined
  // 2026-08-30 共同后端定案（接力文档清单#3）：删除 queue-op FIFO 配对补插 + guide 打标
  // 后置匹配整块（~85 行）。jsonl 的 queue-operation 日志（enqueue/dequeue/remove）无可靠配对
  // 依据（dequeue/remove 不带 content，FIFO 混序消耗即错位、double 风险），从日志反推渲染事件
  // 是本链路全部渲染 bug 的总根源。新语义：
  //  - dequeue 终结 → user 条目天然落盘于消费位置 = CLI 显示位置，前端切段直接消费；
  //  - 回合中注入 → 实时链路由 filterConversationForDisplay 的 queued_command attachment
  //    分支输出（injected:true，内存 messages 权威，conversationDisplay.ts）；非 ant 环境
  //    attachment 不落盘（isLoggableMessage）→ 历史回放无注入引导 = 与 CLI resume 行为同构；
  //  - 排队中 → 队列快照链（CLI queue-state 上报 → /gateway/session.queued + SSE 群发）。
  const lines = raw.split('\n')
  for (const line of lines) {
    const s = line.trim()
    if (!s) continue
    try {
      const r = JSON.parse(s)
      // 会话启动根（2026-08-29 变更卡相对路径显示）：转录记录自带 cwd（= 进程启动 cwd），
      // 取首条即得；前端据此把 fileChange 绝对路径剥成相对启动根路径
      if (!cwd && typeof (r as { cwd?: unknown }).cwd === 'string' && (r as { cwd: string }).cwd) cwd = (r as { cwd: string }).cwd
      // 只保留 normalizeMessages/filterConversationForDisplay 能处理的类型。
      // custom-title/agent-name/file-history-snapshot/queue-operation/last-prompt 等
      // 元记录会让 normalizeMessages 的 switch 无分支返回 undefined → isNotEmptyMessage
      // 崩溃（历史会话全部 500，遥测端看不了）。user/assistant/system 之外的展示不需要。
      // attachment 保留（落盘例外 hook_additional_context / 未来 ant 环境；filter 新分支可处理）。
      if (
        r &&
        typeof r === 'object' &&
        typeof (r as { type?: unknown }).type === 'string' &&
        ['user', 'assistant', 'system', 'attachment', 'progress'].includes((r as { type: string }).type)
      ) {
        records.push(r)
      }
    } catch {
      /* 跳过坏行 */
    }
  }
  // 复用 CLI 权威过滤（conversationDisplay.filterConversationForDisplay），
  // 与 CLI 上报的 display 同源，不再本地复刻 isSynth/toBlocks 等逻辑。
  // mode 用 'prompt-tail-think'（2026-08-27 思考等权展示·方案B）：已收尾历史 thinking 全隐藏
  // （原 'prompt' 语义不变），未收尾尾巴放行最后一块 thinking → 前端 liveFoldBody 以 vacuumState=
  // 'think' 驱动「正在思考」行内状态（CLI 高 effort 思考期 web 不再全空白）。原 'transcript' 曾
  // 保留全局最后一个 thinking，遥测端历史会话因此泄露不该出现的思考过程（废弃）。
  const messages = filterConversationForDisplay(records as never, 'prompt-tail-think')
  const context = extractContextUsage(records)
  return { file: basename(p), path: p, messages, context, cwd }
}

// 统一时间戳为毫秒（CLI 导出与 /gateway/session 均用数字；字符串 ISO 兜底解析）。
function tsMs(ts: unknown): number | undefined {
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts
  if (typeof ts === 'string') {
    const n = Date.parse(ts)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}

type MergeMsg = { role: string; blocks: unknown[]; timestamp?: unknown; injected?: boolean }
// 合并展示消息：以磁盘 jsonl 全量历史为基底，把 live（CLI 上报的内存窗口）中比磁盘末尾
// 更新的消息追加到尾部。原因：CLI 内存窗口在上下文压缩/续接后会缺历史真实用户消息，
// 直接返回 live 会让遥测端看不到完整历史（前端按真实用户消息切段，历史被折叠成一个 blob）；
// 磁盘是完整权威。live 未越过磁盘末尾 → 磁盘已覆盖 live 全部，整段丢弃 live 不重复。
// 2026-08-30 晚：queued_command attachment 已改为落盘（isLoggableMessage 放行，物理位置 =
// 消费位置 = 感知序）→ 注入引导由磁盘权威提供，此处不再做 live injected 归并
// （归并会在磁盘已有注入时产生双份；12:54 版归并基于「不落盘」前提，随落盘一并作废）。
function mergeDisplayMessages(
  disk: MergeMsg[],
  live: MergeMsg[],
): MergeMsg[] {
  if (!live.length) return disk
  if (!disk.length) return live
  const dLast = tsMs(disk[disk.length - 1].timestamp)
  const lLast = tsMs(live[live.length - 1].timestamp)
  if (dLast == null || lLast == null || lLast <= dLast) return disk
  const tail = live.filter((m) => (tsMs(m.timestamp) ?? 0) > dLast)
  return tail.length ? [...disk, ...tail] : disk
}

// ============================================================================
// 默认预览页数据（GET /gateway/project）：项目无 .claude/preview 时，前端 iframe 加载
// web/default-preview/（GitHub 仓库风格），本函数提供文件树 / README / 会话元信息。
//  - 文件树：递归扫项目根，跳过重型/隐藏目录（.git/node_modules/.claude/.trash/dist 等），
//    目录在前、名称字典序；深度 ≤4、条目预算 ≤400（node_modules 等被跳过，正常项目足够）。
//  - README：项目根 README*（.md/.markdown/.txt）优先，内容截断防超大 payload。
//  - 描述：从 README 首行标题推断，兜底项目名。
// ============================================================================
const SKIP_TREE_DIRS = new Set(['.git', 'node_modules', '.claude', '.trash', '.cache', 'dist', 'cli-dist', '.idea', '.vscode'])
type TreeNode = { name: string; type: 'file' | 'dir'; children?: TreeNode[] }

/** 轻量列出一层直接子项（不递归），供预算耗尽时保证目录至少可展开一层。 */
function listOneLevel(dir: string): TreeNode[] {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  const out: TreeNode[] = []
  for (const e of entries) {
    if (out.length >= 50) break
    if (e.name.startsWith('.')) continue
    if (e.isDirectory() && SKIP_TREE_DIRS.has(e.name)) continue
    out.push(e.isDirectory() ? { name: e.name, type: 'dir' } : { name: e.name, type: 'file' })
  }
  return out
}

function walkProjectTree(dir: string, depth: number, budget: { n: number }): TreeNode[] | null {
  if (depth > 3) return null
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  // 每层 cap 50 防单层巨目录。预算按同级目录数平均分摊（同级互不挤占），
  // 深度到顶用 listOneLevel 兜底，保证任意目录至少可展开看到下一级。
  const out: TreeNode[] = []
  for (const e of entries) {
    if (out.length >= 50) break
    if (budget.n <= 0) break
    if (e.name.startsWith('.')) continue
    if (e.isDirectory() && SKIP_TREE_DIRS.has(e.name)) continue
    budget.n--
    out.push(e.isDirectory() ? { name: e.name, type: 'dir' } : { name: e.name, type: 'file' })
  }
  const dirs = out.filter((it) => it.type === 'dir')
  if (dirs.length) {
    const per = Math.floor(budget.n / dirs.length)
    for (const it of dirs) {
      const sub = { n: Math.max(0, per) }
      const children = walkProjectTree(join(dir, it.name), depth + 1, sub)
      if (children && children.length) it.children = children
      else {
        const shallow = listOneLevel(join(dir, it.name))
        if (shallow.length) it.children = shallow
      }
    }
    budget.n = 0
  }
  return out
}

function findProjectReadme(dir: string): string | null {
  const names = ['README.md', 'readme.md', 'README.markdown', 'readme.markdown', 'README.txt', 'readme.txt']
  for (const n of names) {
    const p = join(dir, n)
    if (existsSync(p) && statSync(p).isFile()) {
      const txt = readFileSync(p, 'utf8')
      return txt.length > 200 * 1024 ? txt.slice(0, 200 * 1024) : txt
    }
  }
  try {
    const hit = readdirSync(dir).find((f) => /^readme/i.test(f) && !/^\./.test(f))
    if (hit) {
      const p = join(dir, hit)
      if (existsSync(p) && statSync(p).isFile()) {
        const txt = readFileSync(p, 'utf8')
        return txt.length > 200 * 1024 ? txt.slice(0, 200 * 1024) : txt
      }
    }
  } catch {
    /* 忽略 */
  }
  return null
}

function deriveProjectDescription(readme: string | null, label: string): string {
  if (readme) {
    for (const line of readme.split('\n')) {
      const m = /^#\s+(.+?)\s*$/.exec(line)
      if (m) return m[1].trim().slice(0, 120)
    }
  }
  return label
}

// ============================================================================
// 插件/技能清单（便携根扫描；供 MGR 管理视图 GET /gateway/plugins）
//  - 已安装插件：.claude/plugins/<name>/.claude-plugin/plugin.json
//  - 已安装技能：.claude/skills/<name>/SKILL.md 的 frontmatter（name/description）
//  - 公开市场：.claude/plugins/marketplaces/*/.claude-plugin/marketplace.json 的 plugins[]
//    （技能类条目按名称含 "skill" 归类；inst=1 表示已安装，便于前端打「已安装」徽标）
// ============================================================================
function readJsonObject(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function parseSkillFrontmatter(text: string): { name: string; description: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  const out = { name: '', description: '' }
  if (!m) return out
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const key = line.slice(0, i).trim()
    const val = line.slice(i + 1).trim()
    if (key === 'name') out.name = val
    else if (key === 'description') out.description = val
  }
  return out
}

function listPlugins(root: string): Record<string, unknown> {
  const pluginsDir = join(root, '.claude', 'plugins')
  const skillsDir = join(root, '.claude', 'skills')

  // 已安装插件（跳过 data/marketplaces 等系统目录与隐藏目录）
  const personalPlugins: Array<Record<string, unknown>> = []
  if (isDir(pluginsDir)) {
    for (const e of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'data' || e.name === 'marketplaces') continue
      const m = readJsonObject(join(pluginsDir, e.name, '.claude-plugin', 'plugin.json'))
      if (!m) continue
      personalPlugins.push({
        n: String(m.name || e.name),
        d: String(m.description || ''),
        v: String(m.version || ''),
        inst: 1,
      })
    }
  }

  // 已安装技能（只有带 SKILL.md 的目录才算技能）
  const personalSkills: Array<Record<string, unknown>> = []
  if (isDir(skillsDir)) {
    for (const e of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      const fp = join(skillsDir, e.name, 'SKILL.md')
      if (!existsSync(fp)) continue
      const fm = parseSkillFrontmatter(readFileSync(fp, 'utf8'))
      personalSkills.push({ n: fm.name || e.name, d: fm.description, inst: 1 })
    }
  }

  // 公开市场（官方 marketplace.json 的 plugins[]；技能条目按名称含 skill 归类）
  const marketPlugins: Array<Record<string, unknown>> = []
  const marketSkills: Array<Record<string, unknown>> = []
  const mktDir = join(pluginsDir, 'marketplaces')
  if (isDir(mktDir)) {
    const installed = new Set(personalPlugins.map((p) => String(p.n)))
    for (const e of readdirSync(mktDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const m = readJsonObject(join(mktDir, e.name, '.claude-plugin', 'marketplace.json'))
      const items = Array.isArray(m?.plugins) ? (m.plugins as Array<{ name?: unknown; description?: unknown }>) : []
      for (const it of items) {
        const name = String(it?.name || '')
        if (!name) continue
        const rec = { n: name, d: String(it?.description || ''), inst: installed.has(name) ? 1 : 0 }
        if (/skill/i.test(name)) marketSkills.push(rec)
        else marketPlugins.push(rec)
      }
    }
  }

  // 已安装置顶（inst 降序优先），同安装状态按名称字母序
  const sortN = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    (Number(b.inst) - Number(a.inst)) || String(a.n).localeCompare(String(b.n))
  personalPlugins.sort(sortN)
  personalSkills.sort(sortN)
  marketPlugins.sort(sortN)
  marketSkills.sort(sortN)

  return {
    workspace: root,
    plugins: { personal: personalPlugins, public: marketPlugins },
    skills: { personal: personalSkills, public: marketSkills },
  }
}

// ============================================================================
// 模型配置（MGR 管理视图 GET /gateway/models，与 SubPj1 server.mjs 同逻辑）
// 数据源 = 便携根 .claude/credentials.json 凭据池各 provider 的可用模型 +
//          settings.json 的 model 字段 + env 中模型类环境变量 + 进程实际环境。
// 只读展示，不改写任何配置。
// ============================================================================
const MODEL_ENV_KEYS = [
  'ANTHROPIC_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
]
const MODEL_PROVIDER_LABELS: Record<string, string> = {
  deepseek: 'DeepSeek',
  anthropic: 'Claude · Anthropic',
  claude: 'Claude · Anthropic',
  openai: 'OpenAI',
  qwen: 'Qwen · 通义千问',
  dashscope: 'Qwen · 通义千问',
  gemini: 'Google Gemini',
  glm: '智谱 GLM',
  moonshot: 'Moonshot Kimi',
  openrouter: 'OpenRouter',
}
function modelProviderLabel(name: string): string {
  return MODEL_PROVIDER_LABELS[name.toLowerCase()] || name
}
function listModels(root: string): Record<string, unknown> {
  // 读侧走官方统一设置服务（2026-08-27 P1 修复）：getSettingsForSource('userSettings') 解析到
  // 便携根 .claude/settings.json（与写侧 updateSettingsForSource 同源，写后缓存自动失效）。
  const settings = getSettingsForSource('userSettings') ?? ({} as SettingsJson)
  const items: Array<{ k: string; v: string; src: string }> = []
  if (settings.model !== undefined) items.push({ k: 'model', v: String(settings.model), src: 'settings.json' })
  const env0 = settings.env && typeof settings.env === 'object' ? (settings.env as Record<string, unknown>) : {}
  const seen = new Set(items.map((i) => i.k))
  for (const k of MODEL_ENV_KEYS) {
    if (env0[k] !== undefined && !seen.has(k)) {
      items.push({ k, v: String(env0[k]), src: 'settings.json → env' })
      seen.add(k)
    }
  }
  for (const k of MODEL_ENV_KEYS) {
    if (process.env[k] !== undefined && !seen.has(k)) {
      items.push({ k, v: String(process.env[k]), src: '进程环境变量' })
      seen.add(k)
    }
  }
  // 凭据池（2026-08-27 P1 修复）：不再手解 credentials.json，复用官方 loadCredentials()
  // （providers[].models[] = 各供应商实际可用的模型清单）
  const creds = loadCredentials()
  const poolRows: Array<{ k: string; v: string; src: string; vision?: boolean; provider?: string }> = []
  const poolSet = new Set<string>()
  for (const [name, cfg0] of Object.entries(creds.providers)) {
    const cfg = (cfg0 && typeof cfg0 === 'object' ? cfg0 : {}) as Record<string, unknown>
    const models = Array.isArray(cfg.models) ? (cfg.models as string[]) : []
    const mv =
      cfg.modelVision && typeof cfg.modelVision === 'object' ? (cfg.modelVision as Record<string, unknown>) : {}
    const label = modelProviderLabel(name)
    for (const m of models) {
      if (poolSet.has(m)) continue
      poolSet.add(m)
      // provider=真实归属供应商标签（2026-08-29 直接切模型自动切供应商：前端据此分组/跨商直选，免启发式前缀判定）
      poolRows.push({ k: m, v: m, src: `凭据池·${label}`, vision: mv[m] === true, provider: label })
    }
  }
  // 已作为凭据池模型展示的 settings/env 条目不再重复（同一模型只出现一次）
  const cfgItems = items.filter((it) => !poolSet.has(it.v))
  // 当前真实启用模型 = 凭据池 activeModel（与 CLI getUserSpecifiedModelSetting 同源，优先级高于 settings.model）；
  // 无凭据池配置时回落到 settings.model，保证显示值与 CLI 实际使用一致。
  const activeModel = getActiveModel()
  const activeCfg = getActiveProviderConfig()
  return {
    workspace: root,
    model: activeModel ?? (settings.model !== undefined ? String(settings.model) : null),
    // 2026-08-28 遥测端图片门控：当前生效模型是否识图（凭据池 override，/key vision <model> on；
    // 默认非识图）→ 前端据此显隐图片上传入口
    vision: activeModel ? modelSupportsVision(activeModel) : false,
    activeProvider: creds.activeProvider || null,
    activeModel,
    // 当前供应商可切换的模型清单（每会话模型切换的校验集；前端模型浮窗据此渲染）
    providerModels: activeCfg && Array.isArray(activeCfg.models) ? (activeCfg.models as string[]) : [],
    effortLevel: settings.effortLevel !== undefined ? String(settings.effortLevel) : null,
    source: getSettingsFilePathForSource('userSettings') ?? null,
    items: [...poolRows, ...cfgItems],
  }
}

/** 统一群发（P2 收敛）：逐个发送并吞掉单个客户端断开异常，broadcast/broadcastToClients/pollSse/内联群发共用。 */
function sendAll<T>(targets: Iterable<T>, send: (t: T) => void): void {
  for (const t of targets) {
    try {
      send(t)
    } catch {
      /* 断开忽略 */
    }
  }
}

/** 广播控制消息给所有在线 CLI 进程（/clients 注册的 WS）。 */
function broadcastToClients(msg: unknown): void {
  const s = JSON.stringify(msg)
  sendAll(cliClients.values(), (c) => c.send(s))
}

/** 精确路由控制消息到指定会话（/clients 注册的 WS）；无 sessionId/未命中 → 返回 false（不广播兜底，2026-08-23 用户定案）。 */
function routeToClient(sessionId: string | undefined, msg: unknown): boolean {
  if (!sessionId) return false
  const target = cliClients.get(sessionId)
  if (target && target.readyState === WebSocket.OPEN) {
    try {
      target.send(JSON.stringify(msg))
      return true
    } catch {
      /* 断开忽略，返回 false（不广播兜底） */
    }
  }
  return false
}

// ============================================================================
// SSE 实时事件（jsonl 变化，事件驱动）
// ============================================================================
// O4：watch 事件 → 去抖 → pollSse 扫描。watch 事件仅做「有变化」的提示，真正 diff 仍由 pollSse
// 用 size/mtime 判定（与旧轮询同一逻辑），保证跨平台（尤其 Windows ReadDirectoryChangesW 只给
// 文件名不给内容）也能准确识别具体哪个会话文件变了。
function scheduleSseFlush(root: string): void {
  if (sseClients.size === 0 || sseDebounce) return
  sseDebounce = setTimeout(() => {
    sseDebounce = null
    pollSse(root)
  }, 250)
}
function ensureSseWatches(root: string): void {
  // P0 修复（2026-08-27）：原版 `size > 0` 早退只在首个 SSE 订阅时建一批 watch，网关运行中
  // 新建的项目目录永不覆盖，其会话变化无法触发 SSE → 改为增量补建：每次调用按 findProjects
  // 当前结果为缺失的目录补 watch；watcher error（Windows 目录删除等失效）摘除条目，下次调用自动重建。
  for (const g of findProjects(root)) {
    if (sseWatches.has(g.dir)) continue
    try {
      const dir = g.dir
      const w = watch(dir, () => scheduleSseFlush(root))
      w.on('error', () => {
        if (sseWatches.get(dir) === w) sseWatches.delete(dir)
      })
      sseWatches.set(dir, w)
    } catch {
      /* 目录不存在/被移除，忽略 */
    }
  }
}
function stopSseWatches(): void {
  for (const w of sseWatches.values()) {
    try {
      w.close()
    } catch {
      /* 忽略 */
    }
  }
  sseWatches.clear()
  if (sseDebounce) {
    clearTimeout(sseDebounce)
    sseDebounce = null
  }
}

function pollSse(root: string): void {
  if (sseClients.size === 0) return
  sweepStaleMaps()
  const groups = findProjects(root)
  for (const g of groups) {
    let files: string[] = []
    try {
      files = readdirSync(g.dir).filter((f) => f.endsWith('.jsonl') && SESSION_UUID_RE.test(f))
    } catch {
      continue
    }
    for (const f of files) {
      const p = join(g.dir, f)
      let st: { size: number; mtimeMs: number }
      try {
        st = statSync(p)
      } catch {
        continue
      }
      const prev = sseSizes.get(p)
      const changed = !!prev && (prev.size !== st.size || prev.mtime !== st.mtimeMs)
      if (ssePrimed && (changed || !prev)) {
        const obj = { type: 'updated', hash: f.replace(/\.jsonl$/, ''), file: f, updatedAt: st.mtimeMs }
        const s = `data: ${JSON.stringify(obj)}\n\n`
        sendAll(sseClients, (c) => {
          c.res.write(s)
        })
      }
      sseSizes.set(p, { size: st.size, mtime: st.mtimeMs })
    }
  }
  ssePrimed = true
}

// ============================================================================
// HTTP / WS
// ============================================================================
type ServerResponse = import('node:http').ServerResponse
// O2：统一 JSON 响应帮助函数，消除 handleRequest 内每路由重复的 writeHead/end/JSON.stringify
function sendJson(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' })
  res.end(JSON.stringify(obj))
}
function sendError(res: ServerResponse, e: unknown): void {
  sendJson(res, 500, { error: String((e && (e as Error).message) || e) })
}
/** readReportBody 统一 catch 响应（P2 收敛）：超限 413 payload too large，其余一律 400 invalid body。 */
function sendReportBodyError(res: ServerResponse, error: unknown): void {
  const status = error instanceof ReportBodyTooLargeError ? 413 : 400
  sendJson(res, status, { error: status === 413 ? 'payload too large' : 'invalid body' })
}

async function handleRequest(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, root: string): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`)
  // 直连客户端自愈：凡同网段 IPv4 设备发来 HTTP 请求即定向推 legacy announce（iPad 多播被吞
  // 场景，直连 8124 即建立 floria.local 解析——见 mdnsPushToReachableClient）
  try {
    mdnsPushToReachableClient(req.socket.remoteAddress ?? '')
  } catch {
    /* 推送失败不影响请求 */
  }
  // 安全加固（2026-08-15）：HTTP 数据接口与 WS 升级一致要求 token。
  //  - /gateway/health 保持公开探活（/server status、前端 detectGateway 只读 mode），响应已精简不含路径泄露；
  //  - 其余 /gateway/*（会话/插件/SSE/上报写接口）与 /preview/* 一律校验「query token 或 cookie 票证」，失败 401。
  //  - /default-preview/* 是网关内置静态页（index.html/default.css/default.js，无敏感数据），
  //    不锁 token（页内相对资源请求不带 token，锁了会 401 致 JS/CSS 加载失败）；敏感数据在
  //    /gateway/project（属于 /gateway/* 已受保护），由页面 JS 从自身 URL query 读 token 附加。
  // 2026-08-28 设备认证配对（用户定案：浏览器侧完全删除 token 授权链）：
  //  - 浏览器授权只走 floria_auth cookie 票证（手动配对：设备门显示请求码 → PC `/server auth add`
  //    → 设备 GET /gateway/activate?code=<码> 种 cookie）→ 授权设备 URL 干净、永久免认证。
  //  - query token 仅剩 gateway-token（CLI 上报/内部链路），只放行请求、不种 cookie（浏览器不可用
  //    它获得授权；浏览器 URL 也不再出现 token）。
  const qToken = url.searchParams.get('token')
  const qOk = qToken != null && qToken !== '' && qToken === currentToken
  const cookieVal = parseCookieHeader(req.headers.cookie)[AUTH_COOKIE_NAME]
  const cookieOk = isGatewayTicket(cookieVal)
  const isProtected =
    (url.pathname.startsWith('/gateway/') && url.pathname !== '/gateway/health' && url.pathname !== '/gateway/activate') ||
    url.pathname.startsWith('/preview/')
  if (isProtected && !qOk && !cookieOk) {
    sendJson(res, 401, { error: 'unauthorized' })
    return
  }
  // 授权设备活跃回写（2026-09-01 /server auth 设备情况展示：UA/IP/lastSeen，60s 写盘节流）
  if (isProtected && cookieOk) {
    touchGatewayTicket(cookieVal, req.headers['user-agent'], remoteIPv4(req.socket.remoteAddress))
  }
  // 设备配对激活（公开端点，防枚举靠请求码熵）：码在授权名单（/server auth add）→ 种 HttpOnly
  // floria_auth cookie（票证=码本身，1 年）；不在名单 → 403。前端门态轮询此端点实现「授权后自动进入」。
  if (req.method === 'GET' && url.pathname === '/gateway/activate') {
    const code = (url.searchParams.get('code') || '').trim()
    if (code && isGatewayTicket(code)) {
      // 设备自报类型（iPad 等 UA 无解场景）随配对轮询上报，记入设备情况
      const hint = (url.searchParams.get('device') || '').trim()
      if (hint) touchGatewayTicket(code, undefined, undefined, hint)
      res.setHeader('Set-Cookie', `${AUTH_COOKIE_NAME}=${code}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`)
      sendJson(res, 200, { ok: true })
    } else {
      sendJson(res, 403, { ok: false, error: 'not authorized' })
    }
    return
  }
  if (req.method === 'GET' && url.pathname === '/gateway/health') {
    sendJson(res, 200, { ok: true, mode: 'gateway' })
    return
  }
  // 2026-08-17 独立网关优雅关闭端点（受上方 /gateway/* token 校验保护）：/server off 调用。
  // 先回响应，再 stopLocalGateway + 退出进程（网关是独立 --gateway 进程，exit 即释放端口）。
  if (req.method === 'POST' && url.pathname === '/gateway/shutdown') {
    sendJson(res, 200, { ok: true, stopping: true })
    setTimeout(() => {
      stopLocalGateway()
      process.exit(0)
    }, 50)
    return
  }
  if (req.method === 'GET' && url.pathname === '/gateway/sessions') {
    try {
      sendJson(res, 200, await listSessions(root))
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  if (req.method === 'GET' && url.pathname === '/gateway/plugins') {
    try {
      sendJson(res, 200, listPlugins(root))
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  if (req.method === 'GET' && url.pathname === '/gateway/models') {
    try {
      sendJson(res, 200, listModels(root))
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  // 2026-08-22 模型/思考等级切换（受上方 /gateway/* token 校验保护）：
  //   POST /gateway/model {model?, effortLevel?, sessionId?}
  //   - model → 每会话切换：校验放宽到凭据池全部供应商（findModelProvider），归属其它供应商时
  //     自动全局切供应商（ensureProviderForModel，2026-08-29）；按 sessionId 精确路由
  //     到对应 CLI 进程（{type:'model'} 实时生效，该进程 STATE 覆盖仅本会话；无 sessionId/未命中广播兜底）。
  //   - effortLevel → 写 settings.json effortLevel（全局持久化）+ 广播 {type:'effort'} 实时生效。
  if (req.method === 'POST' && url.pathname === '/gateway/model') {
    try {
      const parsed = await readReportBody(req)
      const model = typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : undefined
      const sessionId =
        typeof parsed.sessionId === 'string' && parsed.sessionId.trim() ? parsed.sessionId.trim() : undefined
      const rawEffort =
        typeof parsed.effortLevel === 'string' && parsed.effortLevel.trim() ? parsed.effortLevel.trim() : undefined
      const defaultModel =
        typeof parsed.defaultModel === 'string' && parsed.defaultModel.trim() ? parsed.defaultModel.trim() : undefined
      // 'off'/'auto'/'default' = 清除思考等级（delete settings.effortLevel + 广播 null → CLI effortValue=undefined）
      const effortLevel =
        rawEffort === 'off' || rawEffort === 'auto' || rawEffort === 'default' ? null : rawEffort
      if (model === undefined && effortLevel === undefined && defaultModel === undefined) {
        sendJson(res, 400, { error: 'invalid body' })
        return
      }
      if (model !== undefined) {
        // 2026-08-29 直接切模型自动切供应商：校验放宽为凭据池全部供应商（findModelProvider）；
        // 归属其它供应商 → ensureProviderForModel 全局切 activeProvider + 写该商 activeModel（key/baseUrl 随之生效）
        if (!findModelProvider(model)) {
          sendJson(res, 400, { error: `model "${model}" 不在凭据池任何供应商模型清单中` })
          return
        }
        ensureProviderForModel(model)
      }
      if (defaultModel !== undefined) {
        // 设为全局默认模型：2026-08-29 起跨供应商自动切换——switchModelAuto 解析归属供应商、
        // 切 activeProvider + 写该商 activeModel（原 switchModel 仅限当前供应商清单内）；
        // 仅全局默认、不广播不路由，当前会话不受影响（2026-08-23 用户定案）
        if (!switchModelAuto(defaultModel)) {
          sendJson(res, 400, { error: `model "${defaultModel}" 不在凭据池任何供应商模型清单中` })
          return
        }
      }
      if (effortLevel !== undefined) {
        // E（2026-08-26）：统一设置服务——不再手写 settings.json，改接官方 updateSettingsForSource
        // （校验/合并/删除/缓存失效/失败暴露全在服务内）。'userSettings' 写便携根
        // getClaudeConfigHomeDir()/settings.json（便携模式 = 便携根/.claude，与旧 writeSettingsModel 同路径）。
        // effortLevel 为 null（off/auto/default 清除）→ 传 undefined → mergeWith 删除该键；
        // 写盘失败 → 返回 500 暴露（不再静默），也不广播（避免 CLI 内存与磁盘全局态不一致）。
        const r = updateSettingsForSource('userSettings', { effortLevel: effortLevel ?? undefined })
        if (r.error) {
          sendJson(res, 500, { error: `写 settings.json 失败：${r.error.message}` })
          return
        }
      }
      if (model !== undefined) {
        // model 每会话覆盖，精确路由到目标会话；未在线/未连接则拒绝而非广播兜底（2026-08-23 用户定案）
        if (!routeToClient(sessionId, { type: 'model', value: model })) {
          sendJson(res, 400, { error: '目标会话未在线，无法切换模型' })
          return
        }
      }
      if (effortLevel !== undefined) broadcastToClients({ type: 'effort', value: effortLevel })
      sendJson(res, 200, { ok: true, model: model ?? null, effortLevel: effortLevel ?? null, defaultModel: defaultModel ?? null })
    } catch (error) {
      sendReportBodyError(res, error)
    }
    return
  }
  // 2026-08-23 web 独立会话（受上方 /gateway/* token 校验保护）：
  //   POST /gateway/wsession {resume?} → 预分配 sid 立即返回 {id,hash}，spawn+注册后台进行（2026-09-06 异步化）；
  //   resume 恢复已有会话同路径。POST /gateway/wsession/stop {id} → 关闭会话（2026-09-08 起 web spawn/终端直开统一 gracefulStopCli：shutdown 优雅退出 + 3s 树杀兜底）
  if (req.method === 'POST' && url.pathname === '/gateway/wsession') {
    try {
      const parsed = await readReportBody(req)
      const resume =
        typeof parsed.resume === 'string' && parsed.resume.trim() ? parsed.resume.trim() : undefined
      // 2026-08-24 指定项目：project = findProjects 命中的项目 label → 会话落该项目 .claude/projects
      const project =
        typeof parsed.project === 'string' && parsed.project.trim() ? parsed.project.trim() : undefined
      // 2026-09-06 异步化（首条消息单状态根治，用户「可不可以只有一个状态」）：预分配 sid 立即
      // 返回，spawn+注册后台进行——前端瞬时进会话态（乐观气泡直通落盘），消除同步等注册 1-2s 的
      // 「创建中」中间态。spawn 期间到达的 send 经 pendingDeliveries 暂存、CLI 注册钩子补投；
      // 失败/注册超时经 SSE ws-failed 群发（前端清合成条目+回滚首条事务+报错），不留静默。
      const sid = resume ?? randomUUID()
      spawnWebSession(resume, project, sid).catch((e) => {
        console.error(`[gateway] wsession: 后台启动失败 sid=${sid}`, e)
        pendingDeliveries.delete(sid)
        const s = `data: ${JSON.stringify({ type: 'ws-failed', session: sid, error: e?.message ?? String(e) })}\n\n`
        sendAll(sseClients, (c) => { c.res.write(s) })
      })
      // id = listSessions 同源 base64url（web 会话落盘 <项目根>/.claude/projects；笔=全局根、项目=项目根）；
      // hash = 前端导航/WS 过滤用的会话哈希（= 转录文件名去 .jsonl，即 sessionId）
      // resume 未显式指定项目时按磁盘会话文件定位（与 spawnWebSession effectiveProject 同源）
      let projLabel = project
      if (resume && !projLabel) projLabel = sessionProjectRootOf(resume)?.projectLabel
      const projRoot = webSessionProjectRoot(projLabel)
      const id = Buffer.from(join(projRoot, '.claude', 'projects', `${sid}.jsonl`)).toString('base64url')
      sendJson(res, 200, { id, hash: sid, resumed: !!resume, project: project ?? null })
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/gateway/wsession/stop') {
    try {
      const parsed = await readReportBody(req)
      const id = typeof parsed.id === 'string' && parsed.id.trim() ? parsed.id.trim() : ''
      // 2026-09-04 关闭会话扩展：web 会话（网关 spawn）走 stopWebSession；非 web spawn 的在线
      // 会话（用户终端直开，activity 上报 pid=CLI 进程本体 process.pid）按同协议优雅停——
      // 2026-09-08 起两会话形态统一走 gracefulStopCli（shutdown → CLI exit 0 → WT 自动收 tab；
      // 3s 树杀兜底豁免网关子树，防关宿主会话连坐杀网关），「关闭会话」对任何在线会话都是
      // 两次 Ctrl+C 退出语义，不存在需要回终端手动退的分支。
      let ok = id ? stopWebSession(id) : false
      if (!ok && id) {
        const act = sessionActivity.get(id)
        if (act && act.pid && isPidAlive(act.pid)) {
          gracefulStopCli(id, act.pid)
          sessionActivity.delete(id)
          ok = true
        }
      }
      sendJson(res, 200, { ok })
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  // 2026-08-24 审批链路诊断（受 token 保护）：返回最近审批轨迹 + 连接概览，用于调试「审批卡不弹」。
  if (req.method === 'GET' && url.pathname === '/gateway/diagnostics') {
    sendJson(res, 200, {
      trail: approvalTrailSnapshot(),
      cliClients: [...cliClients.keys()],
      sockets: sockets.size,
      sseClients: sseClients.size,
      webSessions: [...webSessions.keys()],
    })
    return
  }
  // → 直接复用 CLI /rename 的落盘逻辑（saveCustomTitle + saveAgentName，见命令 rename.ts），
  // 与 CLI 完全同路径：写盘格式含 sessionId（loadTranscriptFile/restoreSessionMetadata 按
  // entry.sessionId 建索引，缺字段会被 resume 跳过 → 旧标题在退出时 re-append 回退 web 列表）；
  // 若目标会话恰好是网关宿主 CLI 的当前会话，还会同步更新 CLI 内存标题缓存。
  // 对已停止的会话同样生效；正在运行的会话下次列表刷新读盘即见新标题。
  if (req.method === 'POST' && url.pathname === '/gateway/session/rename') {
    try {
      const parsed = await readReportBody(req)
      const id = typeof parsed.id === 'string' && parsed.id.trim() ? parsed.id.trim() : ''
      const title = typeof parsed.title === 'string' ? parsed.title.trim() : ''
      if (!id || !title) {
        sendJson(res, 400, { error: 'id 与 title 必填' })
        return
      }
      if (title.length > 200) {
        sendJson(res, 400, { error: '标题过长（最多 200 字符）' })
        return
      }
      const { path: p, uuid } = decodeSessionPath(id, root)
      if (!existsSync(p)) {
        sendJson(res, 404, { error: 'session not found' })
        return
      }
      await saveCustomTitle(uuid as UUID, title, p)
      await saveAgentName(uuid as UUID, title, p)
      // 2026-08-25 web 重命名 → CLI 实时同步：目标会话若有 /clients 注册的在线 CLI 进程
      //（web 独立会话窗口 / 终端 CLI），按会话精确路由 rename 事件，CLI 侧更新内存标题缓存
      // + 输入栏徽标（standaloneAgentContext），无需重启即可看到新名字；未命中静默跳过。
      // B2（2026-08-26）route 未命中诊断：补 rename 命中/未命中轨迹到 /gateway/diagnostics，
      // 区分「目标在线已同步缓存」（hit）与「未命中——仅写盘，在线 CLI 缓存未更新，退出可能回退」（miss）。
      const routed = routeToClient(uuid, { type: 'rename', sessionId: uuid, title })
      approvalTrailPush('rename-routed', uuid, undefined, routed ? 'hit' : 'miss')
      scheduleSseFlush(root) // 立即触发列表刷新，让新标题落进前端列表
      sendJson(res, 200, { ok: true, title })
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  // 默认预览页数据：/gateway/project?label=<项目> → 文件树 + README + 会话元信息（GitHub 仓库风格默认界面）
  // 2026-08-19 Web 容器：/gateway/backend?label=<项目> → 懒加载 spawn 该项目 preview.json 声明的后端进程，
  // 返回 {url}：本机 iframe 直连；远程宿主由前端改走同源代理 /backend/<label>/（受上方 /gateway/* token 校验保护；后端仅监听 127.0.0.1，访问面可控）。
  if (req.method === 'GET' && url.pathname === '/gateway/backend') {
    const bLabel = url.searchParams.get('label') || ''
    const bProj = findProjects(root).find((g) => g.scope === 'project' && g.label === bLabel && g.hasBackend)
    if (!bProj || !bProj.backendCfg) {
      sendJson(res, 404, { error: 'no backend for project' })
      return
    }
    try {
      // alreadyRunning：调用前进程已在册且存活（复用/收养，非本次 spawn）→ 前端不渲染「正在启动」覆盖层，iframe 直挂秒开
      const pre = backendProcesses.get(bLabel)
      const alreadyRunning = !!(pre && backendProcAlive(pre))
      const proc = await ensureBackend(bLabel, bProj.backendCfg)
      // 同源代理票证：为该浏览器种/续 HttpOnly cookie，开放 /backend/<label>/ 转发通道；
      // 已有票证则追加本 label 并续期（多项目并行预览互不顶掉）。
      sweepBpSessions()
      const ckJar = parseCookieHeader(req.headers.cookie)
      let ckKey = ckJar[BP_COOKIE_NAME]
      let bpSess = ckKey && BP_COOKIE_KEY_RE.test(ckKey) ? bpSessions.get(ckKey) : undefined
      if (!bpSess) {
        ckKey = randomBytes(16).toString('hex')
        bpSess = { labels: new Set<string>(), expires: 0 }
        bpSessions.set(ckKey, bpSess)
      }
      bpSess.labels.add(bLabel)
      bpSess.expires = Date.now() + BP_COOKIE_TTL_MS
      res.setHeader('Set-Cookie', `${BP_COOKIE_NAME}=${ckKey}; Path=/backend; HttpOnly; SameSite=Lax; Max-Age=86400`)
      // name：overlay 提示用（preview.json backend.name 或项目 label），前端据此显示「正在启动 <name>…」，可插拔
      sendJson(res, 200, { url: `http://127.0.0.1:${proc.port}/`, port: proc.port, pid: proc.pid, name: proc.cfg.name || bLabel, alreadyRunning })
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  if (req.method === 'GET' && url.pathname === '/gateway/project') {
    const pLabel = url.searchParams.get('label') || ''
    const pProj = findProjects(root).find((g) => g.scope === 'project' && g.label === pLabel)
    if (!pProj) {
      sendJson(res, 404, { error: 'project not found' })
      return
    }
    try {
      const pDir = resolve(pProj.dir, '..', '..') // pProj.dir = <root>/<label>/.claude/projects，上两级才是项目根（resolve '..' 只到 .claude）
      const budget = { n: 2000 }
      const files = walkProjectTree(pDir, 0, budget) ?? []
      const readme = findProjectReadme(pDir)
      const list = await listSessions(root)
      const pSessions = (list.sessions as Array<Record<string, unknown>>)
        .filter((s) => s.projectScope === 'project' && s.projectLabel === pLabel)
        .map((s) => ({
          hash: String(s.file).replace(/\.jsonl$/, ''),
          id: s.id,
          title: s.title,
          messageCount: s.messageCount,
          updatedAt: s.updatedAt,
        }))
        .slice(0, 100)
      sendJson(res, 200, {
        label: pLabel,
        scope: 'project',
        hasPreview: pProj.hasPreview,
        description: deriveProjectDescription(readme, pLabel),
        files,
        readme,
        sessionCount: pSessions.length,
        sessions: pSessions,
        lastActive: pSessions.length ? (pSessions[0].updatedAt as number) : 0,
      })
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  // 项目内文件内容读取：/gateway/file?label=<项目>&path=<项目内相对路径> → 原始字节
  // （供个性化预览页识图渲染 Obsidian canvas / 加载图片音频视频）。受上方 /gateway/* token 校验保护。
  if (req.method === 'GET' && url.pathname === '/gateway/file') {
    const fLabel = url.searchParams.get('label') || ''
    const fPath = url.searchParams.get('path') || ''
    const fProj = findProjects(root).find((g) => g.scope === 'project' && g.label === fLabel)
    if (!fProj) {
      sendJson(res, 404, { error: 'project not found' })
      return
    }
    const fDir = resolve(fProj.dir, '..', '..') // 项目根（fProj.dir = <root>/<label>/.claude/projects）
    const fAbs = resolve(fDir, fPath)
    if (fAbs !== fDir && !fAbs.startsWith(fDir + sep)) {
      sendJson(res, 403, { error: 'forbidden' })
      return
    }
    if (!existsSync(fAbs) || !statSync(fAbs).isFile()) {
      sendJson(res, 404, { error: 'not found' })
      return
    }
    if (statSync(fAbs).size > 4 * 1024 * 1024) {
      sendJson(res, 413, { error: 'too large' })
      return
    }
    const fType = MIME[extname(fAbs)] ?? 'application/octet-stream'
    res.writeHead(200, { 'Content-Type': fType, 'Cache-Control': 'no-cache' })
    res.end(readFileSync(fAbs))
    return
  }

  // 2026-08-27 Web 容器同源反向代理：/backend/<label>/<path>?<query> → http://127.0.0.1:<port>/<path>?<query>
  // 远程端（手机遥测）无法直连回环后端端口，统一经网关主端口转发；后端仍只绑 127.0.0.1，访问面不变。
  // 不做 query token 校验（子资源必裸奔）；凭 /gateway/backend 种下的票证 cookie + label 白名单放行。
  // 2026-08-29 全称定案：主前缀 /backend/，旧 /bp/ 保留解析兼容（不再生成）。
  const bpMatch = /^\/(?:backend|bp)\/([^/?]+)(\/[^?]*)?(\?.*)?$/.exec(req.url ?? '')
  if (bpMatch) {
    let bpLabel = ''
    try {
      bpLabel = decodeURIComponent(bpMatch[1])
    } catch {
      bpLabel = bpMatch[1]
    }
    const bpJar = parseCookieHeader(req.headers.cookie)
    const bpKey = bpJar[BP_COOKIE_NAME]
    const bpTicket = bpKey ? bpSessions.get(bpKey) : undefined
    if (!bpTicket || !bpTicket.labels.has(bpLabel)) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }
    const bpProj = findProjects(root).find((g) => g.scope === 'project' && g.label === bpLabel && g.hasBackend)
    if (!bpProj || !bpProj.backendCfg) {
      sendJson(res, 404, { error: 'no backend for project' })
      return
    }
    let bpProc: BackendProc
    try {
      bpProc = await ensureBackend(bpLabel, bpProj.backendCfg) // 直开页面（无父页心跳）也顺带保活
    } catch (e) {
      sendError(res, e)
      return
    }
    bpTicket.expires = Date.now() + BP_COOKIE_TTL_MS
    // rest/search 原样透传（保留原始 %xx 编码），不在网关层二次解码重组，防中文路径双重编码错乱
    proxyBackendRequest(req, res, bpProc, `/backend/${bpMatch[1]}`, bpMatch[2] || '/', bpMatch[3] || '')
    return
  }
  // 项目预览页静态托管：/preview/<项目>/* → <root>/<项目>/.claude/preview/*（点击项目胶囊时前端 iframe 加载替换界面）
  // label 必须是 findProjects 命中且带 .claude/preview 的真实项目（用 dir 推 preview 目录，避免按 label 拼路径）；
  // 子路径 resolve 后必须落在 preview 目录内（越界防护），默认 index.html。
  const pvMatch = /^\/preview\/([^/]+)((?:\/.*)?)$/.exec(url.pathname)
  if (req.method === 'GET' && pvMatch) {
    // 畸形 % 序列（如 %ZZ）decode 会抛 URIError——未捕获曾崩掉整个网关进程（2026-08-29 gateway.log
    // 取证：URIError at handleRequest，反复崩溃重启→遥测端断连/预览打不开）。decode 失败用原文，
    // 后续 findProjects 不命中自然 404 兜底。
    let pvLabel = pvMatch[1]
    try {
      pvLabel = decodeURIComponent(pvMatch[1])
    } catch {
      /* 保留原文 */
    }
    let pvRel = (pvMatch[2] || '').replace(/^\//, '') || 'index.html'
    try {
      pvRel = decodeURIComponent(pvRel)
    } catch {
      /* 保留原文，existsSync 不命中自然 404 兜底 */
    }
    const pvProj = findProjects(root).find((g) => g.scope === 'project' && g.label === pvLabel && g.hasPreview)
    if (!pvProj) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
      return
    }
    const pvDir = join(pvProj.dir, '..', 'preview') // pvProj.dir = <root>/<label>/.claude/projects
    const pvFile = resolve(pvDir, pvRel)
    if (pvFile !== pvDir && !pvFile.startsWith(pvDir + sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Forbidden')
      return
    }
    if (!existsSync(pvFile) || !statSync(pvFile).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
      return
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(pvFile)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    })
    res.end(readFileSync(pvFile))
    return
  }
  // 内置默认预览页（GitHub 仓库风格，项目无 .claude/preview 时的兜底界面）：
  // /default-preview/<项目>/* → 内嵌 web 资源 default-preview/*（label 必须命中 findProjects 防任意路径）。
  const dpMatch = /^\/default-preview\/([^/]+)((?:\/.*)?)$/.exec(url.pathname)
  if (req.method === 'GET' && dpMatch) {
    // 同 /preview：decode 失败保留原文（不崩进程），后续 404 兜底
    let dpLabel = dpMatch[1]
    try {
      dpLabel = decodeURIComponent(dpMatch[1])
    } catch {
      /* 保留原文 */
    }
    const dpProj = findProjects(root).find((g) => g.scope === 'project' && g.label === dpLabel)
    if (!dpProj) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
      return
    }
    let dpRel = (dpMatch[2] || '').replace(/^\//, '') || 'index.html'
    try {
      dpRel = decodeURIComponent(dpRel)
    } catch {
      /* 保留原文，readWebAsset 不命中自然 404 兜底 */
    }
    const dpBuf = readWebAsset(`default-preview/${dpRel}`)
    if (!dpBuf) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not Found')
      return
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(dpRel)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    })
    res.end(dpBuf)
    return
  }
  if (req.method === 'GET' && url.pathname === '/gateway/session') {
    const id = url.searchParams.get('id')
    if (!id) {
      sendJson(res, 400, { error: 'missing id' })
      return
    }
    try {
      const { path: p, uuid } = decodeSessionPath(id, root)
      // 历史一律以磁盘 jsonl 全量为基底（readSession，含上下文压缩前的完整历史）；
      // CLI 上报的内存窗口（conversationDisplays）只作尾部追加——直接返回 live 会因
      // 内存窗口缺失历史用户消息而看不到完整历史。
      const data = readSession(id, root)
      const disp = conversationDisplays.get(uuid)
      if (disp && Array.isArray(disp.messages) && disp.messages.length) {
        data.messages = mergeDisplayMessages(data.messages as never, disp.messages as never)
        data.display = data.messages
      }
      // 2026-08-24 模型 web/CLI 同步：附每会话实际模型（CLI 上报，override 不落盘只此有源）+
      // 上报时间戳（web 端据此判断是否覆盖本地选择）；无上报时回落 null（web 回落凭据池 activeModel）。
      const sm = sessionModels.get(uuid)
      data.model = sm?.model ?? null
      data.modelTs = sm?.updatedAt ?? null
      // 2026-08-28 遥测端图片门控：该会话模型是否识图（有上报按上报模型，无上报回落全局 activeModel，
      // 与 model 字段回落同源）→ 前端 renderSession/applySessionModel 据此显隐图片上传入口
      const visionModel = sm?.model ?? getActiveModel()
      data.vision = visionModel ? modelSupportsVision(visionModel) : false
      // 2026-08-30 队列快照（清单#2）：当前排队项（首载/刷新时与 SSE queue-state 增量同构）
      data.queued = sessionQueues.get(uuid)?.items ?? []
      // 2026-09-08 事件流统一 P1：当前 delta seq 记账随全量下发——web 全量对账后以此为续流
      // 起点（seq 连续应用 / gap 再对账），网关重启清零后 CLI 未发 delta 时回落 0（下条 seq=1 连续）。
      data.deltaSeq = sessionDeltaSeq.get(uuid) ?? 0
      sendJson(res, 200, data)
    } catch (e) {
      sendError(res, e)
    }
    return
  }
  // 2026-08-30 web 图片内联渲染：GET /gateway/image-cache/<sessionId>/<imageId>。
  // 数据源 = CLI processUserInput storeImages 落盘的 image-cache/<sessionId>/<id>.<ext>
  // （utils/imageStore.ts；id = pastedContents id，与文本 [Image #N] 占位一一对应）。
  // 扩展名由 mediaType 推导，此处按 <id>. 前缀 readdir 解析，消费端无需知道扩展名。
  // 已在上方 /gateway/* 统一 token/票证门内；路径两段白名单校验（uuid/纯数字）防穿越。
  if (req.method === 'GET' && url.pathname.startsWith('/gateway/image-cache/')) {
    const m = /^\/gateway\/image-cache\/([0-9a-f-]{36})\/(\d+)$/.exec(url.pathname)
    if (!m) {
      sendJson(res, 400, { error: 'invalid path' })
      return
    }
    const [, imgSid, imgId] = m
    const imgDir = join(getClaudeConfigHomeDir(), 'image-cache', imgSid)
    try {
      const hit = readdirSync(imgDir).find((f) => /^\d+\./.test(f) && f.startsWith(`${imgId}.`))
      if (!hit) {
        sendJson(res, 404, { error: 'not found' })
        return
      }
      const buf = readFileSync(join(imgDir, hit))
      res.writeHead(200, {
        'Content-Type': MIME[extname(hit)] || 'application/octet-stream',
        'Content-Length': buf.length,
        'Cache-Control': 'private, max-age=86400',
      })
      res.end(buf)
    } catch {
      sendJson(res, 404, { error: 'not found' })
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/gateway/conversation') {
    try {
      const parsed = await readReportBody(req)
      const sid = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
      const msgs = Array.isArray(parsed.messages) ? parsed.messages : null
      if (!sid || !msgs) {
        sendJson(res, 400, { error: 'invalid body' })
        return
      }
      // P2 增量上报聚合（2026-08-31，20260828145952-内存增长根因与代码层修改建议.md）：
      // body.base 为非负整数 = 增量语义——CLI 侧已确认缓存前 base 条不变，本批 messages
      // 替换第 base 条起的内容（尾部 thinking 可见性/图片并回等投影回改天然覆盖）。
      // base 越界（网关重启/缓存被 sweep）→ 按窗口投影展示，CLI 校验响应 cached 长度不符
      // 后下轮自动全量对账恢复完整。无 base = 全量替换（旧语义，兼容）。TTL/sweep 不变。
      const base = typeof parsed.base === 'number' && Number.isInteger(parsed.base) && parsed.base >= 0 ? parsed.base : -1
      let merged = msgs
      if (base >= 0) {
        const prev = conversationDisplays.get(sid)?.messages
        if (Array.isArray(prev) && base <= prev.length) {
          merged = prev.slice(0, base).concat(msgs)
        }
      }
      conversationDisplays.set(sid, { messages: merged, updatedAt: Date.now() })
      sweepStaleMaps()
      sendJson(res, 200, { ok: true, cached: merged.length })
    } catch (error) {
      sendReportBodyError(res, error)
    }
    return
  }
  if (req.method === 'POST' && url.pathname === '/gateway/activity') {
    try {
      const parsed = await readReportBody(req)
      const sid = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
      const status = typeof parsed.status === 'string' && ['busy', 'idle', 'waiting'].includes(parsed.status)
        ? parsed.status
        : null
      if (!sid || !status) {
        sendJson(res, 400, { error: 'invalid body' })
        return
      }
      sessionActivity.set(sid, {
        status,
        pid: Number(parsed.pid) || 0,
        cwd: typeof parsed.cwd === 'string' && parsed.cwd ? parsed.cwd : undefined,
        updatedAt: Date.now(),
      })
      sweepStaleMaps()
      // 状态点即时性（2026-08-29 状态点偶发观测不到修复）：收到活动上报即群发轻量 SSE activity
      // 事件 → 前端 refreshList 重拉 /gateway/sessions。busy/waiting 翻转不再等 jsonl 落盘（updated）
      // 才可见；负载极小，只触发列表刷新、不触发 refreshSession。
      const s = `data: ${JSON.stringify({ type: 'activity', session: sid, state: status })}\n\n`
      sendAll(sseClients, (c) => {
        c.res.write(s)
      })
      sendJson(res, 200, { ok: true })
    } catch (error) {
      sendReportBodyError(res, error)
    }
    return
  }
  // 2026-08-24 模型 web/CLI 同步：CLI 侧 reportCurrentModel 上报每会话实际模型（内存 Map，TTL 清扫）。
  // 每会话 override 不写凭据池，web 端 /gateway/session 据此读取校准模型 seat，与 CLI 实际使用一致。
  if (req.method === 'POST' && url.pathname === '/gateway/model-report') {
    try {
      const parsed = await readReportBody(req)
      const sid = typeof parsed.sessionId === 'string' ? parsed.sessionId : ''
      const model = typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : ''
      if (!sid || !model) {
        sendJson(res, 400, { error: 'invalid body' })
        return
      }
      sessionModels.set(sid, { model, updatedAt: Date.now() })
      sweepStaleMaps()
      sendJson(res, 200, { ok: true })
    } catch (error) {
      sendReportBodyError(res, error)
    }
    return
  }
  if (req.method === 'GET' && url.pathname === '/gateway/events') {
    // SSE：idleTimeout 禁用（长连接保持，避免重连级联）
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    const client = { res }
    sseClients.add(client)
    scheduleIdleShutdown()
    res.write(`data: ${JSON.stringify({ type: 'hello', time: Date.now() })}\n\n`)
    req.on('close', () => {
      sseClients.delete(client)
      scheduleIdleShutdown()
    })
    // O4：建立文件监听 + 立即 primed 一轮（填充 sseSizes 基线），后续变化由 watch 事件驱动
    ensureSseWatches(root)
    pollSse(root)
    return
  }
  // 静态资源：内嵌 web 资源优先（打包进 exe），磁盘 SubPj public 兜底（开发模式）
  // 2026-08-28 SPA 路径路由：/session/<hash>、/manage/…、/project/<label> 非真实文件 → 一律回 index.html，
  // 由前端 parseRoute 按 location.pathname 解析（pushState 路由）。2026-08-29 全称定案：前端只生成全称前缀
  // （/session/、/manage/、/project/、/backend/），旧缩写（/s/、/mgr/、/pview/、/bp/）保留解析兼容。
  // /preview、/default-preview、/backend 等真实路径在前面的分支已消费，不会落到此处。
  const isSpaRoute = /^\/(?:session\/|s\/|manage\/|mgr(?:\/|$)|project\/|pview\/)/.test(url.pathname)
  const rel = isSpaRoute || url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '')
  const embedded = readWebAsset(rel)
  if (embedded) {
    res.writeHead(200, {
      'Content-Type': MIME[extname(rel)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    })
    res.end(embedded)
    return
  }
  const pub = publicDir(root)
  const file = resolve(pub, rel)
  if (!isPathInside(pub, file) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not Found')
    return
  }
  const body = readFileSync(file)
  res.writeHead(200, {
    'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  })
  res.end(body)
}

function broadcast(msg: unknown): void {
  const s = JSON.stringify(msg)
  sendAll(sockets, (c) => c.send(s))
}

/** 遥测端 WS 断开 → 从所有 web 会话订阅集合中摘除（重连后前端重新 subscribe） */
function detachWebSessionClient(ws: WebSocket): void {
  for (const p of webSessions.values()) {
    p.clients.delete(ws)
  }
}

// 2026-08-24 审批链路诊断轨迹：环形日志记录 /clients 注册、approval-request 接收与广播、
// approve 接收与路由、local-resolved/cancel；2026-08-26 P0 加 approval-processed（CLI 已处理回执）
// 与 gw-approval-confirmed（确认转发 floria）。GET /gateway/diagnostics 读取（调试审批「卡片不弹」）。
const approvalTrail: Array<{ ts: number; ev: string; sessionId?: string; requestId?: string; detail?: string }> = []
function approvalTrailPush(ev: string, sessionId?: string, requestId?: string, detail?: string): void {
  approvalTrail.push({ ts: Date.now(), ev, sessionId, requestId, detail })
  if (approvalTrail.length > 500) approvalTrail.splice(0, approvalTrail.length - 500)
}

// 2026-08-30 审批/提问 pending 重放（DSH 同款「待答=会话持久状态」语义）：approval-request 是
// 瞬态广播，前端按 currentHash 过滤丢弃后即永久丢失（提问时页面开着别的会话或没开 → 切回只剩
// 只读兜底卡「请在 CLI 窗口作答」）。改为网关按 requestId 暂存未决 approval（TTL 30 分钟仅兜底
// 泄漏；正常路径由 解答回执/取消/本地已解决 显式清除），前端 renderSession/WS 重连发 subscribe
// 时回放该会话未决项 → 打开会话总能补弹交互卡。
const pendingApprovals = new Map<string, { sessionId: string; payload: unknown; ts: number }>()
const PENDING_APPROVAL_TTL_MS = 30 * 60 * 1000
function pendingApprovalsSet(sessionId: string, requestId: string, payload: unknown): void {
  const now = Date.now()
  for (const [k, v] of pendingApprovals) if (now - v.ts > PENDING_APPROVAL_TTL_MS) pendingApprovals.delete(k)
  pendingApprovals.set(requestId, { sessionId, payload, ts: now })
}
function pendingApprovalsDrop(requestId: unknown): void {
  if (typeof requestId === 'string' && requestId) pendingApprovals.delete(requestId)
}
function pendingApprovalsReplay(ws: WebSocket, sessionId: string): void {
  const now = Date.now()
  for (const [requestId, e] of pendingApprovals) {
    if (e.sessionId !== sessionId) continue
    if (now - e.ts > PENDING_APPROVAL_TTL_MS) {
      pendingApprovals.delete(requestId)
      continue
    }
    try {
      ws.send(JSON.stringify(e.payload))
    } catch {
      /* 连接已断，忽略 */
    }
  }
}
function approvalTrailSnapshot(): unknown[] {
  return approvalTrail.slice(-50).reverse()
}

// 2026-08-25 发送即 resume：任何会话（web 与 CLI 一视同仁）进程未在线 → 先恢复本地 CLI 窗口再投递消息。
// 会话项目按磁盘文件定位（sessionProjectRootOf → 项目根/全局根），复用 spawnWebSession 的 --resume +
// 原生 resume 逻辑，cwd/exe 由 webSessionProjectRoot/webSessionExe 按定位到的项目正确路由，
// 注册完成后再把消息注入 REPL（cliClients 精确路由，与本地打字同路径）。会话文件不在磁盘 → 拒绝。
// 同一会话 resume 在途（spawn 最长 20s）→ 复用同一 promise，多消息串行投递，杜绝双 spawn 双写 jsonl。
const resumingSessions = new Map<string, Promise<void>>()
function resumeAndDeliver(
  sessionId: string,
  text: string,
  images: ReturnType<typeof sanitizeInboundImages>,
  ws: WebSocket,
): void {
  const loc = sessionProjectRootOf(sessionId)
  if (!loc) {
    ws.send(JSON.stringify({ type: 'status', state: '目标会话未在线，消息未注入' }))
    return
  }
  ws.send(JSON.stringify({ type: 'status', state: '正在恢复会话窗口…' }))
  let p = resumingSessions.get(sessionId)
  if (!p) {
    p = spawnWebSession(sessionId, loc.projectLabel).finally(() => resumingSessions.delete(sessionId))
    resumingSessions.set(sessionId, p)
  }
  p.then(() => {
    // 2026-08-31 防双进程路径：复用的活进程可能仍在断连重连（cliClients 暂 miss）——
    // 轮询等其重新注册再注入（最长 5s，400ms 间隔），替代原「miss 即报未注入」单次判定。
    const t0 = Date.now()
    const tryInject = (): void => {
      const t = cliClients.get(sessionId)
      if (t && t.readyState === WebSocket.OPEN) {
        t.send(JSON.stringify(images.length ? { type: 'send', text, images } : { type: 'send', text }))
      } else if (Date.now() - t0 < 5000) {
        setTimeout(tryInject, 400)
      } else {
        ws.send(JSON.stringify({ type: 'status', state: '会话恢复后仍未连接，消息未注入' }))
      }
    }
    tryInject()
  }).catch((e) => {
    ws.send(JSON.stringify({ type: 'status', state: '恢复会话失败：' + (e.message || e) }))
  })
}

// 2026-08-28 遥测端图片上行校验：前端把图片以 base64（无 data: 前缀）随 'send' 上行，
// 逐项校验后透传给 CLI（CLI 侧 gatewayClient 构造 pastedContents → 与本地粘贴图片同链路）。
// 限制：≤4 张/条（API 多图保守上限）、单张 base64 ≤7MB（API 限 5MB 二进制，留编码余量）、
// mediaType 白名单 image/*（png/jpeg/gif/webp）；不合法项静默丢弃。
// 2026-09-06 显式 id 透传：web 前端 2026-09-02 起分配全会话唯一 id（[Image #N] 占位与之一一
// 对应），此处此前重组时把 id 剥掉 → CLI pastedContentsFromImages 收不到显式号，回落每条从 1
// 递增——同会话所有带图消息全存 1.png 互覆错图，且占位 [Image #N] 与落盘 imagePasteIds 错位
// （conversationDisplay 拆分并回条件不满足 → 非排队首条带图消息渲染成文本/图两个气泡）。
// 仅透传正整数显式 id；缺省/非法仍由 CLI 侧自造递增兜底（旧前端兼容不变）。
function sanitizeInboundImages(raw: unknown): Array<{ id?: number; content: string; mediaType: string; filename?: string }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ id?: number; content: string; mediaType: string; filename?: string }> = []
  for (const item of raw.slice(0, 4)) {
    if (!item || typeof item !== 'object') continue
    const it = item as { id?: unknown; content?: unknown; mediaType?: unknown; filename?: unknown }
    if (typeof it.content !== 'string' || !it.content || it.content.length > 7_000_000) continue
    if (typeof it.mediaType !== 'string' || !/^image\/(png|jpeg|gif|webp)$/i.test(it.mediaType)) continue
    out.push({
      ...(typeof it.id === 'number' && Number.isInteger(it.id) && it.id > 0 ? { id: it.id } : {}),
      content: it.content,
      mediaType: it.mediaType.toLowerCase(),
      ...(typeof it.filename === 'string' && it.filename ? { filename: it.filename.slice(0, 120) } : {}),
    })
  }
  return out
}

function handleWsMessage(ws: WebSocket, raw: string): void {
  let data: { type?: string; text?: string; requestId?: string; allowed?: boolean; sessionId?: string; toolUseId?: string; input?: unknown; answers?: Record<string, string>; permissions?: unknown; images?: unknown }
  try {
    data = JSON.parse(raw)
  } catch {
    return
  }
  switch (data.type) {
    case 'send': {
      const text = data.text ?? ''
      if (!text.trim()) break
      // 2026-08-24 web 会话改造：web 会话 = 本地可见交互 REPL（CLI 自己连 /clients 注册），
      // 消息不再写子进程 stdin（stdin 归本地终端窗口），统一经 cliClients 精确路由 →
      // CLI 侧 gatewayClient enqueue 注入 REPL（与本地打字同路径）。审批也在本地窗口操作。
      // 2026-08-28 遥测端图片：images（base64 数组）校验后随消息透传，CLI 构造 pastedContents 走本地粘贴同链路。
      const images = sanitizeInboundImages(data.images)
      const sendPayload = images.length ? { type: 'send', text, images } : { type: 'send', text }
      if (data.sessionId) {
        const target = cliClients.get(data.sessionId)
        if (target && target.readyState === WebSocket.OPEN) {
          target.send(JSON.stringify(sendPayload))
        } else if (webSessions.has(data.sessionId) || spawningPromises.has(data.sessionId)) {
          // 2026-09-06 wsession 异步化配套：spawn/注册完成前到达的消息暂存，CLI 注册钩子
          // flushPendingDeliveries 按序补投——原「web 会话启动中，请稍后再发送」= 用户消息
          // 无声丢失（异步化后 spawn 在途是常态窗口），根除。
          const q = pendingDeliveries.get(data.sessionId) ?? []
          q.push({ text, images })
          pendingDeliveries.set(data.sessionId, q)
        } else {
          // 2026-08-25 发送即 resume：进程未在线 → 按磁盘会话文件定位并先恢复本地 CLI 窗口再投递（web/CLI 一视同仁）
          resumeAndDeliver(data.sessionId, text, images, ws)
        }
        break
      }
      // 无 sessionId → 广播全部在线 CLI 客户端；无在线 CLI → status 提示
      if (cliClients.size) {
        sendAll(cliClients.values(), (c) => c.send(JSON.stringify(sendPayload)))
      } else {
        ws.send(JSON.stringify({ type: 'status', state: '当前无在线 CLI 进程，消息未注入' }))
      }
      break
    }
    case 'interrupt': {
      // 2026-09-04 web 打断按钮：web 前端 {type:'interrupt', sessionId} → 按会话精确路由给在线
      // CLI → CLI 侧 onCancel（与本地 Ctrl+C 同路径）。会话未在线只回 status 提示（不 resumeAndDeliver：
      // 打断对离线/空闲会话无意义，CLI 侧判活未命中本就是 no-op）。
      if (!data.sessionId) {
        ws.send(JSON.stringify({ type: 'status', state: '缺少会话标识，无法打断' }))
        break
      }
      const target = cliClients.get(data.sessionId)
      if (target && target.readyState === WebSocket.OPEN) {
        target.send(JSON.stringify({ type: 'interrupt' }))
      } else {
        ws.send(JSON.stringify({ type: 'status', state: '会话未在线，无法打断' }))
      }
      break
    }
    case 'approve': {
      // 2026-08-24 审批双操作（web 与 CLI 均可）：floria 审批卡的应答路由回对应 CLI 会话
      // （/clients 注册的交互 REPL——普通 CLI 会话与 web 独立会话窗口同路径，均支持远程审批）。
      const target = data.sessionId ? cliClients.get(data.sessionId) : undefined
      if (target && target.readyState === WebSocket.OPEN) {
        approvalTrailPush('floria-approve-routed', data.sessionId, data.requestId, data.allowed === true ? 'allow' : 'deny')
        // 2026-08-24 提问答复：floria 交互表单提交答案 → updatedInput 带 {questions, answers}，
        // CLI 交互应答（buildAllow(updatedInput)）用完整输入执行工具（AskUserQuestion 拿到 answers）。
        // data.input 是工具原始输入 {questions:[...]}，questions 取数组本体（勿再嵌套）。
        let qInput: unknown = data.input ?? {}
        if (data.input && typeof data.input === 'object' && Array.isArray((data.input as { questions?: unknown }).questions)) {
          qInput = (data.input as { questions: unknown }).questions
        }
        // 2026-08-26 A1 修复：普通工具允许时 updatedInput 必须为 undefined（而非空对象 {}），
        // 否则 CLI 侧 interactiveHandler 的 response.updatedInput ?? displayInput 回退会被 {} 阻断，
        // 普通工具拿到空输入 {}。仅提问（data.answers）才构造 {questions, answers}。
        const updatedInput = data.answers
          ? { questions: qInput, answers: data.answers }
          : undefined
        target.send(
          JSON.stringify({
            type: 'approval-response',
            requestId: data.requestId ?? '',
            // 2026-08-26 A2：透传 web 端勾选的「记住此规则」permissionUpdates（data.permissions）
            // → CLI interactiveHandler onResponse 消费 response.updatedPermissions?.length → persistPermissions；
            // undefined 字段经 JSON.stringify 自动省略，不影响旧 CLI。
            response: data.allowed === true
              ? { behavior: 'allow', updatedInput, updatedPermissions: data.permissions }
              : { behavior: 'deny', message: '用户拒绝了该工具调用' },
          }),
        )
      } else {
        approvalTrailPush('floria-approve-miss', data.sessionId, data.requestId, 'target-not-online')
        ws.send(
          JSON.stringify({
            type: 'status',
            state: data.sessionId ? '目标会话未在线，审批未送达' : 'approve 尚未接入（阶段2）',
          }),
        )
        // 2026-08-26 P0：路由失败显式回 approval-rejected（带 requestId）→ 前端保留卡片 + 可见错误 + 重试
        ws.send(
          JSON.stringify({
            type: 'approval-rejected',
            sessionId: data.sessionId,
            requestId: data.requestId ?? '',
          }),
        )
      }
      break
    }
    case 'subscribe': {
      // 2026-08-24 web 会话改造：实时流走 SSE（conversationDisplay 上报 + jsonl + 列表刷新），
      // 无 WS out/approval 回推；订阅保留为兼容空操作（会话存在即确认）。
      const sid = data.sessionId ?? ''
      if (!sid) break
      const p = webSessions.get(sid)
      if (p) {
        p.clients.add(ws)
        ws.send(JSON.stringify({ type: 'status', state: '已订阅会话实时流' }))
      } else {
        ws.send(JSON.stringify({ type: 'status', state: 'web 会话进程未运行，未订阅' }))
      }
      // 2026-08-30 pending 重放：切会话/重连订阅时补弹该会话未决审批/提问（瞬态广播被
      // currentHash 过滤丢弃或页面未开的场景；已解决项不回放）。
      pendingApprovalsReplay(ws, sid)
      break
    }
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong' }))
      break
  }
}

// ============================================================================
// 生命周期
// ============================================================================
export type LocalGatewayInfo = {
  port: number
  host: string
  token: string
  lanUrl: string
  localUrl: string
}

function hasClients(): boolean {
  return cliClients.size > 0 || sockets.size > 0 || sseClients.size > 0 || webSessions.size > 0
}

// 2026-08-17 空闲自动回收：无任何客户端连接（CLI 注册 / 遥测 WS / SSE 全空）时起计时，持续
// GATEWAY_IDLE_MINUTES 分钟仍无连接 → 自动 stopLocalGateway（清空三集合 + 清盘 token）+ 退出进程。
// 任一连接增删都会调用本函数重置计时（有动静即顺延）。仅 --gateway 独立进程模式启用。
// ============================================================================
// Web 容器 backend 进程管理实现
// ============================================================================
// 端口可用性探测：短暂监听 127.0.0.1:<port>，成功即释放 → 可用
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = netCreateServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port, '127.0.0.1')
  })
}

// 后端就绪探测：原生 TCP 连 127.0.0.1:<port> → 发最小 HTTP GET，2xx/404 均视为服务已起来。
// 用 node:net 而非 node:http：bun 编译产物里 httpRequest 对某些后端（aiohttp）可能 hang，
// 原生 socket 最稳（2026-08-19 实测网关 spawn ComfyUI 探测）。
function backendReady(port: number, path: string, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      try {
        sock.destroy()
      } catch {
        /* 忽略 */
      }
      resolve(ok)
    }
    const sock = netCreateConnection({ host: '127.0.0.1', port })
    let buf = ''
    sock.on('connect', () => {
      sock.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`)
    })
    sock.on('data', (d) => {
      buf += d.toString('latin1')
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(buf)
      if (m) finish(m[1] === '200' || m[1] === '404')
    })
    sock.on('error', () => finish(false))
    sock.on('close', () => finish(false))
    sock.setTimeout(timeoutMs, () => finish(false))
  })
}

async function allocBackendPort(): Promise<number> {
  for (let p = BACKEND_PORT_BASE; p < BACKEND_PORT_MAX; p++) {
    if (await portFree(p)) return p
  }
  return 0
}

// 进行中的 spawn（防并发重复拉起）：同一 label 探测期间，后续请求复用同一 Promise
const backendPending = new Map<string, Promise<BackendProc>>()

function backendLogPath(label: string): string {
  const safe = label.replace(/[^a-zA-Z0-9_-]/g, '_')
  return join(getPortableRoot(), '.claude', `backend-${safe}.log`)
}

// O3：backend 日志轮转 —— 超过上限截断重写，防长期运行无限增长（stdout/stderr 落盘只追加）
const BACKEND_LOG_MAX_BYTES = 5 * 1024 * 1024
function rotateBackendLogIfNeeded(p: string): void {
  try {
    if (existsSync(p) && statSync(p).size > BACKEND_LOG_MAX_BYTES) truncateSync(p, 0)
  } catch {
    /* 忽略 */
  }
}

// 懒加载 spawn 后端进程（已运行则复用并刷新活跃时间；2026-08-28 起支持按注册表收养网关重启后的存活进程）
function backendProcAlive(p: BackendProc): boolean {
  return p.child ? p.child.exitCode === null && !p.child.killed : isPidAlive(p.pid)
}
async function ensureBackend(label: string, cfg: BackendCfg): Promise<BackendProc> {
  const existing = backendProcesses.get(label)
  if (existing && backendProcAlive(existing)) {
    existing.lastActive = Date.now()
    return existing
  }
  if (existing) {
    backendProcesses.delete(label) // 进程已退出，清理后重起
    persistBackendRegistry()
  }
  // 收养：注册表有存活记录（pid 活着 + 端口就绪）→ 直接接管，不重新 spawn
  // （网关 stop/restart/硬杀后进程仍在跑；服务 hang 死则杀掉清记录防占端口成孤儿）
  const rec = readBackendRegistry()[label]
  if (rec && rec.pid > 0 && rec.port > 0 && isPidAlive(rec.pid)) {
    if (await backendReady(rec.port, cfg.readyPath)) {
      const proc: BackendProc = { pid: rec.pid, port: rec.port, cfg, startedAt: rec.startedAt, lastActive: Date.now(), child: null }
      backendProcesses.set(label, proc)
      persistBackendRegistry()
      console.log(`[gateway] backend ${label}: 收养存活进程 pid=${rec.pid} port=${rec.port}（网关重启不重启后端）`)
      return proc
    }
    killTree(rec.pid) // pid 活着但端口不通：服务 hang 死，清掉防占端口（pid 被复用且恰占原端口的双巧合误杀概率可忽略）
  }
  const pending = backendPending.get(label)
  if (pending) return pending // 探测进行中，等待同一 Promise 结果（不重复 spawn）
  const p = doSpawnBackend(label, cfg)
  backendPending.set(label, p)
  try {
    return await p
  } finally {
    backendPending.delete(label)
  }
}

async function doSpawnBackend(label: string, cfg: BackendCfg): Promise<BackendProc> {
  const port = cfg.port > 0 ? cfg.port : await allocBackendPort()
  if (!port) throw new Error(`backend ${label}: 无可用端口（${BACKEND_PORT_BASE}-${BACKEND_PORT_MAX} 均被占用）`)
  const cmd = cfg.cmd.map((a) => (a.includes('{port}') ? a.replaceAll('{port}', String(port)) : a))
  // cmd[0] 若是相对路径（含 / 或 \），node spawn 按进程 cwd 而非选项 cwd 解析 → 手动 resolve 到 cfg.cwd
  if (cmd[0] && !isAbsolute(cmd[0]) && /[\\/]/.test(cmd[0])) cmd[0] = resolve(cfg.cwd, cmd[0])
  // 子进程 stdout/stderr 落盘到便携根 .claude/backend-<label>.log（stdio ignore 会丢启动报错，难诊断）
  const logPath = backendLogPath(label)
  rotateBackendLogIfNeeded(logPath)
  const logFd = openSync(logPath, 'a')
  const child = spawn(cmd[0], cmd.slice(1), {
    cwd: cfg.cwd,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', logFd, logFd],
    shell: false,
    windowsHide: true, // 2026-08-20 黑框根因修复：python.exe 是 console 子系统，不设 windowsHide 每次 spawn 会弹出黑色命令行窗口（用户「黑框=单独弹出的指令框，类似 cmd」）
  })
  const proc: BackendProc = { pid: child.pid ?? 0, port, cfg, startedAt: Date.now(), lastActive: Date.now(), child }
  child.on('exit', () => {
    try {
      closeSync(logFd)
    } catch {
      /* 忽略 */
    }
    if (backendProcesses.get(label) === proc) {
      backendProcesses.delete(label)
      persistBackendRegistry()
    }
  })
  // 就绪探测：最多 ~24s（冷启动慢的后端如 ComfyUI torch 初始化实测 ~22s）
  let ready = false
  for (let i = 0; i < 120; i++) {
    if (gatewayStopping || child.exitCode !== null) break
    if (await backendReady(port, cfg.readyPath)) {
      ready = true
      break
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  if (!ready) {
    try {
      child.kill()
    } catch {
      /* 忽略 */
    }
    if (child.pid) killTree(child.pid)
    throw new Error(`backend ${label}: 端口 ${port} 就绪探测失败（${cfg.readyPath}），详见日志 ${backendLogPath(label)}`)
  }
  backendProcesses.set(label, proc)
  persistBackendRegistry()
  return proc
}

function killBackend(label: string): void {
  const p = backendProcesses.get(label)
  if (!p) return
  backendProcesses.delete(label)
  try {
    p.child?.kill()
  } catch {
    /* 忽略 */
  }
  // Windows 兜底：child.kill 不杀进程树，taskkill /T 连子进程一起清（收养的 child=null 直接走这里）
  if (p.pid) killTree(p.pid)
  persistBackendRegistry()
}

// ============================================================================
// Web 容器同源反代助手（2026-08-27）：远程端经网关主端口访问回环后端容器
// ============================================================================
const PROXY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/** 上游 Location 重写：127.0.0.1:<port> 绝对地址或根相对路径改写到 /backend 前缀下；其余原样返回 */
function rewriteLocation(loc: string, prefix: string, port: number): string {
  const abs = `http://127.0.0.1:${port}`
  if (loc === abs) return prefix
  if (loc.startsWith(abs + '/')) return prefix + loc.slice(abs.length)
  if (loc.startsWith('/')) return prefix + loc
  return loc
}

// per-backend 上传转发串行队列（2026-08-29 Pj15 上传断流接力包取证）：带 body 的请求并发经
// Bun node:http 兼容层 pipe 泵会卡死（后端日志铁证：同一张图 90s×3 重试全 400，前端降级串行
// 后 25 张全 200），串行后单路 pipe 通畅。同 key 逐个转发，队列空时自清理防 Map 膨胀。
const bpForwardQueues = new Map<string, Promise<void>>()
function enqueueBpForward(key: string, run: () => Promise<void>): void {
  const prev = bpForwardQueues.get(key) ?? Promise.resolve()
  const next = prev.then(run).catch((e: unknown) => {
    console.log(`[gateway] /backend 转发队列异常: ${e instanceof Error ? e.message : String(e)}`)
  })
  bpForwardQueues.set(key, next)
  void next.then(() => {
    if (bpForwardQueues.get(key) === next) bpForwardQueues.delete(key)
  })
}

/** 把 /backend/<label>/… 请求原样转发到回环后端 http://127.0.0.1:<port>/…（双向流式管道，媒体大文件不落盘） */
function proxyBackendRequest(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse,
  proc: BackendProc,
  prefix: string,
  rawPath: string,
  rawSearch: string,
): void {
  const upHeaders: Record<string, string | string[] | undefined> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase()
    // cookie 必须剥离：不向项目后端泄露 floria_bp 票证
    if (PROXY_HOP_HEADERS.has(lk) || lk === 'host' || lk === 'cookie') continue
    upHeaders[k] = v as string | string[] | undefined
  }
  upHeaders.host = `127.0.0.1:${proc.port}`
  const label = prefix.slice('/backend/'.length)
  // 断流取证（2026-08-29）：已收/声明字节数，半截体一眼定性（误杀=已收远小于声明；真断开=接近声明）
  let receivedBytes = 0
  req.on('data', (c: Buffer) => {
    receivedBytes += c.length
  })
  const contentLen = Number(req.headers['content-length']) || -1
  let upReq: import('node:http').ClientRequest | undefined
  let killed = false
  // 僵尸连接根治（2026-08-28 Pj15 上传卡死移交）：客户端断开必须联动中止上游连接。
  // 此前仅 req 'error' 时 destroy——隧道抖动/刷新页只触发 'aborted'/'close' 不触发 'error'，
  // pipe 不传播断开 → 上游 socket 永挂（请求头已转发、body 永没送齐）→ 后端线程在
  // rfile.read 永久阻塞（事发 12 条 ESTABLISHED 僵尸），死连接同时是网关空闲自旋的燃料。
  const killUpstream = (why: string): void => {
    if (killed) return
    killed = true
    // 请求级断流取证（gateway.log）：来源区分 + 字节计数（upReq 尚未创建的排队期同样可取证）
    console.log(
      `[gateway] /backend ${label}${rawPath} 转发中止: ${why} (已收 ${receivedBytes}/${contentLen < 0 ? '?' : contentLen} 字节)`,
    )
    upReq?.destroy()
  }
  req.on('error', () => killUpstream('客户端请求错误'))
  // body 未收齐客户端就断开（'aborted' 与 close+complete 双保险，覆盖不同运行时语义；文案区分来源）
  req.on('aborted', () => killUpstream('客户端断开(aborted,body 未收齐)'))
  req.on('close', () => {
    if (req.complete === false) killUpstream('客户端断开(close,body 未收齐)')
  })
  // 响应中途客户端消失（刷新/断线）→ 中止上游，后端不再往死管写流
  res.on('close', () => {
    if (!res.writableEnded) killUpstream('客户端断开(响应中途)')
  })

  const forward = async (): Promise<void> => {
    // 轮到转发时客户端已断开/响应已死 → 放弃（避免向上游白转半截体占后端线程）
    if (killed || res.destroyed) return
    const thisReq = httpRequest(
      { host: '127.0.0.1', port: proc.port, method: req.method, path: rawPath + rawSearch, headers: upHeaders },
      (upRes) => {
        const outHeaders: Record<string, string> = {}
        for (const [k, v] of Object.entries(upRes.headers)) {
          const lk = k.toLowerCase()
          // hop-by-hop 与上游 set-cookie 一并剥离（防止上游会话 cookie 泄漏到网关作用域）
          if (PROXY_HOP_HEADERS.has(lk) || lk === 'set-cookie') continue
          outHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '')
        }
        const loc = upRes.headers.location
        if (typeof loc === 'string') outHeaders.location = rewriteLocation(loc, prefix, proc.port)
        else if (Array.isArray(loc) && loc.length > 0) outHeaders.location = rewriteLocation(loc[0], prefix, proc.port)
        res.writeHead(upRes.statusCode ?? 502, outHeaders)
        upRes.pipe(res)
      },
    )
    upReq = thisReq
    req.pipe(thisReq)
    // 上游静默超时（180s 无任何数据，与 Pj15 后端 Handler.timeout 对齐）：后端挂死/隧道断流
    // 不再永久滞留连接；正常流式传输只要数据在流就不会触发（按静默计，非总时长）
    thisReq.on('socket', (s) => {
      s.setTimeout(180_000)
      s.on('timeout', () => {
        killUpstream('上游 180s 无数据')
        if (!res.destroyed && !res.headersSent) sendJson(res, 504, { error: 'upstream timeout' })
      })
    })
    thisReq.on('error', () => {
      if (res.destroyed) return
      if (!res.headersSent) sendJson(res, 502, { error: 'backend unreachable' })
      else res.destroy()
    })
  }

  // 并发上传根治（2026-08-29 取证）：POST/PUT/PATCH（带 body）按 backend label 排队逐个转发；
  // GET/HEAD（无 body，媒体大文件下载）直通不受影响。
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    enqueueBpForward(prefix, forward)
  } else {
    void forward()
  }
}

// 空闲回收：backend 超过 idleMinutes 无活跃 → kill（独立于网关自身空闲回收，
// 因为 iframe 直连后端不经网关，网关三集合可能为空但后端仍被使用中）
function reclaimIdleBackends(): void {
  const now = Date.now()
  for (const [label, p] of [...backendProcesses]) {
    const idleMs = (p.cfg.idleMinutes ?? GATEWAY_IDLE_MINUTES) * 60 * 1000
    if (now - p.lastActive > idleMs) {
      console.log(`[gateway] backend ${label} 空闲超过 ${p.cfg.idleMinutes ?? GATEWAY_IDLE_MINUTES} 分钟，回收`)
      killBackend(label)
    }
  }
}

// ============================================================================
// Web 独立会话实现（2026-08-24 改造：本地可见交互 REPL 窗口，替代 headless 管道转发）
// ============================================================================

/**
 * spawn 一个「本地可见交互 REPL 窗口」作为 web 独立会话（2026-08-24 改造，替代 headless）。
 *
 * 与 headless 的区别：
 *  - 不再传 -p/stream-json（headless 打印模式），改为交互 REPL（正常 ink UI + 终端窗口），
 *    用户在本地可见窗口里可以直接看/操作（审批也在本地窗口弹）。
 *  - 通信不再走 stdin/stdout 管道：交互 REPL 启动后由 CLI 侧 gatewayClient 连 /clients 注册
 *    sessionId（interactiveHelpers.renderAndRun → startGatewayProbeAndConnect），web 消息经
 *    cliClients 精确路由注入 REPL（gatewayClient enqueue，与本地打字同路径）；
 *    展示走 conversationDisplay 上报（/gateway/conversation）+ jsonl 落盘 + SSE 列表刷新。
 *  - 窗口通过 PowerShell Start-Process -PassThru 弹出（复用 deepLink/terminalLauncher 的
 *    可见终端思路；-PassThru 返回真实 CLI pid 供 stopWebSession taskkill）。
 *
 * resume 提供 → 恢复已有会话（--resume <id>）；否则新会话由网关预分配 UUID 经 --session-id
 * 传给子进程（main.tsx 支持 --session-id <uuid>：'Use a specific session ID for the
 * conversation (must be a valid UUID)'），CLI 转录 init 首行即带该 id，jsonl 落盘
 * <项目根>/.claude/projects/<id>.jsonl。
 * project 提供（2026-08-24）→ 在指定项目下新建/恢复会话（cwd = 该项目根）；未指定 → 默认项目根。
 * resolve 在 CLI 完成 /clients 注册后返回 sessionId（保证 web 首条消息可注入，不丢消息）；
 * 注册超时（CLI 启动失败/网关未探测到）→ reject。
 */
// 2026-09-06 wsession 异步化配套（首条消息单状态根治）：
//   spawningPromises = spawn 在途登记（预分配 sid 后台 spawn；同 sid 并发调用——wsession 与
//   resumeAndDeliver 竞速——复用同一 promise，防双进程双写同一 jsonl）；settle 即清。
//   pendingDeliveries = spawn/注册完成前到达的消息暂存（send 路由入队），CLI /clients 注册钩子
//   flushPendingDeliveries 按序补投——原「web 会话启动中，请稍后再发送」丢弃路径根除。
const spawningPromises = new Map<string, Promise<string>>()
// 2026-09-07 wt 直并：cli-hello 上报的 pid 暂存（wt.exe 中转即退，注册成功前 cli-hello 到达时
// webSessions 尚无该 sid）。spawnWebSession 注册成功时取走填入；仅 spawn 在途（spawningPromises
// 命中）才暂存，普通 CLI 主进程的 cli-hello 不入此表防泄漏。
const cliHelloPids = new Map<string, number>()
const pendingDeliveries = new Map<string, { text: string; images: ReturnType<typeof sanitizeInboundImages> }[]>()

// CLI /clients 注册钩子调用：spawn 期间暂存的消息按序补投。cliClients 刚 set（注册即 OPEN），
// 不 OPEN 则保留等下次注册再投（断连重连同钩子触发）——不丢消息。投递形态与 send 路由直投一致。
function flushPendingDeliveries(sessionId: string): void {
  const q = pendingDeliveries.get(sessionId)
  if (!q?.length) return
  const t = cliClients.get(sessionId)
  if (!t || t.readyState !== WebSocket.OPEN) return
  pendingDeliveries.delete(sessionId)
  for (const m of q) {
    t.send(JSON.stringify(m.images.length ? { type: 'send', text: m.text, images: m.images } : { type: 'send', text: m.text }))
  }
}

function spawnWebSession(resume: string | undefined, project: string | undefined, sidForNew?: string): Promise<string> {
  // 幂等：resume 的会话进程已在跑（前端切走再切回）→ 复用现有进程，不重复 spawn（双进程会双写同一 jsonl）
  if (resume && webSessions.has(resume)) {
    const existing = webSessions.get(resume)
    if (existing) existing.lastActive = Date.now()
    return Promise.resolve(resume)
  }
  // 2026-08-31 防双进程根修：近期有 /clients 注册痕迹 = 活进程在断连重连 → 复用不 spawn
  //（双进程乒乓根因，见 cliRegisterAt 注释）。wsession（点开会话）与 resumeAndDeliver（发送
  // 即 resume）两个调用路径同时受保护。边界：进程刚死 10s 内 resume 会误判复用 → 注入轮询
  // 5s miss 后报「未注入」，重发即正常（痕迹超窗）。若真进程活着，它重连回来即恢复路由。
  const lastReg = resume ? cliRegisterAt.get(resume) : undefined
  if (resume && lastReg && Date.now() - lastReg < CLI_RECENT_REGISTER_MS) {
    console.log(`[gateway] wsession: 近期注册痕迹（${Date.now() - lastReg}ms 前），复用活进程不 spawn sid=${resume}`)
    return Promise.resolve(resume)
  }
  // 新建场景 sid 由 wsession handler 预分配传入（异步化：响应需先于 spawn 返回）；resume 场景 sid=resume
  const sid = resume ?? sidForNew ?? randomUUID()
  // spawn 在途：同 sid 并发调用复用同一 promise（2026-09-06，异步化后 wsession 与 resumeAndDeliver 可竞速）
  const inflight = spawningPromises.get(sid)
  if (inflight) return inflight
  // resume 未显式指定项目时，按磁盘会话文件定位项目（项目会话切回后仍落在原项目，web/CLI 一视同仁）
  let effectiveProject = project
  if (resume && !effectiveProject) {
    effectiveProject = sessionProjectRootOf(resume)?.projectLabel
  }
  const p = new Promise<string>((resolve, reject) => {
    const args = resume ? ['--resume', resume] : ['--session-id', sid]
    // cwd = 项目根（指定项目 → 该项目根）：会话 jsonl 落盘到 <项目根>/.claude/projects/<sessionId>.jsonl（与 CLI 同目录）
    const cwd = webSessionProjectRoot(effectiveProject)
    // 2026-09-07 根治定案：wt.exe -w last nt 直并最近 WT 窗口（无窗自动开新窗），启动链彻底脱离
    // 系统默认终端委托（defterm）。背景：25H2 更新把 defterm 激活链本身弄坏（注册表配置正确仍全落
    // conhost 老式黑窗——用户所见「管理员指令框」置顶抢眼、多窗不合并），配置层无解；原 powershell
    // Start-Process 链依赖 defterm 托管，系统更新随时可能再坏。改为网关直接调 wt.exe，行为不再随
    // defterm 配置漂移。配套：①真实 CLI pid 由 cli-hello 上报补填（wt 自身即退拿不到）；
    // ②端口落盘 .claude/gateway-port（并入已存在 WT 窗口时新标签继承旧 WT 进程环境，FLOIRA_GATEWAY
    // 传不到 → CLI env 缺失时读盘发现，见 gatewayToken.ts）。
    // 2026-08-31 根修不变：exe 一律网关自身（协议必然匹配；目录扫描旧案已废，见 webSessionExe 注释）
    const exe = webSessionExe()
    const gwUrl = `http://127.0.0.1:${currentPort}`
    // 2026-08-31 取证日志（20260830222122 事故：spawn 全程零日志，「日志无失败记录」是假象）
    console.log(
      `[gateway] wsession: spawn 开始 resume=${resume ?? '新建'} sid=${sid} project=${effectiveProject ?? '(笔/全局根)'} exe=${exe} cwd=${cwd}`,
    )
    let child: import('node:child_process').ChildProcess
    try {
      child = spawn('wt.exe', ['-w', 'last', 'nt', '-d', cwd, exe, ...args], {
        env: { ...process.env, FLOIRA_GATEWAY: gwUrl, FLORIA_IN_WT: '1' },
        // 不设 windowsHide（2026-09-09 双启动根因）：SW_HIDE 随 STARTUPINFO 被 -w last 无窗时
        // 新开的 WindowsTerminal 继承 = 首窗创建即隐藏；wt.exe 是 GUI 子系统，无黑窗可防。
        stdio: 'ignore',
      })
    } catch (e) {
      reject(e as Error)
      return
    }
    // 等 CLI 完成 /clients 注册（cliClients.has(sid)）——注册成功即 resolve；
    // 超时（wt 打开失败/CLI 未能探测到网关）→ reject（wt pid 即退，无中转进程可杀）。
    const startedAt = Date.now()
    const REGISTER_TIMEOUT_MS = 20_000
    const timer = setInterval(() => {
      if (cliClients.has(sid)) {
        clearInterval(timer)
        console.log(`[gateway] wsession: 注册成功 sid=${sid} 耗时=${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
        const helloPid = cliHelloPids.get(sid)
        cliHelloPids.delete(sid)
        const proc: WebSessionProc = {
          sessionId: sid,
          pid: helloPid,
          clients: new Set(),
          startedAt,
          lastActive: Date.now(),
        }
        webSessions.set(sid, proc)
        persistWebSessions()
        resolve(sid)
        return
      }
      if (Date.now() - startedAt > REGISTER_TIMEOUT_MS) {
        clearInterval(timer)
        console.error(
          `[gateway] wsession: 注册超时 sid=${sid} exe=${exe}（${REGISTER_TIMEOUT_MS / 1000}s 内未完成 /clients 注册，wt 打开失败或 CLI 探测不到网关）`,
        )
        reject(new Error(`web 会话启动超时（${REGISTER_TIMEOUT_MS / 1000}s 内未完成网关注册）`))
      }
    }, 300)
    // wt.exe 启动成功即正常退出（exit 0）——它退出不代表 CLI 窗口关闭，不在此清 timer。
    // 非 0 退出且未注册 → wt 命令本身失败（无 WT/命令被拒），提前 reject 避免空等 20s。
    child.on('exit', (code) => {
      if (code !== 0 && !cliClients.has(sid) && !webSessions.has(sid)) {
        clearInterval(timer)
        console.error(`[gateway] wsession: wt 打开 CLI 窗口失败 sid=${sid} exit=${code ?? '?'}`)
        reject(new Error(`打开本地 CLI 窗口失败（wt exit ${code ?? '?'}）`))
      }
    })
    child.on('error', (err) => {
      clearInterval(timer)
      reject(err)
    })
  })
  spawningPromises.set(sid, p)
  return p
}

// 2026-08-24 web 会话改造：web 消息经 cliClients 注入（CLI 侧 gatewayClient enqueue），
// 审批在本地窗口操作 → 原 stdin 管道函数 sendWebSessionMessage/handleWebApproval 已删除。

/**
 * 优雅停 CLI 进程（2026-09-08 协议，web spawn 与终端直开两会话形态共用）：先经 /clients 通路
 * 请 CLI 自行退出（gatewayClient 收 shutdown → 停重连 → exit 0）——WT 的 closeOnExit=graceful
 * 只对 exit 0 自动收 tab，taskkill 强杀 exit 1 会残留「已退出进程，代码为 1」提示页（wt 直并
 * 链副作用，用户实测）。3s 后进程仍活再树杀兜底（覆盖 WS 已断、收不到 shutdown 的 CLI，含旧
 * exe 无 shutdown handler 的进程）。shutdown 按 sid 精确单发（cliClients.get），非广播不波及
 * 其它会话。
 */
function gracefulStopCli(sid: string, pid: number | undefined): void {
  const sock = cliClients.get(sid)
  if (sock) {
    try { sock.send(JSON.stringify({ type: 'shutdown' })) } catch { /* 断开忽略，走兜底 */ }
  }
  if (pid && isPidAlive(pid)) {
    setTimeout(() => {
      // 豁免版树杀：会话里跑 /server on 会把网关挂到该会话进程树下，普通 /T 会连坐杀网关
      if (isPidAlive(pid)) killTreeExcept(pid, process.pid)
    }, 3000)
  }
}

/**
 * 优雅停 web 会话：关闭本地可见 CLI 窗口（gracefulStopCli 优雅退出协议，窗口随之关闭）。
 * 仅用于用户显式关闭单个会话/超时清理；网关自身关停（off/restart/空闲/SIGINT）不得走这里——
 * web 会话与 CLI 会话同等权重，网关不在了窗口照常活着（2026-08-29 重启杀窗根修）。
 */
function stopWebSession(sessionId: string): boolean {
  const p = webSessions.get(sessionId)
  if (!p) return false
  webSessions.delete(sessionId)
  persistWebSessions()
  gracefulStopCli(sessionId, p.pid)
  return true
}

// 空闲回收：web 会话（本地可见交互 CLI 窗口）生命周期由用户本地操作决定——进程活着不回收
// （lastActive 只是网关侧活跃，本地窗口用户可能正直接操作）；仅清理「进程已死」的残留注册。
function reclaimIdleWebSessions(): void {
  let changed = false
  for (const [sid, p] of [...webSessions]) {
    if (p.pid && !isPidAlive(p.pid)) {
      console.log(`[gateway] web 会话 ${sid} CLI 进程已退出，清理运行注册`)
      webSessions.delete(sid)
      changed = true
    }
  }
  if (changed) persistWebSessions()
}

// P2 收敛（2026-08-27）：backend 与 web 会话原是两套平行 setInterval 回收样板（同 ENABLE_IDLE_RECLAIM
// 门控、同 60s 步进），合并为单一 interval 依次跑两份清扫；停止时在 stopLocalGateway 统一 clearInterval。
let reclaimTimer: NodeJS.Timeout | null = null
function scheduleReclaim(): void {
  if (!ENABLE_IDLE_RECLAIM || reclaimTimer) return
  reclaimTimer = setInterval(() => {
    reclaimIdleBackends()
    reclaimIdleWebSessions()
  }, 60 * 1000)
  reclaimTimer.unref?.()
}

function scheduleIdleShutdown(): void {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (!ENABLE_IDLE_RECLAIM || hasClients()) return
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (hasClients()) return // 计时期间已有连接，放弃回收
    console.log(`[gateway] 无任何客户端连接，空闲超过 ${GATEWAY_IDLE_MINUTES} 分钟，自动关闭`)
    stopLocalGateway()
    process.exit(0)
  }, GATEWAY_IDLE_MINUTES * 60 * 1000)
  idleTimer.unref?.()
}

// 2026-08-31 取证强化：网关日志逐行加 [MM-DD HH:MM:SS] 时间戳。落盘是 fd 重定向（server.ts
// spawnGatewayProcess stdio 直传 fd），无法在落盘侧加前缀 → 输出侧劫持 console。startLocalGateway
// 仅 --gateway 独立进程调用（cli.tsx fast-path），不影响 CLI 进程自身输出。2026-08-30 新会话
// 事故：日志无时间戳严重妨碍取证（「多次重启发生在何时」无法判读）。
let gatewayConsoleStamped = false
function stampGatewayConsole(): void {
  if (gatewayConsoleStamped) return
  gatewayConsoleStamped = true
  const p2 = (n: number): string => String(n).padStart(2, '0')
  const stamp = (): string => {
    const d = new Date()
    return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
  }
  const wrap =
    (orig: (...a: unknown[]) => void) =>
    (...a: unknown[]) =>
      orig(`[${stamp()}]`, ...a)
  console.log = wrap(console.log)
  console.error = wrap(console.error)
  console.warn = wrap(console.warn)
}

export function startLocalGateway(opts?: { host?: string; port?: number; token?: string }): LocalGatewayInfo {
  stampGatewayConsole()
  gatewayStopping = false
  if (server) {
    const lan = lanAddress()
    return {
      port: currentPort,
      host: currentHost,
      token: currentToken,
      lanUrl: lan ? `http://${lan}:${currentPort}/?token=${currentToken}` : '',
      localUrl: `http://127.0.0.1:${currentPort}/?token=${currentToken}`,
    }
  }
  currentHost = opts?.host || process.env.GATEWAY_HOST || '0.0.0.0'
  currentPort = Number(opts?.port || process.env.GATEWAY_PORT || 8124)
  currentToken = opts?.token || process.env.SERVER_TOKEN || randomBytes(16).toString('hex')
  // 共享 token：CLI 侧上报（conversationDisplay.ts /gateway/conversation、/gateway/activity）据此附加校验参数。
  // 2026-08-17 网关独立化：token 落盘（便携根 .claude/gateway-token），供其它 CLI 进程读取后
  // 向本网关上报 / 连接 /clients（否则非网关宿主的 CLI 无 token，上报会被 401 拒绝）。
  setGatewayToken(currentToken)
  saveGatewayTokenToDisk(currentToken)
  // 2026-09-07 wt 直并配套：端口落盘 .claude/gateway-port——并入已存在 WT 窗口的新标签继承旧 WT
  // 进程环境，FLOIRA_GATEWAY env 传不到 CLI 子进程，env 缺失时读盘发现（gatewayToken.ts TTL 缓存）。
  saveGatewayPortToDisk(currentPort)
  const root = getPortableRoot()
  // 收养上一代网关遗留的存活 web 会话窗口（注册表落盘，重启不杀窗 → 必须收养，否则 resume 幂等失效双开进程）
  adoptWebSessions()
  loadTurnEndAt() // 2026-09-07 恢复上一代网关的打断收口时刻（落盘见 turnEndAt 注）
  // 启动即挂上空闲回收计时：此时无任何连接，若后续一直无人使用，到点自动关闭
  scheduleIdleShutdown()
  // backend（2026-08-19）与 web 会话（2026-08-23）空闲回收合并定时器（P2 收敛，独立于网关自身空闲回收）
  scheduleReclaim()

  server = createServer((req, res) => handleRequest(req, res, root))
  // CLOSE_WAIT 收尸（2026-08-28）：对端半关（发来 FIN、我方一直不关）的 socket 会永久滞留
  // CLOSE_WAIT——实测网关空闲积压 8+ 条，死连接是事件循环空转烧 CPU 的燃料（事发 0.76 核）。
  // 对 'end'（对端 FIN 已收）回应自己的 FIN：keep-alive 对端关了就该收，WS 场景对端 FIN 即关闭流程。
  server.on('connection', (socket) => {
    socket.on('end', () => {
      if (!socket.writableEnded) socket.end()
    })
  })
  wss = new WebSocketServer({ noServer: true })
  wss.on('connection', (ws) => {
    sockets.add(ws)
    scheduleIdleShutdown()
    // 2026-08-27 移除「connected」状态广播：此前每次 WS 连接 broadcast {type:'status',state:'connected'}，
    // 前端把它渲染成 chat 区系统行「· connected」；该提示无消费价值（其它 status 状态保留），故根因删除。
    ws.on('message', (data) => {
      handleWsMessage(ws, data.toString())
    })
    ws.on('close', () => {
      sockets.delete(ws)
      detachWebSessionClient(ws) // 2026-08-24 订阅修复：断开即摘除 web 会话订阅
      scheduleIdleShutdown()
    })
    ws.on('error', () => {
      sockets.delete(ws)
      detachWebSessionClient(ws)
      scheduleIdleShutdown()
    })
  })
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`)
    // 2026-08-28 与 HTTP 一致：gateway-token（CLI 内部链路）或 floria_auth cookie 票证二选一；
    // 浏览器授权全靠 cookie（/gateway/activate 配对激活时种下），URL 无 token。
    const wsToken = url.searchParams.get('token') || ''
    const qOk = wsToken !== '' && wsToken === currentToken
    const wsCookieVal = parseCookieHeader(req.headers.cookie)[AUTH_COOKIE_NAME]
    const cOk = isGatewayTicket(wsCookieVal)
    if (!qOk && !cOk) {
      socket.destroy()
      return
    }
    // 授权设备活跃回写（WS 长连接是设备在线的主要形态，upgrade 即更新 UA/IP/lastSeen；
    // 设备自报类型 hint 一并更新——存量票证不经 activate，靠 WS 重连补齐）
    if (cOk) {
      const hint = (url.searchParams.get('device') || '').trim()
      touchGatewayTicket(wsCookieVal, req.headers['user-agent'], remoteIPv4(req.socket.remoteAddress), hint || undefined)
    }
    if (url.pathname === '/ws') {
      // 遥测端（浏览器 floria）连接
      wss?.handleUpgrade(req, socket, head, (ws) => {
        wss?.emit('connection', ws, req)
      })
      return
    }
    if (url.pathname === '/clients') {
      // 2026-08-17 CLI 进程客户端：query 带 session=<uuid>，注册进 cliClients，
      // 遥测端消息经 send 分支转发过来，由 CLI 侧注入其 REPL。不 emit wss 'connection'
      // （不进遥测 broadcast 集合，避免遥测状态误发给 CLI）。
      const sid = url.searchParams.get('session') || ''
      if (!sid) {
        socket.destroy()
        return
      }
      wss?.handleUpgrade(req, socket, head, (ws) => {
        const prev = cliClients.get(sid)
        if (prev && prev !== ws) {
          // 2026-08-31 取证（同步异常根修）：重复注册顶替旧连接此前零日志（盲区）——高频出现
          // 即「同会话双进程乒乓」（两进程注册同一 sid 互踢，消息路由 50% miss，2026-08-30 92bbd49b 实锤）。
          console.log(`[gateway] /clients 重复注册顶替旧连接 sid=${sid}（高频出现=同会话双进程乒乓）`)
          try {
            prev.close()
          } catch {
            /* 忽略 */
          }
        }
        cliClients.set(sid, ws)
        cliRegisterAt.set(sid, Date.now())
        approvalTrailPush('cli-register', sid)
        ensureSseWatches(root) // P0：新 CLI 会话上线（web spawn / 终端在全新项目首开会话）→ 补齐其落盘目录 watch
        flushPendingDeliveries(sid) // 2026-09-06 wsession 异步化：spawn 期间暂存的消息按序补投
        // 2026-09-07 断连感知闭环：注册成功=会话进程回归，SSE 群发 session-up → web 清「已断开」
        // 提示并刷新（状态点恢复由 CLI 注册后的 activity 上报/60s 心跳兜底，网关不代答状态）。
        {
          const s = `data: ${JSON.stringify({ type: 'session-up', session: sid })}\n\n`
          sendAll(sseClients, (c) => { c.res.write(s) })
        }
        scheduleIdleShutdown()
        // 2026-08-24 审批双操作（web 与 CLI 均可）：CLI 交互权限弹窗经 /clients 上报审批请求，
        // 网关转 floria 审批卡；本地先操作/请求撤销 → 通知 floria 撤卡。
        ws.on('message', (data) => {
          let m: {
            type?: string
            requestId?: string
            toolName?: string
            input?: unknown
            toolUseId?: string
            description?: string
            suggestions?: unknown
            blockedPath?: string
            response?: unknown
            items?: unknown
            active?: unknown
            pid?: unknown
            seq?: unknown
            base?: unknown
            messages?: unknown
          }
          try {
            m = JSON.parse(data.toString())
          } catch {
            return
          }
          // 2026-08-24 中继握手：记录 CLI 是否带审批/提问中继代码（relay:true = 新代码）
          if (m.type === 'cli-hello') {
            // 2026-09-08 事件流统一：cli-hello = 进程身份确立，seq 流随进程重启归 1 →
            // 旧记账作废（否则新进程首条 delta 被「seq <= last」去重永久吞掉，web 卡死）。
            sessionDeltaSeq.delete(sid)
            approvalTrailPush('cli-hello', sid, undefined, m.relay === true ? 'relay-on' : 'relay-off')
            // 2026-09-07 wt 直并：真实 CLI pid 由 cli-hello 上报（wt.exe 中转即退，网关拿不到）。
            // spawn 在途（webSessions 尚无此 sid）→ 暂存，spawnWebSession 注册成功时取走填入；
            // 已入库 → 直接补填。普通 CLI 主进程（非 web spawn）不入暂存表。
            if (typeof m.pid === 'number' && m.pid > 0 && (webSessions.has(sid) || spawningPromises.has(sid))) {
              const proc = webSessions.get(sid)
              if (proc && proc.pid !== m.pid) {
                proc.pid = m.pid
                persistWebSessions()
              } else if (!proc) {
                cliHelloPids.set(sid, m.pid)
              }
            }
            return
          }
          // 2026-08-30 队列快照（清单#2）：CLI commandQueue 当前排队项 → 存 per-session +
          // SSE 群发（事件体直接带 items，前端免拉 /gateway/session 即更新置底排队区）。
          // items 为全量快照（CLI 侧 enqueue/dequeue 后都重发），网关只做镜像存储+转发。
          if (m.type === 'queue-state') {
            const items = Array.isArray(m.items)
              ? (m.items as Array<{ content?: unknown; ts?: unknown }>)
                  .filter(it => it && typeof it === 'object' && typeof it.content === 'string')
                  .map(it => ({ content: (it.content as string).slice(0, 2000), ts: typeof it.ts === 'number' ? it.ts : Date.now() }))
              : []
            sessionQueues.set(sid, { items, updatedAt: Date.now() })
            sweepStaleMaps()
            const s = `data: ${JSON.stringify({ type: 'queue-state', session: sid, items })}\n\n`
            sendAll(sseClients, (c) => { c.res.write(s) })
            return
          }
          // 2026-09-04 压缩实时态：CLI onCompactProgress → /clients WS {type:'compact-state', active}
          // → SSE 群发（无状态转发，web 自持 per-session 标记）。压缩进行中 jsonl 零写入（boundary+
          // summary 同毫秒落盘于结束时刻），SSE 'updated' 不会来——本事件是 web「正在压缩」唯一实时源。
          if (m.type === 'compact-state') {
            const s = `data: ${JSON.stringify({ type: 'compact-state', session: sid, active: m.active === true })}\n\n`
            sendAll(sseClients, (c) => { c.res.write(s) })
            return
          }
          // 2026-09-06 web 打断收口/撤回链：CLI onCancel → {type:'turn-state', live:false}（web 收口
          // 「正在处理/正在思考」运行态——打断后 jsonl 零写入，本事件是 web「回合被中止」唯一实时源）；
          // auto-restore（web 发起打断且无 meaningful 响应）→ {type:'restored', text}（web 摘开启气泡
          // + 文本回填输入栏）。均无状态转发，web 自持 per-session 标记。
          if (m.type === 'turn-state') {
            // 2026-09-06 收口二轮：live:false = 回合被中止，记网关权威时刻（无 TTL）供
            // /gateway/sessions 下发，前端刷新后凭此恢复收口判定（实时路径照旧 SSE 直达）。
            // 2026-09-07：回合中止即清活性 beat（旧 beat 不得跨回合参与新回合的无响应判定）。
            if (m.live === false) {
              turnEndAt.set(sid, Date.now())
              persistTurnEndAt() // 2026-09-07 变更即写：打断收口信号跨网关重启存活
              turnBeatAt.delete(sid)
            }
            const s = `data: ${JSON.stringify({ type: 'turn-state', session: sid, live: m.live === true })}\n\n`
            sendAll(sseClients, (c) => { c.res.write(s) })
            return
          }
          if (m.type === 'turn-beat') {
            // 2026-09-07 僵死感知：CLI 引擎增量心跳（4s 节流），记最后活性时刻 + SSE 群发。
            // web 运行态计时 tick 对账：beat 落后超阈值 → 「无响应」提示（进程/WS 活但 query 链
            // 僵死的唯一可判信号）。无状态转发语义，web 自持 per-session 时刻。
            turnBeatAt.set(sid, Date.now())
            const s = `data: ${JSON.stringify({ type: 'turn-beat', session: sid })}\n\n`
            sendAll(sseClients, (c) => { c.res.write(s) })
            return
          }
          if (m.type === 'stream-text') {
            // 2026-09-08 流式字符通道：引擎流式 delta（CLI 100ms 合帧全文快照）无状态转发 +
            // SSE 群发 → web 状态行后流式预览。空串 = 块边界/消息落盘/打断清除信号。纯暂态
            // 显示层（不落盘、不进权威序列），载荷截断防滥用；丢失无害（下一帧覆盖）。
            const text = typeof m.text === 'string' ? m.text.slice(0, 65536) : ''
            const s = `data: ${JSON.stringify({ type: 'stream-text', session: sid, text })}\n\n`
            sendAll(sseClients, (c) => { c.res.write(s) })
            return
          }
          if (m.type === 'restored') {
            const text = typeof m.text === 'string' ? m.text : ''
            const s = `data: ${JSON.stringify({ type: 'restored', session: sid, text })}\n\n`
            sendAll(sseClients, (c) => { c.res.write(s) })
            return
          }
          if (m.type === 'session-delta') {
            // 2026-09-08 事件流统一 P1（方案 20260908135557）：引擎投影 delta 直达 web。
            // CLI 侧 buildDisplayDelta（过滤权威单源）即发 → 本处 seq 记账去重 + SSE 群发。
            // seq <= last = 重复/迟到丢弃；gap（seq > last+1）照发——web 端 gap 判定 → 全量
            // 对账重建基线（CLI 重启 seq 归 1 由 cli-hello 重置覆盖）。不缓存 delta 历史。
            // 载荷基本校验（数组/对象/条数上限=投影窗口 200+裕量）防异常膨胀。
            const seq = typeof m.seq === 'number' && Number.isInteger(m.seq) && m.seq > 0 ? m.seq : 0
            if (!seq) return
            const last = sessionDeltaSeq.get(sid) ?? 0
            if (seq <= last) return
            sessionDeltaSeq.set(sid, seq)
            const base = typeof m.base === 'number' && Number.isInteger(m.base) && m.base >= 0 ? m.base : 0
            const msgs = Array.isArray(m.messages)
              ? m.messages.filter((x) => x && typeof x === 'object').slice(0, 220)
              : []
            const s = `data: ${JSON.stringify({ type: 'session-delta', session: sid, seq, base, messages: msgs })}\n\n`
            sendAll(sseClients, (c) => { c.res.write(s) })
            return
          }
          if (m.type === 'approval-request' && m.requestId) {
            approvalTrailPush('cli-approval-request', sid, m.requestId, m.toolName)
            // 2026-08-26 A2：补透传 CLI 侧 sendRequest 已上报的 description/suggestions/blockedPath，
            // 供前端审批卡展示原因说明、可勾选的「记住此规则」与被拒路径（undefined 字段自动省略）。
            const approvalMsg = {
              type: 'approval',
              session_id: sid,
              requestId: m.requestId,
              toolName: m.toolName,
              toolUseId: m.toolUseId,
              input: m.input,
              description: m.description,
              suggestions: m.suggestions,
              blockedPath: m.blockedPath,
            }
            pendingApprovalsSet(sid, m.requestId, approvalMsg) // 2026-08-30 pending 重放：暂存未决项
            broadcast(approvalMsg)
            approvalTrailPush('gw-broadcast-approval', sid, m.requestId, `sockets=${sockets.size}`)
            return
          }
          // 本地（CLI 终端/窗口）已操作（allow/deny/abort）或请求已解决 → floria 撤卡
          if ((m.type === 'approval-local-resolved' || m.type === 'approval-cancel') && m.requestId) {
            approvalTrailPush('cli-local-resolved-or-cancel', sid, m.requestId, m.type)
            pendingApprovalsDrop(m.requestId) // 2026-08-30 pending 重放：已解决不再回放
            broadcast({ type: 'approval-dismiss', session_id: sid, requestId: m.requestId })
            return
          }
          // 2026-08-26 P0 审批确认送达：CLI 处理完 approval-response（handler 命中消费）后回执，
          // 网关转 approval-confirmed 给 floria → 前端收到确认才关卡（不再 WS send 后立即清卡）。
          // 目标 CLI 在线但本地已 resolve（竞速输/已撤销）不发本回执——floria 会收到 approval-dismiss 撤卡。
          if (m.type === 'approval-processed' && m.requestId) {
            approvalTrailPush('cli-approval-processed', sid, m.requestId)
            pendingApprovalsDrop(m.requestId) // 2026-08-30 pending 重放：CLI 已消费不再回放
            broadcast({ type: 'approval-confirmed', session_id: sid, requestId: m.requestId })
            approvalTrailPush('gw-approval-confirmed', sid, m.requestId)
            return
          }
        })
        const detach = () => {
          if (cliClients.get(sid) === ws) cliClients.delete(sid)
          // 2026-08-30 队列快照：队列态只属于在线 CLI 进程，断开即清（重连后 queue-state 补发对齐）
          sessionQueues.delete(sid)
          // 2026-09-08 断连感知根修：detach 不再立即清 activity/beat + 群发 null——CLI /clients
          // WS 断开 ~1s 重连（RECONNECT_BASE_MS）是常态（网络抖动/睡眠恢复），立即群发会让 web
          // 把活回合误收口成「已处理」（未完成对话停止计时实证）。改 3s 复核窗：窗口内重连 →
          // 全静默（CLI 重连 activityResync 重报自然恢复）；到期未重连才收口——activity null
          // 群发与 session-down 从此共用同一判定时机（进程失联确认），状态源减少。
          // （close 与 error 双触发由 detachTimers 去重；error 后 close 亦会到，幂等无害。）
          const prevDetach = detachTimers.get(sid)
          if (prevDetach) clearTimeout(prevDetach)
          detachTimers.set(
            sid,
            setTimeout(() => {
              detachTimers.delete(sid)
              if (cliClients.has(sid)) return // 复核窗内重连：状态由重连重报恢复，静默
              turnBeatAt.delete(sid)
              sessionActivity.delete(sid)
              const down = `data: ${JSON.stringify({ type: 'activity', session: sid, state: null })}\n\n`
              sendAll(sseClients, (c) => { c.res.write(down) })
              // 2026-08-24 web 会话：CLI 窗口被用户关闭 → 进程死亡 → 从运行表移除
              // （会话仍可从磁盘 resume；2026-08-25 起无来源注册表，列表不再区分来源）。
              // 仅进程真死才删（gatewayClient 断线重连期间进程仍活着，不能误删）。
              const wp = webSessions.get(sid)
              if (wp && wp.pid && !isPidAlive(wp.pid)) {
                webSessions.delete(sid)
                persistWebSessions()
                // 进程真死 → 显式 session-down 群发，web toast 告知用户会话已退出、需点开重开
                const exited = `data: ${JSON.stringify({ type: 'session-down', session: sid })}\n\n`
                sendAll(sseClients, (c) => { c.res.write(exited) })
              }
            }, 3000),
          )
          scheduleIdleShutdown()
        }
        ws.on('close', detach)
        ws.on('error', detach)
        ws.send(JSON.stringify({ type: 'registered', session: sid }))
      })
      return
    }
    socket.destroy()
  })
  let gatewayListened = false
  server.on('error', (err) => {
    // 端口被占等错误：关闭对象避免悬挂
    if (server) {
      server.close()
      server = null
    }
    console.error(`[gateway] 启动失败: ${(err as Error).message}`)
    // P5（2026-08-28）：--gateway 独立进程 listen 失败（EADDRINUSE 等）→ 直接退出，
    // 不留无监听僵尸进程驻留（实测 8199 冲突进程不退，干扰下轮诊断）。
    if (process.argv.includes('--gateway') && !gatewayListened) process.exit(1)
  })
  server.listen(currentPort, currentHost, () => {
    gatewayListened = true
    console.log(`[gateway] 内置网关监听 http://${currentHost}:${currentPort} (token=${currentToken})`)
    // mDNS 应答器只在全网卡监听时有意义；绑 127.0.0.1（调试）时不起
    if (currentHost === '0.0.0.0') mdnsStart()
  })

  const lan = lanAddress()
  return {
    port: currentPort,
    host: currentHost,
    token: currentToken,
    lanUrl: lan ? `http://${lan}:${currentPort}/?token=${currentToken}` : '',
    localUrl: `http://127.0.0.1:${currentPort}/?token=${currentToken}`,
  }
}

export function stopLocalGateway(): boolean {
  gatewayStopping = true
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  stopSseWatches()
  mdnsStop() // mDNS 应答器随网关关停（floria.local 停止解析，设备回落 IP 直连）
  // P2 收敛：停单一回收定时器。web 会话窗口不随网关关停（2026-08-29 根修：此前 killAllWebSessions
  // 把正在执行 /server restart 的 web 会话自己杀掉，restart 断在半路且窗口退出）——web 会话与普通
  // CLI 会话同等权重，网关 off/restart/空闲退出均只关网关，窗口存活并自动重连新网关（注册表已落盘，
  // 新网关启动 adoptWebSessions 收养）；backend 同理（2026-08-28 生命周期解耦）。
  if (reclaimTimer) {
    clearInterval(reclaimTimer)
    reclaimTimer = null
  }
  for (const c of sockets) {
    try {
      c.close()
    } catch {
      /* 忽略 */
    }
  }
  sockets.clear()
  // 2026-08-17 独立化：一并断开所有 CLI 客户端（它们会各自重连或静默等待）
  for (const c of cliClients.values()) {
    try {
      c.close()
    } catch {
      /* 忽略 */
    }
  }
  cliClients.clear()
  // SSE 僵尸连接根治（2026-09-09）：server.close() 只停止接受新连接，不断开既有连接——已挂上的
  // EventSource 流保持 ESTABLISHED，浏览器收不到 TCP FIN → onerror 永不触发 → 前端永不重连。
  // 此前这里只 sseClients.clear() 清引用，旧页面的 SSE 就成了僵尸：消息区收不到
  // updated/session-delta/stream-text，只剩首个乐观气泡永不更新（「web 新建会话长时间空白」根因）。
  // 根治 = 显式 end() 所有 SSE 响应流：客户端收到流结束 → onerror → 3s 后 initLive 重连新网关
  // → hello → refreshSession 全量对账，页面不刷新自动恢复（与上方 WS 显式 close → 自动重连对称）。
  for (const c of sseClients) {
    try {
      c.res.end()
    } catch {
      /* 忽略 */
    }
  }
  sseClients.clear()
  sseSizes.clear()
  ssePrimed = false
  // C1 修复：停网关时一并清空 CLI 上报的内存缓存（内存数据本就随网关重启失效）
  conversationDisplays.clear()
  sessionActivity.clear()
  sessionModels.clear()
  // 共享 token 一并清空：网关停止后 CLI 上报不再附加（保持静默失败，不报错）。
  // 2026-08-17 独立化：同时清盘 token 文件，避免遗留的 token 被误用（新一轮网关会重新生成写盘）。
  setGatewayToken('')
  clearGatewayTokenFromDisk()
  clearGatewayPortFromDisk()
  // 2026-08-28 修订：/server off|restart 不再清设备授权票证（用户实测「重启后授权全没了」）——
  // 授权名单是手动配对的持久资产，只由 /server auth add / auth off 管理；gateway-token（内部）
  // 照旧清盘（重启随机新生成）。设备 cookie 的票证在名单里始终有效，跨重启免重配。
  try {
    wss?.close()
  } catch {
    /* 忽略 */
  }
  wss = null
  if (server) {
    server.close()
    server = null
    return true
  }
  return false
}
