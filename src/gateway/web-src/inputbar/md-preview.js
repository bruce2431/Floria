// 底栏 md 就地渲染（2026-10-14 待办 17，用户改判：不弹独立预览卡）：
// 失焦且有内容 → #input-md（渲染态）顶替 #input；聚焦/点击渲染态 → 回 #input 编辑态。
// **单真值 = #input 的 contenteditable 原文**：#input-md 只是被 hidden 的 #input 的派生视图
// （mdHtml(serializeInput())，与消息流同渲染器），聚焦即弃、不落任何文本状态。
// 交互定夺（回执口径）：失焦显渲染 / 聚焦回编辑（contenteditable 内做 CM6 式逐块 live preview
// 会与中文 IME 合成、mention chip DOM、caret 映射正面冲突，逐击换 DOM 是注册级 bug 源）。
// 刷新口 = mdPreviewRefresh()，由 send.js syncGwSend 调 + #input 自身 blur/focus 两事件。
/* @module inputbar/md-preview.js */
  // 换层禁用窗口：@ 浮窗 / 命令菜单 / 模型·项目下拉 / 审批接管在场时，插入链（sentinel/选区 DOM 操作）
  // 依赖 #input 的选区与可见性——display:none 会毁掉选区，此时保持编辑态不换层（守护的不变量 =
  // 「弹层插入链运行期输入区 DOM 不得被替换」；弹层关闭后随下次输入/blur 自然恢复换层判定）。
  function mdSwapBlocked() {
    const tk = $('composer-takeover')
    if (tk && !tk.hidden) return true
    if (mention && mention.open) return true
    for (const id of ['mention-pop', 'cmd-pop', 'model-pop', 'proj-pop']) {
      const el = $(id)
      if (el && !el.hidden) return true
    }
    return false
  }

  function mdPreviewRefresh() {
    const raw = $('input')
    const view = $('input-md')
    if (!raw || !view) return
    const focused = document.activeElement === raw
    // 编辑态或无内容：渲染视图弃掉（单真值原则——不保留第二份文本），原文归位
    if (focused || !serializeInput().trim() || mdSwapBlocked()) {
      view.hidden = true
      view.innerHTML = ''
      raw.hidden = false
      return
    }
    view.innerHTML = `<div class="blocks">${mdHtml(serializeInput())}</div>`
    view.hidden = false
    raw.hidden = true
  }

  // 点击渲染态 = 要继续编辑：焦点交回 #input（focus 事件走 mdPreviewRefresh 换回编辑态）。
  // 光标落点：contenteditable 被 hidden 过，选区丢失 → 归到文末（就近续写，回执已声明）。
  const mdView = $('input-md')
  if (mdView) {
    mdView.addEventListener('mousedown', (e) => {
      e.preventDefault()
      inputEl.focus()
      const sel = window.getSelection()
      if (sel) {
        const r = document.createRange()
        r.selectNodeContents(inputEl)
        r.collapse(false)
        sel.removeAllRanges()
        sel.addRange(r)
      }
    })
  }
  const mdRaw = $('input')
  if (mdRaw) {
    mdRaw.addEventListener('blur', mdPreviewRefresh)
    mdRaw.addEventListener('focus', mdPreviewRefresh)
  }

