/**
 * /server 指令实现（内置私有化网关开关）。
 * 2026-08-17 网关独立化：网关以「同一 exe 的 --gateway 模式」作为独立进程运行（/server on
 * detached spawn 自身 exe），父 CLI 退出不影响网关；任何 CLI 进程均可连接共用（token 落盘
 * 便携根 .claude/gateway-token，各进程读盘共享）。
 *  on      → spawn 独立网关进程（--gateway，detached + unref），绑定 HOST，等待端口就绪并回显统一地址
 *            （2026-08-28 设备认证配对：浏览器侧完全删除 token 授权链，授权只走 /server auth 手动配对）
 *  off     → POST /gateway/shutdown 优雅关闭独立网关；兜底 netstat + taskkill 清理端口残留
 *  status  → 端口探测网关状态
 *  restart → 先 off 等端口释放再 on（网关未运行则直接 on）
 *  auth    → 设备认证（手动，不可自动化）：auth 列出已授权设备；auth add <请求码> 手动授权新设备
 *            （设备门显示请求码 → add 后设备端 /gateway/activate 自动激活，永久通过 floria.home 连接）；
 *            auth off <n> 撤销第 n 台设备
 * 空闲回收：网关三集合全空持续 GATEWAY_IDLE_MINUTES(默认10) 分钟自动关闭（见 localGateway.ts）
 * 环境变量：GATEWAY_PORT(默认8124)、GATEWAY_HOST(默认0.0.0.0=局域网)、SERVER_TOKEN(指定 token，默认随机)、GATEWAY_IDLE_MINUTES(空闲回收阈值分钟)
 */
import { spawnSync, spawn } from 'child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, openSync, closeSync, statSync, truncateSync } from 'node:fs'
import { join } from 'node:path'
import type { LocalCommandCall } from '../../types/command.js'
import {
  loadGatewayTokenFromDisk,
  listGatewayTickets,
  addGatewayTicket,
  removeGatewayTicket,
} from '../../utils/gatewayToken.js'
import { getPortableRoot } from '../../utils/envUtils.js'

const PORT = Number(process.env.GATEWAY_PORT || 8124)

async function isGatewayUp(port: number = PORT): Promise<boolean> {
  try {
    // 必须带超时：若端口被幽灵进程占用（TCP 可连但 HTTP 永不回），无超时的 fetch 会让 /server status|on 永久卡死
    const res = await fetch(`http://127.0.0.1:${port}/gateway/health`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return false
    const d = (await res.json()) as { mode?: string }
    return d.mode === 'gateway'
  } catch {
    return false
  }
}

function listeningPids(port: number = PORT): string[] {
  try {
    // 2026-08-20 黑框根治第2轮：execFileSync 的 windowsHide 在 bun 运行时无效（/server off 仍弹窗），
    // 改 spawnSync（与已验证生效的 spawn 同一实现），netstat 读 stdout
    const res = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true })
    const out = res.stdout ?? ''
    const pids: string[] = []
    for (const line of out.split('\n')) {
      const t = line.trim()
      if (!t.includes(`:${port}`) || !t.includes('LISTENING')) continue
      const cols = t.split(/\s+/)
      const pid = cols[cols.length - 1]
      if (pid && /^\d+$/.test(pid) && !pids.includes(pid)) pids.push(pid)
    }
    return pids
  } catch {
    return []
  }
}

// 2026-08-29 定案（用户）：全设备唯一地址 floria.local（仅考虑 Apple/Windows，原生 mDNS 解析
// .local；本机 hosts 127.0.0.1 floria.local 同名直达），不再输出 IP 直连行。IP 变动自愈不变：
// 设备请求码存 localStorage 恒定，授权名单按码匹配，新 IP 下轮询 activate 自动重种 cookie。
function describeDefaultUrl(port: number = PORT): string {
  return `统一地址（同 WiFi/热点免配置）: http://floria.local:${port}/\n设备授权: /server auth（add <请求码> / off <n>）`
}

// /server auth —— 设备认证（手动配对，不可自动化）：
//   auth            → 列出已授权设备（设备摘要 + 授权时间 + 最后活跃时间/IP；网关侧带票证请求时回写）
//   auth add <码>   → 把设备门显示的请求码加入授权名单（设备端轮询 /gateway/activate 自动激活）
//   auth off <n>    → 撤销第 n 台已授权设备（其 cookie 立即失效）
function deviceSummary(ua?: string, hint?: string): string {
  const u = ua ?? ''
  if (!u && !hint) return '未知设备（待设备访问后记录）'
  // hint = 设备自报类型（前端 deviceHint 上报）：iPadOS Safari 桌面模式 UA 与 macOS 全同，UA 侧无解，hint 优先
  const os = hint
    ? hint
    : /iPad/.test(u)
      ? 'iPad'
      : /iPhone/.test(u)
        ? 'iPhone'
        : /Android/.test(u)
          ? 'Android'
          : /Windows/.test(u)
            ? 'Windows'
            : /Macintosh/.test(u)
              ? 'Mac'
              : '其它'
  const br = /Edg(iOS|A)?\//.test(u)
    ? 'Edge'
    : /OPR\//.test(u)
      ? 'Opera'
      : /Firefox\//.test(u)
        ? 'Firefox'
        : /CriOS\//.test(u) || /Chrome\//.test(u)
          ? 'Chrome'
          : 'Safari'
  return `${os} · ${br}`
}

async function doAuth(rest: string[]): Promise<string> {
  const sub = (rest[0] || '').toLowerCase()
  if (!sub || sub === 'list') {
    const list = listGatewayTickets()
    if (!list.length) return `暂无已授权设备。新设备授权：设备打开 ${`http://floria.local:${PORT}/`} 显示请求码 → /server auth add <请求码>`
    const lines = list.map((t, i) =>
      `${i + 1}. ${t.id.slice(0, 8)}…  ${[deviceSummary(t.ua, t.hint), t.lastIp ? `IP ${t.lastIp}` : null].filter(Boolean).join(' · ')}`
    )
    return `已授权设备 ${list.length} 台：\n${lines.join('\n')}\n撤销: /server auth off <n>`
  }
  if (sub === 'add') {
    const code = (rest[1] || '').trim()
    if (!/^[a-zA-Z0-9-]{6,64}$/.test(code)) {
      return `用法: /server auth add <请求码>（设备门上显示的 8 位码）`
    }
    const id = code.replace(/-/g, '').toLowerCase()
    addGatewayTicket(id)
    return `已授权设备（请求码 ${id.slice(0, 8)}）。设备将在数秒内自动进入（或刷新页面）。`
  }
  if (sub === 'off') {
    const n = Number.parseInt(rest[1] || '', 10)
    const list = listGatewayTickets()
    if (!Number.isInteger(n) || n < 1 || n > list.length) return `用法: /server auth off <n>（n 为 /server auth 列表中的编号）`
    const target = list[n - 1]
    removeGatewayTicket(target.id)
    return `已撤销设备 ${target.id.slice(0, 8)}… 的授权（其访问将回到请求码门）`
  }
  return `未知参数 "${sub}"。用法: /server auth [add <请求码> | off <n>]`
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ============================================================================
// 网关进程日志落盘 + spawn 共用（2026-08-28）
// 此前 /server on spawn 独立网关用 stdio:'ignore'，网关 crash（如系统 commit 内存
// 耗尽连锁崩溃）无任何痕迹可查——2026-08-28 遥测端断连事故的最大取证盲区。
// 照 backend-<label>.log 先例：stdout/stderr 落盘便携根 .claude/gateway.log，5MB 截断轮转。
// ============================================================================
const GATEWAY_LOG_MAX_BYTES = 5 * 1024 * 1024
function gatewayLogPath(): string {
  return join(getPortableRoot(), '.claude', 'gateway.log')
}

function openGatewayLogFd(): number | null {
  const p = gatewayLogPath()
  try {
    if (existsSync(p) && statSync(p).size > GATEWAY_LOG_MAX_BYTES) truncateSync(p, 0)
  } catch {
    /* 忽略 */
  }
  try {
    return openSync(p, 'a')
  } catch {
    return null
  }
}

// spawn 独立网关进程（--gateway 模式，detached + unref）。/server on 与 CLI 自动拉起共用。
// token/端口经环境变量传给子进程；日志 fd 子进程持有独立句柄，父进程 spawn 后即关。
function spawnGatewayProcess(token: string, port: number): number | undefined {
  const logFd = openGatewayLogFd()
  const child = spawn(process.execPath, ['--gateway'], {
    detached: true,
    stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
    windowsHide: true, // exe 是 console 子系统，不加会弹命令行窗口（2026-08-20 黑框根因修复）
    env: {
      ...process.env,
      GATEWAY_PORT: String(port),
      GATEWAY_HOST: '0.0.0.0',
      SERVER_TOKEN: token,
    },
  })
  child.unref()
  if (logFd !== null) {
    try {
      closeSync(logFd)
    } catch {
      /* 忽略 */
    }
  }
  return child.pid
}

// CLI 自动拉起（网关缺失自愈）：gatewayClient 探测网关不在时调用。
// 与 doOn 的差异：绝不做 taskkill 端口清理（自动路径禁杀进程，红线），端口被非网关
// 占用时静默放弃留给用户手动 /server on；spawn 后不等待就绪（gatewayClient 周期探测自然接续）。
let lastAutoStartAt = 0
export async function ensureGatewayAutoStart(): Promise<boolean> {
  if (Date.now() - lastAutoStartAt < 60_000) return false // 节流：60s 内不重复尝试
  lastAutoStartAt = Date.now()
  if (await isGatewayUp()) return false
  if (listeningPids(PORT).length) return false
  const token = loadGatewayTokenFromDisk() || randomBytes(16).toString('hex')
  return spawnGatewayProcess(token, PORT) !== undefined
}

// 探测实际网关端口：默认 PORT，可能因端口占用被自动顺延换端口
async function findGatewayPort(): Promise<number | null> {
  for (let p = PORT; p < PORT + 6; p++) {
    if (await isGatewayUp(p)) return p
  }
  return null
}

async function doStatus(): Promise<string> {
  const gwPort = await findGatewayPort()
  if (gwPort !== null) {
    return `内置网关运行中（独立进程） · ${describeDefaultUrl(gwPort)}`
  }
  const pids = listeningPids(PORT)
  if (pids.length) {
    return `端口 ${PORT} 被进程 ${pids.join(', ')} 占用，但 /gateway/health 非网关（可能是其它程序）`
  }
  return `内置网关未运行（端口 ${PORT} 空闲）`
}

async function doOn(tokenOverride?: string): Promise<string> {
  if (await isGatewayUp()) {
    return `内置网关已在运行（独立进程）\n${describeDefaultUrl(PORT)}\n停止: /server off`
  }
  // 端口被占用时自动清理：能杀则 taskkill 释放；杀不掉（幽灵 socket 残留，进程表查不到）则自动顺延换端口，
  // 保证每次 /server on 都能把网关起起来，不再卡在「端口被占用」手动处理上
  let target = PORT
  const notes: string[] = []
  for (let attempt = 0; attempt < 6; attempt++) {
    const pids = listeningPids(target)
    if (!pids.length) break
    if (await isGatewayUp(target)) {
      return `端口 ${target} 已有网关进程 (PID ${pids.join(', ')})`
    }
    const killed: string[] = []
    const failed: string[] = []
    for (const pid of pids) {
      try {
        spawnSync('taskkill', ['/F', '/PID', pid], { stdio: 'ignore', windowsHide: true })
        killed.push(pid)
      } catch {
        failed.push(pid)
      }
    }
    await sleep(400)
    if (!listeningPids(target).length) {
      if (killed.length) notes.push(`已自动清理端口 ${target} 占用进程 (PID ${killed.join(', ')})`)
      break
    }
    notes.push(
      `端口 ${target} 被占用且自动清理失败${failed.length ? ` (PID ${failed.join(', ')} 无法终止，疑内核 socket 残留)` : ''}，已改用端口 ${target + 1}`
    )
    target++
  }
  // 2026-08-17 独立化：detached spawn 自身 exe（--gateway 模式），父 CLI 退出不影响网关。
  // token 显式传入子进程（restart 继承旧 token，否则用户设了 SERVER_TOKEN 则沿用，最后随机），网关启动时写盘共享。
  // 2026-08-28 改走 spawnGatewayProcess 共用函数：stdout/stderr 落盘 gateway.log（crash 可取证）。
  const token = tokenOverride || process.env.SERVER_TOKEN || randomBytes(16).toString('hex')
  const childPid = spawnGatewayProcess(token, target)
  // 等待端口就绪（最多 ~6s）
  let up = false
  for (let i = 0; i < 30; i++) {
    await sleep(200)
    if (await isGatewayUp(target)) {
      up = true
      break
    }
  }
  if (!up) {
    return `网关进程已 spawn (PID ${childPid})，但端口 ${target} 未就绪，稍后用 /server status 查看（日志: ${gatewayLogPath()}）${notes.length ? `\n${notes.join('\n')}` : ''}`
  }
  const note = notes.length ? `\n${notes.join('\n')}` : ''
  const idleMin = Number(process.env.GATEWAY_IDLE_MINUTES || 10)
  return `内置网关已启动（独立进程，PID ${childPid}）${note}\n${describeDefaultUrl(target)}\n停止: /server off\n空闲 ${idleMin} 分钟无连接将自动关闭`
}

async function doOff(): Promise<string> {
  let out = ''
  // 探测实际网关端口（可能被自动换端口），否则 shutdown/taskkill 会打错端口
  const gwPort = await findGatewayPort()
  // 优雅关闭独立网关：POST /gateway/shutdown（带 token，受网关 token 校验保护）
  const token = loadGatewayTokenFromDisk()
  if (token && gwPort !== null) {
    try {
      await fetch(`http://127.0.0.1:${gwPort}/gateway/shutdown?token=${encodeURIComponent(token)}`, {
        method: 'POST',
        signal: AbortSignal.timeout(1500),
      })
      await sleep(300)
      out = `已发送网关关闭指令（端口 ${gwPort}）`
    } catch {
      /* 网络异常则走 taskkill 兜底 */
    }
  }
  // 兜底：清理端口上残留的占用进程
  const pids = listeningPids(gwPort ?? PORT)
  if (pids.length) {
    const killed: string[] = []
    for (const pid of pids) {
      try {
        spawnSync('taskkill', ['/F', '/PID', pid], { stdio: 'ignore', windowsHide: true })
        killed.push(pid)
      } catch {
        /* 忽略单个失败 */
      }
    }
    if (killed.length) out += (out ? '\n' : '') + `已清理端口占用进程 (PID ${killed.join(', ')})`
  }
  if (out) return out
  return (await isGatewayUp(gwPort ?? PORT)) ? '网关未停止（关闭失败，可再试 /server off）' : '网关未运行'
}

async function doRestart(): Promise<string> {
  const wasUp = (await findGatewayPort()) !== null
  // 先读盘继承旧 token（网关停止时会清盘，必须关前捕获），restart 后访问 URL 不变
  const prevToken = loadGatewayTokenFromDisk()
  const parts: string[] = []
  if (wasUp) {
    const offMsg = await doOff()
    // doOff 有真实动作才记入，否则说明网关已不在运行
    if (!offMsg.includes('网关未运行')) parts.push(offMsg)
    // 等端口释放（最多 ~3s），避免立刻重起时端口仍被占用触发自动换端口
    for (let i = 0; i < 15; i++) {
      if ((await findGatewayPort()) === null) break
      await sleep(200)
    }
  }
  const onMsg = await doOn(prevToken || undefined)
  parts.push(onMsg)
  return parts.join('\n')
}

export const call: LocalCommandCall = async (args) => {
  const parts = args.trim().split(/\s+/).filter(Boolean)
  const cmd = (parts[0] || 'status').toLowerCase()
  let value: string
  if (cmd === 'on') value = await doOn(parts[1])
  else if (cmd === 'off') value = await doOff()
  else if (cmd === 'status') value = await doStatus()
  else if (cmd === 'restart') value = await doRestart()
  else if (cmd === 'auth') value = await doAuth(parts.slice(1))
  else value = `未知参数 "${cmd}"。用法: /server on | off | status | restart | auth [add <请求码> | off <n>]`
  return { type: 'text', value }
}
