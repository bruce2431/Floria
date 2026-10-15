// 视图注册表 + 槽位整卡切换（第一方契约层，2026-10-10 自 views/registry.js 下移为 engine/；同日 Phase 5
// 再拆出 engine/ext-runtime.js——外部卡运行时 EXT/APP_TABS/QACTIONS/申报缓存/应用目录全归该件）
// （2026-09-23 视图卡化；2026-10-01 卡片化二期：一模块一卡组件 + 单通道；唯一手改处，web/app.js 为生成物）
// 单一真源：每个卡组件（views/cards/<name>/<name>-card.js）在**自身模块顶层**调 registerCard(def) 入表
// （描述符 { id, title, tip, icon, tab, mount }），本表只做「按 id 取卡 → 挂进槽 → 调 mount」的编排，
// 不写任何卡内容，也不 import 任何卡实现（engine 永不 import views）。
// 消费三处——①侧栏 tab 生成（renderMgrTabs）②路由 #mgr/<id>（parseRoute 的 r.mgr 即 id）③卡体渲染
// （openCard 把卡体交给卡自己的 mount）。
// 三张表：第一方 CARDS（本件）+ 运行时 EXT / 应用 APP_TABS（engine/ext-runtime.js，经 extTabs()/appTabs()
// 只读取用）合流于 cardOf / renderMgrTabs 两个查询点。外部卡只有宿主生成的 iframe 壳（无 mount 代码），
// 壳渲染经 setExtCardRenderer 注入（实现留 views/cards/ext/ext-card.js），外部永不获得在宿主 DOM 执行
// 的能力（SPEC-视图卡化 §7 边界）。外部申报的取回/校验/缓存全部归 ext-runtime，本件不认识 preview.json。

import { I } from '../core/icons.js'
import { chatArea, sessionCard, state } from './state.js'
import { esc } from '../core/util.js'
import { appTabs, extLabel, extTabs, isGlobalLabel, setTabRefresh } from './ext-runtime.js'
/* @module engine/registry.js */

  // ---------- 第一方卡片注册表 ----------
  // 卡描述符由各卡模块顶层 registerCard 自注册（一模块一卡）；「项目 / 模型 / 神经元」三卡自 2026-10-10
  // 起不再是第一方卡——改由工作区根以应用形式申报、用户在插件卡「应用」列表里手动启用（APP_TABS 见
  // engine/ext-runtime.js），侧栏 tab 因此是 CARDS / APP_TABS / EXT 之和。
  let CARDS = []
  function registerCard(def) { if (def && def.id) CARDS.push(def) }
  const cardOf = (id) => CARDS.find((c) => c.id === id) || appTabs().find((c) => c.id === id) || extTabs().find((c) => c.id === id)
  // 契约出口：卡外的局部重渲（如 mgr-data 拉完清单刷插件卡网格）不必懂该卡实现，只报 id。
  function refreshCard(id) { cardOf(id)?.refresh?.() }

  // ---------- 注册域（2026-10-15 注册域隔离返修）----------
  // #mgr-tabs 是 chat 侧栏（#chat-panel 内）那一行——work 模式下 #chat-panel 整块 hidden，本行不可见，
  // 故三张表的入表门控一律按 **chat 语境** 判，不得无条件合流（回归：普通 chat 串出工作区根的应用 tab；
  // 离开预览后外部卡 tab 仍在，均可由 extTabs()/appTabs() 有残留解释）：
  //   CARDS    = 第一方卡，恒显（当前唯一 tab:true 者 = 插件）
  //   APP_TABS = 工作区根应用（项目/模型/神经元…）。**仅**当语境 = 工作区根时进表——预览全局根
  //              （state.preview = 全局根 label）或正开着某张 app: 卡（点击后 state.preview 已清，
  //              须靠 mgr id 认领，否则 tab 一点就消失）。普通 chat / 其它项目预览下都不显示。
  //              「应用已启用」由 appTabs() 自身过滤（applyAppTabs 按 APPS_ENABLED 取集）。
  //   EXT      = 当前预览项目申报的外部卡。**仅**当语境 = EXT 所属项目时进表——ctx = work 看工作项目、
  //              chat 看预览路由 state.preview（work 分支此时该行不可见，保留只为语境口径完整），
  //              或正开着该 label 的某张 ext 卡（同上的 mgr id 认领）。

  // 侧栏 tab 生成。契约 = <button class="mgr-tab" data-mgr="<id>">，两处消费点据此零改动：
  // app.js 的点击**委托**在 #mgr-tabs 容器上（本函数重渲不清事件）、route.js syncMgrTabs 按 state.mgr 切 .on。
  // 表变更后的重渲由 ext-runtime 经 setTabRefresh 回调本函数（见文件末的模块体注入）；**语境变更**由
  // 变更点显式调用本函数（applySbMode 的模式切换 / route 末尾 / 切项目），硬性不变量：不得由卡片注册
  // 或应用目录同步直接触发全局重渲，一律经本函数按当前语境取集。
  // mgrTabsHtml 缓存：算出的 HTML 无变化则零写 DOM——冗余调用（路由/5s 对账）不清掉 .on 高亮与焦点。
  let mgrTabsHtml = ''
  function renderMgrTabs() {
    const box = $('mgr-tabs')
    if (!box) return
    const onAppCard = typeof state.mgr === 'string' && state.mgr.startsWith('app:')
    const apps = isGlobalLabel(state.preview) || onAppCard ? appTabs() : []
    const el = extLabel()
    const ctx = state.sbMode === 'work' ? state.workProj : state.preview
    const onExtCard = !!el && typeof state.mgr === 'string' && state.mgr.startsWith('ext:' + el + ':')
    const ext = el && (onExtCard || ctx === el) ? extTabs() : []
    const html = CARDS.concat(apps, ext).filter((v) => v.tab)
      .map((v) => `<button class="mgr-tab" data-mgr="${v.id}" title="${esc(v.tip)}">${I[v.icon]}<span>${v.title}</span></button>`)
      .join('')
    if (html === mgrTabsHtml) return
    mgrTabsHtml = html
    box.innerHTML = html
  }
  // 启动引导：由入口（app.js 启动段）显式调用——各卡模块顶层 registerCard 已完成后再渲 tab，
  // 避免模块求值期副作用（registry 须排在卡模块之前，故不能在自身顶层调 renderMgrTabs）。
  function bootRegistry() { renderMgrTabs() }

  // ---------- 槽位（#chat-area = 无形槽）：同一时刻恰好一张卡 ----------
  // 管理/预览卡按需创建、离开即 .remove()——神经元图的 rAF 以 canvas.isConnected 自毁，
  // display:none 不释放；会话卡改 hidden（其 DOM 是单例，见上）。
  let curCardEl = null
  function makeCard(id) {
    const el = document.createElement('section')
    el.className = 'view-card mgr'
    el.dataset.view = id
    el.innerHTML = '<div class="view-scroll"><div class="view-body"></div></div>'
    return el
  }
  function showCard(el) {
    if (el === curCardEl) return el
    if (curCardEl && curCardEl !== sessionCard) curCardEl.remove()
    curCardEl = el
    sessionCard.hidden = el !== sessionCard
    if (el !== sessionCard) chatArea.appendChild(el)
    return el
  }
  // 同 id 的卡在场则复用：卡体整换但 .view-scroll 不动 ⇒ 滚动位置天然保持
  // （旧版进管理视图手写 scrollTop 存取块因此退场）
  function reuseOrMake(id) {
    if (curCardEl && curCardEl !== sessionCard && curCardEl.dataset.view === id) return curCardEl
    return makeCard(id)
  }
  // 切卡唯一入口：查卡 → 换卡 → 交给卡自己的 mount 渲染。未知 id 返回 null（不回落任何视图）。
  // 生命周期契约：切到**异**卡时先调离场卡的 deactivate()（同 id 复用/软重入不触发，避免整卡重渲
  // 误拆视图态）；会话卡的 deactivate=teardownSessionView（卸净会话态，见 session-card.js）。
  // mount 契约：mount(host, ctx)，host = 卡体元素(.view-body)，ctx = { id, payload, rerender }。
  // 卡内「整卡重渲」（插件卡切 kind/cat）走 ctx.rerender()，由本通道出，卡不反向依赖 registry。
  function openCard(id, payload) {
    const c = cardOf(id)
    if (!c) return null
    const prev = currentCardId()
    if (prev && prev !== id) cardOf(prev)?.deactivate?.()
    const el = showCard(c.card ? c.card() : reuseOrMake(c.id))
    if (c.mount) c.mount(el.querySelector('.view-body'), { id: c.id, payload, rerender: (p) => openCard(id, p) })
    return el
  }
  // 契约出口：卡外（如 preview-frame 硬进入分支）可显式卸某卡视图态，不必懂该卡的清理清单。
  function deactivateCard(id) {
    cardOf(id)?.deactivate?.()
  }
  // 当前槽内卡的 id（'session' 表示会话卡在场；无卡返回 null）。work 模式切入时据此判定是否需先退卡。
  function currentCardId() {
    if (curCardEl === sessionCard) return 'session'
    return curCardEl ? curCardEl.dataset.view : null
  }
  // 异步回程渲染守卫：本视图的卡仍在槽里才交出卡体（否则返回 null，调用方不渲染）
  function viewBody(id) {
    if (!curCardEl || curCardEl.dataset.view !== id) return null
    return curCardEl.querySelector('.view-body')
  }

  // 表变更 → 重渲：把本件的渲染口交给 ext-runtime（它不自 import 本件，避免 engine 内成环）。
  // 注入后 EXT/APP_TABS 的任何变更（网关清单回程、postMessage 注册、启用开关）即时刷侧栏。
  setTabRefresh(renderMgrTabs)

export {
  bootRegistry,
  currentCardId,
  deactivateCard,
  openCard,
  refreshCard,
  registerCard,
  renderMgrTabs,
  viewBody,
}
