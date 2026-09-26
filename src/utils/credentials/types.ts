/**
 * Credential pool types for multi-provider, multi-key, multi-model support.
 *
 * Each provider config (Anthropic, DeepSeek, Kimi, GLM, etc.) stores its own:
 * - base URL (Anthropic-compatible endpoint)
 * - Pool of API keys with exhaustion tracking
 * - List of available models
 * - Active selections (which key, which model)
 *
 * All providers in this pool share the Anthropic SDK client path
 * (new Anthropic({apiKey, baseURL, ...})). Bedrock/Vertex/Foundry
 * use separate SDKs and are excluded from this pool.
 */

export interface ApiKeyEntry {
  /** The actual API key string */
  value: string
  /** Whether this key is marked as exhausted (e.g., rate-limited) */
  exhausted: boolean
  /** Timestamp when exhausted, for auto-recovery */
  exhaustedAt?: number
}

export interface ProviderConfig {
  /** Anthropic-compatible base URL (e.g., https://api.deepseek.com/anthropic) */
  baseUrl: string
  /** Pool of API keys for this provider */
  keys: ApiKeyEntry[]
  /** Index into keys[] of the currently active key */
  activeKeyIndex: number
  /** Available model names for this provider */
  models: string[]
  /** Currently selected model name */
  activeModel: string
  /**
   * Per-model explicit vision capability override.
   * `undefined` for a model = not set → fall back to name-pattern detection.
   * Absent entirely (old credentials.json) = same as empty.
   */
  modelVision?: Record<string, boolean>
  /**
   * Model capabilities this provider's endpoint actually accepts, consumed by
   * get3PModelCapabilityOverride (modelSupportOverrides.ts): 'effort' |
   * 'max_effort' | 'thinking' | 'adaptive_thinking' | 'interleaved_thinking'.
   * Declaring the array takes over completely for this provider (a capability
   * absent from the list = explicitly unsupported); absent entirely = fall
   * back to upstream env/name heuristics. Takes effect on session restart.
   */
  capabilities?: string[]
  /**
   * Official thinking/effort levels this provider's models expose, declared
   * per the vendor docs (2026-09-18). Consumed by getPoolModelEffortLevels
   * (engine Off→thinking-disabled branch) and broadcast per-item via
   * GET /gateway/models so the web effort menu renders from the vendor's
   * actual level list instead of the hardcoded default. Values: 'off' | 'low'
   * | 'medium' | 'high' | 'max'. Absent = web falls back to Off/Low/High/Max.
   */
  effortLevels?: string[]
}

export interface CredentialsFile {
  /** Name of the currently active provider */
  activeProvider: string
  /** All configured providers, keyed by name */
  providers: Record<string, ProviderConfig>
  /**
   * WebSearch tool backend configuration (global pool section).
   * `undefined` = never configured → tool hidden unless a default applies.
   */
  webSearch?: WebSearchCredentials
  /**
   * 模型定价覆盖（见 utils/modelPricing.ts）。全部字段可选，缺省即走
   * 「厂商官网价目 → models.dev 目录」自动链路。
   */
  pricing?: PricingConfig
}

/**
 * 模型定价覆盖。单价一律按**人民币 / 百万 token**、官方账单口径填写
 * （与厂商价目页同单位），内部按实时汇率折算成计价单位。
 */
export interface PricingConfig {
  /** USD→CNY 汇率覆盖；缺省 = 自动拉取（open.er-api.com） */
  usdCnyRate?: number
  /** 法定节假日（`YYYY-MM-DD`，北京时间），当天全天按空闲时段计 */
  holidays?: string[]
  /** 高峰时段 `[起, 止)`（北京时间整点小时）；缺省 [[9,12],[14,18]] */
  peakWindows?: number[][]
  /** 按 provider 名指定 models.dev 目录 id（如 `{ "glm": { "source": "zhipuai" } }`） */
  providers?: Record<string, { source?: string }>
  /** 按模型名覆盖单价（人民币 / 百万 token） */
  models?: Record<
    string,
    {
      input: number
      output: number
      cacheRead?: number
      cacheWrite?: number
    }
  >
}

/**
 * Configuration for the local multi-backend WebSearch tool (port of Hermes'
 * web_tools provider architecture). Lives in the same credentials.json as the
 * LLM provider pool — one global source of truth for API keys.
 */
export interface WebSearchCredentials {
  /** Explicit backend selection (searxng | brave | tavily | exa); autodetect when unset. */
  backend?: string
  /** Self-hosted SearXNG instance base URL (enables the searxng backend). */
  searxngUrl?: string
  /** Vendor API keys, keyed by backend name (brave | tavily | exa). */
  keys?: Record<string, string>
}
