/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */

import { clearTrustedDeviceTokenCache } from '../../bridge/trustedDevice.js'
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js'
import { getGroveNoticeConfig, getGroveSettings } from '../../services/api/grove.js'
import { clearPolicyLimitsCache } from '../../services/policyLimits/index.js'
import { clearRemoteManagedSettingsCache } from '../../services/remoteManagedSettings/index.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import {
  buildAccountProperties,
  buildAPIProviderProperties,
} from '../../utils/status.js'
import {
  getAnthropicApiKeyWithSource,
  removeApiKey,
} from '../../utils/auth.js'
import { clearBetasCaches } from '../../utils/betas.js'
import { saveGlobalConfig } from '../../utils/config.js'
import { isRunningOnHomespace } from '../../utils/envUtils.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { clearToolSchemaCache } from '../../utils/toolSchemaCache.js'
import { resetUserCache } from '../../utils/user.js'

// OAuth 安装/登录流（installOAuthTokens / authLogin）已随 Anthropic 登录线路移除
// （2026-09-18）：本文件仅存 authStatus / authLogout 与清缓存链。
export async function authStatus(opts: {
  json?: boolean
  text?: boolean
}): Promise<void> {
  const { source: apiKeySource } = getAnthropicApiKeyWithSource()
  const hasApiKeyEnvVar =
    !!process.env.ANTHROPIC_API_KEY && !isRunningOnHomespace()
  const loggedIn = apiKeySource !== 'none' || hasApiKeyEnvVar

  if (opts.text) {
    const properties = [
      ...buildAccountProperties(),
      ...buildAPIProviderProperties(),
    ]
    let hasAuthProperty = false
    for (const prop of properties) {
      const value =
        typeof prop.value === 'string'
          ? prop.value
          : Array.isArray(prop.value)
            ? prop.value.join(', ')
            : null
      if (value === null || value === 'none') {
        continue
      }
      hasAuthProperty = true
      if (prop.label) {
        process.stdout.write(`${prop.label}: ${value}\n`)
      } else {
        process.stdout.write(`${value}\n`)
      }
    }
    if (!hasAuthProperty && hasApiKeyEnvVar) {
      process.stdout.write('API key: ANTHROPIC_API_KEY\n')
    }
    if (!loggedIn) {
      process.stdout.write(
        'Not logged in · No usable credentials. Configure .claude/credentials.json keys[].\n',
      )
    }
  } else {
    const resolvedApiKeySource =
      apiKeySource !== 'none'
        ? apiKeySource
        : hasApiKeyEnvVar
          ? 'ANTHROPIC_API_KEY'
          : null
    const output: Record<string, string | boolean | null> = {
      loggedIn,
      authMethod: loggedIn ? 'api_key' : 'none',
      apiProvider: getAPIProvider(),
    }
    if (resolvedApiKeySource) {
      output.apiKeySource = resolvedApiKeySource
    }

    process.stdout.write(jsonStringify(output, null, 2) + '\n')
  }
  process.exit(loggedIn ? 0 : 1)
}

export async function authLogout(): Promise<void> {
  try {
    await performLogout({ clearOnboarding: false })
  } catch {
    process.stderr.write('Failed to log out.\n')
    process.exit(1)
  }
  process.stdout.write('Successfully logged out.\n')
  process.exit(0)
}

// performLogout / clearAuthRelatedCaches 就近安置（2026-09-18）：commands/logout/ 命令模块
// 删除后其仅存消费者是本文件（auth logout），函数本体自 git 历史迁入。
export async function performLogout({
  clearOnboarding = false,
}: {
  clearOnboarding?: boolean
}): Promise<void> {
  // Flush telemetry BEFORE clearing credentials to prevent org data leakage
  const { flushTelemetry } = await import('../../utils/telemetry/instrumentation.js')
  await flushTelemetry()
  await removeApiKey()

  // Wipe all secure storage data on logout
  const secureStorage = getSecureStorage()
  secureStorage.delete()
  await clearAuthRelatedCaches()
  saveGlobalConfig(current => {
    const updated = {
      ...current,
      oauthAccount: undefined,
    }
    if (clearOnboarding) {
      updated.hasCompletedOnboarding = false
      updated.subscriptionNoticeCount = 0
      updated.hasAvailableSubscription = false
      if (updated.customApiKeyResponses?.approved) {
        updated.customApiKeyResponses = {
          ...updated.customApiKeyResponses,
          approved: [],
        }
      }
    }
    return updated
  })
}

// clearing anything memoized that must be invalidated when user/session/auth changes
export async function clearAuthRelatedCaches(): Promise<void> {
  clearTrustedDeviceTokenCache()
  clearBetasCaches()
  clearToolSchemaCache()

  // Clear user data cache BEFORE GrowthBook refresh so it picks up fresh credentials
  resetUserCache()
  refreshGrowthBookAfterAuthChange()

  // Clear Grove config cache
  getGroveNoticeConfig.cache?.clear?.()
  getGroveSettings.cache?.clear?.()

  // Clear remotely managed settings cache
  await clearRemoteManagedSettingsCache()

  // Clear policy limits cache
  await clearPolicyLimitsCache()
}
