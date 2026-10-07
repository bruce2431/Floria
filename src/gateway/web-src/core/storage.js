// 界面状态持久化（localStorage 打补丁读写 + mgrView / work 两族恢复）（2026-10-07 自 engine/state.js 拆出；唯一手改处，web/app.js 为生成物）

import { state, WK_PANES_DEF } from '../engine/state.js'
/* @module core/storage.js */
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
    patchUI({ sbMode: state.sbMode, workProj: state.workProj, workFile: state.workFile, wkPanes: state.wkPanes, wkAssist: !!state.wkAssist, wkMainTab: state.wkMainTab, wkPrevW: state.wkPrevW, wkPvTab: state.wkPvTab, wkAssistMode: state.wkAssistMode, wkAssistH: state.wkAssistH, wkEdit: !!state.wkEdit })
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
      // wkChats（work 顶栏聊天胶囊开放集）不持久化：纯运行时状态，刷新即空、切项目重置（2026-10-07 定案），
      // 恢复态一律从空开始，由路由/侧栏操作自然重建。
      if (typeof d.wkPrevW === 'number' && d.wkPrevW > 0) state.wkPrevW = d.wkPrevW
      // wkPvTab（右栏页态：'' = 预览态 / 工具 id）全局一份，不按项目分槽；未注册的旧 id 由
      // applyPvTab 的 pane 判定自然落成「无 pane 在场」，切一次 tab 即归一（见 work.js setPvTab）。
      if (typeof d.wkPvTab === 'string') state.wkPvTab = d.wkPvTab
      if (d.wkAssistMode === 'side' || d.wkAssistMode === 'float' || d.wkAssistMode === 'slim') state.wkAssistMode = d.wkAssistMode
      if (typeof d.wkAssistH === 'number' && d.wkAssistH > 0) state.wkAssistH = d.wkAssistH
      if (typeof d.wkEdit === 'boolean') state.wkEdit = d.wkEdit
    } catch { /* 忽略 */ }
  }

export {
  UI_KEY,
  loadMgrView,
  loadWork,
  loadWorkPanes,
  patchUI,
  readUI,
  saveMgrView,
  saveWork,
  stashWorkPanes,
}
