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
import { capRenderedMessages, MAX_RENDER_MESSAGES } from '../src/utils/renderCap.ts'

const uid = (p: string, i: number): string => `${p}-0000-4000-8000-${String(i).padStart(12, '0')}`

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

const head = (n: number) => {
  const capped = capRenderedMessages(all.slice(0, n)) as never[]
  const proj = filterConversationForDisplay(capped, 'prompt-tail-think') as { sid?: string; role?: string; kind?: string; text?: string }[]
  return { len: capped.length, projLen: proj.length, h0: proj[0], h1: proj[1] }
}

console.log(`=== cap 窗口滑动时投影头（cap=${CAP}，输入=前 n 条原始记录）===`)
const seq = [CAP, CAP + 2, CAP + 6, CAP + 10]
let prevSid: string | undefined
let bad = 0
for (const n of seq) {
  const { len, projLen, h0, h1 } = head(n)
  const sid = h0?.sid ?? '(undefined)'
  const same = prevSid === undefined ? '—' : sid === prevSid ? '同' : '★变了'
  if (prevSid !== undefined && sid !== prevSid) bad++
  console.log(` n=${n} 输入=${len} 投影=${projLen} | display[0]: role=${h0?.role} kind=${h0?.kind} sid=${sid} ${same}`)
  console.log(`    display[0].text=${JSON.stringify(String(h0?.text ?? '').slice(0, 46))} | display[1]: role=${h1?.role} kind=${h1?.kind}`)
  prevSid = sid
}
console.log(`\n结果：窗口滑动 3 次，投影头 sid 变化次数 = ${bad} → ${bad > 0 ? '★假设成立：占位进入投影头 → base0 恒 -1 → delta 恒 null' : '假设不成立（投影头是稳定真实记录）'}`)
