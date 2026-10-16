// 渲染面复制 → md 源码（2026-10-15 待办返修轮任务D，方案 §任务D「复制渲染内容出 md 源码」+ 待办 16）。
// 不另起还原实现：真源 = core/markdown.js 的 data-md 链（mdHtml 每个块级元素挂 data-md=原始 md 片段，
// 公式块由 phAttr 还原 `$…$`/`$$…$$`）。本件是消费门面：selectionMd（选区级）→ 块级 data-md →
// 纯文本三级降级，供全局 copy 拦截（inputbar/ctx-meter.js 唯一入口）调用。
import { messageMd, selectionMd } from '../core/markdown.js'
import { esc } from '../core/util.js'
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

  // copyRenderedImages(selection) → `<img src="…">` 片段或 ''（2026-10-16「复制图片」）：
  // 选区覆盖到的消息图片（.msg-img：气泡外的图片块 + 正文内联小图 + AI 图）→ 绝对 src 的 img 片段，
  // 由全局 copy 拦截作为 text/html 写进剪贴板。**必须做**——拦截原本只写 text/plain，选中图片复制时
  // 图片被整个丢掉，粘到底栏什么都得不到（「复制图片底栏没胶囊」根因之一）。绝对 URL 是粘贴端
  // 的同源判据（见 inputbar/images.clipboardImageUrls）与拉字节的地址。
  function copyRenderedImages(selection) {
    if (!selection || selection.isCollapsed || !selection.rangeCount) return ''
    const out = []
    for (const img of document.querySelectorAll('img.msg-img')) {
      let hit = false
      try { hit = selection.containsNode(img, true) } catch (_) { hit = false }
      if (!hit) continue
      const src = img.currentSrc || img.src
      if (src) out.push(`<img src="${esc(src)}" alt="${esc(img.alt || '')}">`)
    }
    return out.length ? '<div>' + out.join('') + '</div>' : ''
  }

export { copyRenderedImages, copyRenderedSelection }
