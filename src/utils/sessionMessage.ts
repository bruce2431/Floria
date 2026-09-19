/**
 * 会话间协作消息的文本包装（2026-09-15）
 *
 * 形态与理由：**来源信息内嵌在消息文本里，而不是新开消息字段**。
 *   - 本 fork 已有同一手法：`<task-notification>` / `<local-command-stdout>` 都是文本内嵌 XML，
 *     由 conversationDisplay 抽取后决定投影形态（见该文件 task-notification 与 local_command 分支）。
 *   - 文本即单一真相源：落盘 / 回放 / 压缩后 / 投影天然携带，无需在 QueuedCommand → Attachment
 *     → Message → DisplayMessage 四层各加一个透传字段（状态源只减不增）。
 *   - **关键**：来源绝不能用 `origin` 字段携带 —— `isLoggableMessage` 对带 origin 的
 *     queued_command attachment 直接返回 false（sessionStorage.ts「人发 queued_command」判据），
 *     消息刷新后即消失；conversationDisplay 的可见性判据同源。内嵌文本天然绕开该判据。
 *
 * 模型可见来源（用户定案 4）：包装原样进上下文，模型据此知道该消息来自哪个会话，无需额外注入。
 * 展示层由 conversationDisplay 抽取并剥离（气泡正文只有 body，来源单独走 DisplayMessage.fromSession）。
 */

export const SESSION_MESSAGE_TAG = 'session-message'

/** 来源会话标识。sid 可选：人手打 `[会话:标题]`（无 sid）时只有标题，前端 chip 输出恒带 sid。 */
export type SessionSource = { sid?: string; title: string }

/** 属性值转义（会话标题可能含引号/尖括号，未转义会破坏标签结构） */
function escAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function unescAttr(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** from 属性里的展示前缀（模型读到的形态自解释：「会话：X」） */
const FROM_PREFIX = '会话：'

/** 把一条跨会话消息包成可落盘的文本（接收端 gatewayClient 下行分支调用） */
export function wrapSessionMessage(source: SessionSource, text: string): string {
  const sid = source.sid ? ` sid="${escAttr(source.sid)}"` : ''
  return `<${SESSION_MESSAGE_TAG} from="${escAttr(FROM_PREFIX + source.title)}"${sid}>${text}</${SESSION_MESSAGE_TAG}>`
}

/** 包装标签形态的唯一定义处：开标签（属性段）/闭标签（尾锚定），三个出口共用 */
const OPEN_RE = new RegExp(`^<${SESSION_MESSAGE_TAG}\\s+from="([^"]*)"(?:\\s+sid="([^"]*)")?\\s*>`)
const CLOSE_RE = new RegExp(`</${SESSION_MESSAGE_TAG}>\\s*$`)

function sourceOf(m: RegExpExecArray): SessionSource {
  return {
    sid: m[2] ? unescAttr(m[2]) : undefined,
    title: unescAttr(m[1]).replace(new RegExp(`^${FROM_PREFIX}`), ''),
  }
}

/**
 * 识别并拆解跨会话消息（conversationDisplay 调用）。非该形态返回 null。
 * 正文按「开标签之后、末个闭标签之前」整体取——正文自身含该标签串也不误切
 * （整条消息恒为单层包装，由 wrapSessionMessage 独占产出）。
 */
export function parseSessionMessage(
  text: string,
): { source: SessionSource; body: string } | null {
  const open = OPEN_RE.exec(text)
  if (!open) return null
  const close = CLOSE_RE.exec(text)
  if (!close || close.index < open[0].length) return null
  return { source: sourceOf(open), body: text.slice(open[0].length, close.index) }
}
