// Anthropic voice_stream speech-to-text client for push-to-talk.
//
// The voice_stream endpoint is claude.ai OAuth-only; with the OAuth path
// retired this client is permanently unavailable. Only the exported types
// and the collapsed availability/connect entry points remain for callers.

import { logForDebugging } from '../utils/debug.js'

// ─── Types ──────────────────────────────────────────────────────────

export type VoiceStreamCallbacks = {
  onTranscript: (text: string, isFinal: boolean) => void
  onError: (error: string, opts?: { fatal?: boolean }) => void
  onClose: () => void
  onReady: (connection: VoiceStreamConnection) => void
}

// How finalize() resolved. `no_data_timeout` means zero server messages
// after CloseStream — the silent-drop signature (anthropics/anthropic#287008).
export type FinalizeSource =
  | 'post_closestream_endpoint'
  | 'no_data_timeout'
  | 'safety_timeout'
  | 'ws_close'
  | 'ws_already_closed'

export type VoiceStreamConnection = {
  send: (audioChunk: Buffer) => void
  finalize: () => Promise<FinalizeSource>
  close: () => void
  isConnected: () => boolean
}

// ─── Availability ──────────────────────────────────────────────────────

export function isVoiceStreamAvailable(): boolean {
  // voice_stream used the same OAuth as Claude Code; that path is gone.
  return false
}

// ─── Connection ────────────────────────────────────────────────────────

export async function connectVoiceStream(
  callbacks: VoiceStreamCallbacks,
  _options?: { language?: string; keyterms?: string[] },
): Promise<VoiceStreamConnection | null> {
  logForDebugging('[voice_stream] No OAuth token available')
  return null
}
