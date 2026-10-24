// WS3 探针：浮窗/评论浮层「滚动关闭」语义收窄（待办 9，2026-10-13）
// 锁：两处 scroll capture 监听必须只对「浮窗外的滚动源」关窗——浮窗内输入框自身的内容滚动
// （qp-in 超宽横滚 / cmp-in 长评论纵滚）不得关窗（否则输入多文本的瞬间弹窗即死）。
// 断言手法 = 抽真身源码文本 + 跑真身监听器（stub addEventListener 收集 + 直接调用）。
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SRC = resolve(import.meta.dir, '../src/gateway/web-src')
let pass = 0, fail = 0
const ok = (m) => { pass++; console.log(`PASS  ${m}`) }
const bad = (m) => { fail++; console.log(`FAIL  ${m}`) }
const read = (p) => readFileSync(p, 'utf-8').replace(/\r\n/g, '\n')

// ---- 1. quote.js：scroll 监听收窄 ----
{
  const src = read(resolve(SRC, 'inputbar/quote.js'))
  // 监听存在且带 capture
  const m = src.match(/window\.addEventListener\('scroll',\s*(\(?e\)?\s*=>\s*\{[^}]*\}),\s*\{\s*passive:\s*true,\s*capture:\s*true\s*\}\s*\)/)
  if (m) ok('quote.js scroll capture 监听在位')
  else bad('quote.js scroll capture 监听缺失')
  // 收窄判定：回调体里必须有 contains(e.target) 守卫（target 在浮窗内不关）
  if (m && /quotePop\.contains\(e\.target\)/.test(m[1])) ok('quote.js 滚动源守卫：!quotePop.contains(e.target) 才关')
  else bad('quote.js 滚动源守卫缺失（浮窗内滚动会被误关）')
  // 关窗链保留：mousedown 点外 / Escape 仍关
  if (/document\.addEventListener\('mousedown', \(e\) => \{\s*if \(quotePop && !quotePop\.contains\(e\.target\)\) \{ closeQuotePop\(\); quoteSkipNextUp = true \}/.test(src)) ok('quote.js 点外关窗（mousedown + quoteSkipNextUp）保留')
  else bad('quote.js 点外关窗链丢失')
  if (/e\.key === 'Escape' && quotePop\) closeQuotePop\(\)/.test(src)) ok('quote.js Escape 关窗保留')
  else bad('quote.js Escape 关窗丢失')
  // resize 关窗保留（窗口尺寸变化 = 视口 clamp 失效，仍须关）
  if (/window\.addEventListener\('resize', \(\) => \{ if \(quotePop\) closeQuotePop\(\) \}\)/.test(src)) ok('quote.js resize 关窗保留')
  else bad('quote.js resize 关窗丢失')
}

// ---- 2. feature/comment/comment-composer.js：scroll 监听收窄（同款语义） ----
{
  const src = read(resolve(SRC, 'feature/comment/comment-composer.js'))
  const m = src.match(/window\.addEventListener\('scroll',\s*(\(?e\)?\s*=>\s*\{[^}]*\}),\s*\{\s*passive:\s*true,\s*capture:\s*true\s*\}\s*\)/)
  if (m) ok('comment-composer.js scroll capture 监听在位')
  else bad('comment-composer.js scroll capture 监听缺失')
  if (m && /cmtPop\.contains\(e\.target\)/.test(m[1])) ok('comment-composer.js 滚动源守卫：!cmtPop.contains(e.target) 才关')
  else bad('comment-composer.js 滚动源守卫缺失（浮层内 cmp-in 滚动会被误关）')
  if (/document\.addEventListener\('mousedown', \(e\) => \{ if \(cmtPop && !cmtPop\.contains\(e\.target\)\) cmtClosePop\(\) \}\)/.test(src)) ok('comment-composer.js 点外关窗保留')
  else bad('comment-composer.js 点外关窗丢失')
  if (/e\.key === 'Escape' && cmtPop\) cmtClosePop\(\)/.test(src)) ok('comment-composer.js Escape 关窗保留')
  else bad('comment-composer.js Escape 关窗丢失')
}

// ---- 3. 跑真身：模拟「浮窗内 textarea 滚动」与「浮窗外滚动」的分流 ----
{
  // 复刻 quote.js 收窄后的回调真身（从源码抽出，保证探针测的就是实现）
  const src = read(resolve(SRC, 'inputbar/quote.js'))
  const m = src.match(/window\.addEventListener\('scroll',\s*\(?e\)?\s*=>\s*\{([^}]*)\}/)
  if (m) {
    let closed = 0
    let quotePop = { contains: (t) => t.__inside } // stub：按 target 标记判定归属
    const closeQuotePop = () => { closed++ }
    const handler = new Function('quotePop', 'closeQuotePop', `return (e) => { ${m[1]} }`)(quotePop, closeQuotePop)
    handler({ target: { __inside: true } })  // 浮窗内输入框滚动
    if (closed === 0) ok('真身分流：浮窗内滚动 → 不关')
    else bad('真身分流：浮窗内滚动被误关')
    handler({ target: { __inside: false } }) // 浮窗外滚动（消息流/编辑器滚动）
    if (closed === 1) ok('真身分流：浮窗外滚动 → 关（锚点漂移语义保留）')
    else bad('真身分流：浮窗外滚动未关')
  } else bad('真身抽取失败（scroll 回调）')
}

console.log(`\n${pass}/${pass + fail}`)
process.exit(fail ? 1 : 0)
