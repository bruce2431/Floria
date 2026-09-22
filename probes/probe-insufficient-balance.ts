/**
 * 探针：402 余额不足错误 → 中文充值提示。
 *
 * 不变量：第三方 OpenAI 兼容端点（DeepSeek / GLM 等）余额不足时返回
 * 402 + 正文 "Insufficient Balance"，getAssistantMessageFromError 必须把它
 * 归一为 INSUFFICIENT_BALANCE_ERROR_MESSAGE（渲染键，CLI 端 AssistantTextMessage
 * 按精确文案渲红字），而不是透出 `API Error: 402 {…JSON…}`。
 *
 * 负向不变量：不含该标记的其它 402/错误必须保持原样（不做兜底猜测）。
 *
 * 用法：bun probes/probe-insufficient-balance.ts
 */
import { APIError } from '@anthropic-ai/sdk'
import {
  getAssistantMessageFromError,
  INSUFFICIENT_BALANCE_ERROR_MESSAGE,
  isInsufficientBalanceError,
} from '../src/services/api/errors.js'

let pass = 0
let fail = 0
function check(name: string, ok: boolean, extra?: string): void {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

function textOf(msg: ReturnType<typeof getAssistantMessageFromError>): string {
  const c = msg.message.content
  return Array.isArray(c) && c[0]?.type === 'text' ? c[0].text : ''
}

const realBody = {
  error: {
    message: 'Insufficient Balance',
    type: 'unknown_error',
    param: null,
    code: 'invalid_request_error',
  },
}
const realMessage =
  '402 ' + JSON.stringify(realBody)

console.log('[1] 真实 402 串（DeepSeek 形态）')
const err = new APIError(402, realBody, realMessage, undefined)
const msg = getAssistantMessageFromError(err, 'deepseek-chat')
check('isInsufficientBalanceError 命中', isInsufficientBalanceError(err))
check(
  'content = 余额不足请充值',
  textOf(msg) === INSUFFICIENT_BALANCE_ERROR_MESSAGE,
  `实际 = ${JSON.stringify(textOf(msg))}`,
)
check('error 分类 = billing_error', msg.error === 'billing_error')
check('isApiErrorMessage = true', msg.isApiErrorMessage === true)

console.log('[2] 大小写变体 / 非 APIError 包装')
const upper = new Error('API Error: 402 {"message":"INSUFFICIENT BALANCE"}')
check(
  '大写标记同样命中',
  textOf(getAssistantMessageFromError(upper, 'glm-4.5')) ===
    INSUFFICIENT_BALANCE_ERROR_MESSAGE,
)

console.log('[3] 负向：无关 402 / 无关 400 不误伤')
const other402 = new APIError(
  402,
  { error: { message: 'Payment required for this feature' } },
  '402 {"error":{"message":"Payment required for this feature"}}',
  undefined,
)
const otherText = textOf(getAssistantMessageFromError(other402, 'x'))
check(
  '其它 402 文案不被改写',
  otherText !== INSUFFICIENT_BALANCE_ERROR_MESSAGE,
  `实际 = ${JSON.stringify(otherText)}`,
)
const plain400 = new APIError(
  400,
  { error: { message: 'bad request' } },
  '400 {"error":{"message":"bad request"}}',
  undefined,
)
check(
  '普通 400 不受影响',
  textOf(getAssistantMessageFromError(plain400, 'x')) !==
    INSUFFICIENT_BALANCE_ERROR_MESSAGE,
)

console.log(`\n结果：${pass} pass / ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
