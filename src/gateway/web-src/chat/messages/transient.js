// 乐观/暂态区：首条消息暂存补投、排队主张收编、absorbPending 接管
import { renderTransient, clearTakeover } from '../../inputbar/approval.js'
import { state, live, messagesEl } from '../../engine/state.js'
import { stageStart, scrollBottom } from '../stage.js'
import { firstSendHash } from '../../sidebar/recent.js'
/* @module chat/messages/transient.js */
  let pendingUserMsgs = []
  function addUser(text, imgs, files) {
    clearTakeover() // 清掉残留的提问/审批 takeover
    // 任何 done-live 折叠在场（权威或本区乐观主张）= 回合运行中 → 排队成员；否则本次发送是
    // 「新回合开启主张」。主张至多一个：主张折叠在场时后续发送恒为 dock 成员。
    const hasLive = !!messagesEl.querySelector('details.done-fold.done-live')
    pendingUserMsgs.push({ hash: state.currentHash, text, imgs: imgs || [], files: files || [], baseTs: live.lastDataTs || 0, form: hasLive ? 'dock' : 'bubble', claimTs: Date.now() })
    renderTransient()
    // 两层消息流：乐观开启气泡唤出占位（排队成员/dock 不唤——会话处理中发送不打断当前展示，
    // 2026-09-08 定案「只有处于结束状态的会话发送乐观气泡才唤出占位」）。气泡取暂态区最后
    // 开启气泡（主张至多一个=它），key='optimistic'，落盘接管后由 hasNewUser 链换权威 key。
    if (!hasLive) {
      const zone = document.getElementById('live-zone')
      const els = zone ? zone.querySelectorAll('.msg.user') : []
      if (els.length) stageStart(els[els.length - 1], 'optimistic')
    }
    scrollBottom() // 发送后跟随下滑（占位在场=两层跟随，动画期不抢）
  }
  // 吸收：当前会话 jsonl 已出现该文本（单条落盘或 drainCommandQueue 多条合并成一条，join 后
  // includes 命中）→ 真实气泡已由渲染权威接管，不再重插；其它会话的 pending 保留（切回时处理）。
  // 2026-08-29 误吸收根治：只认「本条 pending 插入时刻之后落盘」（timestamp > baseTs）的真实消息
  // ——短文本（如「继续」）极易被历史 user 文本 includes 命中，误吸收后乐观气泡被整页重建洗掉、
  // 真实气泡尚未落盘 → 消息静默消失。baseTs 取自渲染权威末条 timestamp（服务端时钟，两端设备无关）。
  function absorbPending(messages) {
    if (!pendingUserMsgs.length) return
    const cur = state.currentHash
    if (!cur) return
    const before = pendingUserMsgs.length
    pendingUserMsgs = pendingUserMsgs.filter((p) => {
      if (p.hash !== cur) return true
      // 吸收信号（2026-08-30 定案弃「文本 includes」单启发式的第一步）：injected 出现
      // （role:'user'+injected，isRealUser 命中）= 注入已发生，渲染权威折叠体内气泡接管；
      // dequeue 落盘 user 出现 = 开启气泡接管。baseTs 防历史文本误吸（教训见下）。
      const newer = messages.filter((m) => isRealUser(m) && (!p.baseTs || (m.timestamp || 0) > p.baseTs))
      const realTexts = newer.map((m) => m.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join(''))
      return !realTexts.some((t) => t.includes(p.text))
    })
    if (pendingUserMsgs.length !== before) renderTransient()
  }
  // 刷新两段式根治（2026-09-08）：队列快照的队首项在回合间隙（权威 done-live 不在场）= CLI
  // 空闲入队即消费的瞬态——即将出队开新回合，应渲染为乐观开启主张（气泡+主张折叠）而非
  // 「排队中」（此前刷新撞上「已入队未落盘」窗口：dock 先出「排队中」、气泡+折叠体等落盘
  // +SSE 往返后才出现）。统一收编为 form='bubble'，形态由 renderTransient 按 authLive 自动
  // 定（在场→降级 dock 成员 = 真排队；不在场→气泡 = 即将开回合），非队首项恒走 remote
  // （真排队）。收编项落盘后走 absorbPending 文本接管 / 接管帧同位换皮 / claimStartTs 计时
  // 移交——乐观链全部现成。首载回程/防抖回程/queue-state SSE 三入口统一调用；同文本已
  // 收编或本地已发（dock 项）幂等跳过/原地升级，不产生第二份。
  function queueClaimAdopt(items) {
    const cur = state.currentHash
    if (!cur || (firstSendHash && firstSendHash === cur)) return // 首条消息事务期乐观 DOM 自理
    const head = items && items[0]
    if (!head || typeof head.content !== 'string' || !head.content) return
    const local = pendingUserMsgs.find((p) => p.hash === cur && p.text === head.content)
    if (local) {
      if (local.form === 'dock') { local.form = 'bubble'; local.claimTs = Date.now() }
      return
    }
    pendingUserMsgs.push({ hash: cur, text: head.content, imgs: [], baseTs: live.lastDataTs || 0, form: 'bubble', claimTs: Date.now() })
  }
  // ---- 暂态区（2026-09-07 两区重构）：#live-zone = 数据区与 .pin-stage 之间的唯一暂态容器，
  //      承载三类乐观/运行态元素——回合开启气泡、回合开启主张折叠（「正在处理」）、置底排队区。
  //      生命周期对齐根治：此前三类元素各自为政（气泡直插数据区、proc 折叠独立变量+计时器、
  //      dock 独立挂载），整页重建洗掉一部分、增量路径洗不掉另一部分 → 「正在处理」幻影折叠
  //      残留 / 排队区插到新落盘消息上一行（首段无锚点时 delta 追加越过 dock）。现一切暂态 DOM
  //      由 pendingUserMsgs + live.queueRemote 单一状态源整体重建，每条渲染路径（整页/增量/
  //      queue-state SSE/发送）末尾都跑 renderTransient 对账：
  //      ① 权威 done-live[data-m] 折叠在场（回合实际运行中）→ 本区不持回合开启主张（主张折叠
  //        不渲染、气泡项降级为排队成员）；主张折叠无 data-m，判定不会自匹配。
  //      ② 吸收：absorbPending 文本命中（落盘接管）→ 项移除，区随趟收敛。
  //      ③ 全空 → 容器整体摘除（主张计时随停）。
// —— 跨模块写入口（切割脚本生成）——
export function setPendingUserMsgs(v) { pendingUserMsgs = v }
