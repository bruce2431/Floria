// PDF 预览（2026-10-24 UI 对齐 dsh）：pdf.js 真实渲染取代浏览器自带 <iframe> viewer。
// 结构与 dsh `ui-sidebar-documentpreview/pdf` 同口径：顶部工具条（页码输入 / 缩略比例 / 适宽）
// + 竖向页栈（页间 12px、页面阴影、按可视区懒渲染、可选文本层）。引擎与 worker 为本地 vendor
// （src/gateway/web/vendor/pdfjs/，随 web 资源内嵌进 exe），零外链、零后端改动。
import { esc } from '../../core/util.js'
/* @module sidebar/work/work-pdf.js */

  // 渲染基准：pdf.js 视口 scale=1 是 72dpi，浏览器 CSS 像素按 96dpi —— 100% = scale 96/72。
  const WK_PDF_BASE = 96 / 72
  const WK_PDF_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3]
  const WK_PDF_V = '593' // 与 index.html/sw.js 的 cache-bust 同值
  let wkPdfLib = null
  let wkPdfGen = 0 // 每次装载自增；迟到的解析结果据此作废
  let wkPdfLive = null // 当前文档的释放函数

  async function wkPdfLoadLib() {
    if (!wkPdfLib) {
      // vendor 文件按 .js 命名（不是 .mjs）：静态路由的 MIME 表只登记 .js = text/javascript，
      // 动态 import 与 module worker 都要求 JS MIME，改扩展名即可避开后端 MIME 表改动。
      const lib = await import('/vendor/pdfjs/pdf.min.js?v=' + WK_PDF_V)
      lib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.js?v=' + WK_PDF_V
      wkPdfLib = lib
    }
    return wkPdfLib
  }

  // 切走/换文件时调用：作废在途装载并释放当前文档（worker + canvas + 文本层）。
  function wkPdfClose() {
    wkPdfGen++
    if (wkPdfLive) {
      const fn = wkPdfLive
      wkPdfLive = null
      try { fn() } catch { /* 释放失败不影响切文件 */ }
    }
  }

  // 入口：body = #wk-ed-body，buf = ArrayBuffer（原样交给 pdf.js，worker 侧会转移）。
  async function wkPdfRender(body, path, buf) {
    wkPdfClose()
    const gen = wkPdfGen
    body.innerHTML = '<div class="wk-ed-empty">正在打开 PDF…</div>'
    let lib
    try {
      lib = await wkPdfLoadLib()
    } catch (e) {
      if (gen === wkPdfGen) body.innerHTML = `<div class="wk-ed-empty">PDF 引擎不可用：${esc(e.message || e)}</div>`
      return
    }
    if (gen !== wkPdfGen) return
    const task = lib.getDocument({
      data: new Uint8Array(buf),
      cMapUrl: '/vendor/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/vendor/pdfjs/standard_fonts/',
      isEvalSupported: false,
      useWorkerFetch: false,
    })
    let doc
    try {
      doc = await task.promise
    } catch (e) {
      if (gen !== wkPdfGen) return
      body.innerHTML = `<div class="wk-ed-empty">PDF 解析失败：${esc(e.message || e)}</div>`
      return
    }
    if (gen !== wkPdfGen) {
      try { doc.destroy() } catch { /* 已作废 */ }
      return
    }
    wkPdfMount(body, path, lib, doc)
  }

  function wkPdfMount(body, path, lib, doc) {
    const scroll = document.createElement('div')
    scroll.className = 'wk-pdf-scroll'
    const pages = document.createElement('div')
    pages.className = 'wk-pdf-pages'
    scroll.appendChild(pages)
    const name = String(path).split('/').pop()

    const wrap = document.createElement('div')
    wrap.className = 'wk-pdf'
    wrap.innerHTML =
      `<div class="wk-pdf-bar">` +
      `<span class="wk-pdf-name" title="${esc(path)}">${esc(name)}</span>` +
      `<span class="wk-pdf-total">${doc.numPages} 页</span>` +
      `<span class="wk-pdf-grow"></span>` +
      `<button type="button" class="wk-pdf-btn" data-pdf="prev" title="上一页">‹</button>` +
      `<input class="wk-pdf-num" inputmode="numeric" value="1" aria-label="页码" />` +
      `<span class="wk-pdf-of">/ ${doc.numPages}</span>` +
      `<button type="button" class="wk-pdf-btn" data-pdf="next" title="下一页">›</button>` +
      `<span class="wk-pdf-sep"></span>` +
      `<button type="button" class="wk-pdf-btn" data-pdf="out" title="缩小">−</button>` +
      `<button type="button" class="wk-pdf-btn wk-pdf-fit on" data-pdf="fit" title="适宽">适宽</button>` +
      `<button type="button" class="wk-pdf-btn" data-pdf="in" title="放大">+</button>` +
      `<span class="wk-pdf-pct">–</span>` +
      `</div>`
    wrap.appendChild(scroll)
    body.textContent = ''
    body.appendChild(wrap)

    const q = (s) => wrap.querySelector(s)
    const pageInput = q('.wk-pdf-num')
    const pctEl = q('.wk-pdf-pct')
    const fitBtn = q('[data-pdf="fit"]')

    const st = {
      zoom: 'fit', // 'fit' | number（1 = 96dpi 的 100%）
      visible: new Set(),
      epochs: 0,
      queue: [],
      queued: new Set(),
      busy: false,
      dead: false,
      tasks: new Set(),
      pages: [], // [{ el, canvas, text, base, state }]
      obs: null,
      obsResize: null,
      cur: 1,
      ready: false, // 首页尺寸到位前不渲染（否则先按 100% 渲一帧再重渲）
    }

    const dispose = () => {
      if (st.dead) return
      st.dead = true
      st.obs?.disconnect()
      st.obsResize?.disconnect()
      st.obs = null
      st.obsResize = null
      for (const t of st.tasks) { try { t.cancel() } catch { /* 已结束 */ } }
      st.tasks.clear()
      st.queue.length = 0
      st.queued.clear()
      // 页面 canvas 主动缩零：iOS 上大画布不释放会随文档残留（dsh 同做法）
      for (const p of st.pages) {
        p.canvas.width = 0
        p.canvas.height = 0
      }
      Promise.resolve().then(() => { try { doc.destroy() } catch { /* 已销毁 */ } })
    }
    wkPdfLive = dispose

    for (let n = 1; n <= doc.numPages; n++) {
      const el = document.createElement('div')
      el.className = 'wk-pdf-page'
      el.dataset.page = String(n)
      el.innerHTML = '<div class="wk-pdf-ph" role="status" aria-label="加载第 ' + n + ' 页"></div>' +
        '<div class="wk-pdf-surface" hidden><canvas class="wk-pdf-canvas" role="img" aria-label="第 ' + n + ' 页"></canvas><div class="textLayer wk-pdf-text"></div></div>'
      pages.appendChild(el)
      st.pages.push({
        el,
        canvas: el.querySelector('canvas'),
        text: el.querySelector('.textLayer'),
        surface: el.querySelector('.wk-pdf-surface'),
        base: 0, // 页面在 scale=96/72 下的 CSS 宽
        renderedZoom: 0,
        epoch: -1,
        n,
      })
    }

    // ---- 缩放 ----
    function fitZoom(p0) {
      const avail = scroll.clientWidth - 24
      return p0 && p0.base ? Math.max(0.1, avail / p0.base) : 1
    }
    function zoomValue() {
      const p0 = st.pages[0]
      return st.zoom === 'fit' ? fitZoom(p0) : st.zoom
    }
    function setZoom(z) {
      st.zoom = z
      st.epochs++
      fitBtn.classList.toggle('on', z === 'fit')
      pctEl.textContent = Math.round(zoomValue() * 100) + '%'
      // 重渲可见页 + 当前页（其余页在滚入可视区时按新 epoch 渲染）
      const want = new Set(st.visible)
      want.add(st.cur)
      for (const n of want) requestRender(n)
    }
    function stepZoom(dir) {
      const cur = zoomValue()
      if (dir > 0) {
        const next = WK_PDF_STEPS.find((v) => v > cur + 0.001)
        setZoom(next || WK_PDF_STEPS[WK_PDF_STEPS.length - 1])
      } else {
        const lower = WK_PDF_STEPS.filter((v) => v < cur - 0.001)
        setZoom(lower.length ? lower[lower.length - 1] : WK_PDF_STEPS[0])
      }
    }

    // ---- 渲染队列（串行，避免多页同时分配大画布）----
    function requestRender(n) {
      if (st.dead || !st.pages[n - 1]) return
      if (st.queued.has(n)) return
      st.queued.add(n)
      st.queue.push(n)
      void pump()
    }
    async function pump() {
      if (st.busy || st.dead || !st.ready) return
      const n = st.queue.shift()
      if (n == null) return
      st.busy = true
      try { await renderPage(n) } catch { /* 单页失败保留占位（重渲会再试） */ }
      st.busy = false
      st.queued.delete(n)
      if (!st.dead && st.queue.length) void pump()
    }
    async function renderPage(n) {
      const p = st.pages[n - 1]
      const epoch = st.epochs
      st.queued.add(n)
      const page = await doc.getPage(n)
      if (st.dead || epoch !== st.epochs) return
      const baseVp = page.getViewport({ scale: WK_PDF_BASE })
      p.base = baseVp.width
      const zoom = zoomValue()
      if (p.epoch === epoch && Math.abs(p.renderedZoom - zoom) < 0.001) return
      const vp = page.getViewport({ scale: WK_PDF_BASE * zoom })
      const ratio = Math.min(window.devicePixelRatio || 1, Math.sqrt(16_777_216 / (vp.width * vp.height)))
      p.canvas.width = Math.max(1, Math.floor(vp.width * ratio))
      p.canvas.height = Math.max(1, Math.floor(vp.height * ratio))
      p.canvas.style.width = vp.width + 'px'
      p.canvas.style.height = vp.height + 'px'
      p.surface.style.width = vp.width + 'px'
      const task = page.render({ canvas: p.canvas, viewport: vp, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] })
      st.tasks.add(task)
      // 文本层（可选文本；容器尺寸与画布一致，CSS 变量告知 pdf.js 当前缩放）
      let textLayer
      try {
        p.text.textContent = ''
        p.text.style.setProperty('--total-scale-factor', String(vp.scale))
        textLayer = new lib.TextLayer({ textContentSource: page.streamTextContent(), container: p.text, viewport: vp })
      } catch { textLayer = null }
      try {
        await Promise.all([task.promise, textLayer ? textLayer.render() : Promise.resolve()])
      } finally {
        st.tasks.delete(task)
        try { page.cleanup() } catch { /* 已销毁 */ }
      }
      if (st.dead || epoch !== st.epochs) return
      p.renderedZoom = zoom
      p.epoch = epoch
      p.surface.hidden = false
      const ph = p.el.querySelector('.wk-pdf-ph')
      if (ph) ph.hidden = true
      p.el.style.width = vp.width + 'px'
      pctEl.textContent = Math.round(zoomValue() * 100) + '%'
    }

    // ---- 可视区懒渲染 + 当前页 ----
    if (typeof IntersectionObserver === 'function') {
      st.obs = new IntersectionObserver((entries) => {
        for (const en of entries) {
          const n = Number(en.target.dataset.page)
          if (en.isIntersecting) {
            st.visible.add(n)
            requestRender(n)
          } else st.visible.delete(n)
        }
        syncCur()
      }, { root: scroll, rootMargin: '100% 0px' })
      for (const p of st.pages) st.obs.observe(p.el)
    } else {
      for (const p of st.pages) requestRender(p.n)
    }
    function syncCur() {
      // 当前页 = 顶部越过滚动口顶沿的最后一页；全在下方则取第一页
      let cur = 1
      const top = scroll.getBoundingClientRect().top
      for (const p of st.pages) {
        if (p.el.getBoundingClientRect().top - top <= 24) cur = p.n
        else break
      }
      if (cur !== st.cur) {
        st.cur = cur
        if (document.activeElement !== pageInput) pageInput.value = String(cur)
      }
    }
    let raf = 0
    scroll.addEventListener('scroll', () => {
      if (raf) return
      raf = requestAnimationFrame(() => { raf = 0; if (!st.dead) syncCur() })
    }, { passive: true })

    function goPage(n) {
      const target = Math.min(doc.numPages, Math.max(1, n | 0))
      const p = st.pages[target - 1]
      if (!p) return
      st.cur = target
      pageInput.value = String(target)
      scroll.scrollTop = p.el.offsetTop - pages.offsetTop
      requestRender(target)
    }

    // ---- 工具条 ----
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pdf]')
      if (!b) return
      const act = b.dataset.pdf
      if (act === 'prev') goPage(st.cur - 1)
      else if (act === 'next') goPage(st.cur + 1)
      else if (act === 'out') stepZoom(-1)
      else if (act === 'in') stepZoom(1)
      else if (act === 'fit') setZoom('fit')
    })
    pageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { goPage(Number(pageInput.value)); pageInput.blur() }
    })
    pageInput.addEventListener('blur', () => {
      const n = Number(pageInput.value)
      if (Number.isFinite(n) && n >= 1 && n <= doc.numPages) goPage(n)
      else pageInput.value = String(st.cur)
    })
    // 容器宽度变化（右栏拖宽 / 横竖屏）：适宽态重算；固定比例态也要重算当前页布局
    if (typeof ResizeObserver === 'function') {
      let lastW = scroll.clientWidth
      const ro = new ResizeObserver(() => {
        if (st.dead || scroll.clientWidth === lastW) return
        lastW = scroll.clientWidth
        if (st.zoom === 'fit') setZoom('fit')
        else pctEl.textContent = Math.round(zoomValue() * 100) + '%'
      })
      ro.observe(scroll)
      st.obsResize = ro
    }

    // 先取首页尺寸再落 fit 比例（numPages 为空时不崩）
    void doc.getPage(1).then((p0) => {
      if (st.dead) return
      const vp = p0.getViewport({ scale: WK_PDF_BASE })
      st.pages[0].base = vp.width
      st.ready = true
      setZoom('fit')
      requestRender(1)
      if (!st.dead && st.queue.length) void pump()
    }).catch(() => {
      if (st.dead) return
      st.ready = true
      setZoom('fit')
      void pump()
    })
  }

export {
  wkPdfClose,
  wkPdfRender,
}
