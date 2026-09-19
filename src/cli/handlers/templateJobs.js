/**
 * Template/job command handlers (TEMPLATES feature).
 *
 * Handles `claude new`, `claude list`, `claude reply` — template-based job
 * creation and management commands.
 *
 * @module
 */

/**
 * Entry point for template subcommands.
 *
 * @param {string[]} args - CLI arguments (subcommand + options).
 */
async function templatesMain(args) {
  // Stub: log a message and let the caller exit.
  process.stderr.write(
    'Template jobs are not available in this build.\n',
  )
}

/**
 * Classify the most recent turn and write the classification state to the
 * job directory so the job orchestrator can react to it.
 *
 * @param {string}  _jobDir   - Path to the job working directory
 *        ($CLAUDE_JOB_DIR).
 * @param {unknown} _messages - The assistant messages from the current turn.
 * @returns {Promise<void>}
 */
async function classifyAndWriteState(_jobDir, _messages) {
  // No-op in the stub; real implementations write classification results
  // to the job directory for the orchestrator to consume.
}

module.exports = {
  templatesMain,
  classifyAndWriteState,
}
