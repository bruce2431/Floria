// 图片附件（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { toast, esc, state } from '../core/state.js'
import { I } from '../core/icons.js'
import { apiUrl } from '../core/gateway.js'
import { syncGwSend } from './send.js'
  // ---------- 图片附件（2026-08-28）：走 CLI 粘贴同链路；2026-09-09 上传入口=+ 浮窗「上传」组常驻行，
  // vision 入口门控退役（粘贴/拖拽/发送链本无门控，入口级限制与其它入口不一致）----------
  // pendingImages: {content(base64 无前缀), mediaType, filename, dataUrl(预览)}。发送时文本拼
  // [Image #N] 占位 + images 随 'send' 上行 → 网关透传 → CLI gatewayClient 构造 pastedContents
  // → handlePromptSubmit 占位匹配才发送（与本地粘贴图片完全同路径，不落盘、执行时才 resize）。
  let pendingImages = []
  function clearPendingImages() {
    pendingImages = []
    renderImgPills()
  }
  // pendingFiles: {name, abs, size}（落盘文件）。渲染与图片同胶囊行（#img-pills），发送时
  // 文本拼 [文件:<会话 cwd 相对路径>] 占位随消息上行（CLI 端即普通文本，模型按路径 Read）。
  let pendingFiles = []
  function clearPendingFiles() {
    pendingFiles = []
    renderImgPills()
  }
  function renderImgPills() {
    const box = $('img-pills')
    if (!box) return
    if (!pendingImages.length && !pendingFiles.length) {
      box.hidden = true
      box.innerHTML = ''
    } else {
      box.hidden = false
      box.innerHTML = pendingImages
        .map((p, i) => `<span class="img-pill"><img src="${p.dataUrl}" alt="${p.filename}"/><button class="img-x" data-i="${i}" type="button" aria-label="移除">×</button></span>`)
        .join('') + pendingFiles
        .map((f, i) => `<span class="file-pill" title="${esc(f.abs)}"><span class="fp-ico">${I.dshFile}</span><span class="fp-name">${esc(f.name)}</span><button class="img-x" data-f="${i}" type="button" aria-label="移除">×</button></span>`)
        .join('')
    }
    syncGwSend()
  }
  // 编码：≤1.5MB 且 png/jpg/webp 直传原 base64（截图文字不重压）；否则 canvas 重编码 jpeg
  // （长边 ≤1568 对齐 API 推荐输入、质量 0.85），把手机照片压到几百 KB 再走 WS。
  function encodeImg(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => {
        const dataUrl = String(r.result)
        if (file.size <= 1536 * 1024 && /^image\/(png|jpe?g|webp)$/.test(file.type)) {
          const mediaType = file.type === 'image/jpg' ? 'image/jpeg' : file.type
          return resolve({ content: dataUrl.split(',')[1], mediaType, filename: file.name || '图片', dataUrl })
        }
        const img = new Image()
        img.onload = () => {
          const MAX = 1568
          const scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight))
          const w = Math.max(1, Math.round(img.naturalWidth * scale))
          const h = Math.max(1, Math.round(img.naturalHeight * scale))
          const cv = document.createElement('canvas')
          cv.width = w
          cv.height = h
          cv.getContext('2d').drawImage(img, 0, 0, w, h)
          const out = cv.toDataURL('image/jpeg', 0.85)
          resolve({ content: out.split(',')[1], mediaType: 'image/jpeg', filename: (file.name || '图片').replace(/\.[^.]+$/, '') + '.jpg', dataUrl: out })
        }
        img.onerror = () => reject(new Error('decode failed'))
        img.src = dataUrl
      }
      r.onerror = () => reject(new Error('read failed'))
      r.readAsDataURL(file)
    })
  }
  async function addImageFiles(files) {
    for (const f of files) {
      if (!/^image\//.test(f.type)) continue
      if (pendingImages.length >= 4) { toast('一次最多 4 张图片'); break }
      try { pendingImages.push(await encodeImg(f)) } catch { toast('图片读取失败') }
    }
    renderImgPills()
  }
  // ---------- 文件上传（2026-09-12）：+ 浮窗「上传文件」行 → POST /gateway/upload（原始字节直传，
  // token/cookie 认证同链）→ 网关落盘 <会话根>/uploads/ → 文件胶囊进附件行。落盘跟随会话
  // （2026-09-12 四轮用户定案）：sid=当前会话（存量/已开）；首页尚无会话时 project=state.newProject
  //（项目「+」初始化界面）——与 gwSend 首送建会话的归属参数同源，保证「上传落点=消息会话落点」；
  // 两者皆无（纯首页）网关落全局根。与图片附件（base64 内联不落盘）是两条独立链路，互不复用。
  async function addUploadFiles(files) {
    const ctx = state.currentHash
      ? '&sid=' + encodeURIComponent(state.currentHash)
      : (state.newProject ? '&project=' + encodeURIComponent(state.newProject) : '')
    for (const f of files) {
      toast('正在上传 ' + (f.name || '文件') + '…')
      try {
        const r = await fetch(apiUrl('/gateway/upload?name=' + encodeURIComponent(f.name || 'file') + ctx), {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: f,
        })
        const d = await r.json().catch(() => ({}))
        if (!r.ok || !d.ok) { toast('上传失败：' + (d.error || r.status)); continue }
        pendingFiles.push({ name: d.name || f.name || '文件', abs: String(d.abs || d.path || ''), size: d.size || 0 })
        toast('已上传 ' + d.name)
      } catch {
        toast('上传失败：网络错误')
      }
    }
    renderImgPills()
  }

export {
  addImageFiles,
  addUploadFiles,
  clearPendingImages,
  clearPendingFiles,
  encodeImg,
  pendingImages,
  pendingFiles,
  renderImgPills,
}
