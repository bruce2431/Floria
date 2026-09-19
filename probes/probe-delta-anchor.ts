/**
 * probe-delta-anchor.ts —— 2026-09-10 长会话 delta 对齐根修验收探针
 *
 * 症状（实测）：长会话回合中 web 零实时更新（Bash 零提示、Edit 显「正在思考」），全部内容
 * 回合结束才出现。根因：REPL messages state 被 capRenderedMessages 裁成尾部 200 条
 * （utils/renderCap.ts:15），而 normalizeMessages 的 uuid 派生受 isNewChain 位置相关影响
 * （utils/messages.ts:748-756）→ CLI 窗口坐标与 web 全量投影坐标无法用 uuid 对齐 →
 * buildDisplayDelta 恒 null（旧探针 probe-delta-window.ts 实证 40/40 轮 null）。
 *
 * 本探针验收新协议（anchorSid + 其后整体替换）：
 *   A. 稳定键跨端一致性：同一条记录在「窗口投影」与「全量投影」中的 sid 必须相同（uuid 则相反）。
 *   B. 端到端：造 400 轮历史（800 条），逐轮追加真实回合（user→assistant(think+text+tool_use)
 *      →tool_result→assistant(end_turn)），每轮 cap 后调 exportConversationToServer + buildDisplayDelta，
 *      按 web 侧逻辑（live.js session-delta 分支）应用，断言「web 尾部 == CLI 全量投影尾部」。
 * FLOIRA_GATEWAY 指死端口：POST 失败但缓存仍建立（conversationDisplay.ts），纯离线可跑。
 */
process.env.FLOIRA_GATEWAY = 'http://127.0.0.1:9'

const { exportConversationToServer, buildDisplayDelta, filterConversationForDisplay } =
  await import('../src/utils/conversationDisplay.js')

const MODE = 'prompt-tail-think'
const CAP = 200
const WINDOW_GUARD = 512 // live.js 塌缩防护阈值，与本探针同源

type Src = Record<string, unknown>
// 真实转录的 uuid 恒为 36 字符（randomUUID / API message id）；deriveUUID 的不变量就是
// 「产物前 24 字符 = 源 uuid 前 24 字符」，sid 依赖该不变量 → 探针必须用 36 字符 uuid
// （4 字符假 uuid 下 bare `u300` 与 derived `u300000000000000` 的 24 前缀不同，纯属探针失真）。
const uid = (tag: string, i: number): string => `${tag}${String(i).padStart(6, '0')}${'-'.repeat(21)}${i % 10}`
const mkU = (i: number): Src => ({
  type: 'user', uuid: uid('a1b2c3d4', i), timestamp: 1000 + i * 10,
  message: { role: 'user', content: [{ type: 'text', text: `第${i}问` }] },
})
// 每条 jsonl 记录的 uuid 唯一（真实转录中由 randomUUID 生成）：tool_use 片段与 end_turn 片段
// 是两条独立记录 → 必须给不同 uuid（同 uuid 会让 sid 的「同 parent 内块序」计数撞号，纯属探针失真）。
const mkA = (i: number, stop: string): Src => ({
  type: 'assistant', uuid: uid(stop === 'end_turn' ? 'd4e5f6a7' : 'b2c3d4e5', i), timestamp: 1005 + i * 10,
  message: { role: 'assistant', model: 'glm-5.3-flash', stop_reason: stop, content: [
    ...(stop === 'end_turn' ? [{ type: 'thinking', thinking: `思考${i}` }] : []),
    { type: 'text', text: `回复${i}` },
    ...(stop === 'tool_use' ? [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: 'echo hi' } }] : []),
  ] },
})
const mkTR = (i: number): Src => ({
  type: 'user', uuid: uid('c3d4e5f6', i), timestamp: 1008 + i * 10,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: [{ type: 'text', text: 'ok' }] }] },
})

const full: Src[] = []
for (let i = 0; i < 400; i++) full.push(mkU(i), mkA(i, 'end_turn'))

// ---------- A. 稳定键跨端一致性 ----------
console.log('=== A. 稳定键跨端一致性（窗口投影 vs 全量投影） ===')
const winProj = filterConversationForDisplay(full.slice(-CAP), MODE)
const fullProj = filterConversationForDisplay(full, MODE)
// 全量投影中定位窗口投影首条（按 sid），逐条比对
const anchor0 = fullProj.findIndex((m) => m.sid === winProj[0]!.sid)
console.log(`窗口投影 ${winProj.length} 条 / 全量投影 ${fullProj.length} 条 / 窗口首条在全量中的位置 = ${anchor0}`)
let sidBad = 0, uuidBad = 0, uuidBare = 0
for (let i = 0; i < winProj.length && anchor0 + i < fullProj.length; i++) {
  const w = winProj[i]!, f = fullProj[anchor0 + i]!
  if (w.sid !== f.sid) { if (sidBad < 3) console.log(`  sid ✗ #${i}: win=${w.sid} full=${f.sid}`); sidBad++ }
  if (w.uuid !== f.uuid) {
    if (uuidBad < 3) console.log(`  uuid ✗ #${i}: win=${w.uuid} full=${f.uuid}`)
    uuidBad++
  }
  if (typeof w.uuid === 'string' && w.uuid.length <= 24) uuidBare++
}
console.log(`→ sid 不一致 ${sidBad} 条 / uuid 不一致 ${uuidBad} 条（其中窗口侧裸 uuid ${uuidBare} 条）`)
// 内容同构（剥 uuid）：窗口投影与全量投影重叠段必须逐条一致——delta「锚点后整体替换」的正确性
// 依赖于此（否则 web 未覆盖到的中段会长期停在旧内容）。比对键与 buildDisplayDelta 内 cmpKey 同构。
const ck = (m: unknown): string => JSON.stringify(m, (k, v) => (k === 'uuid' ? undefined : v))
let contentBad = 0
for (let i = 0; i < winProj.length && anchor0 + i < fullProj.length; i++) {
  if (ck(winProj[i]) !== ck(fullProj[anchor0 + i])) { if (contentBad < 2) console.log(`  内容 ✗ #${i}`); contentBad++ }
}
console.log(`→ 内容（剥 uuid）不一致 ${contentBad} 条`)
if (sidBad !== 0) { console.log('✗ 稳定键跨端不一致，协议前提不成立'); process.exit(1) }
console.log('✓ 稳定键跨端一致（uuid 因 isNewChain 位置相关派生而失配，正是旧协议恒 null 的根因）')

// ---------- B. 端到端：cap 窗口 + 逐轮追加 ----------
console.log('\n=== B. 端到端：cap 窗口逐轮 delta（40 轮真实回合） ===')
const sid = 'probe-anchor'
await exportConversationToServer(full.slice(-CAP), sid, MODE)
// web 端基线 = /gateway/session 全量投影
let webCur = filterConversationForDisplay(full, MODE) as { sid?: string; role?: string; blocks?: unknown[] }[]
let msgs: Src[] = full.slice()
let applied = 0, reconcile = 0, nullDelta = 0, tailBad = 0, guardHit = 0
for (let round = 0; round < 40; round++) {
  const i = 400 + round
  msgs = [...msgs, mkU(i), mkA(i, 'tool_use'), mkTR(i), mkA(i, 'end_turn')]
  const capped = msgs.slice(-CAP)
  // 顺序对齐 REPL：delta 先行（REPL.tsx:1597 effect），POST 快照 600ms 防抖在后（同 effect 尾）。
  // 反序（先 POST）会把 cache.sent 推进到本轮 display → buildDisplayDelta 视为「无新增」返回 null。
  const d = buildDisplayDelta(capped, sid, MODE)
  await exportConversationToServer(capped, sid, MODE)
  if (!d) { nullDelta++; reconcile++; continue }
  const idx = webCur.findIndex((m) => m && m.sid === d.anchorSid)
  if (idx === -1 || webCur.length - idx - 1 > WINDOW_GUARD) {
    if (idx !== -1) guardHit++
    reconcile++
    webCur = filterConversationForDisplay(msgs, MODE) as never
    continue
  }
  webCur = webCur.slice(0, idx + 1).concat(d.messages as never)
  applied++
  // 断言：CLI 全量投影的尾部 40 条应与 web 尾部 40 条一致（apply 语义 = web 投影尾部落地）
  const cliFull = filterConversationForDisplay(msgs, MODE) as { sid?: string }[]
  const bad = cliFull.slice(-40).some((m, j) => m.sid !== (webCur as { sid?: string }[]).slice(-40)[j]?.sid)
  if (bad) tailBad++
  if (bad && tailBad === 1) {
    console.log(`    [诊断] round=${round} delta=${d.messages.length} 条 anchor=${d.anchorSid} idx=${idx} webLen=${webCur.length} cliLen=${cliFull.length}`)
    console.log(`    [诊断] cli 末 8 sid: ${cliFull.slice(-8).map((m) => m.sid).join(' ')}`)
    console.log(`    [诊断] web 末 8 sid: ${(webCur as { sid?: string }[]).slice(-8).map((m) => m.sid).join(' ')}`)
    console.log(`    [诊断] delta 内 sid: ${d.messages.map((m) => m.sid).join(' ')}`)
  }
  if (round < 4 || round === 39) {
    console.log(` 轮${round}: ✓应用 anchor=${d.anchorSid} delta=${d.messages.length} 条 web=${webCur.length} cli全量=${cliFull.length} 尾部40条${bad ? '不一致✗' : '一致✓'}`)
  }
}
console.log(`\n结果：应用成功 ${applied} 轮 / 对账 ${reconcile} 轮（其中 delta=null ${nullDelta}、塌缩防护 ${guardHit}）/ 尾部不一致 ${tailBad} 轮`)
console.log(applied === 40 && tailBad === 0 ? '✓ 全部 40 轮增量落地且尾部与 CLI 全量投影一致' : '✗ 未达预期')

// ---------- C. 回合中块级扩展（用户实测症状：Bash 零提示 / Edit 显「正在思考」） ----------
console.log('\n=== C. 回合中块级扩展：tool_use 必须在同轮到达 web（不得等回合结束） ===')
const sid3 = 'probe-midturn'
await exportConversationToServer(full.slice(-CAP), sid3, MODE)
let web3 = filterConversationForDisplay(full, MODE) as { sid?: string; blocks?: { kind?: string; name?: string }[] }[]
const msgs3: Src[] = full.slice()
const step = (n: number, label: string, mutate: (a: Src[]) => Src[]) => {
  const next = mutate(msgs3.slice())
  msgs3.length = 0
  msgs3.push(...next)
  const capped = msgs3.slice(-CAP)
  const d = buildDisplayDelta(capped, sid3, MODE)
  if (!d) { console.log(` ${n}. ${label}: delta=null ✗`); return }
  const idx = web3.findIndex((m) => m && m.sid === d.anchorSid)
  if (idx === -1) { console.log(` ${n}. ${label}: 锚点未命中 ✗`); return }
  web3 = web3.slice(0, idx + 1).concat(d.messages as never)
  const cliFull = filterConversationForDisplay(msgs3, MODE)
  const last = web3[web3.length - 1]
  const kinds = (last?.blocks ?? []).map((b) => b.kind + (b.name ? ':' + b.name : '')).join(',')
  const tailOk = JSON.stringify(cliFull.slice(-20).map((m) => m.sid)) === JSON.stringify(web3.slice(-20).map((m) => m.sid))
  console.log(` ${n}. ${label}: delta=${d.messages.length} 条 anchor=${d.anchorSid} → web 末条[${kinds}] 尾部20${tailOk ? '一致✓' : '不一致✗'}`)
}
step(1, '用户消息', (a) => [...a, mkU(500)])
step(2, 'assistant text 先落', (a) => [...a, { type: 'assistant', uuid: uid('e5f6a7b8', 500), timestamp: 20000, message: { role: 'assistant', model: 'glm-5.3-flash', stop_reason: 'tool_use', content: [{ type: 'text', text: '跑个命令' }] } }])
step(3, 'Bash tool_use 补进同条（块扩展）', (a) => {
  const c = a.slice()
  c[c.length - 1] = { type: 'assistant', uuid: uid('e5f6a7b8', 500), timestamp: 20000, message: { role: 'assistant', model: 'glm-5.3-flash', stop_reason: 'tool_use', content: [{ type: 'text', text: '跑个命令' }, { type: 'tool_use', id: 'tu9', name: 'Bash', input: { command: 'date' } }] } }
  return c
})
step(4, 'tool_result', (a) => [...a, { type: 'user', uuid: uid('f6a7b8c9', 500), timestamp: 20010, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu9', content: [{ type: 'text', text: 'ok' }] }] } }])
step(5, 'Edit tool_use 落地', (a) => [...a, { type: 'assistant', uuid: uid('a7b8c9d0', 500), timestamp: 20020, message: { role: 'assistant', model: 'glm-5.3-flash', stop_reason: 'tool_use', content: [{ type: 'text', text: '改文件' }, { type: 'tool_use', id: 'tu10', name: 'Edit', input: { file_path: 'x.txt' } }] } }])
step(6, 'end_turn 收口', (a) => [...a, { type: 'assistant', uuid: uid('b8c9d0e1', 500), timestamp: 20030, message: { role: 'assistant', model: 'glm-5.3-flash', stop_reason: 'end_turn', content: [{ type: 'text', text: '完成' }] } }])
console.log('probe done')
