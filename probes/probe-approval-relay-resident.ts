/**
 * 探针：审批中继常驻化（2026-09-11 根治「网关断连窗口内弹出的审批永不中继」）
 *
 * 根因：原实现把 permissionCallbacks 注册挂在 sock.on('open')、清空挂在 sock.on('close')。
 * 断连窗口内出现的交互权限弹窗在 useCanUseTool 取到 null 回调 → interactiveHandler 直接
 * 跳过整个 bridge 分支（连 sendRequest 都不调用）→ 请求既不上报也不进 pendingApprovalRequests，
 * 之后任何重连补发都无据可依（09-11 实测：网关重启，弹窗会话在 /gateway/diagnostics 里
 * 零条 cli-approval-request）。
 *
 * 判据（同步、不依赖网络；startGatewayProbeAndConnect 未被调用 ⇒ 模块内 ws 恒为 null）：
 *  1. 模块加载后回调即非 null —— 断连窗口也能入待发表
 *  2. 重复读取为同一常驻对象 —— 不被连接生命周期替换
 *  3. 断连状态下 sendRequest / onResponse 退订 / sendResponse / cancelRequest 均不抛
 *  4. 源码静态核对：close 期清空已移除、顶层常驻注册存在
 *
 * 修前对照：① 必败（顶层无注册，回调只在 open 时出现），② 必败，③ 不可达（回调为 null）。
 *
 * 运行：cd _agent-src && bun probe-approval-relay-resident.ts
 */
import { readFileSync } from 'node:fs'
import { getGatewayPermissionCallbacks } from '../src/bridge/gatewayPermissionRelay.js'

let pass = 0
const fails: string[] = []
function ok(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    pass++
    console.log(`  \u2714 ${name}`)
    return
  }
  fails.push(name)
  console.log(`  \u2716 ${name}${extra ? '  ' + extra : ''}`)
}

console.log('—— 加载 gatewayClient（顶层副作用：常驻注册）——')
await import('../src/utils/gatewayClient.js')

const cb = getGatewayPermissionCallbacks()
ok('未连网关时回调非 null（断连窗口可入表）', cb !== null)

const cb2 = getGatewayPermissionCallbacks()
ok('重复读取为同一常驻对象', cb !== null && cb === cb2)

if (cb) {
  let threw = ''
  try {
    cb.sendRequest(
      'probe-approval-1',
      'Edit',
      { file_path: 'probe.md', old_string: 'a', new_string: 'b' },
      'tu-probe-1',
      'probe 描述',
    )
  } catch (e) {
    threw = String(e)
  }
  ok('断连状态下 sendRequest 不抛（静默入待发表）', threw === '', threw)

  let threw2 = ''
  try {
    const unsubscribe = cb.onResponse('probe-approval-1', () => {})
    unsubscribe()
    cb.sendResponse('probe-approval-1', { behavior: 'deny', message: 'probe' })
    cb.cancelRequest('probe-approval-1')
  } catch (e) {
    threw2 = String(e)
  }
  ok('断连下 onResponse 退订 / sendResponse / cancelRequest 均不抛', threw2 === '', threw2)
}

const src = readFileSync('src/utils/gatewayClient.ts', 'utf-8')
ok(
  '源码已无 close 期清空（setGatewayPermissionCallbacks(null)）',
  !src.includes('setGatewayPermissionCallbacks(null)'),
)
ok(
  '源码存在模块顶层常驻注册',
  /^setGatewayPermissionCallbacks\(permissionCallbacks\)$/m.test(src),
)

console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`)
if (fails.length) {
  console.log('失败项：\n - ' + fails.join('\n - '))
  process.exit(1)
}
