// 实时同步（SSE 监听 jsonl 变化）（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { liveFoldBody, isRealUser, isEndStop, fmtDur, stampMsgIn, charNote, lastSegInfo, messagesHtml, pendingUserMsgs, absorbPending, queueClaimAdopt, statusFlags } from '../chat/messages.js'
import { navigate, renderSession } from '../chat/route.js'
import { stage, stageFollow, stageStart } from '../chat/stage.js'
import { hideGate } from './auth.js'
import { setChar } from './char.js'
import { needToken, apiUrl, setConn } from './gateway.js'
import { hashOf, findSession, listSigOf, applyTurnEndAt, fetchMessages, applySessionModel } from './sessions.js'
import { messagesEl, inputEl, bodyEl, state, ALL, live, connUp, toast } from './state.js'
import { renderTransient, renderSettle, claimStartTs, claimTick, syncTurnLive, takeover, clearTakeover, renderTaskDock } from '../inputbar/approval.js'
import { renderCtxMeter } from '../inputbar/ctx-meter.js'
import { gwSend, syncGwSend } from '../inputbar/send.js'
import { firstSendHash, renderRecent } from '../sidebar/recent.js'

  // ---------- 实时同步（阶段1：SSE 监听 jsonl 变化，自动刷新会话/列表）----------
  // 兼容：刷新只替换 messagesEl 内层，折叠开合（含网关实时折叠）与滚动位置尽量保留；
  // 只读视图下最后一段「处理中（尚无回复）」的已处理折叠默认展开，回复落地后自动收起。
  function initLive() {
    if (!('EventSource' in window)) return
    if (needToken()) return // token 门锁定态：不建 SSE（避免 401 重连刷屏，hideGate 解锁后再建）
    if (live.es) return // 2026-09-04 防重建：hideGate 每次 WS 重连都会跑，重复 new 泄漏旧 SSE 连接+事件双发
    live.es = new EventSource(apiUrl('/gateway/events'))
    live.lastSseAt = Date.now() // SSE 链活性时刻：建连即起算（tick 半开探测基点）
    live.es.onmessage = (e) => {
      live.lastSseAt = Date.now() // 任何事件到达=链活（parse 失败同样是活性证明，先记再解析）
      let ev
      try { ev = JSON.parse(e.data) } catch { return }
      if (ev.type === 'hello') { refreshList(); refreshSession() }
      else if (ev.type === 'activity') {
        // 状态点翻转即时刷新（网关 /gateway/activity 群发，2026-08-29）。
        // 2026-09-07 断连感知：state=null（CLI /clients 断开 → 网关 detach 群发）= 会话进程
        // 断开 → 该会话状态点立即熄（不等 600ms 防抖重拉），当前打开的会话立即收口运行态
        //（「正在思考/正在处理」停表），不再冻结在断流前的最后快照上假绿假转。
        if (ev.state == null && typeof ev.session === 'string') {
          const s = ALL.find((x) => hashOf(x) === ev.session)
          if (s && s.state) { s.state = null; renderRecent() }
          if (ev.session === live.curUuid) refreshSession(true)
        }
        // 2026-09-07 状态恢复对称刷新：state 由真空恢复（CLI 重连重报/60s 心跳补报——网关重启
        // 清 sessionActivity 后的空窗）时，当前会话视图同样立即重渲。否则真空窗里的误收口
        // （state=null 被 closeSeg 判「进程不在线」→ 活回合冻结成「已处理」停表）要等下一次
        // jsonl 落盘才翻回，glm 长思考期可达十几分钟（Pj5 会话重启实证）。不变量：当前会话
        // 视图状态显示收敛到网关最新 state，null↔非 null 两向同治。
        else if (typeof ev.session === 'string' && ev.session === live.curUuid) refreshSession()
        refreshList()
      }
      else if (ev.type === 'session-down') {
        // 2026-09-07 进程退出显式告知：detach 且 pid 已死（非重连窗）→ 网关群发。收口运行态
        // + toast 指路（转录在磁盘，列表点开即 resume 重开，积压消息自动补投）。
        if (typeof ev.session === 'string') {
          const s = ALL.find((x) => hashOf(x) === ev.session)
          if (s && s.state) { s.state = null; renderRecent() }
          if (ev.session === live.curUuid) refreshSession(true)
          toast('会话进程已退出，可从列表点开重开（转录已保留）')
        }
      }
      else if (ev.type === 'session-up') {
        // 2026-09-07 会话进程回归（/clients 注册成功）：刷新列表与当前会话；状态点恢复由
        // CLI 注册后的 activity 上报/60s 心跳随后到达，网关不代答状态。
        refreshList()
        if (ev.session === live.curUuid) refreshSession()
      }
      else if (ev.type === 'turn-beat') {
        // 2026-09-07 僵死感知：引擎增量心跳（CLI setResponseLength → gatewayClient 4s 节流）
        // → 记 per-session 最后活性时刻。bindLiveFoldTimer tick 对账：运行态持续而 beat 缺席
        // 或落后超阈值 = 引擎无真实进展（进程/WS 活但 query 链僵死）→ 计时行标「无响应」。
        if (typeof ev.session === 'string') live.turnBeat.set(ev.session, Date.now())
      }
      else if (ev.type === 'queue-state') {
        // 2026-08-30 队列快照增量（清单#2/#4）：CLI commandQueue 变化 → 网关 SSE 群发（事件体
        // 直接带 items 全量快照）→ 当前会话置底排队区即时重渲，不等 400ms 防抖的 refreshSession。
        if (live.curUuid && ev.session === live.curUuid) {
          live.queueRemote = Array.isArray(ev.items) ? ev.items : []
          queueClaimAdopt(live.queueRemote) // 队首主张收编（同回程入口：CLI 端/另一端入队的瞬态同样立即主张化）
          renderTransient() // 暂态区对账重渲（2026-09-07 收编：远端快照更新与气泡/主张折叠同趟对账）
        }
      }
      else if (ev.type === 'task-state') {
        // 2026-09-10 任务浮窗链：CLI TodoV2 清单快照（useTasksV2 单源出口）→ 网关 SSE 群发
        //（事件体直接带 tasks 全量快照）→ 底栏任务浮窗即时重渲，不等 gss 防抖的 refreshSession。
        // 空数组 = 清单清空/隐藏 → 浮窗整体不出现（与 CLI「tasks.length===0 → null」同一判定）。
        if (live.curUuid && ev.session === live.curUuid) {
          live.tasks = Array.isArray(ev.tasks) ? ev.tasks : []
          renderTaskDock()
        }
      }
      else if (ev.type === 'session-delta') {
        // 2026-09-08 事件流统一 P1（方案 20260908135557）：引擎变化 delta 直达——CLI 过滤投影
        //（filterConversationForDisplay 权威单源）的「锚点 + 其后整体替换」增量（anchorSid =
        // 分歧点前一条的稳定键，messages = 分歧点起的尾部；append/末条 blocks 更新/段收口统一
        // 此编码，幂等）。
        // 2026-09-10 协议根修：CLI 侧输入是 capRenderedMessages 的 200 条尾部窗口、本地是全量
        // 投影，两侧长度与 normalizeMessages 派生的 uuid 规则都不同——旧「数字坐标 base +
        // 长度拼接」在长会话下恒被判「历史截断」拒收 → 全量对账风暴 → 回合中零更新（Bash/Edit
        // 零提示实证）。改以内容标识 sid 定位锚点，长度差异不再参与判定。
        // seq 每会话单调：连续 → 应用进本地基线走 renderSessionBody（与全量对账同一渲染出口，
        // absorbPending/renderTransient/钉顶/计时不变量同源）；重复忽略；gap/无基线/无锚点 →
        // refreshSession(true) 全量对账重建基线（分布式流缺失恢复标准形态，对账源 = /gateway/
        // session，display 链 P1 存活）。本回调同步执行无 await，无切会话写穿窗口。
        if (ev.session !== live.curUuid) return
        if (typeof ev.seq !== 'number' || !Number.isInteger(ev.seq) || ev.seq <= 0) return
        if (live.deltaSeq == null) { refreshSession(true); return }
        if (ev.seq <= live.deltaSeq) return
        if (ev.seq !== live.deltaSeq + 1) { refreshSession(true); return }
        if (!Array.isArray(ev.messages) || !ev.messages.length) return
        const cur = Array.isArray(live.localMessages) ? live.localMessages : null
        const anchor = typeof ev.anchorSid === 'string' ? ev.anchorSid : ''
        if (!cur || !anchor) { refreshSession(true); return }
        const idx = cur.findIndex((m) => m && m.sid === anchor)
        // 塌缩防护（不变量）：CLI 恒发 ≤200 条尾部窗口，锚点 = 分歧点前一条 → 锚点之后的本地
        // 条目必然落在投影窗口量级内。超出 512（窗口 200 的保守余量，含跨轮多次 delta 前移）
        // = CLI state 塌缩/失步瞬态（压缩边界/reactive compact），此时应用会截断已提交历史
        //（2026-09-09 录屏实证：web 数组被切到仅剩一条用户消息）→ 走对账链，不应用。
        if (idx === -1 || cur.length - idx - 1 > 512) { refreshSession(true); return }
        live.localMessages = cur.slice(0, idx + 1).concat(ev.messages)
        live.deltaSeq = ev.seq
        renderSessionBody(live.localMessages, { force: false, hash: state.currentHash })
      }
      else if (ev.type === 'compact-state') {
        // 2026-09-04 压缩实时态（queue-state 同款链）：CLI onCompactProgress → 网关 SSE 群发。
        // 压缩进行中 jsonl 零写入 → SSE 'updated' 不来，本事件是「正在压缩」唯一实时源。
        // Map 按会话 uuid 存到达时刻（render 侧 5min TTL 防 compact_end 丢失后卡死），结束即删。
        if (typeof ev.session === 'string') {
          if (ev.active) live.compactFlags.set(ev.session, Date.now())
          else live.compactFlags.delete(ev.session)
          if (ev.session === live.curUuid) refreshSession()
        }
      }
      else if (ev.type === 'turn-state') {
        // 2026-09-06 打断收口链：CLI onCancel → 网关 SSE（compact-state 同款链）。打断后 jsonl
        // 零写入 → SSE 'updated' 不来，本事件是「回合被中止」唯一实时源——记 per-session 时刻
        // （closeSeg 以「段末落盘 ts < 该时刻」判 finished 收口「已处理」），jsonl 永无该回合回复
        // → 无 TTL（防重建后运行态复活）。jsonl 无变化 sig 不变 → refreshSession(true) 强制重渲。
        if (typeof ev.session === 'string' && ev.live === false) {
          live.turnEndFlags.set(ev.session, Date.now())
          if (ev.session === live.curUuid) {
            live.streamText = '' // 2026-09-08 流式字符通道：回合中止 = 暂态收口（CLI 已 streamClear 同发，双端确定性）
            refreshSession(true)
          }
        }
      }
      else if (ev.type === 'stream-text') {
        // 2026-09-08 流式字符通道：CLI 引擎流式 delta（thinking/text，onUpdateLength 单路累积
        // 100ms 合帧全文快照）→ 运行态状态显示行（.think-state）后/乐观主张折叠体内流式预览。
        // 纯显示暂态：不进 localMessages 权威基线、不落盘；空串 = 块边界/消息落盘清除（权威
        // delta 随后接管）。applyStreamPreview 直写 textContent，不走整页重建；重渲洗 DOM 后由
        // renderSessionBody 出口重挂恢复。
        if (ev.session === live.curUuid) {
          live.streamText = typeof ev.text === 'string' ? ev.text : ''
          applyStreamPreview()
        }
      }
      else if (ev.type === 'restored') {
        // 2026-09-06 撤回链：CLI auto-restore（web 打断且无 meaningful 响应）→ 文本回填本端输入栏
        // + 对话流摘该条开启气泡（jsonl 不删，渲染按 flag 永久跳过该 user——无 TTL 防气泡复活）。
        // 打断时输入栏必空（停止键只在输入栏空时显示，v213 定案），有内容时不覆盖（同 CLI 守卫语义）。
        // 撤回动画（同日二轮，用户反馈瞬间消失生硬）：气泡先塌缩淡出再重渲——定位 = body 文本
        // 匹配 restored 文本的最后一个 user 气泡（打断撤回时队列必空 = 流尾气泡）；找不到直接重渲。
        if (typeof ev.session === 'string' && typeof ev.text === 'string') {
          live.restoredFlags.set(ev.session, { ts: Date.now(), text: ev.text })
          if (ev.session === live.curUuid) {
            // 撤回 = 该条乐观主张一并作废（jsonl 永无该 user，absorbPending 永不命中）——
            // 不同步丢弃 pending 项，renderTransient 会让主张气泡/折叠复活（幻影回流）。
            const t0 = ev.text.trim()
            const n0 = pendingUserMsgs.length
            setPendingUserMsgs(pendingUserMsgs.filter((p) => {
              const inCur = p.hash === state.currentHash || (p.hash === '' && firstSendHash === state.currentHash)
              if (!inCur) return true
              return String(p.text || '').replace(/\s*\[Image #\d+\]/g, '').trim() !== t0
            }))
            if (pendingUserMsgs.length !== n0) renderTransient()
            if (!inputEl.textContent.trim()) {
              inputEl.textContent = ev.text
              syncGwSend()
              inputEl.focus()
            }
            const t = ev.text.trim()
            const bubbles = [...messagesEl.querySelectorAll('.msg.user[data-t="u"]')].filter(el => (el.querySelector('.body')?.textContent || '').trim() === t)
            const el = bubbles[bubbles.length - 1]
            if (el && !el.classList.contains('msg-out')) {
              el.style.maxHeight = el.scrollHeight + 'px'
              void el.offsetHeight // 强制 reflow：让 max-height 初值生效后再过渡到 0
              el.classList.add('msg-out')
              setTimeout(() => { el.remove(); refreshSession(true) }, 360)
            } else {
              refreshSession(true)
            }
          }
        }
      }
      else if (ev.type === 'ws-failed') {
        // 2026-09-06 wsession 异步化失败链：后台 spawn/注册失败（含 20s 注册超时）→ 网关 SSE 群发。
        // 收尾不留静默：清首条事务 + 移除合成列表条目 + toast 报错；当前正看该会话 → 回首页。
        if (typeof ev.session === 'string') {
          if (firstSendHash === ev.session) setFirstSendHash('')
          setAll(ALL.filter((s) => hashOf(s) !== ev.session))
          renderRecent()
          toast('web 会话启动失败：' + (ev.error || '未知错误'))
          if (state.currentHash === ev.session) navigate('#/')
        }
      }
      else if (ev.type === 'updated') {
        if (ev.hash === state.currentHash) refreshSession()
        refreshList()
      }
    }
    live.es.onerror = () => {
      live.es.close()
      live.es = null
      setTimeout(initLive, 3000)
    }
  }

  function refreshList() {
    if (live.listT) return
    live.listT = setTimeout(async () => {
      live.listT = null
      if (needToken()) return // token 门锁定态
      try {
        const res = await fetch(apiUrl('/gateway/sessions'))
        const data = await res.json()
        if (!Array.isArray(data.sessions)) return
        applyTurnEndAt(data.sessions) // sig 短路前恢复：turnEndAt 新增不改 listSig，不能被短路跳过
        const sig = listSigOf(data.sessions)
        if (sig === live.listSig) return
        live.listSig = sig
        // 保留展开中的项目文件夹
        const openF = [...bodyEl.querySelectorAll('.folder.open')].map((f) => f.dataset.f)
        setAll(data.sessions)
        applyTurnEndAt(ALL)
        renderRecent()
        if (openF.length) {
          for (const f of bodyEl.querySelectorAll('.folder')) {
            if (openF.includes(f.dataset.f)) f.classList.add('open')
          }
        }
      } catch { /* 瞬时错误忽略 */ }
    }, 600)
  }

  // 2026-08-24 回合进行中探测（refreshSession 处理折叠抑制窗用）：末段是否仍处理中。
  // 复刻 messagesHtml closeSeg 的 finished 判定——末条 assistant 纯文本回复（无 tool_use）= 回合结束；
  // 刚发的真实用户消息 / thinking / tool_use / tool_result / 其余 = 处理中（等待回复）。
  // system/progress/attachment 等非内容记录跳过（jsonl 末尾常有 progress 尾巴）。仅此一处轻量判定，
  // 数据渲染权威仍在 messagesHtml；折叠关闭后交回下方整页数据渲染一次性出最终态。
  function segIsProcessing(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.role === 'system' || m.role === 'progress' || m.role === 'attachment') continue
      if (isRealUser(m)) return true // 刚发的用户消息（assistant 回复未到）= 处理中
      if (m.role === 'assistant') {
        // 2026-08-26：stopReason 精确判定（stop_reason=null 的旁白/工具=处理中，end_turn/stop_sequence=结束）；
        // 字段缺失（旧数据 undefined）回落旧启发式
        if (m.stopReason !== undefined) return !isEndStop(m.stopReason)
        const hasText = m.blocks.some((b) => b.kind === 'text' && b.text && b.text.trim())
        const hasTool = m.blocks.some((b) => b.kind === 'tool_use')
        return !(hasText && !hasTool)
      }
      return true
    }
    return false
  }

  function refreshSession(force) {
    const hash = state.currentHash
    if (!hash) return
    if (live.sessT) return
    live.sessT = setTimeout(async () => {
      live.sessT = null
      if (state.currentHash !== hash) return
      const s = findSession(hash)
      if (!s) return
      try {
        const { messages, context, model, modelTs, cwd, queued, tasks, file, deltaSeq } = await fetchMessages(s.id)
        // 2026-08-30 串会话根治：会话校验只在 await 前做过一次 → fetch 回程期间用户切到其它
        // 会话时，本响应（A 的整份消息/cwd/模型/上下文/队列快照）会写穿全部全局槽并把 A 的
        // 历史 innerHTML 整页渲染进新会话 DOM（CLI 单进程单会话无此异步边界，web 必须在每个
        // 异步边界重验身份）。await 后已切走 → 本响应整体作废。
        if (state.currentHash !== hash) return
        setSessionCwd(cwd)
        // 2026-08-30 队列快照：jsonl 文件名（uuid）供 SSE queue-state 会话匹配；queued 交排队区
        live.curUuid = file ? file.replace(/\.jsonl$/, '') : live.curUuid
        live.queueRemote = queued
        // 2026-09-10 任务浮窗首载/刷新：与 SSE task-state 增量同构（全量快照 → 整窗重渲）
        live.tasks = tasks
        renderTaskDock()
        applySessionModel(model, modelTs) // 2026-08-24：实时刷新同样按 CLI 上报模型校准 seat
        renderCtxMeter(context)
        // 2026-09-08 事件流统一 P1（方案 20260908135557）：全量回程 = 权威快照，重置本地 delta
        // 基线（localMessages 副本 + 网关 seq 记账）。此后 session-delta SSE 按「尾部替换」增量
        // 演进副本；fetch 回程是基线唯一重置点（单源），gap/失步由本函数全量对账恢复。
        live.localMessages = messages
        live.deltaSeq = deltaSeq
        renderSessionBody(messages, { force, hash, adoptQueue: queued })
      } catch { /* 瞬时错误忽略 */ }
    }, 400)
  }

  // 渲染统一出口（2026-09-08 事件流统一 P1 提取；方案 §5.5「应用 delta 后同样走既有出口对账」）：
  // 全量对账（refreshSession fetch 回程）与 session-delta 增量应用共用同一条渲染路径——首条消息
  // 事务收口/接管帧、absorbPending、暂态区对账、sig 幂等判定、增量末段替换或整页重建、计时/钉顶/
  // 滚动全部同源，渲染不变量不因入口分叉（状态源不增加）。opts.adoptQueue 仅全量回程携带
  //（queued 载荷驱动的队首主张收编；delta 路径无 queued 载荷，queue-state SSE 自有入口）。
  function renderSessionBody(messages, opts) {
    const { force, hash, adoptQueue } = opts
    // 首条消息事务收口（2026-09-06）：本会话真实数据已落盘（SSE 接管起点）→ 销毁事务，
    // queue-dock 恢复正常渲染。与 renderSession fetch 回程的收口同一判定、双入口对称。
    // 接管帧（用户「两个状态的『正在处理』定位不同」根治）：乐观气泡/proc 折叠无 data-m，
    // stampMsgIn 的 prev 采集命中不了 → 接管重建把同位真实元素判「新增」重播 fadeup
    //（气泡+「正在处理」跳变重现）→ txTakeover 帧跳过 stampMsgIn（同位换皮不是新增）；
    // 乐观 proc 计时起点（发送瞬间 T0）早于落盘 user ts（异步化后消息经暂存补投）→
    // 移交 live.txProcStart 供 bindLiveFoldTimer 续算，「正在处理 Xs」跨接管连续不回跳。
    let txTakeover = false
    // 接管帧判定（2026-09-07 推广）：乐观开启气泡在屏（无 data-m 的 data-t="u"——真实渲染恒带
    // data-m、引导气泡另带 data-g，无 data-m 的 user 气泡只可能是乐观 DOM）即乐观权威期，
    // 不再只认 firstSendHash（web 新建事务）：CLI 启动会话的 web 首条消息同样经「乐观气泡→
    // 落盘接管」同位换皮，漏判则真实气泡被 stampMsgIn 判「新增」重播 fadeup = 闪动。
    if (messages.length > 0 && (firstSendHash === hash || messagesEl.querySelector('[data-t="u"]:not([data-m])'))) {
      txTakeover = true
      for (const p of pendingUserMsgs) if (p.hash === '') p.hash = hash // 事务归属落定：'' 项归入本会话（吸收判定依赖 p.hash===cur）
      live.txProcStart = claimStartTs()
      if (firstSendHash === hash) setFirstSendHash('')
    }
    live.lastDataTs = (messages.length && messages[messages.length - 1].timestamp) || live.lastDataTs
    // 2026-09-02 排队图 id 防撞：扫描当前会话 display 已用最大 imageId（CLI getInitialPasteId
    // 同法），gwSend 分配 id 从 max+1 起——同会话多条带图消息 id 互不复用，image-cache 字节
    // 不再互覆（原恒从 1 起，第二条覆盖第一条 → 历史图错图）
    live.maxImgId = 0
    for (const m of messages) {
      for (const b of m.blocks || []) {
        if (b.kind === 'image' && typeof b.imageId === 'number' && b.imageId > live.maxImgId) live.maxImgId = b.imageId
      }
    }
    // 2026-08-29 待落盘乐观消息吸收判定：jsonl 已出现该文本（单条落盘或 drainCommandQueue
    // 多条合并成一条，join 后 includes 命中）→ 真实气泡已由渲染权威接管，不再重插
    absorbPending(messages)
    if (adoptQueue) queueClaimAdopt(adoptQueue) // 队首主张收编（刷新两段式根治，形态由 renderTransient 按 authLive 定）
    renderTransient() // 暂态区对账重渲（吸收变化/远端快照更新后；权威重建后由下方再渲带降级判定）
    const last = messages.length ? messages[messages.length - 1] : null
    const sig = messages.length + ':' + (last ? (last.timestamp || '') : '') + ':' + (last && last.blocks.length ? last.blocks[last.blocks.length - 1].kind : '')
    // 新增用户消息检测（实时同步的钉顶触发点）：末尾真实用户消息索引/时间变了 = 新回合。
    // 注入引导消息（injected:true）不触发钉顶（用户定案：引导消息不钉顶，钉顶只属于新回合开启消息）
    let lastU = -1
    for (let i = messages.length - 1; i >= 0; i--) if (isRealUser(messages[i]) && !messages[i].injected) { lastU = i; break }
    const uSig = lastU >= 0 ? lastU + ':' + (messages[lastU].timestamp || '') : ''
    const hasNewUser = live.lastUserSig !== '' && uSig && uSig !== live.lastUserSig
    // 基线推进规则（2026-09-08 二轮根修）：无新回合（含 lastUserSig==='' 的基线补齐）→ 直接
    // 跟随；hasNewUser 帧不在此推进——钉顶触发未命中气泡时保留旧基线 = 下帧 hasNewUser 仍真
    // = 重试，直到气泡在屏命中才随 pinnedUserSig 一并推进（见下方触发块）。v261 注释宣称
    // 「未命中保留重试」，但此处无条件推进使 hasNewUser 下帧即假、重试永不发生。
    if (uSig && !hasNewUser) live.lastUserSig = uSig
    // 2026-08-26 定案：处理中段实时重建。原 2026-08-24 抑制逻辑（回合进行中跳过整页 innerHTML 重建）
    // 假设实时折叠由 WS out 增量填充——但网关从不给 web 发 out 消息（实时流走 SSE：conversationDisplay
    // 上报 + jsonl + 列表刷新），WS out 是死代码 → 处理中折叠一直空白（用户反馈「完全没有渲染，并且也不同步」）。
    // 现改为：回合未结束（数据在增长或 segIsProcessing）→ 照常整页重建，messagesHtml 对处理中段走
    // liveFoldBody 只渲染一个工具折叠行（「正在运行：<当前工具>」轮转；400ms 去抖已限频，SSE 逐条写入时最多 ~2.5 次/秒）；
    // 回合结束（末段回复落地）→ 关掉空 proc 折叠交回下方数据渲染一次性出最终态（已处理时长/回复/变更卡）。
    // 2026-09-06 空 fetch 不洗盘：发送瞬间乐观气泡（data-t="u"）/乐观折叠已上屏，jsonl 尚未
    // 落盘的窗口期 SSE 触发 refreshSession 拿到空 messages → 整页重建把乐观气泡洗成
    // 空白消息区，落盘后才恢复（用户实测「刷新两次+空态一闪」根因；原空态占位行 2026-09-07 移除）。
    // 消息区已有内容且数据为空 = 落盘窗口，跳过本次渲染保留乐观 DOM，等真实数据接管。
    // force 例外：restored 撤回链靠重渲收口（含空态），必须放行。
    if (!force && !messages.length && messagesEl.querySelector('[data-m], [data-t="u"], details')) return
    if (sig === live.curSig && !force) return // force=true：turn-state/restored 等运行态信号到达，jsonl 无新落盘也强制重渲收口
    live.curSig = sig
    const sc = $('chat-scroll')
    const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 80
    // 2026-08-26 增量重建根治：SSE 实时推送只追加/改写尾部「处理中段」，历史消息不变。
    // 对处理中末段只替换该段 DOM（applySegDelta，头部保留）→ 消除每次推送整页 innerHTML
    // 重建的闪烁，且 tool-running 光泽动画不再被重建打断（2.6s 扫光能完整播放）。
    // 条件：上次渲染存在 + 消息数只增不减（SSE 纯追加；回退/压缩等减少则整页）+ 有处理中末段。
    // 回复落地（段结束）/新回合/消息数减少 → 整页重建一次（低频，带「已处理」收拢可接受）。
    const html = messagesHtml(messages)
    // 2026-08-29 吞消息根治：末条真实用户消息（常为刚落盘的引导消息）气泡若不在 DOM（中间段
    // 新增，乐观气泡已被洗掉），增量路径只贴末段永远补不上 → 强制整页重建一次补齐；气泡在位
    // 后续轮次恢复增量（只多一次整页，折叠开合/入场动画已有恢复机制）。
    let lastRealUser = -1
    for (let i = messages.length - 1; i >= 0; i--) if (isRealUser(messages[i])) { lastRealUser = i; break }
    // 2026-08-29 引导消息折叠链：引导消息气泡 data-m=段 key ≠ 自身索引 → 额外带 data-g=自身索引，
    // 此处一并查（否则引导消息在末段时 userBubbleMissing 恒真 → 每次 SSE 都整页重建）
    const userBubbleMissing = lastRealUser >= 0 && !messagesEl.querySelector(`[data-m="${lastRealUser}"][data-t="u"], [data-g="${lastRealUser}"]`)
    const canDelta = !userBubbleMissing && live.lastMsgLen != null && messages.length >= live.lastMsgLen && lastSegInfo && lastSegInfo.processing && lastSegInfo.html
    live.lastMsgLen = messages.length
    if (canDelta) {
      applySegDelta(lastSegInfo)
      renderTransient() // 增量末段替换后暂态区对账（权威 done-live 复判 → 乐观主张降级/移除）
    } else {
      // 折叠开合恢复改用**结构稳定键**（2026-09-11 根治）：原实现按 querySelectorAll('details')
      // 的数组下标采集/回填，注释假定「索引稳定」——但整页重建时 details 序列本就会变：处理中段的
      // liveFoldBody 尾组数随工具增长、think-row 数随思考块增长、回合收口时处理中段转已完成段
      // （liveFoldBody 多组 → groupTools 合并组）。下标错位会把旧 done-fold 的 open 赋给新 tool-fold，
      // 工具折叠体**莫名自动展开**（用户实测「没点开，自己就这么大」）。
      // 键 = 宿主段(data-m|data-t) + 主类名 + 段内同类序号：跨类型错配彻底消除（思考展开态不会再
      // 灌给工具折叠）；同类内序号偏移只在同段同类折叠增删时发生（后果轻，回落默认收起）。
      const foldKey = (d) => {
        const cls = d.className.split(' ')[0]
        if (d.dataset.m) return `@${d.dataset.m}|${d.dataset.t || ''}|${cls}`
        const host = d.closest('[data-m]')
        const scope = host || messagesEl
        const idx = [...scope.querySelectorAll('details.' + cls)].indexOf(d)
        return `${host ? host.dataset.m + '|' + (host.dataset.t || '') : 'root'}|${cls}#${idx}`
      }
      const openState = new Map([...messagesEl.querySelectorAll('details')].map((d) => [foldKey(d), d.open]))
      const doneLivePrev = new Set([...messagesEl.querySelectorAll('details')].filter((d) => d.classList.contains('done-live')).map(foldKey))
      // 采集刷新前的消息 key（data-m|data-t），重建后只给新增块播放入场动画
      const prevMsgs = new Set([...messagesEl.querySelectorAll('[data-m]')].map((e) => e.dataset.m + '|' + (e.dataset.t || '')))
      messagesEl.innerHTML = html
      if (!txTakeover) stampMsgIn(prevMsgs) // 接管帧不播入场动画（同位换皮，见上方事务收口注释）
      // 已存在的折叠恢复刷新前状态（覆盖 messagesHtml 对处理中折叠的默认 open，避免折叠后被刷新强制弹开）；
      // 处理中折叠（done-live）回复落地 → 自动收起（对齐「回复落地后收起」设计，短回复占位得以重新补回）；
      // 用户手动展开的「已处理」折叠照常恢复。新增折叠（索引越界）保留默认：处理中展开、已处理收起
      ;[...messagesEl.querySelectorAll('details')].forEach((d) => {
        const k = foldKey(d)
        if (!openState.has(k)) return // 新增折叠（键不在旧集）保留 HTML 默认：处理中展开、已处理收起
        const finishedNow = doneLivePrev.has(k) && !d.classList.contains('done-live')
        d.open = finishedNow ? false : openState.get(k)
      })
      // 2026-08-30 乐观改排队区（清单#4③）→ 2026-09-07 暂态区收编：整页重建洗掉 #live-zone
      // → renderTransient 从状态整体重建（气泡/折叠/排队区恒定顺序挂回 pin-stage 之前）
      renderTransient()
    }
    // 2026-09-11 ④ 只读提问卡接管已移除（见 route.js 同处注）：提问态由消息流紧凑工具行表达，
    // 此处只保留审批卡保护——交互式逐题审批卡占据输入栏时不得被 clearTakeover 洗掉。
    if (takeover !== 'approval') clearTakeover()
    setChar(charNote) // 只读 SSE：按末段最近工具/处理状态切形象
    bindLiveFoldTimer(messages)
    applyStreamPreview() // 2026-09-08 流式字符通道：重渲洗 DOM 后重挂流式预览暂态（streamText 内存态恢复）
    syncTurnLive() // 2026-09-04 打断按钮：SSE 刷新整页/增量重建后校准（回合收口→还原发送键）
    if (hasNewUser && uSig !== live.pinnedUserSig) {
      // 真正的新用户消息 → 回合开启唤出（两层消息流）：占位+平滑上划贴顶。
      // pinnedUserSig 防重复：迟到的刷新不会再重钉上一回合。
      // 命中才推进 lastUserSig/pinnedUserSig（配合上方基线推进规则=真实可重试）。
      const el = messagesEl.querySelector(`[data-m="${lastU}"][data-t="u"]`)
      if (el) {
        live.lastUserSig = uSig // 命中才推进（配合上方基线推进规则=真实可重试）
        live.pinnedUserSig = uSig
        if (stage.active && stage.key === 'optimistic') {
          // 乐观气泡唤出的占位在场 → 接管帧同回合延续。必须走 stageStart 直终态（2026-09-09
          // 「新消息跳动」根修）：乐观期开启的 750ms 平滑窗目标基于接管前几何，接管重建
          // （live-zone 摘除 → innerHTML 重建）已改几何，沿用旧窗=到点瞬跳；且换 key 帧须
          // 换参照气泡（脚印随参照实时量取，2026-09-10 起无诞生快照，换气泡即换几何）。
          // smooth=false：不重播上划动画，作废动画窗并按跟随几何同帧归位。
          stageStart(el, uSig, false)
        } else {
          stageStart(el, uSig, true) // CLI 端发起的新回合（web 观察）同样唤出+动画（体验对齐）
        }
      }
    } else {
      renderSettle() // 无新回合：占位在场时对账（重挂/校准/跟随归位），未激活零开销
    }
    // 占位在场=两层跟随接管（stageFollow/动画期已自带让位逻辑）；
    // 否则保留原有「原本在底部就跟着吸底」行为
    if (!stage.active) {
      sc.style.scrollBehavior = 'auto'
      if (atBottom) sc.scrollTop = sc.scrollHeight
      sc.style.scrollBehavior = ''
    }
  }

  // 增量重建（2026-08-26）：只替换「处理中末段」的 DOM，头部历史消息保留不动（不整页 innerHTML，
  // 消除闪烁 + tool-running 光泽动画不被重建打断）。info = lastSegInfo {key, html, prev, processing}：
  // 先删旧末段全部节点（data-m=key，含用户消息/折叠/回复/变更卡），新段节点按 prev 锚点
  // （该段输出前的最后一个 data-m 元素）插回原位；无锚点（末段即首条）则追加到末尾。
  function applySegDelta(info) {
    const key = String(info.key)
    messagesEl.querySelectorAll(`[data-m="${key}"]`).forEach((n) => n.remove())
    const tmp = document.createElement('div')
    tmp.innerHTML = info.html
    const frag = document.createDocumentFragment()
    for (const n of [...tmp.children]) frag.appendChild(n)
    let anchor = null
    if (info.prev) {
      // 同 data-t 多元素时（如多轮 end_turn 的多个 reply 气泡、同 key 多 fold）取文档序最后一个
      // = 段尾精确锚点（碎片化交错渲染 2026-08-29：prev.type 语义=段尾最后元素）
      const nodes = messagesEl.querySelectorAll(`[data-m="${info.prev.key}"][data-t="${info.prev.type}"]`)
      anchor = nodes.length ? nodes[nodes.length - 1] : null
    }
    // 插入点恒避让暂态区与 .pin-stage（暂态区子元素/两层占位必须是流末）：段尾无后继或无锚点
    //（首段处理中）时都插到 #live-zone 之前——否则新段节点越过暂态区/落到占位块后面，
    // 占位错位到内容中间持续到刷新（2026-08-28 钉顶占位突然死亡根因一；2026-09-07 排队区
    // 插到新消息上一行同根因，暂态区结构化消除）。
    const zone = document.getElementById('live-zone')
    const spacer = messagesEl.querySelector('.pin-stage')
    const tail = zone || spacer
    if (anchor && anchor.isConnected) {
      let after = anchor.nextSibling
      while (after && after.nodeType !== 1) after = after.nextSibling
      messagesEl.insertBefore(frag, after || tail)
    } else {
      messagesEl.insertBefore(frag, tail)
    }
  }

  // 处理中折叠的「正在处理」实时计时（历史/SSE 路径）：末段尚无回复 = 处理中，
  // 从该段最后一个真实用户消息时间起跳字，回复落地后下轮刷新换成「已处理 X」并停表。
  let liveFoldTimer = null
  function stopLiveFoldTimer() {
    if (liveFoldTimer) { clearInterval(liveFoldTimer); liveFoldTimer = null }
  }
  function bindLiveFoldTimer(messages) {
    stopLiveFoldTimer()
    const fold = messagesEl.querySelector('details.done-fold.done-live[data-m]') // 权威折叠（data-m）；乐观主张折叠在暂态区无 data-m，不参与
    if (!fold) return
    let t1 = live.txProcStart || 0
    live.txProcStart = 0 // 读取即清：移交起点只服务接管帧这一跳（残留会污染其它会话/回合的计时）
    if (!t1) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        // 注入引导消息（injected:true）不重置计时——「已处理」时长 = 从段开启消息起算，不打断（用户定案）
        if (isRealUser(m) && !m.injected && m.timestamp) {
          t1 = m.timestamp
          break
        }
      }
    }
    if (!t1) return
    const sum = fold.querySelector('summary')
    const tick = () => {
      if (!fold.isConnected) { stopLiveFoldTimer(); return }
      // SSE 半开探测（2026-09-10 真空期二轮根治）：TCP 半开（改网/睡眠唤醒/网络抖动）不触发
      // es.onerror（无 FIN/RST），delta 全丢且无重连——唯一表现=任何 SSE 事件停达而计时行照跳
      //（776169a6 实证：CLI 跑 4 个 Bash，网关 deltaSeq=29/投影 103 条完整，web 冻结旁白帧
      // 1m18s）。done-live 在场=处理中段，引擎有增量即 4s 一发 beat，纯工具期亦有输出流；
      // 90s 无任何 SSE 事件=链死亡（覆盖引擎真静默上界），主动全量对账自愈——fetch 走新 TCP，
      // 既是探测也是恢复，幂等无状态污染。重置基点防每秒重入。es.onerror 明确断开形态已有
      // close+3s 重连+hello 对账覆盖，本探测只补半开盲区。
      const nowMs = Date.now()
      if (live.lastSseAt && nowMs - live.lastSseAt > 90000) {
        live.lastSseAt = nowMs
        refreshSession(true)
      }
      const sec = Math.round((Date.now() - t1) / 1000)
      // 僵死/断连对账（每秒 tick 无残留状态，信号恢复即自动消失）：
      // ① beat = 引擎最后产出增量的时刻（turn-beat SSE）。落后 ≥150s（beat 缺席则从本折叠
      //    计时起点起算）= query 链僵死或长任务无输出 → 标「无响应」。2026-09-08 判定统一：
      //    与 claimTick 同规则，删掉「beat 缺席即标」的短路——纯工具回合（bash 长跑零增量）/
      //    回合切换后 beat 窗口/旧 exe CLI（不发 beat）整回合误标「无响应」（未上屏先挂标实证）。
      // ② connUp = 网关 WS 在线（setConn 维护）。断开（网关死/网络断）→ 标「连接中断」，
      //    此前断流后计时行冻结假转（09-07 Pj5 断流残影实证），用户无从分辨。
      // 回合基线（2026-09-08 无响应误标根治）：turnBeat 是 per-session 永续 Map，上回合残留
      // beat（早于本段开启消息 t1）对新回合毫无意义——回合切换后的静默期（乐观窗口/首响前）
      // 拿旧值算出 staleSec≥150 会立即误标「无响应 X 分」（12:42 实测：正在处理 5s 并挂无响应
      // 2m59s）。beat 早于 t1 视同缺席，从本折叠起点 sec 起算，与本判定设计语义对齐。
      const rawBeat = live.curUuid ? live.turnBeat.get(live.curUuid) || 0 : 0
      const beatAt = rawBeat >= t1 ? rawBeat : 0
      const staleSec = beatAt ? Math.round((Date.now() - beatAt) / 1000) : sec
      // ③ 2026-09-11 已知阻塞原因不算「无响应」：审批卡在场（回合阻塞在等用户作答）/ 工具在飞
      // （引擎阻塞在等工具结果）都是合法阻塞，引擎无产出是预期——beat 自然不会增长。
      // 红标语义 = 「引擎无产出**且无已知阻塞原因**」；纯工具期与审批同等豁免（用户实测
      // 「正在运行时候怎么会无响应呢」，案例=长跑命令 3m33s 被误标）。工具判据取 DOM 运行态标记
      // .tool-line.tool-running——running 分支 summary 与 toolCurHtml 两条出口同款类，单一判据。
      const awaitingApproval = takeover === 'approval'
      const toolRunning = !!fold.querySelector('.tool-line.tool-running')
      // 单状态槽（2026-09-11 用户定案「一次应该只有一个状态，现在是无响应，应该只有无响应」）：
      // 红标在场时它**独占**状态槽——stEl 所在状态显示行挂 .is-flagged，styles.css 隐去同行
      // .think-state（含并发尾缀「并思考」）与 .think-stream（流式预览=引擎产出的暂态，引擎无产出
      // 即过期，留着与红标互相打脸）。旧形态是并排注解（「正在思考 · 2m57s · 无响应 2m51s」两个
      // 状态同时在场），信号恢复即整行复原（每秒重算，无残留态）。
      // 豁免规则（审批等待/工具在飞 = 已知阻塞）→ 本帧不参与僵死判定，传 0 表达「判据不适用」；
      // 阈值与文案由 messages.js statusFlags/STALE_SEC 单源构造（优先级：连接中断 > 无响应）。
      const flags = statusFlags(connUp, awaitingApproval || toolRunning ? 0 : staleSec)
      // 两行各自独立跳字（2026-09-09 用户定案「折叠顶只留正在处理/已处理，状态标识归工具行层」；
      // 二轮定案：工具调用行=折叠体，状态显示行是其内暂态层 .fold-state——有工具组并入 summary
      // 同行、无工具组独立行，动画展示不留存）：① 折叠顶 summary 恒「正在处理 + d-dur 总时长」；
      // ② 思考/压缩状态 .think-state 落 .fold-state 暂态层，tick 原地续「· Ns」。全程节点级
      // textContent 更新、不 innerHTML 重建——重建会每秒重启扫光动画并洗掉 applyStreamPreview
      // 挂的流式预览节点。
      // 状态行文本节点独立（2026-09-11）：.think-state 首子节点恒为 .t-ico 行首槽（与工具行同款
      // 16px 槽 + 5px gap，文字左缘同基准）——整节点 textContent 赋值会连图标槽一并洗掉，槽一没
      // 文字左缘即回跳（用户实测的「跳动」），故 tick 只写 .ts-text 文本节点。
      const stEl = fold.querySelector('.think-state')
      if (stEl) {
        // 文案由 messages.js vacuumLabel 单一映射后写进 data-label（含并发尾缀「并思考」形态）；
        // tick 只补计时，不复刻 mode→label 映射（旧实现在此处重复一份三元链，改文案要改两处）。
        const label = stEl.dataset.label || ''
        const ts = Number(stEl.dataset.ts) || 0
        const dsec = ts ? Math.max(0, Math.round((Date.now() - ts) / 1000)) : 0
        stEl.querySelector('.ts-text').textContent = label && ts ? `${label} · ${fmtDur(dsec)}` : label
      }
      const durEl = sum.querySelector('.d-dur')
      if (durEl) durEl.textContent = ' ' + fmtDur(sec)
      // 僵死/断连红标独立对账（原地，信号恢复即自动消失）；宿主=状态显示行 .fold-state（有工具组时
      // 在工具行 summary 内、无工具组时段尾独立行）或 done-body 尾（乐观主张折叠），不上折叠顶
      // summary（同上定案：折叠顶不留状态标识字样）
      let flEl = fold.querySelector('.d-flags')
      if (!flEl) {
        flEl = document.createElement('span')
        flEl.className = 'd-flags'
        const fhost = stEl ? stEl.parentElement : fold.querySelector('.done-body')
        if (!fhost) return
        fhost.appendChild(flEl)
      }
      flEl.innerHTML = flags
      // 状态槽独占判定（同帧、同一判据 flags 非空）：宿主是状态显示行 .fold-state 时才挂标
      //（回退宿主 .done-body 里本就没有 .think-state，无需隐）。信号恢复 → 摘标 = 状态文字复原。
      const frow = flEl.parentElement
      if (frow && frow.classList.contains('fold-state')) frow.classList.toggle('is-flagged', !!flags)
    }
    tick()
    liveFoldTimer = setInterval(tick, 1000)
  }

  // 2026-09-08 流式字符通道：把 live.streamText 挂到状态显示行 .fold-state 内（权威段体工具行
  // summary 内暂态层 / 段尾独立行 / 乐观主张折叠 #claim-fold 的 done-body 内，2026-09-09 定案
  // 起不再进任何折叠顶 summary——折叠顶只留「正在处理/已处理」字样）。单行 rtl 保尾（.think-stream 样式，v151 .ch-file 同款技巧），
  // JS 截 200 字符防 DOM 膨胀。无状态显示行在场且无主张折叠 = 不显示（内存保留，状态显示行渲染出
  // 来后由下一帧/renderSessionBody 出口带出）；text 空 = 移除暂态节点。
  // 清除信号：stream-text ''（块边界/消息落盘）、turn-state live:false（打断）、切会话清槽。
  function applyStreamPreview() {
    const old = messagesEl.querySelector('.think-stream')
    const text = live.streamText || ''
    if (!text) { if (old) old.remove(); return }
    let host = null
    let anchor = null
    const stEl = messagesEl.querySelector('details.done-fold.done-live .think-state')
    if (stEl) { anchor = stEl; host = stEl.parentElement }
    else {
      const claim = document.getElementById('claim-fold')
      if (claim) host = claim.querySelector('.done-body')
    }
    if (!host) { if (old) old.remove(); return }
    // 流式预览与状态文字同挂 .fold-state 暂态层一行（2026-09-09 定案：与工具行同一行）；已有节点全
    // host 查找复用（行内 d-flags 与流式预览共存，anchor.nextElementSibling 判定会误判成
    // 需重建 → 孤儿残留），只在缺节点时插入到状态文字之后（claim 路径 anchor 空则追加体尾）。
    let el = host.querySelector(':scope > .think-stream')
    if (!el) {
      el = document.createElement('span')
      el.className = 'think-stream'
      if (anchor) anchor.after(el); else host.appendChild(el)
    }
    el.textContent = text.length > 200 ? '…' + text.slice(-200) : text
  }

export {
  applySegDelta,
  applyStreamPreview,
  bindLiveFoldTimer,
  initLive,
  liveFoldTimer,
  refreshList,
  refreshSession,
  renderSessionBody,
  segIsProcessing,
  stopLiveFoldTimer,
}
