// 键盘弹出适配（移动端）——唯一真源 visualViewport（本文件是手改处，web/app.js 为生成物）
import { stageSync } from '../chat/stage.js'

  // ---------- 键盘弹出适配（2026-09-19）----------
  // 不变量：底栏恒贴在**可视区底界**之上，消息流底界恒不落到键盘之下；应用其余部分随浏览器的
  // 可视视口上顶一起走。
  // 几何：L = html clientHeight（=100dvh，移动端键盘不改变布局视口，只压可视视口）；浏览器为
  // 露出焦点元素会把可视视口整体上顶 pan = vv.offsetTop（本页 body overflow:hidden、内容不
  // 溢出 ⇒ 文档无可滚余量，位移只可能来自可视视口上顶，不会来自文档滚动）。
  // 关键：**不抵消 pan**（2026-09-19 四轮，用户「侧栏还是会跳动，先向上然后立即下拉最后恢复…
  // 要不还是撤回对侧栏和背景的限制，直接整个顶起」）。pan 是合成器线程上的瞬时位移，用主线程写
  // 样式去抵消**天生晚一帧**：一帧错位就是「先向上（浏览器上顶）→立即下拉（补偿落地）→恢复
  // （pan 回落）」的往复，JS 赢不了这场竞速、也不必赢。改为全盘接受浏览器位移，只把「浏览器没
  // 顶掉的那部分」算作 kb：**kb = L − pan − vv.height**（pan=0 时与旧式 L − vv.height 完全等价；
  // pan>0 时应用整体顶起，而底栏与消息流底界仍精确贴在可视区上）。同一式子在两种上顶形态下都
  // 自洽 ⇒ 本模块只有一个位移变量，无分支，--vv-pan 退役。
  // 相位（2026-09-19 二轮）：--kb / kb-open 类 / 文档滚动归零全部在事件回调里**同步**写（只写
  // 样式属性，不读取布局、不触发布局）；仅「空态底栏抬升量实测 + stageSync 占位重算」走 rAF
  // 合帧（连续量、晚一帧不可见；且逐事件量算 getBoundingClientRect 会强制布局，拖累上顶过程）。
  // 空态底栏钉在 .g-stage 台面 76.75%（不贴版底），只需抬「露出键盘」的量（--kb-lift，实测）。
  // 底栏子件（2026-09-19 三轮，用户「底栏的子部件也要适配」）：底栏上所有向上弹出的子件
  // （@提及 / 命令菜单 / 任务浮窗 / 项目·模型·上下文弹层）都贴在栏体上沿外展开，旧写法的高度
  // 上限是 vh 或定值——vh 是布局视口，键盘在场不缩，键盘越高弹层上半截越落在可视区外（够不着）。
  // 统一出口 = settle 实测「底栏上沿到可视视口顶」的余量写 --bar-room（纯几何 popRoom），子件
  // 一律 max-height: min(<设计上限>, var(--bar-room, <设计上限>))：键盘起落、底栏多行长高、空态↔
  // 会话态迁移全由这一条量算吸收，弹层不再各自复刻视口公式。以**底栏上沿**量 = 对所有子件都是
  // 安全上界（栏内 chip 系锚点更低、实际可用更多；取本值只会让内容多滚一点，绝不越出可视区）。
  // 纯几何（探针直测本函数，勿复制公式）：L/vvH/vvTop/scale/editing → 仍需自行抬升的键盘高
  // （浏览器上顶 pan 已吃掉的位移不计入，见文件头「不抵消 pan」）。
  function kbGeometry(L, vvH, vvTop, scale, editing) {
    // 捏合缩放不是键盘：scale≠1 时 vv 同样变矮，必须排除（否则缩放会误当键盘抬底栏）
    if (!editing || scale > 1.01) return { kb: 0 }
    const pan = Math.max(0, vvTop) // 上顶量非负（本页无滚动不产生负值；夹取守住「kb 只由真实空缺得出」）
    return { kb: Math.max(0, L - pan - vvH) }
  }

  // 弹层可用高度（纯几何，探针直测本函数，勿复制公式）：底栏上沿在可视视口内的 y − 呼吸常量。
  // barTop 是 client 坐标（应用不再有补偿位移 ⇒ 即布局坐标），vvTop = 可视视口上顶（同 client
  // 坐标口径），相减才是「离用户看到的顶边多远」；margin 含弹层底距锚点的 gap(4~10px) 与顶部呼吸余量。
  function popRoom(barTop, vvTop, margin) {
    return Math.max(0, Math.round(barTop - vvTop - margin))
  }

  // 编辑中判定：只有文本输入在场才会弹键盘（非文本聚焦不应触发任何位移）。
  // （2026-09-19）补「焦点在子框架内」：项目预览的站点页面跑在 .preview-frame 里，焦点进入 iframe
  // 文档时父文档 activeElement 就是那个 <iframe> 元素本身（浏览器标准行为，实测 parent activeElement
  // === 'IFRAME'）。旧判定只认 INPUT/TEXTAREA → 预览 iframe 内打字恒 editing=false → kbGeometry 直接
  // 返回 {0,0}：键盘上顶无人锚回、#chat-scroll 也不为键盘让位，整个界面随每次输入被顶起再弹回。
  // iframe 在场即算编辑中——位移量仍由可视视口实测得出，无键盘时 kb/pan 天然为 0，放宽判定不引入空位移。
  function isEditing() {
    const el = document.activeElement
    if (!el) return false
    if (el.tagName === 'IFRAME') return true
    return !!(el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')
  }

  // 弹层顶部呼吸余量：一并吃下「弹层底距锚点 4~10px 的 gap」+ 与可视区顶的留白（常量在量算侧，
  // 故 --bar-room 已直接是「弹层可安全占用的高度」，消费点不必各自再减间距）
  const BAR_ROOM_MARGIN = 20

  let lastKb = 0      // 同步段算得的键盘高，供延迟段量算复用（避免回读 CSS 变量）
  let settleRaf = 0

  // 同步段：与视觉变化同帧的几何（事件回调内直调，接合视觉视口上顶/键盘起落）
  function syncKeyboard() {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    const { kb } = kbGeometry(root.clientHeight, vv.height, vv.offsetTop, vv.scale, isEditing())
    lastKb = kb
    root.style.setProperty('--kb', kb + 'px')
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
    // 依赖——自然底 = stage 顶 + 底栏 offsetTop + 半高；抬到可视区底界上方 22px（与会话态 docked 同口径）。
    let lift = 0
    if (lastKb > 0 && stageEl) {
      const naturalBottom = stageEl.getBoundingClientRect().top + wrap.offsetTop + wrap.offsetHeight / 2
      // 可视区底界同为 client 坐标口径 = 上顶量 + 可视高（两者不再混用，pan>0 时也正确）
      lift = Math.max(0, Math.round(naturalBottom + 22 - (vv.offsetTop + vv.height)))
    }
    document.documentElement.style.setProperty('--kb-lift', lift + 'px')
    // 底栏上方可视余量（底栏子件的弹层收口唯一出口）：rect.top 含 --kb-lift 的位移与空态台面
    // 定位，与 vv.offsetTop 同为 client 坐标口径 → 两者的差就是「离可视区顶多远」。
    if (wrap) {
      const barRoom = popRoom(wrap.getBoundingClientRect().top, vv.offsetTop, BAR_ROOM_MARGIN)
      document.documentElement.style.setProperty('--bar-room', barRoom + 'px')
    }
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
    // 底栏自身「尺寸」类变化（多行长高 / 接管卡换高 / 窗口缩放的回流）同样要重量：--bar-room 与
    // --kb-lift 都取自底栏位置，只挂 vv 事件会漏掉这些帧。写入的是位移与上限变量，不回改底栏盒模型
    // → 观察者自触发一次即收敛（幂等，非回环）。
    const wrap = document.getElementById('input-wrap')
    if (wrap) {
      new ResizeObserver(scheduleSettle).observe(wrap)
      // 「位移」类变化 ResizeObserver 看不到（观察者只报尺寸）：键盘收起 --kb 归零、空态↔会话态迁移
      // 都让 #input-wrap 的 top/transform 走 0.55s 过渡，而 settle 在事件后一帧读 rect，拿到的是动画
      // 中间值 —— 此时量出的 --bar-room 是「收起前」的小值，且其后不再有任何事件重量 ⇒ 值被钉死，
      // 底栏子件弹层上限 min(设计上限, --bar-room) 随之永久卡小、内容被 overflow 截断。
      // 守护不变量 = --bar-room 恒对应底栏**到位**后的位置；过渡结束即到位，故此刻重量一次。
      // 只听 end：中断（transitioncancel）只会由新的 --kb/几何改动引起，那条路已各自排了 settle。
      wrap.addEventListener('transitionend', (e) => { if (e.target === wrap) scheduleSettle() })
    }
    syncKeyboard()
    settle() // 启动首帧也立即对齐（启动无在途动画，不必等下一帧）
  }
export { initViewport, kbGeometry, popRoom }
