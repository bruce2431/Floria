import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { getOAuthHeaders, prepareApiRequest } from '../../utils/teleport/api.js'
import type {
  ReferralEligibilityResponse,
  ReferralRedemptionsResponse,
  ReferrerRewardInfo,
} from '../oauth/types.js'

export async function fetchReferralRedemptions(
  campaign: string = 'claude_code_guest_pass',
): Promise<ReferralRedemptionsResponse> {
  const { accessToken, orgUUID } = await prepareApiRequest()

  const headers = {
    ...getOAuthHeaders(accessToken),
    'x-organization-uuid': orgUUID,
  }

  const url = `${getOauthConfig().BASE_API_URL}/api/oauth/organizations/${orgUUID}/referral/redemptions`

  const response = await axios.get<ReferralRedemptionsResponse>(url, {
    headers,
    params: { campaign },
    timeout: 10000, // 10 second timeout
  })

  return response.data
}

/**
 * Check cached passes eligibility from GlobalConfig.
 * Guest passes are subscriber-only (max + OAuth org); that path is gone,
 * so never eligible.
 */
export function checkCachedPassesEligibility(): {
  eligible: boolean
  needsRefresh: boolean
  hasCache: boolean
} {
  return {
    eligible: false,
    needsRefresh: false,
    hasCache: false,
  }
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  BRL: 'R$',
  CAD: 'CA$',
  AUD: 'A$',
  NZD: 'NZ$',
  SGD: 'S$',
}

export function formatCreditAmount(reward: ReferrerRewardInfo): string {
  const symbol = CURRENCY_SYMBOLS[reward.currency] ?? `${reward.currency} `
  const amount = reward.amount_minor_units / 100
  const formatted = amount % 1 === 0 ? amount.toString() : amount.toFixed(2)
  return `${symbol}${formatted}`
}

/**
 * Get cached referrer reward info. Always null without OAuth org context.
 */
export function getCachedReferrerReward(): ReferrerRewardInfo | null {
  return null
}

/**
 * Get the cached remaining passes count. Always null without OAuth org context.
 */
export function getCachedRemainingPasses(): number | null {
  return null
}

/**
 * Never cached and never fetched: no subscriber path.
 */
export async function getCachedOrFetchPassesEligibility(): Promise<ReferralEligibilityResponse | null> {
  return null
}

/**
 * Prefetch passes eligibility on startup. No-op: no subscriber path.
 */
export async function prefetchPassesEligibility(): Promise<void> {}
