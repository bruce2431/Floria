// 块级格式标记（ListMark / HeaderMark / QuoteMark）的**相邻退化**插件（2026-10-24 待办）：
// vendor 的 markdownStylePlugin 按**行**决定标记显隐——光标落行内任意位置就把 `#`/`>`/`-` 露出来，
// 且远离光标时把 ListMark 整个藏掉 ⇒ 实报「只要同行就会不完全退化」+「列表圆点没有渲染」。
// 本插件把判据改回项目统一口径（选区闭区间与**标记节点**相交才退化，同 task-list / cm-math）：
//   · 相邻 → 只露出这一段源码标记，**不碰整行**（其余内容保持渲染态）；
//   · 不相邻 → ListMark 渲成 UI（无序 = 圆点，有序 = 原序号），HeaderMark/QuoteMark 保持隐藏。
// 具体外观（圆点叠绘 / 字号）由 styles.css 的 .cm-md-* / .cm-list-* 承担；本件只发 class。
import { edCmg } from './cm-global.js'
/* @module editor/block-mark.js */

  const BLOCK_MARKS = new Set(['ListMark', 'HeaderMark', 'QuoteMark'])

  const edBlockMarkPlugin = edCmg().ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = this.build(view) }
    update(u) { if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = this.build(u.view) }
    build(view) {
      const CM = edCmg()
      const st = view.state
      const isDrag = st.field(CM.mouseSelectingField, false)
      const deco = []
      CM.syntaxTree(st).iterate({
        enter: (node) => {
          if (!BLOCK_MARKS.has(node.name)) return
          // 退化判据 = 选区闭区间与标记节点相交（光标贴标记两侧/选中它），**不是整行**：
          // 行内其它位置落光标时，标记仍按预览形态渲染（同 task-list 的 `[ ]` 口径）。
          const touched = st.selection.ranges.some((r) => r.from <= node.to && r.to >= node.from)
          if (touched && !isDrag) {
            deco.push(CM.Decoration.mark({ class: 'cm-md-src' }).range(node.from, node.to))
            return
          }
          if (node.name === 'ListMark') {
            // 无序标记渲圆点；有序标记（`1.` / `1)`）原文即序号，直接以序号形态露出
            const dot = /^[-*+]$/.test(st.sliceDoc(node.from, node.to))
            deco.push(CM.Decoration.mark({ class: dot ? 'cm-md-far cm-list-dot' : 'cm-md-far cm-list-num' }).range(node.from, node.to))
            return
          }
          deco.push(CM.Decoration.mark({ class: 'cm-md-far' }).range(node.from, node.to))
        },
      })
      return CM.Decoration.set(deco.sort((a, b) => a.from - b.from), true)
    }
  }, { decorations: (v) => v.decorations })

export { edBlockMarkPlugin }
