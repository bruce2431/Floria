// probe-work-scope.ts —— work 模式「在项目中工作」不变量探针（只读，2026-09-26）
// 不变量两条（同一句用户需求的两半，各自有唯一判定点）：
//   ① 落项目：work 模式下的新会话/新上传的目标项目 = 工作项目（state.workProj），
//      唯一真源 = engine/state.js newSessionProject()——任何消费点直读 state.newProject 都会漏。
//   ② 助手栏范围：work 模式下助手栏只展示工作项目的会话（别的项目的会话路径→退回该项目新对话空态），
//      唯一判定点 = sidebar/work.js workScopeOk()，路由渲染/切模式/切项目三处入口共用。
//   ③ 下沉区 tab + 助手三态（2026-10-06）：不变量 = **聊天 tab / 文件 tab / 预览至少一个在场**
//      （助手可脱流为悬浮卡 / 收敛输入栏），唯一判定点仍 applyPanes；下沉格当前显示谁 = wkShownTab()。
//      预览列固定最右（列宽 state.wkPrevW），助手脱流不得被当成在场内容。
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

const stateJs = await Bun.file(`${SRC}/engine/state.js`).text()
const commandsJs = await Bun.file(`${SRC}/inputbar/commands.js`).text()
const sendJs = await Bun.file(`${SRC}/inputbar/send.js`).text()
const imagesJs = await Bun.file(`${SRC}/inputbar/images.js`).text()
const workJs = await Bun.file(`${SRC}/sidebar/work.js`).text()
const recentJs = await Bun.file(`${SRC}/sidebar/recent.js`).text()
const panelJs = await Bun.file(`${SRC}/engine/panel.js`).text()
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
ok('A1 newSessionProject 定义于 engine/state.js', nsp.length > 0)
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

// ---------- ⑥ 下沉区 tab + 助手三态（靠栏 / 悬浮卡 / 收敛输入栏）----------
// 不变量：**聊天 tab / 文件 tab / 预览至少一个在场**（助手脱流时不占下沉格，不能再用它兜底），
// 唯一判定点仍是 applyPanes；下沉格显示谁 = wkShownTab()（靠栏按 wkMainTab，脱流则文件顶上来或空）。
const inFlow = body(workJs, 'function wkAssistInFlow()')
ok('F1 in-flow 判据唯一（助手开着 && 形态 = side）', /state\.wkAssist && wkAssistMode\(\) === 'side'/.test(inFlow), inFlow.replace(/\s+/g, ' ').slice(0, 120))
const ap = body(workJs, 'function applyPanes()')
ok('F1 不变量 = 聊天 tab / 文件 tab / 预览至少一个在场', /!state\.wkAssist && !state\.workFile && !state\.wkPreview/.test(ap))
ok('F1 旧判据（!wkEditor && !wkPreview && !wkAssistInFlow）已清除', !/!state\.wkEditor && !state\.wkPreview && !wkAssistInFlow\(\)/.test(workJs))
const shown = body(workJs, 'function wkShownTab()')
ok('F2 下沉格判据 wkShownTab（靠栏按 wkMainTab / 脱流文件顶上 / 否则空）', shown.includes('wkAssistInFlow()') && shown.includes("state.wkMainTab === 'file'") && /return state\.workFile \? 'file' : ''/.test(shown), shown.replace(/\s+/g, ' ').slice(0, 140))
ok('F2 旧多栏选择器（paneVisible / nearPane / paneKey / PANE_EL）已清除', !/function paneVisible\(|function nearPane\(|function paneKey\(|const PANE_EL/.test(workJs))
const aam = body(workJs, 'function applyAssistMode()')
ok('F3 三态唯一写口 applyAssistMode（类 + 内联几何）', aam.includes('wk-assist-float') && aam.includes('wk-assist-slim'))

ok('F3 applyWorkCols 末尾重锚（预览列宽变化后调 applyAssistMode）', body(workJs, 'function applyWorkCols()').includes('applyAssistMode()'))
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
// 判定点 = work.js paneOn('sidebar') 读 state.panelPinned；钉住态 2026-10-05 收归 engine/panel.js
// applyPanelOpen 单点写（recent.js setPanel 委托之，popup/行状态清理留包装层）。
const paneOnBody = body(workJs, 'function paneOn(')
ok('G1 侧边栏开关真源 = state.panelPinned（不含悬停可见态）', paneOnBody.includes('return !!state.panelPinned') && !paneOnBody.includes('state.panelOpen'), paneOnBody.replace(/\s+/g, ' ').slice(-120))
const applyPanelBody = body(panelJs, 'function applyPanelOpen(')
ok('G1 applyPanelOpen 写 panelPinned（pin 真源单点，engine/panel.js）', /state\.panelPinned = !!open && !!pin/.test(applyPanelBody))
const setPanelBody = body(recentJs, 'function setPanel(')
ok('G1 setPanel 委托 applyPanelOpen（不再自写 pin）', setPanelBody.includes('applyPanelOpen(') && !/state\.panelPinned\s*=/.test(setPanelBody))
ok('G1 setPanel 落地后同步浮层行状态', setPanelBody.includes('syncPaneRows()'))
ok('G1 mouseleave 收起判据读 panelPinned（悬停唤出可收）', /if \(!state\.panelPinned\) setPanel\(false\)/.test(recentJs))
ok('G1 state.js 有 panelPinned 初始位', /panelPinned: false/.test(stateJs))
ok('G1 浮层行同步定义唯一 + 两处调用', count(appJs, /function syncPaneRows\(/g) === 1 && count(appJs, /syncPaneRows\(\)/g) >= 2)

// ---------- ⑪ 视图浮层两开关按项目分槽（2026-10-06 由四开关收为两开关）----------
// 不变量：两开关（预览/侧边栏）是**项目级**状态——切项目换槽（有槽用槽，无槽回落缺省），
// 尚未选项目时不落槽。读写各一个口：stashWorkPanes（saveWork 内调）/ loadWorkPanes（loadWork 与切项目调）。
// 编辑区/助手退场：编辑区在场 ⇔ workFile 非空，助手在场 ⇔ wkAssist（均全局，不按项目分槽）。
ok('H1 state.js 有 wkPanes 槽 + 两开关缺省表', /wkPanes: \{\}/.test(stateJs) && /const WK_PANES_DEF = \{ workspace: true, sidebar: false \}/.test(stateJs))
const stash = body(stateJs, 'function stashWorkPanes()')
ok('H1 归档唯一口：未选项目不落槽', stash.includes('if (!state.workProj) return') && /state\.wkPanes\[state\.workProj\] = \{/.test(stash))
const lwp = body(stateJs, 'function loadWorkPanes(')
ok('H1 读槽唯一口：无槽回落缺省（两键逐一）', lwp.length > 0 && /typeof s\[k\] === 'boolean' \? s\[k\] : WK_PANES_DEF\[k\]/.test(lwp) && ['workspace', 'sidebar'].every((k) => lwp.includes(`val('${k}')`)))
ok('H1 saveWork 归档后与其余 work 状态同一次 patch', body(stateJs, 'function saveWork()').includes('stashWorkPanes()') && /wkPanes: state\.wkPanes/.test(body(stateJs, 'function saveWork()')))
ok('H1 loadWork 读槽表 + 按恢复项目落两开关', /state\.wkPanes\[k\] = v/.test(body(stateJs, 'function loadWork()')) && body(stateJs, 'function loadWork()').includes('loadWorkPanes(state.workProj)'))
ok('H1 旧全局扁平字段 wkEditor 已清除', !/wkEditor/.test(stateJs))
ok('H1 新全局字段（wkAssist/wkMainTab/wkPrevW）顶层持久化往返', /wkAssist: !!state\.wkAssist/.test(stateJs) && stateJs.includes('wkMainTab: state.wkMainTab') && stateJs.includes('wkPrevW: state.wkPrevW') && /typeof d\.wkAssist === 'boolean'/.test(stateJs) && /d\.wkMainTab === 'chat'/.test(stateJs) && /typeof d\.wkPrevW === 'number'/.test(stateJs))
const sp = body(workJs, 'async function selectProject(')
ok('H2 切项目：先归档旧项目（早于 workProj 赋值）', sp.includes('stashWorkPanes()') && sp.indexOf('stashWorkPanes()') < sp.indexOf('state.workProj = label'))
ok('H2 切项目：换槽后落地两开关（loadWorkPanes → applyPanes）', sp.indexOf('loadWorkPanes(label)') > sp.indexOf('state.workProj = label') && sp.indexOf('applyPanes()') > sp.indexOf('loadWorkPanes(label)'))
ok('H2 侧栏开合按新项目槽恢复（applySidebarPin 在切项目链内）', sp.includes('applySidebarPin()'))
const asp = body(workJs, 'function applySidebarPin()')
ok('H3 侧栏恢复走 setPanel（侧栏开合唯一口），移动端不恢复', asp.includes('setPanel(!!state.panelPinned, { pin: !!state.panelPinned })') && asp.includes('if (isMobile()) return'))
ok('H3 进 work 模式接线（applySbMode 的 on 分支调 applySidebarPin）', body(workJs, 'function applySbMode()').includes('applySidebarPin()'))
ok('H3 浮层「侧边栏」开关落盘（setPane sidebar 分支 saveWork）', body(workJs, 'function setPane(').split("if (k === 'sidebar')")[1]?.split('return')[0]?.includes('saveWork()') === true)
ok('H4 产物 app.js 内两个新口定义唯一', count(appJs, /function stashWorkPanes\(/g) === 1 && count(appJs, /function loadWorkPanes\(/g) === 1 && count(appJs, /function applySidebarPin\(/g) === 1)

// ---------- ⑫ work 布局改版：下沉区顶栏 tab + CSS Grid 三列 + 预览常驻最右（2026-10-06）----------
// 侧栏填充按模式分：chat = 透明卡壳（几何保留、透出底板 --plane，主区会话白卡成对比）；
// work = 白卡并与主区拼成同一张（模式色钩子 #app.work 覆盖背景，见下方 J 组）。
// 形态：work 区是**一整张白卡**（#sidebar.open 与 #chat-area.work 等底同色、中缝零间距），
// 卡中间「挖」一个圆角矩形当**下沉洞**（顶栏格 + 内容格拼成，底色 --plane、四周留 8px 白边）；
// 预览默认开、固定最右列（#chat-area.work 白卡的一部分）。
// 顶栏 [＋][聊天][文件名] pill 由 renderTopbar 单口渲染，active 与下沉区实际显示同源（wkShownTab）。
ok('I1 index.html 含顶栏结构（.wk-topbar / #wk-tb-new / #wk-tb-tabs）', ['wk-topbar', 'wk-tb-new', 'wk-tb-tabs'].every((c) => idx.includes(c)))
ok('I1 index.html 旧链清除（#wk-ed-back 已删）', !idx.includes('wk-ed-back'))
ok('I1 视图浮层两行（预览 / 侧边栏，四行退场）', ['data-wkpane="workspace"', 'data-wkpane="sidebar"'].every((c) => idx.includes(c)) && !idx.includes('data-wkpane="editor"') && !idx.includes('data-wkpane="assist"'))
const rt = body(workJs, 'function renderTopbar()')
ok('I2 renderTopbar active 与下沉显示同源（读 wkShownTab）', rt.includes('wkShownTab()') && rt.includes('wk-tb-pill'))
ok('I2 顶栏 tab 数据键 data-wktb（点文件切 wkMainTab=file）', body(workJs, 'function mountWork()').includes('data-wktb') && workJs.includes("state.wkMainTab = 'file'"))
ok('I2 顶栏 + 按钮接线 newWorkChat（新建聊天唯一口）', mw.includes("$('wk-tb-new')") && mw.includes('newWorkChat()'))
ok('I3 CSS Grid 三列（下沉区 | 7px 分界条 | --wk-pw 预览列）', /#chat-area\.work \{[\s\S]*?display: grid;[\s\S]*?grid-template-columns: minmax\(0, 1fr\) 7px var\(--wk-pw, 420px\)/.test(styles))
ok('I3 预览关 → 单列退化（:not(.wk-preview)）', /#chat-area\.work:not\(\.wk-preview\) \{ grid-template-columns: minmax\(0, 1fr\)/.test(styles))
ok('I3 下沉区 tab 显隐类（.wk-show-chat / .wk-show-file）', /\.wk-show-chat > #session-card/.test(styles) && /\.wk-show-file > #work-editor/.test(styles))
ok('I3 顶栏 pill 样式（.wk-tb-pill + .on 高亮）', /\.wk-tb-pill \{/.test(styles) && /\.wk-tb-pill\.on \{/.test(styles))
ok('I3 一整张白卡：主区白底 + 外留 2px 缝 + 右半圆角', /#chat-area\.work \{[\s\S]*?margin: 2px 2px 2px 0;[\s\S]*?background: var\(--chat-bg\);[\s\S]*?border-radius: 0 var\(--radius\) var\(--radius\) 0/.test(styles))
ok('I3 侧栏与主区拼成同一张白卡（右缝归零 + 右角不圆 + work 白底）', /#app\.work #sidebar\.open \{ margin-right: 0; background: var\(--chat-bg\); border-radius: var\(--radius\) 0 0 var\(--radius\)/.test(styles))
ok('I3 chat 侧栏透明卡壳（open 态几何保留 + 透明填充，外留 2px 缝）', /#sidebar\.open \{ width: calc\(var\(--panel-w\) \+ 4px\); padding: 2px; height: auto; margin: 2px 0 2px 2px; background: transparent/.test(styles))
ok('I3 下沉洞上半（顶栏格 --plane + 2px 边距 + 上圆角）', /#chat-area\.work > \.wk-topbar \{[\s\S]*?background: var\(--plane\);[\s\S]*?margin: 2px 2px 0;[\s\S]*?border-radius: var\(--radius\) var\(--radius\) 0 0/.test(styles))
ok('I3 下沉洞下半（内容格 --plane + 下圆角，浮卡/收敛条 :not 排除）', /#chat-area\.work > #work-editor,\s*\n#chat-area\.work > #session-card:not\(\.wk-assist-float\):not\(\.wk-assist-slim\) \{[\s\S]*?background: var\(--plane\);[\s\S]*?margin: 0 2px 2px;[\s\S]*?border-radius: 0 0 var\(--radius\) var\(--radius\)/.test(styles))
ok('I3 角色图承载面透明（.g-stage 无白底，防 re-框成白方块）', /\.g-stage \{[\s\S]*?background: transparent/.test(styles))
ok('I3 预览保持白卡（.wk-preview > #work-preview 显形）', /#chat-area\.work\.wk-preview > #work-preview \{ display: flex/.test(styles))
ok('I4 旧链 CSS 清除（.wk-file-open 覆盖层 / .wk-ed-back 已删）', !/\.wk-file-open/.test(styles) && !/\.wk-ed-back/.test(styles))
ok('I4 旧链 JS 清除（applyWorkFlex / wkFlex / PANE_EL 已删）', !/applyWorkFlex|state\.wkFlex|const PANE_EL/.test(workJs))
ok('I4 旧链 work.js 清除（.wk-file-open / #wk-ed-back 已删）', !/wk-file-open|wk-ed-back/.test(workJs))
ok('I4 state.js 删 wkFlex/wkEditor + 加 wkMainTab/wkPrevW 初值', !/wkFlex|wkEditor/.test(stateJs) && /wkMainTab: 'chat'/.test(stateJs) && /wkPrevW: 420/.test(stateJs))
ok('I5 预览列宽单写口 applyWorkCols（写 CSS 变量 --wk-pw）', body(workJs, 'function applyWorkCols()').includes("setProperty('--wk-pw'") && /state\.wkPrevW = Math\.max\(WK_PREV_MIN/.test(body(workJs, 'function bindGutter(')))
ok('I5 分界条只剩一条（index.html 单一 .work-gutter）', (idx.match(/class="work-gutter"/g) || []).length === 1)
ok('I6 产物 app.js 含新口定义唯一（wkShownTab / renderTopbar / applyWorkCols）', count(appJs, /function wkShownTab\(/g) === 1 && count(appJs, /function renderTopbar\(/g) === 1 && count(appJs, /function applyWorkCols\(/g) === 1)
ok('I6 产物 app.js 旧口清除（applyWorkFlex / closeWorkFile / wk-file-open）', !/function applyWorkFlex\(|function closeWorkFile\(|wk-file-open/.test(appJs))

// ---------- ⑬ 顶栏会话胶囊：开放集（浏览器 tab 模型）（2026-10-06）----------
// 真源 state.wkChats（条目 = 会话 hash 或 'new' 哨兵）；顶栏一条一枚、命名用会话标题、× 只从顶栏移除
// 不删会话（wkCloseTab）；路由落地由 syncWorkTabs 并入；活跃项 = 当前路由（wkActiveKey）。
const closeBody = body(workJs, 'function wkCloseTab(')
ok('J1 state.js wkChats 初值 + saveWork 落盘 + loadWork 恢复（字符串数组）', /wkChats: \[\]/.test(stateJs) && stateJs.includes('wkChats: state.wkChats') && /Array\.isArray\(d\.wkChats\)/.test(stateJs))
ok('J2 work.js 胶囊口四件定义唯一（wkActiveKey / wkEnsureTab / wkCloseTab / syncWorkTabs）', count(workJs, /const wkActiveKey = /g) === 1 && count(workJs, /function wkEnsureTab\(/g) === 1 && count(workJs, /function wkCloseTab\(/g) === 1 && count(workJs, /function syncWorkTabs\(/g) === 1)
ok('J2 活跃键 = 当前路由（currentHash，空 ⇒ WK_NEW_TAB）', /wkActiveKey = \(\) => state\.currentHash \|\| WK_NEW_TAB/.test(workJs) && workJs.includes("const WK_NEW_TAB = 'new'"))
ok('J3 renderTopbar 渲多胶囊（遍历 wkChats + data-wkchat + .wk-tb-x）', rt.includes('for (const key of state.wkChats)') && rt.includes('data-wkchat=') && rt.includes('wk-tb-x'))
ok('J3 胶囊命名用会话标题（wkTabName 读 findSession(...).title）', /wkTabName[\s\S]{0,160}findSession/.test(workJs) && /\(s && s\.title\)/.test(workJs) && workJs.includes("return '新对话'"))
ok('J4 × 只从顶栏移除不删会话（wkCloseTab 无 closeSession/delete）', !/closeSession|deleteSession|DELETE/.test(closeBody))
ok('J4 × 关 tab 接线（wk-tb-x → wkCloseTab）', body(workJs, 'function mountWork()').includes("closest('.wk-tb-x')") && body(workJs, 'function mountWork()').includes('wkCloseTab('))
ok('J4 聊天胶囊点击接线（data-wkchat → 切路由 + 靠回栏）', body(workJs, 'function mountWork()').includes("closest('[data-wkchat]')"))
ok('J5 applyPanes 保开放集含当前 tab（wkEnsureTab(wkActiveKey())）', body(workJs, 'function applyPanes()').includes('wkEnsureTab(wkActiveKey())'))
ok('J5 work 侧栏点会话入开放集（sess-item 分支 wkEnsureTab）', /closest\('\.sess-item'\)[\s\S]{0,200}wkEnsureTab\(s\.dataset\.hash\)/.test(workJs))
ok('J5 syncWorkTabs 导出且在 route.js 调用', /export \{[\s\S]*?syncWorkTabs[\s\S]*?\}/.test(workJs) && routeJs.includes('syncWorkTabs()'))
ok('J6 CSS 关闭钮样式（.wk-tb-x + hover）', /\.wk-tb-x \{/.test(styles) && /\.wk-tb-x:hover \{/.test(styles))
ok('J6 产物 app.js 胶囊口定义唯一', count(appJs, /function wkCloseTab\(/g) === 1 && count(appJs, /function syncWorkTabs\(/g) === 1 && appJs.includes('data-wkchat'))

// ---------- ⑭ 四 bug 修复（2026-10-06）：文件 tab 关闭钮 / 点会话切聊天 tab / 模式白块 / 模式色钩子 ----------
// K1 打开的文件顶栏 pill 带关闭钮（× → closeWkFile：先 flush 编辑 → 清 workFile → 切回聊天 tab）
ok('K1 文件 pill 带 ×（renderTopbar 文件分支渲 .wk-tb-x）', /data-wktb="file"[\s\S]{0,300}wk-tb-x/.test(rt))
ok('K1 × 接线到 closeWkFile（mountWork 文件分支）', body(workJs, 'function mountWork()').includes('closeWkFile()'))
ok('K1 closeWkFile 先 flush 再清 workFile + 切聊天 tab', /async function closeWkFile\(\)[\s\S]{0,300}wkEdFlush\(\)[\s\S]{0,200}workFile = ''[\s\S]{0,200}wkMainTab = 'chat'/.test(workJs))
// K2 work 侧栏点会话 → 强制聊天 tab 顶上来（否则文件 tab 占着下沉格，看着像「点了没反应」）
ok('K2 sess-item 分支强制 wkMainTab=chat + 助手靠回栏', /closest\('\.sess-item'\)[\s\S]{0,400}wkMainTab = 'chat'[\s\S]{0,200}wkAssist = true[\s\S]{0,120}wkAssistMode = 'side'/.test(workJs))
// K3 模式 tab：切换器**不含任何胶囊元素**（无轨道 / 无滑动白块），卡面上只有唯一一块「空位」，
// 且**空位落在非当前模式那侧**（处于的模式在卡片上）；切换 = 空位变形 + 位移（前缘先到、后缘后到 ⇒ 中途拉长）
ok('K3 index.html 含空位元素（.ms-thumb 在 .mode-switch 内）', /<div class="mode-switch"[\s\S]{0,500}class="ms-thumb"/.test(idx))
ok('K3 无轨道底色（.mode-switch 不带 background / box-shadow）', /\.mode-switch \{ position: relative; display: flex; gap: 2px; border-radius: 9px; padding: 3px; \}/.test(styles))
ok('K3 空位 = 半透明暗底 + 内阴影（从卡面缺掉一块的读数）', /\.ms-thumb \{[\s\S]{0,300}background: rgba\(0, 0, 0, 0\.06\)[\s\S]{0,200}box-shadow: inset 0 1px 2px/.test(styles))
ok('K3 空位用 left/right 内衬（非 left/width，才可两缘分速变形）', /\.ms-thumb \{[\s\S]{0,200}left: 3px; right: 50%; top: 3px; bottom: 3px/.test(styles) && !/\.ms-thumb \{[^}]*width:/.test(styles))
ok('K3 CSS 不带 transition（动画只由 JS 按方向写，避免初始化/重排误播）', !/\.ms-thumb \{[^}]*transition/.test(styles))
ok('K3 旧 work 下延贴卡已清（无 #app.work .ms-thumb 分支）', !/#app\.work \.ms-thumb/.test(styles))
ok('K3 当前模式与背景同色 = .ms-btn.on 不画底色（只翻字色，不自绘白片）', /\.ms-btn\.on \{ color: var\(--text\); \}/.test(styles) && !/\.ms-btn\.on \{[^}]*background/.test(styles))
ok('K3 空位归属 = 非当前钮（选取器 .ms-btn:not(.on)，反了即当前模式被凹进去）', /const btn = sw && sw\.querySelector\('\.ms-btn:not\(\.on\)'\)/.test(workJs))
ok('K3 空位定位单口 positionMsThumb（applySbMode 调 + fonts.ready 重量）', count(workJs, /function positionMsThumb\(/g) === 1 && body(workJs, 'function applySbMode()').includes('positionMsThumb()') && workJs.includes('document.fonts.ready.then(positionMsThumb)'))
ok('K3 变形位移 = 按方向写快/慢 transition（去左 left 快 right 慢；去右 right 快 left 慢）', /const moved = msAtFirst !== null && msAtFirst !== first[\s\S]{0,400}th\.style\.transition = first\s*\?\s*`left \$\{MS_FAST\}, right \$\{MS_SLOW\}`\s*:\s*`right \$\{MS_FAST\}, left \$\{MS_SLOW\}`/.test(workJs))
ok('K3 非切换定位 transition:none（初始化 / resize / 字体到位不播动画）', /} else \{\s*th\.style\.transition = 'none'\s*\}/.test(workJs))
ok('K3 几何 = 非当前钮矩形（offsetLeft 内衬 + clientWidth 反推右内衬，无 work 分支）', /th\.style\.left = btn\.offsetLeft \+ 'px'[\s\S]{0,200}th\.style\.right = sw\.clientWidth - btn\.offsetLeft - btn\.offsetWidth \+ 'px'/.test(workJs) && !/borderTopLeftRadius|borderTopRightRadius|gapMid/.test(workJs))
// K5 卡片区域间距统一（2026-10-06 用户定案「以 chat 的 2px 为准」）：work 下沉洞四边缝 8px→2px
ok('K5 work 洞缝 2px（顶栏 / 内容格，与 chat .view-card 外边距同值）', /#chat-area\.work > \.wk-topbar \{[\s\S]{0,200}margin: 2px 2px 0;/.test(styles) && /#session-card:not\(\.wk-assist-float\):not\(\.wk-assist-slim\) \{[\s\S]{0,200}margin: 0 2px 2px;/.test(styles))
ok('K5 手机档同律 2px（旧 6px 已清）', /#chat-area\.work > \.wk-topbar \{ margin: 2px 2px 0; \}/.test(styles) && !/margin: 6px 6px 0/.test(styles) && !/margin: 0 6px 6px/.test(styles))
ok('K5 旧 8px 洞缝已清（单一真源）', !/margin: 8px 8px 0/.test(styles) && !/margin: 0 8px 8px/.test(styles))
// K4 模式色钩子（workstate）：随模式切换的颜色统一挂 #app.work 一个类（唯一写口 applySbMode）
ok('K4 work.js 落 #app.work（applySbMode 唯一写口）', body(workJs, 'function applySbMode()').includes("$('app').classList.toggle('work', on)"))
ok('K4 CSS 定义 --sunken-bg（chat 白卡 / work 底板）', /#app \{ --sunken-bg: var\(--chat-bg\);/.test(styles) && /#app\.work \{ --sunken-bg: var\(--plane\); \}/.test(styles))
ok('K4 composer-mask 消费 --sunken-bg（work 下挡板随底板换色）', /#composer-mask \{[\s\S]*?var\(--sunken-bg\) 36px/.test(styles))
ok('K4 旧旁路选择器 :has(#panel.work) 清除（模式色单一真源）', !/:has\(#panel\.work\) \{/.test(styles))
ok('K4 产物 app.js 含白块定位 + 模式钩子', count(appJs, /function positionMsThumb\(/g) === 1 && appJs.includes("classList.toggle('work', on)"))

console.log(`\n${pass}/${fail}`)
process.exit(fail ? 1 : 0)
