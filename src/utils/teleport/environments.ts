export type EnvironmentKind = 'anthropic_cloud' | 'byoc' | 'bridge'
export type EnvironmentState = 'active'

export type EnvironmentResource = {
  kind: EnvironmentKind
  environment_id: string
  name: string
  created_at: string
  state: EnvironmentState
}

export type EnvironmentListResponse = {
  environments: EnvironmentResource[]
  has_more: boolean
  first_id: string | null
  last_id: string | null
}

/**
 * Fetches the list of available environments from the Environment API
 * @returns Promise<EnvironmentResource[]> Array of available environments
 * @throws Error if the API request fails or no access token is available
 */
export async function fetchEnvironments(): Promise<EnvironmentResource[]> {
  // OAuth 线路已移除：无 access token，环境列表恒失败
  throw new Error(
    'Claude Code web sessions require authentication with a Claude.ai account. API key authentication is not sufficient. Teleport (claude.ai web sessions) is unavailable in this build.',
  )
}

/**
 * Creates a default anthropic_cloud environment for users who have none.
 * Uses the public environment_providers route (same auth as fetchEnvironments).
 */
export async function createDefaultCloudEnvironment(
  name: string,
): Promise<EnvironmentResource> {
  // OAuth 线路已移除：无 access token，环境创建恒失败
  throw new Error('No access token available')
}
