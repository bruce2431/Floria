/**
 * probe-delta-window.ts —— 2026-09-10 长会话 delta 坐标错配复现（历史取证件，已被
 * probe-delta-anchor.ts 取代：旧协议的数字坐标 base 已随 anchorSid 根修删除，本文件
 * 只能复现「修复前恒 null」的历史现象，勿再作为验收依据）。
 *
 * 现象（实测）：6ea48794 CLI base=145 / 网关投影 732；6983e5be CLI base=170-177 / 网关投影 5447。
 * 假设：REPL messages state 被 capRenderedMessages 裁成尾部 200 条（utils/renderCap.ts:15），
 * buildDisplayDelta 的 base 是 CLI 本地 sent 坐标（小数字），而 web 的 cur 是网关全量投影 → 错配拒收。
 *
 * 本探针：造 400 轮历史（800 条消息），每轮只把「尾部 200 条」喂给两链
 *（模拟 cap），迭代 40 轮并打印 base / display 长度，验证是否复现「base 恒在 150-200 小区间」。
 * 同一模型上验证锚点协议（anchorUuid + 尾部替换）能否在 web 全量序列上正确应用。
 */
process.env.FLOIRA_GATEWAY = 'http://127.0.0.1:9' // 死端口：POST 失败但缓存仍建立

const { exportConversationToServer, buildDisplayDelta, filterConversationForDisplay } =
  await import('../src/utils/conversationDisplay.js')

const MODE = 'prompt-tail-think'
const CAP = 200

type Src = Record<string, unknown>
const mkU = (i: number): Src => ({
  type: 'user', uuid: `u${i}`, timestamp: 1000 + i * 10,
  message: { role: 'user', content: [{ type: 'text', text: `第${i}问` } ] },
})
const mkA = (i: number, stop: string): Src => ({
  type: 'assistant', uuid: `a${i}`, timestamp: 1005 + i * 10,
  message: { role: 'assistant', model: 'glm-5.3-flash', stop_reason: stop, content: [
    ...(stop === 'end_turn' ? [{ type: 'thinking', thinking: `思考${i}` }] : []),
    { type: 'text', text: `回复${i}` },
    ...(stop === 'tool_use' ? [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: 'echo hi' } }] : []),
  ] },
})
const mkTR = (i: number): Src => ({
  type: 'user', uuid: `r${i}`, timestamp: 1008 + i * 10,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: [{ type: 'text', text: 'ok' }] }] },
})

// 400 轮历史：每轮 user + assistant(end_turn)
const full: Src[] = []
for (let i = 0; i < 400; i++) { full.push(mkU(i), mkA(i, 'end_turn')) }

const sid = 'probe-window'
// 引导基线（模拟 CLI 启动后首轮上报：此时 messages 已 capped）
await exportConversationToServer(full.slice(-CAP), sid, MODE)
// CLI 侧 / gateway 侧「全量投影」参照：网关读 jsonl 得到全量
const gatewayFull = filterConversationForDisplay(full, MODE)
console.log(`全量消息 ${full.length} 条 → 网关投影 ${gatewayFull.length} 条（web 的 cur 长度）`)

console.log('\n=== 复现：cap 窗口 + 逐轮追加（模拟真实回合） ===')
let msgs: Src[] = full.slice()
let lastBase = -1
let frozen = true
for (let round = 0; round < 40; round++) {
  const i = 400 + round
  // 一轮：user → assistant(think+tool_use) → tool_result → assistant(end_turn)
  msgs = [...msgs, mkU(i), mkA(i, 'tool_use'), mkTR(i), mkA(i, 'end_turn')]
  const capped = msgs.slice(-CAP) // ← capRenderedMessages 的等价窗口（占位符被过滤）
  const d = buildDisplayDelta(capped, sid, MODE)
  if (d) {
    if (round < 6 || round === 39) console.log(` 轮${round}: base=${d.base} delta消息数=${d.messages.length} (cap输入=${capped.length})`)
    if (round > 0 && round < 39) { if (d.base !== lastBase + 1) frozen = false }
    lastBase = d.base
  } else if (round < 6 || round === 39) {
    console.log(` 轮${round}: null（不发）`)
  }
}
console.log(`→ 旧协议在长会话下 base 恒在小数字区间（末轮 base=${lastBase}），web cur 长度=${gatewayFull.length} → 差值 ${gatewayFull.length - lastBase} 条，必然触发「历史截断拒收」`)

console.log('\n=== 新协议验证：锚点 uuid + 尾部替换 ===')
// 重新起一个独立会话，用同一模型跑「锚点协议」并端到端模拟 web 端应用
const sid2 = 'probe-anchor'
await exportConversationToServer(full.slice(-CAP), sid2, MODE)
// web 端序列 = 全量投影（模拟 /gateway/session）
let webCur = filterConversationForDisplay(full, MODE)
let msgs2: Src[] = full.slice()
let ok = 0, reconcile = 0
for (let round = 0; round < 40; round++) {
  const i = 400 + round
  msgs2 = [...msgs2, mkU(i), mkA(i, 'tool_use'), mkTR(i), mkA(i, 'end_turn')]
  const capped = msgs2.slice(-CAP)
  // 新协议：delta = { seq, anchorUuid, messages }
  const d = buildDisplayDelta(capped, sid2, MODE)
  if (!d) { reconcile++; continue }
  // 锚点：CLI 侧用「分歧点前一条」的 uuid（新协议）；这里用旧 base 在 capped 投影中的前一条近似
  const disp = filterConversationForDisplay(capped, MODE)
  const from = d.base // 占位：新协议将直接给 anchorUuid，探针先用等价推导
  const anchorIdx = from - 1
  const anchorUuid = anchorIdx >= 0 ? disp[anchorIdx]?.uuid : null
  const msgsOut = disp.slice(anchorIdx + 1)
  // —— web 端应用（新协议逻辑）——
  const idx = anchorUuid ? webCur.findIndex((m: { uuid?: string }) => m && m.uuid === anchorUuid) : -1
  if (idx === -1) { reconcile++; webCur = filterConversationForDisplay(msgs2, MODE); continue }
  webCur = webCur.slice(0, idx + 1).concat(msgsOut as never[])
  ok++
  // 校验：web 序列尾部应与 CLI 全量投影一致（尾部 200 条内）
  const cliFull = filterConversationForDisplay(msgs2, MODE)
  const tailWeb = JSON.stringify(webCur.slice(-50))
  const tailCli = JSON.stringify(cliFull.slice(-50))
  if (round < 3 || round === 39) {
    console.log(` 轮${round}: 应用✓ (web=${webCur.length} cli全量=${cliFull.length}) 尾部50条${tailWeb === tailCli ? '一致✓' : '不一致✗'}`)
  }
}
console.log(`\n锚点协议结果：应用成功 ${ok} 轮 / 对账 ${reconcile} 轮`)
console.log('probe done')

// ---------- 诊断：定位旧协议 null 命中的分支 ----------
console.log('\n=== 诊断 ===')
const sid3 = 'probe-diag'
await exportConversationToServer(full.slice(-CAP), sid3, MODE)
const capped0 = full.slice(-CAP)
const disp0 = filterConversationForDisplay(capped0, MODE)
console.log(`引导输入 ${capped0.length} 条 → 投影 ${disp0.length} 条`)
console.log(`投影首条 uuid=${disp0[0]?.uuid} role=${disp0[0]?.role} 末条 uuid=${disp0[disp0.length-1]?.uuid}`)
const msgs3 = [...full, mkU(400), mkA(400, 'tool_use')]
const capped1 = msgs3.slice(-CAP)
const disp1 = filterConversationForDisplay(capped1, MODE)
console.log(`下一轮输入 ${capped1.length} 条 → 投影 ${disp1.length} 条 首条 uuid=${disp1[0]?.uuid}`)
const d3 = buildDisplayDelta(capped1, sid3, MODE)
console.log('buildDisplayDelta →', d3 ? `base=${d3.base} len=${d3.messages.length}` : 'null')
// 手工复刻判定
const disp0json = disp0.map(m => JSON.stringify(m))
const disp1json = disp1.map(m => JSON.stringify(m))
console.log('两轮投影首条 JSON 是否相同:', disp0json[0] === disp1json[0])
console.log('disp0[0]:', disp0json[0]?.slice(0, 160))
console.log('disp1[0]:', disp1json[0]?.slice(0, 160))

// ---------- 诊断 2：sent 里到底有没有 display[0] ----------
const sentLike = disp0 // 上一轮投影 = 引导时存入的 sent
const target = disp1[0]!.uuid
const pos = sentLike.findIndex((m) => m.uuid === target)
console.log(`\nsent(${sentLike.length}) 中查找 display 首条 uuid=${target} → 位置 ${pos}`)
console.log('sent 前 6 条 uuid:', sentLike.slice(0, 6).map((m) => m.uuid).join(','))
console.log('disp1 前 6 条 uuid:', disp1.slice(0, 6).map((m) => m.uuid).join(','))
console.log('sent 末 3 条 uuid:', sentLike.slice(-3).map((m) => m.uuid).join(','))
console.log('disp1 末 3 条 uuid:', disp1.slice(-3).map((m) => m.uuid).join(','))
// 复刻 buildDisplayDelta 的三条 null 分支
const base0 = pos
let k = base0
while (k < sentLike.length && k - base0 < disp1.length) {
  if (JSON.stringify(sentLike[k]) !== JSON.stringify(disp1[k - base0])) break
  k++
}
console.log(`手工复刻: base0=${base0} k=${k} k-base0=${k - base0} display.len=${disp1.length} sent.len=${sentLike.length}`)
console.log(`分支判定: base0<0? ${base0 < 0} | k-base0>=display.len? ${k - base0 >= disp1.length} | base0+display.len<sent.len? ${base0 + disp1.length < sentLike.length}`)
