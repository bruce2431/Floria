/**
 * 探针：/cost 的单价来自厂商官网真实价目，且峰谷/长度分档按官方规则命中。
 *
 * 不变量（每条断言对应一条）：
 *   - deepseek 价目取自 api-docs.deepseek.com，空闲/高峰两档都按官方表原值
 *     （空闲价为高峰价一半这件事由官网表直接给出，不由代码乘 2）
 *   - 峰谷时段用北京时间判定：周一至周五 9:00-12:00、14:00-18:00 为高峰，
 *     周末与法定节假日全天空闲；`pricing` 配置可覆盖时段与节假日
 *   - 智谱价目取自 docs.bigmodel.cn，输入/输出长度分档按「首个命中档」；
 *     超出官方已列最大区间时按最高档计
 *   - 官网没列的模型（glm-4.6）回落到 models.dev 目录
 *   - 价目里查不到的模型返回 null（由调用方标未定价），绝不套用别的模型费率
 *   - 汇率未知时不允许把 USD 价硬算成 ¥
 *   - 会话绑定 provider 时，Anthropic 家族别名（haiku/sonnet/opus/best/opusplan）
 *     一律落回该 provider 的模型，不回落一号默认 ID（否则模型名属 Anthropic、
 *     endpoint 属 provider，且被 Anthropic 静态表定价）
 *
 * 全程在临时配置根内跑（CLAUDE_CONFIG_DIR 指向临时目录），不碰真实
 * credentials.json 与真实缓存文件。需要联网（三个价源 + 汇率）。
 *
 * 用法：bun probes/probe-model-pricing.ts
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(tmpdir(), 'floria-model-pricing-probe')
rmSync(root, { recursive: true, force: true })
mkdirSync(join(root, '.claude', 'cache'), { recursive: true })
process.env.CLAUDE_CONFIG_DIR = join(root, '.claude')

const { refreshModelPricing, resolveModelCost, peakPeriodAt, getUsdCnyRate, describePricing } =
  await import('../src/utils/modelPricing.js')

const DEEPSEEK_URL = 'https://api.deepseek.com/anthropic'
const GLM_URL = 'https://open.bigmodel.cn/api/anthropic'

type PricingSection = Record<string, unknown>

function writeCredentials(pricing?: PricingSection): void {
  writeFileSync(
    join(root, '.claude', 'credentials.json'),
    JSON.stringify(
      {
        activeProvider: 'deepseek',
        providers: {
          deepseek: {
            baseUrl: DEEPSEEK_URL,
            models: ['deepseek-flash', 'deepseek-v4-pro'],
            activeModel: 'deepseek-flash',
          },
          glm: {
            baseUrl: GLM_URL,
            models: ['glm-5.3', 'glm-4.6', 'glm-4.5-air'],
          },
        },
        ...(pricing ? { pricing } : {}),
      },
      null,
      2,
    ),
    'utf-8',
  )
}

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

/** 千 token 计数（用于构造 usage） */
const K = (n: number): number => Math.round(n * 1000)

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** 北京时间某天某时的毫秒时间戳（date 用 UTC 表示的「北京日期」） */
function beijing(date: string, hour: number, minute = 0): number {
  return Date.parse(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`)
}

// 2026-09-28 是周一，2026-09-26 是周六
const MON_10 = beijing('2026-09-28', 10) // 高峰
const MON_06 = beijing('2026-09-28', 6) // 空闲
const SAT_10 = beijing('2026-09-26', 10) // 周末 → 空闲
const MON_12 = beijing('2026-09-28', 12) // 时段右开 → 空闲
const MON_14 = beijing('2026-09-28', 14) // 高峰

/** 单价换算成人民币 / 百万 token */
function cny(usdPerMtok: number, rate: number): number {
  return Math.round(usdPerMtok * rate * 1e6) / 1e6
}

function rates(
  cost: { inputTokens: number; outputTokens: number; promptCacheReadTokens: number; promptCacheWriteTokens: number },
  rate: number,
): number[] {
  return [
    cny(cost.inputTokens, rate),
    cny(cost.outputTokens, rate),
    cny(cost.promptCacheReadTokens, rate),
    cny(cost.promptCacheWriteTokens, rate),
  ]
}

function resolve(model: string, usage: Usage, atMs: number, baseUrl: string) {
  return resolveModelCost('probe', baseUrl, model, usage, atMs)
}

// ── 跑 ───────────────────────────────────────────────────────────────────────

console.log('价格源：厂商官网 + models.dev 目录（联网）\n')
writeCredentials()
await refreshModelPricing()

const rate = getUsdCnyRate()
console.log(`USD→CNY = ${rate}`)
if (rate === null) {
  console.log('汇率未知，后续换算断言无法进行')
  process.exit(1)
}
const r = rate

console.log('\n[1] DeepSeek 官方价目（空闲 / 高峰）')
{
  const off = resolve('deepseek-flash', { input_tokens: K(1), output_tokens: K(1) }, MON_06, DEEPSEEK_URL)
  assert('deepseek-flash 空闲 ¥1/¥4 缓存读 ¥0.02 写 ¥1', off && rates(off.cost, r), [1, 4, 0.02, 1])
  assert('  └ 出处 = 官网', off?.source, 'api-docs.deepseek.com')

  const peak = resolve('deepseek-flash', { input_tokens: K(1), output_tokens: K(1) }, MON_10, DEEPSEEK_URL)
  assert('deepseek-flash 高峰 ¥2/¥8 缓存读 ¥0.04', peak && rates(peak.cost, r), [2, 8, 0.04, 2])

  const proOff = resolve('deepseek-v4-pro', { input_tokens: K(1), output_tokens: K(1) }, MON_06, DEEPSEEK_URL)
  assert('deepseek-v4-pro 空闲 ¥4.5/¥13.5 缓存读 ¥0.15', proOff && rates(proOff.cost, r), [4.5, 13.5, 0.15, 4.5])

  const proPeak = resolve('deepseek-v4-pro', { input_tokens: K(1), output_tokens: K(1) }, MON_10, DEEPSEEK_URL)
  assert('deepseek-v4-pro 高峰 ¥9/¥27 缓存读 ¥0.30', proPeak && rates(proPeak.cost, r), [9, 27, 0.3, 9])
}

console.log('\n[2] 峰谷时段判定（北京时间）')
assert('周一 10:00 = 高峰', peakPeriodAt(MON_10), 'peak')
assert('周一 06:00 = 空闲', peakPeriodAt(MON_06), 'offPeak')
assert('周六 10:00 = 空闲', peakPeriodAt(SAT_10), 'offPeak')
assert('周一 12:00（右开）= 空闲', peakPeriodAt(MON_12), 'offPeak')
assert('周一 14:00 = 高峰', peakPeriodAt(MON_14), 'peak')
assert(
  '配置节假日全天空闲',
  peakPeriodAt(MON_10, { holidays: ['2026-09-28'] }),
  'offPeak',
)
assert(
  '配置时段覆盖 [10,11)',
  [peakPeriodAt(MON_10, { peakWindows: [[10, 11]] }), peakPeriodAt(beijing('2026-09-28', 9, 30), { peakWindows: [[10, 11]] }), peakPeriodAt(MON_14, { peakWindows: [[10, 11]] })],
  ['peak', 'offPeak', 'offPeak'],
)
// 法定节假日日历自动抓取（timor.tech）：工作日节假日也判空闲，无需手填
assert(
  '国庆（周四 10:00）= 空闲',
  peakPeriodAt(beijing('2026-10-01', 10)),
  'offPeak',
)
assert(
  '中秋（周五 10:00）= 空闲',
  peakPeriodAt(beijing('2026-09-25', 10)),
  'offPeak',
)
assert(
  '节前普通周一 10:00 = 高峰（未被误判）',
  peakPeriodAt(beijing('2026-09-28', 10)),
  'peak',
)
assert(
  '节假日日历已入缓存',
  /holidays \d+ \(timor\.tech\)/.test(describePricing() ?? ''),
  true,
)

console.log('\n[3] 智谱官方价目（长度分档）')
{
  const g53 = resolve('glm-5.3', { input_tokens: K(10), output_tokens: K(1) }, MON_10, GLM_URL)
  assert('glm-5.3 ¥8/¥28 缓存读 ¥2 写 ¥8', g53 && rates(g53.cost, r), [8, 28, 2, 8])
  assert('  └ 出处 = 官网', g53?.source, 'docs.bigmodel.cn')

  const small = resolve('glm-4.5-air', { input_tokens: K(10), output_tokens: 100 }, MON_10, GLM_URL)
  assert('glm-4.5-air 输入<32K 输出<0.2K → ¥0.8/¥2', small && rates(small.cost, r), [0.8, 2, 0.16, 0.8])

  const longOut = resolve('glm-4.5-air', { input_tokens: K(10), output_tokens: 500 }, MON_10, GLM_URL)
  assert('glm-4.5-air 输入<32K 输出≥0.2K → ¥0.8/¥6', longOut && rates(longOut.cost, r), [0.8, 6, 0.16, 0.8])

  const bigIn = resolve('glm-4.5-air', { input_tokens: K(50), output_tokens: 500 }, MON_10, GLM_URL)
  assert('glm-4.5-air 输入 32K-128K → ¥1.2/¥8', bigIn && rates(bigIn.cost, r), [1.2, 8, 0.24, 1.2])

  const overflow = resolve('glm-4.5-air', { input_tokens: K(300), output_tokens: 500 }, MON_10, GLM_URL)
  assert('glm-4.5-air 超出最大区间 → 按最高档', overflow && rates(overflow.cost, r), [1.2, 8, 0.24, 1.2])

  const g51Small = resolve('glm-5.1', { input_tokens: K(10), output_tokens: K(1) }, MON_10, GLM_URL)
  assert('glm-5.1 输入<32K → ¥6/¥24', g51Small && rates(g51Small.cost, r), [6, 24, 1.3, 6])

  const g51Big = resolve('glm-5.1', { input_tokens: K(40), output_tokens: K(1) }, MON_10, GLM_URL)
  assert('glm-5.1 输入≥32K → ¥8/¥28', g51Big && rates(g51Big.cost, r), [8, 28, 2, 8])

  const cached = resolve(
    'glm-5.3',
    { input_tokens: K(1), cache_read_input_tokens: K(9), cache_creation_input_tokens: 0, output_tokens: K(1) },
    MON_10,
    GLM_URL,
  )
  assert('缓存命中的输入计入输入长度分档', cached && rates(cached.cost, r), [8, 28, 2, 8])
}

console.log('\n[4] 官网未列模型 → models.dev 目录兜底')
{
  const g46 = resolve('glm-4.6', { input_tokens: K(1), output_tokens: K(1) }, MON_10, GLM_URL)
  assert('glm-4.6 有价（目录）', g46 !== null, true)
  assert('  └ 出处 = 目录', g46?.source, 'models.dev/zhipuai')
}

console.log('\n[5] 未定价与覆盖')
{
  const fake = resolve('gpt-nonexistent-9', { input_tokens: K(1), output_tokens: K(1) }, MON_10, GLM_URL)
  assert('未知模型 → null（不套用别的模型费率）', fake, null)

  writeCredentials({
    models: { 'glm-5.3': { input: 1, output: 2, cacheRead: 0.5 } },
  })
  const overridden = resolve('glm-5.3', { input_tokens: K(1), output_tokens: K(1) }, MON_10, GLM_URL)
  assert('credentials.json 覆盖优先（¥1/¥2/缓存 ¥0.5）', overridden && rates(overridden.cost, r), [1, 2, 0.5, 1])
  assert('  └ 出处 = credentials.json', overridden?.source, 'credentials.json')

  writeCredentials({ usdCnyRate: 1 })
  assert('汇率可被配置覆盖', getUsdCnyRate(), 1)
}

console.log('\n[6] 缓存文件')
{
  const cache = JSON.parse(
    readFileSync(join(root, '.claude', 'cache', 'model-pricing.json'), 'utf-8'),
  ) as { fetchedAt: number; rate: number; official: Record<string, unknown>; catalog: Record<string, unknown> }
  assert('缓存含官网段', Object.keys(cache.official).sort(), ['deepseek', 'zhipu'])
  assert('缓存含目录段', Object.keys(cache.catalog), ['deepseek', 'zhipuai'])
  assert('缓存含汇率', typeof cache.rate, 'number')

  const before = cache.fetchedAt
  await refreshModelPricing()
  const after = JSON.parse(
    readFileSync(join(root, '.claude', 'cache', 'model-pricing.json'), 'utf-8'),
  ) as { fetchedAt: number }
  assert('TTL 内不重复抓取', after.fetchedAt, before)
}

console.log('\n[7] 会话绑定 provider 时家族别名落回 provider 模型')
{
  // Anthropic 家族别名（haiku/sonnet/opus/best/opusplan）在 provider 会话里没有
  // 分档语义：若按一号默认回落，请求会带着 Anthropic 模型名打到 provider 的
  // endpoint 且被 Anthropic 静态表定价（Explore 子代理 model:'haiku' 曾因此
  // 被按 $1/$5/$0.1 计成 ¥1.64，provider 实际只收 ¥0.16）。
  const { parseUserSpecifiedModel } = await import('../src/utils/model/model.js')
  for (const alias of ['haiku', 'sonnet', 'opus', 'best', 'opusplan', 'haiku[1m]']) {
    assert(
      `parseUserSpecifiedModel('${alias}') → 池模型`,
      parseUserSpecifiedModel(alias),
      'deepseek-flash',
    )
  }
  assert('非别名（全名）原样透传', parseUserSpecifiedModel('deepseek-v4-pro'), 'deepseek-v4-pro')
}

console.log(`\n通过 ${checks - failures}/${checks}`)
process.exit(failures === 0 ? 0 : 1)
