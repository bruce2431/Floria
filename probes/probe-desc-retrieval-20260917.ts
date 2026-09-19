// 检索复测探针（归属描述块注入实验）：对固定 query 集跑 rankMem（cos+kw 同权重，与 recall 同链）
// 不写 precog（rankMem 干跑，不走 search）。用法：bun probe-desc-retrieval-20260917.ts before|after
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NeuronRetriever } from '../src/tools/neturon/retriever.js'
import { setProjectRoot } from '../src/bootstrap/state.js'

const stage = process.argv[2] ?? 'before'
const ROOT = resolve(import.meta.dir, '..', '..', '..')
setProjectRoot(ROOT)
const LIB = join(ROOT, '.claude', 'neturon', 'neurons', 'Neuron-Pj16')

const QUERIES = [
  'web 前端的改动历史',
  '侧栏组件的维护历史',
  '状态显示行的实现',
  '审批卡审批流程',
  'mDNS 域名解析 floria.local',
  '构建发布版本 Release',
  'token 门过渡动画',
  '神经元社群命名',
  '图片上传错图',
  '会话间协作 session_send',
]

const r: any = new NeuronRetriever(LIB, 'PJ16')
const out: Record<string, Array<{ id: string; rank: number; cos: number; kw: number }>> = {}
for (const q of QUERIES) {
  const { formatted } = await r.rankMem(q, 5)
  out[q] = (formatted ?? []).map((x: any) => ({
    id: x.memory_id,
    rank: x.rank,
    cos: x.cos_score,
    kw: x.kw_score,
  }))
}

const file = join(import.meta.dir, `dump-desc-${stage}-20260917.json`)
writeFileSync(file, JSON.stringify(out, null, 2))
console.log('==', stage, '==')
for (const q of QUERIES) {
  const hits = out[q]!
  const top = hits[0]
  console.log(
    `${q} | top5:${hits.length} 首=${top ? top.id.replace('PJ16_', '') + ' ' + top.rank.toFixed(3) + '(cos' + top.cos.toFixed(2) + '+kw' + top.kw.toFixed(2) + ')' : '无'}`,
  )
}
console.log('dump →', file)
