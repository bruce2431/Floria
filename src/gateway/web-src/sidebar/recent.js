// 侧栏 recent + 行操作（扶起/内嵌菜单/归档/关闭/重命名）（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { route, navigate, renderSession } from '../chat/route.js'
import { deviceHint } from '../engine/auth.js'
import { gws, needToken, apiUrl } from '../engine/gateway.js'
import { I } from '../core/icons.js'
import { refreshList, refreshSession } from '../engine/live.js'
import { hashOf } from '../engine/sessions.js'
import { bodyEl, sidebar, bubblePop, recentLabel, modeTabsEl, state, ALL } from '../engine/state.js'
import { esc, toast, isMobile } from '../core/util.js'
import { applyPanelOpen } from '../engine/panel.js'
import { gwSend } from '../inputbar/send.js'
import { renderBubble, renderSearch } from './bubble-search.js'
import { renderList, renderProject } from './mgr.js'
/* @module sidebar/recent.js */
  // ---------- 侧栏 ----------
  // 开合唯一入口。opt.pin 只在打开时有意义：钉住 = 鼠标移出侧栏不自动收（汉堡/抽屉把手点击），
  // 不钉 = 预览式（左缘悬停唤出）。收起一律清钉住态，避免上一轮的钉住 residual 影响下次悬停。
  // 钉住态挂 state.panelPinned（跨模块真源，「侧边栏」开关读它——悬停唤出不算打开），每次落地后
  // 同步视图浮层的行状态：pin 可由 menu-btn/panel-collapse/scrim/浮层开关任一处翻转，收口在这里。
  function setPanel(open, opt) {
    applyPanelOpen(open, !!(opt && opt.pin)) // 状态落地唯一核（engine/panel.js）：钉住态 + 可见态 + #sidebar.open + 调宽复位
    // 展开/折叠侧栏时关闭相关弹层
    bubblePop.classList.remove('show')
    $('organize-pop').classList.remove('show')
    if (!open) closeRowMenu() // 不变量：侧栏收起 ⇒ 挂在它里面的行浮窗一并收（宿主见 openRowMenu）
    syncPaneRows() // work 视图浮层的「侧边栏」行随钉住态刷新（悬停唤出不改 pin ⇒ 行状态不动）
  }
  // 悬停预览的收口：鼠标离开侧栏且未钉住 → 收起。钉住态（汉堡打开）鼠标怎么走都不收；
  // 侧栏折叠时宽度 0，本事件不会触发。行浮窗挂在 #sidebar 内（见 openRowMenu），指针移到浮窗上
  // 不算离开侧栏，故悬停预览下浮窗可用。
  sidebar.addEventListener('mouseleave', () => { if (!state.panelPinned) setPanel(false) })

  // ---------- 侧栏拖拽调宽（2026-09-12）：仅桌面展开态生效（#panel-resizer 由 CSS 按
  // #sidebar.open + ≥721px 门控显示，pointerdown 再复核 .open 双保险）。拖动改 :root 内联
  // --panel-w——#sidebar 与 .panel-inner 的宽消费同一变量，主区靠 flex 跟随；不持久化，
  // setPanel(false) 清内联值。拖拽中 body.sb-resizing 关宽度过渡即时跟手。
  {
    const rz = $('panel-resizer')
    const clampW = (x) => Math.max(232, Math.min(560, window.innerWidth - 120, x))
    rz.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || !sidebar.classList.contains('open')) return
      rz.setPointerCapture(e.pointerId)
      rz.classList.add('dragging')
      document.body.classList.add('sb-resizing')
      e.preventDefault()
    })
    rz.addEventListener('pointermove', (e) => {
      if (!rz.classList.contains('dragging')) return
      document.documentElement.style.setProperty('--panel-w', `${Math.round(clampW(e.clientX))}px`)
    })
    const release = () => {
      if (!rz.classList.contains('dragging')) return
      rz.classList.remove('dragging')
      document.body.classList.remove('sb-resizing')
    }
    rz.addEventListener('pointerup', release)
    rz.addEventListener('pointercancel', release)
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
    // 2026-09-26 行操作入口 = 右键（桌面）/ 长按（触屏）唤出浮窗，三点按钮已删除（见 openRowMenu）
    return `<button class="sess-item${on ? ' on' : ''}" data-hash="${esc(hashOf(s))}" title="${esc(s.file)}">
      <span class="dot${dotCls}"></span><span class="title">${esc(s.title)}</span>${projTag}</button>`
  }

  // ---------- 真触屏判定（2026-09-05）：iPadOS Safari 桌面模式报 hover:hover+pointer:fine（与 macOS
  // 全同），CSS @media 骗不过 → 「hover 才显」规则（folder-add 等）在 iPad 上生效，
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
    // 操作浮窗开着：滚动/窗口变化这类非 force 还原先冻结（浮窗 fixed 于 body，与行的在流态互不依赖，
    // 只是不该由背景事件把用户正在操作的行拍下去）；浮窗收口时由 closeRowMenu 统一还原。
    if (!force && rowMenuPop) return
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
    // hover 扶起仅桌面指针设备绑定（bindSessLift）；触屏长按扶起由 openRowMenu 直调，不经 hover 路径
    if (liftEl === el) return // 幂等：已浮起（重扶/mouseenter 不重播扶起动画）
    // 切换浮起目标必须无条件清旧（长按换行 / hover 换行）：否则旧浮起行的 fixed 态+占位 spacer 成孤儿
    liftClear(true)
    const r = el.getBoundingClientRect()
    if (!r.height) return
    liftEl = el
    liftSpacer = document.createElement('div')
    liftSpacer.style.height = r.height + 'px'
    el.parentNode.insertBefore(liftSpacer, el)
    el.style.position = 'fixed'; el.style.left = r.left + 'px'; el.style.top = r.top + 'px'
    el.style.zIndex = '60'; el.style.width = r.width + 'px'
    // 目标宽 = 完整标题实测宽，上限 = 视口剩余空间。测量须在 .lift 已挂（无过渡、同一任务内无绘制，
    // 先挂后摘视觉零影响）的状态下做，测得的即浮起终态宽度。
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
      // non-passive 保证监听先于默认滚动动作执行。浮窗开着=一并关闭（滚轮=菜单外交互）。
      // liftCool 与 scroll 门同参续期：滚轮持续=非静止态，防边界拍回/重扶循环。
      bodyEl.addEventListener('wheel', () => {
        liftCool = Date.now() + 150
        if (rowMenuPop) closeRowMenu()
        if (liftEl) { liftClear(true); void bodyEl.offsetHeight }
      }, { passive: false })
    }
  }
  function bindSessLift(root) {
    // hover 扶起仅桌面指针设备绑定；触屏不启用（iPad 桌面模式 matchMedia 伪装 hover:hover
    // 骗过媒体查询，IS_TOUCH_DEVICE 才是真触屏）——触屏长按扶起走 openRowMenu 直调，不经此处
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
    bindSessLift(root)
  }

  // ---------- 行操作浮窗（2026-09-26：三点按钮删除，改右键 / 长按唤出；2026-09-27 泛化为注册式）----------
  // 两个入口：桌面右键（contextmenu）、触屏长按（pointerdown 计时 480ms）。浮窗是 document.body 下
  // 独立 fixed 卡片（脱出 #recent-body / #wk-body 这类 overflow 裁剪容器），落位在被操作行近旁
  // （长按：行左下）/ 指针处（右键），越界翻折 + clamp 回视口。长按同时扶起该行（触屏不绑 hover 扶起，
  // 故 liftStart 直调）——浮起与浮窗同生同灭：点两者之外任意空白（mousedown / pointerdown）→
  // closeRowMenu 一并还原。菜单不切换当前选中项：操作对象由行的 dataset 显式携带。
  //
  // 泛化（2026-09-27）：本模块只负责「唤出手势 + 浮窗 DOM + 浮起联动」，不认具体是哪种行。
  // 谁拥有行谁注册：registerRowMenu({ sel, key, items, pick })，items(el) 返回菜单项
  // [{a,icon,label,danger?}]（空数组 = 该行无菜单，右键保留浏览器默认），pick(a, el) 执行动作。
  const rowMenuSources = []
  function registerRowMenu(src) { rowMenuSources.push(src) }
  function rowMenuHit(target) {
    for (const src of rowMenuSources) {
      const el = target.closest(src.sel)
      if (el) return { src, el }
    }
    return null
  }
  let rowMenuPop = null
  let rowMenuTouch = false // 长按开启：浮起由本浮窗负责，关闭时必须显式拍回（触屏无 mouseleave 自然回位）
  let rowMenuGuard = 0 // 长按抬手会补发 mousedown，短时守卫防「刚弹出就被自己关掉」
  let rowMenuSrc = null // 当前浮窗的行源 + 行标识：列表重建后按此重扶（见 reliftRowMenu）
  let rowMenuKey = null
  function openRowMenu(hit, x, y, rowEl) {
    closeRowMenu()
    if (!hit) return
    const items = hit.src.items(hit.el)
    if (!items || !items.length) return
    rowMenuTouch = !!rowEl
    rowMenuGuard = Date.now() + 600
    const pop = document.createElement('div')
    pop.className = 'row-menu-pop'
    pop.innerHTML = items
      .map(
        (it) =>
          `<button type="button" class="rm-item${it.danger ? ' rm-danger' : ''}" data-a="${esc(it.a)}">` +
          `${it.icon || ''}<span>${esc(it.label)}</span></button>`,
      )
      .join('')
    // 宿主 = 行所属的 #sidebar（行属于侧栏时），否则 document.body（如 #bubble-pop 里的会话行）。
    // 挂在 #sidebar 内是本浮窗与「侧栏悬停预览」共存的前提：#sidebar 的 mouseleave 是收起侧栏的
    // 唯一入口，浮窗若是 body 子节点，指针从行移到浮窗上就等于「离开侧栏」→ 侧栏连带浮窗一起收。
    // .row-menu-pop 是 position:fixed，无 transform 祖先时仍以视口定位，故宿主变更不影响落点。
    const host = hit.el.closest('#sidebar') || document.body
    host.appendChild(pop)
    // 期望落点 = 行左下（长按）/ 指针右下（右键），越界翻折回视口内
    const r = rowEl ? rowEl.getBoundingClientRect() : null
    let lx = r ? r.left + 8 : x
    let ly = r ? r.bottom + 4 : y
    const w = pop.offsetWidth
    const h = pop.offsetHeight
    lx = Math.max(8, Math.min(lx, window.innerWidth - w - 8))
    ly = Math.max(8, Math.min(ly, window.innerHeight - h - 8))
    pop.style.left = Math.round(lx) + 'px'
    pop.style.top = Math.round(ly) + 'px'
    pop.addEventListener('click', (e) => {
      const b = e.target.closest('.rm-item')
      if (!b) return
      const src = hit.src
      closeRowMenu()
      src.pick(b.dataset.a, hit.el)
    })
    pop.addEventListener('contextmenu', (e) => e.preventDefault()) // 浮窗上右键不弹浏览器菜单
    rowMenuPop = pop
    rowMenuSrc = hit.src
    rowMenuKey = hit.src.key(hit.el)
    if (rowEl) liftStart(rowEl, { anim: false })
  }
  function closeRowMenu() {
    if (rowMenuPop) { rowMenuPop.remove(); rowMenuPop = null }
    // 浮起还原：桌面右键场景鼠标仍在该行则不拍回（几何判定而非 :hover——鼠标未动时 :hover 判定不稳）。
    if (!rowMenuTouch && liftEl && mouseXY) {
      const r = liftEl.getBoundingClientRect()
      if (mouseXY[0] >= r.left && mouseXY[0] <= r.right && mouseXY[1] >= r.top && mouseXY[1] <= r.bottom) return
    }
    liftClear(true)
  }
  // 列表重建后重扶：浮窗锚定的旧节点已被换掉（innerHTML 重渲），按 (行源, 行标识) 找新节点补浮起。
  // 由各列表的渲染出口在重渲后调用（recent.js renderRecent / work.js renderWorkBody）。
  function reliftRowMenu() {
    if (!rowMenuPop || !rowMenuTouch || !rowMenuSrc || rowMenuKey == null) return
    const el = [...document.querySelectorAll(rowMenuSrc.sel)].find((x) => rowMenuSrc.key(x) === rowMenuKey)
    if (el) liftStart(el, { anim: false })
  }
  // 桌面右键：只认已注册的行（其它区域保留浏览器默认菜单）
  document.addEventListener('contextmenu', (e) => {
    const hit = rowMenuHit(e.target)
    if (!hit || !hit.src.items(hit.el).length) return
    e.preventDefault()
    openRowMenu(hit, e.clientX, e.clientY)
  })
  // 触屏长按：480ms 未移动即触发（浮起 + 浮窗）；移动 >8px / 抬手 / 取消即作废。长按后抬手若
  // 补发 click（误导航），在 capture 阶段吞掉——它先于元素自身的 click 处理器到达。
  let lpTimer = 0
  let lpFired = false
  let lpHit = null
  let lpXY = null
  const lpCancel = () => { clearTimeout(lpTimer); lpTimer = 0; lpHit = null }
  document.addEventListener('pointerdown', (e) => {
    lpFired = false
    // 浮窗开着时，落在浮窗与行之外的按下 = 明确的关闭意图，即刻收口（触屏抬手补发的 mousedown
    // 没有配套的新 pointerdown，故不受此支路影响，只受 rowMenuGuard 约束）
    if (rowMenuPop && !rowMenuPop.contains(e.target) && !rowMenuHit(e.target)) { closeRowMenu(); return }
    if (e.pointerType !== 'touch') return
    const hit = rowMenuHit(e.target)
    if (!hit || !hit.src.items(hit.el).length) return
    lpHit = hit
    lpXY = [e.clientX, e.clientY]
    clearTimeout(lpTimer)
    lpTimer = setTimeout(() => {
      lpTimer = 0
      const h = lpHit
      if (!h) return
      lpFired = true
      // 480ms 悬停期内列表可能整列重建（refreshList 按活动流签名随时重渲，处理中 2-3 次/秒），
      // 此时捕获的节点已成孤儿：getBoundingClientRect 归零 ⇒ 落点被 clamp 到视口左上角。
      // 不变量「浮窗与浮起锚定现役节点」——按 (行源, 行标识) 重解析；行已消失（删除/换视图）则放弃。
      let el = h.el
      if (!el.isConnected) {
        const key = h.src.key(el)
        if (key == null) return
        el = [...document.querySelectorAll(h.src.sel)].find((x) => h.src.key(x) === key) || null
        if (!el) return
      }
      openRowMenu({ src: h.src, el }, 0, 0, el)
    }, 480)
  }, { passive: true })
  document.addEventListener('pointermove', (e) => {
    if (!lpTimer || !lpXY) return
    if (Math.abs(e.clientX - lpXY[0]) > 8 || Math.abs(e.clientY - lpXY[1]) > 8) lpCancel()
  }, { passive: true })
  document.addEventListener('pointerup', () => {
    lpCancel()
    // 长按抬手发生在守卫之后（长按更久）时续期：iOS 抬手会补发 mousedown，不得关掉刚弹出的浮窗
    if (rowMenuPop && rowMenuTouch) rowMenuGuard = Date.now() + 600
  }, { passive: true })
  document.addEventListener('pointercancel', lpCancel, { passive: true })
  document.addEventListener('click', (e) => {
    if (!lpFired) return
    lpFired = false
    e.stopPropagation()
    e.preventDefault()
  }, true)
  // 点空白（浮窗 / 行之外）→ 浮窗与浮起一并消失
  document.addEventListener('mousedown', (e) => {
    if (!rowMenuPop || Date.now() < rowMenuGuard) return
    if (!rowMenuPop.contains(e.target)) closeRowMenu()
  })
  // 列表滚动 / 窗口尺寸变化：浮窗 fixed 会漂离锚点，直接收（与浮起还原同一时机）
  window.addEventListener('scroll', () => { if (rowMenuPop) closeRowMenu() }, { passive: true, capture: true })
  window.addEventListener('resize', () => { if (rowMenuPop) closeRowMenu() })

  // 会话行源：操作对象 = dataset.hash；已从列表消失的会话不弹菜单（items 返回空）。
  registerRowMenu({
    sel: '.sess-item',
    key: (el) => el.dataset.hash || null,
    items: (el) =>
      ALL.find((v) => hashOf(v) === el.dataset.hash)
        ? [
            { a: 'rename', icon: I.dshEdit, label: '重命名' },
            { a: 'close', icon: I.dshStop, label: '关闭会话', danger: true },
          ]
        : [],
    pick: (a, el) => (a === 'rename' ? openSessionRename(el.dataset.hash) : closeSession(el.dataset.hash)),
  })

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

  // ---------- 重命名弹窗（2026-08-24 DSH 侧栏 rename dialog 移植；2026-09-27 泛化为通用入口）----------
  // 弹窗 DOM 在 index.html（#rename-modal，复用 risk-modal 的 mask/dialog 样式骨架）。本模块只管
  // 表单壳（标题/占位/初值/校验/错误回显），提交语义由调用方以 onSubmit 注入——会话重命名走
  // POST /gateway/session/rename（网关 append custom-title，已停止会话同样生效），文件重命名走
  // POST /gateway/file/rename（work.js 注册），两者共用同一对话框实例，不各建一套弹窗。
  let renameTarget = null // { heading, placeholder, okText, onSubmit }
  const renameModal = $('rename-modal')
  const renameInput = $('rename-input')
  const renameErr = $('rename-error')
  const renameTitle = renameModal.querySelector('.title')
  const renameOk = $('rename-ok')
  function openRenameDialog(opt) {
    renameTarget = opt
    renameTitle.textContent = opt.heading || '重命名'
    renameInput.placeholder = opt.placeholder || '输入新名称'
    renameOk.textContent = opt.okText || '重命名'
    renameInput.value = opt.value || ''
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
    const value = renameInput.value.trim()
    if (!value) {
      renameErr.textContent = '名称不能为空'
      renameErr.hidden = false
      return
    }
    try {
      await renameTarget.onSubmit(value)
      closeRenameDialog()
    } catch (e) {
      renameErr.textContent = e.message || String(e)
      renameErr.hidden = false
    }
  }
  // 会话重命名：查不到（列表已刷新掉）才报错；提交成功同步内存标题并重渲列表。
  function openSessionRename(hash) {
    const s = ALL.find((x) => hashOf(x) === hash)
    if (!s) return toast('未找到该会话')
    openRenameDialog({
      heading: '重命名会话',
      placeholder: '输入新标题',
      okText: '重命名',
      value: s.title || '',
      onSubmit: async (title) => {
        const res = await fetch(apiUrl('/gateway/session/rename'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: s.id, title }),
        })
        const body = await res.json()
        if (!res.ok || !body.ok) throw new Error(body.error || '重命名失败')
        s.title = title
        renderRecent()
        toast('已重命名为「' + title + '」')
      },
    })
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
  // 分层治理 4C（2026-10-10）：engine/live.js 的读取口（写侧仍是尾部 setFirstSendHash）——每次现读，
  // 调用方严禁缓存返回值。
  function getFirstSendHash() { return firstSendHash }
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
      ALL.unshift({ id: d.id, file: d.hash + '.jsonl', title: '新会话', state: 'busy', updatedAt: Date.now(), createdAt: Date.now(), synthetic: true, projectScope: isGlobal ? 'global' : 'project', projectLabel: projectLabel || '', messageCount: 0 })
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
    // 2026-09-05 重建后统一重扶出口：① 触屏长按菜单开着 → 按菜单 hash 重扶对应行（浮起须随新节点重建）；
    // ② 行点击触发的导航（reLiftHash）→ 重扶被点行——重建后新节点 :hover 不恢复（Chrome 实测），
    // 不重扶则鼠标所在行拍回、样式丢失，直到再次移动鼠标。
    // ③ 纯 hover 重建（无线索）：refreshList 按活动流签名随时整列重建（会话处理中=高频），
    //    光标所在行同样拍回；按最近光标落点重扶。
    //    恢复路径一律 anim:false 直接终态（高频重建下重播拉伸动画=脉冲）。
    if (rowMenuPop && rowMenuTouch) {
      // 触屏长按的浮起：整列重建会换掉行节点，浮窗（body 下）不受影响但浮起须按行标识重扶
      reliftRowMenu()
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
        // 行已不存在（删除/换视图）→ find 不到自然下沉。折叠 folder 内行 height=0，liftStart 自拒。
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
  IS_TOUCH_DEVICE,
  bindSessClicks,
  bindSessLift,
  closeRenameDialog,
  closeRowMenu,
  closeSession,
  confirmRename,
  firstSendHash,
  itemHtml,
  liftBound,
  liftClear,
  liftCool,
  liftEl,
  liftSpacer,
  liftStart,
  mouseXY,
  newWebSession,
  openRenameDialog,
  projIdOf,
  registerRowMenu,
  reLiftHash,
  reliftRowMenu,
  renameErr,
  renameInput,
  renameModal,
  renameTarget,
  renderRecent,
  rowMenuPop,
  setPanel,
  webCreating,
}
