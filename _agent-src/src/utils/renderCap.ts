// ---- P1 渲染历史上限（2026-08-31，20260828145952-内存增长根因与代码层修改建议.md）----
// UI 渲染投影（React messages state）只保留尾部窗口，更早的消息替换为单条归档占位。
// 磁盘 jsonl 不动（会话持久化权威在盘）；尾部窗口恒完整。计数从占位文案自身解析，
// 天然幂等，/clear、resume 换会话后自动从零重计。
//
// 2026-09-09 自 REPL.tsx 迁出为共享模块：占位是渲染投影专属标记，除 REPL 的 cap 外，
// useLogMessages（转录落盘边界必须剥离投影——占位混入转录会以 parentUuid=null 成链根
// 切断主链，resume 历史丢失）与 sessionStorage.loadTranscriptFile（读链桥接历史残留
// 占位行）都须识别同一前缀。三处共用本单一定义。
// 2026-09-10 不变式成文：capRenderedMessages 归一化强制「数组内至多一条占位、恒在
// 下标 0」（全量替换路径挤到中部的残留被收拢剥除），消费方按头部单点判定。

import { createSystemMessage } from './messages.js'

export const MAX_RENDER_MESSAGES = 200;
export const ARCHIVE_PLACEHOLDER_PREFIX = '… 早期 ';

type PlaceholderCandidate = {
  type?: unknown
  subtype?: unknown
  content?: unknown
}

export function isRenderArchivePlaceholder(
  msg: PlaceholderCandidate | undefined | null,
): msg is PlaceholderCandidate & { content: string } {
  return (
    msg?.type === 'system' &&
    msg.subtype === 'informational' &&
    typeof msg.content === 'string' &&
    (msg.content as string).startsWith(ARCHIVE_PLACEHOLDER_PREFIX)
  );
}

/** 占位已归档条数（首条非占位 = 0）。cap 后物理长度不再随追加增长，
 *  一切「数组长度 = 逻辑进度」语义（baseline/pending）必须走 logicalRenderedLength。 */
function placeholderCount(msg: PlaceholderCandidate & { content: string }): number {
  const n = parseInt(msg.content.slice(ARCHIVE_PLACEHOLDER_PREFIX.length), 10);
  return Number.isFinite(n) ? n : 0;
}

export function renderArchivedCount<T extends PlaceholderCandidate>(list: readonly T[]): number {
  const head = list[0];
  if (!isRenderArchivePlaceholder(head)) return 0;
  return placeholderCount(head);
}

export function logicalRenderedLength<T extends PlaceholderCandidate>(list: readonly T[]): number {
  return list.length + renderArchivedCount(list);
}

export function capRenderedMessages<T extends PlaceholderCandidate & { uuid?: unknown }>(list: readonly T[]): T[] {
  // 归一化（2026-09-10，不变式强制者）：全量替换路径（REPL partial compact 重建
  // [boundaryMarker, ...kept, ...summary] 等）可把头部占位挤到数组中部——旧实现只读
  // list[0] 计数，读头失配即丢归档计数（逻辑长度低估 → baseline/pending 判定漂移，
  // 「发送回显两条」同族），且中部残留以普通 system 消息形态残留渲染、<200 条期间
  // 无人清理。此处收拢数组内全部占位的计数、剥除残留，再按 excess 统一 prepend 单条
  // ——「至多一条占位、恒在下标 0」由唯一写入口（setMessages 包装器 + useState 初始化）
  // 封闭强制，下游头部判定（useLogMessages）可依赖。无占位且未超 cap 时原引用返回。
  let archived = 0;
  let found = false;
  for (const m of list) {
    if (!isRenderArchivePlaceholder(m)) continue;
    found = true;
    archived += placeholderCount(m as PlaceholderCandidate & { content: string });
  }
  const body = (found ? list.filter(m => !isRenderArchivePlaceholder(m)) : list) as T[];
  const excess = body.length - MAX_RENDER_MESSAGES;
  if (excess <= 0 && !found) return body;
  if (excess > 0) archived += excess;
  const placeholder = createSystemMessage(`${ARCHIVE_PLACEHOLDER_PREFIX}${archived} 条消息已归档 — 完整历史在会话 jsonl（/transcript 可查）`, 'info');
  return [placeholder as unknown as T, ...body.slice(Math.max(0, excess))];
}
