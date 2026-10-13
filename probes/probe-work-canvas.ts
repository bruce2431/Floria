#!/usr/bin/env bun
/**
 * probe-work-canvas —— .canvas 图形预览（JSON Canvas，仿 Obsidian）结构不变量（2026-10-13，WS2 待办 7）
 *
 * 结构锁点（只读源码；wkCvParse 取真实源码执行）：
 *   1) work-canvas.js 新模块：拼接器 marker 存在；解析器真实执行且容错——坏 JSON / 缺 nodes → err，
 *      有效文档 → nodes+edges，Obsidian 扩展节点（file/link）文本兜底，预设色板 '1'..'6' 与 '#hex'。
 *   2) work-cm.js 语言分流：.canvas 扩展名 → wkCvExt(CM)。
 *   3) wkCvExt 组装：默认图形态（onField create=true）；装饰真源走 StateField 且 provide
 *      EditorView.decorations.from（跨行 block replace 仅 StateField 允许，ViewPlugin 会抛错）；
 *      block replace 覆盖整篇；源码态首行行前挂「图形预览」回流钮；JSON 高亮（源码态可编辑可自动保存）。
 *   4) 画布交互：pointerdown/move stopPropagation（事件不漏给 contenteditable 光标）、wheel ctrlKey
 *      缩放、双指捏合（两 pointer 距离比）、CSS touch-action:none。
 *   5) styles.css：.wk-cv 系列类齐全。
 *   6) PIECES 注册（bundle-web-modules.ts）：缺 = 需他文件配合项未落地，WARN 不计败。
 */
import { readFileSync } from 'fs'
import { resolve } from 'path'

const ROOT = resolve(import.meta.dir, '..')
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8')

let pass = 0
let fail = 0
let warn = 0
const ok = (m: string) => {
  pass++
  console.log(`PASS  ${m}`)
}
const bad = (m: string) => {
  fail++
  console.log(`FAIL  ${m}`)
}
const ww = (m: string) => {
  warn++
  console.log(`WARN  ${m}`)
}

const cv = read('src/gateway/web-src/sidebar/work/work-canvas.js')
const cm = read('src/gateway/web-src/sidebar/work/work-cm.js')
const css = read('src/gateway/web/styles.css')
const bundle = read('scripts/bundle-web-modules.ts')

// ---- 1. work-canvas.js：模块与解析器 ----
if (/\/\* @module sidebar\/work\/work-canvas\.js \*\//.test(cv)) ok('拼接 marker 齐全（可进 PIECES 单 IIFE）')
else bad('缺 @module marker —— 拼接器无法切片')
if (!/^\s*(import|export)\s/m.test(cv)) ok('无 import/export（单 IIFE 共享作用域切片约束）')
else bad('含 import/export —— 拼接器切片约束被破坏')

// 解析器真实执行：提取 WKCV_PRESET..wkCvSummary 段（纯解析函数，无 DOM/state 依赖）
const s0 = cv.indexOf('const WKCV_PRESET')
const s1 = cv.indexOf('// ---------- 相机')
if (s0 > 0 && s1 > s0) {
  const seg = cv.slice(s0, s1)
  try {
    const wkCvParse = new Function(`${seg}; return wkCvParse`)() as (t: string) => any
    const e1 = wkCvParse('not json {')
    if (e1.err) ok('坏 JSON → err（容错）')
    else bad('坏 JSON 未返 err')
    const e2 = wkCvParse('{"edges":[]}')
    if (e2.err && /nodes/.test(e2.err)) ok('缺 nodes 数组 → err')
    else bad('缺 nodes 未识别')
    const good = wkCvParse(
      JSON.stringify({
        nodes: [
          { id: 'a', type: 'group', x: 0, y: 0, width: 300, height: 200, color: '4', label: '章节' },
          { id: 'b', type: 'text', x: 20, y: 30, width: 120, height: 60, text: '你好', color: '#ff0000' },
          { id: 'c', type: 'file', x: 200, y: 40, width: 90, height: 50, file: 'MATH/main.tex' },
        ],
        edges: [
          { fromNode: 'b', toNode: 'c', toEnd: 'arrow', label: '引用', color: '6' },
          { fromNode: 'c', toNode: 'x-missing', toEnd: 'none' },
        ],
      })
    )
    if (!good.err && good.nodes.length === 3 && good.edges.length === 1) ok('有效文档 → 3 节点 1 边（悬挂边被滤）')
    else bad(`有效文档解析异常：${JSON.stringify(good).slice(0, 120)}`)
    const grp = good.nodes.find((n: any) => n.id === 'a')
    const fil = good.nodes.find((n: any) => n.id === 'c')
    const txt = good.nodes.find((n: any) => n.id === 'b')
    if (grp && grp.type === 'group') ok('type:group 识别')
    else bad('type:group 未识别')
    if (fil && fil.type === 'file' && fil.text === 'MATH/main.tex') ok('Obsidian file 节点 → text 兜底为文件名')
    else bad('file 节点文本兜底失败')
    if (txt && txt.color === '#ff0000') ok('#hex 直通')
    else bad('#hex 解析失败')
    if (grp && grp.color === '#4caf62') ok("预设色板 '4' → 值")
    else bad("预设色板 '4' 解析失败")
    const empty = wkCvParse('{"nodes":[]}')
    if (!empty.err && empty.nodes.length === 0) ok('空 nodes → 空画布（非错误）')
    else bad('空画布误判为错误')
  } catch (e) {
    bad(`解析器执行异常：${e}`)
  }
} else bad('解析器段定位失败（源码结构漂移）')

// ---- 2. work-cm.js 分流 ----
if (/e === 'canvas'\) return wkCvExt\(CM\)/.test(cm)) ok('wkEdLangExt：.canvas → wkCvExt(CM)')
else bad('wkEdLangExt 缺 .canvas 分流')

// ---- 3. wkCvExt 组装 ----
if (/create: \(\) => true/.test(cv)) ok('onField 默认图形态（create=true）')
else bad('onField 未默认图形态')
if (/provide: \(f\) => CM\.EditorView\.decorations\.from\(f\)/.test(cv)) ok('decoField provide EditorView.decorations.from')
else bad('decoField 缺 provide —— 装饰不生效')
if (/Decoration\.replace\(\{ widget: new WkCvWidget\(st\.doc\.toString\(\)\), block: true \}\)/.test(cv)) ok('图形态 = block replace 覆盖整篇')
else bad('缺 block replace 整篇装饰')
if (/WkCvOpenBtn/.test(cv) && /图形预览/.test(cv)) ok('源码态有「图形预览」回流钮')
else bad('源码态缺回流入口')
if (/CM\.json\(\),\s*CM\.syntaxHighlighting\(wkEdHlStyle\)/.test(cv)) ok('源码态 JSON 高亮（复用 wkEdHlStyle）')
else bad('源码态缺 JSON 高亮')
if (/deco\.map\(tr\.changes\)/.test(cv)) ok('无关变化走 map（不动装饰）')
else bad('update 缺 deco.map 短路')
// widget 必须继承 CM.WidgetType（缺基类方法 ⇒ 首次 docChanged 半更新抛 TypeError，编辑区整体报废）
if (/const WkCvWidgetBase = window\.CMLiveMarkdown\.WidgetType/.test(cv)) ok('取 CM.WidgetType 基类')
else bad('未取 CM.WidgetType 基类 —— widget 非 WidgetType，视图更新会崩')
if (/class WkCvWidget extends WkCvWidgetBase/.test(cv)) ok('WkCvWidget 继承 WidgetType')
else bad('WkCvWidget 未继承 WidgetType —— 打开即崩')
if (/class WkCvOpenBtn extends WkCvWidgetBase/.test(cv)) ok('WkCvOpenBtn 继承 WidgetType')
else bad('WkCvOpenBtn 未继承 WidgetType')
if (/constructor\(text\) \{ super\(\); this\.text = text \}/.test(cv)) ok('WkCvWidget 派生构造首行 super()')
else bad('WkCvWidget 派生构造缺 super()')

// ---- 4. 画布交互 ----
if (/pointerdown[\s\S]*?stopPropagation\(\)/.test(cv)) ok('画布指针事件 stopPropagation（不漏给编辑器光标）')
else bad('画布事件未截断')
if (/e\.ctrlKey/.test(cv) && /Math\.exp\(-e\.deltaY/.test(cv)) ok('Ctrl+滚轮 = 指针锚定缩放')
else bad('缺 Ctrl+滚轮缩放')
if (/active\.size === 2/.test(cv) && /pinch\.k \* \(d \/ pinch\.d\)/.test(cv)) ok('双指捏合 = 距离比缩放')
else bad('缺双指捏合')
if (/setPointerCapture/.test(cv)) ok('指针捕获（拖出画布仍跟手）')
else bad('缺指针捕获')

// ---- 5. styles.css ----
for (const cls of ['.wk-cv {', '.wk-cv-bar', '.wk-cv-btn', '.wk-cv-svg', '.wk-cv-edge', '.wk-cv-box', '.wk-cv-text', '.wk-cv-empty', '.wk-cv-dot']) {
  if (css.includes(cls)) ok(`styles.css 含 ${cls.replace(/[^a-z-].*/, '')}`)
  else bad(`styles.css 缺 ${cls}`)
}
if (/\.wk-cv \{[^}]*touch-action: none/.test(css)) ok('画布 touch-action:none（手势归模块 JS）')
else bad('画布未设 touch-action:none')

// ---- 6. PIECES 注册（需他文件配合） ----
if (/work-canvas\.js/.test(bundle)) ok('PIECES 已注册 work-canvas.js')
else ww('PIECES 未注册 work-canvas.js —— 需他文件配合（在 work-cm.js 行后插 { file: \'sidebar/work/work-canvas.js\', part: 1 }）')

console.log(`\n${pass} pass, ${fail} fail, ${warn} warn`)
process.exit(fail ? 1 : 0)
