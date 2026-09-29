// 触屏程序化选中 → 选中栏（quote-touch，2026-09-28）

import { toast } from '../core/state.js'
import { IS_TOUCH_DEVICE } from '../sidebar/recent.js'
import { writeClipboard } from '../chat/messages.js'
import { QUOTE_ZONE, openQuotePop, quoteActionRows, quoteRunAction, quoteSnapOfRange, quoteStash } from './quote.js'
  // ---------- 触屏程序化选中（quote-touch）----------
  // 宿主自己的「选中引用」（inputbar/quote.js）是**纯鼠标实现**（document mouseup + getSelection）：触屏上
  // iOS 的原生长按选择 + 系统 callout 先接管手势，那条 mouseup 拿不到非空选区 ⇒ 长按消息文字弹出的是系统
  // 「拷贝/查询/翻译」条。本模块 = 触屏专用接管：长按起选、拖动扩选、松手弹**我们自己的选中栏**，取代系统
  // 菜单。**桌面鼠标路径一字不改** —— 本文件全部监听都先过 `IS_TOUCH_DEVICE` 与 `e.pointerType === 'touch'`
  // 两道门（后者是事件级真门，前者挡住 iPadOS 桌面模式那种「设备是触屏但媒体查询撒谎」的场面）。
  //
  // 机制三条（取自 Pj13 项目 PDF 精读页 PdfViewer.tsx 的实机测量，非推测）：
  //  ① **不引入 user-select:none**：user-select:none 的内容 `caretRangeFromPoint` 返回 null；宿主消息流是
  //     任意 HTML、没有 Pj13 那种 canvas 几何兜底 ⇒ 命中测试唯一可用的 API 必须保住。
  //  ② 「**清原生 + 设程序化**」就是替代系统菜单的机理：`removeAllRanges()` 收掉原生 callout，紧接着
  //     `addRange()` 把蓝底画回来；**程序化选区不再唤起 callout**（且原生手势清不掉它）。
  //  ③ 蓝底按住期即有、选中栏**留到松手才弹**（栏出现在指下会被抬手误触），touchend 还要
  //     `preventDefault()` 吞掉长按抬手补发的合成 click。
  // 抢时点：iOS 建原生词选区约 500ms，此处沿用行浮窗（sidebar/recent.js）的 480ms 长按参数，通常能抢在
  // callout 出现前收编；抢不到也没关系 —— 原生词选区已建好时直接收编（第 ① 路），用户手感一致。

  const QUOTE_LP_MS = 480 // 长按判定（与 sidebar/recent.js 行浮窗同参）
  const QUOTE_LP_SLOP = 8 // 悬停期内漂移容忍像素（超出即作废，同参）
  const QUOTE_MOUSE_HOLD = 800 // 抬手后压住鼠标链的窗口（覆盖 iOS 补发的合成 mouseup）
  const QUOTE_BAR_GAP = 10 // 选中栏与选区的间距
  const QUOTE_MORE_W = 62 // 折「更多 ›」时为它预留的宽度

  let qtSt = 'idle' // idle | pressed | selecting | bar
  let qtTimer = 0
  let qtPress = null // 长按起点（宿主视口坐标）
  let qtRange = null // 程序化选区（本模块唯一真源，不读 window.getSelection）
  let qtAnchor = null // 同手势扩选的固定端点（词首）
  let qtFixed = null // 柄拖拽期的固定端点
  let qtBar = null
  let qtKnobs = []
  let qtMouseUntil = 0 // Date.now() < 此值 ⇒ 鼠标链让位

  // 触屏接管期间为真（抬手后 QUOTE_MOUSE_HOLD 内亦真）：**同一次选择只允许一条开窗路径**。
  // inputbar/quote.js 的 document mouseup 据此让位 —— iOS 抬手会补发合成鼠标事件，而收编后的程序化选区
  // 正是「非空且落在引用区内」，不挡就会在选中栏之外再开一份竖排浮窗（同一次选择两份浮窗）。
  function quoteTouchOwnsSelection() { return Date.now() < qtMouseUntil }

  // ---------- 1. 命中测试 ----------
  const QT_WORD_CH = /[\p{L}\p{N}]/u
  function qtWordCh(ch) { return QT_WORD_CH.test(ch) || ch === '_' || ch === '-' || ch === "'" }
  // 取插入点（Safari/Chrome = caretRangeFromPoint；Firefox = caretPositionFromPoint）
  function qtCaretAt(x, y) {
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y)
      if (r) return r
    }
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y)
      if (p) {
        const r = document.createRange()
        r.setStart(p.offsetNode, p.offset)
        r.collapse(true)
        return r
      }
    }
    return null
  }
  // 由插入点向两侧扩到词边界（ASCII 词 / CJK 连串；标点与空白为界）。落点不在文本节点上（元素边界）
  // ⇒ 放弃（宁可不弹，也不编造一段选区）。
  function qtWordRange(cr) {
    const n = cr && cr.startContainer
    if (!n || n.nodeType !== 3) return null
    const v = n.nodeValue || ''
    let s = cr.startOffset
    let e = s
    while (s > 0 && qtWordCh(v[s - 1])) s--
    while (e < v.length && qtWordCh(v[e])) e++
    if (s === e) return null
    const r = document.createRange()
    r.setStart(n, s)
    r.setEnd(n, e)
    return r
  }
  function qtInZone(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement)
    return !!(el && el.closest && el.closest(QUOTE_ZONE))
  }
  // 两端点排序成 Range（DOM 的 setStart/setEnd 在「起点晚于终点」时会自行塌缩，故先比位置再落）
  function qtMakeRange(a, b) {
    const ta = document.createRange()
    ta.setStart(a.node, a.off)
    ta.collapse(true)
    const tb = document.createRange()
    tb.setStart(b.node, b.off)
    tb.collapse(true)
    const r = document.createRange()
    if (ta.compareBoundaryPoints(Range.START_TO_START, tb) <= 0) { r.setStart(a.node, a.off); r.setEnd(b.node, b.off) }
    else { r.setStart(b.node, b.off); r.setEnd(a.node, a.off) }
    return r
  }
  // 落选区 = 清原生 + 设程序化（收编机理，见文件头 ②）。塌缩即作废（不落空选区）。
  function qtApply(r) {
    if (!r || r.collapsed) return false
    qtRange = r
    const sel = window.getSelection()
    if (sel) { sel.removeAllRanges(); sel.addRange(r) }
    return true
  }

  // ---------- 2. 长按收编 ----------
  // 两条来源：① iOS 已建好的**原生词选区**（最贴近 iPad 手感，零自算）② 我们抢在 iOS 前面 ⇒
  // caretRangeFromPoint 自建。两路都拿不到 ⇒ 放弃，什么都不弹（不留半截状态）。
  function qtHarvest() {
    qtTimer = 0
    if (qtSt !== 'pressed') return
    const sel = window.getSelection()
    let r = null
    if (sel && !sel.isCollapsed && sel.rangeCount) {
      const cur = sel.getRangeAt(0)
      if (qtInZone(cur.startContainer)) r = cur.cloneRange() // 先克隆：随即 removeAllRanges 会作废活引用
    }
    if (!r && qtPress) {
      const cr = qtCaretAt(qtPress[0], qtPress[1])
      if (cr && qtInZone(cr.startContainer)) r = qtWordRange(cr)
    }
    if (!r || !qtApply(r)) { qtSt = 'idle'; return }
    qtAnchor = { node: r.startContainer, off: r.startOffset }
    qtSt = 'selecting'
    document.addEventListener('touchmove', qtExtend, { passive: false })
  }
  // 同手势拖动扩选：锚点 = 词首，焦点端点跟着手指走。touchmove 非 passive + preventDefault 冻结滚动 ——
  // 不冻结的话 iOS 会把手势判成滚动（补发 pointercancel），扩选随之中断。
  function qtExtend(e) {
    if (qtSt !== 'selecting' || !qtAnchor) return
    const t = e.touches && e.touches[0]
    if (!t) return
    e.preventDefault()
    const cr = qtCaretAt(t.clientX, t.clientY)
    const n = cr && cr.startContainer
    if (!n || n.nodeType !== 3) return
    qtApply(qtMakeRange(qtAnchor, { node: n, off: cr.startOffset }))
  }
  // 抬手：吞掉补发的合成 click（touchend preventDefault，与 Pj13 同款），选中栏留到这一刻才弹。
  function qtEndGesture(e) {
    if (qtSt === 'pressed') { clearTimeout(qtTimer); qtTimer = 0; qtSt = 'idle'; return }
    if (qtSt !== 'selecting') return
    if (e && e.cancelable) e.preventDefault()
    document.removeEventListener('touchmove', qtExtend)
    qtMouseUntil = Date.now() + QUOTE_MOUSE_HOLD
    qtSt = 'bar'
    qtShowBar()
  }

  // ---------- 3. 选中栏 ----------
  function qtClose() {
    document.removeEventListener('touchmove', qtExtend)
    if (qtBar) { qtBar.remove(); qtBar = null }
    qtClearKnobs()
    qtSt = 'idle'
    qtRange = null
    qtAnchor = null
    qtFixed = null
    const sel = window.getSelection()
    if (sel) sel.removeAllRanges()
  }
  // 栏与柄都锚在**现役选区**上（柄拖拽期选区一直在变，故定位逻辑独立成函数而不是写死在开栏那一次）。
  function qtPlaceBar() {
    if (!qtBar || !qtRange) return
    const r = qtRange.getBoundingClientRect()
    const w = qtBar.offsetWidth
    const h = qtBar.offsetHeight
    let top = r.top - h - QUOTE_BAR_GAP
    if (top < 8) top = r.bottom + QUOTE_BAR_GAP // 选区上方放不下 ⇒ 翻到下方（同 iOS）
    qtBar.style.left = Math.round(Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8))) + 'px'
    qtBar.style.top = Math.round(Math.max(8, Math.min(top, window.innerHeight - h - 8))) + 'px'
  }
  // 动作行 = 内置「拷贝」+ quote.js 的动作表（内置「使用 AI 编辑」+ 当前项目申报行）。放不下时末尾折成
  // 「更多 ›」——点开**复用既有竖排 .quote-pop**（自带全部动作行 + 话术输入行 + 立即发送），不另造动作表。
  function qtShowBar() {
    if (!qtRange) { qtClose(); return }
    const rows = [{ id: 'copy', title: '拷贝' }].concat(quoteActionRows())
    const bar = document.createElement('div')
    bar.className = 'quote-bar'
    bar.style.visibility = 'hidden' // 先量后放，避免首帧闪在视口左上角
    for (const a of rows) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'qb-item'
      b.dataset.qid = a.id
      b.textContent = a.title
      bar.appendChild(b)
    }
    document.body.appendChild(bar)
    const maxW = window.innerWidth - 16
    if (bar.offsetWidth > maxW) {
      while (bar.children.length > 1 && bar.offsetWidth > maxW - QUOTE_MORE_W) bar.lastElementChild.remove()
      const more = document.createElement('button')
      more.type = 'button'
      more.className = 'qb-item qb-more'
      more.dataset.qid = '__more'
      more.innerHTML = '<span class="qb-lb">更多</span><span class="qb-go">›</span>'
      bar.appendChild(more)
    }
    qtBar = bar
    qtPlaceBar()
    bar.style.visibility = ''
    // 栏内按下/抬手都不算「点栏外」（栏是 body 下的 fixed 卡片，与选区无 DOM 亲缘，故靠 contains 判）
    bar.addEventListener('pointerdown', (e) => e.stopPropagation())
    bar.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('.qb-item')
      if (!b) return
      qtRun(b.dataset.qid, rows)
    })
    qtPlaceKnobs()
  }
  // 动作落地。三条都**先取快照再收口**（快照要的是收口前的选区；收口会清掉它）。
  function qtRun(id, rows) {
    if (id === 'copy') {
      const text = qtRange ? qtRange.toString() : ''
      qtClose()
      writeClipboard(text).then((ok) => toast(ok ? '已复制' : '复制失败'))
      return
    }
    const snap = quoteSnapOfRange(qtRange)
    qtClose()
    if (id === '__more') { if (snap) openQuotePop(snap); return }
    if (!snap) return
    const row = rows.find((a) => a.id === id)
    if (row && row.builtin) quoteStash(snap) // 内置「使用 AI 编辑」：胶囊进输入栏 + 光标落胶囊后
    else quoteRunAction(id, snap) // 项目申报动作：宿主不代执行，只把 id 回发预览帧
  }

  // ---------- 4. 选中柄（松手后扩选的唯一入口）----------
  // 两个自绘圆柄落在选区首/末行下沿（iOS 同形）。拖拽期 touch-action:none + 指针捕获；固定端点取**起手时**
  // 的那一端 ⇒ 拖过对端即自然换向（与 iOS 一致），不会因「谁在左谁在右」中途翻车。
  // 柄节点**只在开栏时建一次**，此后只改 left/top —— 拖拽中重建会在 setPointerCapture 的节点上拔掉
  // 元素，指针捕获随之释放、拖动当场断掉（扩选每移动一次都会重定位，故此处必须复用节点）。
  function qtClearKnobs() { qtKnobs.forEach((k) => k.remove()); qtKnobs = [] }
  function qtPlaceKnobs() {
    if (!qtBar || !qtRange) { qtClearKnobs(); return }
    const rects = qtRange.getClientRects()
    if (!rects.length) { qtClearKnobs(); return }
    if (qtKnobs.length !== 2) {
      qtClearKnobs()
      qtKnobs = [qtAddKnob('a'), qtAddKnob('b')]
    }
    const a = rects[0]
    const b = rects[rects.length - 1]
    qtKnobs[0].style.left = Math.round(a.left) + 'px'
    qtKnobs[0].style.top = Math.round(a.bottom) + 'px'
    qtKnobs[1].style.left = Math.round(b.right) + 'px'
    qtKnobs[1].style.top = Math.round(b.bottom) + 'px'
  }
  function qtAddKnob(which) {
    const k = document.createElement('div')
    k.className = 'qh-knob'
    k.dataset.which = which
    k.addEventListener('pointerdown', qtKnobDown)
    document.body.appendChild(k)
    return k
  }
  function qtKnobDown(e) {
    if (e.pointerType !== 'touch' || !qtRange) return
    e.preventDefault()
    e.stopPropagation()
    const k = e.currentTarget
    k.setPointerCapture(e.pointerId)
    qtFixed = k.dataset.which === 'a'
      ? { node: qtRange.endContainer, off: qtRange.endOffset }
      : { node: qtRange.startContainer, off: qtRange.startOffset }
    k.addEventListener('pointermove', qtKnobMove)
    k.addEventListener('pointerup', qtKnobUp)
    k.addEventListener('pointercancel', qtKnobUp)
  }
  function qtKnobMove(e) {
    if (qtSt !== 'bar' || !qtRange || !qtFixed) return
    e.preventDefault()
    const cr = qtCaretAt(e.clientX, e.clientY)
    const n = cr && cr.startContainer
    if (!n || n.nodeType !== 3 || !qtInZone(n)) return
    if (!qtApply(qtMakeRange({ node: n, off: cr.startOffset }, qtFixed))) return
    qtPlaceKnobs()
    qtPlaceBar()
  }
  function qtKnobUp(e) {
    const k = e.currentTarget
    if (k.hasPointerCapture && k.hasPointerCapture(e.pointerId)) k.releasePointerCapture(e.pointerId)
    k.removeEventListener('pointermove', qtKnobMove)
    k.removeEventListener('pointerup', qtKnobUp)
    k.removeEventListener('pointercancel', qtKnobUp)
    qtFixed = null
    qtMouseUntil = Date.now() + QUOTE_MOUSE_HOLD
  }

  // ---------- 5. 手势 ----------
  document.addEventListener('pointerdown', (e) => {
    if (!IS_TOUCH_DEVICE || e.pointerType !== 'touch') return
    if (qtBar && qtBar.contains(e.target)) return // 栏内按下交给栏自己（点动作行）
    if (qtKnobs.some((k) => k.contains(e.target))) return
    if (qtSt === 'bar') qtClose() // 点栏外 = 收口（清选区 + 收柄）
    if (!(e.target.closest && e.target.closest(QUOTE_ZONE))) return
    clearTimeout(qtTimer)
    qtPress = [e.clientX, e.clientY]
    qtSt = 'pressed'
    qtTimer = setTimeout(qtHarvest, QUOTE_LP_MS)
  }, { passive: true })
  document.addEventListener('pointermove', (e) => {
    if (qtSt !== 'pressed' || !qtPress) return
    if (Math.abs(e.clientX - qtPress[0]) > QUOTE_LP_SLOP || Math.abs(e.clientY - qtPress[1]) > QUOTE_LP_SLOP) {
      clearTimeout(qtTimer)
      qtTimer = 0
      qtSt = 'idle'
    }
  }, { passive: true })
  document.addEventListener('pointerup', () => { if (qtSt === 'pressed') { clearTimeout(qtTimer); qtTimer = 0; qtSt = 'idle' } }, { passive: true })
  document.addEventListener('pointercancel', () => { if (qtSt === 'pressed') { clearTimeout(qtTimer); qtTimer = 0; qtSt = 'idle' } }, { passive: true })
  document.addEventListener('touchend', qtEndGesture, { passive: false })
  document.addEventListener('touchcancel', qtEndGesture, { passive: false })
  // 收口四路（与 .quote-pop 同口径）：Escape / 滚动（含 #chat-scroll 内滚）/ 窗口尺寸变化 / 点栏外（上行）。
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && qtSt === 'bar') qtClose() })
  window.addEventListener('scroll', () => { if (qtSt === 'bar') qtClose() }, { passive: true, capture: true })
  window.addEventListener('resize', () => { if (qtSt === 'bar') qtClose() })

export {
  quoteTouchOwnsSelection,
}
