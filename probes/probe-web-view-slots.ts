// probe-web-view-slots.ts —— 「切视图即清全局槽」不变量探针（只读，2026-09-19）
// 背景：同一根因三次复发（renderHome 08-29 / openProjectPreview 09-16 / renderMgr 09-19），
// 每次都是「就地补清单、漏了下一个入口」。本探针把不变量写成断言，覆盖全部离开会话视图的入口：
//   live.curUuid 非空 ⇔ 当前视图正展示该会话（六条 SSE 守卫以此为前提）
//   → 任何进入非会话视图（首页/管理视图/项目预览）的入口必须先 clearSessionSlots()。
// 断言分两类：① 源码结构（入口是否接线 / 清单是否单源）；② 行为真值表——守卫表达式从 live.js
// 源码**提取**（非手抄），喂 (live.curUuid, ev.session) 组合验证语义。
// 用法：bun run ./probe-web-view-slots.ts   （输出 pass/fail，末行 N/M）

const SRC = `${import.meta.dir}/../src/gateway/web-src`
const WEB = `${import.meta.dir}/../src/gateway/web`

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail = '') {
  if (cond) pass++
  else fail++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : '  ← ' + detail}`)
}

const routeJs = await Bun.file(`${SRC}/chat/route.js`).text()
const mgrJs = await Bun.file(`${SRC}/sidebar/mgr.js`).text()
const liveJs = await Bun.file(`${SRC}/core/live.js`).text()
const appJs = await Bun.file(`${WEB}/app.js`).text()
const swJs = await Bun.file(`${WEB}/sw.js`).text()
const indexHtml = await Bun.file(`${WEB}/index.html`).text()

// ---------- 函数体按大括号配对提取 ----------
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
function lineOf(file: string, needle: string): number {
  const i = file.indexOf(needle)
  return i < 0 ? -1 : file.slice(0, i).split('\n').length
}

// ---------- ① 清槽清单单源 ----------
const clearBody = body(routeJs, 'function clearSessionSlots()')
ok('A1 clearSessionSlots 定义于 route.js', clearBody.length > 0)
const SLOTS = ['live.lastMsgLen = null', 'live.localMessages = null', 'live.deltaSeq = null', 'live.queueRemote = []', 'live.curUuid = null', 'live.tasks = []', 'renderTaskDock()', "live.streamText = ''", 'clearTakeover()', 'renderCtxMeter(null)']
for (const s of SLOTS) ok(`A1 清槽清单含 ${s}`, clearBody.includes(s))

// ---------- ② 三个非会话视图入口全部接线 ----------
const homeBody = body(routeJs, 'function renderHome()')
ok('A2 renderHome 调 clearSessionSlots', homeBody.includes('clearSessionSlots()'))
const mgrBody = body(mgrJs, 'function renderMgr()')
ok('A3 renderMgr 调 clearSessionSlots', mgrBody.includes('clearSessionSlots()'))
ok(
  'A3 renderMgr 清槽早于 mgr-on（视图切换前先卸会话态）',
  lineOf(mgrBody, 'clearSessionSlots()') >= 0 && lineOf(mgrBody, 'clearSessionSlots()') < lineOf(mgrBody, "classList.add('mgr-on')"),
  '顺序错：清槽必须早于加 mgr-on',
)
const prevBody = body(mgrJs, 'function openProjectPreview(')
const hardBranch = prevBody.slice(prevBody.indexOf('if (!soft) {'))
ok('A4 openProjectPreview 硬挂载分支调 clearSessionSlots', hardBranch.slice(0, hardBranch.indexOf('state.preview = label')).includes('clearSessionSlots()'))

// ---------- ③ 无第二份内联清单（防再次分叉） ----------
for (const f of ['chat/route.js', 'sidebar/mgr.js', 'sidebar/neurons.js', 'core/live.js']) {
  const t = await Bun.file(`${SRC}/${f}`).text()
  const hits = [...t.matchAll(/live\.(curUuid|deltaSeq|localMessages) = null/g)].length
  const allowed = f === 'chat/route.js' ? 6 : 0 // route.js：clearSessionSlots 3 处 + renderSession 切会话 3 处
  ok(`A5 ${f} 内联清槽行数受控（${hits}/${allowed}）`, hits <= allowed, `发现多余内联清单（新增入口请走 clearSessionSlots）`)
}

// ---------- ④ 拼接产物包含共享出口与全部调用点 ----------
ok('A6 产物 app.js 含 clearSessionSlots 定义', appJs.includes('function clearSessionSlots()'))
ok(
  'A6 产物 app.js 调用点 ≥3（首页/管理视图/预览）',
  [...appJs.matchAll(/clearSessionSlots\(\)/g)].length >= 4, // 1 定义 + ≥3 调用
  `实际 ${[...appJs.matchAll(/clearSessionSlots\(\)/g)].length}`,
)

// ---------- ⑤ 行为真值表：守卫表达式从 live.js 源码提取 ----------
const guardLine = liveJs.split('\n').map((l) => l.trim()).find((l) => /^if \(ev\.session !== live\.curUuid\) return$/.test(l))
ok('B1 session-delta 守卫表达式可提取', !!guardLine, 'live.js 守卫行已被改写？')
if (guardLine) {
  // ignored(ev, live) = true ⇔ 该 delta 被守卫丢弃（守卫体首句即 `return`，即「忽略本事件」）
  const ignored = new Function('ev', 'live', `${guardLine.replace('return', 'return true;')} return false;`) as (ev: { session: string }, live: { curUuid: string | null }) => boolean
  const T: [string, string | null, string, boolean][] = [
    ['会话视图中：同会话 delta → 应用', 'A', 'A', false],
    ['会话视图中：他会话 delta → 丢弃', 'A', 'B', true],
    ['管理视图已清槽：该会话残留 delta → 丢弃', null, 'A', true],
    ['管理视图已清槽：任意 delta → 丢弃', null, 'B', true],
  ]
  for (const [name, curUuid, sess, expectIgnored] of T) {
    const got = ignored({ session: sess }, { curUuid })
    ok(`B2 ${name}`, got === expectIgnored, `期望 ignored=${expectIgnored} 实得 ${got}`)
  }
}

// ---------- ⑥ 前端资产版本自愈链一致 ----------
const swV = /const CACHE = 'floria-v(\d+)'/.exec(swJs)?.[1]
const appV = /\/app\.js\?v=(\d+)/.exec(indexHtml)?.[1]
ok('C1 sw CACHE 与 index.html app.js ?v= 同步', !!swV && swV === appV, `sw=v${swV} app=v${appV}`)

console.log(`\n${pass}/${fail}`)
process.exit(fail ? 1 : 0)
