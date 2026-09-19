// 键盘弹出适配（移动端）——唯一真源 visualViewport（本文件是手改处，web/app.js 为生成物）
import { stageSync } from '../chat/stage.js'

  // ---------- 键盘弹出适配（2026-09-19）----------
  // 不变量：应用锚定「可视视口顶」，键盘只压缩「消息流底界 + 底栏」两处——侧栏与空态 Floria
  // 背景（#empty-hint 绝对铺满 #chat-area，本身不参与位移）零移动，标题栏/URL 栏也不参与。
  // 几何：L = html clientHeight（=100dvh，移动端键盘不改变布局视口，只压可视视口）→
  // 键盘高 kb = L − vv.height；该值就是「底栏从版底抬到键盘上沿」所需的位移（应用局部坐标系
  // 与可视视口顶对齐，故抬 kb 即贴键盘上沿，见 styles.css 键盘节）。
  // pan = vv.offsetTop：浏览器为露出焦点元素会把可视视口整体上顶（页面不可滚时亦然）——
  // 不反向抵消则整界面（含侧栏/背景）被顶起，即用户上报现象；--vv-pan 交 #app 以 top 锚回。
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

  let kbRaf = 0
  function applyKeyboard() {
    kbRaf = 0
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    const { kb, pan } = kbGeometry(root.clientHeight, vv.height, vv.offsetTop, vv.scale, isEditing())
    root.style.setProperty('--kb', kb + 'px')
    root.style.setProperty('--vv-pan', pan + 'px')
    document.body.classList.toggle('kb-open', kb > 0)
    // 空态底栏抬升量：offsetTop/offsetHeight 是布局位（不受 transform 与过渡影响，无中间态
    // 读数），台面几何零常数依赖——自然底 = stage 顶 + 底栏 offsetTop + 半高；抬到键盘上沿上方
    // 22px（与会话态 docked 底边距同口径）。
    const wrap = document.getElementById('input-wrap')
    const stageEl = wrap && wrap.parentElement && wrap.parentElement.classList.contains('g-stage') ? wrap.parentElement : null
    let lift = 0
    if (kb > 0 && stageEl) {
      const naturalBottom = stageEl.getBoundingClientRect().top + wrap.offsetTop + wrap.offsetHeight / 2
      lift = Math.max(0, Math.round(naturalBottom + 22 - vv.height))
    }
    root.style.setProperty('--kb-lift', lift + 'px')
    // 应用是定高壳（body overflow:hidden），文档视口恒停在原位；键盘引起的文档滚动立即归零
    if (window.scrollY) window.scrollTo(0, 0)
    stageSync() // 可视区变矮 → 两层消息流占位/跟随按新几何重算（与 window resize 同口径）
  }

  function scheduleKeyboard() { if (!kbRaf) kbRaf = requestAnimationFrame(applyKeyboard) }

  // 启动注册（app.js 启动序列调用）；无 visualViewport（旧浏览器）时零行为
  function initViewport() {
    const vv = window.visualViewport
    if (!vv) return
    vv.addEventListener('resize', scheduleKeyboard)
    vv.addEventListener('scroll', scheduleKeyboard) // 缩放/上顶改变 offsetTop，同样要重算
    window.addEventListener('orientationchange', scheduleKeyboard)
    applyKeyboard()
  }
export { initViewport, kbGeometry }
