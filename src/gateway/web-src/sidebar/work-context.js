// work 语境唯一源 + 项目槽切换（2026-10-15 待办 #5/#7/#8/#9 根治理线，组 1 步骤 1–2）。
//
// 两个领域，一个上下文源：
//   · 卡片注册域（engine/registry.js 的 isCardAllowedInContext）——「哪张管理卡/应用卡/外部卡可开」
//   · work 工作面域（getWorkSurfaceProjection）——「work 顶栏该显示哪些聊天胶囊/文件 pill」
// 两个领域**各自消费**同一个 getWorkContext()，绝不共用一个布尔判据（把二者塞进一个函数会让判据
// 语义污染：卡片路由域 ≠ 项目内会话/文件工作面）。
//
// 状态模型：state.workSlots[<项目 label>] = 该项目的整套 work 界面状态（键 = WORK_SLOT_DEF，见
// sidebar/work-state.js）。state 上同名的那些 flat 字段 = **当前槽的活视图**，由 loadWorkSlot 落地、
// stashWorkSlot 归档。唯一不变量：**state.workSlotKey === state.workProj**（空项目时两者皆空）。
import { state } from '../core/ui-state.js'
import { loadWorkSlot, stashWorkSlot } from '../core/storage.js'
import { WORK_SLOT_DEF } from './work-state.js'
/* @module sidebar/work-context.js */

  // 「当前 work 面在哪儿」的唯一只读源。kind 区分两种语境：
  //   'project'   = 某个具体工作项目（含它的会话/文件/预览）
  //   'workspace' = 工作区根散件视图（wkTab==='ws'）或无项目选中
  function getWorkContext() {
    const projectKey = state.workProj || ''
    return {
      kind: projectKey && state.wkTab !== 'ws' ? 'project' : 'workspace',
      projectKey,
      projectLabel: projectKey, // 槽键 = 项目 label（/gateway/sessions 的 groups label）
      mode: state.sbMode, // 'chat' | 'work'
      selectedTab: state.wkTab, // 'files' | 'chat' | 'ws'
    }
  }

  // 槽只读取用（不落 live、不改槽）。无槽返回 null——调用方自己决定回落缺省还是走 def。
  function getWorkProjectSlot(key) {
    return (key && state.workSlots[key]) || null
  }

  // work 顶栏（下沉区 tab 条）该显示什么：**只回答 work 面自己的资源**（聊天胶囊 / 文件 pill /
  // 当前文件），且只取**当前语境那一槽**——这正是「顶栏按项目分家」的落地（待办 #9）。
  // 它绝不回答「哪张管理卡能不能开」——那是 registry 的 isCardAllowedInContext。
  //
  // 读哪一份：**live 就是当前槽的活视图**（不变量 workSlotKey === workProj）——运行期对顶栏开放集的
  // 增删只落在 live（openWorkFile / wkEnsureTab），只有在 stash 那一刻才回写槽；因此问的是「当前那
  // 一槽」时读 live 才准（读槽会读到上一次 stash 的旧值，顶栏滞后一拍）。问**别的**项目（未来跨项目
  // 预览/对账）才落到它自己的槽。空语境（工作区根/无项目）两族皆空。
  function getWorkSurfaceProjection(ctx) {
    const c = ctx || getWorkContext()
    const isLive = c.kind === 'project' && c.projectKey === state.workSlotKey
    const slot = c.kind !== 'project' ? null : (isLive ? state : getWorkProjectSlot(c.projectKey))
    return {
      tab: c.selectedTab,
      chats: slot && Array.isArray(slot.wkChats) ? slot.wkChats.slice() : [],
      files: slot && Array.isArray(slot.wkFiles) ? slot.wkFiles.slice() : [],
      activeFile: slot ? slot.workFile || '' : '',
    }
  }

  // 切工作项目（**唯一口**）：stash 当前槽 → 换 workProj → load 新槽 → 对齐 workSlotKey。
  // 只动状态，不渲染、不导航（调用方按需 renderWorkChrome / applyPanes / renderEditor…），
  // 纯状态函数不碰 DOM，便于探针与复用。
  // **返回目标路由** = 新项目槽上次的活动会话 hash（'' = 该项目没有活动会话 ⇒ 空态首页）；
  // 同 label 重复调用 = 无操作，返回 null（调用方据此不导航）。
  // 「切项目该回哪一屏」由本口一次答清，**不再**交给 enforceWorkScope 统一强制跳 '#/'——那会把
  // 「切项目」与「路由弹回」两种意图混成一条，且空路由被 wkActiveKey 转成 'new' 后由 open-set
  // 兜底并入 ⇒ 每切一次项目凭空多一枚「新对话」胶囊（2026-10-15 根因）。
  function switchWorkProject(label) {
    const key = label || ''
    if (key === state.workSlotKey && key === state.workProj) return null
    stashWorkSlot() // 旧 live 归入它自己的槽（认 workSlotKey，不认新指针）
    state.workProj = key
    loadWorkSlot(key, WORK_SLOT_DEF) // 新项目：有槽恢复（含顶栏开放集/侧栏页/开关），无槽回落缺省
    state.workSlotKey = key
    // 上一激活键属于**旧项目**的顶栏 tab 生命周期（跨项目不连续）：不清则 syncWorkTabs 的「开会话顶掉
    // 占位」会拿旧项目的 prev 去摘新项目槽里合法的 new 胶囊。work.js 的模块级变量经单 IIFE 共享作用域可见。
    wkPrevActiveKey = null
    const s = state.workSlots[key]
    return s && typeof s.activeChat === 'string' ? s.activeChat : ''
  }

  // 语境归一（启动恢复 / 切项目 / 路由恢复共用；**幂等**）。守护的不变量：
  //   workSlotKey === workProj（live 必须镜像当前项目的槽）
  // 不等即漂移——按 workProj 重取槽，把 live 拉回正轨（而不是让两套值并存各自演化）。
  // 槽缺失时同一路径补缺省槽，故「首次进某项目」与「漂移修复」共用一条链，无第二份初始化旁路。
  function reconcileWorkSurface() {
    if (state.workSlotKey !== state.workProj) {
      state.workSlotKey = '' // 强制重取：stash 不该把漂移的 live 写进任何槽
      loadWorkSlot(state.workProj, WORK_SLOT_DEF)
      state.workSlotKey = state.workProj
    } else if (state.workProj && !state.workSlots[state.workProj]) {
      state.workSlots[state.workProj] = { ...WORK_SLOT_DEF, wkChats: [], wkFiles: [] } // 无槽 = 补缺省
    }
  }

export {
  getWorkContext,
  getWorkProjectSlot,
  getWorkSurfaceProjection,
  reconcileWorkSurface,
  switchWorkProject,
}
