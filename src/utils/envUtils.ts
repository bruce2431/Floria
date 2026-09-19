import memoize from 'lodash-es/memoize.js'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

// Memoized: 150+ callers, many on hot paths. Keyed off CLAUDE_CONFIG_DIR so
// tests that change the env var get a fresh value without explicit cache.clear.
// Portable root marker: a file INSIDE the config home itself
// (e.g. @WrokSpace\.claude\.claude-portable). It moves with the folder, so exe
// copies run from subdirectories can walk up and land on the same global config
// home no matter where the folder lives. Relative-only — no absolute paths.
const PORTABLE_MARKER_FILE = '.claude-portable'

// A config home is recognizable by content, not mere `.claude` existence.
// Project-local session storage creates `<project>/.claude/projects/` inside
// each project (see sessionStoragePortable.getProjectDir). That bare structure
// must NOT be mistaken for a config home — otherwise launching an exe next to
// it would hijack plugins/memory/credentials into the project folder. Real
// config homes carry at least one of these markers.
const CONFIG_HOME_MARKERS = [
  PORTABLE_MARKER_FILE,
  '.claude.json',
  'settings.json',
  'plugins',
  'skills',
  'commands',
  'credentials.json',
  'history.jsonl',
]

function looksLikeConfigHome(dir: string): boolean {
  return CONFIG_HOME_MARKERS.some(marker => existsSync(join(dir, marker)))
}

// Portable root = the directory that CONTAINS the global config home. Walk up
// from the exe; the first `.claude` carrying the `.claude-portable` marker
// means its PARENT (`dir`) is the portable root (e.g. `@WrokSpace`). Stop there —
// no further upward search. The `.claude` config-home folder itself is derived
// from the root by `getClaudeConfigHomeDir`. (Marker lives inside `.claude`,
// not beside it, so a bare project-local `.claude/projects/` never trips
// looksLikeConfigHome.)
function findPortableRoot(startDir: string): string | null {
  let dir = startDir
  for (;;) {
    const home = join(dir, '.claude')
    if (existsSync(join(home, PORTABLE_MARKER_FILE))) {
      return dir.normalize('NFC')
    }
    const parent = dirname(dir)
    if (parent === dir) return null // reached filesystem root
    dir = parent
  }
}

// Bare-machine bootstrap, called from the TrustDialog "yes" branch: when the
// exe would otherwise fall through to the home-dir default (no env var, no
// adjacent `.claude`, no portable marker up the tree), trusting the folder
// seeds the portable root next to the exe so the config home follows the exe
// from the next launch onward. Throws on failure (e.g. read-only dir) — the
// caller reports it without blocking the trust flow. This run keeps using the
// fallback config home; the marker is picked up on the next launch.
export function maybeInitPortableRoot(): void {
  if (process.env.CLAUDE_CONFIG_DIR) return
  const exeDir = dirname(process.execPath)
  if (exeDir === homedir()) return
  // Never touch an existing `.claude` next to the exe — it may be project-local
  // session storage; seeding into it could hijack or pollute it.
  if (existsSync(join(exeDir, '.claude'))) return
  if (findPortableRoot(exeDir)) return
  const configHome = join(exeDir, '.claude')
  mkdirSync(configHome)
  writeFileSync(join(configHome, PORTABLE_MARKER_FILE), '')
}

export const getClaudeConfigHomeDir = memoize(
  (): string => {
    // 1. Environment variable always wins
    if (process.env.CLAUDE_CONFIG_DIR) {
      return process.env.CLAUDE_CONFIG_DIR.normalize('NFC')
    }
    let exeDir: string | null = null
    // 2. Portable mode: .claude/ next to the executable
    try {
      const exePath = process.execPath
      if (exePath) {
        exeDir = dirname(exePath)
        const portablePath = join(exeDir, '.claude')
        if (existsSync(portablePath) && looksLikeConfigHome(portablePath)) {
          return portablePath.normalize('NFC')
        }
      }
    } catch {
      // process.execPath unavailable, ignore
    }
    // 3. Portable root marker walk-up: root = parent of `.claude/.claude-portable`;
    //    the config home is that `.claude` directory itself.
    if (exeDir) {
      const found = findPortableRoot(exeDir)
      if (found) return join(found, '.claude').normalize('NFC')
    }
    // 4. Default
    return join(homedir(), '.claude').normalize('NFC')
  },
  () => process.env.CLAUDE_CONFIG_DIR,
)

/**
 * Returns the portable root: the directory that CONTAINS the global `.claude/`
 * config home (the parent of the `.claude/.claude-portable` marker), resolved by
 * walking up from the executable directory. Stops at the first match. Falls back
 * to the home directory when no portable root marker is found.
 */
export function getPortableRoot(): string {
  let exeDir: string | null = null
  try {
    const exePath = process.execPath
    if (exePath) exeDir = dirname(exePath)
  } catch {
    // process.execPath unavailable, ignore
  }
  const root = exeDir ? findPortableRoot(exeDir) : null
  return root ?? homedir()
}

export function getTeamsDir(): string {
  return join(getClaudeConfigHomeDir(), 'teams')
}

/**
 * Check if NODE_OPTIONS contains a specific flag.
 * Splits on whitespace and checks for exact match to avoid false positives.
 */
export function hasNodeOption(flag: string): boolean {
  const nodeOptions = process.env.NODE_OPTIONS
  if (!nodeOptions) {
    return false
  }
  return nodeOptions.split(/\s+/).includes(flag)
}

export function isEnvTruthy(envVar: string | boolean | undefined): boolean {
  if (!envVar) return false
  if (typeof envVar === 'boolean') return envVar
  const normalizedValue = envVar.toLowerCase().trim()
  return ['1', 'true', 'yes', 'on'].includes(normalizedValue)
}

export function isEnvDefinedFalsy(
  envVar: string | boolean | undefined,
): boolean {
  if (envVar === undefined) return false
  if (typeof envVar === 'boolean') return !envVar
  if (!envVar) return false
  const normalizedValue = envVar.toLowerCase().trim()
  return ['0', 'false', 'no', 'off'].includes(normalizedValue)
}

/**
 * --bare / CLAUDE_CODE_SIMPLE — skip hooks, LSP, plugin sync, skill dir-walk,
 * attribution, background prefetches, and ALL keychain/credential reads.
 * Auth is strictly ANTHROPIC_API_KEY env or apiKeyHelper from --settings.
 * Explicit CLI flags (--plugin-dir, --add-dir, --mcp-config) still honored.
 * ~30 gates across the codebase.
 *
 * Checks argv directly (in addition to the env var) because several gates
 * run before main.tsx's action handler sets CLAUDE_CODE_SIMPLE=1 from --bare
 * — notably startKeychainPrefetch() at main.tsx top-level.
 */
export function isBareMode(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE) ||
    process.argv.includes('--bare')
  )
}

/**
 * Parses an array of environment variable strings into a key-value object
 * @param envVars Array of strings in KEY=VALUE format
 * @returns Object with key-value pairs
 */
export function parseEnvVars(
  rawEnvArgs: string[] | undefined,
): Record<string, string> {
  const parsedEnv: Record<string, string> = {}

  // Parse individual env vars
  if (rawEnvArgs) {
    for (const envStr of rawEnvArgs) {
      const [key, ...valueParts] = envStr.split('=')
      if (!key || valueParts.length === 0) {
        throw new Error(
          `Invalid environment variable format: ${envStr}, environment variables should be added as: -e KEY1=value1 -e KEY2=value2`,
        )
      }
      parsedEnv[key] = valueParts.join('=')
    }
  }
  return parsedEnv
}

/**
 * Get the AWS region with fallback to default
 * Matches the Anthropic Bedrock SDK's region behavior
 */
export function getAWSRegion(): string {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'
}

/**
 * Get the default Vertex AI region
 */
export function getDefaultVertexRegion(): string {
  return process.env.CLOUD_ML_REGION || 'us-east5'
}

/**
 * Check if bash commands should maintain project working directory (reset to original after each command)
 * @returns true if CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR is set to a truthy value
 */
export function shouldMaintainProjectWorkingDir(): boolean {
  return isEnvTruthy(process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR)
}

/**
 * Check if running on Homespace (ant-internal cloud environment)
 */
export function isRunningOnHomespace(): boolean {
  return (
    process.env.USER_TYPE === 'ant' &&
    isEnvTruthy(process.env.COO_RUNNING_ON_HOMESPACE)
  )
}

/**
 * Conservative check for whether Claude Code is running inside a protected
 * (privileged or ASL3+) COO namespace or cluster.
 *
 * Conservative means: when signals are ambiguous, assume protected. We would
 * rather over-report protected usage than miss it. Unprotected environments
 * are homespace, namespaces on the open allowlist, and no k8s/COO signals
 * at all (laptop/local dev).
 *
 * Used for telemetry to measure auto-mode usage in sensitive environments.
 */
export function isInProtectedNamespace(): boolean {
  // USER_TYPE is build-time --define'd; in external builds this block is
  // DCE'd so the require() and namespace allowlist never appear in the bundle.
  if (process.env.USER_TYPE === 'ant') {
    /* eslint-disable @typescript-eslint/no-require-imports */
    return (
      require('./protectedNamespace.js') as typeof import('./protectedNamespace.js')
    ).checkProtectedNamespace()
    /* eslint-enable @typescript-eslint/no-require-imports */
  }
  return false
}

// @[MODEL LAUNCH]: Add a Vertex region override env var for the new model.
/**
 * Model prefix → env var for Vertex region overrides.
 * Order matters: more specific prefixes must come before less specific ones
 * (e.g., 'claude-opus-4-1' before 'claude-opus-4').
 */
const VERTEX_REGION_OVERRIDES: ReadonlyArray<[string, string]> = [
  ['claude-haiku-4-5', 'VERTEX_REGION_CLAUDE_HAIKU_4_5'],
  ['claude-3-5-haiku', 'VERTEX_REGION_CLAUDE_3_5_HAIKU'],
  ['claude-3-5-sonnet', 'VERTEX_REGION_CLAUDE_3_5_SONNET'],
  ['claude-3-7-sonnet', 'VERTEX_REGION_CLAUDE_3_7_SONNET'],
  ['claude-opus-4-1', 'VERTEX_REGION_CLAUDE_4_1_OPUS'],
  ['claude-opus-4', 'VERTEX_REGION_CLAUDE_4_0_OPUS'],
  ['claude-sonnet-4-6', 'VERTEX_REGION_CLAUDE_4_6_SONNET'],
  ['claude-sonnet-4-5', 'VERTEX_REGION_CLAUDE_4_5_SONNET'],
  ['claude-sonnet-4', 'VERTEX_REGION_CLAUDE_4_0_SONNET'],
]

/**
 * Get the Vertex AI region for a specific model.
 * Different models may be available in different regions.
 */
export function getVertexRegionForModel(
  model: string | undefined,
): string | undefined {
  if (model) {
    const match = VERTEX_REGION_OVERRIDES.find(([prefix]) =>
      model.startsWith(prefix),
    )
    if (match) {
      return process.env[match[1]] || getDefaultVertexRegion()
    }
  }
  return getDefaultVertexRegion()
}
