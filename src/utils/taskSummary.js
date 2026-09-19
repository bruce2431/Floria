// Stub: task summary generation for the BG_SESSIONS feature flag.
// In the full build this generates progress summaries for background sessions.

export function shouldGenerateTaskSummary() {
  return false
}

export async function maybeGenerateTaskSummary(_options) {
  // no-op in this build
}
