// hash 路由（首页/会话/管理/预览）（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { isRealUser, stampMsgIn, charNote, messagesHtml, pendingUserMsgs, addUser, absorbPending, queueClaimAdopt } from './messages.js'
import { stage, stageRelease, stageFollow, stageStart } from './stage.js'
import { hideGate } from '../core/auth.js'
import { setChar } from '../core/char.js'
import { needToken } from '../core/gateway.js'
import { refreshSession, renderSessionBody, stopLiveFoldTimer, bindLiveFoldTimer } from '../core/live.js'
import { hashOf, findSession, loadSessions, fetchMessages, applySessionModel } from '../core/sessions.js'
import { chatArea, messagesEl, inputWrap, state, loadMgrView, live, toast } from '../core/state.js'
import { renderTransient, claimStartTs, syncTurnLive, takeover, clearTakeover, sendSubscribe, renderTaskDock } from '../inputbar/approval.js'
import { renderProjSeat, closeProjPop } from '../inputbar/commands.js'
import { renderCtxMeter } from '../inputbar/ctx-meter.js'
import { closeMentionPop } from '../inputbar/mention.js'
import { gwSend, syncGwSend } from '../inputbar/send.js'
import { renderMgr, openProjectPreview } from '../sidebar/mgr.js'
import { firstSendHash, newWebSession, renderRecent } from '../sidebar/recent.js'
  // ---------- 路由 ----------
  // 2026-08-28 pushState 路径路由：/session/<全长会话hash>、/manage/<kind>、/project/<label>（project 避开网关
  // /preview/* 静态页路径）；hash 路由保留为旧链接/旧缓存页兜底（parseRoute 先 pathname 后 hash）。
  // 2026-08-29 用户定案：全部前缀用全称（/session/、/manage/、/project/、/backend/，禁止简写）；
  // 旧缩写前缀（/s/、/mgr/、/pview/）仅作已发出链接的解析兼容，不再生成。
  // navigate('#mgr/k')/'#preview/l' 是内部调用约定 hash，经 pathFor 转真路径，URL 上不出现。
  function parseRoute() {
    const p = location.pathname
    if (p.startsWith('/session/')) return { name: 'session', hash: decodeURIComponent(p.slice(9)) }
    if (p.startsWith('/s/')) return { name: 'session', hash: decodeURIComponent(p.slice(3)) }
    if (p.startsWith('/manage/')) return { name: 'mgr', mgr: decodeURIComponent(p.slice(8)) }
    if (p.startsWith('/mgr/')) return { name: 'mgr', mgr: decodeURIComponent(p.slice(5)) }
    if (p.startsWith('/project/')) return { name: 'preview', label: decodeURIComponent(p.slice(9)) }
    if (p.startsWith('/pview/')) return { name: 'preview', label: decodeURIComponent(p.slice(7)) }
    const raw = location.hash.replace(/^#\/?/, '')
    if (!raw) return { name: 'home' }
    // 会话 UUID 不会以 mgr//preview/ 开头，前缀判定安全。
    if (raw.startsWith('mgr/')) return { name: 'mgr', mgr: raw.slice(4) }
    if (raw.startsWith('preview/')) return { name: 'preview', label: decodeURIComponent(raw.slice(8)) }
    return { name: 'session', hash: decodeURIComponent(raw) }
  }

  function route() {
    closeMentionPop()
    const r = parseRoute()
    // 任何导航（route 被调用）→ 退出管理视图；管理视图只由 mgr-tab 点击直接 renderMgr 进入，不走 route
    state.mgr = null
    state.preview = null
    if (r.name !== 'preview') state.previewMounted = null // 离开预览：清已挂载标记，下次进入重挂
    // 离开项目预览时回收 backend 保活心跳（2026-08-27 返回按钮移除后，退出预览全靠导航）
    if (window.__backendHeartbeat) {
      clearInterval(window.__backendHeartbeat)
      window.__backendHeartbeat = null
    }
    syncMgrTabs()
    // 2026-08-25 会话切换滞后修复：renderRecent() 里 .on 高亮按 state.currentHash 判定，
    // 原先 renderSession() 在 renderRecent() 之后才设 currentHash → 点第一次侧栏高亮停在旧会话，
    // 要再点一次才高亮正确（用户反馈「需要选中会话多次才可以完全切换」）。这里按路由目标预置，
    // 让 renderRecent() 一次导航即高亮正确目标。
    // 2026-08-28 /session/<全长hash> → resolve 校验会话存在（currentHash/SSE/WS 全链全长）；
    // 未知 hash 原样透传（renderSession 显示「会话不存在」）。
    if (r.name === 'session') {
      const sess = findSession(r.hash)
      r.hash = sess ? hashOf(sess) : r.hash
    }
    state.currentHash = r.name === 'session' ? r.hash : null
    renderRecent()
    if (r.name === 'home') renderHome()
    else if (r.name === 'mgr') { state.mgr = r.mgr; loadMgrView(); renderMgr() }
    else if (r.name === 'preview') { state.preview = r.label; openProjectPreview(r.label, true) }
    else renderSession(r.hash)
  }

  // 同步管理 tab 高亮（route/renderRecent 前调用）
  function syncMgrTabs() {
    document.querySelectorAll('.mgr-tab').forEach((x) => x.classList.toggle('on', x.dataset.mgr === state.mgr))
  }

  // 2026-08-25 同步路由：navigate 后同步调用 route()，不再依赖 hashchange 异步时序。
  // 背景：切换会话需双击——第一次点击走 hashchange 异步 route() 内容区不切换（侧栏 .on 高亮已对，
  // 因 currentHash 在 renderRecent 前预置），第二次点击 hash 已同 → navigate 同步 route() 才切。
  // 实测差异在同步 vs 异步，故改为同步渲染。
  // 2026-08-28 pushState 路径路由：navigate 参数保持既有 hash 形式（调用点零改动），内部转真路径：
  // '#/' → '/'、'#/<hash>' → '/session/<全长hash>'、'#mgr/<k>' → '/manage/<k>'、'#preview/<l>' → '/project/<l>'；
  // history.pushState + popstate 兜底前进/后退（hashchange 保留为旧 hash 链接兜底）。
  let lastNavHash = null
  function pathFor(hash) {
    if (hash === '#/' || hash === '#') return '/'
    if (hash.startsWith('#/')) return '/session/' + hash.slice(2)
    if (hash.startsWith('#mgr/')) return '/manage/' + hash.slice(5)
    if (hash.startsWith('#preview/')) return '/project/' + hash.slice(9)
    return '/'
  }
  function navigate(hash) {
    const path = pathFor(hash)
    if (location.pathname === path) return route()
    lastNavHash = path
    history.pushState(null, '', path)
    route()
  }

  // 2026-08-18 按 SubPj3 实现：空态输入栏挂 #empty-hint .g-stage 内真相对定位（top=台面 76.75%−26px），
  // 会话态移回 #chat-area 沉底。界面切换时移动 DOM，保证定位基准正确且 transition 平滑。
  const emptyStageEl = () => document.querySelector('#empty-hint .g-stage')
  function mountInput(where) {
    const target = where === 'stage' ? emptyStageEl() : chatArea
    if (target && inputWrap.parentNode !== target) target.appendChild(inputWrap)
  }
  // 输入栏 stage↔chat 迁移的 FLIP 补间（2026-08-30 丝滑空态→会话）：换父后 top/width 是
  // 百分比/calc，插值基准随新父容器变化 → 直接过渡会首帧跳变甚至离散。改 FLIP：变更前测
  // 旧矩形 → 统一施加类/父容器变更 → transform 从旧位滑到新位（transform 终点=恒等，无
  // 收尾跳变）→ 结束恢复样式表过渡。隐藏态（门/管理视图 display:none）或未移动时退回普通切换。
  let flipInputTimer = null
  function flipInput(toStage) {
    const el = inputWrap
    if (flipInputTimer) { // 上一次 FLIP 动画中途重入：清定时器并恢复内联样式，防残留
      clearTimeout(flipInputTimer)
      el.style.transition = ''
      el.style.transformOrigin = ''
      flipInputTimer = null
    }
    const apply = () => {
      if (toStage) {
        el.classList.remove('docked')
        chatArea.classList.remove('in-session')
        mountInput('stage')
      } else {
        mountInput('chat')
        el.classList.add('docked')
        chatArea.classList.add('in-session')
      }
    }
    const r1 = el.getBoundingClientRect()
    if (getComputedStyle(el).display === 'none' || !r1.width) { apply(); return }
    el.style.transition = 'none'
    apply()
    const r2 = el.getBoundingClientRect()
    if (!r2.width) { el.style.transition = ''; return }
    // 类变换恒等盒换算：stage 态 translate(-50%,-50%)、docked 态 translate(-50%,-100%)
    const anchorY = toStage ? 0.5 : 1
    const tx = r1.left - (r2.left + r2.width / 2)
    const ty = r1.top - (r2.top + r2.height * anchorY)
    const kx = r1.width / r2.width
    const ky = r1.height / r2.height
    if (Math.abs(tx) < 1 && Math.abs(ty) < 1 && Math.abs(kx - 1) < 0.01 && Math.abs(ky - 1) < 0.01) {
      el.style.transition = ''
      return
    }
    el.style.transformOrigin = 'top left'
    el.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(' + kx + ', ' + ky + ')'
    void el.offsetWidth // 提交起始帧
    el.style.transition = 'transform 0.55s cubic-bezier(0.22, 0.61, 0.36, 1)'
    el.style.transform = ''
    flipInputTimer = setTimeout(() => {
      el.style.transition = ''
      el.style.transformOrigin = ''
      flipInputTimer = null
    }, 580)
  }

  function renderHome() {
    stopLiveFoldTimer()
    setTurnLive(false); syncGwSend() // 2026-09-04 打断按钮：离开会话还原发送键
    stageRelease()
    clearTakeover() // 导航离开：清掉残留的提问/审批 takeover（输入栏恢复）
    state.currentHash = null
    messagesEl.innerHTML = ''
    // 2026-09-08 新会话界面串行根治：回首页（空态）同样必须清「当前会话」全局槽——与
    // renderSession 切会话清理（「切会话即清全局槽」定案）同一清单的对称延伸。不变量：
    // live.curUuid 非空 ⇔ 当前视图正展示该会话；session-delta（419）/queue-state（405）守卫
    // 都以它为前提。renderHome 原先只清 messagesEl 不清槽 → 上一会话的 delta 靠残留
    // curUuid/deltaSeq 通过守卫，renderSessionBody 整页重建把该会话转录连同「正在处理/
    // 正在思考」实时尾灌进首页消息区（实测：新会话界面显示别的会话完整消息流）。
    live.lastMsgLen = null
    live.localMessages = null
    live.deltaSeq = null
    live.queueRemote = []
    live.curUuid = null
    live.tasks = [] // 2026-09-10 任务浮窗：首页空态清任务快照（切会话即清全局槽定案）
    renderTaskDock()
    live.streamText = '' // 2026-09-08 流式字符通道：首页空态清流式暂态（切会话即清全局槽定案）
    setPendingUserMsgs(pendingUserMsgs.filter((p) => p.hash)) // 首页无事务归属：丢弃 hash='' 残留项（防主张气泡飘上空态）
    setChar(1) // 首页空态 → 默认形象
    renderCtxMeter(null) // 首页空态 → 隐藏上下文环
    renderProjSeat()
    chatArea.classList.remove('mgr-on')
    flipInput(true) // docked/in-session 移除 + 挂回 stage 一并由 FLIP 处理（旧位取变更前矩形）
  }

  function renderSession(hash) {
    stopLiveFoldTimer()
    setTurnLive(false); syncGwSend() // 2026-09-04 打断按钮：切会话先复位，busy 会话由下方 syncTurnLive 按实况恢复
    // 切换会话：丢空态（hash=null）乐观项；各会话 pending 保留（2026-08-29 用户反馈
    // 「切换会话引导消息会消失」→ 按 hash 关联，切回时 absorbPending + renderTransient 处理）。
    // 首条消息事务进行中（firstSendHash 在场）hash='' 的乐观项属事务，不丢。
    setPendingUserMsgs(pendingUserMsgs.filter((p) => p.hash || (firstSendHash && p.hash === '')))
    live.lastMsgLen = null // 切换会话：重置增量重建守卫（首个刷新必整页渲染，防跨会话误增量）
    // 2026-09-08 事件流统一 P1：清 delta 本地基线（localMessages/seq）——串会话防写穿（等权
    // 正确性：切会话即清全局槽），新会话基线由 fetch 回程（renderSession/refreshSession）重建。
    live.localMessages = null
    live.deltaSeq = null
    // 2026-08-30 串会话根治：上一会话遗留的全局槽在切换瞬间必须清空——
    // ① live.queueRemote 不清 → 新会话首屏 renderTransient 直接渲染上一会话的 CLI 队列快照
    //   （确定性串染，连竞态都不需要；fetch 回来再硬重置为本会话 queued）；② live.curUuid
    //   不清 → 加载窗口内 queue-state SSE 按旧 uuid 匹配成功，把旧会话快照写进新会话视图。
    live.queueRemote = []
    live.curUuid = null
    live.tasks = [] // 2026-09-10 任务浮窗：切会话清任务快照（同 queueRemote 槽清单，防上一会话清单串染）
    renderTaskDock()
    live.streamText = '' // 2026-09-08 流式字符通道：切会话清流式暂态（串会话防写穿，同 queueRemote/curUuid 槽清单）
    setModelUserPicked(false) // 切换会话：允许 /gateway/session 上报的会话模型校准 seat
    stageRelease()
    clearTakeover() // 切换会话：清掉残留的提问/审批 takeover（输入栏恢复）
    closeProjPop() // 切换会话：项目选择器弹层一并收起（初始界面专属件）
    renderProjSeat() // 会话态：工作文件夹标识按当前会话项目重渲（锁定只读）
    chatArea.classList.remove('mgr-on')
    flipInput(false) // 输入栏移回 #chat-area 沉底（FLIP 像素级补间）
    const s = findSession(hash)
    state.currentHash = hash
    sendSubscribe() // 2026-08-30 pending 重放：切会话即订阅 → 网关回放该会话未决审批/提问（补弹交互卡）
    if (!s) {
      // 2026-08-30 刷新直进 /session/<hash>：token 门未过时会话列表未拉（loadSessions 空跑），
      // 此时找不到 ≠ 真不存在 → 占位「加载中」，由 hideGate 的 loadSessions().then 恢复链落地重渲；
      // 列表就绪后仍找不到才渲染「会话不存在或已删除」。
      if (needToken()) {
        messagesEl.innerHTML = '<div class="msg msg-system">加载中…</div>'
        renderCtxMeter(null) // 无会话数据 → 隐藏上下文环
        inputWrap.classList.add('docked')
        chatArea.classList.add('in-session')
        return
      }
      messagesEl.innerHTML = '<div class="msg msg-system">会话不存在或已删除</div>'
      renderCtxMeter(null) // 无会话数据 → 隐藏上下文环
      inputWrap.classList.add('docked')
      chatArea.classList.add('in-session')
      return
    }
    // 2026-08-25 发送即 resume：打开 web 会话仅预览（与 CLI 会话一致），不再自动拉起本地 CLI 窗口；
    // 会话进程未在线时，发送消息（gwSend → 网关 resumeAndDeliver）才恢复窗口并投递。
    // 原自动 resume + subscribe 已移除：审批卡经网关 broadcast → /ws sockets 到达，subscribe 为死代码。
    // 首条消息事务（2026-09-06 根治）：newWebSession 在 navigate 之前回填 firstSendHash——
    // navigate 同步 route → 本函数跑在 gwSend await 续体之前（旧 pendingFirstSend.hash 此刻
    // 仍为 ''，事后守卫必失效 =「加载中…」洗掉乐观 DOM 的三态根因），hash 回填前移后守卫全程有效。
    // 事务期不洗「加载中…」，乐观 DOM 是权威等真实数据；切到其它会话=放弃首条乐观视图，事务作废。
    if (firstSendHash && firstSendHash !== hash) setFirstSendHash('')
    if (firstSendHash !== hash) {
      messagesEl.innerHTML = '<div class="msg msg-system">加载中…</div>'
    }
    setChar(1) // 加载中 → 默认形象
    inputWrap.classList.add('docked')
    chatArea.classList.add('in-session')
    fetchMessages(s.id)
      .then(({ messages, context, model, modelTs, cwd, file, queued, tasks, deltaSeq }) => {
        if (state.currentHash !== hash) return
        setSessionCwd(cwd)
        // 2026-09-08 事件流统一 P1：首载回程同样重置 delta 本地基线（与 refreshSession 对称，
        // 切会话清理后由本回程重建；此后 session-delta 增量演进至下轮全量对账）。
        live.localMessages = messages
        live.deltaSeq = deltaSeq
        // 切会话队列快照硬重置（2026-08-30）：以本会话响应为准，杜绝上一会话残留
        live.queueRemote = Array.isArray(queued) ? queued : []
        // 切会话任务清单硬重置（2026-09-10）：以本会话响应为准（空数组 = 该会话无清单 → 浮窗不出现）
        live.tasks = Array.isArray(tasks) ? tasks : []
        renderTaskDock()
        // 首条消息事务收口：本会话真实数据已落盘（渲染权威接管起点）→ 销毁事务，queue-dock
        // 恢复正常渲染。销毁先于下方守卫/重建：事务只在「乐观权威期」存在。
        // txTakeover/计时移交语义见 refreshSession 同款收口注释（接管帧跳过 stampMsgIn+续算计时）。
        let txTakeover = false
        if (firstSendHash === hash && messages.length > 0) {
          txTakeover = true
          for (const p of pendingUserMsgs) if (p.hash === '') p.hash = hash // 事务归属落定：'' 项归入本会话（吸收判定依赖 p.hash===cur）
          live.txProcStart = claimStartTs() // 主张计时起点移交（bindLiveFoldTimer 续算，跨接管不回跳）
          setFirstSendHash('')
        }
        // 2026-08-30 图片内联渲染：会话 uuid（image-cache 目录名）供用户气泡 <img> URL 拼接，
        // 首开即设（refreshSession 同款，防首屏图片 URL 带空 uuid）
        if (file) live.curUuid = file.replace(/\.jsonl$/, '')
        live.lastDataTs = (messages.length && messages[messages.length - 1].timestamp) || 0 // 切会话：基线硬重置为本会话末条 ts
        applySessionModel(model, modelTs) // 2026-08-24：打开会话即用 CLI 上报的实际模型校准 seat
        renderCtxMeter(context)
        // 首条消息事务期（2026-09-06）：fetch 空（CLI 尚未落盘首条 user）→ 跳过整页重建保留
        // 乐观 DOM（开启气泡+主张折叠是权威，不被「加载中…」/空态行洗掉），真实数据经 SSE
        // refreshSession 接管（refreshSession 同款「空 fetch 不洗盘」守卫已挡后续）。非空照常重建。
        if (!(firstSendHash === hash && messages.length === 0)) {
          messagesEl.innerHTML = messagesHtml(messages)
        }
        // 2026-08-29 切回会话：吸收该会话已落盘消息（切走不再清空 pending）；2026-09-07 暂态区
        // 收编——innerHTML 重建洗掉 #live-zone，renderTransient 从状态整体重渲（气泡/主张折叠/排队区）
        absorbPending(messages)
        queueClaimAdopt(queued) // 队首主张收编（刷新两段式根治，形态由 renderTransient 按 authLive 定）
        renderTransient()
        // 2026-09-11 ④ 只读提问卡接管已移除（用户定案「静态的提问卡不可交互的…直接移除就好」）：
        // 提问态在消息流里由紧凑工具行表达（askLineHtml「提问 · 等待回答」），作答在 CLI 窗口。
        // 此处只保留审批卡保护——交互式逐题审批卡占据输入栏时不得被 clearTakeover 洗掉。
        if (takeover !== 'approval') clearTakeover()
        setChar(charNote) // 只读 SSE：按末段最近工具/处理状态切形象
        bindLiveFoldTimer(messages)
        syncTurnLive() // 2026-09-04 打断按钮：渲染权威重建后按 done-live 在场校准（busy 会话直进）
        // 事务期（空 fetch 保留乐观 DOM）与接管帧不播入场动画：乐观气泡/proc 折叠已在位，
        // stampMsgIn(new Set()) 会对其重播 fadeup（「正在处理」创建/接管瞬间闪现重现）
        if (firstSendHash !== hash && !txTakeover) stampMsgIn(new Set())
        const last = messages.length ? messages[messages.length - 1] : null
        live.curSig = messages.length + ':' + (last ? (last.timestamp || '') : '') + ':' + (last && last.blocks.length ? last.blocks[last.blocks.length - 1].kind : '')
        // 记录末尾真实用户消息基线：首屏默认不钉顶（只有实时同步新增用户消息才唤出）
        let lastU = -1
        for (let i = messages.length - 1; i >= 0; i--) if (isRealUser(messages[i])) { lastU = i; break }
        const baseU = lastU >= 0 ? lastU + ':' + (messages[lastU].timestamp || '') : ''
        live.lastUserSig = baseU
        live.pinnedUserSig = baseU
        // 刷新/首屏恢复（两层消息流口径，2026-09-09 修订）：最后回合开启气泡在场即唤出占位
        // ——占位=开启气泡在第二层的映射，同等地位（2026-09-09 用户定案）。旧口径「仅末段
        // 处理中（done-live 在场）才唤出、回合已结束普通吸底」为 09-08 残留：回合收口「已
        // 处理」后刷新/切回占位永久死亡且无法恢复（用户实证）。几何 stageFollow 自洽无需
        // 分支：内容超一屏 → 贴顶位<内容底 → 吸底（与旧「普通吸底」逐像素一致）；不足一屏
        // → 占位垫底停贴顶位（两层流正确形态）。
        let pinned = false
        if (lastU >= 0) {
          const el = messagesEl.querySelector(`[data-m="${lastU}"][data-t="u"]`)
          if (el) {
            stageStart(el, baseU, false)
            pinned = true
          }
        }
        const sc = $('chat-scroll')
        if (!pinned) {
          sc.style.scrollBehavior = 'auto'
          sc.scrollTop = sc.scrollHeight
          sc.style.scrollBehavior = ''
        }
        // 2026-09-06 首条消息事务化：旧「fetch 空时补挂 addUser/procOpen」兜底整段删除——
        // 事务期乐观 DOM 是权威且不会被任何路径洗掉（888/913 守卫），无需补挂；不留兜底。
      })
      .catch((e) => toast('读取会话失败: ' + (e.message || e)))
  }

// —— 跨模块写入口（切割脚本生成）——
export function setLastNavHash(v) { lastNavHash = v }

export {
  emptyStageEl,
  flipInput,
  flipInputTimer,
  lastNavHash,
  mountInput,
  navigate,
  parseRoute,
  pathFor,
  renderHome,
  renderSession,
  route,
  syncMgrTabs,
}
