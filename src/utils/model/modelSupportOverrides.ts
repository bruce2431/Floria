import memoize from 'lodash-es/memoize.js'
import { getAPIProvider } from './providers.js'

export type ModelCapabilityOverride =
  | 'effort'
  | 'max_effort'
  | 'thinking'
  | 'adaptive_thinking'
  | 'interleaved_thinking'

const TIERS = [
  {
    modelEnvVar: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES',
  },
  {
    modelEnvVar: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    capabilitiesEnvVar: 'ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES',
  },
] as const

/**
 * Credential-pool provider capability declaration (2026-09-18): a
 * `capabilities` array on the owning provider in credentials.json takes over
 * completely for that endpoint — the pool carries non-Anthropic endpoints
 * (GLM/DeepSeek/…) whose acceptance of effort/thinking params can't be
 * inferred from the model name. Lazy require like providers.ts (keeps this
 * module dependency-light, same convention as isPoolActiveWithNonAnthropicUrl).
 */
function getPoolModelCapability(
  model: string,
  capability: ModelCapabilityOverride,
): boolean | undefined {
  try {
    const { findModelProvider, loadCredentials } = require('../credentials/pool.js') as typeof import('../credentials/pool.js')
    const providerName = findModelProvider(model)
    if (!providerName) return undefined
    const caps = loadCredentials().providers[providerName]?.capabilities
    if (!Array.isArray(caps)) return undefined
    return caps.map(s => String(s).toLowerCase().trim()).includes(capability)
  } catch {
    return undefined
  }
}

/**
 * Official thinking/effort level list declared on the owning pool provider
 * (credentials.json `effortLevels`, per vendor docs 2026-09-18). `undefined`
 * = not declared (caller falls back to hardcoded levels). Consumed by the
 * engine's explicit-Off→thinking-disabled branch (claude.ts) and the gateway
 * /gateway/models broadcast (web renders the effort menu from this list).
 */
export const getPoolModelEffortLevels = memoize(
  (model: string): string[] | undefined => {
    try {
      const { findModelProvider, loadCredentials } = require('../credentials/pool.js') as typeof import('../credentials/pool.js')
      const providerName = findModelProvider(model)
      if (!providerName) return undefined
      const levels = loadCredentials().providers[providerName]?.effortLevels
      if (!Array.isArray(levels)) return undefined
      const out = levels
        .map(s => String(s).toLowerCase().trim())
        .filter(s => ['off', 'low', 'medium', 'high', 'max'].includes(s))
      return out.length ? out : undefined
    } catch {
      return undefined
    }
  },
  (model) => model.toLowerCase(),
)

/**
 * Check whether a 3p model capability override is set for a model that matches one of
 * the pinned ANTHROPIC_DEFAULT_*_MODEL env vars.
 */
export const get3PModelCapabilityOverride = memoize(
  (model: string, capability: ModelCapabilityOverride): boolean | undefined => {
    if (getAPIProvider() === 'firstParty') {
      return undefined
    }
    const poolCap = getPoolModelCapability(model, capability)
    if (poolCap !== undefined) {
      return poolCap
    }
    const m = model.toLowerCase()
    for (const tier of TIERS) {
      const pinned = process.env[tier.modelEnvVar]
      const capabilities = process.env[tier.capabilitiesEnvVar]
      if (!pinned || capabilities === undefined) continue
      if (m !== pinned.toLowerCase()) continue
      return capabilities
        .toLowerCase()
        .split(',')
        .map(s => s.trim())
        .includes(capability)
    }
    return undefined
  },
  (model, capability) => `${model.toLowerCase()}:${capability}`,
)
