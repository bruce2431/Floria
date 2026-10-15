// CM6 事务层：选区包裹 / 任务勾选 / 文档插入 / 包裹快捷键表（2026-10-15 待办返修轮任务D，方案 §任务D）。
// 纯 CM6 事务工具，不持编辑器状态；facade 与 editorCommand 都经这里落事务。
import { edCmg } from './cm-global.js'
/* @module editor/editor-transactions.js */


  // 选区包裹（待办 15）：有选区 = before+选区文本+after；无选区 = 插入成对符号、光标居中。
  // 多光标按 range 各自处理；after 缺省 = before（对称括弧族 `*` `**` `` ` `` 等）。
  function wrapSelectionCM(view, before, after) {
    if (!view || view.state.readOnly) return
    const tail = after === undefined ? before : after
    const EditorSelection = edCmg().EditorSelection
    const tr = view.state.changeByRange((range) => {
      const body = range.empty ? '' : view.state.sliceDoc(range.from, range.to)
      const ins = before + body + tail
      const anchor = range.empty ? range.from + before.length : range.from
      const head = range.empty ? anchor : range.from + before.length + body.length
      return { changes: { from: range.from, to: range.to, insert: ins }, range: EditorSelection.range(anchor, head) }
    })
    view.dispatch(tr, { scrollIntoView: true })
  }

  // 任务勾选（待办 10 可编辑面）：把第 line 行（1-based）行首列表标记后的 `[ ]` / `[x]` 改写为
  // checked 形态；该行无任务标记则不动（返回 false）。
  function toggleTaskLineCM(view, line, checked) {
    if (!view || view.state.readOnly) return false
    const doc = view.state.doc
    if (line < 1 || line > doc.lines) return false
    const l = doc.line(line)
    const m = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/.exec(l.text)
    if (!m) return false
    view.dispatch({ changes: { from: l.from + m[1].length + 1, to: l.from + m[1].length + 2, insert: checked ? 'x' : ' ' } })
    return true
  }

  // 光标处插入文本（附件 md 引用落点）：前接空格分隔（行首/前文空白则不补），光标落插入尾。
  function insertAtCursorCM(view, text) {
    if (!view || view.state.readOnly) return
    const r = view.state.selection.main
    const before = view.state.sliceDoc(Math.max(0, r.from - 1), r.from)
    const pad = r.from === 0 || /\s|\n/.test(before) ? '' : ' '
    const ins = pad + text + ' '
    view.dispatch({ changes: { from: r.from, to: r.to, insert: ins }, selection: { anchor: r.from + ins.length }, scrollIntoView: true })
  }

  // 包裹快捷键（Mod-b 粗体 / Mod-i 斜体 / Mod-e 行内代码）：两宿主 keymap 共用一张表（待办 15
  // 「所有 Markdown 按钮经 editor-command 调度」的键位侧——同一命令层，无第二套包裹实现）。
  function wrapKeymap() {
    return [
      { key: 'Mod-b', run: (v) => { wrapSelectionCM(v, '**'); return true } },
      { key: 'Mod-i', run: (v) => { wrapSelectionCM(v, '*'); return true } },
      { key: 'Mod-e', run: (v) => { wrapSelectionCM(v, '`'); return true } },
    ]
  }

export { insertAtCursorCM, toggleTaskLineCM, wrapKeymap, wrapSelectionCM }
