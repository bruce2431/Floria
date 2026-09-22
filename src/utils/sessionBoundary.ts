/**
 * Session boundary bookkeeping: the start/end markers a process appends to its
 * transcript, and the model-visible continuity note built from them on resume.
 *
 * Kept free of I/O so the parsing and note-building logic is probe-testable
 * (see probes/probe-session-boundary.ts). The write/read sides live in
 * sessionStorage.ts (recordSessionBoundary / readLastSessionBoundary).
 */
import type { UUID } from 'crypto'
import type { SessionBoundaryEntry } from '../types/logs.js'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** Human-readable duration, coarse enough to stay short in the prompt. */
export function formatGap(ms: number): string {
  if (ms < MINUTE_MS) return `${Math.max(0, Math.round(ms / 1000))} seconds`
  if (ms < HOUR_MS) return `${Math.round(ms / MINUTE_MS)} minutes`
  if (ms < DAY_MS) {
    const h = Math.floor(ms / HOUR_MS)
    const m = Math.round((ms % HOUR_MS) / MINUTE_MS)
    return m > 0 ? `${h}h ${m}m` : `${h}h`
  }
  const d = Math.floor(ms / DAY_MS)
  const h = Math.round((ms % DAY_MS) / HOUR_MS)
  return h > 0 ? `${d} days ${h}h` : `${d} days`
}

/**
 * Parse the most recent session-boundary line out of a transcript tail.
 *
 * Matching is on the literal `{"type":"session-boundary"` prefix (the type
 * field is written first by jsonStringify) so it cannot match the same string
 * nested inside a serialized tool input.
 */
export function parseLastSessionBoundaryFromTail(
  tail: string,
): SessionBoundaryEntry | null {
  if (!tail) return null
  const line = tail
    .split('\n')
    .findLast(l => l.startsWith('{"type":"session-boundary"'))
  if (!line) return null
  try {
    const entry = JSON.parse(line) as SessionBoundaryEntry
    return entry?.type === 'session-boundary' ? entry : null
  } catch {
    return null
  }
}

export function buildSessionBoundaryEntry(
  sessionId: UUID,
  event: 'start' | 'end',
  reason: string,
  now: Date = new Date(),
): SessionBoundaryEntry {
  return {
    type: 'session-boundary',
    sessionId,
    event,
    reason,
    timestamp: now.toISOString(),
  }
}

/**
 * Build the model-visible note injected at the head of a resumed conversation.
 *
 * A resumed process otherwise has no idea how long the session has been
 * dormant: message timestamps are stripped before the API call, so the model
 * reads the old transcript as if it were still current. This note states the
 * last activity time, whether the previous process exited cleanly, the current
 * start time, and the elapsed gap — and warns (with intensity scaling to the
 * gap) that the environment may have moved on.
 *
 * Returns null when the last activity time is unknown — a vague note is worse
 * than none.
 */
export function buildSessionContinuityNote(opts: {
  lastActivityTs?: string
  prevBoundary: SessionBoundaryEntry | null
  now?: Date
}): string | null {
  const lastMs = opts.lastActivityTs ? Date.parse(opts.lastActivityTs) : NaN
  if (!Number.isFinite(lastMs)) return null

  const now = opts.now ?? new Date()
  const gap = Math.max(0, now.getTime() - lastMs)

  const exitLine = opts.prevBoundary
    ? opts.prevBoundary.event === 'end'
      ? `graceful exit (recorded ${opts.prevBoundary.timestamp})`
      : 'NOT recorded — the previous process was killed, crashed, or lost power'
    : 'unknown (no boundary recorded by an older build)'

  const warning =
    gap >= DAY_MS
      ? "A long time has passed. Do NOT assume the earlier context still holds — files may have moved or changed, processes may be gone, versions may have advanced, and the user's situation may differ. Verify against the live environment (read files, check git log / running processes) before acting on old conclusions."
      : gap >= HOUR_MS
        ? 'Some time has passed. Anything time-sensitive from the earlier transcript (file contents, running processes, external state) may have changed — re-check before relying on it.'
        : 'The gap is short; the earlier context is still likely current.'

  return [
    '<session-continuity>',
    'This conversation has been resumed in a NEW process. The transcript above is from an earlier run of this same session.',
    '',
    `- Previous session last activity: ${opts.lastActivityTs}`,
    `- Previous session exit: ${exitLine}`,
    `- Current session started: ${now.toISOString()}`,
    `- Time since last activity: ${formatGap(gap)}`,
    '',
    warning,
    '</session-continuity>',
  ].join('\n')
}
