/**
 * Built-in status line renderer (2026-09-19).
 *
 * Upstream renders the status line by spawning the command configured in
 * `settings.statusLine` and piping the status JSON to its stdin — so a status
 * line only exists if the user maintains an external script (the old
 * `~/.claude/statusline.mjs`). This fork compiles the default renderer in: no
 * external script, no spawn, no process boundary.
 *
 * A user-configured `settings.statusLine` command still wins (see
 * StatusLine.tsx `doUpdate`) — this is the built-in default, not a removal of
 * the extension point.
 *
 * Input is the same object shape the external command receives on stdin, but
 * passed in-process (no JSON round-trip).
 */

export type BuiltinStatusLineInput = {
  model?: {
    display_name?: string
    effort_level?: string | null
  } | null
  cost?: {
    total_cost_usd?: number | null
  } | null
  context_window?: {
    used_percentage?: number | null
    hit_rate_turn?: number | null
    hit_rate_session?: number | null
    total_cache_read_tokens?: number | null
    total_input_tokens?: number | null
  } | null
}

function formatTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

/**
 * Render one status line. Segments are omitted when the field is absent — e.g.
 * when the /cost cache-stats toggle is off, the cache fields are missing from
 * the input and only model · context% · cost show.
 */
export function renderBuiltinStatusLine(input: BuiltinStatusLineInput): string {
  const cw = input.context_window ?? {}
  const cost = input.cost ?? {}
  const parts: string[] = []

  const displayName = input.model?.display_name
  if (displayName) {
    const effort = input.model?.effort_level
    parts.push(effort ? `${displayName}·${effort}` : displayName)
  }
  if (cw.used_percentage != null) {
    parts.push(`${Math.round(cw.used_percentage)}% ctx`)
  }
  if (cw.hit_rate_turn != null && cw.hit_rate_session != null) {
    parts.push(
      `hit ${Math.round(cw.hit_rate_turn)}%/${Math.round(cw.hit_rate_session)}%`,
    )
    parts.push(`${formatTokens(cw.total_cache_read_tokens ?? 0)} cached`)
    parts.push(`${formatTokens(cw.total_input_tokens ?? 0)} in`)
  }
  if (cost.total_cost_usd != null && cost.total_cost_usd > 0) {
    parts.push(`$${cost.total_cost_usd.toFixed(2)}`)
  }

  return parts.join(' · ')
}
