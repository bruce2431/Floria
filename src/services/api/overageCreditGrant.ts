export type OverageCreditGrantInfo = {
  available: boolean
  eligible: boolean
  granted: boolean
  amount_minor_units: number | null
  currency: string | null
}

// OAuth org context is gone (no account info ⇒ no org UUID): the grant cache
// and its fetch path were runtime-dead. Kept exports collapse to their
// historical no-org values.

/**
 * Get cached grant info. Always null without OAuth account context.
 */
export function getCachedOverageCreditGrant(): OverageCreditGrantInfo | null {
  return null
}

/**
 * No-op: nothing cached to invalidate without OAuth account context.
 */
export function invalidateOverageCreditGrantCache(): void {}

/**
 * No-op: nothing to fetch or cache without OAuth account context.
 */
export async function refreshOverageCreditGrantCache(): Promise<void> {}

/**
 * Format the grant amount for display. Returns null if amount isn't available
 * (not eligible, or currency we don't know how to format).
 */
export function formatGrantAmount(info: OverageCreditGrantInfo): string | null {
  if (info.amount_minor_units == null || !info.currency) return null
  // For now only USD; backend may expand later
  if (info.currency.toUpperCase() === 'USD') {
    const dollars = info.amount_minor_units / 100
    return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`
  }
  return null
}
