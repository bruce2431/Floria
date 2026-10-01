/**
 * neuron_maintain 维护动作探针（2026-09-30）——块级编辑闭环
 *
 * 守护的不变量：**维护动作改 blocks 时向量随之同事务落地，检索语义即时生效**。
 * 破坏它的路径：setMemoryBlocks 漏写 block_vectors（向量与块错位 → rankMem 抛长度不符）、
 * forget soft 未自指废弃（条目不退场）、merge 未把旧条 deprecated_by 指向新 id。
 *
 * 在**隔离库副本**上跑（与 probe-mem-write 同 tmpRoot），不动真实库。
 * 前置：该隔离库已跑过 probe-mem-write（含 block_vectors 列与向量）。
 *
 * 用法：bun probe-neuron-maintain.ts <tmpRoot>
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readMemories, readMemoryVectors } from '../src/tools/neturon/db.ts'
import { addMemory, forget, mergeMemories, recut, setBlocks } from '../src/tools/neturon/memwriter.ts'
import { NeuronRetriever } from '../src/tools/neturon/retriever.ts'

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
const tmpRoot = resolve(
  process.argv[2] ?? join(here, '..', '..', '20260915182909-神经元字段移除写入验证', 'tmp-root'),
)
const neuronPath = join(tmpRoot, '.claude', 'neturon', 'neurons', 'Neuron-Pj16')
const memDbPath = join(neuronPath, 'l2.mem', 'mem.db')

function dim(): number {
  const vecs = readMemoryVectors(memDbPath)
  for (const e of readMemories(memDbPath)) {
    const nb = e.blocks?.length ?? 0
    const v = vecs.get(e.memory_id)
    if (nb && v) return v.length / nb
  }
  return 0
}

async function main(): Promise<void> {
  if (!existsSync(memDbPath)) {
    console.log(`隔离库不存在：${memDbPath}（先跑 probe-mem-write）`)
    process.exit(1)
  }

  // ── 准备：写两条待维护条目 ──
  const a = await addMemory(
    { neuron: 'PJ16', content: '维护探针条目A：块内容维护 set_blocks 关键词 alpha 甲。', source: 'probe-maintain' },
    tmpRoot,
  )
  const b = await addMemory(
    { neuron: 'PJ16', content: '维护探针条目B：合并 merge 关键词 beta 乙。', source: 'probe-maintain' },
    tmpRoot,
  )
  check('P0 两条 add ok', a.status === 'ok' && b.status === 'ok')
  if (a.status !== 'ok' || b.status !== 'ok') return report()
  const dim0 = dim()

  // ── set_blocks：替换 A 的块（3 块），向量长度随之 ──
  const newBlocks = ['alpha 甲 检索锚块', '第二块 内容', '第三块 内容']
  const sb = await setBlocks('PJ16', a.memory_id, newBlocks, tmpRoot)
  check('S1 set_blocks ok', sb.status === 'ok', sb.message ?? '')
  const va = readMemoryVectors(memDbPath).get(a.memory_id)
  const freshA = readMemories(memDbPath).find(e => e.memory_id === a.memory_id)
  check('S2 向量长度 ≡ 新块数×dim', !!va && !!freshA && va.length === freshA.blocks.length * dim0, `vec=${va?.length} blocks=${freshA?.blocks.length} dim=${dim0}`)
  check('S3 新块内容生效', !!freshA && freshA.blocks[0] === newBlocks[0] && freshA.blocks.length === 3)

  // ── recut：按 max_chars 重切（此处块均 < 300，应等价） ──
  const rc = await recut('PJ16', a.memory_id, tmpRoot)
  check('R1 recut ok 且不抛错', rc.status === 'ok')
  const afterRecut = readMemoryVectors(memDbPath).get(a.memory_id)
  const entryRecut = readMemories(memDbPath).find(e => e.memory_id === a.memory_id)
  check('R2 recut 后向量长度一致', !!afterRecut && !!entryRecut && afterRecut.length === entryRecut.blocks.length * dim0)

  // ── merge：A+B → 新条目，旧条 deprecated ──
  const mg = await mergeMemories('PJ16', [a.memory_id, b.memory_id], '合并条目：alpha 甲 + beta 乙。', {
    cwd: tmpRoot,
    source: 'probe-maintain',
  })
  check('M1 merge ok', mg.status === 'ok', mg.message ?? '')
  const midMerged = typeof mg.memory_id === 'string' ? mg.memory_id : ''
  const all = readMemories(memDbPath)
  const old1 = all.find(e => e.memory_id === a.memory_id)
  const old2 = all.find(e => e.memory_id === b.memory_id)
  check('M2 旧条 deprecated_by 指向新 id', old1?.deprecated_by === midMerged && old2?.deprecated_by === midMerged, `${old1?.deprecated_by}/${old2?.deprecated_by} vs ${midMerged}`)
  const vecMerged = readMemoryVectors(memDbPath).get(midMerged)
  const entryMerged = all.find(e => e.memory_id === midMerged)
  check('M3 新条目带向量', !!vecMerged && !!entryMerged && vecMerged.length === entryMerged.blocks.length * dim0)

  // ── forget soft：已被 merge 废弃，改测新条目 → 自指废弃后退场 ──
  const fg = forget('PJ16', midMerged, 'soft', tmpRoot)
  check('F1 forget soft ok', fg.status === 'ok', fg.message ?? '')
  const forgot = readMemories(memDbPath).find(e => e.memory_id === midMerged)
  check('F2 soft 自指废弃（deprecated_by = 自身）', forgot?.deprecated_by === midMerged, `deprecated_by=${forgot?.deprecated_by}`)

  // ── 检索语义：三旧条目均退场，检索不抛错 ──
  const retr = new NeuronRetriever(neuronPath, 'PJ16')
  const res = await retr.search('alpha 甲 beta 乙 合并', 5)
  const ids = res.formatted.map(x => x.memory_id)
  check('D1 废弃条目全部退场', !ids.includes(a.memory_id) && !ids.includes(b.memory_id) && !ids.includes(midMerged), ids.join(','))
  check('D2 检索不抛错', true)

  report()
}

function report(): void {
  console.log(`\n${pass} 过 / ${fail} 败`)
  for (const f of failures) console.log(`  败: ${f}`)
  process.exit(fail ? 1 : 0)
}

await main()
