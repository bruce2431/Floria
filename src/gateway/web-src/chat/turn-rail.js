// 轮次导航轨（dsh TurnNavigator 移植，2026-10-02）：会话区右侧一列短线刻度，每格=一个对话轮次
//（=一条开启用户气泡所辖段），hover 出预览卡（提示词 50 字 + 回复 120 字）、点击滚动跳到该轮、
// 当前可见轮高亮。数据源=#messages 已渲染 DOM（Pj16 前端全量加载，dsh 的「未加载轮次分页」自然省略）。
// 挂载=动态建 nav 追加到 #chat-area（position:relative 无形槽，absolute 不参与 flex 流）；刷新=对
// #messages 挂 MutationObserver（覆盖整页重建/增量 append/流式文本），debounce 重算。

import { stage, topInScroll } from './stage.js'
import { messagesEl } from '../core/state.js'
  const RAIL_PROMPT_MAX = 50 // 预览提示词封顶（与 dsh 一致）
  const RAIL_RESP_MAX = 120 // 预览回复封顶
  const RAIL_ACTIVE_BAND = 0.4 // 视口上 40% 内最后一个锚 = 当前轮
  const RAIL_NARROW = 900 // 窄于此刻度宽隐藏（dsh 900px 断点同值）

  let railItems = []
  let railActiveIdx = -1
  let railPreviewIdx = -1

  // 元素正文（优先 .body，滤掉 who/图片/文件标签文本）
  function railText(el) {
    const body = el.querySelector('.body') || el
    return String(body.textContent || '').replace(/\s+/g, ' ').trim()
  }
  function railClip(s, max) {
    return s.length > max ? s.slice(0, max) + '…' : s
  }

  // 采集轮次：锚=开启用户气泡 [data-t="u"]（data-m=段键）。querySelectorAll('[data-t="u"],[data-t="a"]')
  // 返回文档序——a 落在其所属轮与下一轮之间即归入当前轮，response 取该轮最后一个 a。轮次<2 由调用方隐藏。
  function railCollect() {
    const out = []
    if (!messagesEl) return out
    const seq = messagesEl.querySelectorAll('[data-t="u"], [data-t="a"]')
    let cur = null
    for (const el of seq) {
      if (el.getAttribute('data-t') === 'u') {
        cur = { el, prompt: railClip(railText(el), RAIL_PROMPT_MAX), response: '' }
        out.push(cur)
      } else if (cur) {
        cur.response = railClip(railText(el), RAIL_RESP_MAX)
      }
    }
    return out
  }

  // nav 单例：动态创建（index.html 不用改），追加到 #chat-area
  function railNav() {
    let nav = document.getElementById('turn-rail')
    if (nav && nav.isConnected) return nav
    const host = document.getElementById('chat-area')
    if (!host) return null
    nav = document.createElement('nav')
    nav.id = 'turn-rail'
    nav.className = 'turn-rail'
    nav.setAttribute('aria-label', '轮次导航')
    nav.hidden = true
    nav.innerHTML = '<div class="tr-scroller"><div class="tr-marks"></div></div>'
      + '<div class="tr-preview" hidden><div class="tr-prompt"></div><div class="tr-resp" hidden></div></div>'
    host.appendChild(nav)
    railBind(nav)
    return nav
  }

  function railBind(nav) {
    nav.querySelector('.tr-scroller').addEventListener('pointermove', (e) => {
      const m = e.target.closest('.tr-mark')
      if (m) railPreview(nav, Number(m.dataset.idx))
    })
    nav.addEventListener('pointerleave', () => { railPreview(nav, -1) })
    nav.addEventListener('click', (e) => {
      const m = e.target.closest('.tr-mark')
      if (m) railJump(Number(m.dataset.idx))
    })
  }

  // 当前轮：视口上 RAIL_ACTIVE_BAND 带内最后一个锚
  function railActiveFromScroll() {
    const sc = document.getElementById('chat-scroll')
    if (!sc || !railItems.length) return -1
    const band = sc.scrollTop + sc.clientHeight * RAIL_ACTIVE_BAND
    let idx = 0
    for (let i = 0; i < railItems.length; i++) {
      if (topInScroll(railItems[i].el) <= band) idx = i
      else break
    }
    return idx
  }

  // 只标态（不整重建）——滚动/预览走此路
  function railPaint(nav) {
    const marks = nav.querySelectorAll('.tr-mark')
    marks.forEach((m, i) => {
      m.classList.toggle('tr-active', i === railActiveIdx)
      m.classList.toggle('tr-preview', i === railPreviewIdx)
    })
    // active 刻度留在轨内可视（手动算，禁 scrollIntoView——会外溢滚动祖先链）
    const scroller = nav.querySelector('.tr-scroller')
    const act = marks[railActiveIdx]
    if (act) {
      const top = act.offsetTop
      const h = scroller.clientHeight
      if (top < scroller.scrollTop) scroller.scrollTop = top
      else if (top + act.offsetHeight > scroller.scrollTop + h) scroller.scrollTop = top + act.offsetHeight - h
    }
  }

  function railRender(nav, items) {
    const marks = nav.querySelector('.tr-marks')
    marks.textContent = ''
    items.forEach((it, i) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'tr-mark'
      b.dataset.idx = String(i)
      b.setAttribute('aria-label', `跳到第 ${i + 1} 轮`)
      marks.appendChild(b)
    })
    railPaint(nav)
  }

  function railPreview(nav, idx) {
    if (idx === railPreviewIdx) return
    railPreviewIdx = idx
    railPaint(nav)
    const pv = nav.querySelector('.tr-preview')
    const item = railItems[idx]
    const marks = nav.querySelectorAll('.tr-mark')
    if (!item || !marks[idx]) { pv.hidden = true; return }
    pv.hidden = false
    pv.querySelector('.tr-prompt').textContent = item.prompt || `第 ${idx + 1} 轮`
    const resp = pv.querySelector('.tr-resp')
    resp.textContent = item.response || ''
    resp.hidden = !item.response
    // 垂直居中于该刻度，钳在 nav 内
    const scroller = nav.querySelector('.tr-scroller')
    const center = marks[idx].offsetTop + marks[idx].offsetHeight / 2 - scroller.scrollTop
    const ph = pv.offsetHeight
    const maxTop = Math.max(0, nav.clientHeight - ph)
    pv.style.top = Math.max(0, Math.min(maxTop, center - ph / 2)) + 'px'
  }

  function railJump(idx) {
    const item = railItems[idx]
    if (!item) return
    const sc = document.getElementById('chat-scroll')
    if (!sc) return
    stage.yielded = true // 用户导航=接管视口，停止 stage 跟随（同滚动输入）
    sc.scrollTo({ top: topInScroll(item.el), behavior: 'smooth' })
    railActiveIdx = idx
    railPreviewIdx = -1
    const nav = document.getElementById('turn-rail')
    if (nav) railPaint(nav)
  }

  function railRefresh() {
    const nav = railNav()
    if (!nav) return
    const area = document.getElementById('chat-area')
    const inSession = !!area && area.classList.contains('in-session') && !area.classList.contains('work')
    railItems = railCollect()
    if (!inSession || railItems.length < 2 || window.innerWidth <= RAIL_NARROW) {
      nav.hidden = true
      railPreviewIdx = -1
      return
    }
    nav.hidden = false
    railActiveIdx = railActiveFromScroll()
    railPreviewIdx = -1
    railRender(nav, railItems)
  }

  // 变更驱动：#messages 整页重建/增量 append/流式文本 → debounce 重算
  let railTimer = null
  const railObs = new MutationObserver(() => {
    clearTimeout(railTimer)
    railTimer = setTimeout(railRefresh, 150)
  })

  function railInit() {
    const nav = railNav()
    if (!nav) return
    if (messagesEl) railObs.observe(messagesEl, { childList: true, subtree: true, characterData: true })
    const sc = document.getElementById('chat-scroll')
    if (sc) {
      let ticking = false
      sc.addEventListener('scroll', () => {
        if (ticking) return
        ticking = true
        requestAnimationFrame(() => {
          ticking = false
          const n = document.getElementById('turn-rail')
          if (!n || n.hidden || !railItems.length) return
          const idx = railActiveFromScroll()
          if (idx === railActiveIdx) return
          railActiveIdx = idx
          railPaint(n)
        })
      }, { passive: true })
    }
    window.addEventListener('resize', railRefresh)
    railRefresh()
  }
  railInit()

// —— 跨模块写入口（切割脚本生成）——
export { railRefresh }
