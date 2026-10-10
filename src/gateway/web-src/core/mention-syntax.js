// @ 提及 / 引用令牌的纯符号层（2026-10-10 自 inputbar/mention.js 下移为 core 叶子）：6 个令牌正则 +
// splitSessionToken + 4 个 chip-html 构造器 + 其所需的 2 个图标常量。core/markdown.js 渲染内联 chip 只
// 需此层——原先直连 inputbar/mention.js 使 core→feature 成环（SCC 27 模块），本层断开该边。
// 纯函数、无状态、无连接、无订阅（§12 core 叶子准入）：可被任意层依赖。唯一手改处，web/app.js 为生成物。

import { I } from './icons.js'
/* @module core/mention-syntax.js */
  const MENTION_PLUGIN_RE = /\[插件:([^\]]+)\]/g
  const MENTION_SESSION_RE = /\[会话:([^\]]+)\]/g
  // @ 提及 icon（2026-09-28 换 dsh v0.2.0-rc.1 产品图标集，16 描线/currentColor；旧 24 手绘那套作废）。
  // 语义与 dsh 一致：会话=ChatLines、插件=PluginPinwheel、技能=Skill、目录=FolderClose、文件=Browse
  // ——与 + 浮窗行图标同源（同一批 I.* 常量），两处不得分叉。
  const MENTION_SESSION_ICON = I.dshChat
  // 目录 / 文件引用令牌（2026-09-26）：令牌 [@目录:路径] / [@文件:路径] 与上传附件占位 [文件:<路径>]
  // 刻意不同名：后者会被 messages.js 的附件卡片链（userFilesHtml/userBodyHtml）剥走，同名会吞掉 @ chip。
  const MENTION_PATH_RE = /\[@(目录|文件):([^\]]+)\]/g
  // 选中引用令牌（2026-09-28，inputbar/quote.js 产出）：`[@引用:<路径>#L12-L20]`——**只给位置**，
  // 模型自己 Read 该文件（与 `[文件:]` 上传占位、`[@文件:]` 路径 chip 都不同名，三者互不吞）。
  // 无行号（拿不到原文行偏移的文件）退化为 `[@引用:<路径>]`。MENTION_PATH_RE 只认「目录|文件」，
  // 不会抢「引用」。
  const QUOTE_REF_RE = /\[@引用:([^\]#]+?)(?:#L(\d+)-L?(\d+))?\]/g
  // 回复引用令牌（2026-09-28，同由 inputbar/quote.js 产出）：回复不属于任何文件、没有位置可查 ⇒
  // **原文必须进消息**（模型直接读到，以普通正文给出），进令牌的只有**锚点行**——`[@引用回复:<第N条>|<标题>]`
  // 在消息/输入栏里渲染成一枚胶囊（与文件引用同族观感）。形态与 `[@引用:]`、`[@目录|文件:]` 互不吞。
  const QUOTE_REPLY_RE = /\[@引用回复:(\d+)\|([^\]]*)\]/g
  // PDF 引用令牌（2026-09-28，同由 inputbar/quote.js 经 floria-quote-open 产出）：`[@引用PDF:<路径>#p7]`。
  // PDF **没有行号**（Read 工具用 pages 参数，>10 页必须传），故位置粒度 = **路径 + 页码**（跨页 `#p7-9`，
  // 无页码退化纯路径）——与 `[@引用:]`（行号语义）刻意分家，混用会误导模型。
  const QUOTE_PDF_RE = /\[@引用PDF:([^\]#]+?)(?:#p(\d+)(?:-p?(\d+))?)?\]/g
  const MENTION_FILE_ICON = I.dshFile

  // 令牌形态解析（会话令牌可带 sid：`标题|sid`，@ 提及 chip 序列化产出，CLI 侧按它精确寻址——
  // 见 src/utils/sessionAddressing.ts）。渲染一律只显示标题，sid 是给工具用的寻址键。
  function splitSessionToken(v) {
    const i = String(v).indexOf('|')
    return i >= 0 ? { title: String(v).slice(0, i), sid: String(v).slice(i + 1) } : { title: String(v), sid: '' }
  }

  // chip HTML（name 为已转义文本：mdInline/addUser 入口已 esc，这里不再二次转义）
  // 消息内渲染=透明胶囊（无图标），仅保留名称文本（用户要求「只要一个白色浮窗似的胶囊」→ 透明胶囊）
  // 路径 chip 额外包一层 .mc-t：长路径在胶囊内省略号收口（inline-flex 直挂文本无法 text-overflow）
  function mentionChipHtml(kind, name, ptype) {
    if (kind === 'path') {
      const label = '@' + name
      return `<span class="mention-chip m-path" title="${label}"><span class="mc-t">${label}</span></span>`
    }
    const label = kind === 'session' ? splitSessionToken(name).title : name
    return `<span class="mention-chip ${kind === 'session' ? 'm-session' : 'm-plugin'}">${label}</span>`
  }

  // 选中引用的消息内形态（透明胶囊 + 文件图标 + 「引用自 <文件名>」，与输入栏内 .mention.ref 同族观感）。
  // path 来自已 esc 的文本（mdInline/renderUserText 入口已整体转义），此处不再二次转义。
  function quoteRefChipHtml(path, l0, l1) {
    const name = String(path).split('/').pop()
    const range = l0 ? ':' + l0 + (l1 && l1 !== l0 ? '-' + l1 : '') : ''
    return `<span class="mention-chip m-ref" title="${path}${range}"><span class="mc-ic">${MENTION_FILE_ICON}</span><span class="mc-t">引用自 ${name}${range}</span></span>`
  }
  // 回复引用的锚点胶囊（与输入栏内 .mention.ref 的回复态同一句话：label 两处必须一致）
  function quoteReplyChipHtml(idx, title) {
    const t = String(title || '').trim() || '本会话'
    const label = `引用自「${t}」· 第 ${idx} 条回复`
    return `<span class="mention-chip m-ref" title="${label}"><span class="mc-ic">${MENTION_SESSION_ICON}</span><span class="mc-t">${label}</span></span>`
  }
  // PDF 引用的锚点胶囊（与输入栏内 .mention.ref 的 pdf 态同一句话：label 两处必须一致）；
  // 位置粒度 = 路径 + 页码（跨页「第 s-e 页」，无页码退化为仅文件名）。
  function quotePdfChipHtml(path, p0, p1) {
    const name = String(path).split('/').pop()
    const pages = p0 ? ' · 第 ' + p0 + (p1 && p1 !== p0 ? '-' + p1 : '') + ' 页' : ''
    const label = `引用自 ${name}${pages}`
    return `<span class="mention-chip m-ref" title="${label}"><span class="mc-ic">${MENTION_FILE_ICON}</span><span class="mc-t">${label}</span></span>`
  }

export {
  MENTION_FILE_ICON,
  MENTION_PATH_RE,
  MENTION_PLUGIN_RE,
  MENTION_SESSION_ICON,
  MENTION_SESSION_RE,
  QUOTE_PDF_RE,
  QUOTE_REF_RE,
  QUOTE_REPLY_RE,
  mentionChipHtml,
  quotePdfChipHtml,
  quoteRefChipHtml,
  quoteReplyChipHtml,
  splitSessionToken,
}
