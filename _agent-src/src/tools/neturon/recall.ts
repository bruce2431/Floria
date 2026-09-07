import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { listNeurons } from './config.js'
import { getRetriever, type Cognition, type PrecogRecord } from './retriever.js'
import { matchFollowup } from './segment.js'
import {
  USAGE_HINT_COGNITION_COLD,
  USAGE_HINT_PRECOG_ANNOTATE,
  USAGE_HINT_SEARCH,
} from './usageHint.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    query: z
      .string()
      .describe(
        '检索语句：用自然句（做了什么/怎么做的），BGE 对自然语句友好；含 URL/关键 ID 时直接拼入',
      ),
    neuron: z
      .string()
      .optional()
      .describe('Neuron id（见系统提示名册；仅一个库可省略；其它项目位置先经 neuron_list 发现）'),
    mode: z
      .enum(['mem', 'cog'])
      .optional()
      .describe('mem=记忆检索（默认，写 precog）；cog=认知层全查（概念+社群+节点+记忆，不写 precog）'),
    top_k: z.number().int().optional().describe('返回条数（默认取库配置）'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

interface RecallOutput {
  query: string
  neuron: string
  skipped?: boolean
  gate?: string
  reason?: string
  note?: string
  results?: Array<Record<string, unknown>>
  precog?: Pick<PrecogRecord, 'record_id' | 'results'> | null
  cognition?: Cognition
  usage?: string
  precog_annotate?: string
  cognition_note?: string
}

const outputSchema = lazySchema(() => z.looseObject({}))
type OutputSchema = ReturnType<typeof outputSchema>

export type Input = z.infer<InputSchema>
export type Output = RecallOutput

export const RecallTool = buildTool({
  name: 'recall',
  searchHint: 'search neuron memory knowledge base retrieval',
  maxResultSizeChars: 200_000,
  async description() {
    return '检索神经元的长期经验/知识库'
  },
  async prompt() {
    return `Retrieve long-term experience and knowledge from persistent memory neurons (vector + keyword search over accumulated task records). Use BEFORE attempting multi-step or unfamiliar work — a past session likely already solved it, including working scripts (men.core_file), pitfalls and verified methods. Also use to recall facts about people, projects and environments. Results include a precog record — annotate it afterwards via neuron_fill_precog.`
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'recall'
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.neuron ? `${input.neuron}: ${input.query}` : input.query
  },
  async checkPermissions(input: Input) {
    return { behavior: 'allow' as const, updatedInput: input }
  },
  async call(input: Input): Promise<{ data: Output }> {
    const neurons = listNeurons()
    let neuronId = input.neuron
    if (!neuronId) {
      if (neurons.length === 1) {
        neuronId = neurons[0]!.id
      } else if (neurons.length === 0) {
        return {
          data: {
            query: input.query,
            neuron: '',
            skipped: true,
            reason: '当前未发现任何神经元',
            note: '用 neuron_list(root=目录) 主动发现，或确认系统提示名册',
          },
        }
      } else {
        return {
          data: {
            query: input.query,
            neuron: '',
            skipped: true,
            reason: '存在多个神经元，需指定 neuron 参数',
            note: `可用: ${neurons.map(n => `${n.id}(${n.name})`).join(', ')}`,
          },
        }
      }
    }

    // 引擎门槛：仅拦后续追问型（代词/极短）查询——这类检索必差；其余放行
    const followup = matchFollowup(input.query)
    if (followup) {
      return {
        data: {
          query: input.query,
          neuron: neuronId,
          skipped: true,
          gate: 'followup',
          reason: followup.reason,
          note: '引擎门槛拦截，未执行检索。请换完整说法（含主语/对象）再 recall。',
        },
      }
    }

    const retriever = getRetriever(neuronId)
    const topK = input.top_k

    if (input.mode === 'cog') {
      const cog = await retriever.getCogContext(input.query, topK)
      return {
        data: {
          query: input.query,
          neuron: neuronId,
          results: cog.mem as unknown as Array<Record<string, unknown>>,
          cognition: {
            concepts: cog.cog2_concepts as never[],
            nodes: cog.nodes as never[],
            communities: cog.communities as never[],
          },
          usage: `认知层全查（不写 precog）：cog2_concepts=${cog.cog2_concepts.length} communities=${cog.communities.length} nodes=${cog.nodes.length} mem=${cog.mem.length}`,
        },
      }
    }

    const res = await retriever.search(input.query, topK)
    const output: Output = {
      query: input.query,
      neuron: neuronId,
      results: res.formatted as unknown as Array<Record<string, unknown>>,
      precog: res.precog
        ? { record_id: res.precog.record_id, results: res.precog.results }
        : null,
      cognition: res.cognition,
      usage: USAGE_HINT_SEARCH,
    }
    // 未标注 precog → 引导标注（拟合环）
    if (res.precog && !(res.precog.description ?? '').trim()) {
      output.precog_annotate = USAGE_HINT_PRECOG_ANNOTATE
    }
    // 冷启动提示：有结果但认知簇未形成
    if (!res.cognition.nodes.length && !res.cognition.communities.length) {
      output.cognition_note = USAGE_HINT_COGNITION_COLD
    }
    return { data: output }
  },
  mapToolResultToToolResultBlockParam(content: Output, toolUseID: string) {
    if (content.skipped) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: `skipped（${content.gate ?? ''}）: ${content.reason ?? ''}\n${content.note ?? ''}`,
      }
    }
    const header = `recall(${content.neuron}): ${content.query}`
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: `${header}\n${jsonStringify(content)}`,
    }
  },
  renderToolUseMessage(input) {
    return input.neuron ? `${input.neuron}: ${input.query ?? ''}` : (input.query ?? '')
  },
} satisfies ToolDef<InputSchema, Output>)
