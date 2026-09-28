// probe-work-scope.ts —— work 模式「在项目中工作」不变量探针（只读，2026-09-26）
// 不变量两条（同一句用户需求的两半，各自有唯一判定点）：
//   ① 落项目：work 模式下的新会话/新上传的目标项目 = 工作项目（state.workProj），
//      唯一真源 = core/state.js newSessionProject()——任何消费点直读 state.newProject 都会漏。
//   ② 助手栏范围：work 模式下助手栏只展示工作项目的会话（别的项目的会话路径→退回该项目新对话空态），
//      唯一判定点 = sidebar/work.js workScopeOk()，路由渲染/切模式/切项目三处入口共用。
//   ③ 助手三态（2026-09-27）：主区「至少一栏」不变量就地改判「编辑区 / 预览至少一栏」（助手可脱流为
//      悬浮卡 / 收敛输入栏），唯一判定点仍是 applyPanes；脱流助手不得被 paneVisible 当成 in-flow 栏。
// 附带断言：空态底栏宽度随包含块（会话卡）收缩——.g-stage 宽度基准不得是 vw（否则 work 两栏下
// stage 溢出被卡裁掉，底栏与「发送消息」占位一并被裁）。
// 用法：bun run ./probe-work-scope.ts   （输出 pass/fail，末行 N/M）

const SRC = `${import.meta.dir}/../src/gateway/web-src`
const WEB = `${import.meta.dir}/../src/gateway/web`

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail = '') {
  if (cond) pass++
  else fail++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : '  ← ' + detail}`)
}

const stateJs = await Bun.file(`${SRC}/core/state.js`).text()
const commandsJs = await Bun.file(`${SRC}/inputbar/commands.js`).text()
const sendJs = await Bun.file(`${SRC}/inputbar/send.js`).text()
const imagesJs = await Bun.file(`${SRC}/inputbar/images.js`).text()
const workJs = await Bun.file(`${SRC}/sidebar/work.js`).text()
const recentJs = await Bun.file(`${SRC}/sidebar/recent.js`).text()
const routeJs = await Bun.file(`${SRC}/chat/route.js`).text()
const styles = await Bun.file(`${WEB}/styles.css`).text()
const appJs = await Bun.file(`${WEB}/app.js`).text()

function body(file: string, header: string): string {
  const i = file.indexOf(header)
  if (i < 0) return ''
  let d = 0
  let started = false
  for (let j = i; j < file.length; j++) {
    const c = file[j]
    if (c === '{') { d++; started = true }
    else if (c === '}') { d--; if (started && d === 0) return file.slice(i, j + 1) }
  }
  return ''
}
const count = (t: string, re: RegExp) => [...t.matchAll(re)].length

// ---------- ① 落项目真源 ----------
const nsp = body(stateJs, 'function newSessionProject()')
ok('A1 newSessionProject 定义于 core/state.js', nsp.length > 0)
ok('A1 规则含 work 分支（sbMode === work → workProj）', /sbMode === 'work' && state\.workProj/.test(nsp), nsp.replace(/\s+/g, ' ').slice(0, 120))
ok('A1 非 work 分支回落 state.newProject', /:\s*state\.newProject\s*$/m.test(nsp) || /:\s*state\.newProject/.test(nsp))
ok('A2 send.js 建会话读 newSessionProject()', body(sendJs, 'async function gwSend()').includes('newSessionProject()'))
ok('A2 send.js 无直读 state.newProject 作落项目', !/const tgt = state\.newProject/.test(sendJs))
ok('A2 images.js 上传读 newSessionProject()', imagesJs.includes('const tgt = newSessionProject()'))
ok('A2 images.js 无直读 state.newProject 作落项目', !/state\.newProject \?/.test(imagesJs))
ok('A2 work.js 不写 state.newProject（目标项目槽无第二写者）', !/state\.newProject\s*=/.test(workJs))

// ---------- ② 助手栏范围真源 ----------
const wsOk = body(workJs, 'function workScopeOk(')
ok('B1 workScopeOk 定义于 sidebar/work.js', wsOk.length > 0)
ok('B1 非 work 模式/未选项目/空 hash 一律放行', /sbMode !== 'work' \|\| !state\.workProj \|\| !hash/.test(wsOk))
ok('B1 查无会话时放行（未知 ≠ 别的项目）', /return !s \|\|/.test(wsOk))
ok('B1 命中判据 = 会话项目 == 工作项目', /s\.projectScope === 'project' && s\.projectLabel === state\.workProj/.test(wsOk))
const enf = body(workJs, 'function enforceWorkScope()')
ok('B1 enforceWorkScope 收口到 workScopeOk', enf.includes('workScopeOk(state.currentHash)'))
ok('B2 切模式入口接线（applySbMode 调 enforceWorkScope）', body(workJs, 'function applySbMode()').includes('enforceWorkScope()'))
ok('B2 切项目入口接线（selectProject 调 enforceWorkScope）', body(workJs, 'async function selectProject(').includes('enforceWorkScope()'))
const rs = body(routeJs, 'function renderSession(hash)')
ok('B2 路由渲染入口接线（renderSession 首句守卫）', rs.slice(0, 400).includes('workScopeOk(hash)'))
ok('B2 守卫在会话渲染前（早于 stopLiveFoldTimer）', rs.indexOf('workScopeOk(hash)') >= 0 && rs.indexOf('workScopeOk(hash)') < rs.indexOf('stopLiveFoldTimer'))

// ---------- ③ seat 只读 ----------
const seatLock = body(commandsJs, 'function projSeatLocked()')
ok('C1 projSeatLocked 定义', seatLock.length > 0)
ok('C1 会话态锁定', seatLock.includes("!!state.currentHash"))
ok('C1 work 模式 + 已选项目锁定', /sbMode === 'work' && !!state\.workProj/.test(seatLock))
ok('C1 点击守卫走 projSeatLocked', /addEventListener\('click'[\s\S]{0,160}projSeatLocked\(\)/.test(body(commandsJs, "projSeatEl.addEventListener('click'")))
ok('C2 seat 显示读 newSessionProject()', commandsJs.includes('newSessionProject()'))

// ---------- ④ 空态底栏宽度基准 = 包含块 ----------
// 取「带 width 的 .g-stage 规则块」（.g-stage 另有多条只设 pointer-events 的短规则，按名取块会取错）
const stageRule = /\n\.g-stage \{([\s\S]*?)\n\}/.exec(styles)?.[1] ?? ''
ok('D1 .g-stage 宽度基准 = 包含块（宽度行含 88% 且不含 vw）', /width:\s*min\(88%/.test(stageRule) && !/width:\s*min\([^)]*vw/.test(stageRule), stageRule.replace(/\s+/g, ' ').slice(0, 160))
// 只取「设了 width 的那条 #empty-hint .g-stage 规则」（同名前缀另有两条只设 pointer-events 的单行规则）
const mobileStage = styles.split('\n').find((l) => l.includes('#empty-hint .g-stage') && l.includes('width:')) ?? ''
ok('D1 手机档空态 stage 同样用 %（无 88vw）', /width:\s*min\(88%/.test(mobileStage) && !/88vw/.test(mobileStage), mobileStage.replace(/\s+/g, ' ').slice(0, 160))

// ---------- ⑤ 产物落地 ----------
ok('E1 产物 app.js 含 newSessionProject 定义', appJs.includes('function newSessionProject()'))
ok('E1 产物内 newSessionProject 定义唯一', count(appJs, /function newSessionProject\(/g) === 1)
ok('E1 产物内 projSeatLocked 定义唯一', count(appJs, /function projSeatLocked\(/g) === 1)
ok('E1 产物内 workScopeOk 定义唯一', count(appJs, /function workScopeOk\(/g) === 1)
ok('E2 产物含 work 范围守卫调用点（含 renderSession 一处）', count(appJs, /workScopeOk\(/g) >= 3)

// ---------- ⑥ 助手三态（2026-09-27：靠栏 / 悬浮卡 / 收敛输入栏）----------
// 不变量就地更新：主区「至少一栏」改判 **编辑区 / 预览至少一栏**（助手脱流时不占列，不能再用它兜底），
// 唯一判定点仍是 applyPanes；脱流助手不得被当成 in-flow 栏（否则预览列与浮卡间会冒出幽灵分界条）。
const inFlow = body(workJs, 'function wkAssistInFlow()')
ok('F1 in-flow 判据唯一（助手开着 && 形态 = side）', /state\.wkAssist && wkAssistMode\(\) === 'side'/.test(inFlow), inFlow.replace(/\s+/g, ' ').slice(0, 120))
const ap = body(workJs, 'function applyPanes()')
ok('F1 不变量 = 编辑区 / 预览至少一栏（判据用 wkAssistInFlow）', /!state\.wkEditor && !state\.wkPreview && !wkAssistInFlow\(\)/.test(ap))
ok('F1 旧判据（!wkEditor && !wkAssist && !wkPreview）已清除', !/!state\.wkEditor && !state\.wkAssist && !state\.wkPreview/.test(workJs))
const pv = body(workJs, 'function paneVisible(')
ok('F2 脱流助手不算 in-flow 栏（无幽灵分界条）', pv.includes('el === sessionCard') && pv.includes('wkAssistInFlow()'))
const aam = body(workJs, 'function applyAssistMode()')
ok('F3 三态唯一写口 applyAssistMode（类 + 内联几何）', aam.includes('wk-assist-float') && aam.includes('wk-assist-slim'))

ok('F3 applyWorkFlex 末尾重锚（栏宽变化后调 applyAssistMode）', body(workJs, 'function applyWorkFlex()').includes('applyAssistMode()'))
// 横向只有一个写口：两态共用 wkPlaceAssistBox 写「左缘 + 宽」；CSS 里不得再出现自居中（双写口 = 双重位移）
const pab = body(workJs, 'function wkPlaceAssistBox(')
ok('F3b 两态横向几何同源（wkPlaceAssistBox 写左缘 + 宽）', pab.includes("sessionCard.style.left") && pab.includes("sessionCard.style.width") && body(workJs, 'function wkPlaceAssistFloat()').includes('wkPlaceAssistBox(') && body(workJs, 'function wkPlaceAssistSlim()').includes('wkPlaceAssistBox('))
const slimRule = /\n#session-card\.wk-assist-slim \{([\s\S]*?)\n\}/.exec(styles)?.[1] ?? ''
ok('F3b CSS 收敛态不自居中（无 left/translateX，横向唯一写口在 JS）', slimRule !== '' && !/left\s*:/.test(slimRule) && !/translateX/.test(slimRule) && !/bottom\s*:/.test(slimRule))
// 纵向：收敛输入栏要与正常底栏（#input-wrap.docked）落在同一处 ⇒ 底距 = 浮卡底距 + 卡内 22px 内缩。
// 两个数值必须同源（JS 常量 WK_INPUT_BOT ↔ CSS #input-wrap.docked 的 calc(100% - 22px)），改一边即破。
const wib = Number(/const WK_INPUT_BOT = (\d+)/.exec(workJs)?.[1])
const dockInset = Number(/top:\s*calc\(100% - (\d+)px\)/.exec(styles)?.[1])
ok('F3c 收敛态底距 = WK_ASSIST_BOT + WK_INPUT_BOT', body(workJs, 'function wkPlaceAssistSlim()').includes('style.bottom = WK_ASSIST_BOT + WK_INPUT_BOT'))
ok('F3c WK_INPUT_BOT 与 #input-wrap.docked 的 22px 内缩同源', wib === 22 && dockInset === wib, `WK_INPUT_BOT=${wib} docked-inset=${dockInset}`)
ok('F3b 清空内联几何含 bottom（切回靠栏不留残位）', body(workJs, 'function wkClearAssistBox()').includes("'bottom'"))
// 收敛 pill 末端的箭头 = 正常底栏发送钮同款（材质 + 单源图标），不得自绘
const wapRule = /\n\.wap-arrow \{([\s\S]*?)\n\}/.exec(styles)?.[1] ?? ''
ok('F3d .wap-arrow 材质 = 发送钮（34px / #4176e6 / #fff / 999px）', /width:\s*34px/.test(wapRule) && /height:\s*34px/.test(wapRule) && /#4176e6/.test(wapRule) && /color:\s*#fff/.test(wapRule) && /border-radius:\s*999px/.test(wapRule))
const grip = body(workJs, 'function bindAssistGrip()')
ok('F4 把手用 pointer events + setPointerCapture（触屏可用）', grip.includes("'pointerdown'") && grip.includes('setPointerCapture'))
ok('F4 收尾看 ev.buttons（不是只等 pointerup，防状态卡死）', /!ev\.buttons/.test(grip))
ok('F4 位移阈值 >3px 才算拖（WK_DRAG_SLOP）', grip.includes('WK_DRAG_SLOP'))
ok('F4 拖拽期挂 body.wk-assist-dragging（关内嵌 pointer-events）', grip.includes('wk-assist-dragging'))
const mw = body(workJs, 'function mountWork()')
ok('F5 头部四图标 + 收敛 pill 全接线', ['wk-assist-slim', 'wk-assist-float', 'wk-assist-dock', 'wk-assist-close', 'wk-assist-pill'].every((id) => mw.includes(id)))
ok('F5 ResizeObserver 重锚（分界条拖拽/侧栏开合/窗口缩放）', mw.includes('ResizeObserver') && mw.includes('wkReflowAssist'))
const idx = await Bun.file(`${WEB}/index.html`).text()
ok('F6 index.html 含三态标记（头部 + 把手 + pill）', ['wk-assist-head', 'wk-assist-grip', 'wk-assist-pill'].every((c) => idx.includes(c)))
const pillHtml = /<button class="wk-assist-pill"[\s\S]*?<\/button>/.exec(idx)?.[0] ?? ''
ok('F3d pill 箭头图标单源（HTML 无内联 svg，mountWork 注 I.dshSend）', pillHtml !== '' && !/<svg/.test(pillHtml) && mw.includes('wap-arrow') && mw.includes('I.dshSend'))
ok('F6 styles.css 含三态几何 + 触屏拖拽守卫', ['#session-card.wk-assist-float', '#session-card.wk-assist-slim', '.wk-assist-pill'].every((c) => styles.includes(c)) && /body\.wk-assist-dragging iframe\s*\{[^}]*pointer-events:\s*none/.test(styles))
ok('F7 state.js 形态默认 side + save/load 往返', /wkAssistMode: 'side'/.test(stateJs) && stateJs.includes('wkAssistMode: state.wkAssistMode') && /d\.wkAssistMode === 'side'/.test(stateJs))
ok('F8 产物 app.js 含三态唯一写口（applyAssistMode / wkAssistInFlow 各一）', count(appJs, /function applyAssistMode\(/g) === 1 && count(appJs, /function wkAssistInFlow\(/g) === 1)

// ---------- ⑨ 空态底栏不压卡边界（2026-09-27：悬浮卡按缺口加高，底栏相对立绘位置不动）----------
// 不变量：空态底栏的底边距卡底边 ≥ WK_INPUT_BOT（与 .docked 在卡内的 22px 内缩同源）。判据只能从已落位
// 几何实量（台面在卡内垂直居中 ⇒ 该底距 = 卡高/2 − 常量，与立绘尺寸/底栏高耦合，不可硬编码卡高）。
const wfd = body(workJs, 'function wkFloatEmptyDeficit(')
ok('F9 缺口判据实测卡内空态底栏（非空态无盒 / 无此父恒 0）', wfd.includes("'#empty-hint #input-wrap'") && /if \(!br\.width\) return 0/.test(wfd), wfd.replace(/\s+/g, ' ').slice(0, 140))
ok('F9 缺口阈值 = WK_INPUT_BOT（与 .docked 内缩同源）', /return WK_INPUT_BOT -/.test(wfd))
const paf = body(workJs, 'function wkPlaceAssistFloat(')
ok('F9 悬浮卡按 2×缺口加高（底距随卡高以 1/2 变化）', /Math\.min\(wkAssistH\(\) \+ 2 \* d/.test(paf), paf.replace(/\s+/g, ' ').slice(-140))
ok('F9 补高量不写回 state.wkAssistH（用户拖动值不被改写）', !/state\.wkAssistH\s*=/.test(paf))
ok('F9 产物 app.js 含缺口判据定义唯一', count(appJs, /function wkFloatEmptyDeficit\(/g) === 1)

// ---------- ⑩ 视图浮层「侧边栏」开关 = 侧栏是否常在（2026-09-28）----------
// 不变量：开关亮 ⇔ 侧栏被主动打开（钉住）；左缘悬停预览式唤出（瞬时露出、移出即收）不算打开。
// 判定点 = work.js paneOn('sidebar') 读 state.panelPinned；钉住态由 recent.js setPanel 单点写，
// 落地后同步浮层行状态（pin 可被汉堡/收起钮/遮罩/浮层开关任一处翻转）。
const paneOnBody = body(workJs, 'function paneOn(')
ok('G1 侧边栏开关真源 = state.panelPinned（不含悬停可见态）', paneOnBody.includes('return !!state.panelPinned') && !paneOnBody.includes('state.panelOpen'), paneOnBody.replace(/\s+/g, ' ').slice(-120))
const setPanelBody = body(recentJs, 'function setPanel(')
ok('G1 setPanel 写 panelPinned（pin 真源单点）', /state\.panelPinned = !!open && !!\(opt && opt\.pin\)/.test(setPanelBody))
ok('G1 setPanel 落地后同步浮层行状态', setPanelBody.includes('syncPaneRows()'))
ok('G1 mouseleave 收起判据读 panelPinned（悬停唤出可收）', /if \(!state\.panelPinned\) setPanel\(false\)/.test(recentJs))
ok('G1 state.js 有 panelPinned 初始位', /panelPinned: false/.test(stateJs))
ok('G1 浮层行同步定义唯一 + 两处调用', count(appJs, /function syncPaneRows\(/g) === 1 && count(appJs, /syncPaneRows\(\)/g) >= 2)

console.log(`\n${pass}/${fail}`)
process.exit(fail ? 1 : 0)
