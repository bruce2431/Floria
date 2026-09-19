/**
 * 2026-09-11 状态显示行 · 行首槽对齐 探针（跑真实源码，非复刻）
 *
 * 用户实测：「正在调用和正在思考定位不同…同行不同时刻，导致跳动」。
 * 根因：同一宿主行在两类状态间切换时**行首结构不同** —— 工具行 = `.t-ico`(16px 槽) + gap 5px + 文字
 * （文字左缘 21px），状态行 = 纯文本（文字左缘 0px）→ 每轮「正在运行：<工具>」⇄「正在思考/生成/压缩」
 * 切换，整行文字横移 21px。
 * 修（用户定案「状态行补同款图标槽（带图标）」，图标 = DSH IconThinkOutline14 原子图标）：
 *   ① messages.js 状态行构造补 `<span class="t-ico">` + 文本另置 `<span class="ts-text">`；
 *   ② live.js tick 只写 `.ts-text`（整节点 textContent 会连槽一起洗掉 → 跳动复发）；
 *   ③ styles.css `.t-ico` 提为通用类 + `.think-state` gap 6→5px 与工具行同基准。
 *
 * 断言：
 *   A 结构同构 —— 状态行 HTML 含 .t-ico 槽 + .ts-text；工具行含 .t-ico（两者同构）
 *   B 行首几何单一来源 —— .t-ico 宽 16px / svg 14px / .tool-line gap 5px / .think-state gap 5px
 *   C tick 不洗槽 —— live.js 的 tick 写 .ts-text（源码级防回归；旧式 `stEl.textContent=` 为反例）
 *   D 时序稳定 —— think/generating/compact 三态 HTML 的行首结构恒同（左缘与 mode 无关）
 *   E 并发复合态 —— 工具在飞 + 状态为**同行原子尾缀**（2026-09-11 11:12 改判：旧「两段各带 .t-ico
 *      并存」被用户判否「这个简单堆叠肯定是不对的」，且窄窗+长命令下状态被挤成竖列撑高空灰块）
 *   F 无响应红标 —— 工具在飞 = 已知阻塞原因，与审批豁免同源（源码级；用户实测「正在运行时怎么
 *      会无响应呢」）
 *   G 折叠开合键 —— open 恢复改用结构稳定键，全局索引退役（源码级；索引错位会把旧 done-fold 的
 *      open 灌给新 tool-fold。注 2026-09-11 11:12 更正：用户所报「运行命令块异常大」并非本条所治，
 *      真因是并发复合态行内挤压，见 probe-concurrent-status.ts B/C 组）
 *
 * 用法：
 *   bun probe-state-lead.ts            正常跑（修复后）
 *   bun probe-state-lead.ts --prefix   还原旧构造（状态行无槽）→ A1/A4 必败（27 过 / 2 败），复现移植前缺陷
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const GW = fileURLToPath(new URL('../src/gateway/', import.meta.url))
let rawMessages = readFileSync(GW + 'web-src/chat/messages.js', 'utf8')
const styles = readFileSync(GW + 'web/styles.css', 'utf8')
const liveSrc = readFileSync(GW + 'web-src/core/live.js', 'utf8')

const NEW_STATE = '${withIcon ? `<span class="t-ico">${THINK_ICON}</span>` : \'\'}'
const OLD_STATE = "${''}"
if (process.argv.includes('--prefix')) {
  if (!rawMessages.includes(NEW_STATE)) throw new Error('--prefix 还原失败：状态行构造形态已变，探针需同步')
  rawMessages = rawMessages.replace(NEW_STATE, OLD_STATE)
}

const stripped = rawMessages
  .split('\n')
  .filter((l) => !/^\s*import\s/.test(l))
  .join('\n')
  .replace(/\bexport\s+(?=(?:function|const|let|var)\b)/g, '')
  .replace(/^export\s*\{[\s\S]*?\}\s*$/m, '')

const stub = `
  const scrollBottom = () => {}
  const stage = { set() {}, clear() {} }
  const stageStart = () => 0
  const toolToChar = () => null
  const I = new Proxy({}, { get: () => '' })
  const refreshSession = async () => {}
  const applySegDelta = () => {}
  const bindLiveFoldTimer = () => {}
  const mdHtml = (s) => String(s ?? '')
  const findSession = () => null
  const sessionCwd = () => ''
  const messagesEl = { appendChild() {}, insertBefore() {}, querySelector: () => null, children: [] }
  const state = { sessions: [], currentHash: '' }
  const live = { curUuid: '', curSeg: null, curSig: '', timer: null }
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  const toast = () => {}
  const renderTransient = () => {}
  const claimStartTs = () => 0
  const takeover = () => {}
  const clearTakeover = () => {}
  let firstSendHash = null
  const $ = () => ({ addEventListener() {}, querySelector: () => ({ addEventListener() {} }), classList: { add() {}, remove() {}, toggle() {} }, style: {}, dataset: {} })
  const document = { getElementById: () => null, addEventListener() {}, createElement: () => ({ style: {}, classList: { add() {} }, appendChild() {} }) }
`

const mod = new Function(`${stub}\n${stripped}\n;return { liveFoldBody, THINK_ICON }`)() as any
const liveFoldBody = mod.liveFoldBody as (items: any[], vacuumState: string | null, vacuumStart?: number) => string

const T0 = 1757500000000
const runningTool = { kind: 'tool', done: false, block: { name: 'Grep', input: { pattern: 'floria' } }, html: '<i>tool</i>' }
const doneTool = { kind: 'tool', done: true, block: { name: 'Read', input: { file_path: 'a.ts' } }, html: '<span class="tool-line">done</span>' }

const pure = (mode: string) => liveFoldBody([{ kind: 'think', html: '<div>t</div>' }], mode, T0)
const concurrent = (mode: string) => liveFoldBody([runningTool], mode, T0)

let pass = 0
let fail = 0
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fail++; console.log(`  ✘ ${name}${detail ? ' — ' + detail : ''}`) }
}

console.log(`\n[probe-state-lead] ${process.argv.includes('--prefix') ? '--prefix 旧构造对照' : '修复后'}\n`)

// ---- A 结构同构 ----
const htmlThink = pure('think')
const htmlGen = pure('generating')
const htmlCmp = pure('compact')
const htmlTool = concurrent('think')
console.log('A 结构同构')
ok('A1 状态行含行首槽 .t-ico', /<span class="think-state"[^>]*><span class="t-ico">/.test(htmlThink), htmlThink.slice(0, 120))
ok('A2 状态行文本独立节点 .ts-text', /<span class="think-state"[^>]*>[\s\S]*?<span class="ts-text">正在思考<\/span>/.test(htmlThink))
ok('A3 工具行含行首槽 .t-ico', /<span class="tool-line tool-running"[^>]*><span class="t-ico">/.test(htmlTool))
ok('A4 状态行槽内图标 = DSH 原子图标（THINK_ICON path）', htmlThink.includes(mod.THINK_ICON.slice(0, 60)))

// ---- B 行首几何单一来源 ----
console.log('B 行首几何（文字左缘 = 槽 16px + gap 5px）')
const cssBlock = (sel: string) => {
  const i = styles.indexOf(sel + ' {')
  if (i < 0) return ''
  return styles.slice(i, styles.indexOf('}', i) + 1)
}
const icoBlock = cssBlock('.t-ico')
const icoSvgBlock = cssBlock('.t-ico svg')
const toolLineBlock = cssBlock('.tool-line')
const thinkBlock = cssBlock('.think-state')
ok('B1 .t-ico 槽宽 16px', /width:\s*16px/.test(icoBlock), icoBlock)
ok('B2 .t-ico svg 14px', /width:\s*14px/.test(icoSvgBlock), icoSvgBlock)
ok('B3 .tool-line gap 5px', /gap:\s*5px/.test(toolLineBlock), toolLineBlock)
ok('B4 .think-state gap 5px（与工具行同基准）', /gap:\s*5px/.test(thinkBlock), thinkBlock)
ok('B5 .t-ico 已提为通用类（无 .tool-line 前缀限定）', styles.includes('\n.t-ico {') && !styles.includes('.tool-line .t-ico {'))
ok('B6 扫光统一：状态行 ::after 并入透明扫光条选择器组', styles.includes('.think-state:not(.ts-join)::after {') && /\.tool-line\.tool-running::after,\s*\n\s*\.tool-fold\[data-state='running'\] summary::after,/.test(styles))
ok('B7 旧「蓝字渐变扫光」已退役', !styles.includes('background-clip: text') && !styles.includes('think-state-shimmer'))
ok('B8 状态行宿主持有扫光定位（relative + overflow:hidden）', /\.think-state \{[^}]*position:\s*relative;[\s\S]*?overflow:\s*hidden;/.test(styles))

// ---- C tick 不洗槽（源码级防回归）----
console.log('C tick 只写 .ts-text（不洗槽）')
ok('C1 live.js tick 用 .ts-text 写入', /stEl\.querySelector\('\.ts-text'\)\.textContent =/.test(liveSrc))
ok('C2 live.js 不再对 .think-state 整节点 textContent 赋值', !/stEl\.textContent =/.test(liveSrc))

// ---- D 三态结构恒定 ----
console.log('D 三态行首结构恒同（与 mode 无关）')
const leadOf = (h: string) => (h.match(/<span class="think-state"[^>]*>.*/) || [''])[0].slice(0, 40)
ok('D1 think/generating/compact 行首前缀一致', leadOf(htmlThink) === leadOf(htmlGen) && leadOf(htmlGen) === leadOf(htmlCmp), `${leadOf(htmlThink)} | ${leadOf(htmlGen)} | ${leadOf(htmlCmp)}`)
ok('D2 文本随 mode 变（正在生成）', /<span class="ts-text">正在生成<\/span>/.test(htmlGen))
ok('D3 文本随 mode 变（正在压缩会话中……）', /<span class="ts-text">正在压缩会话中……<\/span>/.test(htmlCmp))

// ---- E 并发复合态（2026-09-11 11:12 形态改判：两个 widget 并存 → 一行一句原子尾缀）----
console.log('E 并发复合态（工具在飞 + 状态为同行原子尾缀）')
const summary = (htmlTool.match(/<summary>([\s\S]*?)<\/summary>/) || ['', ''])[1]
ok('E1 唯一行容器 .fold-state 内 = 运行行 + 尾缀（非并存兄弟）',
  /^<span class="fold-state"><span class="tool-line tool-running"[\s\S]*?<\/span><span class="think-state ts-join"[^>]*>[\s\S]*?<\/span><\/span>$/.test(summary), summary.slice(0, 200))
ok('E2 summary 含 running 工具行', /正在运行：/.test(summary))
ok('E3 summary 含状态尾缀 .think-state.ts-join', /class="think-state ts-join"/.test(summary))
ok('E4 尾缀不重复行首槽（同行已有工具图标）', (summary.match(/class="t-ico"/g) || []).length === 1)
ok('E5 文案经 data-label 透出（live.js 单一源）', /data-label="并思考"/.test(summary))
ok('E6 无段尾重复状态行（fold-state 恰 1 处）', (htmlTool.match(/class="fold-state"/g) || []).length === 1)

// ---- F 无响应红标：已知阻塞原因豁免 ----
console.log('F 无响应红标：工具在飞豁免（源码级）')
ok('F1 判据含 toolRunning（取 DOM 运行态标记）', /const toolRunning = !!fold\.querySelector\('\.tool-line\.tool-running'\)/.test(liveSrc))
ok('F2 红标单源构造 + 工具在飞豁免串入（2026-09-11 单状态槽改判：阈值/文案归 messages.js statusFlags）',
  /statusFlags\(connUp, awaitingApproval \|\| toolRunning \? 0 : staleSec\)/.test(liveSrc))
ok('F3 审批豁免仍在（不回归）', /const awaitingApproval = takeover === 'approval'/.test(liveSrc))
ok('F4 单状态槽独占标（红标在场隐去 .think-state）',
  /frow\.classList\.toggle\('is-flagged', !!flags\)/.test(liveSrc) && /\.fold-state\.is-flagged > \.think-state/.test(styles))

// ---- G 折叠开合恢复：结构稳定键 ----
console.log('G 折叠开合恢复键（取代全局索引）')
ok('G1 存在 foldKey 稳定键函数', /const foldKey = \(d\) => \{/.test(liveSrc))
ok('G2 采集侧改为 Map（键 → open）', /const openState = new Map\(/.test(liveSrc))
ok('G3 回填改为按键匹配，全局索引已退役', /if \(!openState\.has\(k\)\) return/.test(liveSrc) && !/openState\[i\]/.test(liveSrc))

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 过 / ${fail} 败\n`)
process.exit(fail === 0 ? 0 : 1)
