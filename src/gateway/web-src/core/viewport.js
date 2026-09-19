// 键盘弹出适配（移动端）——唯一真源 visualViewport（本文件是手改处，web/app.js 为生成物）
import { stageSync } from '../chat/stage.js'

  // ---------- 键盘弹出适配（2026-09-19）----------
  // 不变量（五轮定案，用户「整个界面连侧栏一起上下」，要「整页平移」）：应用是一块**刚性板**，
  // 键盘弹出时整体上移一个键盘高 —— 侧栏/背景/底栏连成一体走，内部零重排，只有消息流窗口收窄。
  // 几何：L = html clientHeight（=100dvh，移动端键盘不改布局视口，只压可视视口）；浏览器为露出
  // 焦点元素会把可视视口整体上顶 pan = vv.offsetTop（等价地滚文档，对我们两种形态都成立）。
  // 屏幕上的完整键盘高 total = L − vv.height（= kb + pan，**与浏览器怎么分配这份位移无关**）：
  // 我们只写自己那份 kb = max(0, L − pan − vv.height)，剩下的 pan 由浏览器自己施加 ⇒ 两者之和
  // 恒为 total，pan 再怎么变（含瞬时的「上顶→回落」）画面总位移都不变 ⇒ 不抖。**不抵消 pan**
  // （四轮教训：用主线程写样式去抵消合成器线程的位移天生晚一帧，一帧错位就是「先向上→立即下拉
  // →恢复」的往复；五轮再证：把该补的量补足，浏览器那半份就自然被吸收，无需迎战）。
  // 可视窗：app 顶部被推出屏外的条带高 = total，故 app 内的可视窗 = [total, L]（--kb-total）——
  // 消息流窗口（#chat-scroll margin-top）与三个覆盖层（top）同取此值；底栏恒在 app 底边（22px 口径），
  // 空态底栏随 .g-stage 台面比例走（76.75%）——都不再各自补位移。
  // 相位（二轮）：--kb / --kb-total / kb-open 类全部在事件回调里**同步**写（只写样式属性，不读取
  // 布局、不触发布局）；仅「弹层余量实测 + stageSync 占位重算」走 rAF 合帧（连续量、晚一帧不可见；
  // 且逐事件量算 getBoundingClientRect 会强制布局，拖累上顶过程）。
  // 底栏子件（三轮，用户「底栏的子部件也要适配」）：底栏上所有向上弹出的子件（@提及 / 命令菜单 /
  // 任务浮窗 / 项目·模型·上下文弹层）都贴在栏体上沿外展开，旧写法上限是 vh 或定值——vh 是布局
  // 视口，键盘在场不缩，键盘越高弹层上半截越落在可视区外（够不着）。统一出口 = settle 实测写
  // --bar-room（纯几何 popRoom），子件一律 max-height: min(<设计上限>, var(--bar-room, <设计上限>))：
  // 键盘起落、底栏多行长高、空态↔会话态迁移全由这一条量算吸收，弹层不再各自复刻视口公式。
  // 以**底栏上沿**量 = 对所有子件都是安全上界（栏内 chip 系锚点更低、实际可用更多；取本值只会
  // 让内容多滚一点，绝不越出可视区）。
  // 纯几何（探针直测本函数，勿复制公式）：L/vvH/vvTop/scale/editing → { kb 我们补的位移,
  // total 屏幕上完整键盘高 = app 顶部被推出屏外的条带高 = 可视窗顶在 app 内的偏移 }。
  function kbGeometry(L, vvH, vvTop, scale, editing) {
    // 捏合缩放不是键盘：scale≠1 时 vv 同样变矮，必须排除（否则缩放会误当键盘抬底栏）
    if (!editing || scale > 1.01) return { kb: 0, total: 0 }
    const pan = Math.max(0, vvTop) // 上顶量非负（本页无滚动不产生负值；夹取守住「kb 只由真实空缺得出」）
    const kb = Math.max(0, L - pan - vvH)
    return { kb, total: kb + pan }
  }

  // 弹层可用高度（纯几何，探针直测本函数，勿复制公式）：底栏上沿到屏顶的距离 − 呼吸常量。
  // barTop = 底栏上沿在 **app 内** 的布局 y（由两个 rect 相减得来：app 自身的位移在差里自动抵消，
  // 于是「位移落在上顶还是文档滚动」这个口径问题被消灭，量到的是纯布局量），lift = 应用整体视觉
  // 上移量（= total）。margin 含弹层底距锚点的 gap(4~10px) 与顶部呼吸余量。
  function popRoom(barTop, lift, margin) {
    return Math.max(0, Math.round(barTop - lift - margin))
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

  let lastTotal = 0   // 同步段算得的「屏幕上的完整键盘高」，供延迟段量算复用（避免回读 CSS 变量）
  let settleRaf = 0

  // 同步段：与视觉变化同帧的几何（事件回调内直调，接合视觉视口上顶/键盘起落）
  function syncKeyboard() {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    const { kb, total } = kbGeometry(root.clientHeight, vv.height, vv.offsetTop, vv.scale, isEditing())
    lastTotal = total
    root.style.setProperty('--kb', kb + 'px')
    root.style.setProperty('--kb-total', total + 'px')
    document.body.classList.toggle('kb-open', kb > 0) // 同时是「#app 位移」规则的开关（见 styles.css 键盘节）
    scheduleSettle()
  }

  // 延迟段（rAF 合帧）：弹层余量实测 + 消息流占位/跟随按新几何重算
  function settle() {
    if (settleRaf) { cancelAnimationFrame(settleRaf); settleRaf = 0 } // 直接调用时撤销在途帧，保幂等
    const vv = window.visualViewport
    if (!vv) return
    const wrap = document.getElementById('input-wrap')
    const app = document.getElementById('app')
    // 底栏上方可视余量（底栏子件的弹层收口唯一出口）：两个 rect 相减 = 底栏上沿在 app 内的布局 y，
    // app 的位移（我们写的 --kb 与浏览器施加的上顶/滚动）在差里全部抵消 ⇒ 量到的与位移口径无关；
    // 再减掉整体上移量 --kb-total，才是「离用户看到的顶边多远」。
    if (wrap && app) {
      const barTop = wrap.getBoundingClientRect().top - app.getBoundingClientRect().top
      const barRoom = popRoom(barTop, lastTotal, BAR_ROOM_MARGIN)
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
    // 底栏自身「尺寸」类变化（多行长高 / 接管卡换高 / 窗口缩放的回流）同样要重量：--bar-room 取自
    // 底栏在 app 内的位置，只挂 vv 事件会漏掉这些帧。写入的只是上限变量，不回改底栏盒模型
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
