/**
 * Settings Sync Service
 *
 * Syncs user settings and memory files across Claude Code environments.
 *
 * The sync API is claude.ai OAuth-only (Bearer token + user:inference scope);
 * with the OAuth path retired the sync is never eligible. The entry points
 * remain for their callers and collapse to the historical ineligible outcome.
 */

import { feature } from 'bun:bundle'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { logEvent } from '../analytics/index.js'

/**
 * Upload local settings to remote (interactive CLI only).
 * Called from main.tsx preAction.
 * Runs in background - caller should not await unless needed.
 */
export async function uploadUserSettingsInBackground(): Promise<void> {
  logForDiagnosticsNoPII('info', 'settings_sync_upload_skipped')
  logEvent('tengu_settings_sync_upload_skipped_ineligible', {})
}

/**
 * Download settings from remote for CCR mode.
 * Fired fire-and-forget at the top of print.ts runHeadless(); awaited in
 * installPluginsAndApplyMcpInBackground before plugin install. First call
 * starts the fetch; subsequent calls join it.
 * Returns true if settings were applied, false otherwise.
 */
export function downloadUserSettings(): Promise<boolean> {
  if (feature('DOWNLOAD_USER_SETTINGS')) {
    logForDiagnosticsNoPII('info', 'settings_sync_download_skipped')
    logEvent('tengu_settings_sync_download_skipped', {})
  }
  return Promise.resolve(false)
}

/**
 * Force a fresh download, bypassing the cached startup promise.
 * Called by /reload-plugins in CCR so mid-session settings changes
 * (enabledPlugins, extraKnownMarketplaces) pushed from the user's local
 * CLI are picked up before the plugin-cache sweep.
 */
export function redownloadUserSettings(): Promise<boolean> {
  if (feature('DOWNLOAD_USER_SETTINGS')) {
    logForDiagnosticsNoPII('info', 'settings_sync_download_skipped')
    logEvent('tengu_settings_sync_download_skipped', {})
  }
  return Promise.resolve(false)
}
