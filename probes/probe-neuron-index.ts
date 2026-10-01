/**
 * 神经元块级向量一致性探针（2026-09-30 定案：向量入 mem.db block_vectors）
 *
 * 守护的不变量：**每条记忆的 block_vectors 长度 ≡ n_blocks × dim，且全库 dim 一致**。
 * 破坏它的路径只有一条——绕过 memwriter 直写 mem.db（或老库未跑 backfill），向量缺失/错位。
 * retriever 在 dim=0 或某条长度不符时 rankMem 硬抛；此探针在检索前先给出面级结论。
 *
 * 断言：
 *   A 每条非空 blocks 的向量长度 ≡ n_blocks×dim；全库 dim 一致
 *   B 每个块行 L2 归一（cos 检索前提）
 *   C 真检索可用——rankMem 不抛错、命中条目 id 全在 mem.db（走真实检索引擎，非复刻）
 *
 * 用法：bun probe-neuron-index.ts [neuronPath]
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { countMemories, readMemories, readMemoryVectors } from '../src/tools/neturon/db.ts'
import { NeuronRetriever } from '../src/tools/neturon/retriever.ts'
import { getGlobalRoot } from '../src/tools/neturon/config.ts'

let pass = 0
let fail = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass += 1
    return
  }
  fail += 1
  failures.push(`${name}${detail ? ` —— ${detail}` : ''}`)
}

const here = dirname(fileURLToPath(import.meta.url))
const neuronPath = resolve(
  process.argv[2] ?? join(here, '..', '..', '.claude', 'neturon', 'neurons', 'Neuron-Pj16'),
)
const dbPath = join(neuronPath, 'l2.mem', 'mem.db')

if (!existsSync(dbPath)) {
  console.error(`缺件：${dbPath}`)
  process.exit(1)
}

const entries = readMemories(dbPath)
const dbRows = countMemories(dbPath)
const vecs = readMemoryVectors(dbPath)

check('A0 readMemories 条数 ≡ countMemories', entries.length === dbRows, `${entries.length} / ${dbRows}`)

// ── A 向量长度一致性（dim 由首条非空向量推得，全库应一致） ──
let dim = 0
let badLen = 0
let missing = 0
for (const e of entries) {
  const nb = e.blocks?.length ?? 0
  if (!nb) continue
  const v = vecs.get(e.memory_id)
  if (!v) {
    missing++
    continue
  }
  if (!dim) dim = v.length / nb
  if (v.length !== nb * dim) badLen++
}
const withBlocks = entries.filter(e => (e.blocks?.length ?? 0) > 0).length
check('A1 dim > 0（存在已编码块）', dim > 0, `dim=${dim}，有块条目 ${withBlocks}`)
check('A2 无块条目缺向量', missing === 0, `缺 ${missing} 条`)
check('A3 每条向量长度 ≡ n_blocks×dim', badLen === 0, `错位 ${badLen} 条`)
check('A4 dim 为 512（bge-small-zh）', dim === 512, `dim=${dim}`)

// ── B 块行归一化 ──
let worst = 0
let checked = 0
for (const e of entries) {
  const nb = e.blocks?.length ?? 0
  const v = vecs.get(e.memory_id)
  if (!nb || !v) continue
  for (let r = 0; r < nb; r++) {
    let s = 0
    for (let d = 0; d < dim; d++) s += v[r * dim + d]! ** 2
    worst = Math.max(worst, Math.abs(Math.sqrt(s) - 1))
    checked++
  }
}
check('B1 每个块行 L2 归一到 1（±1e-3）', worst < 1e-3, `最大偏差 ${worst}（${checked} 块）`)

// ── C 真检索（走真实检索引擎） ──
const r = new NeuronRetriever(neuronPath, 'Pj16', join(getGlobalRoot(), 'cache', 'models'))
const ids = new Set(entries.map(e => e.memory_id))
// rankMem 是 private（编译期限定），此处刻意直调以跳过 precog 落盘副作用——被断言的是它内部
// 的一致性抛错点与 max-sim 打分（max_r cos(q, block_r)），与 search 同一条代码路径
const ranked = await (
  r as unknown as { rankMem: (q: string, k: number) => Promise<{ ranked: Array<{ entry: { memory_id: string } }> }> }
).rankMem('会话间协作 session_send 来源行', 5)
check('C1 rankMem 不抛错（向量一致性的第一现场）', true)
check('C2 命中非空', ranked.ranked.length > 0, `命中 ${ranked.ranked.length}`)
check(
  'C3 命中条目 id 全在 mem.db',
  ranked.ranked.every(x => ids.has(x.entry.memory_id)),
  ranked.ranked.map(x => x.entry.memory_id).join(','),
)

console.log(`\n库：${neuronPath}`)
console.log(`条目 ${entries.length} / 有向量 ${vecs.size} / ${dim} 维`)
console.log(`\n${pass} 过 / ${fail} 败`)
if (failures.length) {
  console.log('\n失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(fail ? 1 : 0)
