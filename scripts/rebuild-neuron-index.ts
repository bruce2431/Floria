/**
 * 神经元向量索引重建入口（2026-09-15）
 *
 * 为什么需要：mem 层活写入（log_append.ts 已随任务目录消失后改用 bun:sqlite 直写）绕过了
 * memwriter 的「增量重建 embeddings」这一步，导致 mem.db 行数与 l2.mem/embeddings.npy 行数
 * 漂移（Neuron-Pj16 实测 420 vs 409）。retriever 在行数不一致且 index_config.json 无
 * encoded_ids 时无从对齐，recall 直接抛「embeddings 索引缺失或与 mem.db 行数不一致」——
 * NEURON_RAG 门控默认关故未暴露，开门前必须修。
 *
 * 本脚本走的正是引擎自愈路径的同一条函数（memwriter.rebuildEmbeddings forceFull=true）：
 * 按 readMemories 的行序全量重编码所有 blocks → max-pool → L2 归一 → 覆写 embeddings.npy
 * 与 index_config.json。顺序与 retriever 的 entries 行序同源，故行 i 恒对应同一条 memory。
 *
 * 用法：bun rebuild-neuron-index.ts [neuronPath]
 *   缺省 neuronPath = ../.claude/neturon/neurons/Neuron-Pj16（相对本脚本 = 项目根下）
 *   幂等：重复跑结果相同的矩阵（除浮点细节外），可安全重跑。
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { countMemories, readMemories } from '../src/tools/neturon/db.ts'
import { rebuildEmbeddings } from '../src/tools/neturon/memwriter.ts'
import { getGlobalRoot } from '../src/tools/neturon/config.ts'
import { readNpyF32 } from '../src/tools/neturon/npyio.ts'

const here = dirname(fileURLToPath(import.meta.url))
const neuronPath = resolve(
  process.argv[2] ?? join(here, '..', '..', '.claude', 'neturon', 'neurons', 'Neuron-Pj16'),
)

if (!existsSync(join(neuronPath, 'l2.mem', 'mem.db'))) {
  console.error(`不是神经元库（缺 l2.mem/mem.db）：${neuronPath}`)
  process.exit(1)
}

const dbPath = join(neuronPath, 'l2.mem', 'mem.db')
const embPath = join(neuronPath, 'l2.mem', 'embeddings.npy')
const modelCacheDir = join(getGlobalRoot(), 'cache', 'models')

const before = existsSync(embPath) ? readNpyF32(embPath).shape : null
const entries = readMemories(dbPath)
console.log(`库：${neuronPath}`)
console.log(`mem.db ${countMemories(dbPath)} 行 / readMemories ${entries.length} 条`)
console.log(`旧 embeddings.npy 形状：${before ? JSON.stringify(before) : '（不存在）'}`)
console.log(`模型缓存：${modelCacheDir}`)
console.log('开始全量重编码…')

const t0 = Date.now()
const { shape } = await rebuildEmbeddings(neuronPath, entries, modelCacheDir, true)

const after = readNpyF32(embPath).shape
const rows = countMemories(dbPath)
console.log(`新形状：${JSON.stringify(shape)}（落盘复核 ${JSON.stringify(after)}），耗时 ${Date.now() - t0}ms`)

// 不变量：npy 行数 ≡ mem.db 行数 ≡ readMemories 条数；列数 ≡ index_config.embedding_dim
const ok = after[0] === rows && after[0] === entries.length && shape[0] === rows
console.log(ok ? `✅ 一致（${rows} 行 × ${after[1]} 维）` : `❌ 仍不一致：npy ${after[0]} / db ${rows}`)
process.exit(ok ? 0 : 1)
