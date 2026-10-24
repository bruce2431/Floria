// 评论卡 · 面板组件（#wk-cmt = ToolCapsule「评论」工具页的 pane）。
// 只管内容：页态与显隐归 ToolCapsule（work-preview.js applyPvTab），本组件不碰 #wk-cmt 的 hidden。

import { esc } from '../../../core/util.js'
import { state } from '../../../engine/state.js'
import { cmtFmtTime, cmtHookOpenFile, cmtRemove, cmtState, cmtToggleResolved } from '../../../feature/comment/comment-data.js'
/* @module views/cards/comment/comment-panel.js */
  let cmtFilter = 'all'   // 'all' | 'open'（只看未解决）
  let cmtMounted = false

  function cmtCmp(a, b) {
    const pa = String(a.path || '')
    const pb = String(b.path || '')
    if (pa !== pb) return pa < pb ? -1 : 1
    return (Number(a.l0) || 0) - (Number(b.l0) || 0)
  }
  function cmtItemHtml(c) {
    const n0 = Number(c.l0) || 0
    const n1 = Number(c.l1) || 0
    const loc = esc(String(c.path || '')) + (n0 ? ':' + n0 + (n1 && n1 !== n0 ? '-' + n1 : '') : '')
    return '<div class="cmt-item' + (c.resolved ? ' resolved' : '') + '" data-cid="' + esc(String(c.id || '')) + '">' +
      '<div class="cmt-head">' +
        '<button type="button" class="cmt-loc" data-cmtloc="' + esc(String(c.path || '')) + '">' + loc + '</button>' +
        '<span class="cmt-time">' + esc(cmtFmtTime(c.createdAt)) + '</span>' +
      '</div>' +
      (c.excerpt ? '<blockquote class="cmt-ex">' + esc(String(c.excerpt)) + '</blockquote>' : '') +
      '<div class="cmt-text">' + esc(String(c.body || '')) + '</div>' +
      '<div class="cmt-acts">' +
        '<button type="button" data-cmtact="resolve">' + (c.resolved ? '重开' : '解决') + '</button>' +
        '<button type="button" class="danger" data-cmtact="del">删除</button>' +
      '</div>' +
    '</div>'
  }
  function cmtRender() {
    const el = $('wk-cmt')
    if (!el) return
    if (!state.workProj) {
      el.innerHTML = '<div class="cmt-empty">未选择项目</div>'
      return
    }
    const { list: all, loading, err } = cmtState()
    if (loading) {
      el.innerHTML = '<div class="cmt-empty">加载中…</div>'
      return
    }
    if (err) {
      el.innerHTML = '<div class="cmt-empty">' + esc(err) + '</div>'
      return
    }
    const open = all.filter((c) => !c.resolved).length
    const head =
      '<div class="cmt-filters">' +
        '<button type="button" class="cmt-f' + (cmtFilter === 'all' ? ' on' : '') + '" data-cmtf="all">全部 ' + all.length + '</button>' +
        '<button type="button" class="cmt-f' + (cmtFilter === 'open' ? ' on' : '') + '" data-cmtf="open">未解决 ' + open + '</button>' +
      '</div>'
    const list = (cmtFilter === 'open' ? all.filter((c) => !c.resolved) : all).slice().sort(cmtCmp)
    const body = list.length
      ? list.map(cmtItemHtml).join('')
      : '<div class="cmt-empty">' + (all.length ? '没有未解决的评论' : '还没有评论。在文件里选中内容后添加。') + '</div>'
    el.innerHTML = head + '<div class="cmt-list">' + body + '</div>'
  }

  // 面板事件委托（一次）：容器 innerHTML 整体重渲，逐条绑定会被抹掉
  function cmtMount() {
    const el = $('wk-cmt')
    if (!el || cmtMounted) return
    cmtMounted = true
    el.addEventListener('click', (e) => {
      const f = e.target.closest('[data-cmtf]')
      if (f) {
        cmtFilter = f.dataset.cmtf === 'open' ? 'open' : 'all'
        cmtRender()
        return
      }
      const loc = e.target.closest('[data-cmtloc]')
      if (loc) {
        const item = loc.closest('[data-cid]')
        cmtHookOpenFile(loc.dataset.cmtloc, item ? item.dataset.cid : '')
        return
      }
      const act = e.target.closest('[data-cmtact]')
      const item = act && act.closest('[data-cid]')
      if (!item) return
      const c = cmtState().list.find((x) => String(x.id) === item.dataset.cid)
      if (!c) return
      if (act.dataset.cmtact === 'resolve') cmtToggleResolved(c)
      else if (act.dataset.cmtact === 'del') cmtRemove(c)
    })
  }

export {
  cmtMount,
  cmtRender,
}
