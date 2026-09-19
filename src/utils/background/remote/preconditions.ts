import { getCwd } from '../../cwd.js'
import { logForDebugging } from '../../debug.js'
import { detectCurrentRepository } from '../../detectRepository.js'
import { errorMessage } from '../../errors.js'
import { findGitRoot, getIsClean } from '../../git.js'
import { fetchEnvironments } from '../../teleport/environments.js'

/**
 * Checks if user needs to log in with Claude.ai
 * Extracted from getTeleportErrors() in TeleportError.tsx
 * @returns true if login is required, false otherwise
 */
export async function checkNeedsClaudeAiLogin(): Promise<boolean> {
  // OAuth 线路已移除：无订阅态，恒不需要登录
  return false
}

/**
 * Checks if git working directory is clean (no uncommitted changes)
 * Ignores untracked files since they won't be lost during branch switching
 * Extracted from getTeleportErrors() in TeleportError.tsx
 * @returns true if git is clean, false otherwise
 */
export async function checkIsGitClean(): Promise<boolean> {
  const isClean = await getIsClean({ ignoreUntracked: true })
  return isClean
}

/**
 * Checks if user has access to at least one remote environment
 * @returns true if user has remote environments, false otherwise
 */
export async function checkHasRemoteEnvironment(): Promise<boolean> {
  try {
    const environments = await fetchEnvironments()
    return environments.length > 0
  } catch (error) {
    logForDebugging(`checkHasRemoteEnvironment failed: ${errorMessage(error)}`)
    return false
  }
}

/**
 * Checks if current directory is inside a git repository (has .git/).
 * Distinct from checkHasGitRemote — a local-only repo passes this but not that.
 */
export function checkIsInGitRepo(): boolean {
  return findGitRoot(getCwd()) !== null
}

/**
 * Checks if current repository has a GitHub remote configured.
 * Returns false for local-only repos (git init with no `origin`).
 */
export async function checkHasGitRemote(): Promise<boolean> {
  const repository = await detectCurrentRepository()
  return repository !== null
}

/**
 * Checks if GitHub app is installed on a specific repository
 * @param owner The repository owner (e.g., "anthropics")
 * @param repo The repository name (e.g., "claude-cli-internal")
 * @returns true if GitHub app is installed, false otherwise
 */
export async function checkGithubAppInstalled(
  owner: string,
  repo: string,
  signal?: AbortSignal,
): Promise<boolean> {
  // OAuth 线路已移除：无 token/org，GitHub app 检查恒 false
  return false
}

/**
 * Checks if the user has synced their GitHub credentials via /web-setup
 * @returns true if GitHub token is synced, false otherwise
 */
export async function checkGithubTokenSynced(): Promise<boolean> {
  // OAuth 线路已移除：无 token/org，token 同步检查恒 false
  return false
}

type RepoAccessMethod = 'github-app' | 'token-sync' | 'none'

/**
 * Tiered check for whether a GitHub repo is accessible for remote operations.
 * 1. GitHub App installed on the repo
 * 2. GitHub token synced via /web-setup
 * 3. Neither — caller should prompt user to set up access
 */
export async function checkRepoForRemoteAccess(
  owner: string,
  repo: string,
): Promise<{ hasAccess: boolean; method: RepoAccessMethod }> {
  // OAuth 线路已移除：两条 access 路径均不可达
  return { hasAccess: false, method: 'none' }
}
