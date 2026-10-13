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
    if (wkTab !== 'files' || !state.workFile) return ''
    const i = state.workFile.lastIndexOf('/')
    return i < 0 ? '' : state.workFile.slice(0, i)
  }

  // 创建文件（isDir=false）/ 文件夹（true）：复用 openRenameDialog 一件两用弹窗（与重命名同模式：
  // onSubmit 抛错 = 错误留在弹窗内、不关窗，可改名重试）。成功后展开落点目录、刷新树；新建文件
  // 直接 openWorkFile（进编辑器 + 顶栏 pill + cardBus 广播，与侧栏点击同一唯一口）。
  function wkNewCreate(isDir) {
    if (!state.workProj) return toast('先在上方选择一个项目')
    const dir = wkNewContextDir()
    openRenameDialog({
      heading: isDir ? '新建文件夹' : '新建文件',
      placeholder: '输入名称',
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

  // 下载一个文件（行操作浮窗「下载」项，2026-10-13 待办 1）：走 GET /gateway/file 读原始字节
  // （同 work 编辑区读侧：4 MB 上限、路径穿越防护、鉴权），blob 化后经 a[download] 落浏览器下载。
  // 目录不出此项（整棵打包下载无既有实现，不新造——待办只提文件下载）。
  async function downloadWorkEntry(p) {
    if (!p || !state.workProj) return
    try {
      const res = await fetch(fileUrl(p))
      if (!res.ok) {
        toast(res.status === 413 ? '文件超过 4 MB，不支持下载' : '下载失败（HTTP ' + res.status + '）')
        return
      }
      const blob = await res.blob()
      const a = document.createElement('a')
      const url = URL.createObjectURL(blob)
      a.href = url
      a.download = baseOf(p)
      a.click()
      URL.revokeObjectURL(url)
      toast('已下载「' + baseOf(p) + '」')
    } catch (e) {
      toast('下载失败：' + (e.message || e))
    }
  }
