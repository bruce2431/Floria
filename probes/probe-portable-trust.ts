/**
 * 探针：验证「信任依据 = `.claude-portable` 标记」。
 *
 * 不变量：目录位于便携根（`<root>/.claude/.claude-portable`）之下 ⇒ 已信任，
 * 与全局配置里的绝对路径记录无关。标记由 TrustDialog 的 yes 分支写入
 * （maybeInitPortableRoot）——「信任该文件夹」本身就是「把它设为全局根并初始化」，
 * 所以标记即信任记录，盘符 / 挂载点 / 机器变化都不影响。
 *
 * 构造场景：
 *   <tmp>/floria-portable-trust-probe/
 *     .claude/.claude-portable     <- 标记（期望的信任依据）
 *     .claude/.claude.json         <- 空 projects（无任何绝对路径记录）
 *     proj/cli-fake.exe            <- 伪 exe，令 execPath 指向此处
 *
 * 期望：
 *   A. isUnderPortableRoot(<root>/proj)              === true   标记在，判可信
 *   B. isUnderPortableRoot(<root> 之外的目录)         === false  标记不在
 *   C. 在 proj 下 checkHasTrustDialogAccepted()       === true   端到端（且无路径记录）
 *   D. 删掉标记后同一 cwd                              === false  对照：依据确为标记
 *
 * 用法：bun probes/probe-portable-trust.ts
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(tmpdir(), 'floria-portable-trust-probe')
const outside = join(tmpdir(), 'floria-portable-trust-probe-outside')
rmSync(root, { recursive: true, force: true })
rmSync(outside, { recursive: true, force: true })

mkdirSync(join(root, '.claude'), { recursive: true })
writeFileSync(join(root, '.claude', '.claude-portable'), '')
writeFileSync(join(root, '.claude', '.claude.json'), '{"projects":{}}')

const proj = join(root, 'proj')
mkdirSync(proj, { recursive: true })
const fakeExe = join(proj, 'cli-fake.exe')
writeFileSync(fakeExe, '')
mkdirSync(outside, { recursive: true })

// 必须在 envUtils 首次调用 getClaudeConfigHomeDir 之前覆写
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

const { isUnderPortableRoot } = await import('../src/utils/envUtils.js')
const {
  checkHasTrustDialogAccepted,
  enableConfigs,
  resetTrustDialogAcceptedCacheForTesting,
} = await import('../src/utils/config.js')
const { runWithCwdOverride } = await import('../src/utils/cwd.js')

// The real bootstrap opens the config-reading gate before any trust check; D
// falls through the marker short-circuit to the config lookup, so the probe
// must do the same or it trips the "Config accessed before allowed" guard.
enableConfigs()

const results: boolean[] = []
function check(name: string, got: unknown, want: unknown): void {
  const ok = got === want
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got=${String(got)} want=${String(want)}`)
}

check('A 便携根内的目录判为可信', isUnderPortableRoot(proj), true)
check('B 便携根外的目录判为不可信', isUnderPortableRoot(outside), false)
check(
  'C 端到端：cwd 在便携根下即已信任（无任何路径记录）',
  runWithCwdOverride(proj, () => checkHasTrustDialogAccepted()),
  true,
)

// 对照：抽掉标记，同一 cwd 必须回到未信任
rmSync(join(root, '.claude', '.claude-portable'))
resetTrustDialogAcceptedCacheForTesting()
check(
  'D 删掉标记后同一 cwd 不再信任',
  runWithCwdOverride(proj, () => checkHasTrustDialogAccepted()),
  false,
)

rmSync(root, { recursive: true, force: true })
rmSync(outside, { recursive: true, force: true })

const failed = results.filter(r => !r).length
console.log('---')
console.log(`${results.length - failed}/${results.length} PASS`)
process.exit(failed ? 1 : 0)
