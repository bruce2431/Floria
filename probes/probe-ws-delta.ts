/**
 * probe-ws-delta.ts —— 2026-09-10 网关 session-delta SSE 群发直测
 * 自接 /clients WS（假 sid=probe-delta-sid 防污染真会话 seq 记账），发两条手工 session-delta：
 *   ① 小载荷（1 条消息）seq 999999
 *   ② 大载荷（250 条 × 8KB 文本 ≈ 2MB）seq 1000000
 * 同时另一终端抓 /gateway/events SSE。若 SSE 出帧 = 网关 handler 正常，嫌疑回到 CLI 实发帧
 * 与观测差异（如载荷尺寸）；不出帧 = 网关 handler/WS 接收层有缺陷。
 * token 从环境变量 GW_TOKEN 传入。
 */
const TOKEN = process.env.GW_TOKEN || ''
const sid = 'probe-delta-sid'
const ws = new WebSocket(`ws://127.0.0.1:8124/clients?token=${TOKEN}&session=${sid}`)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

ws.addEventListener('open', async () => {
  console.log('WS open')
  // ① 小载荷
  ws.send(JSON.stringify({
    type: 'session-delta', seq: 999999, base: 0,
    messages: [{ role: 'system', blocks: [{ kind: 'text', text: 'PROBE-DELTA-MARKER-SMALL' }] }],
  }))
  console.log('small delta sent')
  await sleep(2000)
  // ② 大载荷 ≈2MB
  const big = Array.from({ length: 250 }, (_, i) => ({
    role: 'assistant', blocks: [{ kind: 'text', text: 'x'.repeat(8000) + '#' + i }], uuid: 'probe' + i,
  }))
  ws.send(JSON.stringify({ type: 'session-delta', seq: 1000000, base: 0, messages: big }))
  console.log('big delta sent (~' + Math.round(JSON.stringify(big).length / 1024) + 'KB)')
  await sleep(2000)
  ws.close()
  console.log('closed, done')
  process.exit(0)
})
ws.addEventListener('error', (e) => { console.log('WS error', (e as ErrorEvent).message || e); process.exit(1) })
ws.addEventListener('close', () => console.log('WS closed'))
