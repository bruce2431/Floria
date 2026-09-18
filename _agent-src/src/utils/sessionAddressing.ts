/**
 * 会话暴露集合（2026-09-15 会话间协作）——「暴露即授权」的唯一真相源。
 *
 * **真相源 = 本会话转录，不新增持久化状态**（CLAUDE 根本原则 5：状态源只减不增）：
 *   - 正向暴露：用户 `@` 某会话 → 输入文本留下 `[会话:标题|sid]` 令牌（web 前端 chip 序列化）
 *   - 反向暴露：本会话收到过某会话的消息 → 转录留下 `<session-message from="会话：X" sid="…">`
 *     （收到消息的会话自然应当能回话，否则「非必要不通信」下的收件方无法答复）
 * 两条来源都在 user 角色记录里（令牌来自用户键盘、来件由 gatewayClient enqueue 成 user 消息），
 * resume 后自动重建，压缩后由用户重新 @ 即恢复。
 *
 * **只扫 user 角色记录**是授权语义的一部分：模型自己写下的文字不得自我授权，附件内容亦不得
 * （见 extractSessionSource 的开锚定）。
 *
 * 会话名 → sid 的解析**只在本模块（工具侧）**做，网关只按已解析的 sid 路由——网关不引入第二份
 * 标题索引（复用既有 `GET /gateway/sessions`，与 web 前端同源数据）。
 *
 * **本模块保持纯函数**（只 import sessionMessage）——不 import gatewayClient（地址解析/HTTP 查询在
 * 那里：`fetchSessionDirectory`），因为 gatewayClient 顶层 `import { feature } from 'bun:bundle'`
 * 是编译期宏，bun 直跑下不可解析 → 一旦引入，probe-session-link.ts 这类源码直跑探针就再也跑不起来。
 * 输入（会话目录、本会话 sid）由调用方注入。
 */

import { extractSessionSource } from './sessionMessage.js'

/** 暴露项。sid 可选：人手打 `[会话:标题]` 时只有标题，需按标题唯一匹配（重名报错）。 */
export type ExposedSession = { sid?: string; title: string }

/** 会话目录项（网关 /gateway/sessions 归一后的形态，sid = 转录文件名主干） */
export type KnownSession = { sid: string; title: string }

/**
 * 令牌形态（方案 §4.2）：`[会话:标题|sid]`（前端 chip，精确键）/ `[会话:标题]`（人手打）。
 * 正则不含 `]` 与换行：令牌不可能跨行（否则手打文本里的括号会误吞整段）。
 */
const TOKEN_RE = /\[会话:([^\]\n]*)\]/g

/** 记录里可见文本的抽取（string 形态 / text 块数组形态两态，字段名同 message.content 与 attachment.prompt） */
function textsOf(value: unknown): string[] {
  if (typeof value === 'string') return value ? [value] : []
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const b of value) {
    const t = (b as { text?: unknown } | null)?.text
    if (typeof t === 'string' && t) out.push(t)
  }
  return out
}

/**
 * user 角色记录的文本并集。判据三选一：`type:'user'`（转录/内存常规）、`message.role:'user'`、
 * `type:'attachment'`（queued_command 引导注入在 jsonl 里是该形态，其 prompt 同属用户内容）。
 * assistant/tool 记录一律不参与——授权来源必须与模型输出无关。
 */
function userTexts(messages: readonly unknown[]): string[] {
  const out: string[] = []
  for (const raw of messages) {
    const m = raw as
      | { type?: string; message?: { role?: string; content?: unknown }; attachment?: { prompt?: unknown } }
      | null
    if (!m || typeof m !== 'object') continue
    if (m.type !== 'user' && m.type !== 'attachment' && m.message?.role !== 'user') continue
    out.push(...textsOf(m.message?.content), ...textsOf(m.attachment?.prompt))
  }
  return out
}

function parseToken(raw: string): ExposedSession | null {
  const i = raw.indexOf('|')
  const title = (i >= 0 ? raw.slice(0, i) : raw).trim()
  const sid = i >= 0 ? raw.slice(i + 1).trim() : ''
  if (!title && !sid) return null
  return sid ? { sid, title: title || sid } : { title }
}

/**
 * 转录 → 暴露集合（原始形态，未解析 sid）。合并**按 key**（`e.sid ?? e.title`）：同一 key 的重复
 * 令牌收敛为一条，其中纯标题形态不覆盖已有精确键形态（精确键免疫改名，是更强的授权凭据）。
 * 跨 key 的去重不在这里做（`[会话:甲|s1]` 与 `[会话:甲]` 是两个 key）——统一在 resolveAgainst 的
 * targets（Map 以 sid 为键）落定，此处不引入第二处同一性判定。
 *
 * 反向来件**要求 sid**：标题可被冒用/重名，匿名的来件来源不构成授权（宁缺勿猜）。
 */
export function collectExposedSessions(messages: readonly unknown[]): ExposedSession[] {
  const byKey = new Map<string, ExposedSession>()
  for (const text of userTexts(messages)) {
    for (const m of text.matchAll(TOKEN_RE)) {
      const e = parseToken(m[1] ?? '')
      if (!e) continue
      const key = e.sid ?? e.title
      const prev = byKey.get(key)
      if (!prev || (!prev.sid && e.sid)) byKey.set(key, e)
    }
    const source = extractSessionSource(text)
    if (source?.sid) byKey.set(source.sid, { sid: source.sid, title: source.title })
  }
  return [...byKey.values()]
}

export type ResolvedExposure = {
  /** 本会话（给自己的消息盖来源用；目录里查不到时标题回落占位） */
  self: { sid: string; title: string }
  /** 已授权的目标：sid → 标题（已解析、已剔除自环） */
  targets: Map<string, string>
  /** 有令牌/来源但无法落地的项（重名/未命中/自环）——原样报给模型，不做静默丢弃 */
  unresolved: string[]
}

/**
 * 转录 + 会话目录 → 可投递的目标集合（纯函数：目录与本会话 sid 由调用方注入）。解析出口唯一
 * （方案 §4.2）：有 sid 走 sid 精确命中，无 sid 走标题唯一匹配；重名/未命中/自环 → unresolved
 * （不猜、不兜底）。
 */
export function resolveAgainst(
  dir: readonly KnownSession[],
  messages: readonly unknown[],
  selfSid: string,
): ResolvedExposure {
  const bySid = new Map(dir.map(s => [s.sid, s]))
  const byTitle = new Map<string, KnownSession[]>()
  for (const s of dir) {
    const list = byTitle.get(s.title)
    if (list) list.push(s)
    else byTitle.set(s.title, [s])
  }
  const selfKnown = bySid.get(selfSid)
  const targets = new Map<string, string>()
  const unresolved: string[] = []
  for (const e of collectExposedSessions(messages)) {
    let hit: KnownSession | undefined
    if (e.sid) {
      hit = bySid.get(e.sid)
      if (!hit) {
        unresolved.push(`会话「${e.title}」(${e.sid}) 已不在会话目录中`)
        continue
      }
    } else {
      const list = byTitle.get(e.title) ?? []
      if (list.length === 0) {
        unresolved.push(`会话「${e.title}」未找到（可能已删除或不在本工作区）`)
        continue
      }
      if (list.length > 1) {
        unresolved.push(`会话「${e.title}」重名（${list.length} 个），请在 @ 提及里选具体会话`)
        continue
      }
      hit = list[0]!
    }
    if (hit.sid === selfSid) {
      unresolved.push('令牌指向本会话自己，已忽略')
      continue
    }
    targets.set(hit.sid, hit.title)
  }
  return {
    self: { sid: selfSid, title: selfKnown?.title ?? '未命名会话' },
    targets,
    unresolved,
  }
}

/** 授权判定的唯一出口：sid 精确命中优先，其次标题精确命中。未命中返回 undefined。 */
export function findTarget(
  exp: ResolvedExposure,
  to: string,
): { sid: string; title: string } | undefined {
  const q = to.trim()
  if (!q) return undefined
  const bySidTitle = exp.targets.get(q)
  if (bySidTitle !== undefined) return { sid: q, title: bySidTitle }
  for (const [sid, title] of exp.targets) {
    if (title === q) return { sid, title }
  }
  return undefined
}

/** 授权范围的可读说明（拒绝回执/模型自查用；unresolved 原样带出，不静默丢弃） */
export function describeExposure(exp: ResolvedExposure): string {
  const list = [...exp.targets].map(([sid, title]) => `「${title}」(${sid})`)
  const parts = [
    list.length
      ? `当前已授权会话：${list.join('、')}`
      : '当前没有任何已授权会话（用户尚未在本会话里 @ 提及任何会话）',
  ]
  if (exp.unresolved.length) parts.push(`另有无法确定的目标：${exp.unresolved.join('；')}`)
  return parts.join('。')
}
