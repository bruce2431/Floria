/**
 * 探针：底栏任务浮窗（web-src/inputbar/approval.js renderTaskDock/toggleTaskDock）离线自测
 *
 * 为什么这样做：web 前端手改处是 ESM 模块（依赖 DOM/state.js 顶层初始化），不能直接在 bun 里 import。
 * 本探针从源码「按标记区间切片」取出浮窗区间（renderTaskDock/toggleTaskDock/taskById/TASK_ICON，
 * 依赖 $ / live / state / takeover / esc / CHEV 六个外部标识）后求值，DOM 用最小桩注入——
 * 测的是真源码，不是复制品。
 *
 * 运行：cd _agent-src && bun probe-task-dock.ts
 */
import { readFileSync } from 'node:fs'

const SRC = 'src/gateway/web-src/inputbar/approval.js'
const src = readFileSync(SRC, 'utf-8')
const START = '  // ===== 底栏任务浮窗'
const END = '// —— 跨模块写入口'
const i = src.indexOf(START)
const j = src.indexOf(END)
if (i < 0 || j < 0 || j < i) { console.error('❌ 切片标记未命中：底栏任务浮窗区间'); process.exit(1) }
const body = src.slice(i, j)

// 与 web-src/core/state.js:52 同款 esc（探针注入）
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
// 与 web-src/chat/messages.js:408 同款 CHEV（探针只需可辨识的占位串）
const CHEV = '<svg data-chev></svg>'

// ---- 最小 DOM 桩 ----
class El {
  id: string
  hidden = true
  innerHTML = ''
  title = ''
  disabled = false
  scrollTop = 0
  onclick: unknown = 'unset'
  onkeydown: unknown = 'unset'
  attrs: Record<string, string> = {}
  cls = new Set<string>()
  constructor(id: string) { this.id = id }
  get classList() {
    const s = this.cls
    return {
      add: (...c: string[]) => c.forEach((x) => s.add(x)),
      remove: (...c: string[]) => c.forEach((x) => s.delete(x)),
      contains: (c: string) => s.has(c),
      toggle: (c: string, on?: boolean) => { const v = on === undefined ? !s.has(c) : on; if (v) s.add(c); else s.delete(c); return v },
    }
  }
  setAttribute(k: string, v: string) { this.attrs[k] = v }
  querySelector(sel: string) {
    // 只服务 renderTaskDock 里的一次查询：panel.querySelector('.td-head')
    if (sel === '.td-head' && this.innerHTML.includes('class="td-head"')) return (this.head ??= new El('task-head'))
    return null
  }
  head: El | null = null
}
const els: Record<string, El> = {}
const $ = (id: string) => (els[id] ??= new El(id))

// 源码里 takeover 是模块级 let（跨模块 setter 写），探针用注入的同名变量 + 写入钩子
// takeover 在真源码里是模块级 let（由跨模块 setter 写）；探针按同一形态在被测作用域内声明同名变量，
// 并让被测作用域自己导出写入口（← 必须在同一作用域内定义，外部回调写不到闭包变量）
const factory = new Function(
  '$', 'live', 'state', 'esc', 'CHEV',
  `let takeover = null\n${body}\nreturn { renderTaskDock, toggleTaskDock, setTk: (v) => { takeover = v } }`,
) as ($: unknown, live: unknown, state: unknown, esc: unknown, CHEV: unknown) => {
  renderTaskDock: () => void
  toggleTaskDock: () => void
  setTk: (v: string | null) => void
}
const t = (list: unknown[], hash = 'sess-1') => {
  const live: Record<string, unknown> = { tasks: list, taskOpen: false }
  const inst = factory($, live, { currentHash: hash }, esc, CHEV)
  return { live, setTk: inst.setTk, renderTaskDock: inst.renderTaskDock, toggleTaskDock: inst.toggleTaskDock }
}

let pass = 0
const fails: string[] = []
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; return }
  fails.push(`${name}${extra ? ' — ' + extra : ''}`)
}
const item = (id: string, subject: string, status: string, blockedBy: string[] = [], owner?: string, activeForm?: string) =>
  ({ id, subject, status, blockedBy, owner, activeForm })

const FULL = [
  item('1', '阶段1 调研', 'completed'),
  item('2', '阶段2 解说词', 'completed'),
  item('5', '阶段5 构建', 'in_progress', [], 'g2', '构建中'),
  item('10', '阶段10 交付', 'pending'),
  item('3', '阶段3 分镜', 'pending', ['5']),
]

// ---- ① 无清单 / 无会话 → 整窗不出现（与 CLI tasks.length===0 → null 同判）----
{
  const a = t([])
  a.setTk(null); a.renderTaskDock()
  ok('空清单: dock hidden', $('task-dock').hidden === true)
  const b = t(FULL, '')
  b.renderTaskDock()
  ok('无当前会话: dock hidden', $('task-dock').hidden === true)
  const c = t(FULL)
  c.renderTaskDock()
  ok('有清单: dock 显示', $('task-dock').hidden === false)
  ok('有清单: 收敛态（无 open 类）', !$('task-dock').classList.contains('open'))
  ok('有清单: 边沿可点（onclick 已挂）', typeof $('task-lip').onclick === 'function')
  ok('有清单: 边沿未禁用', $('task-lip').disabled === false)
}

// ---- ② 三态图标 + 数据属性（与 CLI TaskListV2 getTaskIcon 同构）----
{
  const a = t(FULL); a.renderTaskDock()
  const html = $('task-panel').innerHTML
  ok('图标: 完成 ✔', html.includes('data-st="completed"') && html.includes('✔'))
  ok('图标: 进行中 ◼', html.includes('data-st="in_progress"') && html.includes('◼'))
  ok('图标: 待办 ◻', html.includes('data-st="pending"') && html.includes('◻'))
  ok('计数文案', html.includes('共 5 项 · 2 完成 · 1 进行中'), html.match(/td-counts">[^<]*/)?.[0] || '')
  ok('头部把手存在', html.includes('class="td-head"'))
}

// ---- ③ 排序：id 数字升序（与 CLI byIdAsc 同构，非字典序）----
{
  const a = t(FULL); a.renderTaskDock()
  const html = $('task-panel').innerHTML
  const order = [...html.matchAll(/class="td-sub">([^<]*)</g)].map((m) => m[1])
  ok('排序: id 数字升序（阶段2 → 阶段3 → 阶段5 → 阶段10）',
    order.join('|') === '阶段1 调研|阶段2 解说词|阶段3 分镜|阶段5 构建|阶段10 交付', order.join('|'))
}

// ---- ④ 阻塞语义：blockedBy 命中未完成项 → dim + tooltip（CLI TaskListV2 unresolvedTaskIds 同构）----
{
  const a = t(FULL); a.renderTaskDock()
  const html = $('task-panel').innerHTML
  const blocked = html.match(/<div class="td-item dim" data-st="pending" title="[^"]*">[^<]*(<span[^>]*>[^<]*<\/span>){1}<span class="td-sub">([^<]*)</)
  ok('阻塞行: dim + title 说明等待前序', !!blocked && html.includes('title="等待前序任务：5"'), String(blocked?.[0]).slice(0, 80))
  ok('阻塞行: 阻塞的是阶段3（阶段10 未被阻塞）',
    !!html.match(/<div class="td-item dim" data-st="pending"[^>]*>\s*<span[^>]*>◻<\/span><span class="td-sub">阶段3 分镜<\/span>/))
  ok('未阻塞行不 dim', !!html.match(/<div class="td-item" data-st="pending"[^>]*>\s*<span[^>]*>◻<\/span><span class="td-sub">阶段10 交付<\/span>/))
  ok('完成任务行 dim（删除线由 CSS 承担）', !!html.match(/<div class="td-item dim" data-st="completed"/))
}
{
  // 阻塞项完成后（blockedBy 指向的 id 不再 unresolved）→ 阻塞解除：pending 行不 dim（dim 只属 completed 行）
  const a = t([item('3', '阶段3', 'pending', ['5']), item('5', '阶段5', 'completed')])
  a.renderTaskDock()
  const html = $('task-panel').innerHTML
  ok('前序完成 → 阻塞解除（pending 行无 dim、无 title）',
    !!html.match(/<div class="td-item" data-st="pending"><span[^>]*>◻<\/span><span class="td-sub">阶段3<\/span>/) && !html.includes('等待前序任务'), html)
}

// ---- ⑤ owner / activeForm ----
{
  const a = t(FULL); a.renderTaskDock()
  const html = $('task-panel').innerHTML
  ok('owner 渲染 @g2', html.includes('<span class="td-owner">@g2</span>'))
  ok('进行中行 title 带 activeForm（CLI spinner 同源）', html.includes('title="构建中"'))
}

// ---- ⑥ 交互：点击边沿上展（open），再点头部向下收敛 ----
{
  const a = t(FULL); a.renderTaskDock()
  ok('初始收敛', !$('task-dock').classList.contains('open') && a.live.taskOpen === false)
  ;($('task-lip').onclick as () => void)()
  ok('点边沿 → 展开（.open + taskOpen 真）', $('task-dock').classList.contains('open') && a.live.taskOpen === true)
  ok('展开: aria-expanded=true', $('task-lip').attrs['aria-expanded'] === 'true')
  const head = $('task-panel').head
  ok('展开: 头部把手指向收起', !!head && typeof head.onclick === 'function')
  ;(head!.onclick as () => void)()
  ok('点头部 → 收敛', !$('task-dock').classList.contains('open') && a.live.taskOpen === false)
  ok('收敛: aria-expanded=false', $('task-lip').attrs['aria-expanded'] === 'false')
}

// ---- ⑦ 列表滚动位置保留（展开态重渲不跳顶）----
{
  const a = t(FULL); a.renderTaskDock()
  ;($('task-lip').onclick as () => void)()
  $('task-panel').scrollTop = 120
  a.live.tasks = [...FULL]
  a.renderTaskDock()
  ok('展开态重渲: 保留 scrollTop', $('task-panel').scrollTop === 120, String($('task-panel').scrollTop))
}

// ---- ⑧ 接管卡（审批/提问）在场 → 自动收敛 + 禁点 ----
{
  const a = t(FULL); a.renderTaskDock()
  ;($('task-lip').onclick as () => void)()  // 用户先展开
  a.setTk('approval')                      // 审批卡到场
  a.renderTaskDock()
  ok('接管: 自动收敛（open 摘除 + taskOpen 清零）', !$('task-dock').classList.contains('open') && a.live.taskOpen === false)
  ok('接管: .blocked + 边沿禁点', $('task-dock').classList.contains('blocked') && $('task-lip').disabled === true && $('task-lip').onclick === null)
  a.live.taskOpen = true; a.renderTaskDock()
  ok('接管: 强开也压回收敛', !$('task-dock').classList.contains('open'))
  a.setTk(null); a.renderTaskDock()        // 卡撤走
  ok('卡撤走: 恢复可点且仍收敛', $('task-lip').disabled === false && typeof $('task-lip').onclick === 'function' && !$('task-dock').classList.contains('open'))
}

// ---- ⑨ 转义：subject/owner 里的标签不得落成 HTML ----
{
  const a = t([item('1', '<script>alert(1)</script>', 'pending', [], '"><img src=x>')])
  a.renderTaskDock()
  const html = $('task-panel').innerHTML
  ok('subject 转义', html.includes('&lt;script&gt;') && !html.includes('<script>'))
  ok('owner 转义', !html.includes('<img src=x>') && html.includes('@&quot;&gt;&lt;img'))
}

// ---- ⑩ 形状边界在网关：normalizeGatewayTasks（localGateway.ts 真源码切片）----
{
  const gw = readFileSync('src/gateway/localGateway.ts', 'utf-8')
  const a = gw.indexOf('// 字段对齐 CLI 源码 TaskSchema')
  const b = gw.indexOf('// 2026-09-06 web 打断收口二轮')
  if (a < 0 || b < 0 || b < a) { console.error('❌ 切片标记未命中：normalizeGatewayTasks'); process.exit(1) }
  // TS 切片含类型标注 → 走 Bun 转译器剥类型（new Function 不认 TS 语法）
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(gw.slice(a, b))
  const norm = new Function(`${js}\nreturn normalizeGatewayTasks`)() as (raw: unknown) => Array<Record<string, unknown>>
  ok('网关: 非数组 → []', Array.isArray(norm(null)) && norm(null).length === 0 && norm('x').length === 0)
  ok('网关: 结构不符项丢弃（null / 缺 id / 缺 subject）', norm([null, { status: 'pending' }, { id: '1' }, { id: '2', subject: 'ok' }]).length === 1)
  const dirty = norm([{ id: '1', subject: 's', status: 'weird', blockedBy: ['a', 3, null], owner: 7, activeForm: 8, description: 'x'.repeat(999) }])[0]
  ok('网关: 未知 status → pending', dirty.status === 'pending')
  ok('网关: blockedBy 只留字符串', JSON.stringify(dirty.blockedBy) === '["a"]')
  ok('网关: 非字符串 owner/activeForm 落 undefined', dirty.owner === undefined && dirty.activeForm === undefined)
  ok('网关: description 等长文本不透传', !('description' in dirty))
  ok('网关: subject 截断 500', (norm([{ id: '1', subject: 'x'.repeat(999) }])[0].subject as string).length === 500)
}

console.log('渲染样例（FULL 清单，dock.hidden=' + (() => { const a = t(FULL); a.renderTaskDock(); return String($('task-dock').hidden) })() + '）：')
console.log($('task-panel').innerHTML.replace(/></g, '>\n<'))
console.log(`\n结果: ${pass} 通过 / ${fails.length} 失败`)
for (const f of fails) console.log('  ❌ ' + f)
process.exit(fails.length ? 1 : 0)
