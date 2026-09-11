// 图片附件（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { toast } from '../core/state.js'
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
  function renderImgPills() {
    const box = $('img-pills')
    if (!box) return
    if (!pendingImages.length) {
      box.hidden = true
      box.innerHTML = ''
    } else {
      box.hidden = false
      box.innerHTML = pendingImages
        .map((p, i) => `<span class="img-pill"><img src="${p.dataUrl}" alt="${p.filename}"/><button class="img-x" data-i="${i}" type="button" aria-label="移除">×</button></span>`)
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

export {
  addImageFiles,
  clearPendingImages,
  encodeImg,
  pendingImages,
  renderImgPills,
}
