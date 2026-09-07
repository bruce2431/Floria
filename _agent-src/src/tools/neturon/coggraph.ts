/**
 * p5 build_cog_graph（批折叠）+ p6 detect_communities（Leiden 社群检测）
 *
 * 对照 Python 基线 engine/core/cognition.py 1:1 移植（2026-09-04 用户定案：
 * 「按照原神经元的逻辑实现就好了」）。p7（LLM 概念抽象）不移植。
 *
 * 全链：recall 落 pre 记录 → fill_precog 标注 → build_graph 折叠进认知图
 * （pre→consumed）→ detect_communities 多分辨率 Leiden → community.json（读侧反查）。
 * 2026-09-04 存储层 DB 化（SubPj7 定案同步）：mem/cog 读写走 mem.db/precog.db，
 * 认知图/社群仍为 JSON 快照（p5-p7 派生重建=整体替换）；含防假标注门禁
 * （pre 记录未标注完不许跑认知管线，SubPj7 2026-08-12 修复同步）。
 *
 * 与 Python 的既定差异：
 *   - 版本快照（_snapshot_version/lineage）不移植——TS 内置引擎全线无版本系统
 *   - Leiden 用本目录 leiden.ts（leidenalg 对照 ΔQ≈0，见 spike）。community.json 的
 *     modularity 复刻 Python partition.q 的实际语义 = igraph VertexClustering.q
 *     （无权 γ=1 标准模块度——leidenalg 分区类继承 igraph VertexClustering，q 属性
 *     不带权重，实证见 spike test-coggraph）；加权 Q 以 q_weighted 随工具返回
 *   - phase1 全量归并 n<2 时 Python 会把缺 cog_id 的裸节点传进 phase2（潜在
 *     KeyError），TS 统一转 cog1 形状规避
 *
 * 核心函数走显式 neuronPath（buildCogGraphInDir/detectCommunitiesInDir），
 * 注册名包装层再经 resolveNeuronPath——测试可在隔离目录跑，不污染真实库。
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cfgGet, cfgRequired, getGlobalRoot, resolveNeuronPath } from './config.js'
import { parse as parseYaml } from 'yaml'
import {
  deletePrecog,
  deriveEntryText,
  markPrecogConsumed,
  readMemories,
  readPrecogRecords,
  type MemEntry,
  type PrecogRecord,
} from './db.js'
import { hasChinese, segmentChinese } from './segment.js'
import { encode } from './embedder.js'
import { leidenCommunities, type LeidenEdgeInput } from './leiden.js'

// ───────────────────────── 类型 ─────────────────────────

interface PreNode {
  id: string
  query: string
  keywords: string[]
  true_set: Set<string>
  revelant_set: Set<string>
  sources: string[]
}

interface Cog1Node {
  cog_id: string
  type: string
  query: string
  keywords: string[]
  true_set: Set<string>
  revelant_set: Set<string>
  /** phase1 全量归并路径写入；fold 路径不写（对齐 Python：_phase2_associate 只读 merged_from） */
  merged_from?: string[]
  description: string
}

interface ExistingNode {
  id: string
  query: string
  keywords: string[]
  true_set: Set<string>
  revelant_set: Set<string>
}

export interface CogGraph {
  nodes: Array<{
    id: string
    query: string
    keywords: string[]
    true_count: number
    revelant_count: number
    true_memories: string[]
    revelant_memories: string[]
    merged_from: string[]
  }>
  edges: Array<{
    source: string
    target: string
    weight: number
    cq: number
    ck: number
    cb: number
    jt: number
    rv: number
  }>
  params: Record<string, number>
}

export interface CogGraphBuildResult {
  status: 'ok' | 'error'
  nodes?: number
  edges?: number
  consumed?: number
  ttl_removed?: number
  message: string
}

export interface DetectCommunitiesResult {
  status: 'ok' | 'error'
  resolutions?: Record<string, { n_communities: number; modularity: number; q_weighted?: number }>
  message: string
}

// ───────────────────────── 小工具（对照 cognition.py 模块级 helper） ─────────────────────────

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf-8')) as T
}

function readYaml(path: string): Record<string, unknown> {
  return (parseYaml(readFileSync(path, 'utf-8')) as Record<string, unknown>) ?? {}
}

function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`, 'utf-8')
  renameSync(tmp, path)
}

/** Python _tokenize：空格分段，中文段切词过滤停用词，非中文整段保留；去重保序 */
function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const part of text.split(/\s+/)) {
    if (!part) continue
    if (hasChinese(part)) tokens.push(...segmentChinese(part))
    else tokens.push(part)
  }
  const seen = new Set<string>()
  const result: string[] = []
  for (const t of tokens) {
    if (seen.has(t)) continue
    seen.add(t)
    result.push(t)
  }
  return result
}

function cosSim(a: number[], b: number[]): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!
  return dot
}

function jaccard(s1: Set<string>, s2: Set<string>): number {
  if (s1.size === 0 || s2.size === 0) return 0
  let inter = 0
  for (const x of s1) if (s2.has(x)) inter++
  const union = s1.size + s2.size - inter
  return union > 0 ? inter / union : 0
}

function overlapRatio(subset: Set<string>, superset: Set<string>): number {
  if (subset.size === 0 || superset.size === 0) return 0
  let inter = 0
  for (const x of subset) if (superset.has(x)) inter++
  return inter / subset.size
}

function round4(x: number): number {
  return Number(x.toFixed(4))
}

/** Python f"resolution_{res}"：YAML float 经 str() —— 整值浮点带 .0（1.0 → "resolution_1.0"） */
function resKey(res: number): string {
  return Number.isInteger(res) ? `${res}.0` : `${res}`
}

function nowStampCompact(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 从 record_id 提取时间戳（PCLJJ_2026-07-24-12:14:42 → Date；无则 null） */
function recordTime(recordId: string): Date | null {
  const m = /(\d{4})-(\d{2})-(\d{2})-(\d{2}):(\d{2}):(\d{2})/.exec(recordId ?? '')
  if (!m) return null
  return new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!)
}

interface CogOpts {
  cfg: Record<string, unknown>
  cfgContext: string
  cogPrefix: string
  modelCacheDir: string
}

function numOpt(opts: CogOpts, path: string): number {
  return Number(cfgRequired(opts.cfg, path, opts.cfgContext))
}

/** 节点三元组嵌入文本（对照 _emb：q_text 与 q_text+keywords 两路） */
function embedTextsOf(nd: { query: string; keywords: string[] }): [string, string] {
  const qt = tokenize(nd.query)
  const qText = qt.length ? qt.join(' ') : nd.query
  const kt = tokenize(nd.keywords.join(' '))
  return [qText, `${qText} ${kt.join(' ')}`]
}

// ───────────────────────── p5 阶段件 ─────────────────────────

/** 惰性 TTL 清理：删除超 precog.ttl_days 的 consumed 记录（pre 永不清） */
function ttlCleanup(
  records: PrecogRecord[],
  cfg: Record<string, unknown>,
): { kept: PrecogRecord[]; removed: number } {
  const ttlDays = Number(cfgGet(cfg, 'precog.ttl_days', 90))
  if (!ttlDays || ttlDays <= 0) return { kept: records, removed: 0 }
  const cutoff = Date.now() - ttlDays * 86_400_000
  const kept: PrecogRecord[] = []
  let removed = 0
  for (const r of records) {
    if (r.status === 'consumed') {
      const rt = recordTime(r.record_id ?? '')
      if (rt && rt.getTime() < cutoff) {
        removed++
        continue
      }
    }
    kept.push(r)
  }
  return { kept, removed }
}

/** 从 precog_records 构建节点（同 query 聚合 true/revelant set；id=首条 record_id） */
function buildNodes(records: PrecogRecord[]): PreNode[] {
  const groups = new Map<string, PreNode>()
  for (const r of records) {
    if (r.status !== 'pre') continue
    const q = r.query ?? ''
    const results = r.results ?? []
    let g = groups.get(q)
    if (!g) {
      g = {
        id: '',
        query: q,
        keywords: [...(r.keywords ?? [])],
        true_set: new Set(),
        revelant_set: new Set(),
        sources: [],
      }
      groups.set(q, g)
    }
    for (const r2 of results) {
      if (!r2.id) continue
      if (r2.accuracy === 'true') g.true_set.add(r2.id)
      else if (r2.accuracy === 'revelant') g.revelant_set.add(r2.id)
    }
    g.sources.push(r.record_id ?? '')
  }
  return [...groups.values()].map(g => ({ ...g, id: g.sources[0] ?? '' }))
}

function preToCog1(nd: PreNode, opts: CogOpts, seq: number): Cog1Node {
  return {
    cog_id: nd.id || `${opts.cogPrefix}${nowStampCompact()}_${String(seq).padStart(2, '0')}`,
    type: 'merge',
    query: nd.query,
    keywords: [...new Set(nd.keywords)].sort(),
    true_set: nd.true_set,
    revelant_set: nd.revelant_set,
    merged_from: nd.sources,
    description: '',
  }
}

/** Phase 1：按相似度连通分量归并节点为 cog1（sim = w_q·cos_q + w_k·cos_k + w_t·jac_t） */
async function phase1Merge(nodes: PreNode[], opts: CogOpts): Promise<Cog1Node[]> {
  const n = nodes.length
  if (n < 2) return nodes.map((nd, i) => preToCog1(nd, opts, i + 1))

  const wQuery = numOpt(opts, 'cog.w_query')
  const wKeywords = numOpt(opts, 'cog.w_keywords')
  const wTrue = numOpt(opts, 'cog.w_true')
  const mergeThreshold = numOpt(opts, 'cog.merge_threshold')

  const qTexts: string[] = []
  const kwTexts: string[] = []
  for (const nd of nodes) {
    const [q, kw] = embedTextsOf(nd)
    qTexts.push(q)
    kwTexts.push(kw)
  }
  const [queryEmbs, kwEmbs] = await Promise.all([
    encode(qTexts, opts.modelCacheDir),
    encode(kwTexts, opts.modelCacheDir),
  ])

  // 邻接（sim ≥ merge_threshold）+ 连通分量
  const adj: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n).fill(false))
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sim =
        wQuery * cosSim(queryEmbs[i]!, queryEmbs[j]!) +
        wKeywords * cosSim(kwEmbs[i]!, kwEmbs[j]!) +
        wTrue * jaccard(nodes[i]!.true_set, nodes[j]!.true_set)
      if (sim >= mergeThreshold) {
        adj[i]![j] = true
        adj[j]![i] = true
      }
    }
  }
  const visited = new Array<boolean>(n).fill(false)
  const components: number[][] = []
  for (let i = 0; i < n; i++) {
    if (visited[i]) continue
    const stack = [i]
    visited[i] = true
    const comp: number[] = []
    while (stack.length) {
      const v = stack.pop()!
      comp.push(v)
      for (let u = 0; u < n; u++) {
        if (adj[v]![u] && !visited[u]) {
          visited[u] = true
          stack.push(u)
        }
      }
    }
    components.push(comp)
  }

  const cog1List: Cog1Node[] = []
  const nowStr = nowStampCompact()
  let cog1Idx = 0
  for (const comp of components) {
    if (comp.length === 1) {
      const nd = nodes[comp[0]!]!
      if (nd.true_set.size === 0 && nd.revelant_set.size === 0) continue
      cog1Idx++
      cog1List.push({
        cog_id: `${opts.cogPrefix}${nowStr}_${String(cog1Idx).padStart(2, '0')}`,
        type: 'merge',
        query: nd.query,
        keywords: [...new Set(nd.keywords)].sort(),
        true_set: nd.true_set,
        revelant_set: nd.revelant_set,
        merged_from: nd.sources,
        description: '',
      })
    } else {
      const tSet = new Set<string>()
      const rSet = new Set<string>()
      const allSrc: string[] = []
      const allKw = new Set<string>()
      const queries: string[] = []
      for (const v of comp) {
        const nd = nodes[v]!
        for (const x of nd.true_set) tSet.add(x)
        for (const x of nd.revelant_set) rSet.add(x)
        allSrc.push(...nd.sources)
        for (const kw of nd.keywords) allKw.add(kw)
        queries.push(nd.query)
      }
      cog1Idx++
      cog1List.push({
        cog_id: `${opts.cogPrefix}${nowStr}_${String(cog1Idx).padStart(2, '0')}`,
        type: 'merge',
        query: queries.join(' + '),
        keywords: [...allKw].sort(),
        true_set: tSet,
        revelant_set: rSet,
        merged_from: allSrc,
        description: '',
      })
    }
  }
  return cog1List
}

/** 加载既有 cog_graph 节点（新 schema 直读 true/revelant_memories；旧节点经 precog 记录回溯） */
function loadExistingGraphNodes(
  graphPath: string,
  recById: Map<string, PrecogRecord>,
): ExistingNode[] {
  const data = readJson<{ nodes?: Array<Record<string, unknown>> }>(graphPath)
  if (!data) return []
  const nodes: ExistingNode[] = []
  for (const nd of data.nodes ?? []) {
    const nid = nd.id as string | undefined
    if (!nid) continue
    const tsRaw = nd.true_memories as string[] | undefined
    const rsRaw = nd.revelant_memories as string[] | undefined
    let ts: Set<string>
    let rs: Set<string>
    if (tsRaw === undefined || rsRaw === undefined) {
      ts = new Set()
      rs = new Set()
      for (const rid of (nd.merged_from as string[] | undefined) ?? []) {
        const rec = recById.get(rid)
        if (!rec) continue
        for (const r2 of rec.results ?? []) {
          if (!r2.id) continue
          if (r2.accuracy === 'true') ts.add(r2.id)
          else if (r2.accuracy === 'revelant') rs.add(r2.id)
        }
      }
    } else {
      ts = new Set(tsRaw)
      rs = new Set(rsRaw)
    }
    nodes.push({
      id: nid,
      query: (nd.query as string) ?? '',
      keywords: ((nd.keywords as string[]) ?? []).slice(),
      true_set: ts,
      revelant_set: rs,
    })
  }
  return nodes
}

/** 批折叠：新 pre 节点 → 折叠进既有节点（sim ≥ threshold）或新建（批内跑、有全局视野） */
async function foldIntoExisting(
  newNodes: PreNode[],
  existing: ExistingNode[],
  opts: CogOpts,
): Promise<Cog1Node[]> {
  if (!existing.length) return phase1Merge(newNodes, opts)

  const wQuery = numOpt(opts, 'cog.w_query')
  const wKeywords = numOpt(opts, 'cog.w_keywords')
  const wTrue = numOpt(opts, 'cog.w_true')
  const mergeThreshold = numOpt(opts, 'cog.merge_threshold')

  const pool: Cog1Node[] = existing.map(nd => ({
    cog_id: nd.id,
    type: 'merge',
    query: nd.query,
    keywords: nd.keywords.slice(),
    true_set: nd.true_set,
    revelant_set: nd.revelant_set,
    description: '',
  }))
  const poolTexts = pool.map(nd => embedTextsOf(nd))
  const [poolQ, poolKw] = await Promise.all([
    encode(poolTexts.map(t => t[0]), opts.modelCacheDir),
    encode(poolTexts.map(t => t[1]), opts.modelCacheDir),
  ])

  const newTexts = newNodes.map(nd => embedTextsOf(nd))
  const [newQ, newKw] = await Promise.all([
    encode(newTexts.map(t => t[0]), opts.modelCacheDir),
    encode(newTexts.map(t => t[1]), opts.modelCacheDir),
  ])

  const nowStr = nowStampCompact()
  let newIdx = 0
  for (let k = 0; k < newNodes.length; k++) {
    const nd = newNodes[k]!
    if (nd.true_set.size === 0 && nd.revelant_set.size === 0) continue
    let bestI = -1
    let bestSim = -1
    for (let i = 0; i < pool.length; i++) {
      const sim =
        wQuery * cosSim(newQ[k]!, poolQ[i]!) +
        wKeywords * cosSim(newKw[k]!, poolKw[i]!) +
        wTrue * jaccard(nd.true_set, pool[i]!.true_set)
      if (sim > bestSim) {
        bestSim = sim
        bestI = i
      }
    }
    if (bestI >= 0 && bestSim >= mergeThreshold) {
      // 折叠进既有节点：并集记忆/关键词/来源，保留原 id/query（不破坏颗粒度）
      const target = pool[bestI]!
      for (const x of nd.true_set) target.true_set.add(x)
      for (const x of nd.revelant_set) target.revelant_set.add(x)
      target.keywords = [...new Set([...target.keywords, ...nd.keywords])].sort()
    } else {
      newIdx++
      const node: Cog1Node = {
        cog_id: `${opts.cogPrefix}${nowStr}_${String(newIdx).padStart(2, '0')}`,
        type: 'merge',
        query: nd.query,
        keywords: [...new Set(nd.keywords)].sort(),
        true_set: nd.true_set,
        revelant_set: nd.revelant_set,
        description: '',
      }
      pool.push(node)
      poolQ.push(newQ[k]!)
      poolKw.push(newKw[k]!)
    }
  }
  return pool
}

function loadMemIndex(neuronPath: string): Map<string, MemEntry> {
  const dbPath = join(neuronPath, 'l2.mem', 'mem.db')
  const entries = readMemories(dbPath)
  if (!entries.length && !existsSync(dbPath)) {
    throw new Error(`mem.db 不存在（未迁移 DB 化）: ${dbPath}`)
  }
  const map = new Map<string, MemEntry>()
  for (const e of entries) {
    if (e.memory_id) map.set(e.memory_id, e)
  }
  return map
}

/** Phase 2：重算边构建加权关联图（含 no_jt/rv 惩罚），nodes 直链 + 边按权重降序 */
async function phase2Associate(
  cog1List: Cog1Node[],
  remainingNodes: ExistingNode[],
  opts: CogOpts,
  memIndex: Map<string, MemEntry>,
): Promise<CogGraph> {
  const wQuery = numOpt(opts, 'cog.w_query_assoc')
  const wKeywords = numOpt(opts, 'cog.w_keywords_assoc')
  const wBlocks = numOpt(opts, 'cog.w_blocks_assoc')
  const wTrue = numOpt(opts, 'cog.w_true_assoc')
  const wRevelant = numOpt(opts, 'cog.w_revelant')
  const noJtPenalty = numOpt(opts, 'edge_filter.no_jt_penalty')
  const rvPenaltyRatio = numOpt(opts, 'edge_filter.rv_penalty.ratio_threshold')
  const rvPenaltyWeight = numOpt(opts, 'edge_filter.rv_penalty.weight')

  const allNodes: Array<{
    id: string
    query: string
    keywords: string[]
    true_set: Set<string>
    revelant_set: Set<string>
    blocks_text: string
    true_count: number
    revelant_count: number
    merged_from: string[]
  }> = []
  for (const c of cog1List) {
    const blockTexts: string[] = []
    for (const t of [...c.true_set].sort()) {
      const s = memIndex.get(t) ? deriveEntryText(memIndex.get(t)!) : ''
      if (s) blockTexts.push(s)
    }
    allNodes.push({
      id: c.cog_id,
      query: c.query,
      keywords: c.keywords,
      true_set: c.true_set,
      revelant_set: c.revelant_set,
      blocks_text: blockTexts.length ? blockTexts.join('。') : c.query,
      true_count: c.true_set.size,
      revelant_count: c.revelant_set.size,
      merged_from: c.merged_from ?? [],
    })
  }
  for (const r of remainingNodes) {
    allNodes.push({
      id: r.id,
      query: r.query,
      keywords: r.keywords,
      true_set: r.true_set,
      revelant_set: r.revelant_set,
      blocks_text: r.query,
      true_count: r.true_set.size,
      revelant_count: r.revelant_set.size,
      merged_from: [],
    })
  }

  const m = allNodes.length
  if (m < 2) return { nodes: [], edges: [], params: {} }

  const qTexts: string[] = []
  const kwTexts: string[] = []
  const bTexts: string[] = []
  for (const nd of allNodes) {
    const qt = tokenize(nd.query)
    const qText = qt.length ? qt.join(' ') : nd.query
    const kt = tokenize(nd.keywords.join(' '))
    qTexts.push(qText)
    kwTexts.push(`${qText} ${kt.join(' ')}`)
    const bt = tokenize(nd.blocks_text)
    bTexts.push(bt.length ? bt.join(' ') : nd.blocks_text)
  }
  const [queryEmbs, kwEmbs, blocksEmbs] = await Promise.all([
    encode(qTexts, opts.modelCacheDir),
    encode(kwTexts, opts.modelCacheDir),
    encode(bTexts, opts.modelCacheDir),
  ])

  const edges: CogGraph['edges'] = []
  for (let i = 0; i < m; i++) {
    for (let j = i + 1; j < m; j++) {
      const cosQ = cosSim(queryEmbs[i]!, queryEmbs[j]!)
      const cosK = cosSim(kwEmbs[i]!, kwEmbs[j]!)
      const cosB = cosSim(blocksEmbs[i]!, blocksEmbs[j]!)
      const a = allNodes[i]!
      const b = allNodes[j]!
      const jacT = jaccard(a.true_set, b.true_set)

      const aUnion = new Set([...a.true_set, ...a.revelant_set])
      const bUnion = new Set([...b.true_set, ...b.revelant_set])
      const rvScore = Math.max(overlapRatio(a.revelant_set, bUnion), overlapRatio(b.revelant_set, aUnion))

      let weight = wQuery * cosQ + wKeywords * cosK + wBlocks * cosB + wTrue * jacT + wRevelant * rvScore

      if (jacT <= 0) weight *= noJtPenalty
      const rvRatio = rvScore / (jacT + rvScore + 1e-8)
      if (rvRatio > rvPenaltyRatio && weight > 0) weight *= rvPenaltyWeight

      edges.push({
        source: a.id,
        target: b.id,
        weight: round4(weight),
        cq: round4(cosQ),
        ck: round4(cosK),
        cb: round4(cosB),
        jt: round4(jacT),
        rv: round4(rvScore),
      })
    }
  }
  edges.sort((x, y) => y.weight - x.weight)

  const nodesOut = allNodes.map(nd => ({
    id: nd.id,
    query: nd.query,
    keywords: nd.keywords.slice(0, 8),
    true_count: nd.true_count,
    revelant_count: nd.revelant_count,
    true_memories: [...nd.true_set].sort(),
    revelant_memories: [...nd.revelant_set].sort(),
    merged_from: nd.merged_from,
  }))

  return {
    nodes: nodesOut,
    edges,
    params: { w_query: wQuery, w_keywords: wKeywords, w_blocks: wBlocks, w_true: wTrue, w_revelant: wRevelant },
  }
}

// ───────────────────────── p5 入口 ─────────────────────────

/** 防假标注门禁（SubPj7 2026-08-12 修复同步）：pre 记录 description 空或任一 results[].accuracy 空 → 违规清单 */
function incompletePreRecords(records: PrecogRecord[]): string[] {
  const violations: string[] = []
  for (const r of records) {
    if (r.status !== 'pre') continue
    if (!(r.description ?? '').trim()) {
      violations.push(`${r.record_id}: description 为空`)
      continue
    }
    for (const res of r.results ?? []) {
      if (!(res.accuracy ?? '').trim()) {
        violations.push(`${r.record_id}: results[${res.id ?? ''}].accuracy 为空`)
      }
    }
  }
  return violations
}

/** 批折叠构建认知图（显式目录版——测试隔离用） */
export async function buildCogGraphInDir(neuronPath: string): Promise<CogGraphBuildResult> {
  const cfgPath = join(neuronPath, 'config.yaml')
  const cfg = readYaml(cfgPath)
  const cfgContext = `config.yaml: ${cfgPath}`
  const precogDbPath = join(neuronPath, 'l1.cog', 'precog.db')
  const graphPath = join(neuronPath, 'l1.cog', 'cog_graph.json')

  const records = readPrecogRecords(precogDbPath)
  if (!records.length) return { status: 'error', message: 'precog.db 无记录' }

  // 防假标注门禁：pre 记录没标注完不许跑认知管线
  const violations = incompletePreRecords(records)
  if (violations.length) {
    return {
      status: 'error',
      message: `存在未标注完整的 pre 记录（先经 neuron_fill_precog 填写，防假标注门禁）：${violations.join('; ')}`,
    }
  }

  const { kept, removed: removedTtl } = ttlCleanup(records, cfg)
  const activeRecords = kept

  const personId = String(cfgRequired(cfg, 'person.id', cfgContext))
  const cogPrefix = `C${personId}`
  void cfgRequired(cfg, 'memory.model_name', cfgContext) // Python 侧显式传模型；TS embedder 单例固定 bge-small-zh
  const opts: CogOpts = {
    cfg,
    cfgContext,
    cogPrefix,
    modelCacheDir: join(getGlobalRoot(), 'cache', 'models'),
  }

  const recById = new Map(activeRecords.map(r => [r.record_id ?? '', r]))
  const existing = loadExistingGraphNodes(graphPath, recById)
  const preNodes = buildNodes(activeRecords)

  if (!preNodes.length && !existing.length) {
    return { status: 'error', message: '无 active precog 记录' }
  }

  // 批折叠：有既有图 → 折叠进既有节点或新建；无既有图 → 全量归并
  const cog1List = existing.length
    ? await foldIntoExisting(preNodes, existing, opts)
    : await phase1Merge(preNodes, opts)

  // 生命周期：TTL 过期 consumed 清除 + 本次聚合的 pre → consumed
  if (removedTtl > 0) {
    const ttlDays = Number(cfgGet(cfg, 'precog.ttl_days', 90))
    const cutoff = Date.now() - ttlDays * 86_400_000
    const expired = records.filter(r => {
      if (r.status !== 'consumed') return false
      const rt = recordTime(r.record_id ?? '')
      return rt !== null && rt.getTime() < cutoff
    })
    deletePrecog(precogDbPath, expired.map(r => r.record_id))
  }
  const preIds = activeRecords.filter(r => r.status === 'pre').map(r => r.record_id)
  markPrecogConsumed(precogDbPath, preIds)

  // Phase 2：重算边（含折叠后的节点全集）
  const memIndex = loadMemIndex(neuronPath)
  const graph = await phase2Associate(cog1List, [], opts, memIndex)

  writeJsonAtomic(graphPath, graph)

  return {
    status: 'ok',
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    consumed: preIds.length,
    ttl_removed: removedTtl,
    message: `cog_graph.json (${graph.nodes.length} nodes, ${graph.edges.length} edges)，consumed ${preIds.length} 条 pre 记录，TTL 清理 ${removedTtl}`,
  }
}

/** 批折叠构建认知图（注册名 → resolveNeuronPath） */
export async function buildCogGraph(neuronId: string, cwd?: string): Promise<CogGraphBuildResult> {
  let neuronPath: string
  try {
    neuronPath = resolveNeuronPath(neuronId, cwd)
  } catch (e) {
    return { status: 'error', message: (e as Error).message }
  }
  return buildCogGraphInDir(neuronPath)
}

// ───────────────────────── p6 — Leiden 社群检测 ─────────────────────────

interface MemberOut {
  id: string
  query: string
  core_score: number
  concept_core: number
  jt_edge_ratio: number
  role: 'core' | 'context'
}

/** 多分辨率 Leiden 社群检测（显式目录版）——重写 community.json（旧文件 .bak） */
export function detectCommunitiesInDir(neuronPath: string): DetectCommunitiesResult {
  const cfgPath = join(neuronPath, 'config.yaml')
  const cfg = readYaml(cfgPath)
  const cfgContext = `config.yaml: ${cfgPath}`
  const graphPath = join(neuronPath, 'l1.cog', 'cog_graph.json')
  const commPath = join(neuronPath, 'l1.cog', 'community.json')

  const graphData = readJson<{ nodes?: Array<Record<string, unknown>>; edges?: Array<Record<string, unknown>> }>(graphPath)
  if (!graphData) return { status: 'error', message: 'cog_graph.json 不存在，请先运行 build_graph' }

  const resolutions = cfgRequired(cfg, 'community.resolutions', cfgContext) as number[]
  const coreScoreMin = Number(cfgRequired(cfg, 'community.core_score_min', cfgContext))
  const conceptCoreMax = Number(cfgRequired(cfg, 'community.concept_core_max', cfgContext))
  // 只把 size ≥ min_group_size 的社群写入 community.json（单节点不写群，检索仍可经节点/记忆层命中）
  const minGroupSize = Number(cfgGet(cfg, 'community.min_group_size', 2))

  const nodesList = graphData.nodes ?? []
  const edgesList = graphData.edges ?? []
  const n = nodesList.length
  const idToIdx = new Map<string, number>()
  nodesList.forEach((nd, i) => idToIdx.set(nd.id as string, i))
  const nodeQuery = nodesList.map(nd => (nd.query as string) ?? '')

  // 邻接（含 jt）供 core_score 计算
  const idToEdges = new Map<string, Array<{ other: string; w: number; jt: number }>>()
  const leidenEdges: LeidenEdgeInput[] = []
  for (const e of edgesList) {
    const w = Number(e.weight ?? 0)
    if (!(w > 0)) continue
    const s = e.source as string
    const t = e.target as string
    const si = idToIdx.get(s)
    const ti = idToIdx.get(t)
    if (si === undefined || ti === undefined) continue
    const jt = Number(e.jt ?? 0)
    leidenEdges.push({ source: si, target: ti, weight: w })
    if (!idToEdges.has(s)) idToEdges.set(s, [])
    if (!idToEdges.has(t)) idToEdges.set(t, [])
    idToEdges.get(s)!.push({ other: t, w, jt })
    idToEdges.get(t)!.push({ other: s, w, jt })
  }

  const { partitions } = leidenCommunities(n, leidenEdges, { resolutions })

  // igraph VertexClustering.q 语义（Python partition.q 实际落点）：无权 γ=1 标准模块度
  const degreeU: number[] = nodesList.map(nd => idToEdges.get(nd.id as string)?.length ?? 0)
  const mU = degreeU.reduce((s, d) => s + d, 0) // Σ无权度 = 2×边数

  const allResults: Record<string, unknown> = {}
  const weightedQ: Record<string, number> = {}
  for (const part of partitions) {
    const membership = part.membership
    // 社群分组（按成员节点序，对应 Python 遍历序）
    const commOrder: number[] = []
    const commMembers = new Map<number, number[]>()
    for (let i = 0; i < n; i++) {
      const c = membership[i]!
      let arr = commMembers.get(c)
      if (!arr) {
        arr = []
        commMembers.set(c, arr)
        commOrder.push(c)
      }
      arr.push(i)
    }

    // modularity（igraph q 语义）：Σ_c [L_c/m_u − (d_c/m_u)²]，L_c 计内部边数
    // （逐端点累计 = 每条内部边计 2 次 = 2L_c），m_u = 2×边数
    let qUnweighted = 0
    if (mU > 0) {
      for (const c of commOrder) {
        const memberIdxU = commMembers.get(c)!
        const memberIdsU = new Set(memberIdxU.map(i => nodesList[i]!.id as string))
        let lc = 0
        let dc = 0
        for (const i of memberIdxU) {
          dc += degreeU[i]!
          for (const d of idToEdges.get(nodesList[i]!.id as string) ?? []) {
            if (memberIdsU.has(d.other)) lc++
          }
        }
        qUnweighted += lc / mU - (dc / mU) * (dc / mU)
      }
    }

    const communities = commOrder.map(c => {
      const memberIdx = commMembers.get(c)!
      const memberIds = new Set(memberIdx.map(i => nodesList[i]!.id as string))
      const members: MemberOut[] = []
      for (const i of memberIdx) {
        const nid = nodesList[i]!.id as string
        const edgesData = idToEdges.get(nid) ?? []
        let total = 0
        let internal = 0
        let internalJt = 0
        let internalJtOnly = 0
        for (const d of edgesData) {
          total += d.w
          if (memberIds.has(d.other)) {
            internal += d.w
            internalJt += d.w * d.jt
            if (d.jt > 0) internalJtOnly += d.w
          }
        }
        const coreScore = total > 0 ? round4(internal / total) : 0
        const conceptCore = total > 0 ? round4(internalJt / total) : 0
        const jtEdgeRatio = internal > 0 ? round4(internalJtOnly / internal) : 0
        members.push({
          id: nid,
          query: nodeQuery[i]!,
          core_score: coreScore,
          concept_core: conceptCore,
          jt_edge_ratio: jtEdgeRatio,
          role:
            coreScore >= coreScoreMin && conceptCore < conceptCoreMax && jtEdgeRatio < 0.2
              ? 'context'
              : 'core',
        })
      }
      // density：社群内边数 / 最大可能边数（无权计数）
      let size = memberIdx.length
      let density = 0
      if (size > 1) {
        let internalEdges = 0
        for (const e of leidenEdges) {
          if (membership[e.source] === c && membership[e.target] === c) internalEdges++
        }
        const maxEdges = (size * (size - 1)) / 2
        density = maxEdges > 0 ? round4(internalEdges / maxEdges) : 0
      }
      return { members, size, density }
    })

    const commList = communities.slice().sort((x, y) => y.size - x.size)
    const filtered = minGroupSize > 1 ? commList.filter(c => c.size >= minGroupSize) : commList

    allResults[`resolution_${resKey(part.resolution)}`] = {
      resolution: part.resolution,
      n_communities: filtered.length,
      modularity: round4(qUnweighted),
      community_sizes: filtered.map(c => c.size),
      communities: filtered.map(c => ({
        members: c.members,
        size: c.size,
        density: c.density,
      })),
    }
    weightedQ[`resolution_${resKey(part.resolution)}`] = round4(part.modularity)
  }

  // 备份旧文件
  if (existsSync(commPath)) copyFileSync(commPath, `${commPath}.bak`)
  writeJsonAtomic(commPath, allResults)

  const summary: Record<string, { n_communities: number; modularity: number; q_weighted: number }> = {}
  for (const [key, v] of Object.entries(allResults as Record<string, { n_communities: number; modularity: number }>)) {
    summary[key] = { n_communities: v.n_communities, modularity: v.modularity, q_weighted: weightedQ[key]! }
  }
  return {
    status: 'ok',
    resolutions: summary,
    message: `community.json (${resolutions.length} resolutions)`,
  }
}

/** 多分辨率 Leiden 社群检测（注册名 → resolveNeuronPath） */
export function detectCommunities(neuronId: string, cwd?: string): DetectCommunitiesResult {
  let neuronPath: string
  try {
    neuronPath = resolveNeuronPath(neuronId, cwd)
  } catch (e) {
    return { status: 'error', message: (e as Error).message }
  }
  return detectCommunitiesInDir(neuronPath)
}
