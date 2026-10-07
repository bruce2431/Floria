// 元素引用 + 界面状态（2026-09-10 web-src 模块化切割自 app.js v287；2026-10-07 工具/设备判定拆至 core/util.js、持久化拆至 core/storage.js；唯一手改处，web/app.js 为生成物）
/* @module engine/state.js */
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
    // wkPvTab = 右栏「页态」：'' = 预览态（挂项目预览帧 #wk-pv-body）/ 已注册工具 id = 工具态（顶 tab 条
    // + 该工具 pane 互斥显隐，注册表见 sidebar/work-tools.js）。与 wkPreview（栏在不在场）正交：
    // 预览态 ⇄ 工具态由顶栏「工具栏」胶囊切（工具态时胶囊变「关闭」，点回预览态）。
    sbMode: 'chat', projects: [], workspace: '', workProj: '', workFile: '', wkAssist: true, wkPreview: true,
    wkMainTab: 'chat', wkPrevW: 420, wkPvTab: '',
    // wkChats = 下沉区打开的聊天 tab 开放集（浏览器 tab 模型）：条目 = 会话 hash，或 'new'（空对话 /
    // 首页的哨兵键）。**纯运行时状态：不持久化（刷新即空），且切换工作项目时重置**（2026-10-07 定案，
    // 根治「Pj18 顶栏残留 Pj16 会话胶囊」的跨项目泄露）。增/删/切换唯一口 = sidebar/work.js（wkEnsureTab /
    // wkCloseTab；路由落地由 syncWorkTabs 并入）。× 只从顶栏移除，不删会话。
    wkChats: [],
    wkAssistMode: 'side', wkAssistH: 430,
    // wkEdit = 编辑区模式（false=阅读（渲染/pre），true=源码编辑）。跨文件记忆（打开下一个文件沿用同一模式），
    // 全局一份（不按项目分槽，同 wkAssistMode）；见 sidebar/work.js renderEditor/wkSetEdit。
    wkEdit: false,
    // wkPanes = 视图浮层两开关（预览/侧边栏）按项目分槽：<项目 label> → 取值。
    // 无槽 = 用 WK_PANES_DEF；未选项目（workProj 空）不落槽。读写唯一口 = stashWorkPanes / loadWorkPanes（core/storage.js）。
    wkPanes: {} }

  // 两开关的缺省（新项目 / 无槽时用）。键名 = 槽内键名，与 state 初值一一对应。
  const WK_PANES_DEF = { workspace: true, sidebar: false }

/* @module engine/state.js #2 */
  let ALL = []
  // 阶段1 实时同步：SSE 变更驱动的去重/防抖状态
  const live = { es: null, listSig: '', curSig: '', listT: null, sessT: null, lastUserSig: '', pinnedUserSig: '', lastMsgLen: null, lastDataTs: 0, curUuid: null, queueRemote: [], maxImgId: 0, compactFlags: new Map(), turnEndFlags: new Map(), restoredFlags: new Map(), turnBeat: new Map(), txProcStart: 0, localMessages: null, deltaSeq: null, streamText: '', tasks: [], taskOpen: false }
  let connUp = false // 2026-09-07 网关 WS 在线（setConn 维护）：运行态计时 tick 据此标「连接中断」

// —— 跨模块写入口（切割脚本生成）——
export function setAll(v) { ALL = v }
export function setConnUp(v) { connUp = v }

export {
  ALL,
  WK_PANES_DEF,
  bodyEl,
  bubblePop,
  charEl,
  chatArea,
  connUp,
  ctxBtnEl,
  ctxMeterEl,
  ctxPanelEl,
  inputBarEl,
  inputEl,
  inputWrap,
  live,
  messagesEl,
  modeTabsEl,
  overlay,
  recentLabel,
  sInput,
  sendBtn,
  sessionCard,
  sidebar,
  state,
  toastEl,
}
