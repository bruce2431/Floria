// 发送编排（gwSend/syncGwSend）（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { pendingUserMsgs, addUser } from '../chat/messages.js'
import { navigate, mountInput, flipInput, renderSession } from '../chat/route.js'
import { stage } from '../chat/stage.js'
import { GATEWAY, gws } from '../core/gateway.js'
import { refreshSession } from '../core/live.js'
import { chatArea, messagesEl, inputWrap, inputEl, sendBtn, state, live, toast } from '../core/state.js'
import { renderTransient, turnLive, setBtnMode } from './approval.js'
import { pendingImages, clearPendingImages } from './images.js'
import { serializeInput, closeMentionPop } from './mention.js'
import { webCreating, firstSendHash, newWebSession } from '../sidebar/recent.js'
  async function gwSend() {
    if (!GATEWAY) return false
    closeMentionPop()
    let text = serializeInput().trim()
    const imgs = pendingImages.slice()
    if (!text && !imgs.length) { inputEl.focus(); return true }
    if (!gws || gws.readyState !== 1) { toast('未连接，无法发送'); return true }
    // 2026-08-28 图片占位：[Image #N] 与 pastedContents id 一一对应。
    // 2026-09-02 防撞根修：id 由本端分配全会话唯一（从已用最大 imageId+1 起，对齐 CLI
    // getInitialPasteId 语义），随 images 显式上行——CLI pastedContentsFromImages 尊重显式 id。
    // 原恒从 1 起：同会话第二条带图消息互覆 image-cache 字节 → 历史图错图。
    if (imgs.length) {
      const base = live.maxImgId || 0
      imgs.forEach((im, i) => { im.id = base + 1 + i })
      live.maxImgId = base + imgs.length
      const ph = imgs.map((im) => `[Image #${im.id}]`).join(' ')
      text = text ? text + ' ' + ph : ph
    }
    const imgPayload = imgs.length
      ? { images: imgs.map(p => ({ id: p.id, content: p.content, mediaType: p.mediaType, filename: p.filename })) }
      : {}
    // 2026-08-24 首页空态首条消息触发：未在具体会话（#/ 空态）输入第一条消息
    // → 先创建 web 会话（网关 spawn 本地可见 CLI 窗口，返回后 CLI 已连 /clients），
    // 再进会话发送首条消息。web 会话 = 本地可见交互 CLI 窗口（用户本地也可直接操作）。
    // 2026-08-25 项目「+」先到初始化界面：state.newProject 有值 → 建会话时带上 project 落到该项目组；
    // 用完即清（正常进会话后 currentHash 已设置，不再进此分支）。
    // 2026-08-24 防双 spawn：创建期间（POST /gateway/wsession 等 CLI 注册，最长 20s）置 webCreating，
    // 期间再发送直接忽略（否则每发一条都新建一个会话）；创建完成后 currentHash 已由 navigate 设置。
    if (!state.currentHash) {
      if (webCreating) { toast('正在创建会话，请稍候…'); return true }
      const tgt = state.newProject
      state.newProject = null
      // 丝滑过渡（2026-08-30）：不等 wsession 返回（spawn CLI 窗口+注册常 >1s，期间空态冻结
      // 是「不丝滑」根源）——发送瞬间即进会话视觉：输入栏 FLIP 沉底 + 趴栏淡出 + 首条消息
      // 乐观上屏（气泡+正在处理折叠）。pre 标记 + hash 暂空：renderSession 创建中不洗
      // 「加载中…」、fetch 空时不重复上屏；创建失败整体回滚空态（还原输入文本与图片胶囊）。
      // 丝滑过渡（2026-08-30）：不等 wsession 返回（spawn CLI 窗口+注册常 >1s，期间空态冻结
      // 是「不丝滑」根源）——发送瞬间即进会话视觉：输入栏 FLIP 沉底 + 趴栏淡出 + 首条消息
      // 乐观上屏（气泡+正在处理折叠）。首条消息事务（firstSendHash）由 newWebSession 在
      // navigate 之前回填，创建失败回滚空态（还原输入文本与图片胶囊）。
      flipInput(false)
      addUser(text, imgs)
      inputEl.textContent = ''
      syncGwSend()
      const d = await newWebSession(tgt || undefined)
      if (!d || !d.hash) {
        setFirstSendHash('') // 事务终止：创建失败，乐观 DOM 随下方空态回滚一并清空
        setPendingUserMsgs(pendingUserMsgs.filter((p) => p.hash)) // 丢弃无归属（hash=''）的乐观项
        messagesEl.innerHTML = ''
        renderTransient() // 暂态区对账：空主张 → 摘区/停主张计时/turnLive 复位
        flipInput(true) // 回滚空态（FLIP 滑回 stage，docked/in-session 一并移除）
        inputEl.textContent = text
        syncGwSend()
        state.newProject = tgt
        inputEl.focus()
        return true
      }
      clearPendingImages()
      // newWebSession 已回填 firstSendHash（navigate 之前）并 navigate 进会话（renderSession
      // 设置 currentHash + 拉历史）：首条消息事务生效——乐观开启气泡/主张折叠是权威 DOM，等真实
      // 数据落盘接管；期间队列快照不渲、空 fetch 不洗盘（守卫见 renderSession/refreshSession）。
      gws.send(JSON.stringify({ type: 'send', text, sessionId: d.hash, ...imgPayload }))
      // 主张折叠已由 addUser → renderTransient 上屏（事务期乐观 DOM 是权威），此处无需再挂
      return true
    }
    if (!inputWrap.classList.contains('docked')) {
      // 先入会话态（输入栏沉底、滚动区留底边距），再追加/钉顶消息，保证钉顶位置计算基于最终布局
      mountInput('chat') // 输入栏从空态 stage 移回 #chat-area 沉底
      inputWrap.classList.add('docked')
      chatArea.classList.add('in-session')
    }
    addUser(text, imgs)
    // 2026-08-17 网关独立化：带当前会话 hash，网关按 sessionId 精确路由给对应 CLI 进程
    // （未在具体会话时 currentHash 为 null → 字段省略，网关广播兜底）
    gws.send(JSON.stringify({ type: 'send', text, sessionId: state.currentHash || undefined, ...imgPayload }))
    // 2026-09-07 两区重构：乐观「正在处理」主张折叠由 renderTransient 从 pendingUserMsgs
    // 统一渲染（回合间隙发送 = 开启主张气泡+主张折叠；回合运行中 = 排队成员，不开折叠）——
    // 原 procOpen 直挂 DOM 链退役（幻影折叠根源：proc 变量跨整页重建悬挂，收养/幂等皆失灵）。
    inputEl.textContent = ''
    clearPendingImages()
    syncGwSend()
    return true
  }

  function syncGwSend() {
    // 2026-09-05 定案：回合进行中输入栏有内容（文本/图）→ 显示发送键（点击=排队续发不打断）；
    // 输入栏为空才显示停止键（打断）。空闲态恒发送键、按输入内容点亮。
    const hasContent = serializeInput().trim().length > 0 || pendingImages.length > 0
    setBtnMode(turnLive && !hasContent ? 'stop' : 'send')
    const on = turnLive || (GATEWAY && gws && gws.readyState === 1 && hasContent)
    sendBtn.classList.toggle('enabled', on)
  }

export {
  gwSend,
  syncGwSend,
}
