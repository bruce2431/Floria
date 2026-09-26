/**
 * 模型定价表 —— 单价一律取自厂商自己公布的价目页 / 社区目录，本文件不含任何
 * 硬编码价格数字（模型的峰谷时段规则是「规则」不是「价格」，内置且可配置覆盖）。
 *
 * 为什么要有这一层：`modelCost.ts` 的静态表只覆盖 Anthropic 官方模型，第三方
 * provider（deepseek / glm…）落到兜底分支会被套用 Anthropic 档费率，把
 * ¥0.15/M 的 flash 档按 Sonnet 档虚报十几倍。这里改成「按厂商官网真实价目计价」，
 * 查不到就返回 null（调用方标「未定价」），**绝不套用别的模型的费率**。
 *
 * 价源优先级（resolveModelCost）：
 *   1. credentials.json `pricing.models[模型]`  —— 用户按官方账单口径直接覆盖
 *   2. 厂商官网适配器（deepseek / 智谱，见 ADAPTERS）—— 最准，含峰谷/长度分档
 *   3. models.dev 目录（按 provider 映射）—— 兜底，单一价、无分档
 *   4. 都没有 → null
 *
 * 不变量：
 *   - 目录（models.dev）provider 节点没有 baseUrl 字段，无法由 endpoint 反查，
 *     因此 provider → 目录 id 的映射来自适配器声明或 `pricing.providers` 显式配置，
 *     不做跨 provider 的价格猜测。
 *   - 全 0 价目（订阅制套餐包）整段丢弃 —— 订阅计划不是按 token 计价，当成 0 元
 *     会显示成免费；宁可标「未定价」。
 *   - 拉取/解析失败保留上一份缓存（stale），永不因为网络问题丢掉可用价目。
 *   - 汇率缺失（无缓存、无配置、拉取失败）时不允许把 USD 价硬算成 ¥，USD 计价源
 *     视为不可用（返回 null）。
 *   - 本模块的同步读路径（resolveModelCost）只读内存 + 缓存文件，不做网络请求；
 *     网络只在启动时的 refreshModelPricing() 里发生（calculateUSDCost 在流式路径里
 *     被同步调用）。
 */

import { readFileSync } from 'fs'
import { mkdir, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import { z } from 'zod/v4'
import { loadCredentials, getActiveProviderConfig, getSessionProviderName } from './credentials/pool.js'
import type { PricingConfig } from './credentials/types.js'
import { logForDebugging } from './debug.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { safeParseJSON } from './json.js'
import type { ModelCosts } from './modelCost.js'
import { jsonStringify } from './slowOperations.js'

// ── 价源端点 ─────────────────────────────────────────────────────────────────

/** DeepSeek 官方价目页（Docusaurus 静态页，价表在 HTML 里） */
const DEEPSEEK_PRICING_URL =
  'https://api-docs.deepseek.com/zh-cn/quick_start/pricing'
const DEEPSEEK_SOURCE = 'api-docs.deepseek.com'

/** 智谱官方价目页（表格带 data-numeric，输入/输出各按长度分档） */
const ZHIPU_PRICING_URL = 'https://docs.bigmodel.cn/cn/guide/start/pricing'
const ZHIPU_SOURCE = 'docs.bigmodel.cn'

/** 社区目录（models.dev 全量目录，4.9MB，只保留需要的 provider 子树） */
const CATALOG_URL = 'https://models.dev/api.json'

/** 实时汇率（无需密钥） */
const FX_URL = 'https://open.er-api.com/v6/latest/USD'

/**
 * 中国法定节假日日历（含调休补班的标记，我们只取 holiday=true 的休息日）。
 * 厂商峰谷规则里的「法定节假日」按此判定——不做硬编码年份表，否则每年都要改码。
 */
const HOLIDAY_URL = (year: number) =>
  `https://timor.tech/api/holiday/year/${year}`
const HOLIDAY_SOURCE = 'timor.tech'

const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 30_000
const FETCH_ATTEMPTS = 3

/** DeepSeek 高峰时段（北京时间，周一至周五、非法定节假日）：9:00-12:00、14:00-18:00 */
const DEFAULT_PEAK_WINDOWS: ReadonlyArray<readonly [number, number]> = [
  [9, 12],
  [14, 18],
]

// ── 数据模型 ─────────────────────────────────────────────────────────────────

/** 某币种下的单价（每 100 万 token） */
export type Money = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

type Currency = 'CNY' | 'USD'

/**
 * 一档单价。厂商按「时段」或「请求长度」分档时产生多档；无分档规则的厂商
 * 只有一档且不带任何条件字段（`period`/`*K` 全部缺省 = 无条件适用）。
 */
type Tier = {
  /** 峰谷时段（仅声明了峰谷规则的厂商有此字段，目前仅 DeepSeek） */
  period?: 'peak' | 'offPeak'
  /** 输入长度区间（千 token，半开 [minK, maxK)）；缺省 = 该侧无界 */
  inputMinK?: number
  inputMaxK?: number
  /** 输出长度区间（千 token，半开 [minK, maxK)） */
  outputMinK?: number
  outputMaxK?: number
  money: Money
  currency: Currency
}

type ModelEntry = {
  /** 价格出处（展示在 /cost 溯源行） */
  source: string
  tiers: Tier[]
}

type Section = {
  source: string
  models: Record<string, ModelEntry>
}

type PricingTable = {
  fetchedAt: number
  /** USD → CNY；null = 未知 */
  rate: number | null
  /** 厂商官网价目，key = 适配器 id */
  official: Record<string, Section>
  /** 目录价目，key = models.dev provider id */
  catalog: Record<string, Section>
  /** 法定节假日（`YYYY-MM-DD`，升序）；缺省 = 未取到，只按周末判空闲 */
  holidays?: string[]
}

const MoneySchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
})

const TierSchema = z.object({
  period: z.enum(['peak', 'offPeak']).optional(),
  inputMinK: z.number().optional(),
  inputMaxK: z.number().optional(),
  outputMinK: z.number().optional(),
  outputMaxK: z.number().optional(),
  money: MoneySchema,
  currency: z.enum(['CNY', 'USD']),
})

const SectionSchema = z.object({
  source: z.string(),
  models: z.record(
    z.string(),
    z.object({ source: z.string(), tiers: z.array(TierSchema) }),
  ),
})

const TableSchema = z.object({
  fetchedAt: z.number(),
  rate: z.number().nullable(),
  official: z.record(z.string(), SectionSchema),
  catalog: z.record(z.string(), SectionSchema),
  holidays: z.array(z.string()).optional(),
})

// ── 适配器声明 ───────────────────────────────────────────────────────────────

type Adapter = {
  id: string
  /**
   * 匹配 provider baseUrl 的主机名后缀（api.deepseek.com / open.bigmodel.cn
   * 都命中各自的域名）。用域名而不是 provider 名：provider 名是用户随手起的。
   */
  hostSuffixes: string[]
  /** 该厂商在 models.dev 里的 provider id（目录兜底用，可被配置覆盖） */
  catalogId: string
  url: string
  source: string
  parse: (payload: string) => Record<string, ModelEntry>
}

const ADAPTERS: Adapter[] = [
  {
    id: 'deepseek',
    hostSuffixes: ['deepseek.com'],
    catalogId: 'deepseek',
    url: DEEPSEEK_PRICING_URL,
    source: DEEPSEEK_SOURCE,
    parse: parseDeepseek,
  },
  {
    id: 'zhipu',
    hostSuffixes: ['bigmodel.cn', 'zhipuai.cn'],
    catalogId: 'zhipuai',
    url: ZHIPU_PRICING_URL,
    source: ZHIPU_SOURCE,
    parse: parseZhipu,
  },
]

// ── HTML 小工具 ──────────────────────────────────────────────────────────────

function textOf(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 解析价目单元格：「1元」→ 1、「0.02元」→ 0.02、「免费」→ 0；非价格 → null */
function parseMoney(text: string): number | null {
  const t = text.replace(/[¥￥元,，\s]/g, '')
  if (t === '免费' || t === '免费。' || t === '-') return 0
  if (!/^[\d.]+$/.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

// ── DeepSeek 官方价目 ────────────────────────────────────────────────────────
//
// 表格形如：首行 `模型 | deepseek-flash | deepseek-v4-pro`，其后每行是
// `[rowspan 单元格…] 空闲时段/高峰时段 | 各模型单价值`。价格标签
// （百万tokens输入（缓存命中）/（缓存未命中）/百万tokens输出）带 rowspan，
// 只出现在该组首行，所以按行推进时把标签状态往下带。
//
// 该表把缓存写入按「未命中输入」计价：DeepSeek 不单列 cache write 单价。

function parseDeepseek(html: string): Record<string, ModelEntry> {
  const table = (html.match(/<table[\s\S]*?<\/table>/g) ?? []).find(t =>
    t.includes('deepseek-'),
  )
  if (!table) return {}

  const rows = [...table.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(row =>
    [...row[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => textOf(m[1])),
  )
  if (rows.length === 0) return {}

  // 首行第一格是 `模型` 标签，其余格是模型名（可能带 (1) 脚注上标）
  const models = rows[0]
    .slice(1)
    .map(c => c.replace(/\(\d+\)/g, '').trim().toLowerCase())
    .filter(Boolean)
  if (models.length === 0) return {}

  const totals = new Map<string, Money>()
  let metric: 'input' | 'output' | null = null
  let cacheHit: boolean | null = null

  for (const cells of rows.slice(1)) {
    for (const c of cells) {
      if (c.includes('百万tokens输入')) {
        metric = 'input'
        cacheHit = !c.includes('未命中')
      } else if (c.includes('百万tokens输出')) {
        metric = 'output'
        cacheHit = null
      }
    }
    // 只有价格行才同时带时段标签；并发限制等其它行在此被跳过
    const periodCell = cells.find(c => c.includes('空闲时段') || c.includes('高峰时段'))
    if (!periodCell || !metric) continue

    const values = cells.slice(-models.length).map(parseMoney)
    if (values.some(v => v === null)) continue

    const period = periodCell.includes('高峰时段') ? 'peak' : 'offPeak'
    models.forEach((name, i) => {
      const value = values[i] as number
      const key = `${name}|${period}`
      const money =
        totals.get(key) ??
        ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } satisfies Money)
      if (metric === 'output') money.output = value
      else if (cacheHit) money.cacheRead = value
      else {
        money.input = value
        money.cacheWrite = value
      }
      totals.set(key, money)
    })
  }

  const out: Record<string, ModelEntry> = {}
  for (const [key, money] of totals) {
    const [name, period] = key.split('|') as [string, 'peak' | 'offPeak']
    const entry = (out[name] ??= { source: DEEPSEEK_SOURCE, tiers: [] })
    entry.tiers.push({ period, money, currency: 'CNY' })
  }
  return out
}

// ── 智谱官方价目 ─────────────────────────────────────────────────────────────
//
// 表格列：模型名称 | 上下文 | 输入单价 | 输出单价 | 缓存存储 | 缓存命中 | 输入模态
// 「上下文」列同时编码了分档条件，形如：
//   输入 [0, 32K)，输出 [0, 0.2K) / 输入 [0, 32K)，输出 ≥0.2K / 输入 [32K, 200K)
//   输入长度 [0, 32K) / 输入长度 ≥32K / 128K / 1M / —
// 纯数字带单位（128K/1M）是上下文上限而非价格档，不产生区间约束。
//
// 缓存存储是「元/百万 token/小时」的存储费，不在 token 用量里，无法计量：
// 该部分少算（智谱的「未命中缓存输入费用」已在输入单价里，故 cacheWrite=输入价）。

/** 「32K」「1M」「0.2K」→ 千 token 数 */
function toK(value: string, unit: string): number {
  const n = Number(value)
  return unit.toUpperCase() === 'M' ? n * 1000 : n
}

/**
 * 从「上下文」格里的条件文本解出该侧长度区间（千 token，半开）。
 * 官方写法三类：`输入长度 [0, 32K)`、`输入长度 ≥32K`、`输入 [0, 32K)，输出 [0, 0.2K)`；
 * 只有上下文容量（如 `1M`/`128K`）时该侧无界，返回空对象。
 * 键名按侧区分（input/output），否则输入条件会被输出条件覆盖。
 */
function parseBounds(
  cond: string,
  label: '输入' | '输出',
): { inputMinK?: number; inputMaxK?: number; outputMinK?: number; outputMaxK?: number } {
  const keyMin = label === '输入' ? 'inputMinK' : 'outputMinK'
  const keyMax = label === '输入' ? 'inputMaxK' : 'outputMaxK'
  const bracketed = new RegExp(
    `${label}(?:长度)?\\s*[\\[［]\\s*([\\d.]+)\\s*([KM]?)\\s*[,，]\\s*([\\d.]+)\\s*([KM]?)\\s*[)\\）]`,
  ).exec(cond)
  if (bracketed) {
    return {
      [keyMin]: toK(bracketed[1], bracketed[2]),
      [keyMax]: toK(bracketed[3], bracketed[4]),
    }
  }
  const lower = new RegExp(
    `${label}(?:长度)?\\s*[≥>]\\s*([\\d.]+)\\s*([KM]?)`,
  ).exec(cond)
  if (lower) return { [keyMin]: toK(lower[1], lower[2]) }
  return {}
}

function parseZhipu(html: string): Record<string, ModelEntry> {
  const out: Record<string, ModelEntry> = {}

  for (const table of html.match(/<table[\s\S]*?<\/table>/g) ?? []) {
    const head = [...table.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map(m =>
      textOf(m[1]),
    )
    const iModel = head.findIndex(h => h.includes('模型名称'))
    const iCond = head.findIndex(h => h.includes('上下文'))
    const iIn = head.findIndex(h => h.includes('输入单价'))
    const iOut = head.findIndex(h => h.includes('输出单价'))
    const iHit = head.findIndex(h => h.includes('缓存命中'))
    if (iModel < 0 || iIn < 0 || iOut < 0) continue

    const body = /<tbody[\s\S]*?<\/tbody>/.exec(table)?.[0] ?? table
    for (const row of body.match(/<tr[\s\S]*?<\/tr>/g) ?? []) {
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m =>
        textOf(m[1]),
      )
      if (cells.length <= Math.max(iIn, iOut)) continue

      const name = cells[iModel]?.toLowerCase().replace(/\s+/g, '')
      const input = parseMoney(cells[iIn] ?? '')
      const output = parseMoney(cells[iOut] ?? '')
      if (!name || input === null || output === null) continue

      const cond = iCond >= 0 ? (cells[iCond] ?? '') : ''
      const cacheRead = iHit >= 0 ? (parseMoney(cells[iHit] ?? '') ?? 0) : 0
      const entry = (out[name] ??= { source: ZHIPU_SOURCE, tiers: [] })
      entry.tiers.push({
        ...parseBounds(cond, '输入'),
        ...parseBounds(cond, '输出'),
        money: {
          input,
          output,
          cacheRead,
          // 智谱未单列缓存写入价，未命中缓存的输入即按输入单价计
          cacheWrite: input,
        },
        currency: 'CNY',
      })
    }
  }
  return out
}

// ── models.dev 目录（兜底）──────────────────────────────────────────────────

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseCatalog(
  payload: unknown,
  ids: readonly string[],
): Record<string, Section> {
  const out: Record<string, Section> = {}
  if (!payload || typeof payload !== 'object') return out
  const root = payload as Record<string, unknown>

  for (const id of ids) {
    const provider = root[id] as { models?: Record<string, unknown> } | undefined
    const models = provider?.models
    if (!models || typeof models !== 'object') continue

    const section: Section = { source: `models.dev/${id}`, models: {} }
    let anyPriced = false
    for (const [name, raw] of Object.entries(models)) {
      const cost = (raw as { cost?: Record<string, unknown> } | null)?.cost
      if (!cost || typeof cost !== 'object') continue
      const input = num(cost.input)
      const output = num(cost.output)
      if (input === null || output === null) continue
      if (input > 0 || output > 0) anyPriced = true
      section.models[name.toLowerCase()] = {
        source: section.source,
        tiers: [
          {
            money: {
              input,
              output,
              cacheRead: num(cost.cache_read) ?? 0,
              cacheWrite: num(cost.cache_write) ?? input,
            },
            currency: 'USD',
          },
        ],
      }
    }

    // 全 0 = 订阅制套餐包（zhipuai-coding-plan 之类），不是按 token 计价
    if (!anyPriced) {
      logForDebugging(
        `[modelPricing] catalog provider ${id} 全 0 价，按订阅制丢弃`,
      )
      continue
    }
    if (Object.keys(section.models).length > 0) out[id] = section
  }
  return out
}

// ── 网络 ─────────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 带超时 + 指数退避重试的取文本。不复用 WebSearchTool 的 fetchJson：那是
 * JSON 专用且无重试，且 utils 层依赖 tools 层会反向耦合。
 */
async function fetchText(label: string, url: string): Promise<string | null> {
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(url, { signal: controller.signal })
      if (response.ok) return await response.text()
      logForDebugging(
        `[modelPricing] ${label} HTTP ${response.status}（第 ${attempt} 次）`,
      )
    } catch (error) {
      logForDebugging(
        `[modelPricing] ${label} 请求失败（第 ${attempt} 次）：${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      clearTimeout(timer)
    }
    if (attempt < FETCH_ATTEMPTS) await sleep(500 * 2 ** (attempt - 1))
  }
  return null
}

async function fetchFxRate(): Promise<number | null> {
  const text = await fetchText('fx', FX_URL)
  if (!text) return null
  try {
    const rate = (JSON.parse(text) as { rates?: { CNY?: unknown } }).rates?.CNY
    return typeof rate === 'number' && rate > 0 ? rate : null
  } catch {
    return null
  }
}

/**
 * 解析节假日接口。返回 `holiday === true` 的日期（法定休息日）；调休补班的周末
 * （`holiday === false`）不计入——峰谷规则里的「法定节假日」不含补班日，补班周末
 * 仍由周末规则判空闲。
 */
function parseHolidays(text: string): string[] {
  const payload = safeParseJSON(text, false) as {
    holiday?: Record<string, { holiday?: boolean; date?: unknown }>
  } | null
  const entries = payload?.holiday
  if (!entries || typeof entries !== 'object') return []
  return Object.values(entries)
    .filter(e => e?.holiday === true && typeof e.date === 'string')
    .map(e => e.date as string)
    .sort()
}

// ── 缓存 ─────────────────────────────────────────────────────────────────────

function cachePath(): string {
  return join(getClaudeConfigHomeDir(), 'cache', 'model-pricing.json')
}

let cachedTable: PricingTable | null = null
let loaded = false

function loadTable(): PricingTable | null {
  if (loaded) return cachedTable
  loaded = true
  try {
    const raw = readFileSync(cachePath(), 'utf-8')
    const parsed = TableSchema.safeParse(safeParseJSON(raw, false))
    cachedTable = parsed.success ? parsed.data : null
    if (!parsed.success) {
      logForDebugging('[modelPricing] 缓存格式不合法，按无缓存处理')
    }
  } catch {
    cachedTable = null
  }
  return cachedTable
}

async function saveTable(table: PricingTable): Promise<void> {
  const path = cachePath()
  const tmp = `${path}.tmp`
  await mkdir(join(getClaudeConfigHomeDir(), 'cache'), { recursive: true })
  await writeFile(tmp, jsonStringify(table), { encoding: 'utf-8', mode: 0o600 })
  await rename(tmp, path)
  cachedTable = table
  loaded = true
}

// ── 配置与路由 ───────────────────────────────────────────────────────────────

export function pricingConfig(): PricingConfig {
  return loadCredentials().pricing ?? {}
}

type Route = {
  officialId: string | null
  catalogId: string | null
}

function adapterFor(baseUrl: string | null): Adapter | null {
  if (!baseUrl) return null
  let host: string
  try {
    host = new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return null
  }
  return (
    ADAPTERS.find(a =>
      a.hostSuffixes.some(s => host === s || host.endsWith(`.${s}`)),
    ) ?? null
  )
}

function routeProvider(
  providerKey: string,
  baseUrl: string | null,
  cfg: PricingConfig,
): Route {
  const adapter = adapterFor(baseUrl)
  return {
    officialId: adapter?.id ?? null,
    catalogId:
      cfg.providers?.[providerKey]?.source ??
      adapter?.catalogId ??
      providerKey ??
      null,
  }
}

/** 当前会话 provider 下的全部生效路由（refresh 用它决定抓哪几份价源） */
function activeRoutes(): { key: string; baseUrl: string | null; route: Route }[] {
  const cfg = pricingConfig()
  const creds = loadCredentials()
  const key = getSessionProviderName()
  const baseUrl = getActiveProviderConfig()?.baseUrl ?? null
  const routes = [{ key, baseUrl, route: routeProvider(key, baseUrl, cfg) }]
  // 其它已配置 provider 的官网价目也一并刷新：同一份缓存文件被所有会话/进程共用，
  // 换 provider 后不必等下一轮 TTL 才有价。
  for (const [name, provider] of Object.entries(creds.providers)) {
    if (name === key) continue
    routes.push({
      key: name,
      baseUrl: provider.baseUrl ?? null,
      route: routeProvider(name, provider.baseUrl ?? null, cfg),
    })
  }
  return routes
}

// ── 峰谷规则（DeepSeek）──────────────────────────────────────────────────────

/** 北京时间 = UTC+8；返回该时刻处于高峰还是空闲时段。 */
export function peakPeriodAt(
  atMs: number,
  cfg: PricingConfig = {},
): 'peak' | 'offPeak' {
  const beijing = new Date(atMs + 8 * 60 * 60 * 1000)
  const weekday = beijing.getUTCDay()
  if (weekday === 0 || weekday === 6) return 'offPeak'
  // 法定节假日：自动抓取的日历 ∪ 配置手填（手填可用于接口漏登/临时放假）
  const today = beijing.toISOString().slice(0, 10)
  if (cfg.holidays?.includes(today) || loadTable()?.holidays?.includes(today)) {
    return 'offPeak'
  }
  const hour =
    beijing.getUTCHours() + beijing.getUTCMinutes() / 60 + beijing.getUTCSeconds() / 3600
  const windows = cfg.peakWindows ?? DEFAULT_PEAK_WINDOWS
  for (const [start, end] of windows) {
    if (hour >= start && hour < end) return 'peak'
  }
  return 'offPeak'
}

// ── 解析 ─────────────────────────────────────────────────────────────────────

function inRange(value: number, min?: number, max?: number): boolean {
  if (min !== undefined && value < min) return false
  if (max !== undefined && value >= max) return false
  return true
}

function tierMatches(
  tier: Tier,
  inputK: number,
  outputK: number,
): boolean {
  return (
    inRange(inputK, tier.inputMinK, tier.inputMaxK) &&
    inRange(outputK, tier.outputMinK, tier.outputMaxK)
  )
}

function pickTier(
  tiers: readonly Tier[],
  inputK: number,
  outputK: number,
  period: 'peak' | 'offPeak' | undefined,
): Tier | null {
  const scoped = tiers.some(t => t.period)
    ? tiers.filter(t => t.period === period)
    : tiers
  if (scoped.length === 0) return null
  const exact = scoped.find(t => tierMatches(t, inputK, outputK))
  if (exact) return exact
  // 官方表未列更高档（请求超出最大已列区间）：按最高档计
  return (
    [...scoped].sort(
      (a, b) =>
        (a.inputMinK ?? 0) - (b.inputMinK ?? 0) ||
        (a.outputMinK ?? 0) - (b.outputMinK ?? 0),
    )[scoped.length - 1] ?? null
  )
}

/** 原币单价 → 内部计价单位 ModelCosts（USD / 百万 token） */
function toCosts(tier: Tier, rate: number | null): ModelCosts | null {
  const divisor = tier.currency === 'CNY' ? rate : 1
  if (!divisor) return null
  return {
    inputTokens: tier.money.input / divisor,
    outputTokens: tier.money.output / divisor,
    promptCacheWriteTokens: tier.money.cacheWrite / divisor,
    promptCacheReadTokens: tier.money.cacheRead / divisor,
    webSearchRequests: 0,
  }
}

export type ResolvedCost = {
  cost: ModelCosts
  /** 价格出处，/cost 溯源用 */
  source: string
}

export type UsageLike = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

/**
 * 解析某模型在该时刻的单价。同步、纯内存/缓存读，无网络。
 * 返回 null = 未定价（调用方标「未定价」并按 0 计，绝不套用别的模型费率）。
 */
export function resolveModelCost(
  providerKey: string,
  baseUrl: string | null,
  model: string,
  usage: UsageLike,
  atMs: number,
): ResolvedCost | null {
  const cfg = pricingConfig()
  const table = loadTable()
  const rate = cfg.usdCnyRate ?? table?.rate ?? null
  const name = model.toLowerCase()
  const route = routeProvider(providerKey, baseUrl, cfg)

  // 1. 用户覆盖（人民币/百万 token，照官方账单口径填写）
  const override = cfg.models?.[name]
  if (override) {
    const money: Money = {
      input: override.input,
      output: override.output,
      cacheRead: override.cacheRead ?? override.input,
      cacheWrite: override.cacheWrite ?? override.input,
    }
    const cost = toCosts({ money, currency: 'CNY' }, rate)
    if (cost) return { cost, source: 'credentials.json' }
  }

  // 2/3. 厂商官网 → 目录
  const sources: [ModelEntry | undefined, string][] = [
    [
      table?.official[route.officialId ?? '']?.models[name],
      table?.official[route.officialId ?? '']?.source ?? route.officialId ?? '官网',
    ],
    [
      table?.catalog[route.catalogId ?? '']?.models[name],
      table?.catalog[route.catalogId ?? '']?.source ?? route.catalogId ?? '目录',
    ],
  ]
  const inputK =
    (usage.input_tokens +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0)) /
    1000
  const outputK = usage.output_tokens / 1000

  for (const [entry, source] of sources) {
    if (!entry || entry.tiers.length === 0) continue
    // 只有声明了时段的价目（DeepSeek）才按当前时段选档；其余厂商单一价
    const period = entry.tiers.some(t => t.period)
      ? peakPeriodAt(atMs, cfg)
      : undefined
    const tier = pickTier(entry.tiers, inputK, outputK, period)
    if (!tier) continue
    const cost = toCosts(tier, rate)
    if (cost) return { cost, source }
  }

  return null
}

/** 当前会话 provider 下某模型的单价 */
export function resolveSessionModelCost(
  model: string,
  usage: UsageLike,
  atMs: number,
): ResolvedCost | null {
  return resolveModelCost(
    getSessionProviderName(),
    getActiveProviderConfig()?.baseUrl ?? null,
    model,
    usage,
    atMs,
  )
}

// ── 对外查询 ─────────────────────────────────────────────────────────────────

/** USD → CNY 汇率；null = 未知（不允许硬算 ¥） */
export function getUsdCnyRate(): number | null {
  const override = pricingConfig().usdCnyRate
  if (typeof override === 'number' && override > 0) return override
  return loadTable()?.rate ?? null
}

/** /cost 溯源行：价源清单 + 汇率 + 缓存时间 */
export function describePricing(): string | null {
  const table = loadTable()
  if (!table) return null
  const sources = [
    ...Object.values(table.official).map(s => s.source),
    ...Object.values(table.catalog).map(s => s.source),
  ]
  const rate = getUsdCnyRate()
  return (
    `Prices: ${sources.length > 0 ? sources.join(', ') : 'none'}` +
    (rate ? ` · USD→CNY ${rate.toFixed(4)}` : ' · USD→CNY unknown') +
    (table.holidays
      ? ` · holidays ${table.holidays.length} (${HOLIDAY_SOURCE})`
      : ' · holidays unknown') +
    ` · cached ${new Date(table.fetchedAt).toLocaleString('zh-CN')}`
  )
}

// ── 刷新 ─────────────────────────────────────────────────────────────────────

let refreshing: Promise<void> | null = null

/**
 * 启动时后台刷新（非阻塞）。TTL 内直接用缓存；任何失败都保留 stale 缓存。
 */
export function refreshModelPricing(): Promise<void> {
  refreshing ??= doRefresh().finally(() => {
    refreshing = null
  })
  return refreshing
}

async function doRefresh(): Promise<void> {
  try {
    const cached = loadTable()
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return

    const cfg = pricingConfig()
    const routes = activeRoutes()
    const officialIds = [
      ...new Set(routes.map(r => r.route.officialId).filter(Boolean)),
    ] as string[]
    const catalogIds = [
      ...new Set(routes.map(r => r.route.catalogId).filter(Boolean)),
    ] as string[]

    // 当年 + 次年：跨年会话（12 月跑进 1 月）也要有表可用
    const holidayYears = [new Date().getFullYear(), new Date().getFullYear() + 1]
    const [fx, catalogPayload, holidayPayloads, ...officialPayloads] =
      await Promise.all([
        fetchFxRate(),
        catalogIds.length > 0 ? fetchText('catalog', CATALOG_URL) : null,
        Promise.all(
          holidayYears.map(y => fetchText('holiday', HOLIDAY_URL(y))),
        ),
        ...ADAPTERS.filter(a => officialIds.includes(a.id)).map(a =>
          fetchText(a.id, a.url),
        ),
      ])

    const official: Record<string, Section> = { ...cached?.official }
    ADAPTERS.filter(a => officialIds.includes(a.id)).forEach((adapter, i) => {
      const payload = officialPayloads[i]
      const models = payload ? adapter.parse(payload) : {}
      // 解析失败（页面改版/网络中断）不覆盖上一份可用价目
      if (Object.keys(models).length === 0) {
        logForDebugging(`[modelPricing] ${adapter.id} 官网价目解析为空，保留旧值`)
        return
      }
      official[adapter.id] = { source: adapter.source, models }
    })

    let catalog: Record<string, Section> = { ...cached?.catalog }
    if (catalogPayload) {
      let parsed: unknown = null
      try {
        parsed = JSON.parse(catalogPayload)
      } catch {
        parsed = null
      }
      const sections = parseCatalog(parsed, catalogIds)
      if (Object.keys(sections).length > 0) {
        catalog = { ...catalog, ...sections }
      }
    }

    // 取不到（接口挂/解析空）时保留上一份，不要用空表把已知节假日抹掉
    const fetchedHolidays = holidayPayloads.flatMap(p =>
      p ? parseHolidays(p) : [],
    )
    const holidays =
      fetchedHolidays.length > 0 ? [...new Set(fetchedHolidays)].sort() : cached?.holidays

    const next: PricingTable = {
      fetchedAt: Date.now(),
      rate: cfg.usdCnyRate ?? fx ?? cached?.rate ?? null,
      official,
      catalog,
      ...(holidays ? { holidays } : {}),
    }
    await saveTable(next)
    logForDebugging(
      `[modelPricing] 价目已更新：官网 ${Object.keys(official).join(',') || '无'}；目录 ${Object.keys(catalog).join(',') || '无'}；汇率 ${next.rate ?? '未知'}；节假日 ${next.holidays?.length ?? 0} 天（${HOLIDAY_SOURCE}）`,
    )
  } catch (error) {
    logForDebugging(
      `[modelPricing] 刷新失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

