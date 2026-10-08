// 文件 / 目录行操作（重命名 / 删除浮窗）与新建聊天 newWorkChat。（拆自 sidebar/work.js，纯搬迁零行为变更；符号经单 IIFE 共享作用域可见）
/* @module sidebar/work/work-rows.js */

  // ---------- 文件 / 目录行操作（2026-09-27：与侧栏会话行同一套右键 / 长按浮窗，见 recent.js registerRowMenu）----------
  // 两个写接口落在网关（POST /gateway/file/rename | /delete），本模块只做「弹出菜单 + 提交 + 刷新树」。
  // 删除 = 移入项目根 .trash/（工作区规范禁止真删），故不设二次确认——.trash/ 本身就是撤销位。
  function baseOf(p) {
    const i = p.lastIndexOf('/')
    return i < 0 ? p : p.slice(i + 1)
  }
  function openFileRename(p) {
    if (!p) return
    openRenameDialog({
      heading: '重命名',
      placeholder: '输入新名称',
      okText: '重命名',
      value: baseOf(p),
      onSubmit: async (name) => {
        const res = await fetch(apiUrl('/gateway/file/rename'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label: state.workProj, path: p, name }),
        })
        const data = await res.json()
        if (!res.ok || !data.ok) throw new Error(data.error || '重命名失败')
        // 展开态与编辑区都按旧路径记着，须同步搬到新路径（目录改名 = 整棵子树的路径前缀都变）
        for (const k of [...wkOpen]) {
          if (k === p) { wkOpen.delete(k); wkOpen.add(data.path) }
          else if (k.startsWith(p + '/')) { wkOpen.delete(k); wkOpen.add(data.path + k.slice(p.length)) }
        }
        if (state.workFile === p) state.workFile = data.path
        else if (state.workFile.startsWith(p + '/')) state.workFile = data.path + state.workFile.slice(p.length)
        saveWork()
        await loadProjectTree(state.workProj)
        renderEditor()
        renderWorkBody()
        applyPanes() // 顶栏文件名 pill 跟着新路径重渲
        toast('已重命名为「' + data.name + '」')
      },
    })
  }
  async function deleteWorkEntry(p) {
    if (!p) return
    try {
      const res = await fetch(apiUrl('/gateway/file/delete'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: state.workProj, path: p }),
      })
      const data = await res.json()
      if (!res.ok || !data.ok) throw new Error(data.error || '删除失败')
      if (state.workFile === p || state.workFile.startsWith(p + '/')) state.workFile = ''
      for (const k of [...wkOpen]) if (k === p || k.startsWith(p + '/')) wkOpen.delete(k)
      saveWork()
      await loadProjectTree(state.workProj)
      renderEditor()
      renderWorkBody()
      applyPanes() // 删掉当前打开的文件 → 文件 tab 退场、下沉格切回聊天/空
      toast('已移入 ' + data.trash)
    } catch (e) {
      toast('删除失败：' + (e.message || e))
    }
  }
  // 文件树行源：文件与目录同一套菜单（目录删除 = 整棵子树进 .trash/）；操作对象 = 行的项目内相对路径。
  function registerWorkRows() {
    registerRowMenu({
      sel: '.wk-row',
      key: (el) => el.dataset.wkfile || el.dataset.wkdir || null,
      items: (el) =>
        el.dataset.wkfile || el.dataset.wkdir
          ? [
              { a: 'rename', icon: I.dshEdit, label: '重命名' },
              { a: 'delete', icon: I.dshStop, label: '删除', danger: true },
            ]
          : [],
      pick: (a, el) => {
        const p = el.dataset.wkfile || el.dataset.wkdir
        if (a === 'rename') openFileRename(p)
        else deleteWorkEntry(p)
      },
    })
  }

  function newWorkChat() {
    // 新会话落在当前 work 项目下（落项目由 engine/state.js newSessionProject 按工作项目解析，此处不写
    // state.newProject——目标项目槽只有一个真源，work 模式读工作项目、chat 模式读该槽）。
    // 不切回 chat 模式：#/ 空态由 renderHome() 渲染进会话卡（非视图卡），work 主区布局照样成立；
    // 模式互斥只对 mgr/preview 两张视图卡生效（route.js 内那一处 setSbMode('chat')）。
    state.wkMainTab = 'chat' // 新建聊天 = 要看聊天 → 聊天 tab 顶上来、助手靠回栏
    state.wkAssist = true
    state.wkAssistMode = 'side'
    wkEnsureTab(WK_NEW_TAB) // 空对话占自己一枚胶囊
    navigate('#/')
    applyPanes()
    saveWork()
    if (isMobile()) setPanel(false)
  }

