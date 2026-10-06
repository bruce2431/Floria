// 项目评论批注（2026-10-06 work 右栏评论 tab + 选区「添加评论」浮层）（唯一手改处，web/app.js 为生成物）

import { needToken, apiUrl } from '../core/gateway.js'
import { esc, state, toast } from '../core/state.js'
  // ---------- 项目评论批注（work 右栏评论 tab） ----------
  // 一条评论 = 文件路径 + 行范围（l0/l1）+ 选中原文摘录（excerpt）+ 正文（body），锚点来自
  // inputbar/quote.js 的 quoteSnapOfRange（kind:'file'）快照。存储 <项目根>/.claude/comments.json，
  // 读写走网关 /gateway/comments（localGateway.ts 的 readProjectComments/writeProjectComments）。
  // 前端为唯一写入方、每次**全量替换**（拉回 → 改内存副本 → 整份回写；列表规模小，避免增量合并歧义）。
  //
  // 与 work.js 解耦（不 import，回调注册）：work.js 在 mountWork 里调 cmtSetHooks 注册
  //   openFile   = 点评论定位 → 打开文件（openWorkFile）
  //   ensurePane = 选区「添加评论」时确保右栏在场且切到评论 tab
  // quote.js 只 import openCommentComposer（选区浮窗「添加评论」行 → 本模块浮层）。
  // 类名一律 cmt* 前缀：全部模块顶层声明共享一个 IIFE 作用域（见 probe-web-module-scope）。
  let cmtList = []        // 当前项目评论（服务端权威副本）
  let cmtProj = ''        // cmtList 归属项目 label
  let cmtLoaded = false    // cmtList 是否已为 cmtProj 拉取成功
  let cmtLoading = false
  let cmtErr = ''
  let cmtFilter = 'all'   // 'all' | 'open'（只看未解决）
  let cmtPop = null       // 选区「添加评论」浮层
  let cmtMounted = false
  let cmtOpenFile = null
  let cmtEnsurePane = null
  let cmtRefreshMarks = null

  function cmtSetHooks(h) {
    if (!h) return
    if (typeof h.openFile === 'function') cmtOpenFile = h.openFile
    if (typeof h.ensurePane === 'function') cmtEnsurePane = h.ensurePane
    if (typeof h.refreshMarks === 'function') cmtRefreshMarks = h.refreshMarks
  }

  // 渲染同步：面板 + 原文标记（work.js 阅读态按 cmtRangesFor 打标的唯一重绘入口）
  function cmtAfterChange() {
    cmtRender()
    if (cmtRefreshMarks) cmtRefreshMarks()
  }

  // 供 work.js 在原文（阅读态）打标记：当前项目内、指定文件的评论行范围（1 基源行号）
  function cmtRangesFor(path) {
    const p = String(path || '').replace(/\\/g, '/')
    if (!p || !cmtProj) return []
    return cmtList
      .filter(
        (c) =>
          c && typeof c === 'object' &&
          String(c.path || '').replace(/\\/g, '/') === p &&
          Number(c.l1) >= 1,
      )
      .map((c) => ({
        id: String(c.id || ''),
        l0: Number(c.l0) || 1,
        l1: Number(c.l1) || Number(c.l0) || 1,
        resolved: !!c.resolved,
      }))
  }

  // 换项目 / 退 work：作废内存副本（下次 cmtLoad 重新拉）
  function cmtInvalidate() {
    cmtList = []
    cmtProj = ''
    cmtLoaded = false
    cmtLoading = false
    cmtErr = ''
    if (cmtRefreshMarks) cmtRefreshMarks() // 换项目：清掉上一项目的原文标记
  }

  function cmtId() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
  }
  function cmtFmtTime(iso) {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    const p = (n) => String(n).padStart(2, '0')
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }

  async function cmtFetch(proj) {
    if (!proj || needToken()) {
      cmtLoading = false
      return
    }
    cmtLoading = true
    cmtErr = ''
    cmtRender()
    try {
      const res = await fetch(apiUrl('/gateway/comments?label=' + encodeURIComponent(proj)))
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || '加载失败')
      cmtList = (Array.isArray(data.comments) ? data.comments : []).filter((c) => c && typeof c === 'object' && !Array.isArray(c))
      cmtProj = proj
      cmtLoaded = true
    } catch (e) {
      cmtErr = e.message || String(e)
      cmtLoaded = false
    } finally {
      cmtLoading = false
      cmtAfterChange()
    }
  }

  // 已有当前项目副本就直接用（免重复请求）；换项目才拉
  async function cmtLoad(proj) {
    if (!proj) {
      cmtInvalidate()
      cmtRender()
      return
    }
    if (cmtLoaded && proj === cmtProj) return
    await cmtFetch(proj)
  }

  // 整份回写（唯一写口）：cmtList 当前值 → 服务端。失败 toast 并返回 false（调用方决定是否回滚内存副本）。
  async function cmtSave() {
    const proj = state.workProj
    if (!proj) return false
    try {
      const res = await fetch(apiUrl('/gateway/comments'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: proj, comments: cmtList }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.ok) throw new Error(data.error || '保存失败')
      return true
    } catch (e) {
      toast('评论保存失败：' + (e.message || e))
      return false
    }
  }

  // 内存副本改 → 渲染 → 回写；回写失败回滚（不静默丢改动）
  async function cmtMutate(fn) {
    const prev = cmtList
    fn()
    cmtAfterChange()
    if (!(await cmtSave())) {
      cmtList = prev
      cmtAfterChange()
    }
  }

  async function cmtAdd(proj, entry) {
    if (!proj) return false
    if (!(cmtLoaded && cmtProj === proj)) await cmtFetch(proj)
    if (cmtProj !== proj) return false
    cmtList.push(entry)
    cmtAfterChange()
    if (!(await cmtSave())) {
      cmtList = cmtList.filter((c) => c !== entry)
      cmtAfterChange()
      return false
    }
    return true
  }

  // ---------- 评论面板渲染（#wk-cmt，work.js setPvTab('comments') 调）----------
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
    if (cmtLoading) {
      el.innerHTML = '<div class="cmt-empty">加载中…</div>'
      return
    }
    if (cmtErr) {
      el.innerHTML = '<div class="cmt-empty">' + esc(cmtErr) + '</div>'
      return
    }
    const open = cmtList.filter((c) => !c.resolved).length
    const head =
      '<div class="cmt-filters">' +
        '<button type="button" class="cmt-f' + (cmtFilter === 'all' ? ' on' : '') + '" data-cmtf="all">全部 ' + cmtList.length + '</button>' +
        '<button type="button" class="cmt-f' + (cmtFilter === 'open' ? ' on' : '') + '" data-cmtf="open">未解决 ' + open + '</button>' +
      '</div>'
    const list = (cmtFilter === 'open' ? cmtList.filter((c) => !c.resolved) : cmtList).slice().sort(cmtCmp)
    const body = list.length
      ? list.map(cmtItemHtml).join('')
      : '<div class="cmt-empty">' + (cmtList.length ? '没有未解决的评论' : '还没有评论。在文件里选中内容后添加。') + '</div>'
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
        if (cmtOpenFile) cmtOpenFile(loc.dataset.cmtloc, item ? item.dataset.cid : '')
        return
      }
      const act = e.target.closest('[data-cmtact]')
      const item = act && act.closest('[data-cid]')
      if (!item) return
      const c = cmtList.find((x) => String(x.id) === item.dataset.cid)
      if (!c) return
      if (act.dataset.cmtact === 'resolve') cmtMutate(() => { c.resolved = !c.resolved })
      else if (act.dataset.cmtact === 'del') cmtMutate(() => { cmtList = cmtList.filter((x) => x !== c) })
    })
  }

  // ---------- 选区「添加评论」浮层（quote.js 的「添加评论」行 → 这里）----------
  function cmtClosePop() {
    if (cmtPop) { cmtPop.remove(); cmtPop = null }
  }
  function openCommentComposer(snap) {
    if (!snap || snap.kind !== 'file' || !snap.file) return
    if (cmtEnsurePane) cmtEnsurePane() // 落点可见：右栏切到评论 tab（注释提交后立刻在列表里看到）
    cmtClosePop()
    const pop = document.createElement('div')
    pop.className = 'cmt-pop'
    const n0 = Number(snap.l0) || 0
    const n1 = Number(snap.l1) || 0
    const loc = esc(snap.file) + (n0 ? ' · ' + n0 + (n1 && n1 !== n0 ? '-' + n1 : '') + ' 行' : '')
    pop.innerHTML =
      '<div class="cmp-loc">' + loc + '</div>' +
      '<blockquote class="cmp-ex">' + esc(String(snap.text || '').slice(0, 300)) + '</blockquote>' +
      '<textarea class="cmp-in" placeholder="添加评论…" rows="3"></textarea>' +
      '<div class="cmp-bar"><button type="button" class="cmp-cancel">取消</button><button type="button" class="cmp-ok">评论</button></div>'
    document.body.appendChild(pop)
    const r = snap.rect || { left: 0, bottom: 0 }
    const w = pop.offsetWidth
    const h = pop.offsetHeight
    pop.style.left = Math.round(Math.max(8, Math.min(r.left, window.innerWidth - w - 8))) + 'px'
    pop.style.top = Math.round(Math.max(8, Math.min(r.bottom + 6, window.innerHeight - h - 8))) + 'px'
    const ta = pop.querySelector('.cmp-in')
    ta.focus()
    pop.addEventListener('mousedown', (e) => e.stopPropagation()) // 浮层内按下不算「点外部」
    pop.querySelector('.cmp-cancel').addEventListener('click', cmtClosePop)
    const submit = async () => {
      const body = ta.value.trim()
      if (!body) { ta.focus(); return }
      const entry = {
        id: cmtId(),
        path: snap.file,
        l0: n0,
        l1: n1,
        excerpt: String(snap.text || '').slice(0, 300),
        body,
        author: 'me',
        createdAt: new Date().toISOString(),
        resolved: false,
      }
      cmtClosePop()
      if (await cmtAdd(snap.proj || state.workProj, entry)) toast('已添加评论')
    }
    pop.querySelector('.cmp-ok').addEventListener('click', submit)
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit() }
      else if (e.key === 'Escape') { e.preventDefault(); cmtClosePop() }
    })
    cmtPop = pop
  }

  // 点浮层外 / 滚动 / Esc → 关（fixed 浮层会漂离锚点；与 quote.js 浮窗同策略）
  document.addEventListener('mousedown', (e) => { if (cmtPop && !cmtPop.contains(e.target)) cmtClosePop() })
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && cmtPop) cmtClosePop() })
  window.addEventListener('scroll', () => { if (cmtPop) cmtClosePop() }, { passive: true, capture: true })

export {
  cmtClosePop,
  cmtInvalidate,
  cmtLoad,
  cmtMount,
  cmtRangesFor,
  cmtRender,
  cmtSetHooks,
  openCommentComposer,
}
