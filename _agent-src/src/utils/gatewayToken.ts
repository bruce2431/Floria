/**
 * gatewayToken.ts —— 内置网关 token 的共享访问点（2026-08-15 安全加固）。
 *
 * 安全修复后 HTTP 数据接口（/gateway/*、/preview/*）与 WS 升级一致要求 token，而 CLI 侧上报
 * （conversationDisplay.ts POST /gateway/conversation、/gateway/activity）与 localGateway.ts 同进程。
 * 为避免两模块互相 import 形成循环依赖（localGateway import conversationDisplay 的
 * filterConversationForDisplay），token 存到本小模块，双方各自读写即可。
 *
 * 2026-08-17 网关独立化：token 跨进程落盘。网关进程（同一 exe 的 --gateway 模式）启动时
 * 把 token 写到便携根 `.claude/gateway-token`；其它 CLI 进程（非网关宿主）探测到网关后读盘
 * 获得 token，才能向网关上报 / 连接。内存优先级高于磁盘：本进程自己管理网关时
 * setGatewayToken 写入内存值；否则 getGatewayToken 惰性读盘兜底。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getPortableRoot } from './envUtils.js'

let currentToken = ''
let currentTokenTime = 0
let diskTokenCache = ''
let diskLoaded = false
let diskLoadTime = 0

// 2026-08-22 修复「web 消息无法注入 + 会话状态恒 None」：磁盘/内存 token 一次性缓存改 TTL 刷新。
// 根因=网关常比 CLI 晚起（/server on detached spawn）或 /server off→on 换新 token，而 CLI 在
// 网关未起时首次读盘会把「空串」永久缓存（diskLoaded=true），之后 loadGatewayTokenFromDisk 永远
// 返回空 → gatewayClient 用空 token 连 /clients 被 401 拒绝（cliClients 空 → web 消息无法注入）、
// conversationDisplay 上报 /gateway/activity 同样 401（会话状态恒 None）。加 TTL 后周期性重读，
// 网关后起 / 重启换 token 都能拿到新值。
const DISK_TOKEN_TTL_MS = 3000
const MEMORY_TOKEN_TTL_MS = 5000

export function setGatewayToken(token: string): void {
  currentToken = token
  currentTokenTime = token ? Date.now() : 0
}

/** 便携根 .claude/gateway-token 的绝对路径（相对便携根，符合全相对路径红线）。 */
function tokenFilePath(): string {
  return join(getPortableRoot(), '.claude', 'gateway-token')
}

/**
 * 网关进程启动时把 token 写盘，供其它 CLI 进程读取。失败静默（不阻塞网关启动）。
 */
export function saveGatewayTokenToDisk(token: string): void {
  try {
    const p = tokenFilePath()
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, token, { encoding: 'utf8' })
    diskTokenCache = token
    diskLoaded = true
    diskLoadTime = Date.now()
  } catch {
    /* 忽略 */
  }
}

/**
 * 读盘 token（其它 CLI 进程探测到网关后调用）。未落盘返回空串。
 * 结果带 TTL 缓存：过期后重读文件。文件缺失也算一次探测（TTL 后重试），
 * 避免「网关未起时读到空串被永久缓存」，也覆盖网关重启换新 token 的场景。
 */
export function loadGatewayTokenFromDisk(): string {
  const now = Date.now()
  if (diskLoaded && now - diskLoadTime < DISK_TOKEN_TTL_MS) return diskTokenCache
  diskLoadTime = now
  try {
    const p = tokenFilePath()
    if (existsSync(p)) {
      diskTokenCache = readFileSync(p, 'utf8').trim()
      diskLoaded = true
      return diskTokenCache
    }
  } catch {
    /* 忽略 */
  }
  diskTokenCache = ''
  diskLoaded = true
  return ''
}

/** 网关停止时清盘 token，并重置磁盘缓存。 */
export function clearGatewayTokenFromDisk(): void {
  try {
    rmSync(tokenFilePath(), { force: true })
  } catch {
    /* 忽略 */
  }
  diskTokenCache = ''
  diskLoaded = false
  diskLoadTime = 0
}

// ---------- 2026-09-07 网关端口落盘发现（wt 直并配套） ----------
// spawn 链改 wt.exe 直并后，并入「已存在 WT 窗口」的新标签继承的是旧 WT 进程的环境变量，
// FLOIRA_GATEWAY 传不到 CLI 子进程 → 网关端口发现补磁盘通道：网关启动写 .claude/gateway-port，
// CLI 探测在 env 缺失时读盘（与 gateway-token 同「读写路径分离 + TTL 缓存」模式）。
// 网关换端口（占用顺延）后新起的 CLI 仍能找到网关。
const portFilePath = () => join(getPortableRoot(), '.claude', 'gateway-port')
let diskPortCache = 0
let diskPortLoadedAt = 0
const DISK_PORT_TTL_MS = 3000

/** 网关进程启动时把端口写盘，供 env 缺失的 CLI 子进程发现（wt 并入旧窗口场景 env 不达）。 */
export function saveGatewayPortToDisk(port: number): void {
  try {
    const p = portFilePath()
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, String(port), { encoding: 'utf8' })
    diskPortCache = port
    diskPortLoadedAt = Date.now()
  } catch {
    /* 忽略 */
  }
}

/** 读盘网关端口（env 缺失时的发现通道）。未落盘/非法值返回 0（调用方回退默认 8124）。 */
export function loadGatewayPortFromDisk(): number {
  const now = Date.now()
  if (diskPortCache && now - diskPortLoadedAt < DISK_PORT_TTL_MS) return diskPortCache
  diskPortLoadedAt = now
  try {
    const p = portFilePath()
    if (existsSync(p)) {
      const n = Number(readFileSync(p, 'utf8').trim())
      diskPortCache = Number.isInteger(n) && n > 0 && n < 65536 ? n : 0
      return diskPortCache
    }
  } catch {
    /* 忽略 */
  }
  diskPortCache = 0
  return 0
}

/** 网关停止时清盘端口，并重置磁盘缓存。 */
export function clearGatewayPortFromDisk(): void {
  try {
    rmSync(portFilePath(), { force: true })
  } catch {
    /* 忽略 */
  }
  diskPortCache = 0
  diskPortLoadedAt = 0
}

/**
 * 当前 token：内存优先（本进程管理网关时由 startLocalGateway 设置），否则读盘兜底。
 * 内存 token 同样可能过期（本进程曾成功连上旧网关、网关随后重启换新 token），TTL 后回落读盘刷新。
 * 未启动网关 / 未落盘时返回空串 → 上报方不带 token（保持旧静默失败行为）。
 */
export function getGatewayToken(): string {
  if (currentToken && Date.now() - currentTokenTime < MEMORY_TOKEN_TTL_MS) return currentToken
  const disk = loadGatewayTokenFromDisk()
  if (disk) {
    setGatewayToken(disk)
    return disk
  }
  return currentToken
}

// ---------- 2026-08-28 设备认证配对（floria 设备授权，用户定案：完全删除 token 授权链） ----------
// 浏览器侧不再有任何 token 授权：设备访问若未授权 → 前端门显示「设备请求码」（localStorage 持久，
// 同一设备恒定）；用户在 PC `/server auth add <请求码>` 手动授权（不可自动化）→ 设备端
// GET /gateway/activate?code=<码>（网关校验该码在授权名单 → 种 HttpOnly floria_auth cookie，票证=码
// 本身）→ 永久通过统一地址 floria.home 连接。票证落盘 `.claude/gateway-tickets`（{id,created} 数组，
// 存量 string 兼容），/server off 清盘全设备掉线。CLI 内部链路的 gateway-token（上报/WS/关闭）
// 与浏览器认证无关，保留不动。
const ticketsFilePath = () => join(getPortableRoot(), '.claude', 'gateway-tickets')
let tickets: GatewayTicket[] = []
let ticketsLoaded = false
let ticketsLoadedAt = 0
// 2026-08-28 修复「auth add 后设备一直未授权」：票证读盘一次性缓存改 TTL 刷新（照 gateway-token
// 2026-08-22 同构先例）。根因=CLI 命令进程（/server auth add）与独立网关进程是两个进程，网关启动后
// 首次校验读盘拿到空名单即永久缓存，之后 CLI 写盘的新票证网关永不重读 → /gateway/activate 永远 403。
const TICKETS_TTL_MS = 3000

interface GatewayTicket {
  id: string
  created: number
}

function ensureTicketsLoaded(): void {
  const now = Date.now()
  if (ticketsLoaded && now - ticketsLoadedAt < TICKETS_TTL_MS) return
  ticketsLoaded = true
  ticketsLoadedAt = now
  try {
    const p = ticketsFilePath()
    if (existsSync(p)) {
      // 存量格式 string[]（首版无 created）→ 归一化 created=0
      const raw: unknown = JSON.parse(readFileSync(p, 'utf8'))
      tickets = (Array.isArray(raw) ? raw : [])
        .map((x) => (typeof x === 'string' ? { id: x, created: 0 } : (x as GatewayTicket)))
        .filter((t) => t && typeof t.id === 'string')
    }
  } catch {
    tickets = []
  }
}

function persistTickets(): void {
  try {
    const p = ticketsFilePath()
    mkdirSync(join(p, '..'), { recursive: true })
    writeFileSync(p, JSON.stringify(tickets), 'utf8')
  } catch {
    /* 忽略 */
  }
}

/** cookie 票证校验（网关 isProtected 与 WS 升级共用）。授权永久，撤销只经 /server auth off。 */
export function isGatewayTicket(t: string): boolean {
  if (!t) return false
  ensureTicketsLoaded()
  return tickets.some((x) => x.id === t)
}

/** 手动授权设备（/server auth add <请求码>）：把码加入授权名单并落盘。上限 64 个防无限增长。 */
export function addGatewayTicket(t: string): void {
  if (!t) return
  ensureTicketsLoaded()
  if (tickets.some((x) => x.id === t)) return
  tickets.push({ id: t, created: Date.now() })
  if (tickets.length > 64) tickets = tickets.slice(-64)
  persistTickets()
}

/** 撤销设备授权（/server auth off <n>）。返回是否找到。 */
export function removeGatewayTicket(t: string): boolean {
  ensureTicketsLoaded()
  const next = tickets.filter((x) => x.id !== t)
  if (next.length === tickets.length) return false
  tickets = next
  persistTickets()
  return true
}

/** 设备票证列表（/server auth 展示用，返回副本，合并设备情况）。 */
export function listGatewayTickets(): (GatewayTicket & DeviceInfo)[] {
  ensureTicketsLoaded()
  ensureDevicesLoaded()
  return tickets.map((t) => ({ ...t, ...(devices[t.id] ?? {}) }))
}

// ---------- 2026-09-01 设备情况（独立文件 gateway-devices，跨进程竞态根修） ----------
// 首版把 ua/lastIp/lastSeen 塞进 gateway-tickets：网关进程 touch 写盘后，常驻 CLI 进程
// （add/off）用自己 3s TTL 过期的内存副本整体覆盖写回，把设备情况抹掉——用户实测见到
// 「Windows · Chrome」一瞬即逝、落盘又回退成裸 {id,created}。根修=读写路径分离：
// 授权名单（gateway-tickets，CLI 写）与设备情况（gateway-devices，仅网关进程写）各存各的，
// 展示时按 id 合并。devices 文件两进程都读（TTL 3s 刷新），只有网关进程写（内存副本权威）。
interface DeviceInfo {
  ua?: string // 最近一次见到的 User-Agent 原文（截断 200；展示层渲染成「iPad · Safari」摘要）
  hint?: string // 设备自报类型（2026-09-05：iPadOS Safari 桌面模式 UA 与 macOS 全同，iPad 判定只能前端上报；展示层 hint 优先于 UA）
  lastIp?: string // 最近一次活跃的来源 IPv4
  lastSeen?: number // 最近一次活跃时间戳
}

const devicesFilePath = () => join(getPortableRoot(), '.claude', 'gateway-devices')
const DEVICES_TTL_MS = 3000
let devices: Record<string, DeviceInfo> = {}
let devicesLoaded = false
let devicesLoadedAt = 0

function ensureDevicesLoaded(): void {
  const now = Date.now()
  if (devicesLoaded && now - devicesLoadedAt < DEVICES_TTL_MS) return
  devicesLoaded = true
  devicesLoadedAt = now
  try {
    const p = devicesFilePath()
    if (existsSync(p)) {
      const raw: unknown = JSON.parse(readFileSync(p, 'utf8'))
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) devices = raw as Record<string, DeviceInfo>
    }
  } catch {
    if (!devicesLoaded || Object.keys(devices).length === 0) devices = {}
  }
}

const TOUCH_PERSIST_MS = 60_000
const touchPersistAt = new Map<string, number>()

/** 设备活跃回写（仅网关进程调用：受保护 HTTP 请求 + WS 升级 + activate 配对）。写盘节流 60s/票。 */
export function touchGatewayTicket(id: string, ua?: string, ip?: string, hint?: string): void {
  if (!id) return
  ensureDevicesLoaded()
  const d = devices[id] ?? (devices[id] = {})
  const now = Date.now()
  d.lastSeen = now
  if (ua) d.ua = ua.slice(0, 200)
  if (hint) d.hint = hint
  if (ip) d.lastIp = ip
  if (now - (touchPersistAt.get(id) ?? 0) > TOUCH_PERSIST_MS) {
    touchPersistAt.set(id, now)
    try {
      const p = devicesFilePath()
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(p, JSON.stringify(devices), 'utf8')
    } catch {
      /* 忽略 */
    }
  }
}
