import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import chalk from 'chalk'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  addToTotalCostState,
  addToTotalLinesChanged,
  getCostCounter,
  getModelUsage,
  getSdkBetas,
  getSessionId,
  getTokenCounter,
  getTotalAPIDuration,
  getTotalAPIDurationWithoutRetries,
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalCostUSD,
  getTotalDuration,
  getTotalInputTokens,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalOutputTokens,
  getTotalToolDuration,
  getTotalWebSearchRequests,
  getUnpricedModels,
  getUsageForModel,
  hasUnknownModelCost,
  resetCostState,
  resetStateForTests,
  setCostStateForRestore,
} from './bootstrap/state.js'
import type { ModelUsage } from './entrypoints/agentSdkTypes.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from './services/analytics/index.js'
import { getAdvisorUsage } from './utils/advisor.js'
import { getCurrentProjectConfig } from './utils/config.js'
import {
  getContextWindowForModel,
  getModelMaxOutputTokens,
} from './utils/context.js'
import { isFastModeEnabled } from './utils/fastMode.js'
import { formatDuration, formatNumber } from './utils/format.js'
import type { FpsMetrics } from './utils/fpsTracker.js'
import { getCanonicalName } from './utils/model/model.js'
import { calculateUSDCost } from './utils/modelCost.js'
import { describePricing, getUsdCnyRate } from './utils/modelPricing.js'
import { getTranscriptPathForSession } from './utils/sessionStorage.js'
export {
  getTotalCostUSD as getTotalCost,
  getTotalDuration,
  getTotalAPIDuration,
  getTotalAPIDurationWithoutRetries,
  addToTotalLinesChanged,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalInputTokens,
  getTotalOutputTokens,
  getTotalCacheReadInputTokens,
  getTotalCacheCreationInputTokens,
  getTotalWebSearchRequests,
  formatCost,
  hasUnknownModelCost,
  resetStateForTests,
  resetCostState,
  getModelUsage,
  getUsageForModel,
}

type StoredCostState = {
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  lastDuration: number | undefined
  modelUsage: { [modelName: string]: ModelUsage } | undefined
}

type LastCallUsage = {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

// Usage of the most recent primary (non-advisor) API call, used to report
// the "this turn" cache hit rate. Advisor usage is excluded so this reflects
// the actual main-model request, not a background classifier.
let lastCallUsage: LastCallUsage | undefined

/**
 * 会话累计用量的**唯一来源**：该会话的转录。
 *
 * 转录是既有权威记录（append-only，会话结束/进程被杀都不会丢），assistant 记录上
 * 直接带着该次 API 响应的 `message.usage`。于是「这个会话花了多少」是**派生值**——
 * 不需要任何落盘计数器，也就不存在「恢复源被别的会话顶掉」「退出钩子没跑成整段丢账」
 * 这类问题（2026-09-26 的 ¥5.04 → ¥0.0x 即此）。
 *
 * 两个必须带上的细节：
 * - **流式会为同一个 `message.id` 写多条记录**（快照），逐字段取最大即终值；
 *   不去重会重复计（曾据此误判「转录求和会高估」）。
 * - **子代理转录在 `<sessionId>/subagents/**` 下**，与主转录无交集，必须一并扫；
 *   子代理的 API 调用同样计入本进程的成本状态。
 *
 * 非派生项（API/tool 时长、行数）转录里没有，一律归 0：它们是进程生命周期的量，
 * 随恢复后的新回合重新累计。
 *
 * 计价口径与实时累加**同一条**（`calculateUSDCost`，含静态表 / 厂商官网 / 目录 /
 * 未定价）。峰谷档按**派生时刻**判定，即整段历史统一按当前时段计价——跨峰谷边界的
 * 会话会有档位差（DeepSeek 空闲/高峰 2 倍），这是个刻意保留的近似：换回逐条按
 * 记录时间戳计价要在静态表与动态价之间再分一条岔路。
 */
export function deriveCostStateFromTranscript(
  sessionId: string,
): StoredCostState | undefined {
  const transcriptPath = getTranscriptPathForSession(sessionId)
  if (!existsSync(transcriptPath)) {
    return undefined
  }

  const byMessageId = new Map<string, { model: string; usage: Usage }>()
  scanAssistantUsage(transcriptPath, byMessageId)
  for (const file of listSubagentTranscripts(
    join(dirname(transcriptPath), sessionId, 'subagents'),
  )) {
    scanAssistantUsage(file, byMessageId)
  }
  if (byMessageId.size === 0) {
    return undefined
  }

  const modelUsage: { [modelName: string]: ModelUsage } = {}
  let totalCostUSD = 0
  for (const { model, usage } of byMessageId.values()) {
    const costUSD = calculateUSDCost(model, usage)
    const acc = (modelUsage[model] ??= {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      webSearchRequests: 0,
      costUSD: 0,
      contextWindow: 0,
      maxOutputTokens: 0,
    })
    acc.inputTokens += usage.input_tokens ?? 0
    acc.outputTokens += usage.output_tokens ?? 0
    acc.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0
    acc.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0
    acc.webSearchRequests += usage.server_tool_use?.web_search_requests ?? 0
    acc.costUSD += costUSD
    totalCostUSD += costUSD
  }
  for (const [model, acc] of Object.entries(modelUsage)) {
    acc.contextWindow = getContextWindowForModel(model, getSdkBetas())
    acc.maxOutputTokens = getModelMaxOutputTokens(model).default
  }

  return {
    totalCostUSD,
    totalAPIDuration: 0,
    totalAPIDurationWithoutRetries: 0,
    totalToolDuration: 0,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    lastDuration: undefined,
    modelUsage,
  }
}

const USAGE_TOKEN_KEYS = [
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
] as const

/** 把一个转录文件里的 assistant `usage` 折进 `byMessageId`（按 message.id 去重）。 */
function scanAssistantUsage(
  filePath: string,
  byMessageId: Map<string, { model: string; usage: Usage }>,
): void {
  let text: string
  try {
    text = readFileSync(filePath, 'utf8')
  } catch {
    return
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let record: { type?: string; message?: { id?: string; model?: string; usage?: Usage } }
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const message = record.message
    if (record.type !== 'assistant' || !message?.id || !message.usage) continue

    const prev = byMessageId.get(message.id)
    if (!prev) {
      byMessageId.set(message.id, {
        model: message.model ?? 'unknown',
        usage: { ...message.usage },
      })
      continue
    }
    for (const key of USAGE_TOKEN_KEYS) {
      prev.usage[key] = Math.max(prev.usage[key] ?? 0, message.usage[key] ?? 0)
    }
    const webSearch = message.usage.server_tool_use?.web_search_requests ?? 0
    if (webSearch > (prev.usage.server_tool_use?.web_search_requests ?? 0)) {
      prev.usage.server_tool_use = {
        ...prev.usage.server_tool_use,
        web_search_requests: webSearch,
      }
    }
  }
}

/** 递归列出子代理转录（`subagents/**` 下可能还有 workflow 等子目录）。 */
function listSubagentTranscripts(dir: string): string[] {
  if (!existsSync(dir)) return []
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...listSubagentTranscripts(path))
    } else if (entry.name.endsWith('.jsonl')) {
      files.push(path)
    }
  }
  return files
}

/**
 * Restores cost state when resuming a session: derive it from the transcript.
 * @returns true if the transcript exists and had assistant responses
 */
export function restoreCostStateForSession(sessionId: string): boolean {
  const data = deriveCostStateFromTranscript(sessionId)
  if (!data) {
    return false
  }
  setCostStateForRestore(data)
  return true
}

/**
 * 内部计价单位是美元（见 utils/modelCost.ts），展示时按实时汇率折成人民币。
 * 汇率未知时不硬算：退回美元原值并由 formatTotalCost 尾注说明。
 */
function formatCost(cost: number, maxDecimalPlaces: number = 4): string {
  const rate = getUsdCnyRate()
  const amount = rate === null ? cost : cost * rate
  const symbol = rate === null ? '$' : '¥'
  return `${symbol}${amount > 0.5 ? round(amount, 100).toFixed(2) : amount.toFixed(maxDecimalPlaces)}`
}

function formatModelUsage(): string {
  const modelUsageMap = getModelUsage()
  if (Object.keys(modelUsageMap).length === 0) {
    return 'Usage:                 0 input, 0 output, 0 cache read, 0 cache write'
  }
  const unpriced = new Set(getUnpricedModels())
  // Accumulate usage by short name
  const usageByShortName: { [shortName: string]: ModelUsage } = {}
  for (const [model, usage] of Object.entries(modelUsageMap)) {
    const shortName = getCanonicalName(model)
    if (!usageByShortName[shortName]) {
      usageByShortName[shortName] = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0,
        contextWindow: 0,
        maxOutputTokens: 0,
      }
    }
    const accumulated = usageByShortName[shortName]
    accumulated.inputTokens += usage.inputTokens
    accumulated.outputTokens += usage.outputTokens
    accumulated.cacheReadInputTokens += usage.cacheReadInputTokens
    accumulated.cacheCreationInputTokens += usage.cacheCreationInputTokens
    accumulated.webSearchRequests += usage.webSearchRequests
    accumulated.costUSD += usage.costUSD
  }

  let result = 'Usage by model:'
  for (const [shortName, usage] of Object.entries(usageByShortName)) {
    const usageString =
      `  ${formatNumber(usage.inputTokens)} input, ` +
      `${formatNumber(usage.outputTokens)} output, ` +
      `${formatNumber(usage.cacheReadInputTokens)} cache read, ` +
      `${formatNumber(usage.cacheCreationInputTokens)} cache write` +
      (usage.webSearchRequests > 0
        ? `, ${formatNumber(usage.webSearchRequests)} web search`
        : '') +
      (unpriced.has(shortName)
        ? ' (unpriced)'
        : ` (${formatCost(usage.costUSD)})`)
    result += `\n` + `${shortName}:`.padStart(21) + usageString
  }
  return result
}

function hitRateNumber(
  cacheRead: number,
  input: number,
  cacheCreation: number,
): number | null {
  const total = input + cacheRead + cacheCreation
  if (total <= 0) {
    return null
  }
  return (cacheRead / total) * 100
}

function hitRate(cacheRead: number, input: number, cacheCreation: number): string {
  const percent = hitRateNumber(cacheRead, input, cacheCreation)
  return percent === null ? '–' : `${percent.toFixed(1)}%`
}

/**
 * Cache hit rates in percent (0-100). `turn` is the most recent primary API
 * call, `session` is the whole session. null when there is no data yet.
 */
export function getCacheHitRates(): {
  turn: number | null
  session: number | null
} {
  const session = hitRateNumber(
    getTotalCacheReadInputTokens(),
    getTotalInputTokens(),
    getTotalCacheCreationInputTokens(),
  )
  const turn = lastCallUsage
    ? hitRateNumber(
        lastCallUsage.cacheRead,
        lastCallUsage.input,
        lastCallUsage.cacheCreation,
      )
    : null
  return { turn, session }
}

function formatCacheStats(): string {
  const sessionInput = getTotalInputTokens()
  const sessionRead = getTotalCacheReadInputTokens()
  const sessionCreate = getTotalCacheCreationInputTokens()
  const sessionHit = hitRate(sessionRead, sessionInput, sessionCreate)
  const thisHit = lastCallUsage
    ? hitRate(
        lastCallUsage.cacheRead,
        lastCallUsage.input,
        lastCallUsage.cacheCreation,
      )
    : '–'

  return (
    `Cache hit:             ${thisHit} this turn · ${sessionHit} session avg\n` +
    `Session tokens:         ${formatNumber(sessionInput)} in · ` +
    `${formatNumber(getTotalOutputTokens())} out · ` +
    `${formatNumber(sessionRead)} cache read · ` +
    `${formatNumber(sessionCreate)} cache write`
  )
}

export function formatTotalCost(): string {
  const unpriced = getUnpricedModels()
  const rate = getUsdCnyRate()
  const costDisplay =
    formatCost(getTotalCostUSD()) +
    (hasUnknownModelCost()
      ? ` (excludes ${unpriced.join(', ')} — no price published)`
      : '')

  const modelUsageDisplay = formatModelUsage()
  const cacheStats = formatCacheStats()
  const pricingInfo =
    describePricing() ??
    'Prices:            vendor price pages not fetched yet'
  const rateNote =
    rate === null ? ' (USD→CNY rate unknown — amounts in USD)' : ''

  return chalk.dim(
    `Total cost:            ${costDisplay}${rateNote}\n` +
      `Total duration (API):  ${formatDuration(getTotalAPIDuration())}
Total duration (wall): ${formatDuration(getTotalDuration())}
Total code changes:    ${getTotalLinesAdded()} ${getTotalLinesAdded() === 1 ? 'line' : 'lines'} added, ${getTotalLinesRemoved()} ${getTotalLinesRemoved() === 1 ? 'line' : 'lines'} removed
${cacheStats}
${modelUsageDisplay}
${pricingInfo}`,
  )
}

function round(number: number, precision: number): number {
  return Math.round(number * precision) / precision
}

function addToTotalModelUsage(
  cost: number,
  usage: Usage,
  model: string,
): ModelUsage {
  const modelUsage = getUsageForModel(model) ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow: 0,
    maxOutputTokens: 0,
  }

  modelUsage.inputTokens += usage.input_tokens
  modelUsage.outputTokens += usage.output_tokens
  modelUsage.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0
  modelUsage.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0
  modelUsage.webSearchRequests +=
    usage.server_tool_use?.web_search_requests ?? 0
  modelUsage.costUSD += cost
  modelUsage.contextWindow = getContextWindowForModel(model, getSdkBetas())
  modelUsage.maxOutputTokens = getModelMaxOutputTokens(model).default
  return modelUsage
}

export function addToTotalSessionCost(
  cost: number,
  usage: Usage,
  model: string,
  isAdvisor = false,
): number {
  if (!isAdvisor) {
    lastCallUsage = {
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheCreation: usage.cache_creation_input_tokens ?? 0,
    }
  }
  const modelUsage = addToTotalModelUsage(cost, usage, model)
  addToTotalCostState(cost, modelUsage, model)

  const attrs =
    isFastModeEnabled() && usage.speed === 'fast'
      ? { model, speed: 'fast' }
      : { model }

  getCostCounter()?.add(cost, attrs)
  getTokenCounter()?.add(usage.input_tokens, { ...attrs, type: 'input' })
  getTokenCounter()?.add(usage.output_tokens, { ...attrs, type: 'output' })
  getTokenCounter()?.add(usage.cache_read_input_tokens ?? 0, {
    ...attrs,
    type: 'cacheRead',
  })
  getTokenCounter()?.add(usage.cache_creation_input_tokens ?? 0, {
    ...attrs,
    type: 'cacheCreation',
  })

  let totalCost = cost
  for (const advisorUsage of getAdvisorUsage(usage)) {
    const advisorCost = calculateUSDCost(advisorUsage.model, advisorUsage)
    logEvent('tengu_advisor_tool_token_usage', {
      advisor_model:
        advisorUsage.model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      input_tokens: advisorUsage.input_tokens,
      output_tokens: advisorUsage.output_tokens,
      cache_read_input_tokens: advisorUsage.cache_read_input_tokens ?? 0,
      cache_creation_input_tokens:
        advisorUsage.cache_creation_input_tokens ?? 0,
      cost_usd_micros: Math.round(advisorCost * 1_000_000),
    })
    totalCost += addToTotalSessionCost(
      advisorCost,
      advisorUsage,
      advisorUsage.model,
      true,
    )
  }
  return totalCost
}

/**
 * 进程退出时的 `tengu_exit` 分析事件。直接读进程内状态——**用量不再落盘**：
 * 恢复链已改为「从转录派生」（见 `deriveCostStateFromTranscript`），
 * `last*` 标量与 `sessionCosts` 槽随之删除。
 */
export function logSessionExitAnalytics(fpsMetrics?: FpsMetrics): void {
  logEvent('tengu_exit', {
    last_session_cost: getTotalCostUSD(),
    last_session_api_duration: getTotalAPIDuration(),
    last_session_tool_duration: getTotalToolDuration(),
    last_session_duration: getTotalDuration(),
    last_session_lines_added: getTotalLinesAdded(),
    last_session_lines_removed: getTotalLinesRemoved(),
    last_session_total_input_tokens: getTotalInputTokens(),
    last_session_total_output_tokens: getTotalOutputTokens(),
    last_session_total_cache_creation_input_tokens:
      getTotalCacheCreationInputTokens(),
    last_session_total_cache_read_input_tokens: getTotalCacheReadInputTokens(),
    last_session_fps_average: fpsMetrics?.averageFps,
    last_session_fps_low_1_pct: fpsMetrics?.low1PctFps,
    last_session_id:
      getSessionId() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    ...getCurrentProjectConfig().lastSessionMetrics,
  })
}
