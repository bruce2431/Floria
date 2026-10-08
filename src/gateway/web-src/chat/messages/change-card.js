// 文件变更汇总卡片（+N/-N）：路径归一/增删解析/聚合/渲染 + 折叠事件委托
import { esc } from '../../core/util.js'
import { sessionCwd } from '../../engine/sessions.js'
import { messagesEl } from '../../engine/state.js'
import { CHEV } from './icons.js'
/* @module chat/messages/change-card.js */
  // ---- 文件变更汇总卡片（Codex 风格：+N 绿 / -N 红）----
  // 数据源（2026-08-23 起）：源码 conversationDisplay.ts 在 tool_result 块上输出结构化
  // fileChange {filePath, added, removed}（权威数字 = 源码 diff.ts sumLinesChanged，由
  // Edit/Write 工具写入文本后缀 `(+N -M)`），前端直接消费字段。
  // parseFileChange 正则反解仅作旧网关/离线数据兜底，新 exe 部署后可删。
  function baseName(p) {
    const s = String(p || '').replace(/\\/g, '/')
    return s.split('/').pop() || s
  }
  // 相对启动根路径显示（2026-08-29）：路径在会话启动根（sessionCwd）下 → 剥前缀显示相对路径
  // （如 src/gateway/web/app.js）；不在根下/未知 cwd → 回退文件名。仅显示层，聚合 key 仍用绝对路径。
  function relFromCwd(p) {
    const norm = String(p || '').replace(/\\/g, '/')
    const root = String(sessionCwd || '').replace(/\\/g, '/').replace(/\/+$/, '') + '/'
    if (root.length > 1 && norm.toLowerCase().startsWith(root.toLowerCase())) {
      return norm.slice(root.length) || baseName(norm)
    }
    return baseName(norm)
  }
  // 从 tool_result 文本提取文件路径与增删行数（Edit/Write 统一格式）——旧网关兜底
  function parseFileChange(text) {
    if (!text) return null
    const t = String(text).trim()
    const m = /\([+-](\d+)\s*[+-](\d+)\)\s*\.?\s*$/.exec(t)
    if (!m) return null
    let path = null
    const fm = /The file\s+(.+?)\s+has been updated/.exec(t)
    if (fm) path = fm[1]
    else {
      const cm = /File created successfully at:\s+(.+?)\s*\(/.exec(t)
      if (cm) path = cm[1]
    }
    if (!path) return null
    return { path: path.trim(), added: Number(m[1]), removed: Number(m[2]) }
  }
  // 归一化为聚合用的 {path, added, removed} 形态（结构化 fileChange 用 filePath 命名）
  function normalizeFileChange(fc) {
    if (!fc) return null
    if (fc.path != null) return { path: fc.path, added: fc.added || 0, removed: fc.removed || 0 }
    if (fc.filePath != null) return { path: fc.filePath, added: fc.added || 0, removed: fc.removed || 0 }
    return null
  }
  function mergeChanges(map, fc) {
    const prev = map.get(fc.path)
    map.set(fc.path, prev ? { added: prev.added + fc.added, removed: prev.removed + fc.removed } : { added: fc.added, removed: fc.removed })
  }
  function renderChangeCardHtml(changes, key) {
    if (!changes || !changes.size) return ''
    let totalAdd = 0, totalDel = 0
    let rows = ''
    for (const [path, c] of changes) {
      totalAdd += c.added
      totalDel += c.removed
      rows += `<div class="ch-row"><span class="ch-file">${esc(relFromCwd(path))}</span><span class="ch-add">+${c.added}</span><span class="ch-del">-${c.removed}</span></div>`
    }
    // 2026-08-19 默认折叠：卡片落地即为收起姿态（标题行 + ▸），点右上角展开文件列表
    // 2026-08-26：key 可选（messagesHtml 段尾传入 s.key）→ 带 data-m/data-t 供增量重建定位删除；
    // 实时 commitLiveChangeCard 不带 key（无 data-m，属消息流外手动追加，不受增量删除影响）
    return `<div class="msg change-card collapsed"${key != null ? ` data-m="${key}" data-t="c"` : ''}><div class="ch-title"><span class="ch-count">${changes.size}个文件已更改</span><span class="ch-add">+${totalAdd}</span><span class="ch-del">-${totalDel}</span><button class="ch-toggle" title="收起/展开文件列表">${CHEV}</button></div><div class="ch-list">${rows}</div></div>`
  }

  // ---- 文件变更汇总卡片：历史/实时统一由 messagesHtml 段尾 seg.changes 数据驱动渲染
  //     （从 transcript 的 tool_result.fileChange 重建，切会话/刷新不丢）。原 WS out 实时内联行/
  //     commitLiveChangeCard 链随 WS out 流退役删除（网关从不投递 out，2026-09-07 定案）----
  // 卡片右上角隐藏按钮：点击切换列表收起/展开（事件委托，innerHTML 重建不受影响）
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.ch-toggle') : null
    if (!btn || !messagesEl.contains(btn)) return
    const card = btn.closest('.change-card')
    if (!card) return
    const collapsed = card.classList.toggle('collapsed')
    btn.innerHTML = CHEV
    btn.classList.toggle('open', !collapsed)
  })

