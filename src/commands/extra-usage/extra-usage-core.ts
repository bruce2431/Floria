import { invalidateOverageCreditGrantCache } from '../../services/api/overageCreditGrant.js'
import { openBrowser } from '../../utils/browser.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logError } from '../../utils/log.js'

type ExtraUsageResult =
  | { type: 'message'; value: string }
  | { type: 'browser-opened'; url: string; opened: boolean }

export async function runExtraUsage(): Promise<ExtraUsageResult> {
  if (!getGlobalConfig().hasVisitedExtraUsage) {
    saveGlobalConfig(prev => ({ ...prev, hasVisitedExtraUsage: true }))
  }
  // Invalidate only the current org's entry so a follow-up read refetches
  // the granted state. Separate from the visited flag since users may run
  // /extra-usage more than once while iterating on the claim flow.
  invalidateOverageCreditGrantCache()

  // No subscribers without OAuth — the team/ent admin-request branch and the
  // utilization fetch were unreachable; always open the consumer usage page.
  const url = 'https://claude.ai/settings/usage'

  try {
    const opened = await openBrowser(url)
    return { type: 'browser-opened', url, opened }
  } catch (error) {
    logError(error as Error)
    return {
      type: 'message',
      value: `Failed to open browser. Please visit ${url} to manage extra usage.`,
    }
  }
}
