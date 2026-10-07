// 侧栏开合核（2026-10-05 自 sidebar/recent.js setPanel 抽出状态落地）（唯一手改处，web/app.js 为生成物）

import { sidebar, state } from './state.js'
/* @module engine/panel.js */
  // ---------- 侧栏开合核 ----------
  // 开合落地唯一实现：钉住态 + 可见态 + #sidebar.open + 折叠清拖拽调宽。recent.js 的 setPanel 委托本核
  // （弹层清理 / 行浮窗 / work 视图浮窗行状态留在其包装层）；卡（neurons/projects）只需「无导航收抽屉」
  // → closePanel（不再横向 import sidebar/recent.js）。真源 = state.panelPinned（悬停唤出只置 panelOpen，
  // 不算「打开」——「侧边栏」开关与 work paneOn 均读 panelPinned）。
  function applyPanelOpen(open, pin) {
    state.panelPinned = !!open && !!pin
    state.panelOpen = open
    sidebar.classList.toggle('open', open)
    // 折叠即清拖拽调宽（2026-09-12）：移除 :root 内联 --panel-w，再展开回默认 280px（不持久化）
    if (!open) document.documentElement.style.removeProperty('--panel-w')
  }
  function closePanel() {
    applyPanelOpen(false)
  }

export {
  applyPanelOpen,
  closePanel,
}
