// work 侧栏「+」新建菜单（#wk-new-pop 四项）的接入实现：创建文件 / 文件夹 + 上传文件 / 文件夹，
// 以及文件行操作浮窗的「下载」。（2026-10-13 待办 1 / 2；此前四项是 toast 占位「暂未接入」）
// 后端 = POST /gateway/file/create（JSON）与 /gateway/file/upload（原始字节，同名 -1 序号避让、
// 落点目录 recursive 创建以承载「上传文件夹」的子目录结构）；纯函数在 localGateway.ts，探针
// probes/probe-file-create.ts 直测。本模块沿用 work-rows.js 的同 IIFE 裸用风格（零 import / 零
// export：拼接后所有顶层符号共享同一作用域，源码态跨文件裸用是 sidebar/work/* 的既定约定），
// 顶层名一律 wkNew*/download* 前缀防撞（probe-web-module-scope 看住）。
/* @module sidebar/work/work-tabmenu.js */

  // 新建 / 上传的落点目录（唯一判定）：文件 tab 且有打开文件 → 其父目录（用户当前上下文）；
  // 否则项目根（''）。树浏览无独立「当前目录」态，不引入。
  function wkNewContextDir() {
    if (state.wkTab !== 'files' || !state.workFile) return ''
    const i = state.workFile.lastIndexOf('/')
    return i < 0 ? '' : state.workFile.slice(0, i)
  }

  // 创建文件（isDir=false）/ 文件夹（true）：复用 openRenameDialog 一件两用弹窗（与重命名同模式：
  // onSubmit 抛错 = 错误留在弹窗内、不关窗，可改名重试）。成功后展开落点目录、刷新树；新建文件
  // 直接 openWorkFile（进编辑器 + 顶栏 pill + cardBus 广播，与侧栏点击同一唯一口）。
  // 新建文件不再提供格式下拉：扩展名直接由用户在名称里写（如 `note.md`），无后缀即纯文本文件。
  function wkNewCreate(isDir) {
    if (!state.workProj) return toast('先在上方选择一个项目')
    const dir = wkNewContextDir()
    openRenameDialog({
      heading: isDir ? '新建文件夹' : '新建文件',
      placeholder: '输入名称（可带扩展名，如 note.md）',
      okText: '创建',
      value: '',
      onSubmit: async (name) => {
        const res = await fetch(apiUrl('/gateway/file/create'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: state.workProj, path: dir, name, dir: isDir }),
        })
        const data = await res.json()
        if (!res.ok || !data.ok) throw new Error(data.error || '创建失败')
        if (dir) wkOpen.add(dir)
        await loadProjectTree(state.workProj)
        if (isDir) {
          renderWorkBody()
          toast('已创建「' + data.name + '」')
        } else {
          await openWorkFile(data.path) // 打开 = renderEditor + applyPanes（顶栏 pill）+ 广播，树已刷新
          toast('已创建「' + data.path + '」')
        }
      },
    })
  }

  // 上传文件（withDir=false，可多选）/ 文件夹（withDir=true，webkitdirectory）。「上传文件夹」
  // 按浏览器带出的 webkitRelativePath 保留所选文件夹自身的目录结构（顶层文件夹名随结构落盘，
  // 与桌面 IDE 拖文件夹一致）；逐文件 POST /gateway/file/upload（原始字节直传），全部完成后刷新
  // 树并展开受影响目录。单文件上限 / 同名序号避让都在后端，失败逐条计入结果 toast。
  function wkNewUpload(withDir) {
    if (!state.workProj) return toast('先在上方选择一个项目')
    const inp = document.createElement('input')
    inp.type = 'file'
    inp.multiple = true
    if (withDir) {
      inp.setAttribute('webkitdirectory', '')
      inp.setAttribute('directory', '')
    }
    inp.addEventListener('change', async () => {
      const files = [...(inp.files || [])]
      inp.remove()
      if (!files.length) return
      const base = wkNewContextDir()
      const dirs = new Set() // 受影响目录（成功者）→ 完成后展开
      let okN = 0
      let bad = ''
      for (const f of files) {
        const rel = withDir ? f.webkitRelativePath || f.name : f.name
        const i = rel.lastIndexOf('/')
        const seg = i > 0 ? rel.slice(0, i) : ''
        const target = base && seg ? `${base}/${seg}` : seg || base
        try {
          const res = await fetch(
            apiUrl('/gateway/file/upload?label=' + encodeURIComponent(state.workProj) +
              '&path=' + encodeURIComponent(target) + '&name=' + encodeURIComponent(f.name)),
            { method: 'POST', body: f },
          )
          const data = await res.json().catch(() => ({}))
          if (!res.ok || !data.ok) throw new Error(data.error || 'HTTP ' + res.status)
          okN++
          const k = data.path ? (data.path.lastIndexOf('/') > 0 ? data.path.slice(0, data.path.lastIndexOf('/')) : '') : ''
          if (k) dirs.add(k)
        } catch (e) {
          bad = f.name + '：' + (e.message || e)
        }
      }
      for (const k of dirs) wkOpen.add(k)
      await loadProjectTree(state.workProj)
      if (bad && !okN) toast('上传失败：' + bad)
      else if (bad) toast(`已上传 ${okN} 个，失败：${bad}`)
      else toast(`已上传 ${okN} 个文件`)
    })
    inp.click()
  }

  // #wk-new-pop 四项的唯一分派口（work-mount.js 点击委托调用）。
  function wkNewPick(a) {
    if (a === 'file') wkNewCreate(false)
    else if (a === 'dir') wkNewCreate(true)
    else if (a === 'upload-file') wkNewUpload(false)
    else if (a === 'upload-dir') wkNewUpload(true)
  }

  // 下载超过此大小先弹确认栏（防止误点超大文件把本机/远端流量一次拉满）。
  const WK_DL_CONFIRM_BYTES = 50 * 1024 * 1024

  function wkDlFmtSize(n) {
    if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GB'
    if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(1) + ' MB'
    if (n >= 1024) return Math.round(n / 1024) + ' KB'
    return n + ' B'
  }

  // 下载确认弹窗（#dl-modal，DOM 在 index.html，样式复用 #rename-modal 的 mask/dialog 骨架）：
  // 返回 Promise<boolean>——确认 true，取消/关闭/点遮罩/Esc 均 false。监听器在收尾时点名移除。
  function wkDlConfirm(name, size) {
    const modal = $('dl-modal')
    const ok = $('dl-ok')
    const cancel = $('dl-cancel')
    const closeBtn = modal.querySelector('.close')
    $('dl-modal-text').textContent = '「' + name + '」约 ' + wkDlFmtSize(size) + '，确定下载？'
    return new Promise((resolve) => {
      let done = false
      function finish(v) {
        if (done) return
        done = true
        modal.hidden = true
        ok.removeEventListener('click', onOk)
        cancel.removeEventListener('click', onCancel)
        closeBtn.removeEventListener('click', onCancel)
        modal.removeEventListener('mousedown', onMask)
        document.removeEventListener('keydown', onKey)
        resolve(v)
      }
      function onOk() { finish(true) }
      function onCancel() { finish(false) }
      function onMask(e) { if (!e.target.closest('.dialog')) finish(false) }
      function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); finish(false) } }
      ok.addEventListener('click', onOk)
      cancel.addEventListener('click', onCancel)
      closeBtn.addEventListener('click', onCancel)
      modal.addEventListener('mousedown', onMask)
      document.addEventListener('keydown', onKey)
      modal.hidden = false
      ok.focus()
    })
  }

  // 下载一个文件（行操作浮窗「下载」项，2026-10-13 待办 1）：走 GET /gateway/file?dl=1
  // （下载语义：不套 4MB 预览上限、Content-Disposition: attachment、服务端流式发送），
  // 导航到带 token 的 URL 由浏览器原生下载管理器接收——不经 blob，任意大小都不占前端内存；
  // attachment 头也让 PDF 等内联类型只下载不预览（旧 blob 方案的「点下载变预览」由此消失）。
  // 先 HEAD 取 Content-Length，超过 WK_DL_CONFIRM_BYTES 弹确认栏。目录不出此项。
  async function downloadWorkEntry(p) {
    if (!p || !state.workProj) return
    const u = fileUrl(p) + '&dl=1'
    try {
      const head = await fetch(u, { method: 'HEAD' })
      if (!head.ok) {
        toast('下载失败（HTTP ' + head.status + '）')
        return
      }
      const size = Number(head.headers.get('Content-Length') || 0)
      if (size > WK_DL_CONFIRM_BYTES && !(await wkDlConfirm(baseOf(p), size))) return
      const a = document.createElement('a')
      a.href = u
      a.download = baseOf(p)
      a.rel = 'noopener'
      a.style.display = 'none'
      document.body.appendChild(a)
      a.click()
      a.remove()
      toast('开始下载「' + baseOf(p) + '」')
    } catch (e) {
      toast('下载失败：' + (e.message || e))
    }
  }
