// vendor 全局取值件（2026-10-15 editor/ 模块组专用）：bundler 剥 ESM import 拼单 IIFE，CM6 一律经
// window.CMLiveMarkdown 取（vendor/codemirror/live-markdown.js 在 app.js 之前加载）。本件只做
// 「取值出口」；命名 edCMG/edCmg 防与宿主件（composer-cm/work-cm 各自的 CMG/CM）单 IIFE 内重名。
/* @module editor/cm-global.js */

const edCMG = typeof window !== 'undefined' ? window.CMLiveMarkdown : null

function edCmg() {
  if (!edCMG) throw new Error('CodeMirror 未加载（window.CMLiveMarkdown 缺失）')
  return edCMG
}

export { edCMG, edCmg }
