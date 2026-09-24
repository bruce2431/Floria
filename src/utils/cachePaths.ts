import { join } from 'path'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { getFsImplementation } from './fsOperations.js'
import { djb2Hash } from './hash.js'

// Anchored to the portable config home, never the host's %LOCALAPPDATA%
// (`env-paths` would resolve to %LOCALAPPDATA%\claude-cli-nodejs\Cache on
// Windows): a portable install must not leave traces on whatever machine the
// drive is plugged into, and the base path must follow the drive letter.
function cacheRoot(): string {
  return join(getClaudeConfigHomeDir(), 'cache')
}

// Local sanitizePath using djb2Hash — NOT the shared version from
// sessionStoragePortable.ts which uses Bun.hash (wyhash) when available.
// Cache directory names must remain stable across upgrades so existing cache
// data (error logs, MCP logs) is not orphaned.
const MAX_SANITIZED_LENGTH = 200
function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, '-')
  if (sanitized.length <= MAX_SANITIZED_LENGTH) {
    return sanitized
  }
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${Math.abs(djb2Hash(name)).toString(36)}`
}

function getProjectDir(cwd: string): string {
  return sanitizePath(cwd)
}

export const CACHE_PATHS = {
  baseLogs: () => join(cacheRoot(), getProjectDir(getFsImplementation().cwd())),
  errors: () =>
    join(cacheRoot(), getProjectDir(getFsImplementation().cwd()), 'errors'),
  messages: () =>
    join(cacheRoot(), getProjectDir(getFsImplementation().cwd()), 'messages'),
  mcpLogs: (serverName: string) =>
    join(
      cacheRoot(),
      getProjectDir(getFsImplementation().cwd()),
      // Sanitize server name for Windows compatibility (colons are reserved for drive letters)
      `mcp-logs-${sanitizePath(serverName)}`,
    ),
}
