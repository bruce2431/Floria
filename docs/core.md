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

`src/tools/neturon/` 15 件纯进程内置（引擎核心+工具层，无 Python 子进程）。**双层根扫描发现**：cwd 根 `<cwd>/.claude/neturon/` + 全局根 `<configHome>/neturon/` + RAG_DATA_DIR 追加；目录即注册（含 config.yaml + l2.mem/**mem.db**，2026-09-04 起），id=person.id 跨根唯一，注册表 10s TTL 缓存；仍为旧 mem.json 的目录不注册、经 neuron_list 报 `pending_migration`（含迁移提示）。**存储层 DB 化（2026-09-04，SubPj7 定案同步）**：`db.ts`（bun:sqlite 零依赖）三表统一 schema——l3.raw/<来源>/message.db（7 列）/l2.mem/mem.db（定案 6 列 + 活引擎 4 可空列 pattern/core_file/supersedes/deprecated_by 超集）/l1.cog/precog.db（8 列，纯追加+标注 UPDATE）；缺字段=NULL、时间编码进 id 无独立 time 列（idTime/makeMessageId）、busy_timeout=5000 防双前端写碰撞；content/summary 不落库由 blocks 派生（deriveEntryText）→ embeddings.npy 保持二进制对位、迁移零重建语义（折叠行序变化时全量重编码，embedder encode 分批 32/批防 ONNX OOM）；cog_graph.json/community.json/cog2.json 快照 JSON 保留。旧 JSON 迁移三件（mem 嵌套 men/sem→平铺 / cog precog_records / message 重编 id 返回 id_map 供 revelant 联动；重复 id 同秒遗留 OR REPLACE last-wins 折叠对照 SubPj7）。**检索** = BGE 向量（@huggingface/transformers + Xenova/bge-small-zh-v1.5 ONNX，懒加载动态 import，编码前预小写归一化对齐 Python 生产路径，模型缓存 `<全局根>/cache/models/` 首跑 hf-mirror 下载 91MB）+ Intl.Segmenter 关键词加权 + 自动扩 k + precog 写入；索引缺失/与 mem.db 行数不一致直接报错（无降级）。**写侧** remember add/update（supersede 纠错，先算后写+失败回滚）。**l1.cog 认知层形成侧内置（09-04）**：`neuron_cog` ops 工具（action=build_graph 批折叠建图，含防假标注门禁——pre 记录 description/accuracy 空则拦截（同步 SubPj7 08-12 修复，fill_precog 合法集 {true,revelant,false}）/ detect_communities 多分辨率 Leiden——本体 `leiden.ts`，leidenalg 实图对照 ΔQ≈0；community.json modularity 复刻 igraph 无权 γ=1 语义，加权 Q 以 q_weighted 另返回）；p7 LLM 概念抽象不移植；读侧 community.json 反查照旧。**注册**：tools.ts `feature('NEURON_RAG')` 门控 require，recall/remember + ops 四件（list/source/fill_precog/cog，shouldDefer）紧跟核心读写组；**名册**经 prompts.ts dynamicSections `neuron_roster` 注入（cwd 根正文上限 8 + 全局根指针行）。定案文档 `20260829142535-神经元内置架构定案.md`（项目根，v2.2）；证据 `20260903204723-BGE-TS化Spike/`（leiden 35/35 + coggraph 双引擎 114/114）+ `20260904153426-DB化同步SubPj7定案/`（隔离冒烟 27/27 + 李京瑾真身迁移脚本/备份/校验：WX 67291、QQ 35158→折叠 35150、mem 4397→折叠 4390、precog 121→折叠 103、revelant 101883 条 id_map 联动）。使用标准 → [standards.md](standards.md) §7。
