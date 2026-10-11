/**
 * CardCall —— 卡片公开 API 的 agent 侧入口（2026-10-11）。
 *
 * 两个动作，同一出口：
 *   list —— 经 gatewayClient.listGatewayCards（GET /gateway/cards）取浏览器在场卡片能力表；
 *   call —— 经 gatewayClient.callGatewayCard（POST /gateway/card-call）驱动某张卡的公开命令。
 *
 * 为什么寻址与命令名都交给「能力表」而不是内置常量：命令集是**卡片自定义**的（统一标准集
 * state/open 只是最小公约），只有卡片自己申报的 cmds 才是真源——故 prompt 明确要求先 list 再 call，
 * 本工具不内置任何命令白名单（内置即等于替卡片说话）。
 *
 * 失败语义全部来自网关既定 HTTP 口径（503 无浏览器 / 409 卡不在场附当场表 / 504 卡超时或设备断开；
 * 卡内命令失败走 200 ok:false）——gatewayClient 已把响应归一成 { ok, error, card }，本工具只转述。
 */

import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { callGatewayCard, listGatewayCards, type GatewayCardCap } from '../../utils/gatewayClient.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { CARD_CALL_TOOL_NAME } from './constants.js'
import { CARD_CALL_DESCRIPTION, getCardCallPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    action: z
      .enum(['list', 'call'])
      .describe("'list' = 列出浏览器在场卡片及各自申报的命令；'call' = 调一张卡的一条命令"),
    label: z
      .string()
      .optional()
      .describe('目标卡所属项目 label（与 /gateway/sessions 的 label 同口径）；寻址用'),
    ns: z
      .string()
      .optional()
      .describe('卡片命名空间（如 floria-pv）；用于跨设备选「持卡的那台浏览器」，寻址用'),
    instanceId: z
      .string()
      .optional()
      .describe('卡片实例 id（最精确，取自 list 返回的 instanceId）；寻址用'),
    cmd: z.string().optional().describe('命令名（call 必填；标准集 state/open，其余以该卡 list 申报为准）'),
    args: z.record(z.string(), z.unknown()).optional().describe('命令参数（原样平铺进命令信封）'),
    timeoutMs: z.number().optional().describe('命令超时毫秒（500..60000，默认 8000）'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    ok: z.boolean(),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type CardCallOutput = z.infer<OutputSchema>

export type Input = z.infer<InputSchema>

/** 把 call 的返回值序列化成一行文本（对象 → JSON；循环引用等序列化失败回落 String）。 */
function describeResult(result: unknown): string {
  if (result === undefined) return '（无返回值）'
  try {
    return JSON.stringify(result) ?? String(result)
  } catch {
    return String(result)
  }
}

/** 能力表 → 人类可读多行文本（一卡一行，含寻址键与申报命令）。 */
function describeCaps(devices: number, cards: GatewayCardCap[]): string {
  const lines = cards.map(c => {
    const keys = [c.instanceId, c.label, c.ns].filter(Boolean).join(' | ') || '(无寻址键)'
    const cmds = c.cmds && c.cmds.length ? c.cmds.join('/') : '（未申报命令）'
    const ready = c.ready === false ? ' [未就绪]' : ''
    return `- ${keys} · ${c.kind || '?'}${ready} · 命令: ${cmds}`
  })
  return `在场卡片 ${cards.length} 张（浏览器 ${devices}）：\n${lines.join('\n')}`
}

export const CardCallTool = buildTool({
  name: CARD_CALL_TOOL_NAME,
  searchHint: 'list or drive web UI cards (in-browser card public API)',
  maxResultSizeChars: 10_000,
  shouldDefer: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    // feature() 是编译期宏，只允许直接出现在 if / 三元条件位（bun:bundle 限制）
    return feature('CARD_API') ? true : false
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    // call 会改变用户浏览器里卡片的可见状态，按写操作对待（list 虽只读，但同一工具不能分档）
    return false
  },
  userFacingName() {
    return CARD_CALL_TOOL_NAME
  },
  async description() {
    return CARD_CALL_DESCRIPTION
  },
  async prompt() {
    return getCardCallPrompt()
  },
  async validateInput(input) {
    if (input.action === 'call') {
      if (!input.cmd || !input.cmd.trim()) {
        return { result: false, message: 'action=call 必须给 cmd（命令名以该卡 list 申报为准）', errorCode: 9 }
      }
      if (!input.label && !input.ns && !input.instanceId) {
        return {
          result: false,
          message: 'action=call 至少给一个寻址键：instanceId（最精确）或 label 或 ns',
          errorCode: 9,
        }
      }
    }
    return { result: true }
  },
  async call(input) {
    if (input.action === 'list') {
      const r = await listGatewayCards()
      // strict:false 下 TS7 的真值收窄不拆判别联合，故比 `=== false` 而非 `!r.ok`
      if (r.ok === false) return { data: { ok: false, message: `查询卡片表失败：${r.error}` } }
      if (!r.cards.length) {
        return {
          data: {
            ok: true,
            message: r.devices ? '浏览器在线，但当前没有在场卡片' : '当前没有浏览器在线（无卡片可调）',
          },
        }
      }
      return { data: { ok: true, message: describeCaps(r.devices, r.cards) } }
    }
    // action === 'call'
    const r = await callGatewayCard({
      label: input.label,
      ns: input.ns,
      instanceId: input.instanceId,
      cmd: input.cmd as string,
      args: input.args,
      timeoutMs: input.timeoutMs,
    })
    if (r.ok === false) {
      const where = r.card ? `（卡：${r.card.instanceId || r.card.ns || r.card.label || '?'}）` : ''
      return { data: { ok: false, message: `卡片命令失败${where}：${r.error}` } }
    }
    return { data: { ok: true, message: `卡片返回：${describeResult(r.result)}` } }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: output.message,
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
} satisfies ToolDef<InputSchema, CardCallOutput>)
