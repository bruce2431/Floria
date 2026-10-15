// Markdown 渲染统一入口 + 任务勾选源码操作（2026-10-15 待办返修轮任务D，方案 §任务D「渲染统一入口」）。
// 不另起渲染器：renderMarkdown 是 core/markdown.js mdHtml（唯一实现，含 KaTeX 公式/提及 chip/代码块
// 白名单安全链）的门面——所有渲染面（会话消息、审批卡、引用预览、新增消费面）一律经此入口，
// 禁止新代码直 import mdHtml 绕过门面（存量消费面保持不动，渲染真源同一）。
import { mdHtml } from '../core/markdown.js'
/* @module editor/editor-markdown.js */


  // 统一渲染入口。opts 为能力声明面（当前唯一真源 mdHtml 恒开公式/提及/代码块；allowHtml 恒 false
  // = mdHtml 白名单安全口径，不提供开关——HTML 直注宿主 DOM 只经任务F的 sandbox 插件链）。
  // opts 现阶段仅作消费面自描述（surface），不改变渲染行为；后续能力裁剪在此收口。
  function renderMarkdown(source, opts) {
    return mdHtml(source)
  }

  // 任务勾选（源码层，纯函数）：把第 line 行（1-based）列表标记后的 `[ ]`/`[x]` 改写为 checked 形态，
  // 返回新源码；该行无任务标记返回 null（调用方不动源码）。渲染面只读复选框（disabled）的可编辑
  // 对应件——CM6 编辑面走 editor-transactions.toggleTaskLineCM（同一行语义，两处正则同族）。
  function toggleTask(source, line, checked) {
    const lines = String(source == null ? '' : source).split('\n')
    const i = line - 1
    if (i < 0 || i >= lines.length) return null
    const m = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\](.*)$/.exec(lines[i])
    if (!m) return null
    lines[i] = m[1] + '[' + (checked ? 'x' : ' ') + ']' + m[3]
    return lines.join('\n')
  }

export { renderMarkdown, toggleTask }
