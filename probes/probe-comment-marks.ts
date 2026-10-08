#!/usr/bin/env bun
/**
 * probe-comment-marks —— 评论「原文标记」结构不变量（2026-10-06，2026-10-07 改编辑器装饰器）
 *
 * 目标：评论不只列在右栏，还要**落回原文**——被批注的行在编辑区有可见标记。
 * 结构锁点（只读源码，不启 DOM）：
 *   1) comments.js 是标记的唯一数据源：导出 cmtRangesFor（按 path + l0/l1），
 *      评论增删改后经 cmtAfterChange 回调 refreshMarks 让 work.js 重绘标记。
 *   2) 编辑区（所有可编辑文本文件）恒为 CodeMirror 6：work.js 渲染末尾调 cmtApplyMarks，
 *      经 wkEdCmtEffect → StateField → Decoration.line 把命中行加 .cmt-mark / .cmt-mark-res。
 *   3) 定位回跳：面板点定位 → openFile(path, id) → work.js 记 wkCmtScrollId →
 *      渲染完经 wkEdScrollToLine → EditorView.scrollIntoView 滚到该行 + 闪标。
 *   4) styles.css 有对应样式；cache-bust 两处同值。
 */
import { readFileSync } from 'fs'
import { resolve } from 'path'

const ROOT = resolve(import.meta.dir, '..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')

let pass = 0
let fail = 0
const ok = (m: string) => {
  pass++
  console.log(`PASS  ${m}`)
}
const bad = (m: string) => {
  fail++
  console.log(`FAIL  ${m}`)
}

const cmt = read('src/gateway/web-src/sidebar/comments.js')
const work = read('src/gateway/web-src/sidebar/work.js')
const css = read('src/gateway/web/styles.css')
const bundle = read('scripts/bundle-web-modules.ts')
const idx = read('src/gateway/web/index.html')
const sw = read('src/gateway/web/sw.js')

// ---- 1. comments.js：标记数据源 + 变更回调 ----
if (/function cmtRangesFor\(/.test(cmt)) ok('comments.js 导出 cmtRangesFor（按文件路径给评论行范围）')
else bad('comments.js 缺 cmtRangesFor —— 原文标记无数据源')
if (/cmtRangesFor,/.test(cmt)) ok('comments.js 的 cmtRangesFor 已 export（work.js 可 import）')
else bad('comments.js 未导出 cmtRangesFor')
if (/function cmtAfterChange\(/.test(cmt) && /cmtRefreshMarks\(\)/.test(cmt)) ok('cmtAfterChange 回调 refreshMarks（评论变更 → 原文标记重绘）')
else bad('comments.js 缺 cmtAfterChange/refreshMarks 回调 —— 增删评论后原文标记不更新')
if (/refreshMarks: /.test(cmt) || /h\.refreshMarks/.test(cmt)) ok('cmtSetHooks 接受 refreshMarks（与 work.js 解耦注册）')
else bad('cmtSetHooks 未接 refreshMarks')
if (/cmtOpenFile\(loc\.dataset\.cmtloc, item \? item\.dataset\.cid : ''\)/.test(cmt)) ok('面板定位把评论 id 一并交给 openFile（回跳能滚到该行）')
else bad('面板定位未传评论 id')

// ---- 2. work.js：编辑器行装饰器打标 ----
if (/import \{[^}]*cmtRangesFor[^}]*\} from '\.\/comments\.js'/.test(work)) ok('work.js import cmtRangesFor（标记单一数据源）')
else bad('work.js 未 import cmtRangesFor')
if (/function cmtApplyMarks\(/.test(work)) ok('work.js 定义 cmtApplyMarks（把评论行范围送进编辑器装饰器）')
else bad('work.js 缺 cmtApplyMarks')
if (/function wkEdBuildCmtDeco\(marks, st\)/.test(work) && /Decoration\.line\(\{ class: 'cmt-mark ' \+ \(m\.resolved/.test(work)) ok('评论标记 = Decoration.line（升序 + 未解决/已解决两态类）')
else bad('评论标记未接编辑器行装饰器')
if (/wkEdCmtEffect\.of\(marks\)/.test(work) && /e\.is\(wkEdCmtEffect\)/.test(work)) ok('标记经 StateEffect → StateField 落装饰（cmtApplyMarks → wkEdCmtEffect）')
else bad('评论标记未接 StateEffect/StateField')
if (/wkEdCmtEffect\.of\(marks\)/.test(work) && /wkEdView\.dispatch/.test(work)) ok('cmtApplyMarks 经 wkEdView.dispatch 送标记（无 DOM [data-l] 走法）')
else bad('cmtApplyMarks 未走编辑器 dispatch')
if (/function wkEdScrollToLine\(/.test(work) && /EditorView\.scrollIntoView/.test(work)) ok('定位回跳：wkEdScrollToLine → scrollIntoView + 闪标')
else bad('缺定位回跳（wkEdScrollToLine）')
if (/cmtApplyMarks\(\) \/\/ 评论标记/.test(work)) ok('阅读态渲染末尾调用 cmtApplyMarks')
else bad('阅读态渲染未调 cmtApplyMarks')
if (/refreshMarks: cmtApplyMarks/.test(work)) ok('mountWork 注册 refreshMarks 钩子（评论变更 → 重绘标记）')
else bad('mountWork 未注册 refreshMarks')
if (/wkCmtScrollId/.test(work) && /wkEdView\.state\.doc\.lines/.test(work)) ok('定位回跳：wkCmtScrollId 消费时行号夹取 + scrollIntoView')
else bad('缺定位回跳滚动')
if (/cmtLoad\(state\.workProj\) \/\/ 评论恢复态补拉/.test(work) && /cmtLoad\(label\) \/\/ 原文标记也需要当前项目的评论/.test(work)) ok('ensureWork / selectProject 恒拉评论（原文标记不只评论 tab 才需要）')
else bad('原文标记场景未恒拉评论数据')

// ---- 3. 编辑区统一为 CodeMirror 6（所有可编辑文本文件；两态已撤） ----
if (/CM\.EditorView\.lineWrapping/.test(work)) ok('work.js 编辑器启用 lineWrapping（长行按窗口软换行）')
else bad('work.js 编辑器缺 lineWrapping —— 长行不换行')
if (/wkEdLangComp = new CM\.Compartment\(\)/.test(work) && /function wkEdSetLang\(path\)/.test(work)) ok('work.js 语言 compartment（按扩展名热换语言扩展）')
else bad('work.js 缺语言 compartment / wkEdSetLang')
if (/function wkEdLangExt\(path\)/.test(work) && /CM\.markdown\(\{ base: CM\.markdownLanguage \}\)/.test(work)) ok('wkEdLangExt：md 走 Live Preview 全套，其余按扩展名取语言包')
else bad('wkEdLangExt 未接 markdown / 语言包')
if (/wkEdBuildHlStyle/.test(work) && /HighlightStyle\.define/.test(work)) ok('代码高亮 = HighlightStyle（tag → --hl-* CSS 变量，日夜随动）')
else bad('代码高亮未接 HighlightStyle')
if (!/wkCodeHtml|wk-ed-ta|wk-ed-hl|state\.wkEdit|applyEdMode/.test(work)) ok('work.js 无两态残留（textarea 编辑 / 阅读态 / 模式按钮全清）')
else bad('work.js 仍有两态残留（wkCodeHtml / wk-ed-ta / wk-ed-hl / state.wkEdit / applyEdMode）')
if (/body\.replaceChildren\(wkEdHost\)/.test(work)) ok('renderEdBody：可编辑文本一律挂 CodeMirror 宿主')
else bad('renderEdBody 未统一挂 CodeMirror 宿主')

// ---- 4. 样式 + 拼接注册 + cache-bust ----
if (/\.cmt-mark \{/.test(css) && /\.cmt-mark-res \{/.test(css) && /\.cmt-flash \{/.test(css)) ok('styles.css 有 .cmt-mark / .cmt-mark-res / .cmt-flash')
else bad('styles.css 缺评论标记样式')
if (/--hl-kw:/.test(css) && /\.wk-ed-cm \{/.test(css)) ok('styles.css 有 --hl-* 高亮令牌 + .wk-ed-cm 宿主样式')
else bad('styles.css 缺 --hl-* 令牌 / .wk-ed-cm 样式')
if (/sidebar\/comments\.js/.test(bundle)) ok('bundle-web-modules 已注册 sidebar/comments.js')
else bad('bundle-web-modules 未注册 comments.js')
const vCss = /styles\.css\?v=(\d+)/.exec(idx)?.[1]
const vApp = /app\.js\?v=(\d+)/.exec(idx)?.[1]
const vSw = /floria-v(\d+)/.exec(sw)?.[1]
if (vCss && vCss === vApp && vCss === vSw) ok(`cache-bust 三处同值（styles/app/sw = v${vSw}）`)
else bad(`cache-bust 不一致：styles=v${vCss} app=v${vApp} sw=v${vSw}`)

console.log(`\n${pass}/${fail}`)
process.exit(fail === 0 ? 0 : 1)
