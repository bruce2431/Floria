/**
 * Attribution hooks for commit-attribution tracking (COMMIT_ATTRIBUTION feature).
 *
 * This module is imported only when the COMMIT_ATTRIBUTION feature flag is
 * enabled. In builds without the flag it is dead-code-eliminated.
 *
 * @module
 */

/** Clear any attribution-related caches. */
function clearAttributionCaches() {
  // No-op in the stub; real implementations hook into attribution state.
}

/** Register attribution tracking hooks into the hook system. */
function registerAttributionHooks() {
  // No-op in the stub; real implementations register event hooks.
}

/** Sweep stale file-content cache entries. */
function sweepFileContentCache() {
  // No-op in the stub; real implementations clean up cached file contents.
}

module.exports = {
  clearAttributionCaches,
  registerAttributionHooks,
  sweepFileContentCache,
}
