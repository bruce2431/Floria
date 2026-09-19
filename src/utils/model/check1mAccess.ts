import { is1mContextDisabled } from '../context.js'

// OAuth 订阅分支已移除：非订阅者（API/PAYG）直接放行
// @[MODEL LAUNCH]: Add check if the new model supports 1M context
export function checkOpus1mAccess(): boolean {
  return !is1mContextDisabled()
}

export function checkSonnet1mAccess(): boolean {
  return !is1mContextDisabled()
}
