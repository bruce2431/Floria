/**
 * 探针：web-assets.generated.ts 内嵌资产解码复核（chart 嵌入式图表随 build 进 exe）
 * 从生成物按 base64 解出 index.html / styles.css / sw.js / app.js，断言 v311 与 chart 符号在位。
 * 运行：cd Floria && bun probes/probe-chart-embed-assets.ts
 */
import { readFileSync } from 'node:fs'

const src = readFileSync('src/gateway/web-assets.generated.ts', 'utf-8')

let pass = 0
const fails: string[] = []
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) { pass++; return }
  fails.push(`${name}${extra ? ' — ' + extra : ''}`)
}

// 生成物条目形状探测：找 sw.js 条目附近窗口
const iSw = src.indexOf('sw.js')
if (iSw < 0) { console.error('❌ 生成物中未见 sw.js 条目'); process.exit(1) }
const window = src.slice(Math.max(0, iSw - 300), iSw + 300)

// 通用提取：形如 "'/sw.js': 'BASE64'" 或 '"sw.js": "BASE64"'（按邻近窗口的实际形状匹配键名）
function assetB64(name: string): string | null {
  const re = new RegExp(`['"]\\/?${name.replace('.', '\\.')}['"]\\s*:\\s*['"]([A-Za-z0-9+/=]+)['"]`)
  const m = re.exec(src)
  return m ? m[1] : null
}

const dec = (b64: string | null) => (b64 ? Buffer.from(b64, 'base64').toString('utf-8') : '')

const swJs = dec(assetB64('sw.js'))
const styles = dec(assetB64('styles.css'))
const indexHtml = dec(assetB64('index.html'))
const appJs = dec(assetB64('app.js'))

ok('sw.js 解出且 v311', swJs.includes("const CACHE = 'floria-v311'"), `len=${swJs.length}`)
ok('sw.js 无 v310 残留', !swJs.includes('v310'))
ok('styles.css 含 chart-embed 全套', ['.chart-embed', '.chart-frame', '.chart-bar', '.chart-src', '.chart-raw', '.as-src'].every((c) => styles.includes(c)))
ok('index.html ?v=311 双位（styles+app.js）', indexHtml.includes('/styles.css?v=311') && indexHtml.includes('/app.js?v=311'))
ok('index.html 无 ?v=310 残留', !indexHtml.includes('?v=310'))
ok('app.js 含 chart 渲染链符号', ['chartSplit', 'CHART_BOOT', '__chartH', 'chart-embed', 'as-src'].every((c) => appJs.includes(c)))
ok('app.js 含 BOOT 高度上报', appJs.includes('parent.postMessage({__chartH'))
ok('app.js 含 CLI 同款哨兵语义（%%ascii 处理）', appJs.includes("'%%ascii'"))

console.log(`\n探针结果: ${pass} 过 / ${fails.length} 败`)
if (fails.length) {
  console.error('失败项:')
  for (const f of fails) console.error('  ❌ ' + f)
  console.error('\n条目窗口样例:\n' + window.slice(0, 400))
  process.exit(1)
}
console.log('✅ probe-chart-embed-assets 全过')
