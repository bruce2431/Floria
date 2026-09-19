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

**新建流程 = 笔与项目「+」一致，先到初始化界面（空态），发送首条消息才真正建会话**：笔（rail-new/recent-write）清 `state.newProject` 回全局首页；项目文件夹行「+」仅设 `state.newProject=label` + `navigate('#/')`。**seat 三态**：空态=白底 chip 可点弹层选项目、label 显示项目全称（max-width 240px）；会话态（`#chat-area.in-session` 门控）=工作文件夹标识保留显示（按 projectScope/projectLabel 渲染、全局会话显示「全局」）但 `.locked` 锁定只读；管理/预览态挂载点不在 chat-area 自动隐藏。`gwSend` 空态分支带 project 调 `newWebSession(project)`（创建失败恢复 newProject）→ 建会话后才弹 CLI 窗口。

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

**菜单形态 = tab 内嵌展开**：选项挂 `.sess-menu`、tab 行内第二行（`.sess-item` 加 `flex-wrap: wrap`，菜单 `flex-basis:100%` 强制折行），`height 0→实测内容高` JS 过渡 = tab 高度展开动画；关闭瞬时收起。**保留不变量**：菜单只存在于浮起 tab 上（`toggleRowMenu` 先 `liftStart(row,{anim:false})` 直终态）；菜单=行子元素（mouseleave 不触发、浮起保持、mousedown 外点关）。**托管被力还原时跟随关闭**：`liftClear` 拍回动作**前**判 `rowMenu.parentElement === liftEl` → `closeRowMenu()`。

**滚轮互搏与死区根治**：`liftCool` 滚动静默期（scroll 监听置 `Date.now()+150`）必须同时挡 mouseenter 直调**与**重建重扶出口（`refreshList` 高频整列重建，滚动中每步都被拍回=「侧栏滚轮失效」）——**不变量：扶起只发生在列表静止态**（出口①rowMenu/②reLiftHash 点击语义=用户主动，保持直调）。**死区真根因=fixed 浮起行不在 `#recent-body` 的滚轮滚动链上**（Chromium 滚动链走包含块链，fixed 行直连 viewport）；根修=`#recent-body` 挂 **non-passive wheel 监听**：滚轮到达=滚动意图 → 同步 `liftClear(true)` 拍回 + `void offsetHeight` 强制 layout，让默认滚动动作在干净布局上把滚动链重新解析回容器；菜单开着一并 `closeRowMenu()`。**不变量：滚轮到达列表 → 列表回纯在流态**。

**三个点拦截修复**：`.sess-more` 点击 `stopPropagation` 会完全阻断冒泡、不触发 `navigate` → 双击；修复=单击三个点 = 切换会话 + 弹出该行菜单（同一会话）。

## 8. 两层消息流与渲染定案

**两层模型**：上层=各种气泡和 AI 消息，第二层=乐观气泡生成的占位，占位大小按屏幕计算，两层合并作为滑条依据。**新模型（占位一诞生即永恒）**：①`.pin-stage` 静态占位块挂 `#messages` 流末（暂态区之后），高度=滚动容器 `clientHeight`（诞生锁定，仅 resize/对账校准），**不随内容收缩、回合结束不自动撤**；②跟随吸底目标=**真实内容底**（`stageFollow`：`scrollTop = max(开启气泡贴顶位, 占位起点 − 视口高)`）；③唤出条件：仅新回合开启消息（web 乐观气泡 `addUser` form='bubble' / CLI 端权威新 user 经 hasNewUser 链），**会话处理中发送=排队成员不唤出**；乐观气泡唤出 `key='optimistic'`，落盘接管帧 `stageStart(el, 权威key, false)` 直终态。旧钉顶的持续吸附状态机 + 逐帧动态几何 + 三类内容几何监听 + `settleCheck` 轮询全部退役（`msg-pin` sticky、`pinReserveApply`/`roundFoldOpen`/`pinSettleCheck`/`pinMaybeRelease`/`smoothDismissPending`/img load 捕获重算/折叠 toggle 重算/折叠收起 click 接管）；`renderSettle` 保留为渲染权威出口对账（`stageSync`：块失联重挂/高度校准/气泡重定位/跟随归位），`msgAppend`/`applySegDelta`/`renderTransient` 插入锚点 `.pin-stage`。**不变量**：占位块至多一个恒居流末；占位高度只随屏幕不随内容（**且恒 = `max(0, clientHeight − paddingBottom − 脚印)`，无第二写入者**）；用户滚动=让位。

**bubble 失联链根修**：`stage.key` 存 sig（`"idx:ts"`）而渲染权威气泡 `data-m`=段起始索引（纯数字）⇒ `stageSync` 重建后重查找恒落空 → bubble 永久失联 → `stageFollow` 的 t0 退化 0。修=`stageSync` 重查找取 sig 索引部分（`":"` 前）匹配 `data-m`，sig 防错位语义保留在 key 本体；**不变量补全：t0 恒取真实贴顶位**。

**触摸让位 + 状态行单行轮转**：①**触摸不释放不摘占位**——手势进行中删一屏高占位 → `scrollHeight` 骤减 → WebKit 触摸滚动基准断裂弹回。新模型：`stage.touchHold`=手势持有期（含惯性，touchend 后 scroll 静默 500ms 判停）冻结 `stageFollow`；静默判停 → `stage.yielded=true` 永久让位（stageStart/释放复位）；tap（位移 ≤6px）不让位。②旧 pin 14 件符号全量退役 grep 零残留；`atBottom` 吸底块保留（有 `!stage.active` 守卫）。③状态行 summary 单行轮转：`liveFoldBody` tick 改**节点级原地更新**（`.think-state`/`.d-dur` `textContent` + `.d-flags` 就地替换——重建每秒洗掉扫光动画与流式预览节点=闪烁根因）；流式预览 `applyStreamPreview` 同挂 summary 一行。

**释放链与占位尺寸**：①**用户滚动输入永不摘占位**——wheel/scroll 只置 `stage.yielded=true`，`stageRelease` 仅剩视图级退出 4 调用点（renderSession / renderHome / renderMgr / openProjectPreview）。**占位生命周期 = 会话视图生命周期**。②`.think-stream` 删 `max-width` 封顶改 flex 子项 `min-width:0` 收缩充满 summary 剩余整行；保尾用 `direction: rtl + text-align: left`（删 `unicode-bidi: plaintext`——内容以拉丁字符开头时基方向解析成 LTR 会反转保尾裁切边）；`.think-stream` 用 `flex:1 1 0`（基准 0 只吃剩余空间）。③**占位尺寸公式**：高度=`max(0, clientHeight − paddingBottom − 脚印)`（`clientHeight` 含 docked 输入栏的悬浮预留，须扣 `padding-bottom`）。

**占位脚印实时化**：`lockFoot` 诞生快照会让诞生后任何内容增长 1:1 变成额外可滚动余量。根修=`stageSync` 脚印改**实时读取**（`foot = topInScroll(占位块) − topInScroll(参照气泡)`）、删 `lockFoot` 字段。**不变量：内容未超一屏时 `scrollHeight ≡ 一屏`、`maxScroll ≡ 贴顶位`**。配套：①气泡参照找回**提前到脚印计算之前**，乐观态暂态区无气泡时回落数据区最后一条 `[data-t="u"]` 权威气泡；②参照两端皆缺（重建窗口内）不写占位高度（写 0 = 钳制跳变）。

**发送瞬间「跳到上一条消息」根治**：①`stageStart` 删动画窗——**占位高度是几何的纯函数**（参照气泡定了终态就定了），写终态 + `stageFollow` 同帧归位；②`route.js` `lastU` 循环补 `&& !messages[i].injected`，与 `live.js` 归并为**同一条规则：钉顶只属于新回合开启消息，引导消息恒不钉顶**。**不变量**：占位高度恒 = `max(0, clientHeight − padBot − 脚印)`；发送事务内 `scrollHeight` 单调不减、`scrollTop` 一次落在贴顶位。探针 `probes/probe-stage-pin.ts`。

**注入吸收帧参照移交**：注入开段回合在 DOM 无 `data-t="u"` 开启气泡（注入气泡只以 `data-t="g0"` 织在段折叠体内）→ 旧回落「末条 `[data-t="u"]`」命中上一回合气泡。修：`stage.js` 新增回合权威锚解析 `guideTurnAnchor`（引导气泡 → `closest('details.done-fold[data-m]')`；该段若另有 `data-t="u"` 仍取开启气泡）+ `absorbTurnAnchor`（以**文档序**判最新回合开启者）。**禁止回落上一回合**。已知候选（未改）：`route.js` 载入钉顶对「末回合为注入开段」的会话仍钉上一真实回合。

**视口基准 dvh**：`html,body{height:100%}` 是恒定大视口（=URL 栏收起态高），iPad Safari 顶栏展开时会叠盖视口顶且底部溢出屏幕。根修=`html{height:100%;height:100dvh}`（100% fallback）。同批 `capRenderedMessages` 归一化：收拢全数组占位计数 + 剥全量替换路径挤到中部的残留，强制「至多一条占位、恒在下标 0」。

**状态行落位终局**：**`done-fold` summary 恒「正在处理·NmNs」/「已处理·NmNs」两字样**（任何状态不再轮转上顶）；思考/压缩扫光状态行落**段体尾部 `.fold-state` 容器**（与工具调用行同域、单宿主单实例），流式预览 `.think-stream` 与无响应/连接中断红标同容器。接线：`liveFoldBody(items, vacuumState, vacuumStart)` 真空态渲染帧在段尾产出状态行（工具运行态不产出）；`bindLiveFoldTimer` tick 双行独立跳字（summary `.d-dur`=段总时长、`.think-state`=距最后落盘 Ns）；红标宿主=状态行容器（真空态）或 done-body 尾（工具态）；乐观主张折叠同规则。

**状态层并入构造期拼接**：用 `sumEnd` 字符偏移回切插入状态层会错位。根治=废弃字符偏移回切，**`stateAppend` 构造期拼接**：`flushTools` 拼 summary 时直接带上状态层，仅循环后那次 flush 生效（旁白打断的收口组不带）；`stateMerged` 判定真并入，尾部无工具组→段尾独立行。

**状态层顶替概括 + MCP 名短显 + 标签省略**：①真空态并入帧 `sumInner=''`，summary 只渲染状态层，工具明细点开仍在、回合收口后恢复完整概括；②`toolMeta` 补 `mcpShortName`（`mcpInfoFromString` 的 `split('__')` 取 tool 段，无 tool 段退回 server 名；仅显示层，权限匹配与 `data-name` 仍走原始名）；③`.tool-fold summary .tf-label` 补 `min-width:0 + nowrap + ellipsis`（`.tl-text` 同配方）。

## 9. 其它渲染与显示

**用户消息图片渲染**：链路 = ①源码权威导出 imageId 化（`conversationDisplay.ts`：`DisplayBlock.imageId` = pastedContents id = `image-cache/<sessionId>/<id>.<ext>` 文件名主干）→ ②网关字节端点 `GET /gateway/image-cache/<sessionUuid>/<id>`（readdir 解析扩展名，**`private, no-cache`**，受 token/cookie 保护）→ ③前端 `userBodyHtml`（剥 `[Image #N]` 占位）+ `userImgsHtml`（`.msg-imgs` 在 `.body` 后=气泡框外正下方右对齐；img `data-ph` + `onerror`：**图未落盘时替换为 `[Image #N]` 裸文本不出破图**——`cleanupOldImageCaches` 会删非当前会话缓存，404 是常态）。**两气泡根修**：`normalizeMessages` 把「text+image」拆成两条，web 原样输出即两个气泡；`filterConversationForDisplay` user 分支末尾重组——image-only 且带 imageId 且前一条真人 user 文本含对应占位 → 并回前一条（工具截图 tool_result 场景自然不合并）；三链路同享同一函数。样式 `.msg .msg-imgs .msg-img`（上限 240px + 单击 lightbox，`ensureLightbox` 单例 + document 级委托，z-index 1200）。**错图回卷根修**：前端渲染清零重扫 `live.maxImgId`，视图丢历史 image 块即回卷复用 1 号 → CLI `storeImage`（open 'w'）覆写 + 网关钉旧字节 = 新气泡显旧图。双修：①分配器**单调不回卷**（id 唯一性是分配器不变量）；②网关字节端点 `private, no-cache`。诊断法：转录 `imagePasteIds` 撞号 + image-cache 单文件 mtime，离线跑 `filterConversationForDisplay` 验投影完整性（探针 `probes/probe-imgid-*.ts`）。

**变更卡文件列表显示相对启动根路径**：网关 `readSession` 取转录记录自带的 `cwd`（会话进程启动根：CLI=exe 目录=项目根、web 笔=全局根、web 项目=该项目根）随载荷附出；前端 `relFromCwd()` 把 fileChange 绝对路径（`\`→`/` 归一 + 大小写不敏感）剥掉启动根前缀显示相对路径，不在根下/无 cwd 回退 basename；`.ch-file` 加 rtl 方向技巧（溢出省略头部）。仅显示层——变更聚合/去重 key 仍用绝对路径，实时与历史两路同走 `renderChangeCardHtml`。

**后台任务通知居中气泡化**：回合以 `end_turn` 收尾后，后台 Bash 任务完成以 `<task-notification>`（`role:'user'`，`origin.kind='task-notification'`）落盘注入唤醒，AI 续跑后再次 `end_turn` 收尾 → 同段两次正式发言（数据忠实）。定案形态：**通知以居中浅灰气泡按时序堆叠**——`conversationDisplay.ts` isTaskNotify 分支恒下发 `pushSystemHint('后台任务完成：'+summary)`（**移出 SHOW_NON_INTERRUPT_HINTS 总开关单独恒显示**），web 复用 `role:'system'` 居中行渲染；`.msg.system` 为浅灰气泡。附带：`normalizeMessages` switch 无 default，元记录直喂会崩 `isNotEmptyMessage`——网关 `readSession` 的五类型前置过滤即为此设，任何新消费端直读 jsonl 必须带同款过滤。

**限流降级提示居中灰 + resume 哨兵全端剔除**：①统一限流降级不再发 `NO_RESPONSE_REQUESTED` 静默占位——改 `rateLimitFallbackNotice(model)` 生成「模型用量已达上限 · 已切换备用模型（model）」，仍记入会话历史；CLI 端 AssistantTextMessage 前缀匹配居中灰渲染（置于 switch **之前**——动态文本不进精确 case），web 端经投影前缀命中转 `pushSystemHint`；②resume 补位哨兵（`conversationRecovery` 追加的 `NO_RESPONSE_REQUESTED` assistant 占位，数据层保留）权威投影层 assistant 分支按精确文本整条剔除（CLI 原有 return null，web 侧曾漏出被渲染成回复气泡），历史回放与实时增量同治。

**审批栏正文按工具语义渲染**：`prettyToolInput(toolName,input,desc)`（`inputbar/approval.js`）：Edit/MultiEdit（`input.edits[]`）=文件名 + **红/绿两段文本 diff**（`.appr-diff`）；其余工具=**中文字段标签 + 值**列表（`FIELD_LABELS` + `TOOL_FIELD_ORDER`，未列字段追加在后）；命令/正文类字段（`command`/`content`/`new_source`/`prompt`）恒落 mono 代码块（`.appr-pre`），多行/超 140 字符值自动升级成块；`boolean true`→「是」，`false`/`null`/空串不渲染；与卡头 `a.description` 逐字重复的字段不再渲染。纯 web 展示层：进料仍是 CLI `sendRequest` 原样透传的 `a.input`。探针 `probes/probe-approval-pretty.ts`（含转义/XSS 断言）。

**审批栏入场动效**：`.appr-in`（`@keyframes apprInUp`：`opacity 0→1` + `translateY(10px→0)`，220ms ease-out）与高度长出（320ms）**同帧起播**；卡面本体在 `.bar-takeover` 态不退场 ⇒ 内容淡入不露首帧空洞；10px 位移落在卡片底部内边距内 ⇒ 按钮行不被裁角；**只在「普通输入栏 → 卡片」那一次播放**（`showTakeover` 的 `firstShow` 门）。

**审批栏高度视口预算 + 收起并行式**：①**高度**：`.appr-body` 改视口预算 `max-height:calc(100vh - 260px)`（`100dvh` 后置声明；预算＝黄条带 38 + 按钮行 60 + 底距 22 + 聊天区至少可见 ~140）。②**收起 = 单一时间轴并行**：`collapseTakeover` 并入 `clearTakeover`，同帧起播三件事——`.appr-out`（`clip-path:inset()` 底边插值 + opacity，170ms，须 ≤ `HEIGHT_MS`=320ms）、`.bar-collapsing` + 撤 `.bar-takeover`、`.bar-reveal`（170ms）。**几何关键**：收起期卡片仍走 `.composer-growing` 的 `absolute bottom:0`（底边钉原位）⇒「卡自下而上被削掉」与「下方同步露出输入内容」同方向交叉过渡。常量：`HEIGHT_MS` 须 = `styles.css #input-bar` 的 `height 0.32s`。配套不变量：`syncTakeoverPad` 在收起启动同帧清零（须在 `wrapAnimating` 置位前直接写）；`cancelClose()` 在新 takeover 到来时撤三态残留；`showTakeover` 先清 `inputBarEl` 内联高度再实测；`finishClear` 复位 `wrapAnimating/wrapClosing`。**审批卡是同链唯一在场者**（只读 question 卡已移除，见 §17）。

## 10. 内存优化链

**P1 渲染历史上限（REPL.tsx）**：`capRenderedMessages` 把 React messages state 收敛为尾部 200 条（`MAX_RENDER_MESSAGES`），更早消息替换为单条归档占位（计数从占位文案自身解析=幂等）；cap 在 setMessages wrapper baseline 判定之后落 ref/state；初始 useState 同样 cap。**语义变化：transcript 虚拟滚动回放同样只见窗口**（完整历史权威在 jsonl）；数据层不经 cap。

**P2 增量上报（conversationDisplay.ts + localGateway.ts）**：CLI 侧 `displayCacheBySession`（键 `${sessionId}:${mode}`，存已上报投影序列 + lastModel 末态 + 失步标）做「水位对齐 + 尾部窗口投影」——对齐键为稳定键 `sid`，`filterConversationForDisplay` 新增可选 `initialLastModel/lastModelOut`，每轮发 `{sessionId, messages, base}`；网关 `/gateway/conversation` 按 base 聚合为全量，响应带 `cached` 长度，CLI 校验不符（网关重启/sweep 失步）置 needFullSync 下轮全量直传对账。P1×P2 联合：单轮构建/序列化/传输峰值恒定（≤200 条投影）。已知名义缺口：CLI 进程重启后 cache 空且窗口首条对不上网关缓存时走窗口全量替换（web 前缀短暂缺失，jsonl 权威在盘）。

**P3 web 注入图压缩前移（gatewayClient.ts）**：`compressPastedContentsFromImages`（WS send 分支）对 >2MB 原图先 `compressImageBuffer` 再入 pastedContents；CLI 本地粘贴链的执行时 resize 原样保留。

**P4 结论（无代码改动）**：fork ink 为双缓冲 screen-blit 架构，内存驻留主体=React 树（messages state），已由 P1 有界化覆盖。

## 11. 教训（勿忘）

①引导消息「吞消息/顺序颠倒」一类渲染 bug 先查 jsonl 物理落盘位置与用户感知顺序的差异（queue-op 消费时序），不是前端渲染逻辑先坏；②折叠唯一性破坏（多 fold）会让钉顶/计时/增量重建锚点全链错位——「已处理永远在第一个消息下」是结构性不变式，任何新渲染方案不得引入第二个 done-fold；③对生成好的 HTML 字符串做偏移切片插入是脆弱机制，插入内容应在构造期随模板拼出。

## 12. 前端模块化架构（web-src/）

**定案**：`src/gateway/web-src/` 下 22 个 ESM 模块，**web-src/ 是唯一手改处**；构建时 `scripts/build.ts` spawn 自写拼接器 `scripts/bundle-web-modules.ts` 把各模块按切割区间行序拼回单 IIFE 写 `web/app.js`（生成物勿手改）。产物文件名/引用不变，sw CORE、`?v=` cache-bust、gen-web-assets、网关静态路由全链零改动。

**打包器定案——自写拼接器（非 Bun.build）**：Bun.build 按依赖图**重排模块执行序**，而多个模块的顶层立即执行代码引用 `state.js` 的 const → TDZ 崩溃；且 IIFE 顶部切割区间外的 `const $ = (id) => document.getElementById(id)` 不属任何模块、切割即丢。根治=拼接器按 MODULES 表**原区间行序**拼回。三机制：**锚点检索**（区间首行=节标题/独特函数签名，手改增删行不破坏拼接）、**marker 尾界**（`// —— 跨模块写入口`/`export {` 首现处）、**首行防呆**（锚点前必恰有 1 分隔空行）。setter 跟随定义模块末区间输出（0 缩进 function 声明，hoisting 无 TDZ）。

**模块布局**：
- `app.js` 入口=import 群 + 事件绑定 + 启动序列
- `core/`：icons（SVG 图标）、state（元素引用/共享可变态/toast/媒体工具）、char（角色形象）、markdown、sessions（会话映射）、live（SSE 会话事件）、gateway（WS 连接/审批中继）、auth（门禁认证/设备认证）、viewport（可视视口/键盘几何）
- `sidebar/`：mgr-data、recent(最近会话/拖宽)、mgr（插件/项目/模型三界面 mgr-tabs）、bubble-search、neurons（神经 tab）
- `inputbar/`：ctx-meter（ContextMeter/纯文本粘贴）、mention（@提及）、commands（命令菜单）、model-select（模型选择/状态域）、approval（审批卡/回合态/takeover/任务浮窗）、images（图片附件 + 文件上传）、send（gwSend/syncGwSend）
- `chat/`：route（路由渲染）、messages（消息渲染）、stage（钉顶占位/stage 机制）

**跨模块可变状态 = SETTERS 机制**：14 个跨模块写入的 let（`ALL`/`connUp`/`gateAwait`/`gateVerified`/`sessionCwd`/`takeover`/`turnLive`/`btnMode`/`MODEL_CUR`/`modelUserPicked`/`pendingUserMsgs`/`firstSendHash`/`lastNavHash`/`approvalPending`）在定义模块尾生成 `export function setX(v){X=v}`，写入方一律调 setter（import 绑定不可赋值=ESM 硬约束）；读跨模块符号走 import（函数级循环 import 安全：hoisting + live binding）。

## 13. 排队消息催办：点击排队气泡打断当前思考

**语义**：点击置底排队区某条气泡 = 「这条我等不及了」。效果**与「模型自然答完后排队消息被纳入」完全一致**——该消息作为注入引导织进**当前**折叠体，模型在**同一回合**里接着答它。明确排除：①**不是新的乐观气泡**（不产生新回合）；②**不是中断**（不走 `onCancel`、无撤回/restored 链）。生效时机：**只在模型生成（思考）时打断**；模型跑工具时点击不动它。

**引擎侧（`query.ts` + `messageQueueManager.ts`）**：既有中链 drain（每轮工具循环开头把队列里的 prompt 命令转成 `queued_command` 附件）是「纳入」的唯一路径。**不能用回合级 `abortController`**——它污染本轮之后所有迭代且直接结束回合。故新增**生成级断流**（不变量：**队列非空 且 当前有一次生成流在飞 且 该生成尚未产出完整 `tool_use` 块 → 断流**）：①`messageQueueManager` 加催办标记 `queueNudgeRequested` + `requestQueueNudge()/peekQueueNudge()/consumeQueueNudge()` + `getDrainableQueuedPrompt()`（可催办对象判据＝`mode:'prompt'` ∧ 非斜杠 ∧ 主线程 `agentId===undefined`），并在 `notifySubscribers()` 里「队列清空即失效」；②`query.ts` 生成流 `for await` 循环体首行 `if (isMainThread && toolUseBlocks.length === 0 && peekQueueNudge()) break`（`toolUseBlocks` 是**本迭代**数组，此处为 0 时断流**不可能**留下孤儿 `tool_use`）；③收口在 `if (!needsFollowUp)` 之前：`if (!needsFollowUp && consumeQueueNudge()) needsFollowUp = true` ⇒ 模型同一回合答这条消息。一次性消费 ⇒ 不会无限断流；队列清空即清标记 ⇒ 不会跨回合误伤。

**链路**：web `.q-item` 点击（事件委托，`cursor:pointer` + `title` 提示）→ `/clients` WS 发 `{type:'queue-nudge', sessionId}` → 网关按会话精确路由（未在线回 status；**不 resumeAndDeliver**——离线会话没有生成流可断）→ CLI `gatewayClient.ts` → `src/bridge/gatewayQueueNudgeHandle.ts`（模块级句柄）→ REPL 注册 handler 判活两条（缺一不可）：**①有在飞生成**（`abortController` 存活）、**②队列里有可 drain 的用户消息** → `requestQueueNudge()`。headless 无句柄 → 静默忽略。

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

**规则**：两态 body 必须走**同一渲染函数**（「乐观开启气泡与落盘气泡同构」不变量）。乐观（`renderTransient`）改 `mdHtml(bodyText)` 与落盘（`chat/messages.js` `userBodyHtml`）同源；`renderUserText` 保留——排队区 `.q-item` 仍用它（排队项自带 `<p>` 包裹，形态本就不同）。**验证**：`probes/probe-user-bubble-parity.ts`（两路径结构差异取证 + 样式 `<p>` margin 证据 + 结构断言两处 body 同源 + 同文本同 HTML）。

## 26. 「神经」tab：神经元选择卡片 + 三级节点图

侧栏第 4 个管理 tab（`data-mgr="neurons"`），与插件/项目/模型并列。前端模块 `web-src/sidebar/neurons.js`，`mgr.js renderMgr` 的 neurons 分支分发，`state.mgrView.neuronSel` 区分层级并持久化。

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
- **修法 = 单源出口**（`chat/route.js` `clearSessionSlots()`）：清槽清单（`lastMsgLen`/`localMessages`/`deltaSeq`/`queueRemote`/`curUuid`/`tasks`+`renderTaskDock`/`streamText` + `clearTakeover` + `renderCtxMeter(null)`）收敛为一个函数，三个「离开会话视图」入口统一调用——`renderHome`（首页空态）、`renderMgr` 顶部（一次覆盖四分支，含神经 tab）、`openProjectPreview` 硬挂载分支。会话态的重新接线仍在 `renderSession`/`refreshSession`（唯一重建点），本函数不涉。
- **守护不变量**：任何进入非会话视图的入口必须先 `clearSessionSlots()`；清槽清单只有一份（新增入口调它，勿就地补行）。**探针**：`probes/probe-web-view-slots.ts`（只读，27/0）——源码结构断言（三入口接线 / 清槽早于 `mgr-on` / 各模块内联清槽行数受控 / 产物 `app.js` 含定义与 ≥3 调用点 / sw 与 `?v=` 同步）+ 行为真值表（守卫表达式从 `core/live.js` 提取后喂 `(curUuid, ev.session)` 四组合）。

## 35. 键盘弹出适配：应用锚定可视视口顶，键盘只压缩「消息流底界 + 底栏」

**原理**：`html` 高 = `100dvh`，键盘**不改变布局视口**（只压可视视口），浏览器为露出焦点底栏把**可视视口整体上顶**（`visualViewport.offsetTop > 0`）——移动的是视口而非布局，故必须显式补偿。

**唯一真源 = `visualViewport`（前端新增 `core/viewport.js`）**：
- **应用锚回**：`--vv-pan = vv.offsetTop` → `#app { position: relative; top: var(--vv-pan) }`，应用恒贴可视视口顶（侧栏、背景层零位移）。
- **消息流底界**：`--kb = html.clientHeight − vv.height` → `#chat-scroll { margin-bottom: var(--kb) }`；键盘在场时调 `stageSync()` 按新几何重算两层占位。
- **底栏**：会话态 `#input-wrap.docked { top: calc(100% - 22px - var(--kb)) }`；空态底栏按实测自然底算 `--kb-lift`（`stageEl.top + wrap.offsetTop + wrap.offsetHeight/2 + 22 − vv.height`）→ `#empty-hint #input-wrap { transform: translate(-50%, calc(-50% - var(--kb-lift))) }`。键盘在场 `body.kb-open #input-wrap { transition: none }`。
- **判定**：`editing = document.activeElement` 是 `contenteditable`/`INPUT`/`TEXTAREA`/**`IFRAME`** 且 `vv.scale ≤ 1.01`（捏合缩放同样压低 `vv.height`，必须排除）；安卓布局视口随键盘同步缩 → 自然不重复抬。**`IFRAME` 分支不可省**：项目预览的站点页面跑在 `.preview-frame` 里，焦点进入 iframe 文档时父文档 `activeElement` 就是该 `<iframe>` 元素本身（浏览器标准行为）——不认它则预览内打字恒非编辑态，`kbGeometry` 直接返回 `{0,0}`（`--vv-pan`/`--kb` 都不写），键盘每次上顶可视视口都无人抵消 = 每敲一个字整页上下跳。放宽判定不引入空位移：位移量全由可视视口实测量算，无键盘时 `kb`/`pan` 天然为 0。事件：`vv.resize`/`vv.scroll`/`orientationchange`。
- **相位**：拆两段——**同步段 `syncKeyboard`**（`--kb`/`--vv-pan`/`body.kb-open`/`window.scrollTo(0,0)` 直接在事件回调里写，只写样式属性、不读元素布局；上顶是帧级动作，经 rAF 转手必晚一帧=「侧栏被顶起一瞬间后回弹」）＋**延迟段 `settle`**（rAF 合帧：`--kb-lift` 实测 + `stageSync()`，二者连续量晚一帧不可见，且逐事件 `getBoundingClientRect` 会强制布局）；键盘高经模块内 `lastKb` 交接。
- **覆盖层同源锚定**：`#search-overlay` / `#risk-modal` / `#rename-modal` 移入 `#app`，改 `position: absolute; top:0; right:0; bottom: var(--kb, 0px); left:0`：定位源与 app 壳体同一，覆盖层不再各自复刻视口公式；对话框高度上限从视口单位改容器百分比（`74vh → 74%`、`calc(100vh - 48px) → calc(100% - 48px)`）。
- **底栏子件同源收口**：底栏上**向上弹出**的子件共六个（七处上限声明）——`#mention-pop`、`#cmd-pop`、`#task-dock .td-panel`、`#proj-pop`、`#model-pop`、`#ctx-panel`——高度上限一律 `max-height: min(<设计上限>, var(--bar-room, <设计上限>))`。`--bar-room` 由纯几何函数 `popRoom(barTop, vvTop, margin)` 在 `settle` 内量得（`wrap.getBoundingClientRect().top − vv.offsetTop − 20`，即「底栏上沿离可视区顶多远」）。**取底栏上沿量是刻意的**：栏内 chip 系锚点更低、真实可用更多 ⇒ 本值对它们是**安全上界**，一个变量覆盖全部七处。**不变量：`--bar-room` 恒对应底栏「到位后」的位置**——触发侧除 `vv` 事件外另两处：`ResizeObserver` 观察 `#input-wrap`（**尺寸类**变化：多行长高/接管卡换高）＋ `transitionend`（`e.target === wrap`，**位移类**变化：键盘收起 `--kb` 归零、空态↔会话态迁移都让 `top`/`transform` 走 0.55s 过渡，而 `settle` 在事件后一帧读 `rect` 只能拿到动画中间值 ⇒ 量出的余量被钉在「收起前」的小值且再无事件重量，弹层上限随之永久卡小、内容被 `overflow` 截断；过渡结束即底栏到位，此刻重量才拿到终值）。超上限时滚动下沉到弹层自身（`overflow-y: auto` 或内部 flex 子项 `min-height:0`）。
- **边界**：无 `visualViewport` 时 `initViewport` 直接返回，行为与改前一致；模块挂进拼接表（`scripts/bundle-web-modules.ts`，区间号仅作执行序，排在启动序列之前）。**探针**：`probes/probe-keyboard-viewport.ts`（只读，73/0）——结构断言（拼接表接线/启动序列调用/同步段无 rAF 转手且不读元素布局/只量算段走 rAF/四个变量全部消费点/三件覆盖层在 `#app` 内且收 `--kb`、无 `position:fixed` 残留/对话框不用 `vh`/六个子件的七处上限声明均收 `--bar-room`/`--bar-room` 的尺寸类与位移类触发齐备/`#empty-hint` 自身不含 `--kb`/产物 `app.js` 含 `IFRAME` 判定）+ 行为真值表（`kbGeometry` 与 `popRoom` 均从源码提取后喂 10 组 + 5 组；`isEditing` 经 `new Function('document', …)` 注入打桩喂 6 组：`IFRAME`/`INPUT`/`TEXTAREA`/`contenteditable`→true，`BUTTON`/`null`→false）。

## 36. 无当前会话态统一为空串：乐观气泡不再「先闪现后消失」

- **不变量**：`state.currentHash` 的无会话态恒为 `''`（与 `firstSendHash`、乐观项 `pendingUserMsgs.hash` 同一约定），**不得再引入 `null``**——乐观项归属守卫、事务收口、主张计时起点 `claimStartTs`、撤回链 `inCur` 命中都押在这一个表示上。`falsy` 用法（`!state.currentHash`）不受影响。
- **五处赋值点**：`core/state.js` 初值、`chat/route.js` 的 `route()`（非 session 路由分支）与 `renderHome`、`sidebar/mgr.js` 的 `renderMgr` 与 `openProjectPreview`（硬挂载分支）。判定侧一行未动即全部有效。
- **探针**：`probes/probe-optimistic-hash.ts`（只读）——源码层断言五处赋值点均为 `''` 且全 `web-src` 无 `currentHash = null` 残留、`addUser` 写入即 `state.currentHash`、生成物 `app.js` 同步。

## 37. 用户图片渲染 id 双来源：模型识图能力不影响图片显示

- **不变量**：**模型是否识图只决定图片发不发 API，不决定界面渲不渲染图片**。图片始终显示，`（当前模型不支持识图，已忽略图片）`提示（`processUserInput.ts` 在非识图模型下追加进消息文本）作为普通文本一并保留。
- **id 双来源**（`chat/messages.js` `userImgsHtml`）：①`blocks[].imageId`——识图模型，CLI 将 image 块附进消息 content，display 链（`conversationDisplay.ts`）按 `msg.imagePasteIds` 对位产出；②文本里的 `[Image #N]` 占位——非识图模型下 CLI 丢弃 image 块（`processUserInput.ts` 的 `skipInputImages` 分支），display 链无 imageId，此时回落占位符取 id。两条路拼的 URL 相同：`/gateway/image-cache/<会话uuid>/<id>`。
- **落盘与鉴图解耦**：`storeImages`（`utils/imageStore.ts`）在 `supportsVision` 判定之前无条件执行，故非识图模型下图片同样落在 image-cache、按 `pastedContents` id 命名——这是双来源能共用同一 URL 的前提。
- **占位符剥除条件**（`userBodyHtml`）：有 imageId 块时按 id 精确剥（原行为）；无 image 块时全剥 `[Image #N]`——否则占位会以裸文本与渲染出的图重影。
