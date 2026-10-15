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
const bundle = [uiStateJs, workStateJs, storageJs, workContextJs].map(strip).join('\n')
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
ok('A1 WORK_SLOT_DEF 有全 11 键（槽与 live 一一对应）', eq(
  Object.keys(WORK_SLOT_DEF).sort(),
  ['wkTab', 'wkMainTab', 'wkAssist', 'wkAssistMode', 'wkAssistH', 'wkChats', 'wkFiles', 'workFile', 'wkPreview', 'wkPvTab', 'panelPinned'].sort(),
), `keys=${Object.keys(WORK_SLOT_DEF).sort().join(',')}`)
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
const liveBefore = state.wkChats.slice()
state.wkChats = ['#a1', '#a2', '#a3'] // 运行期只动 live（未 stash）
const changed = api.switchWorkProject('PJ-B')
ok('C1 切项目返回 true + workProj/workSlotKey 双换', changed === true && state.workProj === 'PJ-B' && state.workSlotKey === 'PJ-B')
ok('C1 旧槽被 stash（含运行期对 live 的改动，不是旧快照）', eq(state.workSlots['PJ-A'].wkChats, ['#a1', '#a2', '#a3']) && state.workSlots['PJ-A'].workFile === 'X/main.tex')
ok('C1 新槽落到 live（PJ-B 有自己的开放集）', eq(state.wkChats, ['#b1']) && eq(state.wkFiles, []) && state.workFile === '' && state.wkTab === 'files')
ok('C1 切项目**不清空** live 为硬编码空（清空 = 把切回来恢复永久做掉）', !/state\.wkChats = \[\]/.test(workFilesJs) && !/state\.wkFiles = \[\]/.test(workFilesJs))

const back = api.switchWorkProject('PJ-A')
ok('C2 切回 PJ-A 恢复它自己的开放集/文件/侧栏页', back === true && eq(state.wkChats, ['#a1', '#a2', '#a3']) && state.wkTab === 'chat' && state.wkPreview === false && state.panelPinned === true)
ok('C2 同 label 重复切 = 无操作（返回 false，不重放 stash/load）', api.switchWorkProject('PJ-A') === false)

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
state.wkTab = 'ws'
ok('E1 工作区根散件视图（wkTab=ws）→ kind=workspace', api.getWorkContext().kind === 'workspace')
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

// ---------- I. 构建产物（生成物必须已重建）----------
ok('I1 bundle-web-modules 注册 work-context.js（排在 work-state.js 之后）', bundlerJs.indexOf("'sidebar/work-context.js'") > bundlerJs.indexOf("'sidebar/work-state.js'"))
ok('I1 app.js 产物含新口定义各一', /function stashWorkSlot\(/.test(appJs) && /function loadWorkSlot\(/.test(appJs) && /function switchWorkProject\(/.test(appJs) && /function reconcileWorkSurface\(/.test(appJs) && /const WORK_SLOT_DEF = \{/.test(appJs))
ok('I1 app.js 产物无旧口残留', !/function stashWorkPanes\(|function loadWorkPanes\(|const WK_PANES_DEF|wkPanes: \{\}/.test(appJs))

console.log(`\n${pass}/${pass + fail}`)
if (fail > 0) process.exit(1)
