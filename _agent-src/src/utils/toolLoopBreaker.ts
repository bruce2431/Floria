/**
 * 2026-09-12 工具循环熔断器。
 *
 * 事故原型（pj18-初始化接力，2026-09-12）：模型 glm-5.3-flash 每轮零思考零文本、纯复读
 * 同一条 TaskUpdate(taskId:5, status:in_progress) 754 次 / 2h41m（约 20s 一轮），每次结果恒为
 * 「Updated task #5」成功＝链路上没有任何失败信号可以打断，自回归复读锁死。根治即在引擎
 * 生成循环内对此判定并收口回合。
 *
 * 判据：同名同参（tool 名 + JSON.stringify(input) 全等）连续调用达 TOOL_LOOP_BREAKER_LIMIT
 * 次。任何不同调用（换工具或换参数）即重置计数——正常工作流中「逐字重发同一条调用」连续
 * 5 次不存在（重试场景参数几乎总会变，如 off-by-one 修正、路径改正）。
 *
 * 纯状态机、零依赖：调用方（query.ts 生成循环）在每批 tool_use 执行前逐块喂入，达到阈值
 * 的块及其后缀全部不执行、由调用方合成 error tool_result 并收口回合（1:1 映射防孤儿
 * tool_use）。
 */

/** 熔断阈值：同名同参连续出现此次数即判定复读死循环（2026-09-12 用户定案 5 次）。 */
export const TOOL_LOOP_BREAKER_LIMIT = 5

export type ToolLoopBreakerState = {
  /** 上一块调用的签名（name + '\u0000' + JSON.stringify(input)），无 → null */
  lastSig: string | null
  /** 与上一块签名相同的连续计数（含当前块） */
  streak: number
}

export function createToolLoopBreakerState(): ToolLoopBreakerState {
  return { lastSig: null, streak: 0 }
}

/**
 * 喂入一个待执行的 tool_use，更新状态并给出是否熔断。有副作用（更新 state）——
 * 每块只许喂一次，调用方必须按执行顺序逐块喂入。
 */
export function toolLoopBreakerCheck(
  state: ToolLoopBreakerState,
  name: string,
  input: unknown,
): { blocked: boolean; streak: number } {
  let sig: string
  try {
    sig = name + '\u0000' + JSON.stringify(input)
  } catch {
    // input 不可序列化（循环引用等）——视为不同调用，重置计数，绝不误熔断
    state.lastSig = null
    state.streak = 1
    return { blocked: false, streak: 1 }
  }
  if (sig === state.lastSig) {
    state.streak++
  } else {
    state.lastSig = sig
    state.streak = 1
  }
  return { blocked: state.streak >= TOOL_LOOP_BREAKER_LIMIT, streak: state.streak }
}
