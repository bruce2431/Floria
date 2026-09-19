import { formatTotalCost } from '../../cost-tracker.js'
import { currentLimits } from '../../services/claudeAiLimits.js'
import type { LocalCommandCall } from '../../types/command.js'
import { isClaudeAISubscriber } from '../../utils/auth.js'
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

  if (isClaudeAISubscriber()) {
    let value: string

    if (currentLimits.isUsingOverage) {
      value =
        'You are currently using your overages to power your Claude Code usage. We will automatically switch you back to your subscription rate limits when they reset'
    } else {
      value =
        'You are currently using your subscription to power your Claude Code usage'
    }

    if (process.env.USER_TYPE === 'ant') {
      value += `\n\n[ANT-ONLY] Showing cost anyway:\n ${formatTotalCost()}`
    }
    return { type: 'text', value: `${toggleText}\n\n${value}` }
  }
  return { type: 'text', value: `${toggleText}\n\n${formatTotalCost()}` }
}
