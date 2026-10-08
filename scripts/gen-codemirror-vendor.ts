/**
 * gen-codemirror-vendor.ts —— 生成 work 编辑区 Live Preview 用的 vendored 全局脚本。
 *
 * 背景：src/gateway/web/app.js 由 scripts/bundle-web-modules.ts 拼接 web-src/ 模块产出，
 * 该拼接器不做任何 npm 解析 ⇒ 第三方库只能以 vendored 全局 <script> 形式随 exe 内嵌
 * （先例：vendor/katex/）。故此处把 CodeMirror 6 + codemirror-live-markdown 打成一个
 * IIFE 全局 window.CMLiveMarkdown，产物提交进仓库。
 *
 * 手动运行（不接进 build.ts —— 常规构建不联网、不需要 node_modules）：
 *   cd Floria && "$BUN" scripts/gen-codemirror-vendor.ts
 *
 * 依赖装在同目录 scratch 工程 scripts/vendor-codemirror/（node_modules 被 .gitignore 排除）。
 */
import { spawnSync } from 'node:child_process'

const here = import.meta.dir
const scratchDir = `${here}/vendor-codemirror`
const entry = `${scratchDir}/entry.js`
const outDir = `${here}/../src/gateway/web/vendor/codemirror`
const outName = 'live-markdown.js'

// 1) 安装/对齐依赖（幂等）
const install = spawnSync(process.execPath, ['install'], { cwd: scratchDir, stdio: 'inherit' })
if (install.status !== 0) {
  console.error('[gen-codemirror-vendor] bun install 失败')
  process.exit(1)
}

// 2) 打包成 IIFE（浏览器 target，压缩）
const result = await Bun.build({
  entrypoints: [entry],
  outdir: outDir,
  naming: outName,
  target: 'browser',
  format: 'iife',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
})
if (!result.success) {
  console.error('[gen-codemirror-vendor] 打包失败：')
  for (const log of result.logs) console.error(log)
  process.exit(1)
}

// 3) 校验产物是纯 IIFE（无顶层 export / 动态 import 残留），并报大小
const outFile = `${outDir}/${outName}`
const text = await Bun.file(outFile).text()
const badExport = /(^|\n)\s*export\s*[{*]/.test(text)
const badImport = /(^|\n)\s*import\s*\(/.test(text) || /\bimport\s*\(\s*["']/.test(text)
if (badExport || badImport) {
  console.error(`[gen-codemirror-vendor] 产物不是纯 IIFE（export=${badExport} import()=${badImport}）——检查打包格式`)
  process.exit(1)
}
console.log(`[gen-codemirror-vendor] ok → ${outFile} (${(text.length / 1024).toFixed(0)} KB)`)
