// 编辑器注册表 + 公开 facade + 命令调度（2026-10-15 待办返修轮任务D，方案 §任务D「editor-api」）。
// 每个 CM6 编辑面（composer / work 编辑区 / 后续新增）注册一个 facade，新能力（包裹/勾选/复制）
// 一律走 facade 方法或 editorCommand——禁止新增直取 view 的代码；view 只作宿主既有专属插件
// （chip 装饰/评论装饰/补全/保存链）的既有链路持有口，不扩散。
import { insertAtCursorCM, toggleTaskLineCM, wrapSelectionCM } from './editor-transactions.js'
/* @module editor/editor-api.js */


  // 注册表：id → facade。同一 id 重复注册 = 后者覆盖（编辑面重建场景）。
  const ED_EDITORS = new Map()
  // 活跃编辑器 id：宿主在 focus 时上报（editorApi.setActive），命令调度落这里。
  let edActiveId = ''

  function editorApiRegister(facade) {
    if (!facade || !facade.id) throw new Error('editorApi.register: facade.id 必填')
    ED_EDITORS.set(facade.id, facade)
    if (!edActiveId) edActiveId = facade.id
    return facade
  }
  function editorApiUnregister(id) {
    ED_EDITORS.delete(id)
    if (edActiveId === id) edActiveId = ''
  }
  function editorApiSetActive(id) {
    if (ED_EDITORS.has(id)) edActiveId = id
  }
  function editorApiGet(id) {
    return id ? ED_EDITORS.get(id) || null : (edActiveId ? ED_EDITORS.get(edActiveId) || null : null)
  }
  // 命令调度（方案「所有 Markdown 按钮经 editor-command 调度」唯一入口）：
  //   editorCommand('wrap', {before, after}) / ('insert', {text}) / ('toggleTask', {line, checked}) / ('focus')
  // target 缺省 = 活跃编辑器；返回是否命中注册面（调用方据此给 toast）。
  function editorCommand(name, payload, target) {
    const ed = editorApiGet(target)
    if (!ed) return false
    if (name === 'wrap') { wrapSelectionCM(ed.view, String(payload.before || ''), payload.after === undefined ? undefined : String(payload.after)); return true }
    if (name === 'insert') { insertAtCursorCM(ed.view, String(payload.text || '')); return true }
    if (name === 'toggleTask') { return toggleTaskLineCM(ed.view, payload.line, !!payload.checked) }
    if (name === 'focus') { ed.focus(); return true }
    throw new Error('editorCommand: 未知命令 ' + name)
  }

  // facade 构造（宿主持 EditorView 后包一层公开面；不替代宿主既有专属链）。
  function makeEditorFacade({ id, view, onDispose }) {
    const facade = {
      id,
      view, // 宿主既有专属插件的过渡持有口：新能力禁直取，走本 facade / editorCommand
      getValue() { return view.state.doc.toString() },
      setValue(text) {
        const cur = view.state.doc.toString()
        if (cur === String(text == null ? '' : text)) return
        view.dispatch({ changes: { from: 0, to: cur.length, insert: String(text == null ? '' : text) } })
      },
      focus() { view.focus() },
      blur() { view.contentDOM.blur() },
      wrapSelection(before, after) { wrapSelectionCM(view, before, after) },
      insertText(text) { insertAtCursorCM(view, text) },
      toggleTask(line, checked) { return toggleTaskLineCM(view, line, checked) },
      copyMarkdownSelection() { return view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to) },
      destroy() {
        editorApiUnregister(id)
        view.destroy()
        if (onDispose) onDispose()
      },
    }
    return editorApiRegister(facade)
  }

export { editorApiGet, editorApiRegister, editorApiSetActive, editorApiUnregister, editorCommand, makeEditorFacade }
