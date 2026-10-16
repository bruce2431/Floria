// 附件链（2026-10-15 待办 13 改造；2026-10-16 待办 6 还原胶囊行）。
// 上传（粘贴/拖拽/+ 浮窗）→ 落盘（POST /gateway/upload）→ **原文插 md 引用**：图片 `![名](uploads/x.png)`
// 行内直渲（editor-attachments.edAttImgPlugin）、文件 `[名](uploads/x)` 文件名链接——**正文引用仍是唯一表达**
// （v3.36.0 定案不撤，待办 6「增加」= 补缺不替换）。
// 待办 6 增补两件：
//   ① **附件胶囊行还原**（`#img-pills`）：pendingImages 缩略图 + pendingFiles 文件卡（× 可移除），
//      是**发送链内部态的可见回显**（看见待发的附件、随时撤掉），不产生第二份内容真相——正文引用照旧由
//      insertAttachmentMarkdown 插，胶囊只镜像 pending* 数组。
//   ② **@ 已上传文件**：本次上传的文件（pendingFiles + 已落盘的图片）进 @ 浮窗「上传」组
//      （mention.js 消费 uploadedMentionItems），选中插回 md 引用。
// 发送链不变量原样保留：pendingImages/pendingFiles 仍是发送链内部态（send.js 消费：[Image #N] 占位 +
// images base64 视觉上行 / [文件:占位] 相对化上行）。
import { toast, esc } from '../core/util.js'
import { I } from '../core/icons.js'
import { syncGwSend } from './send.js'
import { uploadAttachment, insertAttachmentMarkdown } from '../editor/editor-attachments.js'
/* @module inputbar/images.js */
  // ---------- 视觉上行内部态 ----------
  // pendingImages: {content(base64 无前缀), mediaType, filename, dataUrl, attName?}。发送时文本拼 [Image #N]
  // 占位 + images 随 'send' 上行 → 网关透传 → CLI gatewayClient 构造 pastedContents（不落盘、执行时 resize）。
  // attName = 同次上传落盘后的文件名（`uploads/<attName>` 正文引用的键；落盘失败则无，胶囊照显、@ 不可引用）。
  let pendingImages = []
  function clearPendingImages() {
    pendingImages = []
    renderImgPills()
    syncGwSend()
  }
  // pendingFiles: {name, abs, size}（落盘文件）。发送时文本拼 [文件:<会话 cwd 相对路径>] 占位随消息上行
  // （CLI 端即普通文本，模型按路径 Read）；正文里的 `[名](uploads/x)` 链接是同一次上传的引用表达。
  let pendingFiles = []
  function clearPendingFiles() {
    pendingFiles = []
    renderImgPills()
    syncGwSend()
  }
  // ---------- 附件胶囊行（#img-pills）：pending* 的可见回显（待办 6 还原）----------
  // 图片缩略图 + 文件卡同轨（CSS 见 styles.css #img-pills），× 从 pending* 数组摘除并重渲。
  // 一次绑定（dataset.bound）防重复挂监听；元素可能随后才入 DOM，故 renderImgPills 每次调用都补绑。
  function onPillRemove(e) {
    const b = e.target && e.target.closest ? e.target.closest('.img-x') : null
    if (!b) return
    if (b.dataset.i != null && b.dataset.i !== '') pendingImages.splice(+b.dataset.i, 1)
    else if (b.dataset.f != null && b.dataset.f !== '') pendingFiles.splice(+b.dataset.f, 1)
    renderImgPills()
    syncGwSend()
  }
  function renderImgPills() {
    const box = $('img-pills')
    if (!box) return
    if (box.dataset.bound !== '1') { box.dataset.bound = '1'; box.addEventListener('click', onPillRemove) }
    if (!pendingImages.length && !pendingFiles.length) {
      box.hidden = true
      box.textContent = ''
      return
    }
    box.hidden = false
    box.innerHTML =
      pendingImages
        .map((p, i) => `<span class="img-pill"><img src="${p.dataUrl}" alt="${esc(p.filename)}"/><button class="img-x" data-i="${i}" type="button" aria-label="移除">×</button></span>`)
        .join('') +
      pendingFiles
        .map((f, i) => `<span class="file-pill" title="${esc(f.abs)}"><span class="fp-ico">${I.dshFile}</span><span class="fp-name">${esc(f.name)}</span><button class="img-x" data-f="${i}" type="button" aria-label="移除">×</button></span>`)
        .join('')
  }
  // @ 浮窗「上传」组的数据源（mention.js 消费）：本次上传、可被正文引用的附件。
  // 形态 = {kind:'imgpick'|'filepick', name, md}——md 即选中后写回 doc 的正文引用原文（与自动插入同一形态）。
  function uploadedMentionItems() {
    const out = []
    for (const p of pendingImages) {
      if (p.attName) out.push({ kind: 'imgpick', name: p.attName, md: `![${p.attName}](uploads/${encodeURIComponent(p.attName)})` })
    }
    for (const f of pendingFiles) out.push({ kind: 'filepick', name: f.name, md: `[${f.name}](uploads/${encodeURIComponent(f.name)})` })
    return out
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
  // target = editorCommand 落点 id（'composer' 底栏 / 'work' 编辑卡片），缺省底栏
  async function addImageFiles(files, target) {
    const tgtEd = target || 'composer'
    for (const f of files) {
      if (!/^image\//.test(f.type)) continue
      if (pendingImages.length >= 9) { toast('一次最多 9 张图片'); break }
      let enc
      try { enc = await encodeImg(f) } catch { toast('图片读取失败'); continue }
      const att = await uploadAttachment(f)
      if (att) enc.attName = att.name // @ 浮窗可引用的键（落盘成功才有）
      pendingImages.push(enc)
      if (att) insertAttachmentMarkdown(tgtEd, att)
      renderImgPills()
    }
    syncGwSend()
  }
  // 文件附件（+ 浮窗「上传文件」/粘贴）：上传落盘 → pendingFiles 入列（发送侧 [文件:占位] 自动相对化）
  // + 原文插 `[名](uploads/x)` 文件名链接。落盘跟随会话（2026-09-12 四轮用户定案）：sid=当前会话（存量/
  // 已开）；首页尚无会话时 project=newSessionProject()——与 gwSend 首送建会话的归属参数同源，
  // 保证「上传落点=消息会话落点」；两者皆无（纯首页）网关落全局根。
  async function addUploadFiles(files, target) {
    const tgtEd = target || 'composer'
    for (const f of files) {
      toast('正在上传 ' + (f.name || '文件') + '…')
      const att = await uploadAttachment(f)
      if (!att) continue
      pendingFiles.push(att)
      toast('已上传 ' + att.name)
      insertAttachmentMarkdown(tgtEd, att)
      renderImgPills()
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
  renderImgPills,
  uploadedMentionItems,
}
