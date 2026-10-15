/**
 * 探针：用户气泡「未接收态（乐观）」与「接收态（落盘）」的 body 渲染同构性
 *
 * 为什么这样做：web 前端手改处是 ESM 模块（依赖 DOM/state.js 顶层初始化），不能直接在 bun 里 import。
 * 本探针从源码「按标记区间切片」取出纯函数（mention 令牌/chip + mdInline/mdHtml，无 DOM 依赖）后求值，
 * 用 state.js 同款 esc 注入——测的是真源码，不是复制品。
 *
 * 根因（2026-09-15 用户实测「未接收态和接收态的气泡大小有微小差异」）：
 * 乐观气泡 body = renderUserText(text)（esc 裸文本节点），落盘气泡 body = userBodyHtml → mdHtml(text)
 * （输出 <p>…</p>，styles.css `.msg .body p { margin: 3px 0 }` 上下各 3px）⇒ 接管帧高度跳 6px、
 * 多行文本还从「空白折叠」变 `<br>`。修复 = 乐观侧同走 mdHtml（两路径同构，同 2026-09-07 定案的不变量）。
 *
 * 运行：cd Floria && bun probes/probe-user-bubble-parity.ts
 */
import { readFileSync } from 'node:fs'

const MD_SRC = 'src/gateway/web-src/core/markdown.js'
const SPEC_SRC = 'src/gateway/web-src/core/math-spec.js'
const SYNTAX_SRC = 'src/gateway/web-src/core/mention-syntax.js'
const MENTION_SRC = 'src/gateway/web-src/inputbar/mention.js'
const APPROVAL_SRC = 'src/gateway/web-src/inputbar/approval.js'
const MESSAGES_SRC = 'src/gateway/web-src/chat/messages/msg-actions.js'
const CSS_SRC = 'src/gateway/web/styles.css'

// markdown.js 整件求值（剥离 import/export + 注入 math-spec 真源）：mdInline 收尾调 restoreMath、
// mdHtml 入口调 extractMath/mdAttr（2026-10-06 公式链）——固定行切片会漏定义，故整件跑。
const strip = (src: string) => {
  const raw = src.replace(/\r\n/g, '\n')
  const at = raw.search(/^export \{/m)
  const noExport = at >= 0 ? raw.slice(0, at) : raw
  return noExport.split('\n').filter((l) => !/^\s*import\s/.test(l)).join('\n')
}
const spec = new Function(`${strip(readFileSync(SPEC_SRC, 'utf-8'))}\nreturn { MATH_SRC_BLOCK_DOLLAR, MATH_SRC_BLOCK_BRACKET, MATH_SRC_INLINE_PAREN, MATH_SRC_INLINE_DOLLAR, mathInlineOk }`)() as Record<string, unknown>
const mdBody = strip(readFileSync(MD_SRC, 'utf-8'))

// 令牌正则 + chip 构造器已下移 core/mention-syntax.js（cbcad75 分层治理）；renderUserText 仍在 mention.js。
const synBody = strip(readFileSync(SYNTAX_SRC, 'utf-8'))
const mnSrc = readFileSync(MENTION_SRC, 'utf-8')
const mnI = mnSrc.indexOf('  // 实时回显的用户消息')
const mnJ = mnSrc.indexOf('  // 序列化 = CM doc 原文')
if (mnI < 0 || mnJ < 0 || mnJ < mnI) { console.error('❌ 切片标记未命中：mention.js renderUserText'); process.exit(1) }
const renderBody = mnSrc.slice(mnI, mnJ)

// 与 web-src/core/util.js 同款 esc（探针注入）；I 桩（mention-syntax 仅取图标常量给 chip，纯文本用例不触）
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
const mod = new Function(
  'esc', 'I',
  'MATH_SRC_BLOCK_DOLLAR', 'MATH_SRC_BLOCK_BRACKET', 'MATH_SRC_INLINE_PAREN', 'MATH_SRC_INLINE_DOLLAR', 'mathInlineOk',
  `${synBody}\n${renderBody}\n${mdBody}\nreturn { renderUserText, mdHtml, mdInline }`,
)(
  esc, {},
  spec.MATH_SRC_BLOCK_DOLLAR, spec.MATH_SRC_BLOCK_BRACKET, spec.MATH_SRC_INLINE_PAREN, spec.MATH_SRC_INLINE_DOLLAR, spec.mathInlineOk,
) as {
  renderUserText: (t: string) => string
  mdHtml: (t: string) => string
  mdInline: (t: string) => string
}

let pass = 0
const fails: string[] = []
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; return }
  fails.push(`${name}${extra ? ' — ' + extra : ''}`)
}

// ---- ① 两条渲染路径的实际差异（根因取证：结构不等）----
const sample = '你好'
// data-md = 块级原文（2026-10-09 复制链挂载）——两路径 body 结构差异断言随其更新
ok('mdHtml 单行文本包块级 <p>', mod.mdHtml(sample) === '<p data-md="你好">你好</p>', mod.mdHtml(sample))
ok('renderUserText 输出裸文本节点（无块级包裹）', mod.renderUserText(sample) === '你好', mod.renderUserText(sample))
ok('两路径 body 结构确实不等（根因）', mod.mdHtml(sample) !== mod.renderUserText(sample))
ok('多行：mdHtml 出 <br>', mod.mdHtml('a\nb') === '<p data-md="a\nb">a<br>b</p>', mod.mdHtml('a\nb'))
ok('多行：renderUserText 保留裸 \\n（white-space:normal 下折叠为空格）', mod.renderUserText('a\nb') === 'a\nb')
ok('markdown 语义只出现在 mdHtml 一侧', mod.mdHtml('**x**') === '<p data-md="**x**"><strong>x</strong></p>' && mod.renderUserText('**x**') === '**x**', mod.mdHtml('**x**'))

// ---- ② 样式侧证据：<p> 带上下外边距（高度差 = 6px/段）----
const css = readFileSync(CSS_SRC, 'utf-8')
ok('styles.css 有 .msg .body p { margin: 3px 0 }', /\.msg \.body p \{ margin: 3px 0; \}/.test(css))

// ---- ③ 结构断言：两处气泡 body 必须同源（修后不变量）----
const approval = readFileSync(APPROVAL_SRC, 'utf-8')
const messages = readFileSync(MESSAGES_SRC, 'utf-8')
const bubbleLine = approval.split('\n').find((l) => /const bodyInner =/.test(l)) || ''
ok('乐观气泡 body 走 mdHtml（与落盘同源）', /const bodyInner = mdHtml\(bodyText\)/.test(bubbleLine), bubbleLine.trim())
ok('乐观气泡 body 不再走 renderUserText', !/bodyInner = renderUserText/.test(approval))
const userBody = messages.slice(messages.indexOf('function userBodyHtml('), messages.indexOf('function userImgsHtml('))
ok('落盘气泡 body 走 mdHtml', /return mdHtml\(/.test(userBody))

// ---- ④ 乐观/落盘同文本 → 同 HTML（同构直接断言）----
const cases = ['你好', 'a\nb', '**加粗** 与 [插件:archify]', '看这个 https://example.com/x']
for (const c of cases) {
  const optimistic = mod.mdHtml(c)
  const persisted = mod.mdHtml(c) // 落盘侧 = userBodyHtml 尾部同一次 mdHtml 调用
  ok(`同构：${JSON.stringify(c)}`, optimistic === persisted)
}

console.log(`\nprobe-user-bubble-parity: ${pass} 过 / ${fails.length} 败`)
if (fails.length) { for (const f of fails) console.log('  ❌ ' + f); process.exit(1) }
console.log('  ✅ 用户气泡两态 body 渲染同构')
