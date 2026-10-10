// 预览卡（卡片化二期）（2026-10-01 卡片化：自 sidebar/mgr.js 迁出；唯一手改处，web/app.js 为生成物）
// 只留卡描述符 + 自注册：三级链渲染实现归 feature/preview-frame.js，本模块顶层 registerCard 入表。

import { mountPreview } from '../../../feature/preview-frame.js'
import { registerCard } from '../../../engine/registry.js'
/* @module views/cards/preview/preview-card.js */
  // ---------- 预览卡 ----------
  // 槽位预览卡（openProjectPreview，独占主区）：与 work 右栏「预览态」（sidebar/work.js
  // renderWorkPreview）复用同一份 mountPreview——后端容器 / 静态页 / 默认页三级链只有这一处实现，
  // 在 feature/preview-frame.js。syncExtCards 亦在该件，供 sidebar/work.js 的补拉链调（外部卡申报）。
  const previewCardDef = {
    id: 'preview', title: '预览', tip: '项目预览', icon: 'folder', tab: false,
    mount(body, ctx) { mountPreview(body, ctx.payload.label, ctx.payload.hasPreview) },
  }
  registerCard(previewCardDef)

export {
  previewCardDef,
}
