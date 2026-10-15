#!/usr/bin/env bun
/**
 * probe-registry-scope —— 注册域隔离不变量（2026-10-15 两步返修）
 *
 * 背景（回归）：renderMgrTabs 曾无条件 `CARDS.concat(appTabs(), extTabs())`——于是
 *   ① 普通 chat 串出工作区根的应用 tab（项目/模型/神经元…）；
 *   ② 离开预览后 EXT 内存表不清（「离开预览路由不清」是既定生命周期），外部卡 tab 仍挂着。
 * Step1（显示门控）只滤 tab；Step2（本件）补全：**显示与可切入共用同一判据**，隐藏卡不得由路由
 * 或卡 id 切进主区。
 *
 * 语境（关键布局事实）：#mgr-tabs 容器在 #chat-panel 内，work 模式下 applySbMode 把 #chat-panel
 * 整块 hidden ⇒ 本行只在 chat 模式可见；且 route.js 有「work 模式与视图卡互斥」（进 mgr/preview
 * 一律 setSbMode('chat')）。
 *
 * 不变量：
 *   D0 唯一判据 isCardAllowedInContext(id, st) 存在于 registry.js 并导出（tab 取集 / cardOf /
 *      openCard / route mgr 分支 / mgr-tabs 点击委托 五处共用；禁止各自另写一套过滤）。
 *   D1 三张表的域：CARDS（第一方）恒在域内；app:<id> 仅语境 = 工作区根；ext:<label>:<id> 仅语境 =
 *      该 label 且 EXT 运行表正属该 label。
 *   D2 语境唯一状态源：work 看 state.workProj、chat 看 state.preview；已开着的 app/ext 卡自身即其
 *      语境（st.mgr 命名空间占先——renderMgr 清 preview 后 openCard 仍须认得自己）。
 *   D3 route 的 mgr 分支按**入站语境快照 ctx0** 判（state.mgr/preview 在 route 内已被清空/改写；
 *      不取入站快照 = 卡靠自己的 id 自授权，隐藏卡再度可开），域外 → navigate('#/') 退回首页。
 *   D4 cardOf 域内才解析（隐藏卡查无此卡 ⇒ refreshCard/deactivateCard/openCard 同受门）；唯一例外
 *      = 当前槽内那张卡（切异卡须能解析离场卡调 deactivate）。
 *   D5 openCard 域外返回 null，且**不动槽内现卡**。
 *   D6 mgr-tabs 点击委托（web-src/app.js）导航前过同一判据。
 *   D7 硬性：卡片注册 / 应用目录同步不得直接调全局 renderMgrTabs()——ext-runtime 只经 setTabRefresh
 *      注入的回调触发。
 *   D8 语境变更点（模式切换 / 导航）显式调 renderMgrTabs 重取，缺一处即串域。
 *   D9 work 侧栏（work-files / work-mount）不再参与 #mgr-tabs 重渲（setMgrScopeProvider 已撤除）。
 *
 * 只读结构探针：正则断言源码与拼接产物 web/app.js；不改任何文件。
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

const REG = read('src/gateway/web-src/engine/registry.js')
const RT = read('src/gateway/web-src/engine/ext-runtime.js')
const WORK = read('src/gateway/web-src/sidebar/work.js')
const ROUTE = read('src/gateway/web-src/chat/route.js')
const WFILES = read('src/gateway/web-src/sidebar/work/work-files.js')
const WMOUNT = read('src/gateway/web-src/sidebar/work/work-mount.js')
const WLAYOUT = read('src/gateway/web-src/sidebar/work/work-layout.js')
const APPJS = read('src/gateway/web-src/app.js')
const APP = read('src/gateway/web/app.js')

for (const [name, src] of Object.entries({ REG, RT, WORK, ROUTE, WFILES, WMOUNT, WLAYOUT, APPJS, APP })) {
  if (!src) bad(`缺少源件 ${name}`)
}

// ── D0：唯一判据存在并导出 ─────────────────────────────────────
if (has(REG, /function isCardAllowedInContext\(id, st\)/) && has(REG, /^\s*isCardAllowedInContext,\s*$/m)) {
  ok('D0 registry.js 声明并导出 isCardAllowedInContext(id, st)')
} else {
  bad('D0 registry.js 缺 isCardAllowedInContext 声明/导出')
}

// ── D1a：apps 段门控 = 工作区根语境（app: 卡自认领 / 预览全局根）──
if (has(REG, /if \(id\.startsWith\('app:'\)\) return m\.startsWith\('app:'\) \|\| isGlobalLabel\(raw\)/) &&
    has(REG, /isGlobalLabel/) ) {
  ok('D1 apps 域 = m.startsWith(app:) || isGlobalLabel(raw)（工作区根语境）')
} else {
  bad('D1 缺 apps 段域判据（工作区根语境）')
}
if (has(REG, /import\s*\{[^}]*\bisGlobalLabel\b[^}]*\}\s*from\s*'\.\/ext-runtime\.js'/) &&
    has(RT, /const isGlobalLabel = \(l\) => l === GLOBAL_LABEL/) &&
    has(RT, /^\s*isGlobalLabel,\s*$/m)) {
  ok('D1 registry 自 ext-runtime 取 isGlobalLabel（GLOBAL_LABEL 不外泄裸串）')
} else {
  bad('D1 缺 isGlobalLabel（registry 无法判「语境 = 工作区根」/ ext-runtime 未导出）')
}

// ── D1b：ext 段域 = 该 label（且 EXT 运行表正属该 label）────────
if (has(REG, /const label = id\.slice\(4, id\.lastIndexOf\(':'\)\)/) &&
    has(REG, /if \(!label \|\| extLabel\(\) !== label\) return false/) &&
    has(REG, /return m\.startsWith\('ext:' \+ label \+ ':'\) \|\| raw === label/)) {
  ok("D1 ext 域 = extLabel()===label && (m 前缀认领 || raw===label)")
} else {
  bad('D1 缺 ext 段域判据（EXT 所属项目）')
}
if (has(REG, /import\s*\{[^}]*\bextLabel\b[^}]*\}\s*from\s*'\.\/ext-runtime\.js'/)) {
  ok('D1 registry 自 ext-runtime 取 extLabel（EXT 所属项目 label）')
} else {
  bad('D1 registry 未 import extLabel（无法判语境）')
}

// ── D2：语境唯一状态源（work 看工作项目 / chat 看预览）──────────
if (has(REG, /const m = typeof st\.mgr === 'string' \? st\.mgr : ''/) &&
    has(REG, /const raw = \(st\.sbMode === 'work' \? st\.workProj : st\.preview\) \|\| ''/) &&
    has(REG, /if \(CARDS\.some\(\(c\) => c\.id === id\)\) return true/)) {
  ok('D2 语境 = st.mgr 命名空间占先 → work/chat label；CARDS 恒在域内')
} else {
  bad('D2 缺语境归一 / 第一方恒在域内')
}

// ── D1c：tab 取集用同一判据（不得无条件合流）────────────────────
if (has(REG, /CARDS\.concat\(appTabs\(\), extTabs\(\)\)\s*\n\s*\.filter\(\(v\) => v\.tab && isCardAllowedInContext\(v\.id, state\)\)/)) {
  ok('D1 renderMgrTabs 取集 = 三表合流后过 isCardAllowedInContext（显示与可切入同判据）')
} else {
  bad('D1 renderMgrTabs 未按 isCardAllowedInContext 取集（仍可能无条件合流）')
}
if (has(REG, /CARDS\.concat\(\s*appTabs\(\),\s*extTabs\(\)\s*\)\s*\.filter\(\(v\) => v\.tab\)/)) {
  bad('D1 renderMgrTabs 仍是「只滤 tab」旧写法')
}

// ── D3：route mgr 分支按入站快照判 ─────────────────────────────
if (has(ROUTE, /const ctx0 = \{ mgr: state\.mgr, preview: state\.preview, sbMode: state\.sbMode, workProj: state\.workProj \}/) &&
    has(ROUTE, /hydrateExtCardId\(r\.mgr\)\s*\n\s*if \(!isCardAllowedInContext\(r\.mgr, ctx0\)\) \{ navigate\('#\/'\); return \}/)) {
  ok("D3 route() 入站快照 ctx0 + mgr 分支域外退回首页（不得由 URL 切进隐藏卡）")
} else {
  bad('D3 route() mgr 分支缺入站语境门（隐藏卡仍可由路由打开）')
}
if (has(ROUTE, /import\s*\{[^}]*\bisCardAllowedInContext\b[^}]*\}\s*from\s*'\.\.\/engine\/registry\.js'/)) {
  ok('D3 route.js 自 registry 取 isCardAllowedInContext')
} else {
  bad('D3 route.js 未 import isCardAllowedInContext')
}

// ── D4：cardOf 域内才解析（例外 = 槽内卡）──────────────────────
if (has(REG, /const cardOf = \(id\) => \(isCardAllowedInContext\(id, state\) \|\| currentCardId\(\) === id/) &&
    has(REG, /CARDS\.find\(\(c\) => c\.id === id\) \|\| appTabs\(\)\.find\(\(c\) => c\.id === id\) \|\| extTabs\(\)\.find\(\(c\) => c\.id === id\)\s*\n\s*: undefined\)/)) {
  ok('D4 cardOf 域内才解析 + 槽内卡例外（离场卡仍可解析以调 deactivate）')
} else {
  bad('D4 cardOf 未按域解析（隐藏卡仍可由卡 id 命中）')
}

// ── D5：openCard 域外返回 null ─────────────────────────────────
if (has(REG, /function openCard\(id, payload\) \{\s*\n\s*if \(!isCardAllowedInContext\(id, state\)\) return null/) &&
    has(REG, /const c = cardOf\(id\)\s*\n\s*if \(!c\) return null/)) {
  ok('D5 openCard 域外返回 null（先于取离场卡 → 拒绝不顺带拆当前视图）')
} else {
  bad('D5 openCard 缺域判据')
}

// ── D6：mgr-tabs 点击委托过同一判据 ────────────────────────────
if (has(APPJS, /const k = b\.dataset\.mgr\s*\n\s*\/\/[^\n]*\n(\s*\/\/[^\n]*\n)*\s*if \(!isCardAllowedInContext\(k, state\)\) return/) &&
    has(APPJS, /import\s*\{[^}]*\bisCardAllowedInContext\b[^}]*\}\s*from\s*'\.\/engine\/registry\.js'/)) {
  ok('D6 app.js mgr-tabs 委托导航前过 isCardAllowedInContext（残留按钮点了也不切）')
} else {
  bad('D6 app.js mgr-tabs 委托缺域判据 / 未 import')
}

// ── D9：撤除 setMgrScopeProvider（work 侧栏不参与 #mgr-tabs 入表）─
if (has(REG, /setMgrScopeProvider/) || has(WORK, /setMgrScopeProvider/)) {
  bad('D9 仍存在 setMgrScopeProvider（workRoot 注入应已撤除——#mgr-tabs 是 chat 侧栏行）')
} else {
  ok('D9 registry/work.js 均无 setMgrScopeProvider（入表判据不依赖 work 侧栏 wkTab）')
}
if (!has(WFILES, /renderMgrTabs/) && !has(WMOUNT, /renderMgrTabs/)) {
  ok('D9 work-files/work-mount 不再调 renderMgrTabs（wkTab 变更与入表无关）')
} else {
  bad('D9 work-files/work-mount 仍调 renderMgrTabs')
}

// ── D7：硬性——ext-runtime 不得直接调 renderMgrTabs ──────────────
if (has(RT, /\brenderMgrTabs\s*\(/)) {
  bad('D7 ext-runtime 直接调用了 renderMgrTabs（须经 setTabRefresh 注入回调）')
} else {
  ok('D7 ext-runtime 不直接调 renderMgrTabs（卡片注册/应用目录同步只经 tabRefresh）')
}
if (has(RT, /setTabRefresh\(\s*renderMgrTabs\s*\)/) === false && has(REG, /setTabRefresh\(\s*renderMgrTabs\s*\)/)) {
  ok('D7 唯一注入点 = registry 模块体 setTabRefresh(renderMgrTabs)')
} else {
  bad('D7 未找到 registry 的 setTabRefresh(renderMgrTabs) 注入点')
}

// ── D8：语境变更点显式重取 ─────────────────────────────────────
if (has(ROUTE, /renderMgrTabs\(\)\s*\n\s*syncMgrTabs\(\)/)) {
  ok('D8 route() 末尾 renderMgrTabs()+syncMgrTabs()（导航后按语境重取 + 重落高亮）')
} else {
  bad('D8 route() 末尾缺 renderMgrTabs()/syncMgrTabs()')
}
if (has(WLAYOUT, /renderMgrTabs\(\)/)) {
  ok('D8 applySbMode() 模式切换按语境重取（EXT 语境含 work 侧）')
} else {
  bad('D8 applySbMode() 缺 renderMgrTabs() 重取')
}

// ── 产物核对：拼接 app.js 内含同一套注册域逻辑 ─────────────────
const bundleOk =
  has(APP, /function isCardAllowedInContext\(id, st\)/) &&
  has(APP, /\.filter\(\(v\) => v\.tab && isCardAllowedInContext\(v\.id, state\)\)/) &&
  has(APP, /isCardAllowedInContext\(r\.mgr, ctx0\)/) &&
  has(APP, /isCardAllowedInContext\(k, state\)/)
if (bundleOk) ok('产物 web/app.js 含注册域逻辑（判据 + tab 取集 + route 门 + 点击门）')
else bad('产物 web/app.js 缺注册域逻辑（未重跑 bundle-web-modules？）')

console.log(`\n${pass}/${fail}`)
process.exit(fail === 0 ? 0 : 1)
