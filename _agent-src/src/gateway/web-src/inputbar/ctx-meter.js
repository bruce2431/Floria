// 上下文占用指示（ContextMeter）+ 全局交互杂项（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { route, lastNavHash, navigate } from '../chat/route.js'
import { stage, progScrollUntil, stageRelease, stageFollow, stageSync } from '../chat/stage.js'
import { gateSubmit } from '../core/auth.js'
import { gateAwait, gws } from '../core/gateway.js'
import { I } from '../core/icons.js'
import { inputEl, sendBtn, ctxMeterEl, ctxBtnEl, ctxPanelEl, bubblePop, overlay, state, toast, isMobile } from '../core/state.js'
import { renderSettle, btnMode } from './approval.js'
import { cmd, msel, cmdPop, modelPop, modelSeatEl, psel, projPop, projSeatEl, closeProjPop, toggleCmdPop, closeCmdPop, closeRiskModal, cmdMove, cmdSelect } from './commands.js'
import { pendingImages, renderImgPills, addImageFiles } from './images.js'
import { mention, closeMentionPop, moveMentionSel, selectMention, removeChip, mentionBeforeCaret } from './mention.js'
import { toggleModelPop, closeModelPop, modelEscape, mselMove } from './model-select.js'
import { gwSend } from './send.js'
import { setPanel } from '../sidebar/recent.js'
  // ---------- 上下文占用指示（2026-08-23 dsh ContextMeter 移植）----------
  // 数据来自 /gateway/session 的 context 字段（网关 readSession 提取最后一条 assistant usage，
  // 除以 getContextWindowForModel 窗口）。无数据（无 usage / 无模型窗口）→ hidden。
  // 环形 = 14px/2px 圆环，点击展开 breakdown 面板（headline + ~used/window + 占比条）。
  const ctx = { data: null, open: false }
  const CTX_RADIUS = 5.5
  const CTX_CIRC = 2 * Math.PI * CTX_RADIUS

  // 紧凑 token 计数（dsh formatTokens）：517 / 12.2K / 517K / 1.2M
  function formatTokensCompact(n) {
    const scaled = (v) => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))
    if (n < 1000) return String(n)
    if (n < 1000000) return scaled(n / 1000) + 'K'
    return scaled(n / 1000000) + 'M'
  }

  function renderCtxMeter(context) {
    ctx.data = context || null
    if (!context || !(context.usedTokens >= 0) || !(context.contextWindow > 0)) {
      ctxMeterEl.hidden = true
      ctx.open = false
      ctxPanelEl.hidden = true
      ctxBtnEl.setAttribute('aria-expanded', 'false')
      return
    }
    const percent = context.percent != null
      ? Math.min(100, Math.max(0, Math.round(context.percent)))
      : Math.min(100, Math.round((context.usedTokens / context.contextWindow) * 100))
    const reading = percent + '%'
    const label = '上下文已用 ' + reading
    const dash = (CTX_CIRC * percent / 100).toFixed(3)
    ctxBtnEl.innerHTML = '<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">' +
      '<circle class="ctx-track" cx="7" cy="7" r="' + CTX_RADIUS + '"/>' +
      '<circle class="ctx-fill" cx="7" cy="7" r="' + CTX_RADIUS + '" stroke-dasharray="' + dash + ' ' + CTX_CIRC.toFixed(3) + '" transform="rotate(-90 7 7)"/>' +
      '</svg>'
    ctxBtnEl.title = label
    ctxBtnEl.setAttribute('aria-label', label)
    ctxPanelEl.innerHTML = ctxPanelHtml(context, percent, reading)
    ctxMeterEl.hidden = false
    if (ctx.open) ctxPanelEl.hidden = false
  }

  // dsh ContextMeter panel：headline「上下文已用」+ 百分比（primary）+ ~used/window（figures）+
  // 单段占比条（transcript 无 system/tools/messages 分解，对齐 dsh breakdown 缺失时的单段回落）
  function ctxPanelHtml(context, percent, reading) {
    const figures = '~' + formatTokensCompact(context.usedTokens) + ' / ' + formatTokensCompact(context.contextWindow)
    // 0% 不渲染段（对齐 dsh parts.filter(width>0)：空上下文显示空轨道，不被 .ctx-segment 的 min-width 画出填充）
    const seg = percent > 0 ? '<div class="ctx-segment" style="width:' + percent + '%"></div>' : ''
    return '<div class="ctx-header">' +
      '<span class="ctx-headline">上下文已用</span>' +
      '<span class="ctx-percent">' + reading + '</span>' +
      '<span class="ctx-headline"></span>' +
      '<span class="ctx-figures">' + figures + '</span>' +
      '</div>' +
      '<div class="ctx-bar">' + seg + '</div>'
  }

  function setCtxOpen(open) {
    ctx.open = open
    ctxPanelEl.hidden = !open
    ctxBtnEl.setAttribute('aria-expanded', open ? 'true' : 'false')
  }
  function closeCtxMeter() { if (ctx.open) setCtxOpen(false) }

  // 浮窗外部关闭（对齐 dsh 语义：mousedown 时机 + contains 判断——mousedown 在 DOM 变更前命中目标，
  // 天然免疫 innerHTML 重渲染把被点元素摘除后 e.target.closest() 返回 null 误判「点外关闭」的浮窗闪关/复开）
  document.addEventListener('mousedown', (e) => {
    // 上下文面板：点 #ctx-meter 外（环形按钮除外，其 click toggle 接管开合）= 关闭（dsh ContextMeter pointerdown）
    if (ctx.open && !ctxMeterEl.contains(e.target)) closeCtxMeter()
    // 风险确认门：点对话框外（遮罩）= 取消（dsh Modal 的 mask onClick=onClose）；点对话框内部不触发「点外关闭」
    const rm = $('risk-modal')
    if (!rm.hidden) {
      const dlg = rm.querySelector('.dialog')
      if (dlg && !dlg.contains(e.target)) { closeRiskModal(); return }
    }
    // 命令菜单：点卡片外（+ 按钮除外，其 click toggle 接管开合）= 关闭（dsh PopupSelectView pointerdown capture）
    if (cmd.open && !cmdPop.contains(e.target) && !$('cmd-btn').contains(e.target)) closeCmdPop()
    // 模型菜单：点 root 外（模型 trigger 除外，其 click toggle 接管开合）= 关闭（dsh ModelSelect mousedown + rootRef.contains）
    if (msel.open && !modelPop.contains(e.target) && !modelSeatEl.contains(e.target)) closeModelPop()
    // 项目选择器：点 root 外（seat 除外，其 click toggle 接管开合）= 关闭
    if (psel.open && !projPop.contains(e.target) && !projSeatEl.contains(e.target)) closeProjPop()
  })
  // 点击空白关闭弹层（@ 浮窗 / 整理会话 / 最近气泡）
  document.addEventListener('click', (e) => {
    // @ 浮窗：点浮窗外任意处关闭；点输入内 chip 的 × 删除该 chip
    if (e.target.closest('.mention .m-x')) {
      const chip = e.target.closest('.mention')
      if (chip) removeChip(chip)
      return
    }
    if (!e.target.closest('#mention-pop')) closeMentionPop()
    if (!$('organize-pop').contains(e.target) && !e.target.closest('#recent-more')) $('organize-pop').classList.remove('show')
    if (!bubblePop.contains(e.target) && !e.target.closest('#rail-bubble')) bubblePop.classList.remove('show')
  })
  // 风险确认门：Escape 关闭（dsh Modal 的 Escape onClose 监听；输入栏 keydown 不覆盖遮罩态）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (ctx.open) closeCtxMeter()
      if (!$('risk-modal').hidden) closeRiskModal()
    }
  })

  // composer（只读；网关模式由下方 gatewayInit 的 gwSend 接管）
  sendBtn.innerHTML = I.dshSend // 2026-08-21 dsh 移植：发送 = dsh IconSendOutline16
  $('cmd-btn').innerHTML = I.dshPlus // 2026-08-21 dsh 移植：+ 按钮 = dsh IconPlusOutline16（命令菜单）
  // 2026-08-28 v137：图片上传入口在 + 浮窗「图片」tab（独立按钮移除）；选完图关浮窗，胶囊显示在输入栏上方
  $('img-file').addEventListener('change', () => {
    addImageFiles(Array.from($('img-file').files || []))
    $('img-file').value = '' // 允许重复选同一文件
    closeCmdPop()
  })
  $('img-pills').addEventListener('click', (e) => {
    const x = e.target.closest('.img-x')
    if (!x) return
    pendingImages.splice(+x.dataset.i, 1)
    renderImgPills()
  })
  inputEl.addEventListener('paste', (e) => {
    if (gateAwait) return
    const files = Array.from((e.clipboardData && e.clipboardData.files) || []).filter(f => /^image\//.test(f.type))
    if (files.length) { e.preventDefault(); addImageFiles(files) }
  })
  // 2026-09-06 拖拽上传：图片拖进页面任意处 → 全屏浮层提示，松手入列（与选图/粘贴同链 addImageFiles，
  // 4 张上限/编码/胶囊复用）。只拦 dataTransfer 含 Files 的拖拽（页面内拖选文字/链接原样不受影响）；
  // dragenter/leave 计数对抗子元素穿越，浮层 pointer-events:none 事件全落 document。
  const dropOverlay = $('drop-overlay')
  let dragDepth = 0
  document.addEventListener('dragenter', (e) => {
    if (gateAwait || !e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    dragDepth++
    dropOverlay.hidden = false
  })
  document.addEventListener('dragover', (e) => {
    if (!dragDepth) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  })
  document.addEventListener('dragleave', () => {
    if (!dragDepth) return
    if (--dragDepth === 0) dropOverlay.hidden = true
  })
  document.addEventListener('drop', (e) => {
    if (!dragDepth) return
    e.preventDefault()
    dragDepth = 0
    dropOverlay.hidden = true
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter(f => /^image\//.test(f.type))
    if (files.length) addImageFiles(files)
  })
  // 2026-09-06 纯文本复制：鼠标选中复制走浏览器默认会连 text/html 一起写剪贴板
  // （粘回输入栏/外部富文本编辑器保留背景色等样式），全局拦截 copy 只写 text/plain
  document.addEventListener('copy', (e) => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) return
    const text = sel.toString()
    if (!text) return
    e.clipboardData.setData('text/plain', text)
    e.preventDefault()
  })
  // 模型 seat 的 chevron 是静态 DOM（dsh 移植，随 open 翻转），初始塞入 dsh IconChevronDownOutline14
  $('model-seat').querySelector('.chevron').innerHTML = I.dshChevDown
  // 命令菜单 / 模型菜单按钮（2026-08-21 dsh 输入栏移植；controller 定义见下）
  $('cmd-btn').addEventListener('click', () => { if (gateAwait || state.mgr) return; toggleCmdPop() })
  $('model-seat').addEventListener('click', () => { if (gateAwait || state.mgr) return; toggleModelPop() })
  ctxBtnEl.addEventListener('click', () => { if (gateAwait || state.mgr || ctxMeterEl.hidden) return; setCtxOpen(!ctx.open) })
  sendBtn.addEventListener('click', () => {
    if (gateAwait) { gateSubmit(); return } // token 门态：点击发送 = 提交 token
    // 2026-09-05 定案：停止键只在回合进行中且输入栏为空时显示，点击发 interrupt（网关按
    // sessionId 精确路由 → CLI Ctrl+C 同路径）；有内容时显示发送键，点击=发送排队续发
    // （gwSend 无回合态守卫，不打断）。输入中的文字保留在输入栏不丢（打断后可继续编辑发送）。
    if (btnMode === 'stop' && state.currentHash && gws && gws.readyState === 1) {
      gws.send(JSON.stringify({ type: 'interrupt', sessionId: state.currentHash }))
      toast('已发送打断')
      return
    }
    if (!gwSend()) toast('只读查看 · 无法发送')
  })
  inputEl.addEventListener('keydown', (e) => {
    // token 门态：输入框只做 token 提交
    if (gateAwait) {
      if (e.key === 'Enter') { e.preventDefault(); gateSubmit() }
      return
    }
    // 命令菜单打开：方向键/回车/ESC 走选择逻辑（2026-08-21 dsh 移植，不移动光标、不发送）
    if (cmd.open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); cmdMove(1); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); cmdMove(-1); return }
      if (e.key === 'Enter') { e.preventDefault(); cmdSelect(); return }
      if (e.key === 'Escape') { e.preventDefault(); closeCmdPop(); return }
      return
    }
    // 模型菜单打开：ESC 从 drill 面板退一级再关；方向键移动焦点（2026-08-21 dsh 移植）
    if (msel.open) {
      if (e.key === 'Escape') { e.preventDefault(); modelEscape(); return }
      if (e.key === 'ArrowDown') { e.preventDefault(); mselMove(1); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); mselMove(-1); return }
      return
    }
    // @ 浮窗打开：方向键/回车/ESC 走选择逻辑（不移动光标、不发送）
    if (mention.open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveMentionSel(1); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); moveMentionSel(-1); return }
      if (e.key === 'Enter') { e.preventDefault(); selectMention(); return }
      if (e.key === 'Escape') { e.preventDefault(); closeMentionPop(); return }
    }
    // 退格删除光标前的 @chip（含尾随空格）
    if (e.key === 'Backspace' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const chip = mentionBeforeCaret()
      if (chip) { e.preventDefault(); removeChip(chip); return }
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (gateAwait) { gateSubmit(); return } // token 门态：回车 = 提交 token
      if (!gwSend()) toast('只读查看 · 无法发送')
    }
  })

  // 路由
  // 2026-08-28 pushState 配套：popstate 兜底浏览器前进/后退（navigate 同步 route 后同值跳过）；
  // hashchange 保留为旧 hash 链接/手动改 hash 的兜底（pathname 优先级更高，仅在根路径生效）。
  window.addEventListener('popstate', () => {
    if (lastNavHash !== null && location.pathname === lastNavHash) { setLastNavHash(null); return }
    setLastNavHash(null)
    route()
  })
  window.addEventListener('hashchange', () => {
    if (lastNavHash !== null && location.hash === lastNavHash) { setLastNavHash(null); return }
    setLastNavHash(null)
    route()
  })
  // 展开态头部 floria 头像 = 折叠侧栏按钮（2026-09-02 调整：不再回首页新建会话）
  const logoBtn = document.querySelector('.floria-logo')
  if (logoBtn) logoBtn.addEventListener('click', () => setPanel(false))
  // 默认项目主页（default-preview iframe）点会话 → 父级打开该会话（hash = 会话 uuid）
  window.addEventListener('message', (e) => {
    const d = e.data || {}
    if (d.type === 'floria-open-session' && d.hash) {
      navigate('#/' + encodeURIComponent(d.hash))
      if (isMobile()) setPanel(false)
    }
  })
  // 两层消息流（2026-09-08 定案；2026-09-09 释放链铲除）：
  // ① 屏幕尺寸变化（旋转/缩放）→ 占位高度跟随新 clientHeight（「占位大小根据屏幕大小计算」）
  window.addEventListener('resize', () => { if (stage.active) stageSync() })
  // ② 用户滚动输入（滚轮/触摸拖拽/鼠标拖滚动条/键盘）一律**只让位、永不摘占位**（2026-09-09
  //    用户定案「为什么还会有释放链这种东西」——占位=真实 DOM 实体，与回合绑定，用户输入不在
  //    其生命周期内；任何一处的 remove 都被实测定性为「死掉」）。触摸链：手势（含惯性，
  //    touchend 后 scroll 静默 500ms 判停）期 touchHold 冻结程序跟随防 WebKit 触摸滚动基准
  //    断裂，静默后 yielded 永久让位；tap（拖拽位移 ≤6px）不让位。stageRelease 仅剩视图级
  //    退出调用（切会话/回首页/管理视图/项目预览）。
  $('chat-scroll').addEventListener('wheel', () => {
    if (stage.active && !stage.touchHold) stage.yielded = true
  }, { passive: true })
  const touchYield = () => {
    if (stage.releaseT) clearTimeout(stage.releaseT)
    stage.releaseT = setTimeout(() => {
      stage.releaseT = null
      stage.touchHold = false
      stage.yielded = true
    }, 500)
  }
  let touchY0 = 0
  let touchY = 0
  $('chat-scroll').addEventListener('touchstart', (e) => {
    stage.touchHold = true
    if (stage.releaseT) { clearTimeout(stage.releaseT); stage.releaseT = null }
    touchY0 = touchY = e.touches[0] ? e.touches[0].clientY : 0
  }, { passive: true })
  $('chat-scroll').addEventListener('touchmove', (e) => {
    touchY = e.touches[0] ? e.touches[0].clientY : touchY
  }, { passive: true })
  $('chat-scroll').addEventListener('touchend', () => {
    if (!stage.touchHold) return
    if (Math.abs(touchY - touchY0) > 6) touchYield() // 拖拽过 = 滚动接管 → 惯性静默后让位
    else stage.touchHold = false // tap：不算滚动操作
  }, { passive: true })
  $('chat-scroll').addEventListener('touchcancel', () => {
    if (stage.touchHold) touchYield() // 系统打断（来电/手势争夺）：按拖拽保守处理
  }, { passive: true })
  $('chat-scroll').addEventListener('scroll', () => {
    if (stage.touchHold) {
      if (stage.releaseT) touchYield() // touchend 后惯性滚动：续期静默窗
      return // 手势中的 scroll 不构成滚动输入信号（与触摸无法从事件本身区分，靠持有窗屏蔽）
    }
    // 非程序滚动（progScrollUntil 窗外）= 用户拖滚动条/键盘滚动 → 只让位，永不摘占位
    if (stage.active && !stage.animT && Date.now() >= progScrollUntil) stage.yielded = true
  })
  // 旧体系三类内容几何监听（折叠 toggle 重算/收起 click 接管/图片 load 重算）随动态占位退役：
  // 占位恒定 → 内容收起不再令 scrollTop 越出 maxScroll（无 clamp 闪动），图片异步撑高只改变
  // 跟随目标而跟随每次渲染出口现算（renderSettle→stageSync→stageFollow），无需事件驱动重算。

export {
  CTX_CIRC,
  CTX_RADIUS,
  closeCtxMeter,
  ctx,
  ctxPanelHtml,
  dragDepth,
  dropOverlay,
  formatTokensCompact,
  logoBtn,
  renderCtxMeter,
  setCtxOpen,
  touchY,
  touchY0,
  touchYield,
}
