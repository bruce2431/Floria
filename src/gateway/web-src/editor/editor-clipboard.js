// 渲染面复制 → md 源码（2026-10-15 待办返修轮任务D，方案 §任务D「复制渲染内容出 md 源码」+ 待办 16）。
// 不另起还原实现：真源 = core/markdown.js 的 data-md 链（mdHtml 每个块级元素挂 data-md=原始 md 片段，
// 公式块由 phAttr 还原 `$…$`/`$$…$$`）。本件是消费门面：selectionMd（选区级）→ 块级 data-md →
// 纯文本三级降级，供全局 copy 拦截（inputbar/ctx-meter.js 唯一入口）调用。
import { messageMd, selectionMd } from '../core/markdown.js'
/* @module editor/editor-clipboard.js */


  // copyRenderedSelection({selection, container}) → md 源码或 null：
  //  1. selection 给定且非折叠 → selectionMd（整块覆盖用 data-md 原文；块内碎片返回 null）
  //  2. container 给定（如某条消息 .body）→ messageMd（全块按序拼接，复制按钮链路）
  //  3. 都未命中 → null（调用方回落 sel.toString() 纯文本）
  function copyRenderedSelection({ selection, container } = {}) {
    if (selection && !selection.isCollapsed) {
      const s = selectionMd(selection)
      if (s) return s
    }
    if (container) return messageMd(container) || null
    return null
  }

export { copyRenderedSelection }
