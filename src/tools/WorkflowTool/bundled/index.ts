// Bundled workflow scripts. tools.ts calls initBundledWorkflows() at module
// load (under the WORKFLOW_SCRIPTS gate) before constructing WorkflowTool.
// Currently a no-op: workflow scripts are discovered from the project's
// .claude/workflows/ directory, so no bundled defaults are registered yet.

/**
 * Register built-in workflow scripts. Placeholder — add
 * registerBundledWorkflow(...) calls here if bundled defaults are ever wanted.
 */
export function initBundledWorkflows(): void {
  // No bundled workflows yet.
}
