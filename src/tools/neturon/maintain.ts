/**
 * neuron_maintain — 记忆维护工具（块级编辑 / 重切 / 遗忘 / 合并 / 使用概览）
 *
 * 设计初衷：记忆在使用中被优化，优化目标主要是 **blocks**。remember 契约是
 * content+source 必填的 append/supersede；维护动作是 id 驱动的块级编辑，输入面正交，
 * 故独立成工具而非塞进 remember（避免「按 action 条件必填」的 schema 分叉）。
 * 后端全部复用 memwriter/db 既有原语，不复制实现。
 */

import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { listNeurons } from './config.js'
import { forget, mergeMemories, recut, setBlocks, usage } from './memwriter.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['set_blocks', 'recut', 'forget', 'merge', 'usage'])
      .describe(
        'set_blocks=替换某条 blocks（重写/合并/拆分/删除块都是它的特例，重编码该条向量）；recut=按 max_chars 重切（memory_id 省略=全库）；forget=soft 标废弃/ hard 物理删除；merge=多条合一条新记忆（旧条废弃指向新 id）；usage=只读使用概览',
      ),
    neuron: z.string().describe('Neuron id'),
    memory_id: z.string().optional().describe('目标条目 id（set_blocks/forget 必填；recut/usage 可选）'),
    blocks: z
      .array(z.string())
      .optional()
      .describe('set_blocks 必填：新的块数组（可删块/改块/增块；超 max_chars 自动重切）'),
    mode: z.enum(['soft', 'hard']).optional().describe('forget 用：soft=标废弃（默认，可溯源）；hard=物理删除'),
    memory_ids: z.array(z.string()).optional().describe('merge 必填：被合并的旧条目 id 列表'),
    content: z.string().optional().describe('merge 必填：合并后新记忆的内容'),
    source: z.string().optional().describe('merge 用：新条目来源标识（缺省 merge）'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() => z.looseObject({}))
type OutputSchema = ReturnType<typeof outputSchema>

export type Input = z.infer<InputSchema>
export type Output = ReturnType<typeof outputSchema>

export const NeuronMaintainTool = buildTool({
  name: 'neuron_maintain',
  searchHint: 'neuron memory maintain edit blocks recut forget merge usage',
  maxResultSizeChars: 50_000,
  async description() {
    return '维护神经元记忆：块级编辑/重切/遗忘/合并/使用概览'
  },
  async prompt() {
    return `Maintain a neuron's memory entries at the block level. Blocks are the optimization target — rewrite/merge/split/delete them as usage feedback reveals noise or redundancy. action=set_blocks: replace an entry's blocks (re-encodes that entry's vectors; all of split/merge/rewrite/delete are special cases). action=recut: re-split an entry's text (or the whole library when memory_id is omitted) by config blocks.max_chars — note original block boundaries are not recoverable, the raw text lives in l3.raw. action=forget: soft (default) marks deprecated but keeps it for provenance; hard deletes the row. action=merge: fold several entries into one new memory (append-only; old entries deprecated pointing at the new id). action=usage: read-only overview of how entries were recalled (hits + accuracy from precog.db) to decide which blocks to fix. Prefer set_blocks for content optimization.`
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'neuron_maintain'
  },
  shouldDefer: true,
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  toAutoClassifierInput(input) {
    return `${input.action} → ${input.neuron}${input.memory_id ? `: ${input.memory_id}` : ''}`
  },
  async checkPermissions(input: Input) {
    return { behavior: 'allow' as const, updatedInput: input }
  },
  async call(input: Input) {
    const neurons = listNeurons()
    if (!neurons.some(n => n.id === input.neuron)) {
      return {
        data: {
          status: 'error' as const,
          message: `Neuron '${input.neuron}' 未发现。可用: ${neurons.map(n => n.id).join(', ')}`,
        },
      }
    }

    switch (input.action) {
      case 'set_blocks': {
        if (!input.memory_id || !input.blocks) {
          return { data: { status: 'error' as const, message: 'set_blocks 需要 memory_id + blocks' } }
        }
        return { data: await setBlocks(input.neuron, input.memory_id, input.blocks) }
      }
      case 'recut':
        return { data: await recut(input.neuron, input.memory_id) }
      case 'forget': {
        if (!input.memory_id) {
          return { data: { status: 'error' as const, message: 'forget 需要 memory_id' } }
        }
        return { data: forget(input.neuron, input.memory_id, input.mode ?? 'soft') }
      }
      case 'merge': {
        if (!input.memory_ids?.length || !input.content) {
          return { data: { status: 'error' as const, message: 'merge 需要 memory_ids + content' } }
        }
        return {
          data: await mergeMemories(input.neuron, input.memory_ids, input.content, {
            blocks: input.blocks,
            source: input.source,
          }),
        }
      }
      default:
        return { data: usage(input.neuron, input.memory_id) }
    }
  },
  mapToolResultToToolResultBlockParam(content: Output, toolUseID) {
    return { tool_use_id: toolUseID, type: 'tool_result' as const, content: jsonStringify(content) }
  },
  renderToolUseMessage(input) {
    return `${input.action} → ${input.neuron}${input.memory_id ? `: ${input.memory_id}` : ''}`
  },
} satisfies ToolDef<InputSchema, Output>)
