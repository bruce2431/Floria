// web 前端模块拼接器：src/gateway/web-src/（ESM 模块源码，唯一手改处）→ src/gateway/web/app.js（单 IIFE 产物）。
// 不用 Bun.build：打包器按依赖图重排模块执行序，而本代码顶层执行代码（事件绑定/DOM 初始化）依赖原 IIFE
// 物理行序（重排 → TDZ 崩溃，2026-09-10 首跑实证）；且原 IIFE 顶部的 `const $`（区间外声明）会被切割丢失。
// 本拼接器按 MODULES 表的原区间行序把各模块区间拼回单 IIFE——行序=原执行序，语义保真；
// 产物与切割前原版的 diff 应仅含：setter 函数行 + MANUAL 改写行（等价性可 diff 验证）。
// web/app.js 是生成物勿手改；产物文件名/引用不变（?v= cache-bust、sw CORE、gen-web-assets 全链零改动）。

const WEB_SRC = './src/gateway/web-src'
const OUT = './src/gateway/web/app.js'

// 模块 → 原 IIFE 行区间（切割基线 app.js v287，5399 行）。first = 各区间首行（防呆：切片错位即报错）。
const MODULES: { file: string; ranges: [number, number][]; first: string[] }[] = [
  { file: 'core/icons.js', ranges: [[13, 44]], first: ['  // ---------- SVG 图标 ----------'] },
  { file: 'sidebar/mgr-data.js', ranges: [[45, 111]], first: ['  // ---------- 管理视图数据源（2026-08-15 起接后端 /gateway/plugins：真实已安装插件/技能 + 官方市场） ----------'] },
  { file: 'core/state.js', ranges: [[112, 159], [274, 286]], first: ['  // ---------- 元素 ----------', '  function toast(msg) {'] },
  { file: 'core/char.js', ranges: [[160, 176]], first: ['  // ---------- 角色形象（2026-08-14 实验） ----------'] },
  { file: 'core/markdown.js', ranges: [[177, 273]], first: ['  // ---------- Markdown 渲染（安全：mdHtml 入口先整体转义，再生成白名单 HTML） ----------'] },
  { file: 'core/sessions.js', ranges: [[287, 347]], first: ['  // ---------- 会话映射 ----------'] },
  { file: 'core/live.js', ranges: [[348, 898]], first: [''] },
  { file: 'chat/route.js', ranges: [[899, 1205]], first: ['  // ---------- 路由 ----------'] },
  { file: 'chat/messages.js', ranges: [[1206, 1947], [4349, 4418]], first: ['  // ---------- 消息渲染 ----------', '  let pendingUserMsgs = []'] },
  { file: 'sidebar/recent.js', ranges: [[1948, 2438]], first: ['  // ---------- 侧栏 ----------'] },
  { file: 'sidebar/mgr.js', ranges: [[2439, 2893]], first: ['  function renderMgr() {'] },
  { file: 'sidebar/bubble-search.js', ranges: [[2894, 2932]], first: ['  // ---------- 气泡弹层 ----------'] },
  { file: '__app__', ranges: [[2933, 3011], [5379, 5398]], first: ['  // ---------- 事件绑定 ----------', '  // ---------- 启动 ----------'] },
  { file: 'inputbar/ctx-meter.js', ranges: [[3012, 3303]], first: ['  // ---------- 上下文占用指示（2026-08-23 dsh ContextMeter 移植）----------'] },
  { file: 'core/gateway.js', ranges: [[3304, 3420], [4154, 4161], [4969, 5047], [5352, 5378]], first: ['  // ---------- 网关模式（SubPj2 私有化网关）----------', '  function setConn(on, label) {', '  function connect() {', '  function initGateway() {'] },
  { file: 'inputbar/mention.js', ranges: [[3421, 3644]], first: ['  // ---------- @ 提及（2026-08-15）：输入 @ 弹出「插件/技能 + 近48h 会话」浮窗，选中插入内联 chip ----------'] },
  { file: 'inputbar/commands.js', ranges: [[3645, 3674], [3718, 3974]], first: ['  // ---------- 命令菜单 + 模型选择（2026-08-21 dsh 输入栏逻辑移植）----------', '  const cmd = { open: false, status: \'pending\', items: [], search: \'\', active: 0, submitting: false, confirming: null, acknowledged: false, error: null }'] },
  { file: 'inputbar/model-select.js', ranges: [[3675, 3717], [3975, 4153]], first: ['  function modelDir() {', '  function currentChoice() {'] },
  { file: 'chat/stage.js', ranges: [[4162, 4348]], first: ['  function scrollBottom() {'] },
  { file: 'inputbar/approval.js', ranges: [[4419, 4964]], first: ['  function renderTransient() {'] },
  { file: 'core/auth.js', ranges: [[4965, 4968], [5048, 5053], [5054, 5194]], first: ['  function deviceHint() {', '  let finishGateTimer = null // 阶段3 停留后 hideGate 的定时器', '  // ---------- 设备认证配对（2026-08-28，浏览器侧完全删除 token 授权链） ----------'] },
  { file: 'inputbar/images.js', ranges: [[5195, 5258]], first: ['  // ---------- 图片附件（2026-08-28）：走 CLI 粘贴同链路；2026-09-09 上传入口=+ 浮窗「上传」组常驻行，'] },
  { file: 'inputbar/send.js', ranges: [[5259, 5351]], first: ['  async function gwSend() {'] },
]

// ---------- 读取模块文件并剥离切割壳（头注释/import/setter 注释/export 块） ----------
async function loadModuleBodies(): Promise<Map<string, string[]>> {
  const bodies = new Map<string, string[]>()
  for (const m of MODULES) {
    const path = m.file === '__app__' ? `${WEB_SRC}/app.js` : `${WEB_SRC}/${m.file}`
    const lines = (await Bun.file(path).text()).split('\n')
    if (lines.length && lines[lines.length - 1] === '') lines.pop()

    // 剥切割壳（emit 结构=cut-web-modules.ts 304-314 取证）：/*块*/（仅入口件）→ 0 缩进 // 标题 →
    // （有 import 才有的）1 空行 → import 行 →（仅入口件）import 后多 1 空行。
    // 盲目跳空行会吞区间内容（live.js 区间首行就是空行），首行防呆兜底校验错位。
    let i = 0
    if (lines[i]?.startsWith('/*')) { while (i < lines.length && !lines[i].includes('*/')) i++; i++ }
    while (i < lines.length && /^\/\//.test(lines[i])) i++
    if (lines[i]?.trim() === '' && /^import /.test(lines[i + 1] ?? '')) i++
    while (i < lines.length && /^import /.test(lines[i])) i++
    if (m.file === '__app__' && lines[i]?.trim() === '') i++
    if (i === lines.length) throw new Error(`${m.file}: 区间内容为空`)

    // 尾界=切割壳 marker（setterBlock 注释行 / export { 行）首现处，body=头尾之间全量。
    // 弃 v287 定长行数——手改增删行会截短尾区间（live.js SSE 手改 +14 行实证丢码）；区间尾空行
    // （原版 44/286/3011 实测空行）物理上就是 marker 前的空行，随 body 一并保留。手改不破坏定位。
    let end = lines.length
    for (let j = i; j < lines.length; j++) {
      if (/^\/\/ —— 跨模块写入口/.test(lines[j]) || /^export \{/.test(lines[j])) { end = j; break }
    }
    const body = lines.slice(i, end)
    const setters: string[] = []
    for (const ln of lines.slice(end)) {
      if (/^export function set\w+\(/.test(ln)) setters.push(ln.replace(/^export /, ''))
    }
    bodies.set(m.file, body)
    bodies.set(m.file + '::setters', setters)
  }
  return bodies
}

// ---------- 锚点检索切片 + 首行防呆校验 ----------
// 区间起点=锚点行（区间首行）在 body 内检索定位，非定长行数——手改增删行不破坏拼接。
// 锚点唯一性依据=区间首行恒为节标题注释/独特函数签名（首行防呆兜底）；锚点前必恰有 1 分隔空行
//（cut join 结构）作第二重校验。单区间模块 i=0 直接从 body[0] 起（首行防呆校验）。
function sliceRanges(m: { file: string; ranges: [number, number][]; first: string[] }, body: string[]) {
  const starts: number[] = []
  for (let i = 0; i < m.ranges.length; i++) {
    const [a, b] = m.ranges[i]
    if (i === 0) {
      if (body[0] !== m.first[0]) {
        throw new Error(`${m.file} 区间[${a},${b}] 首行失配：\n  实际: ${body[0]}\n  预期: ${m.first[0]}`)
      }
      starts.push(0)
    } else {
      const k = body.indexOf(m.first[i], starts[i - 1] + 1)
      if (k < 0) throw new Error(`${m.file} 区间[${a},${b}] 锚点未找到：${m.first[i]}\n（模块文件手改动过区间首行？）`)
      if (body[k - 1]?.trim() !== '') {
        throw new Error(`${m.file} 区间[${a},${b}] 锚点前缺分隔空行（锚点行失唯一，检索命中错误位置？）`)
      }
      starts.push(k)
    }
  }
  // 区间 i = [starts[i] .. 下一锚点前 2 行)（回吐 1 个分隔空行），末区间至 body 尾（marker 前全量）
  const out: { start: number; lines: string[] }[] = []
  for (let i = 0; i < m.ranges.length; i++) {
    const endLine = i < m.ranges.length - 1 ? starts[i + 1] - 1 : body.length
    out.push({ start: m.ranges[i][0], lines: body.slice(starts[i], endLine) })
  }
  return out
}

// ---------- 主流程 ----------
const bodies = await loadModuleBodies()
const pieces: { start: number; lines: string[] }[] = []
for (const m of MODULES) {
  const ps = sliceRanges(m, bodies.get(m.file)!)
  // setter 跟随定义模块的最后区间之后（切割时 setterBlock 位置=模块尾）
  ps[ps.length - 1].lines.push(...(bodies.get(m.file + '::setters') ?? []))
  pieces.push(...ps)
}
pieces.sort((x, y) => x.start - y.start)

// 骨架：原版头注释（1-7 行）+ IIFE 开 + use strict + 顶部 `const $`（原 11 行，切割区间外，必须注回）
const appLines = (await Bun.file(`${WEB_SRC}/app.js`).text()).split('\n')
const head = appLines.slice(0, 7)
if (!head[0].startsWith('/* floria')) throw new Error('web-src/app.js 头注释被改动？前 7 行应为原版权头')

const out: string[] = [...head, '(() => {', "  'use strict'", '', '  const $ = (id) => document.getElementById(id)', '']
for (const p of pieces) out.push(...p.lines)
out.push('})()')

await Bun.write(OUT, out.join('\n') + '\n')
console.log(`[bundle-web] ${pieces.length} 个区间拼回 → ${OUT}（${out.length + 1} 行）`)
