/**
 * 神经元块级向量重建入口（2026-09-30 起：向量入 mem.db，取代 embeddings.npy 方案）
 *
 * 用途：一次性 backfill / 换模型 / 手工直写 mem.db 后向量缺失时的全量重编码。
 * 逐条按 readMemories 行序重编码该条 blocks，UPDATE memories.block_vectors（先算后写，
 * 中断可重入；不触碰 blocks 文本）。
 *
 * 用法：bun rebuild-neuron-index.ts [neuronPath]
 *   缺省 neuronPath = ../.claude/neturon/neurons/Neuron-Pj16（相对本脚本 = 项目根下）
 *   幂等：重复跑结果相同的矩阵（除浮点细节外），可安全重跑。
 *
 * ⚠️ 重资源长跑（Pj16 约十分钟），启动前须征得用户同意。
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { countMemories, readMemories, readMemoryVectors } from '../src/tools/neturon/db.ts'
import { rebuildVectors } from '../src/tools/neturon/memwriter.ts'
import { getGlobalRoot } from '../src/tools/neturon/config.ts'

const here = dirname(fileURLToPath(import.meta.url))
const neuronPath = resolve(
  process.argv[2] ?? join(here, '..', '..', '.claude', 'neturon', 'neurons', 'Neuron-Pj16'),
)

if (!existsSync(join(neuronPath, 'l2.mem', 'mem.db'))) {
  console.error(`不是神经元库（缺 l2.mem/mem.db）：${neuronPath}`)
  process.exit(1)
}

const dbPath = join(neuronPath, 'l2.mem', 'mem.db')
const modelCacheDir = join(getGlobalRoot(), 'cache', 'models')

const entries = readMemories(dbPath)
console.log(`库：${neuronPath}`)
console.log(`mem.db ${countMemories(dbPath)} 行 / readMemories ${entries.length} 条`)
console.log(`模型缓存：${modelCacheDir}`)
console.log('开始全量重编码…')

const t0 = Date.now()
const { entries: n, blocks, dim } = await rebuildVectors(neuronPath, entries, modelCacheDir, (done, total) => {
  if (done % 50 === 0 || done === total) console.log(`  ${done}/${total}`)
})

// 不变量：每条非空 blocks 的向量长度 ≡ n_blocks × dim
const vecs = readMemoryVectors(dbPath)
let bad = 0
for (const e of entries) {
  const nb = e.blocks?.length ?? 0
  if (!nb) continue
  const v = vecs.get(e.memory_id)
  if (!v || v.length !== nb * dim) bad++
}
console.log(`重编码 ${n} 条 / ${blocks} 块 / ${dim} 维，耗时 ${Date.now() - t0}ms`)
const ok = bad === 0
console.log(ok ? `✅ 全部一致（${vecs.size} 条有向量）` : `❌ ${bad} 条向量缺失/长度不符`)
process.exit(ok ? 0 : 1)
