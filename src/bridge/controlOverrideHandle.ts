/**
 * controlOverrideHandle.ts —— 网关控制消息的全局处理器（2026-08-22 模型/思考等级切换）。
 *
 * 网关 POST /gateway/model 把「实时控制」按会话路由给在线 CLI 进程，gatewayClient（React 树外）收到
 * {type:'model'|'effort'} 后经本模块 invoke 到 REPL 侧注册的 handler；handler 在
 * GatewayControlBridge 组件（replLauncher 内，React Provider 之下）挂载，内部有
 * useSetAppState + setMainLoopModelOverride，与官方 useReplBridge.onSetModel 同一套语义：
 *  - model  → 清除 override（模型源=凭据池，网关已写盘）+ setAppState({ mainLoopModel, mainLoopModelForSession: null })
 *  - effort → setAppState({ effortValue })
 *  - rename → 网关 /gateway/session/rename 后按会话路由给在线 CLI，更新内存标题缓存 + 输入栏徽标
 *    （2026-08-25 web 重命名 → CLI 实时同步，见 GatewayControlBridge）
 * 仿 replBridgeHandle.ts 的「模块级全局 + set/get」模式，供 React 树外代码调用。
 */

export type ControlOverrideKind = 'model' | 'effort' | 'rename'

type ControlOverrideHandler = (kind: ControlOverrideKind, value: unknown) => void

let handler: ControlOverrideHandler | null = null

export function setControlOverrideHandle(h: ControlOverrideHandler | null): void {
  handler = h
}

/** gatewayClient 收到网关控制消息时调用；未挂载（非 REPL 进程）时静默忽略。 */
export function invokeControlOverride(kind: ControlOverrideKind, value: unknown): void {
  try {
    handler?.(kind, value)
  } catch {
    /* 忽略：控制消息失败不影响 REPL */
  }
}
