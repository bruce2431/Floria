// 视图注册表 + 槽位整卡切换（2026-09-23 视图卡化；唯一手改处，web/app.js 为生成物）
// 单一真源：tab 的 id / 标题 / 图标 / 渲染函数只写在这一张表里，消费三处——①侧栏 tab 生成
// （renderMgrTabs，启动时按表注入 #mgr-tabs）②路由 #mgr/<id>（parseRoute 的 r.mgr 即 id）
// ③卡体渲染（render 写进本视图的 .view-body）。会话卡以 tab:false 入表（侧栏条目构成不动），
// 但切卡路径与四张管理卡完全一致——槽位永远只有 showView(id) 一条路径，无默认内容旁路。
// 卡片化二期：外部（<项目>/.claude/preview/ 申报）卡另立**运行时表 EXT**，与第一方 VIEWS 合流于
// viewOf / renderMgrTabs 两个查询点，但分表存放——外部卡只有宿主生成的 iframe 壳（无 render 代码），
// 外部永不获得在宿主 DOM 执行的能力（SPEC-视图卡化 §7 边界）。

import { I } from '../core/icons.js'
import { chatArea, esc, sessionCard } from '../core/state.js'
import { mountExtCard, normExtCards } from './ext-card.js'

  // ---------- 视图注册表 ----------
  const VIEWS = [
    // 会话卡常驻 index.html（承载 #messages/#input-wrap/#char 等模块级 const 引用的单例 DOM，
    // 不能销毁重建）→ card() 直接返回既存元素
    { id: 'session', title: '会话', tip: '会话', icon: 'logo', tab: false, card: () => sessionCard },
    { id: 'plugins', title: '插件', tip: '插件 / 技能预览', icon: 'plug', tab: true, render: renderMgrPlugins },
    { id: 'projects', title: '项目', tip: '项目管理', icon: 'folder', tab: true, render: renderMgrProjects },
    { id: 'models', title: '模型', tip: '模型配置', icon: 'chip', tab: true, render: renderMgrModels },
    { id: 'neurons', title: '神经', tip: '神经元视图（mem→认知→社群节点图）', icon: 'brain', tab: true, render: renderMgrNeurons },
  ]
  const viewOf = (id) => VIEWS.find((v) => v.id === id) || EXT.find((v) => v.id === id)

  // ---------- 运行时外部卡表（卡片化二期）----------
  // 外部（<项目>/.claude/preview/ 申报）卡只活在这里，与第一方 VIEWS 分表存放：外部卡没有 render
  // 代码，只有宿主生成的 iframe 壳（views/ext-card.js）——外部永不获得在宿主 DOM 执行的能力。
  // id 命名空间 `ext:<label>:<id>`（第一方 id 全是裸词，零撞车）；EXT_LABEL 记录本表属于哪个项目。
  // 两条来源汇入 registerExtCards：①网关 /gateway/preview-cards（preview.json 静态清单，replace=true
  // 整份替换）②预览页 postMessage floria-cards-register（同 id 覆盖 + 追加，页面最了解自己有什么卡）。
  // 生命周期不变量：外部卡集恒属于「当前 .preview-frame 所指项目」——异 label 硬挂载 / 文档重挂即
  // 清（清点收在 sidebar/mgr.js 的 syncExtCards，与 clearRailExt 同点）；**离开预览路由不清**，
  // 否则用户点外部卡 tab 的瞬间卡就被清没了。
  let EXT = []
  let EXT_LABEL = ''
  function registerExtCards(label, cards, replace) {
    if (!label) return
    if (replace || EXT_LABEL !== label) { EXT = []; EXT_LABEL = label }
    for (const c of normExtCards(cards)) {
      const id = `ext:${label}:${c.id}`
      EXT = EXT.filter((v) => v.id !== id) // 同 id 覆盖，不改位置语义（后注册者在列表尾）
      EXT.push({
        id,
        title: c.title,
        tip: `${c.title} · ${label}`,
        icon: I[c.icon] ? c.icon : 'plug',
        tab: c.tab,
        render: (body) => mountExtCard(body, label, c),
      })
    }
    renderMgrTabs()
  }
  function clearExtCards() {
    if (!EXT.length && !EXT_LABEL) return
    EXT = []
    EXT_LABEL = ''
    renderMgrTabs()
  }

  // 侧栏 tab 生成。契约 = <button class="mgr-tab" data-mgr="<id>">，两处消费点据此零改动：
  // app.js 的点击**委托**在 #mgr-tabs 容器上（本函数重渲不清事件）、route.js syncMgrTabs 按 state.mgr 切 .on。
  function renderMgrTabs() {
    const box = $('mgr-tabs')
    if (!box) return
    box.innerHTML = VIEWS.concat(EXT).filter((v) => v.tab)
      .map((v) => `<button class="mgr-tab" data-mgr="${v.id}" title="${esc(v.tip)}">${I[v.icon]}<span>${v.title}</span></button>`)
      .join('')
  }

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
  // 切卡唯一入口：查表 → 换卡 → 渲染。未知 id 返回 null（不回落任何视图）
  function showView(id) {
    const v = viewOf(id)
    if (!v) return null
    const el = showCard(v.card ? v.card() : reuseOrMake(v.id))
    if (v.render) v.render(el.querySelector('.view-body'))
    return el
  }
  // 预览卡：非注册表条目（项目预览走 iframe 通道，与内部视图注册表不合并，见 SPEC-视图卡化 §7）
  function showPreviewCard() {
    return showCard(reuseOrMake('preview'))
  }
  // 异步回程渲染守卫：本视图的卡仍在槽里才交出卡体（否则返回 null，调用方不渲染）
  function viewBody(id) {
    if (!curCardEl || curCardEl.dataset.view !== id) return null
    return curCardEl.querySelector('.view-body')
  }

  renderMgrTabs()

export {
  VIEWS,
  clearExtCards,
  registerExtCards,
  renderMgrTabs,
  showPreviewCard,
  showView,
  viewBody,
  viewOf,
}
