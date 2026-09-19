/**
 * REPL-specific wrapper around the bridge init chain.
 *
 * OAuth 线路已移除：bridge 恒不可用（无 claude.ai 订阅态），
 * initReplBridge 恒跳过并返回 null。保留 InitBridgeOptions 与函数
 * 签名，消费方（useReplBridge / print.ts）不变。
 *
 * Called via dynamic import by useReplBridge (auto-start) and print.ts
 * (SDK -p mode via query.enableRemoteControl).
 */

import { isCseShimEnabled } from './bridgeEnabled.js'
import { logBridgeSkip } from './debugUtils.js'
import type { BridgeState, ReplBridgeHandle } from './replBridge.js'
import { setCseShimGate } from './sessionIdCompat.js'
import type { SDKMessage } from '../entrypoints/agentSdkTypes.js'
import type { SDKControlResponse } from '../entrypoints/sdk/controlTypes.js'
import type { Message } from '../types/message.js'
import type { PermissionMode } from '../utils/permissions/PermissionMode.js'

export type InitBridgeOptions = {
  onInboundMessage?: (msg: SDKMessage) => void | Promise<void>
  onPermissionResponse?: (response: SDKControlResponse) => void
  onInterrupt?: () => void
  onSetModel?: (model: string | undefined) => void
  onSetMaxThinkingTokens?: (maxTokens: number | null) => void
  onSetPermissionMode?: (
    mode: PermissionMode,
  ) => { ok: true } | { ok: false; error: string }
  onStateChange?: (state: BridgeState, detail?: string) => void
  initialMessages?: Message[]
  // Explicit session name from `/remote-control <name>`. When set, overrides
  // the title derived from the conversation or /rename.
  initialName?: string
  // Fresh view of the full conversation at call time. Used by onUserMessage's
  // count-3 derivation to call generateSessionTitle over the full conversation.
  // Optional — print.ts's SDK enableRemoteControl path has no REPL message
  // array; count-3 falls back to the single message text when absent.
  getMessages?: () => Message[]
  // UUIDs already flushed in a prior bridge session. Messages with these
  // UUIDs are excluded from the initial flush to avoid poisoning the
  // server (duplicate UUIDs across sessions cause the WS to be killed).
  // Mutated in place — newly flushed UUIDs are added after each flush.
  previouslyFlushedUUIDs?: Set<string>
  /** See BridgeCoreParams.perpetual. */
  perpetual?: boolean
  /**
   * When true, the bridge only forwards events outbound (no SSE inbound
   * stream). Used by CCR mirror mode — local sessions visible on claude.ai
   * without enabling inbound control.
   */
  outboundOnly?: boolean
  tags?: string[]
}

export async function initReplBridge(
  _options?: InitBridgeOptions,
): Promise<ReplBridgeHandle | null> {
  // Wire the cse_ shim kill switch so toCompatSessionId respects the
  // GrowthBook gate. Daemon/SDK paths skip this — shim defaults to active.
  setCseShimGate(isCseShimEnabled)
  // OAuth 线路已移除：bridge 恒不可用，恒跳过。
  logBridgeSkip('not_enabled', '[bridge:repl] Skipping: bridge not enabled')
  return null
}
