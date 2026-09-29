// work 模式侧栏 + 主区编辑区（2026-09-25，参考 Prism）（唯一手改处，web/app.js 为生成物）

import { navigate } from '../chat/route.js'
import { needToken, apiUrl } from '../core/gateway.js'
import { I } from '../core/icons.js'
import { mdHtml } from '../core/markdown.js'
import { ALL, chatArea, esc, isMobile, loadWork, loadWorkPanes, saveWork, sessionCard, stashWorkPanes, state, toast } from '../core/state.js'
import { loadSessions, sessCmp, findSession } from '../core/sessions.js'
import { mountPreview } from './mgr.js'
import { itemHtml, openRenameDialog, registerRowMenu, reliftRowMenu, setPanel } from './recent.js'
import { renderProjSeat } from '../inputbar/commands.js'
  // ---------- work 模式侧栏（Prism 式） ----------
  // 状态源 = core/state.js 的 sbMode / projects / workspace / workProj / workFile / wkEditor / wkAssist
  // （localStorage floria-ui-v1 持久化，见 saveWork/loadWork）；视图浮层四开关（编辑区/助手/预览/侧边栏）
  // 另按项目分槽存 state.wkPanes，切项目时由 stashWorkPanes / loadWorkPanes 换槽（见 selectProject）。
  // 数据源全部是现成端点，本模块零后端改动：
  //   项目列表 → /gateway/sessions 的 groups（sessions.js 顺带存进 state.projects）
  //   文件树   → GET /gateway/project?label=  的 files（walkProjectTree，深度 3 / 每层 50）
  //   单文件   → GET /gateway/file?label=&path=（只读原始字节，带路径穿越防护 + 4MB 上限）
  // 主区：sbMode=work → #chat-area 加 .work（flex-direction:row），#work-editor 与 #session-card
  // 并排成两栏；两栏开关只控制显隐，**至少保留一栏**（全关会让主区空白，属无效态）。
  // 与「管理/预览卡」互斥：那两者是 chat 模式的视图，route.js 进入 mgr/preview 时会调 setSbMode('chat')。

  const IMG_EXT = /\.(png|jpe?g|webp|gif|svg|bmp|ico|avif)$/i
  const MD_EXT = /\.(md|markdown)$/i
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
  // 回该项目的「新对话」空态（新会话的目标项目由 core/state.js newSessionProject 收口，seat 只读）。
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

  // 面板与主区布局按 state 落地。启动恢复与运行期切换共用这一条路径（无第二份初始化旁路）。
  function applySbMode() {
    const on = state.sbMode === 'work'
    document.querySelectorAll('.ms-btn').forEach((b) => b.classList.toggle('on', b.dataset.sbmode === state.sbMode))
    // #panel.work：work 模式下隐藏顶栏 #panel-search（会话搜索的 chat 模式入口）——work 的 🔍 已覆盖
    // 当前 tab 的过滤，两者同为放大镜同屏并存即「两个搜索」的重复观感（样式见 styles.css 该段）
    $('panel').classList.toggle('work', on)
    $('chat-panel').hidden = on
    $('work-panel').hidden = !on
    chatArea.classList.toggle('work', on)
    if (!on) chatArea.classList.remove('hide-editor', 'hide-assist', 'wk-file-open', 'wk-preview')
    applyPanes()
    enforceWorkScope() // 目标项目/只读标识随模式切换重算；开着别项目的会话时退回工作项目的新对话
    if (on) {
      applySidebarPin() // 进 work：侧栏开合按工作项目槽里的开关恢复（桌面）
      ensureWork()
      startWorkAuto()
    } else {
      hideWkPops()
      stopWorkAuto()
    }
  }

  // 浮层各开关的真源：编辑区/助手 = work 主区栏，预览 = 第三栏（个性化工作区），
  // 侧边栏 = 侧栏是否**被主动打开**（state.panelPinned，见 recent.js setPanel）。不用 state.panelOpen
  // ——后者含左缘悬停预览式唤出，那种瞬时露出不是「界面常在」，开关不该跟亮。
  function paneOn(k) {
    if (k === 'editor') return state.wkEditor
    if (k === 'assist') return state.wkAssist
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

  // 主区栏开关落地（不变量判定唯一处）：编辑区/助手/预览三栏至少一栏可见，全关 → 强制回助手栏。
  // 三栏都算数——只看编辑区+助手会让「预览还开着时关掉助手」被误判成全关（2026-09-26 实报）。
  function applyPanes() {
    if (state.sbMode === 'work') {
      // 不变量（2026-09-27 随助手脱流更新）：**编辑区 / 预览至少一栏**——助手悬浮或收成输入栏时不占列，
      // 不能再用它兜底。全关 → 强制打开编辑区（唯一还能承载内容的常驻栏）。判定仍是这一处。
      if (!state.wkEditor && !state.wkPreview && !wkAssistInFlow()) {
        state.wkEditor = true
        toast('至少保留一栏')
      }
      chatArea.classList.toggle('hide-editor', !state.wkEditor)
      chatArea.classList.toggle('hide-assist', !state.wkAssist)
      chatArea.classList.toggle('wk-preview', !!state.wkPreview)
    }
    syncPaneRows()
    applyWorkFlex()
  }

  // ---------- 主区栏宽（分界条拖拽，参考 Pj18 preview 的 #divider/#divider-chat）----------
  // 栏宽真源 = state.wkFlex（三栏各自的 flex-grow，basis 0 ⇒ 宽 ∝ grow），拖某条缝只重分配它左右
  // 相邻两可见栏的 grow、其余不动。缝显隐同理按「左右是否都有可见栏」实时判定，故任意相邻可见栏之间
  // 恒有且只有一条缝（栏隐藏时夹着它的缝自动消失，不会出现两条挨着的空缝）。
  const PANE_EL = { editor: () => $('work-editor'), assist: () => $('session-card'), preview: () => $('work-preview') }
  function paneEl(k) { return PANE_EL[k]() }
  // 助手脱流（float / slim）时它不在 flex 流里，但仍 offsetWidth>0 —— 若不排除，预览列与浮卡之间会凭空
  // 多出一条分界条（nearPane 把浮卡当右邻）。in-flow 判据由 wkAssistInFlow 单点给（见「助手三态」段）。
  function paneVisible(el) {
    if (el === sessionCard) return wkAssistInFlow()
    return !!el && el.offsetWidth > 0 && getComputedStyle(el).display !== 'none'
  }
  // 沿 DOM 序找 el 左/右第一个可见栏（跳过非栏兄弟与隐藏栏）；dir = -1 左 / +1 右。
  // 只认主区三栏（paneKey 查表），不认 `#chat-area` 的其它槽级兄弟：`#gate-screen`（token 门全屏浮层，
  // 满尺寸、display 非 none）会被 paneVisible 判成可见栏，令分界条 g1 误配有右邻 → 门后凭空多一条
  // 7px 假缝（门已 hidden 但 applyWorkFlex 不再重跑）；`#menu-btn` 等绝对定位件同理。
  function nearPane(g, dir) {
    const key = dir < 0 ? 'previousElementSibling' : 'nextElementSibling'
    for (let el = g[key]; el; el = el[key]) {
      if (!paneKey(el)) continue
      if (paneVisible(el)) return el
    }
    return null
  }
  function paneKey(el) {
    for (const k of Object.keys(PANE_EL)) if (paneEl(k) === el) return k
    return ''
  }
  function applyWorkFlex() {
    const on = state.sbMode === 'work'
    // 去重：两条缝被一段「全隐藏」的栏隔开时（如 preview 关、editor 与助手分列 g1/g2 两侧），
    // 二者的左右可见栏会是同一对 → 只保留靠左那条，否则会并排出现两条空缝。
    let lastL = null
    document.querySelectorAll('#chat-area > .work-gutter').forEach((g) => {
      const L = nearPane(g, -1)
      const R = L && nearPane(g, 1)
      const show = on && !!L && !!R && L !== lastL
      g.classList.toggle('on', show)
      if (show) lastL = L
    })
    for (const k of Object.keys(PANE_EL)) {
      const el = paneEl(k)
      if (!el) continue
      // 非 work 模式必须清掉内联 flex：#session-card 在 chat 模式是唯一视图卡（.view-card 的 flex:1）。
      // 助手脱流时同样清掉——absolute 定位已脱出 flex 流，留着内联 flex 只会误导下一处读它的人。
      const inFlow = k !== 'assist' || wkAssistInFlow()
      if (on && inFlow) el.style.flex = `${state.wkFlex[k] || 1} 1 0`
      else el.style.removeProperty('flex')
    }
    applyAssistMode() // 栏宽/显隐变了 → 悬浮卡跟着重锚（分界条拖拽、开关栏、切模式都经这里）
  }

  // 拖动一条缝：按指针在「左栏左缘 → 右栏右缘」区间的占比 p 重分配两栏 grow（和不变）。
  // 每侧留 PANE_MIN 像素地板——拖不到把某栏挤成 0（窄屏时地板自动收窄，不会算出负区间）。
  const PANE_MIN = 180
  function bindGutter(g) {
    g.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      const L = nearPane(g, -1)
      const R = nearPane(g, 1)
      if (!L || !R) return
      const kL = paneKey(L)
      const kR = paneKey(R)
      if (!kL || !kR) return
      const box = L.getBoundingClientRect()
      const right = R.getBoundingClientRect().right
      const w = right - box.left
      if (w <= 0) return
      const sum = (state.wkFlex[kL] || 1) + (state.wkFlex[kR] || 1)
      const floor = Math.min(PANE_MIN, w / 3)
      g.setPointerCapture(e.pointerId)
      g.classList.add('dragging')
      document.body.classList.add('wk-resizing')
      e.preventDefault()
      const move = (ev) => {
        const p = Math.max(floor, Math.min(w - floor, ev.clientX - box.left)) / w
        state.wkFlex[kL] = p * sum
        state.wkFlex[kR] = (1 - p) * sum
        applyWorkFlex()
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
  // 同一张 #session-card 的三个形态：'side'（靠栏，占主区一栏 = 现状）/ 'float'（悬浮卡，脱流不占列）/
  // 'slim'（收敛成底部输入栏）。形态类落在卡上（.wk-assist-float / .wk-assist-slim），可见性与几何的
  // 静态部分全由 CSS 给（web/styles.css「助手三态」段），本模块只写类 + 内联定位。
  // **绝不 reparent**：卡里挂着 core/state.js 模块级 const 引用的 messagesEl / inputWrap / charEl 单例，
  // 搬 DOM 会丢消息流与输入草稿（Pj18 #chat-pane 的同款约束）。
  // 锚点 = 首个可见的 in-flow 主区栏（编辑区 → 预览列 → 整个 #chat-area）：编辑区在场就锚它（主阅读面，
  // 且浮卡压编辑列时预览列完整可见）；编辑区关掉只剩预览时锚预览；两栏都不在（脱流且另一栏也关）兜整区。
  // 不能照搬 Pj18「恒锚编辑列」——work 有第二个主角列，编辑区不在时必须有确定的下一档，不能锚到 0 宽的东西。
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
  // in-flow = 助手是否占着主区一栏（靠栏且开着）。不变量判定、分界条显隐、flex 落点三处共用这一条判据。
  function wkAssistInFlow() {
    return !!state.wkAssist && wkAssistMode() === 'side'
  }
  function wkAssistBase() {
    const b = chatArea.getBoundingClientRect()
    return b.width > 0 ? b : null
  }
  function wkAssistAnchor() {
    for (const id of ['work-editor', 'work-preview']) {
      const el = $(id)
      if (!el) continue
      const r = el.getBoundingClientRect()
      if (r.width > 120) return r // 够宽才算「正在看的栏」，否则跳过（栏被关/未挂时不锚它）
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
    const el = $('work-preview')
    if (!el || !state.wkPreview || !state.workProj) return
    const f = el.querySelector('.preview-frame')
    if (f && f.dataset.label === state.workProj) return // 同项目已挂：交给 mountPreview 的软重入，不重建
    mountPreview(el, state.workProj, hasPreviewOf(state.workProj))
  }

  function hideWkPops() {
    for (const id of ['wk-proj-pop', 'wk-view-pop', 'wk-new-pop']) {
      const el = $(id)
      if (el) el.hidden = true
    }
  }

  function setPane(k, on) {
    if (k === 'sidebar') {
      // 侧栏开合不走「至少保留一栏」判定——那是主区两栏之间的约束，与侧栏无关。
      // pin = 主动打开，鼠标移出侧栏不自动收（悬停预览式收起只属左缘唤出）。行状态真源见 paneOn。
      setPanel(on, { pin: on })
      applyPanes()
      saveWork() // 四开关之一：归档进工作项目的槽
      return
    }
    if (k === 'workspace') {
      state.wkPreview = on
      applyPanes()
      saveWork()
      renderWorkPreview() // 开：挂当前项目预览；关：停在这里（帧留着，CSS 隐藏），重开零重载
      return
    }
    if (k === 'editor') state.wkEditor = on
    else state.wkAssist = on
    applyPanes() // 「至少保留一栏」由 applyPanes 统一兜底（含预览栏）
    saveWork()
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
    stashWorkPanes() // 旧项目的四开关先归档（此刻 state.workProj 还是旧值——saveWork 里那一次归档只认当前项目）
    state.workProj = label
    loadWorkPanes(label) // 新项目：有槽恢复该项目的开关，无槽回落缺省
    state.workFile = ''
    wkOpen.clear()
    wkFilter = ''
    const fi = $('wk-find-input')
    if (fi) fi.value = ''
    renderWorkChrome()
    saveWork()
    applyPanes() // 四开关落地（含「至少保留一栏」判定 + 视图浮层行同步）
    applySidebarPin() // 侧栏开合按新项目的槽（桌面）
    enforceWorkScope() // 换项目 → 助手栏若停在别的项目的会话，退回本项目的新对话
    renderEditor()
    renderWorkPreview() // 预览栏跟着换项目（异 label = 换源，mountPreview 内部重建）
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
  // loadProjectTree 早退 ⇒ 刷新后恢复的 workProj/workFile 无树、编辑区 401，须由 core/auth.js hideGate
  // 的「门后补拉」链再调一次（与 mgr/models/neurons 数据同点，见该文件同名注释）。
  async function ensureWork() {
    renderWorkChrome()
    renderWorkBody()
    renderEditor()
    await ensureProjectList()
    renderWorkChrome()
    if (state.workProj && !wkTree && !wkLoading && !wkErr) await loadProjectTree(state.workProj)
    renderWorkPreview() // 挂在 ensureProjectList 之后：hasPreview 来自 groups，先拉列表才知道
  }

  // ---------- 编辑区（主区左栏，只读） ----------
  function fileUrl(p) {
    return apiUrl(`/gateway/file?label=${encodeURIComponent(state.workProj)}&path=${encodeURIComponent(p)}`)
  }

  function renderEditor() {
    const pathEl = $('wk-ed-path')
    const body = $('wk-ed-body')
    if (pathEl) pathEl.textContent = state.workFile || ''
    if (!body) return
    if (!state.workFile) {
      body.innerHTML = '<div class="wk-ed-empty">从左侧文件树选择一个文件</div>'
      return
    }
    if (!state.workProj) {
      body.innerHTML = '<div class="wk-ed-empty">未选择项目</div>'
      return
    }
    readFile(state.workFile)
  }

  async function readFile(p) {
    const body = $('wk-ed-body')
    if (!body) return
    const seq = ++edSeq
    if (IMG_EXT.test(p)) {
      body.innerHTML = `<div class="wk-ed-img"><img src="${esc(fileUrl(p))}" alt="${esc(p)}" /></div>`
      return
    }
    body.innerHTML = '<div class="wk-ed-empty">读取中…</div>'
    try {
      const res = await fetch(fileUrl(p))
      if (seq !== edSeq) return
      if (!res.ok) {
        body.innerHTML = `<div class="wk-ed-empty">${esc(
          res.status === 413 ? '文件超过 4 MB，不支持预览' : res.status === 403 ? '该项目外的路径不可访问' : `读取失败（HTTP ${res.status}）`,
        )}</div>`
        return
      }
      const ct = (res.headers.get('content-type') || '').toLowerCase()
      const looksText = /^text\/|json|javascript|typescript|xml|svg|x-sh|csv|yaml/.test(ct) || MD_EXT.test(p)
      if (!looksText) {
        body.innerHTML = `<div class="wk-ed-empty">二进制文件（${esc(ct || '未知类型')}），不支持预览</div>`
        return
      }
      const text = await res.text()
      if (seq !== edSeq) return
      // markdown 预览带行锚（mdHtml 第二参数）：渲染期把每个源行号写进 DOM（data-l），
      // 选中引用据此取选区首尾所在行——渲染后的文本已丢格式符，回查原文不可靠（inputbar/quote.js）。
      body.innerHTML = MD_EXT.test(p)
        ? `<div class="wk-ed-md md">${mdHtml(text, 'data-l')}</div>`
        : `<pre class="wk-code">${esc(text)}</pre>`
    } catch (e) {
      if (seq !== edSeq) return
      body.innerHTML = `<div class="wk-ed-empty">读取失败：${esc(e.message || e)}</div>`
    }
  }

  function openWorkFile(p) {
    if (!p) return
    state.workFile = p
    // 编辑区被开关关掉时点文件 = 明确要看内容 → 自动把编辑区打开（不静默什么都不发生）
    if (!state.wkEditor) {
      state.wkEditor = true
      applyPanes()
    }
    saveWork()
    renderWorkBody()
    renderEditor()
    // 手机端两栏不成立：编辑区以覆盖层打开（.wk-file-open 由 CSS 接管），返回键收起
    if (isMobile()) {
      chatArea.classList.add('wk-file-open')
      $('work-panel').hidden = true
    }
  }

  function closeWorkFile() {
    chatArea.classList.remove('wk-file-open')
    if (state.sbMode === 'work') $('work-panel').hidden = false
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
    // 新会话落在当前 work 项目下（落项目由 core/state.js newSessionProject 按工作项目解析，此处不写
    // state.newProject——目标项目槽只有一个真源，work 模式读工作项目、chat 模式读该槽）。
    // 不切回 chat 模式：#/ 空态由 renderHome() 渲染进会话卡（非视图卡），work 两栏布局照样成立；
    // 模式互斥只对 mgr/preview 两张视图卡生效（route.js 内那一处 setSbMode('chat')）。
    navigate('#/')
    if (isMobile()) setPanel(false)
  }

  // ---------- 事件 ----------
  function mountWork() {
    registerWorkRows() // 文件树行的右键 / 长按浮窗（与会话行共用 recent.js 的手势委托）
    document.querySelectorAll('#chat-area > .work-gutter').forEach(bindGutter) // 主区两条分界条
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
    $('wk-find').innerHTML = I.mag
    $('wk-new').innerHTML = I.dshPlus
    $('wk-view').innerHTML = I.toggle
    $('wk-ed-back').innerHTML = I.collapse
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
        // 与侧栏会话条目同语义（recent.js bindSessClicks）：已在该会话内不重复 navigate
        if (s.dataset.hash !== state.currentHash) navigate('#/' + encodeURIComponent(s.dataset.hash))
        if (isMobile()) setPanel(false)
        return
      }
    })
    $('wk-ed-back').addEventListener('click', closeWorkFile)
    $('wk-foot').addEventListener('click', () => toast(state.workspace ? `工作区：${state.workspace}` : '工作区路径未知'))
    // 点空白收起两个浮层（浮层与触发按钮之外的点击都算）
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#wk-proj-pop') && !e.target.closest('#wk-proj-seat')) $('wk-proj-pop').hidden = true
      if (!e.target.closest('#wk-view-pop') && !e.target.closest('#wk-view')) $('wk-view-pop').hidden = true
      if (!e.target.closest('#wk-new-pop') && !e.target.closest('#wk-new')) $('wk-new-pop').hidden = true
    })
    // 窗口跨越手机断点时收起覆盖层：两栏本身能重新排开，覆盖层留着会挡住助手
    window.addEventListener('resize', () => {
      if (!isMobile() && chatArea.classList.contains('wk-file-open')) closeWorkFile()
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
    mountWork()
    applySbMode()
  }

export {
  applySbMode,
  enforceWorkScope,
  ensureWork,
  initWork,
  setSbMode,
  workScopeOk,
}
