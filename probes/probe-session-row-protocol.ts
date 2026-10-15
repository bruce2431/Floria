#!/usr/bin/env bun
/**
 * probe-session-row-protocol —— 会话行（.sess-item）统一行为协议不变量（2026-10-15 任务 A）
 *
 * 背景（回归）：`.sess-item` 在 chat 侧栏（#recent-body / 项目管理卡列表）与 work 下沉区
 * （#wk-body 里的 .wk-chats）各渲一份，行 HTML 本来就是同一份实现（recent.js itemHtml），行为却是两套：
 *   · chat：bindSessClicks 逐行绑点击（含 reLiftHash 重扶 / 移动端收侧栏）+ bindSessLift 逐行绑 hover 扶起；
 *   · work：只在 #wk-body 容器上委托了一段「wkEnsureTab + state.wkMainTab/wkAssist + navigate」，
 *     既没接 reLiftHash 重扶，也没接 hover 扶起 ⇒ 同一行两模式表现分叉（浮起不一致 / 选中滞后 /
 *     点了像没反应），且扶起的滚动/滚轮拍回只挂在 #recent-body 上，work 列表滚轮是死区。
 *
 * 协议（唯一出口，谁拥有行谁接线）：
 *   A1 activateSession(hash, { source })   会话激活唯一口（导航 + 由 source 落地的页面态差异）
 *   A2 bindSessionRows(root, { source })   行行为唯一接线口（点击 → activateSession + hover 扶起）
 *   A3 work 页面态（顶栏胶囊 / 聊天栏顶上来）只在 source='work' 分支内落地——chat 点行不改 work 布局
 *   A4 work-mount.js 的 #wk-body 委托里不得再有会话行分支（只留文件树目录/文件 + 拖拽）
 *   A5 work-files.js renderWorkBody 只在 **innerHTML 重写分支内** 接线（节点未变时接线 = 监听累积）
 *   A6 chat 侧接线点（mgr.js renderList/renderProject）同调 bindSessionRows
 *   A7 扶起的滚动 / 滚轮拍回按**行所在滚动容器**挂（liftBindRoot + opts.root），不再是 #recent-body 单例
 *   A8 重建后重扶出口 reliftAfterRebuild 由两侧共用（chat renderRecent / work renderWorkBody）
 *
 * 只读结构探针：正则 + 位置断言源码与拼接产物 web/app.js；不改任何文件。
 */
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const ROOT = resolve(import.meta.dir, '..')
const read = (p: string) => {
  const abs = resolve(ROOT, p)
  return existsSync(abs) ? readFileSync(abs, 'utf-8') : null
}

let pass = 0
let fail = 0
const ok = (m: string) => { pass++; console.log(`PASS  ${m}`) }
const bad = (m: string) => { fail++; console.log(`FAIL  ${m}`) }
const has = (src: string | null, re: RegExp) => !!src && re.test(src)

const RECENT = read('src/gateway/web-src/sidebar/recent.js')
const MGR = read('src/gateway/web-src/sidebar/mgr.js')
const WFILES = read('src/gateway/web-src/sidebar/work/work-files.js')
const WMOUNT = read('src/gateway/web-src/sidebar/work/work-mount.js')
const APP = read('src/gateway/web/app.js')

for (const [name, src] of Object.entries({ RECENT, MGR, WFILES, WMOUNT, APP })) {
  if (!src) bad(`缺少源件 ${name}`)
}

// ── A1：activateSession 唯一口 + 旧 bindSessClicks 已清除 ────────
if (has(RECENT, /function activateSession\(hash, opts = \{\}\)/) && has(RECENT, /^\s*activateSession,\s*$/m)) {
  ok('A1 recent.js 声明并导出 activateSession(hash, opts)')
} else {
  bad('A1 recent.js 缺 activateSession 声明/导出')
}
if (has(RECENT, /bindSessClicks/) || has(MGR, /bindSessClicks/) || has(APP, /bindSessClicks/)) {
  bad('A1 bindSessClicks 仍存在（应已被 activateSession + bindSessionRows 取代）')
} else {
  ok('A1 bindSessClicks 已完全退场（无第二套点击绑定入口）')
}

// ── A2：bindSessionRows 是唯一接线口（点击 → activateSession）────
if (has(RECENT, /function bindSessionRows\(root, opts = \{\}\)/) &&
    has(RECENT, /addEventListener\(\s*'click',\s*\(\)\s*=>\s*activateSession\(b\.dataset\.hash, opts\)\s*\)/) &&
    has(RECENT, /bindSessLift\(root, liftRoot\)/)) {
  ok('A2 bindSessionRows = 点击(→activateSession) + hover 扶起（同一接线口）')
} else {
  bad('A2 bindSessionRows 未同时接管点击与 hover 扶起')
}

// ── A3：work 页面态按 source 门控（chat 点行不改 work 布局）─────
const srcWorkBranches = (RECENT?.match(/opts\.source === 'work'/g) || []).length
if (srcWorkBranches >= 2 && has(RECENT, /if \(opts\.source === 'work'\) \{\s*\n\s*wkEnsureTab\(hash\)/) &&
    has(RECENT, /if \(opts\.source === 'work'\) \{ applyPanes\(\); saveWork\(\) \}/)) {
  ok(`A3 work 页面态（wkEnsureTab/wkMainTab/applyPanes/saveWork）全在 source='work' 分支内（${srcWorkBranches} 处）`)
} else {
  bad('A3 work 页面态未按 source 门控（chat 侧点行会误改 work 布局）')
}
if (has(RECENT, /reLiftHash = hash/) && has(RECENT, /navigate\('#\/' \+ encodeURIComponent\(hash\)\)/)) {
  ok('A3 activateSession 内含导航 + reLiftHash 重扶线索（两模式同源）')
} else {
  bad('A3 activateSession 缺导航 / reLiftHash 线索')
}

// ── A4：work-mount 委托里不再有会话行分支 ──────────────────────
if (has(WMOUNT, /closest\(\s*'\.sess-item'\s*\)/) || has(WMOUNT, /dataset\.hash/)) {
  bad('A4 work-mount.js #wk-body 委托仍有会话行分支（重复导航逻辑未清）')
} else {
  ok('A4 work-mount.js 无 .sess-item 委托（仅文件树目录/文件 + 拖拽）')
}

// ── A5：work-files renderWorkBody 只在重写分支内接线 ────────────
if (WFILES) {
  const iBranch = WFILES.indexOf('body.innerHTML !== html')
  const iClear = WFILES.indexOf('liftClear(true)', iBranch)
  const iWrite = WFILES.indexOf('body.innerHTML = html', iBranch)
  const iBind = WFILES.indexOf("bindSessionRows(body, { source: 'work'", iBranch)
  const iRelift = WFILES.indexOf('reliftAfterRebuild(body)', iBranch)
  // 全件只有一个接线点（Work 侧行只在此渲染），故「唯一 + 在重写分支内且顺序正确」即充分
  const bindCount = (WFILES.match(/bindSessionRows\(/g) || []).length
  const ordered = iBranch >= 0 && iClear > iBranch && iWrite > iClear && iBind > iWrite && iRelift > iBind
  if (ordered && bindCount === 1) {
    ok('A5 renderWorkBody 重写分支内：liftClear → innerHTML → bindSessionRows(source:work) → reliftAfterRebuild')
  } else {
    bad('A5 renderWorkBody 接线顺序/位置不对（须在 innerHTML 重写分支内，防监听累积）')
  }
}

// ── A6：chat 侧接线点同调 bindSessionRows ──────────────────────
const mgrBinds = (MGR?.match(/bindSessionRows\(box\)/g) || []).length
if (mgrBinds >= 3) ok(`A6 mgr.js 三处列表渲染同调 bindSessionRows（${mgrBinds} 处）`)
else bad(`A6 mgr.js 调 bindSessionRows 的点不足（${mgrBinds} < 3）`)

// ── A7：扶起的滚动/滚轮拍回按容器挂（非 #recent-body 单例）───────
if (has(RECENT, /function liftBindRoot\(root\)/) && has(RECENT, /liftBindRoot\(opts\.root \|\| bodyEl\)/) &&
    has(RECENT, /root\.addEventListener\(\s*'wheel'/) && has(RECENT, /liftBoundRoots\.has\(root\)/)) {
  ok('A7 滚动/滚轮拍回按行所在容器挂（liftBindRoot + opts.root，每容器一次）')
} else {
  bad('A7 扶起拍回仍挂在单一容器（work 列表滚轮死区未治）')
}
if (has(RECENT, /let liftBound\b/) || has(RECENT, /if \(!liftBound\)/)) {
  bad('A7 仍有 liftBound 单例门（应换成 liftBoundRoots 集合）')
} else {
  ok('A7 liftBound 单例门已撤除')
}
if (has(RECENT, /bindSessLift\(root, liftRoot\)/) && has(RECENT, /liftStart\(el, \{ root: lr \}\)/)) {
  ok('A7 liftStart 收 opts.root（扶起时即可判定拍回容器）')
} else {
  bad('A7 liftStart 未接收 root（拍回容器无法判定）')
}

// ── A8：重建后重扶出口两侧共用 ─────────────────────────────────
if (has(RECENT, /function reliftAfterRebuild\(root, prevLift\)/) &&
    has(RECENT, /reliftAfterRebuild\(bodyEl, prevLift\)/) &&
    has(WFILES, /reliftAfterRebuild\(body\)/) && has(RECENT, /^\s*reliftAfterRebuild,\s*$/m)) {
  ok('A8 reliftAfterRebuild 抽出并被 chat(renderRecent) / work(renderWorkBody) 共用')
} else {
  bad('A8 重建后重扶未共用（两套逻辑并存）')
}

// ── 产物核对：拼接 app.js 含同一套协议 ─────────────────────────
if (has(APP, /function activateSession\(hash, opts = \{\}\)/) && has(APP, /function bindSessionRows\(root, opts = \{\}\)/) &&
    has(APP, /function liftBindRoot\(root\)/) && has(APP, /reliftAfterRebuild\(body\)/)) {
  ok('产物 web/app.js 含会话行协议（activateSession / bindSessionRows / liftBindRoot / relift）')
} else {
  bad('产物 web/app.js 缺会话行协议（未重跑 bundle-web-modules？）')
}

console.log(`\n${pass}/${fail}`)
process.exit(fail === 0 ? 0 : 1)
