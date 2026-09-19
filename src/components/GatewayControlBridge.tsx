/**
 * GatewayControlBridge.tsx —— 网关模型/思考等级/重命名控制消息的 REPL 侧处理器（2026-08-22）。
 *
 * 在 replLauncher 的 <REPL> 旁挂载（AppStateProvider 之下）。挂载时注册全局 handler，
 * gatewayClient 收到网关按会话路由的 {type:'model'|'effort'|'rename'} 后 invoke，这里落地到真实 CLI 状态：
 *  - model  → 每会话覆盖（官方 onSetModel 语义）：setMainLoopModelOverride(resolved ?? undefined)
 *    + setAppState({ mainLoopModelForSession: resolved })，'default'/null → undefined 清除覆盖，
 *    回落读盘 getActiveModel()（凭据池）——只影响本会话，不写全局凭据池。
 *  - effort → setAppState({ effortValue })
 *  - rename → 更新内存标题缓存（terminal title / status line / 退出 re-append）+ 输入栏徽标
 *    （standaloneAgentContext.name，useSwarmBanner 渲染），2026-08-25 web 重命名实时同步。
 * 与官方 useReplBridge.onSetModel/onSetMaxThinkingTokens 同一套语义；卸载时清空 handler。
 */
import { useEffect } from 'react'
import { setMainLoopModelOverride } from '../bootstrap/state.js'
import { setControlOverrideHandle } from '../bridge/controlOverrideHandle.js'
import { reportCurrentModel } from '../utils/gatewayClient.js'
import { useSetAppState } from '../state/AppState.js'
import { applyExternalRename } from '../utils/sessionStorage.js'

export function GatewayControlBridge(): null {
  const setAppState = useSetAppState()
  useEffect(() => {
    setControlOverrideHandle((kind, value) => {
      if (kind === 'model') {
        const resolved = value == null || value === 'default' ? null : String(value)
        // 每会话覆盖（官方 onSetModel 语义）：setMainLoopModelOverride 更新模块级 STATE（getMainLoopModel
        // 实际 API 调用用），mainLoopModelForSession 更新 UI 显示；'default'/null 映射到 undefined（清除覆盖）
        // 而非官方 null——Pj16 模型源=凭据池，null 会让 getMainLoopModel 落到内置默认而非 getActiveModel()。
        setMainLoopModelOverride(resolved ?? undefined)
        setAppState(prev =>
          prev.mainLoopModelForSession === resolved
            ? prev
            : { ...prev, mainLoopModelForSession: resolved },
        )
        // 2026-08-24 模型 web/CLI 同步：切换后立即上报实际模型给网关（web 端读取校准）
        reportCurrentModel()
      } else if (kind === 'effort') {
        const v = value == null || value === 'auto' ? undefined : String(value)
        setAppState(prev => (prev.effortValue === v ? prev : { ...prev, effortValue: v }))
      } else if (kind === 'rename') {
        // 2026-08-25 web 重命名 → CLI 实时同步：网关已把 custom-title/agent-name 写入转录，
        // 这里只更新本进程内存缓存 + AppState，让输入栏徽标（useSwarmBanner）与 terminal
        // title / status line 立即反映新名字，无需重启 CLI。sessionId 不匹配时内部忽略。
        const rename = (value ?? {}) as { sessionId?: unknown; title?: unknown }
        const title = typeof rename.title === 'string' ? rename.title : ''
        const sessionId = typeof rename.sessionId === 'string' ? rename.sessionId : ''
        if (!title || !sessionId) return
        applyExternalRename(sessionId, title)
        setAppState(prev =>
          prev.standaloneAgentContext?.name === title
            ? prev
            : {
                ...prev,
                standaloneAgentContext: {
                  ...(prev.standaloneAgentContext ?? {}),
                  name: title,
                },
              },
        )
      }
    })
    return () => setControlOverrideHandle(null)
  }, [setAppState])
  return null
}
