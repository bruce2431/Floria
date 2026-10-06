// probe-math-render.ts —— 公式渲染链路核验（2026-10-06）
//
// 直接取 web-src/core/markdown.js 的真实源码文本（剥 import/export），注入 esc / @提及 stub 与
// vendored katex，执行 mdHtml/mdInline，断言：
//   ① $$…$$ 块级 → <div class="math-block"> 且含 KaTeX 输出（class="katex"）
//   ② $…$ 行内  → class="md-math"… 实际是行内 .katex（不带 .katex-display）
//   ③ \[…\] / \(…\) 兼容形态
//   ④ 代码内 $…$ 不被公式化（遮罩生效）
//   ⑤ 货币 "$5 and $10" 不被误吃
//   ⑥ katex 缺失时 mdHtml 不炸、$…$ 原样
// 非 DOM 依赖（mdHtml/mdInline 为纯字符串函数）；state.js 不参与。
//
// 运行：BUN="F:/@WrokSpace/.tools/bun/bun.exe"; "$BUN" probes/probe-math-render.ts

const here = import.meta.dir
const mkSrc = await Bun.file(`${here}/../src/gateway/web-src/core/markdown.js`).text()
const katexPath = `${here}/../src/gateway/web/vendor/katex/katex.min.js`

// katex UMD → CJS
const katex = require(katexPath)

// 剥头注释 + import 行 + 尾部 export 块；其余照原样执行
const raw = mkSrc.replace(/\r\n/g, '\n')
const exportAt = raw.search(/^export \{/m)
const noExport = exportAt >= 0 ? raw.slice(0, exportAt) : raw
const body = noExport
  .split('\n')
  .filter((l) => !/^\s*import\s/.test(l))
  .join('\n')

function build(windowObj: Record<string, unknown>) {
  const esc = (s: unknown) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }) as Record<string, string>)[c])
  const never = /$^/g
  // @提及 / 引用 令牌：本探针不测这些，给不命中的 stub（保持源码可执行）
  const factory = new Function(
    'esc',
    'MENTION_PATH_RE', 'MENTION_PLUGIN_RE', 'MENTION_SESSION_RE', 'QUOTE_PDF_RE', 'QUOTE_REF_RE', 'QUOTE_REPLY_RE',
    'mentionChipHtml', 'quotePdfChipHtml', 'quoteRefChipHtml', 'quoteReplyChipHtml', 'window',
    `${body}\nreturn { mdHtml, mdInline }`,
  )
  const chip = () => ''
  return factory(esc, never, never, never, never, never, never, chip, chip, chip, chip, windowObj) as {
    mdHtml: (s: string, la?: string) => string
    mdInline: (s: string) => string
  }
}

let pass = 0
let fail = 0
const ok = (cond: boolean, msg: string) => {
  if (cond) { pass++; console.log(`  PASS  ${msg}`) }
  else { fail++; console.log(`  FAIL  ${msg}`) }
}

// ---------- 有 katex ----------
const { mdHtml, mdInline } = build({ katex })

const sample = String.raw`$$\mathrm{MHA}=[\mathrm{head}_1;\dots;\mathrm{head}_h]W_O,\qquad \mathrm{head}_i=\mathrm{Attn}(XW_Q^{(i)},XW_K^{(i)},XW_V^{(i)})$$`
const h1 = mdHtml(sample)
ok(h1.includes('math-block'), '$$…$$ → <div class="math-block">')
ok(h1.includes('class="katex"'), '$$…$$ 渲染出 KaTeX HTML')
ok(!h1.includes('$$'), '$$…$$ 定界符已消解')

const h2 = mdHtml('注意力为 $\\mathrm{softmax}(QK^\\top/\\sqrt{d_k})V$ 形式。')
ok(h2.includes('class="katex"'), '行内 $…$ 渲染出 KaTeX')
ok(!h2.includes('class="math-block"'), '行内 $…$ 不产出块级容器')
ok(h2.includes('softmax'), '行内公式文字进入输出')

const h3 = mdHtml(String.raw`\[
E = mc^2
\]`)
ok(h3.includes('math-block'), String.raw`\[…\] 块级兼容`)

const h4 = mdHtml(String.raw`取 \(a^2+b^2\) 即可`)
ok(h4.includes('class="katex"'), String.raw`\(…\) 行内兼容`)

const h5 = mdHtml('用 `$x$` 表示变量，代码块：\n\n```\n$y = mx + b$\n```')
ok(h5.includes('<code>$x$</code>'), '行内代码内 $…$ 不被公式化')
ok(h5.includes('$y = mx + b$'), '围栏代码内 $…$ 不被公式化')
ok(!h5.includes('class="katex"'), '代码内无误渲染')

const h6 = mdHtml('成本 $5 and $10 合计 $15。')
ok(!h6.includes('class="katex"'), '货币 "$5 and $10" 不被误吃为公式')

const h7 = mdHtml('<script>alert(1)</script> 与 $a<b$ 公式')
ok(h7.includes('&lt;script&gt;'), 'HTML 仍被转义（安全链未破）')
ok(h7.includes('class="katex"'), '$a<b$ 中的 < 交给 KaTeX 而非被转义破坏')

// ---------- 无 katex（脚本缺失） ----------
const { mdHtml: mdHtmlNoK } = build({})
const h8 = mdHtmlNoK('公式 $x^2$ 保持原文')
ok(h8.includes('$x^2$'), 'katex 缺失时 $…$ 原样显示')
ok(!h8.includes('katex'), 'katex 缺失时不产出 KaTeX HTML')

console.log(`\n[probe-math-render] PASS=${pass} FAIL=${fail}`)
if (fail) process.exit(1)
