/**
 * Neuron 检索器 — 检索引擎（含 precog 记录 + 认知反查注入）
 *
 * 对照 Python 基线 engine/core/retriever.py 1:1 移植（2026-09-03 TS 化定案）。
 * 双注入：mem-cog（cos+kw 加权）+ 认知检索（precog 反查锚定），两者独立注入不融合。
 * 每次 search() 自动写 precog 到 l1.cog/precog.db（2026-09-04 DB 化：纯追加 INSERT）。
 *
 * 分歧说明：分词用 Intl.Segmenter（见 segment.ts）；嵌入用 transformers.js
 * bge-small-zh-v1.5（Spike 已验证与 Python 生产路径 cos=1.0）。
 * 存储定案：mem 不存 content/summary，文本由 blocks 派生（db.ts deriveEntryText）。
 */

import { existsSync, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cfgRequired, type ConfigError, getGlobalRoot, resolveNeuronPath } from './config.js'
import { readNpyF32 } from './npyio.js'
import {
  appendPrecog,
  deriveEntryText,
  readMemories,
  readPrecogRecords,
  type MemEntry,
  type PrecogRecord,
  type PrecogResultItem,
} from './db.js'
import { splitQuery, GENERIC_TOKENS } from './segment.js'
import { encode } from './embedder.js'
import { parse as parseYaml } from 'yaml'

export type { MemEntry, PrecogRecord, PrecogResultItem }

export const SUPPORTED_MODEL = 'Xenova/bge-small-zh-v1.5'
// Python 侧模型名（config/index_config 里记的是这个名字）
export const PY_MODEL_EQUIVALENT = 'BAAI/bge-small-zh-v1.5'

// ── 引擎级默认（原 engine/config.yaml 融合段；Neuron config 优先覆盖） ──
const ENGINE_COGNITION_DEFAULTS = {
  top_nodes: 3,
  concept_cos_threshold: 0.4,
  use_accuracies: ['true', 'revelant'],
  max_member_memories: 20,
}

// ── 工具函数 ──

const TS_RE = /(\d{4}-\d{2}-\d{2}-\d{2}:\d{2}:\d{2})(?:_(\d+))?$/

/** 从 record_id 提取时间排序键（跨前缀也按时间排序） */
export function recordTimeKey(recordId: string): [string, number] {
  const m = TS_RE.exec(recordId ?? '')
  if (m) return [m[1]!, parseInt(m[2] ?? '0', 10)]
  return ['', 0]
}

function readYaml(path: string): Record<string, unknown> {
  return (parseYaml(readFileSync(path, 'utf-8')) as Record<string, unknown>) ?? {}
}

/** JSON 宽读：文件缺失/损坏返回 null（cog 快照类文件损坏不阻断检索） */
function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T
  } catch {
    return null
  }
}

/** 归一化查询文本：去所有空白（写侧去重匹配） */
export function normQuery(q: string): string {
  return (q ?? '').replace(/\s+/g, '').trim()
}

function nowStamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// ── 检索器 ──

interface RankedItem {
  rank: number
  cos: number
  kw: number
  entry: MemEntry
}

const REQUIRED_KEYS = [
  'person.id',
  'memory.model_name',
  'ranking.fact.w_cos',
  'ranking.fact.w_kw',
  'precog.default_top_k',
  'precog.expand_threshold',
  'precog.expand_factor',
] as const

export class NeuronRetriever {
  path: string
  neuronId: string
  entries: MemEntry[] = []
  embeddings: Float32Array | null = null
  embeddingShape: [number, number] = [0, 0]
  encodedIds: string[] = []
  indexModelName = ''
  private cfg: Record<string, unknown>
  private modelCacheDir: string

  // cog2 概念嵌入缓存（mtime 失效）
  private cogConceptsEmb: number[][] | null = null
  private cogConceptsSrc: Array<Record<string, unknown>> | null = null
  private cogConceptsMtime = 0

  constructor(neuronPath: string, neuronId: string, modelCacheDir?: string) {
    this.path = neuronPath
    this.neuronId = neuronId
    this.modelCacheDir = modelCacheDir ?? join(getGlobalRoot(), 'cache', 'models')
    this.cfg = readYaml(join(neuronPath, 'config.yaml'))
    const ctx = this.cfgContext
    for (const key of REQUIRED_KEYS) cfgRequired(this.cfg, key, ctx)
    this.loadData()
  }

  private get cfgContext(): string {
    const label = this.neuronId ? `Neuron '${this.neuronId}'` : 'Neuron'
    return `${label} config.yaml: ${join(this.path, 'config.yaml')}`
  }

  private num(path: string): number {
    return Number(cfgRequired(this.cfg, path, this.cfgContext))
  }

  get wCos(): number {
    return this.num('ranking.fact.w_cos')
  }
  get wKw(): number {
    return this.num('ranking.fact.w_kw')
  }
  get expandThreshold(): number {
    return this.num('precog.expand_threshold')
  }
  get expandFactor(): number {
    return this.num('precog.expand_factor')
  }
  get defaultTopK(): number {
    return this.num('precog.default_top_k')
  }
  get defaultResolution(): string {
    return String(cfgRequired(this.cfg, 'abstraction.default_resolution', this.cfgContext))
  }
  get personId(): string {
    return String(cfgRequired(this.cfg, 'person.id', this.cfgContext))
  }

  private checkModel(): void {
    const name = String(cfgRequired(this.cfg, 'memory.model_name', this.cfgContext))
    const effective = this.indexModelName || name
    if (effective !== PY_MODEL_EQUIVALENT) {
      throw new Error(
        `Neuron '${this.neuronId}' 嵌入模型为 ${effective}，TS 引擎仅支持 ${PY_MODEL_EQUIVALENT}`,
      )
    }
  }

  private loadData(): void {
    const memDbPath = join(this.path, 'l2.mem', 'mem.db')
    const embPath = join(this.path, 'l2.mem', 'embeddings.npy')
    const confPath = join(this.path, 'l2.mem', 'index_config.json')

    const raw = readMemories(memDbPath)
    if (!raw.length && !existsSync(memDbPath)) {
      throw new Error(`mem.db 不存在（未迁移 DB 化）: ${memDbPath}`)
    }
    this.entries = raw

    if (existsSync(embPath)) {
      const { data, shape } = readNpyF32(embPath)
      this.embeddings = data
      this.embeddingShape = [shape[0] ?? 0, shape[1] ?? 0]
    }

    if (existsSync(confPath)) {
      const idxCfg = JSON.parse(readFileSync(confPath, 'utf-8')) as {
        encoded_ids?: string[]
        model_name?: string
      }
      this.encodedIds = idxCfg?.encoded_ids ?? []
      this.indexModelName = idxCfg?.model_name ?? ''
    }
    this.checkModel()

    // 一致性检查：mem/emb 行数不齐 → encoded_ids 重建对齐
    if (this.embeddings && this.entries.length > 0 && this.embeddingShape[0] !== this.entries.length) {
      this.reindexByIds()
    }
  }

  private reindexByIds(): void {
    if (!this.encodedIds.length || !this.embeddings) return
    const dim = this.embeddingShape[1]
    const idToRow = new Map<string, number>()
    this.encodedIds.forEach((mid, i) => {
      if (i < this.embeddingShape[0]) idToRow.set(mid, i)
    })
    const newEntries: MemEntry[] = []
    const newEmbs: number[] = []
    for (const e of this.entries) {
      const row = idToRow.get(e.memory_id ?? '')
      if (row === undefined) continue
      newEntries.push(e)
      newEmbs.push(...Array.from(this.embeddings.slice(row * dim, (row + 1) * dim)))
    }
    if (newEmbs.length) {
      this.entries = newEntries
      this.embeddings = new Float32Array(newEmbs)
      this.embeddingShape = [newEntries.length, dim]
    }
  }

  // ── precog 记录（l1.cog/precog.db，纯追加） ──

  private readL1Cog(name: string): unknown {
    const p = join(this.path, 'l1.cog', name)
    if (!existsSync(p)) return null
    return JSON.parse(readFileSync(p, 'utf-8'))
  }

  /** 写一条 precog 记录（纯追加；同秒碰撞加 _1/_2 后缀） */
  private logPrecog(queryText: string, topK: number, ranked: RankedItem[]): PrecogRecord {
    const dbPath = join(this.path, 'l1.cog', 'precog.db')
    const records = readPrecogRecords(dbPath)

    const stamp = nowStamp()
    const baseId = `PC${this.personId}_${stamp}`
    let recordId = baseId
    let n = 1
    while (records.some(r => r.record_id === recordId)) {
      recordId = `${baseId}_${n}`
      n++
    }

    const record: PrecogRecord = {
      record_id: recordId,
      status: 'pre',
      query: queryText,
      keywords: splitQuery(queryText),
      source: '',
      top_k: topK,
      results: ranked.map(({ entry }) => ({
        id: entry.memory_id,
        accuracy: '',
        summary: deriveEntryText(entry).slice(0, 60),
      })),
      description: '',
    }
    appendPrecog(dbPath, record)
    return record
  }

  /** 该 query（归一化匹配）最近的一条 precog 记录（供附带引导标注） */
  getRecentPrecog(queryText: string): PrecogRecord | null {
    const records = readPrecogRecords(join(this.path, 'l1.cog', 'precog.db'))
    const norm = normQuery(queryText)
    let best: PrecogRecord | null = null
    let bestKey: [string, number] | null = null
    for (const r of records) {
      if (normQuery(r.query ?? '') !== norm) continue
      const k = recordTimeKey(r.record_id ?? '')
      if (!bestKey || k[0] > bestKey[0] || (k[0] === bestKey[0] && k[1] > bestKey[1])) {
        best = r
        bestKey = k
      }
    }
    return best
  }

  // ── mem 排序（cos + kw） ──

  private keywordScore(query: string, entry: MemEntry, keywords?: string[]): number {
    const search_text = deriveEntryText(entry).toLowerCase()
    const kws = keywords ?? splitQuery(query)
    if (!kws.length) return 0
    const hits = kws.filter(kw => search_text.includes(kw)).length
    return hits / kws.length
  }

  private formatResults(ranked: RankedItem[]) {
    return ranked.map(({ rank, cos, kw, entry }) => ({
      memory_id: entry.memory_id ?? '',
      rank: Number(rank.toFixed(4)),
      cos_score: Number(cos.toFixed(4)),
      kw_score: Number(kw.toFixed(4)),
      has_core_file: !!entry.core_file?.length,
      blocks: entry.blocks ?? [],
    }))
  }

  /** cos + kw 加权检索（不写 precog） */
  private async rankMem(
    queryText: string,
    topK?: number,
  ): Promise<{ ranked: RankedItem[]; formatted: ReturnType<NeuronRetriever['formatResults']> }> {
    const k = topK ?? this.defaultTopK
    if (!this.entries.length) return { ranked: [], formatted: [] }
    const keywords = splitQuery(queryText)

    if (!this.embeddings || this.embeddingShape[0] !== this.entries.length) {
      throw new Error(
        `Neuron '${this.neuronId}' embeddings 索引缺失或与 mem.db 行数不一致（${this.embeddingShape[0]} ≠ ${this.entries.length}），先经 remember 写入重建索引`,
      )
    }

    const [qEmb] = await encode([queryText], this.modelCacheDir)
    const dim = this.embeddingShape[1]

    const ranked: RankedItem[] = []
    for (let i = 0; i < this.entries.length; i++) {
      const cosScore = dot(this.embeddings, i * dim, qEmb!)
      if (cosScore < 0.1) continue
      const entry = this.entries[i]!
      if (entry.deprecated_by) continue // supersede 废弃条目不参与检索
      const kwScore = this.keywordScore(queryText, entry, keywords)
      ranked.push({ rank: this.wCos * cosScore + this.wKw * kwScore, cos: cosScore, kw: kwScore, entry })
    }
    ranked.sort((a, b) => b.rank - a.rank)

    // 自动扩大 k：底部结果仍高于阈值 → 增大 top_k
    const expanded =
      ranked.length >= k && (ranked[k - 1]?.rank ?? 0) >= this.expandThreshold
        ? Math.floor(k * this.expandFactor)
        : k
    const results = ranked.slice(0, expanded)
    return { ranked: results, formatted: this.formatResults(results) }
  }

  // ── 认知检索注入（Neuron config 优先 / 引擎默认兜底） ──

  private fusionCfg(path: string, defaultValue?: unknown): unknown {
    let node: unknown = this.cfg
    for (const key of path.split('.')) {
      if (node && typeof node === 'object' && key in (node as Record<string, unknown>)) {
        node = (node as Record<string, unknown>)[key]
      } else {
        node = undefined
        break
      }
    }
    if (node === undefined || node === null) {
      node = ENGINE_COGNITION_DEFAULTS[path.split('.')[1] as keyof typeof ENGINE_COGNITION_DEFAULTS]
    }
    return node ?? defaultValue
  }

  /** cog2 概念批量编码（mtime 失效缓存） */
  private async embedCogCache(): Promise<[number[][] | null, Array<Record<string, unknown>> | null]> {
    const path = join(this.path, 'l1.cog', 'cog2.json')
    if (!existsSync(path)) return [null, null]
    const mtime = statSync(path).mtimeMs
    if (this.cogConceptsEmb && this.cogConceptsMtime === mtime) {
      return [this.cogConceptsEmb, this.cogConceptsSrc]
    }
    const data = readJson<{ cog2_records?: Array<Record<string, unknown>> }>(path)
    const src: Array<Record<string, unknown>> = []
    const texts: string[] = []
    for (const rec of data?.cog2_records ?? []) {
      const tl = `${rec.name ?? ''} ${rec.description ?? ''}`.trim()
      if (tl) {
        texts.push(tl)
        src.push(rec)
      }
    }
    if (!texts.length) return [null, null]
    const embs = await encode(texts, this.modelCacheDir)
    this.cogConceptsEmb = embs
    this.cogConceptsSrc = src
    this.cogConceptsMtime = mtime
    return [embs, src]
  }

  /** mem_id → {node_ids} 倒排索引（cog_graph.json true/revelant 直链） */
  private buildMemNodeIndex(graph: unknown): Map<string, Set<string>> {
    const index = new Map<string, Set<string>>()
    for (const node of (graph as { nodes?: GraphNode[] })?.nodes ?? []) {
      if (!node.id) continue
      for (const mid of node.true_memories ?? []) {
        if (!index.has(mid)) index.set(mid, new Set())
        index.get(mid)!.add(node.id)
      }
      for (const mid of node.revelant_memories ?? []) {
        if (!index.has(mid)) index.set(mid, new Set())
        index.get(mid)!.add(node.id)
      }
    }
    return index
  }

  /** precog.results[].id（排除 accuracy=false）→ 倒排反查命中节点 */
  private reverseLookupNodes(precogRecord: PrecogRecord | null): CognitionNode[] {
    if (!precogRecord) return []
    const memIds = (precogRecord.results ?? [])
      .filter(x => (x.accuracy ?? '').toLowerCase() !== 'false')
      .map(x => x.id)
      .filter(Boolean)
    if (!memIds.length) return []
    const graph = this.readL1Cog('cog_graph.json')
    const index = this.buildMemNodeIndex(graph)
    const nodeHits = new Map<string, number>()
    for (const mid of memIds) {
      for (const nid of index.get(mid) ?? []) {
        nodeHits.set(nid, (nodeHits.get(nid) ?? 0) + 1)
      }
    }
    const nodes = new Map<string, GraphNode>()
    for (const n of (graph as { nodes?: GraphNode[] })?.nodes ?? []) nodes.set(n.id, n)
    const topNodes = Number(this.fusionCfg('cognition.top_nodes', 3))
    const sorted = [...nodeHits.entries()].sort((a, b) => b[1] - a[1])
    const out: CognitionNode[] = []
    for (const [nid, cnt] of sorted) {
      const node = nodes.get(nid)
      if (!node) continue
      out.push({
        id: node.id,
        query: node.query ?? '',
        keywords: node.keywords ?? [],
        true_count: node.true_count ?? 0,
        revelant_count: node.revelant_count ?? 0,
        true_memories: node.true_memories ?? [],
        revelant_memories: node.revelant_memories ?? [],
        hit_memories: cnt,
      })
      if (out.length >= topNodes) break
    }
    return out
  }

  /** 认知路由：概念走 BGE cos；节点由 precog.results 倒排反查 */
  private async cognitionRoute(
    queryText: string,
    precogRecord: PrecogRecord | null,
  ): Promise<{ concepts: CognitionConcept[]; nodes: CognitionNode[] }> {
    const result: { concepts: CognitionConcept[]; nodes: CognitionNode[] } = {
      concepts: [],
      nodes: [],
    }
    if (!this.entries.length) return result
    const conceptTh = Number(this.fusionCfg('cognition.concept_cos_threshold', 0.4))
    const [qEmb] = await encode([queryText], this.modelCacheDir)

    const [cEmbs, cSrc] = await this.embedCogCache()
    if (cEmbs && cSrc) {
      for (let i = 0; i < cSrc.length; i++) {
        const cos = dot(cEmbs[i]!, 0, qEmb!)
        if (cos >= conceptTh) {
          const rec = cSrc[i]!
          result.concepts.push({
            name: String(rec.name ?? ''),
            confidence: Number(rec.confidence ?? 0),
            description: String(rec.description ?? ''),
            member_names: (rec.member_names as string[]) ?? [],
            cos: Number(cos.toFixed(4)),
          })
        }
      }
      result.concepts.sort((a, b) => b.cos - a.cos)
    }

    result.nodes = this.reverseLookupNodes(precogRecord)
    return result
  }

  /** 节点直链 → 成员记忆（按 accuracy 分列，白名单过滤） */
  private resolveMemberMemories(node: CognitionNode): Array<{ memory_id: string; accuracy: string; time: string }> {
    const accRaw = this.fusionCfg('cognition.use_accuracies', ['true', 'revelant'])
    const accList = Array.isArray(accRaw) ? accRaw : [accRaw]
    const accWhitelist = new Set(accList.map(a => String(a).toLowerCase()))
    const idToEntry = new Map(this.entries.map(e => [e.memory_id ?? '', e]))

    const mems: Array<{ memory_id: string; accuracy: string; time: string }> = []
    for (const [acc, mids] of [
      ['true', node.true_memories ?? []],
      ['revelant', node.revelant_memories ?? []],
    ] as const) {
      if (!accWhitelist.has(acc)) continue
      for (const mid of mids) {
        const entry = idToEntry.get(mid)
        if (!entry) continue
        mems.push({
          memory_id: mid,
          accuracy: acc,
          time: extractTime(mid),
        })
      }
    }
    const maxMem = Number(this.fusionCfg('cognition.max_member_memories', 20))
    return mems.slice(0, maxMem)
  }

  /** 命中节点 → 所属社群（community.json 默认分辨率） */
  private nodeCommunities(nodeIds: Set<string>): unknown[] {
    if (!nodeIds.size) return []
    const defaultRes = this.defaultResolution
    const comm = this.readL1Cog('community.json') as
      | Record<string, { communities?: Array<Record<string, unknown>> }>
      | null
    if (!comm || !(defaultRes in comm)) return []
    const out: unknown[] = []
    for (const c of comm[defaultRes]?.communities ?? []) {
      const members = (c.members as Array<Record<string, unknown>>) ?? []
      const hit = members.filter(m => nodeIds.has(String(m.id)))
      if (hit.length) {
        out.push({
          size: Number(c.size ?? 0),
          density: Number(c.density ?? 0),
          member_queries: members.map(m => m.query ?? ''),
          hit_roles: hit.map(m => m.role ?? ''),
        })
      }
    }
    return out
  }

  /** 双注入检索：mem-cog（写 precog）+ 认知检索（precog 反查锚定） */
  async search(
    queryText: string,
    topK?: number,
  ): Promise<{ precog: PrecogRecord | null; cognition: Cognition; formatted: ReturnType<NeuronRetriever['formatResults']> }> {
    const k = topK ?? this.defaultTopK
    const { ranked, formatted } = await this.rankMem(queryText, k)

    // 写 precog（与管线一致）；无结果不记录
    const written = ranked.length ? this.logPrecog(queryText, k, ranked) : null

    // 认知检索强制跑（反查锚 = 本次写入记录）
    const route = await this.cognitionRoute(queryText, written)
    for (const node of route.nodes) {
      ;(node as CognitionNode & { member_memories?: unknown }).member_memories =
        this.resolveMemberMemories(node)
    }
    const nodeIds = new Set(route.nodes.map(n => n.id))
    const cognition: Cognition = {
      concepts: route.concepts,
      nodes: route.nodes,
      communities: this.nodeCommunities(nodeIds),
    }
    return { precog: written, cognition, formatted }
  }

  /** 认知层强制全查：概念 + 社群 + 节点 + 记忆全部返回，不做降级（不写 precog） */
  async getCogContext(
    query: string,
    topK?: number,
  ): Promise<{ cog2_concepts: unknown[]; communities: unknown[]; nodes: unknown[]; mem: ReturnType<NeuronRetriever['formatResults']> }> {
    const result = {
      cog2_concepts: [] as unknown[],
      communities: [] as unknown[],
      nodes: [] as unknown[],
      mem: [] as ReturnType<NeuronRetriever['formatResults']>,
    }
    const k = topK ?? this.defaultTopK
    const keywords = splitQuery(query)
    if (!keywords.length) return result

    // 认知层（概念/社群）只统计非通用领域词
    const domainKw = keywords.filter(kw => !GENERIC_TOKENS.has(kw))
    const kwForLayers = domainKw.length ? domainKw : keywords

    // 1) 概念层 — cog2.json（非通用词按 name 2× / desc 1× 打分，总分 ≥1 命中）
    const cog2 = this.readL1Cog('cog2.json') as
      | { cog2_records?: Array<Record<string, unknown>> }
      | null
    if (cog2) {
      for (const rec of cog2.cog2_records ?? []) {
        const name = String(rec.name ?? '')
        const desc = String(rec.description ?? '')
        let score = 0
        score += 2.0 * domainKw.filter(kw => name.toLowerCase().includes(kw)).length
        score += 1.0 * domainKw.filter(kw => desc.toLowerCase().includes(kw)).length
        if (score >= 1.0) {
          result.cog2_concepts.push({
            name,
            confidence: Number(rec.confidence ?? 0),
            description: desc,
            members: rec.members ?? [],
            member_names: rec.member_names ?? [],
          })
        }
      }
    }

    // 2) 社群层 — community.json（默认分辨率；严格多数命中）
    const defaultRes = this.defaultResolution
    const comm = this.readL1Cog('community.json') as
      | Record<string, { communities?: Array<Record<string, unknown>> }>
      | null
    if (comm && defaultRes in comm) {
      for (const c of comm[defaultRes]?.communities ?? []) {
        const members = (c.members as Array<Record<string, unknown>>) ?? []
        const size = Math.max(members.length, 1)
        const needCov = Math.floor(size / 2) + 1
        const kwCov = new Map<string, number>()
        for (const m of members) {
          const tl = String(m.query ?? '').toLowerCase()
          for (const kw of domainKw) {
            if (tl.includes(kw)) kwCov.set(kw, (kwCov.get(kw) ?? 0) + 1)
          }
        }
        const hit = [...kwCov.values()].some(cnt => cnt >= needCov)
        if (hit) {
          result.communities.push({
            size,
            density: Number(c.density ?? 0),
            members: members.map(m => ({
              id: m.id ?? '',
              query: m.query ?? '',
              core_score: Number(m.core_score ?? 0),
              role: m.role ?? '',
            })),
          })
        }
      }
    }

    // 3) 聚合节点层 — cog_graph.json（query + keywords 命中）
    const graph = this.readL1Cog('cog_graph.json') as { nodes?: GraphNode[] } | null
    if (graph) {
      for (const node of graph.nodes ?? []) {
        const tl = `${node.query ?? ''} ${(node.keywords ?? []).join(' ')}`.toLowerCase()
        if (kwForLayers.some(kw => tl.includes(kw))) {
          result.nodes.push({
            id: node.id,
            query: node.query ?? '',
            keywords: node.keywords ?? [],
            true_count: node.true_count ?? 0,
            revelant_count: node.revelant_count ?? 0,
          })
        }
      }
    }

    // 4) 记忆层 — 强制全查（不写 precog；embeddings 不可用回退关键词）
    const { formatted } = await this.rankMem(query, k)
    result.mem = formatted
    return result
  }

  /** 按 memory_id 精确查找完整 mem.db 条目 */
  getSource(memoryId: string): MemEntry | null {
    for (const entry of this.entries) {
      if (entry.memory_id === memoryId) return entry
    }
    return null
  }
}

// ── 检索池 ──

const pool = new Map<string, NeuronRetriever>()

export function getRetriever(neuronId: string, cwd?: string): NeuronRetriever {
  let r = pool.get(neuronId)
  if (!r) {
    const path = resolveNeuronPath(neuronId, cwd)
    r = new NeuronRetriever(path, neuronId)
    pool.set(neuronId, r)
  }
  return r
}

export function clearRetrieverCache(neuronId?: string): void {
  if (neuronId) pool.delete(neuronId)
  else pool.clear()
}

// ── 共享类型与辅助 ──

export interface CognitionConcept {
  name: string
  confidence: number
  description: string
  member_names: string[]
  cos: number
}

export interface CognitionNode {
  id: string
  query: string
  keywords: string[]
  true_count: number
  revelant_count: number
  true_memories: string[]
  revelant_memories: string[]
  hit_memories: number
  member_memories?: Array<{ memory_id: string; accuracy: string; time: string }>
}

export interface Cognition {
  concepts: CognitionConcept[]
  nodes: CognitionNode[]
  communities: unknown[]
}

interface GraphNode {
  id: string
  query?: string
  keywords?: string[]
  true_count?: number
  revelant_count?: number
  true_memories?: string[]
  revelant_memories?: string[]
}

function dot(matrix: Float32Array, offset: number, vec: number[]): number {
  let sum = 0
  for (let i = 0; i < vec.length; i++) sum += matrix[offset + i]! * vec[i]!
  return sum
}

/** memory_id 提取 ISO 时间戳：LJJ_MEM_20260101_120000 → 2026-01-01T12:00:00 */
export function extractTime(memoryId: string): string {
  const parts = memoryId.split('_')
  if (parts.length >= 3) {
    const dateStr = parts[parts.length - 2]!
    const timeStr = parts[parts.length - 1]!
    if (dateStr.length === 8 && /^\d+$/.test(dateStr) && timeStr.length === 6 && /^\d+$/.test(timeStr)) {
      return `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}T${timeStr.slice(0, 2)}:${timeStr.slice(2, 4)}:${timeStr.slice(4, 6)}`
    }
  }
  return ''
}

// ConfigError 类型仅用于 re-export 便利（工具层 catch 用）
export type { ConfigError }
