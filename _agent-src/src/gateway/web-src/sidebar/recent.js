// 侧栏 recent + 行操作（扶起/内嵌菜单/归档/关闭/重命名）（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { route, navigate, renderSession } from '../chat/route.js'
import { deviceHint } from '../core/auth.js'
import { gws, needToken, apiUrl } from '../core/gateway.js'
import { I } from '../core/icons.js'
import { refreshList, refreshSession } from '../core/live.js'
import { hashOf } from '../core/sessions.js'
import { bodyEl, sidebar, bubblePop, recentLabel, modeTabsEl, state, ALL, esc, toast, isMobile } from '../core/state.js'
import { gwSend } from '../inputbar/send.js'
import { renderBubble, renderSearch } from './bubble-search.js'
import { renderList, renderProject } from './mgr.js'
  // ---------- 侧栏 ----------
  function setPanel(open) {
    state.panelOpen = open
    sidebar.classList.toggle('open', open)
    // 展开/折叠侧栏时关闭 rail 相关的弹层
    bubblePop.classList.remove('show')
    $('organize-pop').classList.remove('show')
  }

  // 项目编号提取（2026-08-25）：projectLabel 如 'Pj16-CodeAgent构建' → 短编号 'Pj16'；
  // 命中 Pj<数字> 前缀取前缀，否则回落完整 label（个别非 Pj 命名项目也能区分）。
  function projIdOf(label) {
    const m = /^Pj\d+/.exec(label || '')
    return m ? m[0] : label || ''
  }

  function itemHtml(s, showProj) {
    const on = hashOf(s) === state.currentHash
    // 会话状态点：busy=绿（正在运行）· waiting=橘（等待用户）· idle=红（运行暂停/已完成）· 无=透明（CLI 未打开）
    const dotCls = s.state === 'busy' ? ' st-busy' : s.state === 'waiting' ? ' st-ask' : s.state === 'idle' ? ' st-wait' : ''
    // 2026-08-25 项目会话编号气泡（仅「在一个列表中」堆叠视图，renderList 传 showProj=true）：
    // 平铺时项目会话混在根会话里，用短编号（Pj16）标识所属项目；项目文件夹视图已有文件夹名，不重复显示。
    const projTag = showProj && s.projectScope === 'project' && s.projectLabel
      ? `<span class="w-tag" title="${esc(s.projectLabel)}">${esc(projIdOf(s.projectLabel))}</span>` : ''
    // 2026-08-24 会话行操作（DSH 侧栏 Menu 移植）：hover 显现 …，点击弹出行菜单（重命名/归档）
    const more = '<span class="sess-more" role="button" tabindex="-1" title="会话操作">…</span>'
    return `<button class="sess-item${on ? ' on' : ''}" data-hash="${esc(hashOf(s))}" title="${esc(s.file)}">
      <span class="dot${dotCls}"></span><span class="title">${esc(s.title)}</span>${projTag}${more}</button>`
  }

  // ---------- 真触屏判定（2026-09-05）：iPadOS Safari 桌面模式报 hover:hover+pointer:fine（与 macOS
  // 全同），CSS @media 骗不过 → 「hover 才显」规则（sess-more/folder-add 等）在 iPad 上生效，
  // 触发 iOS「hover 改变布局 → 首击只应用 hover 吞 click」双击（笔按钮实测首击选中二击才跳转）。
  // 判定 = hover:none（手机）或 MacIntel+多点触控（iPad，与 deviceHint 同式）→ body.touch，
  // CSS 对触屏恒显这些元素（见 styles.css body.touch 段），liftStart 同步禁用。
  const IS_TOUCH_DEVICE =
    matchMedia('(hover: none)').matches ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  if (IS_TOUCH_DEVICE) document.body.classList.add('touch')

  // ---------- 会话 tab 悬停扶起（2026-09-05）：fixed 浮起 + 宽度拉伸显示完整标题 ----------
  // #recent-body 是 overflow 裁剪容器，行内加宽必被裁剪；hover 时把该行临时 position:fixed
  // 浮到原位（fixed 不受祖先 overflow 裁剪），原位插同高占位防行高塌陷，背景/阴影/上移/宽度
  // 四路同步过渡到「扶起」终态；离开/列表滚动/窗口 resize/SSE 重建立即还原。触摸设备不启用。
  let liftEl = null
  let liftSpacer = null
  let liftBound = false
  // 滚动静默期（2026-09-08 侧栏滚轮失效根修）：scroll 后 150ms 内 hover 不扶起。
  // 不变量：扶起（fixed 化+插占位符=布局重排）只发生在列表静止态——滚动中扶起与滚动互搏：
  // 每格滚动触发「拍回删占位符（内容缩一行高）→ hover 重算重扶插占位符（内容长回）」，
  // 占位符插删的净位移抵消滚动量 = 观感滚轮失效（wheel 到达+无 preventDefault，target 恒为
  // 行——列表被行铺满无空白落点）；偶发正常=鼠标落点（白边/滚动条不触发）+主线程忙闲时序竞争。
  // 连续滚动每次 scroll 续期；菜单/重建重扶走 liftStart 直调不受冷却约束（点击语义，非 hover）。
  let liftCool = 0
  let reLiftHash = null // 行点击触发的导航：renderRecent 重建后按 hash 重扶被点行（用后即清）
  let mouseXY = null // 最近光标落点：renderRecent 重建后按落点重扶 hover 行（页面加载前 null 不误扶）
  function liftClear(force) {
    // 行菜单开着：还原冻结。2026-09-06 菜单子元素化后 mouseleave 在菜单悬停时不再触发（DOM 子树语义），
    // 冻结只挡 scroll/resize 的非 force 还原——菜单是行子元素，行拍回=菜单失去 CB 基准悬空，closeRowMenu 统一还原。
    if (!force && rowMenu) return
    // 宿主行被力还原（切浮起目标：菜单开着划过另一行 → 该行 mouseenter → liftStart 开头清旧）
    // → 浮窗跟随关闭（浮窗=tab 的一部分，tab 拍回浮窗不得悬空）。必须发生在拍回动作前：行一旦
    // 摘掉 .lift（transform 消失），浮窗 fixed CB 瞬间从行变回视口，「相对行偏移」的 left/top 被
    // 当视口坐标渲染 = 浮窗飞到视口顶部（2026-09-06 用户实测二轮）。closeRowMenu 尾部会再走一次
    // liftClear(true) 完成拍回（届时 rowMenu 已 null 不递归），此处 return 防双拍。
    if (rowMenu && liftEl && rowMenu.parentElement === liftEl) { closeRowMenu(); return }
    if (liftEl) {
      liftEl.classList.remove('lift', 'lift-anim')
      liftEl.style.position = ''; liftEl.style.left = ''; liftEl.style.top = ''
      liftEl.style.width = ''; liftEl.style.zIndex = ''
      liftEl.style.background = ''; liftEl.style.boxShadow = ''; liftEl.style.transform = ''
      liftEl = null
    }
    if (liftSpacer) { liftSpacer.remove(); liftSpacer = null }
  }
  document.addEventListener('mousemove', (e) => { mouseXY = [e.clientX, e.clientY] }, { passive: true, capture: true })
  function liftStart(el, opts = {}) {
    // 触屏禁用已移至 bindSessLift（hover 扶起不绑）——菜单场景（toggleRowMenu）触屏也扶起：
    // 行 fixed 化=菜单 CB+脱出 #recent-body 裁剪（2026-09-06 二轮根修，iPad 浮窗被列表截断随之根治）
    if (liftEl === el) return // 幂等：已浮起（重扶/mouseenter 不重播扶起动画）
    // 切换浮起目标必须无条件清旧：若被 rowMenu 冻结短路，旧浮起行的 fixed 态+占位 spacer 成孤儿
    // （菜单开着划过另一行 → 列表残留空白，2026-09-05 实测），冻结语义只应作用于 mouseleave。
    liftClear(true)
    const r = el.getBoundingClientRect()
    if (!r.height) return
    liftEl = el
    liftSpacer = document.createElement('div')
    liftSpacer.style.height = r.height + 'px'
    el.parentNode.insertBefore(liftSpacer, el)
    el.style.position = 'fixed'; el.style.left = r.left + 'px'; el.style.top = r.top + 'px'
    el.style.zIndex = '60'; el.style.width = r.width + 'px'
    // 目标宽 = 完整标题实测宽，上限 = 视口剩余空间。
    // 测量必须带 .lift：桌面 … 默认 display:none（:hover/.lift 才显）。首次 hover 扶起测量时行有
    // :hover 能测到 …；重建重扶（anim:false）新节点无 :hover，裸测漏 … 宽 ≈28px → 挂 .lift 后 …
    // 挤压标题=展开仍省略号+右侧空隙，且每次重建重扶卡宽瞬间回缩（未选中行「重新浮起」动作，
    // 2026-09-06 实测）。.lift 无过渡（lift-anim 未挂）且同一任务内无绘制，先挂后摘视觉零影响。
    el.classList.add('lift')
    el.style.width = 'max-content'
    const target = Math.min(el.getBoundingClientRect().width, window.innerWidth - r.left - 12)
    el.style.width = r.width + 'px'
    if (opts.anim === false) {
      // 恢复路径（重建后重扶）：.lift 已挂（测量顺带），直接终态不播过渡——活动流驱动的重建随时插入，
      // 每次重播「起步 hover 外观→扶起终态」拉伸动画=视觉脉冲（2026-09-05 根修 hover 重建拍回配套）
      if (target > r.width + 1) el.style.width = target + 'px'
    } else {
      // 起步态 = 当前 hover 外观（内联）：先摘 .lift 再锚定起步态，随后挂终态类触发平滑过渡
      el.classList.remove('lift')
      el.style.background = 'var(--hover)'
      el.style.boxShadow = '0 0 0 1px rgba(0,0,0,0), 0 0 0 rgba(0,0,0,0)'
      el.style.transform = 'translateY(0)'
      void el.offsetWidth // 强制 layout：让起步内联态成为已计算样式，随后挂终态类触发平滑过渡
      el.classList.add('lift', 'lift-anim')
      el.style.background = ''; el.style.boxShadow = ''; el.style.transform = ''
      if (target > r.width + 1) el.style.width = target + 'px'
    }
    if (!liftBound) {
      liftBound = true
      bodyEl.addEventListener('scroll', () => { liftCool = Date.now() + 150; liftClear() }, { passive: true })
      window.addEventListener('resize', liftClear)
      // 滚轮拍回（2026-09-10 侧栏滚轮无响应根修）：Chromium 滚动链走包含块链，fixed 浮起行直连
      // viewport、把 DOM 祖先 #recent-body 从滚动链上摘除——列表被行铺满、光标恒停浮起行（滚动后
      // Chrome 还会按静止光标重扶）→ 滚轮 target 恒为 fixed 行 = 全死区（CDP 探针实测：wheel 到达
      // +0 scroll，v274 liftCool 门拦的是「滚动中重扶」，管不到这条）。滚轮到达列表=滚动意图：
      // 同步拍回+强制 layout，让默认滚动动作在干净布局上把滚动链重新解析回本容器（探针复验通过）。
      // non-passive 保证监听先于默认滚动动作执行。菜单开着=一并关闭（滚轮=菜单外交互；
      // closeRowMenu 对鼠标在行内场景会保留浮起，故其后再无条件拍回，不变量：滚轮到达列表
      // → 列表回纯在流态）。liftCool 与 scroll 门同参续期：滚轮持续=非静止态，防边界拍回/重扶循环。
      bodyEl.addEventListener('wheel', () => {
        if (!liftEl && !rowMenu) return
        liftCool = Date.now() + 150
        if (rowMenu) closeRowMenu()
        if (liftEl) { liftClear(true); void bodyEl.offsetHeight }
      }, { passive: false })
    }
  }
  function bindSessLift(root) {
    // hover 扶起仅桌面指针设备绑定；触屏不启用（iPad 桌面模式 matchMedia 伪装 hover:hover
    // 骗过媒体查询，IS_TOUCH_DEVICE 才是真触屏）——菜单场景扶起走 toggleRowMenu 直调，不经此处
    if (IS_TOUCH_DEVICE || !matchMedia('(hover: hover) and (pointer: fine)').matches) return
    root.querySelectorAll('.sess-item').forEach((el) => {
      el.addEventListener('mouseenter', () => { if (Date.now() >= liftCool) liftStart(el) })
      el.addEventListener('mouseleave', liftClear)
    })
  }

  function bindSessClicks(root) {
    root.querySelectorAll('.sess-item').forEach((b) =>
      b.addEventListener('click', () => {
        // 已在该会话内：不 navigate（route→renderRecent 会整列重建，浮起行随之消亡重扶，闪一次扶起动画）
        if (b.dataset.hash === state.currentHash) return
        reLiftHash = b.dataset.hash // 2026-09-05 重建后重扶被点行（新节点 :hover 不恢复，不重扶=点击即拍回）
        navigate('#/' + encodeURIComponent(b.dataset.hash))
        if (isMobile()) setPanel(false)
      }),
    )
    // 2026-08-24 行菜单入口：…（span 嵌在 .sess-item button 内）
    // 2026-09-05 … 点击统一「先切换、后落位」：navigate 可能整列重建（旧节点/浮起/rect 全失效），
    // 菜单与浮起一律在重建后的新节点上落位（toggleRowMenu 内补扶）；已在该会话内不 navigate
    // （零重建，浮起行保持原节点）。单击三个点 = 切换会话 + 弹出该行菜单（2026-08-25 定案语义不变）。
    root.querySelectorAll('.sess-more').forEach((m) =>
      m.addEventListener('click', (e) => {
        e.stopPropagation() // 阻止事件冒泡到 .sess-item 的 click（避免重复 navigate）
        const b = m.closest('.sess-item')
        if (!b || !b.dataset.hash) return
        if (b.dataset.hash !== state.currentHash) {
          reLiftHash = b.dataset.hash
          navigate('#/' + encodeURIComponent(b.dataset.hash))
          if (isMobile()) setPanel(false)
        }
        const nb = [...bodyEl.querySelectorAll('.sess-item')].find((x) => x.dataset.hash === b.dataset.hash)
        const anchor = nb && nb.querySelector('.sess-more')
        if (anchor) toggleRowMenu(anchor, b.dataset.hash)
      }),
    )
    bindSessLift(root)
  }

  // ---------- 会话 tab 内嵌展开菜单（2026-09-07 用户定案：浮窗改 tab 自身长高）----------
  // 选项不再弹独立浮窗，作为 .sess-menu 挂 tab 行内第二行（flex-wrap），height 0→实测高
  // 过渡 = tab 高度展开动画；再点 … /点外部（mousedown）关闭（瞬时收起）。菜单是行子元素：
  // 鼠标在菜单上=仍在行 DOM 子树内，mouseleave 不触发、浮起天然保持（2026-09-06 子元素化
  // 定案语义延续）；浮窗时代的定位/免裁/行∪浮窗几何判定（positionRowMenu/menuRect）随浮窗
  // 整体删除——内嵌后展开域 ⊆ 行 rect，且行浮起（fixed）天然脱出 #recent-body 裁剪。
  // 仍沿用浮起前提：菜单只存在于浮起 tab 上（liftStart anim:false 直终态，折叠行等不可浮场景不弹）。
  let rowMenu = null
  function toggleRowMenu(anchor, hash) {
    if (rowMenu && rowMenu.dataset.hash === hash) { closeRowMenu(); return }
    closeRowMenu() // 换菜单（关旧开新）：旧行浮起去留交 closeRowMenu 的 hover 判定（鼠标已在新行 → 旧行拍回）
    const row = anchor.closest('.sess-item')
    // 菜单挂载前提=行已成浮起宿主（fixed+.lift=免裁+盖住下方行），anim:false 直终态
    if (row) liftStart(row, { anim: false })
    if (!row || !row.classList.contains('lift')) return // 折叠行等不可浮场景：不弹（不变量：菜单只存在于浮起 tab 上）
    const m = document.createElement('div')
    m.className = 'sess-menu'
    m.dataset.hash = hash
    m.innerHTML =
      '<div class="sess-menu-in">' +
      `<button type="button" class="rm-item" data-a="rename">${I.dshEdit}<span>重命名</span></button>` +
      `<button type="button" class="rm-item" data-a="archive">${I.dshArchive}<span>归档会话</span></button>` +
      `<button type="button" class="rm-item" data-a="close">${I.dshStop}<span>关闭会话</span></button>` +
      '</div>'
    row.appendChild(m)
    // 展开动画：class 基准 height:0 先强制 layout 提交，再落实测内容高触发 height 过渡
    void m.offsetHeight
    m.style.height = m.firstChild.offsetHeight + 'px'
    m.addEventListener('click', (e) => e.stopPropagation()) // 挡冒泡到行 click（否则点菜单项误 navigate）
    // 菜单挂着=鼠标 hover 命中行子树 → 原生 title（文件名）tooltip 会在菜单上弹出，暂存抑制
    row.dataset.title = row.title
    row.title = ''
    m.querySelector('.rm-item[data-a="rename"]').addEventListener('click', () => {
      closeRowMenu()
      openRenameDialog(hash)
    })
    m.querySelector('.rm-item[data-a="archive"]').addEventListener('click', () => {
      closeRowMenu()
      archiveSession(hash)
    })
    m.querySelector('.rm-item[data-a="close"]').addEventListener('click', () => {
      closeRowMenu()
      closeSession(hash)
    })
    rowMenu = m
  }
  function closeRowMenu() {
    if (rowMenu) {
      const host = rowMenu.parentElement
      if (host && host.classList && host.classList.contains('sess-item')) {
        if (host.dataset.title !== undefined) { host.title = host.dataset.title; delete host.dataset.title }
      }
      rowMenu.remove()
      rowMenu = null
    }
    // 鼠标仍悬在浮起行（如点同一 … 关菜单、点菜单项）：浮起保持到移开鼠标（mouseleave 自然回位）。
    // 菜单是行子元素，展开域 ⊆ 行 rect，行矩形一个判定即可。几何判定而非 :hover：菜单开着时的
    // 列表重建会整列换节点（renderRecent 重扶的新节点 Chrome 不恢复 :hover），:hover 判定恒假
    // → closeRowMenu 把刚重扶的行拍回 → 下方补扶 liftStart 走 anim 路径重播扶起动画（2026-09-06
    // 用户实测「直点 tab 没事、点 … 必现重新浮起」根因）。mouseXY=最近光标落点，重建换节点后依然成立。
    if (liftEl && mouseXY) {
      const r = liftEl.getBoundingClientRect()
      if (mouseXY[0] >= r.left && mouseXY[0] <= r.right && mouseXY[1] >= r.top && mouseXY[1] <= r.bottom) return
    }
    liftClear(true) // 菜单关闭=还原冻结解除：浮起行回位
  }
  document.addEventListener('mousedown', (e) => {
    // … 按钮上的按下不关菜单，交给 click 的 toggle（否则 mousedown 关 → click 重开 = 三点永远关不掉菜单）
    if (rowMenu && !rowMenu.contains(e.target) && !e.target.closest('.sess-more')) closeRowMenu()
  })

  // ---------- 归档会话（2026-08-24 DSH archiveSession 移植）----------
  // 归档 = 从侧栏/搜索列表隐藏（本地 localStorage 持久化，与 DSH「归档集」语义一致：
  // 日志/转录保留，只是不在分组表面出现）。不提供恢复入口（对齐 DSH 当前行为）。
  const ARCHIVED_KEY = 'floria-archived-v1'
  let archivedSet = null
  function loadArchived() {
    if (archivedSet) return archivedSet
    try {
      const raw = JSON.parse(localStorage.getItem(ARCHIVED_KEY) || '[]')
      archivedSet = new Set(Array.isArray(raw) ? raw.map(String) : [])
    } catch {
      archivedSet = new Set()
    }
    return archivedSet
  }
  function saveArchived() {
    try { localStorage.setItem(ARCHIVED_KEY, JSON.stringify([...loadArchived()])) } catch { /* 忽略 */ }
  }
  function isArchived(s) { return loadArchived().has(hashOf(s)) }
  function archiveSession(hash) {
    loadArchived().add(hash)
    saveArchived()
    // 若当前正打开该会话 → 回首页（归档会话不再展示）
    if (state.currentHash === hash) navigate('#/')
    renderRecent()
    toast('会话已归档')
  }

  // ---------- 关闭会话（2026-09-04 三点浮窗新增：语义 = CLI 两次 Ctrl+C）----------
  // 第一击 interrupt（网关按 sessionId 精确路由 → CLI onCancel：回合进行中即打断，空闲为 no-op）；
  // 第二击 POST /gateway/wsession/stop（网关统一优雅停 2026-09-08：shutdown → CLI exit 0 →
  // WT 自动收 tab，3s 树杀兜底；web spawn/终端直开两会话形态同协议）。转录保留磁盘，
  // 侧栏 tab 不消失，仅状态点熄灭。
  async function closeSession(hash) {
    const s = ALL.find((x) => hashOf(x) === hash)
    if (!s) return toast('未找到该会话')
    if (!s.state) return toast('会话未在运行，无需关闭')
    // 第一击 Ctrl+C：先打断当前回合（若空闲，CLI 侧判活未命中本就是 no-op）
    if (gws && gws.readyState === 1) gws.send(JSON.stringify({ type: 'interrupt', sessionId: hash }))
    // 第二击 Ctrl+C：关停会话进程（网关对 web/终端会话统一处理）
    try {
      const res = await fetch(apiUrl('/gateway/wsession/stop'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: hash }),
      })
      const body = await res.json()
      if (!res.ok || !body.ok) {
        toast('会话进程未找到，可能已自行退出')
        return
      }
      s.state = null
      renderRecent()
      // 2026-09-06 收口二轮：关的是当前打开会话 → 立即权威重渲（force 跳过 sig 判同），
      // closeSeg 按 state=null 收口「正在处理/正在思考」，不再等下次刷新。
      if (hash === state.currentHash) refreshSession(true)
      toast('会话已关闭')
    } catch (e) {
      toast('关闭失败：' + (e.message || e))
    }
  }

  // ---------- 会话重命名（2026-08-24 DSH 侧栏 rename dialog 移植）----------
  // 弹窗 DOM 在 index.html（#rename-modal，复用 risk-modal 的 mask/dialog 样式骨架）；
  // 提交 POST /gateway/session/rename → 网关 append custom-title 记录（对已停止会话同样生效）。
  let renameTarget = null // { hash, title }
  const renameModal = $('rename-modal')
  const renameInput = $('rename-input')
  const renameErr = $('rename-error')
  function openRenameDialog(hash) {
    const s = ALL.find((x) => hashOf(x) === hash)
    if (!s) return toast('未找到该会话')
    renameTarget = { hash, title: s.title || '' }
    renameInput.value = renameTarget.title
    renameErr.hidden = true
    renameModal.hidden = false
    renameInput.focus()
    renameInput.select()
  }
  function closeRenameDialog() {
    if (!renameModal.hidden) renameModal.hidden = true
    renameTarget = null
  }
  async function confirmRename() {
    if (!renameTarget) return
    const title = renameInput.value.trim()
    if (!title) {
      renameErr.textContent = '标题不能为空'
      renameErr.hidden = false
      return
    }
    try {
      const s = ALL.find((x) => hashOf(x) === renameTarget.hash)
      const res = await fetch(apiUrl('/gateway/session/rename'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: s ? s.id : '', title }),
      })
      const body = await res.json()
      if (!res.ok || !body.ok) throw new Error(body.error || '重命名失败')
      if (s) {
        s.title = title
        renderRecent()
        toast('已重命名为「' + title + '」')
      }
      closeRenameDialog()
    } catch (e) {
      renameErr.textContent = e.message || String(e)
      renameErr.hidden = false
    }
  }
  $('rename-cancel').addEventListener('click', closeRenameDialog)
  $('rename-ok').addEventListener('click', confirmRename)
  $('rename-modal').querySelector('.close').addEventListener('click', closeRenameDialog)
  renameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmRename() }
    if (e.key === 'Escape') { e.preventDefault(); closeRenameDialog() }
  })
  // 点遮罩关闭（与 risk-modal 一致：对话框外判定）
  $('rename-modal').addEventListener('mousedown', (e) => {
    if (!renameModal.hidden && !e.target.closest('.dialog')) closeRenameDialog()
  })

  // 新建 web 会话（2026-08-24 改造：本地可见交互 CLI 窗口，替代 headless 子进程）。
  // 触发方式 = 首页空态输入第一条消息（gwSend 空态分支调用），不再有「新建独立会话」按钮。
  // 网关 spawn 本地可见交互 REPL 窗口（--session-id 预分配）→ CLI 连 /clients 注册 →
  // 网关等注册完成才返回 → 首条消息经 cliClients 精确路由注入 REPL（与本地打字同路径）。
  // 展示走 conversationDisplay 上报 + jsonl 落盘 + SSE 列表刷新（与 CLI 会话一致）。
  // 2026-08-24 防双 spawn：web 会话创建中标志（POST /gateway/wsession 等 CLI 注册最长 20s），
  // 创建期间 gwSend 空态分支再次发送直接忽略，杜绝「每发一条新建一个会话」。
  let webCreating = false
  // 首条消息事务（2026-09-06 根治三态）：值=进行中事务的会话 hash，''=无事务。语义唯一——
  // 「该会话首条乐观 DOM（气泡+proc 折叠）是权威」：renderSession/refreshSession 空 fetch 不洗盘、
  // queue-dock 不渲染（注入中消息不降级「排队中」形态）、真实数据落盘即收口销毁（渲染权威接管）。
  // 旧 pendingFirstSend（pre/hash 双字段+三处守卫+DOM 在场补挂）状态发散已整删：三态=状态源过多
  // +同步 navigate 时序（hash 回填前移 newWebSession 内）+DOM 被当状态存储三者叠加，详见各守卫处。
  let firstSendHash = ''
  async function newWebSession(projectLabel) {
    if (needToken()) return toast('请先完成 token 验证')
    if (webCreating) return null
    webCreating = true
    toast(projectLabel ? `正在 ${projectLabel} 打开本地 CLI 窗口…` : '正在全局根打开本地 CLI 窗口…')
    try {
      const res = await fetch(apiUrl('/gateway/wsession'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(projectLabel ? { project: projectLabel } : {}) })
      const d = await res.json()
      if (!d.hash || !d.id) throw new Error(d.error || 'bad response')
      // 首条消息事务 hash 回填必须在 navigate 之前：navigate 同步 route → renderSession，
      // 守卫（firstSendHash === hash）此刻起生效（回填放 await 续体=跑在 renderSession 之后，
      // 三态截图第②态「加载中…洗掉乐观 DOM」的时序根因）
      if (firstSendHash === '') firstSendHash = d.hash
      // 合成列表条目：子进程刚起 jsonl 可能未落盘，先插入列表保证可导航；SSE 刷新会用真实条目替换。
      // 2026-08-24 用户定案：未指定项目（笔/首页消息发送）→ 会话落全局根（@WrokSpace 散装区，
      // projectScope:'global'）；指定项目 → 该项目组（projectScope:'project'）。不再落启动服务器的项目根。
      const isGlobal = !projectLabel
      ALL.unshift({ id: d.id, file: d.hash + '.jsonl', title: '新会话', state: 'busy', updatedAt: Date.now(), projectScope: isGlobal ? 'global' : 'project', projectLabel: projectLabel || '', messageCount: 0 })
      renderRecent()
      navigate('#/' + encodeURIComponent(d.hash))
      if (isMobile()) setPanel(false)
      return d
    } catch (e) {
      toast('创建独立会话失败: ' + (e.message || e))
      return null
    } finally {
      webCreating = false
    }
  }

  function renderRecent() {
    // 菜单挂行内（2026-09-07 内嵌展开定案）：整列 innerHTML='' 会连菜单销毁 → 先摘到 body 暂存，
    // 重建后按新行重挂；行已不在则 closeRowMenu 一并关。
    if (rowMenu) document.body.appendChild(rowMenu)
    // 重建前快照浮起行（hash + 终态视口矩形）：elementFromPoint 只认拍回后的列表行，
    // 鼠标悬在浮起拉宽区（超出行列表宽）/上移 2px 顶边缝时落空 → 鼠标未动 tab 无故下沉
    // （2026-09-06 用户实测根因），末尾 mouseXY 分支按矩形兜底重扶。
    const prevLift = liftEl && liftEl.dataset.hash
      ? { hash: liftEl.dataset.hash, rect: liftEl.getBoundingClientRect() }
      : null
    liftClear(true) // SSE/导航重建列表：浮起中的 tab 随旧节点消亡，强制还原防孤儿浮卡（行菜单开着则末尾按 hash 重扶）
    // 记录刷新前的会话条目 key（会话哈希 / 项目文件夹名），仅给「新增条目」播放入场动画，
    // 已有条目静默保留，避免每次 SSE 刷新整列重播淡入
    const prevKeys = new Set()
    bodyEl.querySelectorAll('.sess-item, .folder').forEach((el) => {
      const k = el.dataset.hash || el.dataset.f
      if (k) prevKeys.add(k)
    })
    // 保留展开的项目文件夹 + 侧栏滚动位置（2026-08-16：主区导航进管理视图/预览走 route→renderRecent，
    // 重建列表时不重置侧栏状态，避免展开文件夹收起、滚动跳顶）
    const openF = [...bodyEl.querySelectorAll('.folder.open')].map((f) => f.dataset.f)
    const prevTop = bodyEl.scrollTop
    bodyEl.innerHTML = ''
    modeTabsEl.classList.toggle('hidden', state.mode !== 'project')
    recentLabel.textContent = state.mode === 'list' ? '最近' : '最近对话'
    if (state.mode === 'list') renderList()
    else renderProject()
    bodyEl.querySelectorAll('.sess-item, .folder').forEach((el) => {
      const k = el.dataset.hash || el.dataset.f
      if (k && !prevKeys.has(k)) el.classList.add('item-in')
    })
    if (openF.length) {
      for (const f of bodyEl.querySelectorAll('.folder')) {
        if (openF.includes(f.dataset.f)) f.classList.add('open')
      }
    }
    if (prevTop) bodyEl.scrollTop = prevTop
    // 2026-09-05 重建后统一重扶出口：① 行菜单开着 → 按菜单 hash 重扶对应行（菜单挂浮卡下不落空）；
    // ② 行点击触发的导航（reLiftHash）→ 重扶被点行——重建后新节点 :hover 不恢复（Chrome 实测），
    // 不重扶则鼠标所在行拍回、样式丢失，直到再次移动鼠标。
    // ③ 纯 hover 重建（无菜单无点击）：refreshList 按活动流签名随时整列重建（会话处理中=高频），
    //    光标所在行同样拍回且 … 隐藏——用户「点 … 拍回」与点击竞速的根源；按最近光标落点重扶。
    //    恢复路径一律 anim:false 直接终态（高频重建下重播拉伸动画=脉冲）。
    if (rowMenu) {
      const el = [...bodyEl.querySelectorAll('.sess-item')].find((x) => x.dataset.hash === rowMenu.dataset.hash)
      if (el) {
        liftStart(el, { anim: false })
        el.appendChild(rowMenu) // 菜单重挂到新行内（内嵌高度态随节点保留，无需重定位/不重播展开动画）
      } else closeRowMenu() // 行已不在（归档/删除/换视图）→ 菜单一并关
    } else if (reLiftHash) {
      const el = [...bodyEl.querySelectorAll('.sess-item')].find((x) => x.dataset.hash === reLiftHash)
      reLiftHash = null
      if (el) liftStart(el, { anim: false })
    } else if (mouseXY && Date.now() >= liftCool) {
      // ③④纯 hover 重扶同受滚动静默期约束（2026-09-09「侧栏滚轮失效」根修）：不变量
      // 「扶起只发生在列表静止态」——滚动中 refreshList 高频整列重建（活跃回合 2-3 次/秒）
      // 若按旧光标落点直调 liftStart，滚轮每一步都被拍回/重扶互搏；liftCool 门与
      // mouseenter 路径（上方监听）对齐。①②点击语义不在其列（点击即用户主动，保持直调）。
      const hit = document.elementFromPoint(mouseXY[0], mouseXY[1])?.closest('.sess-item')
      if (hit && hit.dataset.hash) liftStart(hit, { anim: false })
      else if (prevLift &&
        mouseXY[0] >= prevLift.rect.left && mouseXY[0] <= prevLift.rect.right &&
        mouseXY[1] >= prevLift.rect.top && mouseXY[1] <= prevLift.rect.bottom) {
        // elementFromPoint 落空但鼠标仍在重建前浮起矩形内（拉宽区/顶边缝）→ 按 hash 重扶同会话行；
        // 行已不存在（归档/删除/换视图）→ find 不到自然下沉。折叠 folder 内行 height=0，liftStart 自拒。
        const el = [...bodyEl.querySelectorAll('.sess-item')].find((x) => x.dataset.hash === prevLift.hash)
        if (el) liftStart(el, { anim: false })
      }
    }
    renderBubble()
    renderSearch()
  }

  // 管理视图（插件/技能预览，Codex 风格）：渲染到主聊天区（侧栏会话列表保持不变）。
  // 插件与技能预览都从「插件」入口进入，顶部插件/技能切换；数据源 = 网关 /gateway/plugins 实时扫描。
  // 重渲保留滚动位置（切换 kind/cat 时内容高度变化，避免 scrollTop 被重置成可见跳动）。
// —— 跨模块写入口（切割脚本生成）——
export function setFirstSendHash(v) { firstSendHash = v }

export {
  ARCHIVED_KEY,
  IS_TOUCH_DEVICE,
  archiveSession,
  archivedSet,
  bindSessClicks,
  bindSessLift,
  closeRenameDialog,
  closeRowMenu,
  closeSession,
  confirmRename,
  firstSendHash,
  isArchived,
  itemHtml,
  liftBound,
  liftClear,
  liftCool,
  liftEl,
  liftSpacer,
  liftStart,
  loadArchived,
  mouseXY,
  newWebSession,
  openRenameDialog,
  projIdOf,
  reLiftHash,
  renameErr,
  renameInput,
  renameModal,
  renameTarget,
  renderRecent,
  rowMenu,
  saveArchived,
  setPanel,
  toggleRowMenu,
  webCreating,
}
