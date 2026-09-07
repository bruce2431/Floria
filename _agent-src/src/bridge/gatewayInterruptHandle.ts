/**
 * gatewayInterruptHandle.ts —— web 打断按钮的 REPL 侧中断句柄（2026-09-04）。
 *
 * 网关把 web 前端的 {type:'interrupt', sessionId} 按会话精确路由给在线 CLI 进程（/clients WS），
 * gatewayClient（React 树外）收到后经本模块 invoke 到 REPL 侧注册的 handler。handler 在 REPL 内
 * 注册（有运行中回合或排队命令才生效，判活对齐 CancelRequestHandler），落地 onCancel() —— 与
 * CLI Ctrl+C（app:interrupt）完全同路径：abort('user-cancel') + 清权限弹窗/队列 + 保留部分流式文本。
 * 仿 controlOverrideHandle.ts 的「模块级全局 + set/get」模式，供 React 树外代码调用。
 */

let handler: (() => void) | null = null
// 2026-09-06 web 打断撤回链：打断来源标记（invoke 时置位，onCancel 经 consumeWebInterrupt 一次性
// 消费）。判活 no-op（无运行回合）未落到 onCancel 时标记靠时间窗自然失效，不残留误判本地 Ctrl+C。
let lastWebInterruptMark = 0

export function setGatewayInterruptHandle(h: (() => void) | null): void {
  handler = h
}

/** gatewayClient 收到网关 interrupt 消息时调用；未挂载（headless 无 REPL）时静默忽略。 */
export function invokeGatewayInterrupt(): void {
  // 本进程无运行回合（handler 未挂）= 本进程没有打断发生，不置位标记——
  // 否则闲 REPL 收到广播后紧随的本地 Ctrl+C 会被 5s 窗误判为 web 来源。
  if (!handler) return
  lastWebInterruptMark = Date.now()
  try {
    handler()
  } catch {
    /* 忽略：中断失败不影响 REPL */
  }
}

/**
 * 2026-09-06 web 打断撤回链：REPL onCancel 消费打断来源——5s 窗内有过 web 打断标记 = 本次打断
 * 源自 web 打断按钮（auto-restore 据此把文本回填导向 web 输入栏而非 CLI 输入框）。读后即清。
 */
export function consumeWebInterrupt(): boolean {
  const isWeb = lastWebInterruptMark > 0 && Date.now() - lastWebInterruptMark < 5000
  lastWebInterruptMark = 0
  return isWeb
}
