// Markdown 渲染 + relTime（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { esc } from './util.js'
import { MENTION_PATH_RE, MENTION_PLUGIN_RE, MENTION_SESSION_RE, QUOTE_PDF_RE, QUOTE_REF_RE, QUOTE_REPLY_RE, mentionChipHtml, quotePdfChipHtml, quoteRefChipHtml, quoteReplyChipHtml } from './mention-syntax.js'
/* @module core/markdown.js */
  // ---------- Markdown 渲染（安全：mdHtml 入口先整体转义，再生成白名单 HTML） ----------
  const MD_MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Consolas, 'Courier New', monospace"
  const MD_LINK_OK = (u) => /^(https?:)?\/\//.test(u) || /^[a-z0-9][a-z0-9./_-]*$/i.test(u)
  // AI 生成图代号（2026-10-03）：markdown ![](code) 里的 code 只允许「文件名.ext」白名单
  // （无 / 无 . 段 → 防路径穿越），真实取图 URL 由注入的 resolver 拼（见 messages.js 注册）。
  const MD_IMG_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(png|jpe?g|webp|gif)$/
  let mdImgResolver = null
  const setImageSrcResolver = (fn) => { mdImgResolver = fn }

  // ---------- 数学公式（2026-10-06，仅 web；CLI 侧不渲染，Markdown.tsx 不挂 math 扩展） ----------
  // 支持 $…$ 行内、$$…$$ 块级，另兼容 \(…\) 行内 / \[…\] 块级。抽取必须发生在 esc 之前、且在原文上——
  // esc 会把 & < > " ' 转义，而 LaTeX 里的 a<b、& 对齐符、\alpha 需原样交给 KaTeX。
  // 做法：先把围栏/行内代码遮罩（防公式误伤代码），再抽公式渲染成 HTML 存表、原文留 \u0002N\u0002 占位；
  // 占位符全为控制字符，可安全穿过 esc。块级占位前后补 \n 独占一行，由 mdHtml 行循环还原为
  // <div class="math-block">；行内占位留在段落文字里，由 mdInline 末尾还原。katex 未加载则整段跳过
  // （$…$ 原样显示）。KaTeX 输出自身安全（trust 默认 false + 整体 esc），可直接进 innerHTML。
  const MATH_PH = /\u0002(\d+)\u0002/g
  let mathStore = null
  function renderMath(body, displayMode) {
    try {
      return window.katex.renderToString(body, { displayMode, throwOnError: false, strict: false, output: 'html' })
    } catch (_) { return null }
  }
  function extractMath(src) {
    mathStore = null
    if (typeof window === 'undefined' || !window.katex) return src
    mathStore = []
    const masked = []
    let s = src.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (m) => { masked.push(m); return `\u0003${masked.length - 1}\u0003` })
    s = s.replace(/`[^`\n]*`/g, (m) => { masked.push(m); return `\u0003${masked.length - 1}\u0003` })
    const put = (body, block) => {
      const html = renderMath(body, block)
      if (!html) return null
      mathStore.push({ html, src: body, block })
      const ph = `\u0002${mathStore.length - 1}\u0002`
      return block ? `\n${ph}\n` : ph
    }
    // 块级先于行内（否则 $$ 会被 $ 抢占）
    s = s.replace(/\$\$([\s\S]+?)\$\$/g, (m, body) => put(body, true) ?? m)
    s = s.replace(/\\\[([\s\S]+?)\\\]/g, (m, body) => put(body, true) ?? m)
    s = s.replace(/\\\(([\s\S]+?)\\\)/g, (m, body) => put(body, false) ?? m)
    // 行内 $…$：单行内、非空、首尾不留空白、不紧跟数字（避免误吃 $5 之类货币）
    s = s.replace(/\$([^$\n]+?)\$/g, (m, body) => (/^\s|\s$/.test(body) || /^\d/.test(body) ? m : (put(body, false) ?? m)))
    return s.replace(/\u0003(\d+)\u0003/g, (_, i) => masked[+i])
  }
  function restoreMath(s) {
    return mathStore ? s.replace(MATH_PH, (_, i) => mathStore[+i].html) : s
  }
  // data-md 复制用：把公式占位符还原成「$$原始 LaTeX$$」（供 md 源码复制），src 未 esc → 需 esc 一次
  // 才能安全落进属性。s 本身已是 esc 后文本（mdHtml 行循环里），故整体仍为「esc 一次」口径。
  function phAttr(s) {
    return mathStore ? String(s).replace(MATH_PH, (_, i) => {
      const m = mathStore[+i]
      return m.block ? '$$' + esc(m.src) + '$$' : '$' + esc(m.src) + '$'
    }) : String(s)
  }
  // 块级原始 md 挂载：raw 必须是 mdHtml 入口 esc 之后的文本（公式占位已由 phAttr 还原）。
  // 属性值经浏览器 DOM 解析解码一次 → el.dataset.md 即原始 md 文本（esc 与解码互相抵消）。
  function mdAttr(raw) {
    return raw ? ` data-md="${phAttr(raw)}"` : ''
  }

  function mdInline(s) {
    // s 必须是已转义文本（来自 mdHtml 入口）
    const codes = []
    s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000' })
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>')
    // 图片代号（AI 生成图）：![](文件名.png) → <img>，code 过白名单 + resolver 拼取图 URL；
    // 不匹配或无 resolver 则保留原文（不兜底）。必须在下方链接替换之前，否则被拆成 ! + <a>。
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, code) => {
      if (!mdImgResolver || !MD_IMG_CODE.test(code)) return `![${alt}](${code})`
      const url = mdImgResolver(code)
      if (!url) return `![${alt}](${code})`
      return `<img class="msg-img md-img" loading="lazy" alt="${alt}" src="${esc(url)}">`
    })
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => (MD_LINK_OK(u) ? `<a href="${u}" target="_blank" rel="noopener">${t}</a>` : t))
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, p, u) => p + `<a href="${u}" target="_blank" rel="noopener">${u}</a>`)
    // @ 提及令牌 → chip（[插件:名称] / [会话:名称]，名称已转义）。
    // ⚠️ 必须在行内代码还原（下一行）之前替换：行内代码 `[插件:X]` 已抽成占位符 \u0000N\u0000，
    // 令牌替换命中不到代码内文本，避免 chip 嵌套进 <code>（白胶囊+灰代码气泡叠一起）。
    s = s.replace(MENTION_PLUGIN_RE, (_, n) => mentionChipHtml('plugin', n))
         .replace(MENTION_SESSION_RE, (_, n) => mentionChipHtml('session', n))
         .replace(MENTION_PATH_RE, (_, t, p) => mentionChipHtml('path', p, t === '目录' ? 'dir' : 'file'))
         .replace(QUOTE_REF_RE, (_, p, a, b) => quoteRefChipHtml(p, a, b))
         .replace(QUOTE_REPLY_RE, (_, i, t) => quoteReplyChipHtml(i, t))
         .replace(QUOTE_PDF_RE, (_, p, a, b) => quotePdfChipHtml(p, a, b))
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`)
    return restoreMath(s)
  }
  // 单段行内文本 → HTML（mdHtml 行循环里对每行做的事，抽成可独立调用的一口）。
  // 顺序与 mdHtml 入口一致且不可换：extractMath（原文上抽公式，先于 esc）→ esc → mdInline（末尾 restoreMath）。
  // 消费者：work.js 编辑区表格 widget 的单元格渲染器（CM.setTableCellRenderer(mdInlineText)）。
  function mdInlineText(s) { return mdInline(esc(extractMath(String(s == null ? '' : s)))) }
  function mdHtml(src) {
    if (!src) return ''
    const lines = esc(extractMath(String(src))).split('\n')
    let html = ''
    let para = []
    let paraRaw = [] // 段落原始行（esc 后），供 data-md 还原 md 源码
    const flushPara = () => {
      if (para.length) {
        html += `<p${mdAttr(paraRaw.join('\n'))}>${para.join('<br>')}</p>`
        para = []
        paraRaw = []
      }
    }
    let inCode = false, codeLang = '', codeBuf = []
    // ---- 嵌入式图表（```chart 双段围栏，2026-09-12 定案）----
    // 契约（全局根 CLAUDE.md）：模型输出 ```chart 围栏，内含 %%html / %%ascii 两个哨兵段（同一图表的两种等价表达）。
    // web 取 %%html 段进 sandbox iframe（opaque origin，BOOT 上报高度），%%ascii 段弃用（「源码」按钮看全文）；
    // CLI 反向过滤只留 ascii（src/components/Markdown.tsx stripChartHtml）。普通 ```html 围栏不受影响。
    // srcdoc 安全链：mdHtml 入口已整体 esc（含引号）→ 属性不破出；浏览器解析 srcdoc 实体解码一次，
    // iframe 文档恰好还原为模型原始 HTML（esc 链与属性解码互相抵消，语义透明）；BOOT 是自有串，esc 一次同理。
    const CHART_BOOT = '<style>html,body{margin:0;padding:0;background:transparent}</style>' +
      '<script>(function(){var p=function(){try{var b=document.body;parent.postMessage({__chartH:Math.max(b?b.scrollHeight:0,document.documentElement.scrollHeight)},"*")}catch(_){}};' +
      'if(window.ResizeObserver)new ResizeObserver(p).observe(document.documentElement);addEventListener("load",p);p()})()</scr' + 'ipt>'
    // 哨兵行（行首精确匹配 %%html / %%ascii）拆段；缺段由 closeCode 降级回代码块
    function chartSplit(buf) {
      let mode = null, hasHtml = false, hasAscii = false, html = [], ascii = []
      for (const line of buf) {
        const t = line.trim()
        if (t === '%%html') { mode = 'html'; hasHtml = true; continue }
        if (t === '%%ascii') { mode = 'ascii'; hasAscii = true; continue }
        if (mode === 'html') html.push(line)
        else if (mode === 'ascii') ascii.push(line)
      }
      return { html: html.join('\n'), ascii: ascii.join('\n'), hasHtml, hasAscii }
    }
    // closed=false（流式未闭合围栏的 EOF 收口）恒回退代码块：闭合那一帧才切 iframe，防流式每 delta 重建闪烁
    const closeCode = (closed) => {
      if (!inCode) return
      const raw = codeBuf.join('\n')
      const fence = '```' + codeLang + '\n' + raw + '\n```' // data-md：围栏原文重建
      const langTag = codeLang ? `<span class="code-lang">${codeLang}</span>` : ''
      const sec = (codeLang === 'chart' && closed) ? chartSplit(codeBuf) : null
      if (sec && sec.hasHtml && sec.html.trim()) {
        html += `<div class="chart-embed"${mdAttr(fence)}><div class="chart-bar"><span class="chart-tag">CHART</span><button type="button" class="chart-src" title="切换 图表/源码">源码</button></div><iframe class="chart-frame" sandbox="allow-scripts" srcdoc="${sec.html}${esc(CHART_BOOT)}"></iframe><pre class="chart-raw"><code>${raw}</code></pre></div>`
      } else {
        html += `<div class="code-block"${mdAttr(fence)}><pre><code>${raw}</code></pre>${langTag}</div>`
      }
      codeBuf = []; codeLang = ''; inCode = false
    }
    let list = null
    const closeList = () => { if (list) { html += `</${list}>`; list = null } }
    const isSep = (r) => { const x = r.replace(/\|/g, '').replace(/[\s:-]/g, ''); return x === '' && r.includes('-') }
    const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const t = line.trim()
      if (!t) { flushPara(); closeList(); continue }
      if (/^```/.test(t)) {
        if (inCode) { closeCode(true) } else { inCode = true; codeLang = t.slice(3).trim() }
        continue
      }
      if (inCode) { codeBuf.push(line); continue }
      // 块级公式占位（extractMath 已渲染成 HTML 存 mathStore）：独占一行 → 输出块级容器
      const mblk = /^\u0002(\d+)\u0002$/.exec(t)
      if (mblk) { flushPara(); closeList(); const mm = mathStore[+mblk[1]]; html += `<div class="math-block"${mdAttr('$$' + esc(mm.src) + '$$')}>${mm.html}</div>`; continue }
      const h = /^(#{1,4})\s+(.*)$/.exec(t)
      if (h) { flushPara(); closeList(); html += `<h${h[1].length}${mdAttr(t)}>${mdInline(h[2])}</h${h[1].length}>`; continue }
      if (t.startsWith('&gt;')) {
        flushPara(); closeList()
        html += `<blockquote${mdAttr(t)}>${mdInline(t.replace(/^&gt;\s?/, ''))}</blockquote>`
        continue
      }
      if (/^[-*+]\s+/.test(t)) {
        flushPara()
        if (list !== 'ul') { closeList(); list = 'ul'; html += '<ul>' }
        html += `<li${mdAttr(t)}>${mdInline(t.replace(/^[-*+]\s+/, ''))}</li>`
        continue
      }
      if (/^\d+[.)]\s+/.test(t)) {
        flushPara()
        if (list !== 'ol') { closeList(); list = 'ol'; html += '<ol>' }
        html += `<li${mdAttr(t)}>${mdInline(t.replace(/^\d+[.)]\s+/, ''))}</li>`
        continue
      }
      if (/^(-{3,}|\*{3,})$/.test(t)) { flushPara(); closeList(); html += `<hr${mdAttr(t)}>`; continue }
      if (t.startsWith('|') && lines[i + 1] && isSep(lines[i + 1].trim())) {
        flushPara(); closeList()
        const tbl = [t]
        let tHtml = `<table><thead><tr>` + cells(t).map((c) => `<th>${mdInline(c)}</th>`).join('') + '</tr></thead><tbody>'
        i += 1
        tbl.push(lines[i])
        while (i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) {
          i += 1
          tbl.push(lines[i])
          tHtml += `<tr>` + cells(lines[i]).map((c) => `<td>${mdInline(c)}</td>`).join('') + '</tr>'
        }
        tHtml += '</tbody></table>'
        html += `<div class="md-table"${mdAttr(tbl.join('\n'))}>${tHtml}</div>`
        continue
      }
      para.push(mdInline(t)); paraRaw.push(t)
    }
    flushPara(); closeCode(false); closeList()
    return html
  }

  // ---------- data-md 消费：复制方向（2026-10-09） ----------
  // mdHtml 给每个块级元素挂了 data-md=原始 md 片段（见 mdAttr），复制据此还原 md 源码：
  //  · messageMd(root)  → root 内全部块级 data-md 按序拼接（复制按钮用，root 传该消息 .body）
  //  · selectionMd(sel) → 选区整块覆盖的块用原文，块内碎片无一一对应关系返回 null（调用方按纯文本降级）
  // 全局唯一的 copy 拦截在 inputbar/ctx-meter.js，两函数即其判据来源（不再另起监听，避免双监听互相覆盖）。
  const COPY_PARA_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'DIV', 'TABLE'])
  const COPY_LINE_TAGS = new Set(['LI', 'TR', 'UL', 'OL', 'HR'])
  // 降级文本：textContent 会把相邻块级元素文本直接拼接（<p>a</p><p>b</p> → "ab"、<br> 更被吞），
  // 故按标签补换行——段落级补空行、列表/表格行补单换行。接受元素/DocumentFragment（nodeType 11）。
  function copyTextOf(node) {
    let out = ''
    const walk = (n) => {
      if (n.nodeType === 3) { out += n.nodeValue; return }
      if (n.nodeType === 11) { n.childNodes.forEach(walk); return }
      if (n.nodeType !== 1) return
      if (n.tagName === 'BR') { out += '\n'; return }
      const sep = COPY_PARA_TAGS.has(n.tagName) ? '\n\n' : (COPY_LINE_TAGS.has(n.tagName) ? '\n' : '')
      if (sep && out && !out.endsWith('\n')) out += sep
      n.childNodes.forEach(walk)
      if (sep && out && !out.endsWith('\n')) out += sep
    }
    walk(node)
    return out
  }
  // 最外层带 data-md 的块（最近的 data-md 祖先即自身 → 嵌套里的顶层块，父块+子块不重复计）
  function topDataMd(root) {
    return Array.from(root.querySelectorAll('[data-md]')).filter((el) => el.closest('[data-md]') === el)
  }
  // 块间拼接：同属一个列表的相邻 LI 之间单换行，其余块之间空行（保持 md 分块语义）
  function joinMdBlocks(els, pick) {
    const parts = []
    els.forEach((el) => { const piece = pick(el); if (piece) parts.push({ el, piece }) })
    let out = ''
    for (let i = 0; i < parts.length; i++) {
      if (i) out += (parts[i].el.tagName === 'LI' && parts[i - 1].el.tagName === 'LI') ? '\n' : '\n\n'
      out += parts[i].piece
    }
    return out
  }
  function messageMd(root) {
    return root ? joinMdBlocks(topDataMd(root), (el) => el.dataset.md).trim() : ''
  }
  // 块内容的起/止边界点：降到最后一级叶子节点。不能用 selectNodeContents——它把边界放在
  // 元素层 (el,0)/(el,len)，那两点在内容「外侧」，文本选区的边界永远在内容「内侧」，两者
  // 比较恒不等 ⇒ 覆盖判定必然失败（整段选中也会被当成碎片降级成渲染文本）。
  function contentEdges(el) {
    let a = el
    let b = el
    while (a.firstChild) a = a.firstChild
    while (b.lastChild) b = b.lastChild
    return [[a, 0], [b, b.nodeType === 3 ? b.nodeValue.length : b.childNodes.length]]
  }
  // 某块是否被 range 完整覆盖：range 同时覆盖该块的起、止两个内容边界点即算完整（边界贴合含在内）
  function isCoveredByRange(range, el) {
    const [[sn, so], [en, eo]] = contentEdges(el)
    try {
      return range.isPointInRange(sn, so) && range.isPointInRange(en, eo)
    } catch (_) { return false }
  }
  // 选区与某块的交集片段（碎片降级文本用）：两端各自向块内容边界收拢，越界/异树异常交回 null
  function intersectFragment(range, el) {
    const [[sn, so], [en, eo]] = contentEdges(el)
    try {
      const startAfter = range.comparePoint(sn, so) === -1  // 选区起点落于块内容起点之后
      const endWithin = range.comparePoint(en, eo) !== 1    // 选区终点未越过块内容终点
      const r = document.createRange()
      r.setStart(startAfter ? range.startContainer : sn, startAfter ? range.startOffset : so)
      r.setEnd(endWithin ? en : range.endContainer, endWithin ? eo : range.endOffset)
      return r.cloneContents()
    } catch (_) { return null }
  }
  function selectionMd(sel) {
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null
    const range = sel.getRangeAt(0)
    const els = topDataMd(document).filter((el) => range.intersectsNode(el))
    if (!els.length) return null
    const text = joinMdBlocks(els, (el) => {
      if (isCoveredByRange(range, el)) return el.dataset.md
      const frag = intersectFragment(range, el)
      return frag ? copyTextOf(frag) : ''
    }).trim()
    return text || null
  }

  function relTime(ms) {
    if (!ms) return ''
    const diff = Date.now() - ms
    const m = Math.floor(diff / 60000)
    if (m < 1) return '刚刚'
    if (m < 60) return `${m} 分钟前`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h} 小时前`
    const d = Math.floor(h / 24)
    if (d < 30) return `${d} 天前`
    const dt = new Date(ms)
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
  }

export {
  MD_LINK_OK,
  MD_MONO,
  mdHtml,
  mdInline,
  messageMd,
  relTime,
  selectionMd,
  setImageSrcResolver,
}
