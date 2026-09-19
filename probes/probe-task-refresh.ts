/**
 * 探针：任务浮窗不刷新根治（2026-09-12 删 sessionTasks/sessionQueues 时间 TTL）
 *
 * 根因：CLI 上行契约「载荷不变不发」（notifyTaskState 去重）× 网关 SESSION_TASK_TTL_MS=10min
 * 时间清扫直接矛盾——活跃会话里清单 10 分钟不变（长工具运行期常态）即被 sweepStaleMaps 清仓 →
 * /gateway/session 首载/刷新拉到 [] 当权威 → web 任务浮窗消失；清单不变永不再发 → 整场不刷新
 * （09-12 实证：回合 2h4m43s 长工具期，CLI 任务在跑、web 浮窗不出现）。sessionQueues（排队区）同病。
 *
 * 修法（纯删除）：两张 Map 退出时间清扫，生命周期不变量收敛为「清单态只属于在线 CLI 进程」——
 * 上报 upsert + detach 删除 + 重连 open 补发（+ 网关重启空表由 CLI 重连补发对齐），三者原本就在。
 *
 * 判据（源码切片结构断言，localGateway.ts 依赖服务器副作用不可整模块导入）：
 *  1. TTL 常量零残留（SESSION_TASK_TTL_MS / SESSION_QUEUE_TTL_MS 全仓 src 无引用）
 *  2. sweepStaleMaps 函数体不再 delete sessionTasks/sessionQueues；其余三张 TTL 表原样保留
 *  3. detach 仍删两表（生命周期第一道闸未被误删）
 *  4. task-state / queue-state 上报入口仍 upsert 两表
 *  5. gatewayClient openSocket 重连补发 sendTaskState + sendQueueState 在场（生命周期第二/三道闸）
 *  6. notifyTaskState 去重契约仍在（删 TTL 的前提正是该契约，双方必须同存）
 *  7. useTasksV2 #report 出口未动（getSnapshot ?? [] 单源语义）
 *
 * 修前对照：①②必败（常量在、清扫分支在），③-⑦修前即过（既有多道闸，本次未动）。
 *
 * 运行：cd _agent-src && bun probe-task-refresh.ts
 */
import { readFileSync } from 'node:fs'

let pass = 0
const fails: string[] = []
function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++
    console.log(`  \u2714 ${name}`)
    return
  }
  fails.push(name)
  console.log(`  \u2716 ${name}${extra ? '  ' + extra : ''}`)
}

/** 提取 { 起点的平衡花括号函数体（源码切片，防跨函数误匹配）。 */
function fnBody(src: string, head: string): string {
  const i = src.indexOf(head)
  if (i === -1) return ''
  const open = src.indexOf('{', i)
  let depth = 0
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') {
      depth--
      if (depth === 0) return src.slice(i, j + 1)
    }
  }
  return ''
}

/** 代码引用计数：忽略行注释（trim 后以 // 或 * 开头）——历史注释提及旧名不算残留。 */
function codeRefs(src: string, name: string): number {
  return src
    .split('\n')
    .filter((l) => l.includes(name) && !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .length
}

console.log('—— localGateway.ts 生命周期结构 ——')
const gw = readFileSync('src/gateway/localGateway.ts', 'utf-8')

ok('① SESSION_TASK_TTL_MS 代码引用零残留', codeRefs(gw, 'SESSION_TASK_TTL_MS') === 0)
ok('① SESSION_QUEUE_TTL_MS 代码引用零残留', codeRefs(gw, 'SESSION_QUEUE_TTL_MS') === 0)

const sweep = fnBody(gw, 'function sweepStaleMaps')
ok('② sweepStaleMaps 已提取到函数体', sweep.length > 100)
ok('② sweep 不再清 sessionTasks（时间清扫移除）', !/sessionTasks\.delete/.test(sweep))
ok('② sweep 不再清 sessionQueues（时间清扫移除）', !/sessionQueues\.delete/.test(sweep))
ok('② 其余 TTL 表保留：conversationDisplays', /conversationDisplays\.delete/.test(sweep))
ok('② 其余 TTL 表保留：sessionActivity（含 isPidAlive）', /sessionActivity\.delete/.test(sweep) && sweep.includes('isPidAlive'))
ok('② 其余 TTL 表保留：sessionModels', /sessionModels\.delete/.test(sweep))

const detach = fnBody(gw, 'const detach = () =>')
ok('③ detach 仍清 sessionTasks', /sessionTasks\.delete\(sid\)/.test(detach))
ok('③ detach 仍清 sessionQueues', /sessionQueues\.delete\(sid\)/.test(detach))

ok('④ task-state 上报入口仍 upsert', gw.includes('sessionTasks.set(sid,'))
ok('④ queue-state 上报入口仍 upsert', gw.includes('sessionQueues.set(sid,'))

console.log('—— gatewayClient.ts 补发与去重契约 ——')
const gc = readFileSync('src/utils/gatewayClient.ts', 'utf-8')
// 头串带 ', () => {'：文件 87 行注释里也有 "sock.on('open')" 字样，精确头防切片取到注释
const openHandler = fnBody(gc, "sock.on('open', () => {")
ok('⑤ open 补发 sendQueueState 在场', /sendQueueState\(\)/.test(openHandler))
ok('⑤ open 补发 sendTaskState 在场', /sendTaskState\(\)/.test(openHandler))
ok('⑥ notifyTaskState 去重契约仍在（载荷不变不发）', gc.includes('if (payload === lastTaskStateJSON) return'))
ok('⑥ notifyTaskState 出口仍 sendTaskState', /export function notifyTaskState[\s\S]*sendTaskState\(\)/.test(gc))

console.log('—— useTasksV2.ts 上报出口 ——')
const uv = readFileSync('src/hooks/useTasksV2.ts', 'utf-8')
ok('⑦ #report 单源出口未动（getSnapshot ?? []）', uv.includes('notifyTaskState(this.getSnapshot() ?? [])'))

console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`)
if (fails.length) {
  console.log('失败项：\n - ' + fails.join('\n - '))
  process.exit(1)
}
