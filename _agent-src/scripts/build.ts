import { chmodSync, existsSync, mkdirSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const pkg = await Bun.file(new URL('../package.json', import.meta.url)).json() as {
  name: string
  version: string
}

const args = process.argv.slice(2)
const compile = args.includes('--compile')
const dev = args.includes('--dev')

const fullExperimentalFeatures = [
  'AGENT_MEMORY_SNAPSHOT',
  'AGENT_TRIGGERS',
  'AGENT_TRIGGERS_REMOTE',
  'AWAY_SUMMARY',
  'BASH_CLASSIFIER',
  'BUILTIN_EXPLORE_PLAN_AGENTS',
  'CACHED_MICROCOMPACT',
  'COMPACTION_REMINDERS',
  'CONNECTOR_TEXT',
  'EXTRACT_MEMORIES',
  'HISTORY_PICKER',
  'HOOK_PROMPTS',
  'KAIROS_BRIEF',
  'KAIROS_CHANNELS',
  'LODESTONE',
  'MCP_RICH_OUTPUT',
  'MESSAGE_ACTIONS',
  'NATIVE_CLIPBOARD_IMAGE',
  'NEW_INIT',
  'POWERSHELL_AUTO_MODE',
  'PROMPT_CACHE_BREAK_DETECTION',
  'QUICK_SEARCH',
  'SHOT_STATS',
  'TEAMMEM',
  'TOKEN_BUDGET',
  'TREE_SITTER_BASH',
  'TREE_SITTER_BASH_SHADOW',
  'ULTRAPLAN',
  'ULTRATHINK',
  'UNATTENDED_RETRY',
  'VERIFICATION_AGENT',
  'VOICE_MODE',
] as const

function runCommand(cmd: string[]): string | null {
  const proc = Bun.spawnSync({
    cmd,
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (proc.exitCode !== 0) {
    return null
  }

  return new TextDecoder().decode(proc.stdout).trim() || null
}

function getDevVersion(baseVersion: string): string {
  const timestamp = new Date().toISOString()
  const date = timestamp.slice(0, 10).replaceAll('-', '')
  const time = timestamp.slice(11, 19).replaceAll(':', '')
  const sha = runCommand(['git', 'rev-parse', '--short=8', 'HEAD']) ?? 'unknown'
  return `${baseVersion}-dev.${date}.t${time}.sha${sha}`
}

function getVersionChangelog(): string {
  return (
    runCommand(['git', 'log', '--format=%h %s', '-20']) ??
    'Local development build'
  )
}

// 2026-08-25 用户定案：PRIVATE_GATEWAY（内置私有化网关）进默认特性——所有构建默认含 /server，
// 无需再显式 --feature=PRIVATE_GATEWAY（build:dev:gateway 显式传入仍按显式代号命名产物）
const defaultFeatures = ['VOICE_MODE', 'BUILTIN_EXPLORE_PLAN_AGENTS', 'PRIVATE_GATEWAY', 'REACTIVE_COMPACT']
const featureSet = new Set(defaultFeatures)
// 显式 --feature=X 的代号集合：用于输出 exe 以 feature 代号命名（feature 构建不复用默认 cli-dev 名，避免互相覆盖）
const explicitFeatures = new Set<string>()
// 本地时间戳 YYYYMMDDHHMMSS，用于产物命名，区分不同构建
function getBuildTimestamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i]
  if (arg === '--feature-set' && args[i + 1]) {
    if (args[i + 1] === 'dev-full') {
      for (const feature of fullExperimentalFeatures) {
        featureSet.add(feature)
      }
    }
    i += 1
    continue
  }
  if (arg === '--feature-set=dev-full') {
    for (const feature of fullExperimentalFeatures) {
      featureSet.add(feature)
    }
    continue
  }
  if (arg === '--feature' && args[i + 1]) {
    featureSet.add(args[i + 1]!)
    explicitFeatures.add(args[i + 1]!)
    i += 1
    continue
  }
  if (arg.startsWith('--feature=')) {
    const f = arg.slice('--feature='.length)
    featureSet.add(f)
    explicitFeatures.add(f)
  }
}
const features = [...featureSet]

// 2026-08-25 用户定案：dev 构建（build:dev / build:dev:gateway）产物直接输出到项目根
// （_agent-src 的上一级 = 便携项目根，免手动复制部署）。基于脚本位置推导
// （import.meta.url = <项目根>/_agent-src/scripts/build.ts → 上两级），不依赖 cwd。
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url)) // <项目根>/_agent-src/scripts
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..', '..') // <项目根>

// 产物命名 = <前缀>-<YYYYMMDDHHMMSS>[-<显式 feature 代号>]，Windows 输出 .exe；
// 时间戳保证不同构建不覆盖，显式 --feature 代号在时间戳后追加（多个用 + 连接）
// compile（正式发布）仍输出 ./dist/，dev 构建直出项目根
const baseOutfile = compile
  ? dev
    ? './dist/cli-dev'
    : './dist/cli'
  : dev
    ? join(PROJECT_ROOT, 'cli-dev')
    : join(PROJECT_ROOT, 'cli')
const buildTimestamp = getBuildTimestamp()
const outfile =
  explicitFeatures.size > 0
    ? `${baseOutfile}-${buildTimestamp}-${[...explicitFeatures].join('+')}`
    : `${baseOutfile}-${buildTimestamp}`
const buildTime = new Date().toISOString()
const version = dev ? getDevVersion(pkg.version) : pkg.version

const outDir = dirname(outfile)
if (outDir !== '.') {
  mkdirSync(outDir, { recursive: true })
}

const externals = [
  '@ant/*',
  'audio-capture-napi',
  'image-processor-napi',
  'modifiers-napi',
  'url-handler-napi',
]

// sharp stub（2026-09-04）：自包含 exe 内 sharp 原生绑定无法加载（@img/sharp-win32-x64 的
// .node 依赖同目录 libvips DLL，兄弟 DLL 打包后到不了位 → LoadLibrary 失败），而
// @huggingface/transformers 对 sharp 是静态 import（image.js:17）——不 stub 则 transformers
// 整包加载即炸，BGE 文本嵌入链瘫痪。仅对 transformers 的 import 重定向：BGE 纯文本嵌入
// 不调用 sharp 任何 API，stub 保持可 import（保住模块图）但真实调用立即报错（不留兜底）。
// 其它 importer（FileReadTool 等）保持真 sharp，行为不变（exe 内其自带 try/catch 降级链）。
const SHARP_STUB_SOURCE = `
const thrower = (prop) => () => {
  throw new Error('sharp.' + String(prop) + '() is stubbed out of the compiled exe: native bindings cannot load in a self-contained binary (DLL siblings unavailable). Text-only pipelines are unaffected; run from source (bun run dev) for image processing.')
}
export default new Proxy({}, { get: (_t, prop) => thrower(prop) })
`

const sharpStubPlugin: BunPlugin = {
  name: 'sharp-stub-for-transformers',
  setup(builder) {
    builder.onResolve({ filter: /^sharp$/ }, (args) => {
      if (
        args.importer &&
        args.importer.includes('@huggingface') &&
        args.importer.includes('transformers')
      ) {
        return { path: 'sharp-stub', namespace: 'sharp-stub' }
      }
      return undefined
    })
    builder.onLoad({ filter: /.*/, namespace: 'sharp-stub' }, () => ({
      contents: SHARP_STUB_SOURCE,
      loader: 'js',
    }))
  },
}

const defines = {
  'process.env.USER_TYPE': JSON.stringify('external'),
  'process.env.CLAUDE_CODE_FORCE_FULL_LOGO': JSON.stringify('true'),
  ...(dev
    ? { 'process.env.NODE_ENV': JSON.stringify('development') }
    : {}),
  ...(dev
    ? {
        'process.env.CLAUDE_CODE_EXPERIMENTAL_BUILD': JSON.stringify('true'),
      }
    : {}),
  'process.env.CLAUDE_CODE_VERIFY_PLAN': JSON.stringify('false'),
  'process.env.CCR_FORCE_BUNDLE': JSON.stringify('true'),
  'MACRO.VERSION': JSON.stringify(version),
  'MACRO.BUILD_TIME': JSON.stringify(buildTime),
  'MACRO.PACKAGE_URL': JSON.stringify(pkg.name),
  'MACRO.NATIVE_PACKAGE_URL': 'undefined',
  'MACRO.FEEDBACK_CHANNEL': JSON.stringify('github'),
  'MACRO.ISSUES_EXPLAINER': JSON.stringify(
    'use the /feedback command to report a feature request or bug.',
  ),
  'MACRO.VERSION_CHANGELOG': JSON.stringify(
    dev ? getVersionChangelog() : 'https://github.com/paoloanzn/claude-code',
  ),
} as const

// 前端 JS 模块拼接：src/gateway/web-src/（ESM 模块源码，唯一手改处）→ src/gateway/web/app.js（单 IIFE 产物）。
// 不用 Bun.build 打包器：其按依赖图重排模块执行序，而各模块顶层立即执行代码（事件绑定/DOM 初始化）依赖
// 原 IIFE 物理行序（重排 → TDZ 崩溃，2026-09-10 首跑实证），且切割会丢 IIFE 顶部区间外的 `const $` 声明
// ——故用自写拼接器按切割区间行序拼回（行序=原执行序，语义保真），锚点检索防呆，产物可 diff 等价验证。
// web/app.js 是生成物勿手改；产物文件名/引用不变（?v= cache-bust、sw CORE、gen-web-assets 全链零改动）。
const bundleWeb = Bun.spawnSync({
  cmd: ['bun', 'scripts/bundle-web-modules.ts'],
  cwd: process.cwd(),
  stdout: 'inherit',
  stderr: 'inherit',
})
if (bundleWeb.exitCode !== 0) {
  console.error('[build] 前端模块拼接失败（bundle-web-modules），终止构建')
  process.exit(bundleWeb.exitCode ?? 1)
}

// 前端资源打包：把 src/gateway/web/ → web-assets.generated.ts（内置网关 PRIVATE_GATEWAY 内嵌 serve 用）
// 生成产物会打进 exe，因此每次构建都自动重跑，保证 exe 内前端为最新。
const genWeb = Bun.spawnSync({
  cmd: ['bun', 'scripts/gen-web-assets.ts'],
  cwd: process.cwd(),
  stdout: 'inherit',
  stderr: 'inherit',
})
if (genWeb.exitCode !== 0) {
  console.error('[build] 前端资源打包失败（gen-web-assets），终止构建')
  process.exit(genWeb.exitCode ?? 1)
}

// 2026-09-04：CLI spawn 改 Bun.build() API（旗标经探针验证完整等价，探针留档
// 20260904202312-sharp-stub-exe修复/）——API 才能挂 onResolve 插件做 sharp stub。
const result = await Bun.build({
  entrypoints: ['./src/entrypoints/cli.tsx'],
  target: 'bun',
  format: 'esm',
  minify: true,
  bytecode: true,
  packages: 'bundle',
  conditions: ['bun'],
  compile: {
    outfile,
    windowsIcon: 'assets/icon.ico',
  },
  external: externals,
  define: defines,
  features,
  plugins: [sharpStubPlugin],
})

if (!result.success) {
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}

if (existsSync(outfile)) {
  chmodSync(outfile, 0o755)
}

// bun writes `<outfile>.exe` on Windows
const builtPath = existsSync(outfile) ? outfile : `${outfile}.exe`

console.log(`Built ${builtPath}`)

// Icon finalization: rewrite into a SINGLE RT_GROUP_ICON (id=1) so Windows
// Explorer does per-size frame selection (crisp at every size). bun's own
// `--windows-icon` embeds a two-group structure (IDI_MYICON 256-only) that
// Windows reuses for ALL sizes → over-sharpened small icons. See
// scripts/postprocess-icon.mjs. Failure here is non-fatal (bun's icon remains).
if (existsSync(builtPath)) {
  const post = Bun.spawnSync({
    cmd: ['bun', 'scripts/postprocess-icon.mjs', builtPath, 'assets/icon.ico'],
    cwd: process.cwd(),
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (post.exitCode !== 0) {
    console.warn(`[build] icon post-process failed (exit ${post.exitCode}); keeping bun-embedded icon`)
  }
}
