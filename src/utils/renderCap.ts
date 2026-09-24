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
//
// ---- 2026-09-24 窗口边界改「UUID 锚点 + 步长量化」（跳顶根修）----
// 旧实现按条数滑动（`body.slice(body.length - cap)`）：消息数一旦超过 cap，**每追加一条就把
// 整个投影窗口前移一条**，顶部行（含计数递增的归档占位）逐帧变化。非全屏模式下这些行已滚入
// 终端 scrollback、物理不可改写，Ink 只能 fullReset（清屏 + 清 scrollback + 光标归零）——
// 用户会话在滚动浏览历史时表现为「概率性跳到最顶部」，且每追加一条重置一次。取证见
// probes/probe-render-cap-flicker.ts（旧算法每帧 flicker，新算法仅前进帧 flicker）。
// 根修即父源对同一 bug 的解法（CC-941 计数滑动 → CC-1154 步长量化 → CC-1174 UUID 锚点），
// 此前只落在 Messages 层、被 REPL 层的计数滑动覆盖，现两处统一走 computeSliceStart 单一定义。

import { createSystemMessage } from './messages.js'

export const MAX_RENDER_MESSAGES = 200;
/** 窗口前进的量化步长：锚点只在「已渲染条数 > cap + step」时前进，且一次前进到恰好 cap 条。
 *  追加不再移动窗口边界（追加快照不动 ⇒ 顶部行恒定 ⇒ 无 fullReset），长会话下重置频率从
 *  「每条一次」降到「每 step 条一次」。 */
export const RENDER_CAP_STEP = 50;
export const ARCHIVE_PLACEHOLDER_PREFIX = '… 早期 ';

export type SliceAnchor = {
  uuid: string;
  idx: number;
} | null;

/** 锚点的持久载体（React 侧为 useRef 的形态：跨渲染存活、可变）。 */
export type SliceAnchorRef = { current: SliceAnchor };

/** 窗口起点（列表下标）。**唯一实现**，两个 cap 层共用：本模块的投影 cap（REPL 层）
 *  与 Messages.tsx 的渲染切片（collapsed 层）。导出供测试与探针驱动。
 *
 *  锚点存 uuid 与 idx 双份：部分 uuid 在渲染间不稳定（collapseHookSummaries 组的合并 uuid
 *  取组内首条，reorderMessagesInUI 随 tool_result 到达重排组内次序 ⇒ 首条易主）。uuid 失配时
 *  回落到存下的 idx（按当前长度夹取），使窗口留在原处而非弹回 0（弹回会让 ~cap 条已渲染消息
 *  突变为全量历史）。 */
export function computeSliceStart(
  list: ReadonlyArray<{ uuid?: unknown }>,
  anchorRef: SliceAnchorRef,
  cap = MAX_RENDER_MESSAGES,
  step = RENDER_CAP_STEP,
): number {
  const anchor = anchorRef.current;
  const anchorIdx = anchor && anchor.uuid !== '' ? list.findIndex(m => m.uuid === anchor.uuid) : -1;
  let start = anchorIdx >= 0 ? anchorIdx : anchor ? Math.min(anchor.idx, Math.max(0, list.length - cap)) : 0;
  if (list.length - start > cap + step) start = list.length - cap;
  // 从当前位置刷新锚点：修复回落后的陈旧 uuid，并捕获前进后的新位置。
  const at = list[start];
  const uuidAt = at && typeof at.uuid === 'string' ? (at.uuid as string) : '';
  if (at) {
    if (!anchor || anchor.uuid !== uuidAt || anchor.idx !== start) anchorRef.current = { uuid: uuidAt, idx: start };
  } else if (anchor) {
    anchorRef.current = null;
  }
  return start;
}

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

/** 投影 cap。anchorRef 是窗口边界的持久载体（REPL 层为 useRef，跨调用存活 = 跨帧稳定）；
 *  无锚点时首帧渲染全量直到超过 cap + step，之后每 step 条前进一次。 */
export function capRenderedMessages<T extends PlaceholderCandidate & { uuid?: unknown }>(
  list: readonly T[],
  anchorRef: SliceAnchorRef,
): T[] {
  // 归一化（2026-09-10，不变式强制者）：全量替换路径（REPL partial compact 重建
  // [boundaryMarker, ...kept, ...summary] 等）可把头部占位挤到数组中部——旧实现只读
  // list[0] 计数，读头失配即丢归档计数（逻辑长度低估 → baseline/pending 判定漂移，
  // 「发送回显两条」同族），且中部残留以普通 system 消息形态残留渲染、<200 条期间
  // 无人清理。此处收拢数组内全部占位的计数、剥除残留，再按 start 统一 prepend 单条
  // ——「至多一条占位、恒在下标 0」由唯一写入口（setMessages 包装器 + useState 初始化）
  // 封闭强制，下游头部判定（useLogMessages）可依赖。无占位且未进档时原引用返回。
  let archived = 0;
  let found = false;
  for (const m of list) {
    if (!isRenderArchivePlaceholder(m)) continue;
    found = true;
    archived += placeholderCount(m as PlaceholderCandidate & { content: string });
  }
  const body = (found ? list.filter(m => !isRenderArchivePlaceholder(m)) : list) as T[];
  const start = computeSliceStart(body, anchorRef);
  // 无归档可记（start=0 且无残留计数）：原引用返回，不产出「…早期 0 条」空占位，
  // 逻辑长度不变量（投影 - 1 + 归档 = 原始条数）才恒成立。
  const archivedTotal = archived + start;
  if (archivedTotal === 0) return body;
  const placeholder = createSystemMessage(`${ARCHIVE_PLACEHOLDER_PREFIX}${archivedTotal} 条消息已归档 — 完整历史在会话 jsonl（/transcript 可查）`, 'info');
  return [placeholder as unknown as T, ...body.slice(start)];
}
