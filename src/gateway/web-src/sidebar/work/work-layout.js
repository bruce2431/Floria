// 布局落地：模式切换 applySbMode / 侧栏开关锚定 / 聊天 tab 开集与关合 / 主区三列不变量 applyPanes。（拆自 sidebar/work.js，纯搬迁零行为变更；符号经单 IIFE 共享作用域可见）
/* @module sidebar/work/work-layout.js */

  // 面板与主区布局按 state 落地。启动恢复与运行期切换共用这一条路径（无第二份初始化旁路）。
  function applySbMode() {
    const on = state.sbMode === 'work'
    // 进 work：槽里若停着非会话卡（管理/预览），先退卡回会话视图——work 助手栏就是 #session-card，
    // 残留的 .view-card 会把助手栏顶成旧卡（「在预览页切到 work，助手栏还是预览页」的根因）。
    // 退卡走 route('#/') 统一收口（顺带清管理/预览路由态、预览页注册件与后端保活心跳），不在此另起清点。
    if (on && currentCardId() && currentCardId() !== 'session') navigate('#/')
    document.querySelectorAll('.ms-btn').forEach((b) => b.classList.toggle('on', b.dataset.sbmode === state.sbMode))
    positionMsThumb() // 选中钮换位 → 空位滑到另一侧（方向性 transition 由本函数写内联）
    // #panel.work：work 模式下隐藏顶栏 #panel-search（会话搜索的 chat 模式入口）——work 的 🔍 已覆盖
    // 当前 tab 的过滤，两者同为放大镜同屏并存即「两个搜索」的重复观感（样式见 styles.css 该段）
    $('panel').classList.toggle('work', on)
    // 模式色钩子（2026-10-06）：#app.work 一处驱动全部随模式切换的颜色（--sunken-bg 等，见 styles.css #app 注释）
    $('app').classList.toggle('work', on)
    $('chat-panel').hidden = on
    $('work-panel').hidden = !on
    chatArea.classList.toggle('work', on)
    applyPanes()
    enforceWorkScope() // 目标项目/只读标识随模式切换重算；开着别项目的会话时退回工作项目的新对话
    if (on) {
      applySidebarPin() // 进 work：侧栏开合按工作项目槽里的开关恢复（桌面）
      ensureWork()
      startWorkAuto()
    } else {
      if (wkEdDirty) wkEdFlush() // 退 work 模式：pending 编辑先落盘（不阻塞模式切换）
      hideWkPops()
      stopWorkAuto()
    }
  }

  // 浮层两开关的真源：预览 = 第三列（个性化工作区），侧边栏 = 侧栏是否**被主动打开**
  // （state.panelPinned，见 recent.js setPanel）。不用 state.panelOpen——后者含左缘悬停预览式唤出，
  // 那种瞬时露出不是「界面常在」，开关不该跟亮。
  function paneOn(k) {
    if (k === 'workspace') return state.wkPreview
    return !!state.panelPinned
  }

  // 视图浮层行状态落地（唯一处）：本模块 applyPanes 与 recent.js setPanel（钉住态可被汉堡/收起钮/
  // 遮罩任一处翻转）两处调用。
  function syncPaneRows() {
    document.querySelectorAll('.wkv-row').forEach((b) => b.classList.toggle('on', paneOn(b.dataset.wkpane)))
  }

  // 侧边栏开关的落地入口：真源始终是 state.panelPinned，而「让侧栏开合」的唯一口是 recent.js 的 setPanel
  // ——本函数只把它按项目槽里的值调一次（loadWorkPanes 已把槽写进 state）。移动端侧栏是全屏抽屉，恢复
  // 打开态会盖住主区，故不恢复（槽里的值照常存，切回桌面端仍按它开合）。
  function applySidebarPin() {
    if (isMobile()) return
    setPanel(!!state.panelPinned, { pin: !!state.panelPinned })
  }

  // 下沉区当前显示的内容（唯一判定）：助手靠栏时按 wkMainTab（要看文件且确有文件才给 file，
  // 否则回 chat）；助手脱流（float/slim）时它不在下沉格里 ⇒ 有文件顶上来、没有就空。'' = 下沉格空。
  function wkShownTab() {
    if (wkAssistInFlow()) return state.wkMainTab === 'file' && state.workFile ? 'file' : 'chat'
    return state.workFile ? 'file' : ''
  }

  // 打开的聊天 tab 开放集（浏览器 tab 模型）：真源 = state.wkChats。**纯运行时、不持久化、按项目重置**
  // （2026-10-07 用户定案）——切换工作项目即清空（见 selectProject），故他项目的会话胶囊绝不残留。
  // 条目 = 会话 hash 或 WK_NEW_TAB。激活键 = 当前路由（currentHash；空 = 首页 ⇒ 'new'）。
  // 增/删/渲染的唯一口都在本模块。
  const wkActiveKey = () => state.currentHash || WK_NEW_TAB
  const wkKeyHash = (key) => (key === WK_NEW_TAB ? '' : key)
  const wkTabName = (key) => {
    if (key === WK_NEW_TAB) return '新对话'
    const s = findSession(key)
    return (s && s.title) || '未命名会话'
  }
  function wkEnsureTab(key) { if (!state.wkChats.includes(key)) state.wkChats.push(key) }
  // 关一枚 tab（× 只从顶栏移除，不删会话）。激活项被关 → 切右邻 / 左邻；一枚不剩且文件 tab 与预览
  // 都不在场 → 保底重开空对话 tab（守「聊天 / 文件 / 预览至少一栏在场」不变量）。
  function wkCloseTab(key) {
    const i = state.wkChats.indexOf(key)
    if (i < 0) return
    const active = wkActiveKey() === key
    state.wkChats.splice(i, 1)
    if (!active) { applyPanes(); saveWork(); return }
    const next = state.wkChats[i] != null ? state.wkChats[i] : state.wkChats[i - 1]
    if (next != null) {
      navigate(next === WK_NEW_TAB ? '#/' : '#/' + encodeURIComponent(next))
      applyPanes(); saveWork(); return
    }
    state.wkAssist = false // 聊天 tab 全关：收起聊天栏（文件 / 预览还在即可）
    if (state.sbMode === 'work' && !state.workFile && !state.wkPreview) {
      state.wkAssist = true
      wkEnsureTab(WK_NEW_TAB)
      navigate('#/')
    }
    applyPanes(); saveWork()
  }
  // 路由落地后并入开放集并重渲顶栏（唯一外部入口，chat/route.js 调）：仅 work + 聊天栏在场时插手。
  // 新会话窗口被替换（2026-10-06 用户定案）：在空对话 tab（新会话窗口）下从侧栏打开具体会话，
  // 直接顶掉占位 new tab（新会话窗口即被该会话替换），顶栏不留单独的「新对话」胶囊。
  // 只在「上一次激活 = new、本次激活 = 具体会话」时替换——后台挂着的 new tab（当前不在其上）不受影响。
  function syncWorkTabs() {
    const key = wkActiveKey()
    if (state.sbMode !== 'work' || !state.wkAssist) { wkPrevActiveKey = key; return }
    if (key !== WK_NEW_TAB && wkPrevActiveKey === WK_NEW_TAB) {
      const i = state.wkChats.indexOf(WK_NEW_TAB)
      if (i >= 0) state.wkChats.splice(i, 1)
    }
    wkEnsureTab(key)
    wkPrevActiveKey = key
    renderTopbar()
    // 2026-10-06 根修「work 侧栏选中灰底更新慢」：可见的会话列表在 #wk-body（renderWorkBody 渲），
    // 不在 route()/SSE 的重渲出口里（refreshList 只渲 #recent-body）。路由落地若不重渲它，行上的
    // .on（按 currentHash 判，见 recent.js itemHtml）要等 workAutoTick 的 5s 对账才同步 → 切会话后
    // 选中灰底滞后 1~2s 才跟手。此处随路由同步重渲一次：renderWorkBody 内有 innerHTML 比对，
    // 未变零写 DOM，故代价可忽略，且保证 .on 与 currentHash 恒同拍。
    renderWorkBody()
  }

  // 布局落地（不变量判定唯一处 + 各布局类的唯一写口）：聊天 tab / 文件 tab / 预览至少一个在场，
  // 全无 → 强制开助手（聊天 tab，唯一还能承载内容的常驻件）。判定仍是这一处。
  function applyPanes() {
    if (state.sbMode === 'work') {
      if (!state.wkAssist && !state.workFile && !state.wkPreview) {
        state.wkAssist = true
        state.wkMainTab = 'chat'
        toast('至少保留一栏')
      }
      if (state.wkAssist) wkEnsureTab(wkActiveKey()) // 聊天栏在场 ⇒ 当前路由对应的 tab 必在开放集
      const shown = wkShownTab()
      chatArea.classList.toggle('wk-show-chat', shown === 'chat')
      chatArea.classList.toggle('wk-show-file', shown === 'file')
      chatArea.classList.toggle('wk-preview', !!state.wkPreview)
    } else {
      chatArea.classList.remove('wk-show-chat', 'wk-show-file', 'wk-preview')
    }
    syncPaneRows()
    applyWorkCols()
    renderTopbar()
    applyPvTab()
  }
