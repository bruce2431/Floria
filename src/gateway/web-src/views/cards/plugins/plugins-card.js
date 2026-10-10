// 插件卡（管理视图「插件」tab：顶层三态 插件 / 技能 / 应用）（2026-10-01 卡片化：自 sidebar/mgr.js 迁出；
// 2026-10-10 增「应用」kind——工作区根申报的界面单元，点 + 启用；唯一手改处，web/app.js 为生成物）

import { I } from '../../../core/icons.js'
import { state } from '../../../engine/state.js'
import { esc } from '../../../core/util.js'
import { saveMgrView } from '../../../core/storage.js'
import { MGR, MGR_ERR, MGR_LOADING, loadMgrData, mgrColor } from '../../../sidebar/mgr-data.js'
import { appCatalog, isAppEnabled, setAppEnabled } from '../../registry.js'
/* @module views/cards/plugins/plugins-card.js */
  // ---------- 插件卡（插件 / 技能 / 应用）----------
  // 每张卡自包含：mount(host, ctx) 只把内容写进交给它的卡体（host = .view-body）；卡内「整卡重渲」
  // （切 kind/cat）走 ctx.rerender() 由单一通道出，不反向依赖 mgr.js。
  // 「应用」cat 的数据源与启停口在 registry（APP_CATALOG / setAppEnabled）——本卡只呈现列表与按钮；
  // 循环 import（registry → 本卡的 pluginsCardDef）是函数级调用，无求值期依赖。
  const pluginsCardDef = {
    id: 'plugins', title: '插件', tip: '插件 / 技能 / 应用', icon: 'plug', tab: true,
    mount(body, ctx) { renderMgrPlugins(body, ctx) },
  }

  // 「插件/技能/应用」卡体（id='plugins' 的默认形态，即侧栏第一 tab）
  function renderMgrPlugins(body, ctx) {
    const v = state.mgrView
    const isApps = v.kind === 'apps'
    const kindName = isApps ? '应用' : v.kind === 'skills' ? '技能' : '插件'
    const sub = isApps
      ? '工作区根 .claude/preview 申报的界面单元 · 点 + 启用后侧栏出现该应用 tab'
      : v.kind === 'skills'
        ? '个人 = 已安装技能（扫描便携根 .claude/skills）· 公开 = 官方市场技能'
        : '个人 = 已安装插件（扫描便携根 .claude/plugins）· 公开 = 官方市场插件'
    body.innerHTML =
      '<div class="mgr-pane">' +
      // 顶层切换＝「插件 / 技能 / 应用」三态：应用与插件/技能同轴，故并入同一段控件（原在公开/个人行）
      '<div class="mgr-top">' +
      '<div class="mgr-kind">' +
      `<button class="mgr-kind-btn${v.kind === 'plugins' ? ' on' : ''}" data-kind="plugins">插件</button>` +
      `<button class="mgr-kind-btn${v.kind === 'skills' ? ' on' : ''}" data-kind="skills">技能</button>` +
      `<button class="mgr-kind-btn${v.kind === 'apps' ? ' on' : ''}" data-kind="apps">应用</button>` +
      '</div>' +
      '</div>' +
      `<div class="mgr-head"><h2 class="mgr-title">${kindName}</h2><div class="mgr-sub">${sub}</div></div>` +
      `<div class="mgr-search">${I.mag}<input id="mgr-q" type="text" placeholder="${isApps ? '搜索应用…' : v.kind === 'skills' ? '搜索技能…' : '搜索插件…'}" value="${esc(v.q)}"></div>` +
      // 公开/个人只对「插件 / 技能」轴有意义，应用态不显示该行
      (isApps
        ? ''
        : '<div class="mgr-cats">' +
          `<button class="mgr-cat${v.cat === 'public' ? ' on' : ''}" data-cat="public">公开</button>` +
          `<button class="mgr-cat${v.cat === 'personal' ? ' on' : ''}" data-cat="personal">个人</button>` +
          '</div>') +
      '<div class="mgr-grid" id="mgr-grid"></div>' +
      `<div class="mgr-foot">${isApps ? '数据源：工作区根 .claude/preview（/gateway/preview-cards）' : '数据源：网关 /gateway/plugins 实时扫描'}</div>` +
      '</div>'
    renderMgrGrid()
    if (!isApps) loadMgrData(false) // 真实数据：首次进入拉取，刷新按钮 force 重拉（应用目录由 registry 拉）
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

  // 插件/技能/应用卡片网格（按 kind + cat + 搜索词过滤；应用数据源 = registry 的 APP_CATALOG）
  function renderMgrGrid() {
    const v = state.mgrView
    const grid = $('mgr-grid')
    if (!grid) return
    // 「应用」kind：列出工作区根申报的全部应用，右侧 + / ✓ 切换启用（启用即侧栏出现该应用 tab）
    if (v.kind === 'apps') {
      const q = (v.q || '').trim().toLowerCase()
      const rows = appCatalog().filter((a) => !q || a.title.toLowerCase().includes(q) || a.id.toLowerCase().includes(q))
      grid.innerHTML = rows.length
        ? rows.map(appCardHtml).join('')
        : '<div class="mgr-empty">没有匹配的应用（工作区根 .claude/preview/preview.json 未申报应用）</div>'
      grid.querySelectorAll('.app-toggle').forEach((b) =>
        b.addEventListener('click', () => {
          setAppEnabled(b.dataset.app, !isAppEnabled(b.dataset.app))
          renderMgrGrid() // 启用态只影响本网格按钮，局部重渲即可（侧栏 tab 由 setAppEnabled 内 renderMgrTabs 刷新）
        }),
      )
      return
    }
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
  // 应用胶囊：+（未启用）/ ✓（已启用）为唯一动作；已启用整卡不另设入口（点击 tab 在侧栏）
  function appCardHtml(a) {
    const on = isAppEnabled(a.id)
    return (
      `<div class="mgr-card"><div class="mgr-ic" style="background:${mgrColor(a.id)}">${esc((a.title[0] || '?').toUpperCase())}</div>` +
      `<div class="mgr-meta"><div class="mgr-name">${esc(a.title)}${on ? '<span class="inst-badge">已启用</span>' : ''}</div>` +
      `<div class="mgr-desc">${esc(a.id)} · ${esc(a.path)}</div></div>` +
      `<button class="mgr-more app-toggle${on ? ' on' : ''}" data-app="${esc(a.id)}" title="${on ? '停用（移除侧栏 tab）' : '启用（侧栏出现该应用 tab）'}">${on ? '✓' : '+'}</button></div>`
    )
  }

export {
  appCardHtml,
  mgrCardHtml,
  pluginsCardDef,
  renderMgrGrid,
  renderMgrPlugins,
}
