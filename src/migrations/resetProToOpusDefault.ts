import { logEvent } from 'src/services/analytics/index.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'

/**
 * OAuth 订阅线路已移除：Pro 订阅态不存在，迁移恒走「跳过并标记完成」路径。
 */
export function resetProToOpusDefault(): void {
  const config = getGlobalConfig()

  if (config.opusProMigrationComplete) {
    return
  }

  saveGlobalConfig(current => ({
    ...current,
    opusProMigrationComplete: true,
  }))
  logEvent('tengu_reset_pro_to_opus_default', { skipped: true })
}
