/**
 * 记忆写入器 — remember 工具后端（add=追加 / update=supersede 修正）
 *
 * 对照 Python 基线 engine/core/memwriter.py 1:1 移植；2026-09-04 存储层 DB 化
 * （SubPj7 定案同步）：mem.json → mem.db（db.ts memories 表）。
 * 一次调用三件事：INSERT mem.db + 增量重建 embeddings 索引 + 刷检索缓存。
 * 先算后写（慢的模型编码发生在落盘前，中断零副作用）；embeddings 写失败回滚 DB。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigError, cfgRequired, getGlobalRoot, resolveNeuronPath } from './config.js'
import { encode } from './embedder.js'
import { readNpyF32, writeNpyF32 } from './npyio.js'
import {
  countMemories,
  deleteMemory,
  insertMemory,
  markDeprecated,
  readMemories,
  type MemEntry,
} from './db.js'
import { clearRetrieverCache } from './retriever.js'
import { parse as parseYaml } from 'yaml'

function readYaml(path: string): Record<string, unknown> {
  return (parseYaml(readFileSync(path, 'utf-8')) as Record<string, unknown>) ?? {}
}

function generateMemoryId(personId: string, existingIds: Set<string>, now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const base = `${personId}_MEM_${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  if (!existingIds.has(base)) return base
  let seq = 1
  while (existingIds.has(`${base}_${String(seq).padStart(2, '0')}`)) seq++
  return `${base}_${String(seq).padStart(2, '0')}`
}

/** 计算 entries 的 embedding 矩阵（增量：仅编码最后一条 vstack；否则全量）。纯计算无落盘。 */
async function computeEmbeddings(
  entries: MemEntry[],
  modelCacheDir: string,
  existing: Float32Array | null,
  existingDim: number,
): Promise<{ data: Float32Array; shape: [number, number] }> {
  if (existing && existingDim > 0 && existing.length / existingDim === entries.length - 1 && entries.length > 0) {
    // ── 增量 ──
    const newBlocks = entries[entries.length - 1]!.blocks ?? []
    if (newBlocks.length) {
      const blockEmbs = await encode(newBlocks, modelCacheDir)
      // max-pooling（与 p2-mem_build.py 一致）
      const dim = blockEmbs[0]!.length
      const pooled = new Array<number>(dim).fill(-Infinity)
      for (const emb of blockEmbs) {
        for (let j = 0; j < dim; j++) pooled[j] = Math.max(pooled[j]!, emb[j]!)
      }
      const norm = Math.sqrt(pooled.reduce((a, b) => a + b * b, 0)) + 1e-9
      const newRow = pooled.map(v => v / norm)
      const data = new Float32Array(existing.length + dim)
      data.set(existing, 0)
      data.set(newRow, existing.length)
      return { data, shape: [entries.length, dim] }
    }
    const data = new Float32Array(existing.length + existingDim)
    data.set(existing, 0)
    return { data, shape: [entries.length, existingDim] }
  }

  // ── 全量 ──
  const allBlocks: string[] = []
  const entryMap: Array<[number, number]> = []
  for (const e of entries) {
    const start = allBlocks.length
    allBlocks.push(...(e.blocks ?? []))
    entryMap.push([start, allBlocks.length])
  }

  if (allBlocks.length) {
    const blockEmbs = await encode(allBlocks, modelCacheDir)
    const dim = blockEmbs[0]!.length
    // 每行先填 -Infinity 再 max-pool（0 初值会吃掉负分量）
    const embeddings = new Float32Array(entries.length * dim).fill(-Infinity)
    entryMap.forEach(([s, en], i) => {
      if (s < en) {
        for (let j = s; j < en; j++) {
          for (let d = 0; d < dim; d++) {
            const v = blockEmbs[j]![d]!
            if (v > embeddings[i * dim + d]!) embeddings[i * dim + d] = v
          }
        }
      } else {
        embeddings.fill(0, i * dim, (i + 1) * dim) // 空条目行归零
      }
    })
    // L2 归一化（行）
    for (let i = 0; i < entries.length; i++) {
      let norm = 0
      for (let d = 0; d < dim; d++) norm += embeddings[i * dim + d]! ** 2
      norm = Math.sqrt(norm) + 1e-9
      for (let d = 0; d < dim; d++) embeddings[i * dim + d] = embeddings[i * dim + d]! / norm
    }
    return { data: embeddings, shape: [entries.length, dim] }
  }
  return { data: new Float32Array(entries.length * 512), shape: [entries.length, 512] }
}

/** 全量重建 embeddings 索引（迁移脚本用：mem 行折叠后 rowid 重排，npy 必须重编码对位） */
export async function rebuildEmbeddings(
  neuronPath: string,
  entries: MemEntry[],
  modelCacheDir: string,
  forceFull = false,
): Promise<{ data: Float32Array; shape: [number, number] }> {
  const memDir = join(neuronPath, 'l2.mem')
  const embPath = join(memDir, 'embeddings.npy')
  const confPath = join(memDir, 'index_config.json')

  let existing: Float32Array | null = null
  let existingDim = 0
  if (!forceFull && existsSync(embPath)) {
    const { data, shape } = readNpyF32(embPath)
    existing = data
    existingDim = shape[1] ?? 0
  }

  const result = await computeEmbeddings(entries, modelCacheDir, existing, existingDim)
  writeNpyF32(embPath, result.data, result.shape)
  writeIndexConfig(confPath, result.shape)
  return result
}

function writeIndexConfig(confPath: string, shape: [number, number]): void {
  const config = {
    model_name: 'BAAI/bge-small-zh-v1.5',
    total_entries: shape[0],
    embedding_dim: shape[1],
  }
  const tmp = `${confPath}.tmp`
  writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8')
  renameSync(tmp, confPath)
}

export interface RememberInput {
  neuron: string
  content: string
  blocks?: string[]
  source?: string
  confidence?: number
  half_life?: number
  memory_id?: string
  revelant?: string[]
  core_file?: Array<{ name: string; path?: string; content?: string }>
}

export type RememberResult =
  | {
      status: 'ok'
      action: 'add' | 'update'
      memory_id: string
      superseded?: string
      entry: MemEntry
      superseded_entry?: MemEntry
      mem_count: number
      embeddings_shape: [number, number]
    }
  | { status: 'error'; message: string }

function validateCommon(input: RememberInput): string | null {
  if (!input.content?.trim()) return 'content 不能为空'
  if (!input.source?.trim()) return 'source 不能为空'
  return null
}

function loadNeuron(neuronId: string, cwd?: string): { neuronPath: string; cfg: Record<string, unknown>; modelCacheDir: string } | { error: string } {
  let neuronPath: string
  try {
    neuronPath = resolveNeuronPath(neuronId, cwd)
  } catch (e) {
    return { error: (e as Error).message }
  }
  const cfg = readYaml(join(neuronPath, 'config.yaml'))
  const cfgContext = `Neuron '${neuronId}' config.yaml: ${join(neuronPath, 'config.yaml')}`
  try {
    cfgRequired(cfg, 'person.id', cfgContext)
    cfgRequired(cfg, 'memory.model_name', cfgContext)
    cfgRequired(cfg, 'memory.default_confidence', cfgContext)
    cfgRequired(cfg, 'memory.default_half_life', cfgContext)
  } catch (e) {
    return { error: (e as ConfigError).message }
  }
  return { neuronPath, cfg, modelCacheDir: join(getGlobalRoot(), 'cache', 'models') }
}

function buildEntry(
  input: RememberInput,
  mid: string,
  cfg: Record<string, unknown>,
): MemEntry {
  return {
    memory_id: mid,
    revelant: input.revelant ?? [],
    blocks: input.blocks?.length ? input.blocks : [input.content],
    source: input.source!,
    confidence: input.confidence ?? Number(cfgRequired(cfg, 'memory.default_confidence', '')),
    half_life: input.half_life ?? Number(cfgRequired(cfg, 'memory.default_half_life', '')),
    core_file: input.core_file ?? null,
    supersedes: null,
    deprecated_by: null,
  }
}

/** embeddings 与 mem 行数一致性自愈（不一致先全量重建） */
async function ensureIndexAligned(
  neuronPath: string,
  entries: MemEntry[],
  modelCacheDir: string,
): Promise<{ existing: Float32Array | null; existingDim: number }> {
  const embPath = join(neuronPath, 'l2.mem', 'embeddings.npy')
  if (!existsSync(embPath)) return { existing: null, existingDim: 0 }
  const { data, shape } = readNpyF32(embPath)
  if (shape[0] !== entries.length) {
    await rebuildEmbeddings(neuronPath, entries, modelCacheDir, true)
    const rebuilt = readNpyF32(embPath)
    return { existing: rebuilt.data, existingDim: rebuilt.shape[1] ?? 0 }
  }
  return { existing: data, existingDim: shape[1] ?? 0 }
}

/** 追加一条记忆到 Neuron 记忆层，并自动重建索引 */
export async function addMemory(input: RememberInput, cwd?: string): Promise<RememberResult> {
  const invalid = validateCommon(input)
  if (invalid) return { status: 'error', message: invalid }
  const loaded = loadNeuron(input.neuron, cwd)
  if ('error' in loaded) return { status: 'error', message: loaded.error }
  const { neuronPath, cfg, modelCacheDir } = loaded

  const memDir = join(neuronPath, 'l2.mem')
  mkdirSync(memDir, { recursive: true })
  const dbPath = join(memDir, 'mem.db')
  const entries = readMemories(dbPath)

  // ── 生成 memory_id ──
  let mid: string
  if (input.memory_id) {
    mid = input.memory_id.trim()
    if (entries.some(e => e.memory_id === mid)) {
      return { status: 'error', message: `memory_id 已存在: ${mid}` }
    }
  } else {
    const personId = String(cfgRequired(cfg, 'person.id', ''))
    mid = generateMemoryId(personId, new Set(entries.map(e => e.memory_id)), new Date())
  }

  const entry = buildEntry(input, mid, cfg)

  // ── 自愈：mem/emb 不一致先全量重建 ──
  const aligned = await ensureIndexAligned(neuronPath, entries, modelCacheDir)

  // ── 追加 + 编码（先算后写） ──
  const list = [...entries, entry]
  const embeddings = await computeEmbeddings(list, modelCacheDir, aligned.existing, aligned.existingDim)

  // ── 落盘（DB + 索引；索引写失败回滚 DB 行） ──
  insertMemory(dbPath, entry)
  try {
    writeNpyF32(join(memDir, 'embeddings.npy'), embeddings.data, embeddings.shape)
    writeIndexConfig(join(memDir, 'index_config.json'), embeddings.shape)
  } catch (e) {
    deleteMemory(dbPath, mid)
    throw e
  }

  clearRetrieverCache(input.neuron)
  return {
    status: 'ok',
    action: 'add',
    memory_id: mid,
    entry,
    mem_count: list.length,
    embeddings_shape: embeddings.shape,
  }
}

/** supersede 修正：追加修正条目（supersedes=旧id）+ 旧条目标注 deprecated_by */
export async function updateMemory(
  input: RememberInput & { memory_id: string },
  cwd?: string,
): Promise<RememberResult> {
  const invalid = validateCommon(input)
  if (invalid) return { status: 'error', message: invalid }
  const loaded = loadNeuron(input.neuron, cwd)
  if ('error' in loaded) return { status: 'error', message: loaded.error }
  const { neuronPath, cfg, modelCacheDir } = loaded

  const memDir = join(neuronPath, 'l2.mem')
  mkdirSync(memDir, { recursive: true })
  const dbPath = join(memDir, 'mem.db')
  const entries = readMemories(dbPath)

  // ── 旧条目校验（必须存在且未被废弃） ──
  const old = entries.find(e => e.memory_id === input.memory_id)
  if (!old) {
    return { status: 'error', message: `memory_id 不存在: ${input.memory_id}` }
  }
  if (old.deprecated_by) {
    return {
      status: 'error',
      message: `memory_id 已被 ${old.deprecated_by} 废弃，请对最新条目再做 update`,
    }
  }

  const mid = generateMemoryId(
    String(cfgRequired(cfg, 'person.id', '')),
    new Set(entries.map(e => e.memory_id)),
    new Date(),
  )
  const entry: MemEntry = {
    ...buildEntry(input, mid, cfg),
    supersedes: input.memory_id, // 纠错链：指向被修正的旧条目
  }

  // ── 自愈 ──
  const aligned = await ensureIndexAligned(neuronPath, entries, modelCacheDir)

  // ── 追加 + 旧条目标废弃 + 编码 ──
  const list = [...entries, entry]
  const embeddings = await computeEmbeddings(list, modelCacheDir, aligned.existing, aligned.existingDim)

  // ── 落盘 ──
  insertMemory(dbPath, entry)
  markDeprecated(dbPath, input.memory_id, mid)
  try {
    writeNpyF32(join(memDir, 'embeddings.npy'), embeddings.data, embeddings.shape)
    writeIndexConfig(join(memDir, 'index_config.json'), embeddings.shape)
  } catch (e) {
    // 回滚（撤新增 + 撤废弃标注）
    deleteMemory(dbPath, mid)
    markDeprecated(dbPath, input.memory_id, null)
    throw e
  }

  clearRetrieverCache(input.neuron)
  return {
    status: 'ok',
    action: 'update',
    memory_id: mid,
    superseded: input.memory_id,
    entry,
    superseded_entry: { ...old, deprecated_by: mid },
    mem_count: list.length,
    embeddings_shape: embeddings.shape,
  }
}
