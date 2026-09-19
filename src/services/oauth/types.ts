// 仅存类型件（2026-09-18）：OAuth 登录线路移除后，为 config/referral/Passes
// 的存量字段引用提供类型定义；无任何运行时逻辑。
export type BillingType = 'subscription' | 'low_balance' | 'contract'

export type ReferrerRewardInfo = {
  currency: string
  amount_minor_units: number
}

export type ReferralRedemptionsResponse = {
  redemptions?: Array<Record<string, unknown>>
  limit?: number
}

export type ReferralCodeDetails = {
  referral_link?: string
  campaign?: string
}

export type ReferralEligibilityResponse = {
  eligible?: boolean
  referral_code_details?: ReferralCodeDetails
  referrer_reward?: ReferrerRewardInfo | null
}
