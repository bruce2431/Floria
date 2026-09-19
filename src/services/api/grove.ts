import memoize from 'lodash-es/memoize.js'

export type AccountSettings = {
  grove_enabled: boolean | null
  grove_notice_viewed_at: string | null
}

export type GroveConfig = {
  grove_enabled: boolean
  domain_excluded: boolean
  notice_is_grace_period: boolean
  notice_reminder_frequency: number | null
}

/**
 * Result type that distinguishes between API failure and success.
 * - success: true means API call succeeded (data may still contain null fields)
 * - success: false means API call failed after retry
 */
export type ApiResult<T> = { success: true; data: T } | { success: false }

// Grove endpoints live under /api/oauth/* (claude.ai OAuth org context only).
// With the OAuth path retired, these calls could never authenticate, so the
// exports collapse to their historical unauthenticated outcomes (failure/no-op).

// Still memoized so `.cache.clear()` call sites keep compiling.
export const getGroveSettings = memoize(
  async (): Promise<ApiResult<AccountSettings>> => ({ success: false }),
)

/**
 * No-op: the server-side viewed-at write required OAuth context.
 */
export async function markGroveNoticeViewed(): Promise<void> {}

/**
 * No-op: the server-side settings write required OAuth context.
 */
export async function updateGroveSettings(
  groveEnabled: boolean,
): Promise<void> {}

/**
 * Check if user is qualified for Grove. Consumer-subscriber only; that path
 * is gone, so never qualified.
 */
export async function isQualifiedForGrove(): Promise<boolean> {
  return false
}

export const getGroveNoticeConfig = memoize(
  async (): Promise<ApiResult<GroveConfig>> => ({ success: false }),
)

/**
 * Determines whether the Grove dialog should be shown.
 * Returns false if either API call failed (after retry) - we hide the dialog on API failure.
 */
export function calculateShouldShowGrove(
  settingsResult: ApiResult<AccountSettings>,
  configResult: ApiResult<GroveConfig>,
  showIfAlreadyViewed: boolean,
): boolean {
  // Hide dialog on API failure (after retry)
  if (!settingsResult.success || !configResult.success) {
    return false
  }

  const settings = settingsResult.data
  const config = configResult.data

  const hasChosen = settings.grove_enabled !== null
  if (hasChosen) {
    return false
  }
  if (showIfAlreadyViewed) {
    return true
  }
  if (!config.notice_is_grace_period) {
    return true
  }
  // Check if we need to remind the user to accept the terms and choose
  // whether to help improve Claude.
  const reminderFrequency = config.notice_reminder_frequency
  if (reminderFrequency !== null && settings.grove_notice_viewed_at) {
    const daysSinceViewed = Math.floor(
      (Date.now() - new Date(settings.grove_notice_viewed_at).getTime()) /
        (1000 * 60 * 60 * 24),
    )
    return daysSinceViewed >= reminderFrequency
  } else {
    // Show if never viewed before
    const viewedAt = settings.grove_notice_viewed_at
    return viewedAt === null || viewedAt === undefined
  }
}

export async function checkGroveForNonInteractive(): Promise<void> {}
