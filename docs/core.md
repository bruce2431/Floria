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

`src/tools/neturon/` 15 件纯进程内置（引擎核心+工具层，无 Python 子进程）。**双层根扫描发现**：cwd 根 `<cwd>/.claude/neturon/` + 全局根 `<configHome>/neturon/` + RAG_DATA_DIR 追加；目录即注册（含 config.yaml + l2.mem/**mem.db**，2026-09-04 起），id=person.id 跨根唯一，注册表 10s TTL 缓存；仍为旧 mem.json 的目录不注册、经 neuron_list 报 `pending_migration`（含迁移提示）。**存储层 DB 化（2026-09-04，SubPj7 定案同步）**：`db.ts`（bun:sqlite 零依赖）三表统一 schema——l3.raw/<来源>/message.db（7 列）/l2.mem/mem.db（定案 6 列 + 活引擎 3 可空列 core_file/supersedes/deprecated_by 超集，v2.3 收口 pattern 彻底移除 = memories 9 列）/l1.cog/precog.db（8 列，纯追加+标注 UPDATE）；缺字段=NULL、时间编码进 id 无独立 time 列（idTime/makeMessageId）、busy_timeout=5000 防双前端写碰撞；content/summary 不落库由 blocks 派生（deriveEntryText）→ embeddings.npy 保持二进制对位、迁移零重建语义（折叠行序变化时全量重编码，embedder encode 分批 32/批防 ONNX OOM）；cog_graph.json/community.json/cog2.json 快照 JSON 保留。旧 JSON 迁移三件（mem 嵌套 men/sem→平铺 / cog precog_records / message 重编 id 返回 id_map 供 revelant 联动；重复 id 同秒遗留 OR REPLACE last-wins 折叠对照 SubPj7）。**检索** = BGE 向量（@huggingface/transformers + Xenova/bge-small-zh-v1.5 ONNX，懒加载动态 import，编码前预小写归一化对齐 Python 生产路径，模型缓存 `<全局根>/cache/models/` 首跑 hf-mirror 下载 91MB）+ Intl.Segmenter 关键词加权 + 自动扩 k + precog 写入；索引缺失/与 mem.db 行数不一致直接报错（无降级）。**写侧** remember add/update（supersede 纠错，先算后写+失败回滚）。**l1.cog 认知层形成侧内置（09-04）**：`neuron_cog` ops 工具（action=build_graph 批折叠建图，含防假标注门禁——pre 记录 description/accuracy 空则拦截（同步 SubPj7 08-12 修复，fill_precog 合法集 {true,revelant,false}）/ detect_communities 多分辨率 Leiden——本体 `leiden.ts`，leidenalg 实图对照 ΔQ≈0；community.json modularity 复刻 igraph 无权 γ=1 语义，加权 Q 以 q_weighted 另返回）；p7 LLM 概念抽象不移植；读侧 community.json 反查照旧。**注册**：tools.ts `feature('NEURON_RAG')` 门控 require，recall/remember + ops 四件（list/source/fill_precog/cog，shouldDefer）紧跟核心读写组；**名册**经 prompts.ts dynamicSections `neuron_roster` 注入（cwd 根正文上限 8 + 全局根指针行）。定案文档 `20260829142535-神经元内置架构定案.md`（项目根，v2.2）；证据 `20260903204723-BGE-TS化Spike/`（leiden 35/35 + coggraph 双引擎 114/114）+ `20260904153426-DB化同步SubPj7定案/`（隔离冒烟 27/27 + 李京瑾真身迁移脚本/备份/校验：WX 67291、QQ 35158→折叠 35150、mem 4397→折叠 4390、precog 121→折叠 103、revelant 101883 条 id_map 联动）。**项目神经元实例（2026-09-10，三层齐备）**：`Neuron-Pj16`（cwd 根 `.claude/neturon/neurons/`，person.id=PJ16，NEURON_RAG 首个项目库）。**三层齐备**（此前只有 l2.mem + l1.cog，缺 raw 层）：① `l3.raw/LOG/` = LOG.md 原文全文（**真移动**——LOG.md 从项目根迁入本层，项目根不再有 LOG.md，841862 B）+ `message.db` 379 行（每条目一行，`message_id=PJ16LOG_{YYYYMMDD}_{HHMMSS}[_seq]` 与 mem 条目 _seq 一一对齐，content=条目全文、source='LOG.md'、sender/media/quote/forward=null）；② `l2.mem/mem.db` 380 条（`memory_id=PJ16_MEM_时间戳确定性生成`，source='LOG' 379（迁移产物）+ 'MEM'（活写入））+ `embeddings.npy [380,512]` + `index_config.json` 规范三字段 `{model_name,total_entries,embedding_dim}`（无 encoded_ids——该字段仅是 retriever 行数不齐时可选对齐口，真身库亦无）；③ `l1.cog/` 待认知层形成。**revelant 定案（照真身库 Neuron-李京瑾 惯例）**：**首元素 = 该条目在 raw 层的 message_id**，其后为相关会话 jsonl 路径 + 该条目修改文件路径（证据指针数组，全相对项目根；jsonl 按首末行 timestamp 区间匹配，不迁移会话仅索引）。**blocks 切分**：标签并入首块（`【标签】`）、按 `；。` 主切 → 超 300 字按 `+` 细分；**块内不嵌时间戳**（条目时间已蕴含在 memory_id，2026-09-10 用户定案）。source 是来源标签（对照真身库 'QQ'/'微信'），confidence/half_life 取 config 默认 0.85/365。precog 标注语义定案：检索某组件历史→修改相同东西=true、不同东西但改相同文件相同部分=revelant。**生成脚本** `20260910152816-项目神经元初始化/gen_pj16_neuron.ts` 幂等可重跑（写前 `DELETE ... WHERE source='LOG'` 只替换迁移产物、mem 活写入条目不动；raw 层只替换 `PJ16LOG_%` 行；embeddings + index_config 按**全库**重建防活写入向量丢失）。**LOG 更新口（2026-09-10 用户定案「以后本项目去 mem 更新 log」）**= `20260910152816-项目神经元初始化/log_append.ts`（源码 `memwriter.ts` addMemory 的薄入口，复用其 DB 写入+增量重建 embeddings+index_config+检索缓存刷新+行数自愈全链，不复制逻辑；新条目 source='MEM'），LOG.md 自此冻结为历史存档。使用标准 → [standards.md](standards.md) §7。

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
