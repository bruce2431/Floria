#!/usr/bin/env bun
/**
 * probe-quote-ref —— 选中文本引用（quote）链的结构不变量
 *
 * 链路：编辑区/消息流选中 → **松开鼠标**唤出浮窗（inputbar/quote.js；右键不拦）→ 引用 chip 落进输入栏
 * → serializeInput 出令牌 → 消息回显成同族胶囊。不变量：
 *  - 唤出手势：document mouseup（主键）+ 快照；**不得**再拦 contextmenu（浏览器原生菜单要留）；
 *  - 发送唯一口：浮窗的两个动作都必须经 inputbar/send.js 的 gwSend，不得自建 ws 发送；
 *  - chip 类名复用：引用 chip 必须是 `.mention`（× 删除与退格删除由 ctx-meter.js 的既有委托按此类处理）；
 *  - 令牌互斥：QUOTE_REF_RE 只认「引用」，MENTION_PATH_RE 只认「目录|文件」，两者不得互相吞；
 *  - 回显成对：renderUserText（乐观态）与 mdInline（落盘态）两个入口都要接 QUOTE_REF_RE；
 *  - 行号唯一来源 = DOM：编辑区纯文本走 Range 字符偏移、markdown 预览走渲染期落下的 data-l 行锚
 *    （**不得**拿渲染后的选中文本回查原文——格式符已丢，跨格式符边界必然找不到）；
 *  - cache-bust 同值：sw.js 的 CACHE 版本与 index.html 的 ?v= 必须一致（只 bump 一处 = 老资源常驻）。
 */
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'

const ROOT = resolve(import.meta.dir, '..')
const SRC = resolve(ROOT, 'src/gateway/web-src')
const WEB = resolve(ROOT, 'src/gateway/web')

let pass = 0
let fail = 0
const ok = (m: string) => { pass++; console.log(`PASS  ${m}`) }
const bad = (m: string) => { fail++; console.log(`FAIL  ${m}`) }

const read = (p: string) => readFileSync(p, 'utf-8')

// 从源码里按花括号配平剥出一个函数（供探针 new Function 跑真身；比正则/固定缩进切片稳）
const fnSlice = (src: string, name: string) => {
  const i = src.indexOf(`function ${name}(`)
  if (i < 0) return ''
  let d = 0
  for (let k = src.indexOf('{', i); k >= 0 && k < src.length; k++) {
    if (src[k] === '{') d++
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1) }
  }
  return ''
}

// ---- 1. quote.js 存在且两个动作齐 ----
const QUOTE = resolve(SRC, 'inputbar/quote.js')
const q = existsSync(QUOTE) ? read(QUOTE) : ''
if (!existsSync(QUOTE)) {
  bad('缺少 src/gateway/web-src/inputbar/quote.js')
} else {
  ok('inputbar/quote.js 在盘')
  for (const fn of ['quoteSnapOf', 'openQuotePop', 'closeQuotePop', 'insertRefChip', 'quoteStash', 'quoteSendNow']) {
    if (new RegExp(`function ${fn}\\(`).test(q)) ok(`quote.js 定义 ${fn}()`)
    else bad(`quote.js 缺 ${fn}()`)
  }
  if (q.includes('await gwSend()')) ok('立即发送走唯一发送口 gwSend()')
  else bad('quoteSendNow 未走 gwSend()（自建发送链？）')
  if (!/gws\s*\.\s*send\(/.test(q)) ok('quote.js 不自建 ws 发送（gws.send 零命中）')
  else bad('quote.js 直接 gws.send —— 绕开了 gwSend 唯一发送口')
  if (/chip\.className = 'mention ref'/.test(q)) ok('引用 chip 复用 .mention 类（× / 退格删除链自动生效）')
  else bad('引用 chip 未复用 .mention 类')
  if (!q.includes('wkEdText')) ok('quote.js 不再依赖编辑区原文缓存（行号唯一来源 = DOM）')
  else bad('quote.js 仍读 wkEdText —— 原文缓存已退役（应改走 data-l 行锚）')
  // 唤出手势（2026-09-28 用户定案）：松开鼠标那一刻；右键保留浏览器原生菜单
  if (/document\.addEventListener\('mouseup'/.test(q) && /if \(e\.button !== 0\) return/.test(q)) ok('唤出 = document mouseup（主键）')
  else bad('quote.js 未按 mouseup 唤出（用户定案：松开鼠标那一刻）')
  if (!/addEventListener\('contextmenu'/.test(q) && !/e\.preventDefault\(\)/.test(q.split('---------- 4.')[1] || '')) ok('不拦 contextmenu（浏览器原生菜单照旧）')
  else bad('quote.js 仍拦 contextmenu —— 用户要求保留原生右键菜单')
  if (/quoteSkipNextUp/.test(q)) ok('「点浮窗外关窗」的 mouseup 被消费（不会关掉又立刻重开）')
  else bad('缺 quoteSkipNextUp 守卫 —— 关窗后紧随的 mouseup 会把浮窗重开')
  // 「使用 AI 编辑」后光标必须落在胶囊之后（用户定案 2026-09-28：接着打字是给这条引用的说明）
  if (/function caretAfter\(/.test(q) && /const chip = insertRefChip\(snap\)[\s\S]{0,120}caretAfter\(chip\)/.test(q)) ok('「使用 AI 编辑」后光标折叠到新胶囊之后（caretAfter）')
  else bad('quoteStash 未把光标落到胶囊后 —— 打字会插在胶囊前面')
}

// ---- 2. 拼接器登记 + 执行序在启动序列之前 ----
const bundler = read(resolve(ROOT, 'scripts/bundle-web-modules.ts'))
const entry = bundler.match(/\{\s*file:\s*'inputbar\/quote\.js',\s*ranges:\s*\[\[(\d+)/)
if (entry) {
  ok(`拼接器已登记 inputbar/quote.js（区间号 ${entry[1]}）`)
  // __app__ 的两个区间：事件绑定（2933）+ 启动（5379）。顶层事件委托须排在启动序列之前。
  const appRanges = [...bundler.matchAll(/\{\s*file:\s*'__app__',\s*ranges:\s*\[\[(\d+),\s*\d+\],\s*\[(\d+)/g)]
  const boot = appRanges.length ? Math.max(...appRanges.map((m) => Number(m[2]))) : Infinity
  if (Number(entry[1]) < boot) ok(`quote.js 排在启动序列（${boot}）之前——顶层事件委托先于启动注册`)
  else bad(`quote.js 区间号 ${entry[1]} 晚于启动序列 ${boot}`)
} else {
  bad('拼接器 MODULES 未登记 inputbar/quote.js（新模块不会进 app.js）')
}

// ---- 3. 令牌正则：从源码抽真身来测（不在探针里复刻）----
const mention = read(resolve(SRC, 'inputbar/mention.js'))
const reOf = (name: string) => {
  const m = mention.match(new RegExp(`const ${name} = (\\/.*\\/[a-z]*)\\n`))
  if (!m) return null
  // eslint-disable-next-line no-new-func
  return new Function(`return ${m[1]}`)() as RegExp
}
const QRE = reOf('QUOTE_REF_RE')
const MRE = reOf('MENTION_PATH_RE')
if (QRE && MRE) {
  ok('从源码抽出 QUOTE_REF_RE / MENTION_PATH_RE 真身')
  const hit = (re: RegExp, s: string) => { re.lastIndex = 0; return re.exec(s) }
  const m1 = hit(QRE, '[@引用:Floria/src/x.ts#L12-20]')
  if (m1 && m1[1] === 'Floria/src/x.ts' && m1[2] === '12' && m1[3] === '20') ok('带行号令牌解析：路径 + 起止行')
  else bad(`带行号令牌解析异常：${JSON.stringify(m1 && m1.slice(1))}`)
  const m2 = hit(QRE, '前文 [@引用:src/a b.md] 后文')
  if (m2 && m2[1] === 'src/a b.md' && m2[2] === undefined) ok('无行号令牌解析：整段作路径、行号为空')
  else bad(`无行号令牌解析异常：${JSON.stringify(m2 && m2.slice(1))}`)
  if (!hit(QRE, '[@文件:src/x.ts]')) ok('QUOTE_REF_RE 不吞 [@文件:] 路径 chip（互斥）')
  else bad('QUOTE_REF_RE 吞掉了 [@文件:] 令牌')
  if (!hit(MRE, '[@引用:src/x.ts#L1-2]')) ok('MENTION_PATH_RE 不吞 [@引用:] 令牌（互斥）')
  else bad('MENTION_PATH_RE 吞掉了 [@引用:] 令牌')
  // 回复引用令牌：`[@引用回复:<第N条>|<标题>]`
  const RRE = reOf('QUOTE_REPLY_RE')
  if (RRE) {
    ok('从源码抽出 QUOTE_REPLY_RE 真身')
    const r1 = hit(RRE, '前文 [@引用回复:12|引用文本功能] 后文')
    if (r1 && r1[1] === '12' && r1[2] === '引用文本功能') ok('回复引用令牌解析：序号 + 会话标题')
    else bad(`回复引用令牌解析异常：${JSON.stringify(r1 && r1.slice(1))}`)
    if (!hit(QRE, '[@引用回复:12|引用文本功能]')) ok('QUOTE_REF_RE 不吞 [@引用回复:] 令牌（互斥）')
    else bad('QUOTE_REF_RE 吞掉了 [@引用回复:] 令牌')
    if (!hit(RRE, '[@引用:src/x.ts#L1-2]')) ok('QUOTE_REPLY_RE 不吞 [@引用:] 令牌（互斥）')
    else bad('QUOTE_REPLY_RE 吞掉了 [@引用:] 令牌')
  } else {
    bad('未能从 mention.js 抽出 QUOTE_REPLY_RE')
  }
} else {
  bad('未能从 mention.js 抽出 QUOTE_REF_RE / MENTION_PATH_RE')
}

// ---- 4. 序列化分支 + 回显成对 ----
if (/k === 'ref'\s*\)\s*\{\s*out \+= refToken/.test(mention)) ok('serializeInput 有 ref 分支（走 refToken）')
else bad('serializeInput 缺 ref 分支（引用 chip 会按插件令牌序列化）')
if (/rkind !== 'file'/.test(mention) && /\[@引用回复:\$\{/.test(mention)) ok('refToken：回复引用出原文 + 锚点令牌')
else bad('refToken 的回复引用分支缺失/形态变了')
if (mention.includes('quoted') === false && /\[@引用:\$\{p\}/.test(mention)) ok('refToken：文件引用只出位置令牌（不含原文）')
else bad('refToken 的文件引用分支形态变了')
if (/\.replace\(QUOTE_REF_RE/.test(mention)) ok('renderUserText 接 QUOTE_REF_RE（乐观态回显）')
else bad('renderUserText 未接 QUOTE_REF_RE')
if (/\.replace\(QUOTE_REPLY_RE/.test(mention)) ok('renderUserText 接 QUOTE_REPLY_RE（乐观态回显）')
else bad('renderUserText 未接 QUOTE_REPLY_RE')
const md = read(resolve(SRC, 'core/markdown.js'))
if (/\.replace\(QUOTE_REF_RE/.test(md)) ok('mdInline 接 QUOTE_REF_RE（落盘态回显）')
else bad('mdInline 未接 QUOTE_REF_RE')
if (/\.replace\(QUOTE_REPLY_RE/.test(md)) ok('mdInline 接 QUOTE_REPLY_RE（落盘态回显）')
else bad('mdInline 未接 QUOTE_REPLY_RE')

// 原文块剥离函数真身（§4c 与 §9 共用）：QUOTE_REPLY_BODY_RE 是模块级常量，须注入
const QRBODY = reOf('QUOTE_REPLY_BODY_RE')
const stripBodySrc = fnSlice(mention, 'stripQuoteReplyBody')
// eslint-disable-next-line no-new-func
const stripBody = (QRBODY && stripBodySrc ? new Function('QUOTE_REPLY_BODY_RE', `${stripBodySrc}\nreturn stripQuoteReplyBody`)(QRBODY) : null) as ((t: string) => string) | null

// ---- 4b. 回复引用：真身 refToken 的**首尾不得带换行**（用户实报「文本的引用自带一个换行」）----
{
  const rtSrc = fnSlice(mention, 'refToken')
  if (!rtSrc) bad('未能剥出 refToken 函数体')
  else {
    // eslint-disable-next-line no-new-func
    const rt = new Function('refPath', `${rtSrc}\nreturn refToken`)((f: string) => f) as (d: Record<string, unknown>) => string
    const tok = rt({ rkind: 'reply', quote: '第一行\n第二行', title: '引用文本功能', idx: 12 })
    const want = '[@引用回复:12|引用文本功能]\n第一行\n第二行\n[/引用回复]'
    if (tok === want) ok('回复引用令牌形态：锚点令牌 + 原文块（/引用回复 收尾）')
    else bad(`回复引用令牌形态变了：${JSON.stringify(tok)}`)
    if (!tok.startsWith('\n') && !tok.endsWith('\n')) ok('回复引用令牌首尾无换行（不自带空行）')
    else bad('回复引用令牌首尾仍带换行')
    // 标题内的 `]` / `|` / 换行是令牌结构字符：必须被替换掉，否则令牌碎裂
    const t2 = rt({ rkind: 'reply', quote: 'x', title: 'a]b|c\nd', idx: 3 })
    if (t2 === '[@引用回复:3|a b c d]\nx\n[/引用回复]') ok('标题内结构字符（] | 换行）已归一，令牌不碎裂')
    else bad(`标题未归一：${JSON.stringify(t2)}`)
  }
}

// ---- 4c. 原文块只给模型看：渲染前必须剥掉（用户实报「为什么文本信息也在气泡里」）----
{
  const bodyReSrc = mention.match(/const QUOTE_REPLY_BODY_RE = (\/[^\n]*\/g)/)
  const stripSrc = fnSlice(mention, 'stripQuoteReplyBody')
  if (!bodyReSrc || !stripSrc) bad('缺 QUOTE_REPLY_BODY_RE / stripQuoteReplyBody')
  else if (!stripBody) bad('stripQuoteReplyBody 真身未能装载')
  else {
    const strip = stripBody
    const wrapped = '[@引用回复:12|引用文本功能]\n第一行\n第二行\n[/引用回复]'
    const out = strip(wrapped)
    if (out === '[@引用回复:12|引用文本功能]') ok('stripQuoteReplyBody：原文块压回单一锚点令牌（气泡里不出现原文）')
    else bad(`stripQuoteReplyBody 形态变了：${JSON.stringify(out)}`)
    const mixed = '看这段：' + wrapped + ' 就这样'
    if (strip(mixed) === '看这段：[@引用回复:12|引用文本功能] 就这样') ok('块外正文字节不动（只吃引用块本身）')
    else bad(`stripQuoteReplyBody 吃掉了块外正文：${JSON.stringify(strip(mixed))}`)
    if (strip(out) === out) ok('stripQuoteReplyBody 幂等（裸令牌不受影响）')
    else bad('stripQuoteReplyBody 非幂等')
    // 三个渲染入口都要过这一刀（漏一个 = 该路径仍把原文摆进气泡）
    const messages = read(resolve(SRC, 'chat/messages.js'))
    const approval = read(resolve(SRC, 'inputbar/approval.js'))
    if (/export \{[^}]*stripQuoteReplyBody,/.test(mention)) ok('mention.js 导出 stripQuoteReplyBody')
    else bad('mention.js 未导出 stripQuoteReplyBody')
    if (/import \{[^}]*stripQuoteReplyBody[^}]*\} from '\.\.\/inputbar\/mention\.js'/.test(messages) && /stripQuoteReplyBody\(txt\)/.test(messages)) ok('messages.js 落盘气泡渲染前剥原文块')
    else bad('messages.js 未剥原文块 —— 原文仍会出现在气泡里')
    if ((approval.match(/stripQuoteReplyBody\(/g) || []).length >= 2) ok('approval.js 乐观气泡 + 排队项两处都剥')
    else bad('approval.js 漏剥（乐观气泡或排队项）')
  }
}

// ---- 5. 编辑区行号唯一来源 = DOM 行锚（渲染期落 data-l）----
// 反例（已根治）：拿「渲染后的选中文本」回查 markdown 原文——渲染把 `**`/`` ` ``/链接等格式符丢了，
// 选中一旦跨在格式符边界上（如「收尾必做清单：」对 `**收尾必做清单**：`）indexOf 必然 -1 ⇒ 行号丢失。
const work = read(resolve(SRC, 'sidebar/work.js'))
if (!work.includes('wkEdText')) ok('work.js 已退役原文缓存 wkEdText（少一个状态源）')
else bad('work.js 仍留 wkEdText —— 与行锚双轨')
if (/mdHtml\(text, 'data-l'\)/.test(work)) ok("work.js 渲染 markdown 预览时传行锚（mdHtml(text, 'data-l')）")
else bad('work.js 的 markdown 预览未落行锚')
if (/\[data-l\]|querySelector\('pre\.wk-code'\)/.test(q) && /QUOTE_LINE_ATTR = 'data-l'/.test(q)) ok('quote.js 行锚常量与纯文本偏移两条路径并存')
else bad('quote.js 未按 data-l 取行')
if (/function quoteLineOf\(/.test(q) && /quoteLineOf\(range\.startContainer\)/.test(q)) ok('quote.js 由选区容器向上取行锚（quoteLineOf）')
else bad('quote.js 缺 quoteLineOf —— 选区 → 行号链断开')
if (/const a = quoteLineOf/.test(q) && /Math\.min\(a, b\)/.test(q)) ok('选区首尾两行归一（min/max），跨行选中也不会倒挂')
else bad('quote.js 未对选区首尾行归一')
// markdown.js：lineAttr 为可选第二参数，默认不带锚（会话消息渲染不受影响）
if (/function mdHtml\(src, lineAttr\)/.test(md) && /const la = \(n\) => \(lineAttr/.test(md)) ok('mdHtml 第二参数 = 行锚属性名（不传 = 现状）')
else bad('mdHtml 未接 lineAttr —— 行锚无处落')
for (const [name, re] of [
  ['标题 h1-h4', /<h\$\{h\[1\]\.length\}\$\{la\(i \+ 1\)\}>/],
  ['引用块 blockquote', /<blockquote\$\{la\(i \+ 1\)\}>/],
  ['列表项 li', /<li\$\{la\(i \+ 1\)\}>/],
  ['分隔线 hr', /<hr\$\{la\(i \+ 1\)\}>/],
  ['表格行 tr', /<tr\$\{la\(i \+ 1\)\}>/],
  ['段落逐行 span', /para\.push\(lw\(i \+ 1,/],
  ['代码块逐行 span', /codeBuf\.map\(\(l, k\) => lw\(codeNums\[k\], l\)\)/],
] as [string, RegExp][]) {
  if (re.test(md)) ok(`行锚覆盖${name}`)
  else bad(`行锚缺${name}（该处选中取不到行号）`)
}
if (/codeNums\.push\(i \+ 1\)/.test(md)) ok('代码块记源行号（codeNums）')
else bad('代码块未记源行号 —— 围栏内选中取不到行')
if (!/indexOf\(text\)/.test(q)) ok('quote.js 已删「渲染文本回查原文」的启发式')
else bad('quote.js 仍在用 indexOf 回查原文（跨格式符必失败）')

// ---- 6. 样式 ----
const css = read(resolve(WEB, 'styles.css'))
for (const sel of ['.quote-pop', '.qp-row', '.qp-bar', '.qp-send', '.mention.ref', '.mention-chip.m-ref']) {
  if (css.includes(sel)) ok(`styles.css 含 ${sel}`)
  else bad(`styles.css 缺 ${sel}`)
}
// 浅色是定案（用户点名「对应换成浅色」）：此块不跟主题变量
if (/\.quote-pop \{[\s\S]*?background: #fff;/.test(css)) ok('.quote-pop 浅色硬编码（不跟 --bg/--text 主题变量）')
else bad('.quote-pop 仍跟随主题变量 —— 与「换成浅色」定案不符')
if (css.includes('.qp-tab')) bad('styles.css 仍留 .qp-tab —— tab 条已被竖排菜单取代')
else ok('旧 tab 条样式已删（无遗留）')
// 聚焦指示载体 = 整行描边，不用浏览器默认 focus ring（全局 2px outline + 6px 圆角与输入行不齐）
if (/\.quote-pop \.qp-in:focus-visible \{ outline: none; \}/.test(css)) ok('输入行的默认 focus ring 已关（蓝色矩形错位根因）')
else bad('未关 .qp-in 的默认 focus ring —— 蓝色矩形仍会错位')
if (/\.qp-bar:focus-within \{ border-color: #4176e6; \}/.test(css)) ok('聚焦指示落在整行（.qp-bar:focus-within 描边变色）')
else bad('缺 .qp-bar:focus-within —— 关掉 ring 后焦点态就不可见了')

// ---- 7. cache-bust 三处同值 ----
const sw = read(resolve(WEB, 'sw.js'))
const html = read(resolve(WEB, 'index.html'))
// 只认被打包的三个静态入口（styles.css / app.js）——index.html 里另有素材版本号（如 state-newchat.webp?v=2），
// 与 SW 缓存版本无关，混进来会误报。
const swVer = sw.match(/const CACHE = 'floria-v(\d+)'/)
const htmlVers = [...html.matchAll(/\/(?:styles\.css|app\.js)\?v=(\d+)/g)].map((m) => m[1])
const uniq = [...new Set(htmlVers)]
if (swVer && uniq.length === 1 && uniq[0] === swVer[1]) ok(`cache-bust 同值：sw v${swVer[1]} = index.html ?v=${uniq[0]}（${htmlVers.length} 处）`)
else bad(`cache-bust 不一致：sw=${swVer && swVer[1]} / index.html=${uniq.join(',')}`)

// ---- 8. 产物侧复核 ----
const APP = resolve(WEB, 'app.js')
if (existsSync(APP)) {
  const app = read(APP)
  if (app.includes('---------- 选中引用（quote）----------')) ok('产物 app.js 已内嵌 quote 段')
  else bad('产物 app.js 未内嵌 quote 段（未重新构建？）')
} else {
  bad('缺少产物 src/gateway/web/app.js')
}

// ---- 9. 行锚功能性验证：跑**真身** mdHtml（剥 import/export，注入 esc 与令牌桩）----
// 只验「锚 = 源行号」这一件事；mdInline 的令牌替换用桩（本探针已在别处验其真身）。
{
  const escStub = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const never = /(?!)/g
  // 真身 quoteReplyChipHtml（icon 用桩）+ 真身 QUOTE_REPLY_RE：回复引用令牌 → 胶囊走完整链
  const replyChipSrc = fnSlice(mention, 'quoteReplyChipHtml')
  const QREPLY = reOf('QUOTE_REPLY_RE')
  // eslint-disable-next-line no-new-func
  const replyChip = (replyChipSrc && QREPLY ? new Function('MENTION_SESSION_ICON', `${replyChipSrc}\nreturn quoteReplyChipHtml`)('<i></i>') : null) as ((i: string, t: string) => string) | null
  if (!replyChip || !QREPLY) bad('未能剥出真身 quoteReplyChipHtml / QUOTE_REPLY_RE')
  let html = ''
  try {
    const body = md.replace(/^import .*$/gm, '').replace(/^export \{[\s\S]*?^\}$/m, '')
    // eslint-disable-next-line no-new-func
    const fn = new Function('esc', 'MENTION_PATH_RE', 'MENTION_PLUGIN_RE', 'MENTION_SESSION_RE', 'QUOTE_REF_RE', 'QUOTE_REPLY_RE', 'mentionChipHtml', 'quoteRefChipHtml', 'quoteReplyChipHtml', `${body}\nreturn mdHtml`)
    const render = fn(escStub, never, never, never, never, QREPLY || never, (k: string, v: string) => v, (p: string) => p, replyChip || ((p: string) => p)) as (s: string, a?: string) => string
    const src = '# 标题\n\n**加粗**：正文\n第二行\n\n- 项一\n- 项二\n\n```\ncode1\ncode2\n```\n'
    html = render(src, 'data-l')
    const want = [
      [3, '<span data-l="3">'],      // 段落首行（含加粗）
      [4, '<span data-l="4">'],      // 段落次行
      [1, '<h1 data-l="1">'],
      [6, '<li data-l="6">'],
      [10, '<span data-l="10">'],    // 代码块首行
      [11, '<span data-l="11">'],
    ] as [number, string][]
    let okAll = true
    for (const [n, frag] of want) if (!html.includes(frag)) { okAll = false; bad(`行锚缺失：第 ${n} 行未落 ${frag}`) }
    if (okAll) ok('行锚落点逐一对应源行号（段落逐行 / 标题 / 列表 / 代码块）')
    // 回归靶：渲染文本「加粗：」跨在 `**` 边界上 —— 旧法（回查原文）必 -1，行锚法必得 3
    if (src.indexOf('加粗：') === -1) ok('回归靶成立：`**加粗**：` 的渲染文本回查原文为 -1（旧法必丢行号）')
    else bad('回归靶失效：该文本竟能回查到原文（用例需更新）')
    const m = html.match(/<span data-l="(\d+)">(?:(?!<span data-l)[\s\S])*?加粗/)
    if (m && m[1] === '3') ok('同一选区经行锚取到第 3 行（新法闭环）')
    else bad(`行锚未覆盖该段落文本：${m ? m[1] : '未命中'}`)
    // 回复引用全链：真身 refToken 出「锚点 + 原文块」→ stripQuoteReplyBody 剥块 → 渲染成胶囊。
    // 气泡里既不得有原文，也不得裸露令牌（用户实报「为什么文本信息也在气泡里」）。
    const wrapped = '[@引用回复:12|引用文本功能]\n原文一句\n原文二句\n[/引用回复]'
    const stripped = stripBody ? stripBody(wrapped + '\n补充一句') : wrapped
    const h2 = render(stripped)
    if (!h2.includes('原文一句') && !h2.includes('原文二句')) ok('原文块不出现在气泡里（模型侧 payload 已剥）')
    else bad(`原文仍出现在气泡里：${JSON.stringify(h2)}`)
    if (h2.includes('补充一句')) ok('引用块之后的正文照常渲染')
    else bad(`块外正文被吞：${JSON.stringify(h2)}`)
    if (h2.includes('mention-chip m-ref') && h2.includes('引用自「引用文本功能」· 第 12 条回复')) ok('回复引用锚点渲染成胶囊（与文件引用同族）')
    else bad(`回复引用未渲染成胶囊：${JSON.stringify(h2)}`)
    if (!h2.includes('[@引用回复:')) ok('令牌已被消费（不裸露在气泡里）')
    else bad('令牌裸露在消息里（渲染入口漏接？）')
  } catch (e) {
    bad(`mdHtml 真身调用失败：${(e as Error).message}`)
  }
  // 不传 lineAttr = 现状（会话消息渲染不得带锚）
  try {
    const body = md.replace(/^import .*$/gm, '').replace(/^export \{[\s\S]*?^\}$/m, '')
    // eslint-disable-next-line no-new-func
    const fn = new Function('esc', 'MENTION_PATH_RE', 'MENTION_PLUGIN_RE', 'MENTION_SESSION_RE', 'QUOTE_REF_RE', 'QUOTE_REPLY_RE', 'mentionChipHtml', 'quoteRefChipHtml', 'quoteReplyChipHtml', `${body}\nreturn mdHtml`)
    const render = fn(escStub, never, never, never, never, QREPLY || never, (k: string, v: string) => v, (p: string) => p, replyChip || ((p: string) => p)) as (s: string, a?: string) => string
    if (!render('# 标题\n\n正文\n').includes('data-l')) ok('不传 lineAttr 时零行锚（会话消息渲染不受影响）')
    else bad('默认渲染带上了行锚 —— 泄漏到会话消息')
  } catch (e) {
    bad(`mdHtml 默认路径调用失败：${(e as Error).message}`)
  }
}

console.log(`\n${pass}/${fail}`)
process.exit(fail === 0 ? 0 : 1)
