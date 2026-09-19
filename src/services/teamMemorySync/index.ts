/**
 * Team Memory Sync Service
 *
 * Bidirectional sync of team memory entries with the server.
 *
 * The sync API is first-party-OAuth-only (Bearer + inference/profile scopes);
 * with the OAuth path retired the sync is never available. The entry points
 * remain for the watcher and collapse to the historical no-OAuth outcome.
 */

import { logEvent } from '../analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../analytics/metadata.js'
import type { TeamMemorySyncPushResult } from './types.js'

// ─── Sync state ─────────────────────────────────────────────

/**
 * Mutable state for the team memory sync service.
 * Created once per session by the watcher and passed to all sync functions.
 */
export type SyncState = {
  /** Last known server checksum (ETag) for conditional requests. */
  lastKnownChecksum: string | null
  /**
   * Per-key content hash (`sha256:<hex>`) of what we believe the server
   * currently holds.
   */
  serverChecksums: Map<string, string>
  /**
   * Server-enforced max_entries cap, learned from a structured 413 response.
   */
  serverMaxEntries: number | null
}

export function createSyncState(): SyncState {
  return {
    lastKnownChecksum: null,
    serverChecksums: new Map(),
    serverMaxEntries: null,
  }
}

/**
 * Check if team memory sync is available (requires first-party OAuth).
 */
export function isTeamMemorySyncAvailable(): boolean {
  return false
}

/**
 * Pull team memory from the server and write to local directory.
 * Returns true if any files were updated.
 */
export async function pullTeamMemory(
  _state: SyncState,
  _options?: { skipEtagCache?: boolean },
): Promise<{
  success: boolean
  filesWritten: number
  /** Number of entries the server returned, regardless of whether they were written to disk. */
  entryCount: number
  notModified?: boolean
  error?: string
}> {
  const startTime = Date.now()
  logPull(startTime, { success: false, errorType: 'no_oauth' })
  return {
    success: false,
    filesWritten: 0,
    entryCount: 0,
    error: 'OAuth not available',
  }
}

/**
 * Push local team memory entries to the server.
 */
export async function pushTeamMemory(
  _state: SyncState,
): Promise<TeamMemorySyncPushResult> {
  const startTime = Date.now()
  logPush(startTime, { success: false, errorType: 'no_oauth' })
  return {
    success: false,
    filesUploaded: 0,
    error: 'OAuth not available',
    errorType: 'no_oauth',
  }
}

/**
 * Bidirectional sync: pull from server, merge with local, push back.
 * Server entries take precedence on conflict (last-write-wins by the server).
 */
export async function syncTeamMemory(state: SyncState): Promise<{
  success: boolean
  filesPulled: number
  filesPushed: number
  error?: string
}> {
  const pullResult = await pullTeamMemory(state, { skipEtagCache: true })
  return {
    success: false,
    filesPulled: 0,
    filesPushed: 0,
    error: pullResult.error,
  }
}

// ─── Telemetry helpers ───────────────────────────────────────

function logPull(
  startTime: number,
  outcome: {
    success: boolean
    filesWritten?: number
    notModified?: boolean
    errorType?: string
    status?: number
  },
): void {
  logEvent('tengu_team_mem_sync_pull', {
    success: outcome.success,
    files_written: outcome.filesWritten ?? 0,
    not_modified: outcome.notModified ?? false,
    duration_ms: Date.now() - startTime,
    ...(outcome.errorType && {
      errorType:
        outcome.errorType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    ...(outcome.status && { status: outcome.status }),
  })
}

function logPush(
  startTime: number,
  outcome: {
    success: boolean
    filesUploaded?: number
    conflict?: boolean
    conflictRetries?: number
    errorType?: string
    status?: number
    putBatches?: number
    errorCode?: string
    serverMaxEntries?: number
    serverReceivedEntries?: number
  },
): void {
  logEvent('tengu_team_mem_sync_push', {
    success: outcome.success,
    files_uploaded: outcome.filesUploaded ?? 0,
    conflict: outcome.conflict ?? false,
    conflict_retries: outcome.conflictRetries ?? 0,
    duration_ms: Date.now() - startTime,
    ...(outcome.errorType && {
      errorType:
        outcome.errorType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    ...(outcome.status && { status: outcome.status }),
    ...(outcome.putBatches && { put_batches: outcome.putBatches }),
    ...(outcome.errorCode && {
      error_code:
        outcome.errorCode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    }),
    ...(outcome.serverMaxEntries !== undefined && {
      server_max_entries: outcome.serverMaxEntries,
    }),
    ...(outcome.serverReceivedEntries !== undefined && {
      server_received_entries: outcome.serverReceivedEntries,
    }),
  })
}
