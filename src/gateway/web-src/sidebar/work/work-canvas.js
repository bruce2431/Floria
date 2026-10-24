// .canvas 文件（JSON Canvas 1.0，Obsidian 同格式）的图形预览+编辑：wkEdLangExt 对 .canvas 扩展名注入
// wkCvExt —— 默认把整篇文档替换为画布（群组/边/节点 + 点阵网格 + 平移/缩放），画布顶栏「编辑源码」
// 切回 JSON（带高亮、可正常自动保存）；源码态文档首行挂「图形预览」钮切回画布。
//
// 2026-10-24 用户定案：**交互逻辑一律搬 ComfyUI，不自己发明**。本文件的手势/相机/选择/拖拽/缩放
// 全部逐行移植自 ComfyUI_frontend + litegraph（源文件与出处见各段头注释），只把数据层换成 JSON Canvas：
//   · CanvasPointer（按下立即 setPointerCapture；6px 位移判定拖动；300ms/18px 双击；触控板/鼠标滚轮识别）
//   · reduceGesture（idle → pressed → dragging 纯函数归约，点击/双击/拖动/取消由 effects 驱动）
//   · DragAndScale（scale 0.1..10、指针锚定缩放、1.0 吸附、75% 适配、350ms ease-in-out-quad 动画）
//   · selectionIntent（replace/add/remove/clear/none；框选 replace/add/subtract）
//   · LGraphCanvas processMouseDown/Move/Up/Wheel/Key（左键=平移画布、Ctrl/⌘+拖=框选、节点角=缩放、
//     Shift 落点吸附、Delete 删除并愈合连线、Ctrl+A/C/V、空格拖动平移）
// 渲染：bg（网格+边）与 fg（节点）双 canvas + 持续 rAF + 脏标记 + 可视区裁剪 + 缩放 < 0.6 低质量。
// 结构：canvas 与 DOM 覆盖层是**兄弟节点**（overlay 不在 canvas 手势路径上，「编辑源码」不会被吞）。
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

  // ---------- 手势原语（搬自 ComfyUI frontend src/lib/litegraph/src/canvas/reduceGesture.ts、
  // captureGesture.ts、measure.ts；逐行移植，仅把 TS 类型擦掉） ----------
  function wkCvDist2(x1, y1, x2, y2) {
    return (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1)
  }
  function wkCvIsInRectangle(x, y, left, top, width, height) {
    return x >= left && y >= top && x < left + width && y < top + height
  }
  function wkCvSnapPoint(pos, snapTo, method) {
    if (!snapTo) return false
    method = method || 'round'
    pos[0] = snapTo * Math[method](pos[0] / snapTo)
    pos[1] = snapTo * Math[method](pos[1] / snapTo)
    return true
  }
  function wkCvOverlapBounding(a, b) {
    const aRight = a[0] + a[2], aBottom = a[1] + a[3]
    const bRight = b[0] + b[2], bBottom = b[1] + b[3]
    return a[0] > bRight || a[1] > bBottom || aRight < b[0] || aBottom < b[1] ? false : true
  }
  function wkCvContainsRect(a, b) {
    const aRight = a[0] + a[2], aBottom = a[1] + a[3]
    const bRight = b[0] + b[2], bBottom = b[1] + b[3]
    const identical = a[0] === b[0] && a[1] === b[1] && aRight === bRight && aBottom === bBottom
    return !identical && a[0] <= b[0] && a[1] <= b[1] && aRight >= bRight && aBottom >= bBottom
  }
  function wkCvWithin(a, b, distance) {
    return wkCvDist2(a.x, a.y, b.x, b.y) <= distance * distance
  }
  const WKCV_IDLE_GESTURE = Object.freeze({ phase: 'idle', lastClick: undefined })
  function wkCvGestureUnchanged(state) {
    return { state, effects: [] }
  }
  function wkCvIsDoubleClick(state) {
    const { lastClick, origin, timeStamp, policy } = state
    if (!lastClick) return false
    const gap = timeStamp - lastClick.timeStamp
    return (
      gap > 0 &&
      gap < policy.doubleClickTime &&
      wkCvWithin(origin, lastClick.position, 3 * policy.maxClickDrift)
    )
  }
  function wkCvReduceIdle(state, event) {
    switch (event.type) {
      case 'down':
        return {
          state: {
            phase: 'pressed',
            origin: event.position,
            timeStamp: event.timeStamp,
            policy: event.policy,
            lastClick: state.lastClick
          },
          effects: []
        }
      case 'move':
      case 'up':
      case 'cancel':
        return wkCvGestureUnchanged(state)
      default:
        return wkCvGestureUnchanged(state)
    }
  }
  function wkCvReducePressed(state, event) {
    const { origin, policy, lastClick } = state
    switch (event.type) {
      case 'move':
        if (wkCvWithin(event.position, origin, policy.maxClickDrift))
          return { state, effects: ['movePress'] }
        return {
          state: { phase: 'dragging', lastClick },
          effects: ['startDrag', 'moveDrag']
        }
      case 'up':
        if (!wkCvWithin(event.position, origin, policy.maxClickDrift))
          return {
            state: { phase: 'idle', lastClick },
            effects: ['startDrag', 'endDrag']
          }
        if (event.acceptsDoubleClick && wkCvIsDoubleClick(state))
          return { state: WKCV_IDLE_GESTURE, effects: ['doubleClick'] }
        return {
          state: {
            phase: 'idle',
            lastClick: { position: origin, timeStamp: state.timeStamp }
          },
          effects: ['click']
        }
      case 'cancel':
        return { state: { phase: 'idle', lastClick }, effects: [] }
      case 'down':
        return wkCvGestureUnchanged(state)
      default:
        return wkCvGestureUnchanged(state)
    }
  }
  function wkCvReduceDragging(state, event) {
    const { lastClick } = state
    switch (event.type) {
      case 'move':
        return { state, effects: ['moveDrag'] }
      case 'up':
        return { state: { phase: 'idle', lastClick }, effects: ['endDrag'] }
      case 'cancel':
        return { state: { phase: 'idle', lastClick }, effects: ['cancelDrag'] }
      case 'down':
        return wkCvGestureUnchanged(state)
      default:
        return wkCvGestureUnchanged(state)
    }
  }
  function wkCvReduceGesture(state, event) {
    switch (state.phase) {
      case 'idle':
        return wkCvReduceIdle(state, event)
      case 'pressed':
        return wkCvReducePressed(state, event)
      case 'dragging':
        return wkCvReduceDragging(state, event)
      default:
        return wkCvGestureUnchanged(state)
    }
  }
  // 对应的 ComfyUI captureGesture.ts：按下即捕获；lostpointercapture（同 pointerId）视为中断。
  function wkCvCaptureGesture(element, pointerId, onInterrupt) {
    function onLostPointerCapture(event) {
      if ('pointerId' in event && event.pointerId === pointerId) onInterrupt()
    }
    element.setPointerCapture(pointerId)
    element.addEventListener('lostpointercapture', onLostPointerCapture)
    return () => {
      element.removeEventListener('lostpointercapture', onLostPointerCapture)
      if (element.hasPointerCapture(pointerId))
        element.releasePointerCapture(pointerId)
    }
  }

  // ---------- 选择意图（搬自 ComfyUI frontend src/core/selection/selectionIntent.ts） ----------
  function wkCvHasToggleModifier(modifiers) {
    return Boolean(modifiers && (modifiers.shiftKey || modifiers.ctrlKey || modifiers.metaKey))
  }
  function wkCvResolveClickSelection(ctx) {
    const { hasItem, isSelected, modifiers, multiSelect, selectOnly, sticky } = ctx
    const toggling = wkCvHasToggleModifier(modifiers)
    if (!hasItem) {
      if (selectOnly) return 'none'
      return !toggling || multiSelect ? 'clear' : 'none'
    }
    const modifying = toggling || multiSelect || selectOnly
    if (!isSelected) return modifying ? 'add' : 'replace'
    if (sticky) return 'none'
    return modifying ? 'remove' : 'replace'
  }
  function wkCvResolveMarqueeSelection(modifiers) {
    if (modifiers.shiftKey) return 'add'
    if (modifiers.altKey) return 'subtract'
    return 'replace'
  }
  function wkCvApplyMarqueeSelection(intent, current, enclosed) {
    switch (intent) {
      case 'add':
        return new Set([...current, ...enclosed])
      case 'subtract':
        return new Set([...current].filter((item) => !enclosed.has(item)))
      case 'replace':
        return new Set(enclosed)
      default:
        return new Set(current)
    }
  }

  // ---------- CanvasPointer（搬自 ComfyUI frontend .../CanvasPointer.ts） ----------
  // 构造时不清状态；down/move/up 调 reduceGesture，回调按 effects 派发。触控板/鼠标识别逐行保留。
  class WkCvCanvasPointer {
    constructor(element) {
      this.element = element
      this.pointerId = undefined
      this.state = WKCV_IDLE_GESTURE
      this.releaseCapture = undefined
      this.isDouble = false
      this.isDown = false
      this.resizeDirection = undefined
      this.clearEventsOnReset = true
      this.eDown = undefined
      this.eMove = undefined
      this.eUp = undefined
      this.detectedDevice = 'mouse'
      this.lastWheelEventTime = 0
      this.hasReceivedWheelEvent = false
      this.bufferedLinuxEvent = undefined
      this.bufferedLinuxEventTime = 0
      this.linuxBufferTimeoutId = undefined
      this._finally = undefined

      this.onDragStart = undefined
      this.onDrag = undefined
      this.onDragEnd = undefined
      this.onDragCancel = undefined
      this.onClick = undefined
      this.onDoubleClick = undefined
    }
    get dragStarted() {
      return this.state.phase === 'dragging'
    }
    static gesturePolicy() {
      return {
        maxClickDrift: WkCvCanvasPointer.maxClickDrift,
        doubleClickTime: WkCvCanvasPointer.doubleClickTime
      }
    }
    get finally() {
      return this._finally
    }
    set finally(value) {
      try {
        if (this._finally) this._finally()
      } finally {
        this._finally = value
      }
    }
    down(e) {
      this.reset()
      this.eDown = e
      this.pointerId = e.pointerId
      this.releaseCapture = wkCvCaptureGesture(this.element, e.pointerId, () =>
        this.reset()
      )
      this.dispatch(
        {
          type: 'down',
          position: { x: e.clientX, y: e.clientY },
          timeStamp: e.timeStamp,
          policy: WkCvCanvasPointer.gesturePolicy()
        },
        e
      )
    }
    move(e) {
      const { eDown } = this
      if (!eDown) return
      if (!(e.buttons & eDown.buttons)) {
        if (this.state.phase !== 'idle') {
          this.eUp = e
          this.dispatch(this.upEvent(e), e)
        }
        this.reset()
        return
      }
      this.eMove = e
      this.dispatch({ type: 'move', position: { x: e.clientX, y: e.clientY } }, e)
    }
    up(e) {
      if (e.button !== (this.eDown && this.eDown.button)) return false
      this.eUp = e
      const effects = this.dispatch(this.upEvent(e), e)
      this.reset()
      return effects.indexOf('endDrag') === -1
    }
    upEvent(e) {
      return {
        type: 'up',
        position: { x: e.clientX, y: e.clientY },
        acceptsDoubleClick: !!this.onDoubleClick
      }
    }
    dispatch(event, e) {
      const { state, effects } = wkCvReduceGesture(this.state, event)
      this.state = state
      const eMove = event.type === 'move' ? e : undefined
      const handlers = {
        click: () => { if (this.onClick) this.onClick(e) },
        doubleClick: () => { if (this.onDoubleClick) this.onDoubleClick(e) },
        startDrag: () => {
          if (this.onDragStart) this.onDragStart(this, eMove)
          delete this.onDragStart
        },
        movePress: () => { if (this.onDrag) this.onDrag(e) },
        moveDrag: () => { if (this.onDrag) this.onDrag(e) },
        endDrag: () => { if (this.onDragEnd) this.onDragEnd(e) },
        cancelDrag: () => { if (this.onDragCancel) this.onDragCancel() }
      }
      for (const effect of effects) handlers[effect]()
      return effects
    }
    isTrackpadGesture(e) {
      const now = performance.now()
      const timeSinceLastEvent = Math.max(0, now - this.lastWheelEventTime)
      this.lastWheelEventTime = now
      if (this._isHighResWheelEvent(e, now)) {
        this.detectedDevice = 'mouse'
      } else if (this._isWithinCooldown(timeSinceLastEvent)) {
        if (this._shouldBufferLinuxEvent(e)) this._bufferLinuxEvent(e, now)
      } else {
        this._updateDeviceMode(e, now)
        this.hasReceivedWheelEvent = true
      }
      return this.detectedDevice === 'trackpad'
    }
    _isHighResWheelEvent(event, now) {
      if (!this.bufferedLinuxEvent || this.bufferedLinuxEventTime <= 0) return false
      const timeSinceBuffer = now - this.bufferedLinuxEventTime
      if (timeSinceBuffer > WkCvCanvasPointer.maxHighResBufferTime) {
        this._clearLinuxBuffer()
        return false
      }
      if (event.deltaX === 0 && this._isLinuxWheelPattern(this.bufferedLinuxEvent.deltaY, event.deltaY)) {
        this._clearLinuxBuffer()
        return true
      }
      return false
    }
    _isWithinCooldown(timeSinceLastEvent) {
      const isFirstEvent = !this.hasReceivedWheelEvent
      const cooldownExpired = timeSinceLastEvent >= WkCvCanvasPointer.trackpadMaxGap
      return !isFirstEvent && !cooldownExpired
    }
    _updateDeviceMode(event, now) {
      if (this._isTrackpadPattern(event)) {
        this.detectedDevice = 'trackpad'
      } else if (this._isMousePattern(event)) {
        this.detectedDevice = 'mouse'
      } else if (this.detectedDevice === 'trackpad' && this._shouldBufferLinuxEvent(event)) {
        this._bufferLinuxEvent(event, now)
      }
    }
    _clearLinuxBuffer() {
      this.bufferedLinuxEvent = undefined
      this.bufferedLinuxEventTime = 0
      if (this.linuxBufferTimeoutId !== undefined) {
        clearTimeout(this.linuxBufferTimeoutId)
        this.linuxBufferTimeoutId = undefined
      }
    }
    _isTrackpadPattern(event) {
      if (event.deltaX !== 0 && event.deltaY !== 0) return true
      if (event.ctrlKey && Math.abs(event.deltaY) < 10) return true
      return false
    }
    _isMousePattern(event) {
      const absoluteDeltaY = Math.abs(event.deltaY)
      if (absoluteDeltaY > 80) return true
      return absoluteDeltaY >= 60 && event.deltaX === 0 && this.detectedDevice === 'mouse'
    }
    _shouldBufferLinuxEvent(event) {
      const absoluteDeltaY = Math.abs(event.deltaY)
      const isInLinuxRange = absoluteDeltaY >= 10 && absoluteDeltaY < 60
      const isVerticalOnly = event.deltaX === 0
      const hasIntegerDelta = Number.isInteger(event.deltaY)
      return this.detectedDevice === 'trackpad' && isInLinuxRange && isVerticalOnly && hasIntegerDelta
    }
    _bufferLinuxEvent(event, now) {
      if (this.linuxBufferTimeoutId !== undefined) clearTimeout(this.linuxBufferTimeoutId)
      this.bufferedLinuxEvent = event
      this.bufferedLinuxEventTime = now
      this.linuxBufferTimeoutId = setTimeout(() => {
        this._clearLinuxBuffer()
      }, WkCvCanvasPointer.maxHighResBufferTime)
    }
    _isLinuxWheelPattern(deltaY1, deltaY2) {
      const absolute1 = Math.abs(deltaY1)
      const absolute2 = Math.abs(deltaY2)
      if (absolute1 === 0 || absolute2 === 0) return false
      if (absolute1 === absolute2) return true
      return absolute1 % absolute2 === 0 || absolute2 % absolute1 === 0
    }
    reset() {
      const { releaseCapture } = this
      this.releaseCapture = undefined
      this.pointerId = undefined
      if (releaseCapture) releaseCapture()
      try {
        if (this.eDown) this.dispatch({ type: 'cancel' }, this.eDown)
      } finally {
        try {
          this.finally = undefined
        } finally {
          delete this.onClick
          delete this.onDoubleClick
          delete this.onDragStart
          delete this.onDrag
          delete this.onDragEnd
          delete this.onDragCancel
          this.isDown = false
          this.isDouble = false
          this.resizeDirection = undefined
          if (this.clearEventsOnReset) {
            this.eDown = undefined
            this.eMove = undefined
            this.eUp = undefined
          }
        }
      }
    }
  }
  WkCvCanvasPointer.doubleClickTime = 300
  WkCvCanvasPointer.maxClickDrift = 6
  WkCvCanvasPointer.trackpadThreshold = 60
  WkCvCanvasPointer.trackpadMaxGap = 500
  WkCvCanvasPointer.maxHighResBufferTime = 10

  // ---------- DragAndScale（搬自 ComfyUI frontend src/lib/litegraph/src/DragAndScale.ts） ----------
  class WkCvDragAndScale {
    constructor(element) {
      this.state = { offset: [0, 0], scale: 1 }
      this.lastState = { offset: [0, 0], scale: 0 }
      this.max_scale = 10
      this.min_scale = 0.1
      this.enabled = true
      this.last_mouse = [0, 0]
      this.visible_area = [0, 0, 0, 0]
      this.element = element
      this.viewportSize = undefined
      this._animationId = 0
      this.onredraw = undefined
      this.onChanged = undefined
    }
    get offset() { return this.state.offset }
    set offset(value) { this.state.offset[0] = value[0]; this.state.offset[1] = value[1] }
    get scale() { return this.state.scale }
    set scale(value) { this.state.scale = value }
    _stateHasChanged() {
      const current = this.state, previous = this.lastState
      return (
        current.scale !== previous.scale ||
        current.offset[0] !== previous.offset[0] ||
        current.offset[1] !== previous.offset[1]
      )
    }
    computeVisibleArea(viewport) {
      const { scale, offset, visible_area } = this
      if (this._stateHasChanged()) {
        if (this.onChanged) this.onChanged(scale, offset)
        this.lastState.scale = this.state.scale
        this.lastState.offset[0] = offset[0]
        this.lastState.offset[1] = offset[1]
      }
      let size = this.getViewportSize()
      let width = size[0], height = size[1]
      let startx = -offset[0]
      let starty = -offset[1]
      if (viewport) {
        startx += viewport[0] / scale
        starty += viewport[1] / scale
        width = viewport[2]
        height = viewport[3]
      }
      const endx = startx + width / scale
      const endy = starty + height / scale
      visible_area[0] = startx
      visible_area[1] = starty
      visible_area[2] = Math.max(0, endx - startx)
      visible_area[3] = Math.max(0, endy - starty)
      return visible_area
    }
    setViewportSize(width, height) {
      this.viewportSize =
        width > 0 && height > 0 && Number.isFinite(width) && Number.isFinite(height)
          ? [width, height]
          : undefined
    }
    invalidateViewportSize() {
      this.viewportSize = undefined
    }
    getViewportSize() {
      const cached = this.viewportSize
      if (cached) return [cached[0], cached[1]]
      const rect = this.element.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) return [rect.width, rect.height]
      const dpr = window.devicePixelRatio || 1
      return [this.element.width / dpr, this.element.height / dpr]
    }
    toCanvasContext(ctx) {
      ctx.scale(this.scale, this.scale)
      ctx.translate(this.offset[0], this.offset[1])
    }
    convertOffsetToCanvas(pos) {
      return [
        (pos[0] + this.offset[0]) * this.scale,
        (pos[1] + this.offset[1]) * this.scale
      ]
    }
    convertCanvasToOffset(pos, out) {
      out = out || [0, 0]
      out[0] = pos[0] / this.scale - this.offset[0]
      out[1] = pos[1] / this.scale - this.offset[1]
      return out
    }
    mouseDrag(x, y) {
      this.offset[0] += x / this.scale
      this.offset[1] += y / this.scale
      if (this.onredraw) this.onredraw(this)
    }
    changeScale(value, zooming_center, roundToScaleOne) {
      if (roundToScaleOne === undefined) roundToScaleOne = true
      if (value < this.min_scale) {
        value = this.min_scale
      } else if (value > this.max_scale) {
        value = this.max_scale
      }
      if (value == this.scale) return
      const rect = this.element.getBoundingClientRect()
      zooming_center = zooming_center || [rect.width * 0.5, rect.height * 0.5]
      const normalizedCenter = [zooming_center[0] - rect.x, zooming_center[1] - rect.y]
      const center = this.convertCanvasToOffset(normalizedCenter)
      this.scale = value
      if (roundToScaleOne && Math.abs(this.scale - 1) < 0.01) this.scale = 1
      const new_center = this.convertCanvasToOffset(normalizedCenter)
      const delta_offset = [new_center[0] - center[0], new_center[1] - center[1]]
      this.offset[0] += delta_offset[0]
      this.offset[1] += delta_offset[1]
      if (this.onredraw) this.onredraw(this)
    }
    changeDeltaScale(value, zooming_center) {
      this.changeScale(this.scale * value, zooming_center)
    }
    fitToBounds(bounds, opts) {
      opts = opts || {}
      const zoom = opts.zoom === undefined ? 0.75 : opts.zoom
      const viewport = opts.viewport
      const size =
        this.element.width === 300 && this.element.height === 150
          ? [1920, 1080]
          : this.getViewportSize()
      const width = size[0], height = size[1]
      const rect = viewport || [0, 0, width, height]
      const vx = rect[0], vy = rect[1], vw = rect[2], vh = rect[3]
      if (!(vw > 0) || !(vh > 0)) return
      let targetScale = this.scale
      if (zoom > 0) {
        const targetScaleX = (zoom * vw) / Math.max(bounds[2], 300)
        const targetScaleY = (zoom * vh) / Math.max(bounds[3], 300)
        targetScale = Math.min(targetScaleX, targetScaleY, this.max_scale)
      }
      const targetX = (vx + vw * 0.5) / targetScale - bounds[0] - bounds[2] * 0.5
      const targetY = (vy + vh * 0.5) / targetScale - bounds[1] - bounds[3] * 0.5
      this.offset[0] = targetX
      this.offset[1] = targetY
      this.scale = targetScale
    }
    animateToBounds(bounds, setDirty, opts) {
      opts = opts || {}
      const duration = opts.duration === undefined ? 350 : opts.duration
      const zoom = opts.zoom === undefined ? 0.75 : opts.zoom
      const easing = opts.easing || 'easeInOutQuad'
      const viewport = opts.viewport
      if (!(duration > 0)) throw new RangeError('Duration must be greater than 0')
      const easeFunctions = {
        linear: (t) => t,
        easeInQuad: (t) => t * t,
        easeOutQuad: (t) => t * (2 - t),
        easeInOutQuad: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t)
      }
      const easeFunction = easeFunctions[easing]
      const startTimestamp = performance.now()
      const size = this.getViewportSize()
      const cw = size[0], ch = size[1]
      const rect = viewport || [0, 0, cw, ch]
      const vx = rect[0], vy = rect[1], vw = rect[2], vh = rect[3]
      if (!(vw > 0) || !(vh > 0)) return
      const startX = this.offset[0]
      const startY = this.offset[1]
      const startX2 = startX - cw / this.scale
      const startY2 = startY - ch / this.scale
      const startScale = this.scale
      let targetScale = startScale
      if (zoom > 0) {
        const targetScaleX = (zoom * vw) / Math.max(bounds[2], 300)
        const targetScaleY = (zoom * vh) / Math.max(bounds[3], 300)
        targetScale = Math.min(targetScaleX, targetScaleY, this.max_scale)
      }
      const scaledWidth = cw / targetScale
      const scaledHeight = ch / targetScale
      const targetX = (vx + vw * 0.5) / targetScale - bounds[0] - bounds[2] * 0.5
      const targetY = (vy + vh * 0.5) / targetScale - bounds[1] - bounds[3] * 0.5
      const targetX2 = targetX - scaledWidth
      const targetY2 = targetY - scaledHeight
      const animate = (timestamp) => {
        const elapsed = timestamp - startTimestamp
        const progress = Math.min(elapsed / duration, 1)
        const easedProgress = easeFunction(progress)
        this.offset[0] = startX + (targetX - startX) * easedProgress
        this.offset[1] = startY + (targetY - startY) * easedProgress
        if (zoom > 0) {
          const currentX2 = startX2 + (targetX2 - startX2) * easedProgress
          const currentY2 = startY2 + (targetY2 - startY2) * easedProgress
          const currentWidth = Math.abs(currentX2 - this.offset[0])
          const currentHeight = Math.abs(currentY2 - this.offset[1])
          this.scale = Math.min(cw / currentWidth, ch / currentHeight)
        }
        setDirty()
        if (progress < 1) {
          this._animationId = requestAnimationFrame(animate)
        } else {
          cancelAnimationFrame(this._animationId)
          this._animationId = 0
        }
      }
      this._animationId = requestAnimationFrame(animate)
    }
    cancelAnimation() {
      if (this._animationId) cancelAnimationFrame(this._animationId)
      this._animationId = 0
    }
    reset() {
      this.scale = 1
      this.offset[0] = 0
      this.offset[1] = 0
    }
  }

  // ---------- 相机 ----------
  // 模块级单份：docChanged 重建 widget 时保留视口与选择。DragAndScale 需要元素做指针锚定，
  // 真实元素每次重建都会换，故用转发壳（永远指向当前舞台 canvas 的 rect / 像素尺寸）。
  const WKCV_GRID = 24
  const WKCV_SNAP = 24
  const WKCV_MIN_SIZE = [40, 30]
  const WKCV_RESIZE_HANDLE = 15
  const WKCV_CLIP_KEY = 'floria.canvas.clipboard'
  let wkCvCamHost = null
  const wkCvCamEl = {
    get width() { return wkCvCamHost ? wkCvCamHost.width : 0 },
    get height() { return wkCvCamHost ? wkCvCamHost.height : 0 },
    getBoundingClientRect() {
      if (wkCvCamHost) return wkCvCamHost.getBoundingClientRect()
      return { x: 0, y: 0, width: 600, height: 400 }
    }
  }
  const wkCvDs = new WkCvDragAndScale(wkCvCamEl)
  let wkCvCamFile = ''
  let wkCvSelFile = ''
  let wkCvSelIds = new Set()

  function wkCvToScreen(x, y) { return wkCvDs.convertOffsetToCanvas([x, y]) }
  function wkCvToWorld(sx, sy) { return wkCvDs.convertCanvasToOffset([sx, sy]) }

  // 节点某侧的锚点（世界坐标）；side 缺省返回 null，由调用方按相对方位就近取。
  function wkCvAnchor(n, side) {
    if (side === 'left') return [n.x, n.y + n.h / 2]
    if (side === 'right') return [n.x + n.w, n.y + n.h / 2]
    if (side === 'top') return [n.x + n.w / 2, n.y]
    if (side === 'bottom') return [n.x + n.w / 2, n.y + n.h]
    return null
  }
  // 连线几何：端点锚 + 出线方向法线。显式 fromSide/toSide 按声明取锚与法线；缺省按两节点中心
  // 连线的主轴取最近侧（水平位移为主取左/右、竖直为主取上/下）。
  const WKCV_SIDE_DIRS = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] }
  function wkCvAnchorDir(n, side, tx, ty) {
    if (side && WKCV_SIDE_DIRS[side]) {
      const p = wkCvAnchor(n, side)
      if (p) return { p, n: WKCV_SIDE_DIRS[side], side }
    }
    const cx = n.x + n.w / 2, cy = n.y + n.h / 2
    if (Math.abs(tx - cx) >= Math.abs(ty - cy)) {
      return tx < cx
        ? { p: [n.x, cy], n: WKCV_SIDE_DIRS.left, side: 'left' }
        : { p: [n.x + n.w, cy], n: WKCV_SIDE_DIRS.right, side: 'right' }
    }
    return ty < cy
      ? { p: [cx, n.y], n: WKCV_SIDE_DIRS.top, side: 'top' }
      : { p: [cx, n.y + n.h], n: WKCV_SIDE_DIRS.bottom, side: 'bottom' }
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
    return { a, c1, c2, b, mx, my, fs: A.side, ts: B.side }
  }
  function wkCvBezierPoint(g, t) {
    const u = 1 - t
    return [
      u * u * u * g.a[0] + 3 * u * u * t * g.c1[0] + 3 * u * t * t * g.c2[0] + t * t * t * g.b[0],
      u * u * u * g.a[1] + 3 * u * u * t * g.c1[1] + 3 * u * t * t * g.c2[1] + t * t * t * g.b[1]
    ]
  }
  function wkCvDistToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy
    let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
    t = Math.max(0, Math.min(1, t))
    return Math.sqrt(wkCvDist2(px, py, ax + t * dx, ay + t * dy))
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
  // 给解析出的节点挂上 Positionable 形态（搬运代码按 node.pos / node.size / node.boundingRect /
  // node.move / node.children 写；此处只做数据层适配，行为仍由搬来的逻辑驱动）。
  function wkCvAttachNodeApi(node, data) {
    Object.defineProperties(node, {
      pos: {
        get() { return [this.x, this.y] },
        set(v) { this.x = v[0]; this.y = v[1] },
        enumerable: false,
        configurable: true,
      },
      size: {
        get() { return [this.w, this.h] },
        set(v) { this.w = v[0]; this.h = v[1] },
        enumerable: false,
        configurable: true,
      },
      boundingRect: {
        get() { return [this.x, this.y, this.w, this.h] },
        enumerable: false,
        configurable: true,
      },
      children: {
        get() {
          if (this.type !== 'group') return undefined
          return data.nodes.filter((m) => {
            if (m === this || m.type === 'group') return false
            const cx = m.x + m.w / 2, cy = m.y + m.h / 2
            return cx >= this.x && cx <= this.x + this.w && cy >= this.y && cy <= this.y + this.h
          })
        },
        enumerable: false,
        configurable: true,
      },
      pinned: { value: false, enumerable: false, configurable: true },
      move: {
        value(dx, dy) { this.x += dx; this.y += dy },
        enumerable: false,
        configurable: true,
      },
    })
    return node
  }
  // 拖拽集合：搬 ComfyUI utils/collections.ts getDraggedItems / getAllNestedItems ——
  // 无 Ctrl/⌘ 时，拖组同时带上组内成员；按下 Ctrl/⌘ 只移动组本身。
  function wkCvGetDraggedItems(selected, event) {
    const moveGroupOnly = event.ctrlKey || event.metaKey
    if (moveGroupOnly) return new Set(selected)
    const all = new Set()
    const addRecursively = (item) => {
      if (all.has(item) || item.pinned) return
      all.add(item)
      if (item.children) for (const child of item.children) addRecursively(child)
    }
    for (const item of selected) addRecursively(item)
    return all
  }
  function wkCvNewId() {
    return 'wk-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  }

  // ---------- 图形编辑（拖动/缩放/连线/增删改；写入 = 原样改写源 JSON 再整篇 dispatch 回编辑器
  // 文档——保留源里本前端不识别的扩展字段，写回后走既有自动保存链落盘。拖动过程只改内存坐标，
  // 手势结束才一次性写文档（一次手势 = 一次编辑 = 一条撤销步）。 ----------
  function wkCvWriteDoc(view, j) {
    try {
      const text = JSON.stringify(j, null, 2) + '\n'
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
    } catch { /* 编辑器已销毁（切文件竞速）：丢弃本次手势 */ }
  }
  function wkCvRawNode(raw, id) {
    return (Array.isArray(raw && raw.nodes) ? raw.nodes : []).find((x) => x && x.id === id) || null
  }
  function wkCvReadRaw(text) {
    try { return JSON.parse(text) } catch { return null }
  }
  // 行内编辑（ComfyUI 同构：编辑态 = DOM 覆盖层里的 textarea，画布手势整体关闭）：
  // Enter / blur 提交，Escape 取消，Shift+Enter 换行。写入 = 源 JSON 上已有的那个字段（不新增键）。
  function wkCvOpenEditor(view, root, overlay, data, raw, rect, n) {
    if (root.classList.contains('wk-cv-editing')) return
    root.classList.add('wk-cv-editing')
    const ta = document.createElement('textarea')
    ta.className = 'wk-cv-edit'
    ta.style.left = Math.max(0, rect.x) + 'px'
    ta.style.top = Math.max(0, rect.y) + 'px'
    ta.style.width = Math.max(80, rect.w) + 'px'
    ta.style.height = Math.max(48, rect.h) + 'px'
    const rn = n.isEdge ? null : wkCvRawNode(raw, n.id)
    ta.value = n.isEdge
      ? String(n.label || '')
      : n.type === 'group'
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
      if (n.isEdge) {
        const idx = (Array.isArray(raw.edges) ? raw.edges : []).findIndex(
          (e) => e && e.fromNode === n.from.id && e.toNode === n.to.id
        )
        if (idx < 0) return
        raw.edges[idx].label = val
      } else {
        const target = wkCvRawNode(raw, n.id)
        if (!target) return
        if (n.type === 'group') target.label = val
        else if ('text' in target) target.text = val
        else if ('file' in target) target.file = val
        else if ('url' in target) target.url = val
      }
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

  // ---------- 画布视图（LGraphCanvas 的 processMouse* 结构；数据层 = JSON Canvas） ----------
  class WkCvGraphView {
    constructor(root, stage, canvas, overlay, view, text) {
      this.root = root
      this.stage = stage
      this.canvas = canvas
      this.overlay = overlay
      this.view = view
      this.text = text
      this.data = wkCvParse(text)
      this.wrapCache = new Map()
      this.pointer = new WkCvCanvasPointer(canvas)
      this.selected = new Set()
      this.dragMoved = new Set()
      this.state = {
        dragging_canvas: false,
        dragging_rectangle: null,
        isDragging: false,
        resizing_node: null,
        node_over: null,
        last_mouse: [0, 0],
        graph_mouse: [0, 0],
        link: null,
      }
      this._spaceKeyHeld = null
      this._lastDragModifiers = { ctrlKey: false, metaKey: false }
      this._lastMousePosition = [0, 0]
      this.dirty_bg = true
      this.dirty_fg = true
      this._raf = 0
      this._destroyed = false
      this.theme = wkCvTheme()

      for (const n of this.data.nodes) wkCvAttachNodeApi(n, this.data)
      this.restoreSelection()
      this.bindEvents()
      this.startRendering()
      this.fitIfNeeded()
    }

    // ---- 选择持久化（docChanged 重建 widget 后恢复；换文件清空） ----
    restoreSelection() {
      if (wkCvSelFile !== state.workFile) {
        wkCvSelFile = state.workFile
        wkCvSelIds = new Set()
      }
      const byId = new Map(this.data.nodes.map((n) => [n.id, n]))
      for (const id of wkCvSelIds) {
        const n = byId.get(id)
        if (n) this.selected.add(n)
      }
    }
    persistSelection() {
      wkCvSelFile = state.workFile
      wkCvSelIds = new Set([...this.selected].filter((n) => n && n.id).map((n) => n.id))
    }

    // ---- 相机 ----
    fitIfNeeded() {
      wkCvCamHost = this.canvas
      // toDOM 返回前 widget 尚未挂进文档，clientWidth/Height 为 0。等 ResizeObserver 报出真实尺寸再取景，
      // 否则会以 1×1 视口算缩放并把相机锁在错误位置（本轮取景由 RO 回调补跑）。
      const cw = this.stage.clientWidth
      const ch = this.stage.clientHeight
      if (cw <= 2 || ch <= 2) return
      wkCvDs.setViewportSize(cw, ch)
      if (wkCvCamFile === state.workFile) return
      wkCvCamFile = state.workFile
      const b = this.bounds()
      if (!b) return
      wkCvDs.animateToBounds(b, () => this.setDirty(true, true), {
        zoom: 0.75,
        viewport: [0, 0, cw, ch],
      })
    }
    bounds() {
      if (!this.data.nodes.length) return null
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (const n of this.data.nodes) {
        x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y)
        x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h)
      }
      return [x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)]
    }

    // ---- 渲染循环（搬 ComfyUI：持续 rAF + dirty_bgcanvas / dirty_canvas） ----
    startRendering() {
      const loop = () => {
        if (this._destroyed) return
        if (this.dirty_bg) {
          this.paintBackground()
          this.dirty_bg = false
        }
        if (this.dirty_fg) {
          this.paintForeground()
          this.dirty_fg = false
        }
        this._raf = requestAnimationFrame(loop)
      }
      this._raf = requestAnimationFrame(loop)
    }
    setDirty(fg, bg) {
      if (fg) this.dirty_fg = true
      if (bg) this.dirty_bg = true
    }
    resizeCanvas(canvas) {
      const dpr = window.devicePixelRatio || 1
      const cw = Math.max(1, this.stage.clientWidth)
      const ch = Math.max(1, this.stage.clientHeight)
      const pw = Math.round(cw * dpr), ph = Math.round(ch * dpr)
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw
        canvas.height = ph
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, cw, ch)
      return { ctx, dpr, cw, ch }
    }
    orderedNodes() {
      const groups = this.data.nodes.filter((n) => n.type === 'group')
      const rest = this.data.nodes.filter((n) => n.type !== 'group')
      return groups.concat(rest)
    }
    visible() {
      return wkCvDs.computeVisibleArea(undefined)
    }
    inView(n, v, margin) {
      margin = margin || 0
      return !(
        n.x + n.w < v[0] - margin ||
        n.y + n.h < v[1] - margin ||
        n.x > v[0] + v[2] + margin ||
        n.y > v[1] + v[3] + margin
      )
    }

    paintBackground() {
      const r = this.resizeCanvas(this.bgCanvas)
      if (!r) return
      const { ctx, cw, ch } = r
      this.theme = wkCvTheme()
      const theme = this.theme
      ctx.fillStyle = theme.bg
      ctx.fillRect(0, 0, cw, ch)
      const k = wkCvDs.scale
      const v = this.visible()

      // 点阵网格：世界 24 单位格；缩得太小时逐级加倍，屏上点距不小于 12px，总点数封顶。
      let step = WKCV_GRID
      while (step * k < 12) step *= 2
      const gx0 = Math.floor(v[0] / step) * step, gy0 = Math.floor(v[1] / step) * step
      const nx = Math.floor(v[2] / step) + 2, ny = Math.floor(v[3] / step) + 2
      const every = Math.max(1, Math.ceil((nx * ny) / 4000))
      ctx.fillStyle = theme.border
      ctx.globalAlpha = 0.55
      let ci = 0
      for (let iy = 0; iy < ny; iy++) {
        for (let ix = 0; ix < nx; ix++) {
          if ((ci++ % every) !== 0) continue
          const s = wkCvToScreen(gx0 + ix * step, gy0 + iy * step)
          ctx.beginPath()
          ctx.arc(s[0], s[1], 1.2, 0, Math.PI * 2)
          ctx.fill()
        }
      }
      ctx.globalAlpha = 1

      // 边（世界坐标直接经 ctx 变换绘制：曲线 + 箭头 + 标签）
      const dpr = window.devicePixelRatio || 1
      ctx.save()
      ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * wkCvDs.offset[0] * k, dpr * wkCvDs.offset[1] * k)
      for (const e of this.data.edges) {
        if (!this.inView(e.from, v, 400) && !this.inView(e.to, v, 400)) continue
        const g = wkCvEdgeGeom(e)
        const selected = this.selected.has(e)
        const col = selected ? theme.blue : e.color || theme.text3
        ctx.strokeStyle = col
        ctx.fillStyle = col
        ctx.lineWidth = (selected ? 2.5 : 1.5) / k
        ctx.beginPath()
        ctx.moveTo(g.a[0], g.a[1])
        ctx.bezierCurveTo(g.c1[0], g.c1[1], g.c2[0], g.c2[1], g.b[0], g.b[1])
        ctx.stroke()
        if (e.arrow && k >= 0.6) {
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
        if (e.label && k >= 0.6) {
          ctx.font = `${11 / k}px ${WKCV_FONT}`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.lineWidth = 3 / k
          ctx.strokeStyle = theme.bg
          ctx.strokeText(e.label, g.mx, g.my)
          ctx.fillStyle = col
          ctx.fillText(e.label, g.mx, g.my)
        }
      }

      // 正在拖出的新连线（ComfyUI LinkConnector.renderLinks 的轻量等价物）
      const link = this.state.link
      if (link) {
        const a = wkCvAnchor(link.node, link.side) || [link.node.x + link.node.w / 2, link.node.y + link.node.h / 2]
        const dir = WKCV_SIDE_DIRS[link.side] || [0, 0]
        const b = link.to
        const dist = Math.max(24, Math.hypot(b[0] - a[0], b[1] - a[1]) / 2)
        const c1 = [a[0] + dir[0] * dist, a[1] + dir[1] * dist]
        ctx.strokeStyle = theme.blue
        ctx.lineWidth = 2 / k
        ctx.setLineDash([6 / k, 5 / k])
        ctx.beginPath()
        ctx.moveTo(a[0], a[1])
        ctx.bezierCurveTo(c1[0], c1[1], b[0], b[1], b[0], b[1])
        ctx.stroke()
        ctx.setLineDash([])
      }
      ctx.restore()
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    paintForeground() {
      const r = this.resizeCanvas(this.fgCanvas)
      if (!r) return
      const { ctx, dpr, cw, ch } = r
      const theme = this.theme
      const k = wkCvDs.scale
      const v = this.visible()
      // 搬 ComfyUI _min_font_size_for_lod=8：正文按世界字号 12 计算，屏幕字号 < 8 时进入低质量。
      const lowQuality = 12 * k < 8

      ctx.save()
      ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * wkCvDs.offset[0] * k, dpr * wkCvDs.offset[1] * k)

      const ordered = this.orderedNodes()
      for (const n of ordered) {
        if (!this.inView(n, v, 40)) continue
        const x = n.x, y = n.y
        const col = n.color || ''
        const isSelected = this.selected.has(n)
        const isHover = this.state.node_over === n
        wkCvRoundRect(ctx, x, y, n.w, n.h, n.type === 'group' ? 10 : 8)
        ctx.fillStyle = col
          ? wkCvRgba(col, n.type === 'group' ? 0.08 : 0.16)
          : (n.type === 'group' ? 'rgba(0,0,0,0)' : wkCvRgba(theme.blue, isSelected ? 0.1 : 0.04))
        ctx.fill()
        ctx.lineWidth = (isSelected || isHover ? 2 : 1) / k
        ctx.strokeStyle = isSelected ? theme.blue : col ? wkCvRgba(col, 0.65) : theme.border
        if (n.type === 'group') ctx.setLineDash([5 / k, 4 / k])
        ctx.stroke()
        ctx.setLineDash([])

        if (n.type === 'group') {
          if (n.label && !lowQuality) {
            ctx.font = `600 12px ${WKCV_FONT}`
            ctx.textAlign = 'left'
            ctx.textBaseline = 'alphabetic'
            ctx.lineWidth = 3 / k
            ctx.strokeStyle = theme.bg
            ctx.strokeText(n.label, x + 2, y - 8 / k)
            ctx.fillStyle = col ? wkCvRgba(col, 0.95) : theme.text2
            ctx.fillText(n.label, x + 2, y - 8 / k)
          }
          continue
        }

        // 正文：按节点宽度折行，超出高度裁掉；折行结果按 (id, 宽, 文本) 缓存。
        if (!lowQuality) {
          const padX = 8, padY = 6
          const maxW = Math.max(10, n.w - padX * 2)
          ctx.save()
          ctx.beginPath()
          ctx.rect(x + padX, y + padY, maxW, Math.max(10, n.h - padY * 2))
          ctx.clip()
          ctx.font = `12px ${WKCV_FONT}`
          ctx.textAlign = 'left'
          ctx.textBaseline = 'top'
          ctx.fillStyle = theme.text
          const lh = 18
          const lines = this.wrapLines(ctx, n, maxW, Math.max(1, Math.ceil((n.h - padY * 2) / lh)))
          for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], x + padX, y + padY + i * lh)
          ctx.restore()
        }

        // 连线锚点（ComfyUI 的 slot 圆点；左侧 = 入、右侧 = 出）
        if (k >= 0.6) {
          ctx.fillStyle = theme.blue
          ctx.globalAlpha = 0.8
          ctx.beginPath(); ctx.arc(x + n.w, y + n.h / 2, 4, 0, Math.PI * 2); ctx.fill()
          ctx.beginPath(); ctx.arc(x, y + n.h / 2, 4, 0, Math.PI * 2); ctx.fill()
          ctx.globalAlpha = 1
        }

        // 选中描边 = strokeShape(selected)：padding 6、alpha 0.8（搬 litegraph draw.ts）
        if (isSelected) {
          const pad = 6
          ctx.globalAlpha = 0.8
          ctx.strokeStyle = theme.blue
          ctx.lineWidth = 2 / k
          wkCvRoundRect(ctx, x - pad, y - pad, n.w + pad * 2, n.h + pad * 2, 8 + pad)
          ctx.stroke()
          ctx.globalAlpha = 1
        }
      }
      ctx.restore()

      // 框选矩形：按 ComfyUI 用屏幕坐标绘制（不随缩放变形）
      const rect = this.state.dragging_rectangle
      const { eDown, eMove } = this.pointer
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (rect) {
        ctx.strokeStyle = theme.blue
        ctx.lineWidth = 1
        if (eDown && eMove) {
          const x = eDown.safeOffsetX
          const y = eDown.safeOffsetY
          ctx.strokeRect(x, y, eMove.safeOffsetX - x, eMove.safeOffsetY - y)
        } else {
          const a = wkCvToScreen(rect[0], rect[1])
          const b = wkCvToScreen(rect[0] + rect[2], rect[1] + rect[3])
          ctx.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1])
        }
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    wrapLines(ctx, n, maxW, maxLines) {
      const key = n.id + '|' + Math.round(n.w) + '|' + n.text
      const cached = this.wrapCache.get(key)
      if (cached) return cached
      const lines = wkCvWrap(ctx, n.text, maxW, maxLines)
      if (this.wrapCache.size > 500) this.wrapCache.clear()
      this.wrapCache.set(key, lines)
      return lines
    }

    // ---- 命中测试 ----
    getNodeOnPos(x, y) {
      const ordered = this.orderedNodes()
      for (let i = ordered.length - 1; i >= 0; i--) {
        const n = ordered[i]
        if (x >= n.x && x <= n.x + n.w && y >= n.y && y <= n.y + n.h) return n
      }
      return undefined
    }
    getEdgeOnPos(x, y) {
      const tol = Math.max(4, 6 / wkCvDs.scale)
      for (const e of this.data.edges) {
        const g = wkCvEdgeGeom(e)
        let px = g.a[0], py = g.a[1]
        for (let i = 1; i <= 24; i++) {
          const p = wkCvBezierPoint(g, i / 24)
          if (wkCvDistToSegment(x, y, px, py, p[0], p[1]) <= tol) return e
          px = p[0]; py = p[1]
        }
      }
      return undefined
    }
    // 节点角 = 缩放把手（ComfyUI findContainingCorner，resizeHandleSize=15）
    findResizeDirection(n, x, y) {
      const r = n.x + n.w, b = n.y + n.h
      if (wkCvIsInRectangle(x, y, n.x, n.y, WKCV_RESIZE_HANDLE, WKCV_RESIZE_HANDLE)) return 'NW'
      if (wkCvIsInRectangle(x, y, r - WKCV_RESIZE_HANDLE, n.y, WKCV_RESIZE_HANDLE, WKCV_RESIZE_HANDLE)) return 'NE'
      if (wkCvIsInRectangle(x, y, n.x, b - WKCV_RESIZE_HANDLE, WKCV_RESIZE_HANDLE, WKCV_RESIZE_HANDLE)) return 'SW'
      if (wkCvIsInRectangle(x, y, r - WKCV_RESIZE_HANDLE, b - WKCV_RESIZE_HANDLE, WKCV_RESIZE_HANDLE, WKCV_RESIZE_HANDLE)) return 'SE'
      return undefined
    }
    bringToFront(n) {
      if (n.type === 'group') return
      const i = this.data.nodes.indexOf(n)
      if (i < 0 || i === this.data.nodes.length - 1) return
      this.data.nodes.splice(i, 1)
      this.data.nodes.push(n)
      this.setDirty(true, true)
    }

    // ---- 选择 ----
    processSelect(item, e, sticky) {
      const intent = wkCvResolveClickSelection({
        hasItem: !!item,
        isSelected: !!item && this.selected.has(item),
        modifiers: e,
        multiSelect: false,
        selectOnly: false,
        sticky: !!sticky,
      })
      switch (intent) {
        case 'clear':
          this.selected.clear()
          break
        case 'add':
          if (item) this.selected.add(item)
          break
        case 'remove':
          if (item) this.selected.delete(item)
          break
        case 'replace':
          this.selected.clear()
          if (item) this.selected.add(item)
          break
        case 'none':
        default:
          return
      }
      this.persistSelection()
      this.setDirty(true, false)
    }
    selectAll() {
      this.selected = new Set([...this.data.nodes, ...this.data.edges])
      this.persistSelection()
      this.setDirty(true, true)
    }
    _normalizeDragRect(rect) {
      const w = Math.abs(rect[2])
      const h = Math.abs(rect[3])
      if (rect[2] < 0) rect[0] -= w
      if (rect[3] < 0) rect[1] -= h
      rect[2] = w
      rect[3] = h
      return rect
    }
    _getItemsInRect(rect) {
      const items = new Set()
      for (const node of this.data.nodes) {
        if (node.type === 'group') {
          if (wkCvContainsRect(rect, node.boundingRect)) items.add(node)
        } else if (wkCvOverlapBounding(rect, node.boundingRect)) {
          items.add(node)
        }
      }
      return items
    }
    _handleMultiSelect(e, dragRect) {
      const normalizedRect = this._normalizeDragRect([dragRect[0], dragRect[1], dragRect[2], dragRect[3]])
      const desired = wkCvApplyMarqueeSelection(
        wkCvResolveMarqueeSelection(e),
        this.selected,
        this._getItemsInRect(normalizedRect)
      )
      this.selected = new Set([...desired].filter((it) => !!it && !it.from))
      this.persistSelection()
      this.setDirty(true, true)
    }
    _setupNodeSelectionDrag(e, pointer, clickTarget) {
      const dragRect = [e.canvasX, e.canvasY, 1, 1]
      pointer.onClick = (eUp) => this.processSelect(clickTarget, eUp)
      pointer.onDragStart = () => { this.state.dragging_rectangle = dragRect }
      // liveSelection=false（ComfyUI 默认）：框选在 drag end 一次性结算。
      pointer.onDragEnd = (upEvent) => this._handleMultiSelect(upEvent, dragRect)
      pointer.finally = () => {
        this.state.dragging_rectangle = null
        this.setDirty(true, true)
      }
    }

    // ---- 指针事件 ----
    adjustMouseEvent(e) {
      const b = this.canvas.getBoundingClientRect()
      e.safeOffsetX = e.clientX - b.left
      e.safeOffsetY = e.clientY - b.top
      e.canvasX = e.safeOffsetX / wkCvDs.scale - wkCvDs.offset[0]
      e.canvasY = e.safeOffsetY / wkCvDs.scale - wkCvDs.offset[1]
    }
    bindEvents() {
      const canvas = this.canvas
      canvas.tabIndex = -1
      this._onDown = (e) => this.processMouseDown(e)
      this._onMove = (e) => this.processMouseMove(e)
      this._onUp = (e) => this.processMouseUp(e)
      this._onWheel = (e) => this.processMouseWheel(e)
      this._onCancel = () => this.processMouseCancel()
      this._onKeyDown = (e) => this.processKey(e)
      this._onKeyUp = (e) => this.processKey(e)
      this._onContext = (e) => e.preventDefault()
      canvas.addEventListener('pointerdown', this._onDown, true)
      canvas.addEventListener('pointermove', this._onMove)
      canvas.addEventListener('pointerup', this._onUp, true)
      canvas.addEventListener('pointercancel', this._onCancel)
      canvas.addEventListener('wheel', this._onWheel, { passive: false })
      canvas.addEventListener('keydown', this._onKeyDown, true)
      canvas.addEventListener('contextmenu', this._onContext)
      document.addEventListener('keyup', this._onKeyUp, true)
    }
    processMouseDown(e) {
      this.adjustMouseEvent(e)
      if (e.isPrimary) this.pointer.down(e)
      this.state.dragging_canvas = false
      const pointer = this.pointer
      const x = e.clientX, y = e.clientY
      const node = this.getNodeOnPos(e.canvasX, e.canvasY)
      const edge = node ? undefined : this.getEdgeOnPos(e.canvasX, e.canvasY)
      this.state.node_over = node || null
      this.state.graph_mouse = [e.canvasX, e.canvasY]
      this.state.last_mouse = [x, y]
      this._lastMousePosition = [e.safeOffsetX, e.safeOffsetY]

      pointer.isDouble = pointer.isDown && e.isPrimary
      pointer.isDown = true
      try { this.canvas.focus({ preventScroll: true }) } catch { this.canvas.focus() }

      if (e.button === 0 && !pointer.isDouble) {
        this._processPrimaryButton(e, node, edge)
      } else if (e.button === 1) {
        this._processMiddleButton(e, node)
      }
      this.setDirty(true, true)
      e.preventDefault()
      e.stopPropagation()
    }
    _processMiddleButton(e, node) {
      const pointer = this.pointer
      pointer.onDragStart = () => { this.state.dragging_canvas = true }
      pointer.finally = () => { this.state.dragging_canvas = false }
    }
    _processPrimaryButton(e, node, edge) {
      const pointer = this.pointer
      const ctrlOrMeta = e.ctrlKey || e.metaKey

      // Ctrl/⌘ + 拖 = 框选（ComfyUI leftMouseClickBehavior === 'panning'）
      if (ctrlOrMeta && !e.altKey) {
        this._setupNodeSelectionDrag(e, pointer, node || edge)
        return
      }
      // 空格持握 = 临时平移（ComfyUI read_only 分支）
      if (this._spaceKeyHeld) {
        pointer.finally = () => { this.state.dragging_canvas = false }
        this.state.dragging_canvas = true
        return
      }

      if (edge) {
        pointer.onClick = (eUp) => this.processSelect(edge, eUp)
        pointer.onDoubleClick = () => this.openEdgeEditor(edge)
        pointer.onDragStart = () => { this.state.dragging_canvas = true }
        pointer.finally = () => { this.state.dragging_canvas = false }
        return
      }
      if (node) {
        this._processNodeClick(e, ctrlOrMeta, node)
        return
      }
      // 空白
      pointer.onDoubleClick = () => this.createNodeAt(e.canvasX, e.canvasY)
      if (!pointer.onDragStart && !pointer.onClick && !pointer.onDrag) {
        // 默认左键平移：拖 = 平移画布；点 = 清空选择
        pointer.onClick = (eUp) => this.processSelect(null, eUp)
        pointer.finally = () => { this.state.dragging_canvas = false }
        this.state.dragging_canvas = true
      }
    }
    _processNodeClick(e, ctrlOrMeta, node) {
      const pointer = this.pointer
      const x = e.canvasX, y = e.canvasY
      pointer.onClick = () => this.processSelect(node, e)
      this.bringToFront(node)

      // 槽位：右侧 = 输出、左侧 = 输入（拖出新连线；ComfyUI 先查 slot 再查 resize）
      const outPos = [node.x + node.w, node.y + node.h / 2]
      if (wkCvIsInRectangle(x, y, outPos[0] - 15, outPos[1] - 10, 30, 20)) {
        this._startLinkDrag(node, 'right', 'input', pointer)
        return
      }
      const inPos = [node.x, node.y + node.h / 2]
      if (wkCvIsInRectangle(x, y, inPos[0] - 15, inPos[1] - 10, 30, 20)) {
        this._startLinkDrag(node, 'left', 'output', pointer)
        return
      }

      pointer.onDoubleClick = () => this.openNodeEditor(node)

      // 缩放把手（ComfyUI：先 onMouseDown 再 resize 再拖动）
      const resizeDirection = this.findResizeDirection(node, x, y)
      if (resizeDirection) {
        pointer.resizeDirection = resizeDirection
        const startBounds = [node.x, node.y, node.w, node.h]
        pointer.onDragStart = () => { this.state.resizing_node = node }
        pointer.onDrag = (eMove) => {
          if (!pointer.dragStarted) return
          const deltaX = eMove.canvasX - x
          const deltaY = eMove.canvasY - y
          const newBounds = [startBounds[0], startBounds[1], startBounds[2], startBounds[3]]
          switch (resizeDirection) {
            case 'NE':
              newBounds[1] = startBounds[1] + deltaY
              newBounds[2] = startBounds[2] + deltaX
              newBounds[3] = startBounds[3] - deltaY
              break
            case 'SE':
              newBounds[2] = startBounds[2] + deltaX
              newBounds[3] = startBounds[3] + deltaY
              break
            case 'SW':
              newBounds[0] = startBounds[0] + deltaX
              newBounds[2] = startBounds[2] - deltaX
              newBounds[3] = startBounds[3] + deltaY
              break
            case 'NW':
              newBounds[0] = startBounds[0] + deltaX
              newBounds[1] = startBounds[1] + deltaY
              newBounds[2] = startBounds[2] - deltaX
              newBounds[3] = startBounds[3] - deltaY
              break
          }
          const min = WKCV_MIN_SIZE
          if (newBounds[2] < min[0]) {
            if (resizeDirection.indexOf('W') !== -1) newBounds[0] = startBounds[0] + startBounds[2] - min[0]
            newBounds[2] = min[0]
          }
          if (newBounds[3] < min[1]) {
            if (resizeDirection.indexOf('N') !== -1) newBounds[1] = startBounds[1] + startBounds[3] - min[1]
            newBounds[3] = min[1]
          }
          node.x = newBounds[0]; node.y = newBounds[1]
          node.w = newBounds[2]; node.h = newBounds[3]
          this.setDirty(true, true)
        }
        const finishResize = () => {
          this.commitNodes([node])
          this.state.resizing_node = null
          this.setDirty(true, true)
        }
        pointer.onDragEnd = finishResize
        pointer.onDragCancel = finishResize
        pointer.finally = () => {
          this.state.resizing_node = null
          pointer.resizeDirection = undefined
        }
        this._setCursor(resizeDirection.toLowerCase() + '-resize')
        return
      }

      // 拖动节点（含多选 / 组带成员）
      pointer.onDragStart = (p) => this._startDraggingItems(node, p, true)
      pointer.onDragEnd = (eUp) => this._processDraggedItems(eUp)
    }
    _setCursor(value) {
      if (this.canvas.style.cursor !== value) this.canvas.style.cursor = value
    }
    _startLinkDrag(node, side, connectingTo, pointer) {
      this.state.link = { node, side, connectingTo, to: this.state.graph_mouse.slice() }
      pointer.onDrag = (eMove) => {
        if (!pointer.dragStarted) return
        this.state.link.to = [eMove.canvasX, eMove.canvasY]
        this.setDirty(false, true)
      }
      pointer.onDragEnd = (eUp) => this._dropLinks(eUp)
      pointer.onDragCancel = () => { this.state.link = null; this.setDirty(false, true) }
      pointer.finally = () => {
        this.state.link = null
        this.setDirty(false, true)
      }
      this.setDirty(false, true)
    }
    // 搬 ComfyUI LinkConnector.dropOnNode：禁止自连；落在节点上就按当前方向建边。
    _dropLinks(eUp) {
      const link = this.state.link
      this.state.link = null
      if (!link) return
      const target = this.getNodeOnPos(eUp.canvasX, eUp.canvasY)
      if (!target || target === link.node) {
        this.setDirty(false, true)
        return
      }
      const raw = wkCvReadRaw(this.text)
      if (!raw) return
      if (!Array.isArray(raw.edges)) raw.edges = []
      // 搬 ComfyUI connectToNode 的既有连接检查：同一对端点不重复建边
      const fromId = link.connectingTo === 'input' ? link.node.id : target.id
      const toId = link.connectingTo === 'input' ? target.id : link.node.id
      if (raw.edges.some((e) => e && e.fromNode === fromId && e.toNode === toId)) {
        this.setDirty(false, true)
        return
      }
      if (link.connectingTo === 'input') {
        raw.edges.push({ fromNode: fromId, toNode: toId, fromSide: link.side, toSide: undefined })
      } else {
        raw.edges.push({ fromNode: fromId, toNode: toId, fromSide: undefined, toSide: link.side })
      }
      wkCvWriteDoc(this.view, raw)
    }
    _startDraggingItems(item, pointer, sticky) {
      pointer.finally = () => {
        this.state.isDragging = false
      }
      pointer.onDragCancel = () => this._processDraggedItems()
      this.processSelect(item, pointer.eDown, sticky)
      this.state.isDragging = true
      this.dragMoved = new Set()
      if (pointer.eDown) {
        this._lastDragModifiers = {
          ctrlKey: pointer.eDown.ctrlKey,
          metaKey: pointer.eDown.metaKey,
        }
      }
    }
    _processDraggedItems(e) {
      // 搬 ComfyUI：Shift（或 alwaysSnapToGrid）在落点吸附到网格
      if (e && e.shiftKey) {
        for (const item of this.dragMoved) {
          if (!item || !item.id) continue
          const pos = [item.x, item.y]
          wkCvSnapPoint(pos, WKCV_SNAP)
          item.x = pos[0]; item.y = pos[1]
        }
      }
      this.commitNodes([...this.dragMoved])
      this.state.isDragging = false
      this.dragMoved = new Set()
      this.setDirty(true, true)
    }
    processMouseMove(e) {
      this.adjustMouseEvent(e)
      const mouse = [e.clientX, e.clientY]
      const delta = [mouse[0] - this.state.last_mouse[0], mouse[1] - this.state.last_mouse[1]]
      this.state.last_mouse = mouse
      this.state.graph_mouse = [e.canvasX, e.canvasY]

      if (e.isPrimary) this.pointer.move(e)

      const pointer = this.pointer
      const dragRect = this.state.dragging_rectangle
      if (dragRect) {
        dragRect[2] = e.canvasX - dragRect[0]
        dragRect[3] = e.canvasY - dragRect[1]
        this.setDirty(true, true)
      } else if (this.state.dragging_canvas) {
        wkCvDs.offset[0] += delta[0] / wkCvDs.scale
        wkCvDs.offset[1] += delta[1] / wkCvDs.scale
        this.setDirty(true, true)
      } else if (!pointer.isDown) {
        // hover：光标形状 + 悬停高亮
        const node = this.getNodeOnPos(e.canvasX, e.canvasY)
        if (this.state.node_over !== (node || null)) {
          this.state.node_over = node || null
          this.setDirty(true, false)
        }
        if (node) {
          const dir = this.findResizeDirection(node, e.canvasX, e.canvasY)
          this._setCursor(dir ? dir.toLowerCase() + '-resize' : 'grab')
        } else if (this.getEdgeOnPos(e.canvasX, e.canvasY)) {
          this._setCursor('pointer')
        } else {
          this._setCursor('grab')
        }
      }

      // 被拖动的项目（ComfyUI：delta / scale，组按 getDraggedItems 带成员）
      if (this.state.isDragging) {
        this._lastDragModifiers = { ctrlKey: e.ctrlKey, metaKey: e.metaKey }
        const allItems = wkCvGetDraggedItems(this.selected, e)
        const deltaX = delta[0] / wkCvDs.scale
        const deltaY = delta[1] / wkCvDs.scale
        for (const item of allItems) {
          if (!item || !item.id) continue
          item.move(deltaX, deltaY)
          this.dragMoved.add(item)
        }
        this.setDirty(true, true)
      }

      e.preventDefault()
    }
    processMouseUp(e) {
      if (!e.isPrimary) return
      this.adjustMouseEvent(e)
      const isClick = this.pointer.up(e)
      if (isClick) {
        this.state.dragging_canvas = false
        e.stopPropagation()
        e.preventDefault()
        return
      }
      this.state.dragging_canvas = false
      if (e.button === 0) {
        this.state.isDragging = false
      }
      this.setDirty(true, true)
      e.stopPropagation()
      e.preventDefault()
    }
    processMouseCancel() {
      this.pointer.reset()
      this.setDirty(true, true)
    }
    // 搬 cofmyfrontend processMouseWheel：默认 mouseWheelScroll='zoom' ⇒ 滚轮=缩放（鼠标步进 ×1.1，
    // 触控板平滑）；Ctrl/⌘ 同样缩放；指针位置为缩放锚点。
    processMouseWheel(e) {
      this.adjustMouseEvent(e)
      let scale = wkCvDs.scale
      const isTrackpad = this.pointer.isTrackpadGesture(e)
      const zoomSpeed = 1.1
      if (isTrackpad) {
        scale *= 1 + e.deltaY * (1 - zoomSpeed) * 0.18
        wkCvDs.changeScale(scale, [e.clientX, e.clientY], false)
      } else {
        if (e.deltaY < 0) scale *= zoomSpeed
        else if (e.deltaY > 0) scale *= 1 / zoomSpeed
        wkCvDs.changeScale(scale, [e.clientX, e.clientY])
      }
      this.setDirty(true, true)
      e.preventDefault()
    }
    // 搬 ComfyUI processKey + 画布命令绑定：空格平移 / Esc / Delete / Ctrl+A / Ctrl+C / Ctrl+V
    processKey(e) {
      if (e.type === 'keyup' && e.key === ' ') {
        const held = this._spaceKeyHeld
        this._spaceKeyHeld = null
        if (held) {
          this.state.dragging_canvas = held.draggingCanvas && this.pointer.isDown
          this._setCursor('grab')
        }
        return
      }
      if (e.target instanceof Element && e.target.localName === 'input') return
      let block_default = false
      if (e.type === 'keydown') {
        if (e.key === ' ') {
          if (!this._spaceKeyHeld) {
            this._spaceKeyHeld = { draggingCanvas: this.state.dragging_canvas }
          }
          this.state.dragging_canvas = this.pointer.isDown
          this._setCursor('grabbing')
          block_default = true
        } else if (e.key === 'Escape') {
          if (this.state.link) {
            this.state.link = null
            this.pointer.reset()
            this.setDirty(false, true)
            e.preventDefault()
            return
          }
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
          this.deleteSelected()
          block_default = true
        } else if ((e.ctrlKey || e.metaKey) && !e.altKey) {
          const k = e.key.toLowerCase()
          if (k === 'a') {
            this.selectAll()
            block_default = true
          } else if (k === 'c') {
            this.copySelected()
            block_default = true
          } else if (k === 'v') {
            this.pasteFromClipboard()
            block_default = true
          }
        }
      }
      if (block_default) {
        e.preventDefault()
        e.stopImmediatePropagation()
      }
    }

    // ---- 文档写入 ----
    commitNodes(items) {
      if (!items || !items.length) return
      const raw = wkCvReadRaw(this.text)
      if (!raw) return
      let changed = false
      for (const it of items) {
        if (!it || !it.id) continue
        const r = wkCvRawNode(raw, it.id)
        if (!r) continue
        const x = Math.round(it.x), y = Math.round(it.y)
        const w = Math.max(1, Math.round(it.w)), h = Math.max(1, Math.round(it.h))
        if (r.x !== x || r.y !== y || r.width !== w || r.height !== h) {
          r.x = x; r.y = y; r.width = w; r.height = h
          changed = true
        }
      }
      if (changed) wkCvWriteDoc(this.view, raw)
    }
    // 搬 ComfyUI deleteSelected：节点先 connectInputToOutput（删除后把前驱接给后继），再删除。
    deleteSelected() {
      if (!this.selected.size) return
      const raw = wkCvReadRaw(this.text)
      if (!raw) return
      if (!Array.isArray(raw.edges)) raw.edges = []
      const nodeIds = new Set()
      for (const item of this.selected) {
        if (!item) continue
        if (item.from) {
          // 选中的边直接删
          raw.edges = raw.edges.filter((e) => !(e && e.fromNode === item.from.id && e.toNode === item.to.id))
        } else if (item.id) {
          nodeIds.add(item.id)
        }
      }
      for (const id of nodeIds) {
        const ins = raw.edges.filter((e) => e && e.toNode === id)
        const outs = raw.edges.filter((e) => e && e.fromNode === id)
        for (const a of ins) {
          for (const b of outs) {
            if (!a.fromNode || !b.toNode || a.fromNode === b.toNode) continue
            const exists = raw.edges.some((e) => e && e.fromNode === a.fromNode && e.toNode === b.toNode)
            if (!exists) {
              raw.edges.push({ fromNode: a.fromNode, toNode: b.toNode, fromSide: a.fromSide, toSide: b.toSide })
            }
          }
        }
        raw.edges = raw.edges.filter((e) => e && e.fromNode !== id && e.toNode !== id)
        raw.nodes = raw.nodes.filter((n) => n && n.id !== id)
      }
      this.selected.clear()
      this.persistSelection()
      this.setDirty(true, true)
      wkCvWriteDoc(this.view, raw)
    }
    copySelected() {
      const raw = wkCvReadRaw(this.text)
      if (!raw) return
      const nodes = []
      const ids = new Set()
      for (const item of this.selected) {
        if (!item || !item.id) continue
        const r = wkCvRawNode(raw, item.id)
        if (!r) continue
        nodes.push(JSON.parse(JSON.stringify(r)))
        ids.add(item.id)
      }
      if (!nodes.length) return
      const edges = (Array.isArray(raw.edges) ? raw.edges : [])
        .filter((e) => e && ids.has(e.fromNode) && ids.has(e.toNode))
        .map((e) => JSON.parse(JSON.stringify(e)))
      try {
        localStorage.setItem(WKCV_CLIP_KEY, JSON.stringify({ nodes, edges }))
      } catch { /* 存储不可用：忽略 */ }
    }
    // 搬 ComfyUI pasteFromClipboard：新 id、相对包围盒左上角落到 graph_mouse、选中新项。
    pasteFromClipboard() {
      let clip
      try { clip = JSON.parse(localStorage.getItem(WKCV_CLIP_KEY) || 'null') } catch { return }
      if (!clip || !Array.isArray(clip.nodes) || !clip.nodes.length) return
      const raw = wkCvReadRaw(this.text)
      if (!raw) return
      if (!Array.isArray(raw.edges)) raw.edges = []
      let x0 = Infinity, y0 = Infinity
      for (const n of clip.nodes) {
        x0 = Math.min(x0, Number(n.x) || 0)
        y0 = Math.min(y0, Number(n.y) || 0)
      }
      if (!Number.isFinite(x0)) x0 = 0
      if (!Number.isFinite(y0)) y0 = 0
      const mx = this.state.graph_mouse[0], my = this.state.graph_mouse[1]
      const idMap = new Map()
      const newIds = []
      for (const n of clip.nodes) {
        const id = wkCvNewId()
        const copy = JSON.parse(JSON.stringify(n))
        copy.id = id
        copy.x = (Number(n.x) || 0) - x0 + mx
        copy.y = (Number(n.y) || 0) - y0 + my
        raw.nodes.push(copy)
        idMap.set(n.id, id)
        newIds.push(id)
      }
      for (const e of clip.edges || []) {
        if (!idMap.has(e.fromNode) || !idMap.has(e.toNode)) continue
        const copy = JSON.parse(JSON.stringify(e))
        copy.fromNode = idMap.get(e.fromNode)
        copy.toNode = idMap.get(e.toNode)
        raw.edges.push(copy)
      }
      wkCvSelFile = state.workFile
      wkCvSelIds = new Set(newIds)
      wkCvWriteDoc(this.view, raw)
    }
    // 空白双击 = 新建文本节点（ComfyUI empty-double-click 的搜索框语义在 JSON Canvas 的对应物）
    createNodeAt(x, y) {
      const raw = wkCvReadRaw(this.text)
      if (!raw) return
      const id = wkCvNewId()
      raw.nodes.push({ id, type: 'text', x: Math.round(x), y: Math.round(y), width: 240, height: 120, text: '' })
      wkCvSelFile = state.workFile
      wkCvSelIds = new Set([id])
      wkCvWriteDoc(this.view, raw)
    }
    openNodeEditor(n) {
      const raw = wkCvReadRaw(this.text)
      if (!raw) return
      const s = wkCvToScreen(n.x, n.y)
      wkCvOpenEditor(this.view, this.root, this.overlay, this.data, raw, {
        x: s[0], y: s[1], w: n.w * wkCvDs.scale, h: n.h * wkCvDs.scale,
      }, n)
    }
    openEdgeEditor(edge) {
      const raw = wkCvReadRaw(this.text)
      if (!raw) return
      const g = wkCvEdgeGeom(edge)
      const s = wkCvToScreen(g.mx, g.my)
      wkCvOpenEditor(this.view, this.root, this.overlay, this.data, raw, {
        x: s[0] - 80, y: s[1] - 18, w: 160, h: 36,
      }, { isEdge: true, from: edge.from, to: edge.to, label: edge.label })
    }
    destroy() {
      this._destroyed = true
      if (this._raf) cancelAnimationFrame(this._raf)
      wkCvDs.cancelAnimation()
      const canvas = this.canvas
      canvas.removeEventListener('pointerdown', this._onDown, true)
      canvas.removeEventListener('pointermove', this._onMove)
      canvas.removeEventListener('pointerup', this._onUp, true)
      canvas.removeEventListener('pointercancel', this._onCancel)
      canvas.removeEventListener('wheel', this._onWheel)
      canvas.removeEventListener('keydown', this._onKeyDown, true)
      canvas.removeEventListener('contextmenu', this._onContext)
      document.removeEventListener('keyup', this._onKeyUp, true)
      this.pointer.reset()
      if (wkCvCamHost === canvas) wkCvCamHost = null
      if (this.ro) { this.ro.disconnect(); this.ro = null }
    }
  }

  // ---------- 画布 widget（decoField 的 block replace 宿主；跨行 replace 只允许走 StateField） ----------
  // 必须继承 CM.WidgetType：视图在 DOM 复用/测量/事件路径会调基类方法（compare/estimatedHeight/
  // ignoreEvent/updateDOM 等），普通 class 缺这些方法 ⇒ 首次 docChanged 半更新抛 TypeError，之后每次
  // dispatch 都在破损视图上再抛 ⇒ 编辑区整体报废（连开其它文件也失败）。CM6 包先于 /app.js 加载，
  // 基类在模块求值期可取（edCMG 来自 editor/cm-bridge.js，排在 work-canvas 之前）。
  const WkCvWidgetBase = edCMG.WidgetType
  class WkCvWidget extends WkCvWidgetBase {
    constructor(text) { super(); this.text = text }
    eq() { return false } // doc 变 / 态切时恒重建 DOM（相机/选择在模块级保留）
    toDOM(view) {
      const root = document.createElement('div')
      root.className = 'wk-cv'
      const data = wkCvParse(this.text)
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
      // 操作提示（画布本身没有可见 affordance）
      const hint = document.createElement('span')
      hint.className = 'wk-cv-hint'
      hint.textContent = '拖动移动 · Ctrl/⌘拖动框选 · 双击编辑 · Shift 吸附 · Del 删除 · Ctrl+A/C/V · 滚轮缩放 · 空格平移 · 拖两侧圆点连线'
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
        empty.textContent = '空画布 — 双击空白新建节点，或点右上「编辑源码」写入 JSON Canvas'
        root.appendChild(empty)
        return root
      }
      // ComfyUI 结构：stage（定位锚）里 bg/fg 双 canvas 画一切图形，overlay 是**兄弟**层（只放编辑控件）。
      const stage = document.createElement('div')
      stage.className = 'wk-cv-stage'
      const bg = document.createElement('canvas')
      bg.className = 'wk-cv-canvas wk-cv-bg'
      const canvas = document.createElement('canvas')
      canvas.className = 'wk-cv-canvas wk-cv-fg'
      const overlay = document.createElement('div')
      overlay.className = 'wk-cv-overlay'
      stage.appendChild(bg)
      stage.appendChild(canvas)
      stage.appendChild(overlay)
      root.appendChild(stage)

      const gview = new WkCvGraphView(root, stage, canvas, overlay, view, this.text)
      gview.bgCanvas = bg
      gview.fgCanvas = canvas
      gview.setDirty(true, true)
      this._gview = gview

      // 画布块填满编辑区：CM6 block widget 默认按内容高度排版，而 stage 内只有绝对定位的 canvas，
      // 高度会塌到 min-height（200px）——取景按 200px 高算就没法看。这里以滚动容器可视高给 root
      // 定高（先写高度再读 stage 尺寸，读数强制回流，取景一次到位）。
      const syncHeight = () => {
        const sc = view.scrollDOM
        if (!sc) return
        // 已挂进文档时按「root 顶到滚动容器底」算，自动扣掉 .cm-content 的上下垫；
        // 尚未挂载（toDOM 阶段）先按容器可视高预留，挂载后的 RO 回调再修正。
        const h = root.isConnected
          ? Math.round(sc.getBoundingClientRect().bottom - root.getBoundingClientRect().top - 8)
          : Math.round(sc.clientHeight - 24)
        const px = Math.max(240, h) + 'px'
        if (root.style.height !== px) root.style.height = px
      }
      const layout = () => {
        syncHeight()
        wkCvDs.invalidateViewportSize()
        gview.fitIfNeeded() // 首次拿到真实尺寸时取景；同文件后续只同步视口
        gview.setDirty(true, true)
      }
      const ro = new ResizeObserver(layout)
      ro.observe(stage)
      if (view.scrollDOM) ro.observe(view.scrollDOM)
      layout()
      gview.ro = ro
      this._ro = ro
      return root
    }
    destroy() {
      if (this._gview) { this._gview.destroy(); this._gview = null }
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
  function wkCvExt(CM, hlStyle) {
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
    return [onField, decoField, CM.json(), CM.syntaxHighlighting(hlStyle)]
  }
