// ---- P1 渲染历史上限（2026-08-31，20260828145952-内存增长根因与代码层修改建议.md）----
// **自建机制**（父源没有，fork 独有）：UI 渲染投影只保留尾部窗口，更早的消息替换为单条
// 归档占位。磁盘 jsonl 不动（会话持久化权威在盘）；尾部窗口恒完整。计数从占位文案自身解析，
// 天然幂等，/clear、resume 换会话后自动从零重计。
//
// 2026-09-22 层次归位（B 案）：cap 只作用于**渲染出口**——messagesRef（数据层/模型上下文）
// 恒为全量、与父源语义一致；唯一写入口 rawSetMessages 收到的是本模块输出。此前把 ref 也
// 写 cap 产物，长会话的模型上下文被静默截断到 200 条。
//
// 长度不变量（精确，非近似）：**logicalRenderedLength(投影) === 未 cap 时该数组的原始条数**，
// 故一切「数组长度=逻辑进度」判定（baseline/pending）在全量源与投影上读数一致，且全量源
// 无占位时就是 .length。占位元素自身不计入逻辑长度（它不对应任何真实记录）。
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

/** 逻辑长度 = 未 cap 时该数组的原始条数（占位元素自身不计数、归档条数计回）。
 *  全量源（无占位）返回值即 .length；渲染投影返回值与全量源**逐值相等**——baseline 存于
 *  全量源坐标、比较发生在投影上，两侧同一把尺子。 */
export function logicalRenderedLength<T extends PlaceholderCandidate>(list: readonly T[]): number {
  const archived = renderArchivedCount(list);
  return archived > 0 ? list.length - 1 + archived : list.length;
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
  // 无归档可记即原引用返回（无占位、或残留占位计数为 0 的坏输入）：不产出「…早期 0 条」空占位，
  // 逻辑长度不变量（投影 - 1 + 归档 = 原始条数）才恒成立。
  if (excess <= 0 && archived === 0) return body;
  if (excess > 0) archived += excess;
  const placeholder = createSystemMessage(`${ARCHIVE_PLACEHOLDER_PREFIX}${archived} 条消息已归档 — 完整历史在会话 jsonl（/transcript 可查）`, 'info');
  return [placeholder as unknown as T, ...body.slice(Math.max(0, excess))];
}
