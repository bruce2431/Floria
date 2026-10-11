import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Text } from '../../ink.js'
import { jsonParse } from '../../utils/slowOperations.js'
import type { CardCallOutput, Input } from './CardCallTool.js'

/** 工具行：list 只显「卡片列表」；call 显示寻址 + 命令名（正文/参数不塞进工具行，防刷屏）。 */
export function renderToolUseMessage(input: Partial<Input>): React.ReactNode {
  if (input.action !== 'call') return '卡片列表'
  const where = input.instanceId || input.label || input.ns || '任意卡'
  return typeof input.cmd === 'string' && input.cmd ? `→ 卡 ${where} · ${input.cmd}` : `→ 卡 ${where}`
}

export function renderToolResultMessage(
  content: CardCallOutput | string,
  _progressMessages: unknown,
  { verbose: _verbose }: { verbose: boolean },
): React.ReactNode {
  const result: CardCallOutput = typeof content === 'string' ? jsonParse(content) : content
  return (
    <MessageResponse>
      <Text dimColor>{result.message}</Text>
    </MessageResponse>
  )
}
