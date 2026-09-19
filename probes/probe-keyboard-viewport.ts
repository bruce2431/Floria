// probe-keyboard-viewport.ts —— 「整页平移 + 底栏恒贴键盘上沿」不变量探针（只读，2026-09-19）
// 背景：移动端（iPad/手机）底栏聚焦弹键盘时，浏览器把整个可视视口上顶。定案（五轮）：应用是一块
// 刚性板，整体上移一个键盘高——我们只写自己那份 kb = L − pan − vv.height，浏览器那份 pan 由它
// 自己叠加，两者之和恒等于屏幕上的完整键盘高 total = L − vv.height（与浏览器怎么分配无关 ⇒ pan
// 瞬时抖动被吸收，画面不动）。**不抵消 pan**（四轮教训：主线程写样式抵消合成器位移必晚一帧 ⇒
// 「先向上→立即下拉→恢复」）。app 内可视窗 = [total, L]：消息流窗口 margin-top、三个覆盖层 top
// 同取 --kb-total；底栏钉在 app 底边 22px、空态底栏随台面比例走——都不再各自补位移。
// 断言分两类：① 源码/产物结构（唯一真源接线、三个 CSS 变量消费点、版本同步）；
// ② 行为真值表——几何函数 kbGeometry / popRoom 从 web-src 源码**提取**（非手抄），喂真实维度组合。
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
// pan 不再抵消（2026-09-19 四轮）：--vv-pan 整个退役，应用随浏览器上顶一起走。
ok('A3 上顶量 pan 不再反向抵消（--vv-pan 写入已删除）', !/setProperty\('--vv-pan'/.test(viewportJs))
ok('A3 kb 扣掉浏览器上顶已吃掉的部分（L − pan − vvH）',
  /const kb = Math\.max\(0, L - pan - vvH\)/.test(viewportJs) && /const pan = Math\.max\(0, vvTop\)/.test(viewportJs))
// 整页平移（五轮）：我们那份 kb + 浏览器那份 pan = 屏幕上的完整键盘高，谁分摊多少都不影响画面。
ok('A3 完整键盘高 = kb + pan（与浏览器怎么分配位移无关）', /return \{ kb, total: kb \+ pan \}/.test(viewportJs))
ok('A3 --kb-total 与 --kb 同帧写入（app 内可视窗顶偏移）',
  /setProperty\('--kb-total', total \+ 'px'\)/.test(body(viewportJs, 'function syncKeyboard()')))
ok('A3 不再有「浏览器位移归零」迎战代码（scrollTo 已删——位移由 total 恒等式吸收）',
  !/scrollTo\(/.test(viewportJs))
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
ok('A4 键盘高经变量交接延迟段（lastTotal，不回读 CSS 变量）',
  /lastTotal = total/.test(syncBody) && /popRoom\(barTop, lastTotal, BAR_ROOM_MARGIN\)/.test(body(viewportJs, 'function settle()')))
ok('A4 仅「量算 + 占位重算」走 rAF 合帧', /requestAnimationFrame\(settle\)/.test(viewportJs) && /stageSync\(\)/.test(body(viewportJs, 'function settle()')))
// 弹层余量的两个输入都是「位移无关量」：barTop 由 app 与底栏两个 rect 相减（位移在差里抵消），
// lift = total 是纯数字交接——不再有「rect 含位移却拿去跟 vv.offsetTop 比」的口径赌注。
ok('A4 弹层余量输入位移无关（rect 相减得 app 内布局 y）',
  /wrap\.getBoundingClientRect\(\)\.top - app\.getBoundingClientRect\(\)\.top/.test(body(viewportJs, 'function settle()')))

// ---------- ③ CSS 消费点（三个变量缺一即「被顶起」或「抬头/漏出」） ----------
ok('B1 整页平移本体：键盘在场 #app 收 --kb 整体位移',
  /body\.kb-open #app \{\s*transform: translateY\(calc\(-1 \* var\(--kb, 0px\)\)\); \}/.test(css))
// transform 非 none 会让 #app 成为 fixed 后代的包含块（#img-lightbox/#drop-overlay/.toast 的
// inset 基准随之改）⇒ 规则必须挂在 kb-open 下，无键盘时 #app 无位移、基准不变。
ok('B1 #app 本体无 transform（位移只在键盘在场时落，无键盘时不改 fixed 后代基准）',
  !/^#app \{[^}]*transform:/m.test(css))
ok('B1 消息流窗口顶偏移收 --kb-total（窗口 = [kb-total, L] = 可视窗）',
  /#chat-scroll \{[^}]*margin-top:\s*var\(--kb-total, 0px\)/.test(css))
ok('B1 消息流不再收 --kb（整页平移下再收一次即双重让位）',
  !/#chat-scroll \{[^}]*margin-bottom:\s*var\(--kb/.test(css))
ok('B1 docked 底栏钉 app 底边 22px（不再自补 --kb：平移已把底边送到键盘上沿）',
  /#input-wrap\.docked \{[^}]*top:\s*calc\(100% - 22px\);[^}]*transform: translate\(-50%, -100%\)/.test(css) &&
    !/#input-wrap\.docked \{[^}]*var\(--kb/.test(css))
ok('B1 空态底栏随台面比例走（--kb-lift 退役，不再单独抬）',
  /#empty-hint #input-wrap \{[^}]*transform:\s*translate\(-50%, -50%\)/.test(css) &&
    !/--kb-lift/.test(css) && !/--kb-lift/.test(viewportJs))
ok('B1 键盘在场底栏不做缓动（否则整程拖尾在键盘后）', /body\.kb-open #input-wrap \{\s*transition: none; \}/.test(css))
ok('B1 #empty-hint 自身不含任何位移/收缩（背景层不参与）',
  !/#empty-hint \{[^}]*var\(--kb/.test(css))

// ---------- ③b 覆盖层（搜索层/风险门/重命名弹窗）：定位源须与 app 壳体同一 ----------
for (const [name, id] of [['搜索层', 'search-overlay'], ['风险门', 'risk-modal'], ['重命名弹窗', 'rename-modal']] as const) {
  const re = new RegExp(`#${id} \\{[^}]*position: absolute;[^}]*top: var\\(--kb-total, 0px\\); right: 0; bottom: 0; left: 0;`)
  ok(`B2 ${name} #${id} 在 app 壳体内 absolute 且遮罩 = 可视窗（top 收 --kb-total、bottom 0）`, re.test(css))
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
// 百分比解析到**内容盒**：容器的 padding:24px 已表达上下呼吸，对话框再减一次 48 等于扣两遍
// ⇒ 上限比实际可用矮 48px，键盘在场（可视区仅 ~272 CSS）时 footer 按钮被 overflow:hidden 裁掉。
// 不变量：对话框上限 == 容器内容盒（呼吸只在容器 padding 一处表达）。
for (const id of ['rename-modal', 'risk-modal'] as const) {
  const block = new RegExp(`#${id} \\.dialog \\{[^}]*\\}`).exec(css)?.[0] ?? ''
  ok(`B2 对话框 #${id} 上限 = 容器内容盒（不得再 calc(100% - 48px) 双扣 padding）`,
    /max-height: 100%/.test(block) && !/max-height: calc\(100% - 48px\)/.test(block))
}

// ---------- ③c 底栏子件（向上弹出的六个弹层，七处上限声明）：上限一律收 --bar-room ----------
// 底栏上沿到屏顶的余量（实测）——子件弹层高于它就会伸到可视区外（够不着）。
// 实测式：barRoom 由 popRoom(底栏上沿在 app 内的布局 y, 整体上移量, 呼吸常量) 得出后写 --bar-room。
ok('B3 余量由「底栏上沿(rect 相减得 app 内布局 y) − 整体上移量」实测',
  /popRoom\(barTop, lastTotal, BAR_ROOM_MARGIN\)/.test(viewportJs) &&
    /barTop = wrap\.getBoundingClientRect\(\)\.top - app\.getBoundingClientRect\(\)\.top/.test(viewportJs) &&
    /setProperty\('--bar-room', barRoom \+ 'px'\)/.test(viewportJs))
ok('B3 底栏自身几何变化（多行长高/接管卡换高/空态↔会话态迁移）也触发重量',
  /new ResizeObserver\(scheduleSettle\)\.observe\(wrap\)/.test(viewportJs))
// 位移类变化（键盘收起 --kb 归零 / 空态↔会话态迁移：top/transform 走 0.55s 过渡）改的是位置不是尺寸，
// ResizeObserver 观察不到；只在过渡结束重量，才拿得到「底栏到位后」的 rect（否则量到动画中间值被钉死）。
ok('B3 底栏位移类变化（过渡驱动）在过渡结束时重量 —— 否则 --bar-room 量到动画中间值被永久卡小',
  /wrap\.addEventListener\('transitionend', \(e\) => \{ if \(e\.target === wrap\) scheduleSettle\(\) \}\)/.test(viewportJs))
const BAR_POPS: [string, RegExp][] = [
  ['@ 提及浮窗 #mention-pop', /#mention-pop \{[^}]*max-height: min\(300px, var\(--bar-room, 300px\)\)/],
  ['命令菜单 #cmd-pop', /#cmd-pop \{[^}]*max-height: min\(380px, var\(--bar-room, 380px\)\)/],
  ['命令菜单/模型弹层（手机档）', /#cmd-pop, #model-pop \{ max-height: min\(300px, var\(--bar-room, 300px\)\); \}/],
  ['任务浮窗 #task-dock .td-panel', /#task-dock \.td-panel \{[^}]*max-height: min\(40vh, 460px, var\(--bar-room, 460px\)\)/],
  ['项目选择弹层 #proj-pop', /#proj-pop \{[^}]*max-height: min\(320px, var\(--bar-room, 320px\)\)/],
  ['模型·推理弹层 #model-pop', /#model-pop \{[^}]*max-height: min\(360px, var\(--bar-room, 360px\)\)/],
  ['上下文面板 #ctx-panel', /#ctx-panel \{[^}]*max-height: min\(240px, var\(--bar-room, 240px\)\)/],
]
for (const [name, re] of BAR_POPS) ok(`B3 ${name} 上限收 --bar-room`, re.test(css), '回归裸定值/vh 上限即越出可视区')
ok('B3 唯一真源导出 popRoom（探针直测，消费者不各自复刻公式）',
  /export \{ initViewport, kbGeometry, popRoom \}/.test(viewportJs))
ok('B3 底栏弹层不再有布局视口口径的 vh 上限残留（键盘在场不缩）',
  !/min\(360px, calc\(100vh - 96px\)\)/.test(css))

// ---------- ④ 产物与版本同步 ----------
ok('C1 产物 app.js 含定义与调用点', ['function kbGeometry(', 'function syncKeyboard(', 'function settle(', 'function initViewport(', 'initViewport()'].every((s) => appJs.includes(s)))
ok('C1 产物 app.js 未引用模块 import 语法（拼接已剥壳）', !/^\s*import .*viewport\.js/m.test(appJs))
ok('C1 产物 app.js 含「焦点在子框架内」判定（预览 iframe 内输入，构建须同步）', /tagName === 'IFRAME'/.test(appJs))
const swV = /const CACHE = 'floria-v(\d+)'/.exec(swJs)?.[1]
const appV = /\/app\.js\?v=(\d+)/.exec(indexHtml)?.[1]
ok('C2 sw CACHE 与 index.html app.js ?v= 同步', !!swV && swV === appV, `sw=v${swV} app=v${appV}`)
ok('C2 index.html 引用 styles.css 且带 cache-bust', /\/styles\.css\?v=\d+/.test(indexHtml))

// ---------- ⑤ 行为真值表：几何函数从 web-src 源码提取 ----------
const geoBody = body(viewportJs, 'function kbGeometry(')
ok('D1 kbGeometry 可从源码提取', geoBody.length > 0, 'viewport.js 函数签名被改写？')
if (geoBody) {
  const kbGeometry = new Function(`return ${geoBody}`)() as (L: number, vvH: number, vvTop: number, scale: number, editing: boolean) => { kb: number; total: number }
  // [名称, L, vvH, vvTop, scale, editing, 期望 kb, 期望 total]
  // kb = 浏览器上顶之后**仍需我们自行补**的位移；total = 屏幕上的完整键盘高 = kb + pan = L − vvH
  const T: [string, number, number, number, number, boolean, number, number][] = [
    ['桌面/未聚焦：全高可视视口 → 零位移', 834, 834, 0, 1, false, 0, 0],
    ['聚焦瞬间键盘未起：仍零位移', 834, 834, 0, 1, true, 0, 0],
    ['iPad 键盘 300 无上顶：全由我们补 300', 834, 534, 0, 1, true, 300, 300],
    ['iPad 键盘 300 + 浏览器上顶 100：我们补 200，合计仍需 300', 834, 534, 100, 1, true, 200, 300],
    ['上顶已吃掉全部空缺（pan=键盘高）：我们补 0，合计仍 562', 834, 272, 562, 1, true, 0, 562],
    ['上顶超过键盘高 → kb 不为负（total 仍为 app 被推出去的条带高）', 834, 272, 700, 1, true, 0, 700],
    ['安卓（布局视口同步缩）：不重复补', 534, 534, 0, 1, true, 0, 0],
    ['捏合缩放（非编辑）：不补', 834, 500, 0, 1, false, 0, 0],
    ['捏合缩放（编辑中，scale=2）：不误判为键盘', 834, 417, 120, 2, true, 0, 0],
    ['scale 轻微数值噪声（1.005）仍按键盘处理', 834, 534, 0, 1.005, true, 300, 300],
    ['异常：可视视口高于布局视口 → kb 不为负', 834, 900, 0, 1, true, 0, 0],
    ['异常：offsetTop 为负 → 上顶量夹到 0', 834, 534, -5, 1, true, 300, 300],
  ]
  let wrong = 0
  for (const [name, L, vvH, vvTop, scale, editing, kb, total] of T) {
    const got = kbGeometry(L, vvH, vvTop, scale, editing)
    if (got.kb !== kb || got.total !== total) wrong++
    ok(`D2 ${name}`, got.kb === kb && got.total === total, `期望 kb=${kb}/total=${total} 实得 kb=${got.kb}/total=${got.total}`)
  }
  ok('D3 全部真值行一致', wrong === 0, `${wrong} 行不符`)
}

// ---------- ⑤b 行为真值表：弹层余量函数（同样从源码提取） ----------
const prBody = body(viewportJs, 'function popRoom(')
ok('D4 popRoom 可从源码提取', prBody.length > 0, 'viewport.js 函数签名被改写？')
if (prBody) {
  const popRoom = new Function(`return ${prBody}`)() as (barTop: number, lift: number, margin: number) => number
  // [名称, 底栏上沿在 app 内的布局 y, 整体上移量, 呼吸常量, 期望余量]
  const T2: [string, number, number, number, number][] = [
    ['无键盘：底栏上沿 700、上移 0、呼吸 20 → 680', 700, 0, 20, 680],
    ['iPad 键盘 300：底栏上沿在 app 内 480、上移 300 → 160', 480, 300, 20, 160],
    ['上移量已吃掉全部余量：钳到 0（不产生负 max-height）', 100, 100, 20, 0],
    ['底栏落在屏顶之上：钳到 0', 80, 100, 20, 0],
    ['子像素取整', 480.6, 100, 20, 361],
  ]
  let wrong2 = 0
  for (const [name, barTop, lift, margin, want] of T2) {
    const got = popRoom(barTop, lift, margin)
    if (got !== want) wrong2++
    ok(`D5 ${name}`, got === want, `期望 ${want} 实得 ${got}`)
  }
  ok('D5 弹层余量真值行全部一致', wrong2 === 0, `${wrong2} 行不符`)
}

// ---------- ⑤c 行为真值表：编辑中判定（项目预览 iframe 内输入必须算「编辑中」） ----------
// 焦点进 iframe 文档时父文档 activeElement 就是该 <iframe> 元素本身——不认它则预览内打字恒
// editing=false，kbGeometry 直接返回 {0,0}，键盘上顶无人锚回 → 每次输入整页上下跳（2026-09-19）。
const ieBody = body(viewportJs, 'function isEditing()')
ok('D6 isEditing 可从源码提取', ieBody.length > 0, 'viewport.js 函数签名被改写？')
if (ieBody) {
  // document 由形参注入（打桩），不触碰全局；函数体原文求值，非手抄
  const withDoc = new Function('document', `return (${ieBody})`) as (d: { activeElement: unknown }) => () => boolean
  const run = (active: unknown) => withDoc({ activeElement: active })()
  const T3: [string, unknown, boolean][] = [
    ['焦点在预览 iframe 内输入（父文档 activeElement=IFRAME）→ 编辑中', { tagName: 'IFRAME' }, true],
    ['INPUT 聚焦 → 编辑中', { tagName: 'INPUT' }, true],
    ['TEXTAREA 聚焦 → 编辑中', { tagName: 'TEXTAREA' }, true],
    ['contentEditable 元素聚焦 → 编辑中', { tagName: 'DIV', isContentEditable: true }, true],
    ['按钮等非文本聚焦 → 非编辑中（不触发位移）', { tagName: 'BUTTON' }, false],
    ['无焦点（activeElement=null）→ 非编辑中', null, false],
  ]
  let wrong3 = 0
  for (const [name, active, want] of T3) {
    const got = run(active)
    if (got !== want) wrong3++
    ok(`D7 ${name}`, got === want, `期望 ${want} 实得 ${got}`)
  }
  ok('D7 编辑中判定真值行全部一致', wrong3 === 0, `${wrong3} 行不符`)
}

console.log(`\n${pass}/${fail}`)
process.exit(fail ? 1 : 0)
