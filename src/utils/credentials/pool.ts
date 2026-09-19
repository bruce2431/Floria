/**
 * Credential pool — multi-provider, multi-key, multi-model management.
 *
 * Provides the runtime API for all credential operations:
 * - Reading/writing the credentials.json file
 * - Getting the active API key, base URL, model
 * - Switching provider, key, model
 * - Key rotation and exhaustion tracking
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { safeParseJSON } from '../json.js'
import type {
  ApiKeyEntry,
  CredentialsFile,
  ProviderConfig,
  WebSearchCredentials,
} from './types.js'

const CREDENTIALS_FILENAME = 'credentials.json'

// ── Internal helpers ─────────────────────────────────────────────────────────

function _getCredentialsPath(): string {
  return join(getClaudeConfigHomeDir(), CREDENTIALS_FILENAME)
}

function createDefaultCredentials(): CredentialsFile {
  return {
    activeProvider: '',
    providers: {},
  }
}

const CREDENTIALS_ENCODING = 'utf-8' as const

function writeCredentials(creds: CredentialsFile): void {
  const path = _getCredentialsPath()
  const dir = getClaudeConfigHomeDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(path, JSON.stringify(creds, null, 2), CREDENTIALS_ENCODING)
  // safeParseJSON memoizes by content string and loadCredentials hands back a
  // reference into the cached object (mutation-through-reference is relied upon
  // by callers like /key reset). If a write reverts the file to content that was
  // cached earlier, the next read returns the stale mutated object — e.g. setting
  // then clearing /key vision reverts credentials.json to the original bytes, so
  // the override silently persists in memory. Writes are rare and the file is
  // small, so invalidating the parse cache after each write is correct & cheap.
  safeParseJSON.cache.clear()
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Load credentials from disk. Returns default (empty) if file doesn't exist.
 */
export function loadCredentials(): CredentialsFile {
  const path = _getCredentialsPath()
  if (!existsSync(path)) {
    return createDefaultCredentials()
  }
  try {
    const raw = readFileSync(path, CREDENTIALS_ENCODING)
    const parsed = safeParseJSON(raw)
    if (!parsed || typeof parsed !== 'object') {
      return createDefaultCredentials()
    }
    const data = parsed as Record<string, unknown>
    const creds: CredentialsFile = {
      activeProvider: typeof data.activeProvider === 'string' ? data.activeProvider : '',
      providers: (typeof data.providers === 'object' && data.providers !== null
        ? data.providers
        : {}) as Record<string, ProviderConfig>,
    }
    // Carry the WebSearch tool section through: load→save round-trips (key
    // rotation, /key ops) rewrite the whole file, so an unparsed section would
    // be silently wiped on the next write.
    if (typeof data.webSearch === 'object' && data.webSearch !== null) {
      creds.webSearch = data.webSearch as WebSearchCredentials
    }
    return creds
  } catch {
    return createDefaultCredentials()
  }
}

/**
 * Save credentials to disk.
 */
export function saveCredentials(creds: CredentialsFile): void {
  writeCredentials(creds)
}

// ── 会话级供应商绑定（2026-09-10）────────────────────────────────────────────
// 一个 CLI 进程 = 一个会话，请求凭据（baseUrl / apiKey / 默认模型）必须由本进程
// 自己决定：全局 activeProvider / activeModel 的任何写入——其它会话切模型、首页设
// 默认模型、/model 命令写池——都不得漂移已运行会话的供应商。否则会出现
// 「模型名属于 A、endpoint/key 属于 B」的 400（2026-09-10 实测：
// 新会话界面切 deepseek → 全局池被改写 → 两个在跑的 GLM 会话拿 glm-5.3-flash
// 打 api.deepseek.com/anthropic 全数 400）。
//
// 解析顺序（不变量：本进程请求凭据只随本进程状态变化）：
//   1. 显式 override —— 网关按会话路由 {type:'model', provider} 时设置（跨供应商切换）
//   2. 进程启动快照 —— 首次解析时的 activeProvider + 该商 activeModel
//   3. 池文件现值 —— 快照缺失 / 绑定供应商已被删除时
let _sessionProviderOverride: string | null = null
let _bootSnapshotTaken = false
let _bootProviderSnapshot: string | null = null
let _bootModelSnapshot: string | null = null

/** 网关按会话路由模型切换时调用；null 清除（回落启动快照）。 */
export function setSessionProviderOverride(name: string | null): void {
  _sessionProviderOverride = name && name.trim() ? name.trim() : null
}

/** 本进程当前绑定的供应商名（会话有效），见 _resolveSessionProvider。 */
export function getSessionProviderName(): string {
  return _resolveSessionProvider(loadCredentials()).name
}

function _takeBootSnapshot(creds: CredentialsFile): void {
  if (_bootSnapshotTaken) return
  _bootSnapshotTaken = true
  const cfg = creds.activeProvider ? creds.providers[creds.activeProvider] : undefined
  _bootProviderSnapshot = cfg ? creds.activeProvider : null
  _bootModelSnapshot = cfg?.activeModel ?? null
}

function _resolveSessionProvider(creds: CredentialsFile): {
  name: string
  cfg: ProviderConfig | null
  explicit: boolean
} {
  _takeBootSnapshot(creds)
  if (_sessionProviderOverride && creds.providers[_sessionProviderOverride]) {
    return { name: _sessionProviderOverride, cfg: creds.providers[_sessionProviderOverride], explicit: true }
  }
  if (_bootProviderSnapshot && creds.providers[_bootProviderSnapshot]) {
    return { name: _bootProviderSnapshot, cfg: creds.providers[_bootProviderSnapshot], explicit: false }
  }
  const name = creds.activeProvider
  return { name, cfg: name ? (creds.providers[name] ?? null) : null, explicit: false }
}

/**
 * Get the config of this session's bound provider (request chain: baseUrl / keys).
 * Returns null if no provider is active or configured.
 */
export function getActiveProviderConfig(): ProviderConfig | null {
  return _resolveSessionProvider(loadCredentials()).cfg
}

/**
 * Get the config of the pool's current activeProvider, ignoring this process's
 * session binding. Management views only (gateway /gateway/models display).
 */
export function getGlobalActiveProviderConfig(): ProviderConfig | null {
  const creds = loadCredentials()
  if (!creds.activeProvider || !creds.providers[creds.activeProvider]) {
    return null
  }
  return creds.providers[creds.activeProvider]
}

/**
 * Get the active API key from the credential pool.
 * Returns null if none available.
 */
export function getActiveApiKey(): string | null {
  const config = getActiveProviderConfig()
  if (!config) return null
  const entry = config.keys[config.activeKeyIndex]
  if (!entry || entry.exhausted) return null
  return entry.value
}

/**
 * Get the base URL for the currently active provider.
 * Returns null if no provider is configured.
 */
export function getActiveBaseUrl(): string | null {
  const config = getActiveProviderConfig()
  return config?.baseUrl ?? null
}

/**
 * Get this session's default model name (used when nothing overrides the model
 * in-process). Bound to the session provider: without an explicit override it
 * answers the boot snapshot's model, so another session writing the pool's
 * activeModel cannot drift this session's model name away from its endpoint.
 * Returns null if none configured.
 */
export function getActiveModel(): string | null {
  const creds = loadCredentials()
  const resolved = _resolveSessionProvider(creds)
  if (resolved.explicit) return resolved.cfg?.activeModel ?? null
  return _bootModelSnapshot ?? resolved.cfg?.activeModel ?? null
}

/**
 * Get the pool's current activeModel, ignoring this process's session binding.
 * Management views only (gateway /gateway/models display).
 */
export function getGlobalActiveModel(): string | null {
  return getGlobalActiveProviderConfig()?.activeModel ?? null
}

/**
 * Get the WebSearch tool's backend configuration section.
 * Returns {} when never configured.
 */
export function getWebSearchCredentials(): WebSearchCredentials {
  return loadCredentials().webSearch ?? {}
}

/**
 * Switch to a different provider by name.
 * If the provider doesn't exist, does nothing and returns false.
 */
export function switchProvider(name: string): boolean {
  const creds = loadCredentials()
  if (!creds.providers[name]) return false
  creds.activeProvider = name
  saveCredentials(creds)
  return true
}

/**
 * List all configured provider names.
 */
export function listProviders(): string[] {
  return Object.keys(loadCredentials().providers)
}

/**
 * Add a new provider configuration.
 */
export function addProvider(
  name: string,
  config: ProviderConfig,
): void {
  const creds = loadCredentials()
  creds.providers[name] = config
  if (!creds.activeProvider) {
    creds.activeProvider = name
  }
  saveCredentials(creds)
}

/**
 * Remove a provider and all its keys.
 * If it was the active provider, resets active to first available.
 */
export function removeProvider(name: string): boolean {
  const creds = loadCredentials()
  if (!creds.providers[name]) return false
  delete creds.providers[name]
  if (creds.activeProvider === name) {
    const remaining = Object.keys(creds.providers)
    creds.activeProvider = remaining.length > 0 ? remaining[0] : ''
  }
  saveCredentials(creds)
  return true
}

/**
 * Find which provider's model list contains the given model.
 * Active provider is checked first (ties resolve to it), then config order.
 * Returns null if no provider lists the model.
 */
export function findModelProvider(model: string): string | null {
  const creds = loadCredentials()
  const cur = creds.activeProvider ? creds.providers[creds.activeProvider] : undefined
  if (cur && Array.isArray(cur.models) && cur.models.includes(model)) {
    return creds.activeProvider
  }
  for (const [name, cfg] of Object.entries(creds.providers)) {
    if (Array.isArray(cfg.models) && cfg.models.includes(model)) return name
  }
  return null
}

/**
 * Switch model globally: resolve the owning provider, switch to it and write
 * its activeModel. Always writes. Global default only — session-level model
 * switches bind the provider in-process (setSessionProviderOverride) and must
 * NOT come through here (2026-09-10: that write used to leak across sessions).
 * Returns false if no provider lists the model.
 */
export function switchModelAuto(model: string): boolean {
  const owner = findModelProvider(model)
  if (!owner) return false
  const creds = loadCredentials()
  creds.activeProvider = owner
  const cfg = creds.providers[owner]
  if (cfg && Array.isArray(cfg.models) && cfg.models.includes(model)) {
    cfg.activeModel = model
  }
  saveCredentials(creds)
  return true
}

/**
 * Switch to a model within the current provider.
 */
export function switchModel(model: string): boolean {
  const creds = loadCredentials()
  const provider = creds.providers[creds.activeProvider]
  if (!provider) return false
  if (!provider.models.includes(model)) return false
  provider.activeModel = model
  saveCredentials(creds)
  return true
}

/**
 * Get the explicit vision override for a model in the current provider.
 * Returns undefined when no override is set (name-pattern detection applies).
 */
export function getModelVision(model: string): boolean | undefined {
  const config = getActiveProviderConfig()
  return config?.modelVision?.[model]
}

/**
 * Set or clear the explicit vision override for a model in the current provider.
 * Pass undefined to clear the override (fall back to name-pattern detection).
 */
export function setModelVision(
  model: string,
  vision: boolean | undefined,
): void {
  const creds = loadCredentials()
  const provider = creds.providers[creds.activeProvider]
  if (!provider) return
  const modelVision = provider.modelVision ?? {}
  if (vision === undefined) {
    delete modelVision[model]
  } else {
    modelVision[model] = vision
  }
  provider.modelVision = modelVision
  saveCredentials(creds)
}

/**
 * Rotate to the next non-exhausted key in the current provider.
 * Returns the new active key, or null if no usable keys remain.
 */
export function rotateKey(): string | null {
  const creds = loadCredentials()
  const provider = creds.providers[creds.activeProvider]
  if (!provider || provider.keys.length === 0) return null

  const startIndex = provider.activeKeyIndex
  let index = (startIndex + 1) % provider.keys.length

  while (index !== startIndex) {
    if (!provider.keys[index].exhausted) {
      provider.activeKeyIndex = index
      saveCredentials(creds)
      return provider.keys[index].value
    }
    index = (index + 1) % provider.keys.length
  }

  // All keys exhausted — try the starting position one last time
  if (!provider.keys[startIndex].exhausted) {
    return provider.keys[startIndex].value
  }
  return null
}

/**
 * Mark the current key as exhausted (e.g., after a 401).
 */
export function markCurrentKeyExhausted(): void {
  const creds = loadCredentials()
  const provider = creds.providers[creds.activeProvider]
  if (!provider) return
  const entry = provider.keys[provider.activeKeyIndex]
  if (!entry) return
  entry.exhausted = true
  entry.exhaustedAt = Date.now()
  saveCredentials(creds)
}

/**
 * Add an API key to the current provider's pool.
 */
export function addKey(key: string): void {
  const creds = loadCredentials()
  const provider = creds.providers[creds.activeProvider]
  if (!provider) return
  provider.keys.push({ value: key, exhausted: false })
  saveCredentials(creds)
}

/**
 * Remove an API key from the current provider's pool by index.
 */
export function removeKey(index: number): boolean {
  const creds = loadCredentials()
  const provider = creds.providers[creds.activeProvider]
  if (!provider || index < 0 || index >= provider.keys.length) return false
  provider.keys.splice(index, 1)
  if (provider.activeKeyIndex >= provider.keys.length) {
    provider.activeKeyIndex = Math.max(0, provider.keys.length - 1)
  }
  saveCredentials(creds)
  return true
}

/**
 * Check if the current provider has non-exhausted keys remaining.
 */
export function hasUsableKeys(): boolean {
  const config = getActiveProviderConfig()
  if (!config) return false
  return config.keys.some(k => !k.exhausted)
}

/** Check if credentials.json exists on disk. */
export function credentialsFileExists(): boolean {
  return existsSync(_getCredentialsPath())
}
