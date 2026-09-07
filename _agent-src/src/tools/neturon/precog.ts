/**
 * precog 拟合环 — fill_precog（p4）+ list_unfilled
 *
 * 对照 Python 基线 engine/core/cognition.py 同名函数 1:1 移植；
 * 2026-09-04 存储层 DB 化（SubPj7 定案同步）：cog.json → precog.db（db.ts precog 表，
 * 标注走 UPDATE by record_id，rowcount≠1 报错）。
 * 防假标注门禁（SubPj7 2026-08-12 修复同步）：空 accuracy 值一律报错，不再放行 ''。
 */

import { join } from 'node:path'
import { resolveNeuronPath } from './config.js'
import { readPrecogRecords, updatePrecog, type PrecogRecord } from './db.js'

/** 填写一条 precog 记录的 description 和 accuracy（拟合环标注） */
export function fillPrecog(
  neuronId: string,
  recordId: string,
  description: string,
  accuracyList: string[],
  cwd?: string,
): { status: 'ok' | 'error'; message: string } {
  let neuronPath: string
  try {
    neuronPath = resolveNeuronPath(neuronId, cwd)
  } catch (e) {
    return { status: 'error', message: (e as Error).message }
  }
  const dbPath = join(neuronPath, 'l1.cog', 'precog.db')
  const target = readPrecogRecords(dbPath).find(r => r.record_id === recordId)
  if (!target) return { status: 'error', message: `找不到记录 ${recordId}` }

  const nResults = target.results?.length ?? 0

  const errors: string[] = []
  if (!(description ?? '').trim().length || description.length < 60) {
    errors.push(`description 仅 ${(description ?? '').length} 字，需 ≥ 60`)
  }
  if (accuracyList.length !== nResults) {
    errors.push(`accuracy 条目数 ${accuracyList.length} ≠ 结果数 ${nResults}`)
  }
  const valid = new Set(['true', 'revelant', 'false'])
  const invalid = accuracyList.filter(a => !valid.has((a ?? '').trim()))
  if (invalid.length) errors.push(`无效 accuracy 值: ${invalid.join(',')}`)

  if (errors.length) return { status: 'error', message: errors.join('; ') }

  // 重排序：false 置底（与 JSON 时代行为一致）
  const results = (target.results ?? []).map((r, i) => ({
    ...r,
    accuracy: (accuracyList[i] ?? '').trim(),
  }))
  results.sort((a, b) => {
    const fa = a.accuracy === 'false' ? 1 : 0
    const fb = b.accuracy === 'false' ? 1 : 0
    return fa - fb || (a.id ?? '').localeCompare(b.id ?? '')
  })

  const updated: Partial<PrecogRecord> = { description, results }
  const rowcount = updatePrecog(dbPath, recordId, updated)
  if (rowcount !== 1) return { status: 'error', message: `更新未命中（rowcount=${rowcount}）: ${recordId}` }
  return { status: 'ok', message: `${recordId} 已填写` }
}

/** 列出所有 description 为空的 precog 记录 */
export function listUnfilled(
  neuronId: string,
  cwd?: string,
): Array<{ record_id: string; query: string; results_count: number; accuracy_filled: number }> {
  const neuronPath = resolveNeuronPath(neuronId, cwd)
  const records = readPrecogRecords(join(neuronPath, 'l1.cog', 'precog.db'))
  const unfilled: Array<{ record_id: string; query: string; results_count: number; accuracy_filled: number }> = []
  for (const r of records) {
    if ((r.description ?? '').trim()) continue
    const results = r.results ?? []
    unfilled.push({
      record_id: r.record_id ?? '',
      query: r.query ?? '',
      results_count: results.length,
      accuracy_filled: results.filter(x => x.accuracy ?? '').length,
    })
  }
  return unfilled
}
