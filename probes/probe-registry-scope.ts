#!/usr/bin/env bun
/**
 * probe-registry-scope —— #mgr-tabs 注册域隔离不变量（2026-10-15 返修）
 *
 * 背景（回归）：renderMgrTabs 曾无条件 `CARDS.concat(appTabs(), extTabs())`——于是
 *   ① 普通 chat 串出工作区根的应用 tab（项目/模型/神经元…）；
 *   ② 离开预览后 EXT 内存表不清（「离开预览路由不清」是既定生命周期），外部卡 tab 仍挂着。
 *
 * 语境（关键布局事实）：#mgr-tabs 容器在 #chat-panel 内，work 模式下 applySbMode 把 #chat-panel
 * 整块 hidden ⇒ 本行只在 chat 模式可见；且 route.js 有「work 模式与视图卡互斥」（进 mgr/preview
 * 一律 setSbMode('chat')）。故两张运行期表的入表门控都按 **chat 语境** 判：
 *
 *   I1 appTabs()（工作区根应用）**仅**当语境 = 工作区根时进表；
 *      「语境 = 工作区根」= `isGlobalLabel(state.preview)`（正在预览全局根）
 *      或 `state.mgr` 以 `app:` 开头（正开着某张应用卡——点击后 state.preview 已清，须靠 mgr id 认领）。
 *      普通 chat / 其它项目预览下都不显示（D1）。
 *   I2 extTabs()（当前预览项目外部卡）**仅**当「语境 = EXT 所属项目」时进表：
 *      ctx = work 看 state.workProj、chat 看 state.preview，或正开该 label 的某张 ext 卡（state.mgr 前缀匹配）。
 *   I3 硬性：卡片注册 / 应用目录同步**不得直接调用全局 renderMgrTabs()**——ext-runtime 只经
 *      setTabRefresh 注入的回调（tabRefresh()）触发，重渲一律经按语境取集的 renderMgrTabs()。
 *   I4 语境变更点（模式切换 / 导航）显式调 renderMgrTabs 重取，缺一处即串域。
 *   I5 work 侧栏（work-files / work-mount）不再参与 #mgr-tabs 重渲——那里是 chat 侧栏的行，wkTab
 *      与入表无关（曾以 setMgrScopeProvider 注入 workRoot 判据，2026-10-15 定案撤除：状态源变少）。
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
const APP = read('src/gateway/web/app.js')

for (const [name, src] of Object.entries({ REG, RT, WORK, ROUTE, WFILES, WMOUNT, WLAYOUT, APP })) {
  if (!src) bad(`缺少源件 ${name}`)
}

// ── I1a：旧的无条件合流写法必须已清除 ────────────────────────────
if (has(REG, /CARDS\.concat\(\s*appTabs\(\),\s*extTabs\(\)\s*\)/)) {
  bad('I1 registry 仍无条件 concat(appTabs(), extTabs())（旧写法未清）')
} else {
  ok('I1 registry 无「CARDS.concat(appTabs(), extTabs())」无条件合流')
}

// ── I1b：apps 段受「语境 = 工作区根」门控 ────────────────────────
if (has(REG, /isGlobalLabel\(state\.preview\)\s*\|\|\s*onAppCard\s*\?\s*appTabs\(\)\s*:\s*\[\]/) &&
    has(REG, /state\.mgr\.startsWith\(\s*'app:'\s*\)/)) {
  ok('I1 apps 段门控 = isGlobalLabel(state.preview) || onAppCard（app: 卡）')
} else {
  bad('I1 apps 段缺「语境 = 工作区根（预览全局根 / 正开 app: 卡）」门控')
}
if (has(REG, /import\s*\{[^}]*\bisGlobalLabel\b[^}]*\}\s*from\s*'\.\/ext-runtime\.js'/) &&
    has(RT, /const isGlobalLabel = \(l\) => l === GLOBAL_LABEL/) &&
    has(RT, /^\s*isGlobalLabel,\s*$/m)) {
  ok('I1 registry 自 ext-runtime 取 isGlobalLabel（GLOBAL_LABEL 不外泄裸串）')
} else {
  bad('I1 缺 isGlobalLabel（registry 无法判「语境 = 工作区根」/ ext-runtime 未导出）')
}

// ── I2：ext 段受「语境 = EXT 所属项目」门控 ─────────────────────
if (has(REG, /startsWith\(\s*'ext:'\s*\+\s*el\s*\+\s*':'/) && has(REG, /ctx\s*===\s*el/)) {
  ok("I2 ext 段门控 = 语境匹配（el && (onExtCard || ctx === el)）")
} else {
  bad('I2 ext 段缺「语境 = EXT 所属项目」门控')
}
if (has(REG, /import\s*\{[^}]*\bextLabel\b[^}]*\}\s*from\s*'\.\/ext-runtime\.js'/)) {
  ok('I2 registry 自 ext-runtime 取 extLabel（EXT 所属项目 label）')
} else {
  bad('I2 registry 未 import extLabel（无法判语境）')
}

// ── I5：撤除 setMgrScopeProvider（work 侧栏不参与 #mgr-tabs 入表）─
if (has(REG, /setMgrScopeProvider/) || has(WORK, /setMgrScopeProvider/)) {
  bad('I5 仍存在 setMgrScopeProvider（workRoot 注入应已撤除——#mgr-tabs 是 chat 侧栏行）')
} else {
  ok('I5 registry/work.js 均无 setMgrScopeProvider（入表判据不依赖 work 侧栏 wkTab）')
}
if (!has(WFILES, /renderMgrTabs/) && !has(WMOUNT, /renderMgrTabs/)) {
  ok('I5 work-files/work-mount 不再调 renderMgrTabs（wkTab 变更与入表无关）')
} else {
  bad('I5 work-files/work-mount 仍调 renderMgrTabs')
}

// ── I3：硬性——ext-runtime 不得直接调 renderMgrTabs ──────────────
if (has(RT, /\brenderMgrTabs\s*\(/)) {
  bad('I3 ext-runtime 直接调用了 renderMgrTabs（须经 setTabRefresh 注入回调）')
} else {
  ok('I3 ext-runtime 不直接调 renderMgrTabs（卡片注册/应用目录同步只经 tabRefresh）')
}
if (has(RT, /setTabRefresh\(\s*renderMgrTabs\s*\)/) === false && has(REG, /setTabRefresh\(\s*renderMgrTabs\s*\)/)) {
  ok('I3 唯一注入点 = registry 模块体 setTabRefresh(renderMgrTabs)')
} else {
  bad('I3 未找到 registry 的 setTabRefresh(renderMgrTabs) 注入点')
}

// ── I4：语境变更点显式重取 ─────────────────────────────────────
if (has(ROUTE, /renderMgrTabs\(\)\s*\n\s*syncMgrTabs\(\)/)) {
  ok('I4 route() 末尾 renderMgrTabs()+syncMgrTabs()（导航后按语境重取 + 重落高亮）')
} else {
  bad('I4 route() 末尾缺 renderMgrTabs()/syncMgrTabs()')
}
if (has(WLAYOUT, /renderMgrTabs\(\)/)) {
  ok('I4 applySbMode() 模式切换按语境重取（EXT 语境含 work 侧）')
} else {
  bad('I4 applySbMode() 缺 renderMgrTabs() 重取')
}

// ── 产物核对：拼接 app.js 内含同一套注册域逻辑 ─────────────────
const bundleOk =
  has(APP, /isGlobalLabel/) &&
  has(APP, /state\.mgr\.startsWith\(\s*'app:'\s*\)/) &&
  has(APP, /startsWith\(\s*'ext:'\s*\+\s*el\s*\+\s*':'/)
if (bundleOk) ok('产物 web/app.js 含注册域逻辑（isGlobalLabel + app: 认领 + ext 语境门控）')
else bad('产物 web/app.js 缺注册域逻辑（未重跑 bundle-web-modules？）')

console.log(`\n${pass}/${fail}`)
process.exit(fail === 0 ? 0 : 1)
