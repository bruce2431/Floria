// work 工具页注册表（2026-10-07，参考 Prism）：work 右栏（#work-preview）**工具态**顶部水平标签栏的
// 工具登记处。右栏两态——**预览态**（默认，渲项目预览帧 #wk-pv-body）与**工具态**（顶 tab 条 + 各工具
// pane 互斥显隐）；态与 active 工具共用一个状态源 state.wkPvTab（'' = 预览态，工具 id = 工具态）。
// 任何模块可调 registerWkTool({ id, title, pane, mount }) 挂一枚工具 tab——本表只做「注册 → 按序渲 tab →
// 交调用方切内容」，不写任何工具内容（与 engine/registry.js 视图卡同思路）。
//   内置（work.js 注册）：'comments' 评论（sidebar/comments.js 渲染进 #wk-cmt）；外部注册 = 任意模块调
//   registerWkTool 追加，注册序即 tab 序。
// 契约：tab = <button class="wk-pv-tab" data-wkpv="<id>">（点击委托挂在 work.js 的 #wk-pv-tabs 容器上，
// 本表重渲不清事件）；active 态与 pane 互斥显隐由 work.js applyPvTab 唯一落。
// pane = 该工具内容所在元素 id；未注册工具的 pane 恒隐（applyPvTab 按 active id 判定）。
// 另收预览页（iframe）经 postMessage 申报的「帧工具」——无 pane/mount，内容由预览页自管（见下方
// registerWkFrameTools；宿主 → 帧回传选中 id 见 work.js notifyFrame）。

import { esc } from '../core/util.js'
/* @module sidebar/work-tools.js */
  const WK_TOOL_DEFS = []

  function registerWkTool(def) {
    if (!def || typeof def.id !== 'string' || !def.id) return
    const entry = {
      id: def.id,
      title: String(def.title || def.id),
      pane: typeof def.pane === 'string' ? def.pane : '',
      mount: typeof def.mount === 'function' ? def.mount : null,
    }
    const i = WK_TOOL_DEFS.findIndex((t) => t.id === entry.id)
    if (i >= 0) WK_TOOL_DEFS[i] = entry
    else WK_TOOL_DEFS.push(entry)
    renderWkToolTabs()
  }

  // 预览页（iframe）申报的工具 tab（2026-10-07）。与宿主注册 WK_TOOL_DEFS 分离——申报集属于**当前加载
  // 的那份预览文档**，随文档失效（帧换 src / 换项目 / 预览栏拆卸时 clearWkFrameTools，不变量同 rail-ext）。
  // 帧工具**无 pane、无 mount**：它的内容由预览页自管（工具态时宿主保留预览帧在场，只把选中 id 回传帧内，
  // 见 work.js applyPvTab / notifyFrame）。label = 申报时帧锚定的项目，用于换项目即失效。
  const WK_FRAME_TOOLS = []
  let wkFrameToolsLabel = ''

  function registerWkFrameTools(label, tools) {
    wkFrameToolsLabel = label || ''
    WK_FRAME_TOOLS.length = 0
    for (const t of tools) WK_FRAME_TOOLS.push(t)
    renderWkToolTabs()
  }
  function clearWkFrameTools() {
    if (!WK_FRAME_TOOLS.length && !wkFrameToolsLabel) return
    WK_FRAME_TOOLS.length = 0
    wkFrameToolsLabel = ''
    renderWkToolTabs()
  }

  function wkToolDefs() {
    return WK_TOOL_DEFS.concat(WK_FRAME_TOOLS)
  }
  function wkToolDef(id) {
    return WK_TOOL_DEFS.find((t) => t.id === id) || WK_FRAME_TOOLS.find((t) => t.id === id) || null
  }
  // 归一化 tab id：已注册则原样，否则回落首枚（无工具时空串）
  function wkToolNormId(id) {
    if (wkToolDef(id)) return id
    return WK_TOOL_DEFS.length ? WK_TOOL_DEFS[0].id : ''
  }

  // tab 条渲染（唯一口）：数据源 = 宿主注册序 + 帧申报序（wkToolDefs）。active 态由 work.js applyPvTab 落。
  function renderWkToolTabs() {
    const box = $('wk-pv-tabs')
    if (!box) return
    box.innerHTML = wkToolDefs().map(
      (t) => `<button type="button" class="wk-pv-tab" data-wkpv="${esc(t.id)}">${esc(t.title)}</button>`,
    ).join('')
  }

export {
  clearWkFrameTools,
  registerWkFrameTools,
  registerWkTool,
  renderWkToolTabs,
  wkToolDef,
  wkToolDefs,
  wkToolNormId,
}
