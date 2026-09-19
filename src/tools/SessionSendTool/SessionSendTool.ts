/**
 * SessionSend —— 会话间协作的发送口（2026-09-15；2026-09-18 撤授权门）。
 *
 * 三段式：
 *   ① 寻址判定（checkPermissions 与 call 都要做，见下）——to（标题或 sid）→ 目标 sid
 *      （sessionAddressing.ts 纯函数）。**2026-09-18 用户定案撤除「暴露即授权」门**：
 *      原授权集合由上下文扫描派生，压缩会卷走令牌、恢复只能靠用户手工重新 @（实测卡线），
 *      机制性摩擦 > 收益——现可发目录内任何会话，回环风险由「非必要不通信」软约束兜底
 *      （失控再补硬护栏）。仍拒绝：未找到 / 重名 / 指向自己 / 空——那是寻址失败，非授权失败。
 *   ② 解析在本进程做（复用网关既有 GET /gateway/sessions），网关只收已解析的 sid 做路由
 *      ——网关不引入第二份会话标题索引。
 *   ③ 投递：gatewayClient.sendSessionMessage → 网关按 sid 三形态路由（在线直投/暂存补投/冷启拉起）。
 *
 * **为什么 checkPermissions 与 call 各解析一次**：checkPermissions 是权限门（可能被
 * bypassPermissions 等路径跳过），call 是执行点——跨会话写入是不可撤回的对外动作，
 * 执行前必须按当下的目录重算寻址（目录在两次之间也可能变化）。
 * 与 SendMessageTool 在 call 里复查 bridge 句柄同一理由（那句注释：checkPermissions 的检查在
 * 用户等待后可能已过期）。两次都是本地 HTTP + 内存比对，代价可忽略。
 */

import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { getSessionId } from '../../bootstrap/state.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { errorMessage } from '../../utils/errors.js'
import { fetchSessionDirectory, sendSessionMessage } from '../../utils/gatewayClient.js'
import { lazySchema } from '../../utils/lazySchema.js'
import {
  resolveSessionTarget,
  type ResolvedSessionTarget,
} from '../../utils/sessionAddressing.js'
import { SESSION_SEND_TOOL_NAME } from './constants.js'
import { getSessionSendPrompt, SESSION_SEND_DESCRIPTION } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

/** 正文上限：跨会话消息会变成对方的 user 消息（进上下文），超长无边界载荷对两端都是浪费 */
const MAX_TEXT_CHARS = 100_000

/** 寻址现场（目录查询 + 目标/自身解析的唯一入口，checkPermissions 与 call 各调一次，见文件头注）。
 *  self 来自同一份目录快照：来源标注用本会话自己的 sid/标题，接收端据此包 `<session-message from="会话：X" sid="…">`。 */
async function resolveAddressing(
  to: string,
): Promise<{ target: ResolvedSessionTarget; self: ResolvedSessionTarget }> {
  const dir = await fetchSessionDirectory()
  const selfSid = getSessionId()
  const r = resolveSessionTarget(dir, to, selfSid)
  if (!r.target) throw new Error(r.error ?? '目标无法确定')
  return {
    target: r.target,
    self: { sid: selfSid, title: dir.find(s => s.sid === selfSid)?.title ?? '未命名会话' },
  }
}

const inputSchema = lazySchema(() =>
  z.strictObject({
    to: z.string().describe('Target session: its title or sid (gateway session directory).'),
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

/** 寻址失败的统一拒绝（不弹审批也不静默放行） */
function deny(reason: string) {
  return {
    behavior: 'deny' as const,
    message: reason,
    decisionReason: {
      type: 'safetyCheck' as const,
      reason: '发送目标无法在会话目录中唯一定位',
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
  async checkPermissions(input) {
    try {
      await resolveAddressing(input.to)
    } catch (e) {
      return deny(errorMessage(e))
    }
    return { behavior: 'allow', updatedInput: input }
  },
  async call(input) {
    let target: ResolvedSessionTarget
    let self: ResolvedSessionTarget
    try {
      const a = await resolveAddressing(input.to)
      target = a.target
      self = a.self
    } catch (e) {
      return { data: { delivered: false, to: input.to, message: `投递失败：${errorMessage(e)}` } }
    }
    const r = await sendSessionMessage(target.sid, input.text, self)
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
