# 源码核心机制（core）

> 本文件属 `docs/` 文档库。
> 官方源码重构快照 2.1.87（bun + ink + React，入口 `src/entrypoints/cli.tsx`），官方文档不适用。
> 路径均相对 `Pj16-CodeAgent构建/_agent-src/`。姊妹件：**术语 → [glossary.md](glossary.md)**；**构建/flag → [build.md](build.md)**；**规则标准 → [standards.md](standards.md)**；**网关服务 → [gateway.md](gateway.md)**；**web 链路 → [web-ui.md](web-ui.md)**。改动以下任一机制时必须同步更新本文。

## 便携配置根（`envUtils.ts`）

`CLAUDE_CONFIG_DIR` → exe 旁 `.claude/`（带 `.claude-portable` 等标记）→ 逐级向上找 `.claude-portable` → 兜底 `~/.claude`。`.claude/.claude-portable` 必须留在 `@WrokSpace` 根（规则约束见 [standards.md](standards.md) §3）。

**裸机初始化**：TrustDialog「Yes, I trust this folder」yes 分支调 `maybeInitPortableRoot()`（`envUtils.ts`）——无 env、exe 邻接无 `.claude/`、向上无标记（=本轮恰落 `~/.claude` 兜底）时，于 **exe 邻接**（`dirname(process.execPath)`，非 cwd——walk-up 从 exeDir 出发，cwd 建标记会死）建 `.claude/.claude-portable` 空标记，**下一轮启动**第 2 步命中生效（初始化=写标记，非运行中热切换；首轮 trust 记录留旧根，第二轮需再点一次 yes）。`exeDir===homedir()` 或邻接已有 `.claude/` 不动；失败 throw 由调用方报，不阻断 trust。本机 `CLAUDE_CONFIG_DIR` 恒设，恒不触发。

## 会话/记忆项目级平铺

会话 `<项目>/.claude/projects/*.jsonl`、自动记忆 `<项目>/.claude/projects/memory/`；subagent 转录按 `<sessionId>/subagents/` 子目录存（正常设计）；项目身份用 `getProjectRoot()` 而非 `getOriginalCwd()`。存储布局规范 → [standards.md](standards.md) §2.1。

## 插件/skill 双发现（`pluginLoader.ts`）

`.claude-plugin/plugin.json` → 插件（根 `.mcp.json` 自动注册，工具命名空间 `mcp__plugin_<插件>_<server>__*`）；`SKILL.md` → skill（`/<插件>:<skill>`）。会话启动一次性加载，改动重启生效。注册标准 → [standards.md](standards.md) §4-§5。

## feature flag

编译期 `feature('X')` 裁剪，只在 `if` 条件里直接调用才能 tree-shake。旗标逐条审计 → [build.md](build.md) §2。

## Changelog（`releaseNotes.ts`）

源=`changes.md`，启动同步进 `.claude/cache/changelog.md`（会被覆盖，**禁手写**）。标准 → [standards.md](standards.md) §8。

## 沙箱权限（`permissions/`）

allow/deny/ask + defaultMode 兜底；路径匹配 gitignore 语义（`@/`=便携根、`~/`=home）；deny 硬拦截。工作区两档权限模型（Pj16 主控档审批制，其余项目 deny 锁死）→ 工作区级 CLAUDE.md「工作区沙箱协议」。

## 网关缺失自愈 + 日志落盘

1. **自愈**——`gatewayClient.ts` `probeAndConnect()` 探测网关不在（`/gateway/health` 失败）时，经 `feature('PRIVATE_GATEWAY')` 门控动态 import `commands/server/server.ts` 的 `ensureGatewayAutoStart()` 自动 detached spawn 独立网关（60s 节流；`isGatewayUp` 在→跳过；端口被非网关占用→**静默放弃不强抢**【自动路径禁杀进程】；token 继承盘上 `.claude/gateway/token`，无则随机），spawn 后下轮 PROBE_RETRY(10s) 自然接续——网关 crash/空闲回收退出不再需要手动 `/server on`。
2. **日志**——`spawnGatewayProcess()`（`/server on` 与自动拉起共用）：网关进程 stdout/stderr 落盘便携根 `.claude/gateway/gateway.log`（5MB 截断轮转），crash 可取证；手动前台 `exe --gateway` 仍直出终端。
3. **排查第一现场**：系统 commit 内存临界（固定页面文件 + 多个 cli-dev 进程各 1.5~3.7GB private）时，web 端首屏全量渲染的内存尖峰可触发多进程连锁 crash（Windows 不挑进程，谁撞上分配失败谁死）——查 `gateway.log`；系统层根治=页面文件改自动管理（用户操作）。

## 神经元内置检索/记忆（NEURON_RAG，默认开）

`src/tools/neturon/` 16 件纯进程内置（引擎核心+工具层，无 Python 子进程），`feature('NEURON_RAG')` 进 build.ts defaultFeatures。

**双层根扫描发现**：cwd 根 `<cwd>/.claude/neturon/` + 全局根 `<configHome>/neturon/` + RAG_DATA_DIR 追加；目录即注册（含 config.yaml + l2.mem/mem.db），id=person.id 跨根唯一，注册表 10s TTL 缓存；仍为旧 mem.json 的目录不注册、经 neuron_list 报 `pending_migration`（含迁移提示）。

**存储层 DB 化**：`db.ts`（bun:sqlite 零依赖）三表统一 schema——`l3.raw/<来源>/message.db`（7 列）/`l2.mem/mem.db`（memories 7 列：memory_id/revelant/blocks/source/core_file/supersedes/deprecated_by；无 confidence/half_life/created_at 列）/`l1.cog/precog.db`（8 列，纯追加+标注 UPDATE）；缺字段=NULL、时间编码进 id 无独立 time 列（idTime/makeMessageId）、busy_timeout=5000 防双前端写碰撞；content/summary 不落库由 blocks 派生（deriveEntryText）→ embeddings.npy 保持二进制对位、迁移零重建语义（折叠行序变化时全量重编码，embedder encode 分批 32/批防 ONNX OOM）；cog_graph.json/community.json/cog2.json 快照 JSON 保留。旧 JSON 迁移三件（mem 嵌套 men/sem→平铺 / cog precog_records / message 重编 id 返回 id_map 供 revelant 联动）。

**检索** = BGE 向量（@huggingface/transformers + Xenova/bge-small-zh-v1.5 ONNX，懒加载动态 import，编码前预小写归一化对齐 Python 生产路径，模型缓存 `<全局根>/cache/models/` 首跑 hf-mirror 下载 91MB）+ Intl.Segmenter 关键词加权（权重 0.70、读全文不受截断影响）+ 自动扩 k + precog 写入；索引缺失/与 mem.db 行数不一致直接报错（无降级）。**写侧** remember add/update（supersede 纠错，先算后写+失败回滚）——**编码恒增量**：只算 npy 尚缺的尾部行（常规「追加 1 条」是特例；直写 mem.db 造成的行数漂移按缺失条数 O(K) 一并补齐，Neuron-Pj16 漂移 4 行实测 740ms），全量重编码不在写入路径上，只剩 npy 缺失（建库）与行数多于 db（删行/行重排）两处。

**l1.cog 认知层形成侧**：`neuron_cog` ops 工具（action=build_graph 批折叠建图，含防假标注门禁——pre 记录 description/accuracy 空则拦截，fill_precog 合法集 {true,revelant,false} / detect_communities 多分辨率 Leiden——本体 `leiden.ts`，leidenalg 实图对照 ΔQ≈0；community.json modularity 复刻 igraph 无权 γ=1 语义，加权 Q 以 q_weighted 另返回）；**社群命名** `cogname.ts`（`neuron_cog action=name_communities`，链末端=detect_communities 之后）：默认分辨率各社群 → LLM 上位概念命名重写 `l1.cog/cog2.json`（记录形状：cog2_id=C{ts}_{nn}/name/confidence/description/members/member_names/community_size/community_density/resolution/reason；旧文件 .bak；消费方 = retriever cognitionRoute 概念 cos（embedCogCache 编码 name+desc）+ getCogContext 关键词 name×2/desc×1 ≥1 命中 + neuron_list cog2_count）。LLM 配置 = config `llm` 段 provider/model/temperature，**密钥不入 config**——凭据单源 = 全局根 credentials.json `providers.<provider>`（与 WebSearch 同一惯例；Anthropic 协议 `/v1/messages` 直调）。对 Python 两处有意偏离：① 无 size 2~6/密度硬门（只尊重 community.min_group_size，异质与否交给模型 name=null 拒绝语义）；② 成员证据取 mem blocks[0] 检索锚头部 60 字 ×≤2。运行期实测定案：glm-4.6 经 anthropic 端点回 thinking 块且计入输出预算（max_tokens=2000 防 JSON 被思考截断），**社群命名用 glm-5.3-flash**；批量社群间 30s 节奏 + 429 等 30s 重试 ×3（bigmodel 账户级限频，等窗即恢复）。

**认知图形成 = 纯标注驱动（主动偏离 Python）**：节点归并判据 `sim = jaccard(true 集) ≥ cog.merge_threshold(0.50)`、边权 `weight = cog.w_true_assoc(0.40)·jt + cog.w_revelant(0.45)·rv`——query/keywords/blocks 余弦三元全部移除，`edge_filter.no_jt_penalty` 随之删除。连带结构简化：`coggraph.ts` 整链不再需要嵌入（encode/embedder/segment 依赖移出本文件）、节点不持久化 `merged_from` 与 `true_count/revelant_count`、边不持久化 `cq/ck/cb`；config 删 7 键并显式补 `precog.ttl_days: 90`。**语义改判 = cog 即事实层**：build_graph 永不修正既有节点记忆集（只并集折叠或建新节点，节点集合只增不减），发现错误直接改 cog 条目；precog 降级为「收件箱」（pre 必留 = 新节点入口 + 待标注队列 + 防假标注门禁载体，consumed 由 `precog.ttl_days` 回收）。完备加权图仍照 Python 原设计落盘（C(n,2) 条全写，仅 weight>0 的进 Leiden）。**Python quirk 保真勿「修正」**：`partition.q` = igraph VertexClustering.q 无权 γ=1 模块度。

**注册与名册**：tools.ts `feature('NEURON_RAG')` 门控 require，recall/remember + ops 四件（list/source/fill_precog/cog，shouldDefer）紧跟核心读写组；名册经 prompts.ts dynamicSections `neuron_roster` 注入（cwd 根正文上限 8 + 全局根指针行）。

**Neuron-Pj16 项目库（三层齐备）**：cwd 根 `.claude/neturon/neurons/`，person.id=PJ16。① `l3.raw/LOG/` = LOG.md 原文全文（**真移动**——项目根不再有 LOG.md）+ `message.db`（每条目一行，`message_id=PJ16LOG_{YYYYMMDD}_{HHMMSS}[_seq]` 与 mem 条目 _seq 一一对齐，content=条目全文、source='LOG.md'）；② `l2.mem/mem.db`（`memory_id=PJ16_MEM_时间戳确定性生成`，source='LOG'（迁移产物）/'MEM'（活写入））+ `embeddings.npy [N,512]` + `index_config.json` 规范三字段 `{model_name,total_entries,embedding_dim}`（无 encoded_ids——该字段仅是 retriever 行数不齐时可选对齐口）；③ `l1.cog/` 认知层。**revelant 定案（照真身库惯例）**：迁移产物首元素 = 该条目在 raw 层的 message_id，其后为相关会话 jsonl 路径 + 该条目修改文件路径（证据指针数组，全相对项目根；jsonl 按首末行 timestamp 区间匹配，不迁移会话仅索引）；'MEM' 活写入条目无 raw 层 message_id，`revelant` 直接放相关会话 jsonl + 改动文件路径。

**blocks 标准（声明源 = 各库 `config.yaml`）**：`blocks.max_chars`（Pj16 = **300 字** ≈180 token，落 BGE 位置上限 512 的安全余量）+ 库个性约定 `prompts.add_memory`（读取方 `remember.ts:52`）——块数 ≥ 2、一块一件事；单块 ≤ max_chars；**block[0] = 检索锚**（查询形自然语句 + 关键标识：功能名/文件路径/参数名/报错原文）；按 `；。` 主切、`【标签】` 并入首块；**块内不嵌时间戳**（条目时间已蕴含在 memory_id）；禁纯工具名块。**写入侧强制**：`memwriter.ts` `splitBlock(block, maxChars)`（就近取窗口后半段的句末标点 `。；！？` 或换行，找不到才硬切）与 `blockMaxChars(cfg)`（读 `blocks.max_chars`，缺省 300），`buildEntry` 对 `blocks` 与 `[input.content]` **两条路径都切**。**动因**：encode 对超长输入**静默丢尾**（transformers.js feature-extraction 默认按 tokenizer 的 512 token 截断），超长块的尾部对检索零贡献；且 BGE 路径是**逐块 encode + 逐维 max-pool**（每块一票），块长/块数直接决定向量形态。**已知副作用**：max-pool 使池化向量范数随块数增长 ⇒ 同一 query 对同一条目的 cos 近似 ∝ 1/√块数，**块数本身即 cos 惩罚**——判条目 cos 高低先看块数；kw 项（读全文不受截断影响）兜住实际检索效果。precog 标注语义定案：检索某组件历史→修改相同东西=true、不同东西但改相同文件相同部分=revelant。source 是来源标签（对照真身库 'QQ'/'微信'）。

**LOG 更新口（现行做法）**：新 LOG 条目 = UTF-8 脚本文件 `bun:sqlite` 同构直写 `l2.mem/mem.db`（**禁 `bun -e` 内联中文**——Windows 下 mojibake；脚本自带断言，blocks 超限 exit(1) 不落盘；`memory_id=PJ16_MEM_{ts}`、`source='MEM'`、blocks 按上述标准）。**直写绕过写入器 ⇒ mem.db 行数与 `embeddings.npy` 行数漂移**（INSERT 只追加，缺失行恒在尾部）。漂移由**下一次经 memwriter 的写入自动消化**（`computeEmbeddings` 增量补齐，O(K) 毫秒级，见上段）——不必再人工重编码；漂移窗口内该库 recall 仍按行数不一致报错。两件维护入口：**`_agent-src/rebuild-neuron-index.ts`**（走 `memwriter.rebuildEmbeddings(forceFull=true)` 按 `readMemories` 行序全量重编码，覆写 npy + index_config，幂等可重跑，指定库路径为可选参数；**降为建库/换模型/行序破坏时的人工入口，启动前必须先征得用户同意**）+ **`_agent-src/probe-neuron-index.ts`**（A 行数三处一致 / B 每行 L2 归一 / C 真检索可用，9 过 0 败，秒级只读可自主跑）。**全项目神经元化**：`_agent-src/init-neuron-project.ts` 为各在盘项目建 Neuron-PjN 三层库并迁入各自历史 LOG，写法通用。使用标准 → [standards.md](standards.md) §7。

## WebSearch 本地多后端检索

`src/tools/WebSearchTool/`（WebSearchTool.ts + providers.ts + prompt.ts/UI.tsx）。**架构移植自 Hermes Agent web_tools**（参考源码 `C:\Users\Ma2431\AppData\Local\hermes\hermes-agent\plugins\web\`）：搜索为**纯客户端本地执行**（进程内 JSON HTTP），与推理 API 服务端工具能力解耦——任何模型 provider（GLM 反代等）都可用。原 Anthropic 服务端 `web_search_20250305` server-tool 链整体退役；原 isEnabled 的 provider 门控同步移除。

- **后端四家**（`providers.ts`，每家约 40 行 JSON HTTP）：`searxng`（自托管实例 `searxngUrl`，免 key，score 降序）/ `brave`（free-tier Data-for-Search，count 上限 20）/ `tavily`（/search，上限 20）/ `exa`（REST 直连不带 SDK，highlights 摘要拼接）。未移植：ddgs（Python 包爬虫，TS 无等价）、xai（仍是服务端路线）、firecrawl/parallel/keenable/perplexity（extract 向，正文抓取已由 WebFetch 覆盖）。
- **密钥与选择走全局密钥池**：credentials.json（`getClaudeConfigHomeDir()`，本机=全局根 `@WrokSpace\.claude\`）顶层 `webSearch` 段——`{ backend?: string, searxngUrl?: string, keys?: { brave|tavily|exa: string } }`；`loadCredentials` 白名单放行该段（load→save round-trip 否则被 /key 写操作冲掉），取值口 `getWebSearchCredentials()`（pool.ts）。后端选择：显式 `backend` **严格不换道**（不可用即报错，不静默 reroute）→ 从未配置过才自动探测（tavily→exa→searxng→brave）→ 全无则工具隐藏 + call 返回配置指引。密钥单源=池（不做 env 双轨）。
- **工具面**：isEnabled = 显式 backend 存在 ‖ 任一后端可用；输入 schema = `query + limit(1-100，默认 5)`（域名过滤走 `site:` 等运算符由后端自行支持）；输出 `Output` 形状 {query, results, durationSeconds}（SearchResult.tool_use_id 语义=后端名），UI 渲染链零改动；错误以字符串条目进 results（模型可见）。密钥写入暂为手编 credentials.json（/key 面板接入待做）。

## 排队消息催办 / 生成级断流（`query.ts` + `utils/messageQueueManager.ts`）

web 点击排队气泡 → 当前这次**生成流**就地收尾，排队消息由中链 drain 纳入**当前**回合（用户语义与全链 → [web-ui.md](web-ui.md) §13）。工程要点：

- **回合级 abort 不可用**：`toolUseContext.abortController.signal` 直传给 `callModel`，abort 会污染本轮后续所有迭代，且 abort 分支 `return { reason:'aborted_streaming' }` 直接结束回合。故催办走**生成级断流**，一个新信号通道：`messageQueueManager` 的 `queueNudgeRequested`（`requestQueueNudge / peekQueueNudge / consumeQueueNudge`），**生命周期锚定队列**——`notifySubscribers()` 里「队列清空即失效」（催办对象没了，标记留着只会误伤下一轮生成），且 `consumeQueueNudge` 一次性消费（不会无限断流）。
- **断流不变量**：生成流 `for await` 循环体首行 `if (isMainThread && toolUseBlocks.length === 0 && peekQueueNudge()) break`。`toolUseBlocks` 是**本迭代**数组且 tool_use 块只在 `content_block_stop` 才入数组/执行器 ⇒ 此处为 0 时断流不可能留下孤儿 `tool_use`、无需合成 `tool_result`（完全绕开工具链）。「工具一旦落定就不动它」由此门控天然成立。断流经 `claude.ts` 生成器 `finally` 释放 HTTP 流（该 finally 注释明写「consumer breaks out of for-await-of」是既定用法）。
- **同轮续跑**：收口在 `if (!needsFollowUp)` 之前——`if (!needsFollowUp && consumeQueueNudge()) needsFollowUp = true`，走 follow-up 路径（零工具，`StreamingToolExecutor.getRemainingResults()` 无未完成工具立即返回），下方既有中链 drain 把排队消息转成 `queued_command` 附件并 `removeFromQueue`，循环底部续跑下一迭代。**复用的就是「模型自然答完后排队消息被纳入」那条既有路径**（不新造纳入机制）。
- **判活在外层**：REPL 侧 `bridge/gatewayQueueNudgeHandle.ts` 句柄只在「有在飞生成 + `getDrainableQueuedPrompt()` 非空」时置位（引擎的断流门只看队列，不另设闸）。可催办对象判据与 drain 过滤同语义：`mode:'prompt'` ∧ 非斜杠 ∧ `agentId===undefined`。

## 工具循环熔断（`query.ts` + `utils/toolLoopBreaker.ts`）

模型复读死循环的引擎侧根治。要点：

- **判据三维（任一触发即熔断）**：
  - ① 同名同参（tool 名 + `JSON.stringify(input)` 全等）**连续**调用达 `TOOL_LOOP_BREAKER_LIMIT`（=5）次。任何不同调用（换工具/换参数）即重置——正常重试场景参数几乎总会变，逐字重发连续 5 次不存在。
  - ② **含簿记批连击**：连续 `TOOL_FAMILY_BATCH_LIMIT`（=4）轮每轮至少 1 个**簿记家族**调用（TaskCreate/TaskUpdate/TaskGet/TaskList/TodoWrite），任何实质工具出现即清零。病理 = 跨轮持续簿记不干活（TaskCreate 数百次参数次次不同、跨轮不停）。**单批大批量突发不算多轮**——一次建 10-30 个任务的大计划是合法正常流（按次计数会把单批多连 TaskCreate 撞线误收口）。
  - ③ **单轮簿记洪水**：单批内簿记调用达 `TOOL_FAMILY_FLOOD_LIMIT`（=40）次即熔断，覆盖洪水的单轮形态（第 40 个即拦，不再放行数百个）。
  - 纯状态机在 `utils/toolLoopBreaker.ts`（零依赖、探针直测）；批边界由调用方每批 `toolLoopBreakerBeginBatch` 划定，家族计数对任何非家族调用清零，与①的签名计数相互独立（①刻意跨批累计——复读本就跨批）。
- **落点**：`queryLoop` 跨迭代状态声明在 `while (true)` 之前；**每批 tool_use 执行前**（`runTools` 调用前）逐块喂入扫描。`streamingToolExecutor` 为 statsig 门控本构建恒关，不为死配置加分支。
- **触发行为**：达阈值块连同**本批后缀**全部不执行（`runTools` 只收 `allowedToolUseBlocks` 前缀）；后缀逐块合成 **error tool_result**（`is_error:true`，与 `yieldMissingToolResultBlocks` 同构——不变量「本批每个 tool_use 都有 result」，防下一轮请求孤儿 tool_use 400）；再 yield 一条用户可见的 assistant 错误消息（①维「⚠️ 工具循环熔断」/②③维「⚠️ 任务工具熔断…请立即停止创建/更新任务，直接用实际工具推进工作」）；`return { reason: 'tool_loop_breaker' }` **直接收口回合**，不再回喂模型（复读态下回喂只会续读；收口后由用户决策续跑）。
- **已知取舍**：被熔断批次的「allowed 前缀」已正常执行，其真实结果保留；排队消息与本熔断的交互不变（收口后 follow-up drain 照常）。
- 探针 `_agent-src/probe-tool-loop-breaker.ts`：A 组真实状态机行为（阈值/重置/不可序列化 input）+ B 组 query.ts 结构断言。

## 会话间协作（`session_send` 工具 + `sessionMessage` / `sessionAddressing`，`SESSION_LINK`）

会话 A 的 agent 向会话 B 发一条消息，B 侧以**与用户消息完全同等形态**接收（空闲开新回合 / 忙则排队 / 离线自动拉起，可点气泡催办），气泡外带一行灰字标明来源。as-built 以本节 + gateway.md §13 为准；网关侧 → [gateway.md](gateway.md) §13；渲染 → [web-ui.md](web-ui.md) §24。

**寻址模型 = 目录寻址，无授权门**：可发会话目录（`GET /gateway/sessions`，读盘、含离线会话）内任何会话，唯一硬门是寻址本身——sid 精确 > 标题唯一，重名/未找到/自环/空一律拒绝。@ 提及为纯输入手势（插 chip），不产生任何授权状态。

| 件 | 职责 |
|---|---|
| `utils/sessionMessage.ts`（纯字符串） | 包装/解析：`wrapSessionMessage({sid,title}, body)` / `parseSessionMessage(text)`（不锚定，展示用） |
| `utils/sessionAddressing.ts`（**纯函数、零 import**） | `resolveSessionTarget(dir, to, selfSid)`：目录 → `{target, error}`；寻址即唯一硬门 |
| `tools/SessionSendTool/` | `session_send({to, text})`；`checkPermissions` 与 `call` 各调一次 `resolveSessionTarget`（现场重算——两次调用间目录可能变化） |
| `utils/gatewayClient.ts` | `fetchSessionDirectory()`（`GET /gateway/sessions` → `KnownSession[]`）+ `sendSessionMessage()`（requestId 配对）+ 下行包装入队 + `queueItemsFromSnapshot` 拆包 |

**核心设计选择（都有根因，勿回退）**：

1. **来源走文本内嵌包装，不走新字段**。`<session-message from="会话：X" sid="…">正文</session-message>` 随消息本体落盘/回放/压缩天然携带，零传参链。**绝不能借用 `origin`/`isMeta`**——`isLoggableMessage`（`sessionStorage.ts`）对带这两个字段的 attachment 返回 false，消息刷新后直接消失。
2. **`sessionAddressing.ts` 必须保持纯函数、零 import**。**不得 import `gatewayClient.ts`**——后者顶层 `import { feature } from 'bun:bundle'` 是编译期宏，`bun` 直跑下不可解析，一旦引入 `probe-session-link.ts` 这类源码直跑探针就永久失效。输入（会话目录、本会话 sid）由调用方注入。
3. **寻址在 CLI 侧解析，网关只做纯 sid 路由**。`resolveSessionTarget` 规则唯一：sid 精确命中（`to` 恰为某会话 sid 又是另一会话标题时 **sid 键优先**）；无则标题唯一匹配；**重名/未找到/自环/空/复合令牌串「标题|sid」不代拆**（调用方须自行拆分）一律拒绝，不猜不兜底。与「寻址判定必须在转录所在侧」同源，避免两处判定同一件事。
4. **撤门后唯一刹车 = 软约束**：「非必要不通信」（`@WrokSpace/.claude/CLAUDE.md` 通信约束节）+ 工具 `prompt.ts` 同款措辞；代码级硬边界只剩寻址层自环拒绝 + 网关拒自发自收。
5. **调用点 `UserPromptMessage.tsx` 就地解析包装**，不新增 props——一处覆盖 CLI 的开回合/排队/历史转录三条路径（都经 `createUserMessage` → `Message`）；同时把提及令牌 `[会话:标题|sid]` 显示为 `[标题]`（sid 不进终端），且**不对 `text` 做 replace**（发往 LLM 的仍是包装原文，模型可见来源）。来源灰字行**随其气泡一侧对齐**（右对齐）：外层 column Box 保持默认 stretch（否则内层气泡会被收成内容宽），只给来源行套 `<Box flexDirection="row" justifyContent="flex-end">` 行盒——web 侧同义改动在 `.msg.user .who`。
6. **来源标注由接收侧渲染，发送方只写正文**。工具说明里显式禁止发送方自加来源前缀/抬头/签名（发送方读工具说明易自写来源，与对侧自动渲染的灰字行重复；链路本身正文原样投递、不强制剥离）。

**回环**：**不做代码级刹车**——靠「非必要不通信」软约束 + 工具 `prompt.ts` 同款措辞。硬边界 = 寻址自环拒绝 + 网关拒「自发自收」；实测出现 agent 对喷再补硬护栏（限频/审批）。

**验证**：`_agent-src/probe-session-link.ts` **47 过 / 0 败**（A 包装往返 / D 寻址含 D7 sid 键优先与 D10 复合令牌不代拆 / F web 接线 / G CLI 接线+工具说明+G7 撤门钉（标识符级防 sessionExposure 残留回潮）/ H 来源行对齐）。

## 跨会话文件修改归因（`utils/fileModifierRegistry.ts`）

两会话（=两进程，内存不互通）并发编辑同一文件时，后写方命中的 modified-since-read 门原只报「被用户/linter 改过」，报不出**谁**改的——根因 `readFileState` 是每进程私有内存，跨进程归因唯一通道是磁盘。归因注册表：

| 件 | 职责 |
|---|---|
| `utils/fileModifierRegistry.ts` | `recordFileModifier(path)`（写入侧）：`appendFileSync` 追加 `{p,sid,ts}` 行到 `<项目根>/.claude/file-mods.jsonl`（`getProjectRuntimeDir`）——追加无读改写竞争，坏行容忍，超 1MB 压缩保尾 1000 行，全程容错不抛；`fileModifierSuffix(path, sinceTs)`（拦截侧）：逆序找最新**非本会话**且 `ts > sinceTs` 条目，命中返回 ` (last modified by session <sid>)`，否则 `''` |

- **记录挂点四处**：FileEditTool / FileWriteTool / NotebookEditTool 各自 `readFileState.set` 之后 + BashTool sed 模拟写路径之后。
- **拦截提示五处**：Edit（ec7）/ Write（ec3）/ NotebookEdit（ec10）三处 validateInput + Edit/Write 两处竞态 `FILE_UNEXPECTEDLY_MODIFIED_ERROR` throw 后缀拼接——竞态路径恰是「两会话真同时」的主现场。
- **边界**：Bash 原生写不经工具链不可归因（仍后写覆盖无提示）；注册表按项目根隔离，跨项目撞车查不到回落原文；本会话自己的行跳过（自家写会刷新自家 readFileState，不构成撞车）。

**验证**：`_agent-src/probe-file-modifier-registry.ts` **5 过 / 0 败**。纯 CLI 工具层，无 web 改动不 bump sw。
