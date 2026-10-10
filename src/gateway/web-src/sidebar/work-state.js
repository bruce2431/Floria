// work 视图两开关的缺省值（2026-10-10 自 engine/state.js 下移）：work 领域默认值，归 feature 层
// （sidebar），不进 core——core/storage.js 的 loadWork/loadWorkPanes 收 defaults 参数，由本层调用方传入。
// 唯一手改处，web/app.js 为生成物。

/* @module sidebar/work-state.js */
  // 两开关的缺省（新项目 / 无槽时用）。键名 = 槽内键名（state.wkPanes[<label>]），与 core/ui-state.js 初值对应。
  const WK_PANES_DEF = { workspace: true, sidebar: false }

export { WK_PANES_DEF }
