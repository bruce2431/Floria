// OAuth 订阅线路已移除：无「计费为 extra usage」的情形
export function isBilledAsExtraUsage(
  _model: string | null,
  _isFastMode: boolean,
  _isOpus1mMerged: boolean,
): boolean {
  return false
}
