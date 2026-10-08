// CodeMirror 6 vendored 打包入口 —— 仅被 scripts/gen-codemirror-vendor.ts 打包成全局 IIFE。
// 产物把全部 API 挂到 window.CMLiveMarkdown，供 web-src/sidebar/work.js 使用
// （web 前端拼接器不做 npm 解析，第三方库一律走 vendored 全局脚本，同 KaTeX 先例）。
import {
  EditorState, EditorSelection, Annotation, StateEffect, StateField,
  RangeSetBuilder, Compartment, Prec,
} from '@codemirror/state'
import { EditorView, Decoration, keymap, WidgetType, ViewPlugin } from '@codemirror/view'
import { history, defaultKeymap, historyKeymap, indentWithTab } from '@codemirror/commands'
import { StreamLanguage, syntaxHighlighting, HighlightStyle, syntaxTree } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { python } from '@codemirror/lang-python'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { yaml } from '@codemirror/legacy-modes/mode/yaml'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import {
  collapseOnSelectionFacet, mouseSelectingField, livePreviewPlugin, markdownStylePlugin,
  editorTheme, shouldShowSource, setMouseSelecting, setTableCellRenderer,
  blockMathField, mathPlugin, tableField, tableEditorPlugin, codeBlockField, imageField, linkPlugin,
  initHighlighter, registerLanguage, renderMath,
} from 'codemirror-live-markdown'

window.CMLiveMarkdown = {
  // @codemirror/state
  EditorState, EditorSelection, Annotation, StateEffect, StateField, RangeSetBuilder, Compartment, Prec,
  // @codemirror/view
  EditorView, Decoration, keymap, WidgetType, ViewPlugin,
  // @codemirror/commands
  history, defaultKeymap, historyKeymap, indentWithTab,
  // @codemirror/language
  StreamLanguage, syntaxHighlighting, HighlightStyle, syntaxTree,
  // @lezer/highlight
  tags,
  // @codemirror/lang-*
  markdown, markdownLanguage, javascript, json, css, html, python,
  // @codemirror/legacy-modes（StreamLanguage 包装器）
  shell, yaml, stex,
  // codemirror-live-markdown
  collapseOnSelectionFacet, mouseSelectingField, livePreviewPlugin, markdownStylePlugin,
  editorTheme, shouldShowSource, setMouseSelecting, setTableCellRenderer,
  blockMathField, mathPlugin, tableField, tableEditorPlugin, codeBlockField, imageField, linkPlugin,
  initHighlighter, registerLanguage, renderMath,
}
