// work 模式侧栏 + 主区编辑区（2026-09-25，参考 Prism）（唯一手改处，web/app.js 为生成物）

import { navigate } from '../chat/route.js'
import { needToken, apiUrl } from '../engine/gateway.js'
import { I } from '../core/icons.js'
import { ALL, chatArea, sessionCard, state } from '../engine/state.js'
import { esc, isMobile, toast } from '../core/util.js'
import { loadWork, loadWorkPanes, saveWork, stashWorkPanes } from '../core/storage.js'
import { loadSessions, sessCmp, findSession } from '../engine/sessions.js'
import { currentCardId, hydrateExtCards } from '../engine/registry.js'
import { itemHtml, openRenameDialog, registerRowMenu, reliftRowMenu, setPanel } from './recent.js'
import { cmtInvalidate, cmtLoad, cmtMount, cmtRangesFor, cmtRender, cmtSetHooks } from './comments.js'
import { renderProjSeat } from '../inputbar/commands.js'
import { mountPreview, syncExtCards } from '../feature/preview-frame.js'
import { clearWkFrameTools, registerWkFrameTools, registerWkTool, wkToolDef, wkToolDefs, wkToolNormId } from './work-tools.js'
/* @module sidebar/work.js */
  // ---------- work 模式侧栏（Prism 式） ----------
  // 状态源 = engine/state.js 的 sbMode / projects / workspace / workProj / workFile / wkMainTab / wkAssist /
  // wkPreview / wkPvTab / wkPrevW（localStorage floria-ui-v1 持久化，见 saveWork/loadWork）。视图浮层两开关
  // （预览 / 侧边栏）按项目分槽存 state.wkPanes，切项目时由 stashWorkPanes / loadWorkPanes 换槽。
  // 数据源全部是现成端点，本模块零后端改动：
  //   项目列表 → /gateway/sessions 的 groups（sessions.js 顺带存进 state.projects）
  //   文件树   → GET /gateway/project?label=  的 files（walkProjectTree，深度 3 / 每层 50）
  //   单文件   → GET /gateway/file?label=&path=（只读原始字节，带路径穿越防护 + 4MB 上限）
  // 主区：sbMode=work → #chat-area 加 .work（CSS Grid 三列 = 下沉区 | 分界条 | 右栏卡）。下沉区顶部一条
  // .wk-topbar tab 顶栏（[+] [聊天胶囊×N] [文件名] [工具栏]）：聊天胶囊 = 开放集 state.wkChats 一会话一枚
  // （命名 = 会话标题，× 关掉），文件 tab 一枚；同一时刻只显一个内容（#session-card = 聊天 / #work-editor =
  // 文件）；右栏（#work-preview，与下沉区同属 #chat-area 三列之一）两态由 state.wkPvTab 定：'' = 预览态
  // （挂项目预览帧）/ 工具 id = 工具态（顶 tab 条 + 该工具 pane，注册表 sidebar/work-tools.js），顶栏
  // 「工具栏」胶囊切这两态（工具态时变「关闭」）。不变量 = 聊天 / 文件 / 右栏 **至少一栏在场**，唯一
  // 判定点 applyPanes。与「管理/预览卡」互斥：route.js 进 mgr/preview 时 setSbMode('chat')。

  const IMG_EXT = /\.(png|jpe?g|webp|gif|svg|bmp|ico|avif)$/i
  const MD_EXT = /\.(md|markdown)$/i
  const WK_SAVE_MS = 1000 // 编辑区自动保存去抖（停止输入后多久落盘）
  const WK_NEW_TAB = 'new' // 空对话 / 首页（currentHash ''）的哨兵 tab 键；真源 state.wkChats 用字符串承载
  let wkPrevActiveKey = null // 上一次路由激活的 tab 键（判别「从空对话 tab 打开具体会话」见 syncWorkTabs）
  let wkTab = 'files'      // 'files' | 'chat'
  let wkTree = null        // 当前项目文件树（/gateway/project 的 files）；null = 未加载
  let wkLoading = false
  let wkErr = ''
  const wkOpen = new Set() // 已展开目录（项目内相对路径）
  let edSeq = 0            // 编辑区读取序号：快速连点文件时丢弃迟到的旧响应

  function setSbMode(mode) {
    state.sbMode = mode === 'work' ? 'work' : 'chat'
    applySbMode()
    saveWork()
  }

  // work 模式不变量（唯一判定点）：助手栏只显示工作项目的会话——当前打开的是别的项目/全局会话时，
  // 回该项目的「新对话」空态（新会话的目标项目由 engine/state.js newSessionProject 收口，seat 只读）。
  // 调用点 = 进入 work 模式 / 切换工作项目 / 路由渲染会话前（chat/route.js renderSession）。
  // 会话尚未落地（findSession 查无 = 列表未拉或刷新中）时不判——「未知」不等于「别的项目」。
  function workScopeOk(hash) {
    if (state.sbMode !== 'work' || !state.workProj || !hash) return true
    const s = findSession(hash)
    return !s || (s.projectScope === 'project' && s.projectLabel === state.workProj)
  }
  function enforceWorkScope() {
    if (!workScopeOk(state.currentHash)) navigate('#/')
    renderProjSeat()
  }

  // 模式 tab「空位」定位（唯一处）：把当前 .ms-btn 的矩形以 left/right 内衬写进 .ms-thumb
  // （.mode-switch 是 position:relative，即两钮的 offsetParent，量值可直接用）。
  // 侧栏折叠态下 #panel 虽 width:0，但 .panel-inner 仍持 --panel-w 宽、按钮尺寸不变（只是被 overflow
  // 裁掉），故任何时刻量都有效，无需等侧栏展开再定位。字体异步到位会改字宽 ⇒ 由 mountWork 在
  // document.fonts.ready 后重量一次（那次不带变形动画）。
  // 切换 = 空位「变形 + 位移」（2026-10-06 用户定案）：用 left/right 两个内衬而不是 left/width——
  // 前缘（移动方向上的那条边）给短时长先到、后缘给长时长后到，中途两缘一快一慢 ⇒ 空位被拉长，
  // 到位后收回成目标钮的形状；这就是「变形位移」的读数。方向性 transition 在此按方向写内联。
  // 非切换的定位（初始化 / resize / 字体到位）一律 transition:none —— 否则首帧会播一次滑动。
  // 空位归属（2026-10-06 二轮定案）：**落在非当前模式那侧**——处于的模式在卡片上（.ms-btn.on 回
  // 卡面色），凹下去的那块给另一个模式。位置取 .ms-btn:not(.on)。
  const MS_FAST = '0.16s cubic-bezier(0.2, 0.8, 0.3, 1)'
  const MS_SLOW = '0.30s cubic-bezier(0.3, 1.04, 0.5, 1)'
  let msAtFirst = null // 上一次空位停在哪一侧（null = 尚未定位）
  function positionMsThumb() {
    const sw = $('mode-switch')
    const th = sw && sw.querySelector('.ms-thumb')
    const btns = sw && sw.querySelectorAll('.ms-btn')
    const btn = sw && sw.querySelector('.ms-btn:not(.on)')
    if (!th || !btn || !btns || btns.length < 2) return
    const first = btn === btns[0]
    const moved = msAtFirst !== null && msAtFirst !== first
    if (moved) {
      // 去左侧：前缘 = 左缘 ⇒ left 快、right 慢；去右侧：前缘 = 右缘 ⇒ right 快、left 慢
      th.style.transition = first
        ? `left ${MS_FAST}, right ${MS_SLOW}`
        : `right ${MS_FAST}, left ${MS_SLOW}`
    } else {
      th.style.transition = 'none'
    }
    th.style.left = btn.offsetLeft + 'px'
    th.style.right = sw.clientWidth - btn.offsetLeft - btn.offsetWidth + 'px'
    msAtFirst = first
  }
export {
  applySbMode,
  enforceWorkScope,
  ensureWork,
  initWork,
  setSbMode,
  syncWorkTabs,
  workScopeOk,
}
