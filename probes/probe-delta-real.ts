/**
 * probe-delta-real.ts —— 2026-09-10 长会话 delta 断流复现探针（真转录驱动）
 *
 * 实证背景：exe 20260910202425 的会话 6ea48794（resume 于 20:42:43）在 20:47 前后
 * delta 彻底停发——网关 /gateway/session 报 deltaSeq=119 冻结，而 jsonl 持续增长
 * （n 1148→1152，含新 Bash tool_use），SSE 上再无 session-delta 帧（其余两会话正常）。
 *
 * 本探针用真转录逐条推进，复刻 REPL 的双写者回路（buildDisplayDelta 即发 +
 * exportConversationToServer 全量 POST 基线），打印每步的对齐量（base0 / k / |W| / |sent|）
 * 与首条 null 的确切原因，定位「永久断流」的触发条件。
 *
 * 2026-09-10 二轮（--gateway-drop / --collapse=N）：把真网关的两条判定搬进来——
 *  ① seq 水位门（localGateway.ts:3461 `seq <= last → 丢弃`）；
 *  ② 压缩塌缩（REPL `setMessages(() => [boundary])` → display 为空 → exportConversation
 *     走全量路径 `set(cacheKey, {sent, lastModel})` 重建缓存 · **丢掉 seq**（conversationDisplay.ts:659）。
 * 断言：塌缩后 CLI 侧 seq 归 1 < 网关水位 → 每条 delta 被静默丢弃，直到 seq 重新爬过水位。
 *
 * 离线：FLOIRA_GATEWAY 指向本地假网关（只回 {ok,cached}），不触真网关。
 */
import { readFileSync } from 'node:fs'

const PORT = 18124
let posts: { base?: number; n: number }[] = []
const server = Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch: async (req) => {
    if (req.method !== 'POST') return new Response('{}', { headers: { 'content-type': 'application/json' } })
    const body = (await req.json()) as { base?: number; messages?: unknown[] }
    const n = Array.isArray(body.messages) ? body.messages.length : 0
    posts.push({ base: body.base, n })
    return new Response(JSON.stringify({ ok: true, cached: (body.base ?? 0) + n }), { headers: { 'content-type': 'application/json' } })
  },
})

process.env.FLOIRA_GATEWAY = `http://127.0.0.1:${PORT}`

const { filterConversationForDisplay, buildDisplayDelta, exportConversationToServer } = await import('../src/utils/conversationDisplay.ts')
const { capRenderedMessages, MAX_RENDER_MESSAGES } = await import('../src/utils/renderCap.ts')
type SliceAnchorRef = { current: { uuid: string; idx: number } | null }

const SID = 'probe-real'
const MODE = 'prompt-tail-think' as const

function loadRecords(p: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      const r = JSON.parse(s) as Record<string, unknown>
      const t = r.type
      if (typeof t === 'string' && ['user', 'assistant', 'system', 'attachment', 'progress'].includes(t)) out.push(r)
    } catch {}
  }
  return out
}

type DisplayMessage = { role: string; blocks: { kind: string; text?: string }[]; timestamp?: unknown; sid?: string; uuid?: string }

const args = process.argv.slice(2)
const file = args[0]!
const tail = Number(args[1] ?? 40)
// --step=N 每次 commit 推进 N 条记录（模拟一次 React commit 合并多条落盘记录）
// --dup=N  同一记录集合重复 commit N 次（模拟无新记录的 block 级更新）
const opt = (k: string, d: number): number => {
  const hit = args.find((a) => a.startsWith(`--${k}=`))
  return hit ? Number(hit.split('=')[1]) : d
}
const step = opt('step', 1)
const dup = opt('dup', 1)
const collapseAt = opt('collapse', 0) // 在该 i 处插入一次压缩塌缩 commit（state = 单条 boundary → 投影为空）
const quiet = args.includes('-q')
const records = loadRecords(file)

// ---- 真网关的两条判定（离线复刻）----
// ① seq 水位门：localGateway.ts sessionDeltaSeq[sid]，`seq <= last → return`（静默丢弃）。
// ② cli-hello 才重置水位；压缩塌缩只重建 CLI 侧缓存（丢掉 seq），水位不动。
// --watermark=N：预设水位 = 模拟「网关进程已为该会话接受过 N 帧」（长会话实况 148 量级），
// 塌缩后 CLI 侧 seq 从 1 重爬，必须爬过 N 才会重新出现在 web 上。
let gwSeq = opt('watermark', 0)
let emitted = 0
let accepted = 0
let dropped = 0
let firstDropAt = -1
let lastDropAt = -1
/** web 侧增量镜像（只记 delta 通道的应用结果；磁盘对账通道另行说明） */
const webMirror: DisplayMessage[] = []

/** 真网关帧门（localGateway.ts:3453-3473）＋ web 增量为同一入口 */
const trace: number[] = []
let firstRecoverAt = -1
let emittedAtCollapse = -1
let gwAtCollapse = -1
const emit = (d: { seq: number; anchorSid: string; messages: DisplayMessage[] } | null, at: number): void => {
  if (!d) return
  emitted++
  if (collapseAt && at >= collapseAt && trace.length < 8) trace.push(d.seq)
  if (d.seq <= gwSeq) {
    // localGateway.ts:3461-3462 —— `seq <= last` 静默丢弃（无 SSE、无日志、无回执）
    dropped++
    if (firstDropAt < 0) firstDropAt = at
    lastDropAt = at
    return
  }
  accepted++
  gwSeq = d.seq
  if (collapseAt && at >= collapseAt && firstRecoverAt < 0) firstRecoverAt = at
  // web 侧应用：定位锚点后整体替换（gateway/web-src/core/live.js session-delta 分支同语义）
  const idx = webMirror.findIndex((m) => m.sid && m.sid === d.anchorSid)
  if (idx >= 0) webMirror.splice(idx + 1, webMirror.length, ...d.messages)
  else webMirror.splice(0, webMirror.length, ...d.messages)
}

// 全量投影（含全部记录）——用于比对真源长度
const full = filterConversationForDisplay(records as never, MODE) as unknown as DisplayMessage[]
console.log(`转录=${file}`)
console.log(`原始记录=${records.length} 全量投影=${full.length}（cap=${MAX_RENDER_MESSAGES}）`)

// ---- 基准：真源全量投影（供对齐诊断） ----
const shadow: DisplayMessage[] = []
let shadowSeq = 0
let frozen = false
let firstNullStep = -1

const start = Math.max(0, records.length - tail)
let nullStreak = 0
// 窗口边界锚点：与 REPL 的 renderCapAnchorRef 同构（跨轮存活 —— 窗口只在超过 cap+step
// 时前进一次，追加不动顶行；2026-09-24 跳顶根修）。
const anchorRef: SliceAnchorRef = { current: null }
for (let i = start; i <= records.length; i += step) {
  // ---- 压缩塌缩注入（--collapse=N）：REACTIVE_COMPACT 边界 setMessages(() => [boundary]) 的同构事件 ----
  // state 收缩为单条 compact_boundary（投影层 line 338 跳过 system/非 local_command）→ 投影为空 →
  // exportConversationToServer 落全量路径 displayCacheBySession.set(cacheKey, {sent, lastModel})
  // （conversationDisplay.ts:659，**不含 seq**）→ CLI 侧 seq 回落，而网关水位只由 cli-hello 重置。
  if (i === collapseAt) {
    gwAtCollapse = gwSeq
    emittedAtCollapse = emitted
    const boundary = {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: 'c0ffee00-0000-4000-8000-000000000000',
      timestamp: 1000 + i * 10,
      content: 'compact_boundary',
    }
    const cstate = capRenderedMessages([boundary], anchorRef) as never
    emit(
      buildDisplayDelta(cstate, SID, MODE) as unknown as { seq: number; anchorSid: string; messages: DisplayMessage[] } | null,
      i,
    )
    await exportConversationToServer(cstate, SID, MODE)
    console.log(`i=${i} ★注入压缩塌缩：state=1 条 boundary → 投影=空 → 全量重建缓存（seq 回落；水位 gwSeq=${gwSeq} 不动）`)
  }
  for (let rep = 0; rep < dup; rep++) {
    const state = capRenderedMessages(records.slice(0, i), anchorRef) as unknown as { type?: string }[]
    // 与 REPL 同序：delta 即发（同步）→ 全量 POST（600ms 防抖处，此处直接调用）
    const d = buildDisplayDelta(state as never, SID, MODE) as unknown as { seq: number; anchorSid: string; messages: DisplayMessage[] } | null
    emit(d, i)

    // ---- shadow 复刻（读诊断量）：与真实 cache.sent 同规则演进 ----
    const W = filterConversationForDisplay(state as never, MODE) as unknown as DisplayMessage[]
    const base0 = W.length ? shadow.findIndex((m) => m.sid && m.sid === W[0]!.sid) : -1
    let k = base0
    while (base0 >= 0 && k < shadow.length && k - base0 < W.length) {
      const a = JSON.stringify(shadow[k], (kk, vv) => (kk === 'uuid' ? undefined : vv))
      const b = JSON.stringify(W[k - base0], (kk, vv) => (kk === 'uuid' ? undefined : vv))
      if (a !== b) break
      k++
    }
    let reason = '—'
    if (!shadow.length) reason = '(基线建立)'
    else if (base0 < 0) reason = 'head-miss(base0=-1)'
    else if (base0 + W.length < shadow.length) reason = `window-short(${base0}+${W.length}<${shadow.length})`
    else if (k - base0 >= W.length) reason = 'nochange'
    else if (!(k > 0 && shadow[k - 1]!.sid)) reason = 'noanchor'
    if (!d) {
      if (firstNullStep < 0 && shadow.length) firstNullStep = i
      nullStreak++
      frozen = true
    } else {
      frozen = false
      nullStreak = 0
    }

    const stamp = i === start || ((!d || k - base0 >= W.length) && !quiet) || args.includes('-v')
    if (stamp) {
      console.log(
        `i=${String(i).padStart(5)} step=${step} dup=${dup} |W|=${String(W.length).padStart(3)} |sent|=${String(shadow.length).padStart(4)} ` +
          `base0=${String(base0).padStart(4)} k=${String(k).padStart(4)} delta=${d ? `seq${d.seq} n=${d.messages.length}` : 'NULL'} ${d ? '' : '<<< ' + reason}`,
      )
    }

    // shadow 演进 = 真函数的两条写者路径
    if (d) {
      const idx = shadow.findIndex((m) => m.sid && m.sid === d.anchorSid)
      if (idx >= 0) shadow.splice(idx + 1, shadow.length, ...d.messages)
      else shadow.splice(0, shadow.length, ...d.messages)
      shadowSeq = d.seq
    }
    await exportConversationToServer(state as never, SID, MODE)
    // POST 路径同规则演进 shadow（基线与真 cache 同步）
    const bP = W.length ? shadow.findIndex((m) => m.sid && m.sid === W[0]!.sid) : -1
    if (bP >= 0 && bP + W.length >= shadow.length) {
      const merged = bP === 0 ? W : [...shadow.slice(0, bP), ...W]
      shadow.splice(0, shadow.length, ...merged)
    } else {
      shadow.splice(0, shadow.length, ...W)
    }
  }
}

console.log(`\n假网关收到 POST ${posts.length} 次；shadow.seq=${shadowSeq} shadow.length=${shadow.length}`)
console.log(firstNullStep >= 0 ? `首次 delta=NULL @ i=${firstNullStep}；末步状态 frozen=${frozen}` : '全程无 NULL（未复现断流）')
console.log(
  `\n【delta 通道】发出 ${emitted} 帧 → 网关接受 ${accepted} / 静默丢弃 ${dropped}；末水位 gwSeq=${gwSeq}；web 增量镜像 |webMirror|=${webMirror.length}`,
)
if (firstDropAt >= 0) console.log(`首丢 i=${firstDropAt}；末丢 i=${lastDropAt}`)
// 空投影上报计数（期望 0）：塌缩瞬态若落全量路径会向网关 POST 空会话并清空本地基线
console.log(`POST 中投影为空的次数 = ${posts.filter((p) => p.n === 0).length}（期望 0）`)
if (collapseAt) {
  console.log(`塌缩 i=${collapseAt}（当时水位 gwSeq=${gwAtCollapse}，此前共发出 ${emittedAtCollapse} 帧）→ 后续 seq 轨迹 = ${trace.join(', ')}`)
  if (dropped === 0) console.log('★塌缩后零丢弃：seq 未回退（进程级账本生效，水位门不再吞帧）')
  else if (firstRecoverAt >= 0)
    console.log(`★恢复：塌缩后第 ${firstRecoverAt - collapseAt} 次 commit（其间 ${dropped} 帧被静默丢弃，= 塌缩时水位 ${gwAtCollapse}）才爬过水位重新被接受`)
  else console.log('★塌缩后再未被接受（seq 始终未爬过水位）——web 实时通道永久静默')
} else {
  console.log('未注入塌缩：加 --collapse=<i> 可复现「seq 回落 → 水位门静默丢弃」')
}
server.stop(true)
