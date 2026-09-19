// OAuth 订阅线路已移除：无订阅者，Console 计费访问恒不可用
export function hasConsoleBillingAccess(): boolean {
  return false
}

// Mock billing access for /mock-limits testing (set by mockRateLimits.ts)
let mockBillingAccessOverride: boolean | null = null

export function setMockBillingAccessOverride(value: boolean | null): void {
  mockBillingAccessOverride = value
}

export function hasClaudeAiBillingAccess(): boolean {
  // Check for mock billing access first (for /mock-limits testing)
  if (mockBillingAccessOverride !== null) {
    return mockBillingAccessOverride
  }

  // OAuth 订阅线路已移除：订阅态不存在
  return false
}
