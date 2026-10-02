// 轮次导航轨（dsh TurnNavigator 移植，2026-10-02）：会话区右侧一列短线刻度，每格=一个对话轮次
//（=一条已提交用户气泡所辖段），hover 出预览卡（提示词 50 字 + 回复 120 字）、点击滚动跳到该轮、
// 当前可见轮高亮。数据源=#messages 已渲染 DOM（Pj16 前端全量加载，dsh 的「未加载轮次分页」自然省略）。
//
// 关键设计（对齐 dsh：刻度稳定、预览不随刷新丢失）：
//  · 刻度仅在**轮次集合变化**时重建（结构指纹 railKeys）；流式文本增长/滚动只刷预览文本，不碰刻度 DOM
//    ——否则流式期间每次刷新都销毁光标下的刻度，预览卡随之消失、刻度闪烁。
//  · 预览锚定在**轮次 key**（用户气泡 data-m）而非下标，跨结构刷新仍能复位到同一轮。
//  · 只采集**已提交**轮次：[data-t="u"][data-m]，排除 #live-zone 内乐观气泡（无 data-m，否则多算一格）。
//  · 回复取该轮**最后一个非空** [data-t="a"] 文本（dsh findLast(text!=='') 同义），避免收尾工具步空文本覆盖。
// 挂载=动态建 nav 追加到 #chat-area（position:absolute 无形槽，不参与 flex 流）；刷新=对 #messages 挂
// MutationObserver（覆盖面重建/增量 append/流式文本），节流（非 debounce——连续流式下 debounce 会饥饿不触发）。

import { stage, topInScroll } from './stage.js'
import { messagesEl } from '../core/state.js'
  const RAIL_PROMPT_MAX = 50 // 预览提示词封顶（与 dsh 一致）
  const RAIL_RESP_MAX = 120 // 预览回复封顶
  const RAIL_ACTIVE_BAND = 0.4 // 视口上 40% 带内最后一个锚 = 当前轮
  const RAIL_NARROW = 640 // 窄于此宽隐藏刻度（手机竖屏；平板竖屏 768–834 保留）
  const RAIL_BUILD = 'rail-t2-2026.10.02' // 构建标记：dataset.build 可核验跑的是哪版
  const RAIL_TOUCH_HOLD = 2500 // 触屏点刻度后预览卡停留时长（无 hover 时的唤起路径）

  let railItems = [] // [{ key, el, prompt, response }]（文档序）
  let railKeys = '' // 结构指纹（各轮 key 拼接）：变化才重建刻度
  let railActiveIdx = -1
  let railPreviewKey = null // 预览锚定轮次 key（跨重建保稳）
  let railTimer = null
  let railLastTick = 0
  let railHideTimer = null // 触屏预览卡自动收起计时器

  // 元素正文（优先 .body，滤掉 who/图片/文件标签文本）
  function railText(el) {
    const body = el.querySelector('.body') || el
    return String(body.textContent || '').replace(/\s+/g, ' ').trim()
  }
  function railClip(s, max) {
    return s.length > max ? s.slice(0, max) + '…' : s
  }

  // 采集已提交轮次：锚=[data-t="u"][data-m]（data-m 排除 #live-zone 乐观气泡）；回复=其后同轮
  // 最后一个非空 [data-t="a"]。轮次<2 由调用方隐藏。
  function railCollect() {
    const out = []
    if (!messagesEl) return out
    const seq = messagesEl.querySelectorAll('[data-t="u"][data-m], [data-t="a"][data-m]')
    let cur = null
    for (const el of seq) {
      if (el.closest('#live-zone')) continue
      if (el.getAttribute('data-t') === 'u') {
        cur = { key: el.getAttribute('data-m'), el, prompt: railClip(railText(el), RAIL_PROMPT_MAX), response: '' }
        out.push(cur)
      } else if (cur) {
        const t = railClip(railText(el), RAIL_RESP_MAX)
        if (t) cur.response = t
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
    nav.dataset.build = RAIL_BUILD
    nav.setAttribute('aria-label', '轮次导航')
    nav.hidden = true
    nav.innerHTML = '<div class="tr-scroller"><div class="tr-marks"></div></div>'
      + '<div class="tr-preview" hidden><div class="tr-prompt"></div><div class="tr-resp" hidden></div></div>'
    host.appendChild(nav)
    railBind(nav)
    return nav
  }

  function railHideSoon(nav) {
    if (railHideTimer) clearTimeout(railHideTimer)
    railHideTimer = setTimeout(() => { railHideTimer = null; railSetPreview(nav, null) }, RAIL_TOUCH_HOLD)
  }

  function railBind(nav) {
    // 绑在 nav（含 scroller 与刻度，冒泡覆盖），pointermove + pointerover 双触发：
    // 刻度重建/内容刷新后若光标静止其上，pointerover 仍能唤出预览卡（单靠 pointermove 会漏）。
    const onHover = (e) => {
      const m = e.target.closest ? e.target.closest('.tr-mark') : null
      if (m) railSetPreview(nav, m.dataset.key)
    }
    nav.addEventListener('pointermove', onHover)
    nav.addEventListener('pointerover', onHover)
    // 触屏 tap 后浏览器会补发 pointerleave（pointerType=touch），此时不能收卡——卡由 railHideSoon 定时收。
    nav.addEventListener('pointerleave', () => { if (railHideTimer) return; railSetPreview(nav, null) })
    // 触屏：tap 刻度 = 亮出该轮预览卡（停留 RAIL_TOUCH_HOLD）并跳到该轮；触屏无 hover，靠此唤起。
    nav.addEventListener('click', (e) => {
      const m = e.target.closest ? e.target.closest('.tr-mark') : null
      if (!m) return
      railSetPreview(nav, m.dataset.key)
      railHideSoon(nav)
      railJump(m.dataset.key)
    })
    // 点轨外任意处收回预览卡（触屏无 pointerleave，须显式收）。
    document.addEventListener('pointerdown', (e) => {
      if (nav.contains(e.target)) return
      if (railHideTimer) { clearTimeout(railHideTimer); railHideTimer = null }
      railSetPreview(nav, null)
    }, true)
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

  function railPreviewIndex() {
    return railPreviewKey == null ? -1 : railItems.findIndex((it) => it.key === railPreviewKey)
  }

  // 只标态（不整重建）——滚动/预览/内容刷新都走此路
  function railPaint(nav) {
    const marks = nav.querySelectorAll('.tr-mark')
    const pIdx = railPreviewIndex()
    marks.forEach((m, i) => {
      m.classList.toggle('tr-active', i === railActiveIdx)
      m.classList.toggle('tr-hot', i === pIdx) // 注意：类名不可用 tr-preview——那是预览卡自己的类，撞名会让刻度按钮命中卡片样式
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

  // 刻度 DOM 仅在轮次集合变化时重建；建完不 paint（由 railRefresh 统一 paint）
  function railRender(nav, items) {
    const marks = nav.querySelector('.tr-marks')
    marks.textContent = ''
    items.forEach((it, i) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'tr-mark'
      b.dataset.key = it.key
      b.setAttribute('aria-label', `跳到第 ${i + 1} 轮`)
      marks.appendChild(b)
    })
  }

  // 预览卡：内容 + 垂直居中于该刻度（钳在轨内）
  function railShowPreview(nav, key) {
    const pv = nav.querySelector('.tr-preview')
    const idx = key == null ? -1 : railItems.findIndex((it) => it.key === key)
    const marks = nav.querySelectorAll('.tr-mark')
    if (idx < 0 || !marks[idx]) { pv.hidden = true; return }
    const item = railItems[idx]
    pv.hidden = false
    pv.querySelector('.tr-prompt').textContent = item.prompt || `第 ${idx + 1} 轮`
    const resp = pv.querySelector('.tr-resp')
    resp.textContent = item.response || ''
    resp.hidden = !item.response
    const scroller = nav.querySelector('.tr-scroller')
    const center = marks[idx].offsetTop + marks[idx].offsetHeight / 2 - scroller.scrollTop
    const ph = pv.offsetHeight
    const maxTop = Math.max(0, scroller.clientHeight - ph)
    pv.style.top = Math.max(0, Math.min(maxTop, center - ph / 2)) + 'px'
  }

  function railSetPreview(nav, key) {
    if (key === railPreviewKey) { railShowPreview(nav, railPreviewKey); return }
    railPreviewKey = key
    railPaint(nav)
    railShowPreview(nav, key)
  }

  function railJump(key) {
    const idx = railItems.findIndex((it) => it.key === key)
    const item = railItems[idx]
    if (!item) return
    const sc = document.getElementById('chat-scroll')
    if (!sc) return
    stage.yielded = true // 用户导航=接管视口，停止 stage 跟随（同滚动输入）
    sc.scrollTo({ top: topInScroll(item.el), behavior: 'smooth' })
    railActiveIdx = idx
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
      railKeys = ''
      railActiveIdx = -1
      railPreviewKey = null
      railShowPreview(nav, null)
      return
    }
    nav.hidden = false
    const keys = railItems.map((it) => it.key).join('\u0001')
    if (keys !== railKeys) {
      railKeys = keys
      railRender(nav, railItems) // 只有轮次集合变了才销毁重建刻度
    }
    railActiveIdx = railActiveFromScroll()
    railPaint(nav)
    railShowPreview(nav, railPreviewKey) // 内容刷新时同步预览文本（刻度未动，光标不移也不丢卡）
  }

  // 变更驱动：#messages 整页重建/增量 append/流式文本 → 节流重算。
  // 用节流而非 debounce：连续流式下 mutation 间隔 < 阈值，debounce 会一直重置、轨道定型不动；
  // 节流保证每 ~150ms 至少刷一次，且因「结构未变不重建」，刷新本身零刻度抖动。
  function railSchedule() {
    if (railTimer != null) return
    const wait = Math.max(0, 150 - (Date.now() - railLastTick))
    railTimer = setTimeout(() => {
      railTimer = null
      railLastTick = Date.now()
      railRefresh()
    }, wait)
  }

  const railObs = new MutationObserver(railSchedule)

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
