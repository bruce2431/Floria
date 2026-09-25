#!/usr/bin/env bun
/**
 * probe-web-module-scope —— web-src 模块顶层声明同名冲突（构建期不变量）
 *
 * 背景：`scripts/bundle-web-modules.ts` 把 `src/gateway/web-src/**` 各模块体**原样拼进同一个 IIFE**
 * （剥掉 `import` 行，保留 2 空格模块缩进），因此**全部模块的顶层声明共享一个作用域**。
 * 两个模块声明同名顶层 `function`/`const` 时，后出现者（按 MODULES 表执行序）在整个作用域内
 * 覆盖先出现者，且**不报错**——先声明者的调用点静默跑到另一个实现上。
 * 实例：`sidebar/work.js` 的 `projList()`（返回 group 对象数组）被 `inputbar/commands.js` 的
 * `projList()`（返回 label 字符串数组）覆盖 ⇒ 下拉渲染出 7 行空按钮（`.wkp-name` 取 `g.label` = undefined）。
 *
 * 只读结构探针：从 `scripts/bundle-web-modules.ts` 的 MODULES 表取模块清单与顺序，
 * 逐文件抽顶层声明（缩进 ≤ 2 的 `function`/`const`/`let`/`var`/`class`），报告同名冲突。
 */
import { readFileSync, existsSync } from 'fs'
import { resolve } from 'path'

const ROOT = resolve(import.meta.dir, '..')
const SRC = resolve(ROOT, 'src/gateway/web-src')
const BUNDLER = resolve(ROOT, 'scripts/bundle-web-modules.ts')

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

// ---- 1. 模块清单与顺序（真源 = 拼接器 MODULES 表）----
const bundlerSrc = readFileSync(BUNDLER, 'utf-8')
const mods: { file: string; order: number }[] = []
for (const m of bundlerSrc.matchAll(/\{\s*file:\s*'([^']+)',\s*ranges:\s*\[\[(\d+)/g)) {
  mods.push({ file: m[1], order: Number(m[2]) })
}
if (mods.length >= 20) ok(`从拼接器读出 ${mods.length} 个模块区间`)
else bad(`拼接器 MODULES 表解析异常，只读到 ${mods.length} 个区间`)

// 拼接器 prelude 注入的名字（见 bundle-web-modules.ts 的 head 拼装）
const PRELUDE = ['$']

// ---- 2. 抽每个模块的顶层声明 ----
const pat =
  /^ {0,2}(?:export\s+)?(?:(?:async\s+)?function|class)\s+([A-Za-z_$][\w$]*)|^ {0,2}(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/
type Decl = { name: string; file: string; line: number; order: number }
const decls: Decl[] = []
for (const m of mods) {
  const p = resolve(SRC, m.file)
  if (!existsSync(p)) {
    console.log(`  跳过不存在模块 ${m.file}`)
    continue
  }
  const lines = readFileSync(p, 'utf-8').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    // 模块体从文件头就是顶层（无外层包裹），缩进 ≤2 的声明即共享作用域可见
    const mm = pat.exec(lines[i])
    if (!mm) continue
    const name = mm[1] || mm[2]
    if (!name) continue
    decls.push({ name, file: m.file, line: i + 1, order: m.order })
  }
}
ok(`抽出 ${decls.length} 条顶层声明（${mods.length} 个模块）`)

// ---- 3. 同名冲突 ----
const byName = new Map<string, Decl[]>()
for (const d of decls) {
  const a = byName.get(d.name)
  if (a) a.push(d)
  else byName.set(d.name, [d])
}
const dups = [...byName.entries()].filter(([, a]) => a.length > 1)
if (dups.length === 0) {
  ok('无模块间顶层声明同名冲突（全部模块共享同一 IIFE 作用域）')
} else {
  for (const [name, a] of dups) {
    bad(
      `顶层声明同名冲突 \`${name}\` → ` +
        a.map((d) => `${d.file}:${d.line}(序${d.order})`).join(' / ') +
        '（后声明者静默覆盖先声明者）',
    )
  }
}

// ---- 4. 与拼接器 prelude 注入名冲突 ----
for (const n of PRELUDE) {
  const hit = byName.get(n)
  if (hit) bad(`模块顶层声明 \`${n}\` 与拼接器 prelude 注入的 \`${n}\` 同名（${hit[0].file}:${hit[0].line}）`)
}
if (PRELUDE.every((n) => !byName.get(n))) ok('无模块与拼接器 prelude 注入名冲突')

// ---- 5. 产物侧复核：直接扫 app.js 的顶层声明（覆盖 MODULES 之外的首尾区间，独立于上面的抽取）----
const APP = resolve(ROOT, 'src/gateway/web/app.js')
if (existsSync(APP)) {
  const appLines = readFileSync(APP, 'utf-8').split(/\r?\n/)
  const seen = new Map<string, number[]>()
  for (let i = 0; i < appLines.length; i++) {
    const mm = pat.exec(appLines[i])
    const name = mm && (mm[1] || mm[2])
    if (!name) continue
    const a = seen.get(name)
    if (a) a.push(i + 1)
    else seen.set(name, [i + 1])
  }
  const appDups = [...seen.entries()].filter(([, a]) => a.length > 1)
  if (appDups.length === 0) ok(`产物 app.js 顶层声明无重复（扫 ${seen.size} 个名字）`)
  else
    bad(
      `产物 app.js 顶层声明重复：` +
        appDups.map(([n, a]) => `${n}(行 ${a.join('/')})`).join('、') +
        '（后声明者覆盖先声明者）',
    )
} else {
  bad('缺少产物 src/gateway/web/app.js')
}

console.log(`\n${pass}/${fail}`)
process.exit(fail === 0 ? 0 : 1)
