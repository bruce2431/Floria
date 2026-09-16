# 源码核心机制（core）

> 本文件属 `docs/` 文档库（2026-09-10 由原 `ARCHITECTURE.md`「一、源码核心机制」章独立成件）。
> 官方源码重构快照 2.1.87（bun + ink + React，入口 `src/entrypoints/cli.tsx`），官方文档不适用。
> 路径均相对 `Pj16-CodeAgent构建/_agent-src/`。姊妹件：**术语 → [glossary.md](glossary.md)**；**构建/flag → [build.md](build.md)**；**规则标准 → [standards.md](standards.md)**；**网关服务 → [gateway.md](gateway.md)**；**web 链路 → [web-ui.md](web-ui.md)**。改动以下任一机制时必须同步更新本文。

## 便携配置根（`envUtils.ts`）

`CLAUDE_CONFIG_DIR` → exe 旁 `.claude/`（带 `.claude-portable` 等标记）→ 逐级向上找 `.claude-portable` → 兜底 `~/.claude`。`.claude/.claude-portable` 必须留在 `@WrokSpace` 根（规则约束见 [standards.md](standards.md) §3）。

**裸机初始化（2026-09-06）**：TrustDialog「Yes, I trust this folder」yes 分支调 `maybeInitPortableRoot()`（`envUtils.ts`）——无 env、exe 邻接无 `.claude/`、向上无标记（=本轮恰落 `~/.claude` 兜底）时，于 **exe 邻接**（`dirname(process.execPath)`，非 cwd——walk-up 从 exeDir 出发，cwd 建标记会死）建 `.claude/.claude-portable` 空标记，**下一轮启动**第 2 步命中生效（初始化=写标记，非运行中热切换；首轮 trust 记录留旧根，第二轮需再点一次 yes）。`exeDir===homedir()` 或邻接已有 `.claude/` 不动；失败 throw 由调用方报，不阻断 trust。本机 `CLAUDE_CONFIG_DIR` 恒设，恒不触发。

## 会话/记忆项目级平铺

会话 `<项目>/.claude/projects/*.jsonl`、自动记忆 `<项目>/.claude/projects/memory/`；subagent 转录按 `<sessionId>/subagents/` 子目录存（正常设计）；项目身份用 `getProjectRoot()` 而非 `getOriginalCwd()`。存储布局规范 → [standards.md](standards.md) §2.1。

## 插件/skill 双发现（`pluginLoader.ts`）

`.claude-plugin/plugin.json` → 插件（根 `.mcp.json` 自动注册，工具命名空间 `mcp__plugin_<插件>_<server>__*`）；`SKILL.md` → skill（`/<插件>:<skill>`）。会话启动一次性加载，改动重启生效。注册标准 → [standards.md](standards.md) §4-§5。

## feature flag

编译期 `feature('X')` 裁剪，只在 `if` 条件里直接调用才能 tree-shake。旗标逐条审计 → [build.md](build.md) §2。

## Changelog（`releaseNotes.ts`）

源=`changes.md`，启动同步进 `.claude/cache/changelog.md`（会被覆盖，**禁手写**）。标准 → [standards.md](standards.md) §8。

## 沙箱权限（`permissions/`）

allow/deny/ask + defaultMode 兜底；路径匹配 gitignore 语义（`@/`=便携根、`~/`=home）；deny 硬拦截；Pj16 审批制，Pj1/Pj2/Pj11/Pj13/Pj14/Pj15 deny 锁死。

## 网关缺失自愈 + 日志落盘（2026-08-28）

1. **自愈**——`gatewayClient.ts` `probeAndConnect()` 探测网关不在（`/gateway/health` 失败）时，经 `feature('PRIVATE_GATEWAY')` 门控动态 import `commands/server/server.ts` 的 `ensureGatewayAutoStart()` 自动 detached spawn 独立网关（60s 节流；`isGatewayUp` 在→跳过；端口被非网关占用→**静默放弃不强抢**【自动路径禁杀进程】；token 继承盘上 `gateway-token`，无则随机），spawn 后下轮 PROBE_RETRY(10s) 自然接续——网关 crash/空闲回收退出不再需要手动 `/server on`（2026-08-28 遥测端断连事故根因之一）。
2. **日志**——`spawnGatewayProcess()`（`/server on` 与自动拉起共用）：网关进程 stdout/stderr 落盘便携根 `.claude/gateway.log`（5MB 截断轮转，照 backend log 先例），crash 可取证（此前 `stdio:'ignore'` 是事故取证盲区）；手动前台 `exe --gateway` 仍直出终端。
3. **事故背景（勿忘）**：系统 commit 内存临界（固定页面文件 20.8GB + 多个 cli-dev 进程各 1.5~3.7GB private，活跃会话增速 ≈2.6GB/h）时，web 端首屏全量渲染的内存尖峰可触发多进程连锁 crash（Windows 不挑进程，谁撞上分配失败谁死）——`gateway.log` 是排查第一现场；系统层根治=页面文件改自动管理（用户操作）。

## 神经元内置检索/记忆（NEURON_RAG，2026-09-03，默认关）

`src/tools/neturon/` 15 件纯进程内置（引擎核心+工具层，无 Python 子进程）。**双层根扫描发现**：cwd 根 `<cwd>/.claude/neturon/` + 全局根 `<configHome>/neturon/` + RAG_DATA_DIR 追加；目录即注册（含 config.yaml + l2.mem/**mem.db**，2026-09-04 起），id=person.id 跨根唯一，注册表 10s TTL 缓存；仍为旧 mem.json 的目录不注册、经 neuron_list 报 `pending_migration`（含迁移提示）。**存储层 DB 化（2026-09-04，SubPj7 定案同步）**：`db.ts`（bun:sqlite 零依赖）三表统一 schema——l3.raw/<来源>/message.db（7 列）/l2.mem/mem.db（定案 4 列 + 活引擎 3 可空列 core_file/supersedes/deprecated_by 超集，v2.3 收口 pattern 彻底移除、2026-09-15 移除 confidence/half_life 僵尸列 = memories 7 列）/l1.cog/precog.db（8 列，纯追加+标注 UPDATE）；缺字段=NULL、时间编码进 id 无独立 time 列（idTime/makeMessageId）、busy_timeout=5000 防双前端写碰撞；content/summary 不落库由 blocks 派生（deriveEntryText）→ embeddings.npy 保持二进制对位、迁移零重建语义（折叠行序变化时全量重编码，embedder encode 分批 32/批防 ONNX OOM）；cog_graph.json/community.json/cog2.json 快照 JSON 保留。旧 JSON 迁移三件（mem 嵌套 men/sem→平铺 / cog precog_records / message 重编 id 返回 id_map 供 revelant 联动；重复 id 同秒遗留 OR REPLACE last-wins 折叠对照 SubPj7）。**检索** = BGE 向量（@huggingface/transformers + Xenova/bge-small-zh-v1.5 ONNX，懒加载动态 import，编码前预小写归一化对齐 Python 生产路径，模型缓存 `<全局根>/cache/models/` 首跑 hf-mirror 下载 91MB）+ Intl.Segmenter 关键词加权 + 自动扩 k + precog 写入；索引缺失/与 mem.db 行数不一致直接报错（无降级）。**写侧** remember add/update（supersede 纠错，先算后写+失败回滚）。**l1.cog 认知层形成侧内置（09-04）**：`neuron_cog` ops 工具（action=build_graph 批折叠建图，含防假标注门禁——pre 记录 description/accuracy 空则拦截（同步 SubPj7 08-12 修复，fill_precog 合法集 {true,revelant,false}）/ detect_communities 多分辨率 Leiden——本体 `leiden.ts`，leidenalg 实图对照 ΔQ≈0；community.json modularity 复刻 igraph 无权 γ=1 语义，加权 Q 以 q_weighted 另返回）；p7 LLM 概念抽象不移植；读侧 community.json 反查照旧。**认知图形成侧 2026-09-15 改判 = 纯标注驱动（用户定案，主动偏离 Python）**：节点归并判据 `sim = jaccard(true 集) ≥ cog.merge_threshold(0.50)`、边权 `weight = cog.w_true_assoc(0.40)·jt + cog.w_revelant(0.45)·rv`——query/keywords/blocks 余弦三元（旧制：归并占 0.15、边权占 0.15）全部移除，`edge_filter.no_jt_penalty` 随之删除（它本只为压文本背景地板）。连带结构简化：`coggraph.ts` 整链不再需要嵌入（encode/embedder/segment 依赖移出本文件）、节点不再持久化 `merged_from`（唯一消费者是其缓存回溯分支）与 `true_count/revelant_count`（= set.size 的冗余第二状态源）、边不再持久化 `cq/ck/cb`；config 相应删 7 键并显式补 `precog.ttl_days: 90`（原为代码内隐式默认）。**语义改判 = cog 即事实层**：build_graph 永不修正既有节点记忆集（只并集折叠或建新节点，节点集合只增不减），发现错误直接改 cog 条目；precog 降级为「收件箱」（pre 必留 = 新节点入口 + 待标注队列 + 防假标注门禁载体，consumed 由 `precog.ttl_days` 回收）。完备加权图仍照 Python 原设计落盘（1081=C(47,2) 条全写，仅 weight>0 的 83 条进 Leiden）。实测：47 节点 res1.5 由 [32,6,5,4]（32 节点纯文本巧合大群）→ **[9,9,7,6,4,4]**（界面 9 / 底栏+杂项 9 / 神经元 7 / 侧栏 6 / 两组 4），原侧栏缺口节点（true 集为空、rv 边被地板锁死）随 no_jt_penalty 移除进群；合成测试 11/0（含「jT=0.4286 歧义带旧公式会合、新公式不合」的最小复现）。**注册**：tools.ts `feature('NEURON_RAG')` 门控 require，recall/remember + ops 四件（list/source/fill_precog/cog，shouldDefer）紧跟核心读写组；**名册**经 prompts.ts dynamicSections `neuron_roster` 注入（cwd 根正文上限 8 + 全局根指针行）。定案文档 `20260829142535-神经元内置架构定案.md`（项目根，v2.2）；证据 `20260903204723-BGE-TS化Spike/`（leiden 35/35 + coggraph 双引擎 114/114）+ `20260904153426-DB化同步SubPj7定案/`（隔离冒烟 27/27 + 李京瑾真身迁移脚本/备份/校验：WX 67291、QQ 35158→折叠 35150、mem 4397→折叠 4390、precog 121→折叠 103、revelant 101883 条 id_map 联动）。**项目神经元实例（2026-09-10，三层齐备）**：`Neuron-Pj16`（cwd 根 `.claude/neturon/neurons/`，person.id=PJ16，NEURON_RAG 首个项目库）。**三层齐备**（此前只有 l2.mem + l1.cog，缺 raw 层）：① `l3.raw/LOG/` = LOG.md 原文全文（**真移动**——LOG.md 从项目根迁入本层，项目根不再有 LOG.md，841862 B）+ `message.db` 379 行（每条目一行，`message_id=PJ16LOG_{YYYYMMDD}_{HHMMSS}[_seq]` 与 mem 条目 _seq 一一对齐，content=条目全文、source='LOG.md'、sender/media/quote/forward=null）；② `l2.mem/mem.db` 380 条（`memory_id=PJ16_MEM_时间戳确定性生成`，source='LOG' 379（迁移产物）+ 'MEM'（活写入））+ `embeddings.npy [380,512]` + `index_config.json` 规范三字段 `{model_name,total_entries,embedding_dim}`（无 encoded_ids——该字段仅是 retriever 行数不齐时可选对齐口，真身库亦无）；③ `l1.cog/` 待认知层形成。**revelant 定案（照真身库 Neuron-李京瑾 惯例）**：**首元素 = 该条目在 raw 层的 message_id**，其后为相关会话 jsonl 路径 + 该条目修改文件路径（证据指针数组，全相对项目根；jsonl 按首末行 timestamp 区间匹配，不迁移会话仅索引）。**blocks 标准（2026-09-15 用户定案，声明源 = 各库 `config.yaml`）**：`blocks.max_chars`（Pj16 = **300 字** ≈180 token，落 BGE 位置上限 512 的安全余量）+ 库个性约定 `prompts.add_memory`（读取方 `remember.ts:52`）——块数 ≥ 2、一块一件事；单块 ≤ max_chars；**block[0] = 检索锚**（查询形自然语句 + 关键标识：功能名 / 文件路径 / 参数名 / 报错原文）；按 `；。` 主切、`【标签】` 并入首块；**块内不嵌时间戳**（条目时间已蕴含在 memory_id，2026-09-10 定案）；禁纯工具名块。**写入侧强制**（不再只靠约定）：`memwriter.ts` 新增 `splitBlock(block, maxChars)`（就近取窗口后半段的句末标点 `。；！？` 或换行，找不到才硬切）与 `blockMaxChars(cfg)`（读 `blocks.max_chars`，缺省 300），`buildEntry` 对 `blocks` 与 `[input.content]` **两条路径都切**——`[input.content]` 回落路径正是此前造出单块巨块的源头。**动因**：encode 对超长输入**静默丢尾**（transformers.js feature-extraction 默认就按 tokenizer 的 512 token 截断；802 token 文本 vs 其首 512 token 文本 cos=1.0000），超长块的尾部对检索零贡献；且 BGE 路径是**逐块 encode + 逐维 max-pool**（每块一票），块长/块数直接决定向量形态。**存量清洗（2026-09-15）**：`recut-mem-blocks.ts --apply` 把 56 条 MEM 单块巨块（均 1.00 块/条，最长 5719 字）重切为 **382 块**（min 134 / max 300 / 均 244），48 条剥掉块首时间戳；落盘前逐条断言 L1 内容零丢失 / L2 每块 ≤ max_chars / L3 无空块。全库超 512 token 块 **43 → 0**（token max 3384→424，中位 44→47）。**已知副作用（留档，待检索侧单独定夺）**：max-pool 使池化向量范数随块数增长 ⇒ 同一 query 对同一条目的 cos 近似 ∝ 1/√块数（受控实测：只池化命中块 0.659 vs 池化全部 22 块 0.339），**块数本身即 cos 惩罚**，改前 MEM 单块形态反而偷吃这份偏置；实测 rank 8 例中 7 例不变、1 例 1→2，kw 项（权重 0.70、读全文不受截断影响）兜住实际检索效果。source 是来源标签（对照真身库 'QQ'/'微信'）。precog 标注语义定案：检索某组件历史→修改相同东西=true、不同东西但改相同文件相同部分=revelant。**生成脚本** `20260910152816-项目神经元初始化/gen_pj16_neuron.ts` 幂等可重跑（写前 `DELETE ... WHERE source='LOG'` 只替换迁移产物、mem 活写入条目不动；raw 层只替换 `PJ16LOG_%` 行；embeddings + index_config 按**全库**重建防活写入向量丢失）。**LOG 更新口（2026-09-10 用户定案「以后本项目去 mem 更新 log」）**：原为任务目录 `20260910152816-项目神经元初始化/log_append.ts`（源码 `memwriter.ts` addMemory 的薄入口，复用其 DB 写入+增量重建 embeddings+index_config+检索缓存刷新+行数自愈全链）——**该任务目录已随项目根 2026* 清理消失（2026-09-12 核实）**，现行做法 = `bun:sqlite` 同构直写 `l2.mem/mem.db`。**行形态（2026-09-15 起按 blocks 标准自洽）**：`source='MEM'`（本项目 LOG 条目无 raw 层 message_id，故 `revelant` 直接放相关会话 jsonl + 改动文件路径，不占首元素）；`blocks[0]` = **检索锚**（查询形自然语句 + 关键标识），**不再写 `<ts> 正文` 式块首时间戳**；块数 ≥ 2、单块 ≤ `blocks.max_chars`——追加脚本自带断言，超限即 exit(1) 不落盘（标准先适用于本条目）。**直写绕过「增量重建 embeddings」这一步 ⇒ mem.db 行数与 `embeddings.npy` 必然漂移**（2026-09-15 实测 420 vs 409；`index_config.json` 无 `encoded_ids` 故 retriever 无从对齐，`search` 抛「索引缺失或与 mem.db 行数不一致」，门控开即硬失败）。补两件收口：**`_agent-src/rebuild-neuron-index.ts`**（走 `memwriter.rebuildEmbeddings(forceFull=true)` 按 `readMemories` 行序全量重编码，覆写 npy + index_config，幂等可重跑，指定库路径为可选参数）+ **`_agent-src/probe-neuron-index.ts`**（A 行数三处一致 / B 每行 L2 归一 / C 真检索可用，9 过 0 败）。**字段裁剪（2026-09-15）**：memories 的 confidence/half_life 定案移除——写入侧只从 config 默认值填数、检索侧从不读取（Python 基线 `retriever.py:_rank_mem` 同样只取 `ranking.fact` 的 w_cos/w_kw），属僵尸字段；配套 `_agent-src/migrate-drop-mem-columns.ts`（幂等 ALTER TABLE DROP COLUMN，先整文件备份到 `.trash/<date>/`）+ `_agent-src/probe-mem-write.ts`（隔离副本库上跑 add/update 全链，14 过 0 败）。LOG.md 自此冻结为历史存档。使用标准 → [standards.md](standards.md) §7。

## WebSearch 本地多后端检索（2026-09-10）

`src/tools/WebSearchTool/`（WebSearchTool.ts + providers.ts + prompt.ts/UI.tsx）。**架构整体移植自 Hermes Agent web_tools**（参考源码 `C:\Users\Ma2431\AppData\Local\hermes\hermes-agent\plugins\web\`）：搜索为**纯客户端本地执行**（进程内 JSON HTTP），与推理 API 服务端工具能力解耦——任何模型 provider（GLM 反代等）都可用。原 Anthropic 服务端 `web_search_20250305` server-tool 链（子查询流式 + server_tool_use 块解析 + max_uses 8）整体退役；原 isEnabled 的 provider 门控（firstParty/vertex-4代/foundry）同步移除。

- **后端四家**（`providers.ts`，每家约 40 行 JSON HTTP）：`searxng`（自托管实例 `searxngUrl`，免 key，score 降序）/ `brave`（free-tier Data-for-Search，count 上限 20）/ `tavily`（/search，上限 20）/ `exa`（REST 直连不带 SDK，highlights 摘要拼接）。未移植：ddgs（Python 包爬虫，TS 无等价）、xai（仍是服务端路线与本目标相悖）、firecrawl/parallel/keenable/perplexity（extract 向，正文抓取已由 WebFetch 覆盖）。
- **密钥与选择走全局密钥池**：credentials.json（`getClaudeConfigHomeDir()`，本机=全局根 `@WrokSpace\.claude\`）新增顶层 `webSearch` 段——`{ backend?: string, searxngUrl?: string, keys?: { brave|tavily|exa: string } }`；`loadCredentials` 白名单放行该段（load→save round-trip 否则被 /key 写操作冲掉），取值口 `getWebSearchCredentials()`（pool.ts）。后端选择：显式 `backend` **严格不换道**（不可用即报错，Hermes 同款；不静默 reroute）→ 从未配置过才自动探测（tavily→exa→searxng→brave）→ 全无则工具隐藏 + call 返回配置指引。密钥单源=池（不做 env 双轨）。
- **工具面**：isEnabled = 显式 backend 存在 ‖ 任一后端可用；输入 schema 简化为 `query + limit(1-100，默认 5)`（原 allowed_domains/blocked_domains 退役——域名过滤走 `site:` 等运算符由后端自行支持，prompt.ts 已同步）；输出 `Output` 形状不变（{query, results, durationSeconds}，SearchResult.tool_use_id 语义=后端名），UI 渲染链零改动；错误以字符串条目进 results（模型可见）。密钥写入暂为手编 credentials.json（/key 面板接入待做）。

## 排队消息催办 / 生成级断流（`query.ts` + `utils/messageQueueManager.ts`，2026-09-10）

web 点击排队气泡 → 当前这次**生成流**就地收尾，排队消息由中链 drain 纳入**当前**回合（用户语义与全链 → [web-ui.md](web-ui.md) §13）。工程要点：

- **回合级 abort 不可用**：`toolUseContext.abortController.signal` 直传给 `callModel`，abort 会污染本轮后续所有迭代，且 abort 分支 `return { reason:'aborted_streaming' }` 直接结束回合。故催办走**生成级断流**，一个新信号通道：`messageQueueManager` 的 `queueNudgeRequested`（`requestQueueNudge / peekQueueNudge / consumeQueueNudge`），**生命周期锚定队列**——`notifySubscribers()` 里「队列清空即失效」（催办对象没了，标记留着只会误伤下一轮生成），且 `consumeQueueNudge` 一次性消费（不会无限断流）。
- **断流不变量**：生成流 `for await` 循环体首行 `if (isMainThread && toolUseBlocks.length === 0 && peekQueueNudge()) break`。`toolUseBlocks` 是**本迭代**数组且 tool_use 块只在 `content_block_stop` 才入数组/执行器 ⇒ 此处为 0 时断流不可能留下孤儿 `tool_use`、无需合成 `tool_result`（完全绕开工具链）。「工具一旦落定就不动它」由此门控天然成立。断流经 `claude.ts` 生成器 `finally` 释放 HTTP 流（该 finally 注释明写「consumer breaks out of for-await-of」是既定用法）。
- **同轮续跑**：收口在 `if (!needsFollowUp)` 之前——`if (!needsFollowUp && consumeQueueNudge()) needsFollowUp = true`，走 follow-up 路径（零工具，`StreamingToolExecutor.getRemainingResults()` 无未完成工具立即返回），下方既有中链 drain 把排队消息转成 `queued_command` 附件并 `removeFromQueue`，循环底部续跑下一迭代。**复用的就是「模型自然答完后排队消息被纳入」那条既有路径**（不新造纳入机制）。
- **判活在外层**：REPL 侧 `bridge/gatewayQueueNudgeHandle.ts` 句柄只在「有在飞生成 + `getDrainableQueuedPrompt()` 非空」时置位（引擎的断流门只看队列，不另设闸）。可催办对象判据与 drain 过滤同语义：`mode:'prompt'` ∧ 非斜杠 ∧ `agentId===undefined`。

## 工具循环熔断（`query.ts` + `utils/toolLoopBreaker.ts`，2026-09-12）

模型复读死循环的引擎侧根治（事故原型 pj18-初始化接力：glm-5.3-flash 每轮零思考零文本、纯复读 `TaskUpdate(#5, in_progress)` 754 次/2h41m，结果恒「Updated task #5」**成功**＝链路上无失败信号可打断，自回归复读锁死）。要点：

- **判据**：同名同参（tool 名 + `JSON.stringify(input)` 全等）**连续**调用达 `TOOL_LOOP_BREAKER_LIMIT`（=5，2026-09-12 用户定案）次。任何不同调用（换工具/换参数）即重置——正常重试场景参数几乎总会变，逐字重发连续 5 次不存在。纯状态机在 `utils/toolLoopBreaker.ts`（零依赖、探针直测）。
- **落点**：`queryLoop` 跨迭代状态声明在 `while (true)` 之前；**每批 tool_use 执行前**（`runTools` 调用前）逐块喂入扫描。`streamingToolExecutor` 为 statsig 门控本构建恒关，不为死配置加分支。
- **触发行为**：达阈值块连同**本批后缀**全部不执行（`runTools` 只收 `allowedToolUseBlocks` 前缀）；后缀逐块合成 **error tool_result**（`is_error:true`，与 `yieldMissingToolResultBlocks` 同构——不变量「本批每个 tool_use 都有 result」，防下一轮请求孤儿 tool_use 400）；再 yield 一条用户可见的「⚠️ 工具循环熔断」assistant 错误消息；`return { reason: 'tool_loop_breaker' }` **直接收口回合**，不再回喂模型（复读态下回喂只会续读，pj18 实证外部注入才能唤醒；收口后由用户决策续跑）。
- **已知取舍**：被熔断批次的「allowed 前缀」已正常执行，其真实结果保留；排队消息与本熔断的交互不变（收口后 follow-up drain 照常）。
- 探针 `_agent-src/probe-tool-loop-breaker.ts`：A 组真实状态机行为（阈值/重置/不可序列化 input）+ B 组 query.ts 结构断言。

## 会话间协作（`session_send` 工具 + `sessionMessage` / `sessionExposure`，2026-09-15，`SESSION_LINK`）

会话 A 的 agent 向会话 B 发一条消息，B 侧以**与用户消息完全同等形态**接收（空闲开新回合 / 忙则排队 / 可点气泡催办），气泡外带一行灰字标明来源。总设计 → 项目根 `20260915133812-会话间协作功能设计方案.md`；网关侧 → [gateway.md](gateway.md) §13；渲染 → [web-ui.md](web-ui.md) §16。

**授权模型 = 暴露即授权**：用户在输入栏用 `@` 提及（或「+」菜单「引用会话」）某会话，即把该会话暴露给当前 agent。没有暴露就没有工具权限。

| 件 | 职责 |
|---|---|
| `utils/sessionMessage.ts`（纯字符串） | 包装/解析/锚定：`wrapSessionMessage({sid,title}, body)` / `parseSessionMessage(text)`（不锚定，展示用）/ `extractSessionSource(text)`（**锚定文本开头**，授权用） |
| `utils/sessionExposure.ts`（**纯函数**） | `collectExposedSessions`（扫 `user` 记录 → 令牌并集 + 反向来件）/ `resolveAgainst(dir, messages, selfSid)`（目录 → `targets`/`unresolved`）/ `findTarget` / `describeExposure` |
| `tools/SessionSendTool/` | `session_send({to, text})`；`checkPermissions` 与 `call` 各调一次本地 `resolveExposure`（**授权判定现场重算，不复用工具描述里的旧值**） |
| `utils/gatewayClient.ts` | `fetchSessionDirectory()`（`GET /gateway/sessions` → `KnownSession[]`）+ `sendSessionMessage()`（requestId 配对）+ 下行包装入队 + `queueItemsFromSnapshot` 拆包 |

**核心设计选择（都有根因，勿回退）**：

1. **来源走文本内嵌包装，不走新字段**。`<session-message from="会话：X" sid="…">正文</session-message>` 随消息本体落盘/回放/压缩天然携带，零传参链（初稿拟加的 `QueuedCommand.sessionSource` → `attachments.ts` → `processUserInput` 贯穿链整体作废）。**绝不能借用 `origin`/`isMeta`**——`isLoggableMessage`（`sessionStorage.ts`）对带这两个字段的 attachment 返回 false，消息刷新后直接消失。
2. **`sessionExposure.ts` 必须保持纯函数**（只 import `sessionMessage.ts`）。**不得 import `gatewayClient.ts`**——后者顶层 `import { feature } from 'bun:bundle'` 是编译期宏，`bun` 直跑下不可解析，一旦引入 `probe-session-link.ts` 这类源码直跑探针就永久失效。输入（会话目录、本会话 sid）由调用方注入。
3. **授权只来自用户键盘或真实来件**。只扫 `user` 角色记录（assistant/tool 记录里的令牌一律不算，否则模型自己写一句就自我授权）；`extractSessionSource` **开标签锚定文本开头**，故 `@file` 读进来的文件内容、模型自述文本里的标签都不产生授权（探针 B0 用「去锚对照」证明锚定确为判据，非空洞断言）。
4. **反向来件要求 sid**。别的会话发给我的消息（`attachment.prompt` 是完整包装）自动构成授权，双方此后可互发；但**无 sid 的匿名来件不算**——标题可被冒用/重名，宁缺勿猜。
5. **寻址在 CLI 侧解析，网关只做纯 sid 路由**。`resolveAgainst` 用目录建 `Map`，规则唯一：有 `|sid` 精确命中；无则按标题唯一匹配；**重名/未找到/失效 sid/自环**四种一律进 `unresolved`，不猜不兜底。这与「暴露判定本就必须在转录所在侧」同源，避免两处判定同一件事。
6. **调用点 `UserPromptMessage.tsx` 就地解析包装**，不新增 props——一处覆盖 CLI 的开回合/排队/历史转录三条路径（都经 `createUserMessage` → `Message`）；同时把提及令牌 `[会话:标题|sid]` 显示为 `[标题]`（sid 不进终端），且**不对 `text` 做 replace**（发往 LLM 的仍是包装原文，模型可见来源）。来源灰字行**随其气泡一侧对齐**（右对齐，2026-09-15 用户定案）：外层 column Box 保持默认 stretch（否则内层气泡会被收成内容宽），只给来源行套 `<Box flexDirection="row" justifyContent="flex-end">` 行盒——web 侧同义改动在 `.msg.user .who`。
7. **来源标注由接收侧渲染，发送方只写正文**。工具说明里显式禁止发送方自加来源前缀/抬头/签名。旧措辞「并会看到『来自 会话：…』的来源标注」在 2026-09-15 真运行实测里被发送方读成「要我加前缀」，于是正文自写来源、与对侧自动渲染的灰字行**重复**（链路本身无缺陷——正文原样投递、不强制剥离）。

**回环**：**不做代码级刹车**（用户 2026-09-15 定案）——靠 `@WrokSpace/.claude/CLAUDE.md` 的「非必要不通信」约束 + 工具 `prompt.ts` 同款措辞。唯一硬边界是网关拒「自发自收」。

**验证**：`_agent-src/probe-session-link.ts` **72 过 / 0 败**（A 包装往返 / B 锚定 / C 暴露集合 / D 解析 / E 自述 / F web 接线 / G CLI 接线+工具说明 / H 来源行对齐）。

