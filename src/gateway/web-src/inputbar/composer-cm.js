// CM6 接管底栏输入框（2026-10-14 #17 B 口径定案：真所见即所得，work 编辑区同款 live preview）。
// **doc 单真源 = EditorState.doc**：序列化令牌原文直接进 doc（[插件:X] / [会话:X|sid] / [@目录|文件:p] /
// [@引用…] / 回复·PDF 引用块），扫描插件按令牌起止加**原子 replace 装饰**渲成 chip（widget 蓝字
// .mention 族 = 输入栏现行为，三点确认 ①）。接缝签名与语义冻结：serializeInput = doc.toString()、
// setInputText = 全文替换——消费链（send/mention/quote/commands/ctx-meter/live）只认这两口。
// 旧 #input contenteditable 与 #input-md 渲染层（md-preview.js 整模块）退役。
/* @module inputbar/composer-cm.js */
  // vendor 全局（index.html 先于 app.js 载入，eval 期取值安全；work-cm.js 同款别名）
  const CMG = window.CMLiveMarkdown
  let cmView = null
  let cmCM = null
  let cmEditComp = null // 可编辑 compartment（只读查看器 app.js 切换口）
  let cmPhComp = null   // 占位符 compartment（token 门/只读态换 ph）
  let cmPhText = '输入消息，Enter 发送'

  // ---------- 令牌表（doc 文本 ↔ chip 装饰的唯一真源；正则与 core/mention-syntax.js 同族形态） ----------
  const CM_TOKENS = [
    { re: /\[会话:([^\]\n]+)\]/g, spec: (m) => ({ kind: 'session', name: m[1] }) },
    { re: /\[插件:([^\]\n]+)\]/g, spec: (m) => ({ kind: 'plugin', name: m[1] }) },
    { re: /\[@(目录|文件):([^\]\n]+)\]/g, spec: (m) => ({ kind: 'path', ptype: m[1] === '目录' ? 'dir' : 'file', name: m[2] }) },
    { re: /\[@引用:([^\]#\n]+?)(?:#L(\d+)-L?(\d+))?\]/g, spec: (m) => ({ kind: 'ref', rkind: 'file', file: m[1], l0: m[2], l1: m[3] }) },
    { re: /\[@引用PDF:([^\]#\n]+?)(?:#p(\d+)(?:-p?(\d+))?)?\]/g, spec: (m) => ({ kind: 'ref', rkind: 'pdf', file: m[1], p0: m[2], p1: m[3] }) },
    { re: /\[@引用回复:(\d+)\|([^\]\n]*)\]/g, spec: (m) => ({ kind: 'ref', rkind: 'reply', idx: m[1], title: m[2] }) },
  ]
  // 引用块收口令牌（回复/PDF 原文块结束行）：渲染为空（隐藏），同样原子——原文块在消息里本就整块剥掉只留锚点胶囊
  const CM_TOKEN_CLOSE = /\[\/(引用回复|引用PDF)\]/g

  function cmTokenRanges(doc) {
    const text = doc.toString()
    const out = []
    for (const t of CM_TOKENS) {
      t.re.lastIndex = 0
      let m
      while ((m = t.re.exec(text))) out.push({ from: m.index, to: m.index + m[0].length, spec: t.spec(m), close: false })
    }
    CM_TOKEN_CLOSE.lastIndex = 0
    let m
    while ((m = CM_TOKEN_CLOSE.exec(text))) out.push({ from: m.index, to: m.index + m[0].length, spec: null, close: true })
    return out.sort((a, b) => a.from - b.from)
  }

  function cmRefLabel(spec) {
    if (spec.rkind === 'reply') return `引用自「${spec.title || '本会话'}」· 第 ${spec.idx} 条回复`
    const name = String(spec.file || '').split('/').pop()
    if (spec.rkind === 'pdf') return `引用自 ${name}${spec.p0 ? ' · 第 ' + spec.p0 + (spec.p1 && spec.p1 !== spec.p0 ? '-' + spec.p1 : '') + ' 页' : ''}`
    return `引用自 ${name}`
  }
  // chip DOM：@ 族复用 buildMentionChip（输入栏蓝字现行为）；引用族同 .mention.ref 结构（icon+label+×）
  function cmChipDom(spec) {
    if (spec.kind === 'ref') {
      const chip = document.createElement('span')
      chip.className = 'mention ref'
      chip.innerHTML = `<span class="m-ic">${spec.rkind === 'reply' ? I.msg : I.dshFile}</span><span class="m-nm">${esc(cmRefLabel(spec))}</span><span class="m-x" title="删除">×</span>`
      return chip
    }
    if (spec.kind === 'session') {
      const t = splitSessionToken(spec.name)
      return buildMentionChip('session', t.title, t.sid)
    }
    return buildMentionChip(spec.kind, spec.name, '', spec.ptype)
  }

  class CmChipWidget extends CMG.WidgetType {
    constructor(spec, len) { super(); this.spec = spec; this.len = len }
    eq(o) { return o.len === this.len && JSON.stringify(o.spec) === JSON.stringify(this.spec) }
    // ignoreEvent true：事件交给 widget 自有监听（× 删除），其余冒泡回 CM
    ignoreEvent() { return true }
    toDOM() {
      const chip = cmChipDom(this.spec)
      chip.addEventListener('mousedown', (e) => {
        if (!e.target.closest('.m-x')) return
        e.preventDefault()
        e.stopPropagation()
        cmRemoveTokenAt(cmView.posAtDOM(chip))
      })
      return chip
    }
  }

  function cmRemoveTokenAt(pos) {
    if (!cmView || cmView.state.readOnly) return
    const hit = cmTokenRanges(cmView.state.doc).find((it) => it.from === pos)
    if (!hit) return
    const text = cmView.state.doc.toString()
    let to = hit.to
    if (text[to] === ' ') to++ // 连同尾随分隔空格一起删（旧 removeChip 同语义）
    cmView.dispatch({ changes: { from: hit.from, to } })
  }

  // 令牌扫描插件 + 原子化：chip 区间游标进不去、退格整块删（CM atomicRanges 语义）
  const cmChipPlugin = CMG.ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = cmBuildDeco(view) }
    update(u) { if (u.docChanged || u.viewportChanged) this.decorations = cmBuildDeco(u.view) }
  }, { decorations: (v) => v.decorations })

  function cmBuildDeco(view) {
    const doc = view.state.doc
    const text = doc.toString()
    const items = cmTokenRanges(doc)
    const arr = []
    // 引用块（回复/PDF）正文行标：锚点令牌行与收口令牌行之间加 .cm-quote-body（正文可见可编辑，
    // 与旧「原文只在 dataset 里不可见」不同——真所见即所得：用户消息将包含他在编辑器里看到的每一行）
    for (const it of items) {
      if (it.close || !it.spec || it.spec.kind !== 'ref' || it.spec.rkind === 'file') continue
      const closeRe = it.spec.rkind === 'pdf' ? '[/引用PDF]' : '[/引用回复]'
      const ci = text.indexOf(closeRe, it.to)
      if (ci < 0) continue
      for (let n = doc.lineAt(it.to).number + 1; n <= doc.lineAt(ci).number - 1; n++) {
        arr.push(CMG.Decoration.line({ class: 'cm-quote-body' }).range(doc.line(n).from))
      }
    }
    for (const it of items) {
      if (it.close) arr.push(CMG.Decoration.replace({}).range(it.from, it.to))
      else arr.push(CMG.Decoration.replace({ widget: new CmChipWidget(it.spec, it.to - it.from) }).range(it.from, it.to))
    }
    return CMG.Decoration.set(arr, true)
  }
  const cmAtomic = CMG.EditorView.atomicRanges.of((view) => {
    const p = view.plugin(cmChipPlugin)
    return p ? p.decorations : CMG.Decoration.none
  })

  // ---------- 键程/粘贴（自 ctx-meter.js 的 #input 监听原样迁入，不改判定次序） ----------
  function cmOnKeydown(event, view) {
    // token 门态：输入框只做 token 提交
    if (gateAwait) {
      if (event.key === 'Enter') { event.preventDefault(); gateSubmit(); return true } // 真 = 阻断 CM keymap 回车换行
      return false
    }
    // IME 组合期（中文/日文拼字中）全放行——组合中的 Enter 是「确认候选」不是发送/选择。
    // CM 原生组合安全：不逐击换 DOM（旧 contenteditable 逐击改 DOM 的三面冲突随之消失）
    if (event.isComposing || event.keyCode === 229) return false
    // 命令菜单打开：方向键/回车/ESC 走选择逻辑（不移动光标、不发送）
    if (cmd.open) {
      if (event.key === 'ArrowDown') { event.preventDefault(); cmdMove(1); return true }
      if (event.key === 'ArrowUp') { event.preventDefault(); cmdMove(-1); return true }
      if (event.key === 'Enter') { event.preventDefault(); cmdSelect(); return true }
      if (event.key === 'Escape') { event.preventDefault(); closeCmdPop(); return true }
      return false
    }
    if (msel.open) {
      if (event.key === 'Escape') { event.preventDefault(); modelEscape(); return true }
      if (event.key === 'ArrowDown') { event.preventDefault(); mselMove(1); return true }
      if (event.key === 'ArrowUp') { event.preventDefault(); mselMove(-1); return true }
      return false
    }
    if (mention.open) {
      if (event.key === 'ArrowDown') { event.preventDefault(); moveMentionSel(1); return true }
      if (event.key === 'ArrowUp') { event.preventDefault(); moveMentionSel(-1); return true }
      if (event.key === 'Enter') { event.preventDefault(); selectMention(); return true }
      if (event.key === 'Escape') { event.preventDefault(); closeMentionPop(); return true }
    }
    // 退格删除光标前的 chip 令牌（跳过其前空白；含尾随一个分隔空格）
    if (event.key === 'Backspace' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (cmBackspaceChip(view)) { event.preventDefault(); return true }
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (!gwSend()) toast('只读查看 · 无法发送')
      return true
    }
    return false
  }

  function cmBackspaceChip(view) {
    const st = view.state
    const r = st.selection.main
    if (!r.empty) return false
    const pos = r.from
    const text = st.doc.toString()
    let hit = null
    for (const it of cmTokenRanges(st.doc)) {
      if (it.to <= pos && /^\s*$/.test(text.slice(it.to, pos))) hit = it
    }
    if (!hit) return false
    let to = pos
    if (hit.to === pos && text[pos] === ' ') to = pos + 1
    view.dispatch({ changes: { from: hit.from, to } })
    return true
  }

  function cmOnPaste(event, view) {
    if (gateAwait) return false
    const cd = event.clipboardData
    const files = Array.from((cd && cd.files) || []).filter((f) => /^image\//.test(f.type))
    if (files.length) { event.preventDefault(); addImageFiles(files); return true }
    // 纯文本粘贴：CM 天然只收文本（无 text/html 富格式问题），走原生事务保 undo 栈
    if (!cd || !cd.getData('text/plain')) return false
    return false // 文本粘贴交 CM 默认（等价旧 execCommand insertText 的纯文本语义）
  }

  // ---------- 输入汇流口（旧 input 事件 → updateListener） ----------
  function cmOnUpdate(update) {
    if (update.docChanged) {
      syncGwSend()
      if (cmd.open) renderCmdPop() // + 浮窗过滤挂底栏：每敲一字列表随文本变（含 IME 组合期）
    }
    if (update.docChanged || update.selectionSet) onInputMention()
  }

  // ---------- 建视图（模块求值期一次；live-markdown.js 在 app.js 之前加载，全局必在） ----------
  function cmMount() {
    if (cmView) return cmView
    cmCM = window.CMLiveMarkdown
    if (!cmCM) throw new Error('CodeMirror 未加载（window.CMLiveMarkdown 缺失）')
    cmEditComp = new cmCM.Compartment()
    cmPhComp = new cmCM.Compartment()
    const st = cmCM.EditorState.create({
      doc: '',
      extensions: [
        cmCM.history(),
        cmCM.keymap.of([...cmCM.defaultKeymap, ...cmCM.historyKeymap]),
        cmCM.EditorView.lineWrapping,
        cmEditComp.of([cmCM.EditorView.editable.of(true), cmCM.EditorState.readOnly.of(false)]),
        cmPhComp.of(cmCM.placeholder(cmPhText)),
        // md Live Preview 全套（work 编辑区同款）：输入即渲染 = 真所见即所得
        cmCM.markdown({ base: cmCM.markdownLanguage }),
        cmCM.collapseOnSelectionFacet.of(true),
        cmCM.mouseSelectingField,
        cmCM.livePreviewPlugin,
        cmCM.markdownStylePlugin,
        cmCM.mathPlugin,
        cmCM.blockMathField,
        cmCM.tableField,
        cmCM.linkPlugin(),
        ...cmCM.codeBlockField(),
        cmChipPlugin,
        cmAtomic,
        cmCM.editorTheme,
        cmThemeSpec(),
        cmCM.EditorView.updateListener.of(cmOnUpdate),
      ],
    })
    cmView = new cmCM.EditorView({ state: st, parent: $('cm-host') })
    // 键/粘贴走 contentDOM **捕获阶段**直挂（不 domEventHandlers）：本 vendor 实测 keymap.of(defaultKeymap)
    // 的 Enter 绑定先于 domEventHandlers 吞键（探针 2026-10-14，np=false 且键程分支未触）——捕获监听先于
    // CM 自身气泡链，true = preventDefault+stopPropagation 阻断 keymap 默认行为。
    const capDom = (type, fn) => cmView.contentDOM.addEventListener(type, (e) => { if (fn(e, cmView) === true) { e.preventDefault(); e.stopPropagation() } }, true)
    capDom('keydown', cmOnKeydown)
    capDom('paste', cmOnPaste)
    inputEl = cmView.contentDOM // state.js 的 inputEl 再指向 CM contentDOM：focus()/contains() 等既有读法不变
    try { cmCM.initHighlighter() } catch (e) { /* 高亮初始化失败不致命（同 work 编辑器） */ }
    return cmView
  }

  // 几何随 #input 旧口径（pl16/pr12/pt4、行高 24、52/336px、docked 28px）——min-height 由 styles.css 承担
  function cmThemeSpec() {
    return cmCM.EditorView.theme({
      '&': { height: 'auto', maxHeight: '336px', fontSize: 'inherit', backgroundColor: 'transparent' },
      '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit', lineHeight: 'inherit' },
      '.cm-content': { padding: '4px 12px 0 16px', color: 'var(--ink)', caretColor: 'var(--ink)', whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere' },
      '.cm-line': { padding: '0' },
      '&.cm-focused': { outline: 'none' },
      '.cm-placeholder': { color: 'var(--ink-4)', pointerEvents: 'none' },
    })
  }

  // ---------- 公开 API（接缝 + 各依赖链改道口） ----------
  function composerDocText() { return cmView ? cmView.state.doc.toString() : '' }
  function composerSetText(text) {
    if (!cmView || cmView.state.readOnly) return
    const cur = cmView.state.doc.toString()
    const next = String(text || '')
    if (cur === next) return
    cmView.dispatch({ changes: { from: 0, to: cur.length, insert: next }, selection: { anchor: next.length } })
  }
  // 令牌/文本追加到输入栏末尾（旧 appendMentionChip / insertRefChip 尾随落点同语义），光标到末尾
  function composerAppendToken(text) {
    if (!cmView || cmView.state.readOnly) return
    const doc = cmView.state.doc
    const sep = doc.length && !/\s$/.test(doc.toString()) ? ' ' : ''
    const ins = sep + text + ' '
    cmView.dispatch({ changes: { from: doc.length, insert: ins }, selection: { anchor: doc.length + ins.length } })
    cmView.focus()
  }
  // 引用令牌追加（quote.js）：块形态（含原文）单独起行，单行文件引用以空格衔接；光标落块尾 = 接着打字就是给引用的说明
  function composerAppendRef(token) {
    if (!cmView || cmView.state.readOnly) return
    const doc = cmView.state.doc
    const block = String(token).indexOf('\n') >= 0
    const sep = doc.length ? (block ? '\n' : ' ') : ''
    const ins = sep + token
    cmView.dispatch({ changes: { from: doc.length, insert: ins }, selection: { anchor: doc.length + ins.length } })
    cmView.focus()
  }
  function composerAppendText(text) {
    if (!cmView || cmView.state.readOnly) return
    const doc = cmView.state.doc
    const sep = doc.length && !/\s$/.test(doc.toString()) ? ' ' : ''
    const ins = sep + text
    cmView.dispatch({ changes: { from: doc.length, insert: ins }, selection: { anchor: doc.length + ins.length } })
    cmView.focus()
  }
  // 区间替换（@ 提及落地：@查询区间 → 令牌 + 空格），光标落 ins 尾
  function composerReplaceRange(from, to, ins) {
    if (!cmView || cmView.state.readOnly) return
    cmView.dispatch({ changes: { from, to, insert: ins }, selection: { anchor: from + ins.length } })
    cmView.focus()
  }
  function composerFocus() { if (cmView) cmView.focus() }
  function composerBlur() { if (cmView) cmView.contentDOM.blur() }
  // 只读查看器（app.js 非网关模式）：editable+readOnly 双阀，CM 不再与手改 contentEditable 拉锯
  function composerSetEditable(on) {
    if (!cmView) return
    cmView.dispatch({ effects: cmEditComp.reconfigure([cmCM.EditorView.editable.of(!!on), cmCM.EditorState.readOnly.of(!on)]) })
  }
  function composerPlaceholder(text) {
    cmPhText = String(text || cmPhText)
    if (cmView) cmView.dispatch({ effects: cmPhComp.reconfigure(cmCM.placeholder(cmPhText)) })
  }

  cmMount()

export {
  composerAppendRef,
  composerAppendText,
  composerAppendToken,
  composerBlur,
  composerDocText,
  composerFocus,
  composerPlaceholder,
  composerReplaceRange,
  composerSetEditable,
  composerSetText,
}
