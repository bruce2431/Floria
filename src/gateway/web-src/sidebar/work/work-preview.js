// 右栏预览与工具页态：预览帧挂载 renderWorkPreview / 页态切换 setPvTab / 顶栏工具栏胶囊 + tab 条渲染。（拆自 sidebar/work.js，纯搬迁零行为变更；符号经单 IIFE 共享作用域可见）
/* @module sidebar/work/work-preview.js */

  // 预览帧是否需要在场（判定唯一处）：栏在场 且 无宿主 pane 工具遮挡。预览态与帧工具态都要帧在场
  // （帧工具的内容就活在帧里，见 applyPvTab 的 body 显隐规则）；宿主 pane 工具（评论）独占右栏、帧不必挂。
  // renderWorkPreview 的渲入门与 syncWorkExtCards 的补拉门（帧不在场才补拉）都以它为准。
  function wkFrameNeeded() {
    if (!state.wkPreview) return false
    const t = state.wkPvTab ? wkToolDef(state.wkPvTab) : null
    return !t || !t.pane
  }

  // 右栏 UI 落地（唯一处，纯渲染、不挂帧）：预览态 → 显 #wk-pv-body、隐 tab 条与全部工具 pane；
  // 工具态 → 隐预览帧、显 tab 条（active = state.wkPvTab）+ 该注册工具 pane（其余 pane 恒隐）。
  // 顶栏「工具栏」胶囊跟着走：预览态 = 「工具栏」+ 插件图标（点入工具态），工具态 = 「关闭」+ ✕
  // （点回预览态）。未注册的 wkPvTab（旧持久化值 / 工具被摘）落成「无 pane 在场」，切一次 tab 即归一。
  function applyPvTab() {
    const id = state.wkPvTab
    const tool = id ? wkToolDef(id) : null
    const bar = $('wk-pv-tabs')
    if (bar) bar.hidden = !tool
    document.querySelectorAll('#work-preview .wk-pv-tab').forEach((b) => b.classList.toggle('on', !!tool && b.dataset.wkpv === id))
    for (const t of wkToolDefs()) {
      const el = t.pane ? $(t.pane) : null
      if (el) el.hidden = !tool || t.id !== id
    }
    // 预览帧只在「无工具或宿主 pane 工具」工具态下让位：帧工具（无 pane）内容由预览页自管，
    // 预览帧必须留在场（否则帧被卸载 → 预览页内的面板也一起没了）。
    const body = $('wk-pv-body')
    if (body) body.hidden = !!tool && !!tool.pane
    const cap = $('wk-tb-tool')
    if (!cap) return
    cap.classList.toggle('on', !!tool)
    cap.title = tool ? '关闭' : '工具栏'
    const ico = cap.querySelector('.wk-tb-ico')
    if (ico) ico.innerHTML = tool ? I.dshClose : I.plug
    const nm = cap.querySelector('.wk-tb-name')
    if (nm) nm.textContent = tool ? '关闭' : '工具栏'
  }

  // 切右栏页态（唯一入口）：'' / 未注册 id → 预览态，已注册 id → 工具态。切到工具态顺带确保栏在场
  // （点 tab 就是要看这栏）。落地后补内容：工具态调该工具的 mount（注册表契约），预览态挂预览帧。
  function setPvTab(id) {
    state.wkPreview = true
    state.wkPvTab = wkToolNormId(id)
    applyPanes()
    syncPvContent()
    saveWork()
  }

  // 页态落地后的内容补挂（唯一处）：预览态 → renderWorkPreview（挂/复挂预览帧）；工具态 → 该工具
  // 的 mount（无 mount 的工具内容自管，由 pane 元素既有渲染链负责，如评论面板的 cmtLoad/cmtRender）。
  // 每次落地都把「当前帧工具选中 id」回传预览帧（帧工具内容归预览页自管）。
  function syncPvContent() {
    const tool = state.wkPvTab ? wkToolDef(state.wkPvTab) : null
    notifyFrame(tool && !tool.pane ? tool.id : '')
    if (tool) {
      if (tool.mount) tool.mount()
      return
    }
    renderWorkPreview()
  }

  // 宿主 → 预览帧：回传当前选中的帧工具 id（'' = 回到预览页默认态）。发给 work 右栏当前那枚
  // .preview-frame（Pj18 等预览页据此开/关自己的面板）。id 去重（同一选中不重复发）；帧不在场
  // 或 id 未变则跳过，帧重挂/重新申报后由 syncPvContent 再对齐。
  let wkFrameSentId = null
  function notifyFrame(id) {
    if (id === wkFrameSentId) return
    const f = wkFrame()
    if (!f || !f.contentWindow) return
    try { f.contentWindow.postMessage({ type: 'floria-wk-tool-select', id }, '*') } catch { /* 帧已销毁：动作无声丢弃 */ }
    wkFrameSentId = id
  }
  // work 右栏预览帧（唯一取处）：#wk-pv-body 内那枚 .preview-frame
  function wkFrame() {
    const body = $('wk-pv-body')
    return body ? body.querySelector('.preview-frame') : null
  }

  // 顶栏「工具栏」胶囊：预览态 → 切工具态（首枚注册工具，即评论）；工具态 → 「关闭」回预览态。
  function toggleToolbar() {
    if (state.wkPvTab) {
      state.wkPvTab = ''
      applyPanes()
      syncPvContent() // 回预览态：预览帧按需挂（同项目已挂则不重建）
      saveWork()
      return
    }
    setPvTab('comments')
  }

  // 预览帧挂载（唯一处）：内容渲染一律走 preview-card 的 mountPreview（与槽位预览卡同一份后端容器 /
  // 静态页 / 默认页三级链），本模块只决定「挂哪个项目的、什么时候挂」，不碰 iframe。
  function hasPreviewOf(label) {
    return wkProjGroups().some((g) => g.label === label && g.hasPreview)
  }
  function renderWorkPreview() {
    if (!wkFrameNeeded()) return // 宿主 pane 工具态 / 栏不在场：预览帧不渲染（切回时 syncPvContent 再调）
    const el = $('wk-pv-body')
    if (!el || !state.workProj) return
    const f = el.querySelector('.preview-frame')
    if (f && f.dataset.label === state.workProj) return // 同项目已挂：交给 mountPreview 的软重入，不重建
    clearWkFrameTools() // 帧换文档：上一份预览页申报的工具 tab 失效（不变量同 rail-ext）
    wkFrameSentId = null
    mountPreview(el, state.workProj, hasPreviewOf(state.workProj))
  }

  // 顶栏 tab 条（唯一渲染口）：[+] [聊天胶囊 × N] [文件名]。聊天胶囊 = 开放集 state.wkChats 一条一枚，
  // 命名用会话标题（空对话 = 「新对话」）；active = 当前路由命中项（wkActiveKey），与下沉区显示同源
  // （wkShownTab，点浮起后胶囊自然熄、文件 pill 亮）。文件 pill 不变。× 关 tab 由点击委托处理。
  function renderTopbar() {
    const box = $('wk-tb-tabs')
    if (!box) return
    if (state.sbMode !== 'work') { if (box.innerHTML) box.innerHTML = ''; return }
    const shown = wkShownTab()
    const active = wkActiveKey()
    const parts = []
    if (state.wkAssist) {
      for (const key of state.wkChats) {
        const name = esc(wkTabName(key))
        parts.push(`<button class="wk-tb-pill${shown === 'chat' && key === active ? ' on' : ''}" data-wkchat="${esc(key)}" title="${name}"><span class="wk-tb-name">${name}</span><span class="wk-tb-x" title="关闭">×</span></button>`)
      }
    }
    if (state.workFile) {
      const fname = esc(baseOf(state.workFile))
      parts.push(`<button class="wk-tb-pill${shown === 'file' ? ' on' : ''}" data-wktb="file" title="${fname}"><span class="wk-tb-ico">${I.dshFile}</span><span class="wk-tb-name">${fname}</span><span class="wk-tb-x" title="关闭">×</span></button>`)
    }
    const html = parts.join('')
    if (box.innerHTML !== html) box.innerHTML = html
  }

