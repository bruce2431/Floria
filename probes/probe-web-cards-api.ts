#!/usr/bin/env bun
/**
 * probe-web-cards-api —— 卡片公开 API 的接线完整性 + 契约字面量一致性（2026-10-11）
 *
 * 卡片公开 API 是一条**跨四层**的链：卡（iframe）→ 宿主总线（web-src/engine/card-bus.js）→
 * 前端网关客户端（engine/gateway.js）→ 网关注册/路由（src/gateway/localGateway.ts）→ agent 工具
 * （src/tools/CardCallTool）。这条链最容易出的错不是逻辑，而是**某一侧改了字面量而另一侧没跟**
 * （帧型 `card-caps`/`card-call`/`card-result`、保留前缀 `floria-card-call`/`floria-card-result`、
 * 寻址键、HTTP 状态码）——单侧看都对，连起来静默不通。本探针把这些字面量与挂点锁死。
 *
 * 只读结构探针（不启动浏览器/网关）：读源文件 + 正则断言。真值表覆盖「信封 → 归属」的判定规则。
 */
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const ROOT = resolve(import.meta.dir, '..')
let pass = 0
let fail = 0
const ok = (m: string) => {
  pass++
  console.log(`PASS  ${m}`)
}
const bad = (m: string) => {
  fail++
  console.log(`FAIL  ${m}`)
}

const read = (rel: string): string => {
  const p = resolve(ROOT, rel)
  if (!existsSync(p)) {
    bad(`缺少文件 ${rel}`)
    return ''
  }
  return readFileSync(p, 'utf-8')
}

const bus = read('src/gateway/web-src/engine/card-bus.js')
const gwJs = read('src/gateway/web-src/engine/gateway.js')
const gwTs = read('src/gateway/localGateway.ts')
const gwc = read('src/utils/gatewayClient.ts')
const tool = read('src/tools/CardCallTool/CardCallTool.ts')
const toolsIndex = read('src/tools.ts')
const buildTs = read('scripts/build.ts')
const bundleTs = read('scripts/bundle-web-modules.ts')

// ---------- A. 总线（card-bus.js）----------
if (/const cardBus = \(function/.test(bus)) ok('总线为单 IIFE，唯一顶层名 cardBus')
else bad('card-bus.js 未发现单 IIFE 顶层名 cardBus')

// 单顶层名：全文只应有一次「顶层 const cardBus」
const busTopDecl = (bus.match(/^const cardBus\b/gm) || []).length
if (busTopDecl === 1) ok('card-bus.js 顶层 cardBus 声明恰 1 处（无静默同名覆盖）')
else bad(`card-bus.js 顶层 cardBus 声明 ${busTopDecl} 处（应恰 1）`)

// 信封：宿主→卡 = `<ns>-cmd`；卡→宿主 = `<ns>-event`（后缀 6 字符切片）
if (bus.includes('`${f.ns}-cmd`') && bus.includes("type: `${f.ns}-cmd`")) ok('宿主→卡信封 = `${f.ns}-cmd`')
else bad('宿主→卡信封 `${f.ns}-cmd` 缺失')
if (bus.includes("d.type.slice(-6) !== '-event'") && '-event'.length === 6) ok("卡→宿主信封判定 = type 后缀 '-event'（6 字符切片）")
else bad("卡→宿主信封判定 slice(-6)!=='-event' 缺失")

// 跨卡保留前缀（宿主 brokered）：认 call、回 result
if (bus.includes("d.type === 'floria-card-call'")) ok('跨卡请求前缀 floria-card-call 被总线识别')
else bad('总线未识别 floria-card-call')
if (bus.includes("type: 'floria-card-result'")) ok('跨卡回执前缀 floria-card-result 由总线发出')
else bad('总线未发出 floria-card-result')

// ack 配对键 = cmd（串行队列下与 queue[0].cmd 比对，不用 callId）
if (/ev === 'ack'/.test(bus) && /f\.queue\[0\]\.cmd/.test(bus)) ok('ack 配对键 = cmd（与在途 queue[0] 比对）')
else bad('ack 配对（ev===\'ack\' + queue[0].cmd）缺失')

// 未注册命令显式报错（不静默）
if (bus.includes('未注册的命令')) ok('未注册命令显式回 ok:false（不静默）')
else bad('未注册命令未显式报错')

// 导出面：11 个公开 API
for (const api of [
  'addCardEventListener',
  'callCard',
  'frames',
  'handleGatewayCall',
  'listCaps',
  'registerFrame',
  'registerInlineCard',
  'reportCaps',
  'setGatewaySender',
  'setSourceOpener',
  'unregisterFrame',
]) {
  // 导出对象里出现 `<api>,` 或 `<api>:` 或 `frames:`
  if (new RegExp(`(^|\\s)${api}[,:]`, 'm').test(bus)) continue
  bad(`总线导出面缺 ${api}`)
}
ok('总线导出面 11 个 API 齐备')

// ---------- B. 帧挂点 ----------
const preview = read('src/gateway/web-src/feature/preview-frame.js')
if (/from '\.\.\/engine\/card-bus\.js'/.test(preview) && /cardBus\.registerFrame\(/.test(preview) && /cardBus\.unregisterFrame\(/.test(preview))
  ok('预览帧 preview-frame.js：注册 + 注销（一处覆盖 slot/work 两消费方）')
else bad('预览帧挂点缺注册/注销或 import')

const extCard = read('src/gateway/web-src/views/cards/ext/ext-card.js')
if (/from '\.\.\/\.\.\/\.\.\/engine\/card-bus\.js'/.test(extCard) && /cardBus\.registerFrame\(/.test(extCard) && /cardBus\.unregisterFrame\(/.test(extCard))
  ok('外置卡 ext-card.js：注册 + 注销')
else bad('外置卡挂点缺注册/注销或 import')

const workMount = read('src/gateway/web-src/sidebar/work/work-mount.js')
if (/cardBus\.setSourceOpener\(/.test(workMount)) ok('work-mount.js 注入 setSourceOpener（src-open → 打开文件 + 定位行）')
else bad('work-mount.js 未注入 setSourceOpener')

const workFacade = read('src/gateway/web-src/sidebar/work.js')
if (/from '\.\.\/engine\/card-bus\.js'/.test(workFacade)) ok('sidebar/work.js 门面持有 cardBus import（拆件不带 import）')
else bad('sidebar/work.js 门面缺 cardBus import')

// ---------- C. 前端网关客户端（gateway.js）----------
if (/from '\.\/card-bus\.js'/.test(gwJs) && /cardBus\.setGatewaySender\(/.test(gwJs)) ok('gateway.js 注入 setGatewaySender（唯一 WS 上行口）')
else bad('gateway.js 未注入 setGatewaySender')
if (/cardBus\.reportCaps\(\)/.test(gwJs)) ok('gateway.js onopen 补报能力表')
else bad('gateway.js onopen 未补报能力表')
if (/msg\.type === 'card-call'/.test(gwJs) && /cardBus\.handleGatewayCall\(msg\)/.test(gwJs)) ok("gateway.js 收 'card-call' → cardBus.handleGatewayCall")
else bad("gateway.js 未接 'card-call'")

// ---------- D. 网关后端（localGateway.ts）----------
if (gwTs.includes("case 'card-caps'") && gwTs.includes("case 'card-result'")) ok("网关 WS 处理 card-caps / card-result 两帧")
else bad('网关缺 card-caps / card-result case')
if (gwTs.includes("type: 'card-call'")) ok("网关下行帧型 = 'card-call'")
else bad("网关下行帧型 card-call 缺失")
if (gwTs.includes("url.pathname === '/gateway/cards'") && gwTs.includes("url.pathname === '/gateway/card-call'"))
  ok('网关路由 GET /gateway/cards + POST /gateway/card-call')
else bad('网关缺 /gateway/cards 或 /gateway/card-call 路由')
// 状态码真值表：503 无浏览器 / 409 卡不在场 / 504 超时或断开 / 200 ok:false（卡内失败）
if (/sendJson\(res, 503, \{ error: '当前无浏览器在线/.test(gwTs)) ok('无浏览器在线 → 503')
else bad('缺 503 无浏览器分支')
if (/sendJson\(res, 409, \{ error: '目标卡不在场'/.test(gwTs)) ok('目标卡不在场 → 409（附当场能力表）')
else bad('缺 409 卡不在场分支')
if ((gwTs.match(/sendJson\(res, 504,/g) || []).length >= 2) ok('卡超时 / 设备断开 → 504')
else bad('缺 504 分支')
if (gwTs.includes('sendJson(res, 200, { ok: false, error: ccOut.error, card: ccWhere })')) ok('卡内命令失败 → HTTP 200 ok:false（非传输错误）')
else bad('卡内命令失败未走 200 ok:false')

// ---------- E. 工具侧 ----------
for (const f of ['CardCallTool.ts', 'constants.ts', 'prompt.ts', 'UI.tsx']) {
  if (!existsSync(resolve(ROOT, 'src/tools/CardCallTool', f))) bad(`缺 src/tools/CardCallTool/${f}`)
}
ok('CardCallTool 四件齐备（Tool/constants/prompt/UI）')
if (/CARD_CALL_TOOL_NAME = 'CardCall'/.test(read('src/tools/CardCallTool/constants.ts'))) ok("工具名常量 = 'CardCall'")
else bad("CARD_CALL_TOOL_NAME 不是 'CardCall'")
if (/feature\('CARD_API'\) \? true : false/.test(tool)) ok("工具 isEnabled 门控 feature('CARD_API')（宏处三元位）")
else bad("工具 isEnabled 缺 feature('CARD_API') 门控")
if (/getCardCallTool/.test(toolsIndex) && /getCardCallTool\(\),/.test(toolsIndex)) ok('src/tools.ts 登记 CardCall（懒加载 + getAllBaseTools 展开）')
else bad('src/tools.ts 未登记 CardCall')
if (/'CARD_API'/.test(buildTs) && /const defaultFeatures = \[[^\]]*'CARD_API'/.test(buildTs)) ok("build.ts defaultFeatures 含 'CARD_API'")
else bad("build.ts defaultFeatures 未含 'CARD_API'（工具将永不注册）")
if (/export async function listGatewayCards/.test(gwc) && /export async function callGatewayCard/.test(gwc)
  && gwc.includes('/gateway/cards') && gwc.includes('/gateway/card-call'))
  ok('gatewayClient 提供 listGatewayCards / callGatewayCard（写死两条网关路由）')
else bad('gatewayClient 缺 listGatewayCards / callGatewayCard 或路由')

// ---------- F. 拼接表 + cache-bust ----------
if (/file: 'engine\/card-bus\.js'/.test(bundleTs)) ok('bundle-web-modules PIECES 含 engine/card-bus.js')
else bad('PIECES 缺 engine/card-bus.js（符号不进 app.js）')

const indexHtml = read('src/gateway/web/index.html')
const swJs = read('src/gateway/web/sw.js')
const htmlV = indexHtml.match(/\/app\.js\?v=(\d+)/)?.[1]
const swV = swJs.match(/floria-v(\d+)/)?.[1]
if (htmlV && swV && htmlV === swV) ok(`cache-bust 版本一致（index app.js?v=${htmlV} == sw floria-v${swV}）`)
else bad(`cache-bust 版本不一致（index=${htmlV} sw=${swV}）`)

console.log(`\n${pass}/${fail}`)
process.exit(fail === 0 ? 0 : 1)
