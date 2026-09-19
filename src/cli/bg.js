/**
 * Background session management for Claude Code (BG_SESSIONS feature).
 *
 * Handles `claude ps`, `claude logs <id>`, `claude attach <id>`,
 * `claude kill <id>`, and `claude --bg` / `claude --background` flags.
 *
 * @module
 */

const STUB_MESSAGE =
  'Background sessions are not available in this build.\n'

/**
 * Handle `claude ps [filters]` — list background sessions.
 *
 * @param {string[]} _args - Optional filter arguments.
 */
async function psHandler(_args) {
  process.stderr.write(STUB_MESSAGE)
}

/**
 * Handle `claude logs <sessionId>` — show logs for a background session.
 *
 * @param {string} _sessionId - The session identifier.
 */
async function logsHandler(_sessionId) {
  process.stderr.write(STUB_MESSAGE)
}

/**
 * Handle `claude attach <sessionId>` — re-attach to a background session.
 *
 * @param {string} _sessionId - The session identifier.
 */
async function attachHandler(_sessionId) {
  process.stderr.write(STUB_MESSAGE)
}

/**
 * Handle `claude kill <sessionId>` — terminate a background session.
 *
 * @param {string} _sessionId - The session identifier.
 */
async function killHandler(_sessionId) {
  process.stderr.write(STUB_MESSAGE)
}

/**
 * Handle `claude --bg` / `claude --background` — start a session in the
 * background.
 *
 * @param {string[]} _args - The full CLI argument list (the flag is already
 *        consumed by the time this handler runs).
 */
async function handleBgFlag(_args) {
  process.stderr.write(STUB_MESSAGE)
}

module.exports = {
  psHandler,
  logsHandler,
  attachHandler,
  killHandler,
  handleBgFlag,
}
