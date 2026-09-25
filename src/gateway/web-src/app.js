/* floria — 会话查看器前端（ChatGPT 风格）
   hash 路由约定：
     #/          → 主界面（空态，输入栏居中）
     #/<会话哈希> → 会话转录（输入栏 docked 底部）
   「会话哈希」= 转录文件名去掉 .jsonl（Claude Code 会话 UUID）。
   数据来自后端：/gateway/sessions 列表、/gateway/session?id= 单会话。
   只读查看：composer 不可发送。 */
// —— 2026-09-10 模块化切割入口（事件绑定 + 启动序列；其余逻辑在 core/sidebar/inputbar/chat 各模块）——
import { route, navigate, renderSession } from './chat/route.js'
import { hideGate } from './core/auth.js'
import { setChar } from './core/char.js'
import { GATEWAY, HOT_RELOAD, initGateway, detectGateway } from './core/gateway.js'
import { I } from './core/icons.js'
import { initLive } from './core/live.js'
import { loadSessions } from './core/sessions.js'
import { inputEl, overlay, sInput, sidebar, state, saveMgrView, isMobile } from './core/state.js'
import { initViewport } from './core/viewport.js'
import { gwSend } from './inputbar/send.js'
import { openSearch, renderSearch } from './sidebar/bubble-search.js'
import { renderProject } from './sidebar/mgr.js'
import { setPanel, newWebSession, renderRecent } from './sidebar/recent.js'
import { initWork, setSbMode } from './sidebar/work.js'

  // ---------- 事件绑定 ----------
  // 侧栏唤出（2026-09-25 定案：折叠态宽度归 0，64px rail 折叠带撤除）：
  //  · #menu-btn 汉堡（左上角，全视口共用一枚）：点击 = 打开并钉住（钉住后鼠标移出侧栏不自动收）
  //  · 左缘唤出（桌面，预览式打开、不钉住）：判据 = 「指针到达窗口左缘」，两种观测合一——
  //    ①窗口内取样到 clientX ≤ EDGE_PX；②指针直接从左缘离开窗口（document mouseout：relatedTarget
  //    为 null 且 clientX ≤ 0）。快速左移常在同一个取样间隔内直接冲出窗口，靠细条 mouseenter 会被整段
  //    跳过（用户实测「向左后再向右一点点才唤出」）。收的判定在 sidebar/recent.js 的 #sidebar mouseleave
  const EDGE_PX = 8
  const edgeArmed = () => !state.panelOpen && !isMobile() && !document.body.classList.contains('token-gate')
  $('menu-btn').addEventListener('click', () => setPanel(true, { pin: true }))
  document.addEventListener('mousemove', (e) => { if (e.clientX <= EDGE_PX && edgeArmed()) setPanel(true) })
  document.addEventListener('mouseout', (e) => {
    if (!e.relatedTarget && e.clientX <= 0 && edgeArmed()) setPanel(true)
  })
  $('scrim').addEventListener('click', () => setPanel(false))
  $('panel-collapse').innerHTML = I.collapse
  $('panel-collapse').addEventListener('click', () => setPanel(false))
  $('panel-search').innerHTML = I.mag
  $('panel-search').addEventListener('click', openSearch)
  // 侧栏模式切换（2026-09-25）：floria·chat ⇄ floria·work。委托在容器上——两个 .ms-btn 常驻不重渲，
  // 但委托写法与其它侧栏控件一致，且 setSbMode 已内部落地全部渲染（applySbMode）。
  $('mode-switch').addEventListener('click', (e) => {
    const b = e.target.closest('.ms-btn')
    if (b && b.dataset.sbmode !== state.sbMode) setSbMode(b.dataset.sbmode)
  })
  $('recent-write').innerHTML = I.pen
  $('recent-write').addEventListener('click', () => { state.newProject = null; navigate('#/'); if (isMobile()) setPanel(false) })
  // 2026-08-24 定案：开启新会话只用「笔」图标（recent-write → 回首页空态），
  // 首条消息触发创建（gwSend 空态分支调 newWebSession）；不再有独立的「新建独立会话」按钮。
  $('recent-more').addEventListener('click', (e) => { e.stopPropagation(); $('organize-pop').classList.toggle('show') })

  // 项目/聊天 tab
  document.querySelectorAll('.mtab').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.mtab').forEach((x) => x.classList.toggle('on', x === b))
      state.pt = b.dataset.pt
      renderProject()
    }),
  )

  // 管理入口 tab（插件，含技能预览）：点击 → 主区切换管理视图（侧栏会话列表不变）；再点已选中 tab → 退出管理。
  // 委托绑在容器上（非逐钮）：卡片化二期起 renderMgrTabs 会在运行期重渲（外部卡注册/清空），
  // 逐钮绑定会被 innerHTML 一并抹掉。
  $('mgr-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('.mgr-tab')
    if (!b) return
    const k = b.dataset.mgr
    // 管理视图进/出走 hash 路由（#mgr/<kind> / #/）：刷新后可恢复当前管理视图
    if (state.mgr === k) navigate('#/')
    else { saveMgrView(); navigate('#mgr/' + k) }
  })

  // 整理会话弹层
  document.querySelectorAll('.org-opt').forEach((b) =>
    b.addEventListener('click', () => {
      document.querySelectorAll('.org-opt').forEach((x) => x.classList.toggle('on', x === b))
      state.mode = b.dataset.mode
      syncModeUI()
      $('organize-pop').classList.remove('show')
    }),
  )
  function syncModeUI() {
    document.querySelectorAll('.org-opt').forEach((x) => x.classList.toggle('on', x.dataset.mode === state.mode))
    renderRecent()
  }

  // 搜索
  $('s-mag').innerHTML = I.mag
  sInput.addEventListener('input', renderSearch)
  $('search-close').addEventListener('click', () => overlay.classList.remove('show'))
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.remove('show') })


  // ---------- 启动 ----------
  ;(async () => {
    await detectGateway()
    await loadSessions()
    initLive()
    initViewport() // 键盘弹出适配（visualViewport）：只压缩消息流底界与底栏
    setPanel(false)
    setChar(1) // 启动默认形象
    // 2026-08-30 改定案（用户）：刷新保留当前界面——/session/<hash> 直进恢复，boot 不再把会话路径
    // 重置回首页（2026-08-28「进入/刷新一律默认初始界面」旧定案作废）。刷新瞬间列表未就绪由
    // renderSession 占位「加载中」，WS 验证通过 → hideGate 的 loadSessions().then 恢复链落地重渲。
    renderRecent()
    // work 模式启动恢复（2026-09-25）：恢复持久化模式/项目/文件 → 绑事件 → 落地；须在 route() 之前，
    // route 进入 mgr/preview 时会把模式强制切回 chat（视图卡与 work 两栏互斥，见 chat/route.js）。
    initWork()
    route()
    if (GATEWAY) initGateway()
    else { inputEl.contentEditable = 'false'; inputEl.dataset.ph = '只读查看 · 无法发送' } // 只读查看器：输入不可编辑
    if (HOT_RELOAD) {
      // 开发审阅热重载：server.mjs HOT_RELOAD=1 时，public/ 文件变化经 SSE 通知 → 自动刷新
      const hr = new EventSource('/gateway/hotreload')
      hr.onmessage = (e) => { if (e.data === 'reload') location.reload() }
    }
  })()