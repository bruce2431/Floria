import { useMemo } from 'react'
import { useAppState } from '../state/AppState.js'
import {
  hasVoiceAuth,
  isVoiceGrowthBookEnabled,
} from '../voice/voiceModeEnabled.js'

/**
 * Combines user intent (settings.voiceEnabled) with auth + GB kill-switch.
 * Only the auth half is memoized on authVersion (the expensive half); GB is a
 * cheap cached-map lookup and stays outside the memo so a mid-session
 * kill-switch flip still takes effect on the next render.
 */
export function useVoiceEnabled(): boolean {
  const userIntent = useAppState(s => s.settings.voiceEnabled === true)
  const authVersion = useAppState(s => s.authVersion)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const authed = useMemo(hasVoiceAuth, [authVersion])
  return userIntent && authed && isVoiceGrowthBookEnabled()
}
