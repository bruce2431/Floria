/**
 * 探针：AI 生成图 markdown 代号渲染（web 端）
 *
 * 验两件事：
 *  1) `core/markdown.js` 的 mdInline 图片分支——注入 resolver 跑**真身** mdInline，
 *     合法代号出 <img>、非法/无 resolver 保留原文、代号白名单拒路径穿越。
 *  2) `chat/messages.js` 的 resolver 注册接线（项目 label → /gateway/file）。
 *
 * 手法同 probe-quote-ref：按花括号配平剥出真身函数，new Function 注入桩跑，不碰 DOM。
 */
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

const ROOT = resolve(import.meta.dir, '..')
const SRC = resolve(ROOT, 'src/gateway/web-src')

let pass = 0
let fail = 0
const ok = (m: string) => { pass++; console.log(`PASS  ${m}`) }
const bad = (m: string) => { fail++; console.log(`FAIL  ${m}`) }
const read = (p: string) => readFileSync(p, 'utf-8').replace(/\r\n/g, '\n')

// 花括号配平剥函数（含 `const f = (...) => {` 形式）
const fnSlice = (src: string, name: string) => {
  let i = src.indexOf(`function ${name}(`)
  if (i < 0) i = src.indexOf(`const ${name} = (`)
  if (i < 0) return ''
  let d = 0
  for (let k = src.indexOf('{', i); k >= 0 && k < src.length; k++) {
    if (src[k] === '{') d++
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1) }
  }
  return ''
}

const MD = resolve(SRC, 'core/markdown.js')
const MSG = resolve(SRC, 'chat/messages.js')
const md = existsSync(MD) ? read(MD) : ''
const msg = existsSync(MSG) ? read(MSG) : ''

// ---------- 1. 源码结构 ----------
if (/const MD_IMG_CODE = \/\^/.test(md)) ok('markdown.js 定义 MD_IMG_CODE 白名单')
else bad('markdown.js 缺 MD_IMG_CODE')

if (/setImageSrcResolver/.test(md) && /setImageSrcResolver,/.test(md)) ok('markdown.js 导出 setImageSrcResolver')
else bad('markdown.js 未导出 setImageSrcResolver')

const imgIdx = md.indexOf('!\\[') // 图片分支
const branchImg = md.indexOf('/!\\[([^\\]]*)\\]\\(([^)\\s]+)\\)/')
const linkIdx = md.indexOf('/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/')
if (branchImg >= 0 && linkIdx >= 0 && branchImg < linkIdx) ok('图片分支排在链接替换之前（否则被拆成 ! + <a>）')
else bad(`图片分支缺失或未排在链接替换之前（img=${branchImg} link=${linkIdx}）`)

if (/esc\(String\(src\)\)/.test(md)) ok('mdHtml 入口整体 esc（引号不破出属性）')
else bad('mdHtml 入口未整体 esc')

// mdImgResolver 模块级变量
if (/let mdImgResolver = null/.test(md)) ok('mdImgResolver 模块级单例（默认 null）')
else bad('mdImgResolver 缺失')

// ---------- 2. 跑真身 mdInline ----------
const MDIMG = /const MD_IMG_CODE = (\/.*\/)/.exec(md)
const MD_IMG_CODE = MDIMG ? (new Function(`return ${MDIMG[1]}`)() as RegExp) : null
if (MD_IMG_CODE) ok(`MD_IMG_CODE 取真身：${MD_IMG_CODE.source}`)
else bad('无法抽取 MD_IMG_CODE')

const inlineSrc = fnSlice(md, 'mdInline')
if (!inlineSrc) bad('无法剥出 mdInline')

const MDLINK = /const MD_LINK_OK = (\(u\) => .*)$/m.exec(md)
const MD_LINK_OK = MDLINK ? (new Function(`return ${MDLINK[1]}`)() as (u: string) => boolean) : (() => false)
if (MDLINK) ok('MD_LINK_OK 取真身（链接分支依赖）')
else bad('无法抽取 MD_LINK_OK')

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))

const NEVER = /(?!)/g // 永不匹配（本探针只验图片分支，令牌替换置桩）
const noopChip = () => ''

type Inline = (s: string) => string
const makeInline = (resolver: ((code: string) => string | null) | null): Inline => {
  if (!inlineSrc || !MD_IMG_CODE) return (s: string) => s
  const body = inlineSrc.replace(/^const mdInline = \(s\) =>/, 'function mdInline(s)')
  return new Function(
    'esc', 'MENTION_PLUGIN_RE', 'MENTION_SESSION_RE', 'MENTION_PATH_RE',
    'QUOTE_REF_RE', 'QUOTE_REPLY_RE', 'QUOTE_PDF_RE',
    'mentionChipHtml', 'quoteRefChipHtml', 'quoteReplyChipHtml', 'quotePdfChipHtml',
    'MD_IMG_CODE', 'mdImgResolver', 'MD_LINK_OK',
    `${body}\nreturn mdInline`,
  )(
    esc, NEVER, NEVER, NEVER, NEVER, NEVER, NEVER,
    noopChip, noopChip, noopChip, noopChip,
    MD_IMG_CODE, resolver, MD_LINK_OK,
  ) as Inline
}

const GATEWAY_RESOLVER = (code: string) =>
  `/gateway/file?label=Floria&path=${encodeURIComponent('.claude/images/' + code)}`

try {
  const run = makeInline(GATEWAY_RESOLVER)

  // 合法代号 → <img>
  const out1 = run('![](gemini-20261003120000.png)')
  if (/<img class="msg-img md-img" loading="lazy"/.test(out1)) ok('合法代号 → <img class="msg-img md-img">')
  else bad(`合法代号未出 <img>：${out1}`)
  if (out1.includes('gemini-20261003120000.png') && out1.includes('/gateway/file') && /src=/.test(out1))
    ok('<img> src = resolver 拼出的取图 URL')
  else bad(`src 未拼取图 URL：${out1}`)
  if (!out1.includes('![')) ok('合法代号不再残留 markdown 原文')
  else bad(`仍残留 ![] 原文：${out1}`)

  // 多个扩展名
  for (const f of ['a-20260101000000.jpg', 'a-20260101000000.jpeg', 'a-20260101000000.webp', 'a-20260101000000.gif']) {
    if (/<img /.test(run(`![](${f})`))) ok(`合法扩展名渲染：${f}`)
    else bad(`合法扩展名未渲染：${f}`)
  }

  // alt 保留
  const outAlt = run('![一张猫](a-20260101000000.png)')
  if (/alt="一张猫"/.test(outAlt)) ok('alt 文本保留')
  else bad(`alt 丢失：${outAlt}`)

  // 路径穿越 → 白名单拒 → 保留原文
  for (const badCode of ['../../etc/passwd.png', '/etc/passwd.png', '.claude/images/x.png', 'a/../b.png', 'C:\\x.png']) {
    const o = run(`![](${badCode})`)
    if (!/<img /.test(o) && o.includes(badCode)) ok(`路径穿越代号不渲染：${badCode}`)
    else bad(`路径穿越代号被渲染：${badCode} => ${o}`)
  }

  // 引号（XSS 载体）→ 白名单拒
  const outXss = run('![](a".png)')
  if (!/<img /.test(outXss)) ok('含引号代号被白名单拒（不注入属性）')
  else bad(`含引号代号被渲染：${outXss}`)

  // 大写扩展名（白名单小写敏感）→ 保留原文（当前行为，非 <img>）
  const outUpper = run('![](X.PNG)')
  if (!/<img /.test(outUpper)) ok('大写扩展名不命中（白名单小写敏感，保留原文）')
  else bad(`大写扩展名意外渲染：${outUpper}`)

  // 普通链接不受影响
  const outLink = run('[文档](https://example.com/a)')
  if (/<a href="https:\/\/example\.com\/a"/.test(outLink) || outLink.includes('example.com')) ok('普通链接仍走链接分支')
  else bad(`普通链接受影响：${outLink}`)

  // 无 resolver → 保留原文
  const runNull = makeInline(null)
  const outNull = runNull('![](a-20260101000000.png)')
  if (!/<img /.test(outNull) && outNull.includes('a-20260101000000.png')) ok('无 resolver → 保留原文（不兜底）')
  else bad(`无 resolver 仍渲染：${outNull}`)

  // resolver 返 null → 保留原文（全局会话场景）
  const runNull2 = makeInline(() => null)
  const outNull2 = runNull2('![](a-20260101000000.png)')
  if (!/<img /.test(outNull2) && outNull2.includes('a-20260101000000.png')) ok('resolver 返 null → 保留原文')
  else bad(`resolver 返 null 仍渲染：${outNull2}`)
} catch (e) {
  bad(`mdInline 真身调用失败：${(e as Error).message}`)
}

// ---------- 3. messages.js 接线 ----------
if (/import \{[^}]*setImageSrcResolver[^}]*\} from '\.\.\/core\/markdown\.js'/.test(msg)) ok('messages.js import setImageSrcResolver')
else bad('messages.js 未 import setImageSrcResolver')

if (/setImageSrcResolver\(/.test(msg)) ok('messages.js 注册 resolver')
else bad('messages.js 未注册 resolver')

if (/projectScope === 'project'/.test(msg)) ok('resolver 只在 project scope 生效')
else bad('resolver 未判 projectScope')

if (/\/gateway\/file\?label=/.test(msg)) ok('resolver 拼 /gateway/file 取图 URL')
else bad('resolver 未拼 /gateway/file')

if (/\.claude\/images\//.test(msg)) ok('resolver 路径 = .claude/images/<代号>')
else bad('resolver 路径不含 .claude/images/')

// ---------- 4. 权限豁免 ----------
const FS = resolve(ROOT, 'src/utils/permissions/filesystem.ts')
const fsSrc = existsSync(FS) ? read(FS) : ''
if (/normalizedNext === 'images'/.test(fsSrc)) ok('filesystem.ts .claude/ 豁免含 images')
else bad('filesystem.ts 未豁免 .claude/images')

// ---------- 汇总 ----------
console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
