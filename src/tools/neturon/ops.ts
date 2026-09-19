import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { listNeurons, listNeuronsInRoot, getBuiltinRoots, listPendingMigration } from './config.js'
import { getRetriever } from './retriever.js'
import { fillPrecog, listUnfilled } from './precog.js'
import { buildCogGraph, detectCommunities } from './coggraph.js'
import { USAGE_HINT_SOURCE } from './usageHint.js'

// ── neuron_list — 名册外的主动发现（root 参数扫任意目录） ──

const listInput = lazySchema(() =>
  z.strictObject({
    root: z
      .string()
      .optional()
      .describe('神经元根目录（含 neurons/ 子目录）。缺省=引擎已挂双根（cwd 根 + 全局根）'),
  }),
)
type ListInput = ReturnType<typeof listInput>

export const NeuronListTool = buildTool({
  name: 'neuron_list',
  searchHint: 'discover neurons roots registry list',
  async description() {
    return '列出已发现的神经元（可带 root 扫任意目录）'
  },
  async prompt() {
    return `Discover memory neurons. Without arguments: lists neurons in the engine's mounted roots (project + global). With root: scans <root>/neurons/ for new libraries anywhere on disk (each subdirectory containing config.yaml + l2.mem/mem.db registers as a neuron). Use when the roster mentions unscanned locations or before recalling another project's neurons.`
  },
  get inputSchema(): ListInput {
    return listInput()
  },
  get outputSchema() {
    return lazySchema(() => z.looseObject({}))()
  },
  userFacingName() {
    return 'neuron_list'
  },
  shouldDefer: true,
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.root ?? '(双根)'
  },
  async checkPermissions(input: ListInput) {
    return { behavior: 'allow' as const, updatedInput: input }
  },
  async call(input: ListInput) {
    const neurons = input.root ? listNeuronsInRoot(input.root) : listNeurons()
    const pending = input.root ? [] : listPendingMigration()
    return {
      data: {
        roots: getBuiltinRoots(),
        neurons: neurons.map(n => ({
          id: n.id,
          name: n.name,
          type: n.type,
          skills: n.skills,
          description: n.description,
          path: n.path,
          mem_count: n.mem_count,
          cog2_count: n.cog2_count,
          last_updated: n.last_updated,
        })),
        pending_migration: pending.length
          ? pending.map(p => ({
              id: p.id,
              path: p.path,
              note: '仍为 mem.json 旧存储（未迁移 mem.db），recall/remember 不可用',
            }))
          : undefined,
        usage: input.root
          ? '扫描结果即注册：这些 id 可直接用于 recall/remember（本会话内有效）。'
          : undefined,
      },
    }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return { tool_use_id: toolUseID, type: 'tool_result' as const, content: jsonStringify(content) }
  },
  renderToolUseMessage(input) {
    return input.root ?? '双根'
  },
} satisfies ToolDef<ListInput, unknown>)

// ── neuron_source — 单条记忆全量内容（含废弃条目溯源） ──

const sourceInput = lazySchema(() =>
  z.strictObject({
    neuron: z.string().describe('Neuron id'),
    memory_id: z.string().describe('记忆条目 id（recall 结果里的 memory_id）'),
  }),
)
type SourceInput = ReturnType<typeof sourceInput>

export const NeuronSourceTool = buildTool({
  name: 'neuron_source',
  searchHint: 'memory entry full content core file script',
  async description() {
    return '取回单条记忆的完整内容（含 core_file 产物）'
  },
  async prompt() {
    return `Fetch the FULL content of one memory entry by id (recall results only show summaries). Use before relying on a hit — confirm the actual outcome. Returns the semantic blocks verbatim plus core_file (reusable scripts/configs — read the referenced path or take content directly instead of reinventing). Also works on deprecated entries for provenance (shows deprecated_by / supersedes links).`
  },
  get inputSchema(): SourceInput {
    return sourceInput()
  },
  get outputSchema() {
    return lazySchema(() => z.looseObject({}))()
  },
  userFacingName() {
    return 'neuron_source'
  },
  shouldDefer: true,
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return `${input.neuron}: ${input.memory_id}`
  },
  async checkPermissions(input: SourceInput) {
    return { behavior: 'allow' as const, updatedInput: input }
  },
  async call(input: SourceInput) {
    const retriever = getRetriever(input.neuron)
    const entry = retriever.getSource(input.memory_id)
    if (!entry) {
      return { data: { error: `memory_id '${input.memory_id}' 未找到` } }
    }
    return { data: { memory_id: input.memory_id, entry, usage: USAGE_HINT_SOURCE } }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return { tool_use_id: toolUseID, type: 'tool_result' as const, content: jsonStringify(content) }
  },
  renderToolUseMessage(input) {
    return `${input.neuron}: ${input.memory_id ?? ''}`
  },
} satisfies ToolDef<SourceInput, unknown>)

// ── neuron_fill_precog — precog 标注（拟合环）+ 未标注审计 ──

const fillInput = lazySchema(() =>
  z.strictObject({
    action: z.enum(['fill', 'list_unfilled']).describe('fill=标注一条 precog；list_unfilled=列出未标注记录'),
    neuron: z.string().describe('Neuron id'),
    record_id: z
      .string()
      .optional()
      .describe('fill 必填：本次检索返回的 precog.record_id'),
    description: z
      .string()
      .optional()
      .describe('fill 必填：≥60 字分析（查询意图 + 检索命中情况）'),
    accuracy_list: z
      .array(z.enum(['true', 'revelant', 'false']))
      .optional()
      .describe('fill 必填：逐条对应 precog.results 的判定，长度必须一致'),
  }),
)
type FillInput = ReturnType<typeof fillInput>

export const NeuronFillPrecogTool = buildTool({
  name: 'neuron_fill_precog',
  searchHint: 'annotate precog accuracy feedback cognition',
  async description() {
    return '标注 precog 检索记录（拟合环）/列出未标注记录'
  },
  async prompt() {
    return `Annotate a precog search record (feedback loop feeding cognition aggregation). Right after a recall: describe what the query intended and how well each result answered it (accuracy_list aligned with precog.results: true=re directly answered, revelant=related, false=noise). Or action=list_unfilled to audit pending annotations for a neuron. Annotated records aggregate into cognition nodes/communities that future recalls route through.`
  },
  get inputSchema(): FillInput {
    return fillInput()
  },
  get outputSchema() {
    return lazySchema(() => z.looseObject({}))()
  },
  userFacingName() {
    return 'neuron_fill_precog'
  },
  shouldDefer: true,
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  toAutoClassifierInput(input) {
    return `${input.action} → ${input.neuron}${input.record_id ? `: ${input.record_id}` : ''}`
  },
  async checkPermissions(input: FillInput) {
    return { behavior: 'allow' as const, updatedInput: input }
  },
  async call(input: FillInput) {
    if (input.action === 'list_unfilled') {
      return { data: { unfilled: listUnfilled(input.neuron) } }
    }
    if (!input.record_id || !input.description || !input.accuracy_list) {
      return {
        data: {
          status: 'error' as const,
          message: 'action=fill 需要 record_id + description（≥60字）+ accuracy_list（与结果数一致）',
        },
      }
    }
    const result = fillPrecog(input.neuron, input.record_id, input.description, input.accuracy_list)
    return { data: result }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return { tool_use_id: toolUseID, type: 'tool_result' as const, content: jsonStringify(content) }
  },
  renderToolUseMessage(input) {
    return `${input.action ?? ''} → ${input.neuron ?? ''}`
  },
} satisfies ToolDef<FillInput, unknown>)

// ── neuron_cog — 认知图维护（p5 批折叠建图 + p6 Leiden 社群检测） ──

const cogInput = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['build_graph', 'detect_communities'])
      .describe('build_graph=折叠 precog 记录建认知图；detect_communities=多分辨率 Leiden 社群检测'),
    neuron: z.string().describe('Neuron id'),
  }),
)
type CogInput = ReturnType<typeof cogInput>

export const NeuronCogTool = buildTool({
  name: 'neuron_cog',
  searchHint: 'cognition graph build fold communities leiden detect',
  async description() {
    return '认知图维护：折叠 precog 记录建图 / Leiden 社群检测'
  },
  async prompt() {
    return `Maintain a neuron's cognition graph. action=build_graph: fold annotated precog records into l1.cog/cog_graph.json (TTL cleanup of consumed records, batch fold/merge by similarity, phase-2 edge recompute) and mark records consumed — run after neuron_fill_precog. action=detect_communities: multi-resolution Leiden over the current graph, rewrites l1.cog/community.json (core/context roles used at recall time) — run after build_graph. Chain: recall → fill_precog → build_graph → detect_communities.`
  },
  get inputSchema(): CogInput {
    return cogInput()
  },
  get outputSchema() {
    return lazySchema(() => z.looseObject({}))()
  },
  userFacingName() {
    return 'neuron_cog'
  },
  shouldDefer: true,
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  toAutoClassifierInput(input) {
    return `${input.action} → ${input.neuron}`
  },
  async checkPermissions(input: CogInput) {
    return { behavior: 'allow' as const, updatedInput: input }
  },
  async call(input: CogInput) {
    if (input.action === 'build_graph') {
      return { data: await buildCogGraph(input.neuron) }
    }
    return { data: detectCommunities(input.neuron) }
  },
  mapToolResultToToolResultBlockParam(content, toolUseID) {
    return { tool_use_id: toolUseID, type: 'tool_result' as const, content: jsonStringify(content) }
  },
  renderToolUseMessage(input) {
    return `${input.action} → ${input.neuron}`
  },
} satisfies ToolDef<CogInput, unknown>)
