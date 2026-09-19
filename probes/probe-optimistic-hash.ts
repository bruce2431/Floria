// probe-optimistic-hash.ts —— 「无当前会话态只有一种表示：''」不变量探针（只读，2026-09-19）
// 背景：state.currentHash 曾用 null 表示「没有会话」，而 firstSendHash 与乐观项 pendingUserMsgs.hash
// 的「未归属」约定用 ''——同一语义两套空值。首页发首条消息时乐观气泡按 null 入表，navigate 进会话后
// renderSession 的归属守卫（按 '' 写）判 null === '' 为假 → 乐观项被丢 → 气泡先闪现后消失，等落盘才恢复。
// 本探针钉死「只有一种表示」：五处赋值点恒 ''、全仓无 null 残留、乐观项表示与 state 同源，
// 并用**源码同形表达式**（字形从源码提取，非手抄）跑归属真值表。
// 用法：bun run ./probe-optimistic-hash.ts   （输出 pass/fail，末行 N/M）

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
const routeJs = await Bun.file(`${SRC}/chat/route.js`).text()
const mgrJs = await Bun.file(`${SRC}/sidebar/mgr.js`).text()
const messagesJs = await Bun.file(`${SRC}/chat/messages.js`).text()
const approvalJs = await Bun.file(`${SRC}/inputbar/approval.js`).text()
const liveJs = await Bun.file(`${SRC}/core/live.js`).text()
const appJs = await Bun.file(`${WEB}/app.js`).text()

// 全 web-src（含未列出的模块，防新增模块再引入 null）
const allSrc = (
  await Promise.all(
    ['core/state.js', 'chat/route.js', 'sidebar/mgr.js', 'chat/messages.js', 'inputbar/approval.js',
     'core/live.js', 'inputbar/send.js', 'sidebar/recent.js', 'core/gateway.js', 'core/auth.js', 'sidebar/neurons.js']
      .map((f) => Bun.file(`${SRC}/${f}`).text()),
  )
).join('\n')

// ---------- ① 五处赋值点恒 '' ----------
ok('A1 state 初值 currentHash: \'\'', /currentHash:\s*''\s*,/.test(stateJs))
ok("A2 route() 非 session 分支落 ''", /state\.currentHash\s*=\s*r\.name === 'session' \? r\.hash : ''/.test(routeJs))
ok("A3 renderHome 落 ''", /state\.currentHash\s*=\s*''/.test(routeJs))
ok("A4 renderMgr 落 ''（两处：renderMgr + openProjectPreview）",
  (mgrJs.match(/state\.currentHash\s*=\s*''/g) || []).length === 2,
  `实得 ${(mgrJs.match(/state\.currentHash\s*=\s*''/g) || []).length} 处`)

// ---------- ② 全仓无 null 双表示残留 ----------
const nullHits = allSrc.match(/state\.currentHash\s*=\s*null|currentHash:\s*null/g) || []
ok('B1 全 web-src 无 currentHash 的 null 赋值/初值（双表示已清除）', nullHits.length === 0, `残留 ${nullHits.length} 处`)

// ---------- ③ 乐观项表示与 state 同源 ----------
ok('C1 addUser 写入 hash: state.currentHash（不独立造空值）',
  /pendingUserMsgs\.push\(\{\s*hash:\s*state\.currentHash/.test(messagesJs))
ok('C2 归属落定仍按 \'\' 归入会话（txTakeover 两入口）',
  (liveJs.match(/if \(p\.hash === ''\) p\.hash = hash/g) || []).length === 1 &&
  (routeJs.match(/if \(p\.hash === ''\) p\.hash = hash/g) || []).length === 1)

// ---------- ④ 生成物同步 ----------
ok('D1 app.js 含 currentHash 初值 \'\'', /currentHash:\s*''/.test(appJs))
ok("D2 app.js 无 currentHash 的 null 残留", !/state\.currentHash\s*=\s*null|currentHash:\s*null/.test(appJs))

// ---------- ⑤ 归属真值表（表达式字形从源码提取，防手抄漂移） ----------
const ROUTE_GUARD = "p.hash || (firstSendHash && p.hash === '')"                    // renderSession 保留判定
const ZONE_GUARD = "p.hash === cur || (p.hash === '' && firstSendHash === cur)"      // renderTransient 计入判定
ok('E1 renderSession 归属守卫字形在源码（非手抄）', routeJs.includes(ROUTE_GUARD), ROUTE_GUARD)
ok('E2 renderTransient 计入守卫字形在源码（非手抄）', approvalJs.includes(ZONE_GUARD), ZONE_GUARD)

const keep = new Function('p', 'firstSendHash', `return (${ROUTE_GUARD})`)
const inZone = new Function('p', 'cur', 'firstSendHash', `return (${ZONE_GUARD})`)

// renderSession：首页发送 → navigate 进会话（事务期，firstSendHash=本会话 hash）
// 注：`||`/`&&` 返回操作数本身而非布尔，故一律取真值（!!）比较
ok("F1 首页乐观项（hash=''）在事务期被保留（修复点）", !!keep({ hash: '' }, 'H1'))
ok("F2 事务已收口（firstSendHash=''）→ 空态残留项被丢弃（预期）", !keep({ hash: '' }, ''))
ok('F3 会话内乐观项（hash=H1）恒保留', !!keep({ hash: 'H1' }, 'H1'))
ok('F4 旧 bug 复现钉：hash=null 的同项会被丢弃（证明双表示必坏）', !keep({ hash: null }, 'H1'))
ok('F5 旧 bug 复现钉：hash=null 的项在首页瞬间也计不进暂态区', !inZone({ hash: null }, '', ''))

// renderTransient：首页发送瞬间（cur 与 firstSendHash 双空，state.currentHash 经修复后为 ''）
ok("G1 首页发送瞬间气泡可渲（cur='' / hash=''）", !!inZone({ hash: '' }, '', ''))
ok("G2 事务期（cur=H1 / firstSendHash=H1）气泡可渲（修复点）", !!inZone({ hash: '' }, 'H1', 'H1'))
ok('G3 切走会话（cur=H2 / 项属 H1）不再计入', !inZone({ hash: 'H1' }, 'H2', 'H2'))
ok('G4 会话内项（hash=H1 / cur=H1）计入', !!inZone({ hash: 'H1' }, 'H1', 'H1'))

console.log(`\n${pass}/${pass + fail}`)
if (fail > 0) process.exit(1)
