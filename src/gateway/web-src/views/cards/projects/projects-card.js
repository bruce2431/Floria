// 项目卡（管理视图「项目」tab）（2026-10-01 卡片化：自 sidebar/mgr.js 迁出；唯一手改处，web/app.js 为生成物）

import { navigate } from '../../../chat/route.js'
import { I } from '../../../core/icons.js'
import { hashOf } from '../../../engine/sessions.js'
import { ALL, state } from '../../../engine/state.js'
import { esc, isMobile } from '../../../core/util.js'
import { saveMgrView } from '../../../core/storage.js'
import { mgrColor } from '../../../sidebar/mgr-data.js'
import { closePanel } from '../../../engine/panel.js'
/* @module views/cards/projects/projects-card.js */
  // ---------- 项目卡 ----------
  // 数据源 = 已加载会话 ALL 按 projectLabel 分组（projectScope==='project'），不另起后端接口。
  // 点项目胶囊一律进预览（hash 路由 #preview/<label>），无 rerender 需求。
  const projectsCardDef = {
    id: 'projects', title: '项目', tip: '项目管理', icon: 'folder', tab: true,
    mount(body) { renderMgrProjects(body) },
  }

  // 每个项目胶囊占据一整行（数据源 = 会话按 projectLabel 分组）
  function renderMgrProjects(body) {
    const projCount = new Set(ALL.filter((s) => s.projectScope === 'project' && s.projectLabel).map((s) => s.projectLabel)).size
    body.innerHTML =
      '<div class="mgr-pane">' +
      '<div class="mgr-head"><h2 class="mgr-title">项目</h2>' +
      '<div class="mgr-sub">按项目文件夹分组 · 会话按最近活跃排序</div></div>' +
      `<div class="mgr-search">${I.mag}<input id="mgr-pq" type="text" placeholder="搜索项目…" value="${esc(state.mgrView.q)}"></div>` +
      `<div class="mgr-cats"><span class="mgr-cat on">共 ${projCount} 个项目</span></div>` +
      '<div class="mgr-list" id="mgr-list"></div>' +
      '<div class="mgr-foot">数据源：会话按项目分组（/gateway/sessions）</div>' +
      '</div>'
    renderMgrProj()
    const pq = $('mgr-pq')
    if (pq) pq.addEventListener('input', () => { state.mgrView.q = pq.value; saveMgrView(); renderMgrProj() })
  }

  // 项目列表（仿照插件布设，每个项目胶囊占据一整行）
  function renderMgrProj() {
    const list = $('mgr-list')
    if (!list) return
    const q = (state.mgrView.q || '').trim().toLowerCase()
    const byProject = {}
    for (const s of ALL) if (s.projectScope === 'project' && s.projectLabel) (byProject[s.projectLabel] = byProject[s.projectLabel] || []).push(s)
    const labels = Object.keys(byProject).filter((l) => !q || l.toLowerCase().includes(q))
    // 按项目最近活跃时间降序（同 renderProject 排序）
    labels.sort((a, b) => {
      const la = Math.max(0, ...byProject[a].map((s) => s.updatedAt))
      const lb = Math.max(0, ...byProject[b].map((s) => s.updatedAt))
      return lb - la
    })
    // 该项目是否带 .claude/preview/（会话 preview 标志由后端 findProjects.hasPreview 透传）
    const hasPreview = (l) => ALL.some((s) => s.projectScope === 'project' && s.projectLabel === l && s.preview)
    list.innerHTML = labels.length
      ? labels.map((l) => mgrProjHtml(l, byProject[l], hasPreview(l))).join('')
      : '<div class="mgr-empty">' + (q ? '没有匹配的项目' : '暂无项目会话') + '</div>'
    list.querySelectorAll('.mgr-proj').forEach((b) =>
      b.addEventListener('click', () => {
        // 点项目胶囊一律进预览：带 .claude/preview 加载真预览页；不带 → 默认项目主页
        // （GitHub 仓库风格，web/default-preview/，由网关 /gateway/project 拉数据）。
        if (b.dataset.label) {
          // 进预览走 hash 路由（#preview/<label>），刷新后可恢复当前预览页
          navigate('#preview/' + encodeURIComponent(b.dataset.label))
          if (isMobile()) closePanel()
          return
        }
        const hash = b.dataset.hash
        if (!hash) return
        navigate('#/' + encodeURIComponent(hash))
        if (isMobile()) closePanel()
      }),
    )
  }
  function mgrProjHtml(label, chats, hasPreview) {
    const latest = [...chats].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    const n = chats.length
    return (
      `<button class="mgr-proj" data-hash="${latest ? esc(hashOf(latest)) : ''}" data-label="${esc(label)}" data-preview="${hasPreview ? '1' : '0'}" title="${esc(label)} · ${n} 个会话（点击进入项目主页）">` +
      `<span class="mgr-ic" style="background:${mgrColor(label)}">${I.folder}</span>` +
      `<span class="mgr-meta"><span class="mgr-name">${esc(label)}${hasPreview ? '<span class="pv-badge">预览</span>' : ''}<span class="inst-badge">${n} 个会话</span></span>` +
      `<span class="mgr-desc">${hasPreview ? '点击打开项目预览页（.claude/preview）' : '点击打开默认项目主页（无预览页）'}</span></span>` +
      '<span class="mgr-more" title="打开">›</span></button>'
    )
  }

export {
  mgrProjHtml,
  projectsCardDef,
  renderMgrProj,
  renderMgrProjects,
}
