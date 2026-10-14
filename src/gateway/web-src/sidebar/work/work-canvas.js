// .canvas 文件（JSON Canvas 1.0，Obsidian 同格式）的图形预览+编辑：wkEdLangExt 对 .canvas 扩展名注入
// wkCvExt —— 默认把整篇文档替换为 SVG 画布（群组/边/节点 + 点阵网格 + 平移/缩放），画布顶栏「编辑源码」
// 切回 JSON（带高亮、可正常自动保存）；源码态文档首行挂「图形预览」钮切回画布。图形编辑（2026-10-14
// 待办#2 补缺）：节点/组拖动改坐标、双击改文字，写入=原样改写源 JSON（保留未识别字段）dispatch 回
// 编辑器文档走既有自动保存链。渲染零依赖（SVG 自绘，无外网 CDN）；canvas 自定色用内联 rgba（Safari
// 对 SVG 内 color-mix 支持不稳），项目令牌色走 class。
/* @module sidebar/work/work-canvas.js */

  // ---------- JSON Canvas 解析 ----------
  // spec 1.0：{nodes:[{id,type:'text'|'group',x,y,width,height,color?,text?}], edges:[{fromNode,
  // fromSide?,toNode,toSide?,toEnd?,label?,color?}]}；Obsidian 扩展 type:'file'|'link'（带 file/url）。
  // color = '1'..'6'（Obsidian 预设色板）或 '#hex'。坏 JSON / 缺 nodes 返 {err}。
  const WKCV_PRESET = { 1: '#e5534b', 2: '#e0823d', 3: '#d4b52c', 4: '#4caf62', 5: '#3fa7c4', 6: '#9a6ff0' }
  function wkCvColor(v) {
    if (!v) return ''
    if (WKCV_PRESET[v]) return WKCV_PRESET[v]
    if (/^#[0-9a-f]{3,8}$/i.test(v)) return v
    return ''
  }
  function wkCvRgba(hex, a) {
    const m = /^#([0-9a-f]{3,8})$/i.exec(hex)
    if (!m) return ''
    let h = m[1]
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
    const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16)
    return `rgba(${r},${g},${b},${a})`
  }
  function wkCvParse(text) {
    let j
    try { j = JSON.parse(text) } catch (e) { return { err: 'JSON 解析失败：' + (e.message || e) } }
    if (!j || !Array.isArray(j.nodes)) return { err: '不是有效的 JSON Canvas（缺 nodes 数组）' }
    const nodes = [], byId = new Map()
    for (const n of j.nodes) {
      if (!n || typeof n.id !== 'string' || !Number.isFinite(n.x) || !Number.isFinite(n.y)) continue
      const node = {
        id: n.id,
        type: n.type === 'group' ? 'group' : n.type === 'file' ? 'file' : n.type === 'link' ? 'link' : 'text',
        x: n.x, y: n.y,
        w: Number.isFinite(n.width) ? n.width : 240,
        h: Number.isFinite(n.height) ? n.height : 120,
        color: wkCvColor(n.color),
        text: typeof n.text === 'string' ? n.text : typeof n.file === 'string' ? n.file : typeof n.url === 'string' ? n.url : '',
        label: typeof n.label === 'string' ? n.label : '',
      }
      nodes.push(node)
      byId.set(node.id, node)
    }
    const edges = []
    if (Array.isArray(j.edges)) {
      for (const e of j.edges) {
        if (!e || !byId.has(e.fromNode) || !byId.has(e.toNode)) continue
        edges.push({ from: byId.get(e.fromNode), to: byId.get(e.toNode), fs: e.fromSide || '', ts: e.toSide || '', arrow: e.toEnd !== 'none', label: typeof e.label === 'string' ? e.label : '', color: wkCvColor(e.color) })
      }
    }
    return { nodes, edges, err: '' }
  }
  // 摘要行文案（画布顶栏）：计数 / 空图 / 错误。
  function wkCvSummary(d) {
    if (d.err) return d.err
    if (!d.nodes.length) return '空画布'
    return `${d.nodes.length} 节点 · ${d.edges.length} 连线`
  }

  // ---------- 相机（平移/缩放；模块级单份：docChanged 重建 widget 时保留视口，换文件重 fit） ----------
  let wkCvCam = { k: 1, tx: 0, ty: 0, fit: false }
  let wkCvLastFile = ''
  let wkCvSeq = 0 // defs id 去重后缀（换装饰的瞬间新旧 widget 短暂共存）
  // 包围盒适配：k 帽 [0.05, 4]，内容居中。cw/ch = 可用视口尺寸。
  function wkCvFit(nodes, cw, ch) {
    if (!nodes.length) return { k: 1, tx: 0, ty: 0, fit: true }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const n of nodes) {
      x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y)
      x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h)
    }
    const k = Math.max(0.05, Math.min(4, Math.min((cw - 40) / Math.max(1, x1 - x0), (ch - 40) / Math.max(1, y1 - y0), 1.5)))
    return { k, tx: (cw - (x1 - x0) * k) / 2 - x0 * k, ty: (ch - (y1 - y0) * k) / 2 - y0 * k, fit: true }
  }
  function wkCvApply(svg, cam) {
    const g = svg && svg.querySelector('g.wk-cv-world')
    if (g) g.setAttribute('transform', `translate(${cam.tx},${cam.ty}) scale(${cam.k})`)
  }
  // 节点某侧的锚点（世界坐标）；side 缺省返回 null，由调用方按相对方位就近取。
  function wkCvAnchor(n, side) {
    if (side === 'left') return [n.x, n.y + n.h / 2]
    if (side === 'right') return [n.x + n.w, n.y + n.h / 2]
    if (side === 'top') return [n.x + n.w / 2, n.y]
    if (side === 'bottom') return [n.x + n.w / 2, n.y + n.h]
    return null
  }
  // 连线几何：端点锚（缺省按两节点中心连线的主轴取最近侧——水平位移为主取左/右，竖直为主取上/
  // 下；旧实现恒按水平取侧，上下堆叠的节点连线会从侧腰横着出去再拐弯，方向观感即「不对」）
  // + 三次贝塞尔控制点 + t=0.5 中点（放 label）。fromSide/toSide 显式声明时仍按声明取锚（spec 语义）。
  function wkCvDefaultAnchor(n, tx, ty) {
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2
    if (Math.abs(tx - cx) >= Math.abs(ty - cy)) return tx < cx ? [n.x, cy] : [n.x + n.w, cy]
    return ty < cy ? [cx, n.y] : [cx, n.y + n.h]
  }
  function wkCvEdgeGeom(e) {
    let a = wkCvAnchor(e.from, e.fs)
    if (!a) a = wkCvDefaultAnchor(e.from, e.to.x + e.to.w / 2, e.to.y + e.to.h / 2)
    let b = wkCvAnchor(e.to, e.ts)
    if (!b) b = wkCvDefaultAnchor(e.to, e.from.x + e.from.w / 2, e.from.y + e.from.h / 2)
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const horiz = Math.abs(dx) >= Math.abs(dy)
    const d = horiz
      ? `M ${a[0]} ${a[1]} C ${a[0] + dx / 2} ${a[1]}, ${b[0] - dx / 2} ${b[1]}, ${b[0]} ${b[1]}`
      : `M ${a[0]} ${a[1]} C ${a[0]} ${a[1] + dy / 2}, ${b[0]} ${b[1] - dy / 2}, ${b[0]} ${b[1]}`
    // 三次贝塞尔 t=0.5：(P0 + 3P1 + 3P2 + P3) / 8
    const mx = (a[0] + 3 * (a[0] + (horiz ? dx / 2 : 0)) + 3 * (b[0] - (horiz ? dx / 2 : 0)) + b[0]) / 8
    const my = (a[1] + 3 * (a[1] + (horiz ? 0 : dy / 2)) + 3 * (b[1] - (horiz ? 0 : dy / 2)) + b[1]) / 8
    return { d, mx, my }
  }

  // ---------- SVG 工具 ----------
  function wkCvEl(tag, attrs) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag)
    for (const k in attrs) el.setAttribute(k, attrs[k])
    return el
  }

  // ---------- 图形编辑（节点/组拖动改坐标 + 双击改文字；写入 = 原样改写源 JSON 再整篇 dispatch 回
  // 编辑器文档——保留源里本前端不识别的扩展字段，写回后走既有自动保存链落盘。相机在模块级保留，
  // dispatch 触发 widget 重建不丢视口。拖动过程只做视觉位移，pointerup 才一次性写文档（一次手势 =
  // 一次编辑 = 一条撤销步）。连线端点随拖动的跟随要等重建（重建后按新坐标重画），拖动中不实时跟。 ----------
  function wkCvWriteDoc(view, j) {
    try {
      const text = JSON.stringify(j, null, 2) + '\n'
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
    } catch { /* 编辑器已销毁（切文件竞速）：丢弃本次手势 */ }
  }
  function wkCvRawNode(raw, id) {
    return (Array.isArray(raw && raw.nodes) ? raw.nodes : []).find((x) => x && x.id === id) || null
  }
  function wkCvBindEdit(view, root, data, raw, gElById) {
    for (const n of data.nodes) {
      const gEl = gElById.get(n.id)
      if (!gEl) continue
      gEl.classList.add(n.type === 'group' ? 'wk-cv-drag-grp' : 'wk-cv-drag-node')
      // 拖动（左键/单指）：拖组 = 组框 + 组内节点（中心落在组框内）一起平移，对齐 Obsidian 语义。
      gEl.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return
        e.stopPropagation() // 不进 pan
        const moved = [n]
        if (n.type === 'group') {
          for (const m of data.nodes) {
            if (m === n || m.type === 'group') continue
            const cx = m.x + m.w / 2, cy = m.y + m.h / 2
            if (cx >= n.x && cx <= n.x + n.w && cy >= n.y && cy <= n.y + n.h) moved.push(m)
          }
        }
        const sx = e.clientX, sy = e.clientY
        let dx = 0, dy = 0
        root.classList.add('wk-cv-dragging')
        try { gEl.setPointerCapture(e.pointerId) } catch { /* 捕获失败照常走 move/up */ }
        const move = (ev) => {
          if (ev.pointerId !== e.pointerId) return
          dx = (ev.clientX - sx) / wkCvCam.k
          dy = (ev.clientY - sy) / wkCvCam.k
          for (const m of moved) {
            const el = gElById.get(m.id)
            if (el) el.setAttribute('transform', `translate(${dx},${dy})`)
          }
        }
        const finish = (ev) => {
          if (ev.pointerId !== e.pointerId) return
          gEl.removeEventListener('pointermove', move)
          gEl.removeEventListener('pointerup', finish)
          gEl.removeEventListener('pointercancel', cancel)
          root.classList.remove('wk-cv-dragging')
          if (!dx && !dy) return
          for (const m of moved) {
            const r = wkCvRawNode(raw, m.id)
            if (!r) continue
            r.x = Math.round((Number(r.x) || 0) + dx)
            r.y = Math.round((Number(r.y) || 0) + dy)
            m.x += dx
            m.y += dy
            const el = gElById.get(m.id)
            if (el) el.removeAttribute('transform')
          }
          wkCvWriteDoc(view, raw)
        }
        const cancel = (ev) => {
          if (ev.pointerId !== e.pointerId) return
          gEl.removeEventListener('pointermove', move)
          gEl.removeEventListener('pointerup', finish)
          gEl.removeEventListener('pointercancel', cancel)
          root.classList.remove('wk-cv-dragging')
          for (const m of moved) {
            const el = gElById.get(m.id)
            if (el) el.removeAttribute('transform')
          }
        }
        gEl.addEventListener('pointermove', move)
        gEl.addEventListener('pointerup', finish)
        gEl.addEventListener('pointercancel', cancel)
      })
      // 双击改文字：节点改 text/file/url（按源里已有的字段写回，不新增键）；组改 label。
      gEl.addEventListener('dblclick', (e) => {
        e.stopPropagation()
        const r = wkCvRawNode(raw, n.id)
        if (!r) return
        if (n.type === 'group') {
          const v = window.prompt('组名称', n.label || '')
          if (v === null) return
          r.label = v
          n.label = v
        } else {
          const key = typeof r.text === 'string' ? 'text' : typeof r.file === 'string' ? 'file' : typeof r.url === 'string' ? 'url' : 'text'
          const v = window.prompt('节点文字', n.text || '')
          if (v === null) return
          r[key] = v
          n.text = v
        }
        wkCvWriteDoc(view, raw)
      })
    }
  }

  // ---------- 画布 widget（decoField 的 block replace 宿主；跨行 replace 只允许走 StateField） ----------
  // 必须继承 CM.WidgetType：视图在 DOM 复用/测量/事件路径会调基类方法（compare/estimatedHeight/
  // ignoreEvent/updateDOM 等），普通 class 缺这些方法 ⇒ 首次 docChanged 半更新抛 TypeError，之后每次
  // dispatch 都在破损视图上再抛 ⇒ 编辑区整体报废（连开其它文件也失败）。vendored 脚本先于 /app.js 加载，
  // 基类在模块求值期可取。
  const WkCvWidgetBase = window.CMLiveMarkdown.WidgetType
  class WkCvWidget extends WkCvWidgetBase {
    constructor(text) { super(); this.text = text }
    eq() { return false } // doc 变 / 态切时恒重建 DOM（相机状态在模块级 wkCvCam 保留）
    toDOM(view) {
      const root = document.createElement('div')
      root.className = 'wk-cv'
      const data = wkCvParse(this.text)
      // 换文件 → 重 fit（相机归属当前文件；同文件 docChanged 重建时保留视口）
      if (wkCvLastFile !== state.workFile) { wkCvLastFile = state.workFile; wkCvCam.fit = false }
      // 顶栏：摘要 + 「编辑源码」
      const bar = document.createElement('div')
      bar.className = 'wk-cv-bar'
      const cnt = document.createElement('span')
      cnt.className = 'wk-cv-cnt'
      cnt.textContent = data.err || wkCvSummary(data)
      const srcBtn = document.createElement('button')
      srcBtn.className = 'wk-cv-btn'
      srcBtn.type = 'button'
      srcBtn.textContent = '编辑源码'
      srcBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        view.dispatch({ effects: wkCvToggle.of() })
      })
      bar.appendChild(cnt)
      bar.appendChild(srcBtn)
      root.appendChild(bar)
      if (data.err) {
        const hint = document.createElement('div')
        hint.className = 'wk-cv-empty wk-cv-bad'
        hint.textContent = data.err + ' — 点右上「编辑源码」修复'
        root.appendChild(hint)
        return root
      }
      if (!data.nodes.length) {
        const hint = document.createElement('div')
        hint.className = 'wk-cv-empty'
        hint.textContent = '空画布 — 点右上「编辑源码」写入 JSON Canvas（nodes/edges）'
        root.appendChild(hint)
        return root
      }
      const seq = ++wkCvSeq
      const svg = wkCvEl('svg', { class: 'wk-cv-svg' })
      const defs = wkCvEl('defs', {})
      // 点阵网格（pattern 在世界坐标系里随相机变换，24px 格距）
      const pat = wkCvEl('pattern', { id: `wkcvg${seq}`, width: 24, height: 24, patternUnits: 'userSpaceOnUse' })
      pat.appendChild(wkCvEl('circle', { cx: 1.2, cy: 1.2, r: 1.2, class: 'wk-cv-dot' }))
      defs.appendChild(pat)
      // 边箭头 marker（按色注册，id 带色值去重）
      const mk = (color) => {
        const id = `wkcvk${seq}${color ? color.slice(1) : 'n'}`
        if (!defs.querySelector(`#${id}`)) {
          const marker = wkCvEl('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' })
          const tri = wkCvEl('path', { d: 'M 0 1 L 9 5 L 0 9 z' })
          if (color) tri.style.fill = color
          else tri.setAttribute('class', 'wk-cv-arrow')
          marker.appendChild(tri)
          defs.appendChild(marker)
        }
        return id
      }
      svg.appendChild(defs)
      const world = wkCvEl('g', { class: 'wk-cv-world' })
      svg.appendChild(world)
      const cover = 200000 // 网格铺底的世界域（pan 到 ±10 万单位内不露底）
      world.appendChild(wkCvEl('rect', { x: -cover / 2, y: -cover / 2, width: cover, height: cover, fill: `url(#wkcvg${seq})` }))
      const edgesG = wkCvEl('g', { class: 'wk-cv-edges' })
      const nodesG = wkCvEl('g', { class: 'wk-cv-nodes' })
      world.appendChild(edgesG)
      world.appendChild(nodesG)
      // 边
      for (const e of data.edges) {
        const g = wkCvEdgeGeom(e)
        const path = wkCvEl('path', { d: g.d, class: 'wk-cv-edge', fill: 'none' })
        if (e.color) path.style.stroke = e.color
        if (e.arrow) path.setAttribute('marker-end', `url(#${mk(e.color)})`)
        edgesG.appendChild(path)
        if (e.label) {
          const t = wkCvEl('text', { x: g.mx, y: g.my, class: 'wk-cv-elabel', 'text-anchor': 'middle' })
          t.textContent = e.label
          edgesG.appendChild(t)
        }
      }
      // 节点：群组先画（z 序垫底），其余按数组序。图形编辑（2026-10-14 待办#2 补缺）：节点/组可拖动
      // 改坐标、双击改文字，落点 = 原样改写源 JSON（保留未识别字段）并 dispatch 回编辑器文档
      // （走既有自动保存链落盘）。raw = JSON.parse 原文（渲染用 normalized 副本，写入用 raw 保字段）；
      // 能走到此处 = wkCvParse 已验证 JSON 合法（坏 JSON 在 err 分支早退），此处解析不设防。
      const raw = JSON.parse(this.text)
      const ordered = [...data.nodes.filter((n) => n.type === 'group'), ...data.nodes.filter((n) => n.type !== 'group')]
      const XHTML = 'http://www.w3.org/1999/xhtml'
      const gElById = new Map()
      for (const n of ordered) {
        const gEl = wkCvEl('g', { class: 'wk-cv-node' + (n.type === 'group' ? ' wk-cv-group' : '') })
        gElById.set(n.id, gEl)
        const rect = wkCvEl('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: n.type === 'group' ? 10 : 8, class: 'wk-cv-box' })
        if (n.color) {
          rect.style.fill = wkCvRgba(n.color, n.type === 'group' ? 0.08 : 0.16)
          rect.style.stroke = wkCvRgba(n.color, 0.65)
        }
        if (n.type === 'group') rect.setAttribute('stroke-dasharray', '5 4')
        gEl.appendChild(rect)
        if (n.type === 'group') {
          if (n.label) {
            // 组名按 Obsidian 惯例放框外顶上（旧实现塞框内第一行，与节点正文争空间 =「组的 UI 不好」）
            const t = wkCvEl('text', { x: n.x + 2, y: n.y - 8, class: 'wk-cv-glabel' })
            t.textContent = n.label
            if (n.color) t.style.fill = wkCvRgba(n.color, 0.95)
            gEl.appendChild(t)
          }
        } else {
          const fo = wkCvEl('foreignObject', { x: n.x + 8, y: n.y + 6, width: Math.max(10, n.w - 16), height: Math.max(10, n.h - 12) })
          const box = document.createElementNS(XHTML, 'div')
          box.className = 'wk-cv-text'
          box.textContent = n.text
          fo.appendChild(box)
          gEl.appendChild(fo)
        }
        nodesG.appendChild(gEl)
      }
      if (raw) wkCvBindEdit(view, root, data, raw, gElById)
      // 相机：未 fit 过（新文件）→ 包围盒适配；否则保留上次的平移缩放
      if (!wkCvCam.fit) {
        const sc = view.dom.querySelector('.cm-scroller')
        wkCvCam = wkCvFit(data.nodes, sc ? sc.clientWidth : 600, sc ? sc.clientHeight : 400)
      }
      wkCvApply(svg, wkCvCam)
      root.appendChild(svg)
      // 高度跟随滚动容器（.cm-content 内百分比高度链不通，JS 实测）
      const sc2 = view.dom.querySelector('.cm-scroller')
      const setH = () => { if (sc2 && sc2.clientHeight) root.style.height = Math.max(200, sc2.clientHeight - 24) + 'px' }
      setH()
      this._ro = new ResizeObserver(setH)
      if (sc2) this._ro.observe(sc2)
      // 平移 / 缩放：单指拖 = pan；双指 = 捏合缩放（锚中点）+ 中点位移 pan；Ctrl+滚轮（Safari 触控板
      // 捏合的手势编码）= 指针锚定缩放；普通滚轮 = 平移。事件截断在画布容器，不漏给编辑器光标。
      const active = new Map()
      let pinch = null
      root.addEventListener('pointerdown', (e) => {
        active.set(e.pointerId, [e.clientX, e.clientY])
        if (active.size === 2) {
          const [a, b] = [...active.values()]
          pinch = { d: Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1])), k: wkCvCam.k, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] }
        }
        root.setPointerCapture(e.pointerId)
        e.stopPropagation()
      })
      root.addEventListener('pointermove', (e) => {
        if (!active.has(e.pointerId)) return
        const prev = active.get(e.pointerId)
        active.set(e.pointerId, [e.clientX, e.clientY])
        if (active.size === 2 && pinch) {
          const [a, b] = [...active.values()]
          const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2
          const d = Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1]))
          // 缩放锚定双指中点 + 中点位移平移
          wkCvCam.k = Math.max(0.05, Math.min(4, pinch.k * (d / pinch.d)))
          wkCvCam.tx += cx - pinch.mid[0]
          wkCvCam.ty += cy - pinch.mid[1]
          pinch.mid = [cx, cy]
        } else if (active.size === 1) {
          wkCvCam.tx += e.clientX - prev[0]
          wkCvCam.ty += e.clientY - prev[1]
        }
        wkCvApply(svg, wkCvCam)
        e.stopPropagation()
      })
      const up = (e) => { active.delete(e.pointerId); if (active.size < 2) pinch = null; e.stopPropagation() }
      root.addEventListener('pointerup', up)
      root.addEventListener('pointercancel', up)
      root.addEventListener('wheel', (e) => {
        e.preventDefault()
        e.stopPropagation()
        if (e.ctrlKey) {
          const rect = svg.getBoundingClientRect()
          const cx = e.clientX - rect.left, cy = e.clientY - rect.top
          const k0 = wkCvCam.k
          wkCvCam.k = Math.max(0.05, Math.min(4, k0 * Math.exp(-e.deltaY * 0.002)))
          // 缩放锚定指针：指针下的世界点不动
          wkCvCam.tx = cx - ((cx - wkCvCam.tx) / k0) * wkCvCam.k
          wkCvCam.ty = cy - ((cy - wkCvCam.ty) / k0) * wkCvCam.k
        } else {
          wkCvCam.tx -= e.deltaX
          wkCvCam.ty -= e.deltaY
        }
        wkCvApply(svg, wkCvCam)
      }, { passive: false })
      return root
    }
    destroy() {
      if (this._ro) { this._ro.disconnect(); this._ro = null }
    }
  }

  // ---------- 源码态的回流入口（首行行前小按钮「图形预览」） ----------
  class WkCvOpenBtn extends WkCvWidgetBase {
    eq(w) { return w instanceof WkCvOpenBtn }
    toDOM(view) {
      const b = document.createElement('button')
      b.className = 'wk-cv-btn wk-cv-open'
      b.type = 'button'
      b.textContent = '图形预览'
      b.addEventListener('click', (e) => {
        e.stopPropagation()
        view.dispatch({ effects: wkCvToggle.of() })
      })
      return b
    }
  }

  // ---------- 扩展组装（wkEdLangExt 对 .canvas 返回它） ----------
  let wkCvToggle = null // StateEffect：图形 ⇄ 源码（wkCvExt 组装时置位；按钮 dispatch 读全局当前值）
  function wkCvExt(CM) {
    const toggle = CM.StateEffect.define()
    wkCvToggle = toggle
    const onField = CM.StateField.define({
      create: () => true, // 默认图形态
      update(v, tr) {
        for (const e of tr.effects) if (e.is(toggle)) return !v
        return v
      },
    })
    // 装饰真源（跨行 block replace 仅 StateField 可为）：图形态 = block replace 覆盖整篇；源码态 =
    // 首行行前「图形预览」按钮。create/update 同一套构造（create 覆盖 setDoc 被同文本跳过的路）。
    const buildDeco = (st) => {
      if (st.field(onField) && st.doc.length > 0) {
        return CM.Decoration.set([CM.Decoration.replace({ widget: new WkCvWidget(st.doc.toString()), block: true }).range(0, st.doc.length)], true)
      }
      return CM.Decoration.set([CM.Decoration.widget({ widget: new WkCvOpenBtn(), side: -1 }).range(0)], true)
    }
    const decoField = CM.StateField.define({
      create: (st) => buildDeco(st),
      update(deco, tr) {
        if (!tr.docChanged && !tr.effects.some((e) => e.is(toggle))) return deco.map(tr.changes)
        return buildDeco(tr.state)
      },
      provide: (f) => CM.EditorView.decorations.from(f),
    })
    // 源码态 JSON 高亮
    return [onField, decoField, CM.json(), CM.syntaxHighlighting(wkEdHlStyle)]
  }
