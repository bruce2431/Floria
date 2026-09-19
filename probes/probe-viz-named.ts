// 探针：验证 /gateway/neurons/graph 载荷带社群命名（cog2.json 挂载 + 默认档跟随命名档）
import { resolve } from 'path'
import { buildNeuronGraphInDir } from '../src/gateway/neuronViz.js'

const neuronPath = resolve(import.meta.dir, '..', '..', '.claude/neturon/neurons/Neuron-Pj16')
const d = buildNeuronGraphInDir(neuronPath)
console.log('resolution =', d.resolution, '| resolutions =', d.resolutions.join(','))
console.log('communities =', d.communities.length)
for (const c of d.communities) {
  console.log(`  群${c.i + 1} size=${c.size} name=${c.name ?? '(无)'} desc=${c.description ? c.description.slice(0, 24) + '…' : '-'} conf=${c.confidence ?? '-'}`)
}
const named = d.communities.filter((c) => c.name).length
console.log(`named ${named}/${d.communities.length}`)
