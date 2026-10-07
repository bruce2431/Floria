// 会话卡（2026-10-05 自 views/registry.js 迁出：一模块一卡；会话卡 = 会话视图本体）
// card() 直接返回既存单例 #session-card——它承载 #messages/#input-wrap/#char 等模块级 const 引用的
// DOM，不能销毁重建（其余卡由 openCard 按需创建/复用）。tab:false（侧栏条目构成不动），但切卡路径
// 与四张管理卡完全一致（槽位永远只有 openCard(id) 一条路径）。
// deactivate 钩子 = teardownSessionView（chat/route.js 合成：停实时计时 + 拆 stage 占位 + 清全局槽 +
// 复位 currentHash）——registry 切卡时对**离场卡**调用；会话卡是唯一带此钩子的卡（离开会话视图须卸净
// 会话态，六条 SSE 守卫以 live.curUuid 为前提）。

import { sessionCard } from '../../../engine/state.js'
import { teardownSessionView } from '../../../chat/route.js'
/* @module views/cards/session/session-card.js */
  // ---------- 会话卡 ----------
  const sessionCardDef = {
    id: 'session', title: '会话', tip: '会话', icon: 'logo', tab: false,
    card: () => sessionCard,
    deactivate: teardownSessionView,
  }

export { sessionCardDef }
