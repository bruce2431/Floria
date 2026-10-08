// 编辑区渲染与读写：原文评论标记 / renderEditor / 读文件 / 自动保存 / 冲突处置 / 开关文件。（拆自 sidebar/work.js，纯搬迁零行为变更；符号经单 IIFE 共享作用域可见）
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
    if (wkEdFile !== state.workFile) {
      readFile(state.workFile)
      return
    }
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

  async function readFile(p) {
    const body = $('wk-ed-body')
    if (!body) return
    const seq = ++edSeq
    wkEdConflict = false
    if (IMG_EXT.test(p)) {
      wkEdFile = p
      wkEdMeta = { isImg: true, editable: false }
      wkEdText = ''
      wkEdMtime = null
      renderEdBody()
      return
    }
    body.innerHTML = '<div class="wk-ed-empty">读取中…</div>'
    try {
      const res = await fetch(fileUrl(p))
      if (seq !== edSeq) return
      if (!res.ok) {
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

  async function openWorkFile(p) {
    if (!p) return
    if (p !== state.workFile && wkEdDirty) await wkEdFlush() // 切文件前 flush 旧文件的 pending 编辑
    state.workFile = p
    state.wkMainTab = 'file' // 点文件 = 明确要看内容 → 文件 tab 顶上来（不静默什么都不发生）
    saveWork()
    applyPanes()
    renderWorkBody()
    renderEditor()
  }

  // 关掉打开的文件（顶栏文件 pill 的 ×）：pending 编辑先落盘（不因关 tab 丢改动），清 workFile，
  // 下沉格回聊天 tab（applyPanes 的不变量会保底——聊天栏不在则文件/预览仍在即可）。
  async function closeWkFile() {
    if (wkEdDirty) await wkEdFlush()
    state.workFile = ''
    state.wkMainTab = 'chat'
    saveWork()
    renderEditor()
    renderWorkBody()
    applyPanes()
  }
