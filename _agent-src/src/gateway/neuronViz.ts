/**
 * 神经元可视化数据源（web「神经」tab 专用，GET /gateway/neurons[/graph]；只读）
 *
 * 复用 neturon 既有读取层，不另造：库发现/统计 = tools/neturon/config.ts（listNeuronsInRoots
 * 多根扫描，roots 由网关组装：cwd 根 → 各项目根 → 全局根，同 id keep-first）；
 * mem 行 = db.ts readMemories；认知图/社群 = l1.cog/cog_graph.json + community.json 快照
 * （由 NEURON_RAG 侧 build_graph / detect_communities 产出，本模块只读不写、不触发管线）。
 *
 * 图数据包三级结构（web 侧 Canvas 力导向直接消费）：
 *   communities[]  社群节点（community.json 指定分辨率一档；cog 成员 + 汇总统计）
 *   cogs[]         认知节点（cog_graph.json nodes；true_memories/revelant_memories = mem 连边依据）
 *   mems[]         记忆节点（mem.db memories；preview/chars 供浮窗与尺寸计算）
 * mem↔cog 连边由前端从 cogs[].mem_ids/rel_ids 派生（同一 mem 可挂多 cog，边随事实走）；
 * cog↔社群连边由 cogs[].community 派生（-1 = 未入群，min_group_size 过滤产物，照实呈现）。
 * 认知层可缺省：cog_graph.json / community.json 由认知管线产出，未跑过的库只有记忆层——
 * 此时按空认知层出图（cognition.graph/communities = false，前端据此提示），不是错误。
 *
 * 不做 NEURON_RAG 门控：本模块只读盘上 JSON/sqlite，不引入 embedder/transformers；
 * 库文件独立于该编译期 flag 存在，默认构建即可出图。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { listNeuronsInRoots, resolveNeuronPathInRoots } from '../tools/neturon/config.js'
import { deriveEntryText, idTime, readMemories } from '../tools/neturon/db.js'

// ── 神经元清单（层级 1：tab 选项界面） ──

export interface NeuronCard {
  id: string
  name: string
  type: string
  description: string
  mem_count: number
  cog_count: number
  community_count: number
  last_updated: string
}

/** 图/社群快照统计（缺文件 = 0，不报错——库允许尚未跑认知管线） */
function graphStats(neuronPath: string): { cog_count: number; community_count: number } {
  const out = { cog_count: 0, community_count: 0 }
  const graphPath = join(neuronPath, 'l1.cog', 'cog_graph.json')
  if (existsSync(graphPath)) {
    try {
      const g = JSON.parse(readFileSync(graphPath, 'utf-8')) as { nodes?: unknown[] }
      out.cog_count = Array.isArray(g.nodes) ? g.nodes.length : 0
    } catch { /* 快照损坏按 0 呈现，图接口再暴露具体错误 */ }
  }
  const commPath = join(neuronPath, 'l1.cog', 'community.json')
  if (existsSync(commPath)) {
    try {
      const c = JSON.parse(readFileSync(commPath, 'utf-8')) as Record<string, { n_communities?: number }>
      const key = pickCommKey(Object.keys(c), readCog2(neuronPath))
      out.community_count = Number(c[key]?.n_communities ?? 0)
    } catch { /* 同上 */ }
  }
  return out
}

export function listNeuronsForGateway(roots: string[]): { neurons: NeuronCard[] } {
  const neurons = listNeuronsInRoots(roots).map((n) => {
    const stats = graphStats(n.path)
    const card: NeuronCard = {
      id: n.id,
      name: n.name,
      type: n.type,
      description: n.description,
      mem_count: n.mem_count,
      cog_count: stats.cog_count,
      community_count: stats.community_count,
      last_updated: n.last_updated,
    }
    return card
  })
  return { neurons }
}

// ── 图数据包（层级 2：单个神经元的三级节点图） ──

export interface NeuronGraphPayload {
  neuron: { id: string; name: string; description: string }
  resolution: string
  resolutions: string[]
  communities: Array<{
    i: number
    size: number
    density: number
    cog_ids: string[]
    mem_count: number
    chars: number
    members: Array<{ id: string; query: string; role: string; core_score: number }>
    name?: string
    description?: string
    confidence?: number
  }>
  cogs: Array<{
    id: string
    query: string
    keywords: string[]
    mem_ids: string[]
    rel_ids: string[]
    community: number
    chars: number
  }>
  mems: Array<{ id: string; chars: number; source: string | null; time: string | null; preview: string }>
  /** 认知层就绪度：库可以只有记忆层（LOG 迁入后未跑认知管线）——照实上报，供前端提示 */
  cognition: { graph: boolean; communities: boolean }
}

/** community.json 键形如 resolution_1.0；兜底取 1.0 档，无则首键（键序 0.5/0.8/1.0/… 字典序） */
function pickResolution(keys: string[]): string {
  if (!keys.length) return 'resolution_1.0'
  return keys.includes('resolution_1.0') ? 'resolution_1.0' : keys.slice().sort()[0]!
}

/** cog2.json 社群命名快照形状（name_communities 产物；缺文件/损坏 = 无命名，照实呈现） */
interface Cog2Snapshot {
  resolution: number
  records: Array<{ name?: unknown; description?: unknown; confidence?: unknown; members?: unknown }>
}

function readCog2(neuronPath: string): Cog2Snapshot | null {
  const p = join(neuronPath, 'l1.cog', 'cog2.json')
  if (!existsSync(p)) return null
  try {
    const d = JSON.parse(readFileSync(p, 'utf-8')) as { resolution?: unknown; cog2_records?: unknown }
    if (typeof d.resolution !== 'number' || !Array.isArray(d.cog2_records)) return null
    return { resolution: d.resolution, records: d.cog2_records as Cog2Snapshot['records'] }
  } catch {
    return null
  }
}

/** 默认档 = cog2 命名档（认知管线 abstraction.default_resolution 的落盘痕迹）优先，兜底 resolution_1.0 */
function pickCommKey(keys: string[], cog2: Cog2Snapshot | null): string {
  if (cog2) {
    const k = `resolution_${cog2.resolution}`
    if (keys.includes(k)) return k
  }
  return pickResolution(keys)
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf-8')) as T
}

function previewOf(blocks: string[]): string {
  const first = blocks.map(String).find((b) => b.trim()) ?? ''
  const t = first.trim()
  return t.length > 80 ? t.slice(0, 80) + '…' : t
}

/** 显式目录版（测试隔离 + 网关路由共用；分辨率参数非法直接抛错，由 sendError 暴露） */
export function buildNeuronGraphInDir(neuronPath: string, resKey?: string): NeuronGraphPayload {
  const graphPath = join(neuronPath, 'l1.cog', 'cog_graph.json')
  const commPath = join(neuronPath, 'l1.cog', 'community.json')
  const graph = readJson<{
    nodes?: Array<{ id?: unknown; query?: unknown; keywords?: unknown; true_memories?: unknown; revelant_memories?: unknown }>
  }>(graphPath)
  const commAll = readJson<Record<string, {
    communities?: Array<{
      size?: unknown
      density?: unknown
      members?: Array<{ id?: unknown; query?: unknown; role?: unknown; core_score?: unknown }>
    }>
  }>>(commPath)

  // 认知层可缺省（照实呈现，不报错）：库迁移/新建后只有记忆层，cog_graph.json 与
  // community.json 均须由认知管线（recall → fill_precog → build_graph → detect_communities）
  // 产出，未跑过即无——此时出图 = 纯记忆层。仅「community.json 存在但显式指定档不存在」
  // 才是真实参数错误，仍然抛错。
  const keys = commAll ? Object.keys(commAll) : []
  const cog2 = readCog2(neuronPath)
  const wantKey = keys.length ? (resKey ? `resolution_${resKey}` : pickCommKey(keys, cog2)) : ''
  if (wantKey && !keys.includes(wantKey)) {
    throw new Error(`分辨率 ${wantKey} 不存在，可用：${keys.join(', ')}`)
  }
  const resolution = wantKey ? wantKey.slice('resolution_'.length) : ''

  const mems = readMemories(join(neuronPath, 'l2.mem', 'mem.db'))
  const memById = new Map(mems.map((m) => [m.memory_id, m]))
  const memChars = new Map<string, number>()
  for (const m of mems) memChars.set(m.memory_id, deriveEntryText(m).length)

  // cog 节点（true/revelant 分列，供前端区分连边语义）
  const cogs = (graph?.nodes ?? [])
    .filter((nd) => typeof nd.id === 'string')
    .map((nd) => {
      const memIds = [...new Set(((nd.true_memories as string[]) ?? []).filter((x) => memById.has(x)))]
      const relIds = [...new Set(((nd.revelant_memories as string[]) ?? []).filter((x) => memById.has(x) && !memIds.includes(x)))]
      let chars = 0
      for (const id of [...memIds, ...relIds]) chars += memChars.get(id) ?? 0
      return {
        id: nd.id as string,
        query: String(nd.query ?? ''),
        keywords: ((nd.keywords as string[]) ?? []).map(String),
        mem_ids: memIds,
        rel_ids: relIds,
        community: -1,
        chars,
      }
    })
  const cogById = new Map(cogs.map((c) => [c.id, c]))

  // 社群命名（cog2.json 记录的 members 集合 = 命名档社群成员原样；按成员集合精确挂载，
  // 其余档/无命名的群照实无 name）
  const nameByMembers = new Map<string, { name: string; description: string; confidence: number }>()
  for (const r of cog2?.records ?? []) {
    if (typeof r.name !== 'string' || !r.name.trim()) continue
    const ms = Array.isArray(r.members) ? r.members.filter((x): x is string => typeof x === 'string') : []
    nameByMembers.set([...new Set(ms)].sort().join('\u0000'), {
      name: r.name,
      description: typeof r.description === 'string' ? r.description : '',
      confidence: typeof r.confidence === 'number' ? r.confidence : 0,
    })
  }

  // 社群（community.json 成员 = cog id；逐群回填 cogs[].community）
  const communities = (wantKey ? commAll![wantKey]?.communities ?? [] : []).map((c, i) => {
    const memberList = (c.members ?? [])
      .filter((m) => typeof m.id === 'string' && cogById.has(m.id as string))
      .map((m) => ({
        id: m.id as string,
        query: String(m.query ?? ''),
        role: String(m.role ?? 'core'),
        core_score: Number(m.core_score ?? 0),
      }))
    const cogIds = memberList.map((m) => m.id)
    for (const cid of cogIds) cogById.get(cid)!.community = i
    const memSet = new Set<string>()
    let chars = 0
    for (const cid of cogIds) {
      const cg = cogById.get(cid)!
      for (const mid of [...cg.mem_ids, ...cg.rel_ids]) {
        if (!memSet.has(mid)) {
          memSet.add(mid)
          chars += memChars.get(mid) ?? 0
        }
      }
    }
    const named = nameByMembers.get([...new Set(cogIds)].sort().join('\u0000'))
    return {
      i,
      size: cogIds.length,
      density: Number(c.density ?? 0),
      cog_ids: cogIds,
      mem_count: memSet.size,
      chars,
      members: memberList,
      ...(named ? { name: named.name, description: named.description, confidence: named.confidence } : {}),
    }
  })

  return {
    neuron: neuronMeta(neuronPath),
    resolution,
    resolutions: keys.map((k) => k.slice('resolution_'.length)),
    communities,
    cogs,
    mems: mems.map((m) => ({
      id: m.memory_id,
      chars: memChars.get(m.memory_id) ?? 0,
      source: m.source,
      time: idTime(m.memory_id),
      preview: previewOf(m.blocks),
    })),
    cognition: { graph: graph !== null, communities: keys.length > 0 },
  }
}

/** 神经元元信息（id/name/description）：经 resolveNeuronPath 反查注册表，少读一次 config */
function neuronMeta(neuronPath: string): { id: string; name: string; description: string } {
  const cfg = parseYaml(readFileSync(join(neuronPath, 'config.yaml'), 'utf-8')) as Record<string, unknown> ?? {}
  const person = (cfg.person as Record<string, unknown> | undefined) ?? {}
  const prompts = (cfg.prompts as Record<string, unknown> | undefined) ?? {}
  return {
    id: String(person.id ?? ''),
    name: String(cfg.name ?? ''),
    description: String(prompts.should_search ?? ''),
  }
}

/** 注册名版：resolveNeuronPathInRoots 未命中时抛错（消息含可用 id 清单，sendError 直达前端） */
export function buildNeuronGraph(neuronId: string, roots: string[], resKey?: string): NeuronGraphPayload {
  return buildNeuronGraphInDir(resolveNeuronPathInRoots(neuronId, roots), resKey)
}
