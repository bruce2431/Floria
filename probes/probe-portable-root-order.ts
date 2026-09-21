/**
 * 探针：验证 getClaudeConfigHomeDir 的解析顺序。
 *
 * 不变量：显式便携标记 `.claude-portable` 必须压过「exe 邻接 .claude 内容指纹」
 * 启发式——标记只可能出现在真配置根里，而 settings.json / skills / commands /
 * plugins 在项目级 `.claude` 中同样合法。
 *
 * 构造场景：
 *   <tmp>/floria-portable-order-probe/
 *     .claude/.claude-portable        <- 祖先的显式便携标记（期望赢家）
 *     .claude/settings.json
 *     proj/.claude/settings.json      <- exe 邻接，像配置根但其实是项目目录
 *     proj/.claude/skills/archify/    <- 项目级 skill，歧义触发项
 *     proj/cli-dev-fake.exe           <- 伪 exe，令 execPath 指向此处
 *
 * 期望配置根 = <tmp>/floria-portable-order-probe/.claude
 * （调换顺序前会错判为 proj/.claude）
 *
 * 用法：bun probes/probe-portable-root-order.ts
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(tmpdir(), 'floria-portable-order-probe')
rmSync(root, { recursive: true, force: true })

// 祖先：真·便携根（有显式标记，同时也有 settings.json）
mkdirSync(join(root, '.claude'), { recursive: true })
writeFileSync(join(root, '.claude', '.claude-portable'), '')
writeFileSync(join(root, '.claude', 'settings.json'), '{}')

// exe 所在目录：邻接 .claude 带 settings.json + skills（项目级合法内容）
const proj = join(root, 'proj')
mkdirSync(join(proj, '.claude', 'skills', 'archify'), { recursive: true })
writeFileSync(join(proj, '.claude', 'settings.json'), '{}')
const fakeExe = join(proj, 'cli-dev-fake.exe')
writeFileSync(fakeExe, '')

// 令 envUtils 认为 exe 就在 proj/ 下（必须在 import 之前设置）
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

const { getClaudeConfigHomeDir } = await import('../src/utils/envUtils.js')

const got = getClaudeConfigHomeDir()
const want = join(root, '.claude').normalize('NFC')

console.log('伪 exe 路径   :', fakeExe)
console.log('期望配置根    :', want)
console.log('实际配置根    :', got)
console.log('---')
console.log('邻接 proj/.claude 是否被判为配置根:', got === join(proj, '.claude').normalize('NFC'))
console.log(got === want ? 'PASS' : 'FAIL')

rmSync(root, { recursive: true, force: true })
process.exit(got === want ? 0 : 1)
