/**
 * gatewayQueueNudgeHandle.ts —— 排队消息「催办」的 REPL 侧句柄（2026-09-10）。
 *
 * 用户在 web 排队区点击某条排队气泡 = 「这条我等不及了」。网关把 web 前端的
 * {type:'queue-nudge', sessionId} 按会话精确路由给在线 CLI 进程（/clients WS），
 * gatewayClient（React 树外）收到后经本模块 invoke 到 REPL 侧注册的 handler。
 * handler 在 REPL 内注册并判活：有在飞生成（abortController 存活）且队列里确有
 * 可被本轮 drain 纳入的用户消息，才置位催办标记。
 *
 * 落地不在本模块：标记经 messageQueueManager 的 peekQueueNudge/consumeQueueNudge
 * 被 query.ts 的生成流读取 —— 断流（generation 级，非回合级 abort）后本轮 drain
 * 把排队消息纳入当前轮次，与「模型自然答完后排队消息被纳入」同一条路径。
 * 仿 gatewayInterruptHandle.ts / controlOverrideHandle.ts 的「模块级全局 + set/get」
 * 模式，供 React 树外代码调用。
 */

let handler: (() => void) | null = null

export function setGatewayQueueNudgeHandle(h: (() => void) | null): void {
  handler = h
}

/** gatewayClient 收到网关 queue-nudge 消息时调用；未挂载（headless 无 REPL）时静默忽略。 */
export function invokeGatewayQueueNudge(): void {
  if (!handler) return
  try {
    handler()
  } catch {
    /* 忽略：催办失败不影响 REPL，排队消息照常等自然投递 */
  }
}
