/**
 * 记忆写入器 — remember / neuron_maintain 工具后端
 *
 * 存储定案（2026-09-30，取代 2026-09-04 的 npy 方案）：块级向量与 blocks **同存 mem.db 一行**
 * （memories.block_vectors BLOB，Float32 块序拼接 n_blocks×dim）。据此刻意不引入
 * embeddings.npy / index_config.json / block_offsets / blocks_digest —— 向量与其来源块
 * 同行同事务落地，「索引第 r 行 = 第 r 块」这类位置映射问题整体不存在，漂移无由发生。
 * 一次写入 = 编码该条 blocks → INSERT/UPDATE（含向量）→ 刷检索缓存。
 * 先算后写（慢的模型编码发生在落盘前，中断零副作用）。
 */

import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigError, cfgGet, cfgRequired, getGlobalRoot, resolveNeuronPath } from './config.js'
import { encode } from './embedder.js'
import {
  deleteMemory,
  deriveEntryText,
  insertMemory,
  markDeprecated,
  readMemories,
  readPrecogRecords,
  setMemoryBlocks,
  setMemoryVectors,
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

/** 一批 block 文本编码成连续行（encode 已 L2 归一，此处仅按块序平铺）。 */
async function encodeBlocks(blocks: string[], modelCacheDir: string): Promise<Float32Array> {
  if (!blocks.length) return new Float32Array(0)
  const embs = await encode(blocks, modelCacheDir)
  const dim = embs[0]!.length
  const data = new Float32Array(blocks.length * dim)
  for (let r = 0; r < embs.length; r++) data.set(embs[r]!, r * dim)
  return data
}

export interface RememberInput {
  neuron: string
  content: string
  blocks?: string[]
  source?: string
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
      embeddings_shape: [number, number] // [块数, dim]
    }
  | { status: 'error'; message: string }

function validateCommon(input: RememberInput): string | null {
  if (!input.content?.trim()) return 'content 不能为空'
  if (!input.source?.trim()) return 'source 不能为空'
  return null
}

function loadNeuron(
  neuronId: string,
  cwd?: string,
): { neuronPath: string; cfg: Record<string, unknown>; modelCacheDir: string } | { error: string } {
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
  } catch (e) {
    return { error: (e as ConfigError).message }
  }
  return { neuronPath, cfg, modelCacheDir: join(getGlobalRoot(), 'cache', 'models') }
}

/** 块长上限：库在 config.yaml blocks.max_chars 声明（标准见 prompts.add_memory）。
 *  缺省 300 字 ≈ 180 token，取自 bge-small-zh 位置上限 512 的安全余量。 */
export function blockMaxChars(cfg: Record<string, unknown>): number {
  const v = Number(cfgGet(cfg, 'blocks.max_chars', 300))
  return Number.isFinite(v) && v > 0 ? v : 300
}

/** 超长块就近切分：优先句末标点/换行，窗口后半段找不到断点就硬切。
 *  不变量——返回的每一段长度都 ≤ maxChars（BGE 512 token 上限的写入侧保证：
 *  encode 对超长输入静默丢尾，尾部内容不进向量，故块长必须在落盘前封顶）。
 *  导出供存量数据重切脚本复用（同一把尺子，不另起炉灶）。 */
export function splitBlock(block: string, maxChars: number): string[] {
  if (block.length <= maxChars) return [block]
  const parts: string[] = []
  let rest = block
  while (rest.length > maxChars) {
    const win = rest.slice(0, maxChars)
    const cut = Math.max(
      win.lastIndexOf('。'),
      win.lastIndexOf('；'),
      win.lastIndexOf('！'),
      win.lastIndexOf('？'),
      win.lastIndexOf('\n'),
    )
    const end = cut >= maxChars / 2 ? cut + 1 : maxChars
    const head = rest.slice(0, end).trim()
    if (head) parts.push(head)
    rest = rest.slice(end).trim()
  }
  if (rest) parts.push(rest)
  return parts
}

function buildEntry(input: RememberInput, mid: string, maxChars: number): MemEntry {
  const raw = input.blocks?.length ? input.blocks : [input.content]
  const blocks = raw.flatMap(b => splitBlock(String(b), maxChars))
  return {
    memory_id: mid,
    revelant: input.revelant ?? [],
    blocks,
    source: input.source!,
    core_file: input.core_file ?? null,
    supersedes: null,
    deprecated_by: null,
  }
}

/** 追加一条记忆到 Neuron 记忆层（blocks 与其向量同事务落 mem.db） */
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

  const entry = buildEntry(input, mid, blockMaxChars(cfg))

  // ── 先算后写：编码该条 blocks（中断零副作用） ──
  const vectors = await encodeBlocks(entry.blocks, modelCacheDir)
  const dim = entry.blocks.length ? vectors.length / entry.blocks.length : 0
  insertMemory(dbPath, entry, vectors)

  clearRetrieverCache(input.neuron)
  return {
    status: 'ok',
    action: 'add',
    memory_id: mid,
    entry,
    mem_count: entries.length + 1,
    embeddings_shape: [entry.blocks.length, dim],
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
    ...buildEntry(input, mid, blockMaxChars(cfg)),
    supersedes: input.memory_id, // 纠错链：指向被修正的旧条目
  }

  const vectors = await encodeBlocks(entry.blocks, modelCacheDir)
  const dim = entry.blocks.length ? vectors.length / entry.blocks.length : 0

  insertMemory(dbPath, entry, vectors)
  markDeprecated(dbPath, input.memory_id, mid)

  clearRetrieverCache(input.neuron)
  return {
    status: 'ok',
    action: 'update',
    memory_id: mid,
    superseded: input.memory_id,
    entry,
    superseded_entry: { ...old, deprecated_by: mid },
    mem_count: entries.length + 1,
    embeddings_shape: [entry.blocks.length, dim],
  }
}

// ── 块级向量维护（backfill 用：重编码该条 / 全库） ──

/** 全库向量重编码（一次性 backfill；模型更换 / 老库补列）。逐条先算后写，中断可重入。 */
export async function rebuildVectors(
  neuronPath: string,
  entries: MemEntry[],
  modelCacheDir: string,
  onProgress?: (done: number, total: number) => void,
): Promise<{ entries: number; blocks: number; dim: number }> {
  const dbPath = join(neuronPath, 'l2.mem', 'mem.db')
  let blocks = 0
  let dim = 0
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!
    const vectors = await encodeBlocks(e.blocks ?? [], modelCacheDir)
    setMemoryVectors(dbPath, e.memory_id, vectors)
    const n = e.blocks?.length ?? 0
    blocks += n
    if (n) dim = vectors.length / n
    onProgress?.(i + 1, entries.length)
  }
  clearRetrieverCache()
  return { entries: entries.length, blocks, dim }
}

// ── neuron_maintain 后端 ──

export interface MaintainResult {
  status: 'ok' | 'error'
  action?: string
  message?: string
  memory_id?: string
  affected?: number
  [k: string]: unknown
}

function openNeuron(neuronId: string, cwd?: string) {
  const loaded = loadNeuron(neuronId, cwd)
  if ('error' in loaded) return { error: loaded.error } as const
  const dbPath = join(loaded.neuronPath, 'l2.mem', 'mem.db')
  return { ...loaded, dbPath } as const
}

/** set_blocks：直接替换某条 blocks（重写/合并/拆分/删除块都是特例），重编码该条向量后同事务写回。 */
export async function setBlocks(
  neuronId: string,
  memoryId: string,
  blocks: string[],
  cwd?: string,
): Promise<MaintainResult> {
  const n = openNeuron(neuronId, cwd)
  if ('error' in n) return { status: 'error', message: n.error }
  const entries = readMemories(n.dbPath)
  const entry = entries.find(e => e.memory_id === memoryId)
  if (!entry) return { status: 'error', message: `memory_id 不存在: ${memoryId}` }
  const maxChars = blockMaxChars(n.cfg)
  const finalBlocks = blocks.flatMap(b => splitBlock(String(b), maxChars)).filter(Boolean)
  const vectors = await encodeBlocks(finalBlocks, n.modelCacheDir)
  setMemoryBlocks(n.dbPath, memoryId, finalBlocks, vectors)
  clearRetrieverCache(neuronId)
  return {
    status: 'ok',
    action: 'set_blocks',
    memory_id: memoryId,
    affected: finalBlocks.length,
    blocks: finalBlocks,
  }
}

/** recut：把条目现有 blocks 拼回整文按 max_chars 重切（原始分块边界不可逆，原文在 l3.raw）。 */
export async function recut(
  neuronId: string,
  memoryId: string | undefined,
  cwd?: string,
): Promise<MaintainResult> {
  const n = openNeuron(neuronId, cwd)
  if ('error' in n) return { status: 'error', message: n.error }
  const entries = readMemories(n.dbPath)
  const targets = memoryId ? entries.filter(e => e.memory_id === memoryId) : entries
  if (memoryId && !targets.length) return { status: 'error', message: `memory_id 不存在: ${memoryId}` }
  const maxChars = blockMaxChars(n.cfg)
  const changed: string[] = []
  for (const e of targets) {
    const text = deriveEntryText(e)
    if (!text) continue
    const blocks = splitBlock(text, maxChars).filter(Boolean)
    const vectors = await encodeBlocks(blocks, n.modelCacheDir)
    setMemoryBlocks(n.dbPath, e.memory_id, blocks, vectors)
    changed.push(e.memory_id)
  }
  clearRetrieverCache(neuronId)
  return { status: 'ok', action: 'recut', affected: changed.length, memory_ids: changed }
}

/** forget：soft=标废弃（保留可溯源，默认）；hard=物理删除该行（含向量）。 */
export function forget(
  neuronId: string,
  memoryId: string,
  mode: 'soft' | 'hard' = 'soft',
  cwd?: string,
): MaintainResult {
  const n = openNeuron(neuronId, cwd)
  if ('error' in n) return { status: 'error', message: n.error }
  const entry = readMemories(n.dbPath).find(e => e.memory_id === memoryId)
  if (!entry) return { status: 'error', message: `memory_id 不存在: ${memoryId}` }
  if (mode === 'hard') {
    deleteMemory(n.dbPath, memoryId)
  } else {
    // soft：自指废弃（deprecated_by = 自身）——rankMem 以 deprecated_by 非空跳过
    markDeprecated(n.dbPath, memoryId, memoryId)
  }
  clearRetrieverCache(neuronId)
  return { status: 'ok', action: 'forget', memory_id: memoryId, mode }
}

/** merge：多条合为一条新记忆（append-only），旧条废弃指向新 id。 */
export async function mergeMemories(
  neuronId: string,
  memoryIds: string[],
  content: string,
  opts: { blocks?: string[]; source?: string; cwd?: string },
): Promise<MaintainResult> {
  const n = openNeuron(neuronId, opts.cwd)
  if ('error' in n) return { status: 'error', message: n.error }
  const entries = readMemories(n.dbPath)
  const olds = memoryIds.map(id => entries.find(e => e.memory_id === id)).filter(Boolean) as MemEntry[]
  if (olds.length !== memoryIds.length) {
    const found = new Set(olds.map(e => e.memory_id))
    return { status: 'error', message: `部分 memory_id 不存在: ${memoryIds.filter(i => !found.has(i)).join(', ')}` }
  }
  const mid = generateMemoryId(
    String(cfgRequired(n.cfg, 'person.id', '')),
    new Set(entries.map(e => e.memory_id)),
    new Date(),
  )
  const maxChars = blockMaxChars(n.cfg)
  const raw = opts.blocks?.length ? opts.blocks : [content]
  const blocks = raw.flatMap(b => splitBlock(String(b), maxChars)).filter(Boolean)
  const entry: MemEntry = {
    memory_id: mid,
    revelant: [],
    blocks,
    source: opts.source ?? 'merge',
    core_file: null,
    supersedes: memoryIds.join(','),
    deprecated_by: null,
  }
  const vectors = await encodeBlocks(blocks, n.modelCacheDir)
  insertMemory(n.dbPath, entry, vectors)
  for (const id of memoryIds) markDeprecated(n.dbPath, id, mid)
  clearRetrieverCache(neuronId)
  return { status: 'ok', action: 'merge', memory_id: mid, affected: memoryIds.length, merged: memoryIds }
}

/** usage：只读——某条 / 全库的检索使用概览（供判断哪些块该改）。数据源 l1.cog/precog.db。 */
export function usage(neuronId: string, memoryId?: string, cwd?: string): MaintainResult {
  const n = openNeuron(neuronId, cwd)
  if ('error' in n) return { status: 'error', message: n.error }
  const records = readPrecogRecords(join(n.neuronPath, 'l1.cog', 'precog.db'))
  const stats = new Map<string, { hits: number; true: number; revelant: number; false: number }>()
  for (const r of records) {
    for (const it of r.results ?? []) {
      const id = it.id
      if (!id) continue
      const s = stats.get(id) ?? { hits: 0, true: 0, revelant: 0, false: 0 }
      s.hits++
      const acc = String(it.accuracy ?? '').toLowerCase()
      if (acc === 'true') s.true++
      else if (acc === 'revelant') s.revelant++
      else if (acc === 'false') s.false++
      stats.set(id, s)
    }
  }
  if (memoryId) {
    return { status: 'ok', action: 'usage', memory_id: memoryId, stat: stats.get(memoryId) ?? { hits: 0, true: 0, revelant: 0, false: 0 } }
  }
  const rows = [...stats.entries()]
    .map(([id, s]) => ({ memory_id: id, ...s }))
    .sort((a, b) => b.hits - a.hits)
  return { status: 'ok', action: 'usage', precog_records: records.length, memory_stats: rows }
}
