// .canvas 文件（JSON Canvas 1.0，Obsidian 同格式）的图形预览+编辑：wkEdLangExt 对 .canvas 扩展名注入
// wkCvExt —— 默认把整篇文档替换为画布（群组/边/节点 + 点阵网格 + 平移/缩放），画布顶栏「编辑源码」
// 切回 JSON（带高亮、可正常自动保存）；源码态文档首行挂「图形预览」钮切回画布。图形编辑（2026-10-14
// 待办#2 补缺）：节点/组拖动改坐标、双击改文字，写入=原样改写源 JSON（保留未识别字段）dispatch 回
// 编辑器文档走既有自动保存链。
// 2026-10-24 用户定案「搬用 comfyui 的画布结构」：图形一律画在 <canvas> 2D 上下文（网格/边/节点/文字），
// DOM 只作**兄弟覆盖层**承载可交互件（行内编辑器、顶栏按钮）——DOM 不进画布手势路径，canvas 的
// pointer capture 也就不会把按钮 click 吞掉（旧实现把 capture 无条件挂在包含顶栏的容器上，实报按钮失效）。
// 手势判定同 ComfyUI：按下不抢指针，位移越过 6px 才 setPointerCapture（click 语义保持原生），up/cancel
// 一律释放。渲染零依赖（不引外部 canvas 库）；自定色用内联 rgba（Safari 对 color-mix 支持不稳）。
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
  // 世界 ⇄ 屏幕（画布内坐标，不含 canvas 的页面偏移）：screen = world * k + t。
  function wkCvToScreen(cam, x, y) { return [x * cam.k + cam.tx, y * cam.k + cam.ty] }
  function wkCvToWorld(cam, sx, sy) { return [(sx - cam.tx) / cam.k, (sy - cam.ty) / cam.k] }
  // 节点某侧的锚点（世界坐标）；side 缺省返回 null，由调用方按相对方位就近取。
  function wkCvAnchor(n, side) {
    if (side === 'left') return [n.x, n.y + n.h / 2]
    if (side === 'right') return [n.x + n.w, n.y + n.h / 2]
    if (side === 'top') return [n.x + n.w / 2, n.y]
    if (side === 'bottom') return [n.x + n.w / 2, n.y + n.h]
    return null
  }
  // 连线几何：端点锚 + 出线方向法线。显式 fromSide/toSide 按声明取锚与法线；缺省按两节点中心
  // 连线的主轴取最近侧（水平位移为主取左/右、竖直为主取上/下）。贝塞尔控制点 = 各自锚点沿该侧
  // 法线伸出到「对端方向分量」的一半 —— 曲线严格从声明侧出发/进入。
  const WKCV_SIDE_DIRS = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] }
  function wkCvAnchorDir(n, side, tx, ty) {
    if (side && WKCV_SIDE_DIRS[side]) {
      const p = wkCvAnchor(n, side)
      if (p) return { p, n: WKCV_SIDE_DIRS[side] }
    }
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2
    if (Math.abs(tx - cx) >= Math.abs(ty - cy)) {
      return tx < cx ? { p: [n.x, cy], n: WKCV_SIDE_DIRS.left } : { p: [n.x + n.w, cy], n: WKCV_SIDE_DIRS.right }
    }
    return ty < cy ? { p: [cx, n.y], n: WKCV_SIDE_DIRS.top } : { p: [cx, n.y + n.h], n: WKCV_SIDE_DIRS.bottom }
  }
  function wkCvEdgeGeom(e) {
    const A = wkCvAnchorDir(e.from, e.fs, e.to.x + e.to.w / 2, e.to.y + e.to.h / 2)
    const B = wkCvAnchorDir(e.to, e.ts, e.from.x + e.from.w / 2, e.from.y + e.from.h / 2)
    const a = A.p, b = B.p
    const kA = Math.max(24, Math.abs((b[0] - a[0]) * A.n[0] + (b[1] - a[1]) * A.n[1]) / 2)
    const kB = Math.max(24, Math.abs((b[0] - a[0]) * B.n[0] + (b[1] - a[1]) * B.n[1]) / 2)
    const c1 = [a[0] + A.n[0] * kA, a[1] + A.n[1] * kA]
    const c2 = [b[0] + B.n[0] * kB, b[1] + B.n[1] * kB]
    // 三次贝塞尔 t=0.5：(P0 + 3P1 + 3P2 + P3) / 8（放 label）
    const mx = (a[0] + 3 * c1[0] + 3 * c2[0] + b[0]) / 8
    const my = (a[1] + 3 * c1[1] + 3 * c2[1] + b[1]) / 8
    return { a, c1, c2, b, mx, my }
  }

  // ---------- 画布绘制（2D context；世界坐标 → 屏幕统一乘相机） ----------
  const WKCV_FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif'
  // 主题色快照（每次重绘读一次；canvas 不认 CSS 变量）
  function wkCvTheme() {
    const cs = getComputedStyle(document.documentElement)
    const g = (n, d) => (cs.getPropertyValue(n) || '').trim() || d
    return {
      bg: g('--bg', '#fff'), text: g('--text', '#222'), text2: g('--text-2', '#555'),
      text3: g('--text-3', '#888'), border: g('--border', '#ddd'), blue: g('--blue', '#4d6bfe'),
    }
  }
  // 文本按像素宽度折行（CJK 可逐字断、拉丁词优先整词）。返回行数组，最多 maxLines 行。
  function wkCvWrap(ctx, text, maxW, maxLines) {
    const out = []
    for (const para of String(text == null ? '' : text).split('\n')) {
      if (out.length >= maxLines) return out
      let line = ''
      let word = ''
      const flushWord = () => { line += word; word = '' }
      for (const ch of para) {
        if (ch === ' ') { flushWord(); line += ch; continue }
        // 拉丁字母数字成词，其它（CJK/标点）逐字
        if (/[A-Za-z0-9_@#$%&*+\-/\\=.:;'"!?()\[\]{}<>]/.test(ch)) { word += ch; continue }
        flushWord()
        if (line && ctx.measureText(line + ch).width > maxW) { out.push(line); line = ''; if (out.length >= maxLines) return out }
        line += ch
      }
      flushWord()
      if (line && ctx.measureText(line).width > maxW) {
        // 整词超宽：逐字硬断
        let cur = ''
        for (const ch of line) {
          if (cur && ctx.measureText(cur + ch).width > maxW) { out.push(cur); cur = ''; if (out.length >= maxLines) return out }
          cur += ch
        }
        line = cur
      }
      if (line || !para) out.push(line)
    }
    return out
  }
  function wkCvRoundRect(ctx, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, w / 2, h / 2))
    ctx.beginPath()
    ctx.moveTo(x + rr, y)
    ctx.lineTo(x + w - rr, y)
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr)
    ctx.lineTo(x + w, y + h - rr)
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h)
    ctx.lineTo(x + rr, y + h)
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr)
    ctx.lineTo(x, y + rr)
    ctx.quadraticCurveTo(x, y, x + rr, y)
    ctx.closePath()
  }
  // 主绘制：只画、不带状态。opts.active = 正在拖动的节点集合（画高亮 + 偏移已并进坐标）。
  function wkCvPaint(canvas, data, cam, theme, opts) {
    const stage = canvas.parentElement
    const dpr = window.devicePixelRatio || 1
    const cw = Math.max(1, stage ? stage.clientWidth : 0)
    const ch = Math.max(1, stage ? stage.clientHeight : 0)
    const pw = Math.round(cw * dpr), ph = Math.round(ch * dpr)
    if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cw, ch)
    ctx.fillStyle = theme.bg
    ctx.fillRect(0, 0, cw, ch)
    const k = cam.k
    const dragSet = (opts && opts.drag) || null
    const off = (n) => (dragSet && dragSet.byId.get(n.id)) || [0, 0]

    // 点阵网格：世界 24 单位格；缩得太小时逐级加倍，屏上点距不小于 12px，总点数封顶。
    let step = 24
    while (step * k < 12) step *= 2
    const [wx0, wy0] = wkCvToWorld(cam, 0, 0)
    const [wx1, wy1] = wkCvToWorld(cam, cw, ch)
    const gx0 = Math.floor(wx0 / step) * step, gy0 = Math.floor(wy0 / step) * step
    const nx = Math.floor((wx1 - gx0) / step) + 1, ny = Math.floor((wy1 - gy0) / step) + 1
    const every = Math.max(1, Math.ceil((nx * ny) / 4000))
    ctx.fillStyle = theme.border
    ctx.globalAlpha = 0.55
    let ci = 0
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        if ((ci++ % every) !== 0) continue
        const [sx, sy] = wkCvToScreen(cam, gx0 + ix * step, gy0 + iy * step)
        ctx.beginPath()
        ctx.arc(sx, sy, 1.2, 0, Math.PI * 2)
        ctx.fill()
      }
    }
    ctx.globalAlpha = 1

    // 边（世界坐标直接经 ctx 变换绘制：曲线 + 箭头 + 标签）
    ctx.save()
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * cam.tx, dpr * cam.ty)
    ctx.lineWidth = 1.5 / k
    ctx.strokeStyle = theme.text3
    ctx.fillStyle = theme.text3
    for (const e of data.edges) {
      const oa = off(e.from), ob = off(e.to)
      const A = { ...e.from, x: e.from.x + oa[0], y: e.from.y + oa[1] }
      const B = { ...e.to, x: e.to.x + ob[0], y: e.to.y + ob[1] }
      const g = wkCvEdgeGeom({ ...e, from: A, to: B })
      const col = e.color || theme.text3
      ctx.strokeStyle = col
      ctx.fillStyle = col
      ctx.beginPath()
      ctx.moveTo(g.a[0], g.a[1])
      ctx.bezierCurveTo(g.c1[0], g.c1[1], g.c2[0], g.c2[1], g.b[0], g.b[1])
      ctx.stroke()
      if (e.arrow) {
        // 箭头方向 = 曲线在终点的切线（控制点 c2 → b）
        const ang = Math.atan2(g.b[1] - g.c2[1], g.b[0] - g.c2[0])
        const al = 9 / k, aw = 4.5 / k
        ctx.beginPath()
        ctx.moveTo(g.b[0], g.b[1])
        ctx.lineTo(g.b[0] - al * Math.cos(ang) + aw * Math.sin(ang), g.b[1] - al * Math.sin(ang) - aw * Math.cos(ang))
        ctx.lineTo(g.b[0] - al * Math.cos(ang) - aw * Math.sin(ang), g.b[1] - al * Math.sin(ang) + aw * Math.cos(ang))
        ctx.closePath()
        ctx.fill()
      }
      if (e.label) {
        ctx.font = `${11 / k}px ${WKCV_FONT}`
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.lineWidth = 3 / k
        ctx.strokeStyle = theme.bg
        ctx.strokeText(e.label, g.mx, g.my)
        ctx.fillStyle = e.color || theme.text2
        ctx.fillText(e.label, g.mx, g.my)
      }
    }
    ctx.restore()

    // 节点（群组先画、垫底；其余按数组序 = 命中测试的 z 序）
    const ordered = [...data.nodes.filter((n) => n.type === 'group'), ...data.nodes.filter((n) => n.type !== 'group')]
    for (const n of ordered) {
      const [dx, dy] = off(n)
      const x = n.x + dx, y = n.y + dy
      ctx.save()
      ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * cam.tx, dpr * cam.ty)
      const isDrag = !!(dragSet && dragSet.byId.has(n.id))
      const col = n.color || ''
      wkCvRoundRect(ctx, x, y, n.w, n.h, n.type === 'group' ? 10 : 8)
      ctx.fillStyle = col ? wkCvRgba(col, n.type === 'group' ? 0.08 : 0.16) : (isDrag ? wkCvRgba(theme.blue, 0.06) : 'rgba(0,0,0,0)')
      ctx.fill()
      ctx.lineWidth = (isDrag ? 2 : 1) / k
      ctx.strokeStyle = isDrag ? theme.blue : col ? wkCvRgba(col, 0.65) : theme.border
      if (n.type === 'group') ctx.setLineDash([5 / k, 4 / k])
      ctx.stroke()
      ctx.setLineDash([])
      ctx.restore()

      if (n.type === 'group') {
        if (n.label) {
          ctx.save()
          ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * cam.tx, dpr * cam.ty)
          ctx.font = `600 ${12 / k}px ${WKCV_FONT}`
          ctx.textAlign = 'left'
          ctx.textBaseline = 'alphabetic'
          ctx.lineWidth = 3 / k
          ctx.strokeStyle = theme.bg
          ctx.strokeText(n.label, x + 2, y - 8 / k)
          ctx.fillStyle = col ? wkCvRgba(col, 0.95) : theme.text2
          ctx.fillText(n.label, x + 2, y - 8 / k)
          ctx.restore()
        }
        continue
      }
      // 节点正文：按节点宽度折行，超出高度裁掉
      const padX = 8, padY = 6
      const maxW = Math.max(10, n.w - padX * 2)
      const fs = 12 / k
      ctx.save()
      ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * cam.tx, dpr * cam.ty)
      ctx.beginPath()
      ctx.rect(x + padX, y + padY, maxW, Math.max(10, n.h - padY * 2))
      ctx.clip()
      ctx.font = `${fs}px ${WKCV_FONT}`
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      ctx.fillStyle = theme.text
      const lh = 18 / k
      const lines = wkCvWrap(ctx, n.text, maxW, Math.max(1, Math.ceil((n.h - padY * 2) / lh)))
      for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], x + padX, y + padY + i * lh)
      ctx.restore()
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  // 命中测试：屏幕点 → 节点（节点在群组之上 ⇒ 逆序找非组，再找组）。返回 {node, dx, dy} 或 null。
  function wkCvHit(ordered, cam, sx, sy) {
    const [wx, wy] = wkCvToWorld(cam, sx, sy)
    for (let i = ordered.length - 1; i >= 0; i--) {
      const n = ordered[i]
      if (wx >= n.x && wx <= n.x + n.w && wy >= n.y && wy <= n.y + n.h) return n
    }
    return null
  }
  // 拖动集合：组 = 组框 + 中心落在组框内的节点（Obsidian 语义）
  function wkCvDragGroup(data, n) {
    const moved = [n]
    if (n.type === 'group') {
      for (const m of data.nodes) {
        if (m === n || m.type === 'group') continue
        const cx = m.x + m.w / 2, cy = m.y + m.h / 2
        if (cx >= n.x && cx <= n.x + n.w && cy >= n.y && cy <= n.y + n.h) moved.push(m)
      }
    }
    return moved
  }
  // 屏幕矩形（给行内编辑器定位）
  function wkCvScreenRect(cam, n) {
    const [sx, sy] = wkCvToScreen(cam, n.x, n.y)
    return { x: sx, y: sy, w: n.w * cam.k, h: n.h * cam.k }
  }

  // ---------- 图形编辑（拖动改坐标 + 双击改文字；写入 = 原样改写源 JSON 再整篇 dispatch 回编辑器
  // 文档——保留源里本前端不识别的扩展字段，写回后走既有自动保存链落盘。相机在模块级保留，
  // dispatch 触发 widget 重建不丢视口。拖动过程只画位移，pointerup 才一次性写文档（一次手势 =
  // 一次编辑 = 一条撤销步）。 ----------
  function wkCvWriteDoc(view, j) {
    try {
      const text = JSON.stringify(j, null, 2) + '\n'
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
    } catch { /* 编辑器已销毁（切文件竞速）：丢弃本次手势 */ }
  }
  function wkCvRawNode(raw, id) {
    return (Array.isArray(raw && raw.nodes) ? raw.nodes : []).find((x) => x && x.id === id) || null
  }
  // 行内编辑（ComfyUI 同构：编辑态 = DOM 覆盖层里的 textarea，画布手势整体关闭）：
  // Enter / blur 提交，Escape 取消，Shift+Enter 换行。写入 = 源 JSON 上已有的那个字段（不新增键）。
  function wkCvOpenEditor(view, root, overlay, data, raw, cam, n) {
    if (root.classList.contains('wk-cv-editing')) return
    root.classList.add('wk-cv-editing')
    const r = wkCvScreenRect(cam, n)
    const ta = document.createElement('textarea')
    ta.className = 'wk-cv-edit'
    ta.style.left = Math.max(0, r.x) + 'px'
    ta.style.top = Math.max(0, r.y) + 'px'
    ta.style.width = Math.max(80, r.w) + 'px'
    ta.style.height = Math.max(48, r.h) + 'px'
    const rn = wkCvRawNode(raw, n.id)
    ta.value = n.type === 'group'
      ? String((rn && rn.label) || '')
      : String((rn && (rn.text ?? rn.file ?? rn.url)) || '')
    overlay.appendChild(ta)
    let done = false
    const close = () => {
      if (done) return
      done = true
      root.classList.remove('wk-cv-editing')
      if (ta.parentElement) ta.parentElement.removeChild(ta)
    }
    const commit = () => {
      if (done) return
      const val = ta.value
      close()
      const target = wkCvRawNode(raw, n.id)
      if (!target) return
      if (n.type === 'group') target.label = val
      else if ('text' in target) target.text = val
      else if ('file' in target) target.file = val
      else if ('url' in target) target.url = val
      wkCvWriteDoc(view, raw)
    }
    ta.addEventListener('pointerdown', (e) => e.stopPropagation())
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close() }
      else if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit() }
    })
    ta.addEventListener('blur', commit)
    ta.focus()
    ta.select()
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
      // 编辑手段提示：拖动/双击无任何可见 affordance——顶栏常驻一行操作提示，源码态同隐藏。
      const hint = document.createElement('span')
      hint.className = 'wk-cv-hint'
      hint.textContent = '拖动移动 · 双击改文字 · 拖组带成员 · 捏合/滚轮缩放'
      bar.appendChild(hint)
      bar.appendChild(srcBtn)
      root.appendChild(bar)
      if (data.err) {
        const bad = document.createElement('div')
        bad.className = 'wk-cv-empty wk-cv-bad'
        bad.textContent = data.err + ' — 点右上「编辑源码」修复'
        root.appendChild(bad)
        return root
      }
      if (!data.nodes.length) {
        const empty = document.createElement('div')
        empty.className = 'wk-cv-empty'
        empty.textContent = '空画布 — 点右上「编辑源码」写入 JSON Canvas（nodes/edges）'
        root.appendChild(empty)
        return root
      }
      // ComfyUI 结构：stage（定位锚）里 canvas 画一切图形，overlay 是**兄弟**层（只放编辑控件）。
      const stage = document.createElement('div')
      stage.className = 'wk-cv-stage'
      const canvas = document.createElement('canvas')
      canvas.className = 'wk-cv-canvas'
      const overlay = document.createElement('div')
      overlay.className = 'wk-cv-overlay'
      stage.appendChild(canvas)
      stage.appendChild(overlay)
      root.appendChild(stage)
      const theme = wkCvTheme()

      // 相机：未 fit 过（新文件）→ 包围盒适配；否则保留上次的平移缩放
      if (!wkCvCam.fit) wkCvCam = wkCvFit(data.nodes, stage.clientWidth || 600, stage.clientHeight || 400)
      const ordered = [...data.nodes.filter((n) => n.type === 'group'), ...data.nodes.filter((n) => n.type !== 'group')]
      let dragPaint = null // {byId: Map<id,[dx,dy]>}
      const repaint = () => wkCvPaint(canvas, data, wkCvCam, theme, { drag: dragPaint })
      repaint()

      // 尺寸变化：canvas 像素尺寸跟随 stage（ResizeObserver 也负责首帧后的布局稳定）
      const ro = new ResizeObserver(() => { repaint() })
      ro.observe(stage)
      this._ro = ro

      // ---- 手势（只绑 canvas；overlay/顶栏不在捕获路径上） ----
      const active = new Map() // pointerId → [clientX, clientY]
      let pend = null          // {id, x, y} 未越过阈值的按下
      let drag = null          // {id, nodes:[...], sx, sy, dx, dy, moved}
      let pinch = null
      const PAN_SLOP = 6
      const localXY = (e) => {
        const r = canvas.getBoundingClientRect()
        return [e.clientX - r.left, e.clientY - r.top]
      }
      const releaseCap = (id) => { try { if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id) } catch { /* 已释放 */ } }
      const endDrag = () => { drag = null; dragPaint = null; root.classList.remove('wk-cv-dragging') }

      canvas.addEventListener('pointerdown', (e) => {
        if (root.classList.contains('wk-cv-editing')) return
        if (e.pointerType === 'mouse' && e.button !== 0) return
        active.set(e.pointerId, [e.clientX, e.clientY])
        if (active.size === 2) {
          // 双指：进入捏合，取消可能的节点拖动
          endDrag()
          const [a, b] = [...active.values()]
          pinch = { d: Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1])), k: wkCvCam.k, mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] }
          pend = null
        } else if (active.size === 1) {
          pend = { id: e.pointerId, x: e.clientX, y: e.clientY }
          const [lx, ly] = localXY(e)
          const hit = wkCvHit(ordered, wkCvCam, lx, ly)
          if (hit) drag = { id: e.pointerId, node: hit, nodes: wkCvDragGroup(data, hit), sx: e.clientX, sy: e.clientY, dx: 0, dy: 0 }
        }
        e.stopPropagation()
      })

      canvas.addEventListener('pointermove', (e) => {
        if (!active.has(e.pointerId)) return
        const prev = active.get(e.pointerId)
        active.set(e.pointerId, [e.clientX, e.clientY])
        // 阈值前不抢指针（click 语义保持原生）；越过 6px 才捕获
        if (pend && pend.id === e.pointerId && active.size === 1) {
          if (Math.hypot(e.clientX - pend.x, e.clientY - pend.y) < PAN_SLOP) { e.stopPropagation(); return }
          pend = null
          try { canvas.setPointerCapture(e.pointerId) } catch { /* 捕获失败照常走 move/up */ }
        }
        if (active.size === 2 && pinch) {
          const [a, b] = [...active.values()]
          const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2
          const d = Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1]))
          wkCvCam.k = Math.max(0.05, Math.min(4, pinch.k * (d / pinch.d)))
          wkCvCam.tx += cx - pinch.mid[0]
          wkCvCam.ty += cy - pinch.mid[1]
          pinch.mid = [cx, cy]
        } else if (active.size === 1 && drag && drag.id === e.pointerId) {
          drag.dx = (e.clientX - drag.sx) / wkCvCam.k
          drag.dy = (e.clientY - drag.sy) / wkCvCam.k
          if (drag.dx || drag.dy) root.classList.add('wk-cv-dragging')
          const byId = new Map()
          for (const m of drag.nodes) byId.set(m.id, [drag.dx, drag.dy])
          dragPaint = { byId }
        } else if (active.size === 1) {
          wkCvCam.tx += e.clientX - prev[0]
          wkCvCam.ty += e.clientY - prev[1]
        }
        repaint()
        e.stopPropagation()
      })

      const up = (e) => {
        active.delete(e.pointerId)
        if (pend && pend.id === e.pointerId) pend = null
        releaseCap(e.pointerId)
        if (active.size < 2) pinch = null
        if (drag && drag.id === e.pointerId) {
          const { nodes, dx, dy } = drag
          endDrag()
          if (dx || dy) wkCvWriteRaw(view, JSON.parse(this.text), nodes, dx, dy)
          repaint()
        }
        e.stopPropagation()
      }
      canvas.addEventListener('pointerup', up)
      canvas.addEventListener('pointercancel', up)
      canvas.addEventListener('lostpointercapture', (e) => {
        active.delete(e.pointerId)
        if (pend && pend.id === e.pointerId) pend = null
        if (drag && drag.id === e.pointerId) { endDrag(); repaint() }
      })

      canvas.addEventListener('wheel', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const [cx, cy] = localXY(e)
        if (e.ctrlKey) {
          const k0 = wkCvCam.k
          wkCvCam.k = Math.max(0.05, Math.min(4, k0 * Math.exp(-e.deltaY * 0.002)))
          // 缩放锚定指针：指针下的世界点不动
          wkCvCam.tx = cx - ((cx - wkCvCam.tx) / k0) * wkCvCam.k
          wkCvCam.ty = cy - ((cy - wkCvCam.ty) / k0) * wkCvCam.k
        } else {
          wkCvCam.tx -= e.deltaX
          wkCvCam.ty -= e.deltaY
        }
        repaint()
      }, { passive: false })

      // 双击 = 进入该节点/组的行内编辑（ComfyUI：编辑控件落在 DOM 覆盖层，画布手势关闭）
      canvas.addEventListener('dblclick', (e) => {
        if (root.classList.contains('wk-cv-editing')) return
        const [lx, ly] = localXY(e)
        const hit = wkCvHit(ordered, wkCvCam, lx, ly)
        if (!hit) return
        e.stopPropagation()
        const raw = JSON.parse(this.text)
        wkCvOpenEditor(view, root, overlay, data, raw, wkCvCam, hit)
      })
      return root
    }
    destroy() {
      if (this._ro) { this._ro.disconnect(); this._ro = null }
    }
  }

  // 拖动落盘：按 id 在原样 JSON 上改坐标（保留未识别字段），整篇 dispatch 回编辑区。
  function wkCvWriteRaw(view, raw, nodes, dx, dy) {
    for (const m of nodes) {
      const r = wkCvRawNode(raw, m.id)
      if (!r) continue
      r.x = Math.round((Number(r.x) || 0) + dx)
      r.y = Math.round((Number(r.y) || 0) + dy)
    }
    wkCvWriteDoc(view, raw)
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
