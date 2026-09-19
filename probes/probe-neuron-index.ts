/**
 * 神经元索引一致性探针（2026-09-15）
 *
 * 守护的不变量：**mem.db 行数 ≡ embeddings.npy 行数 ≡ index_config.total_entries ≡ readMemories 条数**。
 * 破坏它的路径只有一条——绕过 memwriter 直写 mem.db（本项目 2026-09-12 起 log_append 入口消失后
 * 的 bun:sqlite 直写就是这么干的），此时 embeddings 不增量重建，行数漂移。retriever 在
 * index_config 无 encoded_ids 时无从对齐，`search` 直接抛「索引缺失或与 mem.db 行数不一致」——
 * 门控关着不暴露，开门即硬失败（2026-09-15 Neuron-Pj16 实测 409 vs 420）。
 *
 * 断言：
 *   A 行数三处一致（npy / db / readMemories）+ index_config 与 npy 形状一致
 *   B 每行 L2 归一（cos 检索前提；max-pool 后必须归一）
 *   C 真检索可用——rankMem 不抛错、命中条目 id 全在 mem.db（走真实检索引擎，非复刻）
 *
 * 用法：bun probe-neuron-index.ts [neuronPath]
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { countMemories, readMemories } from '../src/tools/neturon/db.ts'
import { readNpyF32 } from '../src/tools/neturon/npyio.ts'
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
const memDir = join(neuronPath, 'l2.mem')
const dbPath = join(memDir, 'mem.db')
const embPath = join(memDir, 'embeddings.npy')
const confPath = join(memDir, 'index_config.json')

if (!existsSync(dbPath) || !existsSync(embPath)) {
  console.error(`缺件：${dbPath} / ${embPath}`)
  process.exit(1)
}

// ── A 行数一致性 ──────────────────────────────────────────────────────────────
const entries = readMemories(dbPath)
const dbRows = countMemories(dbPath)
const { data, shape } = readNpyF32(embPath)
const conf = JSON.parse(
  await Bun.file(confPath).text(),
) as { model_name: string; total_entries: number; embedding_dim: number }

check('A1 npy 行数 ≡ mem.db 行数', shape[0] === dbRows, `npy ${shape[0]} / db ${dbRows}`)
check('A2 npy 行数 ≡ readMemories 条数', shape[0] === entries.length, `npy ${shape[0]} / entries ${entries.length}`)
check('A3 index_config.total_entries ≡ npy 行数', conf.total_entries === shape[0], `${conf.total_entries} / ${shape[0]}`)
check('A4 index_config.embedding_dim ≡ npy 列数', conf.embedding_dim === shape[1], `${conf.embedding_dim} / ${shape[1]}`)
check('A5 npy 数据长度 ≡ 行×列', data.length === shape[0]! * shape[1]!, `${data.length} / ${shape[0]! * shape[1]!}`)

// ── B 行归一化 ────────────────────────────────────────────────────────────────
const dim = shape[1]!
let worst = 0
for (let i = 0; i < shape[0]!; i++) {
  let s = 0
  for (let d = 0; d < dim; d++) s += data[i * dim + d]! ** 2
  // 全零行（blocks 为空的条目）不参与归一化断言
  if (s === 0) continue
  worst = Math.max(worst, Math.abs(Math.sqrt(s) - 1))
}
check('B1 每非零行 L2 归一到 1（±1e-3）', worst < 1e-3, `最大偏差 ${worst}`)

// ── C 真检索（走真实检索引擎）─────────────────────────────────────────────────
const r = new NeuronRetriever(neuronPath, 'Pj16', join(getGlobalRoot(), 'cache', 'models'))
const ids = new Set(entries.map(e => e.memory_id))
// rankMem 是 private（编译期限定），此处刻意直调以跳过 precog 落盘副作用——被断言的是它内部的
// 一致性抛错点与余弦打分，与 search 同一条代码路径
const ranked = await (
  r as unknown as { rankMem: (q: string, k: number) => Promise<{ ranked: Array<{ entry: { memory_id: string } }> }> }
).rankMem('会话间协作 session_send 来源行', 5)
check('C1 rankMem 不抛错（索引一致性的第一现场）', true)
check('C2 命中非空', ranked.ranked.length > 0, `命中 ${ranked.ranked.length}`)
check(
  'C3 命中条目 id 全在 mem.db',
  ranked.ranked.every(x => ids.has(x.entry.memory_id)),
  ranked.ranked.map(x => x.entry.memory_id).join(','),
)

console.log(`\n库：${neuronPath}`)
console.log(`形状：${shape[0]} 行 × ${dim} 维 / 模型 ${conf.model_name}`)
console.log(`\n${pass} 过 / ${fail} 败`)
if (failures.length) {
  console.log('\n失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(fail ? 1 : 0)
