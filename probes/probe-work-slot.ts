// probe-work-slot.ts —— work 项目槽状态模型（2026-10-15 待办 #5/#8/#9 根治）行为 + 接线探针（只读）
//
// 被守护的不变量（组 1 步骤 1–4）：
//   ① 唯一不变量：state.workSlotKey === state.workProj（live 字段恒镜像当前项目的槽）。
//   ② 切项目 = stash 旧槽 → 换 workProj → load 新槽；**不再清空**（旧的 wkChats=[] / wkFiles=[] 重置已删）。
//   ③ 槽 = <label> → 一整套 work 界面状态（键 = WORK_SLOT_DEF），live 是当前槽的活视图。
//   ④ 语境唯一源 getWorkContext()；顶栏投影 getWorkSurfaceProjection() 取当前那槽（live）。
//   ⑤ 启动恢复 loadWork() + 归一 reconcileWorkSurface()（幂等）。
//   ⑥ 旧扁平形态（wkChats/workFile/wkPanes）一次性迁移进当时 workProj 的槽。
// 本探针**真跑**槽函数（把四件源码剥 import/export 后拼进同一作用域 eval，喂 localStorage 桩），
// 不靠文本匹配猜行为。静态接线断言读 work/*.js 与 bundle-web-modules.ts。
// 用法：bun run ./probe-work-slot.ts

const SRC = `${import.meta.dir}/../src/gateway/web-src`

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail = '') {
  if (cond) pass++
  else fail++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : '  ← ' + detail}`)
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

// ---------- 静态源 ----------
const read = (p: string) => Bun.file(`${SRC}/${p}`).text()
const uiStateJs = await read('core/ui-state.js')
const workStateJs = await read('sidebar/work-state.js')
const storageJs = await read('core/storage.js')
const workContextJs = await read('sidebar/work-context.js')
const workJs = await read('sidebar/work.js')
const workLayoutJs = await read('sidebar/work/work-layout.js')
const workRowsJs = await read('sidebar/work/work-rows.js')
const workFilesJs = await read('sidebar/work/work-files.js')
const workMountJs = await read('sidebar/work/work-mount.js')
const bundlerJs = await Bun.file(`${import.meta.dir}/../scripts/bundle-web-modules.ts`).text()
const appJs = await Bun.file(`${import.meta.dir}/../src/gateway/web/app.js`).text()

// ---------- 真跑：四件源码同域 eval（剥 import / export 块；与 bundle-web-modules 单 IIFE 同形）----------
function strip(src: string) {
  return src
    .replace(/^\s*import\s[\s\S]*?from\s+'[^']*'\s*$/gm, '')
    .replace(/^export\s*\{[\s\S]*?\}/gm, '')
    .replace(/^export\s+(?=(function|const|let|class)\b)/gm, '')
}
// work.js 侧声明的、被 work-layout/work-context 直接引用的符号（单 IIFE 共享作用域）：在桩里显式
// 声明，避免隐式全局，也让「切项目重置 wkPrevActiveKey」可被真跑观测。
const PRELUDE = `let wkPrevActiveKey = null;\n  const WK_NEW_TAB = 'new'`
const bundle = [PRELUDE, uiStateJs, workStateJs, storageJs, workContextJs].map(strip).join('\n')
const store = new Map<string, string>()
const localStorageStub = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
}
// eslint-disable-next-line no-new-func
const api = new Function(
  'localStorage',
  `${bundle}
  return { state, WORK_SLOT_DEF, stashWorkSlot, loadWorkSlot, saveWork, loadWork, UI_KEY,
           getWorkContext, getWorkProjectSlot, getWorkSurfaceProjection, switchWorkProject, reconcileWorkSurface }`,
)(localStorageStub) as any
const { state, WORK_SLOT_DEF } = api

// ---------- A. 槽缺省表 = 单一真源 ----------
ok('A1 WORK_SLOT_DEF 有全 12 键（11 live 镜像键 + 槽专属 activeChat）', eq(
  Object.keys(WORK_SLOT_DEF).sort(),
  ['wkTab', 'wkMainTab', 'wkAssist', 'wkAssistMode', 'wkAssistH', 'wkChats', 'wkFiles', 'activeChat', 'workFile', 'wkPreview', 'wkPvTab', 'panelPinned'].sort(),
), `keys=${Object.keys(WORK_SLOT_DEF).sort().join(',')}`)
ok('A1 activeChat 缺省空串（槽专属，无同名 live 字段）', WORK_SLOT_DEF.activeChat === '' && !/activeChat/.test(uiStateJs))
ok('A1 旧 WK_PANES_DEF 已从源码消失', !/WK_PANES_DEF/.test(workStateJs + storageJs + uiStateJs + workFilesJs + workMountJs))
ok('A1 wkTab 提升入 state（初值 files）', /wkTab: 'files'/.test(uiStateJs))
ok('A1 state 有 workSlots 空表 + workSlotKey 空串', /workSlots: \{\}/.test(uiStateJs) && /workSlotKey: ''/.test(uiStateJs))

// ---------- B. loadWork：读盘恢复 + 落当前槽 ----------
const slotA = { ...WORK_SLOT_DEF, wkTab: 'chat', wkChats: ['#a1', '#a2'], wkFiles: ['X/main.tex'], workFile: 'X/main.tex', wkPreview: false, panelPinned: true }
store.set(api.UI_KEY, JSON.stringify({ sbMode: 'work', workProj: 'PJ-A', wkPrevW: 512, workSlots: { 'PJ-A': slotA, 'PJ-B': { ...WORK_SLOT_DEF, wkChats: ['#b1'] } } }))
api.loadWork(WORK_SLOT_DEF)
ok('B1 loadWork 恢复模式 + 当前项目 + 全局列宽', state.sbMode === 'work' && state.workProj === 'PJ-A' && state.wkPrevW === 512)
ok('B1 不变量：workSlotKey === workProj', state.workSlotKey === 'PJ-A')
ok('B1 当前槽落到 live（顶栏开放集 + 侧栏页 + 开关）', eq(state.wkChats, ['#a1', '#a2']) && eq(state.wkFiles, ['X/main.tex']) && state.wkTab === 'chat' && state.wkPreview === false && state.panelPinned === true)
ok('B1 全局量不进槽（wkPrevW 是窗口几何）', !('wkPrevW' in WORK_SLOT_DEF))

// ---------- C. switchWorkProject：stash 旧 → 换 → load 新 ----------
state.wkChats = ['#a1', '#a2', '#a3'] // 运行期只动 live（未 stash）
state.currentHash = '#a2' // 切走前 A 停在 #a2（activeChat 的记入源）
const changed = api.switchWorkProject('PJ-B')
ok('C1 切项目返回目标路由（PJ-B 无活动会话 → 空串）+ workProj/workSlotKey 双换', changed === '' && state.workProj === 'PJ-B' && state.workSlotKey === 'PJ-B', `ret=${JSON.stringify(changed)}`)
ok('C1 旧槽被 stash（含运行期对 live 的改动 + activeChat = 切换前会话）', eq(state.workSlots['PJ-A'].wkChats, ['#a1', '#a2', '#a3']) && state.workSlots['PJ-A'].workFile === 'X/main.tex' && state.workSlots['PJ-A'].activeChat === '#a2')
ok('C1 新槽落到 live（PJ-B 有自己的开放集）', eq(state.wkChats, ['#b1']) && eq(state.wkFiles, []) && state.workFile === '' && state.wkTab === 'files')
ok('C1 切项目**不清空** live 为硬编码空（清空 = 把切回来恢复永久做掉）', !/state\.wkChats = \[\]/.test(workFilesJs) && !/state\.wkFiles = \[\]/.test(workFilesJs))

const back = api.switchWorkProject('PJ-A')
ok('C2 切回 PJ-A 返回其活动会话（恢复目标）+ 恢复开放集/文件/侧栏页', back === '#a2' && eq(state.wkChats, ['#a1', '#a2', '#a3']) && state.wkTab === 'chat' && state.wkPreview === false && state.panelPinned === true, `ret=${JSON.stringify(back)}`)
ok('C2 同 label 重复切 = 无操作（返回 null，不重放 stash/load）', api.switchWorkProject('PJ-A') === null)

// ---------- D. saveWork：live → 槽 → localStorage 同一次 patch ----------
state.workFile = 'X/main.tex'
state.wkFiles = ['X/main.tex']
api.saveWork()
const saved = JSON.parse(store.get(api.UI_KEY)!)
ok('D1 saveWork 落盘含 workSlots + 全局量同一次 patch', !!saved.workSlots && saved.workProj === 'PJ-A' && saved.sbMode === 'work' && saved.wkPrevW === 512)
ok('D1 当前槽在盘上（含刚改的 workFile）', eq(saved.workSlots['PJ-A'].wkFiles, ['X/main.tex']) && saved.workSlots['PJ-A'].workFile === 'X/main.tex')
ok('D1 未选项目不落槽（无 workProj 时 stash 空转）', (() => { const s = state.workProj; state.workProj = ''; const n = Object.keys(state.workSlots).length; api.stashWorkSlot(); const same = Object.keys(state.workSlots).length === n; state.workProj = s; return same })())

// ---------- E. 语境唯一源 + 顶栏投影 ----------
const ctxA = api.getWorkContext()
ok('E1 getWorkContext：项目语境（kind/projectKey/mode/tab）', ctxA.kind === 'project' && ctxA.projectKey === 'PJ-A' && ctxA.mode === 'work' && ctxA.selectedTab === 'chat')
// E1（2026-10-15 待办 7 收尾）：撤 `wkTab==='ws'` 第三态——kind 只看 projectKey 在场（工作区根「全局根·
// 散装对话」有 label ⇒ project 语境），wkTab 取值不再影响 kind。旧断言「wkTab=ws → kind=workspace」已失效。
state.wkTab = 'ws'
ok('E1 撤第三态：有 projectKey 时 wkTab 不影响 kind（仍 project）', api.getWorkContext().kind === 'project')
ok('E1 无 projectKey（未选项目）→ kind=workspace', (() => { const p = state.workProj; state.workProj = ''; const k = api.getWorkContext().kind; state.workProj = p; return k === 'workspace' })())
state.wkTab = 'chat'
state.wkChats = ['#a1', '#live-only']
const proj = api.getWorkSurfaceProjection(ctxA)
ok('E2 顶栏投影取当前槽 = live（读槽会滞后一拍）', eq(proj.chats, ['#a1', '#live-only']) && eq(proj.files, ['X/main.tex']) && proj.activeFile === 'X/main.tex')
const projB = api.getWorkSurfaceProjection({ kind: 'project', projectKey: 'PJ-B', selectedTab: 'files' })
ok('E2 问别的项目落它自己的槽', eq(projB.chats, ['#b1']))
ok('E2 空语境（工作区根）两族皆空', eq(api.getWorkSurfaceProjection({ kind: 'workspace', projectKey: '', selectedTab: 'ws' }).chats, []))

// ---------- F. reconcileWorkSurface：幂等归一 ----------
state.workSlotKey = '' // 人为制造漂移
api.reconcileWorkSurface()
ok('F1 漂移（workSlotKey≠workProj）→ 归一回正轨', state.workSlotKey === 'PJ-A' && eq(state.wkChats, ['#a1', '#a2', '#a3']))
const snapChats = state.wkChats.slice()
api.reconcileWorkSurface()
ok('F1 无漂移时幂等（不动 live）', state.workSlotKey === 'PJ-A' && eq(state.wkChats, snapChats))

// ---------- F2. reconcile 物化当前项目槽（当前项目的槽恒存在 → 投影 API 不当 null 读）----------
const store3 = new Map<string, string>()
store3.set(api.UI_KEY, JSON.stringify({ sbMode: 'work', workProj: 'PJ-NEW' })) // 有项目、无 workSlots
const api3 = (() => {
  const ls = { getItem: (k: string) => (store3.has(k) ? store3.get(k)! : null), setItem: (k: string, v: string) => void store3.set(k, v) }
  // eslint-disable-next-line no-new-func
  return new Function('localStorage', `${bundle}\n return { state, WORK_SLOT_DEF, loadWork, reconcileWorkSurface, getWorkProjectSlot }`)(ls) as any
})()
api3.loadWork(api3.WORK_SLOT_DEF)
ok('F2 无 workSlots 表 → 迁移链物化当前项目槽 + live 回落 def', !!api3.getWorkProjectSlot('PJ-NEW') && eq(api3.state.wkChats, []) && api3.state.workSlotKey === 'PJ-NEW')
ok('F2 缺省槽数组是独立副本（不共享 WORK_SLOT_DEF.wkChats）', eq(api3.WORK_SLOT_DEF.wkChats, []) && eq(api3.state.workSlots['PJ-NEW'].wkChats, []))

// 槽表存在但缺当前项目那一条（外部/异常存档）→ reconcile 物化，投影 API 不当 null 读
const store4 = new Map<string, string>()
store4.set(api.UI_KEY, JSON.stringify({ sbMode: 'work', workProj: 'PJ-GAP', workSlots: { 'PJ-X': { ...WORK_SLOT_DEF, wkChats: ['#x1'] } } }))
const api4 = (() => {
  const ls = { getItem: (k: string) => (store4.has(k) ? store4.get(k)! : null), setItem: (k: string, v: string) => void store4.set(k, v) }
  // eslint-disable-next-line no-new-func
  return new Function('localStorage', `${bundle}\n return { state, WORK_SLOT_DEF, loadWork, reconcileWorkSurface, getWorkProjectSlot, getWorkSurfaceProjection }`)(ls) as any
})()
api4.loadWork(api4.WORK_SLOT_DEF)
api4.reconcileWorkSurface()
ok('F2 槽表缺当前项目条 → reconcile 物化（getWorkProjectSlot 不再 null）', !!api4.getWorkProjectSlot('PJ-GAP') && eq(api4.state.workSlots['PJ-GAP'].wkChats, []))
ok('F2 别的项目槽不被 reconcile 动', eq(api4.getWorkProjectSlot('PJ-X').wkChats, ['#x1']))

// ---------- G. 旧扁平形态一次性迁移 ----------
const store2 = new Map<string, string>()
store2.set(api.UI_KEY, JSON.stringify({ sbMode: 'work', workProj: 'PJ-OLD', workFile: 'Old/f.tex', wkChats: ['#o1'], wkFiles: ['Old/f.tex'], wkMainTab: 'file', wkPanes: { 'PJ-OLD': { workspace: false, sidebar: true }, 'PJ-X': { workspace: true, sidebar: false } } }))
const storeBak = (globalThis as any).localStorage
const api2 = (() => {
  const ls = { getItem: (k: string) => (store2.has(k) ? store2.get(k)! : null), setItem: (k: string, v: string) => void store2.set(k, v) }
  // eslint-disable-next-line no-new-func
  return new Function('localStorage', `${bundle}\n return { state, WORK_SLOT_DEF, loadWork }`)(ls) as any
})()
;(globalThis as any).localStorage = storeBak
api2.loadWork(api2.WORK_SLOT_DEF)
ok('G1 无 workSlots → 扁平字段折进当时 workProj 的槽', eq(api2.state.workSlots['PJ-OLD'].wkChats, ['#o1']) && api2.state.workSlots['PJ-OLD'].workFile === 'Old/f.tex' && api2.state.workSlots['PJ-OLD'].wkMainTab === 'file')
ok('G1 旧 wkPanes 两开关并入槽（workspace/sidebar → wkPreview/panelPinned）', api2.state.workSlots['PJ-OLD'].wkPreview === false && api2.state.workSlots['PJ-OLD'].panelPinned === true)
ok('G1 其余 wkPanes 槽用 def 补齐（保住每项目开关）', api2.state.workSlots['PJ-X'] && api2.state.workSlots['PJ-X'].wkPreview === true && api2.state.workSlots['PJ-X'].panelPinned === false && eq(api2.state.workSlots['PJ-X'].wkChats, []))
ok('G1 迁移后不变量仍成立', api2.state.workSlotKey === 'PJ-OLD')

// ---------- H. 接线（静态）----------
const spBody = (() => { const i = workFilesJs.indexOf('async function selectProject('); if (i < 0) return ''; let d = 0, st = false; for (let j = i; j < workFilesJs.length; j++) { const c = workFilesJs[j]; if (c === '{') { d++; st = true } else if (c === '}') { d--; if (st && d === 0) return workFilesJs.slice(i, j + 1) } } return '' })()
ok('H1 selectProject 走唯一口 switchWorkProject（无 stashWorkPanes/loadWorkPanes）', spBody.includes('switchWorkProject(label)') && !/stashWorkPanes|loadWorkPanes|stashWorkSlot\(\)|loadWorkSlot\(/.test(spBody))
ok('H1 selectProject 仍保留切项目后落地链（applyPanes/applySidebarPin/loadProjectTree）', spBody.includes('applyPanes()') && spBody.includes('applySidebarPin()') && spBody.includes('loadProjectTree(label)'))
ok('H1 selectProject 切项目前 flush pending 编辑', spBody.indexOf('wkEdFlush') < spBody.indexOf('switchWorkProject(label)'))
const initBody = workMountJs.slice(workMountJs.indexOf('function initWork()'), workMountJs.indexOf('function initWork()') + 400)
ok('H2 initWork：loadWork(WORK_SLOT_DEF) → reconcileWorkSurface（早于 hydrateExtCards）', /loadWork\(WORK_SLOT_DEF\)/.test(initBody) && initBody.indexOf('reconcileWorkSurface()') > initBody.indexOf('loadWork(WORK_SLOT_DEF)') && initBody.indexOf('reconcileWorkSurface()') < initBody.indexOf('hydrateExtCards'))
ok('H2 源码无残留 loadWorkPanes / stashWorkPanes / loadWork(WK_PANES', !/loadWorkPanes|stashWorkPanes|WK_PANES_DEF/.test(workFilesJs + workMountJs + workJs + storageJs))

// ---------- J. 开放集：空路由不造 new / 切项目不凭空多 new / 主动新建才 +1（真跑布局层）----------
// work-layout.js 的 wkEnsureTab/syncWorkTabs/applyPanes 会调 DOM 与跨模块符号，喂桩后真跑——
// 守护的不变量 = 顶栏「新对话」胶囊只由用户主动新建入集；空路由（首页）是无活动胶囊的空态。
const LAYOUT_STUBS = `
  const wkAssistInFlow = () => true
  const findSession = () => null
  const workScopeOk = () => true
  const chatArea = { classList: { toggle() {} } }
  const applyWorkCols = () => {}
  const renderTopbar = () => {}
  const applyPvTab = () => {}
  const renderWorkBody = () => {}
  const toast = () => {}
`
const layoutBundle = [PRELUDE, LAYOUT_STUBS, uiStateJs, workStateJs, storageJs, workContextJs, workLayoutJs].map(strip).join('\n')
const storeL = new Map<string, string>()
const apiL = (() => {
  const ls = { getItem: (k: string) => (storeL.has(k) ? storeL.get(k)! : null), setItem: (k: string, v: string) => void storeL.set(k, v) }
  // eslint-disable-next-line no-new-func
  return new Function('localStorage', `${layoutBundle}\n return { state, WORK_SLOT_DEF, switchWorkProject, wkEnsureTab, wkActiveKey, syncWorkTabs, applyPanes }`)(ls) as any
})()
const st = apiL.state
st.sbMode = 'work'
st.wkAssist = true
st.wkTab = 'files'
st.workSlots = { 'PJ-A': { ...apiL.WORK_SLOT_DEF }, 'PJ-B': { ...apiL.WORK_SLOT_DEF } }
st.workProj = 'PJ-A'
st.workSlotKey = 'PJ-A'
st.wkFiles = []
st.workFile = ''

// J1 空路由（首页）：两条渲染链都不得把 '' 变成 'new'
st.currentHash = ''
st.wkChats = []
apiL.syncWorkTabs()
ok('J1 空路由 syncWorkTabs 不自动并入 new', eq(st.wkChats, []), JSON.stringify(st.wkChats))
apiL.applyPanes()
ok('J1 空路由 applyPanes 不自动并入 new（切项目凭空多胶囊的根因）', eq(st.wkChats, []), JSON.stringify(st.wkChats))

// J2 主动新建：恰好 +1，重复调用幂等
apiL.wkEnsureTab('new')
apiL.wkEnsureTab('new')
ok('J2 主动新建恰好新增一枚 new（重复调用幂等）', eq(st.wkChats, ['new']), JSON.stringify(st.wkChats))

// J3 切项目：A 停在 #a1 → 切 B（B 无活动会话）→ 显式回空态，B 的开放集不得凭空多 new
st.wkChats = ['#a1']
st.currentHash = '#a1'
const tgtB = apiL.switchWorkProject('PJ-B')
st.currentHash = tgtB || ''
apiL.syncWorkTabs()
apiL.applyPanes()
ok('J3 切项目返回目标路由（B 无活动会话 → 空串）', tgtB === '', JSON.stringify(tgtB))
ok('J3 切项目后新项目开放集不凭空多 new', eq(st.wkChats, []), JSON.stringify(st.wkChats))
ok('J3 旧项目槽记下切换前会话（activeChat）', st.workSlots['PJ-A'].activeChat === '#a1', String(st.workSlots['PJ-A'].activeChat))

// J4 切回：恢复原会话，且不新增 new
const tgtA = apiL.switchWorkProject('PJ-A')
ok('J4 切回返回原活动会话 = 恢复目标路由', tgtA === '#a1', JSON.stringify(tgtA))
st.currentHash = tgtA || ''
apiL.syncWorkTabs()
apiL.applyPanes()
ok('J4 切回恢复原会话胶囊且不含 new', st.wkChats.includes('#a1') && !st.wkChats.includes('new'), JSON.stringify(st.wkChats))

// ---------- K. 接线（静态）：切项目显式导航 + 空路由不造 new ----------
ok('K1 selectProject 用 switchWorkProject 的返回值作目标路由', /const target = switchWorkProject\(label\)/.test(spBody))
ok('K1 selectProject 由切项目侧显式导航（不再走 enforceWorkScope 强制跳首页）', /navigate\(target \?/.test(spBody) && !/enforceWorkScope\(\)/.test(spBody))
ok('K1 selectProject 仍渲染席位 renderProjSeat()', spBody.includes('renderProjSeat()'))
ok('K2 syncWorkTabs 不再无条件并入 wkActiveKey（空路由不造 new）', !/wkEnsureTab\(wkActiveKey\(\)\)/.test(workLayoutJs) && /if \(key !== WK_NEW_TAB\) wkEnsureTab\(key\)/.test(workLayoutJs))
ok('K2 applyPanes 空路由不并入 new（守卫 k !== WK_NEW_TAB）', /k !== WK_NEW_TAB\) wkEnsureTab\(k\)/.test(workLayoutJs))
ok('K3 wkEnsureTab(' + "'new'" + ') 的用户入口仅 newWorkChat（主动新建）', /function newWorkChat\([\s\S]*?wkEnsureTab\(WK_NEW_TAB\)/.test(workRowsJs) && !/wkEnsureTab\(WK_NEW_TAB\)/.test(workLayoutJs))
ok('K4 switchWorkProject 返回目标路由 + 重置 wkPrevActiveKey（跨项目不连续）', /return s && typeof s\.activeChat === 'string'/.test(workContextJs) && /wkPrevActiveKey = null/.test(workContextJs))
ok('K5 stashWorkSlot 记 activeChat（仅 work 模式记，防 chat 侧导航污染）', /activeChat: state\.sbMode === 'work'/.test(storageJs))

// ---------- I. 构建产物（生成物必须已重建）----------
ok('I1 bundle-web-modules 注册 work-context.js（排在 work-state.js 之后）', bundlerJs.indexOf("'sidebar/work-context.js'") > bundlerJs.indexOf("'sidebar/work-state.js'"))
ok('I1 app.js 产物含新口定义各一', /function stashWorkSlot\(/.test(appJs) && /function loadWorkSlot\(/.test(appJs) && /function switchWorkProject\(/.test(appJs) && /function reconcileWorkSurface\(/.test(appJs) && /const WORK_SLOT_DEF = \{/.test(appJs))
ok('I1 app.js 产物无旧口残留', !/function stashWorkPanes\(|function loadWorkPanes\(|const WK_PANES_DEF|wkPanes: \{\}/.test(appJs))
ok('I1 app.js 产物含 activeChat 槽键 + 空路由不造 new 的守卫', /activeChat: state\.sbMode === 'work'/.test(appJs) && /if \(key !== WK_NEW_TAB\) wkEnsureTab\(key\)/.test(appJs) && /k !== WK_NEW_TAB\) wkEnsureTab\(k\)/.test(appJs))

console.log(`\n${pass}/${pass + fail}`)
if (fail > 0) process.exit(1)
