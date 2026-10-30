// 插件卡（管理视图「插件」tab：顶层三态 插件 / 技能 / 应用）（2026-10-01 卡片化：自 sidebar/mgr.js 迁出；
// 2026-10-10 增「应用」kind——工作区根申报的界面单元，点 + 启用；唯一手改处，web/app.js 为生成物）
// 2026-10-30 列表改 Codex 风格：动作位统一细线图标（未安装 + / 已安装 ✓），点整卡进入卡内详情页。

import { I } from '../../../core/icons.js'
import { state } from '../../../engine/state.js'
import { esc, toast } from '../../../core/util.js'
import { saveMgrView } from '../../../core/storage.js'
import { MGR, MGR_ERR, MGR_LOADING, loadMgrData, mgrColor } from '../../../sidebar/mgr-data.js'
import { registerCard } from '../../../engine/registry.js'
import { appCatalog, globalLabel, isAppEnabled, setAppEnabled, syncGlobalPlugins } from '../../../engine/ext-runtime.js'
import { apiUrl } from '../../../engine/gateway.js'
/* @module views/cards/plugins/plugins-card.js */
  // ---------- 插件卡（插件 / 技能 / 应用）----------
  // 每张卡自包含：mount(host, ctx) 只把内容写进交给它的卡体（host = .view-body）；卡内「整卡重渲」
  // （切 kind/cat）走 ctx.rerender() 由单一通道出，不反向依赖 mgr.js。
  // 「应用」cat 的数据源与启停口在 registry（APP_CATALOG / setAppEnabled）——本卡只呈现列表与按钮；
  // 循环 import（registry → 本卡的 pluginsCardDef）是函数级调用，无求值期依赖。
  // refresh 契约：卡外（mgr-data 拉完清单）经 refreshCard('plugins') 局部重渲本网格，不必懂本卡实现。
  // 详情页状态是卡内瞬态（MGR_DETAIL，模块级、不落盘）：切 kind/cat/搜索/刷新均回列表。
  let MGR_DETAIL = null // { kind, key }；key = 名称（插件/技能）或应用 id
  let PLUGINS_CTX = null // 当前挂载 ctx（列表/详情互跳的唯一重渲口）

  const pluginsCardDef = {
    id: 'plugins', title: '插件', tip: '插件 / 技能 / 应用', icon: 'plug', tab: true,
    mount(body, ctx) { PLUGINS_CTX = ctx; renderMgrPlugins(body, ctx) },
    refresh() { renderMgrGrid() },
  }
  registerCard(pluginsCardDef)

  // 「插件/技能/应用」卡体（id='plugins' 的默认形态，即侧栏第一 tab）
  function renderMgrPlugins(body, ctx) {
    if (MGR_DETAIL) return renderMgrDetail(body, ctx)
    const v = state.mgrView
    const isApps = v.kind === 'apps'
    const kindName = isApps ? '应用' : v.kind === 'skills' ? '技能' : '插件'
    const sub = isApps
      ? '工作区根 .claude/preview 申报的界面单元 · 启用后侧栏出现该应用 tab'
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

  // ---------- 列表 ----------
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
      bindGrid(grid)
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
    bindGrid(grid)
  }
  // 网格事件委托：点卡身进详情；点动作位（应用启停）只切启用态，不进详情
  function bindGrid(grid) {
    grid.querySelectorAll('.mgr-card').forEach((card) =>
      card.addEventListener('click', (e) => {
        const act = e.target.closest('.mgr-act-btn')
        const v = state.mgrView
        if (act) {
          if (v.kind !== 'apps' || !act.dataset.app) return
          e.stopPropagation()
          setAppEnabled(act.dataset.app, !isAppEnabled(act.dataset.app))
          renderMgrGrid() // 启用态只影响本网格按钮，局部重渲即可（侧栏 tab 由 setAppEnabled 内 renderMgrTabs 刷新）
          return
        }
        MGR_DETAIL = { kind: v.kind, key: card.dataset.key }
        if (PLUGINS_CTX) PLUGINS_CTX.rerender()
      }),
    )
  }
  // 插件/技能行：{n 名称, d 描述, v 版本, inst 是否已安装}
  function mgrCardHtml(x) {
    return (
      `<div class="mgr-card" data-key="${esc(x.n)}" data-kind="item">` +
      `<div class="mgr-ic" style="background:${mgrColor(x.n)}">${esc((x.n[0] || '?').toUpperCase())}</div>` +
      `<div class="mgr-meta"><div class="mgr-name">${esc(x.n)}</div><div class="mgr-desc">${esc(x.d || '暂无描述')}</div></div>` +
      actBtnHtml(!!x.inst, { title: x.inst ? '已安装' : '未安装' }) +
      '</div>'
    )
  }
  // 应用胶囊：+（未启用）/ ✓（已启用）为唯一动作；点卡身进详情。
  // 图标 = 应用自己申报的 `icon`（preview.json → normExtCards → APP_CATALOG，见 ext-decl.js），
  // 不按 id 上色块、不取标题首字（2026-10-17 用户定案：模型/神经/本地媒体资源库各用自己的 icon）。
  function appCardHtml(a) {
    const on = isAppEnabled(a.id)
    const ico = I[a.icon]
    const icEl = ico
      ? `<div class="mgr-ic ic">${ico}</div>`
      : `<div class="mgr-ic" style="background:${mgrColor(a.id)}">${esc((a.title[0] || '?').toUpperCase())}</div>`
    return (
      `<div class="mgr-card" data-key="${esc(a.id)}" data-kind="app">${icEl}` +
      `<div class="mgr-meta"><div class="mgr-name">${esc(a.title)}</div>` +
      `<div class="mgr-desc">${esc(a.path)}</div></div>` +
      actBtnHtml(on, { app: a.id, title: on ? '已启用（点击停用）' : '未启用（点击启用）' }) +
      '</div>'
    )
  }
  // 动作位（Codex 风）：细线 +（未安装/未启用）/ ✓（已安装/已启用）。
  // 插件/技能没有安装 API，此位是纯状态指示（点击落到卡身、进详情）；应用位是真开关（bindGrid 里拦）。
  function actBtnHtml(on, opt) {
    const app = opt && opt.app ? ` data-app="${esc(opt.app)}"` : ''
    return `<button class="mgr-act-btn${on ? ' on' : ''}"${app} title="${esc((opt && opt.title) || '')}">${on ? I.dshCheck : I.dshPlus}</button>`
  }

  // ---------- 详情页（卡内子页；返回 = 清 MGR_DETAIL 重渲） ----------
  function detailItem() {
    if (!MGR_DETAIL) return null
    const { kind, key } = MGR_DETAIL
    if (kind === 'apps') {
      const a = appCatalog().find((x) => x.id === key)
      if (!a) return null
      return {
        kind, key, ico: I[a.icon], color: mgrColor(a.id), initial: (a.title[0] || '?').toUpperCase(),
        name: a.title, desc: '', ver: '', inst: isAppEnabled(a.id),
        typeLabel: '应用', sourceLabel: '工作区根 .claude/preview 申报',
        path: a.path, appId: a.id, installedLabel: isAppEnabled(a.id) ? '已启用' : '未启用',
        repo: a.repo || '',
      }
    }
    const v = state.mgrView
    const src = (MGR && MGR[kind] && MGR[v.cat]) || []
    const x = src.find((r) => r.n === key)
    if (!x) return null
    const isSkill = kind === 'skills'
    const personal = v.cat === 'personal'
    return {
      kind, key, ico: '', color: mgrColor(x.n), initial: (x.n[0] || '?').toUpperCase(),
      name: x.n, desc: x.d || '', ver: x.v || '', inst: !!x.inst,
      typeLabel: isSkill ? '技能' : '插件',
      sourceLabel: personal ? '本地已安装' : '公开市场',
      path: personal ? `.claude/${isSkill ? 'skills' : 'plugins'}/${x.n}` : '',
      installedLabel: x.inst ? '已安装' : '未安装',
    }
  }

  function renderMgrDetail(body, ctx) {
    const it = detailItem()
    if (!it) { MGR_DETAIL = null; return renderMgrPlugins(body, ctx) }
    const icEl = it.ico
      ? `<div class="mgr-dl-ic ic">${it.ico}</div>`
      : `<div class="mgr-dl-ic" style="background:${it.color}">${esc(it.initial)}</div>`
    const info = [
      ['类型', it.typeLabel],
      ['来源', it.sourceLabel],
      ['版本', it.ver || '—'],
      ['状态', it.installedLabel],
    ]
    if (it.path) info.push(['位置', it.path])
    // 上游仓库（仅应用）：值可编辑，写回工作区根 .claude/preview/preview.json 的 cards[].repo。
    // 展示为链接只认 http(s)——用户输入的串不得直接进 href（javascript: 等）。
    const safeRepo = /^https?:\/\/[^\s]+$/i.test(it.repo || '') ? it.repo : ''
    const repoRow = it.appId
      ? '<div class="mgr-dl-kvrow mgr-repo-row"><dt>上游仓库</dt><dd class="mgr-repo-dd">' +
        (it.repo
          ? (safeRepo
            ? `<a class="mgr-repo-link" href="${esc(safeRepo)}" target="_blank" rel="noopener">${esc(it.repo)}</a>`
            : `<span class="mgr-repo-plain">${esc(it.repo)}</span>`)
          : '<span class="mgr-repo-empty">未填写</span>') +
        `<button class="mgr-repo-edit" type="button">${it.repo ? '修改' : '填写'}</button></dd></div>`
      : ''
    body.innerHTML =
      '<div class="mgr-pane mgr-detail">' +
      `<div class="mgr-crumb"><button class="mgr-back">${I.collapse}<span>${it.typeLabel}</span></button><span class="mgr-crumb-sep">/</span><span class="mgr-crumb-cur">${esc(it.name)}</span></div>` +
      '<div class="mgr-dl-hd">' + icEl +
      `<div class="mgr-dl-hdmeta"><h2 class="mgr-dl-name">${esc(it.name)}</h2>` +
      `<div class="mgr-dl-sub">${esc(it.typeLabel)} · ${esc(it.sourceLabel)}</div></div>` +
      actBtnHtml(it.inst, { app: it.appId, title: it.appId ? (it.inst ? '已启用（点击停用）' : '未启用（点击启用）') : it.installedLabel }) +
      '</div>' +
      `<p class="mgr-dl-desc">${esc(it.desc || '暂无介绍。')}</p>` +
      '<div class="mgr-dl-sec"><h3 class="mgr-dl-sech">信息</h3><dl class="mgr-dl-kv">' +
      info.map(([k, val]) => `<div class="mgr-dl-kvrow"><dt>${k}</dt><dd>${esc(val)}</dd></div>`).join('') +
      repoRow +
      '</dl></div>' +
      '</div>'
    bindRepoEdit(body, it, ctx)
    const back = body.querySelector('.mgr-back')
    if (back) back.addEventListener('click', () => { MGR_DETAIL = null; ctx.rerender() })
    // 应用详情页的动作位是真开关：切启用态后就地重渲详情（不回落列表）
    const act = body.querySelector('.mgr-act-btn')
    if (act && act.dataset.app) {
      act.addEventListener('click', () => {
        setAppEnabled(act.dataset.app, !isAppEnabled(act.dataset.app))
        ctx.rerender()
      })
    }
  }

  // 上游仓库编辑：点「填写/修改」就地换输入框；保存 = 读 preview.json（带 ETag 基线）→ 改该卡 repo →
  // /gateway/file/write 写回。冲突（409）不静默覆盖，提示后重渲（用户重新编辑即拿到新基线）。
  function bindRepoEdit(body, it, ctx) {
    const btn = body.querySelector('.mgr-repo-edit')
    if (!btn) return
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const dd = btn.closest('.mgr-repo-dd')
      if (!dd || dd.querySelector('.mgr-repo-in')) return
      dd.innerHTML =
        `<input class="mgr-repo-in" type="text" value="${esc(it.repo || '')}" placeholder="https://github.com/owner/repo" spellcheck="false">` +
        '<button class="mgr-repo-save" type="button">保存</button>' +
        '<button class="mgr-repo-cancel" type="button">取消</button>'
      const inp = dd.querySelector('.mgr-repo-in')
      inp.focus()
      inp.select()
      dd.querySelector('.mgr-repo-cancel').addEventListener('click', () => ctx.rerender())
      const save = async () => {
        const val = inp.value.trim()
        if (val && !/^https?:\/\/[^\s]+$/i.test(val)) { toast('仓库地址需以 http(s):// 开头'); return }
        try {
          await saveAppRepo(it.appId, val)
          // 顺序不可换：syncGlobalPlugins 会先用缓存快照整份替换 APP_CATALOG（旧值），
          // 故本地写入必须落在这之后、重渲之前；网络回包会再整份覆盖为真值（含新 repo）。
          syncGlobalPlugins()
          const a = appCatalog().find((x) => x.id === it.appId)
          if (a) a.repo = val
          toast(val ? '已保存上游仓库' : '已清除上游仓库')
          ctx.rerender()
        } catch (err) {
          toast('保存失败：' + (err && err.message ? err.message : String(err)))
        }
      }
      dd.querySelector('.mgr-repo-save').addEventListener('click', save)
      inp.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') { ev.preventDefault(); save() }
        else if (ev.key === 'Escape') { ev.preventDefault(); ctx.rerender() }
      })
    })
  }

  async function saveAppRepo(id, repo) {
    const label = globalLabel()
    const path = '.claude/preview/preview.json'
    const res = await fetch(apiUrl('/gateway/file?label=' + encodeURIComponent(label) + '&path=' + encodeURIComponent(path)))
    if (!res.ok) throw new Error('读取 preview.json 失败（HTTP ' + res.status + '）')
    const baseMtime = Number(String(res.headers.get('ETag') || '').replace(/"/g, '')) || undefined
    let json
    try { json = JSON.parse(await res.text()) } catch { throw new Error('preview.json 不是合法 JSON') }
    const cards = Array.isArray(json && json.cards) ? json.cards : []
    const card = cards.find((c) => c && typeof c === 'object' && c.id === id)
    if (!card) throw new Error('preview.json 里没有该应用')
    if (repo) card.repo = repo
    else delete card.repo
    const w = await fetch(apiUrl('/gateway/file/write'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label, path, content: JSON.stringify(json, null, 2) + '\n', baseMtime }),
    })
    if (!w.ok) {
      const d = await w.json().catch(() => ({}))
      throw new Error(w.status === 409 ? '文件已被他人修改，请重试' : (d.error || 'HTTP ' + w.status))
    }
  }

export {
  appCardHtml,
  mgrCardHtml,
  pluginsCardDef,
  renderMgrGrid,
  renderMgrPlugins,
}
