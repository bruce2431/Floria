// probe-web-ext-cards.ts —— 「外部卡片（卡片化二期）」结构 + 行为不变量探针（只读，2026-09-25）
// 协议：<项目>/.claude/preview/preview.json 的 cards 段（静态清单，网关 GET /gateway/preview-cards 读出）
//       ＋ 预览页 postMessage { type:'floria-cards-register', cards:[…] }（实时申报，同 id 覆盖）。
// 四条不变量（每条答得出守护什么）：
//   I1 外部卡集属于「最近一次挂载的那份 preview 文档所属项目」——异 label / 文档重挂即清；离开预览路由**不清**。
//   I2 只为「当前帧」作证——postMessage 的 e.source 必须等于当前 .preview-frame.contentWindow。
//   I3 外部永不进第一方注册表——EXT 与 VIEWS 分表；外部卡没有 render 代码，只有宿主生成的 iframe 壳。
//   I4 非法声明丢弃不兜底——字段不合格 / 未知 host / 越界 path → 整条丢，不猜不补默认。
// 用法：bun run ./probes/probe-web-ext-cards.ts   （输出 pass/fail，末行 pass/fail 计数）

const SRC = `${import.meta.dir}/../src/gateway/web-src`
const WEB = `${import.meta.dir}/../src/gateway/web`
const ROOT = `${import.meta.dir}/..`
const CLI = `${ROOT}/src/gateway`

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, detail = '') {
  if (cond) pass++
  else fail++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond || !detail ? '' : '  ← ' + detail}`)
}

// ---------- 函数体按大括号配对提取 ----------
function body(file: string, header: string): string {
  const i = file.indexOf(header)
  if (i < 0) return ''
  let d = 0
  let started = false
  for (let j = i; j < file.length; j++) {
    const c = file[j]
    if (c === '{') { d++; started = true }
    else if (c === '}') { d--; if (started && d === 0) return file.slice(i, j + 1) }
  }
  return ''
}

const registryJs = await Bun.file(`${SRC}/views/registry.js`).text()
const extCardJs = await Bun.file(`${SRC}/views/ext-card.js`).text()
const mgrJs = await Bun.file(`${SRC}/sidebar/mgr.js`).text()
const railExtJs = await Bun.file(`${SRC}/sidebar/rail-ext.js`).text()
const routeJs = await Bun.file(`${SRC}/chat/route.js`).text()
const srcAppJs = await Bun.file(`${SRC}/app.js`).text()
const bundleTs = await Bun.file(`${ROOT}/scripts/bundle-web-modules.ts`).text()
const localGatewayTs = await Bun.file(`${CLI}/localGateway.ts`).text()
const stylesCss = await Bun.file(`${WEB}/styles.css`).text()
const appJs = await Bun.file(`${WEB}/app.js`).text()

const count = (s: string, re: RegExp) => [...s.matchAll(re)].length

// ---------- I3 分表：EXT 与 VIEWS 分开存，查询点合流 ----------
ok('I3 registry.js 有独立运行时表 EXT', /let EXT = \[\]/.test(registryJs))
ok('I3 registry.js 有 EXT_LABEL（记录本表属于哪个项目）', /let EXT_LABEL = ''/.test(registryJs))
ok('I3 EXT 未被塞进 VIEWS 字面量（VIEWS 仍是 5 条静态项）', count(registryJs, /\{ id: '/g) === 5, `实体条数 ${count(registryJs, /\{ id: '/g)}`)
ok('I3 viewOf 查两张表', /const viewOf = \(id\) => VIEWS\.find\(\(v\) => v\.id === id\) \|\| EXT\.find\(/.test(registryJs))
ok('I3 renderMgrTabs 遍历 VIEWS + EXT', registryJs.includes('VIEWS.concat(EXT).filter((v) => v.tab)'))
const regBody = body(registryJs, 'function registerExtCards(')
ok('I3 外部卡 render 一律由宿主生成（mountExtCard），无外部代码注入点', regBody.includes('render: (body) => mountExtCard(body, label, c)'))
ok('I3 外部卡 id 命名空间 ext:<label>:<id>（与第一方裸词 id 零撞车）', regBody.includes('`ext:${label}:${c.id}`'))
ok('I3 外部卡字段校验委托给 ext-card.js 的同一份过滤器', regBody.includes('for (const c of normExtCards(cards))'))

// ---------- I1 生命周期：清点受控（异 label / 文档重挂清；离开预览路由不清） ----------
ok('I1 registry.js 定义 clearExtCards', /function clearExtCards\(\)/.test(registryJs))
ok('I1 same-label 且非 replace 时保留既有卡（同 id 覆盖语义）', regBody.includes('if (replace || EXT_LABEL !== label) { EXT = []; EXT_LABEL = label }'))
const syncBody = body(mgrJs, 'function syncExtCards(')
ok('I1 mgr.js 定义 syncExtCards', syncBody.length > 0)
ok('I1 syncExtCards 先清后取（旧项目卡不残留）', syncBody.indexOf('clearExtCards()') >= 0 && syncBody.indexOf('clearExtCards()') < syncBody.indexOf('fetch('))
ok('I1 syncExtCards 走静态清单端点', syncBody.includes('/gateway/preview-cards?label='))
ok('I1 syncExtCards 有 seq 守卫（先发请求的迟到响应不落表）', syncBody.includes('seq === extCardsSeq'))
// 挂载点 = 与 clearRailExt 同点：iframe 换 src / 新文档重挂（2 处），每处紧邻在 clearRailExt() 之后
const clearIdx = [...mgrJs.matchAll(/clearRailExt\(\)/g)].map((m) => m.index!)
const syncIdx = [...mgrJs.matchAll(/syncExtCards\(label\)(?!\s*\{)/g)].map((m) => m.index!)
const paired = clearIdx.filter((i) => syncIdx.some((j) => j > i && j - i < 200)).length
ok('I1 syncExtCards 与 clearRailExt 同点（2 处）', clearIdx.length === 2 && syncIdx.length === 2 && paired === 2, `clearRailExt ${clearIdx.length} / syncExtCards ${syncIdx.length} / 配对 ${paired}`)
ok('I1 离开预览路由**不清**外部卡（route.js 无 clearExtCards）', !routeJs.includes('clearExtCards'))
ok('I1 clearExtCards 调用点只此一处（mgr.js syncExtCards）', count(mgrJs, /clearExtCards\(\)/g) === 1, `mgr.js 内 ${count(mgrJs, /clearExtCards\(\)/g)} 次`)

// ---------- I2 只为当前帧作证：两条申报共用同一道门 ----------
const bridgeBody = body(railExtJs, 'function bindRailExtBridge()')
ok('I2 rail-ext.js 同时收 rail-register 与 cards-register', bridgeBody.includes("d.type === 'floria-rail-register'") && bridgeBody.includes("d.type === 'floria-cards-register'"))
const srcCheck = bridgeBody.indexOf('f.contentWindow !== e.source')
const cardBranch = bridgeBody.indexOf('if (cards) {')
ok('I2 cards 分支在 e.source 校验之后（不为别处窗口采纳）', srcCheck >= 0 && cardBranch >= 0 && srcCheck < cardBranch, `srcCheck@${srcCheck} cards@${cardBranch}`)
ok('I2 label 取当前帧锚定值（f.dataset.label），不由消息自称', bridgeBody.includes("registerExtCards(f.dataset.label || '', d.cards, false)"))
ok('I2 校验器不复刻（rail-ext.js 不内联第二套字段过滤）', !railExtJs.includes('function normExtCards') && !railExtJs.includes('function isExtPath'))
ok('I2 实时申报一律 replace=false（同 id 覆盖，不吞静态清单）', bridgeBody.includes('registerExtCards(f.dataset.label || \'\', d.cards, false)'))

// ---------- I4 非法丢弃不兜底：行为真值表（实现从源码提取，非手抄） ----------
const isExtPathSrc = body(extCardJs, 'function isExtPath(')
const normSrc = body(extCardJs, 'function normExtCards(')
ok('I4 isExtPath / normExtCards 可从源码提取', isExtPathSrc.length > 0 && normSrc.length > 0)
if (isExtPathSrc && normSrc) {
  const factory = new Function(`${isExtPathSrc}\n${normSrc}\nreturn { isExtPath, normExtCards }`) as () => {
    isExtPath: (p: unknown) => boolean
    normExtCards: (raw: unknown) => { id: string; title: string; icon: string; path: string; host: string; tab: boolean }[]
  }
  const { isExtPath, normExtCards } = factory()

  const PATH_T: [string, boolean][] = [
    ['cards/books.html', true],
    ['index.html#card=chat', true], // #片段：同一预览页自我定位，宿主不推断
    ['a/b/c.html', true],
    ['/cards/books.html', false], // 绝对路径
    ['cards\\books.html', false], // 反斜杠
    ['cards/books.html?x=1', false], // query
    ['../secret.html', false], // ..
    ['cards/./books.html', false], // .
    ['cards//books.html', false], // 空段
    ['', false],
    ['a%2F..%2Fb.html', false], // 解码后仍越界
    ['bad%zz.html', false], // 非法 % 序列 → decodeURIComponent 抛
  ]
  for (const [p, want] of PATH_T) ok(`I4 isExtPath(${JSON.stringify(p)}) → ${want}`, isExtPath(p) === want)

  const CARD_T: [string, unknown, string[]][] = [
    ['合法 view 卡', [{ id: 'books', title: '书稿列表', icon: 'folder', path: 'cards/books.html', host: 'view' }], ['books']],
    ['未知 host 整条丢', [{ id: 'x', title: 'X', path: 'a.html', host: 'panel' }], []],
    ['缺 host 整条丢', [{ id: 'x', title: 'X', path: 'a.html' }], []],
    ['id 非法字符整条丢', [{ id: 'a b', title: 'X', path: 'a.html', host: 'view' }], []],
    ['id 超长（>32）整条丢', [{ id: 'x'.repeat(33), title: 'X', path: 'a.html', host: 'view' }], []],
    ['title 空整条丢', [{ id: 'x', title: '   ', path: 'a.html', host: 'view' }], []],
    ['path 越界整条丢', [{ id: 'x', title: 'X', path: '../y.html', host: 'view' }], []],
    ['缺省 icon 回落 plug', [{ id: 'x', title: 'X', path: 'a.html', host: 'view' }], ['x', 'plug']],
    ['tab:false 保留在 tab 位（不出侧栏但可路由）', [{ id: 'x', title: 'X', path: 'a.html', host: 'view', tab: false }], ['x', 'false']],
    ['非数组入参 = 空集（cards 段可缺）', null, []],
    ['数组里的非对象项跳过', ['nope', { id: 'x', title: 'X', path: 'a.html', host: 'view' }], ['x']],
    ['合格与不合格混装：只留合格项', [{ id: 'ok', title: '好的', path: 'c/a.html', host: 'view' }, { id: 'bad', title: '坏的', path: '/x.html', host: 'view' }], ['ok']],
  ]
  for (const [name, raw, expect] of CARD_T) {
    const got = normExtCards(raw)
    const hit = expect.length === 0 ? got.length === 0
      : expect.length === 1 ? got.length === 1 && got[0].id === expect[0]
      : got.length === 1 && got[0].id === expect[0] && String(got[0].tab) === expect[1]
    if (expect.length === 2 && expect[1] === 'plug') {
      ok(`I4 ${name}`, got.length === 1 && got[0].icon === 'plug', `icon=${got[0]?.icon}`)
    } else {
      ok(`I4 ${name}`, hit, `实得 ${JSON.stringify(got)}`)
    }
  }
}

// ---------- iframe 壳：一卡一 iframe，同源 /preview/<label>/<path> + token + #片段原样 ----------
const srcBody = body(extCardJs, 'function extCardSrc(')
ok('壳 src = /preview/<label>/<path>', srcBody.includes('`/preview/${encodeURIComponent(label)}/${file}${q}${frag}`'))
ok('壳 src 带 token（未授权设备首链）', srcBody.includes("gToken ? '?token=' + encodeURIComponent(gToken) : ''"))
ok('壳 src 保留 #片段（原样带上，由卡页自我定位）', srcBody.includes('card.path.slice(i)'))
ok('壳 = 一卡一 iframe（.ext-shell > .ext-frame）', extCardJs.includes("'<div class=\"ext-shell\">'") && extCardJs.includes('class="ext-frame"'))
ok('壳不复用 .preview-frame/.preview-shell 类名（避免顶替宿主「当前预览帧」的定位）', !/class="preview-(frame|shell)"/.test(extCardJs) && /class="ext-shell"/.test(extCardJs) && /class="ext-frame"/.test(extCardJs))

// ---------- 拼接与产物 ----------
ok('B1 bundle-web-modules.ts 收编 views/ext-card.js', bundleTs.includes("views/ext-card.js"))
const rows = [...bundleTs.matchAll(/\{ file: '(views\/[a-z-]+\.js)'/g)].map((m) => m[1])
ok('B1 ext-card.js 排在 registry.js 之前（同区间号 → 稳定排序）', rows.indexOf('views/ext-card.js') === rows.indexOf('views/registry.js') - 1, rows.join(' < '))
ok('B2 产物 app.js 含 mountExtCard 定义', appJs.includes('function mountExtCard('))
ok('B2 产物 app.js 含 registerExtCards / clearExtCards 定义', appJs.includes('function registerExtCards(') && appJs.includes('function clearExtCards('))
ok('B2 产物 app.js 含实时申报分支', appJs.includes("if (cards) { registerExtCards(f.dataset.label || '', d.cards, false); return }"))
ok('B2 产物 app.js 含 syncExtCards', appJs.includes('function syncExtCards('))
// 侧栏 tab 改为容器委托：运行期重渲不清事件（逐钮绑定会被 innerHTML 抹掉）
ok('B3 app.js（源）mgr-tab 走容器委托', srcAppJs.includes("$('mgr-tabs').addEventListener('click'") && !/querySelectorAll\('\.mgr-tab'\)\.forEach\(\(b\) =>\s*\n?\s*b\.addEventListener/.test(srcAppJs))
ok('B3 产物 app.js mgr-tab 走容器委托', appJs.includes("$('mgr-tabs').addEventListener('click'"))

// ---------- 样式：全高卡特例纳入 .ext-shell + 卡圆角裁内容 ----------
ok('S1 .ext-shell 定义在 styles.css', /\.ext-shell \{/.test(stylesCss))
ok('S1 .ext-frame 定义在 styles.css', /\.ext-frame \{/.test(stylesCss))
ok('S1 全高卡特例（.view-scroll）含 .ext-shell', stylesCss.includes('.view-card:has(.ext-shell) > .view-scroll'))
ok('S1 全高卡特例（撤 920px 帽的成对半条）含 .ext-shell', stylesCss.includes('.view-card:has(.ext-shell) > .view-scroll > .view-body'))
ok('S2 .view-card 以 overflow:hidden 把圆角变成内容硬边界', /\.view-card \{[^}]*overflow: hidden/.test(stylesCss))

// ---------- 网关侧：同一份 preview.json、同一套校验 ----------
const readJsonBody = body(localGatewayTs, 'function readPreviewJson(')
ok('G1 readPreviewJson 是 preview.json 的单一解析入口', readJsonBody.length > 0)
ok('G1 readBackendCfg 走 readPreviewJson（不再各自 JSON.parse）', body(localGatewayTs, 'function readBackendCfg(').includes('readPreviewJson(previewDir)'))
ok('G2 readPreviewCards 走同一 readPreviewJson', body(localGatewayTs, 'function readPreviewCards(').includes('readPreviewJson(previewDir)'))
ok('G2 有 isPreviewRelPath（网关侧守 preview.json 来源）', body(localGatewayTs, 'function isPreviewRelPath(').length > 0)
ok('G2 端点 /gateway/preview-cards 存在', localGatewayTs.includes("url.pathname === '/gateway/preview-cards'"))
ok('G2 端点对未命中/无 preview 的项目 404（不回落空数组掩盖）', /preview-cards[\s\S]{0,600}?project not found/.test(localGatewayTs))
const readCardsBody = body(localGatewayTs, 'function readPreviewCards(')
ok('G2 网关侧同样丢弃未知 host（不猜不兜底）', readCardsBody.includes("if (c.host !== 'view') continue"))
ok('G2 网关侧同样丢弃重复 id', readCardsBody.includes('seen.has(id)'))

// ---------- G3 网关侧解析行为真值表（源码提取 + 去 TS 类型后直接跑，不需起网关） ----------
// 起二网关属于「勿为验证另起二网关」明令禁止的坑；这里把 readPreviewJson/isPreviewRelPath/
// readPreviewCards 三个函数体从 localGateway.ts 提出来，经 Bun.Transpiler 剥类型，注入内存
// 文件系统（不放盘）跑真值——验的是真源码，不是手抄副本。
const gSrc = [
  body(localGatewayTs, 'function readPreviewJson('),
  body(localGatewayTs, 'function isPreviewRelPath('),
  body(localGatewayTs, 'function readPreviewCards('),
].join('\n')
ok('G3 三个解析函数可从 localGateway.ts 提取', gSrc.includes('function readPreviewJson(') && gSrc.includes('function isPreviewRelPath(') && gSrc.includes('function readPreviewCards('))
if (gSrc.includes('function readPreviewCards(')) {
  const gJs = new Bun.Transpiler({ loader: 'ts' }).transformSync(gSrc)
  const FILES = new Map<string, string>()
  const readPreviewCards = new Function(
    'join', 'existsSync', 'readFileSync',
    `${gJs}\nreturn readPreviewCards`,
  )(
    (...parts: string[]) => parts.join('/'),
    (p: string) => FILES.has(p),
    (p: string) => {
      const v = FILES.get(p)
      if (v === undefined) throw new Error('ENOENT: ' + p)
      return v
    },
  ) as (dir: string) => { id: string; title: string; icon: string; path: string; host: string; tab: boolean }[]

  const run = (json: string | null) => {
    FILES.clear()
    if (json !== null) FILES.set('PV/preview.json', json)
    return readPreviewCards('PV')
  }

  const r1 = run(JSON.stringify({
    backend: { cmd: ['python', 'server.py'] }, // 与 cards 并列的既有能力，解析不应互相干扰
    cards: [
      { id: 'books', title: '书稿列表', icon: 'folder', path: 'cards/books.html', host: 'view' },
      { id: 'chat', title: '助手', path: 'index.html#card=chat', host: 'view', tab: false },
      { id: 'bad-host', title: 'X', path: 'a.html', host: 'panel' },
      { id: 'bad-path', title: 'X', path: '/etc/passwd', host: 'view' },
      { id: 'dup', title: '前', path: 'a.html', host: 'view' },
      { id: 'dup', title: '后', path: 'b.html', host: 'view' },
    ],
  }))
  ok('G3 合法卡全返且保序（backend 段并存不干扰）', r1.map((c) => c.id).join(',') === 'books,chat,dup', r1.map((c) => c.id).join(','))
  ok('G3 icon 缺省回落 plug', r1[0]?.icon === 'folder' && r1[1]?.icon === 'plug', `${r1[0]?.icon}/${r1[1]?.icon}`)
  ok('G3 tab 缺省 true / tab:false 保留', r1[0]?.tab === true && r1[1]?.tab === false)
  ok('G3 host 非 view 整条丢', !r1.some((c) => c.id === 'bad-host'))
  ok('G3 path 越界整条丢', !r1.some((c) => c.id === 'bad-path'))
  ok('G3 同 id 保首次、丢后者（seen 守卫）', r1.filter((c) => c.id === 'dup').length === 1 && r1.find((c) => c.id === 'dup')?.title === '前', JSON.stringify(r1.find((c) => c.id === 'dup')))

  const r2 = run(JSON.stringify({ backend: { cmd: ['x'] } }))
  ok('G3 cards 段缺失 = 空集（正常，非错误）', r2.length === 0)
  ok('G3 preview.json 不存在 = 空集', run(null).length === 0)
  ok('G3 坏 JSON 不抛（readPreviewJson try/catch）= 空集', run('{ this is not json').length === 0)
  ok('G3 JSON 顶层非对象（数组）= 空集', run('[1,2,3]').length === 0)
  const r3 = run(JSON.stringify({ cards: [{ id: 'a', title: 'A', path: 'x.html', host: 'view' }, { id: 'b', title: 'B', path: 'y.html', host: 'view' }] }))
  ok('G3 多卡保序', r3.map((c) => c.id).join(',') === 'a,b', r3.map((c) => c.id).join(','))
}

// ---------- 前端资产版本自愈链一致 ----------
const swJs = await Bun.file(`${WEB}/sw.js`).text()
const indexHtml = await Bun.file(`${WEB}/index.html`).text()
const swV = /const CACHE = 'floria-v(\d+)'/.exec(swJs)?.[1]
const appV = /\/app\.js\?v=(\d+)/.exec(indexHtml)?.[1]
const cssV = /\/styles\.css\?v=(\d+)/.exec(indexHtml)?.[1]
ok('C1 sw CACHE 与 index.html app.js ?v= 同步', !!swV && swV === appV, `sw=v${swV} app=v${appV}`)
ok('C1 styles.css 有 cache-bust（本次改了样式，必须带 ?v=）', !!cssV, `css=v${cssV}`)

console.log(`\n${pass}/${fail}`)
process.exit(fail ? 1 : 0)
