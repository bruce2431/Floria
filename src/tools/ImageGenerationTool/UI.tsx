import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import type { Output } from './ImageGenerationTool.js'

/**
 * CLI 渲染面（与 WebSearch / Bash / Brief / FileRead 同款 `UI.tsx` 分离）。
 *
 * Ink 要求文本必须落在 `<Text>` 内。`UserToolSuccessMessage` 把
 * `renderToolResultMessage` 的返回值裸插进 `<Box>`（`UserToolErrorMessage` /
 * `UserToolRejectMessage` 亦为组件根节点直返）——返回裸字符串会抛
 * "Text string … must be rendered inside <Text> component" 崩掉整棵渲染树。
 * 故这三个 render* 一律返回 React 元素。
 */
export function renderToolResultMessage(output: Output): React.ReactNode {
  return (
    <MessageResponse>
      <Text>{output.text}</Text>
    </MessageResponse>
  )
}

export function renderToolUseRejectedMessage(): React.ReactNode {
  return (
    <MessageResponse>
      <Text>生图已取消</Text>
    </MessageResponse>
  )
}

export function renderToolUseErrorMessage(): React.ReactNode {
  return (
    <MessageResponse>
      <Text>生图出错</Text>
    </MessageResponse>
  )
}
