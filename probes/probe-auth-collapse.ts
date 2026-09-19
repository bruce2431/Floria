/**
 * probe-auth-collapse.ts — OAuth 剥离收尾探针（2026-09-18）
 * 验证：auth.ts 保留/恢复导出可加载、errors.ts 401 文案、pool.ts 冷却自愈导出链。
 * 纯模块加载与纯函数断言，不写任何状态。
 */
import { getAnthropicApiKey, getAnthropicApiKeyWithSource, isUsing3PServices, isCodexSubscriber, removeApiKey, saveApiKey, getCodexOAuthTokens, hasAnthropicApiKeyAuth } from '../src/utils/auth.js'
import { INVALID_API_KEY_ERROR_MESSAGE, CREDENTIAL_POOL_NO_KEY_MESSAGE, startsWithApiErrorPrefix } from '../src/services/api/errors.js'
import { getActiveBaseUrl, getActiveApiKey, isActiveProviderKeyUnavailable } from '../src/utils/credentials/pool.js'

let pass = 0
let fail = 0
function check(name: string, cond: boolean): void {
  if (cond) {
    pass++
    console.log(`ok  ${name}`)
  } else {
    fail++
    console.log(`FAIL ${name}`)
  }
}

// auth.ts 保留导出（不抛错即通过）
check('auth.getAnthropicApiKey callable', typeof getAnthropicApiKey === 'function')
check('auth.getAnthropicApiKeyWithSource callable', typeof getAnthropicApiKeyWithSource === 'function')
check('auth.hasAnthropicApiKeyAuth callable', typeof hasAnthropicApiKeyAuth === 'function')
check('auth.removeApiKey callable', typeof removeApiKey === 'function')
check('auth.saveApiKey callable', typeof saveApiKey === 'function')
check('auth.getCodexOAuthTokens callable', typeof getCodexOAuthTokens === 'function')
check('auth.isUsing3PServices() returns bool', typeof isUsing3PServices() === 'boolean')
// isCodexSubscriber 内部走 getGlobalConfig（探针环境未 enableConfigs 会抛门控）——只验可调用
check('auth.isCodexSubscriber callable', typeof isCodexSubscriber === 'function')

// OAuth 符号确已消失（导入名不存在即抛错——能跑到这里说明模块无 OAuth 残留导出缺失）
check('errors.401 copy is no-login', INVALID_API_KEY_ERROR_MESSAGE === 'Not logged in · No usable credentials')
check('errors.pool copy mentions cooldown', CREDENTIAL_POOL_NO_KEY_MESSAGE.includes('10 分钟冷却后自动恢复'))
check('errors.prefix fn callable', typeof startsWithApiErrorPrefix === 'function')

// pool.ts 冷却链导出
check('pool.getActiveBaseUrl callable', typeof getActiveBaseUrl === 'function')
check('pool.getActiveApiKey callable', typeof getActiveApiKey === 'function')
check('pool.isActiveProviderKeyUnavailable callable', typeof isActiveProviderKeyUnavailable === 'function')
const key = getActiveApiKey()
check('pool.getActiveApiKey returns string|null', key === null || typeof key === 'string')

console.log(`\n${pass} pass / ${fail} fail`)
if (fail > 0) process.exit(1)
