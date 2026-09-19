// 探针（只读）：核对网关落盘件四条路径 helper 全部指向 `.claude/gateway/`，
// 后端日志指向「该项目 .claude/preview/backend.log」。从源码文本提取字面量
// （不 import，避免依赖链），兼核 backendLogPath 签名与写点 mkdir。
// 用途：2026-09-19 落盘件归位改动的回归锚点（该改动曾被误回退一次）。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const tok = readFileSync(join(root, 'src/utils/gatewayToken.ts'), 'utf8')
const gw = readFileSync(join(root, 'src/gateway/localGateway.ts'), 'utf8')
const sv = readFileSync(join(root, 'src/commands/server/server.ts'), 'utf8')

const cases: Array<[string, boolean]> = [
  ['gatewayToken: gatewayDir 导出', /export function gatewayDir\(\)/.test(tok)],
  ['gatewayToken: gatewayDir = <root>/.claude/gateway', /join\(getPortableRoot\(\), '\.claude', 'gateway'\)/.test(tok)],
  ['gatewayToken: token', /tokenFilePath\(\): string \{\s*return join\(gatewayDir\(\), 'token'\)/.test(tok)],
  ['gatewayToken: port', /portFilePath = \(\) => join\(gatewayDir\(\), 'port'\)/.test(tok)],
  ['gatewayToken: tickets', /ticketsFilePath = \(\) => join\(gatewayDir\(\), 'tickets'\)/.test(tok)],
  ['gatewayToken: devices', /devicesFilePath = \(\) => join\(gatewayDir\(\), 'devices'\)/.test(tok)],
  ['localGateway: backends.json', /return join\(gatewayDir\(\), 'backends\.json'\)/.test(gw)],
  ['localGateway: websessions.json', /webSessionsRegistryPath = \(\): string => join\(gatewayDir\(\), 'websessions\.json'\)/.test(gw)],
  ['localGateway: turnend.json', /turnEndAtPath = \(\): string => join\(gatewayDir\(\), 'turnend\.json'\)/.test(gw)],
  ['localGateway: backendLogPath(cfg) 签名', /function backendLogPath\(cfg: BackendCfg\): string/.test(gw)],
  ['localGateway: 后端日志 = previewDir/backend.log', /join\(cfg\.previewDir \?\? [\s\S]{0,60}?'backend\.log'\)/.test(gw)],
  ['localGateway: BackendCfg.previewDir 字段', /previewDir\?: string/.test(gw)],
  ['localGateway: readBackendCfg 回填 previewDir', /readyPath:[^\n]*\n\s*previewDir,/.test(gw)],
  ['localGateway: spawn 前 mkdir 日志目录', /mkdirSync\(join\(logPath, '\.\.'\), \{ recursive: true \}\)/.test(gw)],
  ['localGateway: 就绪失败文案用 cfg', /backendLogPath\(cfg\)\}\`\)/.test(gw)],
  ['localGateway: 三处写点各 mkdir', (gw.match(/mkdirSync\(join\(p, '\.\.'\), \{ recursive: true \}\)/g) ?? []).length >= 3],
  ['server: gatewayLogPath = gatewayDir()/gateway.log', /return join\(gatewayDir\(\), 'gateway\.log'\)/.test(sv)],
  ['server: openGatewayLogFd 先 mkdir', /mkdirSync\(join\(p, '\.\.'\), \{ recursive: true \}\)/.test(sv)],
  ['server: 已移除未用 getPortableRoot', !/getPortableRoot/.test(sv)],
  ['旧路径字面量已清零（4 件内）', !/gateway-token|gateway-port|gateway-tickets|gateway-devices|gateway-websessions|gateway-turnend|backend-registry/.test(tok + gw + sv)],
]

let pass = 0
for (const [name, ok] of cases) {
  if (ok) pass++
  else console.log('FAIL:', name)
}
console.log(`${pass}/${cases.length}`)
