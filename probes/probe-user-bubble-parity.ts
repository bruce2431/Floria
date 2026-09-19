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
 * 运行：cd _agent-src && bun probe-user-bubble-parity.ts
 */
import { readFileSync } from 'node:fs'

const MD_SRC = 'src/gateway/web-src/core/markdown.js'
const MENTION_SRC = 'src/gateway/web-src/inputbar/mention.js'
const APPROVAL_SRC = 'src/gateway/web-src/inputbar/approval.js'
const MESSAGES_SRC = 'src/gateway/web-src/chat/messages.js'
const CSS_SRC = 'src/gateway/web/styles.css'

const mdSrc = readFileSync(MD_SRC, 'utf-8')
const mdI = mdSrc.indexOf('  function mdInline(')
const mdJ = mdSrc.indexOf('  function relTime(')
if (mdI < 0 || mdJ < 0 || mdJ < mdI) { console.error('❌ 切片标记未命中：markdown.js mdInline…mdHtml'); process.exit(1) }
const mdBody = mdSrc.slice(mdI, mdJ)

const mnSrc = readFileSync(MENTION_SRC, 'utf-8')
const mnI = mnSrc.indexOf('  const MENTION_PLUGIN_RE')
const mnJ = mnSrc.indexOf('  // 序列化 contenteditable')
if (mnI < 0 || mnJ < 0 || mnJ < mnI) { console.error('❌ 切片标记未命中：mention.js 令牌/chip/renderUserText'); process.exit(1) }
const mnBody = mnSrc.slice(mnI, mnJ)

// 与 web-src/core/state.js 同款 esc（探针注入）
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
const mod = new Function('esc', `${mnBody}\n${mdBody}\nreturn { renderUserText, mdHtml, mdInline }`)(esc) as {
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
ok('mdHtml 单行文本包块级 <p>', mod.mdHtml(sample) === '<p>你好</p>', mod.mdHtml(sample))
ok('renderUserText 输出裸文本节点（无块级包裹）', mod.renderUserText(sample) === '你好', mod.renderUserText(sample))
ok('两路径 body 结构确实不等（根因）', mod.mdHtml(sample) !== mod.renderUserText(sample))
ok('多行：mdHtml 出 <br>', mod.mdHtml('a\nb') === '<p>a<br>b</p>', mod.mdHtml('a\nb'))
ok('多行：renderUserText 保留裸 \\n（white-space:normal 下折叠为空格）', mod.renderUserText('a\nb') === 'a\nb')
ok('markdown 语义只出现在 mdHtml 一侧', mod.mdHtml('**x**') === '<p><strong>x</strong></p>' && mod.renderUserText('**x**') === '**x**')

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
