// probe-work-scope.ts —— work 模式「在项目中工作」不变量探针（只读，2026-09-26）
// 不变量两条（同一句用户需求的两半，各自有唯一判定点）：
//   ① 落项目：work 模式下的新会话/新上传的目标项目 = 工作项目（state.workProj），
//      唯一真源 = core/state.js newSessionProject()——任何消费点直读 state.newProject 都会漏。
//   ② 助手栏范围：work 模式下助手栏只展示工作项目的会话（别的项目的会话路径→退回该项目新对话空态），
//      唯一判定点 = sidebar/work.js workScopeOk()，路由渲染/切模式/切项目三处入口共用。
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

console.log(`\n${pass}/${fail}`)
process.exit(fail ? 1 : 0)
