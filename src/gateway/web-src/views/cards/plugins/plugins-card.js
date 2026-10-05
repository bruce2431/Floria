// 插件卡（管理视图「插件」tab，插件 / 技能两态）（2026-10-01 卡片化：自 sidebar/mgr.js 迁出；
// 唯一手改处，web/app.js 为生成物）

import { I } from '../../../core/icons.js'
import { esc, saveMgrView, state } from '../../../core/state.js'
import { MGR, MGR_ERR, MGR_LOADING, loadMgrData, mgrColor } from '../../../sidebar/mgr-data.js'
  // ---------- 插件卡（插件 / 技能）----------
  // 每张卡自包含：mount(host, ctx) 只把内容写进交给它的卡体（host = .view-body）；卡内「整卡重渲」
  // （切 kind/cat）走 ctx.rerender() 由单一通道出，不反向依赖 registry / mgr.js。
  const pluginsCardDef = {
    id: 'plugins', title: '插件', tip: '插件 / 技能预览', icon: 'plug', tab: true,
    mount(body, ctx) { renderMgrPlugins(body, ctx) },
  }

  // 「插件/技能」卡体（id='plugins' 的默认形态，即侧栏第一 tab）
  function renderMgrPlugins(body, ctx) {
    const v = state.mgrView
    const kindName = v.kind === 'skills' ? '技能' : '插件'
    const sub =
      v.kind === 'skills'
        ? '个人 = 已安装技能（扫描便携根 .claude/skills）· 公开 = 官方市场技能'
        : '个人 = 已安装插件（扫描便携根 .claude/plugins）· 公开 = 官方市场插件'
    body.innerHTML =
      '<div class="mgr-pane">' +
      '<div class="mgr-top">' +
      '<div class="mgr-kind">' +
      `<button class="mgr-kind-btn${v.kind === 'plugins' ? ' on' : ''}" data-kind="plugins">插件</button>` +
      `<button class="mgr-kind-btn${v.kind === 'skills' ? ' on' : ''}" data-kind="skills">技能</button>` +
      '</div>' +
      '</div>' +
      `<div class="mgr-head"><h2 class="mgr-title">${kindName}</h2><div class="mgr-sub">${sub}</div></div>` +
      `<div class="mgr-search">${I.mag}<input id="mgr-q" type="text" placeholder="${v.kind === 'skills' ? '搜索技能…' : '搜索插件…'}" value="${esc(v.q)}"></div>` +
      '<div class="mgr-cats">' +
      `<button class="mgr-cat${v.cat === 'public' ? ' on' : ''}" data-cat="public">公开</button>` +
      `<button class="mgr-cat${v.cat === 'personal' ? ' on' : ''}" data-cat="personal">个人</button>` +
      '</div>' +
      '<div class="mgr-grid" id="mgr-grid"></div>' +
      '<div class="mgr-foot">数据源：网关 /gateway/plugins 实时扫描</div>' +
      '</div>'
    renderMgrGrid()
    loadMgrData(false) // 真实数据：首次进入拉取，刷新按钮 force 重拉
    const pane = body.querySelector('.mgr-pane')
    pane.querySelectorAll('.mgr-kind-btn').forEach((b) =>
      b.addEventListener('click', () => {
        v.kind = b.dataset.kind
        saveMgrView()
        ctx.rerender()
      }),
    )
    pane.querySelectorAll('.mgr-cat').forEach((b) =>
      b.addEventListener('click', () => {
        v.cat = b.dataset.cat
        saveMgrView()
        ctx.rerender()
      }),
    )
    const q = $('mgr-q')
    if (q) q.addEventListener('input', () => { v.q = q.value; saveMgrView(); renderMgrGrid() })
  }

  // 插件/技能卡片网格（按 kind + cat + 搜索词过滤；数据源 = 后端 /gateway/plugins）
  function renderMgrGrid() {
    const v = state.mgrView
    const grid = $('mgr-grid')
    if (!grid) return
    const label = v.kind === 'skills' ? '技能' : '插件'
    if (MGR_LOADING) {
      grid.innerHTML = '<div class="mgr-empty">加载真实清单中…</div>'
      return
    }
    if (MGR_ERR) {
      grid.innerHTML =
        '<div class="mgr-empty">清单加载失败：' + esc(MGR_ERR) +
        '<br><button class="mgr-retry" id="mgr-retry">重试</button></div>'
      const retry = $('mgr-retry')
      if (retry) retry.addEventListener('click', () => loadMgrData(true))
      return
    }
    const src = (MGR && MGR[v.kind] && MGR[v.kind][v.cat]) || []
    const q = (v.q || '').trim().toLowerCase()
    const rows = q ? src.filter((x) => x.n.toLowerCase().includes(q) || x.d.toLowerCase().includes(q)) : src
    grid.innerHTML = rows.length
      ? rows.map(mgrCardHtml).join('')
      : `<div class="mgr-empty">没有匹配的${label}</div>`
  }
  function mgrCardHtml(x) {
    const badge = x.inst ? '<span class="inst-badge">已安装</span>' : ''
    return (
      `<div class="mgr-card"><div class="mgr-ic" style="background:${mgrColor(x.n)}">${esc((x.n[0] || '?').toUpperCase())}</div>` +
      `<div class="mgr-meta"><div class="mgr-name">${esc(x.n)}${badge}</div><div class="mgr-desc">${esc(x.d)}</div></div>` +
      '<button class="mgr-more" title="更多">…</button></div>'
    )
  }

export {
  mgrCardHtml,
  pluginsCardDef,
  renderMgrGrid,
  renderMgrPlugins,
}
