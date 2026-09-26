// Markdown 渲染 + relTime（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { esc } from './state.js'
import { MENTION_PATH_RE, MENTION_PLUGIN_RE, MENTION_SESSION_RE, mentionChipHtml } from '../inputbar/mention.js'
  // ---------- Markdown 渲染（安全：mdHtml 入口先整体转义，再生成白名单 HTML） ----------
  const MD_MONO = "ui-monospace, SFMono-Regular, 'SF Mono', Consolas, 'Courier New', monospace"
  const MD_LINK_OK = (u) => /^(https?:)?\/\//.test(u) || /^[a-z0-9][a-z0-9./_-]*$/i.test(u)
  function mdInline(s) {
    // s 必须是已转义文本（来自 mdHtml 入口）
    const codes = []
    s = s.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return '\u0000' + (codes.length - 1) + '\u0000' })
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>')
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => (MD_LINK_OK(u) ? `<a href="${u}" target="_blank" rel="noopener">${t}</a>` : t))
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (_, p, u) => p + `<a href="${u}" target="_blank" rel="noopener">${u}</a>`)
    // @ 提及令牌 → chip（[插件:名称] / [会话:名称]，名称已转义）。
    // ⚠️ 必须在行内代码还原（下一行）之前替换：行内代码 `[插件:X]` 已抽成占位符 \u0000N\u0000，
    // 令牌替换命中不到代码内文本，避免 chip 嵌套进 <code>（白胶囊+灰代码气泡叠一起）。
    s = s.replace(MENTION_PLUGIN_RE, (_, n) => mentionChipHtml('plugin', n))
         .replace(MENTION_SESSION_RE, (_, n) => mentionChipHtml('session', n))
         .replace(MENTION_PATH_RE, (_, t, p) => mentionChipHtml('path', p, t === '目录' ? 'dir' : 'file'))
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`)
    return s
  }
  function mdHtml(src) {
    if (!src) return ''
    const lines = esc(String(src)).split('\n')
    let html = ''
    let para = []
    const flushPara = () => { if (para.length) { html += `<p>${para.join('<br>')}</p>`; para = [] } }
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
      const langTag = codeLang ? `<span class="code-lang">${codeLang}</span>` : ''
      const sec = (codeLang === 'chart' && closed) ? chartSplit(codeBuf) : null
      if (sec && sec.hasHtml && sec.html.trim()) {
        html += `<div class="chart-embed"><div class="chart-bar"><span class="chart-tag">CHART</span><button type="button" class="chart-src" title="切换 图表/源码">源码</button></div><iframe class="chart-frame" sandbox="allow-scripts" srcdoc="${sec.html}${esc(CHART_BOOT)}"></iframe><pre class="chart-raw"><code>${raw}</code></pre></div>`
      } else {
        html += `<div class="code-block"><pre><code>${raw}</code></pre>${langTag}</div>`
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
      const h = /^(#{1,4})\s+(.*)$/.exec(t)
      if (h) { flushPara(); closeList(); html += `<h${h[1].length}>${mdInline(h[2])}</h${h[1].length}>`; continue }
      if (t.startsWith('&gt;')) {
        flushPara(); closeList()
        html += `<blockquote>${mdInline(t.replace(/^&gt;\s?/, ''))}</blockquote>`
        continue
      }
      if (/^[-*+]\s+/.test(t)) {
        flushPara()
        if (list !== 'ul') { closeList(); list = 'ul'; html += '<ul>' }
        html += `<li>${mdInline(t.replace(/^[-*+]\s+/, ''))}</li>`
        continue
      }
      if (/^\d+[.)]\s+/.test(t)) {
        flushPara()
        if (list !== 'ol') { closeList(); list = 'ol'; html += '<ol>' }
        html += `<li>${mdInline(t.replace(/^\d+[.)]\s+/, ''))}</li>`
        continue
      }
      if (/^(-{3,}|\*{3,})$/.test(t)) { flushPara(); closeList(); html += '<hr>'; continue }
      if (t.startsWith('|') && lines[i + 1] && isSep(lines[i + 1].trim())) {
        flushPara(); closeList()
        html += '<div class="md-table"><table><thead><tr>' + cells(t).map((c) => `<th>${mdInline(c)}</th>`).join('') + '</tr></thead><tbody>'
        i += 1
        while (i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) {
          i += 1
          html += '<tr>' + cells(lines[i]).map((c) => `<td>${mdInline(c)}</td>`).join('') + '</tr>'
        }
        html += '</tbody></table></div>'
        continue
      }
      para.push(mdInline(t))
    }
    flushPara(); closeCode(false); closeList()
    return html
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
  relTime,
}
