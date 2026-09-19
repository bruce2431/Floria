import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import { logForDebugging } from '../utils/debug.js'

// Events must be wrapped in { type: 'event', data: <sdk_message> } for the
// POST /v1/sessions endpoint (discriminated union format).
type SessionEvent = {
  type: 'event'
  data: SDKMessage
}

/**
 * Create a session on a bridge environment via POST /v1/sessions.
 * OAuth 线路已移除：无 access token，恒返回 null。
 */
export async function createBridgeSession(_opts: {
  environmentId: string
  title?: string
  events: SessionEvent[]
  gitRepoUrl: string | null
  branch: string
  signal: AbortSignal
  baseUrl?: string
  getAccessToken?: () => string | undefined
  permissionMode?: string
}): Promise<string | null> {
  logForDebugging('[bridge] No access token for session creation')
  return null
}

/**
 * Fetch a bridge session via GET /v1/sessions/{id}.
 * OAuth 线路已移除：无 access token，恒返回 null。
 */
export async function getBridgeSession(
  _sessionId: string,
  _opts?: { baseUrl?: string; getAccessToken?: () => string | undefined },
): Promise<{ environment_id?: string; title?: string } | null> {
  logForDebugging('[bridge] No access token for session fetch')
  return null
}

/**
 * Archive a bridge session via POST /v1/sessions/{id}/archive.
 * OAuth 线路已移除：无 access token，恒跳过。
 */
export async function archiveBridgeSession(
  _sessionId: string,
  _opts?: {
    baseUrl?: string
    getAccessToken?: () => string | undefined
    timeoutMs?: number
  },
): Promise<void> {
  logForDebugging('[bridge] No access token for session archive')
}

/**
 * Update the title of a bridge session via PATCH /v1/sessions/{id}.
 * OAuth 线路已移除：无 access token，恒跳过。
 */
export async function updateBridgeSessionTitle(
  _sessionId: string,
  _title: string,
  _opts?: { baseUrl?: string; getAccessToken?: () => string | undefined },
): Promise<void> {
  logForDebugging('[bridge] No access token for session title update')
}
