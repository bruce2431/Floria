#!/usr/bin/env bun
/**
 * probe-comment-marks —— 评论「原文标记」结构不变量（2026-10-06）
 *
 * 目标：评论不只列在右栏，还要**落回原文**——被批注的行/块在阅读态有可见标记。
 * 结构锁点（只读源码，不启 DOM）：
 *   1) comments.js 是标记的唯一数据源：导出 cmtRangesFor（按 path + l0/l1），
 *      评论增删改后经 cmtAfterChange 回调 refreshMarks 让 work.js 重绘标记。
 *   2) work.js 阅读态渲染末尾调 cmtApplyMarks：md 用 mdHtml 的 data-l 行锚、
 *      纯文本走 wkCodeHtml 逐行落 data-l span；命中行加 .cmt-mark / .cmt-mark-res + data-cmt-id。
 *   3) 定位回跳：面板点定位 → openFile(path, id) → work.js 记 wkCmtScrollId → 渲染完滚到该行。
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

// ---- 2. work.js：阅读态打标 ----
if (/import \{[^}]*cmtRangesFor[^}]*\} from '\.\/comments\.js'/.test(work)) ok('work.js import cmtRangesFor（标记单一数据源）')
else bad('work.js 未 import cmtRangesFor')
if (/function cmtApplyMarks\(/.test(work)) ok('work.js 定义 cmtApplyMarks（据行范围给 [data-l] 加类）')
else bad('work.js 缺 cmtApplyMarks')
if (/function wkCodeHtml\(/.test(work) && /data-l="\$\{i \+ 1\}"/.test(work)) ok('work.js 纯文本阅读态逐行落 data-l span（wkCodeHtml）')
else bad('work.js 纯文本阅读态未逐行落锚 —— 代码视图打不了标')
if (/body\.innerHTML = `<pre class="wk-code">\$\{wkCodeHtml\(wkEdText\)\}<\/pre>`/.test(work)) ok('renderEdBody 代码分支改用 wkCodeHtml(WkEdText)')
else bad('renderEdBody 代码分支未接 wkCodeHtml')
if (/cmtApplyMarks\(\) \/\/ 评论标记/.test(work)) ok('阅读态渲染末尾调用 cmtApplyMarks（md 与纯文本共用）')
else bad('阅读态渲染未调 cmtApplyMarks')
if (/classList\.add\('cmt-mark', hit\.resolved \? 'cmt-mark-res' : 'cmt-mark-open'\)/.test(work)) ok('命中行加 .cmt-mark / .cmt-mark-res（未解决/已解决两态）')
else bad('命中的行未区分未解决/已解决类')
if (/setAttribute\('data-cmt-id', hit\.id\)/.test(work)) ok('命中行落 data-cmt-id（回跳定位锚）')
else bad('命中行未落 data-cmt-id')
if (/refreshMarks: cmtApplyMarks/.test(work)) ok('mountWork 注册 refreshMarks 钩子（评论变更 → 重绘标记）')
else bad('mountWork 未注册 refreshMarks')
if (/wkCmtScrollId/.test(work) && /scrollIntoView\(\{ block: 'center' \}\)/.test(work)) ok('定位回跳：wkCmtScrollId 消费时 scrollIntoView（滚到被批注行）')
else bad('缺定位回跳滚动')
if (/cmtLoad\(state\.workProj\) \/\/ 评论恢复态补拉/.test(work) && /cmtLoad\(label\) \/\/ 原文标记也需要当前项目的评论/.test(work)) ok('ensureWork / selectProject 恒拉评论（原文标记不只评论 tab 才需要）')
else bad('原文标记场景未恒拉评论数据')

// ---- 3. 样式 + 拼接注册 + cache-bust ----
if (/\.cmt-mark \{/.test(css) && /\.cmt-mark-res \{/.test(css) && /\.cmt-flash \{/.test(css)) ok('styles.css 有 .cmt-mark / .cmt-mark-res / .cmt-flash')
else bad('styles.css 缺评论标记样式')
if (/sidebar\/comments\.js/.test(bundle)) ok('bundle-web-modules 已注册 sidebar/comments.js')
else bad('bundle-web-modules 未注册 comments.js')
const vCss = /styles\.css\?v=(\d+)/.exec(idx)?.[1]
const vApp = /app\.js\?v=(\d+)/.exec(idx)?.[1]
const vSw = /floria-v(\d+)/.exec(sw)?.[1]
if (vCss && vCss === vApp && vCss === vSw) ok(`cache-bust 三处同值（styles/app/sw = v${vSw}）`)
else bad(`cache-bust 不一致：styles=v${vCss} app=v${vApp} sw=v${vSw}`)

console.log(`\n${pass}/${fail}`)
process.exit(fail === 0 ? 0 : 1)
