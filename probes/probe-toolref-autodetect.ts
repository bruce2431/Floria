/**
 * Probe: tool_reference 支持情况自动判断（runtime-learned gate）
 *
 * 验证三件事：
 *  1) probeToolReferenceSupport 打真端点得到正确判定（3P 池 provider）
 *  2) 判定结果进缓存，且同步入口 modelSupportsToolReference 读同一个缓存
 *  3) 静态名单（haiku）与 firstParty 默认行为未被破坏
 *
 * 运行：bun probes/probe-toolref-autodetect.ts
 */
import {
  isToolSearchEnabled,
  modelSupportsToolReference,
  probeToolReferenceSupport,
} from '../src/utils/toolSearch.js'
import { TOOL_SEARCH_TOOL_NAME } from '../src/tools/ToolSearchTool/prompt.js'

// haiku 不在列：静态名单在 isToolSearchEnabled 里先于 probe 短路掉它，
// probe 本身不该为它发请求（见 A1 + 下方说明）。
const CASES: Array<{ model: string; expect: boolean; note: string }> = [
  { model: 'glm-4.7', expect: false, note: '实测 400/1210，应判不支持' },
  { model: 'glm-4.5-air', expect: false, note: '实测 400/1210，应判不支持' },
  { model: 'glm-5.3-flash', expect: true, note: '429 余额不足 → fail-open 判支持' },
  { model: 'claude-sonnet-4-5', expect: true, note: '非池 provider → 直接放行，不发请求' },
]

let pass = 0
let fail = 0
function check(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)
}

console.log('--- A. 静态名单 / 非池模型（不应发请求） ---')
check('A1 static haiku list', modelSupportsToolReference('claude-3-5-haiku-20241022'), false)
check('A2 unknown claude = supported', modelSupportsToolReference('claude-sonnet-4-5'), true)

console.log('--- B. 真端点自动判断 ---')
for (const c of CASES) {
  const supported = await probeToolReferenceSupport(c.model)
  check(`B probe(${c.model}) ${c.note}`, supported, c.expect)
}

console.log('--- C. 判定被同步入口读到（缓存一致） ---')
for (const c of CASES) {
  check(`C modelSupportsToolReference(${c.model})`, modelSupportsToolReference(c.model), c.expect)
}

console.log('--- D. 幂等 / 缓存复用（第二次调用不重发） ---')
const t0 = Date.now()
for (let i = 0; i < 50; i++) await probeToolReferenceSupport('glm-4.7')
check('D1 50 次复用耗时 <50ms', Date.now() - t0 < 50, true)
check('D2 结论稳定', await probeToolReferenceSupport('glm-4.7'), false)

console.log('--- E. 门控组合（isToolSearchEnabled 真实入口） ---')
const tools = [
  { name: 'mcp__probe__echo', isMcp: true },
  { name: TOOL_SEARCH_TOOL_NAME },
] as never
const permCtx = (async () => ({})) as never
check(
  'E1 glm-4.7 + 有可延迟工具 → 关',
  await isToolSearchEnabled('glm-4.7', tools, permCtx, [], 'probe'),
  false,
)
check(
  'E2 claude-sonnet-4-5 + 有可延迟工具 → 开',
  await isToolSearchEnabled('claude-sonnet-4-5', tools, permCtx, [], 'probe'),
  true,
)
check(
  'E3 haiku 静态名单先短路 → 关（不发 probe）',
  await isToolSearchEnabled('claude-3-5-haiku-20241022', tools, permCtx, [], 'probe'),
  false,
)
// 未学习过的池模型（glm-4.6）+ 无可延迟工具：不得为探测发请求。
// 真打 bigmodel 一轮往返 >300ms，故以耗时做「没发请求」的证据。
const e4t0 = Date.now()
const e4 = await isToolSearchEnabled(
  'glm-4.6',
  [{ name: TOOL_SEARCH_TOOL_NAME }] as never,
  permCtx,
  [],
  'probe',
)
check(
  `E4 无可延迟工具 → 不为探测花钱，直接开（${Date.now() - e4t0}ms）`,
  e4 && Date.now() - e4t0 < 100,
  true,
)

console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
