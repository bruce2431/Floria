/**
 * 探针：嵌入式图表双段围栏（```chart）双端解析离线自测
 *
 * web 侧：src/gateway/web-src/core/markdown.js 的 mdHtml（含 chartSplit/closeCode/CHART_BOOT）——
 *   ESM 模块依赖 DOM/state.js 不能直接 import，按标记区间切片（mdInline…mdHtml）求值，
 *   注入同款 esc + mention 桩，测的是真源码。
 * CLI 侧：src/components/Markdown.tsx 的 stripChartHtml——剥 TS 类型标注后求值。
 *
 * 运行：cd _agent-src && bun probe-chart.ts
 */
import { readFileSync } from 'node:fs'

let pass = 0
const fails: string[] = []
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; return }
  fails.push(`${name}${extra ? ' — ' + extra : ''}`)
}

// ---- web 侧：切片 mdInline…mdHtml（真源码）----
const WSRC = 'src/gateway/web-src/core/markdown.js'
const wsrc = readFileSync(WSRC, 'utf-8')
const W_START = "  const MD_MONO ="
const W_END = '  function relTime(ms) {'
const wi = wsrc.indexOf(W_START)
const wj = wsrc.indexOf(W_END)
if (wi < 0 || wj < 0 || wj < wi) { console.error('❌ web 切片标记未命中：markdown.js mdInline…mdHtml 区间'); process.exit(1) }
const wbody = wsrc.slice(wi, wj)
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
// mention 桩（web-src/inputbar/mention.js 的 import——本探针不测 chip）
const mdHtml = new Function('esc', 'MENTION_PLUGIN_RE', 'MENTION_SESSION_RE', 'mentionChipHtml',
  `${wbody}\nreturn mdHtml`)(esc, /␀never␀/g, /␀never␀/g, () => '') as (src: string) => string

// ---- CLI 侧：切片 stripChartHtml（真源码，剥 TS 标注）----
const CSRC = 'src/components/Markdown.tsx'
const csrc = readFileSync(CSRC, 'utf-8')
const C_START = 'function stripChartHtml(src: string): string {'
const C_END = 'function cachedLexer(content: string): Token[] {'
const ci = csrc.indexOf(C_START)
const cj = csrc.indexOf(C_END)
if (ci < 0 || cj < 0 || cj < ci) { console.error('❌ CLI 切片标记未命中：Markdown.tsx stripChartHtml 区间'); process.exit(1) }
const cbody = csrc.slice(ci, cj)
  .replace(/\(src: string\): string \{/, '(src) {')
  .replace(/const out: string\[\]/, 'const out')
  .replace(/let mode: 'html' \| 'ascii' \| null = null/, "let mode = null")
const stripChartHtml = new Function(`${cbody}\nreturn stripChartHtml`)() as (src: string) => string

// ============ web 侧断言 ============
const CHART_MD = [
  '前置文字',
  '```chart',
  '%%html',
  '<div style="font-family:sans-serif"><b>孟子晖</b>（伞）</div>',
  '%%ascii',
  '孟子晖（伞：所长+国家奖+204/46所军工通道）',
  '   /        |        \\',
  '鄂秀天凤   徐志斌    吴磊',
  '```',
  '后置文字',
].join('\n')
const whtml = mdHtml(CHART_MD)

ok('web: chart 双段 → iframe 渲染', whtml.includes('<iframe class="chart-frame" sandbox="allow-scripts" srcdoc="'), whtml.slice(0, 200))
ok('web: 含 chart-embed 容器与源码按钮', whtml.includes('chart-embed') && whtml.includes('chart-src') && whtml.includes('chart-raw'))
ok('web: 围栏闭合才渲染（本例已闭合）', whtml.includes('chart-frame'))
ok('web: .code-block 不并存', !whtml.includes('code-block'))
ok('web: ascii 段不进 iframe（srcdoc 内无「孟子晖（伞：所长」）', !/srcdoc="[^"]*孟子晖（伞：所长/.test(whtml))
ok('web: 源码视图 chart-raw 留全文（含 %%ascii 段）', whtml.includes('%%ascii') && whtml.includes('%%html'))
ok('web: 前后文字保留（既有行为：围栏不打断段落，同 <p> 以 <br> 连接）', whtml.includes('<p>前置文字<br>后置文字</p>'))

// srcdoc 属性不破出 + 实体往返透明
const m = /srcdoc="([^"]*)"/.exec(whtml)
ok('web: srcdoc 属性恰好一个完整捕获', !!m)
if (m) {
  const attr = m[1]
  ok('web: 属性内无裸引号（不破出）', !/[^&]"|^"/.test(attr.replace(/&quot;/g, '').replace(/&#39;/g, '')))
  const decoded = attr.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
  ok('web: 实体解码一次=模型原始 HTML+BOOT', decoded.includes('<div style="font-family:sans-serif"><b>孟子晖</b>（伞）</div>') && decoded.includes('__chartH'))
  ok('web: BOOT 带 sandbox 高度上报与 ResizeObserver', decoded.includes('parent.postMessage') && decoded.includes('ResizeObserver'))
}

// 误伤防护：普通 ```html 围栏原样代码块
const plainHtml = mdHtml('```html\n<div>x</div>\n```')
ok('web: 普通 ```html 仍是代码块', plainHtml.includes('code-block') && !plainHtml.includes('chart-frame'))
const htmlPlus = mdHtml('```html+jinja\n<div>x</div>\n```')
ok('web: ```html+jinja 不触发', !htmlPlus.includes('chart-frame'))

// 降级：缺段 / 未闭合
const asciiOnly = mdHtml('```chart\n%%ascii\n甲 — 乙\n```')
ok('web: 只有 %%ascii 段 → 代码块降级', asciiOnly.includes('code-block') && !asciiOnly.includes('chart-frame'))
const noSentinel = mdHtml('```chart\n甲 — 乙\n```')
ok('web: 无哨兵 → 代码块降级', noSentinel.includes('code-block') && !noSentinel.includes('chart-frame'))
const unclosed = mdHtml('```chart\n%%html\n<div>x</div>\n')
ok('web: 流式未闭合 → 代码块回退（闭合帧才切 iframe）', unclosed.includes('code-block') && !unclosed.includes('chart-frame'))
const htmlOnly = mdHtml('```chart\n%%html\n<div>x</div>\n```')
ok('web: 只有 %%html 段 → 照常 iframe 渲染', htmlOnly.includes('chart-frame'))

// 思考块内同链路（mdHtml 复用）
const inThink = mdHtml('```chart\n%%html\n<div>x</div>\n%%ascii\n甲\n```')
ok('web: 思考块同函数命中 iframe', inThink.includes('chart-frame'))

// ============ CLI 侧断言 ============
const cliOut = stripChartHtml(CHART_MD)
ok('CLI: ascii 段保留', cliOut.includes('孟子晖（伞：所长+国家奖+204/46所军工通道）'))
ok('CLI: html 段剔除', !cliOut.includes('<div style=') && !cliOut.includes('<b>孟子晖</b>'))
ok('CLI: 哨兵行剔除', !cliOut.includes('%%html') && !cliOut.includes('%%ascii'))
ok('CLI: 围栏保留（marked 当普通代码块）', cliOut.includes('```chart'))
ok('CLI: 前后文字保留', cliOut.includes('前置文字') && cliOut.includes('后置文字'))

const cliPlain = stripChartHtml('```html\n<div>x</div>\n```')
ok('CLI: 普通 ```html 逐字透传', cliPlain === '```html\n<div>x</div>\n```')
const cliNoChart = stripChartHtml('普通文本\n第二行')
ok('CLI: 无围栏逐字透传', cliNoChart === '普通文本\n第二行')
const cliUnclosed = stripChartHtml('```chart\n%%html\n<div>x</div>\n')
ok('CLI: 未闭合围栏（流式）html 段同样剔除', !cliUnclosed.includes('<div'))
const cliMixed = stripChartHtml('```chart\n%%html\n<div>x</div>\n%%ascii\n甲—乙\n```\n```js\nconst a = 1\n```')
ok('CLI: 后续其它围栏不受影响', cliMixed.includes('const a = 1'))
ok('CLI: 混合场景 ascii 保留且无 html', cliMixed.includes('甲—乙') && !cliMixed.includes('<div'))

console.log(`\n探针结果: ${pass} 过 / ${fails.length} 败`)
if (fails.length) {
  console.error('失败项:')
  for (const f of fails) console.error('  ❌ ' + f)
  process.exit(1)
}
console.log('✅ probe-chart 全过')
