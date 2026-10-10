// 界面状态纯数据（2026-10-10 自 engine/state.js 下移为 core 叶子）：无依赖的对象字面量，供任意层读写。
// 原先 core/{char,util,storage} 直连 engine/state.js 取 state ⇒ 3 条 core→engine 逆向边；state 下沉为
// core 叶子后这些边归 core→core。engine/state.js 转出本模块的 state（全库 import 路径零改）。
// 唯一手改处，web/app.js 为生成物。

/* @module core/ui-state.js */
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
    // wkPanes = 视图浮层两开关（预览/侧边栏）按项目分槽：<项目 label> → 取值。
    // 无槽 = 用 WK_PANES_DEF（sidebar/work-state.js）；未选项目（workProj 空）不落槽。
    // 读写唯一口 = stashWorkPanes / loadWorkPanes（core/storage.js）。
    wkPanes: {} }

export { state }
