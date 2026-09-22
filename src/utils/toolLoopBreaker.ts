/**
 * 2026-09-12 工具循环熔断器。
 *
 * 事故原型（pj18-初始化接力，2026-09-12）：模型 glm-5.3-flash 每轮零思考零文本、纯复读
 * 同一条 TaskUpdate(taskId:5, status:in_progress) 754 次 / 2h41m（约 20s 一轮），每次结果恒为
 * 「Updated task #5」成功＝链路上没有任何失败信号可以打断，自回归复读锁死。根治即在引擎
 * 生成循环内对此判定并收口回合。
 *
 * 判据三维（任一触发即熔断）：
 * ① 同名同参（tool 名 + JSON.stringify(input) 全等）连续调用达 TOOL_LOOP_BREAKER_LIMIT
 *    次。任何不同调用（换工具或换参数）即重置计数——正常工作流中「逐字重发同一条调用」连续
 *    5 次不存在（重试场景参数几乎总会变，如 off-by-one 修正、路径改正）。
 * ② 连续 TOOL_FAMILY_BATCH_LIMIT 轮「含簿记批」（每批至少 1 个簿记家族调用，任何实质工具
 *    出现即清零）达阈值即熔断。病理 = 跨轮持续簿记不干活（pj15-网传状态：TaskCreate 666+
 *    次参数次次不同、跨轮不停，thinking 自认循环求停而输出照吐）。
 * ③ 单批内簿记调用达 TOOL_FAMILY_FLOOD_LIMIT 次即熔断。病理 = pj15 洪水的单轮形态
 *    （单轮 333 个 TaskCreate），首轮第 40 个即拦，不再放行数百个。
 *
 * 2026-09-18 晚重设计（消除维度②误伤）：原维度②「簿记家族连续 8 次调用」把「量」当病理
 * 信号，误伤正常流——实锤现场（2beb0073，09-18 14:22）：会话开工建 10 个任务的大计划，
 * TaskCreate 单批 10 连在第 8 个撞线、后 3 个被拦、回合收口。正常流的合法形态恰是「单批
 * 大批量突发后立即进入实质工具」；真正的病理信号是「持续性」（跨轮簿记不停）与「单轮
 * 超大量」（数百个）。故②改为按「含簿记批连击」计数（单批突发只算 1 轮、实质工具清零），
 * ③补单轮洪水
 * 维度。阈值跨度依据：正常单批突发 ≤ 30（超大清单一次建完罕见），洪水单轮 300+。
 *
 * 纯状态机、零依赖：调用方（query.ts 生成循环）在每批 tool_use 执行前调
 * toolLoopBreakerBeginBatch 划批，再逐块喂入 toolLoopBreakerCheck；达到阈值的块及其后缀
 * 全部不执行、由调用方合成 error tool_result 并收口回合（1:1 映射防孤儿 tool_use）。
 */

/** 熔断阈值①：同名同参连续出现此次数即判定复读死循环（2026-09-12 用户定案 5 次）。 */
export const TOOL_LOOP_BREAKER_LIMIT = 5

/**
 * 熔断阈值②：连续「含簿记批」（每批至少 1 个簿记家族调用，实质工具出现即清零）达此次数
 * 即判定任务刷屏退化（2026-09-22 由 4 上调至 10）。单批内的大批量突发（如一次建 10-30 个
 * 任务的大计划）只算 1 轮、随后即被实质工具清零，不触发本判据。
 *
 * 2026-09-22 上调：4 轮把「开工先建 3 个任务、再起 1 个」这类正常节奏误判成退化
 * （TaskCreate×3 + TaskUpdate×1 逐块各成一批 ⇒ familyBatchStreak 直接到 4 撞线，实质工具
 * 一个都还没跑）。正常开工轮的簿记量本就与清单长度同阶，阈值必须高于「建单+起步」的跨度；
 * 真正的病理形态是 pj15 那种跨轮几十上百轮簿记不停，10 轮仍是高倍余量。
 */
export const TOOL_FAMILY_BATCH_LIMIT = 10

/**
 * 熔断阈值③：单批内簿记调用达此次数即判定单轮簿记洪水（2026-09-18 定案 40 次；
 * pj15 事故形态为单轮 333 个，正常大计划 ≤ 30）。
 */
export const TOOL_FAMILY_FLOOD_LIMIT = 40

/**
 * 簿记家族：任务清单工具。TaskStop/TaskOutput 是后台任务操作（kill/读输出），不属
 * 「清单簿记刷屏」形态，不入族。
 */
const BOOKKEEPING_TOOLS = new Set([
  'TaskCreate',
  'TaskUpdate',
  'TaskGet',
  'TaskList',
  'TodoWrite',
])

export type ToolLoopBreakerState = {
  /** 上一块调用的签名（name + '\u0000' + JSON.stringify(input)），无 → null */
  lastSig: string | null
  /** 与上一块签名相同的连续计数（含当前块） */
  streak: number
  /** 连续「含簿记批」计数（任何实质工具调用清零；每批首个簿记调用 +1，批内只计一次） */
  familyBatchStreak: number
  /** 本批内簿记调用计数（beginBatch 清零；批内实质工具清零） */
  batchFamCalls: number
}

export function createToolLoopBreakerState(): ToolLoopBreakerState {
  return { lastSig: null, streak: 0, familyBatchStreak: 0, batchFamCalls: 0 }
}

export type ToolLoopBreakerKind = 'identical' | 'familyBatch' | 'familyFlood'

/**
 * 批边界：调用方在每批（单个 assistant 消息的 tool_use 块组）喂入 check 前调用一次。
 * 只重置批内簿记计数；维度①（同名同参）刻意跨批累计——复读死循环的复读就跨批。
 */
export function toolLoopBreakerBeginBatch(state: ToolLoopBreakerState): void {
  state.batchFamCalls = 0
}

/**
 * 喂入一个待执行的 tool_use，更新状态并给出是否熔断。有副作用（更新 state）——
 * 每块只许喂一次，调用方必须按执行顺序逐块喂入，且每批开始前先 beginBatch。
 */
export function toolLoopBreakerCheck(
  state: ToolLoopBreakerState,
  name: string,
  input: unknown,
): { blocked: boolean; streak: number; kind: ToolLoopBreakerKind } {
  // 维度②③先判：家族计数只看工具名，与参数可序列化与否无关
  if (BOOKKEEPING_TOOLS.has(name)) {
    state.batchFamCalls++
    if (state.batchFamCalls === 1) state.familyBatchStreak++
    if (state.familyBatchStreak >= TOOL_FAMILY_BATCH_LIMIT) {
      return { blocked: true, streak: state.familyBatchStreak, kind: 'familyBatch' }
    }
    if (state.batchFamCalls >= TOOL_FAMILY_FLOOD_LIMIT) {
      return { blocked: true, streak: state.batchFamCalls, kind: 'familyFlood' }
    }
  } else {
    state.familyBatchStreak = 0
    state.batchFamCalls = 0
  }

  // 维度①：同名同参逐字复读
  let sig: string
  try {
    sig = name + '\u0000' + JSON.stringify(input)
  } catch {
    // input 不可序列化（循环引用等）——视为不同调用，重置计数，绝不误熔断
    state.lastSig = null
    state.streak = 1
    return { blocked: false, streak: 1, kind: 'identical' }
  }
  if (sig === state.lastSig) {
    state.streak++
  } else {
    state.lastSig = sig
    state.streak = 1
  }
  if (state.streak >= TOOL_LOOP_BREAKER_LIMIT) {
    return { blocked: true, streak: state.streak, kind: 'identical' }
  }
  return { blocked: false, streak: state.streak, kind: 'identical' }
}
