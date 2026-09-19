/**
 * SessionSend —— 会话间协作的发送口（2026-09-15）。
 *
 * 三段式：
 *   ① 授权判定（checkPermissions 与 call 都要做，见下）——真相源 = 本会话转录（sessionExposure.ts），
 *      **暴露即授权**，不弹审批（用户定案 5）。
 *   ② 解析：`to`（标题或 sid）→ 目标 sid。解析在本进程做（复用网关既有 GET /gateway/sessions），
 *      网关只收已解析的 sid 做路由——网关不引入第二份会话标题索引。
 *   ③ 投递：gatewayClient.sendSessionMessage → 网关按 sid 三形态路由（在线直投/暂存补投/冷启拉起）。
 *
 * **为什么 checkPermissions 与 call 各解析一次**：checkPermissions 是权限门（可能被
 * bypassPermissions 等路径跳过），call 是执行点——跨会话写入是不可撤回的对外动作，
 * 执行前必须按当下的转录重算授权（授权本身也可能在两次之间被压缩/换会话改变）。
 * 与 SendMessageTool 在 call 里复查 bridge 句柄同一理由（那句注释：checkPermissions 的检查在
 * 用户等待后可能已过期）。两次都是本地 HTTP + 内存扫描，代价可忽略。
 */

import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { getSessionId } from '../../bootstrap/state.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { errorMessage } from '../../utils/errors.js'
import { fetchSessionDirectory, sendSessionMessage } from '../../utils/gatewayClient.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  describeExposure,
  findTarget,
  resolveAgainst,
  type ResolvedExposure,
} from '../../utils/sessionExposure.js'
import { SESSION_SEND_TOOL_NAME } from './constants.js'
import { getSessionSendPrompt, SESSION_SEND_DESCRIPTION } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

/** 正文上限：跨会话消息会变成对方的 user 消息（进上下文），超长无边界载荷对两端都是浪费 */
const MAX_TEXT_CHARS = 100_000

/** 授权判定现场（目录查询 + 解析的唯一入口，checkPermissions 与 call 各调一次，见文件头注） */
async function resolveExposure(messages: readonly unknown[]): Promise<ResolvedExposure> {
  const dir = await fetchSessionDirectory()
  return resolveAgainst(dir, messages, getSessionId())
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    to: z
      .string()
      .describe('Target session: its title or sid. Must be a session the user exposed to you.'),
    text: z
      .string()
      .describe('Message body. Self-contained — the receiving session cannot see your context.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    delivered: z.boolean(),
    to: z.string(),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type SessionSendOutput = z.infer<OutputSchema>

export type Input = z.infer<InputSchema>

/** 未授权/目录不可达的统一拒绝（授权是唯一判据，不弹审批也不静默放行） */
function deny(reason: string) {
  return {
    behavior: 'deny' as const,
    message: reason,
    decisionReason: {
      type: 'safetyCheck' as const,
      reason: '发送目标不在本会话的已暴露会话集合内',
      classifierApprovable: false,
    },
  }
}

export const SessionSendTool = buildTool({
  name: SESSION_SEND_TOOL_NAME,
  searchHint: 'send a message to another Claude session (cross-session collaboration)',
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
    return feature('SESSION_LINK') ? true : false
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return false
  },
  userFacingName() {
    return SESSION_SEND_TOOL_NAME
  },
  async description() {
    return SESSION_SEND_DESCRIPTION
  },
  async prompt() {
    return getSessionSendPrompt()
  },
  async validateInput(input) {
    if (input.to.trim().length === 0) {
      return { result: false, message: 'to must not be empty', errorCode: 9 }
    }
    if (input.text.trim().length === 0) {
      return { result: false, message: 'text must not be empty', errorCode: 9 }
    }
    if (input.text.length > MAX_TEXT_CHARS) {
      return {
        result: false,
        message: `text is too long (${input.text.length} > ${MAX_TEXT_CHARS} chars)`,
        errorCode: 9,
      }
    }
    return { result: true }
  },
  async checkPermissions(input, context) {
    let exp: ResolvedExposure
    try {
      exp = await resolveExposure(context.messages)
    } catch (e) {
      return deny(`无法确认会话授权（网关会话目录不可达）：${errorMessage(e)}`)
    }
    if (!findTarget(exp, input.to)) {
      return deny(`目标会话未授权或无法确定：${describeExposure(exp)}`)
    }
    return { behavior: 'allow', updatedInput: input }
  },
  async call(input, context) {
    let exp: ResolvedExposure
    try {
      exp = await resolveExposure(context.messages)
    } catch (e) {
      return { data: { delivered: false, to: input.to, message: `投递失败：${errorMessage(e)}` } }
    }
    const target = findTarget(exp, input.to)
    if (!target) {
      return {
        data: {
          delivered: false,
          to: input.to,
          message: `未发送（目标不在已授权范围内）：${describeExposure(exp)}`,
        },
      }
    }
    // 来源用本会话自己的 sid/标题：接收端据此包 `<session-message from="会话：X" sid="…">`
    const r = await sendSessionMessage(target.sid, input.text, exp.self)
    return {
      data: {
        delivered: r.ok,
        to: target.title,
        message: r.ok ? `已投递给会话「${target.title}」` : `投递失败：${r.error}`,
      },
    }
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
} satisfies ToolDef<InputSchema, SessionSendOutput>)
