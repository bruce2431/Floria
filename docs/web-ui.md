# web 前端链路定案（web-ui）

> 本文件属 `docs/` 文档库，收录 web 前端（内置网关静态托管页）的**现行链路与不变量**。只写现状，不写逐次缺陷的根因叙事（历史见 git 与神经元 LOG）。
> 前端唯一手改处 = `src/gateway/web-src/`（22 个 ESM 模块），`src/gateway/web/app.js` 由构建生成、勿手改；改动须 bump `?v=` cache-bust 并重新构建 exe（→ [build.md](build.md) §1.1）。网关服务侧（认证 / mDNS / 预览容器 / 审批中继 / 独立会话进程链）→ [gateway.md](gateway.md)；源码核心机制 → [core.md](core.md)；术语 → [glossary.md](glossary.md)。改动以下任一链路时必须同步更新本文。

## 1. pushState 路径路由

主区三态走**真路径路由**——会话 `/session/<完整会话hash>`、管理视图 `/manage/<kind>`（plugins/projects/models）、项目预览 `/project/<项目label>`（`project` 避开网关 `/preview/*` 静态页路径）。**全部前缀用全称，禁止简写**；`/s/`、`/mgr/`、`/pview/`、`/bp/` 仅保留解析兼容、不再生成。`parseRoute` 先读 `location.pathname`（全称与旧缩写双前缀），hash 旧链接兜底；网关静态服务带 SPA fallback（`/^\/(?:session\/|s\/|manage\/|mgr(?:\/|$)|project\/|pview\/)/` → index.html）。`navigate` 参数保持既有 hash 形式（调用点零改动，`#mgr/k`/`#preview/l` 是内部约定 hash、不出现在 URL），内部 `pathFor()` 转真路径。**URL 用完整会话 hash**（= 转录文件名去扩展名），`findSession` 精确匹配，`route()`/`hideGate` 补拉后 resolve。

**刷新保留当前界面**：boot **不把 `/session/<hash>` 重置回首页**——列表未就绪由 `renderSession` 占位「加载中」（`needToken()` 门：token 门未过找不到 ≠ 真不存在），WS 验证通过 → `hideGate` 的 `loadSessions().then` 恢复链落地重渲：消息区**无真实消息气泡**（`.msg:not(.msg-system)`）才整页重渲，列表就绪仍无此会话才渲染「会话不存在或已删除」。**预览重挂守卫**：`hideGate` 恢复链每次 WS 重连都跑，故 `openProjectPreview` 幂等（`state.previewMounted` 标记）、`initLive` 防重建（已有 `live.es` 即跳过，防泄漏 + 事件双发）。

**同步路由**：`navigate()` 后**同步调 `route()`**（不依赖 hashchange 异步时序），`lastNavHash` 去重抑制同值 popstate/hashchange。

**异步边界会话身份校验**：CLI 单进程单会话（query 循环写内存 AppState、React 同步渲染）不存在跨会话异步边界；web 是无状态查看器（异步 fetch + SSE 写全局槽 + 全局 DOM），**每个异步边界必须重验 `state.currentHash`**：①`refreshSession` 在 `await fetchMessages` 后补校验，不通过整体作废；②`renderSession` 切换即清 `live.curUuid` + 置空 `live.queueRemote`，fetch 回来消费 `queued` 硬重置；③`addUser` 忙碌/空闲区分——DOM 有 `done-live`（回合运行中）→ 乐观=排队区成员，无 `done-live` → 乐观开启气泡直接进对话流。

**SPA 配套**：index.html 资源引用与 app.js 动态资源（icon/char/gate）全部改**绝对路径**（`/styles.css?v=NNN` 等）——子路径下相对路径会解析到 `/session/…` 404；左上 logo `<a href="#/">` 加 click 拦截走 `navigate('#/')`。

## 2. 会话创建与首条消息链

**新建流程 = 笔与项目「+」一致，先到初始化界面（空态），发送首条消息才真正建会话**：笔（`#recent-write`）清 `state.newProject` 回全局首页；项目文件夹行「+」仅设 `state.newProject=label` + `navigate('#/')`。**seat 两态**：**可改**=白底 chip 可点弹层选项目、label 显示 `newSessionProject()`（max-width 240px）；**锁定只读**（`inputbar/commands.js` `projSeatLocked()`，点击直接返回不弹层）= 会话态（按 projectScope/projectLabel 渲染、全局会话显示「全局」）∪ work 模式已选工作项目（在项目中工作只能在对应项目建会话，见 §43）。管理/预览态挂载点不在 chat-area 自动隐藏。`gwSend` 空态分支按 `newSessionProject()` 带 project 调 `newWebSession(project)`（创建失败恢复 `state.newProject` 原值）→ 建会话后才弹 CLI 窗口。

**首条消息立即上屏**：renderSession 首屏 fetch 常抢在 CLI 写入首条 user 消息前返回空，此时乐观上屏（用户气泡 + 正在处理折叠），真实数据经 SSE 整页替换。**丝滑建会**：乐观渲染前移到发送瞬间（不等 wsession 返回）+ `flipInput(false)` 沉底，失败回滚空态；`flipInput(toStage)` 为 FLIP 补间（变更前测旧矩形 → 统一施加类/父容器变更 → transform 从旧位滑到新位），renderHome/renderSession 换向均走它。

**三态根治 = 状态收敛为单变量 `firstSendHash`**（`''`=无事务；非空=该会话首条乐观 DOM 为权威）：hash 回填前移至 `newWebSession` 内 navigate 之前；renderSession 入口切走即作废 + 事务期不洗「加载中…」；fetch/refreshSession 回程非空即收口销毁（双入口对称）；事务期 `renderQueueDock` 只跳 remote 快照。效果：发送瞬间直接进入会话视觉并平滑过渡到落盘真实数据，计时不重开。

**wsession 异步化 + 消息暂存补投**：`POST /gateway/wsession` **预分配 sid 立即返回**（`sid = resume ?? randomUUID()`，spawn+注册后台进行）+ `spawningPromises` Map（spawn 在途登记，同 sid 并发调用复用同一 promise 防双进程；**登记须 `p.finally` settle 即清**，只 set 不 delete 会让该 sid 永久驻留 ⇒ 幂等短路恒命中旧 promise + send 路由恒判「在途」把消息永久暂存）+ `pendingDeliveries` Map（send 路由对未就绪会话的消息按序入队）；CLI `/clients` 注册钩子调 `flushPendingDeliveries` 按序补投。失败链不留静默：spawn 失败/注册超时 → `.catch` 清 `pendingDeliveries` + SSE 群发 `{type:'ws-failed', session, error}` → 前端清首条事务 + 移除合成列表条目 + toast 报错 + 正看该会话则回首页。

**接管帧收口（计时回跳与动画重播根治）**：**接管=同位换皮不是新增**——事务收口帧（`firstSendHash === hash && messages.length > 0`，refreshSession/renderSession 双入口对称）置 `txTakeover` 跳过 `stampMsgIn` + 乐观 `procStart` 经 `live.txProcStart` 移交 `bindLiveFoldTimer`（读取即清）续算。推广：乐观开启气泡在屏（`[data-t="u"]:not([data-m])`）即乐观权威期，与 `firstSendHash` 判定并联；乐观气泡补齐复制按钮与落盘气泡完全同构。

**会话行标识 = 项目编号气泡**：`itemHtml(s, showProj)` 删 `webTag`，`renderList`（平铺视图）传 showProj=true 时项目会话（projectScope==='project'）标题后显示短编号气泡（`projIdOf(label)` 取 `^Pj\d+` 前缀，非 Pj 命名回落完整 label，悬停显示完整项目名）；项目文件夹视图/根会话/气泡弹层不显示。

**chat DOM 两区重构：暂态区收编**。不变量=**乐观/暂态元素与权威数据元素生命周期不同源**，故设**暂态区 `#live-zone`**：数据区与 `.pin-stage` 之间的唯一暂态容器（`display:contents` 不产生盒，子元素即 `#messages` 直接 flex 参与者；`pin-stage` 恒居末），承载三类元素——回合开启气泡（与落盘气泡同构）、回合开启主张折叠 `#claim-fold`（「正在处理 Xs」按最早 `claimTs` 跳字）、置底排队区 `#queue-dock`。**单一状态源 `pendingUserMsgs`**（项 `{hash,text,imgs,baseTs,form:'bubble'|'dock',claimTs}`）+ `live.queueRemote`，`renderTransient()` 整体重建：签名不变跳过重建（防 msg-in 重播），空区容器整体摘除。**不变量：权威 `done-live[data-m]` 在场 → 本区不持回合开启主张**；权威插入避让：`msgAppend`/`applySegDelta` 插入点取 `#live-zone` 之前。首条事务收口同步迁移（接管帧 rebase `hash:''` 项 + `claimStartTs()` 经 `live.txProcStart` 移交续算）；撤回链（restored）同步丢弃匹配 pending 项。**队首主张收编 `queueClaimAdopt(items)`**（首载回程/防抖回程/queue-state SSE 三入口统一调用）：刷新撞上「消息已入队、未落盘」窗口时把队列**队首项**收编进 `pendingUserMsgs`（同文本已收编/本地已发 dock 项幂等跳过或原地升级；首条事务期豁免），形态由 `renderTransient` 现成 authLive 判定自动定。

## 3. 共同后端架构

CLI = 前端（React/Ink）+ 后端（会话引擎：query 循环 + commandQueue + AppState）同进程；**会话引擎为 CLI 与 web 的共同后端，二者地位等权**；网关退化为**纯路由**（会话注册表 / 按 sessionId 转发 / SSE 广播，不做任何渲染语义加工）；**jsonl 降级为冷数据**，只用于历史回放（由同一份 `filterConversationForDisplay` 输出）。

**等权的本体 = 二者共用同一个后端**——无主从、无镜像；唯一真源是后端语义。三条：
- **能力等权**：后端暴露的每个会话能力两种前端都应有入口（审批/提问双操作竞速、发送/引导注入=同一 enqueue 写入口、模型切换双向同步、队列预览、重命名实时互同步、web 独立会话=本地可见 REPL 窗口）。**新能力先落后端，两种前端各自接线**。
- **正确性等权**：CLI 单进程单会话，「渲染的数据必属本会话、状态随进程生灭」是**结构免费**的；web 是无状态查看器，同保证必须**显式补齐**：每个异步边界重验 `state.currentHash`、切会话即清全局槽、乐观语义按后端实际行为分流。**「切视图」覆盖全部三个主区视图**（首页/会话/预览）：进入非会话视图必须先 `clearSessionSlots()`（见 §34），恢复「**`live.curUuid` 非空 ⇔ 当前视图正展示该会话**」不变量。**新增主区视图必须执行同款清单**。
- **语义等权**：渲染权威在后端（`filterConversationForDisplay` 一份输出喂回放/实时/离线三链路，前端禁止复刻 isSynth/思考过滤/切段等引擎职责）；行为修正一律回流后端源码。

**落地链 1：injected 权威标（`conversationDisplay.ts` attachment(queued_command) 分支）**——可见性判据照抄 `messages.ts`（origin 回退 task-notification；origin/isMeta 任一存在=系统生成隐藏），人发 → `role:'user' + injected:true`。**人发 queued_command 落盘**：`isLoggableMessage`（sessionStorage.ts）对非 ant 放行 `queued_command && !origin && !isMeta`（上游一律拒写是刻意隐私设计，此处按需求翻案），落盘后物理位置=消费位置=感知序，回放/实时/压缩后三态一致；系统生成 attachment 维持不落盘。

**落地链 2：队列快照上报链**——`QueuedCommand.enqueuedAt`（textInputTypes）→ `messageQueueManager` enqueue 打点 → `gatewayClient` 订阅 `subscribeToCommandQueue`（`startGatewayProbeAndConnect` 挂载，重连补发）→ /clients WS `{type:'queue-state', items:[{content,ts}]}`（仅 mode==='prompt'）→ 网关 `sessionQueues` Map（无时间 TTL；CLI detach 清）→ `/gateway/session.queued` 首载 + SSE `{type:'queue-state', session, items}` 增量（事件体直带全量快照）。

**落地链 3：前端语义切段 + 置底排队区**——切段由 injected 事件驱动：injected → 归未收尾段 guides（weave 织入折叠体；孤儿注入兜底新段 `user:null`），非 injected user 恒开新段并立即计时。「段未收尾的真实 user 一律吸 guides」启发式已删除。**置底排队区 `#queue-dock`**：本地乐观 pending + CLI 快照合并、文本去重、ts 升序、全空隐藏；**乐观按发送时机分流**——DOM 有 `done-live`=排队语义 → 乐观=排队区成员（发送→排队区→injected 吸收→折叠体内气泡→dequeue 落盘变开启气泡）；无 `done-live`=新回合开启消息 → 直接乐观渲染开启气泡进对话流，空档期误判双向自愈；吸收信号含 injected（isRealUser 命中）+ baseTs 防历史误吸；计时/钉顶排除标 guide→injected 三处（`bindLiveFoldTimer`/`lastUserTs`/`uSig`）。

**落地链 4：压缩实时态链**（queue-state 同款三件套）——CLI `onCompactProgress`（`compact_start`/`compact_end`）→ REPL 接线 `gatewayClient.notifyCompactProgress(active)` → /clients WS `{type:'compact-state', active}` → 网关无状态转发 SSE 群发 → web `live.compactFlags`（Map 按会话 uuid 存到达时刻，渲染侧 5min TTL 防 compact_end 丢失卡死）。背景：压缩进行中 jsonl 零写入、SSE 纯 fs.watch 驱动，无此链会错显「正在思考」。状态行落位由 `stateShown` 标记（尾部无工具组承载时独立追加折叠体末尾）。

**落地链 5：任务清单上报链**——详见 §15。

**引导消息碎片化交错渲染**：语义 = **开启消息渲染一个折叠体；旁白、工具调用行、引导消息都作为折叠体内部的元素，各自单独个体、按先后顺序堆叠；结束后最后一个答复（end_turn 回复气泡）在折叠体外**。引导语义由 `filterConversationForDisplay` 的 injected 标权威输出（网关侧补插/打标已删除）。`groupTools`（连续工具合并概括「编辑了文件并运行了命令（3）」）与 `liveFoldBody`（处理中状态行）原样保留——「不合并概括」仅约束引导/回复位置，不及于工具行。

## 4. session-delta 增量事件流

web 读取路径 = **订阅引擎同一变化事件流**——CLI `filterConversationForDisplay`（过滤权威单源）输出经 `buildDisplayDelta`（conversationDisplay.ts）算「尾部替换」增量（**`{seq, anchorSid, messages}`**：anchorSid=分歧点前一条的投影稳定键、messages=自分歧点尾部）→ REPL 发射点即发（block 级无防抖）→ `notifySessionDelta` /clients WS → 网关 `sessionDeltaSeq` 单调去重（seq<=last 丢弃；**cli-hello 重置**防 CLI 重启 seq 归 1 被吞死锁）→ SSE `session-delta` 群发 → web 应用 **「锚点 + 其后整体替换」**：`cur.slice(0, idx+1).concat(messages)`；**渲染走与全量对账同一出口 `renderSessionBody`**。gap/无基线/`idx === -1 || cur.length - idx - 1 > 512` → `refreshSession(true)` 全量对账重建基线（基线唯一重置点 = fetch 回程 + `/gateway/session` 附 `deltaSeq`）。**不变量**：CLI 侧「投影必须覆盖到 sent 末尾」（`base0 + display.length >= cache.sent.length`）；消费端只认内容标识不认长度。新增「内容通知」只此一流。

**稳定键 `sid`**：REPL `messages` state 被 `capRenderedMessages` 裁成尾部 200 条窗口，而 `normalizeMessages` 的 uuid 派生受**粘性** `isNewChain` 影响——同一记录在 CLI 窗口投影与网关全量投影里 uuid 不同、数字坐标不同 → 消费端逐条拒收。根治：①投影出口为每条赋**位置无关稳定键 `sid`**＝「源记录 uuid 前 24 位（`deriveUUID` 恒保留该前缀）+ 同 parent 内块序」，无源 uuid 的派生提示行用 `h#时间戳#文本前 32 字`；②`buildDisplayDelta` 用 sid 对齐与锚点，`anchorSid = sent[k-1].sid`（k=0 无可靠基线则不发）；③比对键**剥 uuid**（`cmpKey`）；④P2 上报水位对齐同根同治；⑤网关转发校验 `anchorSid`（缺锚点不发）。跨版本双向安全降级（无 anchorSid → 对账）。

**delta 序号账本**：序号**不得寄生于展示缓存条目**（全量路径重建缓存会把 CLI 序号打回 1，此后每条 delta 被网关水位吞掉）。①进程级账本 `deltaSeqBySession`（`buildDisplayDelta` 取号自增）——**不变量：delta 序号单调递增、只在 CLI 进程重启时归零**；②`exportConversationToServer` 在 `cache && display.length === 0` 时直接 return——**不变量：`cache.sent` 恒等于最后一次成功上报的完整投影**。探针 `probes/probe-delta-real.ts`。

**P1 钉顶对象与视图槽不变量**：①`renderSessionBody` 钉顶分支 `pinnedUserSig` 推进必须在气泡命中**之后**；②`syncPinAfterRender` 无「抓最后一个 user 气泡」fallback，key 失配 → `pinRelease()` 交还 hasNewUser 链重钉。**不变量：钉顶对象必须是本回合带 data-m 的渲染权威气泡**。③`renderHome` 补与 `renderSession` 同清单的对称清理（现走 `clearSessionSlots`，见 §34）。④REACTIVE_COMPACT 边界塌缩期间每个中间 commit 都会触发 delta effect → 小基线尾部替换 delta 把已提交历史截断。根治三处（均不加状态源）：CLI 侧窗口覆盖不变量 + `exportConversationToServer` 同款守卫 + web 侧 `base + ev.messages.length < cur.length` 拒收并按 seq gap 走 `refreshSession(true)`。

**SSE 半开死亡探测自愈**：TCP 半开（改网/睡眠唤醒/抖动，无 FIN/RST）不触发 `es.onerror` → delta 全丢且无重连，页面冻结最后帧而计时行照跳。修（`core/live.js`）：`onmessage` 记 `live.lastSseAt` 活性时刻；`bindLiveFoldTimer` tick 加 **90s 无任何 SSE 事件 → `refreshSession(true)` 全量对账自愈**（fetch 走新 TCP，幂等；重置基点防每秒重入）。不变量：处理中段 SSE 停达 90s=链死亡。

**回退快照防御 `snapshotStale`（纯函数）**：`/gateway/session` = 磁盘 jsonl + CLI 异步上报窗口合并，回合开启时序窗内两源都可能短暂落后 → 回退快照被当权威会洗掉在屏新回合、回写基线、误重钉（「发送瞬间跳到上一条消息」）。修=渲染统一出口前加**快照单调性门**：本地基线非空而快照为空，或快照最大落盘 ts 严格早于基线 = 回退快照**整帧丢弃**（不渲染、不重写基线、不碰 cwd/模型/队列/任务槽），等下一条 SSE/落盘快照自然恢复；合法重渲放行（撤回/turn-state 同 ts 持平、压缩收口 summary ts 前进、首载/切会话基线 null）。探针 `probes/probe-snapshot-stale.ts`。

## 5. web 模型 / 思考等级切换（模型源=凭据池）

AppState store 是 React Provider 内 `useState` 创建**非模块单例**，React 树外代码走**全局 handler 模式**——`src/bridge/controlOverrideHandle.ts` 模块级 handler + `src/components/GatewayControlBridge.tsx`（replLauncher 在 `<App>` 内挂 `<REPL>` 旁）：model → **切换同拍化**（模型 + 供应商成对挂起、回合边界与 `options.mainLoopModel` 快照同一拍落地；此处只立即更新显示态 `setAppState({mainLoopModelForSession})`；`'default'`/null → 清覆盖 + 清绑定回落读盘凭据池）；effort → `setAppState({effortValue})`。

**网关 `POST /gateway/model`**：**model → 每会话**：校验放宽到凭据池全部供应商（`findModelProvider`），随 `{type:'model', value, provider}` 按 sessionId 精确路由到目标 CLI 进程（进程内绑定 provider 的 baseUrl/key）；**本分支不写全局凭据池**；无 sessionId/未命中返回 400 不广播。**defaultModel → `switchModelAuto` 全局默认**（只对之后新建的会话生效）。**effortLevel → `updateSettingsForSource('userSettings', { effortLevel })`** 写便携根 settings.json（校验/合并/删除/缓存失效/失败暴露全在官方设置服务）+ broadcast `{type:'effort'}`。**写盘守卫**：写盘前过 `parseEffortValue` + `toPersistableEffort`——读侧 schema 非 ant 只接受 low/medium/high 且整文件 safeParse，`'max'` 原样落盘会使整个 userSettings 校验失败作废；守卫后 `'max'` 为 session-scoped 不落盘，运行时仍经广播生效。

**能力声明通道**：凭据池 provider 段新增 `capabilities`（`ProviderConfig.capabilities`），`get3PModelCapabilityOverride` 经 `getPoolModelCapability` → `findModelProvider` 优先消费——**声明即完全接管**（未列能力=显式不支持），未声明段维持 env/name 启发式。**`effortLevels` 声明**（值域 off/low/medium/high/max；glm=[low,high,max]、deepseek=[off,low,high,max]）+ 两段 capabilities 含 `max_effort`（官方 max 档直发，不降级）。**底栏 Off 穿透**：广播 null 必须**透传**（AppState.effortValue 扩 `| null`），`resolveAppliedEffort` 对显式 null 不发 effort 也不落默认链，`'auto'`=清除跟随默认。**Off 真关分叉**（`claude.ts` `paramsFromContext`）：显式 Off 且模型声明含 off → `thinking:{type:'disabled'}`（`getPoolModelEffortLevels` 读取，优先于 ultrathink/thinkingConfig）。**web 菜单按声明动态渲染**：`/gateway/models` 每条目随带 `effortLevels`（`listModels` poolRows），`model-select.js` `modelEffortLevels()` 取当前模型清单生成菜单行；未声明回退固定 Off + Low/High/Max；无 off 档模型（GLM）未设置等级时显示「默认」。

**直接切模型自动切供应商**：**`/model <name>` 直选全池模型，归属其它供应商时本进程绑定该供应商（`setSessionProviderOverride`，baseUrl/key 进程内立即生效，不写全局池）**（CLI `model.tsx`：池内模型跳过 API 试呼验证；补全聚合全部供应商模型、当前供应商排最前）。**`/provider`、`/key` 命令均已移除**——模型/密钥配置只能直接编辑便携根 `.claude/credentials.json`。池级 API：`pool.ts` `findModelProvider` / `setSessionProviderOverride` + `getSessionProviderName` / `switchModelAuto`。

**会话模型严格隔离**：全局默认（`switchModelAuto`）= 只对**之后新启动的会话**生效。`main.tsx` 启动段：未显式指定模型时把**当时**凭据池 activeModel 固化为 `setMainLoopModelOverride` 会话覆盖（否则解析链每轮实时回落读池，模型 tab 切默认会把运行中会话下一轮悄悄带走）。会话内显式切换（/model、弹层路由）走 GatewayControlBridge 覆盖固化值，`'default'` 清覆盖 = 显式恢复实时跟随；CLI REPL 与 web 独立会话一视同仁。

**会话级供应商绑定**：仅固化模型名不够——凭据（baseUrl/apiKey）也须绑定。①`pool.ts` 会话绑定层解析顺序 **显式 override > 进程启动快照 > 池文件现值**；`getActiveProviderConfig()`/`getActiveApiKey()`/`getActiveBaseUrl()`/`getActiveModel()` 全走会话有效值，新增 `getGlobalActive*()` 供管理视图读池现值；**不变量 = 本进程请求凭据只随本进程状态变化**；②`localGateway.ts` `/gateway/model` 的 model 分支不发全局写，改路由 `{type:'model', value, provider}`；③`gatewayClient.ts` 收 `provider` → `setSessionProviderOverride`。前端配套（`model-select.js`）：有会话 → 会话级切换；首页/新会话 → `{defaultModel}`。**同拍化**：provider 与 STATE 覆盖为**挂起对**（`setPendingSessionModelOverride` + `setPendingSessionProvider`），`getToolUseContext` 回合边界与模型名快照同一时刻 `applyPending*` 成对落地；立即写者在写入器内自动取消挂起——回合中途一切请求保持旧模型 + 旧凭据，切换完整落在下一轮循环。

**`listModels`（GET /gateway/models）** 返回 `model = activeModel ?? settings.model`（与 CLI 同源）+ `activeProvider/activeModel/providerModels/effortLevel`，凭据池条目随带 `effortLevels`；前端模型浮窗渲染真实凭据池模型、effort 面板按声明动态渲染。`gatewayClient.ts` WS 收 `{type:'model'|'effort'}` → `invokeControlOverride`；前端 `mselChoose` 调 `apiSetModel` POST（有会话带 `sessionId`，首页/新会话带 `defaultModel`）。CLI 思考等级渲染：LogoV2/CondensedLogo 用 `getDisplayedEffortLevel`（未设置回落 `'high'`）以 `<模型名>·<思考等级>` 显示。

**模型 web/CLI 同步**：每会话 override 只存在于 CLI 内存，web 只读凭据池全局默认 → 需上报。**唯一权威源 = 网关 `sessionModels`；web 的 `MODEL_CUR` 只是该权威源的本地投影 + 乐观前置**。

①**CLI 上报**：`reportCurrentModel(intendedModel?)`（`gatewayClient.ts`）POST `/gateway/model-report` 带 `{sessionId, model}`。调用点 = WS open 回调（重连补报）+ 全部切换点：`GatewayControlBridge`（web 控制切换）、`useReplBridge`、`model.tsx` 交互选择器与 `/model` 路径、`PromptInput` 内联 ModelPicker、`fast.tsx` 开 fast（可能替换模型）、`Config.tsx` 默认模型改动——**不变量 = 任一改变本会话实际模型的落点必须上报**。**参数语义**：不传则读 `getMainLoopModel()`（取 STATE override，CLI 侧切换点已落地新值即真）；**web 控制切换必须显式传 `intendedModel`**——该路径把新值挂起到回合边界才落地（见上「同拍化」），切换瞬间读 STATE 得到的是旧值，上报即恒报旧模型。

②**网关**：`sessionModels` Map（**无时间 TTL**，CLI 断开 detach 删 + 重连 open 补报 + stop 清空，与 sessionQueues/sessionTasks 同构——有 TTL 会把长时间不切模型的活跃会话清成 `model=null`）+ `GET /gateway/session` 附 `model/modelTs`；落值同时 **SSE 群发 `{type:'model', session, model, modelTs}`**（与 queue-state/task-state 同款「镜像存储 + 转发」），web 不必等下一次拉取——会话空闲时底栏也能实时跟。

③**web 采纳**：`applySessionModel(model, modelTs)` 一律采纳上报值（网关即外部真相）；唯一例外是**切换前的在途快照**——用户刚在 web 切过（`modelUserPicked`）且该上报 `modelTs < MODEL_CUR.ts`（本地切换时刻）→ 丢弃。`MODEL_CUR.ts` 由 `saveModelCur()` 回写（不只落 localStorage）；采纳过一次上报即清 `modelUserPicked`，恢复常态跟随。`loadModelsData` 的 model 优先级**按态分叉**：会话内 `MODEL_CUR`（SSE/拉取写入的会话权威）> `activeModel` > 便携根 `settings.model` > 本地 `saved`；非会话态（列表/首页）`activeModel` > `settings.model` > `saved`——`saved` 是上次刷新残留，任何态下都不得压过网关值。`MODEL_CUR` 持久化 key `floria-model-v1`。

## 6. web 打断按钮与打断收口 / 撤回链

回合进行中 web 发送按钮变**圆形方孔停止键**，点击 = CLI 一次 Ctrl+C。**仅当输入栏为空时才显示停止键**；输入栏有内容时恒显示发送键，点击=排队续发，输入清空即还原停止键。全链：web（**回合态由 `syncTurnLive()` 纯 DOM 实况推导**：渲染权威 `done-live[data-m]` 折叠或暂态区乐观主张折叠在场 = 回合运行中，每次渲染路径末尾校准；停止态点击经 `/clients` WS 发 `{type:'interrupt', sessionId}`）→ 网关 `case 'interrupt'` 按会话精确路由（未在线回 status 不 resume）→ CLI `gatewayClient.ts` → `src/bridge/gatewayInterruptHandle.ts`（模块级句柄，仿 controlOverrideHandle）→ REPL 注册 handler：**判活对齐 CancelRequestHandler**（abortController 存活或队列非空才生效）→ `onCancel()`（abort('user-cancel') + 清权限弹窗/队列 + 保留部分流式文本，与本地 Ctrl+C 完全同路径）。

**打断收口 / 撤回链**：打断后 jsonl 零写入（interrupted 标记不落盘、思考期本就不落盘），而 web 判定回合结束只认 end_turn 回复落盘 → 「正在处理/正在思考」永挂。修法 = 补两条 CLI→网关→SSE 信号链：①CLI `onCancel` → `gatewayClient.notifyTurnInterrupted()` 发 `{type:'turn-state', live:false}` → 网关无状态转发 → web 记 per-session `turnEndFlags`（无 TTL）+ `refreshSession(true)` → `closeSeg` 以「段末落盘 ts < 标记时刻」判收口「已处理」；②CLI auto-restore 且打断源自 web（`consumeWebInterrupt()` 时间窗标记）→ `notifyInterruptRestored(text)` 发 `{type:'restored', text}` → web 记 `restoredFlags` + 文本回填输入栏 → 渲染按 flag 永久跳过该 user 气泡（jsonl 不删）。**撤回走与本地完全同路径的 `restoreMessageSyncRef`**（rewind + 回填 CLI 输入框 + 图片回填）；CLI 框残留原文问题用 `restoredToCliRef` 记回填原文，auto-restore 守卫放宽为「空**或**恰为上次回填原文」。本地 Ctrl+C 原行为不变。**撤回动画**：restored 到达先定位 body 文本匹配的最后一个 user 气泡，JS 设 max-height 初值后加 `.msg-out`（opacity/transform/max-height/margin 四属性塌缩过渡）播约 0.3s，结束后 remove + `refreshSession(true)`。

**收口二轮（持久信号）**：`turnEndFlags` 仅内存、「关闭会话」直接杀进程则 onCancel 不跑。根修 = `closeSeg` 双持久信号任一命中即收口：**信号①进程不在线**（`findSession(live.curUuid)` 记 `state=null`，封死一切进程死亡路径）；**信号②turnEndAt 网关权威时刻**（`localGateway` 转发 `turn-state(live:false)` 时记模块级 `turnEndAt` map + `/gateway/sessions` 每会话下发 + 前端 `applyTurnEndAt` 在 `loadSessions`/`refreshList` 两处同源恢复，置于 listSig 短路之前）。时间比较天然兼容新回合覆盖（新消息段 ts > T1 不误收口）。

**断连 / 僵死感知链**：三种形态——①**孤儿僵死**（进程/WS 活但 query 链死，消息只 enqueue 零响应，心跳照发 busy → 状态点恒绿假象）；②**断流残影**（网关/进程死亡后 SSE 断流，web 冻结在 spinner + token 残影无断线表现）；③离线暂存待投（见 §2）。修法三条信号（复用「CLI→网关 WS→SSE 无状态群发→web 自持 per-session 标记」模式）：①**activity(null) + session-down**：`detach` 时 `sessionActivity.delete(sid)` + SSE `{type:'activity', session, state:null}`（状态点立即熄 + 当前会话收口运行态）；进程真死再发 `session-down` → web toast「会话进程已退出」（重连窗内不发）；②**session-up**：`/clients` 注册成功钩子群发 → web 清断开态刷新；③**turn-beat 僵死心跳**：CLI `REPL.setResponseLength` 内容增长分支 → `gatewayClient.notifyTurnBeat()`（4s 节流）→ 网关记 `turnBeatAt` + SSE 群发 → web tick/claimTick 每秒对账（见 §20）。beat 语义=「引擎最后真实产出时刻」；turn-state(live:false)/detach 即清 `turnBeatAt`。

**重启收口持久化 + activity 重连重报**：修三处：①**turnEndAt 落盘**（`.claude/gateway/turnend.json` 变更即写 + 启动 `loadTurnEndAt()`；落盘失败静默降级内存态）；②**CLI WS 重连 open 即重报 activity**（`gatewayClient.ts` `registerActivityResync` 钩子）；③**web activity 恢复对称刷新**（SSE activity handler：state 由 null 恢复非 null 且为当前会话立即 `refreshSession()`）。

**断连复核窗 + 优雅退出 + 无响应判定统一 + 钉顶对账收口**：①detach 立即群发 `activity(null)` 会与 CLI 重连窗竞速 → `localGateway.ts` detach 改 **3s 复核窗**（模块级 `detachTimers` Map，close/error 双触发 clearTimeout 去重）：窗内重连全静默，到期未重连才清 `sessionActivity`/`turnBeatAt` + 群发 null。②**shutdown 优雅退出协议**（见 §7）。③「无响应」判定统一为 `staleSec >= 150`（beat 缺席从折叠计时起点起算）。④**钉顶对账收口 `renderSettle`**：暂态区 `#live-zone` 高度变化统一走 `renderSettle()`（stage 在场即重投影）；`roundFoldOpen` 对 `#live-zone` 返回 false（防误判「处理折叠展开」污染临时让位判定）。

**无响应判定：回合基线 clamp**：`live.turnBeat` 是 per-session 永续 Map，前端正常回合结束**无 SSE 信号**无从删条目，上回合残留 beat 被新回合 tick 取用会立即误标。修法=两处判定（`bindLiveFoldTimer` tick + `claimTick`）统一加**回合基线 clamp**：`beatAt` 早于本回合起点（tick 用段开启消息 t1、claimTick 用 claimTs t0）→ 视同 beat 缺席，从回合起点起算——语义=「**本回合**开始后曾有增量后停摆」。

**排队消息催办**：点击排队气泡 = 打断当前这一轮「思考」，让排队消息立即并入当前轮次——不新增回合、不产生新乐观气泡、**不是中断**（见 §13）。

## 7. 侧栏行菜单「关闭会话」与浮窗 / 滚轮

会话行 … 菜单第二项（重命名 / 关闭会话；icon=dshStop）——语义 = **CLI 两次 Ctrl+C**，对所有在线会话生效：①先经 `/clients` WS 发 `{type:'interrupt', sessionId}`（空闲会话 CLI 侧判活 no-op）；②`POST /gateway/wsession/stop {id}` → 网关双分支杀进程：web spawn 会话走 `stopWebSession`（taskkill 真实 pid 树 → 本地 REPL 窗口随之关闭）；**终端直开会话按 `sessionActivity` 上报 pid（=CLI `process.pid`）`killTree`**。两分支统一 `gracefulStopCli`：先经 /clients 按 sid 精确单发 `{type:'shutdown'}`（非广播）→ CLI `gatewayClient` 置 `shuttingDown` 停重连 + 100ms 后 exit 0 → WT closeOnExit=graceful 自动收 tab → 3s 后进程仍活才 `killTreeExcept(pid, process.pid)` 树杀兜底（**豁免网关子树**——网关可能是本 CLI 会话的子进程，裸 `taskkill /T` 会连坐杀掉网关自身）。转录保留磁盘、tab 不消失，仅状态点熄灭；会话未在线 toast 提示。

**入口与形态 = 右键 / 长按唤出的浮窗**（三点按钮与内嵌展开菜单已删除；`recent.js` 只出手势与浮窗，**认哪种行由各列表注册** `registerRowMenu({sel,key,items,pick})`——会话行与 work 文件行共用同一套委托，见 §45）：浮窗 `.row-menu-pop` 由 `openRowMenu(hit,x,y,rowEl)` 挂 **行所属的 `#sidebar`**（`hit.el.closest('#sidebar')`，行不在侧栏内时回 `document.body`，如 `#bubble-pop` 里的会话行）——`position:fixed`、`z-index:70`，脱出 `#recent-body` / `#wk-body` 裁剪；**宿主必须落在侧栏内**：`#sidebar` 的 `mouseleave` 是「悬停预览」收起侧栏的唯一入口，浮窗若是 body 子节点，指针从行移到浮窗上即等于离开侧栏 ⇒ 侧栏与浮窗一起消失（2026-09-27 用户实测报告）。配套不变量：**侧栏收起 ⇒ 行浮窗一并收**（`setPanel(false)` 内调 `closeRowMenu()`，与 `bubblePop`/`organize-pop` 同处），菜单项由行的 `items(el)` 现算（空数组 = 该行无菜单，右键保留浏览器默认）。**两个入口都是 document 级委托**（`recent.js` 顶层绑定，各行无需接线——chat 侧栏 / 管理视图 / 气泡弹层 / work 侧栏自动同享）：桌面 `contextmenu` 命中已注册行（`preventDefault` 抑制浏览器菜单，落点 = 指针处）；触屏 `pointerdown` 计时 480ms（移动 >8px 或抬手即取消）→ `liftStart(row,{anim:false})` 扶起该行 + 浮窗落点 = 行左下，越界翻折 + clamp 回视口。**不变量：浮起与浮窗同生同灭** —— 点浮窗与行之外的任意空白（`pointerdown` 或 `mousedown`）、列表滚动、窗口 resize、非触屏下的列表重建一律 `closeRowMenu()` 一并还原（触屏长按的浮起由浮窗负责还原 `rowMenuTouch`；桌面右键按鼠标落点几何判定是否拍回，鼠标仍在行内则不拍）。长按抬手会补发 `click`（未拦住即误导航）与 `mousedown`：前者在 capture 阶段吞掉，后者由 `rowMenuGuard`（开启时 +600ms、抬手时续期）挡住，防「刚弹出就被自己关掉」。**菜单不切换当前选中项**：操作对象由行的 dataset 显式携带，浮窗跨列表重建由 `reliftRowMenu()` 按 `(行源, 行标识)` 重扶（两个列表出口 `renderRecent` / `renderWorkBody` 各调一次）。**不变量：浮窗与浮起恒锚定现役节点**——长按在 `pointerdown` 捕获行节点、480ms 后才落点，期间 `refreshList` 整列重渲（处理中 2-3 次/秒）即令捕获节点成孤儿（`getBoundingClientRect` 全零 ⇒ 落点被 clamp 到视口左上角，2026-09-28 用户 iPad 实机偶发），故 fire 时先按 `(行源, 行标识)` 重解析，行已消失则放弃（2026-09-28 根治；`reliftRowMenu` 管的是开启后的重渲，此为开启前的同一缺口）。**长按是手势不是选字**（2026-09-27 用户 iPad 实机：长按会话 tab 选中了标题文字，系统选择菜单「拷贝/查找所选内容/查询」与行浮窗同屏打架）：`.sess-item` / `.wk-row` / `.row-menu-pop` 三处 `user-select: none` + `-webkit-user-select: none` + `-webkit-touch-callout: none`（末者掐掉 iOS 长按呼出的系统 callout 通路），子元素不另设 `user-select: text`。**手势目标不叠系统按压层**（2026-09-27 用户 iPad 实机：长按 tab 唤出浮窗、**松手瞬间 tab 闪一帧灰**）：WebKit 给「可点」元素（button / a / 带 click 的元素）默认叠一层 tap highlight，且它与 `:active` 同由**抬手的合成鼠标事件**落定 ⇒ 变化只出现在松手那一帧（长按此前被文本选择吃掉，上一段的 `user-select:none` 落地后这层才显形）；本项目按压反馈全部自绘（`.sess-item:hover` / `.lift` 浮起 / 长按手势本身），故在 `styles.css` reset 段**全局关一次** `* { -webkit-tap-highlight-color: transparent }`——**不逐元素维护**（浮窗菜单项 `.rm-item`、气泡行、将来新行型会逐个漏）。

**会话行的菜单项** = 重命名（`openSessionRename` → `openRenameDialog`）/ 关闭会话（`.rm-danger` 红字）。**重命名弹窗一件两用**（2026-09-27）：`#rename-modal` 只管表单壳（标题/占位/初值/错误回显），提交语义由 `openRenameDialog({heading,placeholder,okText,value,onSubmit})` 注入——会话走 `POST /gateway/session/rename`，文件走 `POST /gateway/file/rename`（§45），不各建一套弹窗。

**滚轮互搏与死区根治**：`liftCool` 滚动静默期（scroll 监听置 `Date.now()+150`）必须同时挡 mouseenter 直调**与**重建重扶出口（`refreshList` 高频整列重建，滚动中每步都被拍回=「侧栏滚轮失效」）——**不变量：扶起只发生在列表静止态**（出口①触屏长按菜单/②reLiftHash 点击语义=用户主动，保持直调）。**死区真根因=fixed 浮起行不在 `#recent-body` 的滚轮滚动链上**（Chromium 滚动链走包含块链，fixed 行直连 viewport）；根修=`#recent-body` 挂 **non-passive wheel 监听**：滚轮到达=滚动意图 → 同步 `liftClear(true)` 拍回 + `void offsetHeight` 强制 layout，让默认滚动动作在干净布局上把滚动链重新解析回容器；浮窗开着一并 `closeRowMenu()`。**不变量：滚轮到达列表 → 列表回纯在流态**。

## 8. 两层消息流与渲染定案

**两层模型**：上层=各种气泡和 AI 消息，第二层=乐观气泡生成的占位，占位大小按屏幕计算，两层合并作为滑条依据。**新模型（占位一诞生即永恒）**：①`.pin-stage` 静态占位块挂 `#messages` 流末（暂态区之后），高度=滚动容器 `clientHeight`（诞生锁定，仅 resize/对账校准），**不随内容收缩、回合结束不自动撤**；②跟随吸底目标=**真实内容底**（`stageFollow`：`scrollTop = max(开启气泡贴顶位, 占位起点 − 视口高)`）；③唤出条件：仅新回合开启消息（web 乐观气泡 `addUser` form='bubble' / CLI 端权威新 user 经 hasNewUser 链），**会话处理中发送=排队成员不唤出**；乐观气泡唤出 `key='optimistic'`，落盘接管帧 `stageStart(el, 权威key, false)` 直终态。旧钉顶的持续吸附状态机 + 逐帧动态几何 + 三类内容几何监听 + `settleCheck` 轮询全部退役（`msg-pin` sticky、`pinReserveApply`/`roundFoldOpen`/`pinSettleCheck`/`pinMaybeRelease`/`smoothDismissPending`/img load 捕获重算/折叠 toggle 重算/折叠收起 click 接管）；`renderSettle` 保留为渲染权威出口对账（`stageSync`：块失联重挂/高度校准/气泡重定位/跟随归位），`msgAppend`/`applySegDelta`/`renderTransient` 插入锚点 `.pin-stage`。**不变量**：占位块至多一个恒居流末；占位高度只随屏幕不随内容（**且恒 = `max(0, clientHeight − paddingBottom − 脚印)`，无第二写入者**）；用户滚动=让位。

**bubble 失联链根修**：`stage.key` 存 sig（`"idx:ts"`）而渲染权威气泡 `data-m`=段起始索引（纯数字）⇒ `stageSync` 重建后重查找恒落空 → bubble 永久失联 → `stageFollow` 的 t0 退化 0。修=`stageSync` 重查找取 sig 索引部分（`":"` 前）匹配 `data-m`，sig 防错位语义保留在 key 本体；**不变量补全：t0 恒取真实贴顶位**。

**触摸让位 + 状态行单行轮转**：①**触摸不释放不摘占位**——手势进行中删一屏高占位 → `scrollHeight` 骤减 → WebKit 触摸滚动基准断裂弹回。新模型：`stage.touchHold`=手势持有期（含惯性，touchend 后 scroll 静默 500ms 判停）冻结 `stageFollow`；静默判停 → `stage.yielded=true` 永久让位（stageStart/释放复位）；tap（位移 ≤6px）不让位。②旧 pin 14 件符号全量退役 grep 零残留；`atBottom` 吸底块保留（有 `!stage.active` 守卫）。③状态行 summary 单行轮转：`liveFoldBody` tick 改**节点级原地更新**（`.think-state`/`.d-dur` `textContent` + `.d-flags` 就地替换——重建每秒洗掉扫光动画与流式预览节点=闪烁根因）；流式预览 `applyStreamPreview` 同挂 summary 一行。

**释放链与占位尺寸**：①**用户滚动输入永不摘占位**——wheel/scroll 只置 `stage.yielded=true`，`stageRelease` 仅剩视图级退出 4 调用点（renderSession / renderHome / renderMgr / openProjectPreview）。**占位生命周期 = 会话视图生命周期**。②`.think-stream` 删 `max-width` 封顶改 flex 子项 `min-width:0` 收缩充满 summary 剩余整行；保尾用 `direction: rtl + text-align: left`（删 `unicode-bidi: plaintext`——内容以拉丁字符开头时基方向解析成 LTR 会反转保尾裁切边）；`.think-stream` 用 `flex:1 1 0`（基准 0 只吃剩余空间）。③**占位尺寸公式**：高度=`max(0, clientHeight − paddingBottom − 脚印)`（`clientHeight` 含 docked 输入栏的悬浮预留，须扣 `padding-bottom`）。

**占位脚印实时化**：`lockFoot` 诞生快照会让诞生后任何内容增长 1:1 变成额外可滚动余量。根修=`stageSync` 脚印改**实时读取**（`foot = topInScroll(占位块) − topInScroll(参照气泡)`）、删 `lockFoot` 字段。**不变量：内容未超一屏时 `scrollHeight ≡ 一屏`、`maxScroll ≡ 贴顶位`**。配套：①气泡参照找回**提前到脚印计算之前**，乐观态暂态区无气泡时回落数据区最后一条 `[data-t="u"]` 权威气泡；②参照两端皆缺（重建窗口内）不写占位高度（写 0 = 钳制跳变）。

**发送瞬间「跳到上一条消息」根治**：①`stageStart` 删动画窗——**占位高度是几何的纯函数**（参照气泡定了终态就定了），写终态 + `stageFollow` 同帧归位；②`route.js` `lastU` 循环补 `&& !messages[i].injected`，与 `live.js` 归并为**同一条规则：钉顶只属于新回合开启消息，引导消息恒不钉顶**。**不变量**：占位高度恒 = `max(0, clientHeight − padBot − 脚印)`；发送事务内 `scrollHeight` 单调不减、`scrollTop` 一次落在贴顶位。探针 `probes/probe-stage-pin.ts`。

**注入吸收帧参照移交**：注入开段回合在 DOM 无 `data-t="u"` 开启气泡（注入气泡只以 `data-t="g0"` 织在段折叠体内）→ 旧回落「末条 `[data-t="u"]`」命中上一回合气泡。修：`stage.js` 新增回合权威锚解析 `guideTurnAnchor`（引导气泡 → `closest('details.done-fold[data-m]')`；该段若另有 `data-t="u"` 仍取开启气泡）+ `absorbTurnAnchor`（以**文档序**判最新回合开启者）。**禁止回落上一回合**。已知候选（未改）：`route.js` 载入钉顶对「末回合为注入开段」的会话仍钉上一真实回合。

**视口基准 dvh**：`html,body{height:100%}` 是恒定大视口（=URL 栏收起态高），iPad Safari 顶栏展开时会叠盖视口顶且底部溢出屏幕。根修=`html{height:100%;height:100dvh}`（100% fallback）。同批 `capRenderedMessages` 归一化：收拢全数组占位计数 + 剥全量替换路径挤到中部的残留，强制「至多一条占位、恒在下标 0」。

**状态行落位终局**：**`done-fold` summary 恒「正在处理 + 总时长」/终态词 + 摘要计数 + 时长**（任何状态不再轮转上顶）。终态词三态：处理中「正在处理」；正常收尾「已处理」；被打断/被新消息取代（无正文且非 end_turn/stop_sequence 收尾）「已停止」。已完成态摘要含**计数段**（`.d-count`：`N 次工具调用` / `N 次提问`，0 值省略——借鉴 dsh `TurnProcessNodeView` 三段式计数），后随时长（`.d-dur`）；「已停止」不显时长与计数（对齐 dsh aborted/error 置空时长）。分隔线画在**整个折叠体下缘**（`.done-fold:not(.done-live) { border-bottom:1px var(--border) }`，对齐 dsh `TurnProcessNodeView` 的 `.root{border-bottom:0.5px}`——dsh 的线在整块节点底、非 header 底）——折起时即「已处理」行下方一条，展开时落到折叠体内容之后，**不横在「已处理」头与工具状态行之间**；**仅收口后**（「已处理/已停止」）加线，运行态（「正在处理 Xs」）不折叠、不加线也不留额外底垫。**折叠体与其后 AI 最终答复的段距收窄**（`#messages > .done-fold + .msg.assistant { margin-top: -8px }`，18px→~10px；只作用紧跟的回复气泡，不碰折叠体与下一回合开启消息、回复后变更卡）。**无面向用户正文的回合**（折叠体外无 reply 项）默认 `open` 并带 `data-nobody="1"`，收口时增量重建（`live.js` `finishedNow` 分支）不自动折叠——保留过程证据（对齐 dsh「关闭时没有最终正文的轮次保留全部过程证据」）；有正文则照常收口自动折起。**「处理失败」态暂缺**：需会话引擎/网关给出每回合 end reason（error），web 端无此信号（`.is-flagged` 红标是会话僵死/断连的存活信号，非回合结果）。思考/压缩扫光状态行落**段体尾部 `.fold-state` 容器**（与工具调用行同域、单宿主单实例），流式预览 `.think-stream` 与无响应/连接中断红标同容器。接线：`liveFoldBody(items, vacuumState, vacuumStart)` 真空态渲染帧在段尾产出状态行（工具运行态不产出）；`bindLiveFoldTimer` tick 双行独立跳字（summary `.d-dur`=段总时长、`.think-state`=距最后落盘 Ns）；红标宿主=状态行容器（真空态）或 done-body 尾（工具态）；乐观主张折叠同规则。

**状态层并入构造期拼接**：用 `sumEnd` 字符偏移回切插入状态层会错位。根治=废弃字符偏移回切，**`stateAppend` 构造期拼接**：`flushTools` 拼 summary 时直接带上状态层，仅循环后那次 flush 生效（旁白打断的收口组不带）；`stateMerged` 判定真并入，尾部无工具组→段尾独立行。

**状态层顶替概括 + MCP 名短显 + 标签省略**：①真空态并入帧 `sumInner=''`，summary 只渲染状态层，工具明细点开仍在、回合收口后恢复完整概括；②`toolMeta` 补 `mcpShortName`（`mcpInfoFromString` 的 `split('__')` 取 tool 段，无 tool 段退回 server 名；仅显示层，权限匹配与 `data-name` 仍走原始名）；③`.tool-fold summary .tf-label` 补 `min-width:0 + nowrap + ellipsis`（`.tl-text` 同配方）。

## 9. 其它渲染与显示

**用户消息图片渲染**：链路 = ①源码权威导出 imageId 化（`conversationDisplay.ts`：`DisplayBlock.imageId` = pastedContents id = `image-cache/<sessionId>/<id>.<ext>` 文件名主干）→ ②网关字节端点 `GET /gateway/image-cache/<sessionUuid>/<id>`（readdir 解析扩展名，**`private, no-cache`**，受 token/cookie 保护）→ ③前端 `userBodyHtml`（剥 `[Image #N]` 占位）+ `userImgsHtml`（`.msg-imgs` 在 `.body` 后=气泡框外正下方右对齐；img `data-ph` + `onerror`：**图未落盘时替换为 `[Image #N]` 裸文本不出破图**——`cleanupOldImageCaches` 会删非当前会话缓存，404 是常态）。**两气泡根修**：`normalizeMessages` 把「text+image」拆成两条，web 原样输出即两个气泡；`filterConversationForDisplay` user 分支末尾重组——image-only 且带 imageId 且前一条真人 user 文本含对应占位 → 并回前一条（工具截图 tool_result 场景自然不合并）；三链路同享同一函数。样式 `.msg .msg-imgs .msg-img`（上限 240px + 单击 lightbox，`ensureLightbox` 单例 + document 级委托，z-index 1200）。**错图回卷根修**：前端渲染清零重扫 `live.maxImgId`，视图丢历史 image 块即回卷复用 1 号 → CLI `storeImage`（open 'w'）覆写 + 网关钉旧字节 = 新气泡显旧图。双修：①分配器**单调不回卷**（id 唯一性是分配器不变量）；②网关字节端点 `private, no-cache`。诊断法：转录 `imagePasteIds` 撞号 + image-cache 单文件 mtime，离线跑 `filterConversationForDisplay` 验投影完整性（探针 `probes/probe-imgid-*.ts`）。**排队批量出队不变量**：`processQueueIfReady` 会把队列里同 mode 的非斜杠命令**一次抽干**交给同一次 `executeUserInput`（一轮内连发多条带图消息即此形态）；`pastedContents` 是**每条命令自己的**载荷，必须逐条携带——只有回合级共享上下文（`ideSelection` / `skipAttachments` / `setUserInputOnProcessing`）才按 `isFirst` 门控（`utils/handlePromptSubmit.ts` 循环内）。缺则第 2..N 条命令的图不落 `image-cache`，前端 `<img>` 404 回落 `[Image #N]` 裸文本（现象＝气泡里正文被剥成纯文本、下方一行裸占位）。判据：转录中同 `promptId` 的 N 条 user 记录里，只有第一条带 image 块与 `[Image source: …]` meta。

**变更卡文件列表显示相对启动根路径**：网关 `readSession` 取转录记录自带的 `cwd`（会话进程启动根：CLI=exe 目录=项目根、web 笔=全局根、web 项目=该项目根）随载荷附出；前端 `relFromCwd()` 把 fileChange 绝对路径（`\`→`/` 归一 + 大小写不敏感）剥掉启动根前缀显示相对路径，不在根下/无 cwd 回退 basename；`.ch-file` 加 rtl 方向技巧（溢出省略头部）。仅显示层——变更聚合/去重 key 仍用绝对路径，实时与历史两路同走 `renderChangeCardHtml`。

**后台任务通知居中气泡化**：回合以 `end_turn` 收尾后，后台 Bash 任务完成以 `<task-notification>`（`role:'user'`，`origin.kind='task-notification'`）落盘注入唤醒，AI 续跑后再次 `end_turn` 收尾 → 同段两次正式发言（数据忠实）。定案形态：**通知以居中浅灰气泡按时序堆叠**——`conversationDisplay.ts` isTaskNotify 分支恒下发 `pushSystemHint('后台任务完成：'+summary)`（**移出 SHOW_NON_INTERRUPT_HINTS 总开关单独恒显示**），web 复用 `role:'system'` 居中行渲染；`.msg.system` 为浅灰气泡。附带：`normalizeMessages` switch 无 default，元记录直喂会崩 `isNotEmptyMessage`——网关 `readSession` 的五类型前置过滤即为此设，任何新消费端直读 jsonl 必须带同款过滤。

**限流降级提示居中灰 + resume 哨兵全端剔除**：①统一限流降级不再发 `NO_RESPONSE_REQUESTED` 静默占位——改 `rateLimitFallbackNotice(model)` 生成「模型用量已达上限 · 已切换备用模型（model）」，仍记入会话历史；CLI 端 AssistantTextMessage 前缀匹配居中灰渲染（置于 switch **之前**——动态文本不进精确 case），web 端经投影前缀命中转 `pushSystemHint`；②resume 补位哨兵（`conversationRecovery` 追加的 `NO_RESPONSE_REQUESTED` assistant 占位，数据层保留）权威投影层 assistant 分支按精确文本整条剔除（CLI 原有 return null，web 侧曾漏出被渲染成回复气泡），历史回放与实时增量同治。

**审批栏正文按工具语义渲染**：`prettyToolInput(toolName,input,desc)`（`inputbar/approval.js`）：Edit/MultiEdit（`input.edits[]`）=文件名 + **红/绿两段文本 diff**（`.appr-diff`）；其余工具=**中文字段标签 + 值**列表（`FIELD_LABELS` + `TOOL_FIELD_ORDER`，未列字段追加在后）；命令/正文类字段（`command`/`content`/`new_source`/`prompt`）恒落 mono 代码块（`.appr-pre`），多行/超 140 字符值自动升级成块；`boolean true`→「是」，`false`/`null`/空串不渲染；与卡头 `a.description` 逐字重复的字段不再渲染。**ExitPlanMode**：`input.plan`（模型写的计划正文）走 `mdHtml` 渲染（`.appr-md` 作用域，样式注入于 `core/gateway.js` 的 `gatewayCss()`——审批卡不在 `.msg .body`/`.done-think`/`.tr-body` 内，故 md 块级标签在此重复挂样式），其余字段（`allowedPrompts`）仍按通用字段列表渲染；与 CLI 弹窗 `<Markdown>` 同源语义。纯 web 展示层：进料仍是 CLI `sendRequest` 原样透传的 `a.input`。探针 `probes/probe-approval-pretty.ts`（含转义/XSS 断言 + ExitPlanMode 分支接线断言，mdHtml 注入记录型 stub）。

**审批栏入场动效**：`.appr-in`（`@keyframes apprInUp`：`opacity 0→1` + `translateY(10px→0)`，220ms ease-out）与高度长出（320ms）**同帧起播**；卡面本体在 `.bar-takeover` 态不退场 ⇒ 内容淡入不露首帧空洞；10px 位移落在卡片底部内边距内 ⇒ 按钮行不被裁角；**只在「普通输入栏 → 卡片」那一次播放**（`showTakeover` 的 `firstShow` 门）。

**接管期输入内容组的退场方式（不变量）**：`.bar-takeover` 下 `#input-bar` 的非卡子件走 `position:absolute; visibility:hidden; pointer-events:none`（**禁止 `display:none`**）——聚焦中的 `contenteditable` 一旦被移出渲染树，WebKit（iPad Safari / iOS 各浏览器）连带销毁其文本内容，草稿在卡弹出时整段丢失；绝对定位不参与流布局 ⇒ 输入栏高度仍只由卡决定（与 `display:none` 同几何），元素与内容留在渲染树内故草稿存活。配套不变量：`showTakeover` 显式 `inputEl.blur()`（非渲染退场不再顺带失焦）⇒ 接管卡在场恒 `isEditing()` 为假，`viewport.js` 的键盘几何/整页平移不会把已收起的软键盘当编辑态处理。

**审批栏高度视口预算 + 收起并行式**：①**高度**：`.appr-body` 改视口预算 `max-height:calc(100vh - 260px)`（`100dvh` 后置声明；预算＝黄条带 38 + 按钮行 60 + 底距 22 + 聊天区至少可见 ~140）。②**收起 = 单一时间轴并行**：`collapseTakeover` 并入 `clearTakeover`，同帧起播三件事——`.appr-out`（`clip-path:inset()` 底边插值 + opacity，170ms，须 ≤ `HEIGHT_MS`=320ms）、`.bar-collapsing` + 撤 `.bar-takeover`、`.bar-reveal`（170ms）。**几何关键**：收起期卡片仍走 `.composer-growing` 的 `absolute bottom:0`（底边钉原位）⇒「卡自下而上被削掉」与「下方同步露出输入内容」同方向交叉过渡。常量：`HEIGHT_MS` 须 = `styles.css #input-bar` 的 `height 0.32s`。配套不变量：`syncTakeoverPad` 在收起启动同帧清零（须在 `wrapAnimating` 置位前直接写）；`cancelClose()` 在新 takeover 到来时撤三态残留；`showTakeover` 先清 `inputBarEl` 内联高度再实测；`finishClear` 复位 `wrapAnimating/wrapClosing`。**审批卡是同链唯一在场者**（只读 question 卡已移除，见 §17）。

## 10. 内存优化链

**P1 渲染历史上限（REPL.tsx + utils/renderCap.ts，自建机制——父源无此层）**：`capRenderedMessages` 只作用于**渲染出口**——`setMessages` 把全量数组落 `messagesRef`（数据层＝模型/工具上下文，与父源同语义），`rawSetMessages` 收到的才是 cap 产物（React messages state 收敛为尾部窗口 + 单条归档占位，计数从占位文案自身解析=幂等）；初始 useState 同样 cap。**窗口边界＝UUID 锚点 + 步长量化**（`computeSliceStart`，`renderCapAnchorRef` 跨调用存活）：消息数超过 `MAX_RENDER_MESSAGES`(200) + `RENDER_CAP_STEP`(50) 才前进一步，一步落到恰好 200 条 ⇒ 追加不移动顶行、驻留上界 251 条；`Messages.tsx` 的渲染切片走同一实现（原计数滑动版已删，两处单一定义）。**长度不变量：`logicalRenderedLength(投影)` ＝ 未 cap 原始条数**（占位元素自身不计数）⇒ baseline/pending 判定在全量源（`.length`）与投影上逐值相等，删除「cap 后长度非单调」的一切补偿。**语义变化：transcript 虚拟滚动回放只见窗口**（完整历史权威在 jsonl）。探针 `probes/probe-render-cap-layering.ts`（长度不变量 + cap 幂等）、`probes/probe-cap-head.ts`（顶行只在窗口前进时变）、`probes/probe-render-cap-flicker.ts`（Ink fullReset 计数：计数滑动 260 帧 60 次 → 锚点量化 1 次）。

**P2 增量上报（conversationDisplay.ts + localGateway.ts）**：CLI 侧 `displayCacheBySession`（键 `${sessionId}:${mode}`，存已上报投影的**尾部窗口** `sent`（≤ `SENT_WINDOW`=400）+ 绝对起点 `sentOffset` + lastModel 末态 + 失步标；上报 `base` 恒为绝对坐标，网关侧语义与缓存视窗化前一致）做「水位对齐 + 尾部窗口投影」——对齐键为稳定键 `sid`，`filterConversationForDisplay` 新增可选 `initialLastModel/lastModelOut`，每轮发 `{sessionId, messages, base}`；网关 `/gateway/conversation` 按 base 聚合为全量，响应带 `cached` 长度，CLI 校验不符（网关重启/sweep 失步）置 needFullSync 下轮全量直传对账。P1×P2 联合：单轮构建/序列化/传输峰值恒定（≤ `MAX_RENDER_MESSAGES`+`RENDER_CAP_STEP`+1 条投影）。已知名义缺口：CLI 进程重启后 cache 空且窗口首条对不上网关缓存时走窗口全量替换（web 前缀短暂缺失，jsonl 权威在盘）。

**P3 web 注入图压缩前移（gatewayClient.ts）**：`compressPastedContentsFromImages`（WS send 分支）对 >2MB 原图先 `compressImageBuffer` 再入 pastedContents；CLI 本地粘贴链的执行时 resize 原样保留。

**P4 结论（无代码改动）**：fork ink 为双缓冲 screen-blit 架构，内存驻留主体=React 树（messages state），已由 P1 有界化覆盖。

## 11. 教训（勿忘）

①引导消息「吞消息/顺序颠倒」一类渲染 bug 先查 jsonl 物理落盘位置与用户感知顺序的差异（queue-op 消费时序），不是前端渲染逻辑先坏；②折叠唯一性破坏（多 fold）会让钉顶/计时/增量重建锚点全链错位——「已处理永远在第一个消息下」是结构性不变式，任何新渲染方案不得引入第二个 done-fold；③对生成好的 HTML 字符串做偏移切片插入是脆弱机制，插入内容应在构造期随模板拼出。

## 12. 前端模块化架构（web-src/）

**定案**：`src/gateway/web-src/` 下 27 个 ESM 模块（含入口 `app.js`），**web-src/ 是唯一手改处**；构建时 `scripts/build.ts` spawn 自写拼接器 `scripts/bundle-web-modules.ts` 把各模块按切割区间行序拼回单 IIFE 写 `web/app.js`（生成物勿手改）。产物文件名/引用不变，sw CORE、`?v=` cache-bust、gen-web-assets、网关静态路由全链零改动。

**打包器定案——自写拼接器（非 Bun.build）**：Bun.build 按依赖图**重排模块执行序**，而多个模块的顶层立即执行代码引用 `state.js` 的 const → TDZ 崩溃；且 IIFE 顶部切割区间外的 `const $ = (id) => document.getElementById(id)` 不属任何模块、切割即丢。根治=拼接器按 MODULES 表**原区间行序**拼回。三机制：**锚点检索**（区间首行=节标题/独特函数签名，手改增删行不破坏拼接）、**marker 尾界**（`// —— 跨模块写入口`/`export {` 首现处）、**首行防呆**（锚点前必恰有 1 分隔空行）。setter 跟随定义模块末区间输出（0 缩进 function 声明，hoisting 无 TDZ）。

**模块布局**：
- `app.js` 入口=import 群 + 事件绑定 + 启动序列
- `core/`：icons（SVG 图标）、state（元素引用/共享可变态/toast/媒体工具）、char（角色形象）、markdown、sessions（会话映射）、live（SSE 会话事件）、gateway（WS 连接/审批中继）、auth（门禁认证/设备认证）、viewport（可视视口/键盘几何）
- `sidebar/`：mgr-data、recent(最近会话/拖宽)、mgr（管理视图编排 + 侧栏最近列表/项目树）、bubble-search、rail-ext（预览页注册的快捷按钮，见 §39）
- `inputbar/`：ctx-meter（ContextMeter/纯文本粘贴）、mention（@提及）、commands（命令菜单）、model-select（模型选择/状态域）、approval（审批卡/回合态/takeover/任务浮窗）、images（图片附件 + 文件上传）、send（gwSend/syncGwSend）
- `chat/`：route（路由渲染）、messages（消息渲染）、stage（钉顶占位/stage 机制）
- `views/`：registry（**视图注册表 + 槽位单通道整卡切换**——一模块一卡组件在 `views/cards/`，tab 的 id/标题/图标/`mount` 单一真源，侧栏 tab 生成、`#mgr/<id>` 路由、卡体渲染三处走同一张 `CARDS` 表 + 唯一入口 `openCard`，见 §41）；`views/cards/`：`plugins/projects/models/neurons/preview-card.js`（五张第一方卡，各自 `mount`）+ `ext-card.js`（外部卡 iframe 壳 + 声明过滤器，见 §42）

**跨模块可变状态 = SETTERS 机制**：14 个跨模块写入的 let（`ALL`/`connUp`/`gateAwait`/`gateVerified`/`sessionCwd`/`takeover`/`turnLive`/`btnMode`/`MODEL_CUR`/`modelUserPicked`/`pendingUserMsgs`/`firstSendHash`/`lastNavHash`/`approvalPending`）在定义模块尾生成 `export function setX(v){X=v}`，写入方一律调 setter（import 绑定不可赋值=ESM 硬约束）；读跨模块符号走 import（函数级循环 import 安全：hoisting + live binding）。

## 13. 排队消息催办：点击排队气泡打断当前思考

**语义**：点击置底排队区某条气泡 = 「这条我等不及了」。效果**与「模型自然答完后排队消息被纳入」完全一致**——该消息作为注入引导织进**当前**折叠体，模型在**同一回合**里接着答它。明确排除：①**不是新的乐观气泡**（不产生新回合）；②**不是中断**（不走 `onCancel`、无撤回/restored 链）。生效时机：**只在模型生成（思考）时打断**；模型跑工具时点击不动它。

**引擎侧（`query.ts` + `messageQueueManager.ts`）**：既有中链 drain（每轮工具循环开头把队列里的 prompt 命令转成 `queued_command` 附件）是「纳入」的唯一路径。**不能用回合级 `abortController`**——它污染本轮之后所有迭代且直接结束回合。故新增**生成级断流**（不变量：**队列非空 且 当前有一次生成流在飞 且 该生成尚未产出完整 `tool_use` 块 → 断流**）：①`messageQueueManager` 加催办标记 `queueNudgeRequested` + `requestQueueNudge()/peekQueueNudge()/consumeQueueNudge()` + `getDrainableQueuedPrompt()`（可催办对象判据＝`mode:'prompt'` ∧ 非斜杠 ∧ 主线程 `agentId===undefined`），并在 `notifySubscribers()` 里「队列清空即失效」；②`query.ts` 生成流 `for await` 循环体首行 `if (isMainThread && toolUseBlocks.length === 0 && peekQueueNudge()) break`（`toolUseBlocks` 是**本迭代**数组，此处为 0 时断流**不可能**留下孤儿 `tool_use`）；③收口在 `if (!needsFollowUp)` 之前：`if (!needsFollowUp && consumeQueueNudge()) needsFollowUp = true` ⇒ 模型同一回合答这条消息。一次性消费 ⇒ 不会无限断流；队列清空即清标记 ⇒ 不会跨回合误伤。

**链路**：web `.q-item` 点击（事件委托，`cursor:pointer` + `title` 提示）→ `/clients` WS 发 `{type:'queue-nudge', sessionId}` → 网关按会话精确路由（未在线回 status；**不 resumeAndDeliver**——离线会话没有生成流可断）→ CLI `gatewayClient.ts` → `src/bridge/gatewayQueueNudgeHandle.ts`（模块级句柄）→ REPL 注册 handler 判活两条（缺一不可）：**①有在飞生成**（`abortController` 存活）、**②队列里有可 drain 的用户消息** → `requestQueueNudge()`。headless 无句柄 → 静默忽略。

**气泡归属（不变量）**：**气泡属于文字、不属于图片**——气泡壳（`padding`/`border-radius`/`background`/虚线边框/hover）挂在文字段 `.q-text` 上，`.q-item` 是纯命中盒（`cursor:pointer` + 命中区，自带零壳）；`width: fit-content` 令气泡按文字收窄。归属由 **DOM 结构本身**决定（有无 `.q-text`），无类名、无布尔状态源。三态：纯文本项=一个气泡；纯图项=无 `.q-text` ⇒ 无气泡、整张图即点击体；文字+图项=文字带气泡、图片在气泡外裸渲染（`.q-imgs` 仅在前面有件时留 `margin-top`）。**排队图恒用 `.q-img`，绝不换 `.msg-img`**——lightbox 委托（`chat/messages.js`）只认 `.msg-img` ⇒ 点排队图**结构上不可能**开大图，只触发上面的 `queue-nudge`（与「只有已发送图片才有大图」同一机制，无需额外守卫）。

**右对齐（`.q-body` 必须是块流）**：`.queue-dock` 整体 `align-items: flex-end`，`.q-body` 内三段（`.q-who`/`.q-text`/`.q-imgs`）须**右缘一致**——`fit-content` 的气泡若不额外处理会落在 q-body **左侧**、与更宽的图片错开成阶梯状，故 `.q-text` 加 `margin-left: auto`、`.q-who` 加 `text-align: right`（同 `.msg.user .who`）、**`.q-imgs` 加 `justify-content: flex-end`**（图片组贴 q-body 右缘）。三个方向必须同时给：`.q-img` 的 `max-width: min(160px, 100%)` 含百分比，百分比在内在尺寸计算阶段不可解析 ⇒ 浏览器按**原始宽**估 `.q-imgs` 的 max-content，`.q-body`（`flex: 1`）被撑得比实渲染的图片宽（实测 259 vs 160 CSS px）⇒ 只给气泡 `margin-left: auto` 时气泡落在 body 右缘、图片留在 body 左缘，右缘错开成阶梯（2026-09-19 实测复现）。**`.q-body` 不得改成 flex 列**：它同时是 `.q-item`（flex 行）的 `flex: 1; min-width: 0` 子项，改 flex 列后 `.q-imgs` 退化为收缩宽度的 flex 子项，`.q-img` 的 `max-width: min(160px, 100%)` 里的 `100%` 变成循环依赖、图片塌成细条（浏览器把该百分比解析到极小值）。

**已验证**：`probes/probe-queue-nudge.ts` 16/0。

## 14. 处理中段尾部工具组恒收口

**不变量：处理中段的尾部工具组恒有渲染出口**；段体空白只允许发生在「无工具且无真空态」的瞬态。实现：`flushTools()` 从 `if (vacuumState)` 分支内提到分支外**无条件收口**（`flushTools()` → `if (vacuumState && !stateMerged) html += 段尾独立状态行`），`stateInner` 声明上移到分支外；真空态并入折叠 summary 的原路径不变。`flushTools` 内的 running 分支（`正在运行：<工具> · <详情>`）由此可达。

**自取证**：`probes/probe-livefold.ts` 与打包器同源（剥 `messages.js` 的 import/export 行、跨模块名注入纯 stub，调用**真实 `liveFoldBody`**；fixture 须带 `html=toolLine(b)`——`if (!it.html) continue` 会跳过无 html 项）；`--prefix` 开关还原旧出口做对照。

## 15. 底栏任务浮窗（TodoV2 清单）

**形态定案**：清单内容在 web 被渲染；任务栏作为底栏的一个子元素，从底栏生长出宽度小于底栏的浮窗，收敛态仅显示边沿，点击向上伸展、再点向下收敛。**数据源=新增 `task-state` 链**（不复刻：CLI 复刻即违反根本原则 1）；边沿位置=输入栏上沿之上；展开宽=输入栏宽−48px 居中、上到聊天区 40%；与接管栏=自动收敛并禁点。

**链路（CLI 单源 → 网关镜像 → SSE/首载 → web 渲染）**：
- CLI 出口：`useTasksV2.#notify()`（`#fetch` 与隐藏计时器两条路径唯一汇合点）→ `#report()` → `gatewayClient.notifyTaskState(this.getSnapshot() ?? [])`。**载荷去重**在 `notifyTaskState` 内做（`lastTaskStateJSON` 比较）；`sock.on('open')` 补发当前清单。
- 网关（`src/gateway/localGateway.ts`）：`normalizeGatewayTasks` 是**形状边界唯一处**——非对象/缺 `id`/缺 `subject` 项丢弃；未知 `status` → `'pending'`；`subject` 截 500；`blockedBy` 只留字符串；非字符串 `owner`/`activeForm` 落 `undefined`；长文本不透传。存 `sessionTasks` Map（**无时间 TTL**——有 TTL 会与「载荷不变不发」的去重矛盾；生命周期=上报 upsert + `detach()` 清 + 重连 open 补发），`/gateway/session.tasks` 首载 + SSE `{type:'task-state', session, tasks}` 直带全量快照。
- web（`core/live.js` SSE 分支 + `core/sessions.js`/`chat/route.js` 首载三入口）写 `live.tasks` 后调 `renderTaskDock()`；切会话/回首页槽位清空同清单同步。

**单源不变量**：web 渲染的清单 = CLI `getSnapshot()` 同一份语义（hidden/空 → `[]` → 浮窗整体不出现），**web 无任何状态推导、无形状兜底分支**。

**DOM 与几何**：`#task-dock` 是 `#input-bar` 的**子元素**（`position:relative` 为定位上下文），`bottom:100%` 贴输入栏上沿之上、`overflow:hidden` 作裁切盒，`pointer-events:none`（仅在 `.td-lip` 与展开态 `.td-panel` 恢复）。收敛态面板 `transform: translateY(100%)` 整块藏进输入栏后，露出件只剩 `.td-lip` **12px 把手条**（hover 14px）——露出的是 `.td-panel` 自身顶边（同材质，揭示/收合视觉连续）；`.blocked` 加 `opacity:.55`。展开态 `translateY(calc(-1 * var(--td-gap)))`，`--td-gap` = **10px**（面板底边与输入栏上沿间距）；盒 `padding:18px 10px 0`。点击边沿/`.td-head` 切换 `.open`（0.32s cubic-bezier，与接管栏同款缓动）；宽=输入栏宽−48px 居中，`max-height: min(40vh,460px)` 内部滚动，展开态重渲保留 `panel.scrollTop`。行渲染与 CLI `TaskListV2` 同构：图标 `✔/◼/◻`、id 数字升序、`completed` 与「被未完成前序阻塞」行 dim、阻塞行 tooltip「等待前序任务：<id>」、`in_progress` tooltip = `activeForm`、owner 渲染 `@name`。**接管让位**：审批/提问卡入场（`showTakeover`）→ 自动清 `taskOpen` 并加 `.blocked`（边沿 `disabled` + `onclick=null`），卡撤走恢复可点且**仍保持收敛**。

**自取证**：`probes/probe-task-dock.ts`（源码切片求值：从 `inputbar/approval.js` 取浮窗区间 + 最小 DOM 桩；从 `localGateway.ts` 切 `normalizeGatewayTasks` 经 `Bun.Transpiler` 剥类型测形状边界）——39 断言全过。

**实测前提（勿漏）**：上报端在 CLI 进程内，故**产生清单的那个 CLI 会话本身必须跑含本链的新 exe**；换网关 exe 只更新 web 前端不足以显示。**旧 exe 会话的换新路径**：web 侧栏关闭该会话进程 → web 再发消息即由网关 `resumeAndDeliver` 拉起 `process.execPath`（=网关自身新 exe）。

## 16. 并发复合状态行：运行行与状态行并存

**并发是结构性的**：`query.ts` 在流式循环内 `streamingToolExecutor.addTool`——工具的 `tool_use` 块一旦 `content_block_stop` 即开始执行，而模型 HTTP 流仍在产出后续块 ⇒ **搜索在跑的同时引擎仍在产出**。状态行表述「**引擎仍在产出**」，与「**工具在飞**」正交，分档判据即不变量——
① **无工具在飞**（且无待答提问、回合未收口）→ 回合未收口即引擎必然在产出（**推断**）；
② **有工具在飞** → 引擎是否仍在产出**不可推断** → 取**证据**：turn-beat 新鲜度（`live.turnBeat`，4s 节流；`BEAT_FRESH_MS = 6000` = 节流窗 + 2s 抖动余量；beat 早于本回合起点视同缺席）。新鲜 ⇒ 真并发 ⇒ 状态行与「正在运行：<工具>」同 summary 并存（`stateAppend` 构造期拼接支持并存），形态=一行一句（见 §19）。
③ **显式实证先于推断档**：`lastStep==='compact'` / `compact-state` SSE 在 TTL 内 ⇒ 直接 `'compact'`，**不**受「工具在飞」取证约束。

**判定收敛**：`web-src/chat/messages.js` 提纯函数 `vacuumOf(s, processing, live, now)`（判定表唯一出口，替代渲染点内联拼装）；`flushTools()` 的 running 分支保留 `${sumInner}${stateAppend}` 语义。**自取证**：`probes/probe-concurrent-status.ts`（与打包器同源，调真实 `vacuumOf` + 真实 `liveFoldBody`），A1-A12 判定表 + B1-B5 端到端合成；`--prefix` 开关做旧式对照。

## 17. web↔CLI 四缺陷根治：spawn 在途登记 / WS 心跳 / 审批等待红标 / 只读提问卡移除

①②的网关侧根因与修法 → [gateway.md](gateway.md) §7。

**③ 等待审批不判「无响应」**（纯前端）：`awaitingApproval = takeover === 'approval'` → 红标判据串入 `!awaitingApproval`。**为何走展示层**：接管态本就是既有状态，读它 ⇒ 状态源不增反稳（根本原则 5）；网关侧刷 beat 等于造一个说假话的第二状态。`· 连接中断` 分支不动。长静默工具运行的豁免见 §18 ③。

**④ 只读提问卡整体移除**：该卡是 web 自绘的**非交互** AskUserQuestion 接管卡（`.question-card`）；可交互提问走 CLI 审批链 `renderQuestionApproval` 下发的 `.appr-card.qa-card`。移除面：①`chat/messages.js` 删 `questionCardHtml` 与相关复位（`seg.lastAsk` 机制**保留**）；②`inputbar/approval.js` 删 `pendingAskInput`/`setPendingAskInput`，接管类型收窄为 `'approval' | null`；③`chat/route.js` 与 `core/live.js` 两处 `showTakeover(questionCardHtml(…))` → `if (takeover !== 'approval') clearTakeover()`；④`web/styles.css` 删死样式 `.question-card`/`.q-*`。交互式审批卡零改动。

## 18. 状态显示行行首槽对齐 + 扫光统一 + 无响应豁免扩面 + 折叠开合恢复键

**① 行首槽对齐**：工具行 `.tool-line` = `.t-ico`（16px 固定槽 + DSH `IconThinkOutline14` 原子图标 `THINK_ICON`）+ 5px gap + 文字 ⇒ 文字左缘恒 21px；状态行 `.think-state` 构造同样补 `<span class="t-ico">` + `<span class="ts-text">`，`live.js` tick **只写 `.ts-text` 子节点**（整节点 `textContent` 会连图标槽洗掉）；`styles.css` 把 `.t-ico` 从 `.tool-line .t-ico` 提升为**通用类**，`.think-state` 加 `gap: 5px` 与工具行同基准。

**② 折叠开合恢复键 `foldKey`**：`live.js` 采集/回填 `open` 改**结构稳定键**（键 = 宿主段 `data-m|data-t` + 主类名 + 段内同类序号），采集用 `Map`、回填按键匹配，全局数组下标退役。**不变量：折叠体的开合态只跟随同一结构身份的折叠体**。

**③ 无响应红标豁免扩面**：红标语义 = 「**引擎无产出且无已知阻塞原因**」；已知阻塞原因两类=审批接管与工具在飞（`toolRunning = !!fold.querySelector('.tool-line.tool-running')`），判据串入 `!toolRunning`。`· 连接中断` 分支不涉 staleness。

**④ 扫光统一**：删 `.think-state` 蓝字渐变扫光链，`.think-state` 加入**统一扫光选择器组**（`.tool-line.tool-running::after` / `.tool-fold[data-state='running'] summary::after` / `.tool-cur summary::after` / `.think-state::after` 四宿主共用一条 `::after` 规则 + 同一条 `prefers-reduced-motion` 关闭规则），宿主持有 `position: relative; overflow: hidden`。**自取证**：`probes/probe-state-lead.ts` A-G 七组断言。

## 19. 并发复合状态行形态改判 + 行内挤压根治

**根治（一处结构 + 三条样式不变量）**：①`liveFoldBody` running 分支不再产出「两个 widget」，把状态**作原子尾缀并进运行行所在的唯一行容器**：`<span class="fold-state">${runLine}${stateSpan(true,false)}</span>`（`flushTools(isTail)` 新增段尾形参：仅段尾组并状态；并入即清 `stateAppend` 置 `stateMerged`）——文案成**一行一句**「正在运行：<工具> · <detail> **并思考**」；②新增唯一文案映射 `vacuumLabel(mode, join)`（`join=false` → 正在思考/正在生成/正在压缩会话中……；`join=true` → 并思考/并生成/并压缩中），写进 `data-label`，`core/live.js` tick 改读 `stEl.dataset.label`（删 tick 里重复的 mode→label 三元链）；③`styles.css`：`.think-state` 加 **`white-space: nowrap`**（文案恒单行，压缩压力只能落到本就带省略号的 `.tl-text`/`.think-stream`）、新增 `.think-state.ts-join { flex: none }`（尾缀原子）、扫光组改 **`.think-state:not(.ts-join)::after`**。**「只加 nowrap 不够、只改结构也不够」**：旧结构 + nowrap 会让 state 被挤到 1px 肉眼不可见 ⇒ 两者缺一不可。

**自取证**：`probes/probe-concurrent-status.ts` B 组改写 + C 组（跑真实 `liveFoldBody` + 断言 `styles.css`/`live.js` 布局不变量：`.think-state` 恒 nowrap、`.ts-join` 原子、`.tl-text` 是让位方、扫光组恰 2 处 `:not(.ts-join)`、tick 读 `data-label`）。

## 20. 单状态槽：红标在场即独占

**根治（状态源收敛为一）**：①`web-src/chat/messages.js` 新增唯一构造源 `statusFlags(connUp, staleSec)` + 阈值常量 `STALE_SEC = 150`（**删除 live.js/approval.js 各自内联的红标字符串与阈值**）——文案不带前导「·」；优先级写在一处：**连接中断（链路断）> 无响应（链路活而引擎无产出）**；`staleSec<=0` 表达「本帧判据不适用」（调用方按自身豁免规则传 0：审批等待/工具在飞）。②`core/live.js` tick 以**唯一判据**（`flags` 非空）给宿主状态行挂 `.is-flagged`——**状态槽一次只有一个占用者**；`approval.js` claimTick 同步改走 `statusFlags`。③`styles.css` 新增 `.fold-state.is-flagged > .think-state, .fold-state.is-flagged > .think-stream { display: none }` 与 `.fold-state.is-flagged .d-stale { margin-left: 0 }`。信号恢复（beat 回/WS 重连）→ 每秒重算自动摘标。

**自取证**：`probes/probe-concurrent-status.ts` D 组（`statusFlags` 真函数：无红标/唯一红标且无「·」/断连/双信号优先级/阈值 149↔150 边界/`.think-state` 是 `.fold-state` **直接子节点**=独占 CSS 的 `>` 前提）+ C8–C11（样式表独占规则、tick 挂标判据、无内联红标残留、阈值无第二处写死）。

## 21. 侧栏拖拽调宽：展开态自由拖、不记忆

**实现**：①`index.html` `#sidebar` 尾部 `#panel-resizer` 把手节点；②`styles.css`——把手贴右缘 8px 热区（`right:-4px` 骑缝），hover/拖拽显 3px 竖线，**显示门控 = `#sidebar.open` ∧ ≥721px**；拖拽中 `body.sb-resizing` 关掉六处宽度过渡 + `cursor: grabbing` + `user-select: none`；③`web-src/sidebar/recent.js`——pointerdown（左键 + 复核 `.open`）→ `setPointerCapture` → pointermove 以 `e.clientX` clamp 到 `[232, min(560, innerWidth−120)]` 写 **`:root` 内联 `--panel-w`**——`#sidebar/#panel` 宽、主区避让 `padding-left`、`#input-wrap.docked` half-padding 补偿全消费同一变量，零特判；pointerup/cancel 摘把。

**「不记忆」的做法**：内联 `--panel-w` 是唯一可变状态源，`setPanel(false)` 一行 `documentElement.style.removeProperty('--panel-w')`——状态随折叠清零，再展开命中样式表默认 280px，无第二份记忆态、无 localStorage。

## 22. 嵌入式图表：```chart 双段围栏（web 渲 html / CLI 显 ascii）

模型侧契约写**全局根 `@WrokSpace/CLAUDE.md` 快速要点**（` ```chart ` 围栏 + `%%html`/`%%ascii` 哨兵行分段、语义一致、禁裸 ASCII 字符画、风格可调用 lieflat-charts skill）。

**渲染分工**（两端只动显示层，协议/转录不动；**普通 ` ```html ` 围栏两端都不受影响**——只有围栏语言精确 `chart` 才触发）：
- **web**（`core/markdown.js` + `chat/messages.js` + `styles.css`）：`closeCode(closed)` 分支——`chart` 围栏**已闭合**时 `chartSplit` 拆哨兵段，取 `%%html` 段进 `<iframe class="chart-frame" sandbox="allow-scripts" srcdoc=...>`（opaque origin）；`%%ascii` 段弃用，`chart-raw` 留全文供「源码」按钮切换。**srcdoc 安全链**：mdHtml 入口整体 esc → 属性不破出；浏览器解析 srcdoc 属性实体解码一次 = 恰好还原模型原始 HTML（esc 链与属性解码互相抵消）。**高度自适应**：srcdoc 尾注 CHART_BOOT（ResizeObserver + load 上报 `__chartH` postMessage），`messages.js` 按 `e.source === iframe.contentWindow` 采纳设高，CSS `max-height: 60vh` 超出内部滚动。**流式安全**：围栏未闭合恒回退代码块，闭合那一帧才切 iframe。**缺段降级**：无 `%%html` 段 → 代码块。复制排除：`messageCopyText` 剔 `.chart-bar/.chart-raw`。
- **CLI**（`src/components/Markdown.tsx`）：`stripChartHtml` 纯文本预处理接在 `cachedLexer(stripPromptXMLTags(stripChartHtml(children)))`——chart 围栏内删 `%%html` 段与哨兵行、留 `%%ascii` 段给 marked 当普通代码块；`StreamingMarkdown` 走 `<Markdown>` 自动覆盖；未闭合围栏同样剔除 html 段。
- print.ts（-p 非交互路径）无 markdown 渲染器，不涉。

**验证**：`probes/probe-chart.ts`（双段/缺段/未闭合/` ```html ` 与 ` ```html+jinja ` 不误伤/实体往返透明/srcdoc 属性不破出/思考块同链路；CLI `stripChartHtml` 四态）+ `probes/probe-chart-embed-assets.ts` + exe 二进制 `rg -a '%%ascii'` 命中。

## 23. web 文件上传：+ 浮窗「上传文件」行 + 文件胶囊/文件卡片 UI

底栏 + 浮窗「上传」组在「选择图片」行下新增「上传文件…」行：任意类型、可多选，选完即上传（不经输入栏暂存）。链路与图片附件同构的胶囊/卡片，占位路径用**相对路径**。

**链路**：
- **输入态**：`#file-upload` change → `images.js` `addUploadFiles` 逐个 `POST /gateway/upload?name=<文件名>&sid=<当前会话>|&project=<newProject>`（原始字节直传；**落盘跟随会话**——存量会话带 sid、首页尚无会话带 `state.newProject`、纯首页无参落全局根）→ 成功 push `pendingFiles`（`{name, abs, size}`）→ **文件胶囊**（`.file-pill`：64×64 方卡与图片缩略图同轨、灰底 + 薄描边、dshFile 图标 + 文件名居中两行截断、× 收进卡内右上 4px hover 显形/触屏恒显）进附件行 `#img-pills`（与图片胶囊同行，`renderImgPills` 单渲染源）。
- **发送态**：`gwSend` 把待发文件拼 `[文件:<会话 cwd 相对路径>]` 占位进消息文本（与 `[Image #N]` 同位追加；CLI/模型端即普通文本）→ 发送成功清 `pendingFiles`；`syncGwSend` 的 hasContent 计入文件。**相对化**：占位路径由 `send.js` `relUploadPath(abs)` 按**目标会话 cwd** 相对化（`relPath` 纯函数：大小写不敏感逐段比对、`\ /` 通用、跨盘符/无 cwd 退绝对路径）；新会话 jsonl 未落盘无 cwd 源 → wsession 响应附 `cwd` + 网关 `readSession` 记录缺失分支从 id 编码路径派生 cwd。乐观气泡文本不含文件占位。
- **渲染态**（乐观与落盘同构）：`userBodyHtml` 剥 `[文件:...]` 占位 → `userFilesHtml`/`fileCardsHtml` 渲染**文件卡片**（`.msg-files` 在 `.body`/`.msg-imgs` 之后气泡外下方右对齐，卡片=dshFile 图标 + basename，title=完整路径，**点击复制路径**）；乐观气泡渲 `p.files` 卡片同构；排队区剥占位不渲染卡片。占位文本原样进 `pendingUserMsgs`/转录，剥占位只在渲染层。

**与图片附件的关系**：图片走 base64 内联（不落盘、随 send images 上行、4 张上限/自动压缩），文件走落盘链（留盘可复用、无数量上限）；共用 + 浮窗「上传」组与 `#img-pills` 附件行。

## 24. 会话间通信来源行：提及 chip 带 sid + 气泡/排队区灰字

会话 A 的 agent 向会话 B 发消息（`session_send`），B 侧重出**与 user 消息完全同构的气泡**，仅气泡**外**多一行灰色小字「来自 会话：X」。寻址/工具/网关 → [core.md](core.md) + [gateway.md](gateway.md) §13；本节只写 web 前端。

**提及入口（两个，均带 sid；`@` 提及为纯 UI 引用手势，不产生授权状态）**：

| 入口 | 文件 | 要点 |
|---|---|---|
| 输入栏 `@` 浮窗「会话」组 | `inputbar/mention.js` | `mentionItems` 会话项带 `sid: hashOf(s)`；`insertMention(kind,name,sid)` 写 `chip.dataset.sid`；`serializeInput` 输出 `[会话:标题\|sid]`；`mentionChipHtml` 按 `\|` 切分**只显示标题** |
| 「+」菜单「引用会话」 | `inputbar/commands.js` | 同款 `appendMentionChip(kind,name,sid)` + `findSession/hashOf` 取 sid |

**必须两个都补**：同一手势产出的令牌形态必须一致，sid 供精确寻址。

**渲染（web 不解析包装，只读投影字段）**：`chat/messages.js` `whoHtml(m)` 读 `m.fromSession`（`DisplayMessage` 可选字段，经 `session-delta` 帧原样到达），空则不输出；用户开启气泡（`data-t="u"`）与引导气泡（`data-t="g…"`）都在 `.body` 前插 `${whoHtml(m)}`。**前端绝不调 `parseSessionMessage`**——剥壳在 `conversationDisplay.ts` 投影层做过一次。

**排队区（`.q-item`）**：`inputbar/approval.js` 把 `q.from.title` 渲染成 `.q-who`。**关键坑**：排队区文本是**尚未过投影的原始包装**，拆包必须发生在上报侧——CLI `queueItemsFromSnapshot()` 做 `parseSessionMessage` → `{content: body, from}`，网关 `queue-state` 分支只做形状白名单透传（[gateway.md](gateway.md) §12）。来源进排队区重建签名（`[q.from?.title, q.content]`），换来源必重建。

**无乐观气泡**：跨会话消息非本地打字触发，不产生乐观气泡，不存在同构跳变问题。

**来源行对齐**：来源灰字行**随其气泡一侧对齐**（用户气泡右对齐 → 来源行右对齐）。两端同时改：web `styles.css` `.msg.user .who` `align-self: flex-start` → **`flex-end`**（`.msg .who` 基础规则与 `.msg.user` 的 `align-items:flex-end` 不动 ⇒ 气泡宽度零变化）；CLI `UserPromptMessage.tsx` 外层 column Box **保持默认 stretch**，只给来源行套 `<Box flexDirection="row" justifyContent="flex-end">`。

**气泡高度兼容**：`stageSync()` 几何量全为**实时 DOM 读取**、无缓存高度，故灰字行加进 `.msg.user` 内 `.body` 之前时 `t0` 上移一行 = 占位高度减少一行，天然对冲，`maxScroll ≡ 贴顶位` 不破。三条硬约束：①灰字行在 `.msg.user` **容器内**且 `.body` 之前；②**不得脱离文档流**（禁 `position:absolute`，`topInScroll` 用 `offsetTop`）；③两种气泡形态**必须同时**加。`probes/probe-stage-pin.ts` 与 `probes/probe-session-link.ts` H 组守这两条。

## 25. 用户气泡两态同构：乐观/落盘 body 同走 mdHtml

**规则**：两态 body 必须走**同一渲染函数**（「乐观开启气泡与落盘气泡同构」不变量）。乐观（`renderTransient`）改 `mdHtml(bodyText)` 与落盘（`chat/messages.js` `userBodyHtml`）同源；`renderUserText` 保留——排队区 `.q-text` 仍用它（排队项自带 `<p>` 包裹、且气泡壳在 `.q-text` 上，形态本就不同）。**验证**：`probes/probe-user-bubble-parity.ts`（两路径结构差异取证 + 样式 `<p>` margin 证据 + 结构断言两处 body 同源 + 同文本同 HTML）。

## 26. 「神经」tab：神经元选择卡片 + 三级节点图

侧栏第 4 个管理 tab（`data-mgr="neurons"`），与插件/项目/模型并列。前端模块 `web-src/views/cards/neurons-card.js`（`neuronsCardDef`，卡内整卡重渲走 `ctx.rerender()`），`state.mgrView.neuronSel` 区分层级并持久化。

**层级1 选择卡片页**：`renderNeuPicker` → `#neu-grid` 卡片（脑图标 + mem/cog/社群/更新四枚 `neu-stats` chips），数据源 `GET /gateway/neurons`（[gateway.md](gateway.md) §14）；`loadNeuronsData` 带 NEU/NEU_LOADING/NEU_ERR 三态与重试钮。

**层级2 三级节点图**：卡片点击 → `renderNeuGraphView`（`neu-head`：返回钮 + 标题 + meta chips + 图例，`#neu-graph` 全高画布区，`.mgr-pane.neu-pane` 走 `#messages:has(.neu-graph)` 满高规则）。图包按 `neuron.id` 缓存（`NEU_GRAPH`），切库/重进 force 重拉。

- **认知层可缺省（照实呈现）**：`cog_graph.json`/`community.json` 是认知管线产物，新库尚无——网关照常出记忆层图（`cognition.graph/communities` 两标志 false），前端挂 `.neu-note` 提示条（贴顶/不吃指针/z-index 3）说明缺哪一层并附记忆条数；缺认知层不画成错误态。
- **节点与尺寸**：mem 点 `neuMemR` 2.5–5（∝内容 chars）；cog `neuCogR` 7–24（∝挂载 mem/rel 数 + 内容）；社群 `neuCommR` 11–34（∝cog 数 + 内容）。社群色 = `MGR_PALETTE` 按 i 循环；未入群 cog 灰 `#8a94a6`。
- **布局**：确定性同心初始位（社群 r=170 环、cog 贴 host 社群外圈、未入群 cog r=300 环、mem 贴首 host cog；孤儿 mem 落中心环），无随机 → 探针可复现；手写 d3-force 同型仿真（`neuTick`：O(n²) 斥力按类型 charge **12/72/360** + 弹簧目标距=两端半径和 + pad（**力 ∝ alpha 无地板**）+ **向心引力 `NEU_G = 0.01` 统一外场**（指向画布中心、**与类型/尺寸完全无关**——径向分层语义全交斥力：**comm 外圈 / cog 中带 / mem 内带**）+ 碰撞推挤；**渐缓收尾**：速度上限 `14·min(1, alpha/0.3)` + 停机阈值 0.003；衰减 0.985 reheat，ResizeObserver 轻重排，画布离场 `isConnected` 停帧）。
- **连边（事实闭合）**：cog→社群（kind:comm）+ cog→mem/rel 全量，同一 mem 挂多 cog 每 cog 各一条。
- **交互**：滚轮缩放 0.25–3×、空白拖拽平移、节点拖拽（fixed + reheat）、悬停浮窗、点击钉住（<5px 位移判定，钉住态浮窗跟随节点屏幕坐标，空白点击解除）。
- **浮窗 `.neu-pop`**（300px 白卡，`pointer-events:none` 但成员列表可滚）：comm 卡（**有社群名显示名**（cog2.json 命名，含描述行）否则「群 N·认知 X」+ chips + 成员列表）、cog 卡（群 N/游离 + query + 关键词≤6 + 统计）、mem 卡（时间 + 预览 + 内容/来源）；群节点 canvas 标签同理；esc 全量转义。

**验证**：`probes/probe-neuron-viz.ts`（收敛循环跑满至 alpha=0.003；后端真实库直读；前端源码切片注入：连边数恒等、多 cog 挂载事实闭合、确定性布局逐位一致、无 NaN、cog 聚在 host 社群、**向心与尺寸无关**、**弹簧力 ∝ alpha 无地板**、**速度上限随 alpha 收缩**、浮窗 XSS 转义）。

## 27. 项目预览页软重入：openProjectPreview 两级重入

- **不变量**：进预览必须先 `clearSessionSlots()`（见 §34）——堵「实时流按残留 `live.curUuid` 命中守卫把预览洗成 chat」。
- **两级重入**：同 label 且 iframe 在场（`data-label` 锚定）= **软重入**：不重写 shell、不清槽，mount 按 iframe 现有 src 校正（同 src 零操作 = 零导航扰动；异 src 只换 src），分支统一 return；异 label 或 iframe 不在场 = 硬挂载（原全流程）。理由：`hideGate` 恢复链每次 WS 重连都跑，若整区重写 shell + iframe 重载，iOS 上 iframe 二次导航会污染主历史诱发自发后退落到 `/session/<hash>`。
- **取证注意**：bytecode exe 内嵌资产不可 grep，验证资产版本直接 `curl http://127.0.0.1:8124/sw.js` 与 `/app.js`。
- **前端资产版本自愈**：换 exe 后旧标签页只重连不重载 JS。修 = `live.js` 在 hello（每次 SSE 建连/重连都发）时 fetch `/sw.js` 提取 CACHE 版本与页面基线比对，漂移即 toast + 自动 reload（输入栏有内容只提示）。**守护不变量 = 运行中的前端代码 = 网关当前资产版本**。
- **HTML 导航网络优先**：SW fetch 离线兜底会把缓存里的旧 index.html → 旧 app.js 静默回喂。修 = `sw.js` 对 `e.request.mode === 'navigate'`（覆盖全部 SPA 路由导航）**只 fetch 网络不回退缓存**，静态资产兜底保留。**守护不变量 = 导航拿到的 HTML 永远来自网关当前服务字节**。

## 28. 侧栏会话 tab 排序：有状态置顶 + 创建时间新→旧

- **排序**：侧栏会话 tab（平铺「最近」与项目文件夹内两处）走 `sessCmp`（`core/sessions.js` 单一排序器）：有状态（state 点在场 = CLI 在线 busy/waiting/idle）置顶，组内按 **createdAt 降序**。`createdAt` = 网关 `/gateway/sessions` 透传字段（`parseMetaCached` 接 `birthtimeMs`，个别 FS 回 0 落回 mtime，随 (size,mtime) 缓存）。气泡弹层/搜索覆盖层沿用 `sorted()`；项目胶囊与文件夹排序维持最近活跃不动。
- **`withSynthetic` 统一保全**（`core/sessions.js`）：权威列表写 `ALL` 的两出口（`loadSessions`/`refreshList`）统一过此函数——`synthetic:true` 条目且权威列表未含者保留，真实条目出现后自然取代；创建失败链 `ws-failed` 显式移除收口。**守护不变量 = 用户刚建的会话 tab 不因权威刷新窗口消失**。

## 29. 底栏纯文本粘贴：contentEditable 粘贴一律落 text/plain

- **规则**：底栏 `#input` 是 contentEditable div，浏览器粘贴默认吃 `text/html`。**paste 监听**（`inputbar/ctx-meter.js`）：图片粘贴分支不变（`clipboardData.files` 优先入列 `addImageFiles`，补 `return` 防图 + 文双插）；其余粘贴一律 `preventDefault` 取 `text/plain` 经 `document.execCommand('insertText')` 于光标处插入——保留 undo 栈、不破坏 mention chip DOM、多行 `\n` 正常换行；无 `text/plain`（如非图片文件）回落默认。copy 方向已有「纯文本复制」（全局拦截 copy 只写 text/plain，同文件）。

## 30. 增量段替换状态保持：折叠开合 + 用户气泡不重建

- **规则**：`applySegDelta`（`core/live.js`）按段粒度替换时（段=user 气泡 + done-fold + 回复 + 变更卡全量 html），段内两类 HTML 再生不出来的状态必须显式保留：① 替换前按全量路径同款 `foldKey` 键语义（`@m|t|cls` / `host|cls#idx`）捕获段内全部 `details` 开合态，插入后按同键恢复（键不在旧集的新增折叠保留 HTML 默认）；② DOM 已有同 key 用户气泡时保留旧节点、丢弃新段气泡节点只替换其余部分，插入点改**流末锚点前**。**不变量：任何增量替换路径都必须贯彻与全量重建相同的状态保持语义**。
- **连带**：接管帧（首帧无旧气泡）照旧整段插入；压缩/回退（消息数减）照旧整页重建；`msg-in` 入场动画不涉增量路径。

## 31. web 卡顿与内存泄露三刀根治：增量帧惰性渲染 + img 换血 + tick 空写守卫

- **惰性渲染**：`renderSessionBody` 每帧无条件全量 `messagesHtml(messages)` 序列化整个会话，而 session-delta 增量路径只消费末段——历史段渲染全部白付（长会话 MB 级拼接 + `mdHtml` 全文重解析 = 主线程打满）。**修** = `messagesHtml(messages, lazy)` 两段式：切段循环照跑但历史段不生成 HTML；`closeSeg` 非末段走 skip 分支，只按渲染同序静态推进 `lastNode`（u→f→a→c）供末段 prev 锚点链；仅 isFinal 末段真渲染并在入口补齐置空行（ask 按 answer 终态、tool 恒完成行基线、运行态仍由 `flushTools` 分派）。`core/live.js` 先 lazy 切段拿 `lastSegInfo` → `canDelta` 判定 → 增量 `applySegDelta`；不可增量再跑全量。
- **img 换血**：整页重建分支 `innerHTML` 前按 `src` 采池（Map，池 shift 支持同 src 多图），重建后同 `src` 换回旧 `<img>` 节点——image-cache `private,no-cache` 每张必回源的网络风暴 + 全图重新解码双灭。
- **tick 空写守卫**：`bindLiveFoldTimer` 每秒写 flags 改「值不变不重写」，防空串重写打断子动画并触发无谓样式重算。
- **泄露定性**：interval 防叠（`liveFoldTimer`/`claimTick`/`__backendHeartbeat`）、SSE 防重建、WS close 旧连、`renderTransient` sig 幂等、`pendingUserMsgs` 吸收链全数核实在位——无经典引用泄露；「泄露感」主源 = 重建风暴的分配峰值 + GC 压力。

## 32. 无响应红标降为最底层优先级：任意状态在场即不判

- **规则**（`core/live.js` `bindLiveFoldTimer` tick 单处）：`stEl` 查询提前，新增豁免判据 `hasStatus = .think-state 的 data-label 非空`（`vacuumOf` 单源渲染的任意状态：正在思考/正在生成/正在压缩/正在运行）——`statusFlags(connUp, awaitingApproval || toolRunning || hasStatus ? 0 : staleSec)`。**无响应降为最底层优先级，仅当无任何状态时才允许红标**；「连接中断」优先级不变。
- **代价（知情定案）**：引擎真停摆但状态行仍有文字（典型=无工具期「正在思考」）时不再亮无响应红标——以压误报为优先；停摆自愈链（90s SSE 半开探测全量对账、turn-state 打断收口）不受影响。

## 33. 增量路径 img 换血：段内引导气泡图片不再重建

- **规则**（`core/live.js` `applySegDelta`）：照搬 §31 整页重建的 img 换血语义——删旧节点**前**从「本次将被删除」的节点按其 `img[src]` 采池（同一 src 多图用数组 shift），插入新段后同 src 的新 `<img>` 一律 `replaceWith` 换回旧节点（旧节点持已解码位图，零回源零重解码）。**保留的 `[data-t="u"]` 旧气泡不采池**：引导气泡与其可能同 src，采走会让保留气泡丢图。**不变量：已落盘图片字节不可变（image-cache 单调 id）→ img 节点不跨帧重建**。

## 34. 切视图即清全局槽收敛为共享出口：管理视图（神经 tab）不再被实时流洗成 chat

- **不变量**：`live.curUuid` 非空 ⇔ 当前视图正展示该会话（七条 SSE 守卫——session-delta / queue-state / task-state / compact-state / turn-state / stream-text / model——全押在它上面）。
- **修法 = 单源出口**（`chat/route.js` `clearSessionSlots()`）：清槽清单（`lastMsgLen`/`localMessages`/`deltaSeq`/`queueRemote`/`curUuid`/`tasks`+`renderTaskDock`/`streamText` + `clearTakeover` + `renderCtxMeter(null)`）收敛为一个函数，三个「离开会话视图」入口统一调用——`renderHome`（首页空态）、`renderMgr` 顶部（一次覆盖四分支，含神经 tab）、`openProjectPreview` 硬挂载分支（`views/cards/preview-card.js`）。会话态的重新接线仍在 `renderSession`/`refreshSession`（唯一重建点），本函数不涉。
- **守护不变量**：任何进入非会话视图的入口必须先 `clearSessionSlots()`；清槽清单只有一份（新增入口调它，勿就地补行）。**探针**：`probes/probe-web-view-slots.ts`（只读，27/0）——源码结构断言（三入口接线 / 清槽早于 `mgr-on` / 各模块内联清槽行数受控 / 产物 `app.js` 含定义与 ≥3 调用点 / sw 与 `?v=` 同步）+ 行为真值表（守卫表达式从 `core/live.js` 提取后喂 `(curUuid, ev.session)` 四组合）。

## 35. 键盘弹出适配：整页平移一个键盘高，内部零重排

**原理**：`html` 高 = `100dvh`，键盘**不改变布局视口**（只压可视视口）。浏览器为露出焦点底栏让整个画面向上位移 `pan`——同一份位移落在**两条互斥通道之一，随平台变**：iOS 上顶**可视视口**（`visualViewport.offsetTop > 0`，页面不滚 ⇒ `window.scrollY = 0`）；iPad 滚**布局视口**（`window.scrollY > 0`，而 `offsetTop` 恒 0 不报）。故取 `pan = max(offsetTop, scrollY)`；**不可取和**——同源平台上两值相等（iOS 的 `offsetTop` 即滚动量），相加会把一份位移算两遍（over-lift = 键盘过冲）。

**整页平移（定案）**：应用是一块刚性板——键盘在场时 `#app` 整体 `translateY(−--kb)`，侧栏/背景/底栏连成一体走、**内部零重排**（只有消息流窗口收窄）；浏览器那份 `pan` 由它自己叠加，两者之和恒等于屏幕上**完整键盘高** `total = L − vv.height`，**与浏览器怎么分配这份位移无关** ⇒ `pan` 的瞬时抖动（含「上顶→回落」）被恒等式吸收，画面不动。**不抵消 pan**：用主线程写样式去抵消合成器线程的位移天生晚一帧，一帧错位就是可见的往复——位移由恒等式吸收，**源码内不得再有 `scrollTo(0,0)` 之类的迎战代码**（探针钉住）。

**唯一真源 = `visualViewport`（前端 `core/viewport.js`）**：
- **`kbGeometry(L, vvH, vvTop, scrollY, scale, editing) → { kb, total }`**：`kb = max(0, L − pan − vv.height)`（我们补的那份；`pan = max(0, vvTop, scrollY)`），`total = kb + pan`。`--kb` 是 `#app` 的位移，**`--kb-total` = app 顶部被推出屏外的条带高 = app 内可视窗顶偏移**（消息流窗口与覆盖层的统一收口口径）；`pan` 谁分摊多少都不改这两个量的语义。
- **消费点**：`#chat-scroll { margin-top: var(--kb-total) }`（窗口 = `[kb-total, L]`：顶=屏顶、底=键盘上沿，滚动视窗 = 可视视窗，`stageSync` 读 `clientHeight` 的贴顶/占位几何口径不变）；`#input-wrap.docked { top: calc(100% - 22px) }`（平移已把 app 底边送到键盘上沿，底栏不再自补位移）；空态底栏随 `.g-stage` 台面比例（76.75%）一并被顶起；三个覆盖层 `top: var(--kb-total); bottom: 0`（遮罩恒 = 可视窗）。`body.kb-open` 既是 `#app` 位移规则的开关（无键盘时 `#app` 无 `transform` ⇒ 不改 `#img-lightbox`/`#drop-overlay`/`.toast` 等 fixed 后代的包含块基准），也是「键盘在场底栏不做缓动」的条件（`body.kb-open #input-wrap { transition: none }`）。
- **判定**：`editing = document.activeElement` 是 `contenteditable`/`INPUT`/`TEXTAREA`/**`IFRAME`** 且 `vv.scale ≤ 1.01`（捏合缩放同样压低 `vv.height`，必须排除）；安卓布局视口随键盘同步缩 → 自然不重复补。**`IFRAME` 分支不可省**：项目预览的站点页面跑在 `.preview-frame` 里，焦点进入 iframe 文档时父文档 `activeElement` 就是该 `<iframe>` 元素本身（浏览器标准行为）——不认它则预览内打字恒非编辑态，`kbGeometry` 直接返回 `{kb:0, total:0}`，键盘每次上顶可视视口都无人让位 = 每敲一个字整页上下跳。放宽判定不引入空位移：位移量全由可视视口实测量算，无键盘时 `kb` 天然为 0。事件：`vv.resize`/`vv.scroll`/`window.scroll`（布局滚动通道那条，iPad）/`orientationchange`。
- **相位**：`--kb`/`--kb-total`/`body.kb-open` 的写入收敛进**应用段 `applyGeometry`**（只写样式属性、不读元素布局）——**同步段 `syncKeyboard`** 在事件回调里直调它（与视觉变化同帧），**延迟段 `settle`** 在 rAF 里再调一次（事件后一帧 `offsetTop`/`scrollY` 可能才落定，此帧以终值收敛；`applyGeometry` 幂等）。`settle` 另做 `--bar-room` 实测 + `stageSync()`（连续量晚一帧不可见，且逐事件 `getBoundingClientRect` 会强制布局）；完整键盘高经模块内 `lastTotal` 交接（不回读 CSS 变量）。
- **覆盖层同源锚定**：`#search-overlay` / `#risk-modal` / `#rename-modal` 在 `#app` 内，`position: absolute; top: var(--kb-total, 0px); right:0; bottom:0; left:0`：定位源与 app 壳体同一，遮罩恒等于可视窗、对话框在可视窗内居中，不再各自复刻视口公式；对话框高度上限用容器百分比（`74vh → 74%`、`calc(100vh - 48px) → calc(100% - 48px)`），**不得改回 `position:fixed`**（挂 body 会与 app 的视口锚定脱钩，随键盘下移）。
- **底栏子件同源收口**：底栏上**向上弹出**的子件共六个（七处上限声明）——`#mention-pop`、`#cmd-pop`、`#task-dock .td-panel`、`#proj-pop`、`#model-pop`、`#ctx-panel`——高度上限一律 `max-height: min(<设计上限>, var(--bar-room, <设计上限>))`。`--bar-room` 由纯几何函数 `popRoom(barTop, lift, margin)` 在 `settle` 内量得：`barTop` = 底栏上沿在 **app 内**的布局 y（`wrap.getBoundingClientRect().top − #app.getBoundingClientRect().top`——app 自身的位移在差里自动抵消，量到的与「位移落在上顶还是文档滚动」这个口径无关），`lift` = `--kb-total`，`margin` = 20。**取底栏上沿量是刻意的**：栏内 chip 系锚点更低、真实可用更多 ⇒ 本值对它们是**安全上界**，一个变量覆盖全部七处。**不变量：`--bar-room` 恒对应底栏「到位后」的位置**——触发侧除 `vv` 事件外另两处：`ResizeObserver` 观察 `#input-wrap`（**尺寸类**变化：多行长高/接管卡换高）＋ `transitionend`（`e.target === wrap`，**位移类**变化：键盘收起 `--kb` 归零、空态↔会话态迁移都让 `top`/`transform` 走 0.55s 过渡，而 `settle` 在事件后一帧读 `rect` 只能拿到动画中间值 ⇒ 量出的余量被钉在「收起前」的小值且再无事件重量，弹层上限随之永久卡小、内容被 `overflow` 截断；过渡结束即底栏到位，此刻重量才拿到终值）。超上限时滚动下沉到弹层自身（`overflow-y: auto` 或内部 flex 子项 `min-height:0`）。
- **边界**：无 `visualViewport` 时 `initViewport` 直接返回，行为与改前一致；模块挂进拼接表（`scripts/bundle-web-modules.ts`，区间号仅作执行序，排在启动序列之前）。**探针**：`probes/probe-keyboard-viewport.ts`（只读，87/0）——结构断言（拼接表接线/启动序列调用/`applyGeometry` 为唯一应用出口且同步段不读元素布局/只量算段走 rAF/`pan = max(offsetTop, scrollY)` 两通道取大/`window.scroll` 监听已挂/**整页平移恒等式 `total = kb + pan` 与 `--kb-total` 写入**/源码无 `scrollTo`、无 `setProperty('--vv-pan')`/`#app` 位移只在 `body.kb-open` 下且本体无 `transform`/消息流窗口收 `margin-top: var(--kb-total)` 且不再收 `--kb`/docked 底栏与空态底栏均不自补位移且 `--kb-lift` 零残留/三件覆盖层在 `#app` 内、遮罩 = 可视窗、无 `position:fixed` 残留/对话框不用 `vh`/六个子件的七处上限声明均收 `--bar-room`/`--bar-room` 的尺寸类与位移类触发齐备/`#empty-hint` 自身不含 `--kb`/产物 `app.js` 含 `IFRAME` 判定）+ 行为真值表（`kbGeometry` 喂 16 组——含 iPad 布局滚动通道与两通道等值取大的行，逐行断言 `kb` 与 `total` 两列；`popRoom` 喂 5 组；`isEditing` 经 `new Function('document', …)` 注入打桩喂 6 组：`IFRAME`/`INPUT`/`TEXTAREA`/`contenteditable`→true，`BUTTON`/`null`→false）。

## 36. 无当前会话态统一为空串：乐观气泡不再「先闪现后消失」

- **不变量**：`state.currentHash` 的无会话态恒为 `''`（与 `firstSendHash`、乐观项 `pendingUserMsgs.hash` 同一约定），**不得再引入 `null``**——乐观项归属守卫、事务收口、主张计时起点 `claimStartTs`、撤回链 `inCur` 命中都押在这一个表示上。`falsy` 用法（`!state.currentHash`）不受影响。
- **五处赋值点**：`core/state.js` 初值、`chat/route.js` 的 `route()`（非 session 路由分支）与 `renderHome`、`sidebar/mgr.js` 的 `renderMgr` 与 `views/cards/preview-card.js` 的 `openProjectPreview`（硬挂载分支）。判定侧一行未动即全部有效。
- **探针**：`probes/probe-optimistic-hash.ts`（只读）——源码层断言五处赋值点均为 `''` 且全 `web-src` 无 `currentHash = null` 残留、`addUser` 写入即 `state.currentHash`、生成物 `app.js` 同步。

## 37. 用户图片渲染 id 双来源：模型识图能力不影响图片显示

- **不变量**：**模型是否识图只决定图片发不发 API，不决定界面渲不渲染图片**。图片始终显示，`（当前模型不支持识图，已忽略图片）`提示（`processUserInput.ts` 在非识图模型下追加进消息文本）作为普通文本一并保留。
- **id 双来源**（`chat/messages.js` `userImgsHtml`）：①`blocks[].imageId`——识图模型，CLI 将 image 块附进消息 content，display 链（`conversationDisplay.ts`）按 `msg.imagePasteIds` 对位产出；②文本里的 `[Image #N]` 占位——非识图模型下 CLI 丢弃 image 块（`processUserInput.ts` 的 `skipInputImages` 分支），display 链无 imageId，此时回落占位符取 id。两条路拼的 URL 相同：`/gateway/image-cache/<会话uuid>/<id>`。
- **落盘与鉴图解耦**：`storeImages`（`utils/imageStore.ts`）在 `supportsVision` 判定之前无条件执行，故非识图模型下图片同样落在 image-cache、按 `pastedContents` id 命名——这是双来源能共用同一 URL 的前提。
- **占位符剥除条件**（`userBodyHtml`）：有 imageId 块时按 id 精确剥（原行为）；无 image 块时全剥 `[Image #N]`——否则占位会以裸文本与渲染出的图重影。

## 38. 侧栏折叠 = 宽度归 0 的拉伸（宽度即唯一状态源）

- **不变量**：**折叠/展开只有一份状态源**——`#sidebar` 的宽度。`#sidebar` 是 `#app` 的真实 flex 子元素（桌面 ≥721px 亦然），`#sidebar.open` 把宽度 0→280，`#chat-area`（`flex:1`）随之被挤窄/放宽。**主区不做任何避让**：`padding-left` 补偿一族已整体删除——「宽度 + padding 两份」收敛成一份。
- **折叠态无自带外观**（2026-09-25 定案）：原 64px 折叠图标带 `#rail`（logo / 展开 / 新建 / 搜索 / 最近会话气泡 / 头像）连同其桌面覆盖层与交叉淡出过渡一并撤除，折叠 = 宽度 0、主区满宽。**唤出入口只有两个**：
  - `#menu-btn` 汉堡（内容卡左上角 `top/left:10px`，全视口共用一枚，即手机端原有抽屉把手）：点击 = `setPanel(true,{pin:true})` 打开并**钉住**；`#sidebar.open ~ #chat-area #menu-btn` 展开态隐藏，收回入口在面板头部（`.floria-logo` / `#panel-collapse`，均 `setPanel(false)`）。
  - **左缘唤出**（`web-src/app.js` 的 `document` 级监听，无对应元素）：判据 = 「指针到达窗口左缘」的两种观测合一——①`mousemove` 取样到 `clientX ≤ 8`；②`mouseout` 且 `relatedTarget === null && clientX ≤ 0`（指针**直接从左缘离开窗口**）。守卫 `edgeArmed()`：`!state.panelOpen && !isMobile() && !body.token-gate`。**为何不用细条元素**：快速左移常在同一个取样间隔内直接冲出窗口，8px 细条的 `mouseenter` 会被整段跳过（用户实测「向左后再向右一点点才唤出」）。唤出为**不钉住**的预览式，移出侧栏即自动收（`sidebar/recent.js` 的 `#sidebar` `mouseleave` → 未钉住则 `setPanel(false)`）。
- **钉住单一状态源 = `recent.js` 模块内 `panelPinned`**：`setPanel(open, opt)` 里 `panelPinned = !!open && !!opt.pin`（收起一律清），`mouseleave` 只读它裁决收不收。全项目仅 `#menu-btn` 的 click 传 `{pin:true}`。
- **趴栏/门图锚在内容卡内**：`#empty-hint` 与 `#gate-screen` 都是 `#chat-area` 内的 `position:absolute; inset:0` + flex 居中，故侧栏拉伸时随卡片重居中；**`.g-stage` 宽度基准 = 包含块**（`min(88%, 620px, calc(100vh - 160px))`，手机档去 620 上限）——**不得用 `vw`**：work 两栏 / 侧栏展开 / 窄窗口下卡比 `88vw` 窄时，stage 会溢出卡外被 `.view-card` 的 `overflow:hidden` 裁掉，而空态底栏（`#input-wrap`）宽度 = stage + 40px 且随之居中 ⇒ 底栏连同「发送消息」占位、右侧模型 chip 一并被裁。空态 ↔ 会话态的输入栏迁移仍走 FLIP（`chat/route.js` `flipInput`）。
- **token 门**：`body.token-gate #sidebar { width: 0; overflow: hidden }`——侧栏在 flex 流内，`transform` 位移**不释放宽度**，必须收宽才不挤主区；门解除后随 `#sidebar` 的 width 过渡 0→280 拉伸，与门图淡出、趴栏淡入同一时序。
- **panel 无独立定位规则**：`#panel` 宽 0 ↔ `var(--panel-w)` 随 `#sidebar.open` 同步过渡，内容靠定宽 `.panel-inner` 逐帧揭示；手机（≤720px）改覆盖式抽屉（`transform: translateX(-100%)`，不受影响）。
- **手机抽屉宽度 = `min(300px, 84vw)`，且选择器必须写成 `#sidebar, #sidebar.open`**：桌面那条 `#sidebar.open { width: var(--panel-w) }` 特指度 (1,1,0) 高于手机档的 `#sidebar` (1,0,0)，展开态会被按 `--panel-w`（≤1023px 档 240px）窄化——宽度声明整条形同废弃（2026-09-25 手机实测：抽屉 240px、头部「已连接」断行）。**不变量：手机档抽屉宽度只由该 media 内一条声明给值。**
- **折叠态内容避让**：窄桌面 / 平板竖屏（721–899px，#messages 760px 居中后左侧留白不足）给非全出血卡的滚动层留 `padding-top:60px`（全出血卡本就 `padding:0`，汉堡浮在其上）。
- **无分隔线**：`#panel` 不画 `border-right`（侧栏是通高平面、无自身形状；分隔交由底板色从卡缝露出承担，见 §41）。拖拽调宽详见 §21（`:root` 内联 `--panel-w` 同时被 `#sidebar` 与 `.panel-inner` 消费；`#panel-resizer` 由 `#sidebar.open` 门控）。

## 39. 预览页注册快捷按钮（iframe ↔ 宿主 postMessage）

- **契约（预览页 → 宿主）**：`parent.postMessage({ type:'floria-rail-register', items:[{ id, icon, title }] }, '*')`。`icon` 必须是 `core/icons.js` `I` 图标表的键（**预览页不自送 SVG**）；`title` = 悬浮提示；`id` 由预览页自定义。
- **回跳（宿主 → 预览页）**：点击注册来的按钮 → `frame.contentWindow.postMessage({ type:'floria-rail-action', id }, '*')`，`id` 原样回传。
- **现状（2026-09-25）**：**注册链与按钮样式保留、挂载点暂缺**——原 `#rail-mid > #rail-ext`（`display:contents`，与内置四图标同列同 gap）随折叠带撤除，`renderRailExt()` 取不到盒即空转，落地位置待定。`.rail-ico` 样式（28px / radius 8 / hover `--hover`）与 `I` 键约定原样保留，接回只需给一个挂载点。
- **不变量**：**注册集属于「当前加载的那份预览文档」**。①采纳侧：`e.source` 必须等于当前 `.preview-frame` 的 `contentWindow`（别处窗口/图表 iframe 伪报不进来）；②失效侧：iframe 换 src、硬挂载重建、离开预览路由，三处都走 `clearRailExt()`（`chat/route.js` 的 `route()` 非 preview 分支 + `sidebar/mgr.js` 的 `mount()` 两条分支）。
- **边界校验**（外部输入）：`id` 必须为非空字符串、`icon` 必须是 `I` 的自有键（`Object.prototype.hasOwnProperty`，`constructor` 之类原型键不收），不合格项丢弃。
- **实现**：`sidebar/rail-ext.js`（模块内顶层 `bindRailExtBridge()` 自注册监听，与 §22 图表高度上报同走 `window` message）。

## 40. 未定/已推迟：项目控制台与项目态侧栏

主区「项目控制台」（项目级会话/卡片/神经元/skill/settings/CLAUDE.md 聚合）**仍未实现**，勿当成现状。**项目态侧栏已落地但换了形态**——不再是原方案的 `Floria · PjN` scoped 最近列表，而是 §43 的 work 模式（项目切换 + 文件树 + 主区两栏）。预览注册按钮**展开后的形态**仍推迟。方案全文与参考图见 `20260923192542-prism参考图/SPEC.md`。

## 41. 内容卡化：无形槽 + 每视图一张 `.view-card`（缝里露底板当分隔）

- **底板 = `--plane`（`#ececf1`）**：`body` 与 `#app` 同色 ⇒ 整窗读作**一块底板**，`#app` 的 22px 外框圆弧融进底板不再显形（Prism 的读法：只有内容卡有形状）。`index.html` 的 `theme-color` 同步取该值。
- **侧栏 = 底板本身**：`#sidebar` / `#panel` 背景一律透明，图标与面板内容直接落在底板上（原 `#sidebar` 白底是「一条白柱子」读法的来源）。**例外**：手机（≤720px）抽屉是盖在卡**之上**的浮层，透明会透出 `#scrim`（z25）而发黑 ⇒ 该 media 内显式给 `background: var(--plane)`。
- **槽 = `#chat-area`（无形状）**：通高、无圆角/无背景/无边距，只作定位与「卡」的 flex 容器；`#gate-screen`（token 门全屏浮层）与 `#menu-btn`（侧栏唤出汉堡）留槽级，与「当前哪张卡」无关。
- **卡 = `.view-card`**：`border-radius: var(--radius)` + `margin: 2px`（缝宽用户实测 1~2px 定案）+ `background: var(--chat-bg)` + `position: relative`，四周缝隙露出底板——**与侧栏之间那条缝就是分隔**（替代已删的 `#panel` 右缘 `border-right`，见 §38）。卡不画线、不加阴影，分隔只靠底色差（`--plane` ↔ `--chat-bg`）。**`overflow: hidden` = 卡矩形（含圆角）是内容的硬边界**——卡的形状由自身背景圆角给出，任何**不透明填充物**（预览卡/外部卡的白底 iframe、神经元画布）都必须被它裁掉；否则方角盖住四角、卡与槽缘之间的底板缝断在角上，与「内容透明」的会话卡读法不一致。**不变量：槽里同一时刻恰好一张卡**——`margin: 2px` 从槽移到卡上 ⇒ 卡矩形 ≡ 卡化前 `#chat-area` 的矩形，`#empty-hint`/`#input-wrap.docked`/`#char` 这些绝对定位后代几何逐像素不变；`position: relative` 是它们百分比基准的包含块，不可省。
- **一模块一卡组件（`views/cards/`）**：每个第一方卡自持一份描述符 `{id,title,tip,icon,tab,mount}`（`plugins/projects/models/neurons/preview-card.js` + 外部壳 `ext-card.js`），`mount(host, ctx)` 只把内容写进交给它的卡体（`host` = `.view-body`；`ctx = { id, payload, rerender }`）。卡内触发的整卡重渲（如插件卡切 kind/cat）走 `ctx.rerender()` 由通道出，卡不反向依赖注册表。
- **整卡切换（`views/registry.js`）**：视图定义单一真源 = `CARDS` 表（会话描述符 + 五张卡描述符，`registry.js` 聚合导入本表；**卡描述符必须排在 `registry.js` 之前**——`registry` 顶层 `const CARDS` 引用各卡 `*CardDef`），消费三处——侧栏 tab 生成（`renderMgrTabs()` 启动时注入 `#mgr-tabs`，`index.html` 不再有死按钮/内联 SVG）、`#mgr/<id>` 路由（`parseRoute` 的 `r.mgr` 即 id）、卡体渲染。**切卡唯一入口 `openCard(id, payload)`**：查卡 → 换卡 → 调卡自己的 `mount`，未知 id 返回 null（不回落任何视图）。会话卡以 `tab:false` 入表（其 DOM 是常驻单例，描述符用 `card:()=>sessionCard`）走同一条路径，无默认内容旁路。`currentCardId()` 交出槽内当前卡 id（`'session'`/其它/`null`），供 work 模式切入时判定是否需先退卡。
- **卡的生灭**：会话卡常驻 `index.html`（`#session-card`，承载 `messagesEl`/`inputWrap`/`charEl` 等模块级 const 引用的单例 DOM）→ 离开只切 `hidden`（`.view-card[hidden]{display:none}` 必需，否则被 `display:flex` 压过）；管理卡/预览卡按需创建、离开即 `.remove()`（神经元图的 rAF 以 `canvas.isConnected` 自毁，`display:none` 不释放）。同 id 卡在场即复用 ⇒ 卡体整换而滚动层不动，**滚动位置天然保持**（管理视图手写 `scrollTop` 存取块退役）。
- **卡内滚动层**：`.view-scroll`（padding `24px 20px 8px`）+ `.view-body`（`max-width: 920px` 居中）= 镜像 `.mgr-on` 时代 `#chat-scroll` + `#messages{max-width:920px}` 的几何；会话卡仍用 `#chat-scroll`（stage 链读它的 `scrollTop`/`scrollHeight`）。全高视图（项目预览 / 神经元图）的判据从槽上的 `.mgr-on:has(...)` 改为卡内结构：`.view-card:has(.preview-shell|.ext-shell|.neu-graph) > .view-scroll`（`padding:0` + `overflow:hidden` + 纵向 flex）。**该状态下 `.view-body` 的 `max-width` 与 `margin` 必须一并撤销**（二者是同一个「920px 居中帽」的两个半条）——`.view-scroll` 此时是纵向 flex 容器，交叉轴上的 auto margin 会让 flex item 退出 stretch、宽度塌成 `fit-content`（内容为 `width:100%` 的 iframe 时回落到默认 300px）。**不变量：全高卡内 `.view-body` 的宽度恒由卡宽决定。**
- **异步回程守卫**：回程渲染一律经 `viewBody(id)`——本视图的卡仍在槽里才交出卡体，否则返回 null（旧实现 `loadNeuronGraph` 的 `finally` 无条件重渲，图数据慢过用户切 tab 时会把别的视图洗掉）。
- **覆盖层随卡收口**：`#gate-screen`（`inset:0` + `background:#fff`）须自带 `border-radius: var(--radius)`——槽已无圆角可 `inherit`（否则方角盖住卡的圆弧）；`#empty-hint` 无底色不需处理。
- **变量退场**：`--panel-bg` 随侧栏透明化删除（原仅 `#panel` 一处消费）。
- **消费点**：`web-src/app.js` 的 `.mgr-tab` 点击**委托绑在 `#mgr-tabs` 容器上**（读 `e.target.closest('.mgr-tab').dataset.mgr`）、`chat/route.js` 的 `syncMgrTabs()` 按 `state.mgr` 切 `.on`。委托形态是 §42 的前提：`renderMgrTabs()` 自二期起会在运行期重渲（外部卡注册/清空），逐钮绑定会被 `innerHTML` 一并抹掉。


## 42. 卡片化二期：web 内部调用外部 `.claude/preview/` 卡片（一卡一 iframe）

- **定位**：一期（§41）之后外部 preview 只能整页占一张「预览卡」；二期让 preview **按能力申报卡片**，宿主**只按声明摆位、不解释卡片内容**。三条既有设计前提不可动：①`.claude/preview/` 是项目自持的**自包含**静态页（自带相对 css/js），网关只做静态托管；②`preview.json` 是项目向宿主申报「自己界面能力」的声明文件（`backend` 段是第一种能力，`cards` 是并列的第二种，**不是新机制**）；③`/preview/<label>/*` 的路由边界就是隔离边界（SPEC-视图卡化 §7）。
- **渲染 = 一卡一 iframe**：每张卡一个 `iframe`，`src = /preview/<label>/<path>`（同源）。外部内容始终跑在自己的文档里 ⇒ preview 保持自包含，与宿主 CSS/JS **零互相污染**；`#片段`原样带上，由卡页自我定位（宿主不推断）。**同源 fetch-HTML 注入被否决**：`innerHTML` 不执行 script，等于要自造脚本/CSS 加载器并把 §7 边界推倒重来。
- **声明一：`preview.json` 的 `cards` 段**（静态清单，与 `backend` 并列同一份申报表）
  ```json
  { "cards": [ { "id": "books", "title": "书稿列表", "icon": "folder",
                 "path": "cards/books.html", "host": "view", "tab": true } ] }
  ```
  `id` 必填 `/^[a-zA-Z0-9_-]{1,32}$/` 且项目内唯一；`title` 必填非空；`path` 必填、**preview 目录内相对路径**（可带 `#片段`）；`icon` 可选，须是 `core/icons.js` `I` 表自有键，缺省 `plug`；`host` 必填 = **渲染位置由 preview 自己要求**，本版只定义 `"view"`（主区一张独立视图卡）；`tab` 缺省 true（上侧栏 tab）。整个 `cards` 缺失 = 空集（正常，非错误）。
- **声明二：页面 postMessage 实时注册**（沿用 §39 的桥范式）：`parent.postMessage({ type:'floria-cards-register', cards:[…] }, '*')`，字段与校验同上，**同 id 覆盖静态清单项**（页面最了解自己有什么卡）。用途 = 无 `preview.json` 的纯静态 preview、或卡片集随页面状态变化。
- **端点**：`GET /gateway/preview-cards?label=<label>` → `{ label, cards:[…] }`；label 未命中 / 无 preview → 404，有 preview 无卡片 → 空数组。卡片资源**不需要新路由**——`/preview/<label>/<path>` 已托管 preview 目录内任意文件（含 `resolve` + `startsWith` 越界防护与鉴权）。解析侧见 gateway.md §6.5。
- **表与命名空间**：运行时表 `EXT` 与第一方 `CARDS` **分开存**（`views/registry.js`），只在 `cardOf` / `renderMgrTabs` 两个查询点合流；外部卡 id 为 `ext:<label>:<id>`（第一方 id 全是裸词，零撞车），tip 带项目 label。`#mgr-tabs` 的点击因此必须是容器**委托**（见 §41 末条）。
- **不变量**
  1. **外部卡集恒属于「最近一次挂载的那份 preview 文档所属项目」**——异 label 硬挂载 / iframe 换 src / 文档重挂即清（清点 = `views/cards/preview-card.js` 的 `syncExtCards(label)`，与 `clearRailExt()` 同点）；**离开预览路由不清**，否则用户点外部卡 tab 的瞬间卡就没了。
  2. **只为「当前帧」作证**——`floria-cards-register` 与 `floria-rail-register` 共用同一道门：`e.source === 当前 .preview-frame.contentWindow`；label 取帧上锚定的 `dataset.label`，**不由消息自称**。
  3. **外部永不进第一方注册表**——外部卡**没有 `mount` 代码**，其 `mount` 由宿主生成（`views/cards/ext-card.js` 的 `mountExtCard` 写 iframe 壳）⇒ 外部代码不获得在宿主 DOM 执行的能力。
  4. **非法声明丢弃不兜底**——字段不合格 / 未知 `host` / 越界 `path` → 整条丢；两条来源共用 `views/cards/ext-card.js` `normExtCards` 的**同一份过滤器**（postMessage 不过网关，必须自己再校一遍，但不给两处各写一套）。
  5. **申报缓存与刷新恢复（2026-10-02）**——`EXT` 只活在内存里（刷新即空），故网关权威快照（`replace=true`，含 `cards` 与 `quoteActions` 同存）按 label 落 `UI_KEY` 的 `extDecls` 段（`persistExtDecls`，写口仍是 `patchUI`）；postMessage 增量注册**不落盘**（那是预览页的实时补充，混进快照会让缓存随文档生命周期漂移）。回填口 `hydrateExtCards(label)` / `hydrateExtCardId(id)`（`ext:<label>:<cardId>` → label = 最后一个冒号之前那段）复用**同一注册口** `registerExtCards(label, cards, true)`（不另写第二套建表逻辑），三处接线：启动 `initWork()`（`loadWork` 之后）、切项目 `selectProject()`（换槽即换卡）、路由直进 `route()` 的 `mgr` 分支（按 id 里的 label 回填，先于 `renderMgr`）。网络清单仍为权威：`syncWorkExtCards()`（预览栏开着时由 `mountPreview`→`syncExtCards` 拉，关着时在 `ensureWork` 补拉链里拉）拉新整份覆盖——缓存只是「上次所见」的快照，不猜不兜底。
- **样式**：`.ext-shell`（`relative` + 纵向 flex + `height:100%`）> `.ext-frame`（`flex:1; width:100%; border:0`）。与 `.preview-shell`/`.preview-frame` **同构但不复用类名**——宿主侧所有「当前预览帧」的查询（rail-ext 的 `.preview-frame`、`openProjectPreview` 三级链）都按 `.preview-frame` 定位，外部卡若同用会顶替真预览帧。全高卡特例判据须并入 `.ext-shell`（与 `:has(.preview-shell|.neu-graph)` 同一块，见 §41 卡内滚动层）。
- **探针锚点**：`probes/probe-web-ext-cards.ts`（结构 + 行为真值表；网关侧解析从 `localGateway.ts` 提取、经 `Bun.Transpiler` 剥类型后直接跑，不另起网关）。

## 43. 侧栏 chat / work 双模式（Prism 式工作区）

- **模式与状态源**：`state.sbMode`（`'chat'` / `'work'`），持久化在 `UI_KEY='floria-ui-v1'`（`sbMode` + `workProj`/`workFile` + 四开关分槽 `wkPanes`，`core/state.js` 的 `saveWork`/`loadWork`）。**视图浮层四开关（编辑区/助手/预览/侧边栏）是项目级状态**：`wkPanes[<项目 label>] = {editor,assist,workspace,sidebar}`，读写各一个口——`stashWorkPanes()`（`saveWork()` 内调，未选项目不落槽）/ `loadWorkPanes(label)`（`loadWork()` 与切项目时调，无槽回落 `WK_PANES_DEF`；只写 `state`，渲染由 `applyPanes()` / `applySidebarPin()` 负责）。切项目的顺序不可换：先 `stashWorkPanes()`（此时 `workProj` 还是旧值）→ 改 `workProj` → `loadWorkPanes(label)` → `applyPanes()`。**模式不落 hash 路由**——`/session/`、`/manage/`、`/project/` 三条真路径已占满，模式只走 localStorage。`UI_KEY` 由 `mgrView` 与 work 两族状态共用，写入一律经 `patchUI()` 的 read-modify-write 打补丁（整份 `setItem` 会让后写者抹掉先写者）。
- **落地唯一入口 = `sidebar/work.js` 的 `applySbMode()`**：`#chat-panel` / `#work-panel` 切 `hidden`、`.ms-btn` 切 `.on`、`#chat-area` 切 `.work`，启动恢复与运行期切换共用这一条路径（无第二份初始化旁路）。启动序 = `initWork()`（`loadWork()` → `mountWork()` → `applySbMode()`，**绑定必须先于 applySbMode 的渲染**，否则 work 面板首渲的行没有容器级委托）。
- **主区三栏**：`#chat-area.work` → `flex-direction: row`；`#work-editor`、`#session-card`（助手）与 `#work-preview`（个性化工作区预览）各 `flex: 1 1 0`。前两者显隐由 `#chat-area.work.hide-editor` / `.hide-assist` 门控，预览栏由 `#chat-area.work.wk-preview` 门控（第三栏 = `#work-preview` 段）。**助手可脱流**（见下条「助手三态」）：`'side'` 形态占主区一栏，`'float'`/`'slim'` 形态脱出 flex 流、不占列。**不变量：编辑区 / 预览至少一栏可见**（助手脱流时不占列，不能再用它兜底），唯一判定点 = `applyPanes()`（判据 `!state.wkEditor && !state.wkPreview && !wkAssistInFlow()`，命中时强制打开编辑区并 toast；`setPane()` 内不再有第二份检查）。
- **助手三态（2026-09-27，对齐 Pj18 preview 的三态助手）**：同一张 `#session-card` 的三个形态——`'side'`（靠栏，占主区一栏 = 现状）/ `'float'`（悬浮卡，脱流不占列，编辑区与预览列因此变宽）/ `'slim'`（收敛成底部输入栏）——状态源 `state.wkAssistMode`（持久化 `UI_KEY`）+ `state.wkAssist`（开合），中继 `wkAssistMode()`。**绝不 reparent**：卡里挂着 `core/state.js` 模块级 const 引用的 `messagesEl`/`inputWrap`/`charEl` 单例，只改类 + 写内联几何（搬 DOM 会丢消息流与输入草稿）。唯一写口 = `applyAssistMode()`（切 `.wk-assist-float`/`.wk-assist-slim` 两个类落到卡上 + 写/清内联几何），可见性全由 CSS 给（`styles.css`「助手三态」段）。**几何只有一个写口**：两态横向共用 `wkPlaceAssistBox()` 写「左缘 + 宽」，纵向各写各的（悬浮 `top` / 收敛 `bottom`），清空 = `wkClearAssistBox()`（`position/left/top/bottom/width/height`）；CSS 只管外观与可见性，**不得再出现 `left`/`bottom`/`translateX(-50%)` 之类的第二个横向写口**（两写口叠加 = 双重位移，整条栏被推出主区）。in-flow 判据唯一 = `wkAssistInFlow()`（`state.wkAssist && wkAssistMode()==='side'`），不变量判定 / 分界条显隐 / flex 落点三处共用。
  - **锚点 = 首个可见的 in-flow 主区栏**（编辑区 → 预览列 → 整个 `#chat-area`；`wkAssistAnchor()`，宽 >120px 才算）。编辑区在场就锚它（主阅读面，且浮卡压编辑列时预览列完整可见）；编辑区关掉只剩预览时锚预览；两栏都不在（助手脱流且另一栏也关）兜整区。work 有第二个主角列，故不能照搬 Pj18「恒锚编辑列」——编辑区不在时必须给出确定的下一档，不能锚到 0 宽目标。宽度 = 锚栏宽 − 2×8px（`WK_ASSIST_PAD`）。
  - **坐标在 `#chat-area` 局部系**（`position:absolute` + `#chat-area`（`relative`）作包含块）：`body.kb-open` 时 `#app` 被 `transform`，`position:fixed` 的视口坐标会整体漂走，故不用 Pj18 的 fixed。悬浮卡 `top = 主区高 − 高 − 24`（`WK_ASSIST_BOT`）；**空态缺口补高**：卡内立绘台面垂直居中 ⇒ 卡高 `h` 时空态底栏底边距卡底边 `= h/2 − 常量`（常量 = 台面高×0.2675 + 底栏高/2，只由台面与底栏尺寸决定），`h = 430` 时为负（底栏下沿被卡边界裁掉）；故 `wkPlaceAssistFloat()` 落位两拍——先按 `state.wkAssistH` 放，再由 `wkFloatEmptyDeficit()`（实测 `#empty-hint #input-wrap` 底边 vs 卡底边；非空态无盒恒 0）量出缺口 `d`，`d > 0.5` 时按 `h + 2d`（底距随卡高以 1/2 变化）重放，补高量**不写回** `state.wkAssistH`；卡底边锚在主区底部不动 ⇒ 卡向上长，底栏与立绘同步上移、二者相对位置不变（`probe-work-scope` F9 锁这条）；收敛栏 `bottom = WK_ASSIST_BOT + WK_INPUT_BOT`（24 + 22）——**+22 是正常底栏在会话卡内的底距**（`#input-wrap.docked` 的 `top: calc(100% - 22px)`），故收敛栏 pill 底边与正常输入栏底边齐平，切形态时底栏在纵向不挪窝（两常量必须同源，改一边即破，`probe-work-scope` F3c 锁这条耦合）。高度由 pill 内容给（清掉内联 `height`）。收敛 pill 末端的箭头 `.wap-arrow` 与发送钮同款材质（34px 圆 / `#4176E6` / 白字形 / hover `#679EFE`），图标由 `mountWork()` 注入单源 `core/icons.js` 的 `dshSend`（HTML 内联自绘已删）。
  - **形态切换入口**：助手卡头部工具条（`#wk-assist-dock` 靠回栏 / `#wk-assist-float` 浮起 / `#wk-assist-slim` 收成输入栏 / `#wk-assist-close` 关助手，仅 `side`/`float` 态显示），收敛栏的 `.wk-assist-pill`（点回悬浮）。切形态 = `setAssistMode()`（写 `state.wkAssistMode` + 顺手 `wkAssist=true` + `applyPanes()` + `saveWork()`）。
  - **加高把手 `#wk-assist-grip`**（仅悬浮态显示，只调高——宽由锚栏给定）：**pointer events + `setPointerCapture`**（Pj18 的 mousedown 链触屏不触发，iPad 必须能用）。收尾三规矩照抄 Pj18：① 只认主键且位移 >3px（`WK_DRAG_SLOP`）才算拖；② 收尾看 `ev.buttons`（pointerup 落在内嵌内容/窗口外时不只等 up，防状态永久卡死）；③ 拖拽期给 `body` 挂 `.wk-assist-dragging`（`iframe{pointer-events:none}`，拖过 `#work-preview` 的 iframe 时事件仍全归把手）。高度收在 70vh 内（`WK_ASSIST_MAX_VH`），落 `state.wkAssistH`（持久化）。
  - **重锚**：`ResizeObserver` 观察 `#chat-area` / `#work-editor` / `#work-preview` → `wkReflowAssist()`（分界条拖拽、侧栏开合、窗口缩放、栏开关全覆盖；`applyWorkFlex()` 末尾也调一次）。
  - **z-index 15**：高于主区各栏，低于 `.wk-file-open` 的编辑区覆盖层（20，手机端点文件要看内容）。
  - **空态底栏不随模式变（且相对立绘位置锁定）**：work 模式下空态底栏**仍守趴栏台面**——与 chat 空态共用同一条 `#empty-hint #input-wrap` 规则，**无模式分叉、无 work 专属覆盖**。锚点 = **台面中心**（`top: 76.75%` + `transform: translate(-50%, -50%)`，按 `state-newchat.webp` 实测标定，76.75% 即立绘台面中心）——**这是「底栏相对立绘的落点」，2026-09-27 用户定案不可改**（曾改底边锚 `calc(83% - 12px)` + `translateY(-100%)` 让底栏上移压住女孩手臂，被否）。新聊天（空态）与旧聊天（会话态）底栏几何**量级不同属预期**，不做对齐——空态是配合角色立绘的趴栏设计（台面就在那个高度），挪到卡底会与背景脱节。
- **栏宽可调（分界条，2026-09-27）**：栏宽真源 = `state.wkFlex`（三栏各自的 `flex-grow`，`flex-basis:0` ⇒ 宽 ∝ grow），持久化进 `UI_KEY` 的 `wkFlex`；落地口 = `sidebar/work.js` `applyWorkFlex()`（`applyPanes()` 末尾调用，末尾再调 `applyAssistMode()` 让脱流助手跟着重锚；非 work 模式移除内联 `flex`，否则会污染 chat 模式 `.view-card` 的 `flex:1`；助手脱流时同样清掉内联 `flex`——absolute 已脱出 flex 流）。**不变量（2026-09-29 根修）**：写内联 `flex` 前必须把**可见 in-flow 栏**的 grow 按比例归一化到总和 1（`vis` = `PANE_EL` 中 `paneVisible()` 为真者；不可见栏既不参与求和、也不落内联 `flex`）。`wkFlex` 存的是拖拽时「一对栏和不变」的**比例权重**，单栏权重可 < 1；若直接写进 `flex-grow`，关掉其它栏后可见栏 grow 之和可 < 1，而 CSS flex 规范在 grow 总和 < 1 时**只分配该比例的剩余空间、余下留白** ⇒ 栏（实测为助手卡）右侧空出一条 `--plane` 空白带。分界条 = `#chat-area > .work-gutter` 两条（DOM 序夹在编辑区→预览→助手之间），拖拽 `bindGutter()` 按指针在「左栏左缘 → 右栏右缘」区间的占比重分配**这相邻两栏**的 grow（和不变），每侧留 `PANE_MIN=180px` 地板。缝显隐 = 左右都有可见栏（`nearPane()` 沿 DOM 序跳过隐藏栏与另一条缝；`paneVisible()` 对脱流助手恒返回 false，否则预览列与浮卡间会冒出幽灵分界条），并去重（两条缝被一段全隐藏栏隔开时只留靠左一条）；栏隐藏 ⇒ 对应缝自动消失。手机 ≤720px 两条缝一律不出。
- **模式互斥**：work 模式只在会话卡在场时成立——`chat/route.js` 的 `route()` 在 `r.name` 为 `mgr`/`preview` 且当前为 work 时调 `setSbMode('chat')`（顶 tab 高亮、面板显隐、`.work` 由 `applySbMode` 一并落地）。反向无特殊处理（work 侧栏本就不含管理/预览入口）。
- **数据源（零后端改动）**：项目列表 = `/gateway/sessions` 的 `groups`（`core/sessions.js` `loadSessions` 顺带存进 `state.projects`，含无会话项目）；文件树 = `GET /gateway/project?label=` 的 `files`（节点 `{name,type:'dir'|'file',children?}`）；单文件 = `GET /gateway/file?label=&path=`（原始字节，已有路径穿越防护 + 4 MB 上限 + MIME 头）。
- **work 数据的「门后补拉」**：`ensureWork()`（`sidebar/work.js`）是 work 数据补齐的唯一路径（补拉链含文件树 / 编辑区 / 预览栏 / **外部卡申报** `syncWorkExtCards()`——预览栏开着时该申报由 `mountPreview` 链内拉，关着时在此补齐，见 §42 不变量 5），三处调用——`applySbMode()` 进入 work、启动 `initWork()`→`applySbMode()`、以及 `core/auth.js` `hideGate()` 的 `loadSessions().then` 链内（`state.sbMode==='work'` 时）。**为什么必须挂在 hideGate**：`loadProjectTree()` 与 `renderEditor()`→`readFile()` 都依赖 token，boot 时 `needToken()` 仍为真（`loadProjectTree` 直接早退、`readFile` 拿 401 且不重试），刷新后从 localStorage 恢复的 `workProj`/`workFile` 就停在「无文件树 + 编辑区读取失败」——手点 ⟳ 才好的现象即此。补拉点与 mgr/models/neurons 数据的门后补拉同点（不新开窗口、不加定时重试）。
- **项目列表渲染单一路径（不变量）**：`renderWorkChrome()` = 项目名 + 底部卡计数 + 下拉内容（末尾调 `renderWorkProjects()`）的**同一次**渲染，四处调用点共用；下拉内容不得只在下拉打开那一刻从 `state.projects` 快照单独渲一次。**下拉绝不由「在途/空列表」渲染**：`#wk-proj-seat` 点击先 `await ensureProjectList()`（已有列表即返回，空则拉一次——`loadSessions` 在启动早期会因 `needToken()` 早退）再 `pop.hidden = false`。空态文案（`.wk-empty`）取 `--text-2`，`--text-3` 在白底浮层上肉眼等同空白（失败必须看得见）。
- **模块顶层名字全局唯一（构建不变量）**：`scripts/bundle-web-modules.ts` 把各模块体**原样拼进同一个 IIFE**（只剥 `import` 行），故全部模块的顶层 `function`/`const` 共享一个作用域——**同名即静默覆盖**（按 MODULES 序后出现者胜），先声明者的调用点会跑到另一个实现上且无任何报错。新增模块的顶层名一律带模块前缀。探针锚点：`probes/probe-web-module-scope.ts`（模块间同名 / 与 prelude 注入名 `$` 冲突 / 产物 `app.js` 顶层声明去重，三闸）。
- **编辑区渲染分流**（`readFile()`）：图片扩展名 → `<img src=fileUrl>`；`content-type` 判文本（含 `.md` 兜底）→ `.md` 走 `core/markdown.js` 的 `mdHtml`（排版作用域 `.wk-ed-md`，与 `.msg .body` 同一套规则，见 styles.css Markdown 段）否则 `<pre class="wk-code">` 转义原文；413/403/二进制 → 居中提示不静默空白。**`edSeq` 序号守卫**：快速连点文件时丢弃迟到的旧响应。
- **文件树**：整块 `innerHTML` 重渲 ⇒ 点击事件**委托在 `#wk-body` 容器上**（逐行绑定会被下次重渲抹掉）；过滤词命中自身或任一子孙即保留目录（`wkNodeHit`，否则目录被滤掉、里面的命中项也没了）。行操作浮窗（右键 / 长按）与聊天 tab 同走 `recent.js` 的 document 级委托——`mountWork()` 调 `registerWorkRows()` 注册 `.wk-row`（`key` = `data-wkfile`/`data-wkdir`，菜单 重命名/删除），`renderWorkBody()` 重渲后调 `reliftRowMenu()` 复位长按浮起（见 §7 / §45）。
- **与预览页注册按钮的关系**：work 侧栏不含 `#rail-ext` 挂载点（折叠带已于 2026-09-25 撤除，见 §38/§39）；work 模式不改变该链路的状态。
- **样式**：模式 tab / `#work-panel` / 文件树 / `#work-editor` 两栏 / 助手三态（`.wk-assist-head` 头部工具条 / `.wk-assist-grip` 把手 / `.wk-assist-pill` 收敛条 / `#session-card.wk-assist-float` / `.wk-assist-slim`）/ 手机覆盖层集中在 `styles.css` 末段「侧栏 chat / work 双模式」块；`#work-panel[hidden]`、`#chat-panel[hidden]`、`#wk-proj-pop[hidden]`/`#wk-view-pop[hidden]`/`#wk-new-pop[hidden]` 须显式声明（面板带 `display:flex`，作者样式优先级高于 UA 的 `[hidden]{display:none}`）。手机 ≤720px 三栏不成立：常态只显示助手，预览栏强制 `display:none`；点文件给 `#chat-area` 加 `.wk-file-open` → `#work-editor` 变 `position:absolute; inset:2px` 覆盖层，`#wk-ed-back`（仅手机露出）清除该态。
- **聊天 tab 列表**：列出 `state.workProj` 的会话（`ALL` 取 `projectScope==='project' && projectLabel===state.workProj`，`sessCmp` 排序），条目**复用 `recent.js` 的 `itemHtml(s, false)`**——与侧栏「项目展开」同一份行渲染，零复刻。行操作浮窗（右键 / 长按）走 `recent.js` 的 document 级委托，work 侧栏无需接线（见 §7）。点击委托在 `#wk-body`（整块 `innerHTML` 重渲，逐行绑定会被抹掉），语义同 `bindSessClicks`（已在该会话内不重复 navigate；移动端收面板）。
- **过滤词按 tab 各判各的**：`wkFilter` 单一状态源，文件 tab 走 `wkNodeHit`（文件名/路径，命中自身或任一子孙即保留该目录），聊天 tab 按会话标题子串。**切 tab 清词**——两 tab 判据不同，留旧词会渲染出假空态。
- **图标 SVG 无自带尺寸**：`core/icons.js` 的 `I.*` 全是裸 `<svg viewBox>`（不带 width/height），**每个使用点必须落在有 `svg{width;height}` 规则的 slot 里**；裸插会取替换元素默认 300×150（巨型图标撑爆行高）。文件树目录行与文件行同用 `.wk-fic` slot。
- **在项目中工作（不变量，两半各一个判定点）**：work 模式 + 已选工作项目时——①**落项目**：新会话/新上传的目标项目恒 = `state.workProj`，唯一真源 = `core/state.js` `newSessionProject()`（work 模式解析 `workProj`，否则回落 `state.newProject`）；消费点 `inputbar/send.js` 建会话、`inputbar/images.js` 上传落点，**任何消费点直读 `state.newProject` 都会在 work 模式下把会话/文件落到全局**。②**助手栏范围**：只看工作项目的会话，唯一判定点 = `sidebar/work.js` `workScopeOk(hash)`（非 work 模式 / 未选项目 / 空 hash / `findSession` 查无一律放行——「未知」≠「别的项目」），三处入口共用：`chat/route.js` `renderSession` 首句守卫（含刷新恢复的直连路径）、`applySbMode()`（切模式）、`selectProject()`（切项目）——命中即 `navigate('#/')` 退回该项目的新对话空态。seat 由同一判定锁定只读（`inputbar/commands.js` `projSeatLocked()` = 会话态 ∪ work+工作项目，渲染与点击守卫共用），label 读 `newSessionProject()`。
- **新聊天 = tab 行右侧「+」**（`#wk-new`，`.wk-tools` 内，紧邻 🔍）：聊天 tab 点它 → `navigate('#/')`（落项目由 `newSessionProject()` 按工作项目解析，**不写 `state.newProject`**——目标项目槽只有一个真源）；文件 tab 点它 → 弹 `#wk-new-pop`（新建文件 / 新建文件夹 / 上传文件 / 上传文件夹四项，**功能暂未接入**，点击只 toast）。按钮 `title` 与 🔍 的 tooltip/placeholder 随 tab 切换（`updateWkTools()`），切走时文件菜单自动收起（`.wk-ico[hidden]{display:none}` 必需——`.wk-ico` 的 `display:inline-flex` 压过 UA 的 `[hidden]`）。列表顶部那个通栏新建按钮已退场。**不切回 chat 模式**：`#/` 空态由 `renderHome()` 渲进会话卡（非视图卡），work 布局照样成立；模式互斥只对 mgr/preview 两张视图卡生效。
- **视图浮层 `#wk-view`（侧栏右上角）**：`||` 图标，展开 `#wk-view-pop`——四行开关：编辑区 / 侧边栏 / 助手 / 预览（数据键 `data-wkpane` = `editor`/`sidebar`/`assist`/`workspace`）。**唯一读态口 = `paneOn(k)`**（`state.wkEditor`/`wkAssist`/`wkPreview`/`state.panelPinned`），`syncPaneRows()` 是行状态唯一写口（`applyPanes()` 与 `setPanel()` 各调一次——pin 可被汉堡/收起钮/遮罩/浮层开关任一处翻转）。`applyPanes()` 管三栏类（`hide-editor`/`hide-assist`/`.wk-preview`）。**「助手」行 = 开合 `state.wkAssist`**（与形态无关：关掉即无论 `side`/`float`/`slim` 都不显示；`wkAssistInFlow()` 据此判是否占列）。`sidebar` 行走 `setPanel(on,{pin:on})`（**与「折叠侧栏」合并成同一个浮层**，work 模式下 `#panel-collapse` 隐藏），读态用 `state.panelPinned`（**被主动打开**）而非 `state.panelOpen`（**此刻可见**，含左缘悬停预览式唤出）——悬停瞬时露出不算「界面常在」，开关不跟亮。**四开关随项目走**（见上条 `wkPanes`）：切项目换槽、无槽用缺省；`sidebar` 行的落地入口 = `applySidebarPin()`（把槽值交给 `setPanel` 调一次，**移动端不恢复**——侧栏在手机是全屏抽屉，恢复打开态会盖住主区；槽值照常存）。探针锚点：`probes/probe-work-scope.ts` §⑪。
- **自动刷新（`#wk-refresh` 已删）**：`.wk-head` 原刷新按钮退场；work 模式下每 5s（`WK_AUTO_MS`）静默 `refreshWork(true)`= `loadSessions()` + 当前项目文件树，`workAutoTick()` 三重门（非 work 模式 / `document.visibilityState !== 'visible'` / `needToken()` 一律跳过），`visibilitychange` 切回前台立即补一次。定时器由 `applySbMode()` 起停（进 work `ensureWork()+startWorkAuto()`，离开 `hideWkPops()+stopWorkAuto()`）。**防抖**：`renderWorkBody()` 比对新旧 HTML 相同则不动；`refreshWork(silent)` 保存/恢复 `scrollTop`。
- **个性化工作区预览栏 `#work-preview`（第三栏）**：`state.wkPreview` 开则渲染当前工作项目的项目预览，**与「项目」页同一份渲染链**——复用 `sidebar/mgr.js` 的 `mountPreview(container, label, hasPreview)`（从 `openProjectPreview` 抽出的三级链：backend 容器 → `/preview/<label>/index.html` → `/default-preview/<label>/`）。`renderWorkPreview()` 幂等：同 label 且帧已在场则不重建外壳，只纠 src；切项目跟随（`selectProject()` / `ensureWork()` 后各调一次），**关掉不销毁（帧留在 DOM）、重开零重载**。**与槽预览卡的差别**：`#work-preview` 是持久列（非 `.view-card`），不 `clearSessionSlots()`、不切模式，故不走 `openProjectPreview`。
- **侧栏控件不复设（work 模式）**：顶栏 `#panel-search`（搜索会话）与 `#panel-collapse`（折叠）在 work 模式隐藏（`#panel.work #panel-search, #panel.work #panel-collapse`，类由 `applySbMode()` 落在 `#panel` 上）——work 自带 🔍（`#wk-find` 过滤当前 tab），两个放大镜同屏即「重复」观感；侧栏折叠由 `#wk-view-pop` 的「侧边栏」行接管。`.wk-tools` = 🔍 + 「+」（`#wk-find`、`#wk-new`）。
- **构建登记**：`scripts/bundle-web-modules.ts` MODULES 表内 `sidebar/work.js` 区间号 2932（只作执行序排序，排在 `views/registry.js` 之后、`__app__` 之前）。
- **探针锚点**：`probes/probe-work-scope.ts`（结构与真源断言 A~F 组：`newSessionProject` 唯一真源 + 两处消费点接线 + `workScopeOk` 四条放行判据 + 三处入口接线与顺序 + seat 锁定判据 + `.g-stage` 宽度基准无 `vw` + 助手三态〔in-flow 判据唯一 / 新不变量 / 幽灵缝排除 / 三态唯一写口 / 横向几何同源 + CSS 无自居中 + 底距内联 + `WK_INPUT_BOT` 与 `#input-wrap.docked` 22px 同源 + `.wap-arrow` 发送钮材质 + 箭头图标单源 + 清空含 bottom / pointer + `ev.buttons` + 3px 阈值 + 拖拽类 / 四图标 + pill 接线 / ResizeObserver / index.html 与 styles.css 标记 / 形态持久化往返〕+ 产物内函数定义唯一 + 侧边栏开关真源 = `state.panelPinned` 且 `setPanel` 落地后同步行〔G1〕）。

## 44. @ 提及「目录 / 文件」：逐级浏览 + 路径 chip

**能力**：`@` 浮窗与「+」菜单都可引用**目录/文件**，选中文件即插入一枚显示为 `@<相对路径>` 的 chip；**路径基准恒 = 工作区根**（`getPortableRoot()`），与网关 `/gateway/fs` 同基准。

**浏览起点 = 当前上下文项目目录**（`pickHome()`，用户定案「先显示本项目的文件」）：会话态取该会话所属项目（`projectScope==='project'` 的 `projectLabel`，全局会话取空），非会话态取 `newSessionProject()`（work 模式即工作项目）。空串 = 无项目上下文 → 起点即工作区根。**基准仍是工作区根**——`pick.path` 自始至终是相对工作区根的路径，项目层不过是它的一个子级；首行「上级目录」从项目层退回工作区根（`pickParent()` 单段路径 → `''`）。

- **两个浮窗**：「+」菜单（`inputbar/commands.js`，`#cmd-pop`）与 `@` 浮窗（`inputbar/mention.js`，`#mention-pop`）；后者无「上传/指令」组（本就不提供图片/文件上传与斜杠命令），组序仍是同一份 `GROUP_ORDER` 的子序列。
- **两入口共用一份 pick 数据层**（`inputbar/mention.js`，`commands.js` 只 import 复用，零复刻）：状态对象 `pick = { path, entries, loading, err, seq }`；`loadPickPath(path)` 打 `GET /gateway/fs?path=`，**`seq` 序号守卫**丢弃迟到的旧响应（连点下钻防串层）；`pickItems(q)` 产出 `{kind:'pathup'}`（仅非工作区根层）+ `{kind:'path', ptype:'dir'|'file', name, path}`，`q` 只过滤**当前层**名字；`pickEnter(it)` 下钻/返回；`refreshPick(after)` = **定位到 `pickHome()`** 后回调重渲。
- **浮窗打开即回项目层**：`openMentionPopAtCaret()` 与 `toggleCmdPop()` 各调一次 `refreshPick(...)`（回调内先判 `mention.open`/`cmd.open` 再渲，防迟到响应写进已关的浮窗）；打开是新的一轮手势，不延续上次浏览到的层（同 `q`/`sel` 每次重置），且**先清 `pick.entries`**——否则换项目后先闪一帧上一个项目的条目。
- **「上级目录」不依赖当前层内容**：`pickItems` 先压上级行（只要 `pick.path` 非空），再判 `loading`/`entries`。某一层拉不到（目录已删/请求失败）时，上级行照旧在 ⇒ 文件组不会变成退不回去的死层。
- **组序与每组上限（`arrangeItems`，唯一真源，两个浮窗都过）**：组序固定 **上传 → 聊天 → 文件 → 技能 → 指令**，每组只列 `GROUP_MAX = 3` 行（超出的不渲染，没有「更多…」折叠）。`GROUP_OF` 是 kind→组的唯一映射（`imgpick`/`filepick`→上传、`session`→聊天、`path`/`pathup`→文件、`skill`/`plugin`→技能、其余→指令；`commands.js` 的 `cmd` 即指令组），组标题也由它产出——**新增条目只声明 kind，不在各自浮窗里排位**（两处排位分开写迟早分叉）。**例外：「上级目录」是导航行**，既不占列表名额也不被截断（截掉会让子目录变成死层），故文件组最多呈现「上级目录 + 3 项」。
- **渲染**：分组标题 = `groupOf(it)`，文件组额外拼当前层路径（`'文件 · ' + pickLabel()`，工作区根层显示「工作区根」）；行图标 `mentionChipIcon('path', ptype)`（dir→`I.folder`/file→`I.dshFile`），首行「上级目录」用 `MENTION_UP_ICON`（mention.js 自带，非 `I.*`——它不带尺寸槽，本行有 `svg{}` 规则）。行副标题显示完整相对路径。
- **选中分流（唯一判定点 `selectMentionItem(it)`，点击与 Enter 共用）**：`pathup` 或 `path+dir` → 下钻（不插 chip）；`path+file` → 插 chip。`commands.js` 侧同判据内联在 `cmdSelect()`。
- **令牌形态**：`[@目录:路径]` / `[@文件:路径]`（`serializeInput` 由 `chip.dataset.ptype` 决定字面量，`buildMentionChip` 只写 `dataset.name`/`dataset.ptype`）。**刻意不用 `[文件:路径]`**：该形态是上传附件占位（`inputbar/send.js` 上行、`chat/messages.js` 剥离、`userFilesHtml` 渲染成文件卡），复用会被附件链吞掉。
- **渲染回显**：`mention.js` `renderUserText` 与 `core/markdown.js` `mdInline` 都按 `MENTION_PATH_RE = /\[@(目录|文件):([^\]]+)\]/g` 还原成 chip——**两处都要加**（离线气泡走 mdInline、实时流走 renderUserText）。
- **样式**：`.mention-chip.m-path`（等宽字体、`max-width: min(100%, 320px)`），内层 `.mc-t` 承担省略号（chip 是 inline-flex，直挂文本无法 `text-overflow`）；`#cmd-pop .grp` 与 `.mp-sec` 加 `nowrap + ellipsis`（分组标题带路径会撑破浮窗）。
- **构建不变量**：`commands.js` 对 `mention.js` 的 import **必须单行**（拼接器只剥 `/^import /` 行，续行会漏进模块体）。
- **探针锚点**：`probes/probe-gateway-fs.ts`（`resolveWithinRoot` 越界/根内 18 断言 + 端点分支只读/复用 `listOneLevel`/403/404 文本断言）、`probes/probe-web-module-scope.ts`（新增顶层名 `pick`/`pickItems` 等不得与他人撞名）。

## 45. work 文件树写操作：重命名 / 删除（移入 .trash/）

**能力**：work 文件 tab 的文件行/目录行右键（桌面）或长按（触屏）浮出菜单——**重命名** / **删除**；重命名复用会话那枚弹窗，删除 = 把条目**移动进项目根 `.trash/`**（工作区规范禁止真删，`.trash/` 即撤销位，故不设二次确认）。

- **后端两写端点**（`localGateway.ts`，纯函数抽出可直测）：`POST /gateway/file/rename`（body `{label, path, name}`）、`POST /gateway/file/delete`（body `{label, path}`）；`label` 定位项目（`findProjects` 里 `scope==='project'` 的项，项目根 = `resolve(dir,'..','..')`）。响应 200 带 `{path,name}` / `{trash}`，失败沿用 HTTP 码。**不覆盖**：重命名目标已存在 → 409 且磁盘无变化（不自动加序号——静默换名比报错更糟）；同名重命名 = 幂等 no-op。**越界一律 403**：`..` 逃逸 / 空 rel（项目根自身）。删除同名冲突 → 加 `YYYYMMDDHHMMSS-` 时间戳前缀入 `.trash/`，不覆盖既有垃圾。
- **名称清洗 = `sanitizeEntryName`**（导出，上传端点同用一件）：`path.basename` 只取末段（盘符式前缀 `c:notes` 被当路径剥成 `notes`——只可能少字，不可能逃出项目根）→ 非法字符 `[\\/:*?"<>|]` 与控制符替换为 `_` → Windows 保留名（`con`/`prn`/`aux`/`nul`/`com1-9`/`lpt1-9`）加 `_` 前缀 → `.`/`..` 归空 → 超 120 字符截断保扩展名。
- **`.trash/` 不可见**：`SKIP_TREE_DIRS` 含 `.trash`，`walkProjectTree`/`listOneLevel` 跳过点开头条目 ⇒ `.trash/` 永不进 `/gateway/project` 文件树（删除后刷新即从树中消失，不经任何前端过滤）。
- **前端接线**：`sidebar/work.js` `mountWork()` 调 `registerWorkRows()`（`registerRowMenu({sel:'.wk-row', key, items, pick})`）；`openFileRename(p)` → `openRenameDialog`（会话弹窗同一件，见 §7）→ 成功后迁移 `wkOpen` 前缀与 `state.workFile`（目录改名 = 整棵子树前缀随之搬）、`saveWork()` + `loadProjectTree` + `renderEditor` + `renderWorkBody`；`deleteWorkEntry(p)` 清该子树在 `workFile`/`wkOpen` 的残留再重渲。重渲后 `reliftRowMenu()` 复位长按浮起的行（长按态下 5s 自动刷新不塌浮窗）。
- **探针锚点**：`probes/probe-file-tree-ops.ts`（31 断言，直测 `renameProjectEntry`/`trashProjectEntry`/`sanitizeEntryName`：越界 403、409 不覆盖、`.trash/` 迁移与时间戳冲突、Windows 保留名、超长保扩展名、两端点转译结果码、`.trash` 在 `SKIP_TREE_DIRS`）。

## 46. 输入栏工具行的窄容器收缩（容器查询）

**不变量：`#input-bar .row` 恒为一行**（`flex-wrap: nowrap`，换行无合法场景）；放不下时由**两条收缩链**逐级让位，固定件（`+` / 上下文 / 发送）不变形。
- **左链**：`.tools` → `#proj-root` → `#proj-seat` → `.projLabel`（`min-width:0` 逐级打通，项目名出省略号，`max-width:240px`）。
- **右链**：`.trailing`（`flex:0 1 auto`）→ `#model-root`（`display:flex`）→ `#model-seat.trigger`（`flex:0 1 auto`、`max-width:360px`）→ `.triggerLabel`（省略号）；固定件 `#ctx-meter` / `#send-btn` / `.add` 一律 `flex:none` **不参与收缩**——漏给 `flex:none` 的固定圆钮会被 flex 压到 <自身尺寸，内容溢出盒子与邻项重叠（`#ctx-meter` 曾如此：轮廓压在模型 chip 文字上）。`.trailing` 曾为 `flex:none` ⇒ 恒保持内容宽、把发送钮推出卡片。**chip 宽度必须由这条链决定，不得挂容器查询单位**：`max-width: min(360px, 45cqw)` 一旦 cqw 不回落到本栏就按视口取 45%，窄栏里 chip 恒顶 360px 压住上下文圆钮。
- **参照系 = 输入栏自身宽度，不是视口**：`#input-bar { container-type: inline-size }` 使 `@container` 规则以本栏宽为基准（缺它则按视口判定，work 分栏 / 侧栏展开 / 分屏下不触发窄档）。此属性只影响**间距收敛档位**，宽度正确性由上面的收缩链独立保证。
- **窄容器收敛（两档）**：`@container (max-width: 480px)` 收 `.tools`/`.trailing`/`.row` 的 gap 与模型 chip 内垫；`@container (max-width: 400px)` 隐藏 `.triggerEffort`（推理等级）与 `#proj-seat .chevron`——**让位的必须是可再生的文字/装饰，固定件与 chip 图标恒在**（两档合起来把工具行 min-content 从 ~260px 压到 ~234px）。
- **卡片宽度下限 240px**：`#input-wrap.docked { width: max(240px, min(780px, 70vw, calc(100% - 40px))) }`。240px = 工具行 min-content 之上的最短安全宽；下限之上收缩链恒能兜住（永不重叠），下限之下卡片止步不再继续压（宁可横向越出可视区）。

## 47. 选中文本引用：松开鼠标唤出浮窗 → 引用胶囊

**能力**：在**编辑区**（`#work-editor`）或**助手消息流**（`#chat-scroll`）内选中文本 → **松开鼠标那一刻**自动弹出浅色竖排菜单浮窗：上行「使用 AI 编辑」（只把引用胶囊塞进主输入栏，用户补话术后自己发），下行内嵌输入栏 + 尾部发送钮（写一句话即连同引用发出）。模块 `inputbar/quote.js`。**右键不被拦截**——浏览器原生菜单照旧。

- **唤出手势 = `document` `mouseup`（主键）**：`e.button !== 0` 早退；浮窗内的 `mouseup` 早退；`quoteSkipNextUp` 消费「点浮窗外关窗」的那一下——在某些元素上 `mousedown` 并不清掉选区，不挡就会「关掉又立刻重开」。**不再有 `contextmenu` 委托**（旧设计会掐断原生菜单）。
- **选区快照必须在开浮窗那一刻取**：点浮窗内的输入框会清掉 DOM 选区（`window.getSelection()` 变折叠），靠 selection 现场取已来不及。**快照单一构造入口 = `quoteSnapOfRange(range)`**（收 Range 实参，判非空非折叠 + `startContainer` 的 `closest('#chat-scroll, #work-editor')` 命中 + 产出 `{text, rect, ...}`）；桌面路径 `quoteSnapOf()` 只是「现场取当前 `getSelection()` 那一条 Range」的薄壳。**无模块级快照状态**——`quoteStash(snap)` / `quoteSendNow(snap)` / `quoteRunAction(id, snap)` 一律显式实参（动作行的闭包在 `openQuotePop` 内已捕获快照），`closeQuotePop()` 不再需要清快照。
- **两种来源，落地形态不对称（用户定案）**：
  - 编辑区（`state.workFile` 有值）→ `kind:'file'`，**只给位置**（路径 + 行范围），模型自己 Read 该文件。
  - 消息流 → `kind:'reply'`，**带原文 + 会话锚点**（回复不属于任何文件，无位置可查），`idx` = 该 `.msg` 在 `messagesEl.querySelectorAll('.msg')` 中的序号，`title` 取 `findSession(state.currentHash).title`。
- **编辑区行号唯一来源 = DOM**：`pre.wk-code`（纯文本预览）是**原样**文本，用 `range.startContainer === pre.firstChild` 时的 `startOffset` 换算行号；markdown 预览的行号来自**渲染期落下的行锚**——`sidebar/work.js` 调 `mdHtml(text, 'data-l')`（第二参数 = 行锚属性名，不传 = 现状，会话消息渲染不受影响），`core/markdown.js` 在标题/引用块/列表项/分隔线/表格行/代码行上落 `data-l="<源行号>"`、段落**逐行**包 `<span data-l>`（一段跨多行时每行各得各的锚）；`quote.js` 的 `quoteLineOf()` 由选区首尾容器向上取锚并 `min/max` 归一。**不得拿渲染后的选中文本回查原文**（`indexOf`）——渲染把 `**`/`` ` ``/链接等格式符丢了，选中一旦跨在格式符边界上（渲染文本「收尾必做清单：」对源文 `**收尾必做清单**：`）回查必 `-1`，行号整段丢失。两侧都取不到 → `null`，令牌退化为**纯路径不编造行号**。
- **引用胶囊复用 `.mention` 类**（`insertRefChip`，追加到 `inputEl` 末尾、前后各一个 `\u00A0`）：`ctx-meter.js` 的 × 点击与退格删除委托按 `.mention` 统一处理，勿另写一套。dataset：`kind='ref'`、`rkind='file'|'reply'|'pdf'`、`file`/`proj`/`l0`/`l1`（file 类）、`quote`/`title`/`idx`（reply 类）、`file`/`proj`/`quote`/`p0`/`p1`（pdf 类，见 §48）。
- **发送唯一口**：浮窗的两个动作都走 `inputbar/send.js` 的 `gwSend()`（「使用 AI 编辑」= `insertRefChip` → 关窗 → `inputEl.focus()`；输入行 = `insertRefChip` + 话术 → `gwSend()`），**不得自建 ws 发送链**（探针断言 `quote.js` 内 `gws.send` 零命中）。
- **令牌互斥**：`QUOTE_REF_RE = /\[@引用:([^\]#]+?)(?:#L(\d+)-L?(\d+))?\]/g` 与 `QUOTE_REPLY_RE = /\[@引用回复:(\d+)\|([^\]]*)\]/g`（`mention.js`）各认一种引用；`MENTION_PATH_RE`（§44）只认 `[@目录:|[@文件:`；上传附件占位 `[文件:路径]` 归 `messages.js` 侧剥。三者不同名，互不吞。
- **序列化分支**（`mention.js` `serializeInput` 的 `kind==='ref'`，`refToken()`）：file 类 → `[@引用:<路径>#L<s>-<e>]`（无行号 → `[@引用:<路径>]`）；reply 类 → **锚点令牌 + 原文块**：`[@引用回复:<第N条>|<会话标题>]\n<原文>\n[/引用回复]`；pdf 类（见 §48）→ `[@引用PDF:<路径>#p<s>-<e>]\n<原文>\n[/引用PDF]`。原文夹在块里是**给模型的 payload**（回复无文件位置可查、PDF 定位不精确，原文必须进消息），**气泡里不得出现**——见下条。令牌**首尾不留换行**（留了会撑出多余行距），标题里的 `]`/`|`/换行是令牌结构字符，序列化时归一为空格（否则令牌碎裂）。
- **原文块渲染前剥掉**（`mention.js` `stripQuoteBodies()`，把回复块与 PDF 块各压回单一锚点令牌——**单一剥块入口，不得再开第三个**）：**三个渲染入口都要过这一刀**——`chat/messages.js` `userBodyHtml`（落盘气泡）、`inputbar/approval.js` `renderTransient` 的 `bodyText`（乐观气泡）与队列项 `txt`（排队 dock）。漏一个该路径就把原文摆进气泡。手法与 `[Image #N]` / `[文件:路径]` 占位剥离同族。
- **路径基准 = 会话 cwd**（`refPath()`）：`sessionCwd` 末段 === `state.workProj` → 用项目内相对路径 `state.workFile`；否则 `<label>/<path>`（工作区相对，跨项目仍命中）。保证模型 cwd 下可直接 Read。
- **回显成对**：三类令牌都在消息里还原成同族胶囊 `.mention-chip.m-ref`——file 类 `quoteRefChipHtml()`（文件 icon + 「引用自 <basename>」+ 行号，`title` = 完整路径）、reply 类 `quoteReplyChipHtml()`（会话 icon + 「引用自「<标题>」· 第 N 条回复」，与输入栏内 `.mention.ref` 的回复态同一句话）、pdf 类 `quotePdfChipHtml()`（文件 icon + 「引用自 <basename> · 第 N 页」，见 §48）；**两个入口都要接**——`mention.js` `renderUserText`（乐观态）与 `core/markdown.js` `mdInline`（落盘态）。三类都不用 `>` blockquote（`mdHtml` 支持但 `renderUserText` 不跑 markdown，两处渲染会分叉）。
- **浮窗视觉 = 浅色竖排菜单**（`.quote-pop`，用户点名「对应换成浅色」）：色值**硬编码不跟随 `--bg`/`--text` 主题变量**；上行 = `.qp-row`（标签 + 尾部 `I.dshSend` 箭头，hover 整行浅灰），下行 = `.qp-bar`（描边输入行，`--radius 10` 与菜单行同高）。旧 tab 条样式（`.qp-tab`）已删。**聚焦指示落在整行**——`.quote-pop .qp-in:focus-visible { outline: none }` + `.qp-bar:focus-within { border-color: #4176e6 }`（全局那条 `input:focus-visible` 的 2px outline + 6px 圆角与输入行几何不齐）。
- **光标落点**：「使用 AI 编辑」行落胶囊进输入栏后，`caretAfter(chip)` 把光标**折叠到该胶囊之后**（与 `mention.js insertMention` 落光标同一手法）——接着打字就是给这条引用的说明，不该插在胶囊前面。
- **浮窗定位/关闭**：`document.body` 下 `position:fixed`（脱出 `#chat-scroll` 的 `overflow` 裁剪），落点 = **选区下方**（`snap.rect` 的 `left`/`bottom`）+ clamp 回视口（与 `sidebar/recent.js` 行菜单同算法）；外部 `mousedown` / `scroll` / `resize` / `Escape` 关闭；浮窗内 `mousedown` `stopPropagation()`（不算点外部）。
- **触屏 = iOS 原生选中菜单**（模块 `inputbar/quote.js`）：触屏设备上选中文本**不弹宿主浮窗**，一律走 iOS 系统「拷贝/查询/翻译」菜单——宿主自绘选中栏会与系统菜单双框；且程序化选区压不住 iOS 原生选择手势（`pointerdown` 监听为 passive，抢跑拦不住；手指按住期间 `removeAllRanges()` 会被 iOS 重建的原生选区覆盖）⇒ 自绘引擎已撤除。**门** = `IS_TOUCH_DEVICE`（`sidebar/recent.js` 导出，含 iPadOS 桌面模式那条 `MacIntel + maxTouchPoints > 1` 判据）；`quote.js` 的 `document mouseup` 首行 `if (IS_TOUCH_DEVICE) return` 早退。**桌面鼠标路径一字不改**；PDF 预览页走 `postMessage` 桥（§48），不受此门影响。**触屏无「使用 AI 编辑」入口**（iOS Safari 不允许往系统菜单加自定义项）。
- **构建不变量**：登记进 `scripts/bundle-web-modules.ts` MODULES，区间号须排在 `__app__` 启动序列之前（顶层立即注册 `mouseup` 委托）。
- **cache-bust**：`web/sw.js` 的 `CACHE` 版本与 `web/index.html` 的 `/styles.css?v=` `/app.js?v=` 三处同值。
- **探针锚点**：`probes/probe-quote-ref.ts`（123 断言：quote.js 结构、mouseup 唤出/不拦 contextmenu/`quoteSkipNextUp`/`caretAfter`、唯一发送口 + 拼接器登记与执行序 + 从源码抽 `QUOTE_REF_RE`/`QUOTE_REPLY_RE`/`QUOTE_PDF_RE`/`MENTION_PATH_RE` 真身测解析与四者互斥 + serializeInput ref 分支与 refToken 三形态 + **跑真身 `refToken` 核令牌形态/首尾无换行/标题结构字符归一/PDF 页码（单页·跨页·无页码）** + **跑真身 `stripQuoteBodies`**（回复块与 PDF 块 → 单令牌 / 块外正文不动 / 幂等 / 三入口接线 / 旧名零残留）+ **申报动作表**（ext-card `normQuoteActions` 纯数据 + registry 登记/读取 + mgr 同点取两份申报与清理 + quote.js 合流「内置恒在同 id 内置优先」与「回发 id 不代执行」）+ **预览桥**（`quoteFrameBySource` 按 e.source 反查 / `quoteFrameRect` 坐标换算 / message 监听 / 类型判定 / e.source 守门 / pdf 快照带 frame）+ **触屏回归原生**〔自绘引擎 `quote-touch.js` 已删 / `quote.js` 引入 `IS_TOUCH_DEVICE` 且 mouseup 早退 / 旧让位守卫零残留 / 拼接器已移除登记 / 样式无残留 / 产物无 quote-touch 段 / 快照单一入口且无模块级 `quoteSnap`〕+ **网关**（`PreviewQuoteAction`/`readPreviewQuoteActions`/端点并入/字段校验）+ `renderUserText`/`mdInline` 双入口 + 行锚链〔work.js 传锚 / quoteLineOf 取锚 / 七处落锚覆盖 / `codeNums` 记源行〕+ **跑真身 `mdHtml` 核锚 = 源行号**（段落逐行/标题/列表/代码块）**与剥块后回复/PDF 令牌 → 胶囊、原文不出现在气泡** + 回归靶〔`**加粗**：` 渲染文本回查原文 = −1〕+ 默认渲染零行锚 + styles.css 选择器与浅色硬编码、聚焦指示载体 + cache-bust 同值 + 产物内嵌 quote / quote-touch 两段）。

## 48. 浮窗项目申报动作 + PDF 引用（预览页接入引用浮窗）

**能力**（2026-09-28）：项目在自己的 `<项目>/.claude/preview/preview.json` 里静态申报浮窗动作（`quoteActions` 段），宿主选中引用浮窗（§47 `.quote-pop`）打开时把申报行**追加**到内置行「使用 AI 编辑」之后；项目的**预览页**（`/preview/<label>/*` iframe）内的选区经由 `postMessage` 自报开窗，点申报行宿主只把 id **回发**该帧，**执行逻辑留在项目页面自己的运行上下文**（要调项目自己的 API 与页面状态）。**动作是纯数据**（无 path、不指向文件），与 `backend`（能力一）、`cards`（能力二）并列的第三种「项目向宿主申报界面能力」。

- **申报来源 = `preview.json` 的 `quoteActions` 段**：`[{ "id": "vocab", "title": "生成单词卡", "icon": "plug" }, …]`。`id` 必须 `/^[a-zA-Z0-9_-]{1,32}$/` 且组内唯一（非法/重名/`title` 空 → 丢，不猜不兜底）；`icon` 可选，须是 `core/icons.js` 的 `I` 表键（前端渲染时查表，缺省 `plug`）；**段缺失 = 空集**。字段校验两处同款：网关 `localGateway.ts` `readPreviewQuoteActions()` 与前端 `views/ext-card.js` `normQuoteActions()`。
- **载体复用既有拉取点（不新增请求）**：`GET /gateway/preview-cards?label=` 响应扩为 `{ label, cards:[…], quoteActions:[…] }`；消费仍在 `sidebar/mgr.js` `syncExtCards(label)` 的同一 `then` 里——`registerExtCards(...)` 与 `registerQuoteActions(label, d.quoteActions)` 同点落表，`clearExtCards()` 与 `clearQuoteActions()` 同点清理（**不变量：动作表恒属于「当前 `.preview-frame` 所指项目」**，与 EXT 卡生命周期一致）。动作表常驻 `views/registry.js`（`registerQuoteActions` / `clearQuoteActions` / `quoteActions`），`inputbar/quote.js` 的 `quoteActionRows()` 读它与内置行合流。
- **动作合流**：`quoteActionRows()` = 内置 `{ id:'ai-edit', title:'使用 AI 编辑', builtin:true }` **恒在** + 申报行**追加**；**同 id 时内置优先**（申报表里同名条目直接被略过，内置行永不因申报而变样或被删）。渲染 `quoteActionRowHtml()`：申报行前置 `.qp-ic`（`I[icon] || I.plug`，16px 灰），内置行无图标。点击分发——内置 → `quoteStash()`；申报 → `quoteRunAction(id)`（关浮窗 + `frame.postMessage({ type:'floria-quote-action', id }, '*')`，**宿主不代执行**）。
- **预览桥（三类消息，模块 `inputbar/quote.js` §5）**：预览页选区在宿主看来不可达（跨文档 `getSelection` 不达）⇒ **预览页自报**：`floria-quote-open`（`{ text, rect:{x,y,w,h}, pdf, page, pageEnd? }`，`rect` = **iframe 内视口坐标**）/ `floria-quote-close`（`{}`）；宿主回发 `floria-quote-action`（`{ id }`）。**门 = `e.source` 必须是当前在场 `.preview-frame` 的 `contentWindow`**，且按 `e.source` **反查帧**（`quoteFrameBySource`，**不取 `querySelector` 第一个**——槽位预览卡与 work 预览栏可能同时在场，取「第一个」会认到错帧）。
- **坐标换算**：`quoteFrameRect(frame, r)` = 帧内视口坐标（0,0 = 帧左上角）叠 `frame.getBoundingClientRect()` 的偏移 → 宿主视口坐标（只需 `left`/`bottom`，`openQuotePop` 再 clamp 回视口）。
- **浮窗来源扩展**：`openQuotePop(snap)` 是唯一开窗入口，两条来源共用——宿主机内选区（桌面 `quoteSnapOf`）与预览页自报。后者快照多带 `frame`（回发锚点，`quoteRunAction` 靠它；快照恒以实参传到点击那一刻，无模块级状态）与 `kind:'pdf'`、`proj`（取帧 `data-label`）。**iframe 内点击/滚动不冒泡到宿主 `document`**，宿主那两条「点外部/滚动即关」策略对帧内事件失效 ⇒ 预览页必须显式发 `floria-quote-close`。
- **PDF 引用 = 第三族引用**（`kind:'pdf'`）：位置 = 路径 + 页码（跨页 `#p<s>-<e>`，无页码退化路径）。令牌 `[@引用PDF:<路径>#p<s>-<e>]\n<原文>\n[/引用PDF]`（`QUOTE_PDF_RE` / `QUOTE_PDF_BODY_RE`，`mention.js`），胶囊 `quotePdfChipHtml()`（文件 icon + 「引用自 <basename> · 第 N 页」）。**原文必须进消息**——PDF 定位不精确、大 PDF 必须给页码提示、选中原文才是 payload（Read 工具原生支持 PDF，`pages` 参数 >10 页必填）。路径基准复用 `refPath()`（与文件引用同链）。
- **构建不变量**：动作表落 `views/registry.js`（与 `EXT` 同模块，避免 import 环），无需改 `scripts/bundle-web-modules.ts`；`inputbar/quote.js` 区间号须在 `__app__` 启动序列之前（顶层注册 `window.message` 监听）。
- **探针锚点**：`probes/probe-quote-ref.ts` §4d~§4h（PDF 令牌解析与四族互斥、refToken pdf 分支、双入口接线；动作表纯数据/同点取两份申报/合流/回发 id；预览桥按 e.source 反查/坐标换算/守门；触屏回归原生（自绘引擎已删 + 早退守卫）；网关 `PreviewQuoteAction`/`readPreviewQuoteActions`/端点并入）；网关侧另见 `probes/probe-gateway-*.ts` 相关件。

## 49. 轮次导航轨（TurnNavigator，dsh 移植）

**能力**（2026-10-02）：会话区右侧一列**短线刻度**，每格 = 一个对话轮次（= 一条开启用户气泡所辖段）。hover 弹出预览卡（提示词 50 字 + 该轮最后一个回复 120 字），点击滚动跳到该轮，当前可见轮加粗高亮。dsh `packages/client/ui-chat/.../TurnNavigator.tsx` + `turn-rail-items.ts` 的 vanilla 移植；dsh 的「未加载轮次经 seq 分页载入」在 Pj16 前端全量加载下自然省略，其余形态/交互按源码复刻。

- **数据源 = 已渲染 DOM**（模块 `chat/turn-rail.js`，唯一手改处）：`#messages` 内 `querySelectorAll('[data-t="u"],[data-t="a"]')` 按**文档序**分组——`[data-t="u"]`（data-m=段键）为轮锚，落其后的 `[data-t="a"]` 归入当前轮，取该轮最后一个为回复预览。不新增数据请求，与渲染同源。
- **挂载**：动态建 `<nav id="turn-rail">` 追加 `#chat-area`（position:relative 无形槽），absolute 定位不参与 flex 流；`index.html` 不改结构。
- **刷新驱动 = MutationObserver**（`#messages` childList+subtree+characterData，150ms debounce）：覆盖整页重建 / 增量 append / 流式文本三路，无需在各渲染出口插调用。
- **显示门**：非会话态（`#chat-area` 无 `.in-session` 或带 `.work`）、轮次 < 2、视口 ≤ 900px 任一命中即 `hidden`。
- **跳转**：`topInScroll(el)` 取锚的内容坐标写 `#chat-scroll.scrollTop`（smooth）；点击即 `stage.yielded = true`（用户导航 = 接管视口，停止 stage 两层跟随，与滚动输入同口径）。
- **scaleX 三态**（`styles.css` `.tr-mark::before`，`transform-origin: right center`）：默认 `0.6` / hover·预览 `0.9` / 当前轮 `1`；配色 `--border` / `--text-3` / `--text`。
- **构建不变量**：登记进 `scripts/bundle-web-modules.ts` MODULES，区间号须排在 `core/state.js`（messagesEl）与 `chat/stage.js`（stage/topInScroll）之后、`__app__` 启动序列（5379）之前；顶层立即 `railInit()`。
- **cache-bust**：`web/sw.js` 的 `CACHE` 与 `web/index.html` 的 `/styles.css?v=` `/app.js?v=` 三处同值（本次 v427）。
- **探针锚点**：暂无（纯前端 DOM 组件，待补 `probes/probe-turn-rail.ts`）。
