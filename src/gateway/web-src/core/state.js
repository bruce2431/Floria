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
  const state = { mode: 'list', pt: 'projects', panelOpen: false, currentHash: '', mgr: null, preview: null, previewMounted: null, newProject: null, mgrView: { kind: 'plugins', cat: 'public', q: '' },
    // work 模式（2026-09-25）：sbMode = 侧栏模式（chat=现状 / work=Prism 式工作区）；
    // projects = /gateway/sessions 的 groups（全部项目，含无会话者，chat 侧栏不用）；
    // workProj/workFile = 当前项目与只读打开的文件（项目内相对路径）；wkEditor/wkAssist = 主区两栏开关；
    // wkPreview = 个性化工作区（第三栏，渲染当前项目预览，见 sidebar/work.js renderWorkPreview）。
    sbMode: 'chat', projects: [], workspace: '', workProj: '', workFile: '', wkEditor: true, wkAssist: true, wkPreview: false }

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
  function saveMgrView() { patchUI({ mgrView: state.mgrView }) }
  function loadMgrView() {
    try {
      const raw = localStorage.getItem(UI_KEY)
      if (!raw) return
      const d = JSON.parse(raw)
      if (d && d.mgrView) state.mgrView = { ...state.mgrView, ...d.mgrView }
    } catch { /* 忽略 */ }
  }
  // work 模式状态持久化（2026-09-25）：刷新后恢复模式与当前项目/文件、两栏开关
  function saveWork() {
    patchUI({ sbMode: state.sbMode, workProj: state.workProj, workFile: state.workFile, wkEditor: state.wkEditor, wkAssist: state.wkAssist, wkPreview: state.wkPreview })
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
      if (typeof d.wkEditor === 'boolean') state.wkEditor = d.wkEditor
      if (typeof d.wkAssist === 'boolean') state.wkAssist = d.wkAssist
      if (typeof d.wkPreview === 'boolean') state.wkPreview = d.wkPreview
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
  messagesEl,
  modeTabsEl,
  newSessionProject,
  overlay,
  recentLabel,
  sInput,
  saveMgrView,
  saveWork,
  sendBtn,
  sessionCard,
  sidebar,
  state,
  timer,
  toast,
  toastEl,
}
