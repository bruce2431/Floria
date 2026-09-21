/**
 * 会话寻址（2026-09-18）—— SessionSend 的 to（标题或 sid）→ 目标会话，解析唯一出口。
 *
 * **2026-09-18 用户定案：撤除「暴露即授权」门**（前身为 sessionExposure.ts）。
 *   原设计（09-15）：只有被 @ 提及（或来过件）的会话可发，授权集合由上下文扫描派生——
 *   压缩会把令牌卷走、恢复只能靠用户手工重新 @（旧头注释自证）。实测一次真实卡线
 *   （目标会话离线 + 压缩丢授权叠加）后定案：机制性摩擦 > 收益，授权门整体移除——
 *   可发会话目录内**任何**会话；@ 提及仅存 UI 引用语义（往消息里塞会话 chip），不再承担授权。
 *   ⚠️ 移除后「非必要不通信」（全局 CLAUDE.md 通信约束节 + 工具说明）成为**唯一刹车**；
 *   实测出现 agent 对喷 → 回头补硬护栏（限频/审批）。
 *
 * **本模块保持纯函数、零 import**——目录（GET /gateway/sessions 归一形态）与本会话 sid
 * 由调用方注入（SessionSendTool 的 checkPermissions 与 call 各解析一次，见该文件头注）。
 * 解析不猜不兜底：sid 精确命中优先；标题必须唯一；重名/未找到/自环/空 → error 原文回给模型。
 *
 * 2026-09-20：发送模式判定（resolveSendMode：existing / new / invalid）同样收在本模块——
 * 「发给已有会话」与「拉起新会话」的分岔必须是单一出口，否则工具 schema、权限门与执行点
 * 三处各判一次必然漂移。
 */

/** 会话目录项（网关 /gateway/sessions 归一后的形态，sid = 转录文件名主干） */
export type KnownSession = { sid: string; title: string }

export type ResolvedSessionTarget = { sid: string; title: string }

/** 解析结果：target 与 error 恰一非空（不静默兜底） */
export type TargetResolution = { target: ResolvedSessionTarget | null; error: string | null }

/**
 * to（标题或 sid）→ 目标会话。判据：
 *   ① sid 与目录精确命中（trim 后整串比对，不做前缀/大小写猜测）；
 *   ② 否则按标题唯一匹配；
 *   ③ 重名 / 未找到 / 指向本会话自己 / 空 → error。
 * sid 未命中**不回落标题**：`[会话:标题|sid]` 令牌里的 sid 是精确凭据，失配即报未找到
 * （会话可能已删除）——静默换键会掩盖失效。
 */
export function resolveSessionTarget(
  dir: readonly KnownSession[],
  to: string,
  selfSid: string,
): TargetResolution {
  const q = to.trim()
  if (!q) return { target: null, error: '目标为空' }
  const bySid = dir.find(s => s.sid === q)
  if (bySid) {
    if (bySid.sid === selfSid) return { target: null, error: '目标指向本会话自己，已拒绝' }
    return { target: { sid: bySid.sid, title: bySid.title }, error: null }
  }
  const byTitle = dir.filter(s => s.title === q)
  if (byTitle.length === 0) {
    return { target: null, error: `会话「${q}」未找到（可能已删除或不在本工作区；也可改用会话 sid 寻址）` }
  }
  if (byTitle.length > 1) {
    return {
      target: null,
      error: `会话「${q}」重名（${byTitle.length} 个），请让用户指定具体会话（用 sid 寻址）`,
    }
  }
  const hit = byTitle[0]!
  if (hit.sid === selfSid) return { target: null, error: '目标指向本会话自己，已拒绝' }
  return { target: { sid: hit.sid, title: hit.title }, error: null }
}

/**
 * 发送模式（2026-09-20 新增「拉起新会话」）——工具入参 → 该走哪条链路的唯一判定出口。
 *   existing = 发给目录内已有会话（to）；
 *   new      = 拉起一个全新会话并投递首条消息（new_session + project，project 必填）；
 *   invalid  = 形状拒绝。**不猜不兜底**：不把「to 空」当新建、不把「new_session 无 project」
 *              回落全局根——语义冲突与缺参一律原样报给模型（与 resolveSessionTarget 同一立场）。
 * project 的 label 是否真实存在由调用方查目录校验（本模块保持纯函数、零 import）。
 */
export type SendMode =
  | { kind: 'existing'; to: string }
  | { kind: 'new'; project: string }
  | { kind: 'invalid'; error: string }

export function resolveSendMode(input: {
  to?: string
  new_session?: boolean
  project?: string
}): SendMode {
  const to = (input.to ?? '').trim()
  const project = (input.project ?? '').trim()
  if (input.new_session === true) {
    if (to) {
      return {
        kind: 'invalid',
        error: 'new_session 与 to 互斥：新会话尚无目标可寻址，请只填 new_session + project',
      }
    }
    if (!project) {
      return {
        kind: 'invalid',
        error: 'new_session 必须指定 project（新会话落在哪个项目）',
      }
    }
    return { kind: 'new', project }
  }
  if (project) {
    return {
      kind: 'invalid',
      error: 'project 仅在 new_session: true 时有效（发给已有会话请用 to 寻址）',
    }
  }
  if (!to) {
    return {
      kind: 'invalid',
      error: 'to 不能为空（要新建会话请设 new_session: true 并指定 project）',
    }
  }
  return { kind: 'existing', to }
}
