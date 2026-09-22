/**
 * 探针：在「崭新位置」（新盘 / 新机器）运行 exe 时，便携配置根能否自举。
 *
 * 不变量：
 *   A. 首次运行（无 CLAUDE_CONFIG_DIR、exe 邻接无 .claude、祖先无便携标记）
 *      → 配置根回退到 ~/.claude（标准行为，非便携）。
 *   B. 用户在信任对话框中接受后，maybeInitPortableRoot() 在 exe 邻接写入
 *      .claude/.claude-portable（此后配置根跟 exe 走）。
 *   C. 二次运行（同一布局、标记已在）→ 配置根 = <exeDir>/.claude，
 *      压过 ~/.claude 回退。
 *
 * 构造场景：
 *   <tmp>/floria-fresh-machine-probe/
 *     NewDrive/          <- 假「崭新盘」，只有 exe，无 .claude
 *       cli-dev-fake.exe
 *     FakeHome/          <- 假 user home，无 .claude
 *
 * 用法：bun probes/probe-fresh-machine-bootstrap.ts
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(tmpdir(), 'floria-fresh-machine-probe')
rmSync(root, { recursive: true, force: true })

const drive = join(root, 'NewDrive') // 假「崭新盘」
const fakeHome = join(root, 'FakeHome') // 假 user home
mkdirSync(drive, { recursive: true })
mkdirSync(fakeHome, { recursive: true })
const fakeExe = join(drive, 'cli-dev-fake.exe')
writeFileSync(fakeExe, '')

try {
  Object.defineProperty(process, 'execPath', { value: fakeExe, configurable: true })
} catch (e) {
  console.log('无法覆写 process.execPath，探针作废:', String(e))
  process.exit(2)
}
delete process.env.CLAUDE_CONFIG_DIR
// 重定向 home，模拟另一台机器
process.env.USERPROFILE = fakeHome
process.env.HOMEDRIVE = fakeHome.slice(0, 2)
process.env.HOMEPATH = fakeHome.slice(2)

const envUtils = await import('../src/utils/envUtils.js')
const { getClaudeConfigHomeDir, getPortableRoot, maybeInitPortableRoot } = envUtils

const norm = (p: string) => p.normalize('NFC')
const results: Array<[string, boolean, string]> = []

// ── A. 首次运行：回退 ~/.claude ──
const first = getClaudeConfigHomeDir()
results.push([
  'A 首次运行回退到 ~/.claude',
  first === norm(join(fakeHome, '.claude')),
  first,
])

// ── B. 接受信任 → 邻接种下便携标记 ──
let threw = ''
try {
  maybeInitPortableRoot()
} catch (e) {
  threw = String(e)
}
const marker = join(drive, '.claude', '.claude-portable')
results.push([
  'B 信任后在 exe 邻接写入 .claude/.claude-portable',
  !threw && existsSync(marker),
  threw || marker,
])

// ── C. 二次运行：标记压过 ~/.claude ──
// memoize 缓存键是 CLAUDE_CONFIG_DIR、本进程内不会失效；清缓存模拟「重开进程」
;(getClaudeConfigHomeDir as unknown as { cache: { clear(): void } }).cache.clear()
const second = getClaudeConfigHomeDir()
results.push([
  'C 二次运行配置根 = <exeDir>/.claude',
  second === norm(join(drive, '.claude')),
  second,
])
results.push([
  'C2 getPortableRoot() = exe 所在盘根',
  norm(getPortableRoot()) === norm(drive),
  getPortableRoot(),
])

let fail = 0
for (const [name, ok, detail] of results) {
  if (!ok) fail++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
  console.log(`      ${detail}`)
}
console.log('---')
console.log(`${results.length - fail} 过 / ${fail} 败`)
console.log('注意：A 说明首轮运行的登录/onboarding 状态落在 ~/.claude，')
console.log('     而非 exe 邻接的便携根——二次运行起才切到便携根。')

rmSync(root, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
