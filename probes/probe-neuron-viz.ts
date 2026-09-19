/**
 * 探针 · 神经元可视化（web「神经」tab）
 *   后端 A = src/gateway/neuronViz.ts 数据链，真实 Neuron-Pj16 库只读直读
 *   前端 B = web-src/sidebar/neurons.js 源码切片注入（task-dock 探针模式），与真实库 payload 做集成
 * 跑法：cd Floria && bun probes/probe-neuron-viz.ts
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildNeuronGraph, buildNeuronGraphInDir, listNeuronsForGateway } from '../src/gateway/neuronViz.ts'
import { listNeuronsInRoot } from '../src/tools/neturon/config.ts'
import { setProjectRoot } from '../src/bootstrap/state.ts'

let pass = 0
let fail = 0
function ok(cond: unknown, label: string) {
  if (cond) pass++
  else {
    fail++
    console.log('  ✗ ' + label)
  }
}
function sec(name: string) {
  console.log('== ' + name)
}

const ROOT = resolve(import.meta.dir, '..', '..', '..')
const LIB = join(ROOT, '.claude', 'neturon', 'neurons', 'Neuron-Pj16')
setProjectRoot(ROOT) // 对齐网关进程前提（启动 cwd = exe 所在项目根），buildNeuronGraph 默认扫描才指向 cwd 根

// ───────────────────────── A 后端 · 数据链 ─────────────────────────
sec('A 后端 · neuronViz 数据链（真实 Neuron-Pj16 库）')

const roster = listNeuronsInRoot(join(ROOT, '.claude', 'neturon'))
// 注册 id = config.yaml person.id（目录名 Neuron- 前缀被剥），本库 = PJ16
ok(roster.some((n) => n.id === 'PJ16'), '库发现：cwd 根注册表含 PJ16（目录 Neuron-Pj16）')

const payload = buildNeuronGraphInDir(LIB)
const rawCog2 = JSON.parse(readFileSync(join(LIB, 'l1.cog', 'cog2.json'), 'utf-8')) as { resolution?: number; cog2_records?: any[] }
ok(payload.resolution === String(rawCog2.resolution), `默认分辨率 = cog2 命名档 ${rawCog2.resolution}（2026-09-17 定案，不再硬取 1.0）`)
ok(payload.neuron.id === 'PJ16', 'payload.neuron.id = PJ16（config person.id）')

const rawGraph = JSON.parse(readFileSync(join(LIB, 'l1.cog', 'cog_graph.json'), 'utf-8')) as { nodes?: unknown[] }
ok(
  payload.cogs.length === (rawGraph.nodes ?? []).filter((n: any) => typeof n?.id === 'string').length,
  'cog 数与 cog_graph.json 一致',
)
const rawComm = JSON.parse(readFileSync(join(LIB, 'l1.cog', 'community.json'), 'utf-8')) as Record<string, any>
ok(
  payload.communities.length === rawComm['resolution_' + rawCog2.resolution].communities.length,
  `社群数与 community.json[res_${rawCog2.resolution}] 一致`,
)
// 社群命名挂载（cog2.json → communities[].name/description/confidence，members 集合精确匹配）
const namedRecs = (rawCog2.cog2_records ?? []).filter((r: any) => typeof r.name === 'string' && r.name.trim())
const namedComms = payload.communities.filter((c: any) => c.name)
ok(namedComms.length === namedRecs.length, `命名挂载数 = cog2 有效命名记录数（${namedComms.length}/${namedRecs.length}）`)
ok(
  namedComms.every((c: any) => typeof c.description === 'string' && typeof c.confidence === 'number'),
  '挂载社群带 description/confidence',
)
// 命名挂载的 members 集合精确匹配（数据驱动，不写死社群名/规模——认知图会随收割重算）
const recByName = new Map<string, string[]>()
for (const r of namedRecs) recByName.set(String(r.name), [...new Set((r.members ?? []).map(String))].sort())
ok(
  payload.communities.every((c: any) => {
    if (!c.name) return true
    const want = recByName.get(c.name)
    return !!want && JSON.stringify([...c.cog_ids].sort()) === JSON.stringify(want)
  }),
  `命名社群成员集合与 cog2 记录精确一致（${namedComms.length} 个命名群）`,
)
ok(
  JSON.stringify(payload.resolutions) ===
    JSON.stringify(Object.keys(rawComm).map((k) => k.slice('resolution_'.length))),
  'resolutions 清单 = community.json 键',
)

const memIds = new Set(payload.mems.map((m) => m.id))
ok(
  payload.cogs.every((g) => [...g.mem_ids, ...g.rel_ids].every((id) => memIds.has(id))),
  'cog 挂载 mem/rel id 全部闭合于 mems',
)
ok(payload.mems.every((m) => m.preview.length <= 81), 'preview ≤ 81 字符（80+省略号）')

// 社群 mem_count/chars 独立复算（不依赖实现内的累计顺序）
const charsById = new Map(payload.mems.map((m) => [m.id, m.chars]))
let commOk = true
for (const c of payload.communities) {
  const set = new Set<string>()
  let chars = 0
  for (const cid of c.cog_ids) {
    const g = payload.cogs.find((x) => x.id === cid)!
    for (const mid of [...g.mem_ids, ...g.rel_ids]) {
      if (!set.has(mid)) {
        set.add(mid)
        chars += charsById.get(mid) ?? 0
      }
    }
  }
  if (c.mem_count !== set.size || c.chars !== chars) commOk = false
}
ok(commOk, '社群 mem_count/chars 独立复算一致')

const memberOf = new Map<string, number>()
payload.communities.forEach((c) => c.cog_ids.forEach((id) => memberOf.set(id, c.i)))
ok(
  payload.cogs.every((g) => g.community === (memberOf.get(g.id) ?? -1)),
  'cog.community 与社群成员表互恰（未入群 = -1）',
)

let threw = ''
try {
  buildNeuronGraphInDir(LIB, '999')
} catch (e) {
  threw = String(e)
}
ok(threw.includes('分辨率') && threw.includes('resolution_999'), '非法分辨率抛错并带可用档提示')
threw = ''
try {
  buildNeuronGraphInDir(join(ROOT, 'no-such-neuron-xyz'))
} catch (e) {
  threw = String(e)
}
ok(threw.length > 0, '非库目录抛错（l2.mem/mem.db 不存在）')
threw = ''
try {
  buildNeuronGraph('NoSuch-Neuron-XYZ', [join(ROOT, '.claude', 'neturon')])
} catch (e) {
  threw = String(e)
}
ok(threw.length > 0, '未注册 id 经 resolveNeuronPath 抛错')

// A1b 空认知层库（项目库迁入 LOG 后未跑认知管线）：照实出记忆层图，不抛错
sec('A1b 空认知层库（全项目神经元化新库）')
const COG_ROOT = join(resolve(ROOT, '..'), 'Pj15-本地媒体资源库', '.claude', 'neturon')
const noCogLib = join(COG_ROOT, 'neurons', 'Neuron-Pj15-本地媒体资源库')
const noCog = buildNeuronGraphInDir(noCogLib)
ok(noCog.cognition.graph === false && noCog.cognition.communities === false, 'cognition 两标志均 false（无 cog_graph/community）')
ok(noCog.cogs.length === 0 && noCog.communities.length === 0, '认知层/社群层为空数组')
ok(noCog.resolution === '' && noCog.resolutions.length === 0, 'resolution 空串、resolutions 空表（无档可报）')
ok(noCog.mems.length > 0, `记忆层照常出图（mem=${noCog.mems.length}）`)
ok(noCog.mems.every((m) => m.preview.length <= 81), '无认知层库 preview 仍 ≤ 81 字符')
const byId = buildNeuronGraph('PJ16', [join(ROOT, '.claude', 'neturon')])
ok(byId.neuron.id === 'PJ16' && byId.cogs.length === payload.cogs.length, 'buildNeuronGraph 注册名路径与 InDir 一致')

sec('A2 清单卡片 listNeuronsForGateway')
const cards = listNeuronsForGateway([join(ROOT, '.claude', 'neturon')]).neurons
const pj = cards.find((n) => n.id === 'PJ16')
ok(!!pj, '清单含 Neuron-Pj16')
ok(!!pj && pj.mem_count > 0 && pj.cog_count > 0 && pj.community_count > 0, '卡片统计三项非零（mem/cog/社群）')
ok(
  !pj || !Object.keys(pj).some((k) => k.toLowerCase().includes('path') || k.toLowerCase().includes('dir')),
  '卡片不泄漏盘上路径字段',
)

// ───────────────────────── B 前端 · 源码切片注入 ─────────────────────────
sec('B 前端 · neurons.js 切片注入（模型/仿真/浮窗真实源码）')

const src = readFileSync(join(import.meta.dir, '..', 'src', 'gateway', 'web-src', 'sidebar', 'neurons.js'), 'utf-8')
const START = '  // ---------- 三级图模型（纯函数，探针覆盖） ----------'
const END = '\nexport {'
const i0 = src.indexOf(START)
ok(i0 >= 0, '切片起点标记存在（三级图模型）')
const i1 = src.indexOf(END, i0)
ok(i1 > i0, '切片终点存在（export {）')
const body = src.slice(i0 + START.length, i1)
ok(!/\bimport\b/.test(body) && !/\bawait\b/.test(body), '切片体无 import/await（工厂可注入）')

const escReal = (s: unknown) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const factory = new Function(
  'MGR_PALETTE',
  'esc',
  body + '\nreturn { neuBuildModel, neuMemR, neuCogR, neuCommR, neuTick, neuHue, neuPopHtml, neuCommHtml, neuCogHtml, neuMemHtml }',
)
const F = factory(['#5b8ff9', '#7b6bd6'], escReal) as ReturnType<typeof makeApi>
function makeApi() {
  return {} as any
}

// 半径公式边界
ok(F.neuMemR(0) === 2.5 && F.neuMemR(99999) === 5, 'mem 半径 [2.5,5] 且封顶')
ok(F.neuCogR(0, 0) === 7 && F.neuCogR(999, 99999) === 24, 'cog 半径 [7,24] 且封顶')
ok(F.neuCommR(0, 0) === 11 && F.neuCommR(999, 999999) === 34, '社群半径 [11,34] 且封顶')
ok(F.neuHue(0) === '#5b8ff9' && F.neuHue(1) === '#7b6bd6' && F.neuHue(2) === '#5b8ff9', '社群色板按 i 循环')

// 模型构建（真实库 payload 集成）
const m = F.neuBuildModel(payload)
ok(
  m.nodes.length === payload.communities.length + payload.cogs.length + payload.mems.length,
  '节点数 = 社群 + cog + mem',
)
const expLinks = payload.cogs.reduce(
  (a, g) => a + (g.community >= 0 ? 1 : 0) + g.mem_ids.length + g.rel_ids.length,
  0,
)
ok(m.links.length === expLinks, `连边数 = Σ(comm1+mem+rel) = ${expLinks}`)
ok(
  m.links.every((l: any) => l.s >= 0 && l.s < m.nodes.length && l.t >= 0 && l.t < m.nodes.length),
  '连边索引全在界内',
)
// 事实闭合：每 mem 节点连边数 == 其在各 cog 挂载记录之和（多 cog 挂载逐边）
const expMem = new Map<string, number>()
for (const g of payload.cogs) for (const mid of [...g.mem_ids, ...g.rel_ids]) expMem.set(mid, (expMem.get(mid) ?? 0) + 1)
let memMismatch = 0
let multi = 0
for (const n of m.nodes) {
  if (n.type !== 'mem') continue
  const cnt = m.links.filter((l: any) => m.nodes[l.s] === n || m.nodes[l.t] === n).length
  const want = expMem.get(n.ref.id) ?? 0
  if (cnt !== want) memMismatch++
  if (want >= 2) multi++
}
ok(memMismatch === 0, '每 mem 节点连边数与 cog 挂载记录一致（事实闭合）')
console.log('  info: 多 cog 挂载 mem 数 = ' + multi)

ok(m.nodes.every((n: any) => (n.type === 'mem' ? n.r >= 2.5 && n.r <= 5 : true)), '真实 mem 节点半径界内')
ok(m.nodes.every((n: any) => (n.type === 'cog' ? n.r >= 7 && n.r <= 24 : true)), '真实 cog 节点半径界内')
ok(m.nodes.every((n: any) => (n.type === 'comm' ? n.r >= 11 && n.r <= 34 : true)), '真实社群节点半径界内')

// 确定性：同 payload 两次构建逐位一致
const m2 = F.neuBuildModel(buildNeuronGraphInDir(LIB))
const keyOf = (mm: any) => JSON.stringify(mm.nodes.map((n: any) => [n.key, Math.round(n.x * 100), Math.round(n.y * 100)]))
ok(keyOf(m) === keyOf(m2), '两次构建初始布局逐位一致（无随机）')

// 仿真收敛
const PADS: Record<string, number> = { mem: 6, rel: 6, comm: 16 }
const linkErr = (mm: any) =>
  mm.links.reduce((a: number, l: any) => {
    const A = mm.nodes[l.s]
    const B = mm.nodes[l.t]
    const d = Math.hypot(B.x - A.x, B.y - A.y)
    return a + Math.abs(d - (A.r + B.r + PADS[l.kind]))
  }, 0)
const e0 = linkErr(m)
let alpha = 1
let ticks = 0
while (alpha > 0.003 && ticks < 2000) {
  F.neuTick(m, alpha)
  alpha *= 0.985
  ticks++
}
const e1 = linkErr(m)
console.log(`  info: 收敛 ${ticks} tick 至 alpha=${alpha.toFixed(4)}（与前端停机阈值一致）`)
console.log(`  info: 弹簧总误差 ${Math.round(e0)} → ${Math.round(e1)}（120 tick，斥力-弹簧平衡点允许拉长，判有界不判单调）`)
ok(Number.isFinite(e1), '收敛后弹簧误差有限')
ok(m.nodes.every((n: any) => [n.x, n.y, n.vx, n.vy].every((v: number) => Number.isFinite(v))), '120 tick 后无 NaN')
ok(e1 < e0 * 2, '弹簧误差有界（未发散失控）')
// 功能不变量：cog 聚在所属社群旁——收敛后 cog 到 host 社群距离 < 到任一其它社群
const comms = m.nodes.filter((n: any) => n.type === 'comm')
const cogs = m.nodes.filter((n: any) => n.type === 'cog' && n.ref.community >= 0)
let clustered = 0
for (const g of cogs) {
  const host = comms.find((c: any) => c.ref.i === g.ref.community)!
  const dh = Math.hypot(g.x - host.x, g.y - host.y)
  const others = comms.filter((c: any) => c !== host).map((c: any) => Math.hypot(g.x - c.x, g.y - c.y))
  if (others.every((d: number) => dh < d)) clustered++
}
console.log(`  info: 聚类检验 ${clustered}/${cogs.length} 个 cog 距 host 社群最近`)
const meanRad = (t: string) => {
  const arr = m.nodes.filter((n: any) => n.type === t).map((n: any) => Math.hypot(n.x, n.y))
  return arr.length ? (arr.reduce((a: number, b: number) => a + b, 0) / arr.length).toFixed(0) : 'n/a'
}
console.log(`  info: 收敛后平均离心距 comm=${meanRad('comm')} / cog=${meanRad('cog')} / mem=${meanRad('mem')}（统一向心下 charge 大者被推得远：期望 comm 外圈 / cog 中带 / mem 内带）`)
const linkedMems = new Set<string>()
for (const l of m.links as any[]) {
  const A = m.nodes[l.s]
  const B = m.nodes[l.t]
  if (A.type === 'mem') linkedMems.add(A.key)
  if (B.type === 'mem') linkedMems.add(B.key)
}
const orphanMems = m.nodes.filter((n: any) => n.type === 'mem' && !linkedMems.has(n.key))
console.log(`  info: 孤儿 mem（不被任何 cog 挂载）= ${orphanMems.length} / ${m.nodes.filter((n: any) => n.type === 'mem').length}；孤儿平均离心距=${orphanMems.length ? (orphanMems.reduce((a: number, n: any) => a + Math.hypot(n.x, n.y), 0) / orphanMems.length).toFixed(0) : 'n/a'}`)
ok(clustered / cogs.length >= 0.8, '≥80% cog 距所属社群最近（社群成簇成形）')
ok(
  m.nodes.every((n: any) => Math.abs(n.vx) <= 14 + 1e-6 && Math.abs(n.vy) <= 14 + 1e-6),
  '速度上限 14 生效',
)
ok(m.nodes.every((n: any) => Math.hypot(n.x, n.y) < 2000), '布局未发散（全部节点距原点 < 2000）')

// fixed 节点冻结（拖拽钉位不变量）
const mf = F.neuBuildModel(payload)
const fx = mf.nodes[0]
fx.fixed = true
fx.x = 500
fx.y = -300
for (let i = 0; i < 30; i++) F.neuTick(mf, 0.5)
ok(fx.x === 500 && fx.y === -300, 'fixed 节点 tick 期间位置冻结')

// 向心引力与节点尺寸无关（2026-09-16 统一化定案不变量）：同类型异半径，各自单节点模型分别单 tick——
// 孤节点唯一受力=向心引力（无同伴无弹簧），位移必须逐位相等
const mkSolo = (type: string, r: number) => ({
  nodes: [{ type, x: 400, y: -260, vx: 0, vy: 0, r, fixed: false }],
  links: [] as unknown[],
})
const mc = mkSolo('mem', 30)
const mm = mkSolo('mem', 3)
F.neuTick(mc as never, 0.5)
F.neuTick(mm as never, 0.5)
const nc = mc.nodes[0]!
const nm = mm.nodes[0]!
ok(
  nc.x === nm.x && nc.y === nm.y,
  `向心引力与尺寸无关（mem r30 与 r3 分别单 tick 位移相等：${nc.x},${nc.y}）`,
)
// 统一外场判别：同起点 cog 与 mem 单 tick 位移逐位相等（向心与类型无关——15:47 分级旧值会给出 4 倍差）
const ga = mkSolo('cog', 15)
const gb = mkSolo('mem', 15)
F.neuTick(ga as never, 0.5)
F.neuTick(gb as never, 0.5)
const da = 400 - ga.nodes[0]!.x
const db = 400 - gb.nodes[0]!.x
ok(da === db, `向心=统一外场与类型无关（cog/mem 单 tick 位移逐位相等：${da}）`)

// 弹簧无地板：alpha<0.15 时合力仍 ∝ alpha（渐缓收尾不变量）—— stretched 单弹簧两节点模型单 tick，位移比 = alpha 比
const mkSpring = () => ({
  nodes: [
    { type: 'mem', x: 400, y: 0, vx: 0, vy: 0, r: 3, fixed: false },
    { type: 'mem', x: 432, y: 0, vx: 0, vy: 0, r: 3, fixed: false },
  ],
  links: [{ s: 0, t: 1, kind: 'mem' }],
})
const sa1 = mkSpring()
const sa2 = mkSpring()
F.neuTick(sa1 as never, 0.1)
F.neuTick(sa2 as never, 0.05)
const d1 = 400 - sa1.nodes[0]!.x
const d2 = 400 - sa2.nodes[0]!.x
ok(
  Math.abs(d1 - 2 * d2) < 1e-9 * Math.abs(d1),
  `弹簧力无地板 ∝ alpha（单 tick 位移 ${d1.toPrecision(6)} vs ${d2.toPrecision(6)}，比=${(d1 / d2).toPrecision(6)}）`,
)

// 速度上限随 alpha 收缩：预注大速度，alpha=0.09 时上限 4.2（旧实现恒 14 必败 → 真判别）
const mkBoost = (vy0: number) => ({
  nodes: [
    { type: 'mem', x: 400, y: 0, vx: 100, vy: vy0, r: 3, fixed: false },
    { type: 'mem', x: 432, y: 0, vx: 0, vy: 0, r: 3, fixed: false },
  ],
  links: [{ s: 0, t: 1, kind: 'mem' }],
})
const sb1 = mkBoost(0)
F.neuTick(sb1 as never, 0.09)
const sp1 = Math.hypot(sb1.nodes[0]!.vx, sb1.nodes[0]!.vy)
ok(sp1 <= 14 * (0.09 / 0.3) + 1e-9, `速度上限随 alpha 收缩（alpha=0.09 注速 100 → 末速 ${sp1.toPrecision(4)} ≤ 4.2）`)
const sb2 = mkBoost(0)
F.neuTick(sb2 as never, 0.6)
const sp2 = Math.hypot(sb2.nodes[0]!.vx, sb2.nodes[0]!.vy)
ok(sp2 <= 14 + 1e-9 && sp2 > 13.9, `高 alpha 上限仍 14（alpha=0.6 注速 100 → 末速 ${sp2.toPrecision(4)}）`)

// 浮窗（真实源码 esc 注入，XSS 转义 + 格式）
const xss = '<img src=x onerror=alert(1)>'
const fake = {
  neuron: { id: 'T', name: 'T', description: '' },
  resolution: '1.0',
  resolutions: ['1.0'],
  communities: [
    { i: 0, size: 1, density: 0.5, cog_ids: ['c1'], mem_count: 1, chars: 10, members: [{ id: 'c1', query: xss, role: 'core', core_score: 0.734 }] },
  ],
  cogs: [{ id: 'c1', query: '"><script>', keywords: ['<b>kw</b>'], mem_ids: ['m1'], rel_ids: [], community: -1, chars: 5 }],
  mems: [{ id: 'm1', chars: 1200, source: 'LOG', time: '2026-09-16 10:50', preview: '<u>预览</u>' }],
}
const fm = F.neuBuildModel(fake)
const commNode = fm.nodes.find((n: any) => n.type === 'comm')
const cogNode = fm.nodes.find((n: any) => n.type === 'cog')
const memNode = fm.nodes.find((n: any) => n.type === 'mem')
const hComm = F.neuPopHtml(commNode)
ok(hComm.includes('群 1 · 认知 1') && hComm.includes('&lt;img') && !hComm.includes('<img'), '社群浮窗：标题 + 成员 query XSS 转义')
ok(hComm.includes('neu-role core') && hComm.includes('0.73'), '社群浮窗：成员角色点 + 评分两位小数')
const hCog = F.neuPopHtml(cogNode)
ok(hCog.includes('游离') && hCog.includes('&lt;script&gt;') && hCog.includes('&lt;b&gt;kw&lt;/b&gt;'), 'cog 浮窗：游离标注 + query/关键词转义')
ok(hCog.includes('记忆 1') && hCog.includes('内容 5 字'), 'cog 浮窗：chips 统计')
const hMem = F.neuPopHtml(memNode)
ok(hMem.includes('&lt;u&gt;预览&lt;/u&gt;') && hMem.includes('1.2k 字') && hMem.includes('来源 LOG'), 'mem 浮窗：预览转义 + k字格式 + 来源')

// ───────────────────────── C 信息（调参参考） ─────────────────────────
sec('C 信息 · 半径分布（调参参考）')
const cogRs = payload.cogs.map((g) => F.neuCogR(g.mem_ids.length + g.rel_ids.length, g.chars) as number)
const commRs = payload.communities.map((c) => F.neuCommR(c.size, c.chars) as number)
console.log('  cog  r: ' + cogRs.map((r) => r.toFixed(1)).sort().join(' '))
console.log('  comm r: ' + commRs.map((r) => r.toFixed(1)).sort().join(' '))
console.log(`  未入群 cog = ${payload.cogs.filter((g) => g.community < 0).length} / ${payload.cogs.length}；mem = ${payload.mems.length}`)

console.log(`\n结果：${pass} 过 / ${fail} 败`)
process.exit(fail ? 1 : 0)
