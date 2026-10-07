// 视图注册表 + 槽位整卡切换（2026-09-23 视图卡化；2026-10-01 卡片化二期：一模块一卡组件 + 单通道；
// 唯一手改处，web/app.js 为生成物）
// 单一真源：每个卡组件（views/cards/<name>-card.js）导出描述符 { id, title, tip, icon, tab, mount }，
// 本表只做「按 id 取卡 → 挂进槽 → 调 mount」的编排，不写任何卡内容。
// 消费三处——①侧栏 tab 生成（renderMgrTabs，启动时按表注入 #mgr-tabs）②路由 #mgr/<id>（parseRoute 的
// r.mgr 即 id）③卡体渲染（openCard 把卡体交给卡自己的 mount）。会话卡以 tab:false 入表（侧栏条目构成
// 不动），但切卡路径与四张管理卡完全一致——槽位永远只有 openCard(id) 一条路径，无默认内容旁路。
// 外部（<项目>/.claude/preview/ 申报）卡另立**运行时表 EXT**，与第一方 CARDS 合流于 cardOf /
// renderMgrTabs 两个查询点，但分表存放——外部卡只有宿主生成的 iframe 壳（无 mount 代码），
// 外部永不获得在宿主 DOM 执行的能力（SPEC-视图卡化 §7 边界）。

import { I } from '../core/icons.js'
import { chatArea, sessionCard } from '../engine/state.js'
import { esc } from '../core/util.js'
import { patchUI, readUI } from '../core/storage.js'
import { sessionCardDef } from './cards/session/session-card.js'
import { neuronsCardDef } from './cards/neurons/neurons-card.js'
import { pluginsCardDef } from './cards/plugins/plugins-card.js'
import { projectsCardDef } from './cards/projects/projects-card.js'
import { modelsCardDef } from './cards/models/models-card.js'
import { previewCardDef } from './cards/preview/preview-card.js'
import { mountExtCard, normExtCards, normQuoteActions } from './cards/ext/ext-card.js'
/* @module views/registry.js */

  // ---------- 卡片注册表 ----------
  // 会话卡描述符自 views/cards/session/session-card.js 引入（一模块一卡；card() 返回既存单例
  // #session-card，deactivate=teardownSessionView）；其余四张管理卡同态各自成模块。
  const CARDS = [sessionCardDef, pluginsCardDef, projectsCardDef, modelsCardDef, neuronsCardDef, previewCardDef]
  const cardOf = (id) => CARDS.find((c) => c.id === id) || EXT.find((c) => c.id === id)

  // ---------- 运行时外部卡表（卡片化二期）----------
  // 外部（<项目>/.claude/preview/ 申报）卡只活在这里，与第一方 CARDS 分表存放：外部卡没有 mount
  // 代码，只有宿主生成的 iframe 壳（views/cards/ext/ext-card.js）——外部永不获得在宿主 DOM 执行的能力。
  // id 命名空间 `ext:<label>:<id>`（第一方 id 全是裸词，零撞车）；EXT_LABEL 记录本表属于哪个项目。
  // 两条来源汇入 registerExtCards：①网关 /gateway/preview-cards（preview.json 静态清单，replace=true
  // 整份替换）②预览页 postMessage floria-cards-register（同 id 覆盖 + 追加，页面最了解自己有什么卡）。
  // 生命周期不变量：外部卡集恒属于「当前 .preview-frame 所指项目」——异 label 硬挂载 / 文档重挂即
  // 清（清点收在 views/cards/preview/preview-card.js 的 syncExtCards，与 clearRailExt 同点）；**离开预览路由
  // 不清**，否则用户点外部卡 tab 的瞬间卡就被清没了。
  let EXT = []
  let EXT_LABEL = ''
  function registerExtCards(label, cards, replace) {
    if (!label) return
    if (replace || EXT_LABEL !== label) { EXT = []; EXT_LABEL = label }
    const list = normExtCards(cards)
    // 网关权威快照（replace=true）落盘：EXT 只活在内存里，刷新即空 ⇒ 不落盘则刷新后
    // 外部卡 tab 缺失、/manage/ext:<label>:<id> 直进无卡可解析（见下方 hydrateExtCards）。
    // postMessage 增量注册不落盘——那是预览页的实时补充，混进快照会让缓存随文档生命周期漂移。
    if (replace) persistExtDecls(label, { cards: list })
    for (const c of list) {
      const id = `ext:${label}:${c.id}`
      EXT = EXT.filter((v) => v.id !== id) // 同 id 覆盖，不改位置语义（后注册者在列表尾）
      EXT.push({
        id,
        title: c.title,
        tip: `${c.title} · ${label}`,
        icon: I[c.icon] ? c.icon : 'plug',
        tab: c.tab,
        mount: (body) => mountExtCard(body, label, c),
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

  // ---------- 外部卡申报的持久化（与 work/管理态同一条 floria-ui-v1 链，分表存 extDecls）----------
  // 真源仍是网关（preview.json）：缓存只是「上次所见」的快照，启动/切项目时先 hydrate 回来让
  // tab 与路由即刻可用，随后 syncExtCards 拉新整份覆盖（preview-card.js）。无缓存（首次访问）
  // = 空表，照旧等网络清单——不猜不兜底。
  function persistExtDecls(label, patch) {
    if (!label) return
    const d = readUI() || {}
    const all = d.extDecls && typeof d.extDecls === 'object' ? { ...d.extDecls } : {}
    all[label] = { ...(all[label] || {}), ...patch }
    patchUI({ extDecls: all })
  }
  // 缓存 → 运行时表（同步、无网络）。放表而不清表：hydrate 只认「当前该项目」这一份，
  // 异 label 清理仍归 syncExtCards / clearExtCards（不新增第二个清点）。
  function hydrateExtCards(label) {
    if (!label) return
    const d = readUI()
    const e = d && d.extDecls ? d.extDecls[label] : null
    if (!e || typeof e !== 'object') return
    if (Array.isArray(e.cards)) registerExtCards(label, e.cards, true)
    if (Array.isArray(e.quoteActions)) registerQuoteActions(label, e.quoteActions)
  }
  // `ext:<label>:<cardId>` → 缓存恢复。卡 id 不含冒号（normExtCards 正则 [a-zA-Z0-9_-]{1,32}），
  // 故 label = 最后一个冒号之前那段。路由恢复用（刷新直进 /manage/ext:…）。
  function hydrateExtCardId(id) {
    if (typeof id !== 'string' || !id.startsWith('ext:')) return false
    const i = id.lastIndexOf(':')
    if (i < 4) return false
    hydrateExtCards(id.slice(4, i))
    return true
  }

  // ---------- 项目申报的浮窗动作表（2026-09-28）----------
  // preview.json 的 quoteActions 段 → 宿主侧常驻表。选中引用浮窗（inputbar/quote.js）打开时与内置
  // 动作合流渲染。与 EXT 同一份申报来源、同一生命周期与清理点（preview-card.js syncExtCards /
  // mountPreview 重挂）——不变量：动作表恒属于「当前 .preview-frame 所指项目」。
  // 动作是纯数据、无 mount 代码：点击只把 id 回发预览页（floria-quote-action），执行留在项目页面里。
  // 本版唯一来源 = preview.json 静态段（不做 postMessage 实时注册）。
  let QACTIONS = []
  let QACTIONS_LABEL = ''
  function registerQuoteActions(label, actions) {
    if (!label) return
    QACTIONS = normQuoteActions(actions)
    QACTIONS_LABEL = label
    persistExtDecls(label, { quoteActions: QACTIONS }) // 与 EXT 同一份申报、同一份缓存（同清同存）
  }
  function clearQuoteActions() {
    if (!QACTIONS.length && !QACTIONS_LABEL) return
    QACTIONS = []
    QACTIONS_LABEL = ''
  }
  function quoteActions() {
    return QACTIONS
  }

  // 侧栏 tab 生成。契约 = <button class="mgr-tab" data-mgr="<id>">，两处消费点据此零改动：
  // app.js 的点击**委托**在 #mgr-tabs 容器上（本函数重渲不清事件）、route.js syncMgrTabs 按 state.mgr 切 .on。
  function renderMgrTabs() {
    const box = $('mgr-tabs')
    if (!box) return
    box.innerHTML = CARDS.concat(EXT).filter((v) => v.tab)
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
  // 契约出口：卡外（如 preview-card 硬进入分支）可显式卸某卡视图态，不必懂该卡的清理清单。
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

  renderMgrTabs()

export {
  CARDS,
  clearExtCards,
  clearQuoteActions,
  currentCardId,
  deactivateCard,
  hydrateExtCardId,
  hydrateExtCards,
  openCard,
  quoteActions,
  registerExtCards,
  registerQuoteActions,
  renderMgrTabs,
  viewBody,
}
