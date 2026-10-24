// 编辑区渲染与读写：原文评论标记 / renderEditor / 读文件 / 自动保存 / 冲突处置 / 开关文件。（拆自 sidebar/work.js，纯搬迁零行为变更；符号经单 IIFE 共享作用域可见）
import { wkPdfClose, wkPdfRender } from './work-pdf.js'
/* @module sidebar/work/work-editor.js */
  // ---------- 评论标记（原文行打标，2026-10-06；2026-10-07 改编辑器行装饰器） ----------
  // 每条评论的行范围 l0..l1 落成 CodeMirror 行装饰：未解决 .cmt-mark-open / 已解决 .cmt-mark-res。
  function cmtApplyMarks() {
    if (!wkEdView) return
    const marks = cmtRangesFor(state.workFile)
    wkEdCmtMarks = marks
    wkEdView.dispatch({ effects: wkEdCmtEffect.of(marks) })
    if (wkCmtScrollId) {
      const id = wkCmtScrollId
      wkCmtScrollId = ''
      const hit = marks.find((m) => m.id === id)
      if (hit) wkEdScrollToLine(Math.min(hit.l0, wkEdView.state.doc.lines))
    }
  }

  // 顶部「保存态」文本落地（唯一写点）：conflict > saving > dirty > 空。传 (txt, cls) 则原样落。
  function wkEdState(txt, cls) {
    const el = $('wk-ed-save')
    if (!el) return
    if (txt === undefined) {
      txt = wkEdConflict ? '外部已修改' : wkEdSaving ? '保存中…' : wkEdDirty ? '未保存' : ''
      cls = wkEdConflict ? 'conflict' : wkEdDirty || wkEdSaving ? 'dirty' : ''
    }
    el.textContent = txt || ''
    el.classList.toggle('dirty', cls === 'dirty')
    el.classList.toggle('conflict', cls === 'conflict')
  }

  function renderEditor() {
    const pathEl = $('wk-ed-path')
    const body = $('wk-ed-body')
    if (pathEl) pathEl.textContent = state.workFile || ''
    if (!body) return
    if (!state.workFile) {
      wkEdReset()
      body.innerHTML = '<div class="wk-ed-empty">从左侧文件树选择一个文件</div>'
      return
    }
    if (!state.workProj) {
      wkEdReset()
      body.innerHTML = '<div class="wk-ed-empty">未选择项目</div>'
      return
    }
    // 返回载入 Promise（新文件/新项目才读盘）：调用方要等「文档真进编辑器」才能定位行（如卡片 src-open 跳行）。
    // 缓存键 = (workProj, workFile) 两维——只比路径会在「两项目存在同名相对路径」（如都开 README.md）时
    // 判为同一文件：切项目后不重读，编辑区留着上个项目的内容（PDF 分支表现为旧 iframe 换「不支持预览」，
    // 文本分支更会被后续自动保存写进新项目同名文件 = 跨项目串台/污染）。项目维度不可省。
    if (wkEdFile !== state.workFile || wkEdProj !== state.workProj) return readFile(state.workFile)
    renderEdBody()
  }

  function wkEdReset() {
    wkEdFile = ''
    wkEdMeta = null
    wkEdText = ''
    wkEdMtime = null
    wkEdDirty = false
    wkEdConflict = false
    wkEdPendingDoc = null
    wkEdCmtMarks = []
    wkEdProj = ''
    wkPdfClose()
    if (wkEdView) { wkEdSetLang(''); wkEdSetDoc('') }
    if (wkEdTimer) {
      clearTimeout(wkEdTimer)
      wkEdTimer = 0
    }
    wkEdState('')
  }

  function renderEdBody() {
    const body = $('wk-ed-body')
    if (!body || !wkEdMeta) return
    if (wkEdMeta.isImg) {
      body.innerHTML = `<div class="wk-ed-img"><img src="${esc(fileUrl(state.workFile))}" alt="${esc(state.workFile)}" /></div>`
      return
    }
    if (!wkEdMeta.editable) {
      body.innerHTML = `<div class="wk-ed-empty">${esc(wkEdMeta.msg || '不支持预览')}</div>`
      return
    }
    // 可编辑文本（含 md）：常驻 CodeMirror 6 编辑器。把 host 挂回 body 并测量（body 可能被别的渲染重建过
    // 子节点）；仅当 readFile 置了 wkEdPendingDoc（新文件）才换文档 + 热换语言，否则保留编辑器现状
    // （重渲不得用陈旧基线覆盖用户未保存的编辑）。
    const view = wkEdEnsureView()
    body.replaceChildren(wkEdHost)
    if (wkEdPendingDoc !== null) {
      wkEdSetLang(state.workFile)
      wkEdSetDoc(wkEdPendingDoc)
      wkEdPendingDoc = null
    }
    requestAnimationFrame(() => view.requestMeasure())
    cmtApplyMarks() // 评论标记：被批注的行加高亮
    wkEdState()
  }

  let wkEdProj = '' // 当前编辑内容所属项目（缓存键第二维；与 wkEdFile 配对，切项目即失效）

  // 死路径收口：读回 404 = 该路径在盘上已不存在（改名/删除后残留的开放集条目，含持久化恢复的）。
  // 摘出 state.wkFiles（顶栏 pill 的唯一来源），激活项按关 tab 同语义落到右邻/左邻/聊天；
  // 不保留一枚永远「读取失败」的空壳胶囊。**只认 404**——网络错误/413/403 是「读不出内容」而非
  // 「文件没了」，瞬时故障不该吞掉用户打开的视图。
  function wkDropDeadFile(p) {
    const i = state.wkFiles.indexOf(p)
    if (i >= 0) state.wkFiles.splice(i, 1)
    toast('文件不存在：' + p)
    if (state.workFile !== p) { applyPanes(); return }
    const next = state.wkFiles[i] != null ? state.wkFiles[i] : state.wkFiles[i - 1]
    if (next != null) return openWorkFile(next)
    state.workFile = ''
    state.wkMainTab = 'chat'
    renderEditor()
    applyPanes()
  }
  async function readFile(p) {
    const body = $('wk-ed-body')
    if (!body) return
    const seq = ++edSeq
    // 立刻认下新 (proj,path)：并发重渲（切项目那一刻）不得拿旧 wkEdFile 命中缓存渲染上个项目的内容
    wkEdProj = state.workProj
    wkEdFile = ''
    wkEdConflict = false
    wkPdfClose()
    if (IMG_EXT.test(p)) {
      wkEdFile = p
      wkEdMeta = { isImg: true, editable: false }
      wkEdText = ''
      wkEdMtime = null
      renderEdBody()
      return
    }
    // PDF（2026-10-24 改 pdf.js）：读原始字节交给 work-pdf.js 真实渲染（页导航/缩放/文本层，
    // 对齐 dsh 文档预览）。渲染自闭环在分支内（不进 renderEdBody），不占用 wkEdMeta 状态；
    // 网关读侧 4 MB 上限对 PDF 同样生效，超限显式提示。
    if (/\.pdf$/i.test(p)) {
      wkEdFile = p
      wkEdMeta = { isImg: false, editable: false }
      wkEdText = ''
      wkEdMtime = null
      body.innerHTML = '<div class="wk-ed-empty">读取中…</div>'
      try {
        const res = await fetch(fileUrl(p))
        if (seq !== edSeq) return
        if (!res.ok) {
          if (res.status === 404) return wkDropDeadFile(p)
          body.innerHTML =
            '<div class="wk-ed-empty">' +
            esc(res.status === 413 ? 'PDF 超过 4 MB，网关读取上限内不支持预览' : `读取失败（HTTP ${res.status}）`) +
            '</div>'
          return
        }
        const buf = await res.arrayBuffer()
        if (seq !== edSeq) return
        await wkPdfRender(body, p, buf)
      } catch (e) {
        if (seq !== edSeq) return
        body.innerHTML = `<div class="wk-ed-empty">读取失败：${esc(e.message || e)}</div>`
      }
      return
    }
    // Office 只读预览（2026-10-24）：xlsx/docx 二进制包交给 work-doc.js 解包渲染（不走文本分支，
    // 否则 content-type 判成二进制直接「不支持预览」）。网关读侧 4 MB 上限同样生效。
    if (wkDocKind(p)) {
      wkEdFile = p
      wkEdMeta = { isImg: false, editable: false }
      wkEdText = ''
      wkEdMtime = null
      body.innerHTML = '<div class="wk-ed-empty">读取中…</div>'
      try {
        const res = await fetch(fileUrl(p))
        if (seq !== edSeq) return
        if (!res.ok) {
          if (res.status === 404) return wkDropDeadFile(p)
          body.innerHTML =
            '<div class="wk-ed-empty">' +
            esc(res.status === 413 ? '文件超过 4 MB，网关读取上限内不支持预览' : `读取失败（HTTP ${res.status}）`) +
            '</div>'
          return
        }
        const buf = await res.arrayBuffer()
        if (seq !== edSeq) return
        wkDocRender(body, p, buf)
      } catch (e) {
        if (seq !== edSeq) return
        body.innerHTML = `<div class="wk-ed-empty">读取失败：${esc(e.message || e)}</div>`
      }
      return
    }
    body.innerHTML = '<div class="wk-ed-empty">读取中…</div>'
    try {
      const res = await fetch(fileUrl(p))
      if (seq !== edSeq) return
      if (!res.ok) {
        if (res.status === 404) return wkDropDeadFile(p)
        wkEdFile = p
        wkEdMeta = {
          isImg: false,
          editable: false,
          msg:
            res.status === 413
              ? '文件超过 4 MB，不支持编辑'
              : res.status === 403
                ? '该项目外的路径不可访问'
                : `读取失败（HTTP ${res.status}）`,
        }
        renderEdBody()
        return
      }
      const ct = (res.headers.get('content-type') || '').toLowerCase()
      const looksText = /^text\/|json|javascript|typescript|xml|svg|x-sh|csv|yaml/.test(ct) || MD_EXT.test(p)
      if (!looksText) {
        wkEdFile = p
        wkEdMeta = { isImg: false, editable: false, msg: `二进制文件（${ct || '未知类型'}），不支持预览` }
        renderEdBody()
        return
      }
      const text = await res.text()
      if (seq !== edSeq) return
      const etag = res.headers.get('etag')
      let mtime = etag ? Number(etag.replace(/"/g, '')) : NaN
      if (!Number.isFinite(mtime)) mtime = null
      wkEdFile = p
      wkEdText = text
      wkEdMeta = { isImg: false, editable: true }
      wkEdMtime = mtime
      wkEdDirty = false
      wkEdPendingDoc = text // 新文档灌入编辑器 + 热换语言（renderEdBody 消费）
      renderEdBody()
    } catch (e) {
      if (seq !== edSeq) return
      body.innerHTML = `<div class="wk-ed-empty">读取失败：${esc(e.message || e)}</div>`
    }
  }

  // 强制重拉磁盘版本（冲突「取消」分支 / 需放弃本地改动时用）
  async function wkEdReload() {
    if (!state.workFile) return
    const p = state.workFile
    wkEdFile = ''
    await readFile(p)
  }

  // 切文件 / 切项目 / 退 work 前 flush：把 pending 编辑立即落盘（交互式——冲突时弹处置框）
  async function wkEdFlush() {
    if (wkEdTimer) {
      clearTimeout(wkEdTimer)
      wkEdTimer = 0
    }
    if (!wkEdDirty || wkEdConflict) return
    await wkEdSave({ interactive: true })
  }

  // 保存：默认带 baseMtime（外部改过 → 409，不覆盖）；force = 无基线强制覆盖（用户确认后）。
  async function wkEdSave(opts) {
    const force = !!(opts && opts.force)
    const interactive = !!(opts && opts.interactive)
    if (!state.workFile || !state.workProj || wkEdSaving) return
    wkEdText = wkEdDocText() // 落盘 payload = 当前真源（编辑器文档）
    if (!wkEdDirty && !force) return
    if (wkEdTimer) {
      clearTimeout(wkEdTimer)
      wkEdTimer = 0
    }
    wkEdSaving = true
    wkEdState('保存中…', 'dirty')
    let conflict = false
    try {
      const payload = { label: state.workProj, path: state.workFile, content: wkEdText }
      if (!force && wkEdMtime !== null) payload.baseMtime = wkEdMtime
      const res = await fetch(apiUrl('/gateway/file/write'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (res.status === 409) conflict = true
      else {
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.ok) throw new Error(data.error || '保存失败')
        if (typeof data.mtime === 'number') wkEdMtime = data.mtime
        wkEdInvalidatePathCache() // 写盘成功 → 路径补全目录缓存失效（新文件/新目录要能补出来）
        wkEdDirty = wkEdDocText() !== wkEdText // 保存期间又改了 → 留脏，下面续排程
      }
    } catch (e) {
      wkEdSaving = false
      wkEdState('保存失败', 'conflict')
      toast('保存失败：' + (e.message || e))
      return
    }
    wkEdSaving = false
    if (conflict) {
      wkEdConflict = true
      wkEdState('外部已修改', 'conflict')
      if (interactive) return wkEdResolveConflict()
      toast('文件已被外部修改，未自动覆盖（Ctrl+S 可覆盖）')
      return
    }
    wkEdState()
    if (wkEdDirty) wkEdScheduleSave() // 保存期间又改了 → 续排程（wkEdState 先落地「未保存」）
  }

  // 冲突处置（用户显式保存时）：确定 = 用当前内容覆盖；取消 = 放弃编辑、重载磁盘版本。绝静默二选一。
  async function wkEdResolveConflict() {
    const overwrite = window.confirm('磁盘上的文件已被外部修改。\n\n确定：用当前内容覆盖\n取消：放弃编辑，载入磁盘版本')
    if (overwrite) {
      wkEdConflict = false
      wkEdDirty = true
      return wkEdSave({ force: true })
    }
    wkEdDirty = false
    wkEdConflict = false
    await wkEdReload()
  }

  // 打开一个文件（**唯一口**：侧栏文件树行 / 搜索浮窗行 / 顶栏文件 pill / 评论定位 / 预览卡 src-open 全走这里）。
  // 顶栏文件 pill 的多枚开放集由 applyPanes 兜底并入（`wkEnsureFileTab(state.workFile)`），故此处不必另加。
  async function openWorkFile(p) {
    if (!p) return
    if (p !== state.workFile && wkEdDirty) await wkEdFlush() // 切文件前 flush 旧文件的 pending 编辑
    state.workFile = p
    state.wkMainTab = 'file' // 点文件 = 明确要看内容 → 文件 tab 顶上来（不静默什么都不发生）
    saveWork()
    applyPanes()
    renderWorkBody()
    // 「用户打开了某文件」是一条**事实**，广播给当前工作项目的在场卡（Pj18 预览卡据此切到该篇 PDF）；
    // 内容判断（只认 .tex / 目录段推书稿名）由卡片自己定，宿主不替卡做过滤。带 label 限定 = 不跨项目串台。
    // 切激活项（点另一枚 pill）同样走这里 ⇒ 每次都重发一次；卡侧按路径去重，重复广播不会 reload。
    if (state.workProj) cardBus.broadcast({ label: state.workProj }, 'file-open', { path: p })
    await renderEditor() // 等文档真正进编辑器再返回（调用方据此在正确文档上定位行）
  }

  // 关一枚文件 tab（顶栏文件 pill 的 ×，p = 该 pill 的路径）：从开放集 state.wkFiles 移除。关的是
  // **激活项** → 切右邻 / 左邻（落点语义同 wkCloseTab）；一枚不剩 → 清 workFile、下沉格回聊天 tab
  // （「聊天 / 文件 / 预览至少一栏」由 applyPanes 保底）。非激活 tab 没有文档态（单编辑器模型，切前
  // flush），故只有关激活项才需要落盘 pending 编辑——绝不因关 tab 丢改动。
  async function closeWkFile(p) {
    const i = state.wkFiles.indexOf(p)
    if (i < 0) return
    state.wkFiles.splice(i, 1)
    if (p !== state.workFile) { applyPanes(); return } // 关非激活项：只少一枚 pill，文档与路由不动
    if (wkEdDirty) await wkEdFlush()
    const next = state.wkFiles[i] != null ? state.wkFiles[i] : state.wkFiles[i - 1]
    if (next != null) return openWorkFile(next) // 切到邻枚：载入 + 广播 file-open，预览卡跟着切
    state.workFile = ''
    state.wkMainTab = 'chat'
    saveWork()
    renderEditor()
    renderWorkBody()
    applyPanes()
  }
