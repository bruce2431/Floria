// 探针：回退快照防御 snapshotStale（2026-09-11 三诊根治「发送瞬间跳到上一条消息」真主链）
// 跑真实源码：从 web-src/core/live.js 切出 snapshotStale 函数体执行断言；源码结构断言验证
// 门在 refreshSession 中的位置（先于一切副作用与基线赋值）。场景=20260911203904 录像三态重放。
// 运行：bun probe-snapshot-stale.ts
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../src/gateway/web-src/core/live.js', import.meta.url), 'utf8')

let pass = 0
let fail = 0
function ok(cond: boolean, name: string) {
  if (cond) { pass++ } else { fail++; console.error('FAIL: ' + name) }
}

// ---- 切出真实 snapshotStale 函数体 ----
const fnStart = SRC.indexOf('function snapshotStale')
ok(fnStart > 0, 'live.js 含 snapshotStale 定义')
const fnSrc = SRC.slice(fnStart, SRC.indexOf('\n  }', fnStart) + 4)
const snapshotStale = new Function('return ' + fnSrc)() as (local: unknown, incoming: unknown) => boolean

// ---- 录像时序重放素材：回合1-3（最大 ts=900）→ 回合4 落盘（ts=1000）----
const turns123 = [
  { role: 'user', timestamp: 100 },
  { role: 'assistant', timestamp: 500 },
  { role: 'user', timestamp: 700 },
  { role: 'assistant', timestamp: 900 },
]
const turns1234 = [...turns123, { role: 'user', timestamp: 1000 }]

// ---- 场景断言（纯函数） ----
// 首载/切会话：基线 null → 无从回退，放行
ok(snapshotStale(null, turns1234) === false, '基线 null 放行（首载）')
ok(snapshotStale(undefined, turns1234) === false, '基线 undefined 放行')
ok(snapshotStale([], turns1234) === false, '空基线放行')

// 录像 pass B：已渲染回合4（基线 max ts=1000）→ 旧快照只到回合3（max ts=900）= 回退，丢弃
ok(snapshotStale(turns1234, turns123) === true, '回退快照丢弃（录像 pass B：回合4被洗成1-3）')

// 录像 pass C：本地非空、快照空 = 洗盘，丢弃（force 也拦）
ok(snapshotStale(turns1234, []) === true, '空快照丢弃（录像 pass C：整页空白）')
ok(snapshotStale(turns1234, null) === true, '快照 null 丢弃')

// 幂等重渲（撤回 restored / turn-state 收口：同数据 force 重渲）→ ts 持平放行
ok(snapshotStale(turns1234, turns1234) === false, '同数据 force 重渲放行（ts 持平）')

// 前进快照（正常 SSE/落盘推进）放行
ok(snapshotStale(turns123, turns1234) === false, '前进快照放行')
ok(snapshotStale(turns123, [...turns123, { role: 'assistant', timestamp: 1200 }]) === false, '尾部增长放行')

// 压缩收口：历史被 summary 替换但 ts 前进 → 放行
ok(snapshotStale(turns1234, [{ role: 'user', timestamp: 1500 }]) === false, '压缩后 ts 前进放行')

// incoming 全部无时间戳（next=0）→ 不可证回退，维持现行为放行
ok(snapshotStale(turns1234, [{ role: 'user' }]) === false, '无时间戳快照放行（不可证回退）')

// 尾部 progress 无 ts 不参与 max：快照末条无 ts 但中间有 900 → 与基线 1000 比 = 回退
ok(snapshotStale(turns1234, [...turns123, { role: 'progress' }]) === true, 'maxTs 取全量最大而非末条（尾 progress 无 ts 不遮蔽回退）')

// ---- 时序集成重放：模拟 refreshSession 门——仅在门放行时允许基线赋值 ----
{
  let baseline: Array<{ timestamp?: number }> | null = null
  let assigned = 0
  const fetchArrival = (incoming: Array<{ timestamp?: number }> | null) => {
    if (baseline !== null && snapshotStale(baseline, incoming as never)) return // 门：丢弃，基线不动
    baseline = incoming as Array<{ timestamp?: number }>
    assigned++
  }
  fetchArrival(turns1234)        // pass A：回合4 权威快照（录像 f26 正确渲染）
  ok(baseline && (baseline as never as Array<{ timestamp?: number }>).length === 5, 'pass A 基线=回合1-4（5 条落盘）')
  fetchArrival(turns123)         // pass B：回退快照（录像 f30 跳变源）→ 必须丢弃
  ok(assigned === 1, 'pass B 回退快照被丢弃（基线未回写）')
  ok((baseline as never as Array<{ timestamp?: number }>).length === 5, 'pass B 后基线仍含回合4（DOM 不被洗）')
  fetchArrival([])               // pass C：空快照（录像 f42 空白源）→ 必须丢弃
  ok(assigned === 1, 'pass C 空快照被丢弃（不洗盘）')
  fetchArrival(turns1234)        // 幂等重渲放行
  ok(assigned === 2, '同数据重渲正常放行')
  fetchArrival([...turns1234, { role: 'assistant', timestamp: 1100 }]) // 回复落盘
  ok(assigned === 3 && (baseline as never as Array<{ timestamp?: number }>).length === 6, '回复落盘正常推进')
}

// ---- 源码结构断言：门在 refreshSession 内、先于一切副作用 ----
const rsStart = SRC.indexOf('function refreshSession')
ok(rsStart > 0, 'refreshSession 存在')
const rsBody = SRC.slice(rsStart, SRC.indexOf('function renderSessionBody', rsStart))
const gateCall = rsBody.indexOf('if (snapshotStale(live.localMessages, messages)) return')
ok(gateCall > 0, 'refreshSession 内有 snapshotStale 门调用')
const hashCheck = rsBody.indexOf('if (state.currentHash !== hash) return')
const sideEffect = rsBody.indexOf('setSessionCwd(cwd)')
const baselineAssign = rsBody.indexOf('live.localMessages = messages')
ok(hashCheck > 0 && gateCall > hashCheck, '门位于会话身份复验之后（防串会话写穿）')
ok(sideEffect > 0 && gateCall < sideEffect, '门先于 cwd/模型/队列/任务槽副作用（回退快照整体作废）')
ok(baselineAssign > 0 && gateCall < baselineAssign, '门先于 localMessages/deltaSeq 基线赋值（防静默回写）')

console.log(`probe-snapshot-stale: ${pass} pass / ${fail} fail`)
if (fail > 0) process.exit(1)
