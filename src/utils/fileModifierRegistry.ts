import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'fs'
import { dirname, resolve } from 'path'
import { getSessionId } from 'src/bootstrap/state.js'
import { logForDebugging } from 'src/utils/debug.js'
import { getProjectRuntimeDir } from 'src/utils/projectConfig.js'

// Cross-process registry mapping file paths to the session that last wrote
// them. Each CLI session is a separate process with private memory, so the
// only channel for "who modified this file" is disk: writers append a line,
// and a session hitting the modified-since-read staleness gate looks the
// modifier's session id up here.

const REGISTRY_FILE = 'file-mods.jsonl'
const COMPACT_THRESHOLD_BYTES = 1_000_000
const COMPACT_KEEP_LINES = 1000

function registryPath(): string {
  return getProjectRuntimeDir(REGISTRY_FILE)
}

function normalizeKey(filePath: string): string {
  const resolved = resolve(filePath)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Record that this session just wrote filePath. Best-effort — attribution
 * must never break the write itself.
 */
export function recordFileModifier(filePath: string): void {
  try {
    const path = registryPath()
    mkdirSync(dirname(path), { recursive: true })
    compactIfNeeded(path)
    const entry = JSON.stringify({
      p: normalizeKey(filePath),
      sid: getSessionId(),
      ts: Date.now(),
    })
    appendFileSync(path, entry + '\n', 'utf8')
  } catch (e) {
    logForDebugging(
      `fileModifierRegistry: record failed: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

/**
 * If another session wrote filePath after sinceTs, return its session id.
 * Newest entry wins; own-session entries are skipped (our own writes keep
 * readFileState fresh, so they cannot be the cause of a staleness gate).
 */
export function findFileModifier(
  filePath: string,
  sinceTs: number,
): string | undefined {
  let lines: string[]
  try {
    lines = readFileSync(registryPath(), 'utf8').split('\n')
  } catch {
    return undefined
  }
  const key = normalizeKey(filePath)
  const ownSid = getSessionId()
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      const entry = JSON.parse(line) as { p?: string; sid?: string; ts?: number }
      if (
        entry.p === key &&
        entry.sid &&
        entry.sid !== ownSid &&
        entry.ts !== undefined &&
        entry.ts > sinceTs
      ) {
        return entry.sid
      }
    } catch {
      // tolerate corrupt/partial lines from racing appends
    }
  }
  return undefined
}

/**
 * Attribution suffix for staleness messages, '' when no other-session write
 * qualifies (user/linter edits stay unattributed).
 */
export function fileModifierSuffix(filePath: string, sinceTs: number): string {
  const sid = findFileModifier(filePath, sinceTs)
  return sid ? ` (last modified by session ${sid})` : ''
}

function compactIfNeeded(path: string): void {
  try {
    if (statSync(path).size <= COMPACT_THRESHOLD_BYTES) return
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
    writeFileSync(path, lines.slice(-COMPACT_KEEP_LINES).join('\n') + '\n', 'utf8')
  } catch {
    // ENOENT on first write, or a raced compaction — both fine
  }
}
