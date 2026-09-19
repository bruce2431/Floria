/**
 * 探针：工具循环熔断器（2026-09-12 落地阈值 5；2026-09-18 晚重设计三维）
 *
 * 事故原型（pj18-初始化接力）：模型 glm-5.3-flash 每轮零思考零文本、纯复读同一条
 * TaskUpdate(taskId:5, in_progress) 754 次 / 2h41m，每次结果恒「Updated task #5」成功＝链路上
 * 无任何失败信号可打断，自回归复读锁死；用户三条消息前两条仅入队未注入，第三条注入才唤醒。
 *
 * 判据（2026-09-18 晚重设计，消除维度②对正常流误伤）：
 * ①同名同参连续 5 次 → 熔断（pj18 形态）；②连续 4 个纯簿记批（中间无实质工具）→ 熔断
 * （pj15 跨轮洪水形态）；③单批簿记 40 次 → 熔断（pj15 单轮 333 个形态）。
 * 误伤实锤（2beb0073，09-18 14:22）：会话开工单批建 10 个任务的计划，旧判据「簿记连续
 * 8 次」在第 8 个 TaskCreate 撞线、后 3 个被拦、回合收口——单批大批量突发是合法正常流。
 *
 * 用例：
 *  A. 状态机行为（真实模块导入直测）——维度①阈值 5/换参重置/不可序列化不误熔断；
 *     现场2 复现（单批 10 个 TaskCreate 不熔断）；大计划单批 30 不熔断；跨 4 纯簿记批熔断；
 *     实质工具重置；单批 39 不熔断 / 第 40 熔断（familyFlood）
 *  B. query.ts 结构断言——状态机声明在 while(true) 之前（跨迭代存活）；beginBatch+check
 *     唯一喂入点；扫描在 runTools 前；runTools 只收 allowedToolUseBlocks；熔断分支含合成
 *     tool_result（1:1 映射哨兵）+ 用户可见提示 + return { reason: 'tool_loop_breaker' }
 *
 * 运行：cd Floria && bun probes/probe-tool-loop-breaker.ts
 */
import { readFileSync } from 'node:fs'
import {
  createToolLoopBreakerState,
  toolLoopBreakerBeginBatch,
  toolLoopBreakerCheck,
  TOOL_LOOP_BREAKER_LIMIT,
  TOOL_FAMILY_BATCH_LIMIT,
  TOOL_FAMILY_FLOOD_LIMIT,
  type ToolLoopBreakerKind,
} from '../src/utils/toolLoopBreaker.js'

let pass = 0
const fails: string[] = []
function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++
    console.log(`  \u2714 ${name}`)
    return
  }
  fails.push(name)
  console.log(`  \u2716 ${name}${extra ? '  ' + extra : ''}`)
}
type Check = { blocked: boolean; streak: number; kind: ToolLoopBreakerKind }
const none: Check = { blocked: false, streak: 0, kind: 'identical' }

// ---------- A. 状态机行为（真实模块） ----------
console.log('A. toolLoopBreaker 状态机行为')
ok('阈值常量 ①=5 ②=4 ③=40', TOOL_LOOP_BREAKER_LIMIT === 5 && TOOL_FAMILY_BATCH_LIMIT === 4 && TOOL_FAMILY_FLOOD_LIMIT === 40)

// 维度①：同名同参
{
  const s = createToolLoopBreakerState()
  const input = { status: 'in_progress', taskId: '5' }
  toolLoopBreakerBeginBatch(s)
  let r: Check = none
  for (let i = 0; i < 4; i++) r = toolLoopBreakerCheck(s, 'TaskUpdate', input)
  ok('同名同参 4 次：不熔断', !r.blocked && r.streak === 4, `streak=${r.streak} blocked=${r.blocked}`)
  r = toolLoopBreakerCheck(s, 'TaskUpdate', input)
  ok('第 5 次：熔断（identical）', r.blocked && r.streak === 5 && r.kind === 'identical')
  r = toolLoopBreakerCheck(s, 'TaskUpdate', input)
  ok('第 6 次（继续喂）：仍熔断', r.blocked && r.streak === 6)
}
{
  const s = createToolLoopBreakerState()
  const a = { status: 'in_progress', taskId: '5' }
  toolLoopBreakerBeginBatch(s)
  for (let i = 0; i < 4; i++) toolLoopBreakerCheck(s, 'TaskUpdate', a)
  let r = toolLoopBreakerCheck(s, 'TaskUpdate', { status: 'completed', taskId: '5' })
  ok('参数变化：重置不熔断', !r.blocked && r.streak === 1)
  toolLoopBreakerBeginBatch(s)
  for (let i = 0; i < 4; i++) r = toolLoopBreakerCheck(s, 'TaskUpdate', a)
  ok('换参数后再连 4 次（累计不足 5）：不熔断', !r.blocked && r.streak === 4)
}
{
  const s = createToolLoopBreakerState()
  const input = { file_path: 'x.ts' }
  toolLoopBreakerBeginBatch(s)
  for (let i = 0; i < 4; i++) toolLoopBreakerCheck(s, 'Read', input)
  const r = toolLoopBreakerCheck(s, 'Grep', input)
  ok('换工具名（参数同形）：重置不熔断', !r.blocked && r.streak === 1)
}
{
  const s = createToolLoopBreakerState()
  const circular: Record<string, unknown> = {}
  circular['self'] = circular
  toolLoopBreakerBeginBatch(s)
  let r: Check = none
  for (let i = 0; i < 6; i++) r = toolLoopBreakerCheck(s, 'Weird', circular)
  ok('不可序列化 input：不误熔断（重置语义）', !r.blocked, `streak=${r.streak} blocked=${r.blocked}`)
}

// 维度②③：现场2 复现 + 批判据
{
  // 误伤实锤复现：单批建 10 个任务（参数各不同）→ 修后必须放行
  const s = createToolLoopBreakerState()
  toolLoopBreakerBeginBatch(s)
  let r: Check = none
  for (let i = 0; i < 10; i++) r = toolLoopBreakerCheck(s, 'TaskCreate', { subject: `任务 ${i}`, description: 'd' })
  ok('现场2 复现：单批 10 个 TaskCreate（建大计划）不熔断', !r.blocked, `kind=${r.kind} streak=${r.streak}`)
  r = toolLoopBreakerCheck(s, 'Bash', { command: 'git status' })
  ok('随后实质工具：家族连击清零', s.familyBatchStreak === 0 && !r.blocked)
}
{
  const s = createToolLoopBreakerState()
  toolLoopBreakerBeginBatch(s)
  let r: Check = none
  for (let i = 0; i < 30; i++) r = toolLoopBreakerCheck(s, 'TaskCreate', { subject: `t${i}` })
  ok('超大计划单批 30 个：不熔断', !r.blocked, `kind=${r.kind} streak=${r.streak}`)
}
{
  // 跨 4 个纯簿记批（每批 1-2 个 TaskUpdate，参数各不同）→ 第 4 批熔断
  const s = createToolLoopBreakerState()
  let r: Check = none
  for (let b = 0; b < 3; b++) {
    toolLoopBreakerBeginBatch(s)
    r = toolLoopBreakerCheck(s, 'TaskUpdate', { taskId: String(b), status: 'completed' })
  }
  ok('连续 3 个纯簿记批：不熔断', !r.blocked && s.familyBatchStreak === 3, `streak=${s.familyBatchStreak}`)
  toolLoopBreakerBeginBatch(s)
  r = toolLoopBreakerCheck(s, 'TaskUpdate', { taskId: '9', status: 'completed' })
  ok('第 4 个纯簿记批：熔断（familyBatch streak=4）', r.blocked && r.kind === 'familyBatch' && r.streak === 4, `kind=${r.kind} streak=${r.streak}`)
}
{
  // 实质工具打断连击：3 纯批 → Bash → 再纯批 → 不熔断
  const s = createToolLoopBreakerState()
  let r: Check = none
  for (let b = 0; b < 3; b++) {
    toolLoopBreakerBeginBatch(s)
    r = toolLoopBreakerCheck(s, 'TaskCreate', { subject: `s${b}` })
  }
  toolLoopBreakerBeginBatch(s)
  toolLoopBreakerCheck(s, 'Edit', { file_path: 'a.ts' })
  toolLoopBreakerBeginBatch(s)
  r = toolLoopBreakerCheck(s, 'TaskUpdate', { taskId: '1', status: 'in_progress' })
  ok('实质工具打断后再纯簿记批：不熔断', !r.blocked && s.familyBatchStreak === 1, `streak=${s.familyBatchStreak}`)
}
{
  // 批内混合：簿记+实质+簿记 → 批不算纯簿记
  const s = createToolLoopBreakerState()
  toolLoopBreakerBeginBatch(s)
  toolLoopBreakerCheck(s, 'TaskUpdate', { taskId: '1', status: 'in_progress' })
  toolLoopBreakerCheck(s, 'Read', { file_path: 'a.ts' })
  const r = toolLoopBreakerCheck(s, 'TaskUpdate', { taskId: '1', status: 'completed' })
  ok('批内混合（簿记+实质+簿记）：不熔断，按 1 轮含簿记计', !r.blocked && s.familyBatchStreak === 1, `streak=${s.familyBatchStreak}`)
}
{
  // 维度③：单批洪水
  const s = createToolLoopBreakerState()
  toolLoopBreakerBeginBatch(s)
  let r: Check = none
  for (let i = 0; i < 39; i++) r = toolLoopBreakerCheck(s, 'TaskCreate', { subject: `flood ${i}` })
  ok('单批簿记 39 个：不熔断', !r.blocked, `kind=${r.kind} streak=${r.streak}`)
  r = toolLoopBreakerCheck(s, 'TaskCreate', { subject: 'flood 39' })
  ok('第 40 个：熔断（familyFlood streak=40）', r.blocked && r.kind === 'familyFlood' && r.streak === 40, `kind=${r.kind} streak=${r.streak}`)
}

// ---------- B. query.ts 结构断言 ----------
console.log('B. query.ts 集成结构')
const src = readFileSync(new URL('../src/query.ts', import.meta.url), 'utf8')

function codeRefs(name: string): number {
  return src
    .split('\n')
    .filter((l) => l.includes(name) && !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .length
}

ok('toolLoopBreakerCheck 唯一喂入点（import + 1 调用）', codeRefs('toolLoopBreakerCheck') === 2, `refs=${codeRefs('toolLoopBreakerCheck')}`)
ok('toolLoopBreakerBeginBatch 唯一批边界点（import + 1 调用）', codeRefs('toolLoopBreakerBeginBatch') === 2, `refs=${codeRefs('toolLoopBreakerBeginBatch')}`)
ok('beginBatch 在喂入循环之前', src.indexOf('toolLoopBreakerBeginBatch(toolLoopBreaker)') < src.indexOf('for (const block of toolUseBlocks) {'))
ok('状态声明在场', src.includes('const toolLoopBreaker = createToolLoopBreakerState()'))
const declAt = src.indexOf('const toolLoopBreaker = createToolLoopBreakerState()')
const whileAt = src.indexOf('while (true) {')
ok('状态声明在 while(true) 之前（跨迭代存活）', declAt !== -1 && whileAt !== -1 && declAt < whileAt, `decl=${declAt} while=${whileAt}`)

const scanAt = src.indexOf('for (const block of toolUseBlocks) {')
const runToolsAt = src.indexOf('runTools(allowedToolUseBlocks, assistantMessages, canUseTool, toolUseContext)')
ok('runTools 改收 allowedToolUseBlocks', runToolsAt !== -1)
ok('熔断扫描在 runTools 之前', scanAt !== -1 && runToolsAt !== -1 && scanAt < runToolsAt)
ok('runTools 不再收裸 toolUseBlocks', !src.includes('runTools(toolUseBlocks,'))

const branchAt = src.indexOf('if (breakerTripped) {')
const checkpointAt = src.indexOf("queryCheckpoint('query_tool_execution_end')")
ok('熔断收口分支在工具执行收尾之后', branchAt !== -1 && checkpointAt !== -1 && branchAt > checkpointAt)
ok('合成 error tool_result（is_error + tool_use_id）', /is_error: true,\s*tool_use_id: content\.id/.test(src))
ok('1:1 映射哨兵（allowed 前缀跳过）', src.includes('if (seenBlocks <= allowedToolUseBlocks.length) continue'))
ok('用户可见熔断提示（三形态文案在场）', src.includes('⚠️ 任务工具熔断：任务簿记工具已连续') && src.includes('⚠️ 任务工具熔断：任务簿记工具本批内') && src.includes('⚠️ 工具循环熔断：'))
ok("回合收口 return { reason: 'tool_loop_breaker' }", src.includes("return { reason: 'tool_loop_breaker' }"))
ok('分析事件 tengu_tool_loop_breaker_tripped 在场', src.includes("'tengu_tool_loop_breaker_tripped'"))
ok('streamingToolExecutor 原路径未动（getRemainingResults 仍在）', src.includes('streamingToolExecutor.getRemainingResults()'))

// ---------- 结果 ----------
console.log(`\n${pass} 过 / ${fails.length} 败`)
if (fails.length > 0) {
  console.log('败项：' + fails.join(' | '))
  process.exit(1)
}
