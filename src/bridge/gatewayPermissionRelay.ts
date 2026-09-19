import type { BridgePermissionCallbacks } from './bridgePermissionCallbacks.js'

/**
 * gatewayPermissionRelay.ts —— 网关权限回调的模块级注册表（2026-08-24）。
 *
 * 与 controlOverrideHandle 同款「全局 handler」模式：gatewayClient.ts（CLI 进程内、
 * React 树外，持有 /clients WS）在连接建立时 setGatewayPermissionCallbacks(impl)，
 * 断开时清除；React 树内 useCanUseTool（交互权限弹窗点）读取 getGatewayPermissionCallbacks()
 * 传给 handleInteractivePermission 的 bridgeCallbacks 参数 —— 本地终端弹窗与 floria
 * 审批卡竞速（claim()），先操作者生效，两端均可操作。
 */
let gatewayPermissionCallbacks: BridgePermissionCallbacks | null = null

export function setGatewayPermissionCallbacks(
  callbacks: BridgePermissionCallbacks | null,
): void {
  gatewayPermissionCallbacks = callbacks
}

export function getGatewayPermissionCallbacks(): BridgePermissionCallbacks | null {
  return gatewayPermissionCallbacks
}
