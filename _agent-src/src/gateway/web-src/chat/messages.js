// 消息渲染（气泡/折叠/媒体）+ 首条消息暂存补投（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { scrollBottom, stage, stageStart } from './stage.js'
import { toolToChar } from '../core/char.js'
import { I } from '../core/icons.js'
import { refreshSession, applySegDelta, bindLiveFoldTimer } from '../core/live.js'
import { mdHtml } from '../core/markdown.js'
import { findSession, sessionCwd } from '../core/sessions.js'
import { messagesEl, state, live, esc, toast } from '../core/state.js'
import { renderTransient, claimStartTs, takeover, clearTakeover } from '../inputbar/approval.js'
import { firstSendHash } from '../sidebar/recent.js'
  // ---------- 消息渲染 ----------
  // 工具名 → 中文动作（弱化行展示，不单独成气泡）
  const TOOL_NAMES = {
    Read: '阅读', Edit: '编辑', Write: '写入', Grep: '搜索', Glob: '查找文件',
    Bash: '运行命令', WebFetch: '抓取网页', WebSearch: '搜索网页',
    NotebookEdit: '编辑笔记', TaskCreate: '创建任务', TaskUpdate: '更新任务',
    TaskGet: '查询任务', Agent: '委派 Agent', Skill: '调用技能', TodoWrite: '更新待办',
    AskUserQuestion: '提问',
  }
  // MCP 工具名 → 短显示名（沿用源码 mcpInfoFromString 的 split('__') 解析约定：
  // mcp__<server>__<tool> 取 tool 段；仅显示层用，权限匹配仍走原始名）。无 tool 段退回 server 名。
  function mcpShortName(name) {
    const parts = name.split('__')
    if (parts[0] !== 'mcp' || !parts[1]) return null
    return parts.slice(2).join('__') || parts[1]
  }
  // 工具块元信息：英文名 + 中文动作 + 详情（命令/路径/搜索词等）
  function toolMeta(block) {
    const name = block.name || 'tool'
    const zh = TOOL_NAMES[name] || mcpShortName(name) || name
    const inp = block.input && typeof block.input === 'object' ? block.input : null
    const detail = inp ? (inp.file_path || inp.filePath || inp.query || inp.pattern || inp.command || inp.toolName || inp.path || '') : ''
    return { name, zh, detail: typeof detail === 'string' && detail ? String(detail).slice(0, 120) : '' }
  }
  function toolLine(block) {
    const t = toolMeta(block)
    return `<span class="tool-line" data-name="${esc(t.name)}"><span class="t-ico">${toolIcon(t.name)}</span><span class="tl-text">${esc(t.zh)}${t.detail ? ' · ' + esc(t.detail) : ''}</span></span>`
  }
  // 提问在消息流里的紧凑行（DSH 工具行语义）：icon + 「提问」+ 状态（等待回答 / 已回答）。
  // 2026-09-11 ④ 用户定案移除只读提问卡（`questionCardHtml` 静态不可交互的输入栏接管卡，
  // 「有一个静态的提问卡不可交互的…直接移除就好」）——AskUserQuestion 在 web 只留本紧凑行，
  // 作答在 CLI 窗口；web 可交互提问走 CLI 经审批链下发的 question 分支（renderQuestionApproval）。
  function askLineHtml(answered) {
    return `<span class="tool-line" data-name="AskUserQuestion"><span class="t-ico">${toolIcon('AskUserQuestion')}</span>提问 · ${answered ? '已回答' : '等待回答'}</span>`
  }
  // 工具类型 → 概括短语（连续工具折叠的 summary 标签）
  const TOOL_VERB = {
    Read: '阅读了文件', Glob: '查找了文件', Grep: '搜索了代码',
    Bash: '运行了命令', WebFetch: '查看了网页', WebSearch: '搜索了网页',
    Edit: '编辑了文件', Write: '写入文件', NotebookEdit: '编辑了文件',
    Agent: '委派了子代理', Skill: '调用了技能', TodoWrite: '更新了待办',
    TaskCreate: '创建了任务', TaskUpdate: '更新了任务', TaskGet: '查询了任务',
    AskUserQuestion: '提出了问题',
  }
  // 一组工具的概括标签：去重保序 + 「、」/「并」连接，如「编辑了文件并运行了命令（3）」
  function toolFoldLabel(tools) {
    const verbs = []
    for (const t of tools) {
      const v = TOOL_VERB[t.name] || t.zh || '调用了工具'
      if (!verbs.includes(v)) verbs.push(v)
    }
    const label = verbs.length <= 1 ? (verbs[0] || '调用了工具') : verbs.slice(0, -1).join('、') + '并' + verbs[verbs.length - 1]
    return `${label}（${tools.length}）`
  }
  // 把段内 items（think/text/guide/tool 对象）渲染为 done-body 内部 HTML：
  // 连续 tool 合并成一个可展开折叠（默认收起省空间），思考/旁白/引导气泡原位穿插显示（与动作关联）。
  // 2026-08-30 恢复（工具行折叠回归）：v163 stackBody 重写把 groupTools/liveFoldBody 连同折叠
  // 一起删除（用户实测「工具行折叠的功能消失了」，对照 182358 正常版 diff 定位），本函数原样取回；
  // running 判定改用 done 标（现行 items 约定），供被打断段（closeSeg(false)）未完成工具亮 tf-dot。
  function groupTools(items) {
    let html = ''
    let group = []
    const flush = () => {
      if (!group.length) return
      const rows = group.map((g) => g.html).join('')
      const running = group.some((g) => !g.done)
      html += `<details class="tool-fold"${running ? ' data-state="running"' : ''}><summary>${running ? '<span class="tf-dot"></span>' : ''}<span class="tf-label">${esc(toolFoldLabel(group))}</span></summary><div class="tool-fold-body">${rows}</div></details>`
      group = []
    }
    for (const it of items) {
      if (!it || !it.html) continue // 占位/置空的块（reply 占位、被过滤的思考）
      if (it.kind === 'tool') { group.push(it); continue }
      flush()
      html += it.html
    }
    flush()
    return html
  }
  // 「状态行」归属判定（纯函数；2026-09-11 并发复合态根治——探针 probe-concurrent-status 跑本函数真实实现）。
  // 状态行（正在思考/正在生成/正在压缩）表述的是「引擎仍在产出」这一事实，**与「工具在飞」正交**。
  // 旧式把两者绑成互斥（busyOk 含 `!s.pendingTools.length`）→「模型边跑工具边继续产出」的真并发态被压成
  // 二选一，随内容块起点来回翻（用户实测「左侧 search 在闪」；CLI 侧同源判据 MessageRow.isActiveCollapsedGroup
  // 的 `isLoading && !hasContentAfter` 亦按内容块重算）。分档判据即不变量：
  //   ① 无工具在飞 + 无待答提问 + 回合未收口 → 回合未收口即引擎必然在产出（推断成立；原 busyOk 语义原样保留）；
  //   ② 有工具在飞 → 引擎是否仍在产出**不可推断**（工具跑完后引擎可能已收工等结果）→ 取证据 turn-beat 新鲜度：
  //      （此取证只约束**推断档** think/generating；压缩态是 CLI 显式上报的**实证**，自带证据，故判定序在其先，
  //       不受「工具在飞」约束——压缩与工具互斥是巧合而非不变量，把实证挂到推断之后正是本次要根除的互斥绑定。）
  //      REPL setResponseLength 内容增长分支 → notifyTurnBeat（4s 节流；thinking/text/工具参数三类 delta 全汇聚
  //      于此，= messages.ts onUpdateLength 的三处调用点）。新鲜 = 真并发 → 状态行与「正在运行：<工具>」同 summary
  //      并存（liveFoldBody 的 stateAppend 构造期拼接天然支持两行并存，无新渲染分支）。
  // 阈值 6s = 节流窗 4s + 2s 抖动余量；生产流中途 >6s 无 delta 属停摆，归 150s 无响应红标另管（live.js tick）。
  // beat 早于本回合起点视同缺席（上回合残留 beat 对新回合无意义）——与 live.js tick 的回合基线 clamp 同规则。
  const BEAT_FRESH_MS = 6000
  function vacuumOf(s, processing, live, now) {
    if (!processing) return null
    if (s.lastAsk && s.lastAsk.answer == null) return null
    // 压缩实时态（2026-09-04 queue-state 同款链）：压缩进行中 jsonl 零写入（boundary+summary 同毫秒落盘
    // 于结束时刻）→ lastStep 停在 'result'，CLI onCompactProgress → 网关 compact-state SSE 到达即强制压缩态
    // （TTL 5min 防 compact_end 丢失卡死）；结束回退思考态逻辑。显式实证，先于工具在飞取证。
    const cfTs = live.compactFlags.get(live.curUuid)
    if (s.lastStep === 'compact' || (cfTs && now - cfTs < 300000)) return 'compact'
    if (s.pendingTools.length > 0) {
      const beatAt = live.curUuid ? (live.turnBeat.get(live.curUuid) || 0) : 0
      const turnStart = (s.user && s.user.timestamp) || s.startTs || 0
      if (!(beatAt >= turnStart && now - beatAt < BEAT_FRESH_MS)) return null
    }
    // 行为分级文本（2026-09-10 用户定案「根据行为确定状态显示行文本」）：思考落盘/流式、工具结果刚回、
    // 段刚开 → 'think'「正在思考」；旁白已落盘、引擎产出下一动作（典型=生成 tool_use 参数 3~14s）
    // → 'generating'「正在生成」。
    return s.lastStep === 'text' ? 'generating' : 'think'
  }
  // 状态行文案（唯一映射源，2026-09-11 并发复合态定案）：join=false = 独立状态行全称
  // （正在思考/正在生成/正在压缩会话中……）；join=true = 并发尾缀，接在「正在运行：<工具> · <detail>」
  // 之后成同一行同一句（用户原话「思考和搜索同时进行就显示正在搜索xxx并思考」）。
  // 文案经 data-label 落到 DOM，live.js tick 只读该字段补计时，不在第二处复刻 mode→label 映射。
  function vacuumLabel(mode, join) {
    if (mode === 'compact') return join ? '并压缩中' : '正在压缩会话中……'
    if (mode === 'generating') return join ? '并生成' : '正在生成'
    return join ? '并思考' : '正在思考'
  }
  // 僵死/断连红标阈值：引擎最后产出（turn-beat）落后该秒数 = 无产出（live.js tick / approval.js
  // claimTick 同基准，两处共用本常量，不再各写 150）。
  const STALE_SEC = 150
  // 红标文案（唯一构造源，两处 tick 共用）。【2026-09-11 单状态槽定案】用户定案「一次应该只有一个
  // 状态，现在是无响应，应该只有无响应」——红标不再是状态文字旁的**注解**（旧形态前置分隔符「·」，
  // 与状态文字并排 ⇒ 实测出现「正在思考 · 2m57s · 无响应 2m51s」两个状态同时在场），而是状态槽的
  // **唯一占用者**：有红标时调用方给宿主状态行挂 .is-flagged（styles.css 隐去同行 .think-state/
  // .think-stream），故文案不带前导「·」。优先级：连接中断（链路断，一切产出不可信）> 无响应（链路
  // 活而引擎无产出）。staleSec<=0 = 本帧无僵死判定（调用方按各自豁免规则传 0：审批等待/工具在飞）。
  function statusFlags(connUp, staleSec) {
    return (connUp ? '' : '<span class="d-stale">连接中断</span>')
      + (staleSec >= STALE_SEC ? '<span class="d-stale">无响应 ' + fmtDur(staleSec) + '</span>' : '')
  }
  // 实时（处理中）段体（2026-08-26 用户定案：一个工具调用轮次只渲染一个工具折叠行）：
  // 有工具在运行 → summary 显示「正在运行：<当前工具>」+ 光泽扫动，点开看全部工具步明细
  // （已完成行 + 当前运行行）；全部完成 → 折叠概括（与已处理段同形态）。
  // 【状态显示行落位（2026-09-09 用户定案两轮：①「折叠顶只留正在处理/已处理，状态标识
  // 与工具调用行在一起」；②二轮澄清「工具调用行本质=折叠体，子 DOM 分两类——tf-label 工具
  // 概括留存；正在思考/压缩/断连等标识显示动画但不留存」）】：状态显示行 .fold-state（扫光
  // 文字 + data-ts 起点，bindLiveFoldTimer 每秒原地补「· Ns」，流式预览/无响应红标同层）并入
  // 尾部工具折叠行 summary——四轮定案（2026-09-09）真空态并入时折叠顶只留状态显示行、不带已处理
  // 概括（「正在思考时不应再有『运行了命令（N）』」，两状态同行并存=图二实测反例；工具明细
  // 点开折叠仍在）；无状态并入时 summary=toolFoldLabel——单宿主单实例，不复现
  // 09-08 前双轨（尾组 label 原位替换+独立兜底行）的随机命中；折叠顶 summary 恒「正在处理」
  // 不轮转（v267 的 summary 轮转方案废弃）。
  // 思考永不独立成行（if (it.kind === 'think') continue）。引导气泡（kind 'guide'）按非 tool
  // 项原样穿插，打断工具组时组照常收口。
  function liveFoldBody(items, vacuumState, vacuumStart) {
    let html = ''
    let tools = []
    // 状态显示行并入走构造期拼接（2026-09-09 三轮根治）：stateAppend 仅循环后那次
    // flushTools 生效（旁白打断的收口组不带）；v275 的 sumEnd 字符偏移回切废弃——偏移漏算
    // `<details class="tool-fold"><summary>` 前缀 33 字符，插入点前错 33 字符把
    // <span class="tf-label"> 切碎成 `pan class="tf-label">` 纯文本漏出。
    let stateAppend = ''
    let stateMerged = false
    // 状态显示行原子件（唯一构造点）：join=false + withIcon=true → 独立状态行（行首图标槽）；
    // join=true → 并发尾缀，无独立图标（同一行已有工具图标，避免第二个图标槽=视觉堆叠）。
    const stateSpan = (join, withIcon) => {
      const label = vacuumLabel(vacuumState, join)
      return `<span class="think-state${join ? ' ts-join' : ''}" data-ts="${vacuumStart || ''}" data-mode="${vacuumState}" data-label="${esc(label)}">${withIcon ? `<span class="t-ico">${THINK_ICON}</span>` : ''}<span class="ts-text">${esc(label)}</span></span>`
    }
    const flushTools = (isTail) => {
      if (!tools.length) return
      const rows = tools.map((g) => (g.kind === 'tool' && g.done) ? g.html : toolCurHtml(g.block)).join('')
      const running = tools.filter((g) => g.kind === 'tool' && !g.done)
      let sumInner
      if (running.length) {
        // 并发复合态（2026-09-11 用户定案）：状态并入同一行成「正在运行：<工具> · <detail> 并思考」。
        // 旧并列实现把工具行与状态行当 summary 的两个 flex 兄弟，而行容器 .fold-state 是 flex:1 1 0
        // （flex-basis 0 + min-width 0）→ 尺寸只看剩余空间、不看内容：nowrap 的工具文本吃满整行后
        // .fold-state 只剩 ~0.8px，其内无 white-space 规则的短标签逐字换行成竖列（N×22px）→ summary
        // 撑成 ~90px 高的空灰块（受控浏览器实测 summary 716×90、.fold-state 0.8×88、字号 14px）。
        // 根治：唯一行容器 .fold-state 同时承载「运行行（可收缩，.tl-text 省略号收尾）+ 状态尾缀（原子）」，
        // 收缩压力落在工具文本上、尾缀恒完整 → 几何上不可能再出现逐字换行。
        const cur = toolMeta(running[running.length - 1].block)
        const runLine = `<span class="tool-line tool-running" data-name="${esc(cur.name)}"><span class="t-ico">${toolIcon(cur.name)}</span><span class="tl-text">正在运行：${esc(cur.zh)}${cur.detail ? ' · ' + esc(cur.detail) : ''}</span></span>`
        if (isTail && vacuumState) {
          sumInner = `<span class="fold-state">${runLine}${stateSpan(true, false)}</span>`
          stateAppend = '' // 已并入本行，防下方 ${stateAppend} 二次追加
          stateMerged = true
        } else {
          sumInner = runLine
        }
      } else if (stateAppend) {
        // 真空态（正在思考/生成/压缩）并入：折叠顶只留状态显示行、不带已处理概括（2026-09-09 四轮定案
        // 「正在思考时不应再有『运行了命令（N）』」，两状态同行并存=图二实测反例）；工具明细点开折叠仍在
        sumInner = ''
      } else {
        sumInner = `<span class="tf-label">${esc(toolFoldLabel(tools))}</span>`
      }
      html += `<details class="tool-fold"><summary>${sumInner}${stateAppend}</summary><div class="tool-fold-body">${rows}</div></details>`
      if (stateAppend) stateMerged = true
      stateAppend = ''
      tools = []
    }
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      if (!it || !it.html) continue // 占位/置空的块（reply 占位、被过滤的思考）
      if (it.kind === 'think') continue // 思考永不独立成行（真空态=工具行内 .fold-state 状态显示行）
      if (it.kind === 'tool') { tools.push(it); continue } // 完成/运行中的工具都进当前组 → 统一成一个折叠行
      flushTools(false) // 中途被旁白/文本/引导气泡打断的工具组按普通折叠收口（非段尾，不并状态行）
      html += it.html
    }
    // 状态显示行（真空态；2026-09-09 二轮定案：工具调用行=折叠体，tf-label 留存、状态标识暂态不
    // 留存）：有尾部工具组 → .fold-state 暂态层构造期并入其 summary（label 后同一行）；
    // 尾部无工具组（纯思考真空/末尾是旁白）→ 段尾独立行。计时起点=段内最后一条落盘记录时刻。
    let stateInner = ''
    if (vacuumState) {
      // 行首图标槽（2026-09-11 用户定案）：独立状态行与工具行共享同一行首几何（16px 槽 + 5px gap，
      // 图标复用 DSH IconThinkOutline14 原子图标）——同一宿主行在「正在运行：<工具>」⇄「正在思考/
      // 生成/压缩」之间切换时文字左缘零位移（此前状态行无槽，文字回跳 21px = 用户实测「跳动」）。
      // 文本另置 .ts-text 子节点：live.js tick 只更新该节点（整节点 textContent 会连图标槽一起
      // 洗掉 → 槽消失、回跳依旧）。
      stateInner = stateSpan(false, true)
      stateAppend = `<span class="fold-state">${stateInner}</span>`
    }
    // 尾部工具组恒收口（2026-09-10 根治）：旧实现 flushTools() 只写在 vacuumState 分支内，而当时的
    // 判定式含 `!pendingTools.length`（工具在飞恒假）→ vacuumState=null → 该分支不进 → 尾部工具组
    // 整组不产出（无中断项调 flushTools）。实证（受控浏览器页面自采样，前台 Bash 20s 窗口）：
    // .tool-running=0、.tool-fold 数恒定不长、状态行亦空 → 处理中段体整段空白；工具结果
    // 回来那一帧才借真空态 flush 长出折叠行 = 用户实测「工具行只在跑完后才出现 / read、search 更是
    // 根本没有」。收口后 flushTools 内 running 分支（`正在运行：<工具>`）成为可达出口——正是术语
    // 定案里「状态行 = 正在思考/正在生成/正在压缩/正在运行:工具」的一次性实时动画位。不变量：
    // 处理中段的尾部工具组恒有渲染出口，段体空白只允许发生在「无工具且无真空态」的瞬态。
    // 2026-09-11 并发复合态：vacuumState 与 pendingTools 解耦后，「有工具在飞 + 引擎仍在产出」时
    // stateAppend 非空，且被尾组 running 分支取走、并成一行一句（见上方 running 分支注）——
    // 尾组无运行行时 stateAppend 仍走下面普通并存路径（`${sumInner}${stateAppend}`）。
    flushTools(true)
    if (vacuumState && !stateMerged) html += `<div class="fold-state">${stateInner}</div>`
    return html
  }
  // 当前正在运行的工具步（实时段专用）：复用原灰色工具行（tool-line）的 inline 形态，仅加 .tool-running
  // 光泽扫动标识运行态（无蓝点、无 <details> 提示行、无输入 JSON，用户 2026-08-26 定案）。
  function toolCurHtml(block) {
    const t = toolMeta(block)
    return `<span class="tool-line tool-running" data-name="${esc(t.name)}"><span class="t-ico">${toolIcon(t.name)}</span><span class="tl-text">${esc(t.zh)}${t.detail ? ' · ' + esc(t.detail) : ''}</span></span>`
  }

  // ---- 文件变更汇总卡片（Codex 风格：+N 绿 / -N 红）----
  // 数据源（2026-08-23 起）：源码 conversationDisplay.ts 在 tool_result 块上输出结构化
  // fileChange {filePath, added, removed}（权威数字 = 源码 diff.ts sumLinesChanged，由
  // Edit/Write 工具写入文本后缀 `(+N -M)`），前端直接消费字段。
  // parseFileChange 正则反解仅作旧网关/离线数据兜底，新 exe 部署后可删。
  function baseName(p) {
    const s = String(p || '').replace(/\\/g, '/')
    return s.split('/').pop() || s
  }
  // 相对启动根路径显示（2026-08-29）：路径在会话启动根（sessionCwd）下 → 剥前缀显示相对路径
  // （如 src/gateway/web/app.js）；不在根下/未知 cwd → 回退文件名。仅显示层，聚合 key 仍用绝对路径。
  function relFromCwd(p) {
    const norm = String(p || '').replace(/\\/g, '/')
    const root = String(sessionCwd || '').replace(/\\/g, '/').replace(/\/+$/, '') + '/'
    if (root.length > 1 && norm.toLowerCase().startsWith(root.toLowerCase())) {
      return norm.slice(root.length) || baseName(norm)
    }
    return baseName(norm)
  }
  // 从 tool_result 文本提取文件路径与增删行数（Edit/Write 统一格式）——旧网关兜底
  function parseFileChange(text) {
    if (!text) return null
    const t = String(text).trim()
    const m = /\([+-](\d+)\s*[+-](\d+)\)\s*\.?\s*$/.exec(t)
    if (!m) return null
    let path = null
    const fm = /The file\s+(.+?)\s+has been updated/.exec(t)
    if (fm) path = fm[1]
    else {
      const cm = /File created successfully at:\s+(.+?)\s*\(/.exec(t)
      if (cm) path = cm[1]
    }
    if (!path) return null
    return { path: path.trim(), added: Number(m[1]), removed: Number(m[2]) }
  }
  // 归一化为聚合用的 {path, added, removed} 形态（结构化 fileChange 用 filePath 命名）
  function normalizeFileChange(fc) {
    if (!fc) return null
    if (fc.path != null) return { path: fc.path, added: fc.added || 0, removed: fc.removed || 0 }
    if (fc.filePath != null) return { path: fc.filePath, added: fc.added || 0, removed: fc.removed || 0 }
    return null
  }
  function mergeChanges(map, fc) {
    const prev = map.get(fc.path)
    map.set(fc.path, prev ? { added: prev.added + fc.added, removed: prev.removed + fc.removed } : { added: fc.added, removed: fc.removed })
  }
  function renderChangeCardHtml(changes, key) {
    if (!changes || !changes.size) return ''
    let totalAdd = 0, totalDel = 0
    let rows = ''
    for (const [path, c] of changes) {
      totalAdd += c.added
      totalDel += c.removed
      rows += `<div class="ch-row"><span class="ch-file">${esc(relFromCwd(path))}</span><span class="ch-add">+${c.added}</span><span class="ch-del">-${c.removed}</span></div>`
    }
    // 2026-08-19 默认折叠：卡片落地即为收起姿态（标题行 + ▸），点右上角展开文件列表
    // 2026-08-26：key 可选（messagesHtml 段尾传入 s.key）→ 带 data-m/data-t 供增量重建定位删除；
    // 实时 commitLiveChangeCard 不带 key（无 data-m，属消息流外手动追加，不受增量删除影响）
    return `<div class="msg change-card collapsed"${key != null ? ` data-m="${key}" data-t="c"` : ''}><div class="ch-title"><span class="ch-count">${changes.size}个文件已更改</span><span class="ch-add">+${totalAdd}</span><span class="ch-del">-${totalDel}</span><button class="ch-toggle" title="收起/展开文件列表">${CHEV}</button></div><div class="ch-list">${rows}</div></div>`
  }

  // ---- 文件变更汇总卡片：历史/实时统一由 messagesHtml 段尾 seg.changes 数据驱动渲染
  //     （从 transcript 的 tool_result.fileChange 重建，切会话/刷新不丢）。原 WS out 实时内联行/
  //     commitLiveChangeCard 链随 WS out 流退役删除（网关从不投递 out，2026-09-07 定案）----
  // 卡片右上角隐藏按钮：点击切换列表收起/展开（事件委托，innerHTML 重建不受影响）
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.ch-toggle') : null
    if (!btn || !messagesEl.contains(btn)) return
    const card = btn.closest('.change-card')
    if (!card) return
    const collapsed = card.classList.toggle('collapsed')
    btn.innerHTML = CHEV
    btn.classList.toggle('open', !collapsed)
  })

  // 消息复制（DSH MessageIconActions copy 语义）：取消息纯文本（剔除已处理折叠/变更卡/操作行/工具折叠），
  // writeClipboard 成功 → 图标换 check 1s（DSH 同款反馈窗口），失败 toast
  function messageCopyText(msgEl) {
    const clone = msgEl.cloneNode(true)
    clone.querySelectorAll('.done-fold, .change-card, .msg-actions, .tool-fold, .mention-x, script, style').forEach((el) => el.remove())
    return (clone.textContent || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  }
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.msg-copy') : null
    if (!btn || !messagesEl.contains(btn) || btn.classList.contains('copied')) return
    const msgEl = btn.closest('.msg')
    if (!msgEl) return
    const text = messageCopyText(msgEl)
    if (!text) return
    writeClipboard(text).then((ok) => {
      if (!ok) { toast('复制失败'); return }
      btn.classList.add('copied')
      btn.innerHTML = I.dshCheck
      btn.title = '已复制'
      btn.setAttribute('aria-label', '已复制')
      setTimeout(() => {
        if (!btn.isConnected) return
        btn.classList.remove('copied')
        btn.innerHTML = ICON_COPY
        btn.title = '复制'
        btn.setAttribute('aria-label', '复制')
      }, 1000)
    })
  })

  // 压缩/自动摘要标记：转录里压缩会把「会话续接」记成 user|text（后端已映射 role:'system'，
  // 标签「会话续接（自动摘要）」）。命中它 = 当前回合被压缩打断，但 agent 仍在干活——
  // 不应把它当成回合结束，否则「正在处理」被强收成「已处理」、后续思考/工具拆成断开的新段。
  // ⚠️ 存活代码勿删（2026-08-27 P2 复核纠正审查报告§C 结论）：shouldShowUserMessage 只剔 isMeta，
  // 而 isCompactSummary 续接记录不带 isMeta、conversationDisplay 亦无专门剔除 → 经网关 display /
  // 磁盘兜底同样以 role:'user' 到达前端；处理中命中即驱动 liveFoldBody 真空态「正在压缩会话中……」行，
  // 已收尾时静默吞行。英/中双正则分别兜官方原文与离线标签两种形态。
  const CONTINUED_RE = /This session is being continued from a previous conversation/i
  function isContinuationMsg(m) {
    if (m.role !== 'system' && m.role !== 'user') return false
    return m.blocks.some((b) => b.kind === 'text' && (CONTINUED_RE.test(b.text) || b.text.includes('会话续接')))
  }

  // 真实用户消息（带文本/图片，非纯工具回包）：开新段/新回合检测/处理中计时共用。
  // 合成 user（后台任务通知/对话中断等）已由源码 shouldShowUserMessage 剔除（A/B 路径）、
  // 离线路径由 server.mjs readSession 映射为 role:'system'（C 路径）——前端无需再判系统注入
  // 文本（isSynthText/SYNTH_RE 已于 2026-08-23 删除，见交接文档任务 1）。
  function isRealUser(m) {
    if (m.role !== 'user') return false
    return m.blocks.some((b) => (b.kind === 'text' && b.text && b.text.trim()) || b.kind === 'image')
  }

  // 回合终止性 stopReason（2026-08-31）：官方 end_turn 之外，第三方商正常终止可能返回
  // 'stop_sequence'（CLI 未配置 stop_sequence 参数，纯文本回复即自然结束；jsonl 实证其后无
  // assistant 记录 = CLI 已按回合结束收尾）。只认 end_turn 会把这类已完成的回合刷新后误判
  // 「正在处理」重新计时、回复沉进折叠体（实测 2471f361/6f1f48fb）。'tool_use'/null 仍=处理中。
  function isEndStop(sr) {
    return sr === 'end_turn' || sr === 'stop_sequence'
  }

  // 用户气泡正文（2026-08-30 图片渲染，用户定案：图在气泡外）：
  // 带 imageId 的 image 块 → 气泡只出文本（剥掉文本里已渲染图的 [Image #N] 占位），
  // 图由 userImgsHtml 渲染在气泡框外；字节走网关 GET /gateway/image-cache/<会话uuid>/<id>
  // （复用 CLI processUserInput storeImages 落盘的 image-cache，display JSON 不塞 base64）。
  // 无 imageId（旧记录）→ 回落 [图片] 占位/纯文本；图已落盘后被清（会话重启
  // cleanupOldImageCaches 清非当前会话缓存）→ userImgsHtml onerror 出 [Image #N] 裸文本。
  function userBodyHtml(m) {
    const ids = []
    for (const b of m.blocks) if (b.kind === 'image' && b.imageId) ids.push(b.imageId)
    const txt = m.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('')
    if (ids.length) {
      const stripped = txt.replace(new RegExp('\\s*\\[Image #(' + ids.join('|') + ')\\]', 'g'), '')
      return mdHtml(stripped)
    }
    const hasImg = m.blocks.some((b) => b.kind === 'image')
    return mdHtml(hasImg && !txt ? '[图片]' : txt)
  }

  // 图片容器（用户 2026-08-30 定案：渲染在气泡外）：.msg 内、.body 后——.msg 无背景，
  // 视觉即气泡正下方右侧。图未落盘（404）→ onerror 替换为 [Image #N] 裸文本，不出破图
  //（用户定案「会话重启后图片不留盘，就仅渲染裸文本就好了」）。
  function userImgsHtml(m) {
    const ids = []
    for (const b of m.blocks) if (b.kind === 'image' && b.imageId) ids.push(b.imageId)
    if (!ids.length) return ''
    const imgs = ids.map((id) => `<img class="msg-img" loading="lazy" alt="图片" data-ph="[Image #${id}]" onerror="this.replaceWith(document.createTextNode(this.dataset.ph))" src="/gateway/image-cache/${live.curUuid || ''}/${id}">`).join('')
    return `<div class="msg-imgs">${imgs}</div>`
  }

  // 大图预览 lightbox（2026-08-30 用户定案：单击缩略图看大图）：单例覆盖层，
  // src 复用缩略图同 URL（网关 Cache-Control private 1d，字节已缓存零请求）；
  // 点击任意处 / Esc 关闭。事件委托 document 级绑一次，覆盖历史/实时/SSE 全渲染路径。
  function ensureLightbox() {
    let lb = document.getElementById('img-lightbox')
    if (lb) return lb
    lb = document.createElement('div')
    lb.id = 'img-lightbox'
    lb.innerHTML = '<img alt="大图预览">'
    lb.addEventListener('click', () => lb.classList.remove('on'))
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') lb.classList.remove('on') })
    document.body.appendChild(lb)
    return lb
  }
  document.addEventListener('click', (e) => {
    const im = e.target.closest && e.target.closest('.msg-img')
    if (!im) return
    const lb = ensureLightbox()
    lb.querySelector('img').src = im.currentSrc || im.src
    lb.classList.add('on')
  })

  // 已处理时长：10m 50s 风格
  function fmtDur(sec) {
    if (!(sec > 0)) return ''
    if (sec < 60) return sec + 's'
    const m = Math.floor(sec / 60)
    const s = sec % 60
    if (m < 60) return s ? m + 'm ' + s + 's' : m + 'm'
    const h = Math.floor(m / 60)
    return h + 'h ' + (m % 60) + 'm'
  }

  // 思考/旁白文本：无气泡框，浅灰小字（收在「已处理」折叠区内）
  function processTextHtml(text) {
    return `<div class="done-think">${mdHtml(text)}</div>`
  }

  // ---- 思考折叠行（2026-08-22 移植 deepseek-harness ReasoningRow / DisclosureRow）----
  // 每个思考块 = 一条可展开折叠行：14px 思考图标 + 「思考」标题 + 2×2 圆点 + 摘要
  // （已结束=首行 / 运行中=末行实时跟随），展开正文 14/24 弱化色、左缩进 22px，运行中扫光动画。
  // 图标 path 精确取自 deepseek-harness packages/client/ui-primitives/src/icons/index.tsx
  // （IconThinkOutline14 / IconChevronDownOutline14，fill=currentColor 随父级）。
  const THINK_ICON = '<svg viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M7.06431 5.93342C7.68763 5.93342 8.19307 6.43904 8.19322 7.06233C8.19322 7.68573 7.68772 8.19123 7.06431 8.19123C6.44099 8.19113 5.9354 7.68567 5.9354 7.06233C5.93555 6.43911 6.44108 5.93353 7.06431 5.93342Z" fill="currentColor"/><path fill-rule="evenodd" clip-rule="evenodd" d="M8.6815 0.963693C10.1169 0.447019 11.6266 0.374829 12.5633 1.31135C13.5 2.24805 13.4277 3.75776 12.911 5.19319C12.7126 5.74431 12.4386 6.31796 12.0965 6.89729C12.4969 7.54638 12.8141 8.19018 13.036 8.80647C13.5527 10.2419 13.6251 11.7516 12.6883 12.6883C11.7516 13.625 10.242 13.5527 8.8065 13.036C8.19022 12.8141 7.54641 12.4969 6.89732 12.0965C6.31797 12.4386 5.74435 12.7125 5.19322 12.911C3.75777 13.4276 2.2481 13.5 1.31138 12.5633C0.374859 11.6266 0.447049 10.1168 0.963724 8.68147C1.17185 8.10338 1.46321 7.50063 1.82896 6.8924C1.52182 6.35711 1.27235 5.82825 1.08872 5.31819C0.572068 3.88278 0.499714 2.37306 1.43638 1.43635C2.37308 0.499655 3.8828 0.572044 5.31822 1.08869C5.82828 1.27232 6.35715 1.5218 6.89243 1.82893C7.50066 1.46318 8.10341 1.17181 8.6815 0.963693ZM11.3573 8.01154C10.9083 8.62253 10.3901 9.22873 9.80943 9.8094C9.22877 10.3901 8.62255 10.9083 8.01158 11.3572C8.4257 11.5841 8.8287 11.7688 9.21275 11.9071C10.5456 12.3868 11.4246 12.2547 11.8397 11.8397C12.2548 11.4246 12.3869 10.5456 11.9071 9.21272C11.7688 8.82866 11.5841 8.42568 11.3573 8.01154ZM2.56529 8.02912C2.37344 8.39322 2.21495 8.74796 2.09263 9.08772C1.61291 10.4204 1.74512 11.2995 2.16001 11.7147C2.57505 12.1297 3.45415 12.2618 4.78697 11.7821C5.11057 11.6656 5.44786 11.5164 5.7938 11.3367C5.249 10.9223 4.70922 10.4533 4.19029 9.9344C3.57578 9.31987 3.03169 8.67633 2.56529 8.02912ZM6.90708 3.2469C6.24065 3.70479 5.5646 4.26321 4.91392 4.91389C4.26325 5.56456 3.70482 6.24063 3.24693 6.90705C3.72674 7.63325 4.32777 8.37459 5.03892 9.08576C5.64943 9.69627 6.28183 10.2265 6.90806 10.6678C7.59368 10.2025 8.2908 9.63076 8.96079 8.96076C9.6308 8.29075 10.2025 7.59366 10.6678 6.90803C10.2265 6.2818 9.69631 5.6494 9.08579 5.03889C8.37462 4.32773 7.63328 3.72672 6.90708 3.2469ZM11.7147 2.15998C11.2996 1.74509 10.4204 1.61288 9.08775 2.0926C8.74835 2.21479 8.39382 2.37271 8.03013 2.56428C8.67728 3.03065 9.31995 3.5758 9.93443 4.19026C10.4534 4.7092 10.9223 5.24896 11.3368 5.79377C11.5164 5.44785 11.6656 5.11052 11.7821 4.78694C12.2618 3.45416 12.1297 2.57502 11.7147 2.15998ZM4.91197 2.2176C3.57922 1.73788 2.70004 1.86995 2.28501 2.28498C1.87001 2.70003 1.73791 3.5792 2.21763 4.91194C2.31709 5.18822 2.44112 5.47427 2.58677 5.7674C3.01931 5.1887 3.51474 4.6158 4.06529 4.06526C4.61584 3.5147 5.18872 3.01928 5.76743 2.58674C5.47431 2.4411 5.18824 2.31706 4.91197 2.2176Z" fill="currentColor"/></svg>'
  const THINK_CHEV = '<svg viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z" fill="currentColor"/></svg>'
  // ---- 折叠 chevron（DSH IconChevronRightOutline14，「>」箭头，替换旧 ▸ 小三角）----
  const CHEV = '<svg viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M5.5 2.15137L5.92383 2.57617L8.65137 5.30273C8.90706 5.55843 9.13382 5.78438 9.29785 5.98828C9.46883 6.20088 9.61756 6.44405 9.66602 6.75C9.69222 6.91565 9.69222 7.08435 9.66602 7.25C9.61756 7.55595 9.46883 7.79912 9.29785 8.01172C9.13382 8.21561 8.90706 8.44157 8.65137 8.69727L5.92383 11.4238L5.5 11.8486L4.65137 11L5.07617 10.5762L7.80273 7.84863C8.07732 7.57405 8.24849 7.40124 8.3623 7.25977C8.46904 7.12709 8.47813 7.07728 8.48047 7.0625C8.48703 7.02105 8.48703 6.97895 8.48047 6.9375C8.47813 6.92272 8.46904 6.87291 8.3623 6.74023C8.24848 6.59876 8.07732 6.42595 7.80273 6.15137L5.07617 3.42383L4.65137 3L5.5 2.15137Z" fill="currentColor"/></svg>'

  // ---- 工具步骤图标（2026-08-21 移植 deepseek-harness ui-tool 的 variant leading 映射，
  // path 精确取自 ui-primitives/icons/index.tsx，fill=currentColor 随父级；替代旧 ⚙ 齿轮）----
  const ICON_BROWSE = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11.2426 4.80473V6.10551H4.75819V4.80473H11.2426Z" fill="currentColor"/><path d="M9.40858 7.84478V9.14557H4.75819V7.84478H9.40858Z" fill="currentColor"/><path d="M9.23438 0.546389C10.1941 0.546389 10.9683 0.544914 11.5859 0.611819C12.2161 0.680096 12.7634 0.825745 13.2393 1.17139C13.5172 1.3733 13.7619 1.61812 13.9639 1.896C14.3096 2.37183 14.4551 2.91922 14.5234 3.54932C14.5903 4.16686 14.5889 4.94133 14.5889 5.90088V10.0981C14.5889 11.0576 14.5903 11.8321 14.5234 12.4497C14.4552 13.0798 14.3094 13.6272 13.9639 14.103C13.7619 14.381 13.5172 14.6257 13.2393 14.8276C12.7633 15.1734 12.2163 15.3189 11.5859 15.3872C10.9683 15.4541 10.1942 15.4536 9.23438 15.4536H6.76563C5.80591 15.4536 5.03168 15.4541 4.41407 15.3872C3.78385 15.3189 3.23665 15.1734 2.76074 14.8276C2.48291 14.6257 2.23802 14.3809 2.03614 14.103C1.69066 13.6272 1.54483 13.0798 1.47657 12.4497C1.40973 11.8321 1.41114 11.0576 1.41114 10.0981V5.90088C1.41113 4.94132 1.40966 4.16686 1.47657 3.54932C1.54488 2.91921 1.69042 2.37184 2.03614 1.896C2.2381 1.61807 2.4828 1.37333 2.76074 1.17139C3.23665 0.825682 3.78386 0.680109 4.41407 0.611819C5.03168 0.544905 5.80591 0.546389 6.76563 0.546389H9.23438ZM6.76563 1.896C5.77586 1.896 5.0876 1.89738 4.55957 1.95459C4.0443 2.01043 3.76214 2.11349 3.55469 2.26416C3.39135 2.38284 3.24761 2.52662 3.12891 2.68994C2.97821 2.89736 2.8752 3.17967 2.81934 3.69483C2.76214 4.22279 2.76075 4.91131 2.76074 5.90088V10.0981C2.76074 11.0876 2.76221 11.7762 2.81934 12.3042C2.87516 12.8194 2.97829 13.1026 3.12891 13.3101C3.24754 13.4733 3.39147 13.6172 3.55469 13.7358C3.76213 13.8865 4.04438 13.9896 4.55957 14.0454C5.0876 14.1026 5.77586 14.103 6.76563 14.103H9.23438C10.2242 14.103 10.9124 14.1026 11.4404 14.0454C11.9556 13.9896 12.2379 13.8865 12.4453 13.7358C12.6086 13.6172 12.7525 13.4733 12.8711 13.3101C13.0217 13.1026 13.1248 12.8195 13.1807 12.3042C13.2378 11.7762 13.2393 11.0876 13.2393 10.0981V5.90088C13.2393 4.91131 13.2379 4.22279 13.1807 3.69483C13.1248 3.17969 13.0218 2.89736 12.8711 2.68994C12.7524 2.52667 12.6086 2.38281 12.4453 2.26416C12.2379 2.11355 11.9556 2.01041 11.4404 1.95459C10.9124 1.8974 10.2241 1.896 9.23438 1.896H6.76563Z" fill="currentColor"/></svg>'
  const ICON_EDIT = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.94076 1.34942C10.7047 0.90231 11.6503 0.902415 12.4143 1.34942C12.7061 1.52015 12.9688 1.79118 13.3104 2.13284C13.6521 2.47448 13.9231 2.73721 14.0939 3.02894C14.5408 3.79294 14.5409 4.73856 14.0939 5.50251C13.9231 5.79415 13.652 6.05704 13.3104 6.39861L6.65932 13.0497C6.28068 13.4284 6.00695 13.7108 5.66543 13.9097C5.32391 14.1085 4.94315 14.2074 4.42705 14.3498L3.24394 14.6761C2.77527 14.8054 2.34538 14.9262 2.00131 14.9684C1.65196 15.0112 1.17964 15.0013 0.810764 14.6325C0.441921 14.2637 0.432107 13.7913 0.47486 13.442C0.517035 13.0979 0.6379 12.668 0.767181 12.1993L1.09352 11.0162C1.23588 10.5001 1.33481 10.1193 1.5336 9.77784C1.7325 9.43632 2.0149 9.1626 2.39355 8.78395L9.04466 2.13284C9.38625 1.79126 9.64911 1.52016 9.94076 1.34942ZM15.5427 14.8398H7.55223L8.96707 13.425H15.5427V14.8398ZM3.39382 9.78422C2.965 10.213 2.84244 10.3436 2.75709 10.49C2.67183 10.6366 2.61862 10.8079 2.45733 11.3925L2.13099 12.5756C2.00183 13.0439 1.92194 13.3419 1.88863 13.5536C2.10041 13.5204 2.39872 13.4416 2.86764 13.3123L4.05075 12.9859C4.63544 12.8246 4.80669 12.7715 4.95323 12.6862C5.09968 12.6008 5.23022 12.4783 5.65905 12.0494L10.721 6.98644L8.45577 4.72121L3.39382 9.78422ZM11.7 2.57079C11.3774 2.38198 10.9777 2.38198 10.6551 2.57079C10.5602 2.62647 10.4487 2.72931 10.0449 3.13311L9.45604 3.72094L11.7213 5.98617L12.3102 5.39833C12.7139 4.99457 12.8168 4.88307 12.8725 4.78818C13.0613 4.46561 13.0612 4.06585 12.8725 3.74326C12.8169 3.64827 12.7146 3.53752 12.3102 3.13311C11.9057 2.72863 11.795 2.6264 11.7 2.57079Z" fill="currentColor"/></svg>'
  const ICON_SEARCH = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11.894845 6.647401C11.894845 3.725463 9.534486 1.356779 6.623219 1.35657C3.711786 1.35657 1.351635 3.725338 1.351635 6.647401C1.351843 9.569296 3.711911 11.938273 6.623219 11.938273C9.534361 11.938064 11.894637 9.569171 11.894845 6.647401ZM13.245462 6.647401C13.245254 10.317935 10.280401 13.293613 6.623219 13.293821C2.965871 13.293821 0.000204 10.31806 0 6.647401C0 2.976574 2.965746 0 6.623219 0C10.280526 0.000205 13.245462 2.9767 13.245462 6.647401Z" fill="currentColor"/><path d="M16.000417 15.041079L15.044449 16.000433L11.530434 12.473588L12.486298 11.514234L16.000417 15.041079Z" fill="currentColor"/></svg>'
  const ICON_API = '<svg viewBox="0 0 14 14" fill="none" aria-hidden="true"><path transform="translate(0.6689 1.073)" d="M11.4818 5.57813C11.4818 4.45301 11.4807 3.66237 11.4075 3.05908C11.3359 2.46953 11.2024 2.13852 10.9939 1.89441C10.9247 1.81341 10.8493 1.73801 10.7683 1.66882C10.5242 1.46033 10.1932 1.32686 9.60364 1.25525C9.00034 1.18198 8.20974 1.18091 7.0846 1.18091L5.57813 1.18091C4.45301 1.18091 3.66238 1.18198 3.05908 1.25525C2.46953 1.32686 2.13852 1.46033 1.89441 1.66882C1.81341 1.73801 1.73801 1.81341 1.66882 1.89441C1.46033 2.13852 1.32686 2.46953 1.25525 3.05908C1.18198 3.66238 1.18091 4.45301 1.18091 5.57813L1.18091 6.2771C1.18091 7.40218 1.18197 8.19288 1.25525 8.79614C1.32687 9.38553 1.46036 9.71674 1.66882 9.96082C1.73797 10.0417 1.81347 10.1173 1.89441 10.1864C2.13851 10.3948 2.46965 10.5275 3.05908 10.5991C3.66238 10.6724 4.45298 10.6735 5.57813 10.6735L7.0846 10.6735C8.20977 10.6735 9.00033 10.6724 9.60364 10.5991C10.1931 10.5275 10.5242 10.3948 10.7683 10.1864C10.8493 10.1173 10.9247 10.0417 10.9939 9.96082C11.2024 9.71674 11.3358 9.38553 11.4075 8.79614C11.4808 8.19288 11.4818 7.40218 11.4818 6.2771L11.4818 5.57813ZM12.6627 6.2771C12.6627 7.37222 12.6637 8.247 12.5798 8.93799C12.4942 9.64284 12.3133 10.2359 11.8928 10.7282C11.7834 10.8562 11.6637 10.9751 11.5356 11.0845C11.0434 11.5049 10.4511 11.6867 9.74634 11.7723C9.05525 11.8563 8.17999 11.8552 7.0846 11.8552L5.57813 11.8552C4.48273 11.8552 3.60747 11.8563 2.91638 11.7723C2.21157 11.6867 1.61933 11.5049 1.12708 11.0845C0.99901 10.9751 0.879281 10.8562 0.769898 10.7282C0.349454 10.2359 0.168506 9.64284 0.0828864 8.93799C-0.00101964 8.247 4.88512e-07 7.37222 6.47206e-07 6.2771L6.47206e-07 5.57813C6.47206e-07 4.48273 -0.00106163 3.60747 0.0828864 2.91638C0.168502 2.21168 0.349594 1.61928 0.769898 1.12708C0.879302 0.998981 0.998981 0.879302 1.12708 0.769898C1.61928 0.349594 2.21168 0.168502 2.91638 0.0828864C3.60747 -0.00106163 4.48273 6.47206e-07 5.57813 6.47206e-07L7.0846 6.47206e-07C8.17999 6.47206e-07 9.05525 -0.00106163 9.74634 0.0828864C10.451 0.168505 11.0434 0.349587 11.5356 0.769898C11.6637 0.879302 11.7834 0.998981 11.8928 1.12708C12.3131 1.61928 12.4942 2.21169 12.5798 2.91638C12.6638 3.60747 12.6627 4.48273 12.6627 5.57813L12.6627 6.2771Z" fill="currentColor"/><path transform="translate(0.6689 1.073)" d="M6.02607 5.50955L6.44306 5.9274L3.84284 8.52762L3.425 8.11063L3.00715 7.69278L4.77253 5.9274L3.00715 4.16202L3.84284 3.32633L6.02607 5.50955Z" fill="currentColor"/><path transform="translate(0.6689 1.073)" d="M9.23789 7.35397L9.23789 8.53488L6.96238 8.53488L6.96238 7.35397L9.23789 7.35397Z" fill="currentColor"/></svg>'
  const ICON_GLOBE = '<svg viewBox="0 0 14 14" fill="none" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.00018 0.353516C10.6708 0.353535 13.6468 3.32958 13.6469 7.00018C13.6468 10.6708 10.6708 13.6468 7.00018 13.6469C3.32957 13.6468 0.353535 10.6708 0.353516 7.00018C0.353535 3.32957 3.32957 0.353531 7.00018 0.353516ZM5.44643 7.59661C5.49463 8.97506 5.70762 10.191 6.02136 11.0793C6.20141 11.5891 6.40328 11.9585 6.59898 12.1889C6.79501 12.4196 6.93213 12.454 7.00018 12.454C7.06822 12.454 7.20533 12.4197 7.40138 12.1889C7.59708 11.9585 7.79895 11.589 7.979 11.0793C8.29274 10.191 8.50574 8.97506 8.55394 7.59661H5.44643ZM1.57861 7.59661C1.80785 9.70467 3.2386 11.4509 5.1715 12.1388C5.07135 11.9317 4.97972 11.7098 4.89746 11.477C4.53084 10.4391 4.30224 9.0828 4.25357 7.59661H1.57861ZM9.74679 7.59661C9.69813 9.0828 9.46952 10.4391 9.1029 11.477C9.0206 11.7099 8.92818 11.9316 8.82797 12.1388C10.7613 11.4511 12.1925 9.70496 12.4218 7.59661H9.74679ZM5.1706 1.8616C3.23814 2.54963 1.80876 4.29604 1.5795 6.40376H4.25357C4.30224 4.91756 4.53083 3.56129 4.89746 2.5234C4.97968 2.29066 5.07051 2.0686 5.1706 1.8616ZM7.00018 1.54637C6.93213 1.54638 6.79503 1.5807 6.59898 1.81145C6.40332 2.04177 6.20139 2.41058 6.02136 2.92012C5.70754 3.80851 5.49461 5.02499 5.44643 6.40376H8.55394C8.50575 5.025 8.29282 3.80851 7.979 2.92012C7.79898 2.41059 7.59705 2.04177 7.40138 1.81145C7.20531 1.58067 7.06823 1.54637 7.00018 1.54637ZM8.82887 1.8616C8.92902 2.0687 9.02064 2.29053 9.1029 2.5234C9.46953 3.56129 9.69812 4.91756 9.74679 6.40376H12.4209C12.1916 4.29575 10.7618 2.54943 8.82887 1.8616Z" fill="currentColor"/></svg>'
  const ICON_CHECKLIST = '<svg viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M13.3277 9.69629V10.976H7.28086V9.69629H13.3277Z" fill="currentColor"/><path d="M13.3277 2.97256V4.25225H7.28086V2.97256H13.3277Z" fill="currentColor"/><path d="M4.64512 10.336C4.64505 9.62755 4.07081 9.05322 3.3623 9.05322C2.65386 9.05329 2.07956 9.62759 2.07949 10.336C2.07949 11.0445 2.65382 11.6188 3.3623 11.6188C4.07085 11.6188 4.64512 11.0446 4.64512 10.336ZM5.92559 10.336C5.92559 11.7515 4.77777 12.8993 3.3623 12.8993C1.94689 12.8993 0.799805 11.7515 0.799805 10.336C0.799871 8.92066 1.94693 7.7736 3.3623 7.77354C4.77773 7.77354 5.92552 8.92062 5.92559 10.336Z" fill="currentColor"/><path d="M4.64531 3.6123C4.6453 2.90382 4.07098 2.32949 3.3625 2.32949C2.65403 2.32951 2.0797 2.90383 2.07969 3.6123C2.07969 4.32079 2.65402 4.8951 3.3625 4.89512C4.07099 4.89512 4.64531 4.3208 4.64531 3.6123ZM5.925 3.6123C5.925 5.02772 4.77792 6.1748 3.3625 6.1748C1.9471 6.17479 0.8 5.02771 0.8 3.6123C0.800013 2.19691 1.9471 1.04982 3.3625 1.0498C4.77791 1.0498 5.92499 2.1969 5.925 3.6123Z" fill="currentColor"/></svg>'
  const ICON_SKILL = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M12.5113 15.4067C12.4395 15.6249 12.1308 15.6249 12.059 15.4067L11.643 14.1416C11.454 13.567 11.0033 13.1164 10.4288 12.9274L9.16369 12.5113C8.94544 12.4395 8.94544 12.1308 9.16369 12.059L10.4288 11.643C11.0033 11.454 11.454 11.0033 11.643 10.4288L12.059 9.16369C12.1308 8.94544 12.4395 8.94544 12.5113 9.16369L12.9274 10.4288C13.1164 11.0033 13.567 11.454 14.1416 11.643L15.4067 12.059C15.6249 12.1308 15.6249 12.4395 15.4067 12.5113L14.1416 12.9274C13.567 13.1164 13.1164 13.567 12.9274 14.1416L12.5113 15.4067Z" fill="currentColor"/><path d="M9.02246 0.546878C9.9822 0.546878 10.7564 0.545403 11.374 0.612307C12.0042 0.680586 12.5515 0.826244 13.0273 1.17188C13.3052 1.37376 13.5501 1.61868 13.752 1.89649C14.0975 2.37225 14.2432 2.91984 14.3115 3.54981C14.3784 4.16727 14.377 4.94206 14.377 5.90137V8.51367C13.9611 8.29533 13.5071 8.13985 13.0273 8.06055V5.90137C13.0273 4.9121 13.0259 4.22322 12.9688 3.69532C12.9129 3.18044 12.8098 2.89782 12.6592 2.69043C12.5406 2.52724 12.3966 2.38326 12.2334 2.26465C12.026 2.11404 11.7437 2.0109 11.2285 1.95508C10.7005 1.89789 10.0122 1.89649 9.02246 1.89649H6.55371C5.56395 1.89649 4.87569 1.89787 4.34766 1.95508C3.83242 2.01092 3.55022 2.11398 3.34278 2.26465C3.17953 2.38329 3.03564 2.52719 2.91699 2.69043C2.76642 2.89782 2.66325 3.18042 2.60742 3.69532C2.55027 4.22322 2.54883 4.9121 2.54883 5.90137V10.0986C2.54883 11.0878 2.55031 11.7768 2.60742 12.3047C2.66326 12.8196 2.76642 13.1032 2.91699 13.3105C3.03558 13.4736 3.17966 13.6178 3.34278 13.7363C3.5502 13.8869 3.83265 13.9901 4.34766 14.0459C4.87568 14.1031 5.56398 14.1035 6.55371 14.1035H8.08399C8.27443 14.6025 8.55077 15.0585 8.89551 15.4541H6.55371C5.59402 15.4541 4.81976 15.4546 4.20215 15.3877C3.57204 15.3194 3.02468 15.1738 2.54883 14.8281C2.27111 14.6263 2.02606 14.3813 1.82422 14.1035C1.47883 13.6278 1.33293 13.08 1.26465 12.4502C1.19783 11.8327 1.19922 11.0579 1.19922 10.0986V5.90137C1.19922 4.94206 1.1978 4.16727 1.26465 3.54981C1.33295 2.91984 1.47867 2.37225 1.82422 1.89649C2.02613 1.61864 2.27098 1.37379 2.54883 1.17188C3.02472 0.826181 3.57197 0.6806 4.20215 0.612307C4.81976 0.545393 5.594 0.546877 6.55371 0.546878H9.02246ZM9.19629 9.14649H4.5459V7.84571H9.19629V9.14649ZM11.0303 6.10645H4.5459V4.80567H11.0303V6.10645Z" fill="currentColor"/></svg>'
  const ICON_SPARKLE = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6.1 3.1Q6.6 7.8 11.3 8.3Q6.6 8.8 6.1 13.5Q5.6 8.8 0.9 8.3Q5.6 7.8 6.1 3.1Z" fill="currentColor"/><path d="M11.9 1Q12.2 3.7 14.9 4Q12.2 4.3 11.9 7Q11.6 4.3 8.9 4Q11.6 3.7 11.9 1Z" fill="currentColor"/><path d="M12.5 9.4Q12.7 11.4 14.7 11.6Q12.7 11.8 12.5 13.8Q12.3 11.8 10.3 11.6Q12.3 11.4 12.5 9.4Z" fill="currentColor"/></svg>'
  // 映射对齐 DSH ui-tool GenericToolCard variant leading：read→browse、write/edit→edit、search→search、
  // bash→api、web_search→globe（web_fetch→browse）、todo/task→checklist、skill→skill、其余（含 Agent）→sparkle
  const TOOL_ICONS = {
    Read: ICON_BROWSE, Edit: ICON_EDIT, Write: ICON_EDIT, NotebookEdit: ICON_EDIT,
    Grep: ICON_SEARCH, Glob: ICON_SEARCH, Bash: ICON_API,
    WebFetch: ICON_BROWSE, WebSearch: ICON_GLOBE,
    TaskCreate: ICON_CHECKLIST, TaskUpdate: ICON_CHECKLIST, TaskGet: ICON_CHECKLIST, TodoWrite: ICON_CHECKLIST,
    Skill: ICON_SKILL,
  }
  function toolIcon(name) { return TOOL_ICONS[name] || ICON_SPARKLE }

  // ---- 消息复制按钮（2026-08-21 移植 DSH MessageIconActions：28px 圆形图标钮，copy → check 1s 反馈。
  // path 取自 ui-primitives/icons IconCopyOutline16；成功对勾复用 I.dshCheck）----
  const ICON_COPY = '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6.14929 4.02032C7.11197 4.02032 7.87983 4.02016 8.49597 4.07598C9.12128 4.13269 9.65792 4.25188 10.1415 4.53106C10.7202 4.8653 11.2008 5.3459 11.535 5.92462C11.8142 6.40818 11.9334 6.94481 11.9901 7.57012C12.0459 8.18625 12.0458 8.95419 12.0458 9.9168C12.0458 10.8795 12.0459 11.6473 11.9901 12.2635C11.9334 12.8888 11.8142 13.4254 11.535 13.909C11.2008 14.4877 10.7202 14.9683 10.1415 15.3025C9.65792 15.5817 9.12128 15.7009 8.49597 15.7576C7.87984 15.8134 7.11196 15.8133 6.14929 15.8133C5.18667 15.8133 4.41874 15.8134 3.80261 15.7576C3.1773 15.7009 2.64067 15.5817 2.1571 15.3025C1.5784 14.9683 1.09778 14.4877 0.76355 13.909C0.484366 13.4254 0.365184 12.8888 0.308472 12.2635C0.252649 11.6473 0.252808 10.8795 0.252808 9.9168C0.252808 8.95418 0.252664 8.18625 0.308472 7.57012C0.365184 6.94481 0.484366 6.40818 0.76355 5.92462C1.09777 5.34589 1.57839 4.86529 2.1571 4.53106C2.64067 4.25188 3.1773 4.13269 3.80261 4.07598C4.41874 4.02017 5.18666 4.02032 6.14929 4.02032ZM6.14929 5.37774C5.16181 5.37774 4.46634 5.37761 3.92566 5.42657C3.39434 5.47472 3.07859 5.56574 2.83582 5.70587C2.4632 5.92106 2.15354 6.2307 1.93835 6.60333C1.79823 6.8461 1.70721 7.16185 1.65906 7.69317C1.6101 8.23385 1.61023 8.92933 1.61023 9.9168C1.61023 10.9043 1.61009 11.5998 1.65906 12.1404C1.70721 12.6717 1.79823 12.9875 1.93835 13.2303C2.15356 13.6029 2.46321 13.9126 2.83582 14.1277C3.07859 14.2679 3.39434 14.3589 3.92566 14.407C4.46634 14.456 5.16182 14.4559 6.14929 14.4559C7.13682 14.4559 7.83224 14.456 8.37292 14.407C8.90425 14.3589 9.21999 14.2679 9.46277 14.1277C9.83535 13.9126 10.145 13.6029 10.3602 13.2303C10.5004 12.9875 10.5914 12.6717 10.6395 12.1404C10.6885 11.5998 10.6884 10.9043 10.6884 9.9168C10.6884 8.92934 10.6885 8.23384 10.6395 7.69317C10.5914 7.16185 10.5004 6.8461 10.3602 6.60333C10.1451 6.23071 9.83536 5.92107 9.46277 5.70587C9.21999 5.56574 8.90424 5.47472 8.37292 5.42657C7.83224 5.3776 7.13682 5.37774 6.14929 5.37774ZM9.80164 0.367975C10.7638 0.367975 11.5314 0.36788 12.1473 0.423639C12.7726 0.480307 13.3093 0.598759 13.7928 0.877741C14.3717 1.21192 14.8521 1.69355 15.1864 2.27227C15.4655 2.75574 15.5857 3.29164 15.6425 3.9168C15.6983 4.53301 15.6971 5.3016 15.6971 6.26446V7.82989C15.6971 8.29264 15.6989 8.58993 15.6649 8.84844C15.4668 10.3525 14.401 11.5738 12.9833 11.9988V10.5467C13.6973 10.1903 14.2105 9.49662 14.3192 8.67169C14.3387 8.52347 14.3407 8.3358 14.3407 7.82989V6.26446C14.3407 5.27706 14.3398 4.58149 14.2909 4.04083C14.2428 3.50968 14.1526 3.19372 14.0126 2.95098C13.7974 2.57849 13.4876 2.26869 13.1151 2.05352C12.8724 1.91347 12.5564 1.82237 12.0253 1.77423C11.4847 1.72528 10.7888 1.7254 9.80164 1.7254H7.71472C6.7562 1.72558 5.92665 2.27697 5.52332 3.07891H4.07019C4.54221 1.51132 5.9932 0.368186 7.71472 0.367975H9.80164Z" fill="currentColor"/></svg>'
  // 剪贴板写入（DSH ui-primitives clipboard.ts 移植）：异步 Clipboard API 优先，
  // 非安全上下文（http 局域网 / 无 clipboard）回退 textarea + execCommand('copy')
  async function writeClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try { await navigator.clipboard.writeText(text); return true } catch { return false }
    }
    const exec = typeof document.execCommand === 'function' ? document.execCommand.bind(document) : undefined
    if (!exec) return false
    const el = document.createElement('textarea')
    el.value = text
    el.setAttribute('readonly', '')
    el.style.position = 'fixed'
    el.style.left = '-9999px'
    document.body.appendChild(el)
    el.select()
    try { return exec('copy') } catch { return false } finally { el.remove() }
  }

  function thinkRowHtml(text, running) {
    const t = String(text || '')
    if (!t.trim()) return ''
    // 2026-08-26 任务 D 定案：思考块收起时**不显示思考正文摘要**（用户「思考过程未折叠」反馈——
    // 摘要「思考 先说明：触发。」直接暴露内部推理）。summary 只留「思考」标题 + 运行态扫光，
    // 点开才看全文。删除 thinkSummary 摘要（运行中 latestLine / 完成后 firstLine 语义一并废弃）。
    return `<details class="think-row" data-state="${running ? 'running' : 'ok'}"><summary><span class="tr-leading" aria-hidden="true"><span class="tr-ico">${THINK_ICON}</span><span class="tr-chev">${THINK_CHEV}</span></span><span class="tr-title">思考</span></summary><div class="tr-body">${mdHtml(t)}</div></details>`
  }

  // 入场动画标记：对比刷新前的顶层消息 key 集合，只给「本次新增」的块加 .msg-in，
  // 已存在的块静默保留（视觉无缝），避免整体 innerHTML 重建时整屏重播动画造成强刷感。
  // key = data-m|data-t（段起始消息索引 | 块类型：u=用户 a=回复 f=独立处理折叠 s=系统）。
  // prev 为空（首屏加载）时全部淡入并带轻微 stagger，让会话打开更有层次。
  function stampMsgIn(prev) {
    let n = 0
    messagesEl.querySelectorAll('[data-m]').forEach((el) => {
      const k = el.dataset.m + '|' + (el.dataset.t || '')
      if (!prev.has(k)) {
        el.classList.add('msg-in')
        el.style.animationDelay = Math.min(n * 22, 330) + 'ms'
        n++
      }
    })
  }

  // messagesHtml 渲染时记录的末段形象（只读 SSE 路径）：末段仍在处理中且段内最近有工具调用
  // → 按该工具选形象（读/搜=3、写/编=2、执行/插件/命令=4）；回复已发布/空闲 → 默认 1
  let charNote = 1
  // 增量重建（2026-08-26）：messagesHtml 记录「最后一个被 closeSeg 的段」的 key/html/前驱锚点/处理中标志，
  // refreshSession 对处理中末段只替换该段 DOM（applySegDelta），头部历史消息保留不动——消除整页重建闪烁。
  let lastSegInfo = null

  function messagesHtml(messages) {
    // 按「用户消息 → AI 处理 → 回复」切段：
    // 真实 user 消息开新段；assistant/tool 的 thinking 与 tool_use 归入「已处理」折叠，
    // 段内最后一个带文本的 assistant 消息 = 回复（主内容），其余文本（过程旁白）也折进去。
    // role:'system'（后端已把合成/系统注入标成 system）= 无发布者的居中提示，独立一行。
    let html = ''
    let seg = null
    lastSegInfo = null // 每次渲染重置：仅记录本次被 closeSeg 的最后一个段
    let lastNode = null // 最近输出的 data-m 元素 {key, type}（供增量重建定位插入锚点）
    // 兜底：最后一条真实用户消息的时间（供「系统消息打断后」无 user 的末段计时/展示时长）；
    // 注入引导消息（injected）不计入——计时起点不打断（单折叠定稿）
    let lastUserTs = 0
    for (const m of messages) if (isRealUser(m) && !m.injected && m.timestamp) lastUserTs = m.timestamp
    // 引导消息按 pos 织进 items 流（从后往前插避免下标位移）；guides 按 push 序天然 pos 升序。
    // A 方案（用户 2026-08-29 定案）：处理中/完成态均为顶层完整用户气泡，原位保留。
    function weave(items, guides, s) {
      if (!guides || !guides.length) return items
      const out = items.slice()
      for (let gi = guides.length - 1; gi >= 0; gi--) {
        const g = guides[gi]
        const gbody = userBodyHtml(g.m)
        out.splice(Math.min(g.pos, out.length), 0, {
          kind: 'guide', gi,
          html: `<div class="msg user" data-m="${s.key}" data-t="g${gi}"${g.i != null ? ` data-g="${g.i}"` : ''}>${gbody ? `<div class="body">${gbody}</div>` : ''}${userImgsHtml(g.m)}</div>`, // 引导气泡不带复制按钮（用户 2026-08-30 定案）；纯图无文本不出空气泡（2026-09-07 空气炮根修）
        })
      }
      return out
    }
    // end_turn 正式回复气泡（流内 reply 项用，形态与原 reply 特判渲染一致）
    function replyBubbleHtml(key, text) {
      return `<div class="msg assistant" data-m="${key}" data-t="a"><div class="body"><div class="blocks">${mdHtml(text)}</div><div class="msg-actions"><button class="msg-copy" title="复制" aria-label="复制">${ICON_COPY}</button></div></div></div>`
    }
    function closeSeg(isFinal) {
      if (!seg) return
      const s = seg
      seg = null
      const segPrev = lastNode // 该段输出前的最后一个 data-m 元素（增量重建插入锚点）
      // 2026-09-06 打断收口：回合被中止后 jsonl 零写入（永远不会有 end_turn 回复），数据形态与
      // 「正在处理」不可区分——收口判定靠两持久信号，任一命中即强制按「已处理」收口，不再挂
      // 「正在处理/正在思考」无限计时（用户实测 2h26m 挂死根修）：
      // ① 会话进程不在线（state=null，网关按存活 pid 判定）= 不可能在处理：封死进程退出/关闭
      //    会话（直接 taskkill 零 onCancel）/崩溃路径；
      // ② turnEndAt（网关权威时刻：turn-state SSE 实时 + /gateway/sessions 首载恢复，无 TTL）
      //    晚于段末落盘 ts = 该回合已被中止：封死打断后刷新丢前端内存标记路径。
      const turnEnded = (() => {
        const sess = findSession(live.curUuid)
        if (sess && !sess.state) return true
        const te = live.turnEndFlags.get(live.curUuid)
        return !!(te && (s.lastTs || (s.user && s.user.timestamp) || 0) < te)
      })()
      const processing = isFinal && !s.finished && !turnEnded // 最后一段且末尾还没收到纯文本回复 = 处理中
      // 末段仍在处理中（未出正式回复）且段内最近有工具调用 → 按该工具选形象；否则（回复已发布/空闲）默认 1
      if (isFinal) charNote = (!(s.finished || turnEnded) && s.lastTool) ? toolToChar(s.lastTool) : 1
      // 旁白 text 原位回填（与其后的动作交错，不再统一沉到段尾）；正式回复（end_turn）已在切段时
      // 气泡化（reply 项 → 折叠体外），不进 texts
      for (const t of s.texts) s.items[t.idx].html = processTextHtml(t.text)
      // 思考行不做 running 态回填（思考永不独立成行：真空态=liveFoldBody 工具行内 .fold-state
      // 状态显示行，2026-09-09 用户定案「状态标识与工具调用行在一起」，v267 summary 轮转方案废弃）

      let segHtml = ''
      if (s.user) {
        const m = s.user
        // 纯图消息（文本剥 [Image #N] 占位后为空）不出 .body 空气泡，复制按钮同去（无文本可复制；
        // 乐观气泡同构同去防接管帧形态跳变）——2026-09-07 空气炮根修
        const ubody = userBodyHtml(m)
        segHtml += `<div class="msg user" data-m="${s.key}" data-t="u">${ubody ? `<div class="body">${ubody}</div>` : ''}${userImgsHtml(m)}${ubody ? `<div class="msg-actions"><button class="msg-copy" title="复制" aria-label="复制">${ICON_COPY}</button></div>` : ''}</div>`
        lastNode = { key: s.key, type: 'u' }
      }

      // 2026-08-29 最终定案（用户）：开启消息渲染一个折叠体，旁白/工具调用行/思考/引导消息
      // 都作为折叠体内部的元素（思考/旁白/引导原位穿插，连续工具折叠概括——liveFoldBody/groupTools），end_turn 正式
      // 回复是唯一折叠体外元素（「已处理 X」+回复）。顺序与 CLI 线性序一致（网关已把回合中
      // 引导重定位回 enqueue 位置并打 guide 标——「回复跑到引导上面」的顺序颠倒已根治）。
      const woven = weave(s.items, s.guides, s)
      const foldItems = []
      const flowParts = []
      for (const it of woven) {
        if (it.kind === 'reply') flowParts.push({ html: it.html, type: 'a' })
        else foldItems.push(it)
      }

      // 「正在思考/正在生成/正在压缩」状态行（2026-08-27 机制沿用；2026-09-11 判定收敛为纯函数 vacuumOf）。
      // 【真空窗口实锤（ff7dc1c2 转录逐行计时）】CLI 按块流式落盘：旁白 text 落盘后 LLM 生成 Edit 的
      // tool_use 参数 3~14s——期间 jsonl 零写入、turn-beat 仍随 delta 持续 → 旧白名单判定（result/thinking
      // 才亮 think，text 不亮）使状态显示行整段真空数秒（用户实测「编辑文件时短暂真空期」）。text 落盘与
      // thinking 落盘语义相同（回合未收口、无工具运行 = 引擎在产出），判定不再按尾动作类型区分；
      // lastStep=null（段刚开、首条记录未落盘）同样亮态。提问 ask 不亮态（提问卡接管输入栏即状态，
      // 2026-09-09 定案维持）。thinking 流式期间 jsonl 零写入 → SSE 不触发，web 保持本次渲染的思考态
      // 直到落盘轮转。判定细则与「工具在飞时以 turn-beat 取证」见 vacuumOf。
      const vacuumState = vacuumOf(s, processing, live, Date.now())
      // 思考/压缩态计时起点：段内最后一条落盘记录的时刻（真空期从那时开始）；尚无记录退回段 user 时间
      const vacuumStart = s.lastTs || (s.user && s.user.timestamp) || 0
      // 处理中（实时）段 = liveFoldBody（单工具折叠行轮转 + 真空态段尾状态显示行，2026-09-09 定案
      // 状态标识与工具行同一行）；已处理/被打断段 = groupTools（连续工具合并概括折叠，思考/旁白/
      // 引导原位穿插）。2026-08-30 恢复 182358 形态（v163 stackBody 重写误删工具折叠，用户实测
      // 「工具行折叠的功能消失」退回）。处理中恒渲染（即使空体——刚发消息乐观折叠语义）；完成态空体跳过。
      const bodyHtml = processing ? liveFoldBody(foldItems, vacuumState, vacuumStart) : groupTools(foldItems)
      if (bodyHtml || processing) {
        // dur 计时（CLI spinner 对应物）：t1=段开启消息 ts（开启消息/新回合段首引导），endTs=回复落盘 ts/段末 ts
        const t1 = (s.user && s.user.timestamp) || s.startTs || (isFinal ? lastUserTs : 0)
        const endTs = s.replyTs || s.lastTs
        const dur = !processing && t1 && endTs ? fmtDur(Math.round((endTs - t1) / 1000)) : ''
        // 处理状态行（2026-09-09 用户定案「折叠顶只应有两字样」）：summary 恒「正在处理 + 总时长」
        // （处理中）/「已处理 + 总时长」（完成），真空期（思考/生成/压缩）状态显示行由 liveFoldBody 并入
        // 尾部工具折叠行 summary 同行（无工具组时段尾独立行），无响应/连接中断红标挂暂态层——折叠顶
        // 不再出现任何其它字样（v267 的 summary 单行轮转方案废弃）。
        const totalSec = processing && t1 ? Math.max(0, Math.round((Date.now() - t1) / 1000)) : 0
        const stateHtml = processing
          ? `正在处理<span class="d-dur"> ${fmtDur(totalSec)}</span>`
          : `已处理${dur ? `<span class="d-dur"> ${dur}</span>` : ''}`
        segHtml += `<details class="done-fold${processing ? ' done-live' : ''}" data-m="${s.key}" data-t="f"${processing ? ' open' : ''}><summary><span class="d-chev">${CHEV}</span>${processing ? '<span class="df-dot"></span>' : ''}${stateHtml}</summary><div class="done-body">${bodyHtml}</div></details>`
        lastNode = { key: s.key, type: 'f' }
      }
      // 流内项（按落盘序）：引导气泡 + 回复气泡（data-t 精确值供下段 prev 锚点查询命中）
      for (const p of flowParts) {
        segHtml += p.html
        lastNode = { key: s.key, type: p.type }
      }

      // 段末文件变更汇总卡片（回合内 Edit/Write 的真实增删行数）
      if (s.changes && s.changes.size) {
        segHtml += renderChangeCardHtml(s.changes, s.key)
        lastNode = { key: s.key, type: 'c' }
      }
      html += segHtml
      lastSegInfo = { key: s.key, html: segHtml, prev: segPrev, processing }
    }

    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]
      if (isContinuationMsg(m)) {
        // 压缩/自动摘要标记（2026-08-27 二轮修正）：不再产生任何可见行——曾以 note 吸进折叠或
        // 居中系统提示，都会打断实时工具折叠行的展示（用户实测）。现在处理中段记 lastStep=
        // 'compact'，由 liveFoldBody 纯空窗兜底附加闪烁「正在压缩会话中……」状态显示行
        // （与「正在思考」同机制）；段间/已完成则静默吞行——数据层不剔 isCompactSummary 续接记录，拦截必须留。
        if (seg && !seg.finished) seg.lastStep = 'compact'
        continue
      }
      if (m.role === 'system') {
        // 无发布者的系统提示：中断当前段并居中展示
        closeSeg(false)
        const txt = m.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('\n').trim()
        html += `<div class="msg system" data-m="s${i}" data-t="s">${esc(txt || '系统消息')}</div>`
        lastNode = { key: 's' + i, type: 's' }
        continue
      }
      if (isRealUser(m)) {
        // 2026-08-30 共同后端定案（接力文档清单#4①）：切段由语义事件驱动——injected:true
        // （queued_command attachment 注入，filterConversationForDisplay 权威输出）= 回合中
        // 引导 → 归当前未收尾段 guides（weave 织入折叠体内部，记 pos=织入 items 流的下标）。
        // 无未收尾段的孤儿注入 → 不开新回合段（user:null，引导为折叠体首元素，兜底防吞）。
        // 非 injected 真实 user = dequeue 消费落盘的开启消息 → 永远开新段并立即计时。
        // 原「段未收尾到来的真实 user 一律吸 guides」启发式删除——它是排队消息被渲染成
        // 引导气泡的根因（102156 二轮实测），排队语义现由置底排队区承担。
        if (m.injected === true) {
          if (seg && !seg.finished) {
            if (!seg.guides) seg.guides = []
            seg.guides.push({ m, i, pos: seg.items.length })
            if (m.timestamp) seg.lastTs = m.timestamp
            continue
          }
          closeSeg(false)
          seg = { user: null, guides: [{ m, i, pos: 0 }], items: [], texts: [], lastTs: m.timestamp || null, startTs: m.timestamp || 0, key: i, thinks: [], lastTool: null, lastAsk: null, pendingTools: [], changes: new Map(), lastStep: null }
          continue
        }
        closeSeg(false)
        // 2026-09-06 撤回链：restoredFlags 命中该 user（落盘早于标记时刻且文本一致）→ 渲染层跳过
        // ——jsonl 不删（CLI rewind 只动内存+换 conversationId），气泡由渲染权威按标记永久不渲染。
        const rst = live.restoredFlags.get(live.curUuid)
        let userSkipped = false
        if (rst && (m.timestamp || 0) <= rst.ts) {
          const ut = (m.blocks || []).filter((b) => b.kind === 'text').map((b) => b.text).join('')
          if (ut.trim() === rst.text.trim()) userSkipped = true
        }
        seg = { user: userSkipped ? null : m, guides: [], items: [], texts: [], lastTs: null, startTs: m.timestamp || 0, key: i, thinks: [], lastTool: null, lastAsk: null, pendingTools: [], changes: new Map(), lastStep: null } // lastStep=段尾最新动作类型（thinking/tool/result/ask/text），真空期「正在思考」占位判定用
        continue
      }
      if (!seg) seg = { user: null, guides: [], items: [], texts: [], lastTs: null, startTs: m.timestamp || 0, key: i, thinks: [], lastTool: null, lastAsk: null, pendingTools: [], changes: new Map(), lastStep: null }
      const hasText = m.blocks.some((b) => b.kind === 'text' && b.text && b.text.trim())
      const hasTool = m.blocks.some((b) => b.kind === 'tool_use')
      for (const b of m.blocks) {
        // 思考块进 items 并记索引（s.thinks 供处理中段 running 态定位）；单块放行由数据层保证
        //（prompt 全剔/transcript 单全局/prompt-tail-think 尾巴单块），前端不再二次折叠（P2 删留尾兜底）
        if (b.kind === 'thinking') { seg.thinks.push(seg.items.length); seg.items.push({ kind: 'think', text: b.text, html: thinkRowHtml(b.text, false) }); seg.lastStep = 'thinking' } // 思考块：lastStep='thinking'（旁白走 text 分支，严格分流）
        else if (b.kind === 'text' && hasTool && b.text && b.text.trim()) {
          // 工具消息里的旁白文本：按块原位插入 items（保持 content 数组顺序——旁白在其对应工具调用之上），
          // 不统一沉到段尾；纯文本消息（无 tool_use）仍在循环后整体追加（保持同消息多 text 块拼接为一条的语义）。
          // end_turn/stop_sequence 正式回复（理论不带 tool_use，防御分支）→ 流内 reply 气泡，不进 texts
          if (isEndStop(m.stopReason)) {
            seg.items.push({ kind: 'reply', html: replyBubbleHtml(seg.key, b.text), text: b.text })
            seg.replyTs = m.timestamp
          } else {
            seg.items.push({ kind: 'text', html: '', text: b.text })
            seg.texts.push({ text: b.text, ts: m.timestamp, idx: seg.items.length - 1 })
          }
          seg.lastStep = 'text' // 工具消息内旁白 ≠ 思考
        }
        else if (b.kind === 'tool_use') {
          if (b.name === 'AskUserQuestion') {
            // 提问块 → DSH 风格提问卡（答案由后续 tool_result 文本吸附）
            const it = { kind: 'ask', name: 'AskUserQuestion', zh: '提问', input: b.input, answer: null, html: askLineHtml(false) }
            seg.items.push(it)
            seg.lastAsk = it
            seg.lastStep = 'ask'
          } else {
            const t = toolMeta(b); seg.items.push({ kind: 'tool', html: toolLine(b), block: b, name: t.name, zh: t.zh }); seg.lastTool = b.name; seg.pendingTools.push(seg.items.length - 1); seg.lastStep = 'tool' // 待完成工具队列（FIFO：连续多个 tool_use 全部登记，tool_result 按序逐个标记 done）
          }
        }
        else if (b.kind === 'tool_result') {
          // 文件变更（2026-08-23 起）：源码 conversationDisplay.ts 输出结构化 fileChange（Edit/Write
          // 真实增删行数，权威 = diff.ts sumLinesChanged），优先消费；parseFileChange 正则反解仅作
          // 旧网关/旧数据兜底（新 exe 部署后可删）。聚合文件变更 → 段末汇总卡片
          const fc = normalizeFileChange(b.fileChange) || parseFileChange(b.text); if (fc) mergeChanges(seg.changes, fc)
          // 2026-08-26 实时折叠：该工具步已收到结果 → 标记 done，groupTools/liveFoldBody 对完成的工具步
          // 显示为普通文本行（「当这一步工具调用完成后，折叠为文本」，不再显示「正在运行」）
          if (seg.pendingTools.length) { const pi = seg.pendingTools.shift(); seg.items[pi].done = true }
          seg.lastStep = 'result'
          // AskUserQuestion 答案关联：最近的未回答提问卡吸附该 tool_result 文本并标出所选
          if (seg.lastAsk && seg.lastAsk.answer == null && b.text) {
            seg.lastAsk.answer = String(b.text)
            seg.lastAsk.html = askLineHtml(true) // 已答 → 「提问 · 已回答」
          }
        }
      }
      if (hasText && !hasTool) {
        // 纯文本消息：end_turn/stop_sequence 正式回复 → 流内 assistant 气泡（reply 项，B 缺陷根治：end_turn 后
        // 继续有工具调用时回复不再被沉进折叠体；多轮 end_turn 各自原位气泡）。旧数据无 stopReason
        // 字段 → 纯文本=回复（与现行 finished 启发式同口径迁移）。其余为过程旁白 → 占位进 items，
        // closeSeg 时原位填充。
        const text = m.blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('')
        if (m.stopReason === undefined || isEndStop(m.stopReason)) {
          seg.items.push({ kind: 'reply', html: replyBubbleHtml(seg.key, text), text })
          seg.replyTs = m.timestamp
        } else {
          seg.items.push({ kind: 'text', html: '', text })
          seg.texts.push({ text, ts: m.timestamp, idx: seg.items.length - 1 })
        }
        seg.lastStep = 'text' // 纯文本旁白/回复（无 tool_use 的消息）≠ 思考
      }
      // finished = 段已收尾判定。2026-08-26 起优先用 stopReason（源码 conversationDisplay 新增，
      // 'end_turn'/'stop_sequence' = 正式回复 = 回合结束（stop_sequence=第三方商正常终止，
      // 2026-08-31 补）；'tool_use'/null = 处理中，旁白/工具步保持「正在处理」）——
      // 精确区分「过程旁白纯文本」与「正式回复」，根治旁白中段误判成已处理（实时折叠闪「已处理」）。
      // 注意：stopReason=null（旁白，JSON 保留 null）也要算「处理中」；仅字段缺失（旧数据 undefined）回落
      // 旧启发式：纯文本回复（无 tool_use）= 收尾。
      if (m.role === 'assistant') {
        seg.finished = m.stopReason !== undefined ? (isEndStop(m.stopReason) ? 1 : 0) : (hasText && !m.blocks.some((b) => b.kind === 'tool_use') ? 1 : 0)
      }
      if (m.timestamp) seg.lastTs = m.timestamp
    }
    // 末尾待答提问在消息流里由紧凑行表达（askLineHtml「提问 · 等待回答」，见 b.name==='AskUserQuestion' 分支）；
    // 2026-09-11 ④ 起不再向上报 pendingAskInput（只读接管卡已移除，见 askLineHtml 注释）。
    closeSeg(true)
    // 2026-09-07 用户定案：空会话不再渲染「暂无 user/assistant 记录」占位行——该界面让会话
    // 出现「空态/内容态」两种视觉状态；移除后空会话消息区即纯空白，状态统一。
    return html
  }


  let pendingUserMsgs = []
  function addUser(text, imgs) {
    clearTakeover() // 清掉残留的提问/审批 takeover
    // 任何 done-live 折叠在场（权威或本区乐观主张）= 回合运行中 → 排队成员；否则本次发送是
    // 「新回合开启主张」。主张至多一个：主张折叠在场时后续发送恒为 dock 成员。
    const hasLive = !!messagesEl.querySelector('details.done-fold.done-live')
    pendingUserMsgs.push({ hash: state.currentHash, text, imgs: imgs || [], baseTs: live.lastDataTs || 0, form: hasLive ? 'dock' : 'bubble', claimTs: Date.now() })
    renderTransient()
    // 两层消息流：乐观开启气泡唤出占位（排队成员/dock 不唤——会话处理中发送不打断当前展示，
    // 2026-09-08 定案「只有处于结束状态的会话发送乐观气泡才唤出占位」）。气泡取暂态区最后
    // 开启气泡（主张至多一个=它），key='optimistic'，落盘接管后由 hasNewUser 链换权威 key。
    if (!hasLive) {
      const zone = document.getElementById('live-zone')
      const els = zone ? zone.querySelectorAll('.msg.user') : []
      if (els.length) stageStart(els[els.length - 1], 'optimistic', true)
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

export {
  CHEV,
  CONTINUED_RE,
  ICON_API,
  ICON_BROWSE,
  ICON_CHECKLIST,
  ICON_COPY,
  ICON_EDIT,
  ICON_GLOBE,
  ICON_SEARCH,
  ICON_SKILL,
  ICON_SPARKLE,
  THINK_CHEV,
  THINK_ICON,
  TOOL_ICONS,
  TOOL_NAMES,
  TOOL_VERB,
  absorbPending,
  addUser,
  askLineHtml,
  baseName,
  charNote,
  ensureLightbox,
  fmtDur,
  groupTools,
  isContinuationMsg,
  isEndStop,
  isRealUser,
  lastSegInfo,
  liveFoldBody,
  mcpShortName,
  mergeChanges,
  messageCopyText,
  messagesHtml,
  normalizeFileChange,
  parseFileChange,
  pendingUserMsgs,
  processTextHtml,
  queueClaimAdopt,
  relFromCwd,
  renderChangeCardHtml,
  stampMsgIn,
  statusFlags,
  thinkRowHtml,
  toolCurHtml,
  toolFoldLabel,
  toolIcon,
  toolLine,
  toolMeta,
  userBodyHtml,
  userImgsHtml,
  writeClipboard,
}
