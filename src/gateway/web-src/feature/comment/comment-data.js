// 评论卡 · 数据层（2026-10-24 卡片化：自 sidebar/comments.js 拆出）。
// 一条评论 = 文件路径 + 行范围（l0/l1）+ 选中原文摘录（excerpt）+ 正文（body），锚点来自
// inputbar/quote.js 的 quoteSnapOfRange（kind:'file'）快照。存储 <项目根>/.claude/comments.json，
// 读写走网关 /gateway/comments（localGateway.ts 的 readProjectComments/writeProjectComments）。
// 前端为唯一写入方、每次**全量替换**（拉回 → 改内存副本 → 整份回写；列表规模小，避免增量合并歧义）。

import { needToken, apiUrl } from '../../engine/gateway.js'
import { state } from '../../engine/state.js'
import { toast } from '../../core/util.js'
/* @module feature/comment/comment-data.js */
  // 类名一律 cmt* 前缀：全部模块顶层声明共享一个 IIFE 作用域（见 probe-web-module-scope）。
  let cmtList = []        // 当前项目评论（服务端权威副本）
  let cmtProj = ''        // cmtList 归属项目 label
  let cmtLoaded = false    // cmtList 是否已为 cmtProj 拉取成功
  let cmtLoading = false
  let cmtErr = ''

  // 宿主能力注入（work 侧 / 预处理器侧不反向 import 卡）
  let cmtOpenFile = null
  let cmtEnsurePane = null
  let cmtRefreshMarks = null

  function cmtSetHooks(h) {
    if (!h) return
    if (typeof h.openFile === 'function') cmtOpenFile = h.openFile
    if (typeof h.ensurePane === 'function') cmtEnsurePane = h.ensurePane
    if (typeof h.refreshMarks === 'function') cmtRefreshMarks = h.refreshMarks
  }

  function cmtHookOpenFile(path, id) { if (cmtOpenFile) cmtOpenFile(path, id) }
  function cmtHookEnsurePane() { if (cmtEnsurePane) cmtEnsurePane() }

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

  // 读口（面板 / 卡 API 只读，不直取可变绑定）
  function cmtState() {
    return {
      list: cmtList,
      proj: cmtProj,
      loading: cmtLoading,
      err: cmtErr,
    }
  }
  function cmtRemove(c) {
    cmtMutate(() => { cmtList = cmtList.filter((x) => x !== c) })
  }
  function cmtToggleResolved(c) {
    cmtMutate(() => { c.resolved = !c.resolved })
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

export {
  cmtAdd,
  cmtFmtTime,
  cmtHookEnsurePane,
  cmtHookOpenFile,
  cmtId,
  cmtInvalidate,
  cmtLoad,
  cmtRangesFor,
  cmtRemove,
  cmtSetHooks,
  cmtState,
  cmtToggleResolved,
}
