// 键盘弹出适配（移动端）——唯一真源 visualViewport（本文件是手改处，web/app.js 为生成物）
import { stageSync } from '../chat/stage.js'

  // ---------- 键盘弹出适配（2026-09-19）----------
  // 不变量：应用锚定「可视视口顶」，键盘只压缩「消息流底界 + 底栏」两处——侧栏与空态 Floria
  // 背景（#empty-hint 绝对铺满 #chat-area，本身不参与位移）零移动，标题栏/URL 栏也不参与。
  // 几何：L = html clientHeight（=100dvh，移动端键盘不改变布局视口，只压可视视口）→
  // 键盘高 kb = L − vv.height；该值就是「底栏从版底抬到键盘上沿」所需的位移（应用局部坐标系
  // 与可视视口顶对齐，故抬 kb 即贴键盘上沿，见 styles.css 键盘节）。
  // pan = vv.offsetTop：浏览器为露出焦点元素会把可视视口整体上顶（本页 body overflow:hidden、
  // 内容不溢出 ⇒ 文档无可滚余量，位移只可能来自可视视口上顶，不会来自文档滚动）——不反向抵消
  // 则整界面（含侧栏/背景）被顶起，即用户上报现象；--vv-pan 交 #app 以 top 锚回。
  // 相位（2026-09-19 二轮，用户「侧栏还是会被顶起一瞬间后回弹」）：上顶是帧级动作，补偿必须与
  // 事件同帧落地——经 requestAnimationFrame 转手必然晚一帧，那一帧就是可见的「顶起」。故
  // --kb / --vv-pan / kb-open 类 / 文档滚动归零全部在事件回调里**同步**写（只写样式属性，
  // 不读取布局、不触发布局）；仅「空态底栏抬升量实测 + stageSync 占位重算」走 rAF 合帧
  // （连续量、晚一帧不可见；且逐事件量算 getBoundingClientRect 会强制布局，拖累上顶过程）。
  // 空态底栏钉在 .g-stage 台面 76.75%（不贴版底），只需抬「露出键盘」的量（--kb-lift，实测）。
  // 纯几何（探针直测本函数，勿复制公式）：L/vvH/vvTop/scale/editing → 键盘高与上顶量。
  function kbGeometry(L, vvH, vvTop, scale, editing) {
    // 捏合缩放不是键盘：scale≠1 时 vv 同样变矮，必须排除（否则缩放会误当键盘抬底栏）
    if (!editing || scale > 1.01) return { kb: 0, pan: 0 }
    return { kb: Math.max(0, L - vvH), pan: Math.max(0, vvTop) }
  }

  // 编辑中判定：只有文本输入在场才会弹键盘（非文本聚焦不应触发任何位移）
  function isEditing() {
    const el = document.activeElement
    return !!el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
  }

  let lastKb = 0      // 同步段算得的键盘高，供延迟段量算复用（避免回读 CSS 变量）
  let settleRaf = 0

  // 同步段：与视觉变化同帧的几何（事件回调内直调，接合视觉视口上顶/键盘起落）
  function syncKeyboard() {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    const { kb, pan } = kbGeometry(root.clientHeight, vv.height, vv.offsetTop, vv.scale, isEditing())
    lastKb = kb
    root.style.setProperty('--kb', kb + 'px')
    root.style.setProperty('--vv-pan', pan + 'px')
    document.body.classList.toggle('kb-open', kb > 0)
    if (window.scrollY) window.scrollTo(0, 0) // 键盘引起的文档滚动与上顶同理，须同帧归零
    scheduleSettle()
  }

  // 延迟段（rAF 合帧）：空态底栏抬升量实测 + 消息流占位/跟随按新几何重算
  function settle() {
    if (settleRaf) { cancelAnimationFrame(settleRaf); settleRaf = 0 } // 直接调用时撤销在途帧，保幂等
    const vv = window.visualViewport
    if (!vv) return
    const wrap = document.getElementById('input-wrap')
    const stageEl = wrap && wrap.parentElement && wrap.parentElement.classList.contains('g-stage') ? wrap.parentElement : null
    // offsetTop/offsetHeight 是布局位（不受 transform 与过渡影响，无中间态读数），台面几何零常数
    // 依赖——自然底 = stage 顶 + 底栏 offsetTop + 半高；抬到键盘上沿上方 22px（与会话态 docked 同口径）。
    let lift = 0
    if (lastKb > 0 && stageEl) {
      const naturalBottom = stageEl.getBoundingClientRect().top + wrap.offsetTop + wrap.offsetHeight / 2
      lift = Math.max(0, Math.round(naturalBottom + 22 - vv.height))
    }
    document.documentElement.style.setProperty('--kb-lift', lift + 'px')
    stageSync() // 可视区变矮 → 两层消息流占位/跟随按新几何重算（与 window resize 同口径）
  }

  function scheduleSettle() { if (!settleRaf) settleRaf = requestAnimationFrame(settle) }

  // 启动注册（app.js 启动序列调用）；无 visualViewport（旧浏览器）时零行为
  function initViewport() {
    const vv = window.visualViewport
    if (!vv) return
    vv.addEventListener('resize', syncKeyboard)
    vv.addEventListener('scroll', syncKeyboard) // 缩放/上顶改变 offsetTop，同样要同帧重算
    window.addEventListener('orientationchange', syncKeyboard)
    syncKeyboard()
    settle() // 启动首帧也立即对齐（启动无在途动画，不必等下一帧）
  }
export { initViewport, kbGeometry }
