// 短域词 query 验证：描述块必含「归属域：X」→ 纯域词 query 的 kw 通道应大面积命中
import { join, resolve } from 'node:path'
import { NeuronRetriever } from '../src/tools/neturon/retriever.js'
import { setProjectRoot } from '../src/bootstrap/state.js'

setProjectRoot(resolve(import.meta.dir, '..', '..', '..'))
const LIB = join(import.meta.dir, '..', '..', '.claude', 'neturon', 'neurons', 'Neuron-Pj16')
const r: any = new NeuronRetriever(LIB, 'PJ16')

for (const q of ['前端', '网关', '构建', '神经元']) {
  const { formatted, ranked } = await r.rankMem(q, 100)
  const kwFull = formatted.filter((x: any) => x.kw_score >= 0.99).length
  const cosTop = formatted.slice(0, 3).map((x: any) => x.cos_score.toFixed(2)).join('/')
  console.log(`「${q}」 命中(≥0.1) ${ranked.length} 条 | kw满分 ${kwFull} 条 | top3 cos ${cosTop}`)
}
