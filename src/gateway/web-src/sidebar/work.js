// work 模式侧栏 + 主区编辑区（2026-09-25，参考 Prism）（唯一手改处，web/app.js 为生成物）

import { navigate } from '../chat/route.js'
import { needToken, apiUrl } from '../engine/gateway.js'
import { I } from '../core/icons.js'
import { mdHtml } from '../core/markdown.js'
import { ALL, chatArea, sessionCard, state } from '../engine/state.js'
import { esc, isMobile, toast } from '../core/util.js'
import { loadWork, loadWorkPanes, saveWork, stashWorkPanes } from '../core/storage.js'
import { loadSessions, sessCmp, findSession } from '../engine/sessions.js'
import { currentCardId, hydrateExtCards } from '../views/registry.js'
import { itemHtml, openRenameDialog, registerRowMenu, reliftRowMenu, setPanel } from './recent.js'
import { cmtInvalidate, cmtLoad, cmtMount, cmtRangesFor, cmtRender, cmtSetHooks } from './comments.js'
import { renderProjSeat } from '../inputbar/commands.js'
import { mountPreview, syncExtCards } from '../views/cards/preview/preview-card.js'
/* @module sidebar/work.js */
  // ---------- work 模式侧栏（Prism 式） ----------
  // 状态源 = engine/state.js 的 sbMode / projects / workspace / workProj / workFile / wkMainTab / wkAssist /
  // wkPreview / wkPrevW（localStorage floria-ui-v1 持久化，见 saveWork/loadWork）。视图浮层两开关
  // （预览 / 侧边栏）按项目分槽存 state.wkPanes，切项目时由 stashWorkPanes / loadWorkPanes 换槽。
  // 数据源全部是现成端点，本模块零后端改动：
  //   项目列表 → /gateway/sessions 的 groups（sessions.js 顺带存进 state.projects）
  //   文件树   → GET /gateway/project?label=  的 files（walkProjectTree，深度 3 / 每层 50）
  //   单文件   → GET /gateway/file?label=&path=（只读原始字节，带路径穿越防护 + 4MB 上限）
  // 主区：sbMode=work → #chat-area 加 .work（CSS Grid 三列 = 下沉区 | 分界条 | 预览列）。下沉区顶部一条
  // .wk-topbar tab 顶栏（[+] [聊天胶囊×N] [文件名]）：聊天胶囊 = 开放集 state.wkChats 一会话一枚（命名
  // = 会话标题，× 关掉），文件 tab 一枚；同一时刻只显一个内容（#session-card = 聊天 / #work-editor =
  // 文件）；预览列常驻最右（开关只控显隐）。不变量 = 聊天 / 文件 / 预览 **至少一栏在场**，唯一判定点
  // applyPanes。与「管理/预览卡」互斥：route.js 进 mgr/preview 时 setSbMode('chat')。

  const IMG_EXT = /\.(png|jpe?g|webp|gif|svg|bmp|ico|avif)$/i
  const MD_EXT = /\.(md|markdown)$/i
  const WK_SAVE_MS = 1000 // 编辑区自动保存去抖（停止输入后多久落盘）
  const WK_NEW_TAB = 'new' // 空对话 / 首页（currentHash ''）的哨兵 tab 键；真源 state.wkChats 用字符串承载
  let wkPrevActiveKey = null // 上一次路由激活的 tab 键（判别「从空对话 tab 打开具体会话」见 syncWorkTabs）
  let wkTab = 'files'      // 'files' | 'chat'
  let wkTree = null        // 当前项目文件树（/gateway/project 的 files）；null = 未加载
  let wkFilter = ''        // 文件过滤词（前端过滤，不重拉）
  let wkLoading = false
  let wkErr = ''
  const wkOpen = new Set() // 已展开目录（项目内相对路径）
  let edSeq = 0            // 编辑区读取序号：快速连点文件时丢弃迟到的旧响应

  function setSbMode(mode) {
    state.sbMode = mode === 'work' ? 'work' : 'chat'
    applySbMode()
    saveWork()
  }

  // work 模式不变量（唯一判定点）：助手栏只显示工作项目的会话——当前打开的是别的项目/全局会话时，
  // 回该项目的「新对话」空态（新会话的目标项目由 engine/state.js newSessionProject 收口，seat 只读）。
  // 调用点 = 进入 work 模式 / 切换工作项目 / 路由渲染会话前（chat/route.js renderSession）。
  // 会话尚未落地（findSession 查无 = 列表未拉或刷新中）时不判——「未知」不等于「别的项目」。
  function workScopeOk(hash) {
    if (state.sbMode !== 'work' || !state.workProj || !hash) return true
    const s = findSession(hash)
    return !s || (s.projectScope === 'project' && s.projectLabel === state.workProj)
  }
  function enforceWorkScope() {
    if (!workScopeOk(state.currentHash)) navigate('#/')
    renderProjSeat()
  }

  // 模式 tab「空位」定位（唯一处）：把当前 .ms-btn 的矩形以 left/right 内衬写进 .ms-thumb
  // （.mode-switch 是 position:relative，即两钮的 offsetParent，量值可直接用）。
  // 侧栏折叠态下 #panel 虽 width:0，但 .panel-inner 仍持 --panel-w 宽、按钮尺寸不变（只是被 overflow
  // 裁掉），故任何时刻量都有效，无需等侧栏展开再定位。字体异步到位会改字宽 ⇒ 由 mountWork 在
  // document.fonts.ready 后重量一次（那次不带变形动画）。
  // 切换 = 空位「变形 + 位移」（2026-10-06 用户定案）：用 left/right 两个内衬而不是 left/width——
  // 前缘（移动方向上的那条边）给短时长先到、后缘给长时长后到，中途两缘一快一慢 ⇒ 空位被拉长，
  // 到位后收回成目标钮的形状；这就是「变形位移」的读数。方向性 transition 在此按方向写内联。
  // 非切换的定位（初始化 / resize / 字体到位）一律 transition:none —— 否则首帧会播一次滑动。
  // 空位归属（2026-10-06 二轮定案）：**落在非当前模式那侧**——处于的模式在卡片上（.ms-btn.on 回
  // 卡面色），凹下去的那块给另一个模式。位置取 .ms-btn:not(.on)。
  const MS_FAST = '0.16s cubic-bezier(0.2, 0.8, 0.3, 1)'
  const MS_SLOW = '0.30s cubic-bezier(0.3, 1.04, 0.5, 1)'
  let msAtFirst = null // 上一次空位停在哪一侧（null = 尚未定位）
  function positionMsThumb() {
    const sw = $('mode-switch')
    const th = sw && sw.querySelector('.ms-thumb')
    const btns = sw && sw.querySelectorAll('.ms-btn')
    const btn = sw && sw.querySelector('.ms-btn:not(.on)')
    if (!th || !btn || !btns || btns.length < 2) return
    const first = btn === btns[0]
    const moved = msAtFirst !== null && msAtFirst !== first
    if (moved) {
      // 去左侧：前缘 = 左缘 ⇒ left 快、right 慢；去右侧：前缘 = 右缘 ⇒ right 快、left 慢
      th.style.transition = first
        ? `left ${MS_FAST}, right ${MS_SLOW}`
        : `right ${MS_FAST}, left ${MS_SLOW}`
    } else {
      th.style.transition = 'none'
    }
    th.style.left = btn.offsetLeft + 'px'
    th.style.right = sw.clientWidth - btn.offsetLeft - btn.offsetWidth + 'px'
    msAtFirst = first
  }

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

  // 打开的聊天 tab 开放集（浏览器 tab 模型）：真源 = state.wkChats，条目 = 会话 hash 或 WK_NEW_TAB。
  // 激活键 = 当前路由（currentHash；空 = 首页 ⇒ 'new'）。增/删/渲染的唯一口都在本模块。
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

  // 右栏（#work-preview）tab 落地（唯一处）：'preview'（预览帧）/ 'comments'（评论面板）互斥显隐。
  // 状态源 = state.wkPvTab（persist）；预览帧的**挂载**由 renderWorkPreview 负责，本函数只管 tab UI 与
  // 面板显隐。胶囊（#wk-tb-comment）的 active 态也在此同步。
  function applyPvTab() {
    const on = state.wkPvTab === 'comments'
    const pv = $('work-preview')
    if (pv) {
      pv.classList.toggle('pv-comments', on)
      pv.querySelectorAll('.wk-pv-tab').forEach((b) => b.classList.toggle('on', (b.dataset.wkpv === 'comments') === on))
    }
    const body = $('wk-pv-body')
    if (body) body.hidden = on
    const cm = $('wk-cmt')
    if (cm) cm.hidden = !on
    const cap = $('wk-tb-comment')
    if (cap) cap.classList.toggle('on', on)
  }

  // 切 tab（唯一入口）：预览 tab → 挂预览帧；评论 tab → 拉/渲评论面板。saveWork 持久化。
  function setPvTab(tab) {
    state.wkPvTab = tab === 'comments' ? 'comments' : 'preview'
    applyPvTab()
    if (state.wkPvTab === 'preview') renderWorkPreview()
    else {
      cmtLoad(state.workProj)
      cmtRender()
    }
    saveWork()
  }

  // 顶栏「评论」胶囊：点开右栏并切到评论 tab；已在评论 tab 时再点 → 回预览 tab（不关右栏）。
  function toggleComments() {
    const back = state.wkPreview && state.wkPvTab === 'comments'
    state.wkPreview = true // 胶囊点击恒确保右栏在场（未开则开）
    state.wkPvTab = back ? 'preview' : 'comments'
    applyPanes() // 右栏在场落地（列宽 + tab 渲染 + applyPvTab）
    setPvTab(state.wkPvTab)
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

  // ---------- 主区列宽（分界条拖拽，参考 Pj18 preview 的 #divider）----------
  // 只剩一条分界条：下沉区 ↔ 预览列。列宽真源 = state.wkPrevW（预览列 px，写进 CSS 变量 --wk-pw 落 grid）。
  // 分界条显隐 = 预览在场（.wk-preview 类由 applyPanes 落，CSS 同步收窄成单列模板）。
  function applyWorkCols() {
    const on = state.sbMode === 'work'
    document.querySelectorAll('#chat-area > .work-gutter').forEach((g) => g.classList.toggle('on', on && !!state.wkPreview))
    if (on) chatArea.style.setProperty('--wk-pw', state.wkPrevW + 'px')
    else chatArea.style.removeProperty('--wk-pw')
    applyAssistMode() // 列宽/显隐变了 → 悬浮卡跟着重锚（分界条拖拽、开关栏、切模式都经这里）
  }

  // 拖动分界条：只改预览列宽（条往左拉 = 预览变宽），左侧下沉区自适应吃掉余量。
  // 地板 WK_PREV_MIN；上限 = 主区宽的 70%（拖不出一屏只剩预览）。
  const WK_PREV_MIN = 260
  const WK_PREV_MAX_RATIO = 0.7
  function bindGutter(g) {
    g.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      const prev = $('work-preview')
      const main = chatArea.getBoundingClientRect()
      if (!prev || main.width <= 0) return
      const right = prev.getBoundingClientRect().right
      const maxW = Math.max(WK_PREV_MIN, Math.round(main.width * WK_PREV_MAX_RATIO))
      g.setPointerCapture(e.pointerId)
      g.classList.add('dragging')
      document.body.classList.add('wk-resizing')
      e.preventDefault()
      const move = (ev) => {
        state.wkPrevW = Math.max(WK_PREV_MIN, Math.min(maxW, Math.round(right - ev.clientX)))
        applyWorkCols()
      }
      g.addEventListener('pointermove', move)
      const done = () => {
        g.removeEventListener('pointermove', move)
        g.classList.remove('dragging')
        document.body.classList.remove('wk-resizing')
        saveWork()
      }
      g.addEventListener('pointerup', done, { once: true })
      g.addEventListener('pointercancel', done, { once: true })
    })
  }


  // ---------- 助手三态（2026-09-27，与 Pj18 preview 的三态助手对齐） ----------
  // 同一张 #session-card 的三个形态：'side'（靠栏 = 聊天 tab 的内容，占下沉格）/ 'float'（悬浮卡，脱流不占格）/
  // 'slim'（收敛成底部输入栏）。形态类落在卡上（.wk-assist-float / .wk-assist-slim），可见性与几何的
  // 静态部分全由 CSS 给（web/styles.css「助手三态」段），本模块只写类 + 内联定位。
  // **绝不 reparent**：卡里挂着 engine/state.js 模块级 const 引用的 messagesEl / inputWrap / charEl 单例，
  // 搬 DOM 会丢消息流与输入草稿（Pj18 #chat-pane 的同款约束）。
  // 锚点 = 当前可见的下沉内容栏（文件 tab 的 #work-editor）→ 整个 #chat-area；预览列固定最右不参与。
  // 坐标一律在 #chat-area 局部系算：#app 在键盘态被 transform（body.kb-open），position:fixed 的视口
  // 坐标会整体漂走，故用 absolute + #chat-area（position:relative）作包含块，左右上下全数相减。
  const WK_ASSIST_PAD = 8      // 浮卡/输入栏与锚栏左右各留的白
  const WK_ASSIST_BOT = 24     // 距主区底部的距离（浮卡写 top、输入栏写 bottom，两态共用这一个值）
  // 正常底栏（#input-wrap.docked）在会话卡内的底距：top: calc(100% - 22px) —— 收敛输入栏要与它
  // 落在同一处，故停在「卡片底边 −22px」= 浮卡的 WK_ASSIST_BOT 再让出这 22px。两处数值同源，
  // 改一边必须改另一边（probe-work-scope F3c 锁这条耦合）。
  const WK_INPUT_BOT = 22
  const WK_ASSIST_MIN_W = 240
  const WK_ASSIST_MIN_H = 200
  const WK_ASSIST_MAX_VH = 0.7 // 高度上限 = 视口 70%（窄屏/横屏时浮卡不顶满）
  const WK_DRAG_SLOP = 3       // 位移 ≤3px 不算拖拽（区分点按与拖动）

  function wkAssistMode() {
    return state.wkAssistMode === 'float' || state.wkAssistMode === 'slim' ? state.wkAssistMode : 'side'
  }
  // in-flow = 助手是否占着下沉格（靠栏且开着）。wkShownTab 判定、三态几何两处共用这一条判据。
  function wkAssistInFlow() {
    return !!state.wkAssist && wkAssistMode() === 'side'
  }
  function wkAssistBase() {
    const b = chatArea.getBoundingClientRect()
    return b.width > 0 ? b : null
  }
  // 锚点 = 当前可见的下沉内容栏（文件 tab 的 #work-editor）→ 整个 #chat-area。预览列固定最右、
  // 不再作锚（浮卡不会压到它）；#work-editor 仅在文件 tab 正在显示时有宽（够宽才算「正在看的栏」）。
  function wkAssistAnchor() {
    const el = $('work-editor')
    if (el) {
      const r = el.getBoundingClientRect()
      if (r.width > 120) return r
    }
    return wkAssistBase()
  }
  function wkAssistW(a) {
    return Math.max(WK_ASSIST_MIN_W, Math.round(a.width - WK_ASSIST_PAD * 2))
  }
  function wkAssistH() {
    const max = Math.round(window.innerHeight * WK_ASSIST_MAX_VH)
    return Math.max(WK_ASSIST_MIN_H, Math.min(state.wkAssistH || 430, max))
  }
  function wkClearAssistBox() {
    for (const p of ['position', 'left', 'top', 'bottom', 'width', 'height']) sessionCard.style.removeProperty(p)
  }
  // 两态共用的横向公式：宽 = 锚栏宽 − 2×留白，左缘 = 锚栏左缘 + 剩余留白的一半（水平居中于锚栏）。
  // **一律写左缘、不写中线**：CSS 里没有 translateX(-50%) 之类的自居中，横向只有一个写口（本函数），
  // 中线公式 + CSS 自居中会在改宽度时双重位移（2026-09-27 实报「折叠形态定位有问题」的根因）。
  function wkPlaceAssistBox(a, w, base) {
    sessionCard.style.position = 'absolute'
    sessionCard.style.width = w + 'px'
    sessionCard.style.left = Math.round(a.left - base.left + (a.width - w) / 2) + 'px'
  }
  // 空态「底栏不压卡边界」的缺口（返 0 = 已达标或非空态）。不变量：空态底栏（#empty-hint #input-wrap，
  // 锚在立绘台上、中心锚——用户保护项，绝不可动）的底边距卡底边 ≥ WK_INPUT_BOT（与正常底栏 .docked
  // 在卡内的内缩同源，都是「底栏离卡底边 22px」）。台面在卡内垂直居中 ⇒ 卡高 h 时该底距 = h/2 − 常量
  // （常量 = 台面高×0.2675 + 底栏高/2，只由台面与底栏尺寸决定）：h = 430 时该值为负 ⇒ 底栏下沿被卡边界
  // 裁掉（2026-09-27 实报「低栏和卡片边界都挨上了」）。补法只能是**加高卡**（底栏与立绘同步上移，二者
  // 相对位置不变）：底距随卡高以 1/2 变化 ⇒ 加高量 = 2×缺口；卡底边锚在主区底部不动 ⇒ 卡向上长。
  function wkFloatEmptyDeficit() {
    const bar = document.querySelector('#empty-hint #input-wrap')
    if (!bar) return 0
    const br = bar.getBoundingClientRect()
    if (!br.width) return 0 // 门后 / 非空态：无盒，不参与
    return WK_INPUT_BOT - (sessionCard.getBoundingClientRect().bottom - br.bottom)
  }
  // 悬浮卡：定宽（锚栏宽 − 2×留白）、定高（state.wkAssistH，收在 70vh 内），水平居中于锚栏、贴主区底部。
  // 落位两拍：先按用户高放，量出空态缺口再补高（非空态缺口恒 0，只放一拍）——量算放在落位之后，是因为
  // 缺口只能从已落位的几何上量得。补高量不写回 state.wkAssistH（用户值不被改写；把手拖动的起点读的是
  // 实际渲染高，故拖一下即把当前高收进用户值，缺口随之归零，不来回弹）。
  function wkPlaceAssistFloat() {
    const base = wkAssistBase()
    const a = wkAssistAnchor()
    if (!base || !a) return
    wkPlaceAssistBox(a, wkAssistW(a), base)
    const put = (h) => {
      sessionCard.style.height = h + 'px'
      sessionCard.style.top = Math.round(base.height - h - WK_ASSIST_BOT) + 'px'
      sessionCard.style.removeProperty('bottom')
    }
    put(wkAssistH())
    const d = wkFloatEmptyDeficit()
    if (d > 0.5) {
      const max = Math.round(window.innerHeight * WK_ASSIST_MAX_VH)
      put(Math.min(wkAssistH() + 2 * d, Math.max(max, WK_ASSIST_MIN_H)))
    }
  }
  // 收敛输入栏：宽与左缘同浮卡，高度由 pill 内容给（清掉内联 height）。底距 = 浮卡底距 + 正常底栏
  // 在卡内的 22px 内缩 ⇒ pill 底边与 #input-wrap.docked 的底边齐平（都停在卡片底边上方 22px，
  // 2026-09-27 用户实报「两个底栏到卡片下边界的距离不一样」）。
  function wkPlaceAssistSlim() {
    const base = wkAssistBase()
    const a = wkAssistAnchor()
    if (!base || !a) return
    wkPlaceAssistBox(a, wkAssistW(a), base)
    sessionCard.style.bottom = WK_ASSIST_BOT + WK_INPUT_BOT + 'px'
    sessionCard.style.removeProperty('height')
    sessionCard.style.removeProperty('top')
  }
  // 三态唯一写口：形态类 + 几何一把落。side（或非 work / 助手关着）清掉全部内联几何，回到 CSS 的普通栏。
  function applyAssistMode() {
    const on = state.sbMode === 'work' && !!state.wkAssist
    const m = wkAssistMode()
    sessionCard.classList.toggle('wk-assist-float', on && m === 'float')
    sessionCard.classList.toggle('wk-assist-slim', on && m === 'slim')
    if (!on || m === 'side') {
      wkClearAssistBox()
      return
    }
    if (m === 'float') wkPlaceAssistFloat()
    else wkPlaceAssistSlim()
  }
  // 重锚：主区尺寸 / 栏宽 / 显隐变化时（分界条拖拽、侧栏开合、窗口缩放、开关栏）由 ResizeObserver 触发。
  function wkReflowAssist() {
    if (state.sbMode !== 'work' || !state.wkAssist || wkAssistMode() === 'side') return
    applyAssistMode()
  }
  // 形态切换入口（头部工具条 / 收敛输入栏的 pill 都走这里）。切形态 = 明确要用助手：顺手把它打开
  // （关着的卡切形态无意义，用户看不到任何反馈）。
  function setAssistMode(m) {
    state.wkAssistMode = m === 'float' || m === 'slim' ? m : 'side'
    state.wkAssist = true
    applyPanes()
    saveWork()
  }

  // 悬浮卡加高把手：只调高（宽由锚栏给定），触屏必须能用 → pointer events + setPointerCapture。
  // 收尾三规矩照抄 Pj18（都是真踩过的坑）：① 只认主键且位移 >3px 才算拖；② 收尾看 ev.buttons 而不只等
  // pointerup（up 若落在内嵌内容/窗口外，状态会永久卡死，之后指针一动高度就跟着走）；③ 拖拽期给 body 挂
  // wk-assist-dragging，关掉内嵌内容的 pointer-events（拖过 #work-preview 的 iframe 时事件仍全归把手）。
  function bindAssistGrip() {
    const g = $('wk-assist-grip')
    if (!g) return
    g.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      const base = wkAssistBase()
      if (!base) return
      const y0 = e.clientY
      const startH = sessionCard.getBoundingClientRect().height || state.wkAssistH || 430
      let dragging = false
      g.setPointerCapture(e.pointerId)
      e.preventDefault()
      const end = () => {
        g.removeEventListener('pointermove', move)
        g.removeEventListener('pointerup', end)
        g.removeEventListener('pointercancel', end)
        if (!dragging) return
        document.body.classList.remove('wk-assist-dragging')
        saveWork()
      }
      const move = (ev) => {
        if (!ev.buttons) { end(); return } // ② 主键已松（up 落在内嵌内容/窗口外也走这里收尾）
        if (!dragging) {
          if (Math.abs(ev.clientY - y0) <= WK_DRAG_SLOP) return // ① 位移太小不算拖
          dragging = true
          document.body.classList.add('wk-assist-dragging') // ③ 拖拽期关掉内嵌内容 pointer-events
        }
        const max = Math.round(window.innerHeight * WK_ASSIST_MAX_VH)
        state.wkAssistH = Math.round(Math.max(WK_ASSIST_MIN_H, Math.min(max, startH + (ev.clientY - y0))))
        wkPlaceAssistFloat()
      }
      g.addEventListener('pointermove', move)
      g.addEventListener('pointerup', end)
      g.addEventListener('pointercancel', end)
    })
  }

  // ---------- 个性化工作区（第三栏：项目预览） ----------
  // 内容渲染一律走 mgr.js 的 mountPreview（与槽位预览卡同一份后端容器/静态页/默认页三级链），
  // 本模块只决定「挂哪个项目的、什么时候挂」，不碰 iframe。
  function hasPreviewOf(label) {
    return wkProjGroups().some((g) => g.label === label && g.hasPreview)
  }
  function renderWorkPreview() {
    if (state.wkPvTab !== 'preview') return // 评论 tab 在场：预览帧不渲染（切回预览 tab 时 setPvTab 会再调）
    const el = $('wk-pv-body')
    if (!el || !state.wkPreview || !state.workProj) return
    const f = el.querySelector('.preview-frame')
    if (f && f.dataset.label === state.workProj) return // 同项目已挂：交给 mountPreview 的软重入，不重建
    mountPreview(el, state.workProj, hasPreviewOf(state.workProj))
  }
  // 外部卡申报的补拉口（与 ensureWork 的树/编辑区补拉同源）：预览栏开着时由 renderWorkPreview →
  // mountPreview → syncExtCards 拉；关着时在此补齐——否则刷新后外部卡 tab 缺失、/manage/ext:…
  // 直进无卡可解析（EXT 是内存表，只落缓存不落盘的话两者都靠「先开一次预览」）。
  function syncWorkExtCards() {
    if (state.workProj && !state.wkPreview) syncExtCards(state.workProj)
  }

  function hideWkPops() {
    for (const id of ['wk-proj-pop', 'wk-view-pop', 'wk-new-pop']) {
      const el = $(id)
      if (el) el.hidden = true
    }
  }

  function setPane(k, on) {
    if (k === 'sidebar') {
      // 侧栏开合不走「至少保留一栏」判定——那是主区内容的约束，与侧栏无关。
      // pin = 主动打开，鼠标移出侧栏不自动收（悬停预览式收起只属左缘唤出）。行状态真源见 paneOn。
      setPanel(on, { pin: on })
      applyPanes()
      saveWork() // 两开关之一：归档进工作项目的槽
      return
    }
    if (k === 'workspace') {
      state.wkPreview = on
      applyPanes()
      saveWork()
      // 开：当前 tab 为预览则挂预览帧，为评论则拉/渲评论面板；关：停在这里（帧留着，CSS 隐藏），重开零重载
      if (on && state.wkPvTab === 'comments') {
        cmtLoad(state.workProj)
        cmtRender()
      } else renderWorkPreview()
      return
    }
    // 助手开关（浮层已不含助手行；只剩助手头部的 × 走到这里）：关掉后若下沉格再没有别的可显，
    // 由 applyPanes 的不变量兜底（强制留一栏 + toast）。
    if (k === 'assist') {
      state.wkAssist = on
      applyPanes()
      saveWork()
    }
  }

  // ---------- 侧栏渲染 ----------
  // 名字必须全局唯一：全部 web-src 模块体拼进同一个 IIFE 作用域，顶层同名声明会静默互相覆盖。
  // 原取名 `projList` 与 inputbar/commands.js 的同名函数撞车（后者在后 ⇒ 覆盖本函数），
  // 本函数返回 group 对象数组、后者返回 label 字符串数组 ⇒ 下拉渲染出 7 行空按钮。
  // 由 `probes/probe-web-module-scope.ts` 看住这条不变量。
  function wkProjGroups() {
    return (state.projects || []).filter((g) => g && g.scope === 'project' && g.label)
  }

  // 项目名 + 底部卡 + 下拉内容 = 同一份 state.projects 的同一次渲染（2026-09-25 修）。
  // 此前下拉内容由 renderWorkProjects 单独在「点开那一刻」渲染一次，而项目列表是 ensureWork 里
  // await loadSessions() 异步落地的——切到 work 后立刻点开就会渲染出 0 项，此后列表到了也不再更新
  // （底部卡显示「7 个项目」、下拉却是空的，就是这个错位）。合并为一条渲染路径后无处可漂移。
  function renderWorkChrome() {
    const lab = document.querySelector('#wk-proj-seat .wk-proj-label')
    if (lab) lab.textContent = state.workProj || '选择项目'
    const ft = $('wk-foot-text')
    if (ft) {
      const n = wkProjGroups().length
      ft.textContent = `${state.workProj || 'Floria'} · ${n} 个项目`
    }
    const seat = $('wk-proj-seat')
    if (seat) seat.classList.toggle('empty', !state.workProj)
    renderWorkProjects()
  }

  function renderWorkProjects() {
    const box = $('wk-proj-pop')
    if (!box) return
    const ps = wkProjGroups()
    box.innerHTML = ps.length
      ? ps
          .map(
            (g) =>
              `<button class="wkp-row${g.label === state.workProj ? ' on' : ''}" data-wkproj="${esc(g.label)}">` +
              `<span class="wkp-name">${esc(g.label)}</span>` +
              `<span class="wkp-tag">${g.hasPreview ? '预览' : ''}</span></button>`,
          )
          .join('')
      : '<div class="wk-empty">未发现项目，点 ⟳ 重试</div>'
  }

  // tab 行工具区：加号只在聊天 tab 出现（新建聊天）；🔍 的提示词随 tab 走——过滤对象不同，
  // 写死「过滤文件」会在聊天 tab 里给出错位提示（与 #panel-search 的「两个搜索」定案同源）。
  // 文件 tab 的加号（新建文件/文件夹）待新建写接口定案后接入，届时同一按钮按 tab 分派。
  function updateWkTools() {
    const nb = $('wk-new')
    const isChat = wkTab === 'chat'
    if (nb) nb.title = isChat ? '新建聊天' : '新建文件'
    const pop = $('wk-new-pop')
    if (pop && isChat) pop.hidden = true // 文件菜单只在文件 tab 有意义，切走即收
    const fb = $('wk-find')
    if (fb) fb.title = isChat ? '过滤聊天' : '过滤文件'
    const fi = $('wk-find-input')
    if (fi) fi.placeholder = isChat ? '过滤聊天…' : '过滤文件…'
  }

  // 侧栏体的唯一渲染出口：HTML 全量算好再比对写入。比对是自动对账的必要条件——每 5s 一次无脑重写
  // innerHTML 会让文件树的滚动位置与展开动画反复归零（内容没变就没有重写的理由）。
  function renderWorkBody() {
    const body = $('wk-body')
    if (!body) return
    updateWkTools()
    const html = wkBodyHtml()
    if (body.innerHTML !== html) {
      body.innerHTML = html
      // 重渲换掉了行节点：长按浮窗若开着，按行标识把新节点重新扶起（浮窗本身挂在 body 下不受影响）
      reliftRowMenu()
    }
  }

  function wkBodyHtml() {
    if (wkTab === 'chat') {
      // 列表 = 当前项目下的会话，条目渲染复用 recent.js 的 itemHtml（与侧栏「项目展开」同一份实现，
      // 不另写一套行）；行操作浮窗（右键 / 长按）走 recent.js 的 document 级委托，此处无需接线。
      const f = wkFilter.trim().toLowerCase()
      const list = state.workProj
        ? ALL.filter((s) => s.projectScope === 'project' && s.projectLabel === state.workProj)
            .sort(sessCmp)
            .filter((s) => !f || String(s.title || '').toLowerCase().includes(f))
        : []
      const rows = !state.workProj
        ? '<div class="wk-empty">先在上方选择一个项目</div>'
        : list.length
          ? `<div class="wk-chats">${list.map((s) => itemHtml(s, false)).join('')}</div>`
          : `<div class="wk-empty">${f ? '没有匹配的聊天' : '该项目还没有聊天'}</div>`
      // 新建入口 = tab 行工具区的加号（updateWkTools 控制显隐），列表顶部不再占一行大按钮
      return rows
    }
    if (!state.workProj) return '<div class="wk-empty">先在上方选择一个项目</div>'
    if (wkLoading) return '<div class="wk-empty">加载中…</div>'
    if (wkErr) return `<div class="wk-empty">${esc(wkErr)}</div>`
    if (!wkTree || !wkTree.length) return '<div class="wk-empty">项目内没有可列出的文件</div>'
    const f = wkFilter.trim().toLowerCase()
    return wkTreeHtml(wkTree, 0, '', f) || '<div class="wk-empty">没有匹配的文件</div>'
  }

  // 目录命中判定：过滤词命中自身或任一子孙即保留（否则目录被过滤掉，里面的命中项也没了）
  function wkNodeHit(n, f) {
    if (!f) return true
    if (String(n.name).toLowerCase().includes(f)) return true
    return (n.children || []).some((c) => wkNodeHit(c, f))
  }

  function wkTreeHtml(nodes, depth, prefix, f) {
    let h = ''
    for (const n of nodes || []) {
      if (!wkNodeHit(n, f)) continue
      const p = prefix ? `${prefix}/${n.name}` : n.name
      const pad = `padding-left:${8 + depth * 13}px`
      if (n.type === 'dir') {
        const open = wkOpen.has(p)
        h += `<button class="wk-row dir${open ? ' open' : ''}" data-wkdir="${esc(p)}" style="${pad}" title="${esc(p)}">`
        // 图标 SVG 无自带尺寸，必须落在有 svg 尺寸规则的 slot 里——裸插会取替换元素默认 300×150（巨型图标撑爆行高）
        h += `<span class="wk-chev">${open ? I.dshChevDown : I.dshChevRight}</span><span class="wk-fic">${I.folder}</span>`
        h += `<span class="wk-name">${esc(n.name)}</span></button>`
        if (open) h += wkTreeHtml(n.children, depth + 1, p, f)
      } else {
        const on = p === state.workFile ? ' on' : ''
        h += `<button class="wk-row file${on}" data-wkfile="${esc(p)}" style="${pad}" title="${esc(p)}">`
        h += `<span class="wk-chec"></span><span class="wk-fic">${I.dshFile}</span>`
        h += `<span class="wk-name">${esc(n.name)}</span></button>`
      }
    }
    return h
  }

  // ---------- 数据 ----------
  // silent = 自动对账调用：不置加载态、失败保留旧树（瞬时网络错误不该把已展开的树清成错误页）
  async function loadProjectTree(label, silent) {
    if (!label || needToken()) return
    if (!silent) {
      wkLoading = true
      wkErr = ''
      wkTree = null
      renderWorkBody()
    }
    try {
      const res = await fetch(apiUrl('/gateway/project?label=' + encodeURIComponent(label)))
      const data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error || '加载失败')
      wkTree = Array.isArray(data.files) ? data.files : []
    } catch (e) {
      if (silent) return
      wkErr = e.message || String(e)
    } finally {
      if (!silent) wkLoading = false
    }
    renderWorkBody()
  }

  async function selectProject(label) {
    hideWkPops()
    if (!label || label === state.workProj) return
    if (wkEdDirty) await wkEdFlush() // 切项目前 flush 旧项目文件的 pending 编辑
    stashWorkPanes() // 旧项目的两开关先归档（此刻 state.workProj 还是旧值——saveWork 里那一次归档只认当前项目）
    state.workProj = label
    loadWorkPanes(label) // 新项目：有槽恢复该项目的开关，无槽回落缺省
    state.workFile = ''
    state.wkMainTab = 'chat' // 换了项目 = 旧文件 tab 作废，回到聊天 tab
    wkOpen.clear()
    wkFilter = ''
    const fi = $('wk-find-input')
    if (fi) fi.value = ''
    renderWorkChrome()
    saveWork()
    applyPanes() // 两开关落地（含「至少保留一栏」判定 + 视图浮层行同步）
    applySidebarPin() // 侧栏开合按新项目的槽（桌面）
    enforceWorkScope() // 换项目 → 助手栏若停在别的项目的会话，退回本项目的新对话
    renderEditor()
    hydrateExtCards(label) // 换项目：外部卡先按缓存即时换槽（tab 不断档），再走下面一次网络清单
    cmtInvalidate() // 评论按项目分库：旧项目副本作废（下一行 cmtLoad 重拉，评论 tab 与原文标记共用）
    renderWorkPreview() // 预览栏跟着换项目（异 label = 换源，mountPreview 内部重建）
    cmtLoad(label) // 原文标记也需要当前项目的评论（不止评论 tab）；拉到后 cmtApplyMarks 自动补标
    cmtRender()
    syncWorkExtCards()
    await loadProjectTree(label)
  }

  // silent = 自动对账（见 workAutoTick）：不收起浮层、不动滚动位置、失败静默
  async function refreshWork(silent) {
    if (!silent) hideWkPops()
    const body = $('wk-body')
    const sc = body ? body.scrollTop : 0
    try {
      await loadSessions()
    } catch {
      /* 列表刷新失败不阻断文件树刷新 */
    }
    renderWorkChrome()
    if (state.workProj) await loadProjectTree(state.workProj, silent)
    else renderWorkBody() // 未选项目时列表/空态也要跟上（loadProjectTree 早退不渲染）
    if (body && sc && body.scrollTop !== sc) body.scrollTop = sc
  }

  // ---------- 自动刷新（2026-09-26 取代手动 ⟳） ----------
  // 三条前置：work 模式 + 页面可见 + 已过 token 门。会话列表由 /gateway/events SSE 增量推，
  // 但 work 侧栏的列表/树不在 SSE 的重渲出口里（live.js refreshList 只渲 #recent-body），
  // 所以这里定时对账一次全量，静默无变化即不写 DOM（renderWorkBody 的 HTML 比对）。
  const WK_AUTO_MS = 5000
  let wkAutoT = 0
  function startWorkAuto() {
    if (!wkAutoT) wkAutoT = setInterval(workAutoTick, WK_AUTO_MS)
  }
  function stopWorkAuto() {
    if (wkAutoT) {
      clearInterval(wkAutoT)
      wkAutoT = 0
    }
  }
  async function workAutoTick() {
    if (state.sbMode !== 'work' || document.visibilityState !== 'visible' || needToken()) return
    await refreshWork(true)
  }

  // 项目列表落地（ensureWork / 下拉打开时共用）。needToken 未解锁或网络失败时 state.projects 保持原值。
  async function ensureProjectList() {
    if (state.projects.length) return
    try {
      await loadSessions()
    } catch {
      /* 静默：renderWorkProjects 以空态呈现 */
    }
  }

  // work 模式数据补齐（启动进入 / 门后补拉 / 恢复持久化状态三处共用一条路径）。needToken() 未解锁时
  // loadProjectTree 早退 ⇒ 刷新后恢复的 workProj/workFile 无树、编辑区 401，须由 engine/auth.js hideGate
  // 的「门后补拉」链再调一次（与 mgr/models/neurons 数据同点，见该文件同名注释）。
  async function ensureWork() {
    renderWorkChrome()
    renderWorkBody()
    renderEditor()
    await ensureProjectList()
    renderWorkChrome()
    if (state.workProj && !wkTree && !wkLoading && !wkErr) await loadProjectTree(state.workProj)
    renderWorkPreview() // 挂在 ensureProjectList 之后：hasPreview 来自 groups，先拉列表才知道
    cmtLoad(state.workProj) // 评论恢复态补拉（评论 tab 与原文标记共用；needToken 未解锁时早退，由门后补拉再调）
    syncWorkExtCards() // 外部卡申报同上：与树/编辑区/预览同一条补拉链
    // 布局落地（tab 显隐 + 列宽 + 顶栏）在本链尾再落一次：ensureWork 是 work 一切事后补拉的唯一口
    // （启动 + token 门解锁后各一次），门/首帧里 DOM 还没量到时这里给第二次落地机会。
    applyPanes()
    cmtRender() // 评论面板空态/加载态跟着工作项目落地（needToken 未解锁时上面 cmtLoad 早退）
  }

  // ---------- 编辑区（主区左栏：阅读 / 源码编辑，仿 Obsidian 源码+阅读双模） ----------
  // 阅读态 = 原只读行为（图片 <img> / markdown 经 mdHtml 渲染（带 data-l 行锚）/ 其它文本 <pre>）。
  // 编辑态 = 原生 <textarea>（本工程零依赖、无法引入 CodeMirror/Monaco）。模式真源 = state.wkEdit
  // （跨文件记忆 + localStorage 持久化）；#work-editor.editing 类在编辑态落，供 inputbar/quote.js 屏蔽引用浮窗。
  // 保存 = 停止输入 1s 自动（去抖）+ Ctrl+S 立即；写回带 ETag 基线 wkEdMtime，外部改过 → 409，不静默覆盖。
  // 图片 / 二进制 / 超 4 MB 文件不可编辑（工具栏按钮隐藏，仍走阅读态）。
  let wkEdFile = ''     // 已载入编辑缓冲的路径（与 wkEdMeta/wkEdText 同拍）；'' = 未载入
  let wkEdMeta = null   // { isImg, isMd, editable, msg? }；null = 未载入
  let wkEdText = ''     // 当前文件正文（编辑态 = textarea 缓冲真源）
  let wkEdMtime = null  // 读侧 ETag 解析的 mtime（毫秒），写回冲突基线；null = 无
  let wkEdDirty = false
  let wkEdTimer = 0
  let wkEdSaving = false
  let wkEdConflict = false
  let wkCmtScrollId = '' // 评论面板定位跳转待消费的评论 id（渲染完原文标记后滚到该行）

  function fileUrl(p) {
    return apiUrl(`/gateway/file?label=${encodeURIComponent(state.workProj)}&path=${encodeURIComponent(p)}`)
  }
  const wkEdTa = () => document.querySelector('#wk-ed-body .wk-ed-ta')

  // ---------- 评论标记（阅读态原文打标，2026-10-06） ----------
  // 读态把每条评论的行范围 l0..l1 落到原文：纯文本逐行 <span data-l>、markdown 各块/段落行锚 data-l
  // （core/markdown.js mdHtml 第二参）。命中即加 .cmt-mark（未解决）/.cmt-mark-res（已解决）+ data-cmt-id。
  // 编辑态（透明 textarea 载体）无法内联打标，标记只存在于阅读态——与选区引用同口径（编辑态本就屏蔽）。
  function wkCodeHtml(text) {
    // 逐行落锚：换行并入该行 span（pre 内不留裸 '\n' 文本节点），选区端点才能上溯到 data-l
    // （inputbar/quote.js quoteLineOf 依赖 data-l；纯文本偏移链改锚后依旧精确且更好）。
    const lines = String(text).split('\n')
    let out = ''
    for (let i = 0; i < lines.length; i++) {
      const t = i < lines.length - 1 ? lines[i] + '\n' : lines[i]
      out += `<span class="wk-ln" data-l="${i + 1}">${esc(t)}</span>`
    }
    return out
  }
  function cmtApplyMarks() {
    const body = $('wk-ed-body')
    if (!body) return
    body.querySelectorAll('.cmt-mark').forEach((el) => {
      el.classList.remove('cmt-mark', 'cmt-mark-res', 'cmt-mark-open')
      el.removeAttribute('data-cmt-id')
    })
    const marks = cmtRangesFor(state.workFile)
    if (marks.length) {
      body.querySelectorAll('[data-l]').forEach((el) => {
        const ln = Number(el.getAttribute('data-l'))
        if (!ln) return
        const hit = marks.find((m) => ln >= m.l0 && ln <= m.l1)
        if (!hit) return
        el.classList.add('cmt-mark', hit.resolved ? 'cmt-mark-res' : 'cmt-mark-open')
        el.setAttribute('data-cmt-id', hit.id)
      })
    }
    if (wkCmtScrollId) {
      const t = body.querySelector(`[data-cmt-id="${wkCmtScrollId}"]`)
      wkCmtScrollId = ''
      if (t) {
        t.scrollIntoView({ block: 'center' })
        t.classList.add('cmt-flash')
        setTimeout(() => t.classList.remove('cmt-flash'), 1200)
      }
    }
  }

  // ---------- 源码着色（编辑态语法高亮；仿编辑器源码模式） ----------
  // 不变量：着色层 `.wk-ed-hl` 与 textarea 逐字叠放、同步滚动；token **只改 color**——禁字重/字形/字号，
  // 任何字形差异都会让两层字宽/换行错位（排版同源由 styles.css 的 .wk-ed-hl / .wk-ed-ta 两条规则保证）。
  // 着色只写进 aria-hidden 的着色层；textarea 文本透明（caret-color 可见）、选区背景半透明透出着色。
  const WK_HL_KW = {
    js: ' const let var function return if else for while do switch case break continue new class extends super import export from default async await yield try catch finally throw typeof instanceof in of delete void this null undefined true false static get set ',
    py: ' def class return if elif else for while import from as pass break continue with try except finally raise lambda yield global nonlocal and or not in is None True False async await del assert ',
    sh: ' if then else elif fi for while do done case esac function return local export echo cd exit set unset source ',
    yaml: ' true false null yes no on off ',
    css: '', html: '',
  }
  // 扩展名 → 语言键；'' = 纯文本（仅转义，不上色）
  function wkEdLang(p) {
    const m = /\.([a-z0-9]+)$/i.exec(p || '')
    const e = m ? m[1].toLowerCase() : ''
    if (/^(md|markdown)$/.test(e)) return 'md'
    if (e === 'json') return 'json'
    if (/^(js|mjs|cjs|jsx|ts|tsx)$/.test(e)) return 'js'
    if (/^(css|scss|less)$/.test(e)) return 'css'
    if (/^(html|htm|xml|svg|vue)$/.test(e)) return 'html'
    if (e === 'py') return 'py'
    if (/^(sh|bash|zsh)$/.test(e)) return 'sh'
    if (/^(yaml|yml|toml|ini|conf)$/.test(e)) return 'yaml'
    return ''
  }
  // 扫描切片：命中段转义后包 span（cls 返回 '' 则不包），未命中段仅转义——字符零增删，与 textarea 逐字对齐。
  function wkHlScan(text, re, cls) {
    let out = '', last = 0
    re.lastIndex = 0
    let m
    while ((m = re.exec(text))) {
      if (m.index > last) out += esc(text.slice(last, m.index))
      const k = cls(m[0])
      out += k ? `<span class="${k}">${esc(m[0])}</span>` : esc(m[0])
      last = re.lastIndex
      if (m.index === re.lastIndex) re.lastIndex++
    }
    return out + esc(text.slice(last))
  }
  // 代码族两套注释：# 行注释（py/sh/yaml）与 //、/* */、<!-- -->（css/js/html）——css 用 # 会误伤 #id 选择器
  const WK_HL_RE_SLASH = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|<!--[\s\S]*?-->|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`|\b0x[0-9a-fA-F]+\b|\b\d[\d_]*(?:\.\d+)?\b|[A-Za-z_$][\w$]*/g
  const WK_HL_RE_HASH = /#[^\n]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\b\d[\d_]*(?:\.\d+)?\b|[A-Za-z_$][\w$]*/g
  function wkHlCodeCls(lang) {
    const kw = WK_HL_KW[lang] || ''
    return (t) => {
      if (t.startsWith('/*') || t.startsWith('//') || t.startsWith('#') || t.startsWith('<!--')) return 'hl-com'
      if (t[0] === '"' || t[0] === "'" || t[0] === '`') return 'hl-str'
      const c = t.charCodeAt(0)
      if (c >= 48 && c <= 57) return 'hl-num'
      return kw.indexOf(' ' + t + ' ') >= 0 ? 'hl-kw' : ''
    }
  }
  const WK_HL_RE_MD = /```[\s\S]*?```|`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]*\]\([^)\n]*\)|^#{1,6}[ \t].*$|^>[ \t].*$|^(?:[-*+]|\d+\.)[ \t]|^(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm
  function wkHlMdCls(t) {
    if (t[0] === '`') return 'hl-code'
    if (t[0] === '*' && t[1] === '*') return 'hl-b'
    if (t[0] === '_' && t[1] === '_') return 'hl-b'
    if (t[0] === '*' || t[0] === '_') return 'hl-i'
    if (t[0] === '[') return 'hl-link'
    if (t[0] === '#') return 'hl-h'
    if (t[0] === '>') return 'hl-quote'
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(t)) return 'hl-hr'
    return 'hl-li'
  }
  const WK_HL_RE_JSON = /"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g
  function wkHlJsonCls(t) {
    if (t[0] === '"') return 'hl-str'
    if (t[0] === 't' || t[0] === 'f' || t[0] === 'n') return 'hl-kw'
    return 'hl-num'
  }
  function wkHlHtml(text, lang) {
    if (lang === 'md') return wkHlScan(text, WK_HL_RE_MD, wkHlMdCls)
    if (lang === 'json') return wkHlScan(text, WK_HL_RE_JSON, wkHlJsonCls)
    if (lang === 'py' || lang === 'sh' || lang === 'yaml') return wkHlScan(text, WK_HL_RE_HASH, wkHlCodeCls(lang))
    if (lang) return wkHlScan(text, WK_HL_RE_SLASH, wkHlCodeCls(lang))
    return esc(text)
  }
  // 着色重绘：写着色层 innerHTML 后回填 scroll（innerHTML 重置滚动），rAF 合帧——输入期每帧至多绘一次
  let wkEdPaintQ = false
  function wkEdPaint() {
    const ta = wkEdTa()
    const hl = document.querySelector('#wk-ed-body .wk-ed-hl')
    if (!ta || !hl) return
    hl.innerHTML = wkHlHtml(ta.value, wkEdLang(state.workFile))
    hl.scrollTop = ta.scrollTop
    hl.scrollLeft = ta.scrollLeft
  }
  function wkEdPaintSoon() {
    if (wkEdPaintQ) return
    wkEdPaintQ = true
    requestAnimationFrame(() => { wkEdPaintQ = false; wkEdPaint() })
  }

  // 顶部「保存态」文本落地（唯一写点）：conflict > saving > dirty > 空。传 (txt, cls) 则原样落。
  function wkEdState(txt, cls) {
    const el = $('wk-ed-save')
    if (!el) return
    if (txt === undefined) {
      txt = wkEdConflict ? '外部已修改' : wkEdSaving ? '保存中…' : wkEdDirty ? '未保存' : ''
      cls = wkEdConflict ? 'conflict' : wkEdDirty || wkEdSaving ? 'dirty' : ''
    }
    el.textContent = txt || ''
    el.classList.toggle('dirty', cls === 'dirty')
    el.classList.toggle('conflict', cls === 'conflict')
  }

  // 模式类 + 工具栏按钮落地（编辑态唯一判定点）：不可编辑（图/二进制/超限）恒阅读态、按钮隐藏。
  function applyEdMode() {
    const on = !!state.workFile && !!wkEdMeta && !wkEdMeta.isImg && wkEdMeta.editable
    const editing = !!(on && state.wkEdit)
    const ed = $('work-editor')
    if (ed) ed.classList.toggle('editing', editing)
    const btn = $('wk-ed-mode')
    if (!btn) return
    btn.hidden = !on
    btn.innerHTML = editing ? I.dshBook : I.dshEdit
    btn.title = editing ? '阅读' : '编辑'
  }

  function renderEditor() {
    const pathEl = $('wk-ed-path')
    const body = $('wk-ed-body')
    if (pathEl) pathEl.textContent = state.workFile || ''
    if (!body) return
    if (!state.workFile) {
      wkEdReset()
      body.innerHTML = '<div class="wk-ed-empty">从左侧文件树选择一个文件</div>'
      return
    }
    if (!state.workProj) {
      wkEdReset()
      body.innerHTML = '<div class="wk-ed-empty">未选择项目</div>'
      return
    }
    if (wkEdFile !== state.workFile) {
      readFile(state.workFile)
      return
    }
    renderEdBody()
  }

  function wkEdReset() {
    wkEdFile = ''
    wkEdMeta = null
    wkEdText = ''
    wkEdMtime = null
    wkEdDirty = false
    wkEdConflict = false
    if (wkEdTimer) {
      clearTimeout(wkEdTimer)
      wkEdTimer = 0
    }
    applyEdMode()
    wkEdState('')
  }

  function renderEdBody() {
    const body = $('wk-ed-body')
    if (!body || !wkEdMeta) return
    if (wkEdMeta.isImg) {
      body.innerHTML = `<div class="wk-ed-img"><img src="${esc(fileUrl(state.workFile))}" alt="${esc(state.workFile)}" /></div>`
      applyEdMode()
      return
    }
    if (!wkEdMeta.editable) {
      body.innerHTML = `<div class="wk-ed-empty">${esc(wkEdMeta.msg || '不支持预览')}</div>`
      applyEdMode()
      return
    }
    if (state.wkEdit) {
      // 编辑态 = 着色层 <div class="wk-ed-hl">（aria-hidden，只读展示）+ 透明文本 textarea 叠放；
      // textarea 自身滚动，scroll 事件回填着色层 scrollTop/Left 保持逐字对齐。textarea 用 DOM 属性赋值
      // （不走 innerHTML 转义：value 不需 HTML 转义，且要保住原始引号/实体）。
      const wrap = document.createElement('div')
      wrap.className = 'wk-ed-wrap'
      const hl = document.createElement('div')
      hl.className = 'wk-ed-hl'
      hl.setAttribute('aria-hidden', 'true')
      const ta = document.createElement('textarea')
      ta.className = 'wk-ed-ta'
      ta.spellcheck = false
      ta.value = wkEdText
      wrap.append(hl, ta)
      body.replaceChildren(wrap)
      wkEdPaint() // 首次着色（写在 replaceChildren 后，二者已挂载）
      ta.addEventListener('scroll', () => { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft })
      ta.focus()
    } else if (wkEdMeta.isMd) {
      // markdown 阅读态带行锚（data-l）：选中引用据此取选区首尾所在源行（inputbar/quote.js quoteEditorLines）
      body.innerHTML = `<div class="wk-ed-md md">${mdHtml(wkEdText, 'data-l')}</div>`
    } else {
      body.innerHTML = `<pre class="wk-code">${wkCodeHtml(wkEdText)}</pre>`
    }
    applyEdMode()
    cmtApplyMarks() // 评论标记：被批注的行加高亮（阅读态；编辑态 textarea 载体无法内联打标）
    wkEdState()
  }

  async function readFile(p) {
    const body = $('wk-ed-body')
    if (!body) return
    const seq = ++edSeq
    wkEdConflict = false
    if (IMG_EXT.test(p)) {
      wkEdFile = p
      wkEdMeta = { isImg: true, isMd: false, editable: false }
      wkEdText = ''
      wkEdMtime = null
      renderEdBody()
      return
    }
    body.innerHTML = '<div class="wk-ed-empty">读取中…</div>'
    try {
      const res = await fetch(fileUrl(p))
      if (seq !== edSeq) return
      if (!res.ok) {
        wkEdFile = p
        wkEdMeta = {
          isImg: false,
          isMd: false,
          editable: false,
          msg:
            res.status === 413
              ? '文件超过 4 MB，不支持编辑'
              : res.status === 403
                ? '该项目外的路径不可访问'
                : `读取失败（HTTP ${res.status}）`,
        }
        renderEdBody()
        return
      }
      const ct = (res.headers.get('content-type') || '').toLowerCase()
      const looksText = /^text\/|json|javascript|typescript|xml|svg|x-sh|csv|yaml/.test(ct) || MD_EXT.test(p)
      if (!looksText) {
        wkEdFile = p
        wkEdMeta = { isImg: false, isMd: false, editable: false, msg: `二进制文件（${ct || '未知类型'}），不支持预览` }
        renderEdBody()
        return
      }
      const text = await res.text()
      if (seq !== edSeq) return
      const etag = res.headers.get('etag')
      let mtime = etag ? Number(etag.replace(/"/g, '')) : NaN
      if (!Number.isFinite(mtime)) mtime = null
      wkEdFile = p
      wkEdText = text
      wkEdMeta = { isImg: false, isMd: MD_EXT.test(p), editable: true }
      wkEdMtime = mtime
      wkEdDirty = false
      renderEdBody()
    } catch (e) {
      if (seq !== edSeq) return
      body.innerHTML = `<div class="wk-ed-empty">读取失败：${esc(e.message || e)}</div>`
    }
  }

  // 模式切换（阅读 ⇄ 编辑）：离开编辑态前先把 textarea 现值收进缓冲并 flush 保存（防丢字），再重渲。
  async function wkSetEdit(on) {
    on = !!on
    if (on === state.wkEdit) return
    if (!on) await wkEdFlush()
    state.wkEdit = on
    saveWork()
    renderEdBody()
  }

  // 强制重拉磁盘版本（冲突「取消」分支 / 需放弃本地改动时用）
  async function wkEdReload() {
    if (!state.workFile) return
    const p = state.workFile
    wkEdFile = ''
    await readFile(p)
  }

  function wkEdInput() {
    const ta = wkEdTa()
    if (ta) wkEdText = ta.value
    wkEdDirty = true
    wkEdPaintSoon() // 着色层随输入重绘（rAF 合帧）
    wkEdState()
    if (wkEdConflict) return // 冲突未决：暂停自动保存，交 Ctrl+S 显式处置（避免覆盖外部改动）
    if (wkEdTimer) clearTimeout(wkEdTimer)
    wkEdTimer = setTimeout(() => {
      wkEdTimer = 0
      wkEdSave({})
    }, WK_SAVE_MS)
  }

  // 切文件 / 切项目 / 退 work 前 flush：把 pending 编辑立即落盘（交互式——冲突时弹处置框）
  async function wkEdFlush() {
    if (wkEdTimer) {
      clearTimeout(wkEdTimer)
      wkEdTimer = 0
    }
    const ta = wkEdTa()
    if (ta) wkEdText = ta.value
    if (!wkEdDirty || wkEdConflict) return
    await wkEdSave({ interactive: true })
  }

  // 保存：默认带 baseMtime（外部改过 → 409，不覆盖）；force = 无基线强制覆盖（用户确认后）。
  async function wkEdSave(opts) {
    const force = !!(opts && opts.force)
    const interactive = !!(opts && opts.interactive)
    if (!state.workFile || !state.workProj || wkEdSaving) return
    const ta = wkEdTa()
    if (ta) wkEdText = ta.value
    if (!wkEdDirty && !force) return
    if (wkEdTimer) {
      clearTimeout(wkEdTimer)
      wkEdTimer = 0
    }
    wkEdSaving = true
    wkEdState('保存中…', 'dirty')
    let conflict = false
    try {
      const payload = { label: state.workProj, path: state.workFile, content: wkEdText }
      if (!force && wkEdMtime !== null) payload.baseMtime = wkEdMtime
      const res = await fetch(apiUrl('/gateway/file/write'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.status === 409) conflict = true
      else {
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.ok) throw new Error(data.error || '保存失败')
        if (typeof data.mtime === 'number') wkEdMtime = data.mtime
        const fresh = wkEdTa()
        wkEdDirty = !!(fresh && fresh.value !== wkEdText) // 保存期间又改了 → 留脏，下面续排程
      }
    } catch (e) {
      wkEdSaving = false
      wkEdState('保存失败', 'conflict')
      toast('保存失败：' + (e.message || e))
      return
    }
    wkEdSaving = false
    if (conflict) {
      wkEdConflict = true
      wkEdState('外部已修改', 'conflict')
      if (interactive) return wkEdResolveConflict()
      toast('文件已被外部修改，未自动覆盖（Ctrl+S 可覆盖）')
      return
    }
    if (wkEdDirty) wkEdInput()
    else wkEdState()
  }

  // 冲突处置（用户显式保存时）：确定 = 用当前内容覆盖；取消 = 放弃编辑、重载磁盘版本。绝静默二选一。
  async function wkEdResolveConflict() {
    const overwrite = window.confirm('磁盘上的文件已被外部修改。\n\n确定：用当前内容覆盖\n取消：放弃编辑，载入磁盘版本')
    if (overwrite) {
      wkEdConflict = false
      wkEdDirty = true
      return wkEdSave({ force: true })
    }
    wkEdDirty = false
    wkEdConflict = false
    await wkEdReload()
  }

  async function openWorkFile(p) {
    if (!p) return
    if (p !== state.workFile && wkEdDirty) await wkEdFlush() // 切文件前 flush 旧文件的 pending 编辑
    state.workFile = p
    state.wkMainTab = 'file' // 点文件 = 明确要看内容 → 文件 tab 顶上来（不静默什么都不发生）
    saveWork()
    applyPanes()
    renderWorkBody()
    renderEditor()
  }

  // 关掉打开的文件（顶栏文件 pill 的 ×）：pending 编辑先落盘（不因关 tab 丢改动），清 workFile，
  // 下沉格回聊天 tab（applyPanes 的不变量会保底——聊天栏不在则文件/预览仍在即可）。
  async function closeWkFile() {
    if (wkEdDirty) await wkEdFlush()
    state.workFile = ''
    state.wkMainTab = 'chat'
    saveWork()
    renderEditor()
    renderWorkBody()
    applyPanes()
  }

  // ---------- 文件 / 目录行操作（2026-09-27：与侧栏会话行同一套右键 / 长按浮窗，见 recent.js registerRowMenu）----------
  // 两个写接口落在网关（POST /gateway/file/rename | /delete），本模块只做「弹出菜单 + 提交 + 刷新树」。
  // 删除 = 移入项目根 .trash/（工作区规范禁止真删），故不设二次确认——.trash/ 本身就是撤销位。
  function baseOf(p) {
    const i = p.lastIndexOf('/')
    return i < 0 ? p : p.slice(i + 1)
  }
  function openFileRename(p) {
    if (!p) return
    openRenameDialog({
      heading: '重命名',
      placeholder: '输入新名称',
      okText: '重命名',
      value: baseOf(p),
      onSubmit: async (name) => {
        const res = await fetch(apiUrl('/gateway/file/rename'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: state.workProj, path: p, name }),
        })
        const data = await res.json()
        if (!res.ok || !data.ok) throw new Error(data.error || '重命名失败')
        // 展开态与编辑区都按旧路径记着，须同步搬到新路径（目录改名 = 整棵子树的路径前缀都变）
        for (const k of [...wkOpen]) {
          if (k === p) { wkOpen.delete(k); wkOpen.add(data.path) }
          else if (k.startsWith(p + '/')) { wkOpen.delete(k); wkOpen.add(data.path + k.slice(p.length)) }
        }
        if (state.workFile === p) state.workFile = data.path
        else if (state.workFile.startsWith(p + '/')) state.workFile = data.path + state.workFile.slice(p.length)
        saveWork()
        await loadProjectTree(state.workProj)
        renderEditor()
        renderWorkBody()
        applyPanes() // 顶栏文件名 pill 跟着新路径重渲
        toast('已重命名为「' + data.name + '」')
      },
    })
  }
  async function deleteWorkEntry(p) {
    if (!p) return
    try {
      const res = await fetch(apiUrl('/gateway/file/delete'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: state.workProj, path: p }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || '删除失败')
      if (state.workFile === p || state.workFile.startsWith(p + '/')) state.workFile = ''
      for (const k of [...wkOpen]) if (k === p || k.startsWith(p + '/')) wkOpen.delete(k)
      saveWork()
      await loadProjectTree(state.workProj)
      renderEditor()
      renderWorkBody()
      applyPanes() // 删掉当前打开的文件 → 文件 tab 退场、下沉格切回聊天/空
      toast('已移入 ' + data.trash)
    } catch (e) {
      toast('删除失败：' + (e.message || e))
    }
  }
  // 文件树行源：文件与目录同一套菜单（目录删除 = 整棵子树进 .trash/）；操作对象 = 行的项目内相对路径。
  function registerWorkRows() {
    registerRowMenu({
      sel: '.wk-row',
      key: (el) => el.dataset.wkfile || el.dataset.wkdir || null,
      items: (el) =>
        el.dataset.wkfile || el.dataset.wkdir
          ? [
              { a: 'rename', icon: I.dshEdit, label: '重命名' },
              { a: 'delete', icon: I.dshStop, label: '删除', danger: true },
            ]
          : [],
      pick: (a, el) => {
        const p = el.dataset.wkfile || el.dataset.wkdir
        if (a === 'rename') openFileRename(p)
        else deleteWorkEntry(p)
      },
    })
  }

  function newWorkChat() {
    // 新会话落在当前 work 项目下（落项目由 engine/state.js newSessionProject 按工作项目解析，此处不写
    // state.newProject——目标项目槽只有一个真源，work 模式读工作项目、chat 模式读该槽）。
    // 不切回 chat 模式：#/ 空态由 renderHome() 渲染进会话卡（非视图卡），work 主区布局照样成立；
    // 模式互斥只对 mgr/preview 两张视图卡生效（route.js 内那一处 setSbMode('chat')）。
    state.wkMainTab = 'chat' // 新建聊天 = 要看聊天 → 聊天 tab 顶上来、助手靠回栏
    state.wkAssist = true
    state.wkAssistMode = 'side'
    wkEnsureTab(WK_NEW_TAB) // 空对话占自己一枚胶囊
    navigate('#/')
    applyPanes()
    saveWork()
    if (isMobile()) setPanel(false)
  }

  // ---------- 事件 ----------
  function mountWork() {
    registerWorkRows() // 文件树行的右键 / 长按浮窗（与会话行共用 recent.js 的手势委托）
    document.querySelectorAll('#chat-area > .work-gutter').forEach(bindGutter) // 主区一条分界条（下沉区 ↔ 预览）
    // 助手三态：头部工具条的四个图标 + 收敛输入栏的 pill；形态切换统一走 setAssistMode / setPane。
    const bindIco = (id, fn) => {
      const b = $(id)
      if (b) b.addEventListener('click', fn)
    }
    bindIco('wk-assist-slim', () => setAssistMode('slim'))
    bindIco('wk-assist-float', () => setAssistMode('float'))
    bindIco('wk-assist-dock', () => setAssistMode('side'))
    bindIco('wk-assist-close', () => setPane('assist', false))
    bindIco('wk-assist-pill', () => setAssistMode('float'))
    bindAssistGrip()
    // 主区尺寸变化 → 重锚悬浮卡：ResizeObserver 一把覆盖分界条拖拽、侧栏开合、窗口缩放、栏开关
    // （比 window.resize + 视口算更准：锚栏宽变了就重算，没变就不动）。
    const ro = new ResizeObserver(() => wkReflowAssist())
    ro.observe(chatArea)
    for (const id of ['work-editor', 'work-preview']) {
      const el = $(id)
      if (el) ro.observe(el)
    }
    // 模式 tab 白块：applySbMode 首次定位时字体可能还没到位（字宽变 ⇒ 白块错位），fonts.ready 后重量一次；
    // 窗口宽变同理（面板拖宽不改钮宽，但换字号/系统缩放下会）。
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(positionMsThumb)
    window.addEventListener('resize', positionMsThumb)
    $('wk-find').innerHTML = I.mag
    $('wk-new').innerHTML = I.dshPlus
    $('wk-view').innerHTML = I.toggle
    $('wk-tb-new').innerHTML = I.dshPlus // 顶栏 + 按钮图标（单源 core/icons.js）
    $('wk-tb-comment').innerHTML = I.msg // 顶栏评论胶囊图标（气泡，与「引用自会话」同族）
    // 评论模块 ↔ work 解耦：注册回调（点评论定位开文件 / 选区添加评论时确保右栏切到评论 tab /
    // 评论增删改后重绘原文标记）
    cmtSetHooks({
      openFile: (p, id) => {
        wkCmtScrollId = id || ''
        openWorkFile(p) // 打开 + 渲染后由 cmtApplyMarks 消费 wkCmtScrollId 滚到被批注行
      },
      ensurePane: () => {
        state.wkPreview = true
        applyPanes()
        setPvTab('comments')
      },
      refreshMarks: cmtApplyMarks,
    })
    cmtMount()
    // 下沉区顶栏 tab：[+] = 新建聊天；两个 pill 的点击只切 wkMainTab/助手形态，渲染由 renderTopbar 收口。
    $('wk-tb-new').addEventListener('click', () => newWorkChat())
    $('wk-tb-comment').addEventListener('click', () => toggleComments())
    // 右栏 tab（预览 / 评论）：唯一切换口 = setPvTab（渲染 + 持久化都在其内）
    $('wk-pv-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-wkpv]')
      if (b) setPvTab(b.dataset.wkpv)
    })
    $('wk-tb-tabs').addEventListener('click', (e) => {
      const cap = e.target.closest('[data-wkchat]')
      if (cap) {
        if (e.target.closest('.wk-tb-x')) { wkCloseTab(cap.dataset.wkchat); return } // × = 关这枚 tab
        // 点胶囊 = 明确要看这个会话：助手在场且靠回栏（浮起/收敛先靠回），再切到该会话路由
        state.wkMainTab = 'chat'
        state.wkAssist = true
        state.wkAssistMode = 'side'
        const hash = wkKeyHash(cap.dataset.wkchat)
        if (state.currentHash !== hash) navigate(hash ? '#/' + encodeURIComponent(hash) : '#/')
        applyPanes() // 形态 + 顶栏 active 一并落地（applyWorkCols 内 applyAssistMode 收口）
        saveWork()
        return
      }
      const b = e.target.closest('[data-wktb]')
      if (!b || b.dataset.wktb !== 'file') return
      if (e.target.closest('.wk-tb-x')) { closeWkFile(); return } // × = 关掉打开的文件
      state.wkMainTab = 'file'
      applyPanes()
      saveWork()
    })
    // 收敛输入栏末端的箭头 = 正常底栏发送钮的同一枚图标（单源 core/icons.js，勿在 HTML 内联自绘）
    const wap = document.querySelector('.wap-arrow')
    if (wap) wap.innerHTML = I.dshSend
    const ico = document.querySelector('#wk-proj-seat .wk-proj-ico')
    if (ico) ico.innerHTML = I.folder
    const fic = document.querySelector('.wk-foot-ico')
    if (fic) fic.innerHTML = I.logo

    $('wk-proj-seat').addEventListener('click', async (e) => {
      e.stopPropagation() // 同步：先掐断 document 的收起委托，后面的 await 才不会被它提前关掉
      const pop = $('wk-proj-pop')
      const willShow = pop.hidden
      hideWkPops()
      if (!willShow) return
      // 列表还在途中（切到 work 后立刻点开）就先等它落地——绝不给用户弹一个空框，也避免弹完不再更新
      await ensureProjectList()
      renderWorkChrome()
      pop.hidden = false
    })
    $('wk-proj-pop').addEventListener('click', (e) => {
      e.stopPropagation()
      const b = e.target.closest('[data-wkproj]')
      if (b) selectProject(b.dataset.wkproj)
    })
    $('wk-view').addEventListener('click', (e) => {
      e.stopPropagation()
      const pop = $('wk-view-pop')
      const willShow = pop.hidden
      hideWkPops()
      pop.hidden = !willShow
      applyPanes()
    })
    $('wk-view-pop').addEventListener('click', (e) => {
      e.stopPropagation()
      const b = e.target.closest('[data-wkpane]')
      if (b) setPane(b.dataset.wkpane, !b.classList.contains('on'))
    })
    // 加号按 tab 分派：聊天 tab = 直接新建对话；文件 tab = 展开新建菜单（创建/上传，功能待接入）
    $('wk-new').addEventListener('click', (e) => {
      e.stopPropagation() // 同步：先掐断 document 的收起委托，否则菜单刚开就被关掉
      if (wkTab !== 'files') {
        newWorkChat()
        return
      }
      const pop = $('wk-new-pop')
      const willShow = pop.hidden
      hideWkPops()
      pop.hidden = !willShow
    })
    $('wk-new-pop').addEventListener('click', (e) => {
      e.stopPropagation()
      if (!e.target.closest('[data-wknew]')) return
      $('wk-new-pop').hidden = true
      toast('创建 / 上传功能暂未接入')
    })
    $('wk-find').addEventListener('click', () => {
      const row = $('wk-find-row')
      row.hidden = !row.hidden
      // 过滤词作用于「当前 tab」——文件 tab 滤文件名/路径、聊天 tab 滤会话标题（同一 wkFilter，各自判据）
      if (!row.hidden) $('wk-find-input').focus()
      else if (wkFilter) {
        wkFilter = ''
        $('wk-find-input').value = ''
        renderWorkBody()
      }
    })
    $('wk-find-input').addEventListener('input', (e) => {
      wkFilter = e.target.value
      renderWorkBody()
    })
    document.querySelectorAll('.wk-tab').forEach((b) =>
      b.addEventListener('click', () => {
        wkTab = b.dataset.wktab === 'chat' ? 'chat' : 'files'
        // 两个 tab 的过滤判据不同，切 tab 时清词（否则会以旧词在新 tab 里给出「没有匹配」的假空态）
        wkFilter = ''
        const fi = $('wk-find-input')
        if (fi) fi.value = ''
        document.querySelectorAll('.wk-tab').forEach((x) => x.classList.toggle('on', x === b))
        renderWorkBody()
      }),
    )
    // 文件树整块由 innerHTML 重渲 → 事件必须委托在容器上（逐行绑定会被下次重渲抹掉）
    $('wk-body').addEventListener('click', (e) => {
      const d = e.target.closest('[data-wkdir]')
      if (d) {
        const p = d.dataset.wkdir
        if (wkOpen.has(p)) wkOpen.delete(p)
        else wkOpen.add(p)
        renderWorkBody()
        return
      }
      const f = e.target.closest('[data-wkfile]')
      if (f) {
        openWorkFile(f.dataset.wkfile)
        return
      }
      const s = e.target.closest('.sess-item')
      if (s && s.dataset.hash) {
        wkEnsureTab(s.dataset.hash) // 显式打开一个会话 = 顶栏占一枚胶囊
        // 点会话 = 明确要看这个会话：聊天 tab 顶上来（否则文件 tab 占着格，看着像「点了没反应」）
        state.wkMainTab = 'chat'
        state.wkAssist = true
        state.wkAssistMode = 'side'
        // 与侧栏会话条目同语义（recent.js bindSessClicks）：已在该会话内不重复 navigate
        if (s.dataset.hash !== state.currentHash) navigate('#/' + encodeURIComponent(s.dataset.hash))
        applyPanes() // 新胶囊 + active 落地
        saveWork()
        if (isMobile()) setPanel(false)
        return
      }
    })
    // 编辑区：阅读/编辑切换按钮 + Ctrl+S 保存 / Ctrl+E 切模式（绑在 #work-editor 上，编辑态才命中）
    $('wk-ed-mode').addEventListener('click', () => wkSetEdit(!state.wkEdit))
    $('work-editor').addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      const k = e.key.toLowerCase()
      if (k === 's') {
        e.preventDefault()
        wkEdSave({ interactive: true })
      } else if (k === 'e') {
        e.preventDefault()
        wkSetEdit(!state.wkEdit)
      }
    })
    // textarea 整块由 renderEdBody 重建 → input 委托在容器上
    $('wk-ed-body').addEventListener('input', (e) => {
      if (e.target && e.target.classList.contains('wk-ed-ta')) wkEdInput()
    })
    $('wk-foot').addEventListener('click', () => toast(state.workspace ? `工作区：${state.workspace}` : '工作区路径未知'))
    // 点空白收起两个浮层（浮层与触发按钮之外的点击都算）
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#wk-proj-pop') && !e.target.closest('#wk-proj-seat')) $('wk-proj-pop').hidden = true
      if (!e.target.closest('#wk-view-pop') && !e.target.closest('#wk-view')) $('wk-view-pop').hidden = true
      if (!e.target.closest('#wk-new-pop') && !e.target.closest('#wk-new')) $('wk-new-pop').hidden = true
    })
    // 后台标签页不做对账（定时器仍在跑，tick 内自会跳过）；切回前台立刻补一次，不等下一个间隔
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') workAutoTick()
    })
  }

  // 启动一次：恢复持久化状态 → 绑定事件 → 落地（顺序不可换：绑定要先于 applySbMode 的渲染，
  // 否则 work 面板首个渲染出来的行（文件树/新聊天）没有容器级委托）
  function initWork() {
    loadWork()
    // 外部卡申报按缓存即时回填（同步、无网络）：刷新后在门解锁前 tab 就在位，/manage/ext:… 直进也有卡
    // 可解析；权威清单由 ensureWork → syncWorkExtCards 拉新覆盖。必须在 loadWork 之后（要知道工作项目）。
    hydrateExtCards(state.workProj)
    mountWork()
    applySbMode()
  }

export {
  applySbMode,
  enforceWorkScope,
  ensureWork,
  initWork,
  setSbMode,
  syncWorkTabs,
  workScopeOk,
}
