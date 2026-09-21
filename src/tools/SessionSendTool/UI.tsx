import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import { jsonParse } from '../../utils/slowOperations.js'
import type { Input, SessionSendOutput } from './SessionSendTool.js'

/** 工具行：只显示目标，不显示正文（正文可能是长消息，塞进工具行会刷屏）。
 *  新建会话形态（2026-09-20）显示「＋ 新会话 · <项目>」——与既有「→ 会话 <目标>」区分开。 */
export function renderToolUseMessage(input: Partial<Input>): React.ReactNode {
  if (input.new_session === true) {
    return typeof input.project === 'string' && input.project ? `＋ 新会话 · ${input.project}` : '＋ 新会话'
  }
  return typeof input.to === 'string' && input.to ? `→ 会话 ${input.to}` : null
}

export function renderToolResultMessage(
  content: SessionSendOutput | string,
  _progressMessages: unknown,
  { verbose: _verbose }: { verbose: boolean },
): React.ReactNode {
  const result: SessionSendOutput =
    typeof content === 'string' ? jsonParse(content) : content
  return (
    <MessageResponse>
      <Text dimColor>{result.message}</Text>
    </MessageResponse>
  )
}
