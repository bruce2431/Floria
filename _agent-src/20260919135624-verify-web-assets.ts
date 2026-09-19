// 一次性核验：新构建 exe 内嵌的前端资源是否含键盘适配改动（只读）
const t = await Bun.file('src/gateway/web-assets.generated.ts').text()
function grab(name: string): string {
  const re = new RegExp('"' + name + '": "([A-Za-z0-9+/=]+)"')
  const m = re.exec(t)
  if (!m) throw new Error('missing ' + name)
  return Buffer.from(m[1]!, 'base64').toString('utf8')
}
const css = grab('styles.css')
const js = grab('app.js')
const sw = grab('sw.js')
const html = grab('index.html')
console.log('css  --kb:', css.includes('--kb, 0px'), '| --vv-pan:', css.includes('--vv-pan, 0px'), '| --kb-lift:', css.includes('--kb-lift, 0px'), '| kb-open:', css.includes('body.kb-open #input-wrap'))
console.log('js   kbGeometry:', js.includes('function kbGeometry('), '| applyKeyboard:', js.includes('function applyKeyboard('), '| called:', js.includes('initViewport()'))
console.log('sw   cache:', /floria-v\d+/.exec(sw)?.[0], '| html app.js:', /app\.js\?v=\d+/.exec(html)?.[0], '| html styles:', /styles\.css\?v=\d+/.exec(html)?.[0])
