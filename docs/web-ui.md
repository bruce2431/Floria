# web 前端链路定案（web-ui）

> 本文件属 `docs/` 文档库，收录 web 前端（内置网关静态托管页）的**现行链路与不变量**。
> 前端唯一手改处 = `_agent-src/src/gateway/web-src/`（22 个 ESM 模块），`src/gateway/web/app.js` 由构建生成、勿手改；改动须 bump `?v=` cache-bust 并重新构建 exe（→ [build.md](build.md) §1.1）。网关服务侧（认证 / mDNS / 预览容器 / 审批中继 / 独立会话进程链）→ [gateway.md](gateway.md)；源码核心机制 → [core.md](core.md)；术语 → [glossary.md](glossary.md)。改动以下任一链路时必须同步更新本文。

## 1. pushState 路径路由

主区三态走**真路径路由**——会话 `/session/<完整会话hash>`、管理视图 `/manage/<kind>`（plugins/projects/models）、项目预览 `/project/<项目label>`（`project` 避开网关 `/preview/*` 静态页路径）。**全部前缀用全称，禁止简写**；`/s/`、`/mgr/`、`/pview/`、`/bp/` 仅保留解析兼容、不再生成。`parseRoute` 先读 `location.pathname`（全称与旧缩写双前缀），hash 旧链接兜底；网关静态服务带 SPA fallback（`/^\/(?:session\/|s\/|manage\/|mgr(?:\/|$)|project\/|pview\/)/` → index.html）。`navigate` 参数保持既有 hash 形式（调用点零改动，`#mgr/k`/`#preview/l` 是内部约定 hash、不出现在 URL），内部 `pathFor()` 转真路径；`history.pushState` + `popstate` 兜底前进/后退。**URL 用完整会话 hash**：URL 直接就是转录文件名（`<uuid>.jsonl` 去扩展名），`findSession` 精确匹配即可，`route()`/`hideGate` 补拉后 resolve（`currentHash`/SSE/WS 全链全长）。

**刷新保留当前界面**：boot **不把 `/session/<hash>` 重置回首页**——刷新直进时会话列表未就绪由 `renderSession` 占位「加载中」（`needToken()` 门：token 门未过找不到 ≠ 真不存在），WS 验证通过 → `hideGate` 的 `loadSessions().then` 恢复链落地重渲：消息区**无真实消息气泡**（`.msg:not(.msg-system)`）才整页重渲（占位行也是 `.msg`，旧判定对占位恒假会残留），列表就绪仍无此会话才渲染「会话不存在或已删除」。**预览重挂守卫**：hideGate 恢复链在每次 WS 重连都会执行（iPad 后台杀 WS 回前台自动重连必触发），故 `openProjectPreview` 幂等（同 label 且 iframe 仍挂载且非 default 兜底误挂 → 跳过重挂、保留站内位置，`state.previewMounted` 标记），连带 `initLive` 防重建（每次 hideGate 重复 `new EventSource` 会泄漏旧连接 + 事件双发，已有 `live.es` 即跳过）。

**同步路由**：`navigate()` 后**同步调 `route()`**（不依赖 hashchange 异步时序——异步 route 会出现内容区不切、需再点一次），`lastNavHash` 去重抑制同值 popstate/hashchange。

**异步边界会话身份校验**：CLI 单进程单会话（query 循环写内存 AppState、React 同步渲染）不存在跨会话异步边界；web 是无状态查看器（异步 fetch + SSE 写全局槽 + 全局 DOM），**每个异步边界必须重验 `state.currentHash`**（同构于「渲染前数据必属当前会话」）：①`refreshSession` 在 `await fetchMessages` 后补校验，不通过整体作废（否则 fetch 回程切会话会把上一会话的整份消息/cwd/模型/上下文/队列快照写穿全部全局槽）；②`renderSession` 切换即清 `live.curUuid` + 置空 `live.queueRemote`，fetch 回来消费 `queued` 硬重置（不清则新会话排队区确定性显示上一会话的 CLI 队列快照）；③`addUser` 忙碌/空闲区分——DOM 有 `done-live`（回合运行中）→ 乐观=排队区成员，无 `done-live`（回合间隙）→ 乐观开启气泡直接进对话流。

**SPA 路径路由配套**：index.html 资源引用与 app.js 动态资源（icon/char/gate）全部改**绝对路径**（`/styles.css?v=NNN` 等）——`/session/<hash>` 子路径下相对路径会解析到 `/session/…` 404；左上 logo `<a href="#/">` 加 click 拦截走 `navigate('#/')`（pushState 下仅改 hash 不切视图）。

## 2. 会话创建与首条消息链

**新建流程 = 笔与项目「+」一致，先到初始化界面（空态），发送首条消息才真正建会话**：笔（rail-new/recent-write）清 `state.newProject` 回全局首页；项目文件夹行「+」仅设 `state.newProject=label` + `navigate('#/')`（取消/切换目标项目走输入栏项目选择器 seat）。**seat 三态**：空态=白底 chip 可点弹层选项目、label 显示项目全称（max-width 240px）；会话态（`#chat-area.in-session` 门控）=工作文件夹标识保留显示（按当前会话 projectScope/projectLabel 渲染、全局会话显示「全局」）但 `.locked` 锁定只读；管理/预览态挂载点不在 chat-area 自动隐藏。`gwSend` 空态分支带 project 调 `newWebSession(project)`（创建失败恢复 newProject）→ 建会话后才弹 CLI 窗口。

**首条消息立即上屏**：renderSession 首屏 fetch 常抢在 CLI 把首条 user 消息写入 jsonl 前返回空，renderSession fetch 空时乐观上屏（用户气泡 + 正在处理折叠），真实数据经 SSE 整页替换。

**丝滑建会**：gwSend 空态分支乐观渲染前移到发送瞬间（不等 wsession 返回）+ `flipInput(false)` 沉底，失败回滚空态；`flipInput(toStage)` 为 FLIP 补间（变更前测旧矩形 → 统一施加类/父容器变更 → transform 从旧位滑到新位，终点=恒等无跳变），renderHome/renderSession 换向均走它；renderSession 在 `webCreating` 且 hash 未定时跳过「加载中…」整洗，保留乐观 DOM。

**三态根治 = 状态收敛为单变量 `firstSendHash`**（`''`=无事务；非空=该会话首条乐观 DOM 为权威）：hash 回填前移至 `newWebSession` 内 navigate 之前（同步 navigate 使 renderSession 跑在 gwSend await 续体回填 hash 之前，一切「事后守卫」对第一次洗盘必然失效）；renderSession 入口切走即作废 + 事务期不洗「加载中…」；fetch/refreshSession 回程非空即收口销毁（双入口对称）；事务期 `renderQueueDock` 只跳 remote 快照（注入中消息保持开启气泡形态，不降级排队态）。效果：发送瞬间直接进入会话视觉并平滑过渡到落盘真实数据，计时不再重开。

**wsession 异步化 + 消息暂存补投**：`POST /gateway/wsession` **预分配 sid 立即返回**（`sid = resume ?? randomUUID()`，spawn+注册后台进行）+ `spawningPromises` Map（spawn 在途登记，同 sid 并发调用复用同一 promise 防双进程；**登记须 `p.finally` settle 即清**，只 set 不 delete 会让该 sid 永久驻留 ⇒ 幂等短路恒命中旧 promise + send 路由恒判「在途」把消息永久暂存）+ `pendingDeliveries` Map（send 路由对未就绪会话的消息按序入队，替代「启动中请稍后再发送」的静默丢消息）；CLI `/clients` 注册钩子调 `flushPendingDeliveries` 按序补投（cliClients 刚 set 必 OPEN；不 OPEN 保留等下次注册，不丢消息）。失败链不留静默：spawn 失败/注册超时 → handler `.catch` → 清 `pendingDeliveries` + SSE 群发 `{type:'ws-failed', session, error}` → 前端清首条事务 + 移除合成列表条目 + toast 报错 + 当前正看该会话则回首页。效果：发送 → 会话页（乐观气泡 + 正在处理连续计时）→ CLI 注册（后台）→ 补投 → CLI 处理 → 落盘接管，全程单状态。

**接管帧收口（计时回跳与动画重播根治）**：落盘接管帧的视觉跳变双源——①乐观气泡/乐观 proc 折叠无 `data-m`，refreshSession 整页重建的 `stampMsgIn(prevMsgs)` prev 采集只认 `[data-m]` → 同位真实元素被判「新增」重播 `fadeup`（翻译位移起步=气泡 + 「正在处理」跳变）；②`bindLiveFoldTimer` 计时起点=落盘 user ts（消息经暂存补投，晚于发送瞬间）→ 计时回跳重数。根治=**接管=同位换皮不是新增**：事务收口帧（`firstSendHash === hash && messages.length > 0`，refreshSession/renderSession 双入口对称）置 `txTakeover` 跳过 `stampMsgIn` + 乐观 `procStart` 经 `live.txProcStart` 移交 `bindLiveFoldTimer`（读取即清）续算。判定推广：乐观开启气泡在屏（`[data-t="u"]:not([data-m])`——真实渲染恒带 data-m、引导气泡另带 data-g，无 data-m 的 user 气泡只可能是乐观 DOM）即乐观权威期，与 `firstSendHash` 判定并联；乐观气泡补齐复制按钮与落盘气泡完全同构。

**会话行标识 = 去「独立」徽标，改项目编号气泡**：`itemHtml(s, showProj)` 删 `webTag`，`renderList`（平铺视图）传 showProj=true 时项目会话（projectScope==='project'）标题后显示短编号气泡（`projIdOf(label)` 取 `^Pj\d+` 前缀，非 Pj 命名回落完整 label，悬停显示完整项目名）；项目文件夹视图/根会话/气泡弹层不显示。

**chat DOM 两区重构：暂态区收编**。根因=乐观/暂态元素与权威数据元素生命周期不同源（乐观开启气泡直插数据区会被整页重建洗掉、乐观 proc 折叠挂独立变量+计时器重建后悬挂失连、`#queue-dock` 独立 `msgAppend` 挂载与 delta 增量插入竞争文档序）。根治=**暂态区 `#live-zone`**：数据区与 `.pin-stage` 之间的唯一暂态容器（`display:contents` 不产生盒，子元素即 `#messages` 直接 flex 参与者；`pin-stage` 恒居末），承载三类元素——回合开启气泡（乐观气泡带复制钮与落盘气泡同构）、回合开启主张折叠 `#claim-fold`（「正在处理 Xs」由 `claimTimerSet` 按最早 `claimTs` 跳字）、置底排队区 `#queue-dock`（合并/去重/排序逻辑原样迁入）。**单一状态源 `pendingUserMsgs`**（项 `{hash,text,imgs,baseTs,form:'bubble'|'dock',claimTs}`）+ `live.queueRemote`，`renderTransient()` 整体重建：签名不变跳过重建（防 msg-in 动画重播），空区容器整体摘除。每条渲染路径末尾对账，不变量恒成立：**权威 `done-live[data-m]` 在场 → 本区不持回合开启主张**（幻影折叠结构性不可能）。权威插入避让：`msgAppend`/`applySegDelta` 插入点取 `#live-zone` 之前。首条消息事务收口同步迁移：接管帧 rebase `hash:''` 项归入本会话 + `claimStartTs()` 经 `live.txProcStart` 移交续算；撤回链（restored）同步丢弃匹配 pending 项。**队首主张收编 `queueClaimAdopt(items)`**（首载回程/防抖回程/queue-state SSE 三入口统一调用）：刷新撞上「消息已入队、未落盘」窗口时，把队列**队首项**收编进 `pendingUserMsgs`（form='bubble'；同文本已收编/本地已发 dock 项幂等跳过或原地升级；首条消息事务期豁免），形态由 `renderTransient` 现成 authLive 判定自动定——权威 `done-live` 在场（回合运行中）→ 降级 dock 成员=真排队；不在场（回合间隙）→ 气泡 + 主张折叠；非队首项恒走 remote 真排队。

## 3. 共同后端架构

CLI = 前端（React/Ink）+ 后端（会话引擎：query 循环 + commandQueue + AppState）同进程；**会话引擎为 CLI 与 web 的共同后端，二者地位等权**；网关退化为**纯路由**（会话注册表 / 按 sessionId 转发 / SSE 广播，不做任何渲染语义加工）；**jsonl 降级为冷数据**，只用于历史回放（由同一份 `filterConversationForDisplay` 输出）。

**等权的本体 = 二者共用同一个后端**——无主从、无镜像关系；唯一真源是后端语义，两个前端都只是「呈现 + 输入」的视图层。由此三条：
- **能力等权**：后端暴露的每个会话能力，两种前端都应有入口——审批/提问双操作竞速、发送/引导注入（同一 enqueue 写入口）、模型切换双向同步、队列预览（queue-state 快照链）、重命名实时互同步、web 独立会话=本地可见 REPL 窗口与普通 CLI 同路径。**新能力先落在后端（引擎/导出），两种前端各自接线**；不允许只给一个前端做。
- **正确性等权**：两种前端向前端无关的后端语义对齐，但运行结构不同——CLI 单进程单会话，「渲染的数据必属本会话、状态随进程生灭」是**结构免费**的；web 是无状态查看器（多会话随时切换 + 异步取数），同保证必须**显式补齐**：每个异步边界（fetch 回程/SSE 事件/防抖定时器）重验 `state.currentHash`、切会话即清全局槽、乐观语义按后端实际行为分流（回合中=排队预览、回合间隙=立即开新回合）。**「切视图」覆盖全部三个主区视图**（首页/会话/预览）：预览进入时执行与 `renderHome`/`renderSession` 同款清槽清单（`live.curUuid`/`localMessages`/`deltaSeq`/`queueRemote`/`tasks`/`streamText` + `clearTakeover` + `renderCtxMeter(null)`），恢复「**`live.curUuid` 非空 ⇔ 当前视图正展示该会话**」不变量——否则会话 A 运行中打开项目页，A 的 session-delta 按残留 curUuid 命中守卫会把预览 iframe 洗成会话 chat。**新增主区视图必须执行同款清单**。
- **语义等权**：渲染权威在后端（`filterConversationForDisplay` 一份输出喂回放/实时/离线三链路，前端禁止复刻 isSynth/思考过滤/切段等引擎职责）；行为修正一律回流后端源码，不允许任一前端打补丁绕过。

**落地链 1：injected 权威标（`conversationDisplay.ts` 的 `filterConversationForDisplay` attachment(queued_command) 分支）**——可见性判据照抄 `messages.ts`（origin 回退 task-notification；origin/isMeta 任一存在=系统生成隐藏），人发 → `role:'user' + injected:true`。**人发 queued_command attachment 已落盘**：`isLoggableMessage`（sessionStorage.ts）对非 ant 放行 `queued_command && !origin && !isMeta`（上游 free-code 的 attachment 一律拒写是刻意隐私设计，非缺陷；此处按需求翻案），落盘后物理位置 = 消费位置 = 感知序，回放/实时/压缩后三态一致；系统生成 attachment 维持不落盘。

**落地链 2：队列快照上报链（排队中语义）**——`QueuedCommand.enqueuedAt`（textInputTypes）→ `messageQueueManager` enqueue 打点 → `gatewayClient` 订阅 `subscribeToCommandQueue`（`startGatewayProbeAndConnect` 挂载，重连补发）→ /clients WS `{type:'queue-state', items:[{content,ts}]}`（仅 mode==='prompt'，task-notification 排除）→ 网关 `sessionQueues` Map（无时间 TTL；CLI detach 清）→ `/gateway/session.queued` 首载 + SSE `{type:'queue-state', session, items}` 增量（事件体直带全量快照，前端免拉）。

**落地链 3：前端语义切段 + 置底排队区**——切段由 injected 事件驱动：injected → 归未收尾段 guides（weave 织入折叠体；孤儿注入兜底新段 `user:null`），非 injected user 恒开新段（=dequeue 落盘开启消息）并立即计时。「段未收尾的真实 user 一律吸 guides」启发式已删除（它是排队消息被渲染成引导气泡的根因）。**置底排队区 `#queue-dock`**：本地乐观 pending + CLI 快照合并、文本去重、ts 升序、全空隐藏；**乐观按发送时机分流**——DOM 有 `done-live`（回合运行中）= 排队语义 → 乐观=排队区成员（生命周期 发送→排队区→injected 出现吸收→折叠体内气泡→dequeue 落盘变开启气泡）；无 `done-live`（回合间隙）= 本次发送是**新回合开启消息**、CLI 空闲即消费无排队阶段 → 直接乐观渲染开启气泡进对话流，真实数据经 SSE 整页重建接管，空档期误判双向自愈；吸收信号含 injected（isRealUser 命中）+ baseTs 防历史误吸；计时/钉顶排除标 guide→injected 三处（`bindLiveFoldTimer`/`lastUserTs`/`uSig`）。

**落地链 4：压缩实时态链**（queue-state 同款三件套）——CLI `onCompactProgress`（`compact_start`/`compact_end`，auto/manual 共用）→ REPL 接线 `gatewayClient.notifyCompactProgress(active)` → /clients WS `{type:'compact-state', active}` → 网关无状态转发 SSE 群发 → web `live.compactFlags`（Map 按会话 uuid 存到达时刻，渲染侧 5min TTL 防 compact_end 丢失卡死；结束即删）在真空态强制 compact。背景：压缩进行中 jsonl 零写入（boundary+summary 同毫秒落盘于压缩结束时刻），SSE 纯 fs.watch 驱动 → 压缩期间 web 无任何信号，`lastStep` 停在 'result' 只能错显「正在思考」。同时状态行落位改为 `stateShown` 标记——尾部无工具组承载时状态行独立追加折叠体末尾（否则提问卡/旁白等非工具尾项会先收口，状态行被丢弃）。

**落地链 5：任务清单上报链（底栏任务浮窗，与 queue-state 同款三件套 + 首载快照字段）**——CLI `useTasksV2` store `#notify()` → `gatewayClient.notifyTaskState(getSnapshot() ?? [])`（载荷去重，兜底轮询原样重发不发）→ /clients WS `{type:'task-state', tasks}`（open 时补发当前可见清单）→ 网关 `normalizeGatewayTasks` 收口形状后存 `sessionTasks` Map（无时间 TTL；CLI detach 清）→ `/gateway/session.tasks` 首载 + SSE `{type:'task-state', session, tasks}` 增量 → web `live.tasks`（渲染件 `renderTaskDock`）。**单源不变量**：出口取 `getSnapshot()`——hidden 或清单空 → `[]`，web 与 CLI `TaskListV2` 判定同源；web 无任何复刻逻辑、无形状兜底分支，形状边界只此网关一处。**DOM 几何**：`#task-dock` 是 `#input-bar` 的子元素（输入栏 `position:relative` 为其定位上下文），`bottom:100%` 贴输入栏上沿之上、`pointer-events:none` 只在边沿与展开面板上恢复；收敛态面板 `translateY(100%)` 整块藏进输入栏后，只留 `.td-lip` 把手条可见（12px 高、hover 14px），点击边沿 → `.open` 面板 `translateY(calc(-1 * var(--td-gap)))` 向上伸展（`--td-gap`=10px 为面板底边与输入栏上沿的间距），点击 `.td-head` 向下收敛。**接管让位**：审批/提问卡在场 → `renderTaskDock` 自动清 `taskOpen` 并加 `.blocked`（边沿 `disabled` + `onclick=null`），卡撤走恢复可点且仍保持收敛。详见 §15。

**引导消息碎片化交错渲染**：语义 = **开启消息渲染一个折叠体；旁白、工具调用行、引导消息都作为折叠体内部的元素，各自单独个体、按先后顺序堆叠；结束后最后一个答复（end_turn 回复气泡）在折叠体外**。引导语义由 `filterConversationForDisplay` 的 injected 标权威输出（网关侧补插/打标已整块删除）。`groupTools`（完成态：连续工具合并概括折叠「编辑了文件并运行了命令（3）」）与 `liveFoldBody`（处理中状态行）原样保留——「不合并概括」仅约束引导/回复位置，不及于工具行。

## 4. session-delta 增量事件流

web 读取路径 = **订阅引擎同一变化事件流**——CLI `filterConversationForDisplay`（过滤权威单源不变）输出经 `buildDisplayDelta`（conversationDisplay.ts）算「尾部替换」增量（**`{seq, anchorSid, messages}`**：anchorSid=分歧点前一条的投影稳定键、messages=自分歧点尾部；append/末条 blocks 更新/段收口统一此编码幂等）→ REPL 发射点即发（block 级无防抖，流式字符不入 messages 不风暴）→ `notifySessionDelta` /clients WS → 网关 `sessionDeltaSeq` 单调去重（seq<=last 丢弃；**cli-hello 重置**防 CLI 重启 seq 归 1 被吞死锁）→ SSE `session-delta` 群发 → web 应用 **「锚点 + 其后整体替换」**：`cur.slice(0, idx+1).concat(messages)`，长度差异不参与判定；**渲染走与全量对账同一出口 `renderSessionBody`**（事务收口/接管帧/absorbPending/renderTransient/sig 幂等/增量末段替换或整页重建不变量同源）。gap/无基线/`idx === -1 || cur.length - idx - 1 > 512` → `refreshSession(true)` 全量对账重建基线（基线唯一重置点 = fetch 回程 + `/gateway/session` 附 `deltaSeq`）。jsonl watch 'updated' 触发的 refreshSession 照旧（display 链活着=对账基线），sig 幂等天然跳过重复渲染。**不变量**：CLI 侧「投影必须覆盖到 sent 末尾」（`base0 + display.length >= cache.sent.length`，不满足即 return null，中间 commit 静默跳过）；消费端只认内容标识不认长度。新增「内容通知」只此一流，新增特设信号链前先校验是否属于本流。

**稳定键 `sid`（长会话 delta 恒失效的根治）**：REPL `messages` state 被 `capRenderedMessages` 裁成尾部 200 条窗口，而 `normalizeMessages` 的 uuid 派生受**粘性** `isNewChain` 标志影响——同一记录在 CLI 窗口投影里是裸 uuid、在网关全量投影里是派生 uuid，窗口每滑一条派生分界点即漂移；数字坐标 `base` 是 CLI 本地窗口坐标而 web `cur` 是网关全量投影，消费端因此逐条拒收。根治（不改 normalizeMessages，改动面收敛在投影出口 + 协议）：①投影出口为每条赋**位置无关稳定键 `sid`**＝「源记录 uuid 前 24 位（`deriveUUID` 恒保留该前缀）+ 同 parent 内块序」，无源 uuid 的派生提示行用 `h#时间戳#文本前 32 字`；②`buildDisplayDelta` 用 sid 对齐与锚点，`anchorSid = sent[k-1].sid`（k=0 无可靠基线则不发，交对账链）；③比对键**剥 uuid**（`cmpKey`）——uuid 是位置相关派生物，留在比对里会让每轮 delta 退化为整窗重发；④P2 上报 `exportConversationToServer` 的水位对齐同根同治（uuid → sid）；⑤网关 `/clients` 转发校验 `anchorSid`（缺锚点不发，web 走对账）。跨版本双向安全降级（无 anchorSid → 对账）。

**delta 序号账本（帧 0 到达的根治）**：序号原寄生于展示缓存条目（`DisplayCacheEntry.seq`，而全量路径的 `displayCacheBySession.set` 不提 seq）→ 任何一次全量重建都把 CLI 序号打回 1，网关侧水位只由 cli-hello 重置、`seq <= last` 静默丢弃 → 此后每条 delta 被吞，水位越高遮蔽越久。根治两处（均在 conversationDisplay.ts，不动协议/网关/web）：①新增进程级账本 `deltaSeqBySession`（`buildDisplayDelta` 从它取号并自增，`DisplayCacheEntry` 去掉 `seq`）——**不变量：delta 序号单调递增、只在 CLI 进程重启时归零**；②`exportConversationToServer` 在 `cache && display.length === 0` 时直接 return（不 POST、不推进基线）——**不变量：`cache.sent` 恒等于最后一次成功上报的完整投影**，瞬态空投影不是新基线。探针 `probe-delta-real.ts`（真网关水位门 + `--collapse` 注入同构塌缩 + `--watermark` 预设水位）。

**P1 钉顶对象与视图槽不变量**：①`renderSessionBody` 钉顶分支 `pinnedUserSig` 推进必须在气泡命中**之后**（先推进后查找，选择器未命中即本回合钉顶切换永久失效不重试）；②`syncPinAfterRender` 无「抓最后一个 user 气泡」fallback（可能命中暂态乐观气泡/旧气泡），key 失配 → `pinRelease()` 交还 hasNewUser 链重钉。**不变量：钉顶对象必须是本回合带 data-m 的渲染权威气泡**。③`renderHome`（回首页空态）补与 `renderSession` 切会话清理同清单的对称清理（`lastMsgLen`/`localMessages`/`deltaSeq`/`queueRemote`/`curUuid`）——否则该会话继续流式输出时 session-delta 靠残留槽通过守卫，把上一会话转录灌进首页消息区。④REACTIVE_COMPACT 边界塌缩期间 `setMessages(() => [boundary])` 把 React state 塌缩为单条、随后逐条回补，每个中间 commit 都触发 delta effect → `buildDisplayDelta` 对短小中间投影发出小基线尾部替换 delta → web 把已提交历史截断成残段。根治三处（CLI 生产端两处 + web 消费端一处，均不加状态源）：CLI 侧窗口覆盖不变量（见上）+ `exportConversationToServer` 同款守卫；web 侧 `base + ev.messages.length < cur.length` 拒收并按 seq gap 同形态走 `refreshSession(true)`。

**SSE 半开死亡探测自愈**：TCP 半开（改网/睡眠唤醒/网络抖动，无 FIN/RST）不触发 `es.onerror`：delta 全丢且无重连，页面冻结最后帧而计时行照跳（`setInterval` 不依赖数据）。修（`core/live.js`）：`initLive` 建连 + `onmessage` 记 `live.lastSseAt` 活性时刻（任何 SSE 事件到达=链活，parse 失败同样是活性证明）；`bindLiveFoldTimer` tick 加 **90s 无任何 SSE 事件 → `refreshSession(true)` 全量对账自愈**（fetch 走新 TCP=既是探测也是恢复，幂等；重置基点防每秒重入）。不变量：处理中段 SSE 事件停达 90s=链死亡（处理中段引擎有增量即 4s 一发 beat、纯工具期亦有输出流）；明确断开形态由 `es.onerror` 的 close + 重连 + hello 对账覆盖。

**回退快照防御 `snapshotStale`（纯函数）**：`/gateway/session` = 磁盘 jsonl 全量 + CLI 异步上报窗口合并，回合开启时序窗内两源都可能短暂落后（dequeue 落盘前 / display 缓冲重建期）→ 同一会话先后两次 fetch 拿到「已渲染内容消失」的回退快照，`refreshSession` 把它当权威 → 整页重建洗掉在屏新回合、`localMessages`/`deltaSeq` 基线被静默回写、`hasNewUser` 在回退数据上把上一回合误判为新消息并主动重钉（「发送瞬间跳到上一条消息」）、基线回退致后续 delta 判 gap 并 force 绕过「空 fetch 不洗盘」守卫 → 整页空白。修=渲染统一出口前加**快照单调性门**：本地基线非空而快照为空，或快照最大落盘 ts 严格早于基线 = 回退快照，**整帧丢弃**——不渲染、不重写基线、不碰 cwd/模型/队列/任务槽（置于会话身份复验之后、一切副作用之前），等下一条 SSE/落盘触发的快照自然恢复；合法重渲不受影响（撤回/turn-state 同数据 ts 持平放行、压缩收口 summary ts 前进放行、首载/切会话基线 null 放行）。探针 `probe-snapshot-stale.ts`。

## 5. web 模型 / 思考等级切换（模型源=凭据池）

AppState store 是 React Provider 内 `useState` 创建**非模块单例**，React 树外代码走**全局 handler 模式**——`src/bridge/controlOverrideHandle.ts` 模块级 handler + `src/components/GatewayControlBridge.tsx`（replLauncher 在 `<App>` 内挂 `<REPL>` 旁，Provider 内注册）：model → **切换同拍化**（模型 + 供应商成对挂起：`setPendingSessionModelOverride` + `setPendingSessionProvider`，回合边界（REPL `getToolUseContext`）与 `options.mainLoopModel` 快照**同一拍**落地；此处只立即更新显示态 `setAppState({mainLoopModelForSession: resolved})`；`'default'`/null → 清覆盖 + 清绑定回落读盘凭据池，只影响本会话）；effort → `setAppState({effortValue})`。

**网关 `POST /gateway/model`**：**model → 每会话**：校验放宽到凭据池全部供应商（`findModelProvider`），随 `{type:'model', value, provider}` 按 sessionId 精确路由到目标 CLI 进程（该进程进程内绑定 provider 的 baseUrl/key）；**本分支不写全局凭据池**；无 sessionId/未命中返回 400 不广播，失败路径零副作用。**defaultModel → `switchModelAuto` 全局默认**（跨供应商自动切换；只对之后新建的会话生效）。**effortLevel → `updateSettingsForSource('userSettings', { effortLevel })`** 写便携根 settings.json effortLevel（全局；校验/合并/删除/缓存失效/失败暴露全在官方设置服务，写失败返 500）+ broadcast `{type:'effort'}`。**写盘守卫**：写盘前过 `parseEffortValue` + `toPersistableEffort`——读侧 schema 非 ant 只接受 low/medium/high 且整文件 safeParse，把 `'max'` 原样落盘会使整个 userSettings 校验失败作废（model/permissions 全读丢）；守卫后 `'max'` 为 session-scoped 不落盘（删键=重启跟随模型默认），运行时仍经广播实时生效。

**能力声明通道**：凭据池 provider 段新增 `capabilities` 声明（`ProviderConfig.capabilities`），`get3PModelCapabilityOverride` 经 `getPoolModelCapability` → `findModelProvider` 优先消费——**声明即完全接管**（未列能力=显式不支持），未声明段维持 env/name 启发式。**`effortLevels` 声明**（`ProviderConfig.effortLevels`，值域 off/low/medium/high/max；glm=[low,high,max]、deepseek=[off,low,high,max]）+ 两段 capabilities 含 `max_effort`（官方 max 档直发，不降级）。**底栏 Off 穿透**：GatewayControlBridge 广播 null 必须**透传**（AppState.effortValue 扩 `| null`；把 null 折叠成 undefined 会与「未设置」不可分），`resolveAppliedEffort` 对显式 null 不发 effort 也不落默认链（与 env unset 同语义），`'auto'` 仍=清除跟随默认。**Off 真关分叉**（`claude.ts` `paramsFromContext`）：显式 Off（`effortValue===null`）且模型声明含 off → `thinking:{type:'disabled'}`（`getPoolModelEffortLevels` 读取，优先于 ultrathink/thinkingConfig）。**web 菜单按声明动态渲染不写死**：`/gateway/models` 每条目随带 `effortLevels`（`listModels` poolRows），`model-select.js` `modelEffortLevels()` 取当前模型条目清单生成菜单行（`EFFORT_LABELS` 映射，off→undefined 语义）；未声明回退固定 Off + Low/High/Max；无 off 档模型（GLM）未设置等级时显示「默认」而非 Off。

**直接切模型自动切供应商**：密钥池切换不再两步——**`/model <name>` 直选全池模型，归属其它供应商时本进程绑定该供应商（`setSessionProviderOverride`，baseUrl/key 进程内立即生效，不写全局池）**（CLI `model.tsx`：池内模型跳过 API 试呼验证（池为权威）；模型菜单 handleSelect 同接；补全聚合全部供应商模型、当前供应商排最前）。**`/provider`、`/key` 命令均已移除**——模型/密钥配置只能直接编辑便携根 `.claude/credentials.json`，命令仅保留 `/model`（凭据池读取侧 API 全保留，vision/client/网关不受影响）。网关 `listModels` items 凭据池行携带真实归属 `provider` 标签；web 模型浮窗/MGR 全池可选（分组用真实 provider 标签、MGR「设为默认」放开全池走 `switchModelAuto`）。池级 API：`pool.ts` `findModelProvider` / `setSessionProviderOverride` + `getSessionProviderName` / `switchModelAuto`（始终写全局池 = 默认模型）。

**会话模型严格隔离**：全局默认（模型 tab `switchModelAuto`，仅写池不广播不路由）= 只对**之后新启动的会话**生效，运行中会话不被影响。`main.tsx` 启动段：未显式指定模型（--model flag / agent model 都没有）时，把**当时**凭据池 activeModel 固化为 `setMainLoopModelOverride` 会话覆盖——否则 override 留空、模型解析链每轮实时回落读池，模型 tab 切默认会把运行中「未显式设过模型」的会话下一轮悄悄带走。会话内显式切换（/model、弹层路由 `{type:'model'}`）仍走 GatewayControlBridge 覆盖固化值，`'default'` 清覆盖 = 显式恢复实时跟随；CLI REPL 与 web 独立会话（同走 main.tsx 交互入口）一视同仁。

**会话级供应商绑定**：仅固化模型名不够——**凭据（baseUrl/apiKey）仍每次请求现读全局池**，于是「新会话界面切模型」路径若全局写池会毒害所有在跑会话（跨商 400 且失败路径无回滚）。根治三处：①`pool.ts` 会话绑定层——解析顺序 **显式 override（网关路由 `{type:'model', provider}` 时 `setSessionProviderOverride`）> 进程启动快照（首次解析时的 activeProvider + 该商 activeModel）> 池文件现值**；`getActiveProviderConfig()`/`getActiveApiKey()`/`getActiveBaseUrl()`/`getActiveModel()` 全走会话有效值，新增 `getGlobalActiveProviderConfig()`/`getGlobalActiveModel()` 供管理视图（`listModels`、会话 vision 回落）读池现值；**不变量 = 本进程请求凭据只随本进程状态变化**；②`localGateway.ts` `/gateway/model` 的 model 分支不发全局写，改为 `{type:'model', value, provider: findModelProvider(model)}` 路由；③`gatewayClient.ts` 收 `provider` → `setSessionProviderOverride` 绑定本进程。前端配套（`model-select.js`）：有会话 → `{model, sessionId}` 会话级切换；首页/新会话 → `{defaultModel}`（全局默认，只影响之后新建的会话）。**同拍化**：provider 与 STATE 覆盖为**挂起对**（`setPendingSessionModelOverride` bootstrap/state.ts + `setPendingSessionProvider` pool.ts），`getToolUseContext` 回合边界与模型名快照同一时刻 `applyPending*` 成对落地；立即写者（CLI /model、resume、官方 onSetModel）在写入器内自动取消挂起——回合中途一切请求（主循环续轮/催办 drain 续轮/fork 查询）保持旧模型 + 旧凭据，切换完整落在下一轮循环。

**`listModels`（GET /gateway/models）** 返回 `model = activeModel ?? settings.model`（与 CLI 同源）+ `activeProvider/activeModel/providerModels/effortLevel` 字段，凭据池条目随带 `effortLevels`（官方档位声明）；前端模型浮窗渲染真实凭据池模型、effort 面板按当前模型 `effortLevels` 声明动态渲染（未声明回退固定 Off+Low/High/Max）。`gatewayClient.ts` WS 收 `{type:'model'|'effort'}` → `invokeControlOverride`（model 随带 provider 传 REPL 侧挂起；effort 仍实时生效）；前端 `mselChoose` 调 `apiSetModel` POST（有会话 → `{model, sessionId: state.currentHash}` 供网关精确路由；首页/新会话 → `{defaultModel}` 设全局默认）。CLI 思考等级渲染：LogoV2/CondensedLogo 用 `getDisplayedEffortLevel`（恒返等级、未设置回落 `'high'`）以 `<模型名>·<思考等级>` 显示。

**模型 web/CLI 同步**：每会话 override 只存在于 CLI 内存，web 只读凭据池全局默认 → 不同步。方案=①CLI 上报：`gatewayClient.ts` `reportCurrentModel()`（WS open 回调 + GatewayControlBridge/useReplBridge/model.tsx 三处切换点后调用，POST `/gateway/model-report` 带 `{sessionId, model}`，model 取自 `getMainLoopModel()`），网关 `sessionModels` Map（**无时间 TTL**，CLI 断开 detach 删 + 重连 open 补报 + stop 清空，与 sessionQueues/sessionTasks 同构——有 TTL 会把长时间不切模型的活跃会话清成 `model=null` → web seat 校准跳过、停在 localStorage 旧值）+ POST `/gateway/model-report` 存 + `GET /gateway/session` 附 `model/modelTs`；②web 双保险：`MODEL_CUR` 持久化 `localStorage`（`floria-model-v1`）+ `applySessionModel(model, modelTs)`（`modelUserPicked` 标记：切换会话/刷新时若用户本会话未手动切过则用上报模型校准 seat 并持久化，`mselChoose` 手动切换置 true 不再被覆盖）。

## 6. web 打断按钮与打断收口 / 撤回链

回合进行中 web 发送按钮变**圆形方孔停止键**，点击 = CLI 一次 Ctrl+C。**仅当输入栏为空时才显示停止键**；输入栏有内容（文本/图）时恒显示发送键，点击=排队续发（`gwSend` 无回合态守卫，不打断），输入清空即还原停止键。全链：web（**回合态由 `syncTurnLive()` 纯 DOM 实况推导**：渲染权威 `done-live[data-m]` 折叠或暂态区乐观主张折叠在场 = 回合运行中，每次渲染路径末尾校准；停止态点击经既有 `/clients` WS 发 `{type:'interrupt', sessionId}`，输入文字保留）→ 网关 `handleWsMessage` `case 'interrupt'` 按会话精确路由（未在线回 status 不 resume）→ CLI `gatewayClient.ts` 收 `interrupt` → `src/bridge/gatewayInterruptHandle.ts`（模块级句柄，仿 controlOverrideHandle 模式）→ REPL 注册 handler：**判活对齐 CancelRequestHandler**（abortController 存活或队列非空才生效）→ `onCancel()`（abort('user-cancel') + 清权限弹窗/队列 + 保留部分流式文本，与本地 Ctrl+C 完全同路径）。

**打断收口 / 撤回链**：打断后 jsonl 零写入（interrupted 标记不落盘、思考期本就不落盘），而 web 判定回合结束只认 end_turn 回复落盘 → 打断后「正在处理/正在思考」永挂。修法 = compact-state 同款「CLI→网关→SSE」信号链补两条：①CLI `onCancel`（一切打断汇聚点）→ `gatewayClient.notifyTurnInterrupted()` 发 `{type:'turn-state', live:false}` → 网关无状态转发 → web 记 per-session `turnEndFlags`（无 TTL，jsonl 永无该回合回复）+ `refreshSession(true)` 强制重渲 → `closeSeg` 以「段末落盘 ts < 标记时刻」判收口「已处理」；②CLI auto-restore（REPL 打断后无 meaningful 响应自动回退，web 注入消息同样触发）且打断源自 web（`consumeWebInterrupt()` 时间窗标记，`gatewayInterruptHandle` invoke 时置位/onCancel 一次性消费；handler 未挂（本进程无运行回合）不置位，闲 REPL 收广播不污染后续本地 Ctrl+C 判定）→ `notifyInterruptRestored(text)` 发 `{type:'restored', text}` → web 记 `restoredFlags` + 文本回填输入栏（打断时输入栏必空）→ 渲染按 flag 永久跳过该 user 气泡（jsonl 不删，rewind 只动 CLI 内存 + 换 conversationId）。**web 打断撤回走与本地完全同路径的 `restoreMessageSyncRef`**（rewind + 回填 CLI 输入框 + 图片回填）再叠加 restored 事件回填 web 栏；CLI 框残留原文问题用 `restoredToCliRef` 记回填原文，auto-restore 守卫放宽为「空**或**恰为上次回填原文（用户未动）」，用户真打字仍拦。本地 Ctrl+C 原行为不变（无 restored 事件），web 旁观收到 turn-state 同步收口。**撤回动画**：restored 到达先定位 body 文本匹配的最后一个 user 气泡（打断撤回时队列必空=流尾气泡），JS 设 max-height 初值后加 `.msg-out`（opacity/transform/max-height/margin 四属性塌缩过渡）播约 0.3s 塌缩淡出，结束后 remove + `refreshSession(true)`；输入栏回填时机不变（restored 到达立即回填 + focus）。

**收口二轮（持久信号）**：`turnEndFlags` 仅内存、刷新即丢；「关闭会话」直接杀进程则 `onCancel` 不跑、turn-state 根本不发（CLI 崩溃/直接关终端同理）。根修 = `closeSeg` 双持久信号任一命中即收口：**信号①进程不在线**——`findSession(live.curUuid)` 记录 `state=null`（网关按存活 pid 判定，`sweepStaleMaps` 同步清死进程 activity），封死一切进程死亡路径；**信号②turnEndAt 网关权威时刻**——`localGateway` 转发 `turn-state(live:false)` 时记模块级 `turnEndAt` map（无 TTL、不入 sweep）+ `/gateway/sessions` 每会话下发 `turnEndAt` 字段 + 前端 `applyTurnEndAt` 在 `loadSessions`/`refreshList` 两处拉列表同源恢复（`refreshList` 中置于 listSig 短路之前）。时间比较语义天然兼容新回合覆盖：被打断回合（te=T1）之后新发消息（段 ts > T1）不误收口。

**断连 / 僵死感知链**：两种形态——①**孤儿僵死**：进程/WS 活但 query 链死（消息只 enqueue 落盘零响应，心跳照发 busy → 状态点恒绿假象）；②**断流残影**：网关/进程死亡后 SSE 断流，web 冻结在 spinner + token 数字残影无任何断线表现。缺口根源=`/clients` WS `detach` 全程静默，web 状态权威 `sessionActivity` 只靠下次拉取/TTL 被动过期。修法三条信号（复用「CLI→网关 /clients WS→SSE 无状态群发→web 自持 per-session 标记」模式）：①**activity(null) + session-down**：`detach` 时 `sessionActivity.delete(sid)` + SSE 群发 `{type:'activity', session, state:null}`（web 状态点立即熄 + 当前会话 `refreshSession(true)` 收口运行态）；进程真死再群发 `{type:'session-down', session}` → web toast「会话进程已退出」（重连窗内不发防闪扰）；②**session-up**：`/clients` 注册成功钩子群发 → web 清断开态刷新；③**turn-beat 僵死心跳**：CLI `REPL.setResponseLength` 内容增长分支（thinking/text/subagent delta 全汇聚点）→ `gatewayClient.notifyTurnBeat()`（4s 节流）→ 网关记 `turnBeatAt` + SSE 群发 → web tick 与乐观主张 `claimTick` 每秒对账：beat 缺席（整回合零增量）或落后 ≥150s（中途停摆）→ 计时行红标（见 §20 单状态槽）。beat 语义=「引擎最后真实产出时刻」，每秒 tick 重算无残留状态，信号恢复即自动消失；turn-state(live:false)/detach 即清 `turnBeatAt` 防旧 beat 跨回合误判。beat 只反映「有无新输出」——长工具任务无 delta 会显示「无响应」，中性文案不武断卡死；审批接管与工具在飞均已豁免（§18 ③）。

**重启收口持久化 + activity 重连重报**：重启网关会清空 `sessionActivity`（CLI 只在状态变化 + 60s 心跳补报 → 真空窗内 `/gateway/sessions` 派生 `state=null` → `closeSeg` 把**活回合**误收口成「已处理」）与 `turnEndAt`（重启前被打断回合的收口信号消失 → 无限计时复活）。三修：①**turnEndAt 落盘持久化**（`.claude/gateway-turnend.json` 变更即写 + 启动 `loadTurnEndAt()` 恢复；落盘失败静默降级内存态）；②**CLI WS（重）连 open 即重报 activity**（`gatewayClient.ts` `registerActivityResync` 钩子，REPL activity effect 挂重报闭包随 sessionStatus 恒新）；③**web activity 恢复对称刷新**（SSE activity handler：state 由 null 恢复非 null 且为当前会话立即 `refreshSession()`——不变量=当前会话视图状态显示收敛到网关最新 state，null↔非 null 两向同治）。

**断连复核窗 + 优雅退出 + 无响应判定统一 + 钉顶对账收口**：①detach 立即群发 `activity(null)` 会与 CLI 重连窗竞速，网络抖动即把活回合误收口；根修 = `localGateway.ts` detach 改 **3s 复核窗**（模块级 `detachTimers` Map，close/error 双触发 clearTimeout 去重）：窗内重连全静默（activityResync 重报自然恢复状态），到期未重连才清 `sessionActivity`/`turnBeatAt` + 群发 null——activity null 收口与 session-down 共用「进程失联确认」同一判定时机。②**shutdown 优雅退出协议**（见 §7）。③「无响应」判定统一为 `staleSec >= 150`（beat 缺席从折叠计时起点起算）——此前 tick 与 claimTick 判定不一致，纯工具回合/回合切换 beat 窗口/旧 exe CLI 整回合误标。④**钉顶对账收口 `renderSettle`**：暂态区 `#live-zone` 高度变化（queue-state SSE 直调 `renderTransient`、发送主张上屏、吸收摘除 zone）此前绕过钉顶几何对账——`renderTransient` 出口（含全空摘 zone 分支）统一走 `renderSettle()`（stage 在场即重投影，未激活零开销）；`roundFoldOpen` 对 `#live-zone` 返回 false（恒 open 的 claim-fold 曾被 `zone.querySelector` 命中误判「处理折叠展开」污染临时让位判定）。

**无响应误标二轮根治：beat 回合基线 clamp**：「正在处理 5s · 无响应 2m 59s」并存根因=`live.turnBeat` 是 per-session 永续 Map，前端正常回合结束**无 SSE 信号**（turn-state(live:false) 仅打断时发）无从删条目，上回合残留 beat 被新回合 tick 直接取用——回合切换后静默期 `staleSec = now − 旧值 ≥ 150s` 立即误标。修法=两处判定（`bindLiveFoldTimer` tick + `claimTick`）统一加**回合基线 clamp**：`beatAt` 早于本回合起点（tick 用段开启消息 t1、claimTick 用主张 claimTs t0）→ 视同 beat 缺席，从回合起点起算——判定语义从「会话上次增量距今」校正回「**本回合**开始后曾有增量后停摆 / 本回合 150s 无增量」，前端不引入新信号源、不改 DOM 结构。

**排队消息催办**：点击排队气泡 = 打断当前这一轮「思考」，让排队消息立即并入当前轮次——不新增回合、不产生新乐观气泡、**不是中断**（见 §13）。

## 7. 侧栏行菜单「关闭会话」与浮窗 / 滚轮

会话行 … 菜单第二项（重命名 / 关闭会话；icon=dshStop 停止键）——语义 = **CLI 两次 Ctrl+C**，对所有在线会话生效：①先经 `/clients` WS 发 `{type:'interrupt', sessionId}`（上方打断链，空闲会话 CLI 侧判活 no-op）；②`POST /gateway/wsession/stop {id: hash}` → 网关双分支杀进程：web spawn 会话走 `stopWebSession`（taskkill 真实 pid 树 → 本地 REPL 窗口随之关闭）；**终端直开会话（非网关 spawn）按 `sessionActivity` 上报 pid（=CLI 进程本体 `process.pid`，REPL activity 心跳）`killTree`**——「关闭会话」不存在需要用户回终端手动退的分支。两分支统一 `gracefulStopCli` 优雅退出协议：先经 /clients 按 sid 精确单发 `{type:'shutdown'}`（`cliClients.get`，非广播不波及其它会话）→ CLI `gatewayClient` 置 `shuttingDown` 停重连 + 100ms 后 exit 0 → WT closeOnExit=graceful 自动收 tab，不留「已退出进程，代码为 1」提示页（旧 exe 无 shutdown handler 的进程对消息无视，3s 兜底照旧强杀 exit 1——只能换新 exe 重开会话根治）→ 3s 后进程仍活才 `killTreeExcept(pid, process.pid)` 树杀兜底（**豁免网关子树**——网关进程可能是「跑 /server restart 或被自愈拉起」的那个 CLI 会话的子进程，裸 `taskkill /T` 会连坐杀掉网关自身）。转录保留磁盘、tab 不消失，仅状态点熄灭；会话未在线 toast 提示不动作。

**菜单形态 = tab 内嵌展开**：选项挂 `.sess-menu`、tab 行内第二行（`.sess-item` 加 `flex-wrap: wrap`，菜单 `flex-basis:100%` 强制折行；常规行 title `flex:1` + `overflow:hidden` 可缩到 0 恒单行不受影响），`height 0→实测内容高` JS 过渡（先 `void offsetHeight` 提交 0 基准再落实测高触发高度过渡）= tab 高度展开动画；关闭（再点 …/点外部 mousedown/点菜单项）瞬时收起。**保留不变量**：菜单只存在于浮起 tab 上（`toggleRowMenu` 先 `liftStart(row,{anim:false})` 直终态；行未成浮起宿主不弹菜单）；菜单=行子元素（mouseleave 不触发、浮起保持、title 暂存抑制、mousedown 外点关）；`renderRecent` 先摘 body 暂存 + 重扶出口重挂（高度态随节点保留，无重定位、不重播动画）。**托管被力还原时跟随关闭**：`liftClear` 拍回动作**前**判 `rowMenu.parentElement === liftEl` → `closeRowMenu()`（其尾部 `liftClear(true)` 完成拍回不递归，此处 return 防双拍；renderRecent 路径菜单先摘 body、parentElement≠liftEl 不误关）；`renderRecent` 折叠分支提前 return 前 closeRowMenu。

**滚轮互搏与死区根治**：hover 扶起与滚动互搏 —— `liftCool` 滚动静默期（scroll 监听置 `Date.now()+150`）必须同时挡 mouseenter 直调**与**重建重扶出口（`refreshList` 按活动流签名高频整列重建，滚动中每步都被拍回/重扶=「侧栏滚轮失效」），出口③④（elementFromPoint/prevLift rect → liftStart 直调）同加 `Date.now() >= liftCool` 门——**不变量：扶起只发生在列表静止态**贯彻到全部重建路径（出口①rowMenu/②reLiftHash 点击语义=用户主动，保持直调）。**死区真根因=fixed 浮起行不在 `#recent-body` 的滚轮滚动链上**——Chromium 滚动链走包含块链，fixed 行直连 viewport，DOM 祖先 overflow 容器被整段摘除（wheel 打在浮起行上「事件到达 + 0 scroll」，同点在流行照滚）；列表被行铺满 + 滚动后按静止光标重扶 → wheel target 恒为 fixed 行。根修=`#recent-body` 挂 **non-passive wheel 监听**（first-lift 时随 scroll/resize 一并绑定）：滚轮到达=滚动意图 → 同步 `liftClear(true)` 拍回 + `void offsetHeight` 强制 layout，让默认滚动动作在干净布局上把滚动链重新解析回容器；菜单开着一并 `closeRowMenu()`；`liftCool` 与 scroll 门同参续期。**不变量：滚轮到达列表 → 列表回纯在流态**。

**三个点拦截修复**：`.sess-more` 点击 `stopPropagation` 会完全阻断冒泡、不触发 `navigate` → 双击；修复=单击三个点 = 切换会话 + 弹出该行菜单（同一会话），任意位置单击都可靠切换。

## 8. 两层消息流与渲染定案

**两层模型**：上层=各种气泡和 AI 消息，第二层=乐观气泡生成的占位，占位大小按屏幕计算，两层合并作为滑条依据。**新模型（占位一诞生即永恒）**：①`.pin-stage` 静态占位块挂 `#messages` 流末（暂态区之后），高度=滚动容器 `clientHeight`（诞生锁定，仅 resize/对账校准），**不随内容收缩、回合结束不自动撤**；②跟随吸底目标=**真实内容底**（`stageFollow`：`scrollTop = max(开启气泡贴顶位, 占位起点 − 视口高)`——内容未满一屏时视口停在开启气泡贴顶处、折叠体/回复在下方生长，超过一屏后平滑转内容底跟随、气泡自然上滑出视口顶，两视角在贴顶位无缝衔接）；③唤出条件：仅新回合开启消息（web 乐观气泡 `addUser` form='bubble' / CLI 端权威新 user 经 hasNewUser 链），**会话处理中发送=排队成员不唤出**；乐观气泡唤出 `key='optimistic'`，落盘接管帧 `stageStart(el, 权威key, false)` 直终态；刷新/首屏恢复=末段处理中（done-live 在场）才无动画就位，已结束回合吸底。旧钉顶的持续吸附状态机 + 逐帧动态几何 + 三类内容几何监听 + 临时让位 + settleCheck 轮询全部退役（`msg-pin` sticky、`pinReserveApply`/`roundFoldOpen`/`pinSettleCheck`/`pinMaybeRelease`/`smoothDismissPending`/img load 捕获重算/折叠 toggle 重算/折叠收起 click 接管）；`renderSettle` 保留为渲染权威出口对账（`stageSync`：块失联重挂/高度校准/气泡重定位/跟随归位），`msgAppend`/`applySegDelta`/`renderTransient` 插入锚点 `.pin-stage`。**不变量**：占位块至多一个恒居流末；占位高度只随屏幕不随内容（**且恒 = `max(0, clientHeight − paddingBottom − 脚印)`，无第二写入者**）；用户滚动=让位。

**bubble 失联链根修**：`stage.key` 存 sig（`"idx:ts"`，基线防索引复用错位）而渲染权威气泡 `data-m`=段起始索引（纯数字）⇒ `stageSync` 整页重建后的气泡重找（`[data-m="${stage.key}"]`）恒落空 → bubble 永久失联 → `stageFollow` 的 t0 退化 0 → 落点从贴顶位瞬移内容底。修=`stageSync` 重查找取 sig 索引部分（`":"` 前）匹配 `data-m`，sig 防错位语义保留在 key 本体；**不变量补全：t0 恒取真实贴顶位，失联退化仅允许存在于换皮单帧窗口**。

**触摸让位 + 状态行单行轮转**：①**触摸不释放不摘占位**——触摸手势进行中删一屏高占位 → `scrollHeight` 骤减 → WebKit 触摸滚动基准断裂弹回拖不动（触摸滚动按 touchstart 时布局连续映射手指位移；桌面滚轮=离散事件故现象不确定）。新模型：`stage.touchHold`=手势持有期（touchstart 起，含惯性——touchend 后 scroll 静默 500ms 判停）冻结 `stageFollow` 程序跟随；静默判停 → `stage.yielded=true` 永久让位（stageStart/释放复位）；tap（touchend 位移 ≤6px）不让位。②旧 pin 14 件符号全量退役 grep 零残留；`atBottom` 吸底块保留（有 `!stage.active` 守卫，服务释放后刷新吸底职责）。③**状态行 summary 单行轮转**（后被 §8 状态行落位终局取代，见下）：`liveFoldBody` 双轨（段尾工具组 label 原位替换 / 独立兜底行——命中分支随尾项类型随机=「偶发一行/两行」根因）全删，状态唯一落位=`done-fold` summary 内原位轮转；`bindLiveFoldTimer` tick 由 innerHTML 重建改**节点级原地更新**（`.think-state`/`.d-dur` `textContent` + `.d-flags` 就地替换——重建每秒洗掉扫光动画 `background-clip:text` 与流式预览节点=闪烁根因）；流式预览 `applyStreamPreview` 同挂 summary 一行（host 查找统一 `:scope > .think-stream` 防孤儿）。

**释放链铲除 + 流式预览充满整行 + 占位尺寸公式**：①**用户滚动输入永不摘占位**——wheel/scroll（拖滚动条/键盘）监听器全部只置 `stage.yielded=true`（跟随永久让位到下一回合 stageStart 复位），`stageRelease` 仅剩视图级退出 4 调用点（renderSession 切会话 / renderHome 回首页 / renderMgr 管理视图 / openProjectPreview 项目预览）。**占位生命周期 = 会话视图生命周期**。②**`.think-stream` 充满整行**：删 `max-width` 封顶（行内死空根因）改 flex 子项 `min-width:0` 收缩充满 summary 剩余整行；删 `unicode-bidi: plaintext`（内容以拉丁字符开头时基方向解析成 LTR → rtl 保尾裁切边反转、保尾失效），保尾用 `direction: rtl + text-align: left`；左缘渐隐 1.5em。③**占位尺寸公式**：高度=`max(0, clientHeight − paddingBottom − 脚印)`（`clientHeight` 含 docked 输入栏的悬浮预留，须扣 `padding-bottom`；空白恰铺到输入栏上沿）。④`.think-stream` 用 `flex:1 1 0`（基准 0 只吃剩余空间）——`flex:0 1 auto` 基准=max-content 会撑溢出 summary 行，收缩把 `.think-state`（`min-width:auto`=CJK 单字宽）压成逐字换行。

**占位脚印实时化**：`lockFoot` 诞生快照会让诞生后任何内容增长（乐观气泡图片异步解码撑高、折叠体变高、回复正文流式变长）1:1 变成额外可滚动余量（`maxScroll = padTop + 贴顶位 + 增长量`）→ 内容明明没超一屏，滚到底即可把开启气泡推出视口顶。根修=`stageSync` 脚印改**实时读取**（`foot = topInScroll(占位块) − topInScroll(参照气泡)`，每次对账按当前几何重量）、删 `lockFoot` 字段。**不变量：内容未超一屏时 `scrollHeight ≡ 一屏`、`maxScroll ≡ 贴顶位`**（滚动极限恒=开启气泡贴顶位，内容增长/收起都不改变滚动范围），超过一屏占位归零、自然转内容底跟随。配套：①气泡参照找回**提前到脚印计算之前**（实时脚印依赖参照物在场），且乐观态暂态区无气泡时回落数据区最后一条 `[data-t="u"]` 权威气泡（引导消息 `data-t="g…"` 天然排除）；②参照两端皆缺（重建窗口内）不写占位高度（写 0 = `scrollHeight` 骤减 = 钳制跳变）。

**发送瞬间「跳到上一条消息」根治**：根因①=换出动画窗的初值把 `scrollHeight` 塌陷（占位初高取 `p0=min(乐观气泡高, pStar)`，rAF 平滑拉到 pStar——占位先缩 ⇒ 同一事务内 scrollHeight 先塌 ⇒ 浏览器按塌后 maxScroll 钳 scrollTop，首帧就绘在内容底=上一回合尾部 ⇒ 逐帧抬到贴顶位）；根因②=`route.js` 载入钉顶的 `lastU` 循环漏 `!injected`（末条 user 为注入引导消息时气泡渲染为 `data-t="g…"`，`[data-m=lastU][data-t="u"]` 恒落空 ⇒ `pinned=false` ⇒ stage 全程未激活，且把引导消息当新回合基线 → 下帧 `hasNewUser` 误判）。修：①`stageStart` 删动画窗——**占位高度是几何的纯函数**（参照气泡定了终态就定了），写终态 + `stageFollow` 同帧归位，浏览器只绘一帧且那帧即终态（连带退役 `stage.animT` 与 `smooth` 形参）；②`route.js` `lastU` 循环补 `&& !messages[i].injected`，与 `live.js` 归并为**同一条规则：钉顶只属于新回合开启消息，引导消息恒不钉顶**。**不变量**：占位高度在任意时刻 = `max(0, clientHeight − padBot − 脚印)`；发送事务内 `scrollHeight` 单调不减、`scrollTop` 一次落在贴顶位。探针 `probe-stage-pin.ts`。

**注入吸收帧参照移交**：CLI 桥接会话发送 → 乐观气泡钉顶 → 注入落盘（injected:true）→ `absorbPending` 移除 pending → `renderTransient` 摘除暂态区（乐观气泡 DOM 消失）→ `stageSync` 参照重找。注入开段回合按切段定案 `user:null`（回合在 DOM 没有 `data-t="u"` 开启气泡，注入气泡只以 `data-t="g0"` + `data-g` 织在段折叠体 `done-body` 内）→ 旧回落「末条 `[data-t="u"]`」只能命中上一回合气泡 → `stageFollow` 以 t0=上一回合贴顶位重钉。修：`stage.js` 新增回合权威锚解析 `guideTurnAnchor`（引导气泡 → `closest('details.done-fold[data-m]')` 段折叠；该段若另有 `data-t="u"`（真实 user 开段、引导系中途织入）仍取开启气泡——折叠顶/气泡顶=回合顶=乐观气泡原位）+ `absorbTurnAnchor`（乐观吸收后的同回合锚：以**文档序**判最新回合开启者——最新引导气泡在末条开启气泡之后 ⇔ 注入开段 → 取折叠锚；否则回落末条开启气泡=dequeue 原行为）。**禁止回落上一回合**。实时同步中到达的注入消息不主动触发钉顶（本修只接管「乐观参照已死」的对账帧）。已知候选（未改）：`route.js` 载入钉顶对「末回合为注入开段」的会话仍钉上一真实回合，与「最后回合开启气泡在场即唤出占位」定案存在张力；若要统一，锚解析可复用 `guideTurnAnchor`（key 重找需同步支持折叠锚）。

**视口基准 dvh**：`html,body{height:100%}` 是恒定大视口（=URL 栏收起态高），iPad Safari 顶栏展开时叠盖视口顶（贴顶位在视口顶下方 padTop 处，顶栏展开高 > padTop 即盖住气泡顶），且占位高度按大视口补空白导致底部溢出屏幕。根修=`html{height:100%;height:100dvh}`（100% fallback）：dvh 随顶栏伸缩，视口顶恒=可视区顶，占位高度/贴顶位/stageFollow 几何自动自洽，resize 重算链现成咬合，JS 零改动。同批 renderCap 归一化：`capRenderedMessages` 收拢全数组占位计数 + 剥全量替换路径挤到中部的残留，强制「至多一条占位、恒在下标 0」。

**状态行落位终局**：**`done-fold` summary 恒「正在处理·NmNs」/「已处理·NmNs」两字样**（脉冲点/箭头除外，任何状态不再轮转上顶）；思考/压缩扫光状态行落**段体尾部 `.fold-state` 容器**（与工具调用行同域、单宿主单实例——不复活「尾组 label 原位替换 + 独立兜底行」双轨，随机命中根因不回归），流式预览 `.think-stream` 与无响应/连接中断红标同容器。接线：`liveFoldBody(items, vacuumState, vacuumStart)` 真空态渲染帧在段尾产出状态行（工具运行态不产出=正运行工具行即活动指示）；`bindLiveFoldTimer` tick 双行独立跳字（summary `.d-dur`=段总时长、`.think-state`=距最后落盘 Ns）+ 红标宿主=状态行容器（真空态）或 done-body 尾（工具态）；乐观主张折叠同规则（`claimTick` 红标落 claim done-body、`applyStreamPreview` claim 路径落 done-body，summary 恒「正在处理」）。

**状态层并入构造期拼接**：用 `sumEnd` 字符偏移回切插入状态层会错位（漏算 `<details class="tool-fold"><summary>` 前缀字符数，把 summary 内 `<span class="tf-label">` 开头切碎）。根治=废弃字符偏移回切，**`stateAppend` 构造期拼接**：`flushTools` 拼 summary 时直接带上状态层，仅循环后那次 flush 生效（旁白打断的收口组不带）；`stateMerged` 判定真并入，尾部无工具组（纯思考真空/末尾是旁白）→ 段尾独立行。

**状态层顶替概括 + MCP 名短显 + 标签省略**：①真空态两状态并存（折叠顶同时出现「运行了命令（2） 正在思考 · 17s」）→ `flushTools` 补 `stateAppend` 分支：并入帧 `sumInner=''`，summary 只渲染状态层，工具明细点开折叠仍在、回合收口后恢复完整概括（留存语义不变，仅显示时机让位）；②MCP 原始名裸奔 → `toolMeta` 补 `mcpShortName`（沿用源码 `mcpInfoFromString` 的 `split('__')` 解析约定取 tool 段，无 tool 段退回 server 名；仅显示层，权限匹配仍走原始名，`data-name` 属性保留原始名）；③超长标签撑行 → `.tool-fold summary .tf-label` 补 `min-width:0 + nowrap + ellipsis`（`.tl-text` 同配方）。

## 9. 其它渲染与显示

**用户消息图片渲染**：链路 = ①源码权威导出 imageId 化（`conversationDisplay.ts`：`DisplayBlock.imageId` = pastedContents id = `image-cache/<sessionId>/<id>.<ext>` 文件名主干；SourceMessage/queued attachment 的 `imagePasteIds` 按序对位 image 块）→ ②网关字节端点 `GET /gateway/image-cache/<sessionUuid>/<id>`（readdir `<id>.*` 解析扩展名，MIME 按 extname，**`private, no-cache`**，自动受 /gateway token/cookie 保护）→ ③前端 `userBodyHtml`（气泡只出文本，剥 `[Image #N]` 占位）+ `userImgsHtml`（`<div class="msg-imgs">` 容器在 `.body` 后——`.msg` 无背景=**气泡框外正下方右对齐**；引导气泡 + 开启消息两处接线；img `data-ph` + `onerror`：**图未落盘时替换为 `[Image #N]` 裸文本不出破图**——`cleanupOldImageCaches` 会把非当前会话的 image-cache 全删（父源刻意行为，「会话重启后图片不留盘」由此而来），404 是常态而非异常），`renderSession` 设 `live.curUuid` 供首屏图片 URL。**两气泡根修**：`normalizeMessages` 把「text+image」人发消息拆成 text-only 与 image-only 两条，web 原样输出即两个气泡；`filterConversationForDisplay` user 分支末尾重组——image-only 且带 imageId 且前一条真人 user 消息 text 含对应 `[Image #id]` 占位 → 并回前一条（工具截图 tool_result 场景因前面是 assistant/无占位自然不合并）；历史回放/实时上报/离线兜底三链路同享同一函数。样式 `.msg .msg-imgs .msg-img`（缩略图上限 240px + 单击 lightbox 大图预览——`ensureLightbox` 单例覆盖层 + document 级事件委托 `closest('.msg-img')`，src 复用同 URL，点击/Esc 关闭，z-index 1200；多图纵排）。**错图回卷根修**：同会话多张图全分 id=1——前端 `renderSessionBody` 每次渲染清零重扫 `live.maxImgId`，视图在压缩归档/delta 重写窗口丢历史 image 块即回卷 → 复用 1 号 → CLI `storeImage`（open 'w'）覆写同名字节 + 网关旧 max-age 把旧字节钉死 = 新气泡显示旧图。双修：①分配器**单调不回卷**（重扫只增不清零——id 唯一性是分配器不变量，不依赖视图完整；跨会话基准偏高无害，image-cache 按会话分目录）；②网关字节端点 `private, no-cache`。诊断法：转录 jsonl 的 `imagePasteIds` 撞号 + image-cache 单文件 mtime=最后写入时刻，离线跑 `filterConversationForDisplay` 可验投影完整性（探针 `probe-imgid-*.ts`）。

**变更卡文件列表显示相对启动根路径**：网关 `readSession`（`/gateway/session`）取转录记录自带的 `cwd`（= 会话进程启动根：CLI=exe 目录=项目根、web 笔=全局根、web 项目=该项目根）随载荷附出；前端 `fetchMessages` 存 `sessionCwd`，`relFromCwd()` 把 fileChange 绝对路径（`\`→`/` 归一 + 大小写不敏感）剥掉启动根前缀显示相对路径，不在根下/无 cwd 回退 basename；`.ch-file` 加 rtl 方向技巧（溢出省略头部、文件名端保持可见）。仅显示层——变更聚合/去重 key 仍用绝对路径，实时（SSE fileChange → `liveChanges` → `commitLiveChangeCard`）与历史（`seg.changes`）两路同走 `renderChangeCardHtml` 一处生效。

**后台任务通知居中气泡化**：「一回合两个复制按钮」= 通知唤醒续跑的真实数据形态——回合以 `end_turn` 收尾后，后台 Bash 任务完成以 `<task-notification>`（`role:'user'`，`origin.kind='task-notification'`）落盘注入唤醒，AI 续跑后再次 `end_turn` 收尾 → 同段两次正式发言（多轮 end_turn 各自原位气泡，数据忠实非拆错；CLI 侧 `>` 只标用户消息，两条 AI 发言之间本就无第二个 `>`）。定案形态：**通知以居中浅灰气泡按时序堆叠**——实现：`conversationDisplay.ts` isTaskNotify 分支恒下发 `pushSystemHint('后台任务完成：'+summary)`（**移出 SHOW_NON_INTERRUPT_HINTS 总开关单独恒显示**，其余非中断提示维持隐藏），web 复用 `role:'system'` 居中行渲染（切段遇 system 收口当前段 → 通知后处理开 `user:null` 新段自带折叠体，时序归属完整）；`.msg.system` 为浅灰气泡（用户气泡同款 `#f2f2f3` 底、fit-content 居中、85% 上限换行，中断提示等同形态统一）。CLI 界面渲染组件不动。附带：`normalizeMessages` switch 无 default，queue-operation 等元记录直喂产生 undefined 崩 `isNotEmptyMessage`——网关 `readSession` 的五类型前置过滤即为此设，任何新消费端直读 jsonl 必须带同款过滤。

**限流降级提示居中灰 + resume 哨兵全端剔除**：①统一限流降级（`getRateLimitErrorMessage` 返回 null、备用模型接手）不再发 `NO_RESPONSE_REQUESTED` 静默占位——改 `rateLimitFallbackNotice(model)` 生成可见提示「模型用量已达上限 · 已切换备用模型（model）」，仍记入会话历史供模型看到；CLI 端 AssistantTextMessage 前缀匹配居中灰渲染（置于 switch **之前**——动态文本不进精确 case，且 default 首位无 break 会贯通灭掉全部 case），web 端经投影前缀命中转 `pushSystemHint` → `role:'system'` 居中灰胶囊（移出总开关，web 前端零改动）；②resume 补位哨兵（`conversationRecovery` 在末尾 user 消息后追加的 `NO_RESPONSE_REQUESTED` assistant 占位，保 API 结构合法，数据层保留）权威投影层 assistant 分支按精确文本整条剔除——CLI 原有 return null，web 侧曾从投影漏出被渲染成回复气泡，历史回放与实时增量投影同治。

**审批栏正文按工具语义渲染**：旧版把 `a.input` 原样 `JSON.stringify(input,null,2)` 倒进正文，改 `prettyToolInput(toolName,input,desc)`（`inputbar/approval.js`）：Edit/MultiEdit（`input.edits[]`）=文件名 + **红/绿两段文本 diff**（`.appr-diff`，行首 `- `/`+ ` 前缀 + 两端行数标题；`replace_all` 附「替换文件中全部匹配」）；其余工具=**中文字段标签 + 值**列表（`FIELD_LABELS` 标签表 + `TOOL_FIELD_ORDER` 每工具字段序，未列字段追加在后）；命令/正文类字段（`command`/`content`/`new_source`/`prompt`）恒落 mono 代码块（`.appr-pre`），多行/超 140 字符值自动升级成块；`boolean true`→「是」，`false`/`null`/空串不渲染；与卡头说明（`a.description`）逐字重复的字段不再渲染一遍。纯 web 展示层格式化：进料仍是 CLI `sendRequest` 原样透传的 `a.input`，不改协议、不新增后端字段。离线自测 `probe-approval-pretty.ts`（从源码按标记切片求值，测真源码非副本），含转义/XSS 断言。

**审批栏入场动效**：旧版入场零过渡（输入内容组瞬间 `display:none`、按钮行以全不透明瞬间出现，只剩 `height` 长出把卡面往上展开）。新增 `.appr-in`（`@keyframes apprInUp`：`opacity 0→1` + `translateY(10px→0)`，220ms ease-out）与高度长出（320ms）**同帧起播**；卡面本体（白底/描边/圆角/阴影）在 `.bar-takeover` 态不退场 ⇒ 内容淡入不露首帧空洞；10px 位移落在卡片底部内边距内 ⇒ 按钮行不被裁角；**只在「普通输入栏 → 卡片」那一次播放**（`showTakeover` 的 `firstShow = !takeover && !wasClosing` 门），换题/重渲染不重播。CSS 承载：正文族 `.appr-input/.appr-kvs/.appr-kv/.ak-l/.ak-v/.appr-file/.appr-meta/.appr-pre/.appr-diff*`（注入 CSS，`core/gateway.js` `gatewayCss`），入场 `.appr-in`（`web/styles.css`）。

**审批栏高度视口预算 + 收起并行式**：①**高度**：`.appr-body` 旧定值 `max-height:200px` 会让十几行命令体恒出滚动条；改视口预算 `max-height:calc(100vh - 260px)`（`100dvh` 后置声明，不支持的引擎落回 vh；预算＝黄条带 38 + 按钮行 60 + 底距 22 + 聊天区至少可见 ~140），正文吃满自然高度、仅真超屏才滚（真边界非兜底）。②**收起 = 单一时间轴并行**：`collapseTakeover` 并入 `clearTakeover`，一个函数里同帧起播三件事——①`.appr-out`（`@keyframes apprOutUp`：`clip-path:inset()` 底边 0→100% 插值 + opacity，170ms，须 ≤ `HEIGHT_MS`=320ms ⇒ 卡在折叠收口前先淡尽）②`.bar-collapsing{justify-content:flex-end}` + 撤 `.bar-takeover`（输入内容组复现并贴底对齐：输入栏底边由 docked `translateY(-100%)` 固定 ⇒ 折叠期内容零位移、只有顶边下移收短）③`.bar-reveal`（`@keyframes barRevealIn` 170ms，输入内容组淡入）。**几何不打架的关键**：收起期卡片仍走 `.composer-growing` 的 `absolute bottom:0`（底边钉原位、只有顶边下移）⇒「卡自下而上被削掉」与「下方同步露出输入内容」是同方向的两个动作，在底边处自然交叉过渡（卡与输入内容同域重叠 ~170ms=交叉淡入淡出）。常量：`HEIGHT_MS` 长出/收回共用一条时间轴，须 = `styles.css #input-bar` 的 `height 0.32s`；跨模块导出表同步改名。配套不变量：`syncTakeoverPad`（聊天底垫）在收起启动同帧清零（该写须在 `wrapAnimating` 置位前直接写，否则守卫会挡 RO）；`cancelClose()` 在新 takeover 到来时撤三态残留 + 停待执行相位；`showTakeover` 先清 `inputBarEl` 内联高度再实测（残留内联高度 ⇒ h1 失真 + `|h1-h0|<1.5` 早退 ⇒ 输入栏永久卡在错误高度）；`finishClear` 复位 `wrapAnimating/wrapClosing`（否则被顶号即泄漏 `wrapAnimating=true` 卡死 pad 同步）；`takeoverPlainH` 只在非收起态记录。**审批卡是同链唯一在场者**（只读 question 卡已移除，见 §17，交接链路原样保留）。

## 10. 内存优化链

**P1 渲染历史上限（REPL.tsx）**：`capRenderedMessages` 把 React messages state 收敛为尾部 200 条（`MAX_RENDER_MESSAGES`），更早消息替换为单条归档占位（system/informational，计数从占位文案自身解析=幂等，/clear、resume 换会话自动重计）；cap 在 setMessages wrapper（Zustand 模式）baseline 判定之后落 ref/state；初始 useState 同样 cap（resume 全量载入被窗口化）。**语义变化：transcript 虚拟滚动回放同样只见窗口**（完整历史权威在 jsonl）；数据层（query 循环 / `filterConversationForDisplay` 完整尾部语义）不经 cap。

**P2 增量上报（conversationDisplay.ts + localGateway.ts）**：CLI 侧 `displayCacheBySession`（键 `${sessionId}:${mode}`，存已上报投影序列 + lastModel 末态 + 失步标）做「水位对齐 + 尾部窗口投影」——DisplayMessage 的对齐键为**位置无关稳定键 `sid`**，`filterConversationForDisplay` 新增可选 `initialLastModel/lastModelOut`（「已切换模型」提示跨扫描续算），每轮发 `{sessionId, messages, base}`；网关 `/gateway/conversation` 按 base 聚合为全量（越界=按窗口展示），响应带 `cached` 长度，CLI 校验不符（网关重启/sweep 失步）置 needFullSync 下轮全量直传对账；无 base=全量替换。P1×P2 联合效果：单轮构建/序列化/传输峰值恒定（≤200 条投影），网关聚合保留 web 端全量语义。已知名义缺口：CLI 进程重启后 cache 空且窗口首条对不上网关缓存时走窗口全量替换（web 端前缀短暂缺失，jsonl 权威在盘）。

**P3 web 注入图压缩前移（gatewayClient.ts）**：`compressPastedContentsFromImages`（WS send 分支）对 >2MB 原图先 `compressImageBuffer`（复用 imageResizer 既有管线）再入 pastedContents，pastedContents/历史/落盘全链收敛小图；CLI 本地粘贴链的执行时 resize 原样保留兜底。

**P4 结论（无代码改动）**：fork ink 为双缓冲 screen-blit 架构（`renderer.ts` frontFrame/backFrame diff blit），不存在上游 ink Static 行缓冲——内存驻留主体=React 树（messages state），已由 P1 有界化覆盖。

## 11. 教训（勿忘）

①引导消息「吞消息/顺序颠倒」一类渲染 bug 先查 jsonl 物理落盘位置与用户感知顺序的差异（queue-op 消费时序），不是前端渲染逻辑先坏；②折叠唯一性破坏（多 fold）会让钉顶/计时/增量重建锚点全链错位——「已处理永远在第一个消息下」是结构性不变式，任何新渲染方案不得引入第二个 done-fold；③对生成好的 HTML 字符串做偏移切片插入是脆弱机制（前缀长度一变即错位），插入内容应在构造期随模板拼出，不做事后回切。

## 12. 前端模块化架构（web-src/）

**定案**：web 前端 JS 源码模块化——`_agent-src/src/gateway/web-src/` 下 22 个 ESM 模块，**web-src/ 是唯一手改处**；构建时 `scripts/build.ts` spawn 自写拼接器 `scripts/bundle-web-modules.ts` 把各模块按切割区间行序拼回单 IIFE 写 `web/app.js`（生成物勿手改，每次构建重新生成）。产物文件名/引用不变，sw CORE、`?v=` cache-bust、gen-web-assets、网关静态路由全链零改动。

**打包器定案——自写拼接器（非 Bun.build）**：Bun.build 按依赖图**重排模块执行序**，而多个模块的顶层立即执行代码（事件绑定/DOM 初始化）引用 `state.js` 的 const → TDZ 崩溃；且 IIFE 顶部切割区间外的 `const $ = (id) => document.getElementById(id)` 不属任何模块、切割即丢 → `state.js` 顶层 `$('chat-area')` ReferenceError。根治=拼接器按 MODULES 表**原区间行序**拼回（行序=原执行序，TDZ 不可能复现；`const $` 注回 IIFE 顶部原位；头注释 + IIFE 壳照原版重建）。拼接器三机制：**锚点检索**定位区间起点（区间首行=节标题/独特函数签名，手改增删行不破坏拼接）、**marker 尾界**（`// —— 跨模块写入口`/`export {` 首现处，body=头尾全量）、**首行防呆**（锚点前必恰有 1 分隔空行=第二重校验）。setter 跟随定义模块末区间输出（0 缩进 function 声明，hoisting 无 TDZ）。

**模块布局**（按原 IIFE 分区机械切割，源码守恒）：
- `app.js` 入口=import 群 + 事件绑定 + 启动序列
- `core/`：icons（SVG 图标）、state（元素引用/共享可变态/toast/媒体工具）、char（角色形象）、markdown、sessions（会话映射）、live（SSE 会话事件）、gateway（WS 连接/审批中继）、auth（门禁认证/设备认证）
- `sidebar/`：mgr-data（管理数据源）、recent（最近会话）、mgr（插件/项目/模型三界面 mgr-tabs）、bubble-search、neurons（神经 tab）
- `inputbar/`：ctx-meter（ContextMeter）、mention（@提及）、commands（命令菜单）、model-select（模型选择/状态域）、approval（审批卡/回合态/takeover/任务浮窗）、images（图片附件 + 文件上传）、send（gwSend/syncGwSend）
- `chat/`：route（路由渲染）、messages（消息渲染）、stage（钉顶占位/stage 机制）

**跨模块可变状态 = SETTERS 机制**：14 个跨模块写入的 let（`ALL`/`connUp`/`gateAwait`/`gateVerified`/`sessionCwd`/`takeover`/`turnLive`/`btnMode`/`MODEL_CUR`/`modelUserPicked`/`pendingUserMsgs`/`firstSendHash`/`lastNavHash`/`approvalPending`）在定义模块尾生成 `export function setX(v){X=v}`，写入方一律调 setter（import 绑定不可赋值=ESM 硬约束）。读跨模块符号走 import（函数级循环 import 安全：hoisting + live binding）。

## 13. 排队消息催办：点击排队气泡打断当前思考

**语义**：点击置底排队区某条气泡 = 「这条我等不及了」。效果**与「模型自然答完后排队消息被纳入」完全一致**——该消息作为注入引导织进**当前**折叠体，模型在**同一回合**里接着答它。明确排除两件事：①**不是新的乐观气泡**（不产生新回合）；②**不是中断**（不走 `onCancel`，无「用户中断了对话」提示、无撤回/restored 链）。生效时机：**只在模型生成（思考）时打断**；模型正在跑工具时点击不动它——排队消息会在本次工具批次结束后的中链 drain 自然纳入。

**引擎侧（`query.ts` + `messageQueueManager.ts`）**：既有中链 drain（每轮工具循环开头把队列里的 prompt 命令转成 `queued_command` 附件）本就是「纳入」的唯一路径，缺的只是「现在就走」的触发。**不能用回合级 `abortController`**——它是 `callModel` 的 signal，abort 会污染本轮之后所有迭代，且 abort 分支会 `return {reason:'aborted_streaming'}` 直接结束回合（=被否决的「新回合」语义）。故新增**生成级断流**（不变量：**队列非空 且 当前有一次生成流在飞 且 该生成尚未产出完整的 `tool_use` 块 → 断流**）：①`messageQueueManager` 加催办标记 `queueNudgeRequested` + `requestQueueNudge()/peekQueueNudge()/consumeQueueNudge()` + `getDrainableQueuedPrompt()`（可催办对象判据＝`mode:'prompt'` ∧ 非斜杠 ∧ 主线程 `agentId===undefined`，与 drain 过滤同语义），并在 `notifySubscribers()` 里「队列清空即失效」；②`query.ts` 生成流 `for await` 循环体首行 `if (isMainThread && toolUseBlocks.length === 0 && peekQueueNudge()) break`（`toolUseBlocks` 是**本迭代**数组，且 tool_use 块只在 `content_block_stop` 才入数组/执行器 ⇒ 此处为 0 时断流**不可能**留下孤儿 `tool_use`、无需合成 `tool_result`；生成器 finally 会释放 HTTP 流，break 出 for-await 是既定用法）；③收口在 `if (!needsFollowUp)` 之前：`if (!needsFollowUp && consumeQueueNudge()) needsFollowUp = true`——不让回合在生成结束处收尾，改走 follow-up 路径，下方 drain 把排队消息转成附件并 `removeFromQueue`，循环底部续跑下一迭代 ⇒ 模型同一回合答这条消息。一次性消费 ⇒ 不会无限断流；队列清空即清标记 ⇒ 不会跨回合误伤。

**链路**：web `.q-item` 点击（事件委托，`#live-zone` 重建不影响；`cursor:pointer` + hover 浮起 + `title` 提示「点击催办：结束当前思考，本条立即并入本轮」）→ `/clients` WS 发 `{type:'queue-nudge', sessionId}` → 网关 `handleWsMessage` `case 'queue-nudge'` 按会话精确路由（未在线回 status；**不 resumeAndDeliver**——离线会话没有生成流可断，排队消息在那边本就只走常规投递）→ CLI `gatewayClient.ts` 收帧 → `src/bridge/gatewayQueueNudgeHandle.ts`（模块级句柄，仿 `gatewayInterruptHandle.ts` 模式）→ REPL 注册 handler 判活两条（缺一不可）：**①有在飞生成**（`abortController` 存活）、**②队列里确有可 drain 的用户消息**（`getDrainableQueuedPrompt()` 非空）→ `requestQueueNudge()`。headless（无 REPL）无句柄 → 静默忽略；旧 exe 收到未知帧同样静默忽略。

**已验证**：`messageQueueManager` 侧自取证探针 `_agent-src/probe-queue-nudge.ts` 16 项全过（可催办对象判据四种形态 + 一次性消费 + 队列清空失效）。

## 14. 处理中段尾部工具组恒收口

**根因**：`liveFoldBody(items, vacuumState, vacuumStart)` 中收口函数 `flushTools()` 的调用点原本只有两处——循环内被旁白/文本/引导气泡打断的组，与 `if (vacuumState)` 分支内。而 `vacuumState` 判定 `busyOk = processing && !s.pendingTools.length && !(lastAsk 未答)`：**只要有工具在飞，`pendingTools` 非空 → `busyOk` 必假 → `vacuumState === null` → 该分支不进 → 尾部工具组整组不产出**（无中断项故循环内那处也不触发）。后果：处理中段体整段空白，段内已完成的工具行与在飞工具行一并消失；工具结果落盘那一帧 `pendingTools` 清空、真空态成立，才借真空分支长出折叠行。同理 `flushTools` 内的 running 分支（`正在运行：<工具> · <详情>`）此前是**不可达出口**——而它正是「状态行」定义里的「正在运行:<工具>」那一位。

**根治**：把 `flushTools()` 从 `if (vacuumState)` 分支内提到分支外**无条件收口**（`flushTools()` → `if (vacuumState && !stateMerged) html += 段尾独立状态行`），`stateInner` 声明上移到分支外。真空态并入折叠 summary 的原路径不变（`stateAppend` → `flushTools` → `stateMerged`），故「并入时折叠顶只留状态行、不带 tf-label 概括」不受影响。**不变量：处理中段的尾部工具组恒有渲染出口**；段体空白只允许发生在「无工具且无真空态」的瞬态（即模型刚好在两次落盘之间的空窗）。

**自取证（跑真实函数体，非复刻）**：`probe-livefold.ts` 与打包器同源（剥 `messages.js` 的 import/export 行、只对跨模块名注入纯 stub，再调用**真实 `liveFoldBody`**；fixture 按真实形态：工具项恒带 `html=toolLine(b)`、`done` 由后续 `tool_result` 标记——`if (!it.html) continue` 会跳过无 html 项，不带 html 的 fixture 测不到产品路径）。`--prefix` 开关把尾部 `flushTools()` 还原回旧出口跑同一组样本做对照。

## 15. 底栏任务浮窗（TodoV2 清单）

**需求定案**：清单内容在 web 被渲染；创建类似 list 时候，从底栏生长出一个宽度小于底栏的浮窗，在底栏下收敛状态仅显示边沿，鼠标点击浮窗向上伸展、再次点击向下收敛；任务栏作为底栏的一个子元素，定位依照底栏位置设定。四问定案：**数据源=新增 `task-state` 链**、边沿位置=输入栏上沿之上、展开形态=宽=输入栏宽−48px 居中向上到聊天区 40%、与接管栏=自动收敛并禁点。

**为什么必须走新链**：CLI 清单渲染在 `TaskListV2`（`src/components/tasks/TaskListV2.tsx`），可见性由 `useTasksV2`（`src/hooks/useTasksV2.ts`）单例 store 决定——`getSnapshot()` 在 hidden 或清单空时返回 `undefined`，模型/子 agent 通过 `TaskCreate/TaskUpdate`（TodoV2 工具，`isTodoV2Enabled()` 门控）写入。web 侧无法从 jsonl 或既有信号推出「此刻可见的清单」（工具调用参数 ≠ 清单状态，隐藏计时器/兜底轮询都在 store 内），复刻即违反根本原则 1。

**链路（CLI 单源 → 网关镜像 → SSE/首载 → web 渲染）**：
- CLI 出口：`useTasksV2.#notify()`（`#fetch` 与隐藏计时器两条路径唯一汇合点）→ `#report()` → `gatewayClient.notifyTaskState(this.getSnapshot() ?? [])`。**载荷去重**在 `notifyTaskState` 内做（`lastTaskStateJSON` 比较，store 兜底轮询原样重发不发）；`sock.on('open')` 补发当前清单。
- 网关（`src/gateway/localGateway.ts`）：`normalizeGatewayTasks` 是**形状边界唯一处**——非对象/缺 `id`/缺 `subject` 项丢弃；未知 `status` → `'pending'`；`subject` 截 500；`blockedBy` 只留字符串；非字符串 `owner`/`activeForm` 落 `undefined`；`description` 等长文本不透传。存 `sessionTasks` Map（**无时间 TTL**——有 TTL 会与「载荷不变不发」的去重矛盾，活跃会话清单十分钟不变即被 `sweepStaleMaps` 清仓 → 首载/刷新拉到 `[]` 当权威 → 浮窗消失；生命周期=上报 upsert + `detach()` 清 + 重连 open 补发）+ CLI `detach()` 清，`/gateway/session.tasks` 首载 + SSE `{type:'task-state', session, tasks}` 事件体直带全量快照。
- web（`core/live.js` 的 SSE 分支 + `core/sessions.js`/`chat/route.js` 首载三入口）写 `live.tasks` 后调 `renderTaskDock()`；切会话/回首页槽位清空同清单同步。

**单源不变量**：web 渲染的清单 = CLI `getSnapshot()` 的同一份语义（hidden/空 → `[]` → 浮窗整体不出现），**web 无任何状态推导、无形状兜底分支**——形状校验只存在于网关一处（这里的形状边界守护的是「web 消费端恒可信任载荷」）。

**DOM 与几何**：`#task-dock`（`index.html`）是 `#input-bar` 的**子元素**（`#input-bar` `position:relative` 为其定位上下文），`bottom:100%` 贴输入栏上沿之上、`overflow:hidden` 作裁切盒，`pointer-events:none`（仅在 `.td-lip` 与展开态 `.td-panel` 上恢复）保证不可见盒体永不挡聊天区点击。收敛态面板 `transform: translateY(100%)` **整块藏进输入栏后**，露出件只剩 `.td-lip` **12px 把手条**（hover 14px，兼作点击热区）。**把手材质 = 同族材质**（`background:#fff` + `1px solid rgba(0,0,0,0.1)`、`border-bottom:none` 紧贴栏顶不画第二道线、`border-radius:10px 10px 0 0`）——收敛态露出的**就是 `.td-panel` 自身的顶边**（与展开态同材质，揭示/收合视觉连续）；`.blocked`（接管卡在场）加 `opacity:.55` 显式弱化。展开态面板 `translateY(calc(-1 * var(--td-gap)))`，`--td-gap` = **10px** 为面板底边与输入栏上沿的间距；几何唯一出口 = `#task-dock` 上的 `--td-gap` 变量，盒 `padding:18px 10px 0`（上 18px 供展开态上移后浮出阴影不被裁）。点击边沿/`.td-head` 切换 `.open`（0.32s cubic-bezier，与接管栏同款缓动）；宽=输入栏宽−48px 居中（`margin:0 10px` + 盒左右 padding 10px），`max-height: min(40vh,460px)` 内部滚动，展开态重渲保留 `panel.scrollTop`（兜底轮询不跳顶）。行渲染与 CLI `TaskListV2` 同构：图标 `✔/◼/◻`、id 数字升序（非字典序）、`completed` 与「被未完成前序阻塞」行 dim、阻塞行 tooltip「等待前序任务：<id>」、`in_progress` 行 tooltip = `activeForm`（CLI spinner 同源）、owner 渲染 `@name`。**接管让位**：审批/提问卡入场（`showTakeover`）→ 自动清 `taskOpen` 并加 `.blocked`（边沿 `disabled` + `onclick=null`），卡撤走（`finishClear`）恢复可点且**仍保持收敛**（由用户点开）。

**自取证**：`_agent-src/probe-task-dock.ts`（源码切片求值模式：从 `inputbar/approval.js` 按标记区间取出浮窗区间 + 最小 DOM 桩求值，测真源码非复制品；另从 `localGateway.ts` 切 `normalizeGatewayTasks` 经 `Bun.Transpiler` 剥类型后测形状边界）——10 组 39 断言全过。

**实测前提（勿漏）**：本链的**上报端在 CLI 进程内**（`useTasksV2` → `notifyTaskState`），故**产生清单的那个 CLI 会话本身必须跑含本链的新 exe**；换网关 exe 只更新 web 前端（内嵌资源）不足以显示。**旧 exe 会话的换新路径**：web 侧栏关闭该会话进程（或本地退出窗口）→ web 再发消息即由网关 `resumeAndDeliver` 拉起 `process.execPath`（=网关自身新 exe）→ 此后清单才会上报。

## 16. 并发复合状态行：运行行与状态行并存

**并发是结构性的，非抖动**：`query.ts` 在流式循环内 `streamingToolExecutor.addTool(toolBlock, message)`——工具的 `tool_use` 块一旦 `content_block_stop` 即开始执行，而模型 HTTP 流仍在产出后续块 → **搜索在跑的同时引擎仍在产出**（思考/下一动作）。CLI 侧闪烁的来源是同源判据按**内容块重算**（`isActiveCollapsedGroup` 由逐块重置的 `streamingText` 喂，块边界处真假交替 → 组头在「活动」与「非活动」间翻）；web 侧的对应病根是把两件事**绑成互斥**：`busyOk = processing && !s.pendingTools.length && !(lastAsk 未答)`——只要有工具在飞，真空态必假 → 状态行必熄；工具一落定状态行又亮。这是「一个真值承担两件事」的绑定错误，不是阈值问题。

**根治（纯前端，零协议改动）**：状态行表述的是「**引擎仍在产出**」，与「**工具在飞**」正交，分档判据即不变量——
① **无工具在飞**（且无待答提问、回合未收口）→ 回合未收口即引擎必然在产出（**推断**成立，原 `busyOk` 语义原样保留）；
② **有工具在飞** → 引擎是否仍在产出**不可推断** → 取**证据**：turn-beat 新鲜度。`live.turnBeat` 是既有信号（CLI `setResponseLength` 内容增长分支 → `notifyTurnBeat`，4s 节流；thinking_delta / text_delta / input_json_delta 三类 delta 全汇聚于此），无需新增上报链。阈值 `BEAT_FRESH_MS = 6000`（节流窗 4s + 2s 抖动余量）；beat 早于本回合起点（`s.user.timestamp`）视同缺席（与 tick 的回合基线 clamp 同规则）。新鲜 ⇒ 真并发 ⇒ 状态行与「正在运行：<工具>」同 summary 并存（`stateAppend` 构造期拼接天然支持并存）。**并存形态 = 一行一句**（状态作原子尾缀并进运行行，见 §19）。
③ **显式实证先于推断档**：`lastStep==='compact'` / `compact-state` SSE 在 TTL 内 ⇒ 直接 `'compact'`，**不**受「工具在飞」取证约束（压缩与工具同时在场是巧合而非不变量；把实证挂在推断之后正是本次要根除的绑定错误）。

**判定收敛**：`web-src/chat/messages.js` 提纯函数 `vacuumOf(s, processing, live, now)`（判定表唯一出口，替代渲染点内联的 `busyOk`/`cfTs`/`vacuumState` 拼装）；`flushTools()` 的 running 分支保留 `${sumInner}${stateAppend}` 语义。**自取证**：`probe-concurrent-status.ts`（与打包器同源，调用真实 `vacuumOf` + 真实 `liveFoldBody`），A1-A12 判定表 + B1-B5 端到端合成；`--prefix` 开关把 `pendingTools` 分支还原成旧式 `return null` 做对照。

## 17. web↔CLI 四缺陷根治：spawn 在途登记 / WS 心跳 / 审批等待红标 / 只读提问卡移除

① 与 ② 的网关侧根因/修法/证据 → [gateway.md](gateway.md) §7；本节收 ③④ 前端段与两处的 web 观察面。

**③ 等待审批被误判「无响应」（纯前端，零协议改动）**：`live.js` tick 与 `claimTick` 的 `staleSec >= 150` 红标在审批等待期稳定误报——CLI 停在权限弹窗、内容零增长 ⇒ turn-beat 停发。修 = **用既有接管态抑制**：`awaitingApproval = takeover === 'approval'` → 红标判据串入 `!awaitingApproval`（`inputbar/approval.js` 同判据）。**为何选展示层而非让网关刷 `turnBeatAt`**：接管态本就是既有状态，抑制红标只是读它 ⇒ 状态源不增反稳（根本原则 5）；网关侧刷 beat 等于凭空造出一个说假话的第二状态。`· 连接中断` 分支不动（那是 `connUp` 真值，与 staleness 无关）。长静默工具运行的豁免见 §18 ③。

**④ 只读提问卡整体移除**：该卡是 web 自绘的**非交互** AskUserQuestion 接管卡（`#composer-takeover` 内 `.question-card`），渲染但无任何交互入口；可交互提问走 CLI 审批链 `renderQuestionApproval` 下发的 `.appr-card.qa-card`（选项/多选/自定义输入/跳过/翻题，样式在 `gateway.js` 注入 CSS），与它无关。移除面（四处代码 + 一处样式）：①`chat/messages.js` 删 `questionCardHtml` 与 `messagesHtml` 内 `setPendingAskInput(null)` 复位、尾部上报块（`seg.lastAsk` 机制**保留**——空洞态抑制仍在用）；②`inputbar/approval.js` 删 `let pendingAskInput = null` 与 `setPendingAskInput`（含 export 块条目），接管类型收窄为 `'approval' | null`；③`chat/route.js` 与 `core/live.js` 两处 `showTakeover(questionCardHtml(…))` → `if (takeover !== 'approval') clearTakeover()`；④`web/styles.css` 删死样式 `.question-card`/`.q-*` 整块，`#composer-takeover` 选择器组去 `.question-card,` 保 `.appr-card`。交互式审批卡零改动。

## 18. 状态显示行行首槽对齐 + 扫光统一 + 无响应豁免扩面 + 折叠开合恢复键

**① 行首槽对齐（跳动根因）**：工具行 `.tool-line` = `.t-ico`（16px 固定槽，内含 DSH `IconThinkOutline14` 原子图标 `THINK_ICON`）+ 5px gap + 文字 ⇒ 文字左缘恒 21px；状态行 `.think-state` 此前是**裸文本** ⇒ 文字左缘 0px。同一 `details` summary 内「正在运行：<工具>」⇄「正在思考/生成/压缩」轮转时整行文字横移 21px = 跳动。修：①`messages.js` 状态行构造补 `<span class="t-ico">${THINK_ICON}</span><span class="ts-text">${label}</span>`；②`live.js` tick **只写 `.ts-text` 子节点**（整节点 `textContent` 会连图标槽一并洗掉 → 槽消失、回跳复发）；③`styles.css` 把 `.t-ico` 从 `.tool-line .t-ico` 提升为**通用类**，`.think-state` 加 `gap: 5px` 与工具行同基准。图标复用既有资产零新增。

**② 折叠开合恢复键 `foldKey`**：`live.js` 原按 `messagesEl.querySelectorAll('details')` 的**数组下标**采集/回填 `open`，但整页重建时 details 序列本就会变（处理中段尾组数随工具增长、`think-row` 数随思考块增长、回合收口时处理中段多组 `liveFoldBody` 转 `groupTools` 单合并组），下标错位把旧 done-fold 的 `open=true` 灌给新 tool-fold。修 = `foldKey(d)` **结构稳定键**（键 = 宿主段 `data-m|data-t` + 主类名 + 段内同类序号），采集改 `Map`、回填按键匹配，全局索引退役。**不变量：折叠体的开合态只跟随同一结构身份的折叠体**（跨类型错配彻底消除；同类内序号偏移只在同段同类增删时发生，后果轻——回落默认收起）。

**③ 无响应红标豁免扩面**：红标语义 = 「**引擎无产出且无已知阻塞原因**」。§17 ③ 只豁免审批等待；工具在跑时引擎阻塞在等工具结果是**预期行为**不是僵死，故判据串入 `!toolRunning`（`toolRunning = !!fold.querySelector('.tool-line.tool-running')`——running 分支 summary 与 `toolCurHtml` 两条出口同款类，单一判据）。已知阻塞原因现为两类：审批接管与工具在飞。`· 连接中断` 分支不涉 staleness，不动。

**④ 扫光统一**：`.think-state` 原为**蓝字渐变扫光**（`background-clip: text`），与工具行的**透明覆盖扫光条**（`::after` 线性渐变平移）两套。修 = 删蓝字链（`background-clip: text`/`text-fill`/私有 keyframes/`.think-state .t-ico` 脱扫光逃逸规则），`.think-state` 加入**统一扫光选择器组**（`.tool-line.tool-running::after` / `.tool-fold[data-state='running'] summary::after` / `.tool-cur summary::after` / `.think-state::after` 四宿主共用一条 `::after` 规则 + 同一条 `prefers-reduced-motion` 关闭规则），宿主持有 `position: relative; overflow: hidden` 定位扫光条。**自取证**：`probe-state-lead.ts`（与打包器同源，`new Function` 调用真实 `liveFoldBody`）A-G 七组断言；`--prefix` 开关把状态行还原成旧式裸文本做对照。

## 19. 并发复合状态行形态改判 + 行内挤压根治

**根因（受控浏览器实测，非推断）**：§16 的并发复合态把两块当 summary 的**两个 flex 兄弟**——`.tool-line.tool-running`（其 `.tl-text` 是 `white-space: nowrap`，基准=全文最大宽）与 `.fold-state`（`flex: 1 1 0` = **flex-basis 0 + min-width 0**：尺寸只看剩余空间、**不看内容**）→ 工具文本吃满整行后 `.fold-state` 只剩 **0.8px**；而 `.think-state` 当时**无任何 white-space 规则**，被压到 0.8px 宽即逐字换行成竖列（CJK 每字一行）→ summary 被 `align-items:center` 撑成 716×90px，`.think-state { overflow: hidden }` 把竖列裁掉 ⇒ **所见就是那个巨大空浅灰圆角块**（`:hover` 的 `rgba(0,0,0,0.045)` 提供灰色 + 圆角）。同结构实测：长 detail = summary 716×90 / state 1×88 / `white-space: normal`（复现）；短 detail = 448×24 / state 77×22（有富余宽度时不发作 ⇒ 解释了为何只有长命令、窄窗才炸）。

**根治（一处结构 + 三条样式不变量，状态源减少）**：①`liveFoldBody` 的 running 分支不再产出「两个 widget」，而是把状态**作原子尾缀并进运行行所在的唯一行容器**：`<span class="fold-state">${runLine}${stateSpan(true,false)}</span>`（`flushTools(isTail)` 新增段尾形参：仅段尾组并状态，中途被旁白打断的组不并；并入即清 `stateAppend` 置 `stateMerged`，杜绝二次追加）——文案成**一行一句**「正在运行：<工具> · <detail> **并思考**」；②新增唯一文案映射 `vacuumLabel(mode, join)`（`join=false` → 正在思考/正在生成/正在压缩会话中……；`join=true` → 并思考/并生成/并压缩中），写进 `data-label`，`core/live.js` tick 改读 `stEl.dataset.label`（**删掉 tick 里重复的 mode→label 三元链**）；③`styles.css`：`.think-state` 加 **`white-space: nowrap`**（文案恒单行，压缩压力只能落到本就带省略号/裁切能力的 `.tl-text`/`.think-stream` 上——这是本缺陷类别的**根因闸门**）、新增 `.think-state.ts-join { flex: none }`（尾缀原子）、扫光组 `.think-state::after` → **`.think-state:not(.ts-join)::after`**（尾缀不重复扫光，扫光随运行行）。独立状态行路径（无工具组的段尾 `.fold-state`）与 `.d-flags`/`.think-stream` 宿主形态不变。

**自取证**：`probe-concurrent-status.ts` 按新契约改写 B 组并新增 C 组（跑真实 `liveFoldBody` + 逐条断言 `styles.css`/`live.js` 的布局不变量）；C 组把「结构不塌的前提」钉死：`.think-state` 恒 nowrap、`.ts-join` 原子、`.tl-text` 是让位方、扫光组恰 2 处 `:not(.ts-join)`、tick 读 `data-label` 且旧三元链零残留。**「只加 nowrap 不够、只改结构也不够」**：旧结构 + nowrap 会让 state 被挤到 1px 肉眼不可见 ⇒ 结构改判与 nowrap 缺一不可。

## 20. 单状态槽：红标在场即独占

**根因（状态源有两个，不是样式问题）**：红标从引入起就是**状态文字旁的注解**——`live.js` tick 与 `approval.js` claimTick 各自拼 `<span class="d-stale">· 无响应 Ns</span>` 追加在状态行尾部，「·」前缀正是注解语法的自证（写死在两处内联字符串里，阈值 150 也在两处各写一遍）。而状态文字（`.think-state`）与红标是**两个独立节点、各自独立判活**：引擎无产出满 150s 时 `.think-state` 仍按上一帧的 `data-label` 计秒 ⇒ 同屏两个状态。

**根治（状态源收敛为一）**：①`web-src/chat/messages.js` 新增唯一构造源 `statusFlags(connUp, staleSec)` + 阈值常量 `STALE_SEC = 150`（**删除 live.js/approval.js 各自内联的红标字符串与写死的 150**）——文案不带前导「·」（红标已是状态本体，不是注解），优先级写在一处：**连接中断（链路断，产出不可信）> 无响应（链路活而引擎无产出）**；`staleSec<=0` 表达「本帧判据不适用」（各调用方按自身豁免规则传 0：审批等待/工具在飞）。②`core/live.js` tick 以**唯一判据**（`flags` 非空）给宿主状态行挂 `.is-flagged`：`frow.classList.toggle('is-flagged', !!flags)`——**状态槽一次只有一个占用者**；`approval.js` claimTick 同步改走 `statusFlags`。③`web/styles.css` 新增 `.fold-state.is-flagged > .think-state, .fold-state.is-flagged > .think-stream { display: none }`（隐去状态文字**与并发尾缀「并思考」**——引擎无产出/链路断时它已过期；`.think-stream` 流式预览同属引擎产出的暂态）与 `.fold-state.is-flagged .d-stale { margin-left: 0 }`（独占时红标即行首；行内 `gap: 7px` 已是唯一间距）。信号恢复（beat 回/WS 重连）→ 每秒重算自动摘标，状态文字原样复原，**无残留态、无第二份状态源**。

**自取证**：`probe-concurrent-status.ts` 新增 D 组（`statusFlags` 真函数：无红标 / 唯一红标且无「·」/ 断连 / 双信号优先级与顺序 / 阈值 149↔150 边界 / `.think-state` 是 `.fold-state` **直接子节点**=独占 CSS 的 `>` 前提，尾缀形态与独立行形态各一条）+ C8–C11（样式表独占规则、tick 挂标判据、两处 tick 无内联红标标记、阈值无第二处写死）；`probe-state-lead.ts` F2 改判为「单源构造 + 工具在飞豁免串入」并新增 F4（独占标 + 样式规则）。负对照（同 DOM 同 `.is-flagged` 类，仅抽掉独占规则）可见文本回到「并思考 · 2m 57s无响应 2m 51s」= 双状态确由本改动消除。

## 21. 侧栏拖拽调宽：展开态自由拖、不记忆

**需求定案**：侧栏展开态可拖右缘自由调宽；仅展开态生效；鼠标手指交互（hover grab / 拖拽中 grabbing）；**不做记忆功能**——每次折叠→再展开回默认 280px。

**实现**：①`index.html` `#sidebar` 尾部新增 `#panel-resizer` 把手节点；②`styles.css`——把手 = 贴 `#sidebar` 右缘 8px 热区（`right:-4px` 骑缝），hover/拖拽显 3px 竖线，**显示门控 = `#sidebar.open` ∧ ≥721px**（折叠态与手机抽屉 ≤720px 恒 `display:none`），光标 grab；拖拽中 `body.sb-resizing` 关掉 `#sidebar/#panel/#chat-area/#messages/#empty-hint/#input-wrap.docked` 六处宽度相关过渡（0.28s padding/width 动画会让拖拽滞后）+ `cursor: grabbing` + `user-select: none`；③`web-src/sidebar/recent.js`——pointer 拖拽链：pointerdown（左键 + 复核 `.open`，CSS 门控之上双保险）→ `setPointerCapture` → pointermove 以 `e.clientX`（侧栏左缘=0，clientX 即目标宽度）clamp 到 `[232, min(560, innerWidth−120)]` 写 **`:root` 内联 `--panel-w`**——`#sidebar/#panel` 宽、主区避让 `padding-left`、`#input-wrap.docked` half-padding 补偿全消费同一变量，天然联动零特判；pointerup/cancel 摘把。

**「不记忆」的根治做法**：内联 `--panel-w` 是唯一可变状态源，`setPanel(false)` 一行 `documentElement.style.removeProperty('--panel-w')`——状态随折叠自然清零，再展开命中样式表默认 280px（≤720px 媒体查询的 240px 不受内联值影响，因手机端把手恒不可见、不会产生内联值），无第二份记忆态、无 localStorage。

## 22. 嵌入式图表：` ```chart ` 双段围栏（web 渲 html / CLI 显 ascii）

模型侧契约写**全局根 `@WrokSpace/CLAUDE.md` 快速要点**（` ```chart ` 围栏 + `%%html`/`%%ascii` 哨兵行分段、语义一致、禁裸 ASCII 字符画、风格可调用 lieflat-charts skill）。

**渲染分工**（两端均只动显示层，协议/转录不动；**普通 ` ```html ` 围栏两端都不受影响**——只有围栏语言精确 `chart` 才触发）：
- **web**（`web-src/core/markdown.js` + `chat/messages.js` + `styles.css`）：`closeCode(closed)` 分支——`chart` 围栏**已闭合**时 `chartSplit` 拆哨兵段，取 `%%html` 段进 `<iframe class="chart-frame" sandbox="allow-scripts" srcdoc=...>`（opaque origin：模型 HTML 摸不到父页 DOM/不能导航/不能开窗）；`%%ascii` 段弃用，`chart-raw` 留全文供「源码」按钮切换（事件委托 `.chart-src`）。**srcdoc 安全链**：mdHtml 入口整体 esc（含引号）→ 属性不破出；浏览器解析 srcdoc 属性实体解码一次 = 恰好还原模型原始 HTML（esc 链与属性解码互相抵消，语义透明）；CHART_BOOT 为自有串 esc 一次同理。**高度自适应**：srcdoc 尾注 CHART_BOOT（ResizeObserver + load 上报 `__chartH` postMessage），`messages.js` `message` 监听按 `e.source === iframe.contentWindow` 采纳设高（其它窗口伪造不进来），CSS `max-height: 60vh` 超出内部滚动；侧栏拖宽 → 内容高变 → 重报，闭环。**流式安全**：围栏未闭合恒回退代码块，闭合那一帧才切 iframe（防流式每 delta 重建闪烁）。**缺段降级**：无 `%%html` 段/哨兵 → 代码块。复制排除：`messageCopyText` 剔 `.chart-bar/.chart-raw`。
- **CLI**（`src/components/Markdown.tsx`）：`stripChartHtml` 纯文本预处理接在 `cachedLexer(stripPromptXMLTags(stripChartHtml(children)))`（stripChartHtml 最外层）——chart 围栏内删 `%%html` 段与哨兵行、留 `%%ascii` 段给 marked 当普通代码块；`StreamingMarkdown` 统一走 `<Markdown>` 自动覆盖（strip 只在渲染层）；未闭合围栏（流式中间态）同样剔除 html 段。
- print.ts（-p 非交互路径）无 markdown 渲染器，不涉。

**验证**：`probe-chart.ts`（web 真源码切片：双段/缺段/未闭合/` ```html ` 与 ` ```html+jinja ` 不误伤/实体往返透明/srcdoc 属性不破出/思考块同链路；CLI `stripChartHtml`：双段/逐字透传/混合围栏/流式）+ `probe-chart-embed-assets.ts`（web-assets 生成物 base64 解码校验）+ exe 二进制 `rg -a '%%ascii'` 命中（CLI 侧已编译进 exe）。

## 23. web 文件上传：+ 浮窗「上传文件」行 + 文件胶囊/文件卡片 UI

底栏 + 浮窗「上传」组在「选择图片」行下新增「上传文件…」行：任意类型、可多选，选完即上传（不经输入栏暂存）。链路与图片附件完全同构的胶囊/卡片，占位路径用**相对路径**。

**链路（与图片占位同模式）**：
- **输入态**：`#file-upload` change → `images.js` `addUploadFiles` 逐个 `POST /gateway/upload?name=<文件名>&sid=<当前会话>|&project=<newProject>`（原始字节直传，`apiUrl` 同链 token/cookie 认证；**落盘跟随会话**：sid/project 与 gwSend 首送建会话归属参数同源，保证「上传落点 = 消息会话落点」——存量会话带 sid、首页尚无会话带 `state.newProject`、纯首页无参落全局根）→ 成功 push `pendingFiles`（`{name, abs, size}`）→ **文件胶囊**（`.file-pill`：64×64 方卡与图片缩略图同轨等高、灰底 `rgba(38,49,72,.06)` + 薄描边、dshFile 图标 + 文件名居中两行截断、× 收进卡内右上 4px hover 显形/触屏 `pointer:coarse` 恒显）进附件行 `#img-pills`（与图片胶囊同行，`renderImgPills` 单渲染源，× 复用 `.img-x` 类名按 `data-f`/`data-i` 分流）。
- **发送态**：`gwSend` 把待发文件拼 `[文件:<会话 cwd 相对路径>]` 占位进消息文本（与 `[Image #N]` 同位追加；CLI/模型端即普通文本，按会话 cwd 解析 Read）→ 发送成功清 `pendingFiles`；`syncGwSend` 的 hasContent 计入文件。**相对化**：占位路径由 `send.js` `relUploadPath(abs)` 按**目标会话 cwd** 相对化——`relPath` 纯函数（大小写不敏感逐段比对、`\ /` 通用、跨盘符/无 cwd 退绝对路径=物理上唯一诚实表示）；落盘跟随会话后同会话「上传→发送」恒为 `uploads/<名>`（上传落点=会话根 `uploads/`，与 cwd 同根），跨会话补发（A 传 B 发）按 B 的 cwd 相对化；存量会话 cwd 取 `/gateway/session` 载荷（`sessions.js` `sessionCwd`）；**新会话（首条消息）jsonl 未落盘无 cwd 源 → wsession 响应附 `cwd`（=webSessionProjectRoot，与 spawn cwd 同源）+ 网关 `readSession` 记录缺失分支从 id 编码路径派生 cwd**（新会话空 fetch 不再洗掉 wsession 带回的 cwd）。乐观气泡文本不含文件占位。
- **渲染态**（乐观与落盘同构）：`userBodyHtml` 剥 `[文件:...]` 占位 → `userFilesHtml`/`fileCardsHtml` 渲染**文件卡片**（`.msg-files` 容器在 `.body`/`.msg-imgs` 之后气泡外下方右对齐，卡片=dshFile 图标 + basename 文件名，title=完整路径，**点击复制路径**——document 级委托同 `.msg-copy` 模式）；乐观气泡（`renderTransient` bubble）渲 `p.files` 卡片同构；排队区（dock，本地乐观项 + CLI 队列快照）剥占位不渲染卡片。占位文本原样进 `pendingUserMsgs`/转录（absorb 链 `includes` 匹配不受影响），剥占位只在渲染层。

**与图片附件的关系**：两条独立链路——图片走 base64 内联（不落盘、随 send images 上行、4 张上限/自动压缩），文件走落盘链（留盘可复用、无数量上限）；共用 + 浮窗「上传」组与 `#img-pills` 附件行（图标 `dshFile`）。

## 24. 会话间通信来源行：提及 chip 带 sid + 气泡/排队区灰字

会话 A 的 agent 向会话 B 发消息（`session_send`），B 侧重出**与 user 消息完全同构的气泡**，仅气泡**外**多一行灰色小字「来自 会话：X」。寻址/工具/网关 → [core.md](core.md) + [gateway.md](gateway.md) §13；本节只写 web 前端。

**提及入口（两个，均已补 sid；`@` 提及为纯 UI 引用手势，不产生授权状态）**：

| 入口 | 文件 | 要点 |
|---|---|---|
| 输入栏 `@` 浮窗「会话」组 | `inputbar/mention.js` | `mentionItems` 会话项带 `sid: hashOf(s)`；`insertMention(kind,name,sid)` 写 `chip.dataset.sid`；`serializeInput` 输出 `[会话:标题\|sid]`；`mentionChipHtml` 按 `\|` 切分**只显示标题** |
| 「+」菜单「引用会话」 | `inputbar/commands.js` | 同款 `appendMentionChip(kind,name,sid)` + `findSession/hashOf` 取 sid |

**必须两个都补**：同一用户手势产出的令牌形态必须一致（都带 sid）——渲染只显示标题、sid 供精确寻址语义。

**渲染（web 不解析包装，只读投影字段）**：`chat/messages.js` `whoHtml(m)` 读 `m.fromSession`（`DisplayMessage` 可选字段，经 `session-delta` 帧原样到达），空则不输出；用户开启气泡（`data-t="u"`，`closeSeg`）与引导气泡（`data-t="g…"`，`weave`）都在 `.body` 前插 `${whoHtml(m)}`。**前端绝不调 `parseSessionMessage`**——剥壳在 `conversationDisplay.ts` 的投影层做过一次，前端只消费结果。

**排队区（`.q-item`）**：`inputbar/approval.js` 把 `q.from.title` 渲染成 `.q-who`（`styles.css` 新增两条，气泡侧复用既有 `.msg .who` 零新增）。**关键坑**：排队区的文本是**尚未过投影的原始包装**（消息还在队列里没进转录），所以拆包必须发生在上报侧——CLI `queueItemsFromSnapshot()` 做 `parseSessionMessage` → `{content: body, from}`，网关 `queue-state` 分支只做形状白名单透传（[gateway.md](gateway.md) §12）。来源进排队区重建签名（`dockItems.map(q => [q.from?.title, q.content])`），换来源必重建。

**无乐观气泡**：跨会话消息非本地打字触发，不产生乐观气泡，**不存在乐观/权威同构与接管帧跳变问题**。

**来源行对齐**：来源灰字行**随其气泡一侧对齐**——用户气泡右对齐 → 来源行右对齐。两个前端等权、同时改：

| 端 | 落点 | 改法 |
|---|---|---|
| web | `styles.css` `.msg.user .who` | `align-self: flex-start` → **`flex-end`**；`.msg .who` 基础规则不动，`.msg.user` 的 `align-items:flex-end` 不动 ⇒ 气泡宽度行为零变化 |
| CLI | `UserPromptMessage.tsx` | 外层 column Box **保持默认 stretch**（否则内层气泡会被收成内容宽、改变气泡形态），只给来源行套一层 `<Box flexDirection="row" justifyContent="flex-end">` 行盒 ⇒ 仅该行右移 |

**气泡高度兼容**：`stageSync()` 的几何量（`topInScroll`/`clientHeight`/`scrollHeight`）全为**实时 DOM 读取**、无缓存高度，故灰字行加进 `.msg.user` 内 `.body` 之前时 `t0` 上移一行 = 占位高度减少一行，天然对冲，`maxScroll ≡ 贴顶位` 不变量不破。三条硬约束：①灰字行在 `.msg.user` **容器内**且 `.body` 之前（插容器外则贴顶时灰字行被挤出视口上方）；②**不得脱离文档流**（禁 `position:absolute`，`topInScroll` 用 `offsetTop` 度量）；③两种气泡形态**必须同时**加。`probe-stage-pin.ts` 回归守这条，`probe-session-link.ts` H 组守对齐。

## 25. 用户气泡两态同构：乐观/落盘 body 同走 mdHtml

**根因**：两态 body 走了**两个渲染函数**（违反「乐观开启气泡与落盘气泡同构」不变量，body 渲染是它漏网的一环）——未接收态（乐观，`inputbar/approval.js` `renderTransient` 的 `renderUserText(bodyText)`）出 `esc` 裸文本节点（无块级包裹）；接收态（落盘，`chat/messages.js` `userBodyHtml(m)` → `mdHtml(txt)`）出 `<p>…</p>`（`.msg .body p { margin: 3px 0 }` ⇒ 上下各 3px）。⇒ 高度差 = **6px/段**；多行文本还从「空白折叠」变 `<br>`；markdown 语义此前只在落盘态生效。`.msg .body` 的宽度/`max-width:85%`/padding 两态一致（`.msg` 同处 `#messages` 直接 flex 参与，`#live-zone` 是 `display:contents`），故现象只出在高度。

**修复（同源，非补丁）**：乐观气泡 body 改 `mdHtml(bodyText)`（新增 `import { mdHtml } from '../core/markdown.js'`，无环：markdown.js 不反向依赖 approval.js）。`renderUserText` 保留——排队区 `.q-item` 仍用它（排队项自带 `<p>` 包裹，形态本就与气泡不同）。

**验证**：探针 `_agent-src/probe-user-bubble-parity.ts`——①两路径结构差异取证（`mdHtml('你好')='<p>你好</p>'` vs `renderUserText('你好')='你好'`；多行 `<br>` vs 裸 `\n`；`**x**` 语义只在 mdHtml 侧）②样式侧 `<p>` margin 证据 ③**结构断言：两处气泡 body 必须同源**（乐观走 mdHtml、不再走 renderUserText）④同文本 → 同 HTML。

## 26. 「神经」tab：神经元选择卡片 + 三级节点图

侧栏第 4 个管理 tab（`data-mgr="neurons"`，脑图标内联 svg），与插件/项目/模型并列。前端模块 `web-src/sidebar/neurons.js`（纯 JS），`mgr.js renderMgr` 的 neurons 分支分发，`state.mgrView.neuronSel` 区分层级并持久化。

**层级1 选择卡片页**：`renderNeuPicker` → `#neu-grid` 卡片（`mgr-card neu-card`，脑图标 + mem/cog/社群/更新四枚 `neu-stats` chips），数据源 `GET /gateway/neurons`（[gateway.md](gateway.md) §14）；`loadNeuronsData` 带 NEU/NEU_LOADING/NEU_ERR 三态与重试钮。

**层级2 三级节点图**：卡片点击 → `state.mgrView.neuronSel = id` → `renderNeuGraphView`（`neu-head`：返回钮 + 标题 + 三枚 meta chips + 图例，`#neu-graph` 全高画布区，`.mgr-pane.neu-pane` 走 `#messages:has(.neu-graph)` 满高规则、`#chat-scroll` 去 padding/hidden overflow）。图包按 `neuron.id` 缓存一份（`NEU_GRAPH`），切库/重进 force 重拉。

- **节点与尺寸**：mem 点 `neuMemR` 2.5–5（∝内容 chars）；cog `neuCogR` 7–24（∝挂载 mem/rel 数 + 内容）；社群 `neuCommR` 11–34（∝cog 数 + 内容）。社群色 = `MGR_PALETTE` 按 i 循环；未入群 cog 灰 `#8a94a6`。
- **布局**：确定性同心初始位（社群 r=170 环、cog 贴 host 社群外圈、未入群 cog r=300 环、mem 贴首 host cog；孤儿 mem 落中心环），无随机 → 探针可复现；手写 d3-force 同型仿真（`neuTick`：O(n²) 斥力按类型 charge **12/72/360** + 弹簧目标距=两端半径和 + pad（**力 ∝ alpha 无地板**）+ **向心引力 `NEU_G = 0.01` 统一外场**：指向画布中心、**与类型/尺寸完全无关**——向心只负责整图约束，径向分层语义全交斥力（charge 大者被推得远，**comm 外圈 / cog 中带 / mem 内带**）+ 碰撞推挤；**渐缓收尾**：速度上限 `14·min(1, alpha/0.3)` 随 alpha 线性收缩 + 停机阈值 0.003 + 弹簧地板移除——末段速度渐近归零不再急刹；衰减 0.985 reheat，ResizeObserver 轻重排，画布离场 `isConnected` 停帧）。
- **连边（事实闭合）**：cog→社群（kind:comm）+ cog→mem/rel（kind:mem/rel）全量，同一 mem 挂多 cog 每 cog 各一条。
- **交互**：滚轮缩放 0.25–3×、空白拖拽平移、节点拖拽（fixed + reheat）、悬停浮窗、点击钉住（<5px 位移判定；钉住态浮窗跟随节点屏幕坐标，空白点击解除）。
- **浮窗 `.neu-pop`**（300px 白卡，`pointer-events:none` 但成员列表可滚）：comm 卡（**有社群名显示名**（cog2.json 命名，含描述行）否则「群 N·认知 X」+ 记忆/密度/内容 chips + 成员列表，core 实心/context 空心角色点随社群色）、cog 卡（群 N/游离 + query + 关键词≤6 + 统计 chips）、mem 卡（时间 + 预览 + 内容/来源）；群节点 canvas 标签同理（名·size / 群N·size）；esc 全量转义。

**验证**：`_agent-src/probe-neuron-viz.ts`（收敛循环跑满至 alpha=0.003 与前端停机一致；后端真实库直读闭包/复算/错误路径；前端源码切片注入：连边数恒等、多 cog 挂载 mem 事实闭合、确定性布局逐位一致、无 NaN/误差有界、cog 聚在 host 社群、fixed 冻结、**向心与尺寸无关**（异型异径孤节点单 tick 位移逐位相等）、**弹簧力 ∝ alpha 无地板**、**速度上限随 alpha 收缩**、**统一外场判别**（分级旧值会给出数倍差）、浮窗 XSS 转义）。

## 27. 项目预览页软重入：openProjectPreview 两级重入

用户症状「打开项目预览页有概率跳回 chat」「在 chat 状态行更新时跳」。两轮根修互补：

- **一轮**：`openProjectPreview` 进预览时清 `live.curUuid`/`localMessages`/`deltaSeq`/`queueRemote`/`tasks`/`streamText` 全局槽 + `clearTakeover` + `renderCtxMeter(null)`，补齐 §3「切视图即清全局槽」不变量在预览态的实例——堵「实时流（session-delta 等六类 SSE 守卫全押在 `live.curUuid` 上）洗预览成 chat」。
- **二轮（根修本尊）**：旧幂等守卫要求 `previewMounted === label`，而兜底 default-preview 恒记 `null`（「兜底误挂不算已挂载」定案）→ 每次断连重连/门解锁的 `hideGate` 恢复链（`if (state.preview) route()`）都整区重写 shell + iframe 重载；iOS 上 iframe 二次导航污染主历史诱发自发后退落到 `/session/<hash>` 即弹回会话 chat。「状态行更新时跳」= 同因相关：会话活跃期切屏频繁 → WS 重连频繁 → 重挂频繁。
- **修法**：`openProjectPreview` 改两级重入——同 label 且 iframe 在场（`data-label` 锚定）= **软重入**：不重写 shell、不清槽，mount 按 iframe 现有 src 校正（同 src 零操作 = 零导航扰动；异 src 只换 src，覆盖 backend 就绪升级/default 换真源），软重入分支统一 return 不落整区重建；异 label 或 iframe 不在场 = 硬挂载（原全流程）。一轮清槽修复仍必要（SSE 守卫的前提不变量）。
- **取证注意**：bytecode exe 内嵌资产不可 grep（字符串经编码），验证资产版本直接 `curl http://127.0.0.1:8124/sw.js` 与 `/app.js`。
- **交付自愈（前端资产版本自愈）**：换 exe 后旧标签页只重连 WS/SSE、**不重载 JS**，会让「修复没生效」实为「跑的是旧代码」。修 = `live.js` 在 hello（每次 SSE 建连/重连都发）时 fetch `/sw.js` 提取 CACHE 版本与页面加载时基线比对，漂移即 toast + 自动 reload（输入栏有内容只提示不强刷，不毁用户输入；重载后新基线同版本无回环）。**守护不变量 = 运行中的前端代码 = 网关当前资产版本**。存量旧标签页需手动硬刷新一次，此后新构建自动追平。
- **四轮根修：HTML 导航网络优先不回退缓存**：自愈链之上的残余交付洞 = **SW fetch 离线兜底**——floria.local 网络抖动瞬间刷新，`catch → caches.match` 静默回喂缓存里的旧 index.html → 旧 app.js（SPA 路由 `/session/`、`/project/` 刷新同走回退）。修 = `sw.js` 对 `e.request.mode === 'navigate'`（覆盖 `/` 与全部 SPA 路由导航）**只 fetch 网络不回退缓存**——导航失败宁可报错由用户重试，绝不静默发旧代码；静态资产兜底保留。**守护不变量 = 导航拿到的 HTML 永远来自网关当前服务字节**。已中招的旧代码标签页无法在线追平，须一次性清站点数据后重开。

## 28. 侧栏会话 tab 排序：有状态置顶 + 创建时间新→旧

- **排序定案**：侧栏会话 tab（平铺「最近」与项目文件夹内两处）改 `sessCmp`（`core/sessions.js` 单一排序器）：有状态（state 点在场 = CLI 在线 busy/waiting/idle；透明无点 = CLI 未打开）置顶，组内按 **createdAt 降序**。`createdAt` = 网关 `/gateway/sessions` 新透传字段（localGateway.ts：SessionMeta 劈 SessionCore + createdAt，`parseMetaCached` 既有 stat 接 `birthtimeMs`（个别 FS 回 0 落回 mtime，birthtime 不可变随 (size,mtime) 缓存无假命中），`listSessions` 输出）。气泡弹层/搜索覆盖层沿用 `sorted()` 随新序；项目胶囊与文件夹排序维持最近活跃不动。
- **新建会话 tab 闪现→消失→再现根因**：`newWebSession` 本地先插合成条目（保证 jsonl 未落盘时也可导航），但 `refreshList`/`loadSessions` 权威拉取整体替换 `ALL`——落盘前窗口内权威列表尚不含新会话，合成 tab 被洗掉，落盘后下次刷新再出现。
- **修法 = `withSynthetic` 统一保全**（`core/sessions.js`）：权威列表写 `ALL` 的两出口（`loadSessions`/`refreshList`）统一过此函数——`synthetic:true` 条目且权威列表未含者保留，真实条目出现后自然取代（真实条目无 synthetic 标）；创建失败链 `ws-failed` 显式移除收口。**守护不变量 = 用户刚建的会话 tab 不因权威刷新窗口消失**；合成条目带 `createdAt`（同入置顶组）。

## 29. 底栏纯文本粘贴：contentEditable 粘贴一律落 text/plain

- **根因**：底栏输入框 `#input` 是 contentEditable div（`core/gateway.js` 开编辑），浏览器粘贴默认吃剪贴板里的 `text/html`——从网页/IDE/Office 复制粘入会保留颜色/粗体/背景等原格式。copy 方向已有「纯文本复制」（全局拦截 copy 只写 text/plain，`inputbar/ctx-meter.js`），paste 方向对称补齐。
- **修法**（`inputbar/ctx-meter.js` paste 监听）：图片粘贴分支不变（`clipboardData.files` 优先入列 `addImageFiles`，补 `return` 防图 + 文双插）；其余粘贴一律 `preventDefault` 取 `text/plain` 经 `document.execCommand('insertText')` 于光标处插入——保留 undo 栈、不破坏 mention chip DOM、多行 `\n` 正常换行；无 `text/plain`（如非图片文件）回落默认。token 门态（`gateAwait`）与只读态（contentEditable=false 不触发 paste）不参与。

## 30. 增量段替换状态保持：折叠开合 + 用户气泡不重建

- **根因**：每条状态行更新（工具启停）与旁白行（`.done-think`）新增都是一次 session-delta → `applySegDelta`（`core/live.js`）按段粒度**整段换血**（段=user 气泡 + done-fold + 回复 + 变更卡全量 html），段内两类 HTML 再生不出来的状态每增量丢失：① **details 开合态被拍回默认**——处理中段折叠 HTML 默认 `open`、tool-fold 默认收起，用户手动关上的段折叠每次增量被强制弹开、手动展开的工具明细每次被拍回收起 → 整段高度每增量跳一次（全量重建路径已按 `foldKey` 恢复开合，增量路径未贯彻同一不变量）。② **用户气泡连图重建**——气泡在段内不变（who/图/文件/复制钮落盘后皆静态），重建 `<img>` 节点重新请求/解码（image-cache 已是 no-cache 必回源）→ 至少一帧 0 高塌缩再回弹的跳动。
- **修法**（`core/live.js` `applySegDelta` 单点）：① 替换前按全量路径同款 `foldKey` 键语义（`@m|t|cls` / `host|cls#idx`）捕获段内全部 `details` 开合态，插入后按同键恢复（键不在旧集的新增折叠保留 HTML 默认：处理中展开、工具行收起）；② DOM 已有同 key 用户气泡时保留旧节点、丢弃新段气泡节点只替换其余部分，插入点改流末锚点前（旧 prev 锚点插法会把新折叠体插到保留气泡之前颠倒文档序；处理中段恒为末段，旧气泡与流末锚点之间无他段节点，文档序必然还原）。气泡保留同时使 `stage.bubble` 引用不再每增量失联重定位。
- **连带不变**：接管帧（首帧无旧气泡）照旧整段插入；压缩/回退（消息数减）照旧走整页重建；`msg-in` 入场动画逻辑不涉增量路径。

## 31. web 卡顿与内存泄露三刀根治：增量帧惰性渲染 + img 换血 + tick 空写守卫

- **卡顿主根（惰性渲染）**：`renderSessionBody` 每帧无条件全量 `messagesHtml(messages)` 序列化整个会话，而 session-delta 增量路径只消费末段 `lastSegInfo.html`——历史段渲染全部白付；session-delta 运行期合帧最高 ~10 次/秒，长会话每次 MB 级字符串拼接 + `mdHtml` 全文重解析 = 主线程打满（「渲染增量化了、序列化没增量」的半成品状态）。**修** = `messagesHtml(messages, lazy)` 两段式：切段循环照跑（O(N) 桶分配轻量）但历史段不生成 HTML（`chat/messages.js` think/ask/tool/reply 行 html 置空）；`closeSeg` 非末段走 skip 分支，只按渲染同序静态推进 `lastNode`（u→f→a→c，节点存在性与渲染路径等价）供末段 prev 锚点链；仅 isFinal 末段真渲染并在入口补齐置空行（ask 按 answer 终态、tool 恒完成行基线、运行态仍由 `flushTools` 分派）。`core/live.js` 先 lazy 切段拿本轮 `lastSegInfo` → `canDelta` 判定（语义不变）→ 增量直接 `applySegDelta`（历史段零渲染成本）；不可增量再跑全量（行为等价，全量频次=切段边界低频）。
- **内存峰值/闪烁（img 换血）**：整页重建分支 `innerHTML` 前按 `src` 采池（Map，池 shift 支持同 src 多图），重建后同 `src` 换回旧 `<img>` 节点——image-cache `private,no-cache` 每张必回源的网络风暴 + 全图重新解码（回合边界卡顿峰值 + 「先塌后弹」闪烁）双灭。
- **tick 空写守卫**：`bindLiveFoldTimer` 每秒 `flEl.innerHTML = flags` 改「值不变不重写」，防空串重写打断子动画并触发无谓样式重算。
- **泄露定性**：interval 防叠（`liveFoldTimer`/`claimTick`/`__backendHeartbeat`）、SSE 防重建、WS close 旧连、`renderTransient` sig 幂等、`pendingUserMsgs` 吸收链全数核实在位——无经典引用泄露；「泄露感」主源 = 重建风暴的分配峰值 + GC 压力，由前两刀直击。

## 32. 无响应红标降为最底层优先级：任意状态在场即不判

- **根因**：压缩（REACTIVE_COMPACT/长会话压缩）期间被标「无响应」——压缩是一次大 LLM 调用，零增量产出 → turn-beat 恒停超 150s（`STALE_SEC`）被判死，且单状态槽 `.is-flagged` 挤掉「正在压缩」；状态行判定（`vacuumOf`）里压缩是显式实证档（compact-state 专链 TTL 5min），但僵死判定豁免清单（`live.js` tick）只认审批等待/工具在飞两种，两线豁免源不对齐。
- **修**（`core/live.js` `bindLiveFoldTimer` tick 单处）：`stEl` 查询提前，新增豁免判据 `hasStatus = .think-state 的 data-label 非空`（`vacuumOf` 单源渲染的任意状态：正在思考/正在生成/正在压缩/正在运行）——`statusFlags(connUp, awaitingApproval || toolRunning || hasStatus ? 0 : staleSec)`。**无响应降为最底层优先级，仅当无任何状态时才允许红标**；「连接中断」优先级不变。
- **代价（知情定案）**：引擎真停摆但状态行仍有文字（典型=无工具期「正在思考」）时不再亮无响应红标——以压误报为优先；停摆自愈链（90s SSE 半开探测全量对账、turn-state 打断收口）不受影响。

## 33. 增量路径 img 换血：段内引导气泡图片不再重建

- **根因**（§30 的残留缺口）：`applySegDelta` 的状态保持只覆盖 `[data-t="u"]` 段首用户气泡——段内其余 `data-m=key` 节点（尤其**引导气泡 `data-t="g<gi>"`**，见 `chat/messages.js` `weave`）每增量仍整段重建。回合中上传的图片若经排队注入（`queued_command`）落成引导气泡，就与旁白行（`.done-think`）同段；每次旁白/状态行到达 → 引导气泡 `<img>` 重建 → image-cache `private,no-cache` 必回源 → 新节点在 paint 时尚未解码 = 0 高塌缩再回弹。用户口径「旁白消息的图片没修复」即此。
- **修法**（`core/live.js` `applySegDelta`）：照搬 §31 整页重建的 img 换血语义——删旧节点**前**从「本次将被删除」的节点按其 `img[src]` 采池（同一 src 多图用数组 shift），插入新段后同 src 的新 `<img>` 一律 `replaceWith` 换回旧节点（旧节点持已解码位图，零回源零重解码）。保留的 `[data-t="u"]` 旧气泡**不采池**：引导气泡与其可能同 src，采走会让保留气泡丢图。同一不变量：已落盘图片字节不可变（image-cache 单调 id）→ img 节点不跨帧重建。
- **配套**：sw `floria-v341→v342`、`app.js?v=342`；exe `cli-dev-20260918231033.exe`。

