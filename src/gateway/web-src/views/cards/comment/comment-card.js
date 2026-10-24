// 评论卡（卡片化，2026-10-24）：宿主 pane 也按卡片组织的唯一入口。
// 卡目录自包含：comment-card = 描述符 + 注册；comment-panel = 卡私有面板组件。
// 跨卡/宿主共享的实现归 feature/comment/：comment-data = 数据/网关写口（work.js 的原文标记也读它）、
// comment-composer = 选区浮层（inputbar/quote.js 也开它）。宿主只在 work-mount 注入回调（cmtSetHooks）。
// 依赖方向单向：views/cards/comment → feature/comment → engine/core，feature 层不反向 import views。
// 两个注册面：
//   ① ToolCapsule 工具页（registerWkTool，pane=#wk-cmt）——用户在右栏切到「评论」；
//   ② cardBus inline 卡（instanceId=floria-comment）——agent / 其它卡经公开命令读取评论态。

import { state } from '../../../engine/state.js'
import { cardBus } from '../../../engine/card-bus.js'
import { registerWkTool } from '../../../sidebar/work-tools.js'
import { cmtLoad, cmtState } from '../../../feature/comment/comment-data.js'
import { cmtMount, cmtRender } from './comment-panel.js'
/* @module views/cards/comment/comment-card.js */
  // 卡描述符（与 views/cards/* 同构：id/title/命令表）。host pane 卡无槽位 mount，注册面走 ToolCapsule。
  const commentCardDef = {
    id: 'comment',
    title: '评论',
    tip: '项目评论批注',
    icon: 'msg',
    tab: false,
    pane: 'wk-cmt',
    ns: 'floria-comment',
    cmds: ['state', 'locate'],
  }

  // ① ToolCapsule 工具页：打开该页时拉当前项目评论并渲染（cmtMount 幂等，事件委托只绑一次）
  registerWkTool({
    id: 'comments',
    title: commentCardDef.title,
    pane: commentCardDef.pane,
    mount: () => {
      cmtMount()
      cmtLoad(state.workProj)
      cmtRender()
    },
  })

  // ② 公开 API：只读快照，无状态、幂等
  function cmtSnapshot() {
    const { list, proj, loading, err } = cmtState()
    return { project: proj, total: list.length, open: list.filter((c) => !c.resolved).length, loading, error: err }
  }
  cardBus.registerInlineCard({
    instanceId: 'floria-comment',
    ns: commentCardDef.ns,
    cmds: commentCardDef.cmds,
    handlers: {
      state: () => cmtSnapshot(),
      locate: () => ({
        ...cmtSnapshot(),
        comments: cmtState().list.map((c) => ({
          id: String(c.id || ''),
          path: String(c.path || ''),
          l0: Number(c.l0) || 0,
          l1: Number(c.l1) || 0,
          resolved: !!c.resolved,
        })),
      }),
    },
  })

export {
  commentCardDef,
}
