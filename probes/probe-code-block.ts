// probe-code-block.ts —— 围栏代码块渲染链路核验（codex 化：头栏 + 语法高亮 + 软换行，2026-10-10）
//
// 直接取 web-src/core/markdown.js 的真实源码文本（剥 import/export），注入 esc / @提及 stub 与
// window（CMLiveMarkdown.highlightCode）/ document / localStorage stub，执行 mdHtml，断言：
//   ① 围栏 → .code-block（默认带 .wrap）＋头栏 .code-head（.code-lang 语言名 + .code-acts 两钮）
//   ② 高亮可用且有语言 → 正文走 hljs-* HTML 且挂 data-lang；lowlight 自行 escape ⇒ 不得二次转义
//   ③ 语言为空 / 库缺失 → 正文回落「已转义纯文本」、不挂 data-lang（头栏仍在，复制按钮照常可取文）
//   ④ pre>code 的 textContent 还原 = 原始代码（复制按钮的取文口径）
//   ⑤ toggleCodeWrap 翻转偏好 → 下一次渲染类名随之变；localStorage 持久化
//   ⑥ ```chart 双段围栏不受影响（仍产 .chart-embed）
// 非 DOM 依赖（mdHtml 为纯字符串函数）；document/localStorage 仅被 toggle/init 触碰，给 stub。
//
// 运行：BUN="F:/@WrokSpace/.tools/bun/bun.exe"; "$BUN" probes/probe-code-block.ts

const here = import.meta.dir
const mkSrc = await Bun.file(`${here}/../src/gateway/web-src/core/markdown.js`).text()

// 剥头注释 + import 行 + 尾部 export 块；其余照原样执行
const raw = mkSrc.replace(/\r\n/g, '\n')
const exportAt = raw.search(/^export \{/m)
const noExport = exportAt >= 0 ? raw.slice(0, exportAt) : raw
const body = noExport
  .split('\n')
  .filter((l) => !/^\s*import\s/.test(l))
  .join('\n')

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }) as Record<string, string>)[c])

function build(windowObj: Record<string, unknown>, doc: unknown, store: Map<string, string>) {
  const never = /$^/g
  const factory = new Function(
    'esc',
    'MENTION_PATH_RE', 'MENTION_PLUGIN_RE', 'MENTION_SESSION_RE', 'QUOTE_PDF_RE', 'QUOTE_REF_RE', 'QUOTE_REPLY_RE',
    'mentionChipHtml', 'quotePdfChipHtml', 'quoteRefChipHtml', 'quoteReplyChipHtml',
    'window', 'document', 'localStorage',
    `${body}\nreturn { mdHtml, mdInline, toggleCodeWrap, initCodeBlock }`,
  )
  const chip = () => ''
  const localStorageStub = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, v) },
  }
  return factory(esc, never, never, never, never, never, never, chip, chip, chip, chip, windowObj, doc, localStorageStub) as {
    mdHtml: (s: string, la?: string) => string
    mdInline: (s: string) => string
    toggleCodeWrap: () => boolean
    initCodeBlock: () => void
  }
}

// lowlight 行为拟真：内部自行 escapeHtml（喂已转义文本会二次转义 ⇒ 探针即靠此抓回归）
const lowlightStub = (code: string, lang: string) => ({ html: `<span class="hljs-${lang}">${esc(code)}</span>` })

let pass = 0
let fail = 0
const ok = (cond: boolean, msg: string) => {
  if (cond) { pass++; console.log(`  PASS  ${msg}`) }
  else { fail++; console.log(`  FAIL  ${msg}`) }
}

const docStub = { querySelectorAll: () => [] as unknown[] }
const decode = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&')

// ---------- 有高亮库 ----------
const storeA = new Map<string, string>()
const A = build({ CMLiveMarkdown: { highlightCode: lowlightStub } }, docStub, storeA)

const h1 = A.mdHtml('```js\nconst a = 1\n```')
ok(h1.includes('class="code-block wrap"'), '围栏 → .code-block 且默认 .wrap 软换行')
ok(h1.includes('class="code-head"'), '头栏 .code-head 在场')
ok(h1.includes('code-lang">js<'), '头栏显示语言名 js')
ok(h1.includes('cb-wrap') && h1.includes('cb-copy'), '头栏含换行钮 .cb-wrap 与复制钮 .cb-copy')
ok(h1.includes('<pre><code>'), '正文在 pre>code 内')
ok(h1.includes('class="hljs-js"'), '高亮路径生效（hljs-* 类）')
ok(h1.includes('data-lang="js"'), '高亮时挂 data-lang')
ok(h1.includes('data-md="```js'), 'data-md 挂围栏原文（复制/选区复制溯源）')

const src = 'if (a < b && c > d) { x = "q" }'
const h2 = A.mdHtml('```js\n' + src + '\n```')
ok(h2.includes('&lt;') && h2.includes('&amp;&amp;'), '尖括号/& 经 esc 一次进入输出')
ok(!h2.includes('&amp;lt;') && !h2.includes('&amp;amp;'), '喂高亮前已 unesc ⇒ 无二次转义')
const codeHtml = /<pre><code>([\s\S]*?)<\/code><\/pre>/.exec(h2)![1]
ok(decode(codeHtml.replace(/<[^>]+>/g, '')) === src, 'pre>code 的 textContent 还原 = 原始代码（复制口径）')

const h3 = A.mdHtml('```\nplain text\n```')
ok(h3.includes('code-lang">代码<'), '无语言围栏头栏回落「代码」')
ok(!h3.includes('data-lang'), '无语言不挂 data-lang')
ok(!h3.includes('hljs-'), '无语言不走高亮（禁猜语言）')
ok(h3.includes('plain text'), '无语言正文保留原文')

const h4 = A.mdHtml('```chart\n%%html\n<b>x</b>\n%%ascii\nX\n```')
ok(h4.includes('chart-embed'), '```chart 双段围栏仍产 .chart-embed（未受影响）')
ok(!h4.includes('code-block'), '```chart 不走代码块分支')

// ---------- 无高亮库（脚本缺失） ----------
const storeB = new Map<string, string>()
const B = build({}, docStub, storeB)
const h5 = B.mdHtml('```js\nx < y\n```')
ok(!h5.includes('hljs-'), '库缺失时不产 hljs-*')
ok(!h5.includes('data-lang'), '库缺失时不挂 data-lang')
ok(h5.includes('code-head') && h5.includes('cb-copy'), '库缺失时头栏/复制钮仍在')
ok(h5.includes('x &lt; y'), '库缺失时正文为已转义纯文本')

// ---------- 换行偏好 ----------
const storeC = new Map<string, string>()
const C = build({ CMLiveMarkdown: { highlightCode: lowlightStub } }, docStub, storeC)
ok(C.mdHtml('```js\nz\n```').includes('code-block wrap'), '默认渲染带 wrap')
ok(C.toggleCodeWrap() === false, 'toggleCodeWrap 翻转 true→false')
ok(!C.mdHtml('```js\nz\n```').includes('code-block wrap'), '翻转后新渲染不带 wrap')
ok(storeC.get('floria-code-wrap') === '0', '翻转写入 localStorage 偏好')

const storeD = new Map<string, string>([['floria-code-wrap', '0']])
const D = build({ CMLiveMarkdown: { highlightCode: lowlightStub } }, docStub, storeD)
D.initCodeBlock()
ok(!D.mdHtml('```js\nz\n```').includes('code-block wrap'), 'initCodeBlock 读到 0 → 渲染不带 wrap')

console.log(`\n[probe-code-block] PASS=${pass} FAIL=${fail}`)
if (fail) process.exit(1)
