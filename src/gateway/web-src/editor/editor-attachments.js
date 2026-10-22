// 附件链（2026-10-15 待办返修轮任务D，方案 §任务D「附件」+ 待办 13）：
// 上传后**在原文插 md 引用**（图片 `![名](uploads/x.png)` / 文件 `[名](uploads/x.pdf)`），
// 底栏不再以图片/文件胶囊为主要表达形式（胶囊渲染链退役，pendingImages/pendingFiles 视觉上行
// 内部态保留——发送链 [Image #N]/[文件:占位] 不变量原样）。渲染：图片按扩展名行内直渲（CM6 widget
// 插件，vendor live preview 无 image 渲染，此处补缺）；文件为文件名链接（live preview 链接样式）。
import { toast, newSessionProject } from '../core/util.js'
import { fileIcon } from '../core/icons.js'
import { apiUrl } from '../engine/gateway.js'
import { live, state } from '../engine/state.js'
import { findSession } from '../engine/sessions.js'
import { edCmg } from './cm-global.js'
/* @module editor/editor-attachments.js */

  // ---------- 判类（按扩展名，方案 isImageAttachment / isDocumentAttachment） ----------
  const ATT_IMG_RE = /\.(png|jpe?g|webp|gif|bmp|svg)$/i
  function isImageAttachment(name) { return ATT_IMG_RE.test(String(name || '')) }
  function isDocumentAttachment(name) { return !isImageAttachment(name) }

  // 落盘名 = 原名主体 + `-YYYYMMDDHHMMSS`（精确到秒）+ 原扩展名，如 `报告-20261022183608.docx`。
  // 保留原名（用户要求：已有名字的文件不得被纯时间戳顶替），时间戳只作同名防覆盖；
  // 同一秒内同名的极端情形仍由网关 `-1/-2` 去重兜底。
  function uploadStampName(file) {
    const raw = String(file.name || '').split(/[\\/]/).pop() || 'file'
    const m = /^(.*?)(\.[A-Za-z0-9]+)?$/.exec(raw)
    const base = (m[1] || 'file').trim() || 'file'
    const ext = m[2] || ''
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
    return `${base}-${stamp}${ext}`
  }

  // ---------- 上传（与 + 浮窗「上传文件」同一端点/落点/认证链） ----------
  // POST /gateway/upload（原始字节直传）→ 网关落盘 <会话根>/uploads/；sid=当前会话、无会话时
  // project=newSessionProject()（与 gwSend 首送建会话归属同源，保证上传落点=消息会话落点）。
  async function uploadAttachment(file) {
    const tgt = newSessionProject()
    const ctx = state.currentHash
      ? '&sid=' + encodeURIComponent(state.currentHash)
      : (tgt ? '&project=' + encodeURIComponent(tgt) : '')
    try {
      const r = await fetch(apiUrl('/gateway/upload?name=' + encodeURIComponent(uploadStampName(file)) + ctx), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || !d.ok) { toast('上传失败：' + (d.error || r.status)); return null }
      return { name: d.name || file.name || '文件', abs: String(d.abs || d.path || ''), size: d.size || 0 }
    } catch {
      toast('上传失败：网络错误')
      return null
    }
  }

  // ---------- md 引用插入（经 editor-command 调度，禁直改 doc） ----------
  // 引用路径恒 uploads/<落盘名>（同会话上传+发送 = 会话 cwd 相对路径，send.js relUploadPath 同口径；
  // 跨会话补发由用户改文本——旧胶囊链的 [文件:占位] 仍随 pendingFiles 在发送侧自动相对化，不受影响）。
  function insertAttachmentMarkdown(target, att) {
    if (!att) return false
    const md = isImageAttachment(att.name)
      ? `![${att.name}](uploads/${encodeURIComponent(att.name)})`
      : `[${att.name}](uploads/${encodeURIComponent(att.name)})`
    return editorCommand('insert', { text: md }, target)
  }

  // ---------- 取图 URL 解析（复用 GET /gateway/file?label=&path=） ----------
  // label 取法与 chat/messages.js AI 图 resolver 同口径：work 模式 = workProj；会话态 = 会话自带
  // projectLabel（全局根会话=「全局根 · 散装对话」，网关按 label 解析到工作区根）。解析不出 → null
  // （不兜底：widget 不挂，原样显源码）。
  function attachmentUrl(relPath) {
    const label = state.sbMode === 'work' && state.workProj
      ? state.workProj
      : (findSession(live.curUuid) || {}).projectLabel || ''
    if (!label) return null
    return `/gateway/file?label=${encodeURIComponent(label)}&path=${encodeURIComponent(relPath)}`
  }

  // ---------- 行内图片 widget（vendor 无 image 渲染的补缺件，2026-10-15） ----------
  // syntaxTree 扫 Image 节点（`![alt](url)`）：url 为 uploads/ 引用且能解析出取图 URL → 原子 replace
  // 成 <img>；光标/拖选落在区间内 = 显源码（与 vendor live preview 显隐口径一致）。非 uploads 引用
  // （AI 生成图代号等）不接管，仍走各自链路。
  const edImgWidgetBase = class extends edCmg().WidgetType {
    constructor(url, alt) { super(); this.url = url; this.alt = alt }
    eq(o) { return o.url === this.url && o.alt === this.alt }
    ignoreEvent() { return true }
    // 图字节异步到位 ⇒ 行高在 CM 量过之后才变；高度图陈旧会让**下方**的点击/光标映射整体偏移
    // （2026-10-21 待办「概率出现点击位置与光标偏移」）。加载完/失败都求一次重量，把行高落回高度图。
    toDOM(view) {
      const wrap = document.createElement('span')
      wrap.className = 'cm-att-img'
      const img = document.createElement('img')
      img.src = this.url
      img.alt = this.alt
      img.loading = 'lazy'
      const remeasure = () => { if (view && view.dom.isConnected) view.requestMeasure() }
      img.addEventListener('load', remeasure, { once: true })
      img.addEventListener('error', remeasure, { once: true })
      wrap.appendChild(img)
      return wrap
    }
  }
  const edAttImgPlugin = edCmg().ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = this.build(view) }
    update(u) { if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = this.build(u.view) }
    build(view) {
      const CM = edCmg()
      const deco = []
      const isDrag = view.state.field(CM.mouseSelectingField, false)
      let active = null
      if (!isDrag) {
        for (const r of view.state.selection.ranges) {
          if (!r.empty) { active = { from: r.from, to: r.to }; break }
        }
      }
      CM.syntaxTree(view.state).iterate({
        enter: (node) => {
          if (node.name !== 'Image') return
          const text = view.state.sliceDoc(node.from, node.to)
          const m = /^!\[([^\]]*)\]\((uploads\/[^)\s]+)\)$/.exec(text)
          if (!m) return
          let url = null
          try { url = attachmentUrl(decodeURIComponent(m[2])) } catch { return } // 引用路径非法 → 不接管
          if (!url) return
          if (active && node.from < active.to && node.to > active.from) return // 选区内 = 显源码
          deco.push(CM.Decoration.replace({ widget: new edImgWidgetBase(url, m[1]) }).range(node.from, node.to))
        },
      })
      return CM.Decoration.set(deco.sort((a, b) => a.from - b.from), true)
    }
  }, { decorations: (v) => v.decorations })

  // ---------- 行内文件引用 widget（2026-10-22） ----------
  // `[名](uploads/x.pdf)`：@ 上传组插入的引用形态。渲染 = 类型徽标 + 文件名（与输入栏 @ chip 同族），
  // 光标/选区落入区间显源码（口径同图片 widget）。非 uploads 链接不接管（普通外链仍走 vendor）。
  const edFileWidgetBase = class extends edCmg().WidgetType {
    constructor(name, path) { super(); this.name = name; this.path = path }
    eq(o) { return o.name === this.name && o.path === this.path }
    ignoreEvent() { return true }
    toDOM() {
      const el = document.createElement('span')
      el.className = 'cm-att-file mention'
      el.title = this.path
      el.innerHTML = `<span class="m-ic">${fileIcon(this.name)}</span>`
      const nm = document.createElement('span')
      nm.className = 'm-nm'
      nm.textContent = this.name
      el.appendChild(nm)
      return el
    }
  }
  const edAttFilePlugin = edCmg().ViewPlugin.fromClass(class {
    constructor(view) { this.decorations = this.build(view) }
    update(u) { if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = this.build(u.view) }
    build(view) {
      const CM = edCmg()
      const deco = []
      const isDrag = view.state.field(CM.mouseSelectingField, false)
      let active = null
      if (!isDrag) {
        for (const r of view.state.selection.ranges) {
          if (!r.empty) { active = { from: r.from, to: r.to }; break }
        }
      }
      CM.syntaxTree(view.state).iterate({
        enter: (node) => {
          if (node.name !== 'Link') return
          const text = view.state.sliceDoc(node.from, node.to)
          const m = /^\[([^\]]*)\]\((uploads\/[^)\s]+)\)$/.exec(text)
          if (!m) return
          if (active && node.from < active.to && node.to > active.from) return // 选区内 = 显源码
          let name = m[1]
          if (!name) {
            name = m[2].split('/').pop()
            try { name = decodeURIComponent(name) } catch (_) { /* 非法编码 → 原样显示 */ }
          }
          deco.push(CM.Decoration.replace({ widget: new edFileWidgetBase(name, m[2]) }).range(node.from, node.to))
        },
      })
      return CM.Decoration.set(deco.sort((a, b) => a.from - b.from), true)
    }
  }, { decorations: (v) => v.decorations })

export { attachmentUrl, insertAttachmentMarkdown, isDocumentAttachment, isImageAttachment, uploadAttachment, edAttImgPlugin, edAttFilePlugin }
