/**
 * probe-render-cap-layering.ts —— 2026-09-22 P1 层次归位（B 案）+ P2 缓存有界化 的复验探针
 *
 * 三条不变量：
 *  A. renderCap：**logicalRenderedLength(投影) === 未 cap 时原始条数**（精确），投影 ≤ cap + step 条、
 *     至多一条占位且恒在下标 0、cap 幂等。这条保证「baseline 存于全量源坐标、比较发生在投影上」
 *     两侧同尺（发送回显 placeholder 的显隐判据）。
 *  B. P2 增量链：投影窗口滑动时上报 base 恒为**绝对**坐标（= cache.sentOffset + 窗口内偏移），
 *     桩网关按 base 聚合出的重建序列必须与「全量源直算投影」逐条相等（不截断、不重影）。
 *  C. 有界性：单轮 POST 载荷 ≤ 渲染窗口（200）+1；cache.sent 驻留 ≤ SENT_WINDOW，且
 *     sentOffset + sent = 绝对投影长度（尾部窗口 = 全量投影的后缀）。
 *
 * 桩网关复刻 localGateway.ts `/gateway/conversation`（base 合法 → prev.slice(0,base).concat(msgs)；
 * base 越界 → 全量替换；响应 cached = merged.length）。不触真网关、不写盘、不起会话。
 */
import { filterConversationForDisplay, exportConversationToServer, buildDisplayDelta, displayCacheStats } from '../src/utils/conversationDisplay.ts'
import { capRenderedMessages, logicalRenderedLength, isRenderArchivePlaceholder, MAX_RENDER_MESSAGES, RENDER_CAP_STEP, type SliceAnchorRef } from '../src/utils/renderCap.ts'

let failures = 0
const ok = (cond: boolean, label: string, extra = ''): void => {
  if (cond) console.log(`  PASS  ${label}${extra ? ` — ${extra}` : ''}`)
  else { failures++; console.log(`  FAIL  ${label}${extra ? ` — ${extra}` : ''}`) }
}

// ───────────────────────── A. renderCap 长度不变量 ─────────────────────────
// sid = uuid 前 24 位 + 同 parent 块序（conversationDisplay 稳定键）——索引必须落在前 24 位内，
// 否则同一 parent 的不同记录会撞成同一 sid，对齐失效（探针初版即栽在此，非产品缺陷）。
const uid = (p: string, i: number): string => `${p}${String(i).padStart(16, '0')}-0000-4000-8000-000000000000`
const userRec = (i: number): Record<string, unknown> => ({
  type: 'user', uuid: uid('b2c3d4e5', i), timestamp: 1000 + i * 10,
  message: { role: 'user', content: [{ type: 'text', text: `问题${i}` }] },
})
const asstRec = (i: number): Record<string, unknown> => ({
  type: 'assistant', uuid: uid('a1b2c3d4', i), timestamp: 1005 + i * 10,
  message: { role: 'assistant', model: 'glm-5.3-flash', stop_reason: 'end_turn', content: [{ type: 'text', text: `回复${i}` }] },
})
const source = (n: number): Record<string, unknown>[] => {
  const out: Record<string, unknown>[] = []
  for (let i = 0; i < n; i++) { out.push(userRec(i)); out.push(asstRec(i)) }
  return out.slice(0, n)
}

console.log('=== A. renderCap 长度不变量（逻辑长度 = 未 cap 原始条数）===')
for (const n of [0, 1, 199, 200, 201, 202, 400, 1000]) {
  const list = source(n)
  const anchorRef: SliceAnchorRef = { current: null }
  const capped = capRenderedMessages(list, anchorRef)
  const logical = logicalRenderedLength(capped)
  const placeholders = capped.filter(m => isRenderArchivePlaceholder(m as never)).length
  const headIsPlaceholder = isRenderArchivePlaceholder(capped[0] as never)
  const atMost = placeholders === 0 || (placeholders === 1 && headIsPlaceholder)
  // 上界 = cap + step（窗口只在超过 cap+step 时前进到恰好 cap 条；未进档期间可驻留 cap+step 条）
  ok(logical === n && capped.length <= MAX_RENDER_MESSAGES + RENDER_CAP_STEP && atMost,
    `n=${n}: 投影=${capped.length} 逻辑=${logical} 占位=${placeholders}`)
  // 幂等：再 cap 一次结构不变
  const again = capRenderedMessages(capped, anchorRef)
  ok(again.length === capped.length && logicalRenderedLength(again) === n, `n=${n}: cap 幂等`)
}
ok(logicalRenderedLength(source(300) as never) === 300, '全量源（无占位）逻辑长度 = .length')

// ───────────────────────── 桩网关 ─────────────────────────
type Rec = { base?: number; count: number; seq?: number }
const posts: Rec[] = []
let serverCache: unknown[] = []
const server = Bun.serve({
  port: 18243,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/gateway/conversation' && req.method === 'POST') {
      const body = (await req.json()) as { messages?: unknown[]; base?: number }
      const msgs = Array.isArray(body.messages) ? body.messages : []
      const base = typeof body.base === 'number' && Number.isInteger(body.base) && body.base >= 0 ? body.base : -1
      posts.push({ base, count: msgs.length })
      let merged: unknown[] = msgs
      if (base >= 0 && base <= serverCache.length) merged = serverCache.slice(0, base).concat(msgs)
      serverCache = merged
      return Response.json({ ok: true, cached: merged.length })
    }
    return Response.json({ error: 'not found' }, { status: 404 })
  },
})
process.env.FLOIRA_GATEWAY = 'http://127.0.0.1:18243'

// ───────────────────────── B/C. 长会话驱动 ─────────────────────────
const SID = 'probe-layering-0000-4000-8000-000000000001'
const MODE = 'prompt-tail-think' as const
const TURNS = 900

console.log(`\n=== B/C. ${TURNS} 轮追加（每轮 +1 条原始记录，投影窗口滑动）===`)
let payloadMax = 0
let cacheMax = 0
let baseViolations = 0
let deltaCount = 0

const full: Record<string, unknown>[] = []
const rec = (i: number): Record<string, unknown> => (i % 2 === 0 ? userRec(i / 2) : asstRec((i - 1) / 2))
// 锚点跨轮存活 = REPL 的 renderCapAnchorRef（本轮 900 次调用模拟同一会话的 900 次 setMessages）
const anchorRef: SliceAnchorRef = { current: null }

for (let t = 0; t < TURNS; t++) {
  full.push(rec(t))
  // REPL：state = cap(全量源)；导出链消费 state（P1×P2 契约不变）
  const projection = capRenderedMessages(full, anchorRef) as never[]
  await exportConversationToServer(projection, SID, MODE)
  buildDisplayDelta(projection, SID, MODE)

  const last = posts[posts.length - 1]!
  payloadMax = Math.max(payloadMax, last.count)
  const stats = displayCacheStats(SID, MODE)!
  cacheMax = Math.max(cacheMax, stats.sent)

  // 期望：绝对投影 = 全量源直算投影（同一份过滤，无窗口切片）
  const expected = filterConversationForDisplay(full as never, MODE)
  if (serverCache.length !== expected.length) baseViolations++
  // 视窗自洽：缓存窗口 + 绝对起点 = 全量投影长度（sent 恒为全量投影的后缀）
  const stats2 = displayCacheStats(SID, MODE)!
  if (stats2.sent + stats2.sentOffset !== expected.length) baseViolations++
  // base<0 = 无 base（全量路径：首轮 / 对齐未命中），不参与「base + 载荷 = 总长」自洽检查
  if (last.base! >= 0 && last.base! + last.count !== expected.length) baseViolations++
  if (t >= MAX_RENDER_MESSAGES) deltaCount += 1
}

const expectedFinal = filterConversationForDisplay(full as never, MODE)
const rebuilt = serverCache as { sid?: string }[]
const expectedSids = expectedFinal.map(m => m.sid)
const rebuiltSids = rebuilt.map((m: { sid?: string }) => m.sid)
ok(rebuiltSids.length === expectedSids.length && rebuiltSids.every((s, i) => s === expectedSids[i]),
  '桩网关按 base 聚合的重建序列 = 全量源直算投影（逐条 sid 相等）',
  `重建=${rebuilt.length} 期望=${expectedFinal.length}`)
ok(baseViolations === 0, '绝对 base 自洽（base+载荷 = 投影总长；sent+sentOffset = 投影总长）', `违例轮次=${baseViolations}`)
ok(payloadMax <= MAX_RENDER_MESSAGES + RENDER_CAP_STEP + 1, '单轮上报载荷 ≤ 渲染窗口+step+1（P2 峰值有界）', `最大=${payloadMax}`)
const stats = displayCacheStats(SID, MODE)!
ok(stats.sent <= 400 && stats.sentOffset > 0,
  '显示缓存已视窗化（sent ≤ SENT_WINDOW 且 sentOffset 递增）', `sent=${stats.sent} sentOffset=${stats.sentOffset}`)

server.stop(true)
console.log(`\n结果：${failures === 0 ? 'PASS' : `FAIL（${failures} 项）`}；POST ${posts.length} 次，delta 轮次=${deltaCount}`)
process.exit(failures === 0 ? 0 : 1)
