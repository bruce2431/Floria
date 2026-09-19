// probe-imgid-20260916.ts — offline reproduction of the gateway/CLI display projection
// for session b5bd1265: check whether image blocks carry imageId after
// filterConversationForDisplay (positional mapping vs imagePasteIds contract).
import { readFileSync } from 'fs'
import { filterConversationForDisplay } from '../src/utils/conversationDisplay.js'

const p = process.argv[2] ?? '../.claude/projects/b5bd1265-5daf-4c52-a805-d1b1593377ff.jsonl'
const lines = readFileSync(p, 'utf8').split('\n')
const records: Record<string, unknown>[] = []
for (const s of lines) {
  const t = s.trim()
  if (!t) continue
  try {
    const r = JSON.parse(t)
    if (r && typeof r === 'object' && typeof r.type === 'string' &&
        ['user', 'assistant', 'system', 'attachment', 'progress'].includes(r.type)) records.push(r)
  } catch { /* skip */ }
}
const msgs = filterConversationForDisplay(records as never, 'prompt-tail-think') as never as Array<{ role: string; blocks: Array<{ kind: string; imageId?: number }>; timestamp?: unknown }>
let imgs = 0
let withId = 0
msgs.forEach((m, i) => {
  for (const b of m.blocks || []) {
    if (b.kind === 'image') {
      imgs++
      if (typeof b.imageId === 'number') withId++
      console.log(`msg#${i} ts=${String(m.timestamp)} role=${m.role} imageId=${b.imageId}`)
    }
  }
})
console.log(`total display msgs=${msgs.length}, image blocks=${imgs}, with imageId=${withId}`)
