// 会话映射 + 数据拉取（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { hideGate } from './auth.js'
import { needToken, apiUrl } from './gateway.js'
import { refreshList } from './live.js'
import { bodyEl, state, ALL, live, toast } from './state.js'
import { saveModelCur, MODEL_CUR, modelUserPicked, renderModelSeat } from '../inputbar/model-select.js'
import { isArchived } from '../sidebar/recent.js'
  // ---------- 会话映射 ----------
  const hashOf = (s) => (s.file || '').replace(/\.jsonl$/, '')
  // 2026-08-28 定案（用户）：URL 用完整会话 hash 不简写 → 精确匹配即可
  const findSession = (hash) => ALL.find((s) => hashOf(s) === hash)
  // 2026-08-24 归档过滤：统一数据源过滤已归档会话（isArchived 声明在下方行菜单区，函数提升可用）
  const sorted = () => [...ALL].filter((s) => !isArchived(s)).sort((a, b) => b.updatedAt - a.updatedAt)

  // ---------- 数据 ----------
  // 列表签名（2026-08-29 状态点偶发观测不到修复）：数量+最新 updatedAt+标题+各会话状态点。
  // 状态翻转不改 count/updatedAt，签名不含 state 时 refreshList 判同跳过重渲染 → 点不刷新。
  function listSigOf(sessions) {
    const top = sessions[0]
    return sessions.length + ':' + (top ? top.updatedAt : 0) + ':' + (top ? top.title : '') + ':' +
      sessions.map((s) => s.state || '').join(',')
  }
  // 2026-09-06 收口二轮：网关权威 turnEndAt（回合中止时刻）→ live.turnEndFlags 恢复。
  // 首载(loadSessions)与增量(refreshList)两处拉列表同源调用；实时 turn-state SSE 照旧增量。
  // closeSeg 凭此判定「回合已被中止」收口，打断/关闭会话后刷新不再挂「正在处理」无限计时。
  function applyTurnEndAt(sessions) {
    for (const s of sessions) if (typeof s.turnEndAt === 'number') live.turnEndFlags.set(hashOf(s), s.turnEndAt)
  }
  async function loadSessions() {
    if (needToken()) return // token 门锁定态：不发请求（hideGate 解锁后刷新）
    try {
      const res = await fetch(apiUrl('/gateway/sessions'))
      const data = await res.json()
      if (!Array.isArray(data.sessions)) throw new Error(data.error || 'bad response')
      setAll(data.sessions)
      applyTurnEndAt(ALL)
      live.listSig = listSigOf(data.sessions)
    } catch (e) {
      toast('加载失败: ' + (e.message || e))
      bodyEl.innerHTML = '<div class="no-hit">无法连接后端服务。请确认服务已启动。</div>'
    }
  }

  let sessionCwd = null // 当前会话启动根（网关 /gateway/session 附带，取自 jsonl 记录 cwd）；变更卡相对路径显示用
  async function fetchMessages(sessionId) {
    if (needToken()) return { messages: [], context: null, model: null, modelTs: null } // token 门锁定态
    const res = await fetch(apiUrl('/gateway/session?id=' + encodeURIComponent(sessionId)))
    const data = await res.json()
    if (!Array.isArray(data.messages)) throw new Error(data.error || 'bad response')
    // CLI 已按「复用已有实现」原则导出过滤后的会话展示（display，见 conversationDisplay.ts /
    // 网关 /gateway/session 注入）→ 存在时优先消费（thinking 过滤 / 真实用户消息识别由 CLI 权威完成），
    // 尚未导出（如网关重启后 CLI 未重发）时回退后端原始消息映射。
    // context = 网关 readSession 提取的上下文占用（dsh ContextMeter 数据源），无则 null。
    // model/modelTs = 网关附带的每会话实际模型（CLI reportCurrentModel 上报），无则 null。
    // cwd = 会话启动根（2026-08-29 变更卡相对路径显示），无则 null。
    // queued = 当前排队项快照（2026-08-30 队列快照链，CLI queue-state 上报，置底排队区首载数据源）；
    // tasks = 当前任务清单快照（2026-09-10 任务浮窗链，CLI task-state 上报，底栏任务浮窗首载数据源）；
    // file = jsonl 文件名（uuid），供 SSE queue-state / task-state 事件按会话精确匹配。
    return { messages: data.display || data.messages, context: data.context || null, model: data.model || null, modelTs: data.modelTs || null, vision: !!data.vision, cwd: data.cwd || null, queued: Array.isArray(data.queued) ? data.queued : [], tasks: Array.isArray(data.tasks) ? data.tasks : [], file: typeof data.file === 'string' ? data.file : null, deltaSeq: typeof data.deltaSeq === 'number' ? data.deltaSeq : null }
  }
  // 用 CLI 上报的会话实际模型校准模型 seat（2026-08-24 模型 web/CLI 同步）。仅当用户本次会话内
  // 未主动切换（modelUserPicked=false）时采纳，避免覆盖刚切的选择。modelTs 暂保留（供后续冲突判定）。
  function applySessionModel(model, modelTs) {
    if (!model || modelUserPicked) return
    if (MODEL_CUR.model === model) return
    setModelCur({ ...MODEL_CUR, model })
    saveModelCur()
    renderModelSeat()
  }
// —— 跨模块写入口（切割脚本生成）——
export function setSessionCwd(v) { sessionCwd = v }

export {
  applySessionModel,
  applyTurnEndAt,
  fetchMessages,
  findSession,
  hashOf,
  listSigOf,
  loadSessions,
  sessionCwd,
  sorted,
}
