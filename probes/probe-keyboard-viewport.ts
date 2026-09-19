// probe-keyboard-viewport.ts —— 「键盘只压缩消息流底界与底栏」不变量探针（只读，2026-09-19）
// 背景：移动端（iPad/手机）底栏聚焦弹键盘时，浏览器把整个可视视口上顶 → 侧栏与空态 Floria
// 背景跟着被顶起。定案：应用锚定可视视口顶，键盘只影响「消息流底界 + 底栏」两处。
// 断言分两类：① 源码/产物结构（唯一真源接线、三个 CSS 变量消费点、版本同步）；
// ② 行为真值表——几何函数 kbGeometry 从 web-src 源码**提取**（非手抄），喂真实维度组合。
// 用法：bun run ./probe-keyboard-viewport.ts   （输出 pass/fail，末行 N/M）

const SRC = `${import.meta.dir}/../src/gateway/web-src`
const WEB = `${import.meta.dir}/../src/gateway/web`

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail = '') {
  if (cond) pass++
  else fail++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : '  ← ' + detail}`)
}

const viewportJs = await Bun.file(`${SRC}/core/viewport.js`).text()
const appSrc = await Bun.file(`${SRC}/app.js`).text()
const css = await Bun.file(`${WEB}/styles.css`).text()
const appJs = await Bun.file(`${WEB}/app.js`).text()
const swJs = await Bun.file(`${WEB}/sw.js`).text()
const indexHtml = await Bun.file(`${WEB}/index.html`).text()
const bundler = await Bun.file(`${import.meta.dir}/../scripts/bundle-web-modules.ts`).text()

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

// ---------- ① 拼接表接线（新模块必须进表，否则不被拼进产物） ----------
ok('A1 bundle-web-modules 表含 core/viewport.js', /file:\s*'core\/viewport\.js'/.test(bundler))
ok('A1 viewport 区间排在启动序列（5379）之前（顶层 let 先于 initViewport 调用）',
  (() => { const m = /file:\s*'core\/viewport\.js',\s*ranges:\s*\[\[(\d+)/.exec(bundler); return !!m && Number(m[1]) < 5379 })())

// ---------- ② 唯一真源与消费点 ----------
ok('A2 启动序列调 initViewport（紧随 initLive）', (() => {
  const i = appSrc.indexOf('initLive()')
  const j = appSrc.indexOf('initViewport()')
  return i >= 0 && j > i && j - i < 120
})())
ok('A3 syncKeyboard 消费 visualViewport', /window\.visualViewport/.test(body(viewportJs, 'function syncKeyboard()')))
ok('A3 键盘高只由布局视口与可视视口差得出', /root\.clientHeight,\s*vv\.height,\s*vv\.offsetTop,\s*vv\.scale/.test(viewportJs))
ok('A3 上顶量 pan 交 #app 反向锚回', /setProperty\('--vv-pan'/.test(viewportJs))
ok('A3 空态底栏抬升量独立计算（--kb-lift）', /setProperty\('--kb-lift'/.test(viewportJs))
ok('A3 键盘在场重算消息流占位几何（stageSync）', /stageSync\(\)/.test(viewportJs) && /import \{ stageSync \}/.test(viewportJs))

// ---------- ②b 相位：补偿必须与视觉变化同帧（rAF 转手必晚一帧 = 侧栏被顶起一瞬间） ----------
ok('A4 监听器直挂同步段（resize/scroll 同帧写补偿）',
  /vv\.addEventListener\('resize', syncKeyboard\)/.test(viewportJs) && /vv\.addEventListener\('scroll', syncKeyboard\)/.test(viewportJs))
ok('A4 无 rAF 转手的补偿路径（旧 scheduleKeyboard 应已删除）',
  !/scheduleKeyboard/.test(viewportJs) && !/requestAnimationFrame\(syncKeyboard/.test(viewportJs))
const syncBody = body(viewportJs, 'function syncKeyboard()')
// 读 visualViewport 的 offsetTop 是取值不是量算；只有读 DOM 元素的布局位才强制布局
const layoutReads = [...syncBody.matchAll(/([\w.$]+)\.offsetTop/g)].map((m) => m[1]).filter((s) => s !== 'vv')
ok('A4 同步段内不读元素布局（getBoundingClientRect/offset* 会强制布局，拖累上顶过程）',
  syncBody.length > 0 && !/getBoundingClientRect|offsetHeight|offsetWidth/.test(syncBody) && layoutReads.length === 0,
  layoutReads.join(','))
ok('A4 键盘高经变量交接延迟段（lastKb，不回读 CSS 变量）', /lastKb = kb/.test(syncBody) && /lastKb > 0/.test(body(viewportJs, 'function settle()')))
ok('A4 仅「量算 + 占位重算」走 rAF 合帧', /requestAnimationFrame\(settle\)/.test(viewportJs) && /stageSync\(\)/.test(body(viewportJs, 'function settle()')))
ok('A4 文档滚动归零也在同步段（与上顶同理须同帧）', /scrollTo\(0, 0\)/.test(syncBody))

// ---------- ③ CSS 消费点（三个变量缺一即「被顶起」或「抬头/漏出」） ----------
ok('B1 #app 以 --vv-pan 锚定可视视口顶', /#app \{[^}]*top:\s*var\(--vv-pan, 0px\)/.test(css))
ok('B1 消息流底界收 --kb（margin-bottom，缩小滚动视窗本身）', /#chat-scroll \{[^}]*margin-bottom:\s*var\(--kb, 0px\)/.test(css))
ok('B1 docked 底栏抬 --kb（底边距 22px 口径不变）', /#input-wrap\.docked \{[^}]*top:\s*calc\(100% - 22px - var\(--kb, 0px\)\)/.test(css))
ok('B1 空态底栏抬 --kb-lift（Floria 背景层零位移）', /#empty-hint #input-wrap \{[^}]*transform:\s*translate\(-50%, calc\(-50% - var\(--kb-lift, 0px\)\)\)/.test(css))
ok('B1 键盘在场底栏不做缓动（否则整程拖尾在键盘后）', /body\.kb-open #input-wrap \{\s*transition: none; \}/.test(css))
ok('B1 无残留的写死 docked top（旧 calc(100% - 22px) 应已并入 --kb 表达式）',
  !/top:\s*calc\(100% - 22px\);\s*\n\s*transform: translate\(-50%, -100%\)/.test(css))
ok('B1 #empty-hint 自身不含任何位移/收缩（背景层不参与）',
  !/#empty-hint \{[^}]*var\(--kb/.test(css))

// ---------- ③b 覆盖层（搜索层/风险门/重命名弹窗）：定位源须与 app 壳体同一 ----------
for (const [name, id] of [['搜索层', 'search-overlay'], ['风险门', 'risk-modal'], ['重命名弹窗', 'rename-modal']] as const) {
  const re = new RegExp(`#${id} \\{[^}]*position: absolute;[^}]*bottom: var\\(--kb, 0px\\)`)
  ok(`B2 ${name} #${id} 在 app 壳体内 absolute 且 bottom 收 --kb`, re.test(css))
  ok(`B2 ${name} 不再 position:fixed 挂 body（会与 app 视口锚定脱钩）`, !new RegExp(`#${id} \\{[^}]*position: fixed`).test(css))
}
const appOpen = indexHtml.indexOf('<div id="app">')
const appShellEnd = indexHtml.indexOf('<!-- 聊天气泡弹层')
ok('B2 三件覆盖层的 DOM 真在 #app 内（不靠 CSS 假装）',
  appOpen >= 0 && appShellEnd > appOpen &&
    ['search-overlay', 'risk-modal', 'rename-modal'].every((id) => {
      const k = indexHtml.indexOf(`id="${id}"`)
      return k > appOpen && k < appShellEnd
    }))
ok('B2 对话框高度上限用容器百分比（vh=布局视口，键盘在场会溢出可视区）',
  !/max-height: calc\(100vh - 48px\)/.test(css) && !/max-height: 74vh/.test(css))

// ---------- ④ 产物与版本同步 ----------
ok('C1 产物 app.js 含定义与调用点', ['function kbGeometry(', 'function syncKeyboard(', 'function settle(', 'function initViewport(', 'initViewport()'].every((s) => appJs.includes(s)))
ok('C1 产物 app.js 未引用模块 import 语法（拼接已剥壳）', !/^\s*import .*viewport\.js/m.test(appJs))
const swV = /const CACHE = 'floria-v(\d+)'/.exec(swJs)?.[1]
const appV = /\/app\.js\?v=(\d+)/.exec(indexHtml)?.[1]
ok('C2 sw CACHE 与 index.html app.js ?v= 同步', !!swV && swV === appV, `sw=v${swV} app=v${appV}`)
ok('C2 index.html 引用 styles.css 且带 cache-bust', /\/styles\.css\?v=\d+/.test(indexHtml))

// ---------- ⑤ 行为真值表：几何函数从 web-src 源码提取 ----------
const geoBody = body(viewportJs, 'function kbGeometry(')
ok('D1 kbGeometry 可从源码提取', geoBody.length > 0, 'viewport.js 函数签名被改写？')
if (geoBody) {
  const kbGeometry = new Function(`return ${geoBody}`)() as (L: number, vvH: number, vvTop: number, scale: number, editing: boolean) => { kb: number; pan: number }
  // [名称, L, vvH, vvTop, scale, editing, 期望 kb, 期望 pan]
  const T: [string, number, number, number, number, boolean, number, number][] = [
    ['桌面/未聚焦：全高可视视口 → 零位移', 834, 834, 0, 1, false, 0, 0],
    ['聚焦瞬间键盘未起：仍零位移', 834, 834, 0, 1, true, 0, 0],
    ['iPad 键盘 300 无上顶：抬 300', 834, 534, 0, 1, true, 300, 0],
    ['iPad 键盘 300 + 上顶 100：抬 300 且反向锚 100', 834, 534, 100, 1, true, 300, 100],
    ['安卓（布局视口同步缩）：不重复抬', 534, 534, 0, 1, true, 0, 0],
    ['捏合缩放（非编辑）：不抬', 834, 500, 0, 1, false, 0, 0],
    ['捏合缩放（编辑中，scale=2）：不误判为键盘', 834, 417, 120, 2, true, 0, 0],
    ['scale 轻微数值噪声（1.005）仍按键盘处理', 834, 534, 0, 1.005, true, 300, 0],
    ['异常：可视视口高于布局视口 → kb 不为负', 834, 900, 0, 1, true, 0, 0],
    ['异常：offsetTop 为负 → pan 不为负', 834, 534, -5, 1, true, 300, 0],
  ]
  let wrong = 0
  for (const [name, L, vvH, vvTop, scale, editing, kb, pan] of T) {
    const got = kbGeometry(L, vvH, vvTop, scale, editing)
    if (got.kb !== kb || got.pan !== pan) wrong++
    ok(`D2 ${name}`, got.kb === kb && got.pan === pan, `期望 kb=${kb} pan=${pan} 实得 kb=${got.kb} pan=${got.pan}`)
  }
  ok('D3 全部真值行一致', wrong === 0, `${wrong} 行不符`)
}

console.log(`\n${pass}/${fail}`)
process.exit(fail ? 1 : 0)
