// 选中文本 → 松开鼠标 → 引用浮窗（2026-09-28）

import { I } from '../core/icons.js'
import { esc, inputEl, messagesEl, state } from '../core/state.js'
import { findSession } from '../core/sessions.js'
import { quoteActions } from '../views/registry.js'
import { gwSend, syncGwSend } from './send.js'
  // ---------- 选中引用（quote）----------
  // 两个来源：① #work-editor（只读编辑区，引用**文件 + 行范围**）② #chat-scroll（消息流，引用**会话锚点 + 原文**）。
  // 两条链的落地形态不同（用户定案）：文件引用只给位置——模型自己 Read 该文件；回复引用必须带原文——
  // 回复不属于任何文件，没有位置可查。两者都在输入栏里显示成同一族「引用胶囊」（透明胶囊 + 图标）。
  //
  // 浮窗竖排菜单 = 两个动作（浅色，2026-09-28 定案）：上行「使用 AI 编辑」= 只把引用胶囊塞进主输入栏，
  // 用户补完话术自己发；下行内嵌输入栏（话术）+ 尾部发送钮 = 立即把「引用 + 话术」作为一条消息发出。
  // 两者共用 insertRefChip，发送一律走 inputbar/send.js 的 gwSend（唯一发送口，不另起链路）。
  //
  // 唤出手势 = **松开鼠标那一刻**（document mouseup，主键；用户 2026-09-28 定案）——右键不再被拦截，
  // 浏览器原生菜单照旧弹出。选区必须在**开浮窗那一刻快照**：点浮窗里的输入框会把 DOM 选区清掉，
  // 靠 selection 现场取已来不及。
  //
  // 2026-09-28 扩展（项目注册）：浮窗改为「**内置动作 + 当前项目申报动作**分表合流」。动作表由项目在
  // `<项目>/.claude/preview/preview.json` 的 `quoteActions` 段静态申报（与 cards 同构、同一拉取点），
  // 经 views/registry.js 的 registerQuoteActions 落表、本模块 quoteActions() 读。第二来源 = 项目预览页
  // （iframe）——它的选区在宿主看来不可达（跨文档 getSelection 不达），故由预览页 postMessage 自报：
  // `floria-quote-open`（开窗）/ `floria-quote-close`（关窗），宿主点申报动作行回发 `floria-quote-action`。
  // 执行逻辑**留在项目页面自己的运行上下文**（要调 Pj13 的 API 与 pdf 状态），宿主只回发 id、不代执行。

  // 可引用区（选区落在其中才认，其它区域不唤出）
  const QUOTE_ZONE = '#chat-scroll, #work-editor'

  let quotePop = null
  let quoteSkipNextUp = false // 「点浮窗外关窗」的那一下 mousedown 已消费：紧随的 mouseup 不得重开

  // ---------- 1. 选区 → 快照 ----------
  function quoteBase(p) {
    return String(p || '').split('/').pop()
  }
  // 编辑区行号唯一来源 = DOM 本身：
  //  · 纯文本预览（pre.wk-code）是**原样**文本，Range 起点/终点的字符偏移换算行号，精确到行；
  //  · markdown 预览渲染成 HTML（**格式符已丢、文本经过变换**，拿渲染文本回查原文必然对不上——
  //    「**加粗**：」这类选中就跨在格式符边界上），故行号由渲染期落下的行锚 `data-l` 提供
  //    （core/markdown.js mdHtml 第二参数，每源行一个锚）。
  // 拿不到 → null（令牌退化为纯路径，不编造行号）。
  const QUOTE_LINE_ATTR = 'data-l'
  function quoteLineOf(node) {
    let el = node && node.nodeType === 1 ? node : node && node.parentElement
    while (el) {
      const v = el.getAttribute && el.getAttribute(QUOTE_LINE_ATTR)
      if (v) return Number(v)
      el = el.parentElement
    }
    return 0
  }
  function quoteEditorLines(range) {
    const body = $('wk-ed-body')
    const pre = body && body.querySelector('pre.wk-code')
    const n = pre && pre.firstChild
    if (n && n.nodeType === 3 && range.startContainer === n) {
      const s = range.startOffset
      const e = range.endContainer === n ? range.endOffset : n.nodeValue.length
      return [n.nodeValue.slice(0, s).split('\n').length, n.nodeValue.slice(0, e).split('\n').length]
    }
    const a = quoteLineOf(range.startContainer)
    const b = quoteLineOf(range.endContainer)
    return a && b ? [Math.min(a, b), Math.max(a, b)] : null
  }
  // 快照构造的唯一入口，**两条来源共用**（桌面 mouseup 现场取选区 / 触屏引擎收编的选区）：
  // 入参恒为 Range，不读 window.getSelection —— 触屏那条路的 Range 是程序化设回的，与「当前选区」同源但
  // 未必同一对象（且收编靠的就是先清后设），读全局选区会在时序上分叉出第二份真源。
  function quoteSnapOfRange(range) {
    if (!range || range.collapsed) return null
    const text = range.toString()
    if (!text.trim()) return null
    const node = range.startContainer
    const el = node.nodeType === 1 ? node : node.parentElement
    if (!el || !el.closest || !el.closest(QUOTE_ZONE)) return null
    const rect = range.getBoundingClientRect()
    const inEditor = el.closest('#work-editor')
    if (inEditor) {
      // 空态提示行 / 未打开文件：没有可引用的文件位置
      if (!state.workFile) return null
      const lines = quoteEditorLines(range)
      return { kind: 'file', text, rect, file: state.workFile, proj: state.workProj, l0: lines && lines[0], l1: lines && lines[1] }
    }
    const msg = el.closest('.msg')
    if (!msg) return null
    const all = [...messagesEl.querySelectorAll('.msg')]
    const idx = all.indexOf(msg) + 1
    const cur = state.currentHash ? findSession(state.currentHash) : null
    return { kind: 'reply', text, rect, title: (cur && cur.title) || '本会话', idx }
  }
  // 桌面路径：现场取 window.getSelection 的那一条 Range（触屏路径不走这里，见 inputbar/quote-touch.js）
  function quoteSnapOf() {
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null
    return quoteSnapOfRange(sel.getRangeAt(0))
  }

  // ---------- 2. 引用胶囊（输入栏内）----------
  // 复用 .mention 类：× 删除与退格删除由 ctx-meter.js 的既有委托按 .mention 统一处理，勿另写一套。
  function insertRefChip(snap) {
    const chip = document.createElement('span')
    chip.className = 'mention ref'
    chip.contentEditable = 'false'
    chip.dataset.kind = 'ref'
    chip.dataset.rkind = snap.kind
    let inner
    if (snap.kind === 'pdf') {
      // PDF 引用（2026-09-28）：位置 = 路径 + 页码（跨页 s-e）。**原文必须进消息**（PDF 定位不精确、
      // 大 PDF 必须给页码提示、选中原文才是要引用的 payload）⇒ dataset.quote 与回复引用同款带上。
      chip.dataset.file = snap.file
      chip.dataset.proj = snap.proj || ''
      chip.dataset.quote = snap.text
      if (snap.p0) { chip.dataset.p0 = String(snap.p0); if (snap.p1) chip.dataset.p1 = String(snap.p1) }
      const pages = snap.p0 ? ' · 第 ' + snap.p0 + (snap.p1 && snap.p1 !== snap.p0 ? '-' + snap.p1 : '') + ' 页' : ''
      inner = `<span class="m-ic">${I.dshFile}</span><span class="m-nm">引用自 ${esc(quoteBase(snap.file))}${pages}</span>`
    } else if (snap.kind === 'file') {
      chip.dataset.file = snap.file
      chip.dataset.proj = snap.proj || ''
      if (snap.l0) { chip.dataset.l0 = String(snap.l0); chip.dataset.l1 = String(snap.l1) }
      inner = `<span class="m-ic">${I.dshFile}</span><span class="m-nm">引用自 ${esc(quoteBase(snap.file))}</span>`
    } else {
      chip.dataset.quote = snap.text
      chip.dataset.title = snap.title || '本会话'
      chip.dataset.idx = String(snap.idx || 0)
      inner = `<span class="m-ic">${I.msg}</span><span class="m-nm">引用自「${esc(snap.title || '本会话')}」· 第 ${snap.idx} 条回复</span>`
    }
    chip.innerHTML = inner + '<span class="m-x" title="删除">×</span>'
    // 追加到输入栏末尾：与 @ chip 一样前后各留一个 nbsp 作分隔（序列化时还原成空格）
    inputEl.appendChild(document.createTextNode('\u00A0'))
    inputEl.appendChild(chip)
    inputEl.appendChild(document.createTextNode('\u00A0'))
    syncGwSend()
    return chip
  }

  // ---------- 3. 浮窗 ----------
  function closeQuotePop() {
    if (quotePop) { quotePop.remove(); quotePop = null }
  }

  // 立即发送：引用 + 浮窗话术进输入栏 → gwSend（输入栏原有草稿一并发出，不丢内容）
  async function quoteSendNow(snap) {
    if (!snap) return
    const note = (quotePop.querySelector('.qp-in').value || '').trim()
    insertRefChip(snap)
    if (note) {
      inputEl.appendChild(document.createTextNode(' '))
      inputEl.appendChild(document.createTextNode(note))
    }
    closeQuotePop()
    inputEl.focus()
    await gwSend()
  }
  // 只入输入栏（「使用 AI 编辑」行 / 触屏选中栏同款语义）：不发送，关浮窗把焦点交还输入栏，
  // **光标落在胶囊之后**（用户 2026-09-28 定案：接着打字就是给这条引用的说明，光标不该留在胶囊前面）。
  function quoteStash(snap) {
    if (!snap) return
    const chip = insertRefChip(snap)
    closeQuotePop()
    inputEl.focus()
    caretAfter(chip)
  }
  // 折叠光标到 node 之后（与 mention.js insertMention 落光标同一手法）
  function caretAfter(node) {
    if (!node || !node.parentNode) return
    const sel = window.getSelection()
    if (!sel) return
    const r = document.createRange()
    r.setStartAfter(node)
    r.collapse(true)
    sel.removeAllRanges()
    sel.addRange(r)
  }
  // 动作行 = 内置（「使用 AI 编辑」）+ 当前项目申报行**合流**（2026-09-28）。外部只能**追加**——
  // 同 id 时内置优先（申报表里同名条目直接被略过），内置行永不因申报而变样或被删。
  const QUOTE_BUILTIN_ID = 'ai-edit'
  function quoteActionRows() {
    const rows = [{ id: QUOTE_BUILTIN_ID, title: '使用 AI 编辑', builtin: true }]
    for (const a of quoteActions()) if (a.id !== QUOTE_BUILTIN_ID) rows.push(a)
    return rows
  }
  function quoteActionRowHtml(a) {
    const lead = a.builtin ? '' : `<span class="qp-ic">${I[a.icon] || I.plug}</span>`
    return '<button type="button" class="qp-row" data-qact="' + esc(a.id) + '">' +
      lead + '<span class="qp-lb">' + esc(a.title) + '</span><span class="qp-go"></span>' +
      '</button>'
  }
  // 申报动作的落地：宿主**不代执行**（业务动作要调项目自己的 API 与页面状态）——只把 id 回发预览帧。
  function quoteRunAction(id, snap) {
    const w = snap && snap.frame
    closeQuotePop()
    if (w) { try { w.postMessage({ type: 'floria-quote-action', id }, '*') } catch { /* 帧已销毁：动作无声丢弃 */ } }
  }
  // 唯一开窗入口（两条来源共用）：宿主机内选区（quoteSnapOf）与项目预览页自报（floria-quote-open）。
  // 后者多带 frame（回发锚点）与 kind:'pdf'，其余同构——外部来源不另开一套浮窗。
  function openQuotePop(snap) {
    closeQuotePop()
    const pop = document.createElement('div')
    pop.className = 'quote-pop'
    pop.innerHTML =
      quoteActionRows().map(quoteActionRowHtml).join('') +
      '<div class="qp-bar">' +
        '<input class="qp-in" type="text" placeholder="对这段说点什么…" aria-label="引用说明" />' +
        '<button type="button" class="qp-send" title="发送" aria-label="发送"></button>' +
      '</div>'
    pop.querySelectorAll('.qp-go').forEach((g) => { g.innerHTML = I.dshSend })
    pop.querySelector('.qp-send').innerHTML = I.dshSend
    document.body.appendChild(pop)
    // 落点 = 选区下方（与图片一致：菜单挂在选中行下面），越界 clamp 回视口（与 recent.js 行菜单同一算法）
    const r = snap.rect || { left: 0, bottom: 0 }
    const w = pop.offsetWidth
    const h = pop.offsetHeight
    pop.style.left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - w - 8))) + 'px'
    pop.style.top = Math.round(Math.max(8, Math.min(r.bottom + 6, window.innerHeight - h - 8))) + 'px'
    pop.addEventListener('mousedown', (e) => e.stopPropagation()) // 浮窗内按下不算「点外部」
    pop.querySelectorAll('.qp-row').forEach((b) =>
      b.addEventListener('click', () => {
        const id = b.dataset.qact
        if (id === QUOTE_BUILTIN_ID) quoteStash(snap)
        else quoteRunAction(id, snap)
      }),
    )
    pop.querySelector('.qp-send').addEventListener('click', () => quoteSendNow(snap))
    pop.querySelector('.qp-in').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); quoteSendNow() }
      else if (e.key === 'Escape') { e.preventDefault(); closeQuotePop() }
    })
    quotePop = pop
  }

  // ---------- 4. 手势 ----------
  // 松开鼠标那一刻（document mouseup，主键）—— 有非空选区且落在可引用区即开浮窗；右键不拦，原生菜单照旧。
  // 浮窗内的 mouseup 不算（那一处是点菜单行/输入框）。「点浮窗外关窗」的那一下同样不算——某些元素上
  // 按下并不会清掉选区，不挡就会「关掉又立刻重开」。
  document.addEventListener('mouseup', (e) => {
    if (e.button !== 0) return
    // 触屏接管中（触屏选区引擎在 hold 窗口内）⇒ 鼠标链让位：iOS 抬手会补发合成 mouseup，而收编后的
    // 程序化选区正是「非空且在引用区内」，不挡就会在选中栏之外再开一份浮窗（见 inputbar/quote-touch.js）。
    if (quoteTouchOwnsSelection()) return
    if (quoteSkipNextUp) { quoteSkipNextUp = false; return }
    if (quotePop && quotePop.contains(e.target)) return
    const snap = quoteSnapOf()
    if (snap) openQuotePop(snap)
  })
  // 点浮窗外任意处 / 滚动 / 窗口尺寸变化 / Esc → 关（fixed 浮窗会漂离锚点）
  document.addEventListener('mousedown', (e) => {
    if (quotePop && !quotePop.contains(e.target)) { closeQuotePop(); quoteSkipNextUp = true }
  })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && quotePop) closeQuotePop() })
  window.addEventListener('scroll', () => { if (quotePop) closeQuotePop() }, { passive: true, capture: true })
  window.addEventListener('resize', () => { if (quotePop) closeQuotePop() })

  // ---------- 5. 项目预览桥（floria-quote-open / floria-quote-close / floria-quote-action）----------
  // 预览页（<项目>/.claude/preview 的 iframe，src = 127.0.0.1:<port> 或 /backend/<label>/）里的选区
  // 宿主看不到（跨文档 getSelection 不达）⇒ 由预览页自报开窗；关窗同理：iframe 内点击/滚动都不冒泡
  // 到宿主 document，宿主那两条「点外部/滚动即关」的策略对帧内事件失效，故预览页必须显式发 close。
  // **门 = e.source 必须是当前在场 .preview-frame 的 contentWindow**（与 rail-ext / ext-card 同一道）。
  // **按 e.source 反查帧、不取 querySelector 第一个**：槽位预览卡与 work 预览栏可能同时在场，
  // 取「第一个」会把 bridge 认到错误的帧（rail-ext 同病，本模块不重蹈）。
  const QUOTE_FRAME_SEL = '.preview-frame'
  function quoteFrameBySource(src) {
    let hit = null
    document.querySelectorAll(QUOTE_FRAME_SEL).forEach((el) => {
      if (hit || !el.contentWindow) return
      if (el.contentWindow === src) hit = el
    })
    return hit
  }
  // 坐标换算：预览页给的是 **iframe 内视口坐标**（0,0 = 帧左上角），叠上帧自身的位置即是宿主视口坐标。
  // 浮窗落点只需 left/bottom（openQuotePop 用这两项 + 视口 clamp）。
  function quoteFrameRect(frame, r) {
    const b = frame.getBoundingClientRect()
    const x = Number(r && r.x) || 0
    const y = Number(r && r.y) || 0
    const h = Number(r && r.h) || 0
    return { left: b.left + x, bottom: b.top + y + h }
  }
  function quoteBridgeOnMessage(e) {
    const d = e.data
    if (!d || typeof d !== 'object') return
    if (d.type !== 'floria-quote-open' && d.type !== 'floria-quote-close') return
    const frame = quoteFrameBySource(e.source)
    if (!frame) return // 非当前预览帧的输入一律不理（唯一守门）
    if (d.type === 'floria-quote-close') { closeQuotePop(); return }
    const text = typeof d.text === 'string' ? d.text : ''
    if (!text.trim()) return
    const p0 = Number(d.page) > 0 ? Number(d.page) : 0
    const p1 = Number(d.pageEnd) > 0 ? Number(d.pageEnd) : 0
    // 路径基准交给 refPath（会话开在 Pj13 时出项目内相对路径，否则带 label 前缀）——proj 取帧的 data-label。
    openQuotePop({
      kind: 'pdf',
      text,
      rect: quoteFrameRect(frame, d.rect),
      frame: frame.contentWindow,
      file: typeof d.pdf === 'string' ? d.pdf : '',
      proj: frame.dataset.label || '',
      p0,
      p1: p1 || p0,
    })
  }
  window.addEventListener('message', quoteBridgeOnMessage)

export {
  QUOTE_FRAME_SEL,
  QUOTE_ZONE,
  caretAfter,
  closeQuotePop,
  insertRefChip,
  openQuotePop,
  quoteActionRows,
  quoteBase,
  quoteEditorLines,
  quoteFrameBySource,
  quoteFrameRect,
  quoteLineOf,
  quoteRunAction,
  quoteSnapOf,
  quoteSnapOfRange,
  quoteStash,
}
