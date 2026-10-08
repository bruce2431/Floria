// 分层校验器：检查 src/gateway/web-src/**/*.js 的静态 import 依赖图是否违反分层约定。
//
// 运行（无副作用，只读源码、只打印）：
//   F:/@WrokSpace/.tools/bun/bun.exe scripts/check-layering.ts          # 只报告，exit 0
//   F:/@WrokSpace/.tools/bun/bun.exe scripts/check-layering.ts --strict # 有违规时 exit 1
//   F:/@WrokSpace/.tools/bun/bun.exe scripts/check-layering.ts --graph  # 附加依赖图摘要（度数/层级/按层边数）
//
// 规则（复合违规 = 三类之和；--strict 有任一即 exit 1）：
//   1. 成环：import 图里长度 >1 的强连通分量（Tarjan SCC）。
//   2. 逆向依赖：低层 import 高层（core 0 → engine 1 → feature 2 → views 3 → app 4）。
//   3. 卡边界：views/cards/<name>/ 的卡组件不得互相 import（同卡目录内部除外）——
//      卡只能依赖 Shared Kernel core/* 与 registry 契约，不得依赖兄弟卡组件。
//
// 背景：web-src 的 ESM import 在构建时被 bundle-web-modules.ts 剥除拼成单 IIFE，
// 模块边界只是源码组织、非运行时边界；此脚本把 import 声明变成可校验的约束（纯源码卫生）。

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname, sep } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const SRC = join(ROOT, 'src/gateway/web-src')
const STRICT = process.argv.includes('--strict')
const GRAPH = process.argv.includes('--graph')

// ── 分层定义（低 → 高）──────────────────────────────────────────
// 数字越小越底层；允许 import 同层或更低层，禁止 import 更高层（逆向依赖）。
const LAYER = {
  core: 0,    // 叶子：无业务依赖的工具模块
  engine: 1,  // 状态/生命周期/网关
  feature: 2, // 业务功能块
  views: 3,   // 视图/卡片注册
  app: 4,     // 入口
}
const LAYER_NAME = ['core', 'engine', 'feature', 'views', 'app']

// core/ 内部再分：叶集合 vs 引擎集合（引擎项可能在 core/ 或 engine/ 目录下）
const CORE_LEAVES = new Set(['util', 'icons', 'markdown', 'storage', 'char'])
const ENGINE_MODULES = new Set(['state', 'live', 'gateway', 'sessions'])
const FEATURE_DIRS = new Set(['chat', 'inputbar', 'sidebar'])

/** 由模块相对路径（相对 SRC，形如 "core/state.js"）判定所属层；无法判定返回 null。 */
function layerOf(rel: string): number | null {
  const parts = rel.split('/')
  const dir = parts[0]
  if (parts.length === 1) return dir === 'app.js' ? LAYER.app : null
  if (dir === 'views') return LAYER.views
  if (FEATURE_DIRS.has(dir)) return LAYER.feature
  if (dir === 'engine') return LAYER.engine
  if (dir === 'core') {
    const base = parts[parts.length - 1].replace(/\.js$/, '')
    if (CORE_LEAVES.has(base)) return LAYER.core
    if (ENGINE_MODULES.has(base)) return LAYER.engine
    // 其余 core/* 暂按引擎层处理（auth/panel/viewport 等非叶子工具）
    return LAYER.engine
  }
  return null
}

// ── 扫描：建模块级有向图 ────────────────────────────────────────
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

const files = walk(SRC)
const mods = files.map(f => relative(SRC, f).split(sep).join('/'))
const modSet = new Set(mods)

const edges = new Map<string, Set<string>>()
for (const m of mods) edges.set(m, new Set())

// import { … } from '<specifier>'
const IMPORT_RE = /import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g

for (const f of files) {
  const from = relative(SRC, f).split(sep).join('/')
  const text = readFileSync(f, 'utf8')
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1]
    if (!spec.startsWith('.')) continue // 只处理相对路径的本地模块
    const resolved = relative(SRC, resolve(dirname(f), spec)).split(sep).join('/')
    if (resolved === from) continue
    if (modSet.has(resolved)) edges.get(from)!.add(resolved)
  }
}

// ── 违规 1：逆向依赖（下层 import 上层）────────────────────────
type Rev = { from: string; to: string; fl: number; tl: number }
const reverse: Rev[] = []
for (const [from, tos] of edges) {
  const fl = layerOf(from)
  for (const to of tos) {
    const tl = layerOf(to)
    if (fl === null || tl === null) continue
    if (tl > fl) reverse.push({ from, to, fl, tl })
  }
}

// ── 违规 3：卡边界（views/cards/** 卡组件不得互相 import）──────
/** 卡组件模块 → 其卡目录名；非卡模块返回 null。 */
const CARD_RE = /^views\/cards\/([^/]+)\//
function cardOf(m: string): string | null {
  const mm = CARD_RE.exec(m)
  return mm ? mm[1] : null
}
type CardEdge = { from: string; to: string; fromCard: string; toCard: string }
const cardCross: CardEdge[] = []
for (const [from, tos] of edges) {
  const fc = cardOf(from)
  if (fc === null) continue
  for (const to of tos) {
    const tc = cardOf(to)
    if (tc === null || tc === fc) continue // 同卡目录内部 import 合法
    cardCross.push({ from, to, fromCard: fc, toCard: tc })
  }
}

// ── 违规 2：成环（Tarjan SCC）──────────────────────────────────
const index = new Map<string, number>()
const low = new Map<string, number>()
const onStack = new Set<string>()
const stack: string[] = []
let counter = 0
const sccs: string[][] = []

function strongconnect(v: string) {
  index.set(v, counter); low.set(v, counter); counter++
  stack.push(v); onStack.add(v)
  for (const w of edges.get(v)!) {
    if (!index.has(w)) { strongconnect(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)) }
    else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!))
  }
  if (low.get(v) === index.get(v)) {
    const comp: string[] = []
    let w: string
    do { w = stack.pop()!; onStack.delete(w); comp.push(w) } while (w !== v)
    if (comp.length > 1) sccs.push(comp.reverse())
  }
}
for (const m of mods) if (!index.has(m)) strongconnect(m)

/** 在一个 SCC 内找一条示例环路径。 */
function exampleCycle(comp: string[]): string[] {
  const set = new Set(comp)
  const start = comp[0]
  const path: string[] = []
  const seen = new Set<string>()
  function dfs(v: string): boolean {
    if (seen.has(v)) return v === start && path.length > 1
    seen.add(v); path.push(v)
    for (const w of edges.get(v)!) {
      if (!set.has(w)) continue
      if (w === start) { path.push(w); return true }
      if (dfs(w)) return true
    }
    seen.delete(v); path.pop()
    return false
  }
  return dfs(start) ? path : comp
}

// ── 报告 ────────────────────────────────────────────────────────
const edgeCount = [...edges.values()].reduce((a, s) => a + s.size, 0)
console.log('web-src 分层校验  (nodes=%d  edges=%d)', mods.length, edgeCount)
console.log('分层: ' + LAYER_NAME.map((n, i) => `${i}=${n}`).join(' → '))
console.log('')

// ── 依赖图摘要（--graph）────────────────────────────────────────
if (GRAPH) {
  const inDeg = new Map<string, number>(mods.map(m => [m, 0]))
  for (const [, tos] of edges) for (const t of tos) inDeg.set(t, inDeg.get(t)! + 1)

  const layerNameOf = (m: string): string => {
    const l = layerOf(m)
    return l === null ? '?' : LAYER_NAME[l]
  }

  // 层级分布
  const dist = new Array<number>(LAYER_NAME.length).fill(0)
  let unlayered = 0
  for (const m of mods) { const l = layerOf(m); if (l === null) unlayered++; else dist[l]++ }

  // 按层聚合的边数
  const agg = new Map<string, number>()
  for (const [from, tos] of edges) {
    const fname = layerNameOf(from)
    for (const to of tos) {
      const k = `${fname} → ${layerNameOf(to)}`
      agg.set(k, (agg.get(k) ?? 0) + 1)
    }
  }

  console.log('【依赖图摘要】')
  console.log('  层级分布: ' + LAYER_NAME.map((n, i) => `${n}=${dist[i]}`).join('  ') + (unlayered ? `  未分层=${unlayered}` : ''))
  console.log('  按层聚合边数:')
  for (const [k, v] of [...agg.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`    ${k}: ${v}`)
  }
  console.log('  模块度数 (out=出边 / in=入边，按总度降序):')
  const deg = mods.map(m => ({ m, out: edges.get(m)!.size, in: inDeg.get(m)! }))
  deg.sort((a, b) => (b.out + b.in) - (a.out + a.in) || a.m.localeCompare(b.m))
  for (const d of deg) console.log(`    [${layerNameOf(d.m)}] ${d.m}  out=${d.out} in=${d.in}`)
  console.log('')
}

console.log(`【成环】依赖环 ${sccs.length} 个`)
for (const comp of sccs) {
  const cyc = exampleCycle(comp)
  console.log(`  • 环(${comp.length}): ${cyc.join(' → ')}`)
}
console.log('')

console.log(`【逆向依赖】下层 import 上层 ${reverse.length} 条`)
reverse.sort((a, b) => a.fl - b.fl || a.from.localeCompare(b.from))
for (const r of reverse) {
  console.log(`  • ${r.from} [${LAYER_NAME[r.fl]}] → ${r.to} [${LAYER_NAME[r.tl]}]`)
}
console.log('')

console.log(`【卡边界】卡组件互相 import ${cardCross.length} 条`)
cardCross.sort((a, b) => a.fromCard.localeCompare(b.fromCard) || a.from.localeCompare(b.from))
for (const c of cardCross) {
  console.log(`  • ${c.from} [卡:${c.fromCard}] → ${c.to} [卡:${c.toCard}]`)
}
console.log('')

const bad = sccs.length + reverse.length + cardCross.length
console.log(`合计违规：成环 ${sccs.length} + 逆向依赖 ${reverse.length} + 卡边界 ${cardCross.length} = ${bad}`)
if (STRICT && bad > 0) process.exit(1)
