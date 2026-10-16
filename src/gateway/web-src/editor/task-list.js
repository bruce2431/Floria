// 任务列表 checkbox（2026-10-16 待办 2）：CM6 编辑面把 `- [ ]` / `- [x]` 渲成**真实可点**的
// <input type=checkbox>（Obsidian 式），点击写回源码（`[ ]`↔`[x]`）。只读消息面的同类 checkbox
// 在 core/markdown.js（mdHtml 产出 disabled input），本件是**编辑面**的补缺——两处口径一致（真 input）。
// vendor 的 markdown 语法（GFM）已产出 `TaskMarker` 节点（恰 3 字符 `[ ]`/`[x]`/`[X]`），livePreview 与
// markdownStylePlugin 都不处理它 ⇒ 原样显文本；本插件只补这层渲染，不与既有装饰相交（ListMark 装饰
// 覆盖 `- `，本件覆盖 `[ ]`，区间不重叠 → replace 装饰无冲突）。光标/拖选在该行时显源码（同 wkEdHrPlugin）。
import { edCmg } from './cm-global.js'
import { toggleTaskLineCM } from './editor-transactions.js'
/* @module editor/task-list.js */

  const edTaskBoxWidget = class extends edCmg().WidgetType {
    constructor(view, line, checked) { super(); this.view = view; this.line = line; this.checked = checked }
    eq(o) { return o.line === this.line && o.checked === this.checked } // 不比较 view（单例宿主）
    ignoreEvent() { return true } // 事件自管（mousedown），不冒泡给 CM
    toDOM() {
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.className = 'cm-task-checkbox'
      box.checked = this.checked
      box.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const v = this.view
        if (v && !v.state.readOnly) toggleTaskLineCM(v, this.line, !this.checked)
      })
      return box
    }
  }

  const edTaskPlugin = edCmg().ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = this.build(view) }
    update(u) { if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = this.build(u.view) }
    build(view) {
      const CM = edCmg()
      const st = view.state
      const activeLines = new Set()
      for (const r of st.selection.ranges) {
        const a = st.doc.lineAt(r.from).number
        const b = st.doc.lineAt(r.to).number
        for (let l = a; l <= b; l++) activeLines.add(l)
      }
      const isDrag = st.field(CM.mouseSelectingField, false)
      const deco = []
      CM.syntaxTree(st).iterate({
        enter: (node) => {
          if (node.name !== 'TaskMarker') return
          const line = st.doc.lineAt(node.from)
          if (activeLines.has(line.number) && !isDrag) return // 本行激活 = 显源码
          const checked = /^\[[xX]\]$/.test(st.sliceDoc(node.from, node.to))
          deco.push(CM.Decoration.replace({ widget: new edTaskBoxWidget(view, line.number, checked) }).range(node.from, node.to))
        },
      })
      return CM.Decoration.set(deco.sort((a, b) => a.from - b.from), true)
    }
  }, { decorations: (v) => v.decorations })

export { edTaskPlugin }
