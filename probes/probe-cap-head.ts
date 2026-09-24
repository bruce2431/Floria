/**
 * probe-cap-head.ts —— 2026-09-10 长会话 delta 仍恒 null 的取证探针（二轮）
 *
 * 假设：CLI 的 React messages state 经 capRenderedMessages 后，头部是 createSystemMessage 造的
 * 归档占位（uuid=randomUUID() + timestamp=now + 计数随窗口增长）。若该占位进入 filterConversationForDisplay
 * 的输出（display[0]），则 buildDisplayDelta 的 base0 = sent.findIndex(display[0].sid) 恒 -1
 * → 长会话下 delta 恒 null（窗口每滑一条即换占位）→ web 回合中零更新、Bash 空窗期。
 *
 * 本探针只取证投影头：不触网、不改状态。
 */
// 注意导入序：conversationDisplay 先（其依赖链含 sessionStorage 的模块级常量初始化），
// renderCap 后——反序会触发 ARCHIVE_PLACEHOLDER_PREFIX 的 TDZ（探针环境循环导入差异）。
import { filterConversationForDisplay } from '../src/utils/conversationDisplay.ts'
import { capRenderedMessages, MAX_RENDER_MESSAGES, RENDER_CAP_STEP, type SliceAnchorRef } from '../src/utils/renderCap.ts'

// 索引必须落在 uuid 前 24 位内 —— display 的稳定键 sid = uuid 前 24 位 + 同 parent 块序，
// 索引写在尾部会让同一 parent 的所有记录撞成同一 sid（探针判据失效，非产品缺陷）。
const uid = (p: string, i: number): string => `${p}${String(i).padStart(16, '0')}-0000-4000-8000-000000000000`

const rec = (i: number): Record<string, unknown> => ({
  type: 'assistant',
  uuid: uid('a1b2c3d4', i),
  timestamp: 1000 + i * 10,
  message: { role: 'assistant', model: 'glm-5.3-flash', stop_reason: 'end_turn', content: [{ type: 'text', text: `回复${i}` }] },
})

const CAP = MAX_RENDER_MESSAGES
const all: Record<string, unknown>[] = []
for (let i = 0; i < CAP + 40; i++) {
  all.push({ type: 'user', uuid: uid('b2c3d4e5', i), timestamp: 1000 + i * 10, message: { role: 'user', content: [{ type: 'text', text: `问题${i}` }] } })
  all.push(rec(i))
}

// 锚点跨调用存活 = REPL 的 renderCapAnchorRef 同构：窗口只在「已渲染 > cap + step」时前进一次，
// 追加不动顶行（2026-09-24 跳顶根修）。旧版每调用新建状态（= 计数滑动），此处必须带锚点，
// 否则复现的是已修掉的旧语义。
const anchorRef: SliceAnchorRef = { current: null }

const head = (n: number) => {
  const capped = capRenderedMessages(all.slice(0, n), anchorRef) as never[]
  const proj = filterConversationForDisplay(capped, 'prompt-tail-think') as { sid?: string; role?: string; kind?: string; text?: string }[]
  return { len: capped.length, projLen: proj.length, h0: proj[0], h1: proj[1] }
}

console.log(`=== cap 窗口前进时投影头（cap=${CAP} step=${RENDER_CAP_STEP}，输入=前 n 条原始记录）===`)
// 覆盖两次窗口前进：首次前进发生在 n = cap + step + 1，其后每 step 条一次。
// 前进点：首次 L - 0 > cap + step ⇒ L = 251（窗口落 51..250）；此后 start=51，下一次 L - 51 > 250
// ⇒ L = 302。采样点取每段前进的前一条、当条与后一条。
const seq = [CAP, CAP + RENDER_CAP_STEP, CAP + RENDER_CAP_STEP + 1, CAP + RENDER_CAP_STEP + 2, CAP + 2 * RENDER_CAP_STEP + 2]
// 判据 = display[0] 的稳定键 sid（归档占位被 filterConversationForDisplay 丢弃，不进投影头，
// 故头部恒为真实记录、sid 稳定可作身份）。
let prevSid: string | undefined
let changed = 0
for (const n of seq) {
  const { len, projLen, h0, h1 } = head(n)
  const sid = h0?.sid ?? '(undefined)'
  const same = prevSid === undefined ? '—' : sid === prevSid ? '同' : '★变了'
  if (prevSid !== undefined && sid !== prevSid) changed++
  console.log(` n=${n} 输入=${len} 投影=${projLen} | display[0]: role=${h0?.role} kind=${h0?.kind} sid=${sid} ${same}`)
  console.log(`    display[0].text=${JSON.stringify(String(h0?.text ?? '').slice(0, 46))} | display[1]: role=${h1?.role} kind=${h1?.kind}`)
  prevSid = sid
}
const advances = 2 // seq 覆盖 n = cap+step+1 与 n = cap+2*step+1 两次窗口前进
console.log(`\n结果：${seq.length} 个采样点跨 ${advances} 次窗口前进，投影头 sid 变化次数 = ${changed}（期望 = ${advances}）`)
console.log(changed === advances ? 'PASS：投影头只在窗口前进时变（追加不再移动顶行 ⇒ 无 fullReset）' : 'FAIL：顶行变化次数与窗口前进次数不符')
