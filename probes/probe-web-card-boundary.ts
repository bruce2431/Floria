#!/usr/bin/env bun
/**
 * probe-web-card-boundary —— web 视图卡的依赖方向不变量（卡片解耦，2026-10-05）
 *
 * 目标（用户口径）：web 调用卡片、卡片自持组件、每卡独立可运行 —— 卡片依赖方向必须收成单向
 *   **卡 → 小底座**（core + 数据层 sidebar/mgr-data + 契约 views/registry + 卡自身目录），
 *   **禁 卡 → 兄弟子系统**（chat/ 其余、sidebar/recent·rail-ext·work·mgr、inputbar/、core/live、core/auth）。
 * 违反即「改某个子系统连带打坏某张卡」，本探针把它锁死防复发。
 *
 * 只读结构探针：遍历 `src/gateway/web-src/views/cards/**\/*.js`（一卡一目录），抽 `import` specifier，
 * 相对该文件 resolve 归一为 `web-src/<path>` 逻辑路径，逐条判白名单。
 *
 * 白名单：
 *   - core/{state,icons,sessions,gateway,panel}.js（小底座）
 *   - sidebar/mgr-data.js（数据层）
 *   - views/registry.js（卡片契约）
 *   - views/cards/ext/ext-card.js（外部申报域共享底座：preview 卡外部卡/侧栏按钮的状态清点归此）
 *   - 卡**自身目录** `./*`（含子目录，同目录组件随卡）
 * 显式例外（带注释，本版不动 routing）：
 *   - views/cards/projects/projects-card.js → chat/route.js（`navigate`，hash 路由）
 *   - views/cards/session/session-card.js   → chat/route.js（`teardownSessionView`，会话卡=会话视图本体）
 *
 * 第二断言：views/registry.js 的 import ⊆ {engine/state.js, core/icons.js, ./cards/*}
 *   （registry 是卡片契约唯一入口，不得 import chat/sidebar/inputbar 成 god importer）。
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
  'engine/sessions.js',
  'engine/gateway.js',
  'engine/panel.js',
  'sidebar/mgr-data.js',
  'views/registry.js',
  'views/cards/ext/ext-card.js', // 外部申报域共享底座
])
const EXCEPTIONS: Record<string, string[]> = {
  // 已知例外：projects 卡进预览走 hash 路由（navigate 保留 chat/route，本版不迁 routing）
  'views/cards/projects/projects-card.js': ['chat/route.js'],
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
  if (files.length >= 7) ok(`卡片文件 ${files.length} 个（views/cards/**）`)
  else bad(`卡片文件只找到 ${files.length} 个（应 ≥7，一卡一目录）`)

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

// ---- 第二断言：registry 不做 god importer ----
const REG = resolve(SRC, 'views/registry.js')
if (!existsSync(REG)) {
  bad(`缺少契约入口 ${logical(REG)}`)
} else {
  const src = readFileSync(REG, 'utf-8')
  const regAllow = new Set(['engine/state.js', 'core/icons.js'])
  let n = 0
  for (const m of src.matchAll(IMPORT_RE)) {
    n++
    const target = resolveSpec(REG, m[1])
    if (regAllow.has(target) || target.startsWith('views/cards/')) continue
    bad(`views/registry.js → ${target}（契约入口不得 import chat/sidebar/inputbar，禁 god importer）`)
  }
  ok(`views/registry.js：${n} 条 import ⊆ {core/state,core/icons,./cards/*}`)
}

console.log(`\n${pass}/${fail}`)
process.exit(fail === 0 ? 0 : 1)
