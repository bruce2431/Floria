/**
 * 记忆写入链探针（2026-09-15）——memories 表移除 confidence/half_life 后的回归验证
 *
 * 守护的不变量：**写入链在 7 列结构下完整闭环**——insert 列数对齐、新条目字段可读、
 * embeddings 增量重建后与 mem.db 行数一致、supersede 纠错链双向置位、写后可被真实检索命中。
 * 破坏它的路径：db.ts 的 MEM_COLS / memEntryRow / insertMemory 占位符任一处漏改（列数错配 →
 * SQLite 报 "N values for M columns" 或静默错位）、memwriter 漏改导致 buildEntry 输出多字段。
 *
 * 在**隔离库副本**上跑（tmpRoot 下的 .claude/neturon/neurons/Neuron-Pj16），不动真实库。
 *
 * 用法：bun probe-mem-write.ts <tmpRoot>
 */
import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readMemories } from '../src/tools/neturon/db.ts'
import { readNpyF32 } from '../src/tools/neturon/npyio.ts'
import { addMemory, updateMemory } from '../src/tools/neturon/memwriter.ts'
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
const tmpRoot = resolve(process.argv[2] ?? join(here, '..', '..', '20260915182909-神经元字段移除写入验证', 'tmp-root'))
const neuronPath = join(tmpRoot, '.claude', 'neturon', 'neurons', 'Neuron-Pj16')
const memDbPath = join(neuronPath, 'l2.mem', 'mem.db')
const embPath = join(neuronPath, 'l2.mem', 'embeddings.npy')

const EXPECTED_COLS = [
  'memory_id',
  'revelant',
  'blocks',
  'source',
  'core_file',
  'supersedes',
  'deprecated_by',
]

/** 待写入内容：带独特关键词，供检索命中断言 */
const CONTENT = '探针验证条目：字段移除回归测试（probe-mem-write），关键词 索引对齐校验。'

async function main(): Promise<void> {
  if (!existsSync(memDbPath)) {
    console.log(`隔离库不存在：${memDbPath}`)
    process.exit(1)
  }

  // ── A 表结构 ──
  {
    const db = new Database(memDbPath, { readonly: true })
    const cols = (db.query('PRAGMA table_info(memories)').all() as Array<{ name: string }>).map(r => r.name)
    db.close()
    check('A1 列清单 = 7 列且无 confidence/half_life', JSON.stringify(cols) === JSON.stringify(EXPECTED_COLS), cols.join(','))
  }

  const n0 = readMemories(memDbPath).length
  const emb0 = readNpyF32(embPath)
  check('A2 起始行数 mem/npy 一致', n0 === emb0.shape[0], `mem=${n0} npy=${emb0.shape[0]}`)

  // ── B add ──
  const added = await addMemory(
    {
      neuron: 'PJ16',
      content: CONTENT,
      source: 'probe-mem-write',
      revelant: ['probe-ref-1'],
      core_file: [{ name: 'probe.sh', content: 'echo probe' }],
    },
    tmpRoot,
  )
  check('B1 add 返回 ok', added.status === 'ok', added.status === 'ok' ? '' : (added as { message?: string }).message ?? '')
  if (added.status !== 'ok') {
    report()
    return
  }
  const mid1 = added.memory_id

  const entries1 = readMemories(memDbPath)
  const emb1 = readNpyF32(embPath)
  const row1 = entries1.find(e => e.memory_id === mid1)
  check('B2 mem 行数 +1', entries1.length === n0 + 1, `${entries1.length}`)
  check('B3 npy 行数 = mem 行数（增量重建对齐）', emb1.shape[0] === entries1.length, `npy=${emb1.shape[0]} mem=${entries1.length}`)
  check('B4 新条目读回字段完整', !!row1 && row1.blocks[0] === CONTENT && row1.revelant[0] === 'probe-ref-1' && !!row1.core_file?.length && row1.supersedes === null && row1.deprecated_by === null)
  check('B5 条目结构无 confidence/half_life 键', !!row1 && !('confidence' in row1) && !('half_life' in row1))

  // ── C update（supersede） ──
  const upd = await updateMemory(
    { neuron: 'PJ16', memory_id: mid1, content: `${CONTENT}（修正版）`, source: 'probe-mem-write' },
    tmpRoot,
  )
  check('C1 update 返回 ok', upd.status === 'ok', upd.status === 'ok' ? '' : (upd as { message?: string }).message ?? '')
  if (upd.status !== 'ok') {
    report()
    return
  }
  const mid2 = upd.memory_id
  const entries2 = readMemories(memDbPath)
  const oldRow = entries2.find(e => e.memory_id === mid1)
  const newRow = entries2.find(e => e.memory_id === mid2)
  check('C2 mem 行数 +1（追加不删）', entries2.length === n0 + 2, `${entries2.length}`)
  check('C3 旧条目标 deprecated_by', oldRow?.deprecated_by === mid2, `deprecated_by=${oldRow?.deprecated_by}`)
  check('C4 新条目挂 supersedes', newRow?.supersedes === mid1, `supersedes=${newRow?.supersedes}`)

  // ── D 写后可被真实检索命中 ──
  const retr = new NeuronRetriever(neuronPath, 'PJ16')
  const res = await retr.search('字段移除 索引对齐 校验', 5)
  const hitIds = res.formatted.map(r => r.memory_id)
  check('D1 新条目进入检索结果', hitIds.includes(mid2), hitIds.join(','))
  check('D2 被废弃条目不再检索（supersede 生效）', !hitIds.includes(mid1), hitIds.join(','))
  check('D3 检索不抛错且返回非空', res.formatted.length > 0, `${res.formatted.length}`)

  report()
}

function report(): void {
  console.log(`\n${pass} 过 / ${fail} 败`)
  for (const f of failures) console.log(`  败: ${f}`)
  process.exit(fail ? 1 : 0)
}

await main()
