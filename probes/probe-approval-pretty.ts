/**
 * 探针：审批卡正文格式化（web-src/inputbar/approval.js prettyToolInput）离线自测
 *
 * 为什么这样做：web 前端手改处是 ESM 模块（依赖 DOM/state.js 顶层初始化），不能直接在 bun 里 import。
 * 本探针从源码「按标记区间切片」取出纯函数（FIELD_LABELS…prettyToolInput，无 DOM 依赖）后求值，
 * 用 state.js 里同款 esc 实现做注入——测的是真源码，不是复制品。
 *
 * 运行：cd Floria && bun probes/probe-approval-pretty.ts
 */
import { readFileSync } from 'node:fs'

const SRC = 'src/gateway/web-src/inputbar/approval.js'
const src = readFileSync(SRC, 'utf-8')
const START = '  // ===== 审批卡正文渲染'
const END = '  function renderApproval(a) {'
const i = src.indexOf(START)
const j = src.indexOf(END)
if (i < 0 || j < 0 || j < i) { console.error('❌ 切片标记未命中：审批卡正文渲染区间'); process.exit(1) }
const body = src.slice(i, j)
// 与 web-src/core/state.js:51 同款 esc（探针注入）
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
// mdHtml 在真实运行期来自 core/markdown.js（依赖 MENTION_* 等 DOM 侧模块，不宜整段切片）；
// 探针注入记录型 stub——只验证 ExitPlanMode 分支「把 plan 交给 mdHtml 并包进 .appr-md」的接线，
// 不重复测 markdown 解析本身（那是 core/markdown.js 的职责）。
const mdCalls: string[] = []
const mdHtmlStub = (s: unknown) => {
  mdCalls.push(String(s ?? ''))
  return `<p>${esc(s)}</p>`
}
const prettyToolInput = new Function('esc', 'mdHtml', `${body}\nreturn prettyToolInput`)(esc, mdHtmlStub) as (
  tool: string, input: unknown, desc?: string,
) => string

let pass = 0
const fails: string[] = []
function ok(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; return }
  fails.push(`${name}${extra ? ' — ' + extra : ''}`)
}

// ---- ① Edit：红/绿两段文本 diff，不再是 JSON ----
const edit = prettyToolInput('Edit', {
  file_path: 'Pj16-CodeAgent构建/Floria/src/gateway/web/styles.css',
  old_string: '#input-bar { transition: height 0.32s; }',
  new_string: '#input-bar { transition: height 0.32s; }\n#input-bar.bar-reveal > :not(#composer-takeover) { animation: barRevealIn 0.17s ease-out both; }',
  replace_all: false,
})
ok('Edit: 走 diff 结构', edit.includes('appr-diff') && edit.includes('appr-diff-b old') && edit.includes('appr-diff-b new'))
ok('Edit: 旧文本带 - 前缀', edit.includes('- #input-bar { transition: height 0.32s; }'))
ok('Edit: 新文本带 + 前缀', edit.includes('+ #input-bar.bar-reveal'))
ok('Edit: 行数统计', edit.includes('旧文本 · 1 行') && edit.includes('新文本 · 2 行'))
ok('Edit: 无转义换行残留', !edit.includes('\\n'))
ok('Edit: 无 JSON 键名裸奔', !edit.includes('old_string') && !edit.includes('new_string'))
ok('Edit: replace_all=false 不渲染「替换全部」', !edit.includes('替换全部'))
const editAll = prettyToolInput('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y', replace_all: true })
ok('Edit: replace_all=true 有提示', editAll.includes('替换文件中全部匹配'))

// ---- ② XSS/转义：内容里的标签必须被转义 ----
const evil = prettyToolInput('Write', { file_path: 'a.html', content: '<script>alert(1)</script>\n<img src=x onerror=1>' })
ok('Write: 尖括号被转义', evil.includes('&lt;script&gt;') && !evil.includes('<script>'))
ok('Write: 多行内容落 mono 块', evil.includes('appr-pre'))
ok('Write: 文件行 + 内容块', evil.includes('appr-kv') && evil.includes('文件') && evil.includes('内容'))

// ---- ③ Bash：命令原文（非 JSON）+ 元信息；与卡头说明重复的 description 不重复渲染 ----
const bash = prettyToolInput('Bash', { command: 'ls -la "a b" && echo done', description: '列出目录', timeout: 30000 }, '列出目录')
ok('Bash: 命令原文在 pre 块', bash.includes('appr-pre') && bash.includes('ls -la &quot;a b&quot; &amp;&amp; echo done'))
ok('Bash: 与卡头说明重复的 description 不渲染', !bash.includes('说明'))
ok('Bash: 超时用毫秒中文标签', bash.includes('超时') && bash.includes('30000'))
ok('Bash: 无 JSON 键名裸奔', !bash.includes('timeout&quot;'))

// ---- ④ 字段顺序与布尔/空值处理（Read / 未知工具）----
const read = prettyToolInput('Read', { file_path: '/tmp/x.ts', offset: 100, limit: 50 })
ok('Read: 顺序 文件→起始行→行数', read.indexOf('文件') < read.indexOf('起始行') && read.indexOf('起始行') < read.indexOf('行数'))
const unknown = prettyToolInput('SomeFutureTool', { alpha: 1, flag: true, off: false, none: null, blank: '', nested: { a: 1 } })
ok('未知工具: true→是', unknown.includes('是'))
ok('未知工具: false/null/空串不渲染', !unknown.includes('off') && !unknown.includes('none') && !unknown.includes('blank'))
ok('未知工具: 嵌套对象 JSON 内联', unknown.includes('{&quot;a&quot;:1}'))
ok('未知工具: 仍非原始 JSON 倾倒（无 appr-command 时代的外层花括号）', !unknown.trim().startsWith('{'))

// ---- ⑤ ExitPlanMode：计划正文走 Markdown，不再落 appr-pre 纯文本 ----
const plan = prettyToolInput('ExitPlanMode', {
  plan: '# 计划\n\n- 第一步\n- 第二步\n\n```ts\nconst a = 1\n```',
  allowedPrompts: [{ tool: 'Bash', prompt: 'run tests' }],
})
ok('ExitPlanMode: plan 交给 mdHtml', mdCalls.some((s) => s.includes('# 计划') && s.includes('第一步')))
ok('ExitPlanMode: 包 .appr-md 且不落 appr-pre', plan.includes('appr-md') && !plan.includes('appr-pre'))
ok('ExitPlanMode: 与卡头说明不重复/其余字段照渲', plan.includes('appr-kvs') && plan.includes('allowedPrompts'))
ok('ExitPlanMode: 无 plan 不渲空 md 容器', prettyToolInput('ExitPlanMode', {}) === '' && !prettyToolInput('ExitPlanMode', { plan: '   ' }).includes('appr-md'))

// ---- ⑥ 空输入不炸 ----
ok('空输入返回空串', prettyToolInput('Bash', {}) === '' && prettyToolInput('Edit', null) !== undefined)

console.log('渲染样例（Edit 切片前 6 行）:')
console.log(edit.split('\n').slice(0, 6).join('\n'))
console.log(`\n结果: ${pass} 通过 / ${fails.length} 失败`)
for (const f of fails) console.log('  ❌ ' + f)
process.exit(fails.length ? 1 : 0)
