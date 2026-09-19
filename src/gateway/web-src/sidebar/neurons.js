// 神经元视图（web「神经」tab）：层级1 = 神经元选择卡片，层级2 = Canvas 力导向三级节点图
// （mem→cog→社群；2026-09-16 新增，数据源 = 网关 /gateway/neurons[/graph]，见 src/gateway/neuronViz.ts）

import { apiUrl, needToken } from '../core/gateway.js'
import { mgrColor, MGR_PALETTE } from './mgr-data.js'
import { setPanel } from './recent.js'
import { chatArea, esc, inputWrap, isMobile, messagesEl, saveMgrView, state, toast } from '../core/state.js'
  // ---------- 神经元视图（web「神经」tab）----------

  // 脑图标（层级1 卡片 + index.html tab 同款内联 svg）
  const NEU_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M9.5 4.5a2.5 2.5 0 0 0-2.5 2.5 2.5 2.5 0 0 0-1.8 4.2A2.6 2.6 0 0 0 6 15.6 2.5 2.5 0 0 0 8.5 18h1V4.5z"/>' +
    '<path d="M14.5 4.5A2.5 2.5 0 0 1 17 7a2.5 2.5 0 0 1 1.8 4.2 2.6 2.6 0 0 1-.8 4.4A2.5 2.5 0 0 1 15.5 18h-1V4.5z"/>' +
    '<path d="M12 4.5v13.5M12 18v1.5"/></svg>'

  // ---------- 数据源：神经元清单（层级1） ----------
  let NEU = null
  let NEU_LOADING = false
  let NEU_ERR = ''
  async function loadNeuronsData(force) {
    if (NEU && !force) return NEU
    if (needToken()) return null
    NEU_LOADING = true
    NEU_ERR = ''
    renderNeuGrid()
    try {
      const res = await fetch(apiUrl('/gateway/neurons'))
      const data = await res.json()
      if (!data || !Array.isArray(data.neurons)) throw new Error(data.error || 'bad response')
      NEU = data.neurons
    } catch (e) {
      NEU_ERR = e.message || String(e)
    } finally {
      NEU_LOADING = false
      renderNeuGrid()
    }
    return NEU
  }

  // ---------- 数据源：图数据包（层级2） ----------
  let NEU_GRAPH = null // 当前已加载图包（按 neuron.id 缓存一份；切换/重进 force 重拉）
  let NEU_GRAPH_LOADING = false
  let NEU_GRAPH_ERR = ''
  async function loadNeuronGraph(id, force) {
    if (NEU_GRAPH && NEU_GRAPH.neuron.id === id && !force) return NEU_GRAPH
    if (needToken()) return null
    if (NEU_GRAPH_LOADING) return null
    NEU_GRAPH_LOADING = true
    NEU_GRAPH_ERR = ''
    try {
      const res = await fetch(apiUrl('/gateway/neurons/graph?id=' + encodeURIComponent(id)))
      const data = await res.json()
      if (!data || !data.neuron || !Array.isArray(data.cogs)) throw new Error(data.error || 'bad response')
      NEU_GRAPH = data
    } catch (e) {
      NEU_GRAPH_ERR = e.message || String(e)
    } finally {
      NEU_GRAPH_LOADING = false
      if (state.mgrView.neuronSel) renderMgrNeurons() // 渲染唯一入口：就绪→startNeuGraph / 失败→错误态
    }
    return NEU_GRAPH
  }

  /** 神经元视图统一分发（mgr.js renderMgr 的 neurons 分支入口）：有选中 = 图视图，无 = 选择界面 */
  function renderMgrNeurons() {
    if (state.mgrView.neuronSel) renderNeuGraphView()
    else renderNeuPicker()
  }

  // ---------- 层级1：神经元选择界面 ----------
  function renderNeuPicker() {
    messagesEl.innerHTML =
      '<div class="mgr-pane">' +
      '<div class="mgr-top"></div>' +
      '<div class="mgr-head"><h2 class="mgr-title">神经元</h2>' +
      '<div class="mgr-sub">记忆神经元库 · mem→认知→社群三级节点图（数据源 .claude/neturon/neurons）</div></div>' +
      '<div class="mgr-grid" id="neu-grid"></div>' +
      '<div class="mgr-foot">数据源：网关 /gateway/neurons 实时扫描</div>' +
      '</div>'
    inputWrap.classList.remove('docked')
    chatArea.classList.remove('in-session')
    chatArea.classList.add('mgr-on')
    renderNeuGrid()
    loadNeuronsData(false)
  }

  function renderNeuGrid() {
    const grid = $('neu-grid')
    if (!grid) return
    if (NEU_LOADING) {
      grid.innerHTML = '<div class="mgr-empty">扫描神经元库中…</div>'
      return
    }
    if (NEU_ERR) {
      grid.innerHTML =
        '<div class="mgr-empty">清单加载失败：' + esc(NEU_ERR) +
        '<br><button class="mgr-retry" id="neu-retry">重试</button></div>'
      const retry = $('neu-retry')
      if (retry) retry.addEventListener('click', () => loadNeuronsData(true))
      return
    }
    const list = NEU || []
    grid.innerHTML = list.length
      ? list.map(neuCardHtml).join('')
      : '<div class="mgr-empty">未发现神经元库（各根 .claude/neturon/neurons/ 下含 config.yaml + l2.mem/mem.db 的目录即注册）</div>'
    grid.querySelectorAll('.neu-card').forEach((c) =>
      c.addEventListener('click', () => {
        state.mgrView.neuronSel = c.dataset.id
        saveMgrView()
        renderMgr()
        if (isMobile()) setPanel(false)
      }),
    )
  }

  function neuCardHtml(n) {
    return (
      `<div class="mgr-card neu-card" data-id="${esc(n.id)}" title="进入 ${esc(n.name || n.id)} 节点图">` +
      `<div class="mgr-ic" style="background:${mgrColor(n.id)}">${NEU_ICON}</div>` +
      '<div class="mgr-meta">' +
      `<div class="mgr-name">${esc(n.name || n.id)}<span class="inst-badge">${esc(n.id)}</span></div>` +
      `<div class="mgr-desc">${esc(n.description || '（无触发说明）')}</div>` +
      '<div class="neu-stats">' +
      `<span>记忆 ${n.mem_count}</span><span>认知 ${n.cog_count}</span><span>社群 ${n.community_count}</span>` +
      (n.last_updated ? `<span>更新 ${esc(String(n.last_updated).slice(0, 10))}</span>` : '') +
      '</div></div>' +
      '<span class="mgr-more" title="进入">›</span></div>'
    )
  }

  // ---------- 层级2：节点图视图 ----------
  function renderNeuGraphView() {
    const sel = state.mgrView.neuronSel
    const meta = (NEU || []).find((n) => n.id === sel)
    messagesEl.innerHTML =
      '<div class="mgr-pane neu-pane">' +
      '<div class="neu-head">' +
      '<button class="neu-back" id="neu-back" title="返回神经元选择">‹ 神经元</button>' +
      `<span class="neu-title">${esc((meta && (meta.name || meta.id)) || sel)}</span>` +
      (meta ? `<span class="neu-meta-chip">记忆 ${meta.mem_count}</span><span class="neu-meta-chip">认知 ${meta.cog_count}</span><span class="neu-meta-chip">社群 ${meta.community_count}</span>` : '') +
      '<span class="neu-legend"><i class="lg lg-mem"></i>记忆<i class="lg lg-cog"></i>认知<i class="lg lg-comm"></i>社群</span>' +
      '</div>' +
      '<div class="neu-graph" id="neu-graph"><canvas id="neu-canvas"></canvas><div class="neu-pop" id="neu-pop" hidden></div></div>' +
      '<div class="mgr-foot">滚轮缩放 · 空白处拖拽平移 · 节点可拖拽 · 悬停/点击弹浮窗 · 数据源 /gateway/neurons/graph</div>' +
      '</div>'
    inputWrap.classList.remove('docked')
    chatArea.classList.remove('in-session')
    chatArea.classList.add('mgr-on')
    const back = $('neu-back')
    if (back)
      back.addEventListener('click', () => {
        state.mgrView.neuronSel = null
        saveMgrView()
        renderMgr()
      })
    if (NEU_GRAPH_LOADING) {
      const box = $('neu-graph')
      if (box) box.innerHTML = '<canvas id="neu-canvas"></canvas><div class="neu-hint">加载图数据…</div>'
      return
    }
    if (NEU_GRAPH_ERR) {
      const box = $('neu-graph')
      if (box) {
        box.innerHTML =
          '<canvas id="neu-canvas"></canvas><div class="neu-hint">图数据加载失败：' + esc(NEU_GRAPH_ERR) +
          '<br><button class="mgr-retry" id="neu-graph-retry">重试</button></div>'
        const retry = $('neu-graph-retry')
        if (retry) retry.addEventListener('click', () => loadNeuronGraph(sel, true))
      }
      return
    }
    if (NEU_GRAPH && NEU_GRAPH.neuron.id === sel) startNeuGraph(NEU_GRAPH)
    else loadNeuronGraph(sel, false)
  }

  // ---------- 三级图模型（纯函数，探针覆盖） ----------

  // 半径公式：mem 小点（内容量微调）；cog ∝ 挂载记忆数 + 内容量；社群 ∝ cog 数 + 内容量
  function neuMemR(chars) {
    return 2.5 + Math.min(2.5, chars / 600)
  }
  function neuCogR(nMems, chars) {
    return Math.min(24, 7 + 2.4 * Math.sqrt(nMems) + Math.min(7, chars / 1200))
  }
  function neuCommR(nCogs, chars) {
    return Math.min(34, 11 + 3.2 * Math.sqrt(nCogs * 2) + Math.min(9, chars / 2500))
  }
  function neuHue(i) {
    return MGR_PALETTE[i % MGR_PALETTE.length]
  }

  /** payload → 仿真模型：nodes（x/y 初始化为确定性同心布局，无随机 → 探针可复现）+ links */
  function neuBuildModel(d) {
    const nodes = []
    const links = []
    const idxOf = {}
    const C = d.communities
    for (let i = 0; i < C.length; i++) {
      const c = C[i]
      const ang = (2 * Math.PI * i) / Math.max(1, C.length) - Math.PI / 2
      idxOf['c' + c.i] = nodes.length
      nodes.push({
        key: 'comm' + c.i, type: 'comm', r: neuCommR(c.size, c.chars), ref: c,
        x: Math.cos(ang) * 170, y: Math.sin(ang) * 170, vx: 0, vy: 0,
      })
    }
    for (const g of d.cogs) {
      idxOf['g' + g.id] = nodes.length
      const comm = g.community >= 0 ? C[g.community] : null
      const host = comm ? idxOf['c' + comm.i] : -1
      // 初始位：社群节点近旁外圈（未入群 cog 落外围 300 环）
      const k = nodes.length
      const ang = 0.7 * k
      const rad = host >= 0 ? nodes[host].r + 60 + (k % 7) * 9 : 300
      const cx = host >= 0 ? nodes[host].x : 0
      const cy = host >= 0 ? nodes[host].y : 0
      nodes.push({
        key: 'cog' + g.id, type: 'cog', r: neuCogR(g.mem_ids.length + g.rel_ids.length, g.chars), ref: g,
        x: cx + Math.cos(ang) * rad, y: cy + Math.sin(ang) * rad, vx: 0, vy: 0,
      })
    }
    for (const m of d.mems) {
      idxOf['m' + m.id] = nodes.length
      // 初始位：挂靠首个 cog 近旁；孤儿 mem（不挂任何 cog）落中心环
      const hostCog = d.cogs.find((g) => g.mem_ids.includes(m.id) || g.rel_ids.includes(m.id))
      const host = hostCog ? idxOf['g' + hostCog.id] : -1
      const k = nodes.length
      const ang = 1.3 * k
      const rad = host >= 0 ? nodes[host].r + 10 + (k % 5) * 5 : 120 + (k % 9) * 8
      const cx = host >= 0 ? nodes[host].x : 0
      const cy = host >= 0 ? nodes[host].y : 0
      nodes.push({
        key: 'mem' + m.id, type: 'mem', r: neuMemR(m.chars), ref: m,
        x: cx + Math.cos(ang) * rad, y: cy + Math.sin(ang) * rad, vx: 0, vy: 0,
      })
    }
    // 连边（事实闭合）：cog→社群 + cog→mem/rel 全量连边（同一 mem 挂多 cog 时每 cog 各一条）
    for (const g of d.cogs) {
      const gi = idxOf['g' + g.id]
      if (g.community >= 0 && idxOf['c' + g.community] !== undefined) links.push({ s: idxOf['c' + g.community], t: gi, kind: 'comm' })
      for (const mid of g.mem_ids) { const mi = idxOf['m' + mid]; if (mi !== undefined) links.push({ s: gi, t: mi, kind: 'mem' }) }
      for (const mid of g.rel_ids) { const mi = idxOf['m' + mid]; if (mi !== undefined) links.push({ s: gi, t: mi, kind: 'rel' }) }
    }
    return { nodes, links, neuron: d.neuron, resolution: d.resolution }
  }

  // ---------- 力导向仿真（d3-force 同型：斥力 + 弹簧 + 向心引力 + 碰撞） ----------
  // 2026-09-16 用户实测「节点间斥力太大」：整体 ÷2.5（mem 卫星平衡距 49→32px，mem 云不再被吹散）
  const NEU_CHARGE = { mem: 12, cog: 72, comm: 360 }
  const NEU_PAD = { mem: 6, rel: 6, comm: 16 }
  const NEU_KLINK = { mem: 0.06, rel: 0.04, comm: 0.09 }
  // 向心引力（2026-09-16 二次定案：18:32 回退曾误恢复 15:47 首版分级值——16:12 定案本就是废弃
  // 分级、改统一外场，d3 forceCenter 同型）：向心只负责把整图约束在画布内，与类型/尺寸完全无关；
  // 径向分层语义全部交斥力——charge 大者被推得远（comm 外圈 / cog 中带 / mem 内带）。
  const NEU_G = 0.01

  function neuTick(model, alpha) {
    const ns = model.nodes
    // 斥力（O(n²)，数百节点规模足够；d² 衰减 + 位移上限防爆）
    for (let i = 0; i < ns.length; i++) {
      const a = ns[i]
      for (let j = i + 1; j < ns.length; j++) {
        const b = ns[j]
        let dx = b.x - a.x
        let dy = b.y - a.y
        let d2 = dx * dx + dy * dy
        if (d2 < 1) { dx = (i % 3) - 1 || 0.5; dy = (j % 3) - 1 || 0.5; d2 = 1 }
        const f = (NEU_CHARGE[a.type] * NEU_CHARGE[b.type] * alpha) / d2
        const d = Math.sqrt(d2)
        const fx = (dx / d) * f
        const fy = (dy / d) * f
        a.vx -= fx; a.vy -= fy
        b.vx += fx; b.vy += fy
      }
    }
    // 弹簧（目标距离 = 两端半径和 + 余量）
    for (const lk of model.links) {
      const a = ns[lk.s]
      const b = ns[lk.t]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const d = Math.sqrt(dx * dx + dy * dy) || 1
      const L = a.r + b.r + NEU_PAD[lk.kind]
      // 弹簧无地板：力 ∝ alpha 随仿真衰减自然归零（旧 max(alpha,0.15) 地板令末段速度恒定、停机像急刹）
      const f = (d - L) * NEU_KLINK[lk.kind] * alpha
      const fx = (dx / d) * f
      const fy = (dy / d) * f
      a.vx += fx; a.vy += fy
      b.vx -= fx; b.vy -= fy
    }
    // 向心引力（统一外场指向画布中心，与类型/尺寸无关）
    for (const n of ns) {
      const g = NEU_G
      n.vx += (0 - n.x) * g * alpha
      n.vy += (0 - n.y) * g * alpha
      n.vx *= 0.85
      n.vy *= 0.85
      const sp = Math.sqrt(n.vx * n.vx + n.vy * n.vy)
      // 速度上限随 alpha 线性收缩（alpha≤0.3 后渐缓趋停，2026-09-16 用户「中止过于突然，应该是速度逐渐变缓」）
      const cap = 14 * Math.min(1, alpha / 0.3)
      if (sp > cap) { n.vx = (n.vx / sp) * cap; n.vy = (n.vy / sp) * cap }
      if (!n.fixed) { n.x += n.vx; n.y += n.vy } else { n.vx = 0; n.vy = 0 }
    }
    // 碰撞去重叠（按半径和推出；单趟即可，斥力会接力）
    for (let i = 0; i < ns.length; i++) {
      const a = ns[i]
      for (let j = i + 1; j < ns.length; j++) {
        const b = ns[j]
        const dx = b.x - a.x
        const dy = b.y - a.y
        const min = a.r + b.r + 1.5
        const d2 = dx * dx + dy * dy
        if (d2 >= min * min || d2 === 0) continue
        const d = Math.sqrt(d2)
        const push = ((min - d) / d) * 0.5
        const fx = dx * push
        const fy = dy * push
        if (!a.fixed) { a.x -= fx; a.y -= fy }
        if (!b.fixed) { b.x += fx; b.y += fy }
      }
    }
  }

  // ---------- 渲染与交互（实例态挂在闭包，画布离场即停帧） ----------
  let NEU_VIEW = null // {model, view:{x,y,k}, raf, pinned, canvas, ctx, box, pop, alpha, drag}

  function startNeuGraph(data) {
    const canvas = $('neu-canvas')
    const box = $('neu-graph')
    const pop = $('neu-pop')
    if (!canvas || !box || !pop) return
    const model = neuBuildModel(data)
    NEU_VIEW = { model, view: { x: 0, y: 0, k: 1 }, raf: 0, pinned: null, canvas, ctx: canvas.getContext('2d'), box, pop, alpha: 1, drag: null }
    const st = NEU_VIEW
    const resize = () => {
      const w = box.clientWidth
      const h = box.clientHeight
      if (!w || !h) return
      const dpr = window.devicePixelRatio || 1
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      canvas.style.width = w + 'px'
      canvas.style.height = h + 'px'
      st.ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      st.w = w
      st.h = h
      st.alpha = Math.max(st.alpha, 0.3) // 尺寸变化轻 reheating 重排
    }
    resize()
    st.ro = new ResizeObserver(resize)
    st.ro.observe(box)

    const frame = () => {
      if (!canvas.isConnected) {
        if (st.ro) st.ro.disconnect()
        if (st.raf) cancelAnimationFrame(st.raf)
        if (NEU_VIEW === st) NEU_VIEW = null
        return
      }
      if (st.alpha > 0.003) {
        neuTick(st.model, st.alpha)
        st.alpha *= 0.985
      }
      drawNeu(st)
      if (st.pinned) positionPop(st)
      st.raf = requestAnimationFrame(frame)
    }
    st.raf = requestAnimationFrame(frame)
    bindNeuPointer(st)
    st.frame = frame
  }

  /** 屏幕坐标 → 图坐标 */
  function neuToGraph(st, sx, sy) {
    return { x: (sx - st.w / 2 - st.view.x) / st.view.k, y: (sy - st.h / 2 - st.view.y) / st.view.k }
  }
  function neuHit(st, sx, sy) {
    const p = neuToGraph(st, sx - st.box.getBoundingClientRect().left, sy - st.box.getBoundingClientRect().top)
    let best = null
    for (const n of st.model.nodes) {
      const d = Math.sqrt((n.x - p.x) ** 2 + (n.y - p.y) ** 2)
      const hit = n.type === 'mem' ? n.r + 4 : n.r + 2
      if (d <= hit && (!best || n.r > best.r)) best = n
    }
    return best
  }

  function drawNeu(st) {
    const { ctx, model, view } = st
    const w = st.w || 0
    const h = st.h || 0
    ctx.clearRect(0, 0, w, h)
    ctx.save()
    ctx.translate(w / 2 + view.x, h / 2 + view.y)
    ctx.scale(view.k, view.k)
    // 边：mem 实线淡 / rel 更淡 / comm 稍深
    for (const lk of model.links) {
      const a = model.nodes[lk.s]
      const b = model.nodes[lk.t]
      const hue = a.type === 'comm' ? neuHue(a.ref.i) : cogHue(a)
      ctx.strokeStyle =
        lk.kind === 'comm' ? hexA(hue, 0.4) : lk.kind === 'rel' ? hexA(hue, 0.1) : hexA(hue, 0.22)
      ctx.lineWidth = lk.kind === 'comm' ? 1.6 : lk.kind === 'rel' ? 0.6 : 1
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
    }
    // 节点：mem 小点 → cog 彩点 → 社群大节点（描边 + 标签）
    for (const n of model.nodes) {
      ctx.beginPath()
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
      if (n.type === 'mem') {
        ctx.fillStyle = '#9aa7b8'
      } else if (n.type === 'cog') {
        ctx.fillStyle = cogHue(n)
        ctx.strokeStyle = 'rgba(255,255,255,0.9)'
        ctx.lineWidth = 1.2
        ctx.stroke()
      } else {
        ctx.fillStyle = cogHue(n)
        ctx.strokeStyle = 'rgba(255,255,255,0.95)'
        ctx.lineWidth = 2
        ctx.stroke()
      }
      ctx.fill()
      if (n.type === 'comm') {
        ctx.fillStyle = 'rgba(40,50,70,0.85)'
        ctx.font = '10px system-ui, sans-serif'
        ctx.textAlign = 'center'
        ctx.fillText((n.ref.name || '群' + (n.ref.i + 1)) + '·' + n.ref.size, n.x, n.y + n.r + 12)
      }
    }
    ctx.restore()
  }
  function cogHue(n) {
    return n.type === 'comm' ? neuHue(n.ref.i) : n.ref.community >= 0 ? neuHue(n.ref.community) : '#8a94a6'
  }
  function hexA(hex, a) {
    const h = hex.replace('#', '')
    const r = parseInt(h.slice(0, 2), 16)
    const g = parseInt(h.slice(2, 4), 16)
    const b = parseInt(h.slice(4, 6), 16)
    return `rgba(${r},${g},${b},${a})`
  }

  // ---------- 指针交互（悬停浮窗 / 点击钉住 / 拖节点 / 平移 / 缩放） ----------
  function bindNeuPointer(st) {
    const cv = st.canvas
    let moved = 0
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId)
      moved = 0
      const hit = neuHit(st, e.clientX, e.clientY)
      st.drag = { hit, sx: e.clientX, sy: e.clientY, vx: st.view.x, vy: st.view.y }
      if (hit) hit.fixed = true
    })
    cv.addEventListener('pointermove', (e) => {
      if (st.drag) {
        const dx = e.clientX - st.drag.sx
        const dy = e.clientY - st.drag.sy
        moved = Math.max(moved, Math.abs(dx) + Math.abs(dy))
        if (st.drag.hit) {
          const p = neuToGraph(st, e.clientX - st.box.getBoundingClientRect().left, e.clientY - st.box.getBoundingClientRect().top)
          st.drag.hit.x = p.x
          st.drag.hit.y = p.y
          st.alpha = Math.max(st.alpha, 0.35)
        } else {
          st.view.x = st.drag.vx + dx
          st.view.y = st.drag.vy + dy
        }
        return
      }
      const hit = neuHit(st, e.clientX, e.clientY)
      if (hit) showNeuPop(st, hit, e.clientX, e.clientY)
      else if (!st.pinned) hideNeuPop(st)
    })
    const up = (e) => {
      if (st.drag) {
        if (st.drag.hit) {
          st.drag.hit.fixed = false
          if (moved < 5) {
            st.pinned = st.pinned === st.drag.hit ? null : st.drag.hit
            if (st.pinned) showNeuPop(st, st.pinned, e.clientX, e.clientY)
            else hideNeuPop(st)
          }
        } else if (moved < 5) {
          st.pinned = null
          hideNeuPop(st)
        }
      }
      st.drag = null
    }
    cv.addEventListener('pointerup', up)
    cv.addEventListener('pointercancel', () => { st.drag = null })
    cv.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault()
        const k = Math.min(3, Math.max(0.25, st.view.k * Math.exp(-e.deltaY * 0.0012)))
        st.view.k = k
      },
      { passive: false },
    )
    cv.addEventListener('pointerleave', () => { if (!st.pinned) hideNeuPop(st) })
  }

  // ---------- 浮窗（美化卡片：标题行 + 统计 chips + 成员/内容区） ----------
  function showNeuPop(st, node, clientX, clientY) {
    st.hover = node
    const pop = st.pop
    pop.innerHTML = neuPopHtml(node)
    pop.hidden = false
    st.popAt = { x: clientX, y: clientY }
    positionPop(st)
  }
  function positionPop(st) {
    const node = st.pinned || st.hover
    const pop = st.pop
    if (!node || pop.hidden) return
    // 钉住态跟随节点图→屏坐标；悬停态用最近指针位
    let sx
    let sy
    if (st.pinned === node) {
      const rect = st.box.getBoundingClientRect()
      sx = rect.left + st.w / 2 + st.view.x + node.x * st.view.k
      sy = rect.top + st.h / 2 + st.view.y + node.y * st.view.k
    } else if (st.popAt) {
      sx = st.popAt.x
      sy = st.popAt.y
    } else return
    const pw = pop.offsetWidth || 300
    const ph = pop.offsetHeight || 160
    const rect = st.box.getBoundingClientRect()
    let left = sx - rect.left + 14
    let top = sy - rect.top + 14
    left = Math.max(6, Math.min(left, rect.width - pw - 6))
    top = Math.max(6, Math.min(top, rect.height - ph - 6))
    pop.style.left = left + 'px'
    pop.style.top = top + 'px'
  }
  function hideNeuPop(st) {
    st.hover = null
    st.pop.hidden = true
  }

  function neuPopHtml(node) {
    if (node.type === 'comm') return neuCommHtml(node.ref)
    if (node.type === 'cog') return neuCogHtml(node.ref)
    return neuMemHtml(node.ref)
  }

  function chipsHtml(arr) {
    return '<div class="neu-chips">' + arr.map((x) => `<span class="neu-chip">${x}</span>`).join('') + '</div>'
  }

  function neuCommHtml(c) {
    const hue = neuHue(c.i)
    const rows = c.members
      .map(
        (m) =>
          `<div class="neu-mrow"><span class="neu-role ${esc(m.role)}" style="--hue:${hue}"></span>` +
          `<span class="neu-mq" title="${esc(m.query)}">${esc(m.query)}</span>` +
          `<span class="neu-score">${m.core_score.toFixed(2)}</span></div>`,
      )
      .join('')
    return (
      `<div class="neu-pop-h"><span class="neu-dot" style="background:${hue}"></span>` +
      (c.name ? `${esc(c.name)} · 认知 ${c.size}` : `群 ${c.i + 1} · 认知 ${c.size}`) +
      '</div>' +
      (c.description ? `<div class="neu-q">${esc(c.description)}</div>` : '') +
      chipsHtml([`记忆 ${c.mem_count}`, `密度 ${c.density.toFixed(2)}`, `内容 ${fmtChars(c.chars)}`]) +
      `<div class="neu-members">${rows || '<div class="neu-nomember">（无成员）</div>'}</div>`
    )
  }

  function neuCogHtml(g) {
    const hue = g.community >= 0 ? neuHue(g.community) : '#8a94a6'
    const kws = g.keywords
      .slice(0, 6)
      .map((k) => `<span class="neu-kw">${esc(k)}</span>`)
      .join('')
    return (
      `<div class="neu-pop-h"><span class="neu-dot" style="background:${hue}"></span>认知节点${g.community >= 0 ? ` · 群 ${g.community + 1}` : ' · 游离'}</div>` +
      `<div class="neu-q">${esc(g.query)}</div>` +
      (kws ? `<div class="neu-kws">${kws}</div>` : '') +
      chipsHtml([
        `记忆 ${g.mem_ids.length}`,
        g.rel_ids.length ? `关联 ${g.rel_ids.length}` : '',
        `内容 ${fmtChars(g.chars)}`,
      ].filter(Boolean))
    )
  }

  function neuMemHtml(m) {
    return (
      '<div class="neu-pop-h"><span class="neu-dot" style="background:#9aa7b8"></span>记忆' +
      (m.time ? ` · ${esc(m.time)}` : '') +
      '</div>' +
      `<div class="neu-prev">${esc(m.preview || '（无文本）')}</div>` +
      chipsHtml([`内容 ${fmtChars(m.chars)}`, m.source ? '来源 ' + esc(m.source) : ''].filter(Boolean))
    )
  }

  function fmtChars(n) {
    return n >= 1000 ? (n / 1000).toFixed(1) + 'k 字' : n + ' 字'
  }

export { loadNeuronsData, renderMgrNeurons, neuBuildModel, neuMemR, neuCogR, neuCommR, neuTick }
