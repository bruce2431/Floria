/**
 * 2026-09-11 发送瞬间「界面短暂跳到上一条消息」根治探针（跑真实源码函数体，非复刻）
 *
 * 用户实测：「发送新消息，界面会短暂跳到上一条消息」。
 *
 * 根因（两层消息流 stage）：唤出占位时旧实现把占位高度初值设为**乐观气泡同高**（p0），
 * 再用 rAF 750ms 拉到目标高（pStar）。占位初值是缩的 ⇒ 同一事务内 scrollHeight 先塌
 * ⇒ 浏览器按塌后的 maxScroll 钳 scrollTop（首帧就画在内容底 = 上一回合尾部）⇒ rAF 逐帧
 * 抬到贴顶位。用户看到的就是「先跳到上一条消息，再滑上去」。
 * 占位高度是几何的纯函数（参照气泡定了终态就定了），不存在中间态：修 = 删动画窗，高度
 * 唯一写入者 stageSync，唤出即终态（stageStart 只做状态复位 + stageSync）。
 * 附带根修：route.js 载入钉顶的 lastU 循环漏 `!injected` 过滤（与 live.js 同规则不一致）
 * ——末条 user 为注入引导消息时 pinned=false、stage 全程未激活，发送才首次创建占位
 * （恒走 fresh 路径）。
 *
 * 断言：
 *   A 源码级 —— stageStart 无第三形参/无 rAF；stage.js 无 animT 状态源；四个调用点两参化；
 *      route.js 载入钉顶循环含 !injected（与 live.js 同规则）；absorbTurnAnchor/guideTurnAnchor
 *      回落锚在位（二轮根修）
 *   B 几何实测（真实函数体 + 最小布局模型；场景=短会话·未激活 stage 的发送=旧 fresh 路径）
 *      帧末 scrollTop === 贴顶位（新气泡钉在视口顶）；maxScroll === 贴顶位（未超一屏不变量）；
 *      占位高度写序无回撤（只写终态）；无待执行动画帧
 *   C --prefix 旧构造对照 —— 写序出现回撤（终态 → 气泡高）；帧末 scrollTop = 内容底（≠贴顶位
 *      = 上一条消息）；存在待执行 rAF 帧；逐帧推进后才收敛到贴顶位（= 先跳后滑）
 *   D 注入吸收帧参照移交（二轮根修主场景，2026-09-11 二轮实测「还是有问题」）
 *      CLI 桥接会话发送 → 乐观气泡钉顶 → injected user 落盘吸收乐观气泡 → 接管帧乐观 DOM
 *      移除、段折叠体（details.done-fold[data-m] + 织入的 data-t="g0" 引导气泡）上屏 →
 *      stageSync 参照必须移交**同一回合**折叠锚（折叠顶=回合顶=乐观原位），禁止回落上一回合
 *      气泡（旧回落「末条 data-t="u"」在注入开段回合=上一回合气泡=用户所见「跳到上一条消息」）
 *   E 文档序防误吞 —— 历史存在更早注入回合的引导气泡 + 本次为 dequeue 落盘接管（真实开启
 *      气泡在引导之后）→ 仍取末条开启气泡，不吞旧折叠锚
 *
 * 用法：
 *   bun probe-stage-pin.ts            修复后（期望全过）
 *   bun probe-stage-pin.ts --prefix   还原 09-09 拉伸动画构造 → B 组必败、C 组复现缺陷
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const GW = fileURLToPath(new URL('../src/gateway/', import.meta.url))
let rawStage = readFileSync(GW + 'web-src/chat/stage.js', 'utf8')
const routeSrc = readFileSync(GW + 'web-src/chat/route.js', 'utf8')
const liveSrc = readFileSync(GW + 'web-src/core/live.js', 'utf8')
const msgsSrc = readFileSync(GW + 'web-src/chat/messages.js', 'utf8')

const PREFIX = process.argv.includes('--prefix')

// 旧构造（09-09 定案原文，git HEAD 版 stageStart）：占位初值=气泡高 + rAF 750ms easeOutCubic
const OLD_START = `  function stageStart(bubbleEl, key, smooth) {
    stage.active = true
    stage.key = key
    stage.bubble = bubbleEl
    if (stage.animT) { cancelAnimationFrame(stage.animT); stage.animT = null }
    if (stage.releaseT) { clearTimeout(stage.releaseT); stage.releaseT = null }
    stage.touchHold = false
    stage.yielded = false
    stageSync()
    const fresh = !!stage.__fresh
    stage.__fresh = false
    if (smooth && stage.bubble && stage.el) {
      const pStar = parseFloat(stage.el.style.height) || 0
      const p0 = fresh ? Math.min(stage.bubble.offsetHeight, pStar) : (parseFloat(stage.el.style.height) || 0)
      const t0ms = performance.now()
      stage.el.style.height = p0 + 'px'
      const step = (now) => {
        const k = Math.min(1, (now - t0ms) / 750)
        const e = 1 - Math.pow(1 - k, 3)
        if (stage.el) stage.el.style.height = (p0 + (pStar - p0) * e) + 'px'
        if (!stage.yielded && !stage.touchHold) stageFollow()
        if (k < 1) { stage.animT = requestAnimationFrame(step) }
        else { stage.animT = null; stageSync() }
      }
      stage.animT = requestAnimationFrame(step)
    } else {
      stageFollow()
    }
  }`

if (PREFIX) {
  const m = rawStage.match(/ {2}function stageStart\(bubbleEl, key\) \{[\s\S]*?\n {2}\}\n/)
  if (!m) throw new Error('--prefix 还原失败：stageStart 形态已变，探针需同步')
  rawStage = rawStage.replace(m[0], OLD_START + '\n')
  // 旧 stageSync 以「created」回报占位是否本趟新建（新实现已删该返回值）——旧构造的 fresh
  // 语义靠此标记还原，否则 fresh 恒 undefined = 动画被跳过，对照失真。
  const NEW_CREATE = `      el = document.createElement('div')
      el.className = 'pin-stage'
      messagesEl.appendChild(el)
    }`
  if (!rawStage.includes(NEW_CREATE)) throw new Error('--prefix 还原失败：stageSync 建块形态已变，探针需同步')
  rawStage = rawStage.replace(NEW_CREATE, `      el = document.createElement('div')
      el.className = 'pin-stage'
      messagesEl.appendChild(el)
      stage.__fresh = true
    }`)
}

const stripped = rawStage
  .split('\n')
  .filter((l) => !/^\s*import\s/.test(l))
  .join('\n')
  .replace(/\bexport\s+(?=(?:function|const|let|var)\b)/g, '')
  .replace(/^export\s*\{[\s\S]*?\}\s*$/m, '')

// 最小布局模型（坐标系与浏览器同构）：offsetTop 含顶 padding；可滚动区 = 子元素高之和 + 底
// padding（顶 padding 不产生可滚动空白）→ maxScroll ≡ 贴顶位的不变量在此模型下精确成立。
const PAD_TOP = 24
const PAD_BOT = 142
const VIEW_H = 700

const stub = `
  let frameQ = []
  let clock = 0
  const performance = { now: () => clock }
  const requestAnimationFrame = (cb) => { frameQ.push(cb); return frameQ.length }
  const cancelAnimationFrame = () => { frameQ.length = 0 }
  const setTimeout = () => 0
  const clearTimeout = () => {}
  const PAD_TOP = ${PAD_TOP}, PAD_BOT = ${PAD_BOT}
  const doc = { pinWrites: [] }
  let dirty = true
  const markDirty = () => { dirty = true }
  function hOf(el) { const raw = el.style.height; const n = raw ? parseFloat(raw) : NaN; return isNaN(n) ? el.natH : n }
  function layout() {
    if (!dirty) return
    dirty = false
    let y = PAD_TOP
    for (const c of messagesEl.children) { c._ot = y; c._oh = hOf(c); y += c._oh }
    messagesEl.contentH = y - PAD_TOP
  }
  function mkEl(cls, natH, attrs) {
    const el = {
      className: cls, attrs: attrs || {}, natH: natH || 0, _ot: 0, _oh: 0, parent: null, isConnected: false, children: [],
      get offsetTop() { layout(); return el._ot },
      get offsetHeight() { layout(); return el._oh },
      remove() { const i = messagesEl.children.indexOf(el); if (i >= 0) messagesEl.children.splice(i, 1); el.isConnected = false; el.parent = null; markDirty() },
      closest(sel) { let p = el.parent; while (p && p !== messagesEl) { if (matchesEl(p, sel)) return p; p = p.parent } return null },
      compareDocumentPosition(other) { const list = docOrder(); const a = list.indexOf(el); const b = list.indexOf(other); if (a < 0 || b < 0) return 0; return a < b ? 4 : 2 },
    }
    el.dataset = el.attrs
    const style = { scrollBehavior: '' }
    let hRaw = ''
    Object.defineProperty(style, 'height', {
      get: () => hRaw,
      set: (v) => { hRaw = v; markDirty(); if (String(el.className).indexOf('pin-stage') >= 0) doc.pinWrites.push(v) },
      configurable: true,
    })
    el.style = style
    return el
  }
  function matchesEl(el, sel) {
    const parts = sel.match(/\\.[\\w-]+|\\[[\\w][\\w-]*(?:\\^)?="[^"]*"\\]/g) || []
    return parts.every((p) => {
      if (p[0] === '.') return String(el.className).split(/\\s+/).indexOf(p.slice(1)) >= 0
      const pm = p.match(/^\\[([\\w-]+)(\\^?)="([^"]*)"\\]$/)
      if (!pm) return true
      const v = String(el.attrs[pm[1]] == null ? '' : el.attrs[pm[1]])
      return pm[2] === '^' ? v.indexOf(pm[3]) === 0 : v === pm[3]
    })
  }
  const Node = { DOCUMENT_POSITION_FOLLOWING: 4 }
  function docOrder() {
    const out = []
    const walk = (ns) => { for (const n of ns) { out.push(n); if (n.children.length) walk(n.children) } }
    walk(messagesEl.children)
    return out
  }
  const sc = {
    offsetTop: 0, clientHeight: ${VIEW_H}, style: { scrollBehavior: '' }, _st: 0,
    get scrollHeight() { layout(); return Math.max(this.clientHeight, messagesEl.contentH + PAD_BOT) },
    get scrollTop() { const mx = Math.max(0, this.scrollHeight - this.clientHeight); return Math.min(this._st, mx) },
    set scrollTop(v) { const mx = Math.max(0, this.scrollHeight - this.clientHeight); this._st = Math.max(0, Math.min(v, mx)) },
    addEventListener() {}, querySelector() { return null },
  }
  function deepAll(nodes, sel) {
    const out = []
    const walk = (ns) => { for (const n of ns) { if (matchesEl(n, sel)) out.push(n); if (n.children.length) walk(n.children) } }
    walk(nodes)
    return out
  }
  const messagesEl = {
    children: [], offsetTop: 0, contentH: 0,
    appendChild(el) { this.children.push(el); el.parent = this; el.isConnected = true; markDirty(); return el },
    insertBefore(el, ref) {
      const i = ref ? this.children.indexOf(ref) : -1
      if (i >= 0) this.children.splice(i, 0, el); else this.children.push(el)
      el.parent = this; el.isConnected = true; markDirty(); return el
    },
    querySelector(sel) { return deepAll(this.children, sel)[0] || null },
    querySelectorAll(sel) { return deepAll(this.children, sel) },
    closest() { return sc },
    addEventListener() {},
  }
  const document = {
    getElementById: (id) => (id === 'chat-scroll' ? sc : null),
    createElement: () => mkEl('', 0, {}),
    addEventListener() {},
  }
  const getComputedStyle = () => ({ paddingTop: PAD_TOP + 'px', paddingBottom: PAD_BOT + 'px' })
  const $ = (id) => document.getElementById(id)
  const absorbPending = () => {}
  const renderHome = () => {}
  const renderSession = () => {}
  const renderTransient = () => {}
  const renderMgr = () => {}
  const openProjectPreview = () => {}
  const live = {}
  const dom = { sc, messagesEl, doc, mkEl, layout, frameQ: () => frameQ, setClock: (v) => { clock = v }, markDirty }
`

const mod = new Function(`${stub}\n${stripped}\n;return { stageStart, stageSync, stageFollow, stageRelease, topInScroll, stage, dom }`)() as any

let pass = 0
let fail = 0
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ✔ ${name}`) }
  else { fail++; console.log(`  ✘ ${name}${detail ? ' — ' + detail : ''}`) }
}

console.log(`\n[probe-stage-pin] ${PREFIX ? '--prefix 旧构造对照（09-09 拉伸动画）' : '修复后'}\n`)

if (PREFIX) {
  console.log('A 源码级形态 —— 本模式跳过（源码已按旧构造改写，断言无意义）\n')
} else {
  // ---- A 源码级形态 ----
  console.log('A 源码级形态')
  ok('A1 stageStart 无第三形参（smooth 退役）', /function stageStart\(bubbleEl, key\) \{/.test(rawStage))
  ok('A2 stageStart 体内无 requestAnimationFrame（无动画窗）', !/requestAnimationFrame/.test(rawStage))
  ok('A3 stage.js 无 animT 状态源（高度唯一写入者）', !/animT/.test(rawStage))
  ok('A4 live.js 唤出单路径（乐观/权威不再分叉）', /stageStart\(el, uSig\)/.test(liveSrc) && !/stageStart\(el, uSig, /.test(liveSrc))
  ok('A5 messages.js/route.js 调用点两参化', /stageStart\(els\[els\.length - 1\], 'optimistic'\)/.test(msgsSrc) && /stageStart\(el, baseU\)/.test(routeSrc))
  ok('A6 route.js 载入钉顶 lastU 排除 injected（与 live.js 同规则）',
    /for \(let i = messages\.length - 1; i >= 0; i--\) if \(isRealUser\(messages\[i\]\) && !messages\[i\]\.injected\)/.test(routeSrc))
  ok('A7 ctx-meter 滚动让位判据无 animT 残留', !/animT/.test(readFileSync(GW + 'web-src/inputbar/ctx-meter.js', 'utf8')))
  ok('A8 乐观回落走 absorbTurnAnchor（旧「末条 data-t="u"」直落形态已删）',
    /absorbTurnAnchor\(\)/.test(rawStage) && !/\|\| \(users\.length \? users\[users\.length - 1\] : null\)/.test(rawStage))
  ok('A9 回合锚=引导所属段折叠 details.done-fold[data-m]（guideTurnAnchor 在位）',
    /guideEl\.closest\('details\.done-fold\[data-m\]'\)/.test(rawStage) && /data-t\^\="g"/.test(rawStage))
}

// ---- B/C 几何实测：场景 = 短会话 + stage 未激活（旧 fresh 路径）的发送 ----
const { messagesEl, sc, doc, mkEl, layout } = mod.dom
function scenario() {
  messagesEl.children.length = 0
  doc.pinWrites.length = 0
  // 历史：更早内容 200 + 上一回合开启气泡 64 + 上一回合回复 300
  const above = mkEl('msg', 200, {})
  const prevBubble = mkEl('msg user', 64, { 'data-m': '0', 'data-t': 'u' })
  const prevReply = mkEl('msg', 300, {})
  messagesEl.appendChild(above)
  messagesEl.appendChild(prevBubble)
  messagesEl.appendChild(prevReply)
  layout()
  sc._st = sc.scrollHeight // 用户此刻停在内容底
  const beforeScrollTop = sc.scrollTop
  // 发送：乐观开启气泡挂入 + 唤出占位（stage 未激活 → 占位本趟首次创建 = 旧 fresh 路径）
  const newBubble = mkEl('msg user msg-in', 64, { 'data-t': 'u' })
  messagesEl.insertBefore(newBubble, null)
  layout()
  mod.stageStart(newBubble, 'optimistic', PREFIX ? true : undefined)
  const t0 = mod.topInScroll(newBubble)
  const frame0 = sc.scrollTop // 事务末 = 浏览器绘制的那一帧
  const maxScroll = sc.scrollHeight - sc.clientHeight
  const frames = mod.dom.frameQ().length
  const writes = doc.pinWrites.slice()
  const heights = messagesEl.children.map((c: any) => c.offsetHeight)
  // 逐帧推进到动画收敛（新构造无帧 → 循环不执行）
  let n = 0
  while (mod.dom.frameQ().length && n < 120) {
    const q = mod.dom.frameQ().splice(0)
    n++
    mod.dom.setClock(n * 16.7)
    for (const cb of q) cb(n * 16.7)
  }
  return { t0, frame0, frameEnd: sc.scrollTop, maxScroll, frames, writes, heights, beforeScrollTop, stepped: n }
}
const r = scenario()
const GEO = `占位终态高应 = 视口高 − 底 padding − 脚印 = ${VIEW_H}−${PAD_BOT}−64 = 494`

if (!PREFIX) {
  console.log('\nB 几何实测（真实函数体；场景 = 短会话·未激活 stage 的发送 = 旧 fresh 路径）')
  ok('B0 ' + GEO, parseFloat(r.writes[0] || '0') === 494, `writes=${JSON.stringify(r.writes)}`)
  ok('B1 占位高度恰好写一次（终态唯一，无第二写入者）', r.writes.length === 1, `writes=${JSON.stringify(r.writes)}`)
  ok(`B2 帧末 scrollTop = 贴顶位 ${r.t0}（新气泡钉在视口顶）`,
    r.frame0 === r.t0, `frame0=${r.frame0} t0=${r.t0} maxScroll=${r.maxScroll}`)
  ok('B3 maxScroll ≡ 贴顶位（未超一屏不变量）', r.maxScroll === r.t0, `maxScroll=${r.maxScroll} t0=${r.t0}`)
  ok('B4 无待执行动画帧（唤出即终态，无中间帧可绘，frames=0）', r.frames === 0, `frames=${r.frames}`)

  // ---- D 注入吸收帧参照移交（二轮根修主场景）----
  // 真实时序：发送 → 乐观气泡钉顶 → injected user 落盘 → absorbPending 移除 pending →
  // renderTransient 摘除暂态区（乐观气泡 DOM 消失）→ 整页重建（占位块被 innerHTML 洗掉、
  // 段折叠体+织入引导气泡上屏）→ renderSettle → stageSync 参照重找。
  console.log('\nD 注入吸收帧参照移交（CLI 桥接会话接管帧）')
  {
    messagesEl.children.length = 0
    doc.pinWrites.length = 0
    mod.stageRelease()
    const above = mkEl('msg', 200, {})
    const prevBubble = mkEl('msg user', 64, { 'data-m': '0', 'data-t': 'u' })
    const prevReply = mkEl('msg', 300, {})
    messagesEl.appendChild(above); messagesEl.appendChild(prevBubble); messagesEl.appendChild(prevReply)
    const optBubble = mkEl('msg user msg-in', 64, { 'data-t': 'u' })
    messagesEl.appendChild(optBubble)
    layout()
    sc._st = sc.scrollHeight
    mod.stageStart(optBubble, 'optimistic')
    const t0opt = mod.topInScroll(optBubble)
    // 吸收 + 接管重建：乐观气泡移除、折叠体（data-m=1，data-t=f，含引导 g0）上屏、占位块被洗
    optBubble.remove()
    const stalePin = messagesEl.querySelector('.pin-stage')
    if (stalePin) stalePin.remove() // 整页重建 innerHTML 洗掉占位块
    const fold = mkEl('details done-fold done-live', 120, { 'data-m': '1', 'data-t': 'f' })
    const body = mkEl('done-body', 0, {})
    const guide = mkEl('msg user', 0, { 'data-m': '1', 'data-t': 'g0', 'data-g': '1' })
    fold.children.push(body); body.parent = fold; body.isConnected = true
    body.children.push(guide); guide.parent = body; guide.isConnected = true
    messagesEl.appendChild(fold)
    layout()
    mod.stageSync()
    const t0fold = mod.topInScroll(fold)
    const t0prev = mod.topInScroll(prevBubble)
    const oldFallbackTarget = (() => {
      const us = messagesEl.querySelectorAll('[data-t="u"]')
      return us.length ? us[us.length - 1] : null // 旧回落「末条 data-t="u"」在注入开段回合=上一回合气泡
    })()
    const pin = messagesEl.querySelector('.pin-stage')
    ok('D1 参照移交同一回合折叠锚（≠旧回落命中的上一回合气泡）',
      mod.stage.bubble === fold && oldFallbackTarget === prevBubble, `bubble=${mod.stage.bubble && mod.stage.bubble.className}`)
    ok(`D2 帧末 scrollTop = 新回合顶 ${t0fold}（钉在接管帧回合顶，不回上一条消息）`,
      sc.scrollTop === t0fold, `scrollTop=${sc.scrollTop} t0fold=${t0fold} t0prev=${t0prev}`)
    ok('D3 未回落旧锚落点（scrollTop ≠ 上一回合气泡贴顶位=用户所报「跳到上一条消息」）',
      sc.scrollTop !== t0prev && t0prev < t0fold, `scrollTop=${sc.scrollTop} t0prev=${t0prev}`)
    ok('D4 占位块重挂 #messages 流末（整页重建洗掉后由 stageSync 重建）',
      !!pin && pin.isConnected && messagesEl.children[messagesEl.children.length - 1] === pin)
    ok(`D5 占位高度 = 视口 − 底 padding − 折叠脚印 = ${VIEW_H}−${PAD_BOT}−120 = 438`,
      pin && pin.style.height === '438px', `height=${pin && pin.style.height}`)
    ok('D6 maxScroll ≡ 新回合贴顶位（未超一屏不变量对折叠锚同样成立）',
      sc.scrollHeight - sc.clientHeight === t0fold, `maxScroll=${sc.scrollHeight - sc.clientHeight} t0fold=${t0fold}`)
    void t0opt
  }

  // ---- E 文档序防误吞：历史旧引导在场 + dequeue 落盘接管 ----
  console.log('\nE 文档序防误吞（旧注入回合历史 + dequeue 接管帧）')
  {
    messagesEl.children.length = 0
    doc.pinWrites.length = 0
    mod.stageRelease()
    const above = mkEl('msg', 200, {})
    const oldFold = mkEl('details done-fold', 120, { 'data-m': '0', 'data-t': 'f' })
    const oldBody = mkEl('done-body', 0, {})
    const oldGuide = mkEl('msg user', 0, { 'data-m': '0', 'data-t': 'g0', 'data-g': '0' })
    oldFold.children.push(oldBody); oldBody.parent = oldFold; oldBody.isConnected = true
    oldBody.children.push(oldGuide); oldGuide.parent = oldBody; oldGuide.isConnected = true
    const newBubble = mkEl('msg user', 64, { 'data-m': '1', 'data-t': 'u' })
    const newReply = mkEl('msg', 200, {})
    messagesEl.appendChild(above); messagesEl.appendChild(oldFold); messagesEl.appendChild(newBubble); messagesEl.appendChild(newReply)
    layout()
    // 乐观参照已死的吸收帧（dead = 已从 DOM 移除的元素）
    const dead = mkEl('msg user msg-in', 0, { 'data-t': 'u' })
    mod.stageRelease()
    mod.stage.active = true
    mod.stage.key = 'optimistic'
    mod.stage.bubble = dead
    mod.stage.el = null
    mod.stageSync()
    ok('E1 参照=末条开启气泡（dequeue 接管原行为，不吞更早回合的旧折叠锚）',
      mod.stage.bubble === newBubble, `bubble=${mod.stage.bubble && mod.stage.bubble.className} attrs=${JSON.stringify(mod.stage.bubble && mod.stage.bubble.attrs)}`)
    ok(`E2 帧末 scrollTop = 新开启气泡贴顶位 ${mod.topInScroll(newBubble)}`,
      sc.scrollTop === mod.topInScroll(newBubble), `scrollTop=${sc.scrollTop}`)
  }
} else {
  console.log('\nC 旧构造对照（复现用户所报）')
  ok('C0 ' + GEO, parseFloat(r.writes[0] || '0') === 494, `writes=${JSON.stringify(r.writes)}`)
  ok('C1 占位写序出现回撤：先写终态 494px 再缩回气泡高 64px（scrollHeight 本趟塌陷）',
    r.writes.length === 2 && r.writes[0] === '494px' && r.writes[1] === '64px', `writes=${JSON.stringify(r.writes)}`)
  ok(`C2 首帧 scrollTop = 内容底 ${r.frame0}（≠ 贴顶位 ${r.t0}）= 画面停在上一回合尾部`,
    r.frame0 === r.maxScroll && r.frame0 < r.t0, `frame0=${r.frame0} maxScroll=${r.maxScroll} t0=${r.t0}`)
  ok('C3 存在待执行 rAF 帧（750ms 滑动窗）', r.frames === 1, `frames=${r.frames}`)
  ok('C4 逐帧推进后才收敛到贴顶位（= 先跳后滑）', r.stepped > 0 && r.frameEnd === r.t0, `stepped=${r.stepped} frameEnd=${r.frameEnd} t0=${r.t0}`)
  ok('C5 几何公式本身无误（缺陷在写序塌陷，非公式）', parseFloat(r.writes[0]) === 494 && r.frameEnd === r.t0)
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 过 / ${fail} 败\n`)
process.exit(fail === 0 ? 0 : 1)
