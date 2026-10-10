#!/usr/bin/env bun
/**
 * probe-web-card-boundary —— web 视图卡的依赖方向不变量（卡片解耦，2026-10-05）
 *
 * 目标（用户口径）：web 调用卡片、卡片自持组件、每卡独立可运行 —— 卡片依赖方向必须收成单向
 *   **卡 → 小底座**（core + 数据层 sidebar/mgr-data + 契约 engine/registry + 卡自身目录），
 *   **禁 卡 → 兄弟子系统**（chat/ 其余、sidebar/recent·rail-ext·work·mgr、inputbar/、core/live、core/auth）。
 * 违反即「改某个子系统连带打坏某张卡」，本探针把它锁死防复发。
 *
 * 只读结构探针：遍历 `src/gateway/web-src/views/cards/**\/*.js`（一卡一目录），抽 `import` specifier，
 * 相对该文件 resolve 归一为 `web-src/<path>` 逻辑路径，逐条判白名单。
 *
 * 白名单：
 *   - engine/{state,sessions,gateway,panel}.js（小底座）
 *   - core 叶子 {icons,util,storage}.js（§12：无状态/无连接/无订阅，可被任意层依赖）
 *   - sidebar/mgr-data.js（数据层）
 *   - engine/registry.js（卡片契约，2026-10-10 自 views/registry.js 下沉）
 *   - engine/ext-runtime.js（外部卡运行时表 + 应用目录 + 浮窗动作表，2026-10-10 Phase 5 自 registry 拆出）
 *   - engine/ext-decl.js（外部申报纯校验/壳 src 串，契约层共享底座）
 *   - feature/preview-frame.js（项目预览帧渲染实现：preview 卡 mountPreview、ext 卡 rail-ext 状态；
 *     属显式登记的共享底座，非「卡 → 兄弟子系统」）
 *   - 卡**自身目录** `./*`（含子目录，同目录组件随卡）
 * 显式例外（带注释，本版不动 routing）：
 *   - views/cards/session/session-card.js → chat/route.js（`teardownSessionView`，会话卡=会话视图本体）
 *
 * 第二断言：两个契约入口的 import 同受「小底座」约束，不得 import chat/sidebar/inputbar 成 god importer
 *   —— engine/registry.js ⊆ {engine/state, engine/ext-runtime, core 叶子}；
 *      engine/ext-runtime.js ⊆ {engine/gateway, engine/ext-decl, core 叶子}。
 *   并锁死依赖单向：registry → ext-runtime 许可，反向 import 即报（engine 内不新增环）。
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'fs'
import { resolve, dirname, relative, sep } from 'path'

const ROOT = resolve(import.meta.dir, '..')
const SRC = resolve(ROOT, 'src/gateway/web-src')
const CARDS = resolve(SRC, 'views/cards')

let pass = 0
let fail = 0
const ok = (m: string) => {
  pass++
  console.log(`PASS  ${m}`)
}
const bad = (m: string) => {
  fail++
  console.log(`FAIL  ${m}`)
}

// 归一为 web-src 逻辑路径（posix 风格）
const logical = (abs: string) => relative(SRC, abs).split(sep).join('/')
const resolveSpec = (fromAbs: string, spec: string) =>
  logical(resolve(dirname(fromAbs), spec))

// ---- 白名单 / 例外 ----
const ALLOW_EXACT = new Set([
  'engine/state.js',
  'core/icons.js',
  // core/ 叶子（§12：无状态/无连接/无订阅，可被任意层依赖）——卡用 esc/toast/持久化补丁
  'core/util.js',
  'core/storage.js',
  'engine/sessions.js',
  'engine/gateway.js',
  'engine/panel.js',
  'sidebar/mgr-data.js',
  'engine/registry.js', // 卡片契约（2026-10-10 自 views/registry.js 下沉）
  'engine/ext-runtime.js', // 外部卡运行时表 + 应用目录（2026-10-10 Phase 5 自 registry.js 拆出）
  'engine/ext-decl.js', // 外部申报纯校验/壳 src 串（契约层共享底座）
  'feature/preview-frame.js', // 项目预览帧渲染实现（显式登记的共享底座）
])
const EXCEPTIONS: Record<string, string[]> = {
  // 会话卡 = 会话视图本体，deactivate 挂 teardownSessionView
  'views/cards/session/session-card.js': ['chat/route.js'],
}

const IMPORT_RE = /^\s*import\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/gm

// ---- 遍历卡片文件 ----
function walk(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

if (!existsSync(CARDS)) {
  bad(`缺少卡片目录 ${logical(CARDS)}`)
} else {
  const files = walk(CARDS)
  if (files.length >= 4) ok(`卡片文件 ${files.length} 个（views/cards/**）`)
  else bad(`卡片文件只找到 ${files.length} 个（应 ≥4，一卡一目录）`)

  for (const abs of files) {
    const rel = logical(abs) // views/cards/<name>/<name>-card.js
    const ownDir = rel.slice(0, rel.lastIndexOf('/')) // views/cards/<name>
    const src = readFileSync(abs, 'utf-8')
    const exc = new Set((EXCEPTIONS[rel] ?? []).map((s) => resolveSpec(abs, `../../../${s}`)))
    let n = 0
    let violated = false
    for (const m of src.matchAll(IMPORT_RE)) {
      n++
      const spec = m[1]
      if (!spec.startsWith('.')) {
        violated = true
        bad(`${rel} → 非相对 import「${spec}」（卡片只许相对自身底座/同目录）`)
        continue
      }
      const target = resolveSpec(abs, spec)
      if (target.startsWith(ownDir + '/')) continue // 同卡目录（含子目录）
      if (ALLOW_EXACT.has(target)) continue // 小底座/契约/外部申报共享底座
      if (exc.has(target)) continue // 显式例外
      violated = true
      bad(`${rel} → ${target}（卡片禁依赖兄弟子系统）`)
    }
    if (n > 0 && !violated) ok(`${rel}：${n} 条 import 全在卡片白名单内`)
  }
}

// ---- 第二断言：registry / ext-runtime 不做 god importer ----
// 2026-10-10 Phase 5：engine/registry.js 拆出 engine/ext-runtime.js（外部卡运行时 + 应用目录 + 浮窗
// 动作表）。两件同付「契约入口」约束——各只许依赖小底座，不得 import chat/sidebar/inputbar/views。
// registry → ext-runtime 是唯一许可的 engine 内单向边（不得反向，否则 engine 内成环）。
const godAllow: Record<string, { file: string; allow: Set<string> }> = {
  'engine/registry.js': {
    file: 'engine/registry.js',
    allow: new Set(['engine/state.js', 'engine/ext-runtime.js', 'core/icons.js', 'core/util.js']),
  },
  'engine/ext-runtime.js': {
    file: 'engine/ext-runtime.js',
    allow: new Set(['engine/gateway.js', 'engine/ext-decl.js', 'core/icons.js', 'core/storage.js']),
  },
}
for (const [label, spec] of Object.entries(godAllow)) {
  const p = resolve(SRC, spec.file)
  if (!existsSync(p)) {
    bad(`缺少契约入口 ${label}`)
    continue
  }
  const src = readFileSync(p, 'utf-8')
  let n = 0
  for (const m of src.matchAll(IMPORT_RE)) {
    n++
    const target = resolveSpec(p, m[1])
    if (spec.allow.has(target)) continue
    bad(`${label} → ${target}（契约入口不得 import chat/sidebar/inputbar/views，禁 god importer）`)
  }
  n > 0 && ok(`${label}：${n} 条 import 全在小底座内（${[...spec.allow].join(', ')}）`)
}
{
  const rt = readFileSync(resolve(SRC, 'engine/ext-runtime.js'), 'utf-8')
  ok('ext-runtime.js 不 import registry.js（依赖单向，engine 内不新增环）', !/from '\.\/registry\.js'/.test(rt))
}

console.log(`\n${pass}/${fail}`)
process.exit(fail === 0 ? 0 : 1)
