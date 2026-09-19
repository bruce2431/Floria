import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'

/**
 * Kill-switch check for voice mode. Returns true unless the
 * `tengu_amber_quartz_disabled` GrowthBook flag is flipped on (emergency
 * off). Default `false` means a missing/stale disk cache reads as "not
 * killed" — so fresh installs get voice working immediately without
 * waiting for GrowthBook init. Use this for deciding whether voice mode
 * should be *visible* (e.g., command registration, config UI).
 */
export function isVoiceGrowthBookEnabled(): boolean {
  // Positive ternary pattern — see docs/feature-gating.md.
  // Negative pattern (if (!feature(...)) return) does not eliminate
  // inline string literals from external builds.
  return feature('VOICE_MODE')
    ? !getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_quartz_disabled', false)
    : false
}

/**
 * Auth-only check for voice mode. Voice uses the voice_stream endpoint on
 * claude.ai (OAuth-only); with the OAuth path retired there is never voice
 * auth.
 */
export function hasVoiceAuth(): boolean {
  return false
}

/**
 * Full runtime check: auth + GrowthBook kill-switch. Callers: `/voice`
 * (voice.ts, voice/index.ts), ConfigTool, VoiceModeNotice — command-time
 * paths. For React render paths use useVoiceEnabled() instead (memoizes
 * the auth half).
 */
export function isVoiceModeEnabled(): boolean {
  return hasVoiceAuth() && isVoiceGrowthBookEnabled()
}
