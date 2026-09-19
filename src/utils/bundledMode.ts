/**
 * Detects if the current runtime is Bun.
 * Returns true when:
 * - Running a JS file via the `bun` command
 * - Running a Bun-compiled standalone executable
 */
export function isRunningWithBun(): boolean {
  // https://bun.com/guides/util/detect-bun
  return process.versions.bun !== undefined
}

/**
 * Detects if running as a Bun-compiled standalone executable.
 *
 * Two build flavors exist:
 * 1. Classic `bun build --compile` (file embeds): embedded assets surface as
 *    `Bun.embeddedFiles` (non-empty array).
 * 2. `--bytecode` builds (this repo's build.ts): bytecode is embedded but is
 *    NOT exposed via `Bun.embeddedFiles`, so that array is empty/undefined.
 *    Instead the compiled entrypoint leaves a virtual bundle path in argv[1]
 *    (e.g. "B:/~BUN/root/cli-dev"). Its presence identifies the build.
 *
 * Misdetecting a --bytecode exe as non-bundled makes spawners pass argv[1]
 * (the virtual path) as an argument/command — the child claude then errors
 * "too many arguments. Expected 1 argument but got 2." and sub-agent spawns
 * target a non-existent path.
 */
export function isInBundledMode(): boolean {
  if (typeof Bun === 'undefined') return false
  if (Array.isArray(Bun.embeddedFiles) && Bun.embeddedFiles.length > 0) {
    return true
  }
  return (
    typeof process.argv[1] === 'string' &&
    process.argv[1].includes('/~BUN/')
  )
}
