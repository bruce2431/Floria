/**
 * probe-delta-tooluse.ts —— 2026-09-10 第三轮实证探针
 * 症状：exe 144808 下 web 端 Bash 运行零提示、Edit 运行显「正在思考」（tool_use 未进 web）。
 * 本探针用真实 buildDisplayDelta/filterConversationForDisplay 模拟一轮
 * 「user → assistant(think+text+tool_use Bash) → tool_result → assistant(tool_use Edit) → end_turn」
 * 的三种落盘形态，检查每步 delta 是否携带 tool_use。
 * FLOIRA_GATEWAY 指死端口：exportConversationToServer POST 快速失败，但缓存仍无条件建立
 * （conversationDisplay.ts:617），buildDisplayDelta 即可离线工作。
 */
process.env.FLOIRA_GATEWAY = 'http://127.0.0.1:9'

const { exportConversationToServer, buildDisplayDelta } = await import('../src/utils/conversationDisplay.js')

const mkA = (uuid, ts, content, stop) => ({
  type: 'assistant', uuid, timestamp: ts,
  message: { role: 'assistant', model: 'glm-5.3-flash', content, stop_reason: stop },
})
const mkU = (uuid, ts, text) => ({
  type: 'user', uuid, timestamp: ts,
  message: { role: 'user', content: [{ type: 'text', text }] },
})
const mkTR = (uuid, ts, toolUseId) => ({
  type: 'user', uuid, timestamp: ts,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: [{ type: 'text', text: 'ok' }] }] },
})

const show = (label, d) => {
  if (!d) { console.log(label, '→ null（无 delta 发出）'); return }
  const msgs = d.messages.map(m =>
    `${m.role}[${(m.blocks || []).map(b => b.kind + (b.name ? ':' + b.name : '')).join(',')}]`).join(' | ')
  console.log(label, '→ seq', d.seq, 'anchor', d.anchorSid, 'msgs:', msgs)
}

const MODE = 'prompt-tail-think'

async function run(name, build) {
  const sid = 'probe-' + name
  // 起始基线：上一回合已收尾（u1 + a1 end_turn 带思考）
  const base = [
    mkU('u1', 1000, '上一问'),
    mkA('a1', 2000, [{ type: 'thinking', thinking: '旧思考' }, { type: 'text', text: '上一轮回复' }], 'end_turn'),
  ]
  await exportConversationToServer(base, sid, MODE) // 引导缓存（POST 失败无妨）
  console.log('=== ' + name + ' ===')
  let s = base
  for (const [label, next] of build) {
    s = next(s)
    show(label, buildDisplayDelta(s, sid, MODE))
  }
}

// 形态 A：整块落地——一条 assistant 消息同时含 think+text+tool_use
await run('A-整块落地', [
  ['①user追加', s => [...s, mkU('u2', 3000, 'Bash、Edit 各来一次')]],
  ['②think+text+tool_use(Bash)落地', s => [...s, mkA('a2', 4000, [
    { type: 'thinking', thinking: '新思考' },
    { type: 'text', text: '好，再跑一轮' },
    { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'date; sleep 3; date' } },
  ], 'tool_use')]],
  ['③tool_result(Bash)', s => [...s, mkTR('u3', 5000, 'tu1')]],
  ['④think+tool_use(Edit)落地', s => [...s, mkA('a3', 6000, [
    { type: 'thinking', thinking: 'edit思考' },
    { type: 'tool_use', id: 'tu2', name: 'Edit', input: { file_path: 'x.txt' } },
  ], 'tool_use')]],
  ['⑤tool_result(Edit)', s => [...s, mkTR('u4', 7000, 'tu2')]],
  ['⑥end_turn 收口', s => [...s, mkA('a4', 8000, [{ type: 'text', text: '完成' }], 'end_turn')]],
])

// 形态 B：拆分落地——思考先到（独立消息），text+tool_use 随后
await run('B-拆分落地', [
  ['①user追加', s => [...s, mkU('u2', 3000, 'Bash、Edit 各来一次')]],
  ['②think 独立落地', s => [...s, mkA('a2a', 3500, [{ type: 'thinking', thinking: '新思考' }], 'tool_use')]],
  ['③text+tool_use(Bash)落地', s => [...s, mkA('a2b', 4000, [
    { type: 'text', text: '好，再跑一轮' },
    { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'date; sleep 3; date' } },
  ], 'tool_use')]],
  ['④tool_result(Bash)', s => [...s, mkTR('u3', 5000, 'tu1')]],
])

// 形态 C：同 uuid 块扩展——text 先落，tool_use 块随后补进同一条消息（流式块级更新）
await run('C-同uuid块扩展', [
  ['①user追加', s => [...s, mkU('u2', 3000, 'Bash、Edit 各来一次')]],
  ['②text 先落（无 tool_use）', s => [...s, mkA('a2', 4000, [
    { type: 'text', text: '好，再跑一轮' },
  ], 'tool_use')]],
  ['③tool_use(Bash) 补进同条', s => {
    const c = s.slice()
    c[c.length - 1] = mkA('a2', 4000, [
      { type: 'text', text: '好，再跑一轮' },
      { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'date; sleep 3; date' } },
    ], 'tool_use')
    return c
  }],
  ['④tool_result(Bash)', s => [...s, mkTR('u3', 5000, 'tu1')]],
])
console.log('probe done')
