// 元素引用 + 界面状态 + 基础工具 + toast/设备判定（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { route } from '../chat/route.js'
import { setConn } from './gateway.js'
import { ctx } from '../inputbar/ctx-meter.js'
  // ---------- 元素 ----------
  const chatArea = $('chat-area')
  const sessionCard = $('session-card') // 会话卡（视图注册表 tab:false 一条；常驻 index.html，靠 hidden 退场）
  const messagesEl = $('messages')
  const inputWrap = $('input-wrap')
  const inputEl = $('input')
  const inputBarEl = $('input-bar')
  const sendBtn = $('send-btn')
  const ctxMeterEl = $('ctx-meter')
  const ctxBtnEl = $('ctx-btn')
  const ctxPanelEl = $('ctx-panel')
  const bodyEl = $('recent-body')
  const sidebar = $('sidebar')
  const toastEl = $('toast')
  const charEl = $('char')
  const bubblePop = $('bubble-pop')
  const overlay = $('search-overlay')
  const sInput = $('search-input')
  const recentLabel = $('recent-label')
  const modeTabsEl = $('mode-tabs')

  // ---------- 状态 ----------
  // currentHash 无会话态 = ''（与 recent.js firstSendHash 同一表示，禁止再引入 null）：乐观项
  // pendingUserMsgs.hash 的「未归属」判定（p.hash === ''）依赖此约定——两套空值表示会让首页
  // 发送的乐观气泡在 navigate 进会话时被 renderSession 的归属守卫判为异类而丢弃（消息先闪现后消失）。
  // panelOpen = 侧栏**此刻可见**（含左缘悬停预览式唤出）；panelPinned = 侧栏**被主动打开**（汉堡/视图浮层
  // 开关，鼠标移出不自动收）。二者不同源：悬停唤出只置 panelOpen，故「侧边栏」开关的真源是 panelPinned
  // ——开关亮 = 侧栏常在，不是「此刻恰好露出」（见 sidebar/recent.js setPanel、sidebar/work.js paneOn）。
  const state = { mode: 'list', pt: 'projects', panelOpen: false, panelPinned: false, currentHash: '', mgr: null, preview: null, previewMounted: null, newProject: null, mgrView: { kind: 'plugins', cat: 'public', q: '' },
    // work 模式（2026-09-25）：sbMode = 侧栏模式（chat=现状 / work=Prism 式工作区）；
    // projects = /gateway/sessions 的 groups（全部项目，含无会话者，chat 侧栏不用）；
    // workProj/workFile = 当前项目与打开的文件（项目内相对路径）；wkPreview = 预览列（最右，常驻）。
    // wkMainTab = 下沉区当前 tab（'chat' 助手 / 'file' 编辑区），同时只显一个；
    // wkAssist = 聊天 tab 是否在场（全局，不按项目分槽）；wkPrevW = 预览列宽 px（拖分界条调，见 work.js applyWorkCols）。
    // wkAssistMode = 助手形态（'side'=靠栏 = 聊天 tab 内容 / 'float'=悬浮卡 / 'slim'=收敛输入栏）；
    // wkAssistH = 悬浮卡高度（宽由锚栏宽给定，见 sidebar/work.js applyAssistMode）。
    sbMode: 'chat', projects: [], workspace: '', workProj: '', workFile: '', wkAssist: true, wkPreview: true,
    wkMainTab: 'chat', wkPrevW: 420,
    // wkChats = 下沉区打开的聊天 tab 开放集（浏览器 tab 模型）：条目 = 会话 hash，或 'new'（空对话 /
    // 首页的哨兵键）。真源，随 saveWork 持久化；增/删/切换唯一口 = sidebar/work.js（wkEnsureTab /
    // wkCloseTab；路由落地由 syncWorkTabs 并入）。× 只从顶栏移除，不删会话。
    wkChats: [],
    wkAssistMode: 'side', wkAssistH: 430,
    // wkEdit = 编辑区模式（false=阅读（渲染/pre），true=源码编辑）。跨文件记忆（打开下一个文件沿用同一模式），
    // 全局一份（不按项目分槽，同 wkAssistMode）；见 sidebar/work.js renderEditor/wkSetEdit。
    wkEdit: false,
    // wkPanes = 视图浮层两开关（预览/侧边栏）按项目分槽：<项目 label> → 取值。
    // 无槽 = 用 WK_PANES_DEF；未选项目（workProj 空）不落槽。读写唯一口 = stashWorkPanes / loadWorkPanes（下方）。
    wkPanes: {},
    // wkPvTab = 右栏（#work-preview）当前 tab：'preview'（项目预览，默认）| 'comments'（评论面板，
    // 2026-10-06）。全局一份（不按项目分槽），随 saveWork 持久化；判定/落地唯一处 = sidebar/work.js applyPvTab。
    wkPvTab: 'preview' }

  // 两开关的缺省（新项目 / 无槽时用）。键名 = 槽内键名，与 state 初值一一对应。
  const WK_PANES_DEF = { workspace: true, sidebar: false }

  // 界面状态持久化（2026-08-16）：管理视图内部状态（mgrView：插件/技能切换、公开/个人、搜索词）
  // 存 localStorage，刷新后由 route 的 mgr 分支 loadMgrView 恢复——配合 hash 路由 #mgr/<kind>/#preview/<label>
  // 实现「刷新保持当前界面」（会话/管理/预览三态均可恢复，不再回退初始界面）。
  const UI_KEY = 'floria-ui-v1'
  // 写入 = read-modify-write 打补丁：mgrView 与 work 两族状态共用同一 key，
  // 直接 setItem(整份) 会让后写者抹掉先写者（两族各自保存时都会发生）。
  function patchUI(patch) {
    try {
      const raw = localStorage.getItem(UI_KEY)
      const cur = raw ? JSON.parse(raw) : {}
      localStorage.setItem(UI_KEY, JSON.stringify({ ...cur, ...patch }))
    } catch { /* 存储不可用忽略 */ }
  }
  // 只读整份（不自带段语义）：分表存同一 key 的调用方（外部卡申报缓存）自己取段。写口恒为 patchUI。
  function readUI() {
    try {
      const raw = localStorage.getItem(UI_KEY)
      return raw ? JSON.parse(raw) : null
    } catch { return null }
  }
  function saveMgrView() { patchUI({ mgrView: state.mgrView }) }
  function loadMgrView() {
    try {
      const raw = localStorage.getItem(UI_KEY)
      if (!raw) return
      const d = JSON.parse(raw)
      if (d && d.mgrView) state.mgrView = { ...state.mgrView, ...d.mgrView }
    } catch { /* 忽略 */ }
  }
  // 两开关 → 工作项目的槽（唯一写口，saveWork 调用）。未选项目不落槽。
  // 必须在 workProj 还是**旧值**时调用才能归档旧项目（见 sidebar/work.js selectProject）。
  function stashWorkPanes() {
    if (!state.workProj) return
    state.wkPanes[state.workProj] = { workspace: !!state.wkPreview, sidebar: !!state.panelPinned }
  }
  // 槽 → 两开关（唯一读口）：有槽用槽，无槽回落 WK_PANES_DEF。只写 state，渲染由调用方（applyPanes /
  // applySidebarPin）负责——纯函数不许碰 DOM。
  function loadWorkPanes(label) {
    const s = (label && state.wkPanes[label]) || null
    const val = (k) => (s && typeof s[k] === 'boolean' ? s[k] : WK_PANES_DEF[k])
    state.wkPreview = val('workspace')
    state.panelPinned = val('sidebar')
  }
  // work 模式状态持久化（2026-09-25）：刷新后恢复模式与当前项目/文件、两开关、下沉区当前 tab、预览列宽
  function saveWork() {
    stashWorkPanes() // 两开关随项目归档（唯一写口），与下面其余 work 状态同一次 patch
    patchUI({ sbMode: state.sbMode, workProj: state.workProj, workFile: state.workFile, wkPanes: state.wkPanes, wkAssist: !!state.wkAssist, wkMainTab: state.wkMainTab, wkPrevW: state.wkPrevW, wkChats: state.wkChats, wkAssistMode: state.wkAssistMode, wkAssistH: state.wkAssistH, wkEdit: !!state.wkEdit, wkPvTab: state.wkPvTab })
  }
  function loadWork() {
    try {
      const raw = localStorage.getItem(UI_KEY)
      if (!raw) return
      const d = JSON.parse(raw)
      if (!d) return
      if (d.sbMode === 'work' || d.sbMode === 'chat') state.sbMode = d.sbMode
      if (typeof d.workProj === 'string') state.workProj = d.workProj
      if (typeof d.workFile === 'string') state.workFile = d.workFile
      if (d.wkPanes && typeof d.wkPanes === 'object') {
        for (const [k, v] of Object.entries(d.wkPanes)) if (k && v && typeof v === 'object') state.wkPanes[k] = v
      }
      loadWorkPanes(state.workProj) // 两开关 = 恢复项目的槽（无槽回落缺省）
      if (typeof d.wkAssist === 'boolean') state.wkAssist = d.wkAssist
      if (d.wkMainTab === 'chat' || d.wkMainTab === 'file') state.wkMainTab = d.wkMainTab
      if (Array.isArray(d.wkChats)) state.wkChats = d.wkChats.filter((k) => typeof k === 'string' && k)
      if (typeof d.wkPrevW === 'number' && d.wkPrevW > 0) state.wkPrevW = d.wkPrevW
      if (d.wkAssistMode === 'side' || d.wkAssistMode === 'float' || d.wkAssistMode === 'slim') state.wkAssistMode = d.wkAssistMode
      if (typeof d.wkAssistH === 'number' && d.wkAssistH > 0) state.wkAssistH = d.wkAssistH
      if (typeof d.wkEdit === 'boolean') state.wkEdit = d.wkEdit
      if (d.wkPvTab === 'preview' || d.wkPvTab === 'comments') state.wkPvTab = d.wkPvTab
    } catch { /* 忽略 */ }
  }
  let ALL = []
  let timer = null
  // 阶段1 实时同步：SSE 变更驱动的去重/防抖状态
  const live = { es: null, listSig: '', curSig: '', listT: null, sessT: null, lastUserSig: '', pinnedUserSig: '', lastMsgLen: null, lastDataTs: 0, curUuid: null, queueRemote: [], maxImgId: 0, compactFlags: new Map(), turnEndFlags: new Map(), restoredFlags: new Map(), turnBeat: new Map(), txProcStart: 0, localMessages: null, deltaSeq: null, streamText: '', tasks: [], taskOpen: false }
  let connUp = false // 2026-09-07 网关 WS 在线（setConn 维护）：运行态计时 tick 据此标「连接中断」

  // ---------- 工具 ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))


  function toast(msg) {
    toastEl.textContent = msg
    toastEl.hidden = false
    clearTimeout(timer)
    timer = setTimeout(() => (toastEl.hidden = true), 2600)
  }

  // 新会话的落项目（唯一真源）：work 模式 = 「在项目中工作」，目标项目恒 = 工作项目（state.workProj）；
  // 其余情况 = chat 侧栏/初始界面选的 state.newProject（null = 全局）。所有建会话/上传的落项目判定
  // 都读本函数——写死 state.newProject 的消费点会在 work 模式下漏掉工作项目（会话落到全局）。
  function newSessionProject() {
    return state.sbMode === 'work' && state.workProj ? state.workProj : state.newProject
  }

  // 手机端（≤720px）：侧栏为全屏抽屉，选择会话后自动收起
  const isMobile = () => window.matchMedia('(max-width: 720px)').matches
  // 纯触屏设备（iPad/iPhone Safari）：打开弹层时不得程序化聚焦输入框——iOS 会因此弹出系统键盘
  // （2026-08-28：+ 命令菜单搜索框 / 模型菜单回填输入栏焦点均被识别为文本输入；桌面不受影响，方向键导航保留）
  const isTouch = () => window.matchMedia('(hover: none) and (pointer: coarse)').matches

// —— 跨模块写入口（切割脚本生成）——
export function setAll(v) { ALL = v }
export function setConnUp(v) { connUp = v }

export {
  ALL,
  UI_KEY,
  bodyEl,
  bubblePop,
  charEl,
  chatArea,
  connUp,
  ctxBtnEl,
  ctxMeterEl,
  ctxPanelEl,
  esc,
  inputBarEl,
  inputEl,
  inputWrap,
  isMobile,
  isTouch,
  live,
  loadMgrView,
  loadWork,
  loadWorkPanes,
  messagesEl,
  modeTabsEl,
  newSessionProject,
  overlay,
  patchUI,
  readUI,
  recentLabel,
  sInput,
  saveMgrView,
  saveWork,
  stashWorkPanes,
  sendBtn,
  sessionCard,
  sidebar,
  state,
  timer,
  toast,
  toastEl,
}
