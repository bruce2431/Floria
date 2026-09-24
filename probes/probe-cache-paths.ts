/**
 * 探针：CLI 缓存/日志路径锚定便携配置根，而非宿主 `%LOCALAPPDATA%`。
 *
 * 不变量：`CACHE_PATHS` 四个基路径都以 `<配置根>/cache` 开头——便携版插到任何
 * 机器上都不在宿主盘留痕，且基路径随盘符 / 挂载点走。（`env-paths` 所返回的
 * `%LOCALAPPDATA%\claude-cli-nodejs\Cache` 会把日志写进宿主用户目录，换盘符还会
 * 再生成一套。）
 *
 * 构造场景：
 *   <tmp>/floria-cache-paths-probe/
 *     .claude/.claude-portable      <- 便携标记（令配置根 = 该 .claude）
 *     proj/cli-fake.exe             <- 伪 exe，令 execPath 指向此处
 *
 * 用法：bun probes/probe-cache-paths.ts
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'

const root = join(tmpdir(), 'floria-cache-paths-probe')
rmSync(root, { recursive: true, force: true })

mkdirSync(join(root, '.claude'), { recursive: true })
writeFileSync(join(root, '.claude', '.claude-portable'), '')
const proj = join(root, 'proj')
mkdirSync(proj, { recursive: true })
const fakeExe = join(proj, 'cli-fake.exe')
writeFileSync(fakeExe, '')

try {
  Object.defineProperty(process, 'execPath', {
    value: fakeExe,
    configurable: true,
  })
} catch (e) {
  console.log('无法覆写 process.execPath，探针作废:', String(e))
  process.exit(2)
}
delete process.env.CLAUDE_CONFIG_DIR

const { CACHE_PATHS } = await import('../src/utils/cachePaths.js')

const wantRoot = normalize(join(root, '.claude', 'cache')).normalize('NFC')
const results: boolean[] = []
function check(name: string, ok: boolean, detail: string): void {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) console.log(`      ${detail}`)
}

const base = CACHE_PATHS.baseLogs().normalize('NFC')
const errors = CACHE_PATHS.errors().normalize('NFC')
const messages = CACHE_PATHS.messages().normalize('NFC')
const mcp = CACHE_PATHS.mcpLogs('plugin-github-github').normalize('NFC')

check('A baseLogs 落在 <配置根>/cache 下', base.startsWith(wantRoot), base)
check('B errors 落在 <配置根>/cache 下', errors.startsWith(wantRoot), errors)
check('C messages 落在 <配置根>/cache 下', messages.startsWith(wantRoot), messages)
check(
  'D mcpLogs 落在 <配置根>/cache 下且目录名为 mcp-logs-<server>',
  mcp.startsWith(wantRoot) && mcp.includes('mcp-logs-plugin-github-github'),
  mcp,
)

// 反向断言：不得出现 env-paths 的宿主特征目录名。只查 `claude-cli-nodejs`
// 而不查 `AppData` —— 本探针把场景建在 `%TEMP%` 下，而 `%TEMP%` 自身就在
// `AppData` 里，按子串判会假阳性。该不变量（路径落在便携配置根而非宿主用户
// 目录）已由 A–D 的 `startsWith(wantRoot)` 严格覆盖：若仍走 env-paths，四条
// 路径都以 `%LOCALAPPDATA%\claude-cli-nodejs\Cache` 开头，A–D 必挂。
const hostTraces = [base, errors, messages, mcp].filter(p =>
  /claude-cli-nodejs/i.test(p),
)
check(
  'E 无任何路径引用 env-paths 的 claude-cli-nodejs 目录',
  hostTraces.length === 0,
  hostTraces.join(' | '),
)

rmSync(root, { recursive: true, force: true })

const failed = results.filter(r => !r).length
console.log('---')
console.log(`${results.length - failed}/${results.length} PASS`)
process.exit(failed ? 1 : 0)
