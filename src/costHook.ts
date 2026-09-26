import { useEffect } from 'react'
import { formatTotalCost, logSessionExitAnalytics } from './cost-tracker.js'
import { hasConsoleBillingAccess } from './utils/billing.js'
import type { FpsMetrics } from './utils/fpsTracker.js'

export function useCostSummary(
  getFpsMetrics?: () => FpsMetrics | undefined,
): void {
  useEffect(() => {
    const f = () => {
      if (hasConsoleBillingAccess()) {
        process.stdout.write('\n' + formatTotalCost() + '\n')
      }

      logSessionExitAnalytics(getFpsMetrics?.())
    }
    process.on('exit', f)
    return () => {
      process.off('exit', f)
    }
  }, [])
}
