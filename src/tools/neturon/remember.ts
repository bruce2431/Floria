import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { getNeuronInfo, listNeurons } from './config.js'
import { addMemory, updateMemory, type RememberResult } from './memwriter.js'
import { parse as parseYaml } from 'yaml'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { USAGE_HINT_REMEMBER } from './usageHint.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z.enum(['add', 'update']).describe('add=追加新记忆；update=supersede 修正旧条目（旧条目自动废弃不删除）'),
    neuron: z.string().describe('Neuron id（见系统提示名册）'),
    content: z
      .string()
      .describe('记忆内容：保留 [用户]/[Agent] 前缀对话格式，完整记录「做了什么/怎么做的/结果」'),
    source: z.string().describe('来源标识（如 CLI/web/会话标题）'),
    blocks: z.array(z.string()).optional().describe('语义编码块（缺省 [content]）'),
    revelant: z.array(z.string()).optional().describe('关联引用（相关文件路径/记忆 id）'),
    core_file: z
      .array(
        z.object({
          name: z.string(),
          path: z.string().optional(),
          content: z.string().optional(),
        }),
      )
      .optional()
      .describe('核心产物（完整脚本/配置文本），检索命中后可经 neuron_source 整体取回复用'),
    memory_id: z
      .string()
      .optional()
      .describe('update 必填：被修正的旧条目 id；add 可选自定义 id'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() => z.looseObject({}))
type OutputSchema = ReturnType<typeof outputSchema>

export type Input = z.infer<InputSchema>
export type Output = RememberResult & { fill_rule?: string }

/** 库个性录入约定（config prompts.add_memory）+ 通用约定 */
function fillRule(neuronId: string): string {
  let rule = ''
  const path = join(getNeuronInfo(neuronId).path, 'config.yaml')
  const cfg = (parseYaml(readFileSync(path, 'utf-8')) as Record<string, unknown>) ?? {}
  const prompts = (cfg.prompts as Record<string, unknown> | undefined) ?? {}
  rule = String(prompts.add_memory ?? '').trim()
  return rule ? `${rule}\n${USAGE_HINT_REMEMBER}` : USAGE_HINT_REMEMBER
}

export const RememberTool = buildTool({
  name: 'remember',
  searchHint: 'store experience memory write supersede correct',
  maxResultSizeChars: 50_000,
  async description() {
    return '向神经元写入长期经验/知识（追加或 supersede 修正）'
  },
  async prompt() {
    return `Persist a durable experience/insight into a memory neuron. Use whenever a task yields reusable knowledge: verified methods, pitfalls (failed directions), facts about people/projects/environments. Write at the moment of discovery — include what was done, how, and the outcome in [用户]/[Agent] dialogue format. Attach working scripts via core_file. Correct a wrong existing memory with action=update (supersede — old entry is marked deprecated, never deleted). Prefer overwriting nothing: neurons are append-only.`
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'remember'
  },
  isConcurrencySafe() {
    return false // 同库串行，防 mem.db 写竞争
  },
  isReadOnly() {
    return false
  },
  toAutoClassifierInput(input) {
    return `${input.action} → ${input.neuron}: ${input.content.slice(0, 60)}`
  },
  async checkPermissions(input: Input) {
    // append-only 知识库写入（纠错走 supersede 不删除）——自动放行
    return { behavior: 'allow' as const, updatedInput: input }
  },
  async call(input: Input): Promise<{ data: Output }> {
    const neurons = listNeurons()
    if (!neurons.some(n => n.id === input.neuron)) {
      return {
        data: {
          status: 'error',
          message: `Neuron '${input.neuron}' 未发现。可用: ${neurons.map(n => n.id).join(', ')}`,
        },
      }
    }

    let result: RememberResult
    if (input.action === 'update') {
      if (!input.memory_id) {
        return {
          data: { status: 'error', message: 'action=update 需要 memory_id（被修正的旧条目）' },
        }
      }
      result = await updateMemory(input as Input & { memory_id: string })
    } else {
      result = await addMemory(input)
    }

    if (result.status === 'ok') {
      return { data: { ...result, fill_rule: fillRule(input.neuron) } }
    }
    return { data: result }
  },
  mapToolResultToToolResultBlockParam(content: Output, toolUseID: string) {
    if (content.status === 'ok') {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: `remember ${content.action} → ${content.memory_id}${content.superseded ? `（已废弃 ${content.superseded}）` : ''}\n${content.fill_rule ?? ''}`,
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: `Error: ${content.message}`,
      is_error: true,
    }
  },
  renderToolUseMessage(input) {
    return `${input.action ?? ''} → ${input.neuron ?? ''}: ${input.content?.slice(0, 60) ?? ''}`
  },
} satisfies ToolDef<InputSchema, Output>)
