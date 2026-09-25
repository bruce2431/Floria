// 外部预览卡片（卡片化二期）（唯一手改处，web/app.js 为生成物）

import { esc } from '../core/state.js'
  // ---------- 外部卡片（卡片化二期）----------
  // 用途：项目 `.claude/preview/` 里的界面单元（卡片）被 Floria web 内部调用——preview 在
  // preview.json 的 cards 段静态声明，或由预览页 postMessage 实时注册；宿主只按声明的 host 摆位，
  // **不解释卡片内容**（内容永远跑在它自己的文档里）。声明文件与 backend 段同一份申报表。
  // 渲染 = 一卡一 iframe（`/preview/<label>/<path>`，同源）：preview 保持自包含（自带 css/js/
  // 相对路径），与宿主 DOM/CSS/JS 零互相污染——一期 SPEC-视图卡化 §7「外部插件 = iframe」边界的延续。
  // 契约：preview.json cards（网关 GET /gateway/preview-cards 读出，见 docs/gateway.md §6）
  //       预览页 → 宿主 parent.postMessage({ type:'floria-cards-register', cards:[…] }, '*')
  //       宿主 → 预览页沿用既有 floria-rail-action 通道，本模块不新增回发。
  // 不变量：卡片集恒属于「当前 .preview-frame 所指项目」——异 label 重挂 / 文档重挂即清
  //        （清空点收在 sidebar/mgr.js 的 syncExtCards）；不合格声明整条丢弃，不猜不兜底。

  // 卡片字段校验（唯一一份）：preview.json 来源在网关已校过一遍，但 postMessage 这条不经过网关，
  // 必须同款再校——两条来源共用本函数，不给两处各写一套。host 只认 view（本版唯一定义的位置）。
  function normExtCards(raw) {
    return (Array.isArray(raw) ? raw : [])
      .filter((c) => c && typeof c === 'object' && !Array.isArray(c))
      .map((c) => ({
        id: typeof c.id === 'string' ? c.id.trim() : '',
        title: typeof c.title === 'string' ? c.title.trim() : '',
        icon: typeof c.icon === 'string' && c.icon ? c.icon : 'plug',
        path: typeof c.path === 'string' ? c.path.trim() : '',
        host: typeof c.host === 'string' ? c.host : '',
        tab: c.tab !== false,
      }))
      .filter((c) => /^[a-zA-Z0-9_-]{1,32}$/.test(c.id) && c.title && c.host === 'view' && isExtPath(c.path))
  }
  // 资源路径必须是 preview 目录内的相对文件路径（绝对路径 / 反斜杠 / query / 空段 / `.` `..` 段
  // 一律拒；允许尾随 #片段）。与网关 isPreviewRelPath 同款规则——网关侧挡 preview.json 来源，
  // 这里挡 postMessage 来源，两条外部输入各自守门。
  function isExtPath(p) {
    if (!p || p.startsWith('/') || p.includes('\\') || p.includes('?')) return false
    const i = p.indexOf('#')
    const file = i >= 0 ? p.slice(0, i) : p
    let rel
    try { rel = decodeURIComponent(file) } catch { return false } // 非法 % 序列
    if (!rel || rel.startsWith('/') || rel.includes('\\') || rel.includes('?')) return false
    return rel.split('/').every((s) => s && s !== '.' && s !== '..')
  }
  // 卡页 URL：/preview/<label>/<path>（+token 供未授权设备首链；#片段原样带上，由卡页自我定位）
  function extCardSrc(label, card) {
    const i = card.path.indexOf('#')
    const file = i >= 0 ? card.path.slice(0, i) : card.path
    const frag = i >= 0 ? card.path.slice(i) : ''
    const q = gToken ? '?token=' + encodeURIComponent(gToken) : ''
    return `/preview/${encodeURIComponent(label)}/${file}${q}${frag}`
  }
  // 把一张外部卡的卡体写进宿主卡体（调用方 = 注册表 showView 的 render(卡体)）
  function mountExtCard(body, label, card) {
    body.innerHTML =
      '<div class="ext-shell">' +
      `<iframe class="ext-frame" title="${esc(card.title)}" data-ext-card="${esc(card.id)}" src="${esc(extCardSrc(label, card))}"></iframe>` +
      '</div>'
  }

export {
  mountExtCard,
  normExtCards,
}
