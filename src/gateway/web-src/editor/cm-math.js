// CM6 数学公式插件（2026-10-15 待办 11 统一）：给两条 CM6 编辑链（work md 编辑区 / 底栏 composer）补齐
// 与消息流**同一套**公式能力——`$…$`、`$$…$$`、`\(…\)`、`\[…\]`。
// 与 vendor live-markdown 既有 mathPlugin/blockMathField 的关系 = **补缺不替换**：vendor 只认
// ```math 围栏（blockMathField）与 `` `$…$` `` 行内代码内写法（mathPlugin），标准分隔符不认；本件补的正是
// 标准分隔符那段，靠「跳过 InlineCode / FencedCode 区间」与 vendor 划清边界，两套不重叠、互不吞并。
// 文法与判据唯一真源 = core/math-spec.js（消息流 extractMath 同源，禁在此另写一套正则）。
// 契约：
//  · 流式容错：未闭合（单个 `$`、未收尾的 `$$`/`\[`）不匹配 → 原样显源码，不产半截 KaTeX；
//  · 选中即显源码：光标/选区与公式区间相交时撤下装饰（与 vendor live preview「光标所在块显源码」同口径），
//    故选区复制天然拿到**原始公式源码**（含定界符），不会有「只复制渲染后的纯字符」形态；
//  · 暗色：KaTeX 输出颜色继承父级 currentColor（同消息流），主题切换零额外逻辑。
import { MATH_SRC_BLOCK_BRACKET, MATH_SRC_BLOCK_DOLLAR, MATH_SRC_INLINE_DOLLAR, MATH_SRC_INLINE_PAREN, mathInlineOk } from '../core/math-spec.js'
import { edCmg } from './cm-global.js'
/* @module editor/cm-math.js */

  // 代码区间（不参与公式识别）：行内代码与围栏代码。vendor 的 ```math 围栏也在此被跳过 → 交 vendor 处理。
  const CM_MATH_SKIP_NODES = new Set(['InlineCode', 'FencedCode', 'CodeBlock'])
  // 选区相交判据（撤装饰显源码）——**闭区间**，与 vendor live-markdown 的 `cn(state,from,to)`
  // （`a.from<=to && a.to>=from`，即 `**` 行内标记的去/显判据）逐字同款：光标落在公式边界上
  // （紧邻 `$` 前 / 后）也算命中 ⇒ 退化显源码。开区间（严格 `<`/`>`）会漏掉边界态——此即 2026-10-15
  // 实报「`$…$` 光标临近不退化为源码，而 `**` 正常」的根因。拖选中（mouseSelectingField）期间按
  // 「无选区」处理，避免拖拽沿途闪烁。
  function cmMathSelectionHit(state, CM, from, to) {
    if (state.field(CM.mouseSelectingField, false)) return false
    for (const r of state.selection.ranges) {
      if (r.from <= to && r.to >= from) return true
    }
    return false
  }
  // 一次全量收集：块级（$$…$$ / \[…\]）先于行内（\(…\) / $…$），已被块级认领的区间不再被行内重认。
  function cmMathScan(state, CM) {
    const doc = state.doc
    const text = doc.toString()
    const skip = []
    CM.syntaxTree(state).iterate({
      enter: (node) => {
        if (!CM_MATH_SKIP_NODES.has(node.name)) return
        skip.push([node.from, node.to])
      },
    })
    const inSkip = (a, b) => skip.some(([s, e]) => a < e && b > s)
    const claimed = []
    const isClaimed = (a, b) => claimed.some(([s, e]) => a < e && b > s)
    const out = []
    const push = (m, body, cls) => {
      const from = m.index
      const to = from + m[0].length
      if (inSkip(from, to) || isClaimed(from, to)) return
      claimed.push([from, to])
      out.push({ from, to, src: body, cls })
    }
    // 块级：$$…$$ / \[…\]
    for (const src of [MATH_SRC_BLOCK_DOLLAR, MATH_SRC_BLOCK_BRACKET]) {
      const re = new RegExp(src, 'g')
      let m
      while ((m = re.exec(text))) push(m, m[1], 'block')
    }
    // 行内：\(…\) / $…$
    for (const src of [MATH_SRC_INLINE_PAREN, MATH_SRC_INLINE_DOLLAR]) {
      const re = new RegExp(src, 'g')
      let m
      while ((m = re.exec(text))) {
        if (src === MATH_SRC_INLINE_DOLLAR && !mathInlineOk(m[1])) continue
        push(m, m[1], 'inline')
      }
    }
    return out
  }
  // 块级公式落成 block widget 需行对齐：整行只含该公式（首行前缀 / 末行后缀皆空白）→ 吃掉整行；
  // 否则按行内 widget 渲染（displayMode 数学仍按 KaTeX 显示模式排版，不吞同行文字）。
  function cmMathRange(state, item) {
    if (item.cls !== 'block') return { from: item.from, to: item.to, block: false }
    const d = state.doc
    const l0 = d.lineAt(item.from)
    const l1 = d.lineAt(item.to)
    const pre = d.sliceString(l0.from, item.from)
    const post = d.sliceString(item.to, l1.to)
    if (!pre.trim() && !post.trim()) return { from: l0.from, to: l1.to, block: true }
    return { from: item.from, to: item.to, block: false }
  }
  // 扩展工厂（两宿主各传自己的 CM 全局；同一实现，禁各写一套）。
  function cmMathExt(CM) {
    const C = CM || edCmg()
    const renderMath = (src, display) => (typeof C.renderMath === 'function' ? C.renderMath(src, display) : '')
    class CM_MathWidget extends C.WidgetType {
      constructor(src, block, display) { super(); this.src = src; this.block = block; this.display = display }
      eq(o) { return o.src === this.src && o.block === this.block && o.display === this.display }
      ignoreEvent() { return false }
      toDOM() {
        const el = document.createElement(this.block ? 'div' : 'span')
        el.className = this.block ? 'cm-math-block cm-mspec-math' : 'cm-math-inline cm-mspec-math'
        // KaTeX 输出自身安全（trust 默认 false + 内部转义），与消息流 mdHtml 同口径直接进 DOM。
        el.innerHTML = renderMath(this.src, this.display)
        return el
      }
    }
    const build = (view) => {
      const deco = []
      for (const item of cmMathScan(view.state, C)) {
        const r = cmMathRange(view.state, item)
        if (cmMathSelectionHit(view.state, C, r.from, r.to)) continue // 选区内 = 显源码
        deco.push(C.Decoration.replace({ widget: new CM_MathWidget(item.src, r.block, item.cls === 'block'), block: r.block }).range(r.from, r.to))
      }
      return C.Decoration.set(deco.sort((a, b) => a.from - b.from), true)
    }
    return C.ViewPlugin.fromClass(class {
      constructor(view) { this.decorations = build(view) }
      update(u) {
        if (u.docChanged || u.viewportChanged || u.selectionSet || u.reconfigured) this.decorations = build(u.view)
      }
    }, { decorations: (v) => v.decorations })
  }

export { cmMathExt }
