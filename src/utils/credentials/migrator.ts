/**
 * Migrator — imports existing environment variables into credentials.json.
 *
 * On first run (or when credentials.json doesn't exist), this reads the
 * current ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL env vars
 * and creates a credentials.json entry for them so the credential pool
 * takes over transparently.
 */

import { credentialsFileExists, loadCredentials, saveCredentials } from './pool.js'
import type { ProviderConfig, CredentialsFile } from './types.js'

/**
 * Migrate from environment variables to credentials.json.
 *
 * Reads ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, ANTHROPIC_MODEL,
 * ANTHROPIC_SMALL_FAST_MODEL and creates a provider entry.
 *
 * Idempotent — only writes if credentials.json doesn't already exist.
 * Returns true if migration was performed.
 */
export function migrateFromEnv(): boolean {
  if (credentialsFileExists()) {
    return false // already migrated
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return false // nothing to migrate
  }

  const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com'
  const model = process.env.ANTHROPIC_MODEL || ''

  // Determine provider label
  let providerName = 'custom'
  if (baseUrl.includes('deepseek')) {
    providerName = 'deepseek'
  } else if (baseUrl.includes('moonshot') || baseUrl.includes('kimi')) {
    providerName = 'kimi'
  } else if (baseUrl.includes('anthropic')) {
    providerName = 'anthropic'
  } else if (baseUrl.includes('openai') || baseUrl.includes('bigmodel')) {
    providerName = 'glm'
  }

  const models: string[] = model ? [model] : []
  const smallFast = process.env.ANTHROPIC_SMALL_FAST_MODEL
  if (smallFast && !models.includes(smallFast)) {
    models.push(smallFast)
  }

  const config: ProviderConfig = {
    baseUrl,
    keys: [{ value: apiKey, exhausted: false }],
    activeKeyIndex: 0,
    models,
    activeModel: model || (models[0] ?? ''),
  }

  const creds: CredentialsFile = {
    activeProvider: providerName,
    providers: {
      [providerName]: config,
    },
  }

  saveCredentials(creds)
  return true
}
