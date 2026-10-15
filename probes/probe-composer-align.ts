// probe-composer-align.ts —— 底栏编辑器文本对齐的组件契约探针（只读）
//
// 被守护的不变量（2026-10-15「同一部件两个面貌」根因）：
//   ① 空态（输入栏活在 #empty-hint 内）会话态（reparent 到 #session-card 内）下，CM6 文本区
//      的**有效** text-align 恒为 left —— 不靠继承宿主，而由组件（#input-bar 边界）自己声明。
//   ② #empty-hint 的 text-align:center 保留（它只管空态整体布局对齐），但不外溢到底栏内部文本。
//   ③ 编辑器是**单实例**：空态↔会话态切换只 reparent（route.js appendChild(#input-wrap)），
//      不重建第二个 EditorView（同一 DOM 节点换宿主 ⇒ 组件契约必须与宿主无关）。
// 本探针**真算 CSS 层叠**：从 styles.css 抽规则 → 对给定祖先链求最近命中 text-align（含继承）
// + 特指度比较（id>class>tag），不靠文本匹配猜结果。静态断言读 composer-cm.js / route.js / index.html。
// 用法：bun run ./probe-composer-align.ts

const SRC = `${import.meta.dir}/../src/gateway/web-src`
const WEB = `${import.meta.dir}/../src/gateway/web`

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail = '') {
  if (cond) pass++
  else fail++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : '  ← ' + detail}`)
}

const stylesCss = await Bun.file(`${WEB}/styles.css`).text()
const composerJs = await Bun.file(`${SRC}/inputbar/composer-cm.js`).text()
const routeJs = await Bun.file(`${SRC}/chat/route.js`).text()
const indexHtml = await Bun.file(`${WEB}/index.html`).text()

// ---------- 极简 CSS 抽取 + 选择器匹配（只关心 text-align 的层叠胜出者）----------
type El = { tag: string; id?: string; classes: string[] }
type Simple = { tag?: string; id?: string; classes: string[] }
type Rule = { selectors: string[]; decl: string }

function stripComments(s: string) { return s.replace(/\/\*[\s\S]*?\*\//g, '') }

function parseRules(css: string): Rule[] {
  const out: Rule[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(css))) {
    const sel = m[1].trim()
    if (!sel || sel.startsWith('@')) continue // at-rule 序言（@media/@container/@keyframes…）跳过
    if (/^\d/.test(sel)) continue // keyframes 关键帧（0% / from / to）跳过
    out.push({ selectors: sel.split(',').map((x) => x.trim()).filter(Boolean), decl: m[2] })
  }
  return out
}

function parseCompound(s: string): Simple | null {
  // 去伪类/伪元素/属性选择器（本探针只在 .cm-* 上判 text-align，伪态不影响该属性的胜出者）
  let t = s.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, '').replace(/\[[^\]]*\]/g, '').trim()
  if (!t) return null
  const mm = t.match(/^([a-zA-Z][\w-]*)?(#[\w-]+)?((?:\.[\w-]+)*)$/)
  if (!mm) return null
  return { tag: mm[1] || undefined, id: mm[2] ? mm[2].slice(1) : undefined, classes: (mm[3] || '').split('.').filter(Boolean) }
}

function compoundMatch(c: Simple, el: El): boolean {
  if (c.tag && c.tag !== el.tag) return false
  if (c.id && c.id !== el.id) return false
  return c.classes.every((k) => (el.classes || []).includes(k))
}

// 后代组合子（空格）匹配：末位复合式命中元素，其余逆序在祖先里按顺序各命中一个
function selectorMatch(sel: string, chain: El[]): boolean {
  const parts = sel.trim().split(/\s+/).filter((p) => p !== '>' && p !== '+' && p !== '~')
  const compounds = parts.map(parseCompound)
  if (compounds.length === 0 || compounds.some((c) => !c)) return false
  const last = compounds[compounds.length - 1]!
  if (!compoundMatch(last, chain[chain.length - 1])) return false
  let i = chain.length - 2
  for (let k = compounds.length - 2; k >= 0; k--) {
    let found = false
    while (i >= 0) { if (compoundMatch(compounds[k]!, chain[i])) { found = true; i--; break } i-- }
    if (!found) return false
  }
  return true
}

function specificity(sel: string): number[] {
  const s = sel.replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, ' ').replace(/\[[^\]]*\]/g, ' ')
  const ids = (s.match(/#[\w-]+/g) || []).length
  const cls = (s.match(/\.[\w-]+/g) || []).length
  const tags = (s.replace(/[#.][\w-]+/g, ' ').match(/[a-zA-Z][\w-]*/g) || []).length
  return [ids, cls, tags]
}
const specCmp = (a: number[], b: number[]) => (a[0]! - b[0]!) || (a[1]! - b[1]!) || (a[2]! - b[2]!)

const rules = parseRules(stripComments(stylesCss))

// 该元素自身**直接命中**的 text-align（特指度最高者）；无直接规则返回 null（留给继承）
function directAlign(chain: El[]): string | null {
  let best: string | null = null
  let bestSpec: number[] | null = null
  for (const r of rules) {
    const m = r.decl.match(/(?:^|;)\s*text-align\s*:\s*([^;]+)/)
    if (!m) continue
    for (const sel of r.selectors) {
      if (!selectorMatch(sel, chain)) continue
      const sp = specificity(sel)
      if (!bestSpec || specCmp(sp, bestSpec) > 0) { bestSpec = sp; best = m[1]!.trim() }
    }
  }
  return best
}
// 有效值 = 自身直接命中；否则沿祖先链取最近一个有 text-align 的元素（CSS 继承）；再无 → 初始值 start
function effectiveAlign(chain: El[]): string {
  for (let i = chain.length - 1; i >= 0; i--) {
    const v = directAlign(chain.slice(0, i + 1))
    if (v) return v
  }
  return 'start'
}

const cmContent = { tag: 'div', classes: ['cm-content'] }
const cmLine = { tag: 'div', classes: ['cm-line'] }
const cmPh = { tag: 'span', classes: ['cm-placeholder'] }
const barHost = [
  { tag: 'div', id: 'input-bar' },
  { tag: 'div', id: 'cm-host' },
]
// 空态：index.html 实测结构 #empty-hint > .g-stage > #input-wrap > #input-bar > #cm-host
const chainEmpty = (leaf: El): El[] => [
  { tag: 'div', id: 'empty-hint' },
  { tag: 'div', classes: ['g-stage'] },
  { tag: 'div', id: 'input-wrap' },
  ...barHost,
  leaf,
]
// 会话态：输入栏被 reparent 进 #session-card，加 .docked（route.js flipInput / send.js）
const chainSession = (leaf: El): El[] => [
  { tag: 'div', id: 'session-card', classes: ['view-card'] },
  { tag: 'div', id: 'input-wrap', classes: ['docked'] },
  ...barHost,
  leaf,
]

// ---------- A. 组件契约：文本区有效对齐左（两宿主一致，不靠继承）----------
ok('A1 空态（#empty-hint 内）.cm-content 有效 text-align = left', effectiveAlign(chainEmpty(cmContent)) === 'left', effectiveAlign(chainEmpty(cmContent)))
ok('A2 会话态（#session-card 内）.cm-content 有效 text-align = left', effectiveAlign(chainSession(cmContent)) === 'left', effectiveAlign(chainSession(cmContent)))
ok('A3 两态 .cm-line 有效对齐 left', effectiveAlign(chainEmpty(cmLine)) === 'left' && effectiveAlign(chainSession(cmLine)) === 'left')
ok('A4 两态 .cm-placeholder 有效对齐 left', effectiveAlign(chainEmpty(cmPh)) === 'left' && effectiveAlign(chainSession(cmPh)) === 'left')
ok('A5 对齐**不依赖宿主继承**：两态 .cm-content 均有自身直接命中规则（非继承 #empty-hint 的 center）',
  directAlign(chainEmpty(cmContent)) === 'left' && directAlign(chainSession(cmContent)) === 'left',
  `empty=${directAlign(chainEmpty(cmContent))} session=${directAlign(chainSession(cmContent))}`)
ok('A6 #empty-hint 仍 text-align:center（外层整体布局契约保留，未被删除）',
  effectiveAlign([{ tag: 'div', id: 'empty-hint' }]) === 'center')
ok('A7 组件边界选择器齐 5 枚（#input-bar / #cm-host / .cm-content / .cm-line / .cm-placeholder 同一规则声明）',
  rules.some((r) => ['#input-bar', '#input-bar #cm-host', '#input-bar .cm-content', '#input-bar .cm-line', '#input-bar .cm-placeholder'].every((s) => r.selectors.includes(s)) && /text-align\s*:\s*left/.test(r.decl)))

// ---------- B. 单实例：两态只 reparent，不重建编辑器 ----------
const editorNew = (composerJs.match(/new\s+cmCM\.EditorView\(/g) || []).length
ok('B1 composer-cm.js 只创建一次 EditorView（单实例）', editorNew === 1, `new=${editorNew}`)
ok('B2 空态↔会话态只 reparent（route.js appendChild(inputWrap)，不重建编辑器）',
  /inputWrap\.parentNode !== target\)\s*target\.appendChild\(inputWrap\)/.test(routeJs) && !/new\s+cmCM\.EditorView|createComposer/.test(routeJs))
ok('B3 index.html 结构：#cm-host ⊂ #input-bar ⊂ #input-wrap（组件边界在两宿主下恒成立）',
  (() => {
    const wrap = indexHtml.indexOf('id="input-wrap"')
    const bar = indexHtml.indexOf('id="input-bar"')
    const host = indexHtml.indexOf('id="cm-host"')
    return wrap >= 0 && bar > wrap && host > bar
  })())
// 两态切换类不落编辑器本身（.docked / .in-session 只挂 #input-wrap 与 #chat-area）
ok('B4 两态类只挂容器（#input-wrap.docked / #chat-area.in-session），不落 #cm-host / .cm-content',
  /inputWrap\.classList\.add\('docked'\)/.test(routeJs) && !/cm-host'\)\.classList|cmView\.dom\.classList\.add\('(docked|in-session)'/.test(routeJs + composerJs))

console.log(`\n${pass}/${pass + fail}`)
if (fail > 0) process.exit(1)
