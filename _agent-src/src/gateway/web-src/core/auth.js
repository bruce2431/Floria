// 设备认证配对 + token 门链（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { route, renderSession } from '../chat/route.js'
import { stage } from '../chat/stage.js'
import { GATEWAY, GATEWAY_REVIEW, gateVerified, gToken, needToken, connect } from './gateway.js'
import { initLive, refreshList, refreshSession } from './live.js'
import { hashOf, findSession, loadSessions } from './sessions.js'
import { chatArea, messagesEl, inputWrap, inputEl, state, ALL } from './state.js'
import { closeMentionPop } from '../inputbar/mention.js'
import { renderModelSeat } from '../inputbar/model-select.js'
import { syncGwSend } from '../inputbar/send.js'
import { loadMgrData, MODELS, loadModelsData } from '../sidebar/mgr-data.js'
import { renderRecent } from '../sidebar/recent.js'
  function deviceHint() {
    return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1 ? 'iPad' : ''
  }


  let finishGateTimer = null // 阶段3 停留后 hideGate 的定时器
  let hideGateTimer = null // gate-screen 淡出后隐藏的定时器（hideGate 不再硬切）
  const gateScreen = $('gate-screen')
  const gTok = $('g-token'), gVid = $('g-video'), gNewImg = $('g-new')
  const gCard = $('g-card')


  // ---------- 设备认证配对（2026-08-28，浏览器侧完全删除 token 授权链） ----------
  // 门态显示设备请求码（localStorage 持久，同一设备恒定），轮询 /gateway/activate?code=：
  // PC 端 /server auth add <请求码> 后网关名单命中 → 种 floria_auth cookie → 下轮轮询 200 →
  // connect()（cookie 直过）→ onopen → gateVerified → gatePlayTransition。无自动转正、无 token。
  let pairTimer = null
  function deviceCode() {
    let c = ''
    try { c = localStorage.getItem('floria-device-code') || '' } catch { /* 忽略 */ }
    if (!/^[a-f0-9]{8}$/.test(c)) {
      const b = new Uint8Array(4)
      crypto.getRandomValues(b)
      c = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
      try { localStorage.setItem('floria-device-code', c) } catch { /* 忽略 */ }
    }
    return c
  }
  function pairStart() {
    pairStop()
    $('g-pair-code').textContent = deviceCode().replace(/(..)(..)(..)(..)/, '$1 $2 $3 $4')
    pairTimer = setInterval(pairPollOnce, 2500)
  }
  function pairStop() {
    if (pairTimer) { clearInterval(pairTimer); pairTimer = null }
  }
  async function pairPollOnce() {
    try {
      const hint = deviceHint()
      const res = await fetch('/gateway/activate?code=' + encodeURIComponent(deviceCode()) + (hint ? '&device=' + encodeURIComponent(hint) : ''))
      if (!res.ok) return false
      pairStop()
      connect() // cookie 已种，WS 直过 → onopen → gatePlayTransition
      return true
    } catch { return false }
  }

  function showGate() {
    closeMentionPop()
    setGateAwait(true)
    setGateVerified(false)
    document.body.classList.add('token-gate')
    // token 门态输入栏必须回到 chat 空态位（位置一致），防 hash 残留会话导致 docked 到底部
    inputWrap.classList.remove('docked')
    chatArea.classList.remove('in-session')
    // 重置门到阶段1：举白板 + 白板内 token 表单
    // 平滑浮现：先置透明再移除 fade-out（强制 reflow 让 transition 生效）→ 淡入
    clearTimeout(hideGateTimer)
    gateScreen.classList.add('fade-out')
    gateScreen.hidden = false
    void gateScreen.offsetWidth
    gateScreen.classList.remove('fade-out')
    clearTimeout(finishGateTimer)
    gVid.pause(); gVid.currentTime = 0
    gVid.classList.remove('show', 'fade-out')
    gTok.classList.remove('fade-out')
    gNewImg.classList.remove('show')
    gCard.classList.remove('hide', 'shake')
    pairStart() // 显示设备请求码 + 启动激活轮询
    syncGwSend()
  }
  function gatePlayTransition() {
    // 阶段1 → 阶段2：白板内表单淡出，过渡视频淡入播放（视频首帧≈举白板图，无缝衔接）
    gCard.classList.add('hide')
    gTok.classList.add('fade-out')
    gVid.classList.add('show')
    gVid.currentTime = 0
    gVid.playbackRate = 1.5 // 过渡视频提速（用户「动画播放快一点」）
    const p = gVid.play()
    if (p && p.catch) p.catch(finishGate) // 视频不可播（不支持 webm/mp4）→ 直接进空态
  }
  function finishGate() {
    if (!gateVerified) return
    // 阶段2 → 阶段3：视频淡出，趴栏图淡入；停留片刻后 hideGate（空态同趴栏 stage，无缝）
    gVid.classList.add('fade-out')
    gVid.classList.remove('show')
    gNewImg.classList.add('show')
    clearTimeout(finishGateTimer)
    finishGateTimer = setTimeout(hideGate, 300)
  }
  gVid.addEventListener('ended', finishGate)

  function hideGate() {
    setGateAwait(false)
    pairStop() // 退出门态：停止配对激活轮询
    document.body.classList.remove('token-gate')
    // 2026-08-28 token 出 URL：正式网关验证通过即清除 URL query token（凭据已入 floria_auth
    // cookie 票证，刷新/收藏都是干净地址）；REVIEW 模式保留写回（server.mjs 仍按 query 校验）。
    try {
      const u = new URL(location.href)
      if (GATEWAY_REVIEW) u.searchParams.set('token', gToken)
      else u.searchParams.delete('token')
      history.replaceState(null, '', u.pathname + u.search + u.hash)
    } catch { /* 忽略 */ }
    gVid.pause()
    inputEl.dataset.ph = '输入消息，Enter 发送' // 占位符复位（token 提示 → 正常输入）
    // gate-screen 淡出后隐藏，与空态（同款渐变背景）交叉过渡 → 切换平滑浮现，不做硬切
    gateScreen.classList.add('fade-out')
    clearTimeout(hideGateTimer)
    hideGateTimer = setTimeout(() => {
      gateScreen.hidden = true
      gateScreen.classList.remove('fade-out')
    }, 280)
    syncGwSend()
    // token 门锁定态跳过的数据加载，解锁后补拉（SSE 重连 + 会话列表/当前会话）
    // 2026-08-18 修复：loadSessions 只填 ALL 不渲染，门后首次拉取后侧栏一直空——
    // 后续 SSE hello→refreshList 因 sig===listSig 短路跳过渲染；须在数据落地后显式渲染侧栏
    //（renderRecent 保留展开文件夹+滚动位置，幂等）。
    loadSessions().then(() => {
      // 刷新直进 /session/<hash>：boot 时会话列表未就绪，route() 的 resolve 落空，
      // currentHash 暂存 → 补拉列表落地后重 resolve（renderSession/refreshSession/SSE 全链全长）。
      // 2026-08-30 改定案（刷新保留当前界面，boot 不再强制回首页）后本恢复链成为刷新直进的唯一落地路径：
      // 「无真实消息气泡」才整页重渲（占位行也是 .msg → 旧判定 .msg 对占位恒假，列表落地即残留）；
      // 列表就绪仍找不到 → route() 渲染真实「会话不存在或已删除」（此时 needToken 已 false）。
      if (state.currentHash) {
        const sess = findSession(state.currentHash)
        if (sess) {
          state.currentHash = hashOf(sess)
          if (!messagesEl.querySelector('.msg:not(.msg-system)')) route()
        } else {
          route()
        }
      }
      renderRecent()
    })
    initLive()
    // 恢复当前界面（gToken 已就绪）：预览态重挂 iframe、管理视图补拉数据、会话态增量刷新
    if (state.preview) route()
    else if (state.mgr) { loadMgrData(true); if (state.mgr === 'models') loadModelsData(true) }
    else {
      refreshSession()
      // 2026-08-25 首页/会话态补拉模型数据：初始 renderModelSeat 时 GATEWAY 尚未就绪、
      // token 空 → /gateway/models 401，MODELS 恒 null，seat 一直显示「选择模型」（用户反馈「看不到模型」）。
      // hideGate 解锁后 token 已就绪 → 补拉一次，finally 内 renderModelSeat 刷新输入栏模型名。
      loadModelsData(true).catch(() => {})
    }
  }
  async function gateSubmit() {
    // 门态回车/点击发送 = 手动重试一次配对激活（平时 2.5s 自动轮询；授权后数秒内自动进入）
    await pairPollOnce()
  }
  // 白板内 token 表单：回车提交（无发送按钮）—— 设备配对版已移除输入框，此绑定随 #g-token-input 删除

export {
  deviceCode,
  deviceHint,
  finishGate,
  finishGateTimer,
  gCard,
  gTok,
  gatePlayTransition,
  gateScreen,
  gateSubmit,
  hideGate,
  hideGateTimer,
  pairPollOnce,
  pairStart,
  pairStop,
  pairTimer,
  showGate,
}
