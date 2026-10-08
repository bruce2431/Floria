// 消息区交互与用户气泡内容：复制/用量弹层/图表/大图 lightbox + userBodyHtml/图片/文件卡片 + 时长与旁白渲染
import { mdHtml } from '../../core/markdown.js'
import { I } from '../../core/icons.js'
import { esc, toast } from '../../core/util.js'
import { messagesEl, live } from '../../engine/state.js'
import { stripQuoteBodies } from '../../inputbar/mention.js'
import { ICON_COPY, writeClipboard } from './usage.js'
/* @module chat/messages/msg-actions.js */
  // 消息复制（DSH MessageIconActions copy 语义）：取消息纯文本（剔除已处理折叠/变更卡/操作行/工具折叠），
  // writeClipboard 成功 → 图标换 check 1s（DSH 同款反馈窗口），失败 toast
  // 块级标签 → 复制文本补换行。textContent 会把相邻块级元素文本直接拼接（<p>a</p><p>b</p> → "ab"、
  // <br> 更无文本节点被吞），复制结果丢换行与空行；故按标签补：段落级补空行、列表/表格行补单换行。
  const COPY_PARA_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'DIV', 'TABLE'])
  const COPY_LINE_TAGS = new Set(['LI', 'TR', 'UL', 'OL', 'HR'])
  function copyTextOf(node) {
    let out = ''
    const walk = (n) => {
      if (n.nodeType === 3) { out += n.nodeValue; return }
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
  function messageCopyText(msgEl) {
    const clone = msgEl.cloneNode(true)
    clone.querySelectorAll('.done-fold, .change-card, .msg-actions, .tool-fold, .mention-x, .chart-bar, .chart-raw, script, style').forEach((el) => el.remove())
    return copyTextOf(clone).replace(/[ \t]+\n/g, '\n').trim()
  }
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.msg-copy') : null
    if (!btn || !messagesEl.contains(btn) || btn.classList.contains('copied')) return
    const msgEl = btn.closest('.msg')
    if (!msgEl) return
    const text = messageCopyText(msgEl)
    if (!text) return
    writeClipboard(text).then((ok) => {
      if (!ok) { toast('复制失败'); return }
      btn.classList.add('copied')
      btn.innerHTML = I.dshCheck
      btn.title = '已复制'
      btn.setAttribute('aria-label', '已复制')
      setTimeout(() => {
        if (!btn.isConnected) return
        btn.classList.remove('copied')
        btn.innerHTML = ICON_COPY
        btn.title = '复制'
        btn.setAttribute('aria-label', '复制')
      }, 1000)
    })
  })

  // 用量明细弹层（DSH 回复操作条「用量 X tok」按钮 → 点击弹出面板）：单开互斥（开本关它），点外区关闭。
  // 面板 .usage-pop 在 .msg-actions 内、与 .msg-usage 同属 .msg；按钮 aria-expanded 同步。
  function closeUsagePops(except) {
    messagesEl.querySelectorAll('.usage-pop:not([hidden])').forEach((p) => {
      if (p === except) return
      p.hidden = true
      const b = p.parentElement && p.parentElement.querySelector('.msg-usage')
      if (b) b.setAttribute('aria-expanded', 'false')
    })
  }
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.msg-usage') : null
    if (btn && messagesEl.contains(btn)) {
      const pop = btn.parentElement && btn.parentElement.querySelector('.usage-pop')
      if (!pop) return
      const open = pop.hidden
      closeUsagePops(pop)
      pop.hidden = !open
      btn.setAttribute('aria-expanded', open ? 'true' : 'false')
      return
    }
    if (e.target && e.target.closest && e.target.closest('.usage-pop')) return
    closeUsagePops(null)
  })

  // ---- 嵌入式图表（```chart 围栏，渲染链见 core/markdown.js）----
  // 「源码」切换（事件委托，innerHTML 重建不受影响）：.chart-embed.as-src 切 iframe ↔ 原文
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.chart-src') : null
    if (!btn || !messagesEl.contains(btn)) return
    const box = btn.closest('.chart-embed')
    if (!box) return
    btn.textContent = box.classList.toggle('as-src') ? '图表' : '源码'
  })

  // 高度自适应：sandbox iframe（opaque origin）内 BOOT 量 body/documentElement scrollHeight 上报
  // __chartH；按 e.source 精确匹配本页 .chart-frame 才采纳（其它窗口/preview iframe 伪造不进来），
  // 高度上限交给 CSS max-height，超出内部滚动。宽度变化（如侧栏拖宽）→ 内容高变 → 内部 ResizeObserver 重报，闭环。
  addEventListener('message', (e) => {
    const h = e.data && e.data.__chartH
    if (typeof h !== 'number' || !isFinite(h) || h <= 0) return
    for (const f of document.querySelectorAll('iframe.chart-frame')) {
      if (f.contentWindow !== e.source) continue
      const nh = Math.round(h)
      if (Math.abs((parseFloat(f.style.height) || 0) - nh) > 1) f.style.height = nh + 'px'
      return
    }
  })

  // 压缩/自动摘要标记：转录里压缩会把「会话续接」记成 user|text（后端已映射 role:'system'，
  // 标签「会话续接（自动摘要）」）。命中它 = 当前回合被压缩打断，但 agent 仍在干活——
  // 不应把它当成回合结束，否则「正在处理」被强收成「已处理」、后续思考/工具拆成断开的新段。
  // ⚠️ 存活代码勿删（2026-08-27 P2 复核纠正审查报告§C 结论）：shouldShowUserMessage 只剔 isMeta，
  // 而 isCompactSummary 续接记录不带 isMeta、conversationDisplay 亦无专门剔除 → 经网关 display /
  // 磁盘兜底同样以 role:'user' 到达前端；处理中命中即驱动 liveFoldBody 真空态「正在压缩会话中……」行，
  // 已收尾时静默吞行。英/中双正则分别兜官方原文与离线标签两种形态。
  const CONTINUED_RE = /This session is being continued from a previous conversation/i
  function isContinuationMsg(m) {
    if (m.role !== 'system' && m.role !== 'user') return false
    return m.blocks.some((b) => b.kind === 'text' && (CONTINUED_RE.test(b.text) || b.text.includes('会话续接')))
  }

  // 真实用户消息（带文本/图片，非纯工具回包）：开新段/新回合检测/处理中计时共用。
  // 合成 user（后台任务通知/对话中断等）已由源码 shouldShowUserMessage 剔除（A/B 路径）、
  // 离线路径由 server.mjs readSession 映射为 role:'system'（C 路径）——前端无需再判系统注入
  // 文本（isSynthText/SYNTH_RE 已于 2026-08-23 删除，见交接文档任务 1）。
  // 跨会话来件的来源行（2026-09-15 会话间协作）：气泡外一行灰字标识来自哪个会话。
  // 来源由 CLI 投影给定（DisplayMessage.fromSession，正文里的 `<session-message from=…>` 包装
  // 已在 conversationDisplay 剥离）——前端不解析包装、不复刻判据。无该字段 = 本地用户输入，
  // 渲染与本地消息完全一致（用户定案：气泡本体形态不变，只有气泡外多一行小字）。
  // 位置：插在 .body 之前（DOM 序 = 视觉上方），.msg 是列向 flex → 在文档流里占位（不做绝对定位，
  // 不参与气泡高度计算），故对既有高度/滚动占位（stageSync 贴顶位）零影响。
  function whoHtml(m) {
    const f = m && m.fromSession
    if (!f || !f.title) return ''
    return `<div class="who">来自 会话：${esc(String(f.title))}</div>`
  }

  function isRealUser(m) {
    if (m.role !== 'user') return false
    return m.blocks.some((b) => (b.kind === 'text' && b.text && b.text.trim()) || b.kind === 'image')
  }

  // 回合终止性 stopReason（2026-08-31）：官方 end_turn 之外，第三方商正常终止可能返回
  // 'stop_sequence'（CLI 未配置 stop_sequence 参数，纯文本回复即自然结束；jsonl 实证其后无
  // assistant 记录 = CLI 已按回合结束收尾）。只认 end_turn 会把这类已完成的回合刷新后误判
  // 「正在处理」重新计时、回复沉进折叠体（实测 2471f361/6f1f48fb）。'tool_use'/null 仍=处理中。
  function isEndStop(sr) {
    return sr === 'end_turn' || sr === 'stop_sequence'
  }

  // 用户气泡正文（2026-08-30 图片渲染，用户定案：图在气泡外）：
  // 带 imageId 的 image 块 → 气泡只出文本（剥掉文本里已渲染图的 [Image #N] 占位），
  // 图由 userImgsHtml 渲染在气泡框外；字节走网关 GET /gateway/image-cache/<会话uuid>/<id>
  // （复用 CLI processUserInput storeImages 落盘的 image-cache，display JSON 不塞 base64）。
  // 无 imageId（旧记录）→ 回落 [图片] 占位/纯文本；图已落盘后被清（会话重启
  // cleanupOldImageCaches 清非当前会话缓存）→ userImgsHtml onerror 出 [Image #N] 裸文本。
  function userBodyHtml(m) {
    const ids = []
    for (const b of m.blocks) if (b.kind === 'image' && b.imageId) ids.push(b.imageId)
    let txt = m.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('')
    if (ids.length) {
      txt = txt.replace(new RegExp('\\s*\\[Image #(' + ids.join('|') + ')\\]', 'g'), '')
    } else {
      // non-vision 模型：CLI 不把 image 块写进消息 content（processUserInput 丢弃，
      // 见 skipInputImages），display 链无 imageId → 占位符按 id 精确剥的旧条件失效，
      // 会以 [Image #N] 裸文本上屏。此处全剥：占位是 web 发送端内部令牌，对应图片
      // 已由 userImgsHtml 依同一批 id 渲染，不剥就重影。
      txt = txt.replace(/\s*\[Image #\d+\]/g, '')
    }
    // 文件占位（2026-09-12 文件上传）：[文件:<绝对路径>] 剥出渲染成文件卡片（userFilesHtml）
    txt = txt.replace(/\s*\[文件:[^\]]*\]/g, '')
    // 回复引用的原文块只给模型看，气泡里剥掉只留锚点胶囊（2026-09-28）
    txt = stripQuoteBodies(txt)
    const hasImg = m.blocks.some((b) => b.kind === 'image')
    return mdHtml(hasImg && !ids.length && !txt.trim() ? '[图片]' : txt)
  }

  // 文本里的 [Image #N] 占位（web 发送端拼的内部令牌）→ id 列表。CLI 落盘文件名即 N
  // （storeImages 按 pastedContents id 命名），故凭占位即可拼出 image-cache URL。
  function textImageIds(m) {
    const txt = m.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('')
    const out = []
    txt.replace(/\[Image #(\d+)\]/g, (_, n) => { out.push(Number(n)); return '' })
    return out
  }

  // 图片容器（用户 2026-08-30 定案：渲染在气泡外）：.msg 内、.body 后——.msg 无背景，
  // 视觉即气泡正下方右侧。图未落盘（404）→ onerror 替换为 [Image #N] 裸文本，不出破图
  //（用户定案「会话重启后图片不留盘，就仅渲染裸文本就好了」）。
  // id 来源两路：image 块 imageId（vision 模型，CLI 把图附进 content）；无 image 块时回落
  // 文本占位符（non-vision 模型，CLI 丢弃 image 块但 storeImages 仍无条件落盘）——保证
  // 「模型忽略图片」不等于「界面不显示图片」，切换识图模型后同一路径即正常可用。
  function userImgsHtml(m) {
    const ids = []
    for (const b of m.blocks) if (b.kind === 'image' && b.imageId) ids.push(b.imageId)
    if (!ids.length) ids.push(...textImageIds(m))
    if (!ids.length) return ''
    const imgs = ids.map((id) => `<img class="msg-img" loading="lazy" alt="图片" data-ph="[Image #${id}]" onerror="this.replaceWith(document.createTextNode(this.dataset.ph))" src="/gateway/image-cache/${live.curUuid || ''}/${id}">`).join('')
    return `<div class="msg-imgs">${imgs}</div>`
  }

  // 文件卡片（2026-09-12 文件上传，用户定案「像图片一样有对应的 UI」）：与图片同构——消息文本里
  // 的 [文件:<落盘绝对路径>] 占位剥出渲染成气泡外下方文件卡片（图标+文件名，title=完整路径，
  // 点击复制路径供粘贴他用）。文件已落盘（uploads/ 不随会话清理），无图片的 404/裸文本回落问题。
  function fileCardsHtml(paths) {
    const cards = paths.map((p) => {
      const name = String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
      return `<span class="msg-file" role="button" data-path="${esc(p)}" title="${esc(p)}">${I.dshFile}<span class="mf-name">${esc(name)}</span></span>`
    }).join('')
    return `<div class="msg-files">${cards}</div>`
  }
  function userFilesHtml(m) {
    const txt = m.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('')
    const paths = []
    txt.replace(/\[文件:([^\]]+)\]/g, (_, p) => { paths.push(p.trim()); return '' })
    return paths.length ? fileCardsHtml(paths) : ''
  }
  // 文件卡片点击 = 复制落盘路径（事件委托，innerHTML 重建不受影响）
  document.addEventListener('click', (e) => {
    const c = e.target && e.target.closest ? e.target.closest('.msg-file') : null
    if (!c || !messagesEl.contains(c)) return
    writeClipboard(c.dataset.path || '').then((ok) => toast(ok ? '已复制路径' : '复制失败'))
  })

  // 大图预览 lightbox（2026-08-30 用户定案：单击缩略图看大图）：单例覆盖层，
  // src 复用缩略图同 URL（网关 Cache-Control private 1d，字节已缓存零请求）；
  // 点击任意处 / Esc 关闭。事件委托 document 级绑一次，覆盖历史/实时/SSE 全渲染路径。
  function ensureLightbox() {
    let lb = document.getElementById('img-lightbox')
    if (lb) return lb
    lb = document.createElement('div')
    lb.id = 'img-lightbox'
    lb.innerHTML = '<img alt="大图预览">'
    lb.addEventListener('click', () => lb.classList.remove('on'))
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') lb.classList.remove('on') })
    document.body.appendChild(lb)
    return lb
  }
  document.addEventListener('click', (e) => {
    const im = e.target.closest && e.target.closest('.msg-img')
    if (!im) return
    const lb = ensureLightbox()
    lb.querySelector('img').src = im.currentSrc || im.src
    lb.classList.add('on')
  })

  // 已处理时长：10m 50s 风格
  function fmtDur(sec) {
    if (!(sec > 0)) return ''
    if (sec < 60) return sec + 's'
    const m = Math.floor(sec / 60)
    const s = sec % 60
    if (m < 60) return s ? m + 'm ' + s + 's' : m + 'm'
    const h = Math.floor(m / 60)
    return h + 'h ' + (m % 60) + 'm'
  }

  // 思考/旁白文本：无气泡框，浅灰小字（收在「已处理」折叠区内）
  function processTextHtml(text) {
    return `<div class="done-think">${mdHtml(text)}</div>`
  }

