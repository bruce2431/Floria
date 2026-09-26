/**
 * 探针：会话累计用量**从转录派生**（唯一的恢复来源）。
 *
 * 不变量（每条断言对应一条）：
 *   - 同一条 API 响应在转录里被流式写成多条记录（同一 `message.id`），
 *     派生时逐字段取最大 = 终值，**不重复计**
 *   - 子代理转录（`<sessionId>/subagents/**`）与主转录无交集，必须一并折入
 *   - **压缩代理转录（`agent-acompact-*.jsonl`）里含有主链消息的副本**（同 `message.id`），
 *     必须与主转录折进同一张 map 全局去重，否则同一次调用计两遍
 *   - 派生出的金额 = 逐模型按 token 计价求和（`totalCostUSD ≡ Σ modelUsage.costUSD`）
 *   - `restoreCostStateForSession` 把派生值写进 STATE；无转录的会话返回 false
 *   - 不再有任何落盘计数器参与：恢复只依赖转录，换进程/被杀都不丢
 *
 * 全程在临时配置根 + 临时项目目录内跑，不碰真实 `.claude.json` / `credentials.json`。
 *
 * 用法：bun probes/probe-session-cost-restore.ts
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const root = join(tmpdir(), 'floria-session-cost-probe')
rmSync(root, { recursive: true, force: true })
const configHome = join(root, '.claude')
const projectDir = join(root, 'proj')
mkdirSync(configHome, { recursive: true })
mkdirSync(projectDir, { recursive: true })
process.env.CLAUDE_CONFIG_DIR = configHome
process.chdir(projectDir)

// 价格走「用户覆盖」层（credentials.json `pricing.models`），人民币/百万 token，
// 汇率 7：1 ⇒ 输入 $1/M、输出 $4/M、缓存读 $0.02/M。
writeFileSync(
  join(configHome, 'credentials.json'),
  JSON.stringify({
    pricing: {
      usdCnyRate: 7,
      models: { 'deepseek-flash': { input: 7, output: 28, cacheRead: 0.14 } },
    },
  }),
)

const { enableConfigs } = await import('../src/utils/config.js')
enableConfigs()

const state = await import('../src/bootstrap/state.js')
const { getTranscriptPathForSession } = await import(
  '../src/utils/sessionStorage.js'
)
const { deriveCostStateFromTranscript, restoreCostStateForSession } =
  await import('../src/cost-tracker.js')

// ── 断言 ─────────────────────────────────────────────────────────────────────

let failures = 0
let checks = 0

function assert(label: string, actual: unknown, expected: unknown): void {
  checks++
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(
    `${ok ? '  ok  ' : ' FAIL '} ${label.padEnd(52)} ${ok ? String(actual) : `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`,
  )
}

function assertClose(label: string, actual: number, expected: number): void {
  checks++
  const ok = Math.abs(actual - expected) < 1e-9
  if (!ok) failures++
  console.log(
    `${ok ? '  ok  ' : ' FAIL '} ${label.padEnd(52)} ${ok ? String(actual) : `got ${actual} want ${expected}`}`,
  )
}

// ── 造转录 ───────────────────────────────────────────────────────────────────

const sessionId = state.getSessionId()
const transcriptPath = getTranscriptPathForSession(sessionId)
mkdirSync(dirname(transcriptPath), { recursive: true })

/** 一条 assistant 记录（只保留用量相关字段，够派生用） */
function assistant(
  id: string,
  usage: Record<string, number>,
): string {
  return JSON.stringify({
    type: 'assistant',
    message: { id, model: 'deepseek-flash', usage },
  })
}

const lines = [
  // 同一次响应被流式写了三条（input/cacheRead 相同，output 逐渐到终值）
  assistant('msg-1', {
    input_tokens: 1000,
    output_tokens: 0,
    cache_read_input_tokens: 2000,
    cache_creation_input_tokens: 0,
  }),
  assistant('msg-1', {
    input_tokens: 1000,
    output_tokens: 40,
    cache_read_input_tokens: 2000,
    cache_creation_input_tokens: 0,
  }),
  assistant('msg-1', {
    input_tokens: 1000,
    output_tokens: 100,
    cache_read_input_tokens: 2000,
    cache_creation_input_tokens: 0,
  }),
  assistant('msg-2', {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 0,
  }),
  // 非 assistant 记录应被忽略
  JSON.stringify({ type: 'user', message: { id: 'u-1' } }),
]
writeFileSync(transcriptPath, lines.join('\n') + '\n')

// 子代理转录：与主转录消息 id 无交集
const subagentPath = join(
  dirname(transcriptPath),
  sessionId,
  'subagents',
  'agent-abc.jsonl',
)
mkdirSync(dirname(subagentPath), { recursive: true })
writeFileSync(
  subagentPath,
  assistant('msg-3', {
    input_tokens: 500,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  }) + '\n',
)

// 压缩代理转录：含主链消息 msg-1 / msg-2 的副本（同 message.id，取自同一响应），
// 外加它自己的一条 msg-4。副本必须被全局去重，否则 msg-1/msg-2 计两遍。
const compactPath = join(
  dirname(transcriptPath),
  sessionId,
  'subagents',
  'agent-acompact-abc.jsonl',
)
writeFileSync(
  compactPath,
  [
    assistant('msg-1', {
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_input_tokens: 2000,
      cache_creation_input_tokens: 0,
    }),
    assistant('msg-2', {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 0,
    }),
    assistant('msg-4', {
      input_tokens: 250,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    }),
  ].join('\n') + '\n',
)

// ── [1] 派生 ─────────────────────────────────────────────────────────────────

console.log('\n[1] 从转录派生累计用量')
const derived = deriveCostStateFromTranscript(sessionId)
{
  assert('派生成功', derived !== undefined, true)
  const usage = derived?.modelUsage['deepseek-flash']
  assert('输入 token（主 1000 + 子代理 500 + 压缩代理 250）', usage?.inputTokens, 1750)
  assert('输出 token 取快照终值（非 0+40+100）', usage?.outputTokens, 100)
  assert('缓存读 token（2000 + 1000）', usage?.cacheReadInputTokens, 3000)
  assert(
    '同一 message.id 跨文件只计一次（压缩代理副本不重复计）',
    (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
    1850,
  )
  // (1750 * $1 + 100 * $4 + 3000 * $0.02) / 1e6
  assertClose('金额 = 逐模型 token 计价求和', derived?.totalCostUSD ?? -1, 0.00221)
  assert(
    '总价 ≡ Σ modelUsage.costUSD',
    derived?.totalCostUSD,
    Object.values(derived?.modelUsage ?? {}).reduce((s, u) => s + u.costUSD, 0),
  )
  assert('模型用量表带上了上下文窗口', (usage?.contextWindow ?? 0) > 0, true)
}

// ── [2] 恢复链路 ─────────────────────────────────────────────────────────────

console.log('\n[2] restoreCostStateForSession 把派生值写进 STATE')
{
  state.resetCostState()
  assert('恢复返回 true', restoreCostStateForSession(sessionId), true)
  assert('STATE 总额 = 派生总额', state.getTotalCostUSD(), derived?.totalCostUSD)
  assert(
    'STATE 模型用量 = 派生用量',
    state.getUsageForModel('deepseek-flash')?.inputTokens,
    1750,
  )
}

// ── [3] 无转录 / 无 assistant 记录 ───────────────────────────────────────────

console.log('\n[3] 边界')
{
  assert(
    '没有转录的会话派生为 undefined',
    deriveCostStateFromTranscript('00000000-0000-0000-0000-000000000000'),
    undefined,
  )
  assert(
    '没有转录的会话恢复失败',
    restoreCostStateForSession('00000000-0000-0000-0000-000000000000'),
    false,
  )
  const emptyPath = join(dirname(transcriptPath), 'empty-session.jsonl')
  writeFileSync(emptyPath, JSON.stringify({ type: 'user', message: {} }) + '\n')
  assert(
    '只有非 assistant 记录的会话派生为 undefined',
    deriveCostStateFromTranscript('empty-session'),
    undefined,
  )
}

console.log(
  `\n${failures === 0 ? 'PASS' : 'FAIL'}  ${checks - failures}/${checks}`,
)
process.exit(failures === 0 ? 0 : 1)
