import { registerBundledSkill } from '../bundledSkills.js'

const HUNTER_PROMPT = `# Hunter: Bug Hunt

Review the current change for bugs and produce a review artifact for the user's approval. You hunt and report — you do NOT fix code unless the user explicitly asks.

## Phase 1: Locate the Change

Run \`git diff\` (or \`git diff HEAD\` if there are staged changes) to see what changed. If a base branch, PR number, or paths are given, scope the hunt to those. If there are no git changes and no other target, stop and ask the user what to review.

## Phase 2: Hunt by Severity

Analyze the change for real bugs, severity first. For each suspicious spot, verify it is actually reachable before reporting it:

1. **Correctness**: logic errors, race conditions, edge cases, null/undefined handling, off-by-one, wrong operator, dead code, incorrect state transitions
2. **Security**: injection, secrets committed, unsafe deserialization, path traversal, missing authz checks
3. **Robustness**: swallowed errors, partial-failure handling, missing cleanup / resource leaks, missing retries or idempotency
4. **Performance**: hot-path work, N+1 queries, repeated file/network reads, blocking I/O on the main path, unbounded memory growth
5. **Testability / conventions**: changed paths missing test coverage, misleading names, dead imports

Do not repeat the reuse / cleanup pass of /simplify — focus on bugs that can cause wrong behavior or breakage.

## Phase 3: Verify the Evidence

Every finding needs evidence: cite the file and line, and explain the failing scenario concretely. Run a cheap check (typecheck or the relevant test) when it would confirm or refute a candidate. If you cannot verify a suspicion, mark it as \`maybe\` rather than asserting it as a fact.

## Phase 4: Produce the Review Artifact

Compile your findings into a structured artifact and call the ReviewArtifact tool to get the user's approval before it is saved:

- \`title\`: a short title for the review
- \`summary\`: overview of what was reviewed and the key conclusions
- \`findings\`: ordered list, most severe first. Each finding: unique \`id\`, \`severity\` (critical|security|major|minor|perf), the affected \`file\`, optional 1-based \`line\`, a \`title\`, a \`description\` explaining why it is a bug, and an optional \`fix\`.
- Pass a \`targetFile\` (relative path) to control where the markdown artifact is saved.

The approval dialog lets the user deselect findings before approving; only the selected findings are saved. After the tool returns, give the user a short summary of the saved artifact in your reply.

## Rules

- Report only; do not modify code unless the user asked for fixes in the hunt target.
- Skip findings that are not real problems — do not pad the artifact.
- If everything looks clean, say so and offer to skip the artifact.
`

export function registerHunterSkill(): void {
  registerBundledSkill({
    name: 'hunter',
    description:
      'Hunt for bugs in the current change and produce a review artifact for your approval.',
    whenToUse:
      'Use after a set of code changes when you want a focused bug hunt with a reviewable artifact, e.g. before committing or opening a PR.',
    argumentHint: '[<base branch> | <PR number> | <paths...>]',
    userInvocable: true,
    async getPromptForCommand(args) {
      let prompt = HUNTER_PROMPT
      if (args) {
        prompt += `\n\n## Hunt Target\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
