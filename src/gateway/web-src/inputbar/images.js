// 附件链（2026-10-15 待办 13 改造；原 2026-09-10 图片/文件胶囊链退役）。
// 上传（粘贴/拖拽/+ 浮窗）→ 落盘（POST /gateway/upload）→ **原文插 md 引用**：图片 `![名](uploads/x.png)`
// 行内直渲（editor-attachments.edAttImgPlugin）、文件 `[名](uploads/x)` 文件名链接——底栏不再有胶囊行，
// 「胶囊 + 正文引用」两套真相收口为一套（正文引用即唯一表达）。
// 发送链不变量原样保留：pendingImages/pendingFiles 仍是发送链内部态（send.js 消费：[Image #N] 占位 +
// images base64 视觉上行 / [文件:占位] 相对化上行），只是不再有底栏 UI 表达。
import { toast } from '../core/util.js'
import { syncGwSend } from './send.js'
import { uploadAttachment, insertAttachmentMarkdown } from '../editor/editor-attachments.js'
/* @module inputbar/images.js */
  // ---------- 视觉上行内部态（无底栏 UI；发送链 [Image #N] 契约不变，2026-08-28 起同口径） ----------
  // pendingImages: {content(base64 无前缀), mediaType, filename, dataUrl}。发送时文本拼 [Image #N] 占位 +
  // images 随 'send' 上行 → 网关透传 → CLI gatewayClient 构造 pastedContents（不落盘、执行时 resize）。
  let pendingImages = []
  function clearPendingImages() {
    pendingImages = []
    syncGwSend()
  }
  // pendingFiles: {name, abs, size}（落盘文件）。发送时文本拼 [文件:<会话 cwd 相对路径>] 占位随消息上行
  // （CLI 端即普通文本，模型按路径 Read）；正文里的 `[名](uploads/x)` 链接是同一次上传的引用表达。
  let pendingFiles = []
  function clearPendingFiles() {
    pendingFiles = []
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
  // 图片附件（粘贴/拖拽/+ 浮窗）：视觉上行 base64 入列 + 原文件上传落盘 → 原文插 `![名](uploads/x)`
  // md 引用（CM 行内直渲）。落盘失败时视觉上行仍有效（无 md 引用，发送链 [Image #N] 照旧上行）。
  async function addImageFiles(files) {
    for (const f of files) {
      if (!/^image\//.test(f.type)) continue
      if (pendingImages.length >= 9) { toast('一次最多 9 张图片'); break }
      try { pendingImages.push(await encodeImg(f)) } catch { toast('图片读取失败'); continue }
      const att = await uploadAttachment(f)
      if (att) insertAttachmentMarkdown('composer', att)
    }
    syncGwSend()
  }
  // 文件附件（+ 浮窗「上传文件」/粘贴）：上传落盘 → pendingFiles 入列（发送侧 [文件:占位] 自动相对化）
  // + 原文插 `[名](uploads/x)` 文件名链接。落盘跟随会话（2026-09-12 四轮用户定案）：sid=当前会话（存量/
  // 已开）；首页尚无会话时 project=newSessionProject()——与 gwSend 首送建会话的归属参数同源，
  // 保证「上传落点=消息会话落点」；两者皆无（纯首页）网关落全局根。
  async function addUploadFiles(files) {
    for (const f of files) {
      toast('正在上传 ' + (f.name || '文件') + '…')
      const att = await uploadAttachment(f)
      if (!att) continue
      pendingFiles.push(att)
      toast('已上传 ' + att.name)
      insertAttachmentMarkdown('composer', att)
    }
    syncGwSend()
  }

export {
  addImageFiles,
  addUploadFiles,
  clearPendingImages,
  clearPendingFiles,
  encodeImg,
  pendingImages,
  pendingFiles,
}
