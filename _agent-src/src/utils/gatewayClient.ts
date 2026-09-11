/**
 * gatewayClient.ts —— CLI 侧网关客户端（2026-08-17 网关独立化）。
 *
 * 网关现在是独立进程（同一 exe 的 --gateway 模式，/server on spawn）。每个交互式 CLI
 * 进程（非网关宿主）启动后由本模块：
 *  1. 探测本机网关（GET /gateway/health，地址 = FLOIRA_GATEWAY 或回退 127.0.0.1:8124）；
 *     网关未起则后台定时重试（网关后起也能连上），全程静默不打扰；
 *  2. 读盘 token（网关进程启动时写入便携根 .claude/gateway-token）→ setGatewayToken，
 *     让 conversationDisplay 的 HTTP 上报（/gateway/conversation、/gateway/activity）也带 token；
 *  3. 以 WebSocket 客户端连 /clients?token=&session=<getSessionId()> 注册自己的会话；
 *  4. 收到网关转发来的遥测端消息（{type:'send', text}）→ enqueue 注入本进程 REPL
 *     （与打字同路径，复用 messageQueueManager.enqueue + bridgeOrigin:true）。
 *
 * 断线指数退避重连。headless（print.ts）不挂载本模块：它只上报、不交互，无 REPL 可注入。
 */
import WebSocket from 'ws'
import { getSessionId } from '../bootstrap/state.js'
import { invokeControlOverride } from '../bridge/controlOverrideHandle.js'
import { invokeGatewayInterrupt } from '../bridge/gatewayInterruptHandle.js'
import { invokeGatewayQueueNudge } from '../bridge/gatewayQueueNudgeHandle.js'
import {
  setGatewayPermissionCallbacks,
} from '../bridge/gatewayPermissionRelay.js'
import type { BridgePermissionCallbacks, BridgePermissionResponse } from '../bridge/bridgePermissionCallbacks.js'
import { getMainLoopModel } from './model/model.js'
import { setSessionProviderOverride } from './credentials/pool.js'
import { enqueue, getCommandQueueSnapshot, subscribeToCommandQueue } from './messageQueueManager.js'
import { getGatewayToken, loadGatewayPortFromDisk, loadGatewayTokenFromDisk, setGatewayToken } from './gatewayToken.js'
import { compressImageBuffer } from './imageResizer.js'
import type { QueuedCommand } from '../types/textInputTypes.js'
import { feature } from 'bun:bundle'

const HEALTH_TIMEOUT_MS = 1500
const PROBE_RETRY_MS = 10_000
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 60_000

/**
 * 网关 HTTP 基地址：FLOIRA_GATEWAY env 优先；缺失（wt 直并入旧 WT 窗口时 env 不达子进程）
 * 读盘 .claude/gateway-port（网关启动写）；再缺失回退默认 8124。
 */
function baseUrl(): string {
  if (process.env.FLOIRA_GATEWAY) return process.env.FLOIRA_GATEWAY.replace(/\/+$/, '')
  const port = loadGatewayPortFromDisk() || 8124
  return `http://127.0.0.1:${port}`
}

function wsHostPort(): { host: string; port: number } {
  const u = new URL(baseUrl())
  return { host: u.hostname, port: Number(u.port || 8124) }
}

let started = false
let ws: WebSocket | null = null
let timer: NodeJS.Timeout | null = null
let attempt = 0
// 2026-09-08 web 关闭会话优雅退出：网关 stopWebSession 精确路由 {type:'shutdown'} 后置位，
// close 不再重连、进程 exit 0（WT closeOnExit=graceful 自动收 tab，不留「已退出进程」提示页）。
let shuttingDown = false
// 当前 WS 注册到网关 /clients 的 sessionId（openSocket 时快照）。
// /resume、/clear、/branch 等 switchSession 换了 sessionId 后网关注册表仍挂旧 sid →
// web 发送按旧 id 路由 miss → 网关误判会话离线 → 冷启动弹第二个窗口（同会话双进程）。
let registeredSid = ''
let sidWatchAttached = false

// 2026-08-31 应答处理器表提升模块级（原 openSocket 内 per-connection）：重启前挂起的弹窗把
// onResponse 注册在旧 socket 的表上，重连后新 socket 的表查不到 → web 作答送达也被丢。
// 跨重连保留后，approval-response 在新连接上仍能命中 handler，唤醒重启前的交互弹窗。
const pendingResponses = new Map<string, (response: BridgePermissionResponse) => void>()

// 2026-08-31 跨网关重启 pending 补发：审批/提问请求只在弹窗出现瞬间发一次，网关重启清空内存
// pendingApprovals 后，存活 CLI 重连 /clients 却不重发 → web subscribe 重放查空，只剩 jsonl
// 只读兜底卡无法作答（08-31 实测）。sendRequest 记入本表，WS（重）连 open 后逐条重发（走网关
// 现有暂存+broadcast 链路，网关零改动）；解决点（本地 resolve / web 应答消费 / 退订）逐处移除。
type PendingApprovalPayload = {
  requestId: string
  toolName: string
  input: Record<string, unknown>
  toolUseId: string
  description: string
  suggestions?: unknown
  blockedPath?: string
}
const pendingApprovalRequests = new Map<string, PendingApprovalPayload>()

// 2026-09-11 审批中继常驻化（根治「网关重启断连窗口内弹出的审批永不中继」）：
// 原实现把回调注册挂在 sock.on('open')、清除挂在 sock.on('close')——断连窗口内出现的交互权限
// 弹窗在 useCanUseTool 处取到 null，interactiveHandler 直接跳过整个 bridge 分支（连 sendRequest
// 都不调用）→ 请求既不上报也不进 pendingApprovalRequests，之后任何重连补发都无据可依
// （09-11 实测：网关 09:53 重启，弹窗所在会话在 /gateway/diagnostics 里零条 cli-approval-request）。
// 改为模块加载即常驻注册（闭包内读当前 ws）：不变量「审批请求一旦产生必入待发表」与 WS 连接状态
// 彻底解耦——断连期照常入表，重连时由 open 的补发链送达。
const permissionCallbacks: BridgePermissionCallbacks = {
  sendRequest(requestId, toolName, input, toolUseId, description, permissionSuggestions, blockedPath) {
    const payload: PendingApprovalPayload = {
      requestId,
      toolName,
      input,
      toolUseId,
      description,
      suggestions: permissionSuggestions,
      blockedPath,
    }
    pendingApprovalRequests.set(requestId, payload) // 跨重启补发：无条件记入待重发表
    sendApprovalRequest(payload)
  },
  sendResponse(requestId, response) {
    pendingApprovalRequests.delete(requestId) // 本地已解决 → 不再补发
    const sock = ws
    if (sock && sock.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify({ type: 'approval-local-resolved', requestId, response }))
    }
  },
  cancelRequest(requestId) {
    pendingApprovalRequests.delete(requestId) // 已解决/撤销 → 不再补发
    pendingResponses.delete(requestId)
    const sock = ws
    if (sock && sock.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify({ type: 'approval-cancel', requestId }))
    }
  },
  onResponse(requestId, handler) {
    pendingResponses.set(requestId, handler)
    return () => {
      if (pendingResponses.get(requestId) === handler) pendingResponses.delete(requestId)
      // 2026-08-31 abort 清理路径（turn 中止只退订不 cancelRequest）→ 一并撤出补发表
      pendingApprovalRequests.delete(requestId)
    }
  },
}
setGatewayPermissionCallbacks(permissionCallbacks)

// 2026-09-07 网关重启状态真空窗根治：activity 镜像只存网关内存（sessionActivity），重启/断连
// 即清零——此前只靠「状态变化 + 60s 心跳」补报，真空窗内网关 state=null，web closeSeg 把活
// 回合误收口成「已处理」冻结计时（Pj5 会话重启截图实证）。与 sendQueueState 重连补发同模式：
// REPL 经本钩子挂「重报当前状态」闭包（随 REPL effect 重建恒持最新 status），WS（重）连 open
// 即触发；首次连接若钩子未及挂载，由 effect 挂载时的自报兜底，两路幂等。
let activityResync: (() => void) | null = null
export function registerActivityResync(fn: (() => void) | null): void {
  activityResync = fn
}

function sendApprovalRequest(p: PendingApprovalPayload): void {
  const sock = ws
  if (!sock || sock.readyState !== WebSocket.OPEN) return
  try {
    sock.send(JSON.stringify({ type: 'approval-request', ...p }))
  } catch {
    /* 断开忽略 */
  }
}

function resendPendingApprovalRequests(): void {
  for (const p of pendingApprovalRequests.values()) sendApprovalRequest(p)
}

/**
 * 2026-08-28 遥测端图片 → pastedContents（结构对齐 utils/config.ts PastedContent：
 * {id, type:'image', content(base64), mediaType, filename}）。占位符 [Image #N] 由前端
 * 拼进 text、id 从 1 递增与之一一对应；文本无占位时 handlePromptSubmit 会把孤儿图片过滤掉。
 * 返回 undefined = 无合法图片，enqueue 不带 pastedContents 字段（纯文本消息零开销）。
 */
function pastedContentsFromImages(
  raw: unknown,
): Record<number, { id: number; type: 'image'; content: string; mediaType?: string; filename?: string }> | undefined {
  if (!Array.isArray(raw) || !raw.length) return undefined
  const out: Record<number, { id: number; type: 'image'; content: string; mediaType?: string; filename?: string }> = {}
  let nextId = 0
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const it = item as { content?: unknown; mediaType?: unknown; filename?: unknown; id?: unknown }
    if (typeof it.content !== 'string' || !it.content) continue
    // 2026-09-02 图片 id 防撞号：web 前端分配全会话唯一 id（对齐 CLI 本地粘贴 getInitialPasteId
    // 语义）——显式合法 id 直接用（占位 [Image #id] 与之一一对应）；无显式 id（旧版前端）回落
    // 自造递增。原恒从 1 起，同会话第二条带图消息互覆 image-cache 字节 → 历史图错图。
    const explicit = it.id
    let id =
      typeof explicit === 'number' && Number.isInteger(explicit) && explicit > 0 ? explicit : 0
    if (!id || out[id]) {
      do {
        nextId++
      } while (out[nextId])
      id = nextId
    }
    out[id] = {
      id,
      type: 'image',
      content: it.content,
      mediaType: typeof it.mediaType === 'string' && it.mediaType ? it.mediaType : 'image/png',
      ...(typeof it.filename === 'string' && it.filename ? { filename: it.filename } : {}),
    }
  }
  return Object.keys(out).length ? out : undefined
}

/**
 * P3 图片压缩前移（2026-08-31，20260828145952-内存增长根因与代码层修改建议.md）：
 * web 注入图 >2MB（raw）先压缩再入 pastedContents——pastedContents / 消息历史 / 落盘
 * 全链收敛为小图，避免大图 base64 会话内多副本驻留放大。CLI 本地粘贴链已有执行时
 * resize（processUserInput maybeResizeAndDownsampleImageBlock），此处理的是 web 端
 * 直传原图无压缩的缺口。压缩失败回退原图（入历史前 processUserInput resize 兜底）。
 */
const WEB_IMAGE_MAX_BYTES = 2 * 1024 * 1024
async function compressPastedContentsFromImages(
  raw: unknown,
): Promise<Record<number, { id: number; type: 'image'; content: string; mediaType?: string; filename?: string }> | undefined> {
  const base = pastedContentsFromImages(raw)
  if (!base) return base
  for (const img of Object.values(base)) {
    try {
      // base64 长度快速预判（raw ≈ len*3/4），小图零开销直通
      if (img.content.length <= (WEB_IMAGE_MAX_BYTES * 4) / 3) continue
      const buffer = Buffer.from(img.content, 'base64')
      if (buffer.length <= WEB_IMAGE_MAX_BYTES) continue
      const compressed = await compressImageBuffer(buffer, WEB_IMAGE_MAX_BYTES, img.mediaType)
      img.content = compressed.base64
      img.mediaType = compressed.mediaType
    } catch {
      /* 压缩失败保留原图 */
    }
  }
  return base
}

async function isGatewayUp(): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl()}/gateway/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
    if (!res.ok) return false
    const d = (await res.json()) as { mode?: string }
    return d.mode === 'gateway'
  } catch {
    return false
  }
}

/**
 * 2026-08-28 网关缺失自愈：探测失败（网关确证不在）时自动拉起独立网关进程。
 * 此前网关 crash/空闲回收退出后 REPL 只会静默无限重连，遥测端永远连不上，需手动 /server on
 * （2026-08-28 遥测端断连事故根因之一）。ensureGatewayAutoStart 内部 60s 节流 + 不强抢端口，
 * spawn 后下一轮 PROBE_RETRY 自然连上。feature 内联门控保 PRIVATE_GATEWAY 关闭时 tree-shake。
 */
async function autoStartGateway(): Promise<void> {
  try {
    if (feature('PRIVATE_GATEWAY')) {
      const { ensureGatewayAutoStart } = await import('../commands/server/server.js')
      await ensureGatewayAutoStart()
    }
  } catch {
    /* 拉起失败静默，下轮探测重试 */
  }
}

/** 探测网关 → 读盘 token → 连 /clients。网关未起则定时重试（gateway 后起也能连上）。 */
async function probeAndConnect(): Promise<void> {
  if (ws) return
  if (!(await isGatewayUp())) {
    void autoStartGateway()
    schedule(PROBE_RETRY_MS)
    return
  }
  const token = loadGatewayTokenFromDisk()
  if (!token) {
    // 网关起来了但 token 尚未落盘（瞬态）：稍后再试
    schedule(PROBE_RETRY_MS)
    return
  }
  // 让本进程的 HTTP 上报也带 token（否则非网关宿主的 CLI 上报会被 401）
  setGatewayToken(token)
  openSocket(token)
}

function openSocket(token: string): void {
  const { host, port } = wsHostPort()
  const sid = getSessionId()
  registeredSid = sid
  const url = `ws://${host}:${port}/clients?token=${encodeURIComponent(token)}&session=${encodeURIComponent(sid)}`
  let sock: WebSocket
  try {
    sock = new WebSocket(url)
  } catch {
    schedule(RECONNECT_BASE_MS)
    return
  }
  ws = sock
  // 2026-09-11 审批中继回调已提升为模块级常驻（见文件上方 permissionCallbacks 及其注释），
  // 与 WS 连接生命周期解耦：连接建立/断开都不再增删回调，断连期弹窗照常入待发表待补发。
  sock.on('open', () => {
    attempt = 0
    // 2026-08-24 中继握手：告知网关本 CLI 带审批/提问中继代码（网关 /gateway/diagnostics trail 记 cli-hello，
    // 用于判断「cliClients 有会话但不中继」是旧进程还是新代码 bug）。
    // 2026-09-07 spawn 链 wt 直并后网关拿不到 -PassThru pid：握手上报本进程 pid，
    // 网关填 webSessions 供 stopWebSession taskkill 树杀。
    sock.send(JSON.stringify({ type: 'cli-hello', relay: true, pid: process.pid }))
    // 2026-08-24 模型 web/CLI 同步：连接后上报一次当前实际模型（网关存 sessionId→model 供 web 读取）
    reportCurrentModel()
    // 2026-08-30 队列快照：重连后补发一次当前排队状态（订阅期间的断线窗口靠它对齐）
    sendQueueState()
    // 2026-09-10 任务清单快照：同队列——重连补发当前可见清单，web 底栏任务浮窗对齐
    sendTaskState()
    // 2026-08-31 跨网关重启 pending 补发：仍挂起的审批/提问逐条重发 → 网关重新暂存+broadcast，
    // web 补弹可交互卡（重启前弹的卡随网关内存清空丢失，此前只剩只读兜底卡无法作答）
    resendPendingApprovalRequests()
    // 2026-09-07 重连即重报当前活动状态：sessionActivity 是网关内存镜像，重启即空，
    // 等 60s 心跳的真空窗里 web 会把活回合误收口成「已处理」（见 registerActivityResync 注）
    activityResync?.()
  })
  sock.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString()) as {
        type?: string
        text?: string
        value?: unknown
        /** 2026-09-10 会话级供应商绑定：model 消息随带的模型归属供应商（本进程据此绑定 baseUrl/key） */
        provider?: string | null
        requestId?: string
        response?: BridgePermissionResponse
        sessionId?: string
        title?: string
        images?: unknown
      }
      // 2026-08-24 审批双操作：floria 的审批结果经网关回传 → 唤醒交互权限弹窗的 bridge 竞速分支
      if (msg.type === 'approval-response' && msg.requestId) {
        pendingApprovalRequests.delete(msg.requestId) // 2026-08-31 web 已作答 → 撤出补发表（含 handler miss 的死请求）
        const handler = pendingResponses.get(msg.requestId)
        if (handler) {
          pendingResponses.delete(msg.requestId)
          handler(msg.response ?? { behavior: 'deny', message: 'empty approval response' })
          // 2026-08-26 P0 审批确认送达：回执网关「已处理」→ 转 floria approval-confirmed，
          // 前端收到确认才关卡（不再 WS send 后立即清卡）。仅 handler 命中（本端消费）才回执；
          // 本地已 resolve（竞速输）时 pendingResponses 已删，不发——floria 会收到 approval-dismiss 撤卡。
          try {
            sock.send(JSON.stringify({ type: 'approval-processed', requestId: msg.requestId }))
          } catch {
            /* 断开忽略 */
          }
        }
        return
      }
      // floria 侧撤卡（本地已操作/请求已解决）→ 丢弃本地挂起的响应订阅
      if (msg.type === 'approval-cancel' && msg.requestId) {
        pendingResponses.delete(msg.requestId)
        return
      }
      // 2026-08-22 模型/思考等级控制消息：网关 POST /gateway/model 后按会话路由给在线 CLI，
      // 走 controlOverrideHandle → REPL 侧 setAppState（与官方 useReplBridge.onSetModel 同语义）。
      // 2026-09-10 会话级供应商绑定：网关随 model 下发 provider（该模型归属供应商）→
      // 本进程绑定其 baseUrl/key（进程内，见 credentials/pool.ts）。provider 缺失/null 时清除
      // 绑定回落启动快照。跨供应商切换从此只影响本会话，不再借道全局凭据池。
      if (msg.type === 'model') {
        setSessionProviderOverride(typeof msg.provider === 'string' ? msg.provider : null)
        invokeControlOverride(msg.type, msg.value)
        return
      }
      if (msg.type === 'effort') {
        invokeControlOverride(msg.type, msg.value)
        return
      }
      // 2026-08-25 web 重命名 → CLI 实时同步：网关 /gateway/session/rename 后按会话精确路由
      // {type:'rename', sessionId, title} 给在线 CLI（routeToClient），更新内存标题缓存 +
      // 输入栏徽标，无需重启 CLI 即可看到新名字。
      if (msg.type === 'rename' && typeof msg.sessionId === 'string' && typeof msg.title === 'string') {
        invokeControlOverride('rename', { sessionId: msg.sessionId, title: msg.title })
        return
      }
      // 2026-09-04 web 打断按钮：网关把 web 前端的 interrupt 按会话精确路由过来 → 同 CLI 一次
      // Ctrl+C（onCancel 全套：abort('user-cancel') + 清权限弹窗/队列 + 保留部分流式文本）。
      // 句柄由 REPL 注册（gatewayInterruptHandle），未挂载（headless 无 REPL）静默忽略。
      if (msg.type === 'interrupt') {
        invokeGatewayInterrupt()
        return
      }
      // 2026-09-10 web 排队消息催办：点击排队气泡 → 网关按会话路由过来 → REPL 侧
      // 判活后置位催办标记（messageQueueManager.requestQueueNudge），生成流随之
      // 就地断流 + 本轮 drain 纳入。与 interrupt 的区别：不改回合边界、不撤回、
      // 不产生新回合——排队消息织进当前折叠体。句柄未挂载（headless）静默忽略。
      if (msg.type === 'queue-nudge') {
        invokeGatewayQueueNudge()
        return
      }
      // 2026-09-08 web 关闭会话优雅退出：stopWebSession 先走本消息（树杀仅作 3s 兜底）。
      // 停重连定时器 + 置位 shuttingDown（close 事件不再 schedule）→ 短延迟 exit 0，让
      // close 帧先行——exit 0 令 WT closeOnExit(graceful) 自动收 tab，强杀 exit 1 会残留
      // 「已退出进程，代码为 1」提示页（wt 直并链副作用，用户实测）。
      if (msg.type === 'shutdown') {
        shuttingDown = true
        if (timer) { clearTimeout(timer); timer = null }
        try { sock.close() } catch { /* 已断开 */ }
        setTimeout(() => process.exit(0), 100)
        return
      }
      if (msg.type === 'send' && typeof msg.text === 'string' && msg.text.trim()) {
        // 2026-08-28 遥测端图片：网关透传 images（base64 无 data: 前缀）→ 构造 pastedContents，
        // 与本地粘贴图片完全同链路（enqueue → handlePromptSubmit：仅当文本 [Image #N] 占位与
        // 图片 id 匹配才发送、孤儿图片被过滤兜底）。2026-08-31 P3 起 >2MB 图先压缩再入链。
        const pasted = await compressPastedContentsFromImages(msg.images)
        enqueue({
          value: msg.text,
          mode: 'prompt',
          skipSlashCommands: true,
          bridgeOrigin: true,
          ...(pasted ? { pastedContents: pasted } : {}),
        } as QueuedCommand)
      }
    } catch {
      /* 忽略坏帧 */
    }
  })
  sock.on('close', () => {
    if (ws === sock) {
      ws = null
      // 2026-09-11 常驻化后断开不再清空审批回调（见 permissionCallbacks 注释）：断连窗口内
      // 弹出的审批必须照常入待发表，才能在重连（open 的 resend）时补发到网关。
      // 2026-08-31 pendingResponses 提升模块级后断开不再 clear（原 per-connection 表断开即清）：
      // 重启前挂起弹窗的 handler 必须跨重连保留，approval-response 在新连接上才能命中。
      // 残留由 onResponse 退订 / approval-response 消费 / approval-cancel 逐点回收。
      if (shuttingDown) return // 2026-09-08 优雅退出中：不再重连，进程即将 exit 0
      schedule(reconnectDelay())
    }
  })
  sock.on('error', () => {
    /* error 后必跟 close，重连交给 close */
  })
}

function reconnectDelay(): number {
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS)
  attempt++
  return delay
}

function schedule(ms: number): void {
  if (timer) return
  timer = setTimeout(() => {
    timer = null
    void probeAndConnect()
  }, ms)
}

/**
 * 2026-08-30 共同后端队列快照（接力文档清单#2）：commandQueue 变化 → /clients WS 发
 * {type:'queue-state', items:[{content, ts}]} → 网关存 per-session 并 SSE 群发，web 置底
 * 排队区数据源。只报 mode==='prompt'（用户输入；task-notification/系统项不进排队区）。
 * content：string 直用；blocks 取 text join，纯图给占位。非关键路径，失败全静默。
 */
function queueItemsFromSnapshot(): Array<{ content: string; ts: number }> {
  return getCommandQueueSnapshot()
    .filter(cmd => cmd.mode === 'prompt')
    .map(cmd => {
      let content = ''
      if (typeof cmd.value === 'string') {
        content = cmd.value
      } else if (Array.isArray(cmd.value)) {
        const texts = cmd.value
          .filter((b): b is { type: 'text'; text: string } => b?.type === 'text' && typeof b.text === 'string')
          .map(b => b.text)
        content = texts.join('\n') || '[图片]'
      }
      return { content, ts: cmd.enqueuedAt ?? Date.now() }
    })
}

function sendQueueState(): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'queue-state', items: queueItemsFromSnapshot() }))
    } catch {
      /* 断开忽略 */
    }
  }
}

/**
 * 2026-09-10 web 任务清单链（底栏任务浮窗数据源）：TodoV2 任务清单变化 → /clients WS
 * {type:'task-state', tasks:[…]} → 网关存 per-session 并 SSE 群发 → web 底栏任务浮窗。
 * 载荷 = 当前可见清单（useTasksV2 TasksV2Store 单源出口，与 CLI TaskListV2 同源）；空数组
 * = 清单已清空/隐藏 → web 浮窗整体不出现（与 CLI「tasks.length === 0 → null」同一判定）。
 * 与 sendQueueState 同通道同形态（WS（重）连 open 补发同款）；非关键路径，失败全静默。
 * 去重：载荷不变不发——store 对未完成任务有 5s 兜底轮询，原样重发只会空刷 SSE。
 */
let latestTaskState: unknown[] | null = null
let lastTaskStateJSON = ''

function sendTaskState(): void {
  if (latestTaskState === null) return
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'task-state', tasks: latestTaskState }))
    } catch {
      /* 断开忽略 */
    }
  }
}

export function notifyTaskState(tasks: unknown[]): void {
  const list = Array.isArray(tasks) ? tasks : []
  let payload: string
  try {
    payload = JSON.stringify(list)
  } catch {
    return
  }
  if (payload === lastTaskStateJSON) return
  lastTaskStateJSON = payload
  latestTaskState = list
  sendTaskState()
}

/**
 * 2026-09-04 压缩实时态：REPL onCompactProgress（compact_start/compact_end，auto/manual 共用
 * compactConversation）→ /clients WS {type:'compact-state', active} → 网关 SSE 群发 → web 真空态
 * 强制「正在压缩会话中……」。压缩进行中 jsonl 零写入（boundary+summary 同毫秒落盘于结束时刻），
 * 本事件是 web 端唯一实时源。与 sendQueueState 同通道同形态；非关键路径，失败全静默。
 */
export function notifyCompactProgress(active: boolean): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'compact-state', active }))
    } catch {
      /* 断开忽略 */
    }
  }
}

/**
 * 2026-09-06 web 打断收口链：REPL onCancel → /clients WS {type:'turn-state', live:false} →
 * 网关 SSE 群发 → web 收口「正在处理/正在思考」运行态。打断后 jsonl 零写入（SSE 'updated'
 * 不来），web 判定回合结束只认 end_turn 回复落盘——无本信号则运行态永挂。与 compact-state
 * 同通道同形态；非关键路径，失败全静默。
 */
export function notifyTurnInterrupted(): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'turn-state', live: false }))
    } catch {
      /* 断开忽略 */
    }
  }
}

/**
 * 2026-09-07 web 僵死感知链：引擎每产出真实增量（thinking/text/subagent delta，REPL
 * setResponseLength 内容增长分支）→ {type:'turn-beat'} → 网关记 turnBeatAt + SSE 群发 →
 * web 运行态计时 tick 对账：beat 落后超阈值即显「无响应」。4s 节流（高频 delta 不刷屏），
 * 进程/WS 活但 query 链僵死时 beat 恒停 = web 可判。非关键路径，失败全静默。
 */
let lastBeatSentAt = 0
export function notifyTurnBeat(): void {
  const now = Date.now()
  if (now - lastBeatSentAt < 4000) return
  lastBeatSentAt = now
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'turn-beat' }))
    } catch {
      /* 断开忽略 */
    }
  }
}

/**
 * 2026-09-06 web 打断撤回链：auto-restore（打断且无 meaningful 响应回退）且打断源自 web →
 * {type:'restored', text} → web 摘该条开启气泡 + 文本回填 web 输入栏。jsonl 不删（rewind 只动
 * CLI 内存+换 conversationId），web 渲染按 per-session 标记永久跳过该 user。与 compact-state
 * 同通道；非关键路径，失败全静默。
 */
export function notifyInterruptRestored(text: string): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'restored', text }))
    } catch {
      /* 断开忽略 */
    }
  }
}

/**
 * 2026-09-08 事件流统一 P1（方案 20260908135557）：引擎投影 delta 即发——REPL messages 变化
 * （block 级，流式字符不入 messages）→ buildDisplayDelta（conversationDisplay.ts，过滤权威单源）
 * → {type:'session-delta', seq, anchorSid, messages} → 网关 seq 记账 + SSE 群发 → web 增量渲染。
 * 即发无防抖（block 级变化率 ~2.5/s 上限，方案 §3.1 定案不合帧）。会话 sid 由 /clients 连接
 * query 提供（queue-state 同款，载荷不带）；anchorSid = 投影稳定键（2026-09-10 协议根修：
 * 替代旧数字坐标 base，见 conversationDisplay.ts buildDisplayDelta）。WS 断开时静默丢弃：
 * seq 已在 CLI 侧消耗不回滚，web 端 gap 判定 → 全量对账重建（分布式流标准恢复语义，非兜底）。
 * 与 notifyCompactProgress 同通道同形态；非关键路径，失败全静默。
 */
export function notifySessionDelta(seq: number, anchorSid: string, messages: unknown[]): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'session-delta', seq, anchorSid, messages }))
    } catch {
      /* 断开忽略 */
    }
  }
}

/**
 * 2026-09-08 流式字符通道：引擎流式 delta（thinking/text，REPL onUpdateLength 单路累积）经
 * 100ms 合帧 → {type:'stream-text', text} → 网关 SSE 群发 → web 状态行后流式预览。text 为
 * 全文快照（无状态，丢失/乱序无害，尾部截断显示）；空串 = 块边界/消息落盘/打断 → web 清除
 * 暂态（权威 delta 随后接管）。sid 由 /clients 连接 query 提供（turn-beat 同款）；非关键路径，
 * 失败全静默。
 */
export function notifyStreamText(text: string): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify({ type: 'stream-text', text }))
    } catch {
      /* 断开忽略 */
    }
  }
}

let queueSubscriptionAttached = false

/**
 * 启动网关探测 + 客户端连接（幂等单例）。在交互 REPL 新会话启动点 fire-and-forget 调用。
 */
export function startGatewayProbeAndConnect(): void {
  if (started) return
  started = true
  if (!queueSubscriptionAttached) {
    queueSubscriptionAttached = true
    subscribeToCommandQueue(() => sendQueueState())
  }
  // 2026-08-30 会话切换注册自愈：sessionId 变化点分散（/resume、/clear、/branch、adopt…），
  // 事件点逐个接线易漏 → 周期自检兜底：注册 sid ≠ 当前 sid → 重注册（probeAndConnect 的
  // openSocket 天然带新 id；ws 为 null 时无需处理，重连流程本身就读当前 sid）。
  if (!sidWatchAttached) {
    sidWatchAttached = true
    setInterval(() => {
      if (ws && registeredSid && registeredSid !== getSessionId()) {
        refreshGatewayRegistration()
      }
    }, 10_000)
  }
  void probeAndConnect()
}

/**
 * sessionId 变化时刷新注册（如 REPL 开启新会话 / 切换会话）。关闭旧连接后重新探测连接，
 * 保证网关注册表里的 session 与当前会话一致。
 */
export function refreshGatewayRegistration(): void {
  if (ws) {
    try {
      ws.close()
    } catch {
      /* 忽略 */
    }
    ws = null
  }
  attempt = 0
  void probeAndConnect()
}

/**
 * 上报当前会话实际模型给网关（2026-08-24 模型 web/CLI 同步）。
 *
 * 每会话模型 override（mainLoopModelOverride）只存在于本进程内存，网关 /gateway/models 只返回凭据池
 * 全局默认 activeModel，web 模型 seat 因此与 CLI 实际使用不一致。本函数在 WS 连接后与模型切换点
 * 各调用一次，网关存 sessionId→model（TTL 10min），web 端 /gateway/session 读取校准。带 token query
 *（对齐 conversationDisplay.ts 的 gatewayApiUrl 模式）；网关未起 / 未在线时静默失败。
 */
export function reportCurrentModel(): void {
  try {
    const token = getGatewayToken()
    if (!token) return
    const sessionId = getSessionId()
    if (!sessionId) return
    const model = getMainLoopModel()
    if (!model) return
    void fetch(
      `${baseUrl()}/gateway/model-report?token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, model }),
        signal: AbortSignal.timeout(3000),
      },
    ).catch(() => { /* 网关未起等静默 */ })
  } catch {
    /* 忽略 */
  }
}
