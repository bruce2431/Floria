import { formatTotalCost } from '../../cost-tracker.js'
import type { LocalCommandCall } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

export const call: LocalCommandCall = async () => {
  // Toggle whether the statusline shows cache hit-rate / token stats.
  const showCacheStats = getGlobalConfig().showStatuslineCacheStats ?? true
  saveGlobalConfig(prev => ({
    ...prev,
    showStatuslineCacheStats: !showCacheStats,
  }))
  const toggleText = showCacheStats
    ? 'Statusline cache stats: OFF (run /cost to re-enable)'
    : 'Statusline cache stats: ON (run /cost to hide)'

  return { type: 'text', value: `${toggleText}\n\n${formatTotalCost()}` }
}
