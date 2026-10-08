// 编辑区 CodeMirror6 引擎：建视图 / 热换语言 / 主题 / 评论行装饰 / 选区行号（惰性建单例）。（拆自 sidebar/work.js，纯搬迁零行为变更；符号经单 IIFE 共享作用域可见）
/* @module sidebar/work/work-cm.js */
  // ---------- 编辑区（主区左栏） ----------
  // 所有可编辑文本文件（markdown 与代码/纯文本一视同仁）都是常驻 CodeMirror 6 编辑器：整篇恒可编辑，
  // 无阅读/编辑两态、无模式按钮；markdown 走 Obsidian 式 Live Preview（光标所在块就地显源码标记），
  // 其余按扩展名加载语言高亮——长行按窗口软换行（EditorView.lineWrapping）。库 codemirror-live-markdown
  // 与各语言包以 vendored 全局脚本 window.CMLiveMarkdown 提供（复用已 vendored 的全局 katex 渲染公式）。
  // 真源 = EditorView.state.doc（wkEdText 仅作上次落盘基线）。图片 <img> / 不可编辑文件仍走各自只读分支。
  // 保存 = 停止输入 1s 自动（去抖）+ Ctrl+S 立即；写回带 ETag 基线 wkEdMtime，外部改过 → 409，不静默覆盖。
  let wkEdFile = ''     // 已载入编辑缓冲的路径（与 wkEdMeta/wkEdText 同拍）；'' = 未载入
  let wkEdMeta = null   // { isImg, editable, msg? }；null = 未载入
  let wkEdText = ''     // 上次落盘/读入的文件正文（实时真源在 wkEdView.state.doc；保存基线）
  let wkEdMtime = null  // 读侧 ETag 解析的 mtime（毫秒），写回冲突基线；null = 无
  let wkEdDirty = false
  let wkEdTimer = 0
  let wkEdSaving = false
  let wkEdConflict = false
  let wkCmtScrollId = '' // 评论面板定位跳转待消费的评论 id（渲染完原文标记后滚到该行）
  // CodeMirror 6（2026-10-07）：全生命周期只建一次 EditorView，跨文件复用（切文件只换文档 + 热换语言）。
  let wkEdCM = null       // window.CMLiveMarkdown（建 view 时缓存；缺失即显式报错，不静默降级）
  let wkEdView = null     // EditorView 实例；null = 尚未创建
  let wkEdHost = null     // EditorView 的包裹 div（作为挂载单元在 #wk-ed-body 内换父）
  let wkEdProgAnn = null  // Annotation：标记「程序性改文档」，updateListener 据此区分用户编辑
  let wkEdCmtEffect = null // StateEffect<marks[]>：把评论行范围送进编辑器装饰器
  let wkEdCmtMarks = []   // 最近一次评论标记数据（建 view 时回填/重挂用）
  let wkEdLangComp = null // Compartment：按文件扩展名热换语言扩展（markdown Live Preview / 代码语言 / 纯文本）
  let wkEdHlStyle = null  // HighlightStyle：代码语法高亮（tag → --hl-* CSS 变量，日夜随动）
  let wkEdPendingDoc = null // 待灌入编辑器的新文档（readFile 置位；renderEdBody 消费后清空）——避免重渲时用陈旧基线覆盖用户编辑

  function fileUrl(p) {
    return apiUrl(`/gateway/file?label=${encodeURIComponent(state.workProj)}&path=${encodeURIComponent(p)}`)
  }
  // 当前正文真源文本 = 编辑器文档（无编辑器则回退基线）。
  function wkEdDocText() {
    return wkEdView ? wkEdView.state.doc.toString() : wkEdText
  }

  // ---------- 编辑区 CodeMirror 6 编辑器 ----------
  // 惰性建 view（全生命周期一次）：默认键位/历史 + 按文件热换的语言 compartment（markdown Live Preview 或
  // 代码语言）+ 软换行 + 库自带主题 + 本项目主题（CSS 变量，日夜随动）+ 评论行装饰 field + 文档变更监听。
  function wkEdEnsureView() {
    if (wkEdView) return wkEdView
    const CM = window.CMLiveMarkdown
    if (!CM) throw new Error('CodeMirror 编辑器未加载（window.CMLiveMarkdown 缺失）')
    wkEdCM = CM
    // 表格 widget 单元格渲染器：库默认 `td.textContent`（纯文本）会把格内 md 原样吐出，
    // 注入本工程的行内渲染器（core/markdown.js mdInlineText）⇒ 格内 `**粗**`/`` `码` ``/链接正常渲染。
    CM.setTableCellRenderer(mdInlineText)
    wkEdProgAnn = CM.Annotation.define()
    wkEdCmtEffect = CM.StateEffect.define()
    const cmtField = CM.StateField.define({
      create: () => CM.Decoration.none,
      update: (deco, tr) => {
        let next = deco.map(tr.changes)
        for (const e of tr.effects) if (e.is(wkEdCmtEffect)) next = wkEdBuildCmtDeco(e.value, tr.state)
        return next
      },
    })
    wkEdHost = document.createElement('div')
    wkEdHost.className = 'wk-ed-cm'
    wkEdLangComp = new CM.Compartment()
    wkEdHlStyle = wkEdBuildHlStyle(CM)
    const st = CM.EditorState.create({
      doc: '',
      extensions: [
        CM.history(),
        CM.keymap.of([...CM.defaultKeymap, ...CM.historyKeymap]),
        CM.EditorView.lineWrapping, // 长行按窗口软换行（Obsidian 同款）
        wkEdLangComp.of(wkEdLangExt('')),
        CM.editorTheme,
        wkEdThemeSpec(CM),
        CM.EditorView.updateListener.of(wkEdOnUpdate),
        cmtField,
      ],
    })
    wkEdView = new CM.EditorView({ state: st, parent: wkEdHost })
    if (wkEdCmtMarks.length) wkEdView.dispatch({ effects: wkEdCmtEffect.of(wkEdCmtMarks) })
    try { CM.initHighlighter() } catch (e) { /* 高亮初始化失败不致命（代码块退化为纯文本） */ }
    return wkEdView
  }

  // 水平分隔线（`---` / `***` / `___`）渲染：库（codemirror-live-markdown 0.5.1-alpha.1）的 markdownStylePlugin
  // 没有 HorizontalRule 项，`---` 在预览里原样显源码。本插件补上——未落光标时给该行加 `.wk-ed-hr` 画横线
  // 并藏掉字符，光标进入该行（或拖选中）则显源码，与标题/引用的显隐口径一致。
  function wkEdHrPlugin(CM) {
    return CM.ViewPlugin.fromClass(class {
      constructor(view) { this.decorations = this.build(view) }
      update(u) {
        if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = this.build(u.view)
      }
      build(view) {
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
            if (node.name !== 'HorizontalRule') return
            const line = st.doc.lineAt(node.from)
            // 光标在该行（或拖选中）= 显源码：不加任何装饰，`---` 原样可编辑
            if (activeLines.has(line.number) && !isDrag) return
            // 行装饰必须落在行首（node.from 可能带缩进 ≠ line.from，直接用 node.from 会被 CM 拒收）
            deco.push(CM.Decoration.line({ class: 'wk-ed-hr' }).range(line.from))
            if (node.from >= node.to) return
            deco.push(CM.Decoration.mark({ class: 'wk-ed-hr-hide' }).range(node.from, node.to))
          },
        })
        return CM.Decoration.set(deco.sort((a, b) => a.from - b.from), true)
      }
    }, { decorations: (v) => v.decorations })
  }

  // 扩展名 → 语言扩展。markdown = Live Preview 全套（语法 + live-preview 装饰 + 公式/表格/链接/代码块）；
  // 代码/纯文本 = 对应语言包 + 基础高亮；无匹配扩展名 = 纯文本（无高亮）。
  function wkEdLangExt(path) {
    const CM = wkEdCM
    if (!CM) return []
    const m = /\.([a-z0-9]+)$/i.exec(path || '')
    const e = m ? m[1].toLowerCase() : ''
    if (/^(md|markdown)$/.test(e)) {
      return [
        // base=markdownLanguage 本身已含 GFM（commonmark.configure([GFM,…])，Table 在其中）⇒ 不必再传 extensions:[Table]
        CM.markdown({ base: CM.markdownLanguage }),
        CM.collapseOnSelectionFacet.of(true),
        CM.mouseSelectingField,
        CM.livePreviewPlugin,
        CM.markdownStylePlugin,
        CM.mathPlugin,
        CM.blockMathField,
        CM.tableField,
        CM.linkPlugin(),
        ...CM.codeBlockField(),
        wkEdHrPlugin(CM),
      ]
    }
    const L = wkEdLangFor(CM, e)
    return L ? [L, CM.syntaxHighlighting(wkEdHlStyle)] : []
  }
  // 代码语法高亮样式：tag → 项目 CSS 变量（--hl-*）⇒ 日夜随动，无需重建。会话消息/旁白不受影响
  // （只作用于编辑器）。
  function wkEdBuildHlStyle(CM) {
    const t = CM.tags
    const c = (v) => ({ color: `var(${v})` })
    return CM.HighlightStyle.define([
      { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.operatorKeyword, t.modifier, t.self], ...c('--hl-kw') },
      { tag: [t.string, t.special(t.string), t.regexp, t.character], ...c('--hl-str') },
      { tag: [t.number, t.bool, t.null, t.atom], ...c('--hl-num') },
      { tag: [t.comment, t.lineComment, t.blockComment, t.docComment, t.meta], ...c('--hl-com') },
      { tag: t.heading, ...c('--hl-h') },
      { tag: t.strong, ...c('--hl-b') },
      { tag: t.emphasis, ...c('--hl-i') },
      { tag: [t.link, t.url], ...c('--hl-link') },
      { tag: [t.monospace, t.quote], ...c('--hl-code') },
      { tag: [t.typeName, t.className, t.namespace, t.labelName], ...c('--hl-type') },
      { tag: [t.function(t.variableName), t.function(t.propertyName)], ...c('--hl-fn') },
      { tag: [t.propertyName, t.attributeName, t.definition(t.propertyName)], ...c('--hl-attr') },
      { tag: [t.operator, t.punctuation, t.bracket, t.separator], ...c('--hl-op') },
    ])
  }
  // 代码族语言包（@codemirror/lang-* 直取；legacy-modes 经 StreamLanguage 包装）。
  function wkEdLangFor(CM, e) {
    if (e === 'json') return CM.json()
    if (/^(js|mjs|cjs|jsx)$/.test(e)) return CM.javascript()
    if (/^(ts|tsx|mts|cts)$/.test(e)) return CM.javascript({ typescript: true })
    if (/^(css|scss|less)$/.test(e)) return CM.css()
    if (/^(html|htm|xml|svg|vue)$/.test(e)) return CM.html()
    if (e === 'py') return CM.python()
    if (/^(sh|bash|zsh)$/.test(e)) return CM.StreamLanguage.define(CM.shell)
    if (/^(yaml|yml|toml|ini|conf)$/.test(e)) return CM.StreamLanguage.define(CM.yaml)
    if (/^(tex|latex|sty|cls|bib)$/.test(e)) return CM.StreamLanguage.define(CM.stex)
    return null
  }
  // 热换语言（切文件时调，compartment reconfigure 不触碰文档与撤销历史）。
  function wkEdSetLang(path) {
    if (!wkEdView) return
    wkEdView.dispatch({ effects: wkEdLangComp.reconfigure(wkEdLangExt(path)) })
  }

  // 本项目主题：用项目 CSS 变量（--text/--bg/--mono），日夜切换自动随动（不重建）。
  function wkEdThemeSpec(CM) {
    return CM.EditorView.theme({
      '&': { fontSize: '12.5px', lineHeight: '1.6', color: 'var(--text)', backgroundColor: 'transparent', margin: '0' },
      '&.cm-editor': { height: '100%' },
      '.cm-scroller': { fontFamily: 'var(--mono)', overflow: 'auto' },
      '.cm-content': { fontFamily: 'var(--mono)', padding: '16px 20px', caretColor: 'var(--text)' },
      '.cm-line': { padding: '0' },
      '&.cm-focused': { outline: 'none' },
      '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--text)' },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
        backgroundColor: 'color-mix(in srgb, var(--text) 24%, transparent)',
      },
    })
  }

  // 用户编辑 vs 程序性改文档：docChanged 且无 progAnn ⇒ 记为脏并起去抖保存。
  function wkEdOnUpdate(update) {
    if (!update.docChanged) return
    for (const tr of update.transactions) if (tr.annotation(wkEdProgAnn)) return
    wkEdDirty = true
    wkEdState()
    wkEdScheduleSave()
  }
  // 去抖自动保存（冲突未决时暂停，交 Ctrl+S 显式处置，避免覆盖外部改动）。
  function wkEdScheduleSave() {
    if (wkEdConflict) return
    if (wkEdTimer) clearTimeout(wkEdTimer)
    wkEdTimer = setTimeout(() => { wkEdTimer = 0; wkEdSave({}) }, WK_SAVE_MS)
  }

  // 把编辑器文档设为 text（相等则跳过；否则带 progAnn 程序性 dispatch，不触发脏标记）。
  function wkEdSetDoc(text) {
    if (!wkEdView) return
    const cur = wkEdView.state.doc.toString()
    if (cur === text) return
    wkEdView.dispatch({ changes: { from: 0, to: cur.length, insert: text }, annotations: wkEdProgAnn.of(true) })
  }

  // 评论行装饰：给 l0..l1 源行加 line decoration（RangeSetBuilder 必须按 from 升序、去重）。
  function wkEdBuildCmtDeco(marks, st) {
    const CM = wkEdCM
    const doc = st.doc
    const b = new CM.RangeSetBuilder()
    const seen = new Set()
    for (const m of (marks || []).slice().sort((a, x) => a.l0 - x.l0)) {
      const l0 = Math.max(1, Math.min(m.l0, doc.lines))
      const l1 = Math.max(l0, Math.min(m.l1, doc.lines))
      for (let n = l0; n <= l1; n++) {
        if (seen.has(n)) continue
        seen.add(n)
        const from = doc.line(n).from
        b.add(from, from, CM.Decoration.line({ class: 'cmt-mark ' + (m.resolved ? 'cmt-mark-res' : 'cmt-mark-open') }))
      }
    }
    return b.finish()
  }

  // 滚动到源行 n 并给该行闪标（评论跳转）
  function wkEdScrollToLine(n) {
    if (!wkEdView) return
    const from = wkEdView.state.doc.line(Math.max(1, Math.min(n, wkEdView.state.doc.lines))).from
    wkEdView.dispatch({ selection: { anchor: from }, effects: wkEdCM.EditorView.scrollIntoView(from, { y: 'center' }) })
    const node = wkEdView.domAtPos(from).node
    const el = node && node.nodeType === 3 ? node.parentElement : node
    const line = el && el.closest ? el.closest('.cm-line') : null
    if (line) {
      line.classList.add('cmt-flash')
      setTimeout(() => line.classList.remove('cmt-flash'), 1200)
    }
  }

  // 选区 → 源行号区间 [l0,l1]（供 inputbar/quote.js 引用浮窗取行号；比渲染 DOM 爬锚更准）。
  function wkEdQuoteLines(range) {
    if (!wkEdView || !range) return null
    try {
      const a = wkEdView.posAtDOM(range.startContainer, range.startOffset)
      const b = wkEdView.posAtDOM(range.endContainer, range.endOffset)
      if (a < 0 || b < 0) return null
      const d = wkEdView.state.doc
      return [d.lineAt(Math.min(a, b)).number, d.lineAt(Math.max(a, b)).number]
    } catch (e) {
      return null
    }
  }

