# 构建标准与 Feature Flag 活审计（build）

> 本文件属 `docs/` 文档库。
> 权威规则与姊妹件：**总标准 → [standards.md](standards.md)**；**前端打包对网关侧的效应 → [gateway.md](gateway.md)**。

## 1. 构建标准

- 源码构建区 `Pj16-CodeAgent构建/_agent-src/`：`src/` `scripts/` `package.json` `bun.lock` `tsconfig.json` `env.d.ts` `node_modules/`。
- 命令（均在 `cd Pj16-CodeAgent构建/_agent-src &&` 后执行）：
  - `bun install` — 装依赖（bun >= 1.3.11）
  - `bun run build` — 构建 → 项目根 `./cli-<ts>.exe`
  - `bun run build:dev` — dev 构建 → **项目根** `cli-dev-<YYYYMMDDHHMMSS>.exe`（dev 构建即部署：产物直出项目根，build.ts 按脚本位置推导 PROJECT_ROOT；构建统一用本命令）
  - `bun run build:dev:full` — 开全部实验 feature（产物 `cli-dev-<ts>-<特性代号>`，时间戳不同不覆盖；注意 CHICAGO_MCP 仍会编入但外部二进制启动到缺失的 `@ant/computer-use-mcp` 运行时包无法干净引导，见 §2.4 broken 节）
  - `bun run compile` — 正式编译 → `./dist/cli-<YYYYMMDDHHMMSS>.exe`（发布流程用）
  - `bun run dev` — 源码直跑（入口 `src/entrypoints/cli.tsx`）
- 产物命名（`scripts/build.ts`）= `<前缀>-<YYYYMMDDHHMMSS>[-<显式 --feature 代号>]`，显式 feature 代号用 `+` 连接（如 `cli-dev-<YYYYMMDDHHMMSS>-PRIVATE_GATEWAY.exe`）；前缀 dev=`cli-dev`、compile=`dist/cli`。默认六个 feature（VOICE_MODE + BUILTIN_EXPLORE_PLAN_AGENTS + PRIVATE_GATEWAY + REACTIVE_COMPACT[usage-policy 拒绝/媒体超限/PTL 自动恢复] + SESSION_LINK[会话间协作] + NEURON_RAG[神经元内置检索/记忆]）与 `--feature-set=dev-full` 不进文件名。**构建一律 `bun run build:dev`（产物名不带 `-PRIVATE_GATEWAY` 代号，含发布；`build:dev:gateway` 已废弃不使用）**；按特性构建仍用 `--feature=X`（产物名带该特性代号；NEURON_RAG 已进默认，显式传 `--feature=NEURON_RAG` 仅剩命名作用）。
- 产物是**自包含单文件二进制**（`bun build --compile --bytecode --packages bundle`），拷到任意项目目录即可用，运行时不需要 src/node_modules。**exe 产物带时间戳是强制规范，不允许覆盖**（禁止覆盖成固定名如 `cli-dev.exe`）；部署/换新 = 直接用新时间戳 exe 启动，旧产物原样保留。
- codegraph 索引：`Pj16-CodeAgent构建/_agent-src/src/.codegraph/`（相对路径存储，随 src 迁移有效）；MCP 查询带 `projectPath=Pj16-CodeAgent构建/_agent-src/src`。
- dev 版本号从 git 派生（sha 取自 git HEAD；仓库仅跟踪 `_agent-src/`、`README.md`、`docs/`，其余项目文件由 .gitignore 排除）。

### 1.1 前端内嵌打包与 cache-busting（改 web 前端必读）

前端权威 `_agent-src/src/gateway/web-src/`（22 ESM 模块，`gateway/web/app.js` 为构建生成物勿手改）；构建时 `scripts/gen-web-assets.ts` 递归 base64 内联进 exe（build.ts 每次构建前自动运行），`localGateway.ts` 内嵌优先、磁盘 public 仅兜底（项目根优先 + 便携根兜底）。**前端改动必须重新构建 exe 才生效**（无磁盘热重载）；**cache-busting**：index.html 资源引用带版本号 `?v=N`（styles.css/app.js），每次前端改动同步 bump 该号（+ sw.js CACHE），浏览器强制下载新版绕过 HTTP 缓存（资源引用为绝对路径，见 [gateway.md](gateway.md) pushState 路由章节）；**注意：前端从未注册 Service Worker**（web/ 目录无 serviceWorker 代码，sw.js 是死文件，浏览器不跑它——更新可靠靠 cache-busting 而非 sw）。**bytecode exe 内嵌资产不可 grep**（字符串经编码），验证资产版本用 `curl http://127.0.0.1:8124/sw.js` 与 `/app.js`。

## 2. Feature Flags 活审计

本仓库现引用 88 个 `feature('FLAG')` 编译期旗标。逐一按当前 external-build defines 与 externals 打包复核结果：

- 74 个旗标可干净打包
- 13 个仍打包失败（其中 5 个已恢复，见 §2.6；10 个远程/云端方向已定案放弃不恢复：CCR 认证族五 flag `BRIDGE_MODE`/`CCR_AUTO_CONNECT`/`CCR_MIRROR`/`CCR_REMOTE_SETUP`/`DAEMON` + `DIRECT_CONNECT`/`SSH_REMOTE`/`KAIROS`/`KAIROS_DREAM`/`PROACTIVE`——均不在任何 feature 集，源码门控保留（编译期 tree-shake））

Important: "bundle cleanly" does not always mean "runtime-safe". Some flags still depend on optional native modules, claude.ai OAuth, GrowthBook gates, or externalized `@ant/*` packages.

### 2.1 Default Build Flags

- `VOICE_MODE`
  已包含在默认构建管线（不限 dev 构建）。启用 `/voice`、push-to-talk UI、voice notices、dictation plumbing。运行时原依赖 claude.ai OAuth + 原生音频模块或 SoX 兜底录音器——OAuth 登录线路已彻底移除，`/voice` 运行时恒不可用（UI/按键编排仍编入，语音 STT/连接链按 OAuth token 恒缺位拒绝），flag 保留仅编排水位，待定去留。
- `PRIVATE_GATEWAY`
  【内置私有化网关，默认开，纯本地】进 `defaultFeatures`：所有默认构建（build / build:dev / compile）均注册 `/server` 指令，内置网关随 exe 编入（`--gateway` 独立进程 + 内嵌 web 前端）。链路详情 → [gateway.md](gateway.md)。
- `REACTIVE_COMPACT`
  进 `defaultFeatures` 默认编入。usage-policy 拒绝（stop_reason='refusal'）自动剥图恢复 + PTL/媒体超限恢复；门控接入 `query.ts`（`tryReactiveCompact` / `isWithheldPromptTooLong` / `isWithheldMediaSizeError` / `isWithheldUsagePolicyRefusal`）与 `commands/compact/compact.ts`（`compactViaReactive` / `isReactiveOnlyMode`）。条目详情见 §2.6。
- `SESSION_LINK`
  【会话间协作，默认开，纯本地/TUI 无关】进 `defaultFeatures`——门控点 = `tools.ts` 里 `feature('SESSION_LINK') ? getSessionSendTool() : null`（工具注册）+ `SessionSendTool.isEnabled()`。启用 `session_send` 工具与跨会话投递（不门控接收侧——接收走既有 `enqueue`，无新代码）。链路 → [core.md](core.md) 末节 + [gateway.md](gateway.md) §13 + [web-ui.md](web-ui.md) §24。

### 2.2 Working Experimental Features

These are the user-facing or behavior-changing flags that currently bundle cleanly and should still be treated as experimental unless explicitly called out as default-on.

#### Interaction and UI Experiments

- `AWAY_SUMMARY` — Adds away-from-keyboard summary behavior in the REPL.
- `HISTORY_PICKER` — Enables the interactive prompt history picker.
- `HOOK_PROMPTS` — Passes the prompt/request text into hook execution flows.
- `KAIROS_BRIEF` — Enables brief-only transcript layout and BriefTool-oriented UX without the full assistant stack.
- `KAIROS_CHANNELS` — Enables channel notices and channel callback plumbing around MCP/channel messaging.
- `LODESTONE` — Enables deep-link / protocol-registration related flows and settings wiring.
- `MESSAGE_ACTIONS` — Enables message action entrypoints in the interactive UI.
- `NEW_INIT` — Enables the newer `/init` decision path.
- `QUICK_SEARCH` — Enables prompt quick-search behavior.
- `SHOT_STATS` — Enables additional shot-distribution stats views.
- `TOKEN_BUDGET` — Enables token budget tracking, prompt triggers, and token warning UI.
- `ULTRAPLAN` — Enables `/ultraplan`, prompt triggers, and exit-plan affordances.
- `ULTRATHINK` — Enables the extra thinking-depth mode switch.
- `VOICE_MODE` — Enables voice toggling, dictation keybindings, voice notices, and voice UI.
- `STREAMLINED_OUTPUT` — Enables streamlined message-output transformation in headless `stream-json` mode when `CLAUDE_CODE_STREAMLINED_OUTPUT=true`（`cli/print.ts` 门控）.

#### Agent, Memory, and Planning Experiments

- `AGENT_MEMORY_SNAPSHOT` — Stores extra custom-agent memory snapshot state in the app.
- `AGENT_TRIGGERS` — Enables local cron/trigger tools and bundled trigger-related skills.
- `AGENT_TRIGGERS_REMOTE` — Enables the remote trigger tool path.
- `BUILTIN_EXPLORE_PLAN_AGENTS` — Enables built-in explore/plan agent presets（默认编入）.
- `CACHED_MICROCOMPACT` — Enables cached microcompact state through query and API flows.
- `COMPACTION_REMINDERS` — Enables reminder copy around compaction and attachment flows.
- `EXTRACT_MEMORIES` — Enables post-query memory extraction hooks.
- `PROMPT_CACHE_BREAK_DETECTION` — Enables cache-break detection around compaction/query/API flow.
- `TEAMMEM` — Enables team-memory files, watcher hooks, and related UI messages.
- `VERIFICATION_AGENT` — Enables verification-agent guidance in prompts and task/todo tooling.

#### Tools, Permissions, and Remote Experiments

- `BASH_CLASSIFIER` — Enables classifier-assisted bash permission decisions.
- `BRIDGE_MODE` — Enables Remote Control / REPL bridge command and entitlement paths.【已放弃】运行时需 claude.ai OAuth 订阅 + GrowthBook 门，被内置网关覆盖，不恢复；已从 `build.ts` `fullExperimentalFeatures` 剔除，源码门控保留（编译期 tree-shake）。
- `CCR_AUTO_CONNECT` — Enables the CCR auto-connect default path.【已放弃】同 BRIDGE_MODE，从 feature 集剔除。
- `CCR_MIRROR` — Enables outbound-only CCR mirror sessions.【已放弃】镜像转发对应能力已在本地落地：`conversationDisplay.ts` 导出 `{role,blocks[]}` + `exportConversationToServer` POST + `sendSessionActivity` 状态上报 → 网关 → floria 网页；已从 feature 集剔除。
- `CCR_REMOTE_SETUP` — Enables the remote setup command path.【已放弃】本地网关 `/server on` 即起，无对应需求；已从 feature 集剔除。
- `CHICAGO_MCP` — Enables computer-use MCP integration paths and wrapper loading.
- `CONNECTOR_TEXT` — Enables connector-text block handling in API/logging/UI paths.
- `MCP_RICH_OUTPUT` — Enables richer MCP UI rendering.
- `NATIVE_CLIPBOARD_IMAGE` — Enables the native macOS clipboard image fast path.
- `NEURON_RAG`
  【本 fork 自有；默认开】神经元记忆/RAG 引擎纯进程内置化：注册 `recall`/`remember`（**不带 neuron_ 前缀**，常驻直载、不经 ToolSearch 检索，直接调用）+ `neuron_list`/`neuron_source`/`neuron_fill_precog`/`neuron_cog`（延迟加载，ToolSearch 可检索）六工具（`src/tools/neturon/` 16 件：BGE 向量检索 @huggingface/transformers + p5/p6 认知链 leiden.ts + coggraph.ts，无 python 子进程）。专用 flag 构建（`--feature=NEURON_RAG`，产物名带代号）仅存档意义。标准见 [standards.md](standards.md) §7，机制见 [core.md](core.md)。
- `POWERSHELL_AUTO_MODE` — Enables PowerShell-specific auto-mode permission handling.
- `TREE_SITTER_BASH` — Enables the tree-sitter bash parser backend.
- `TREE_SITTER_BASH_SHADOW` — Enables the tree-sitter bash shadow rollout path.
- `UNATTENDED_RETRY` — Enables unattended retry behavior in API retry flows.
- `PRIVATE_GATEWAY`
  【内置私有化网关，默认开】注册 `/server` 指令（on/off/status 开关内置网关；`--gateway` 独立进程模式——`/server on` detached spawn 自身 exe，`src/gateway/localGateway.ts`（node:http + ws），CLI 退出不影响网关；web 端 WS `send` 带 `sessionId` → 网关按会话跨进程路由 → CLI `gatewayClient.ts` WS 客户端收消息 → `enqueue` 注入对应 REPL（与打字同路径）；token 落盘 `getPortableRoot()/.claude/gateway-token` 跨进程共享；空闲自动回收——cliClients/sockets/sseClients 三集合全空持续 `GATEWAY_IDLE_MINUTES`（默认 10，env 可调）分钟自动关闭；无 AGENT_CWD；会话列表/读取/SSE 基于便携根）。API 清单、安全加固（token 门）、`/gateway/*` 前缀迁移等全链 → [gateway.md](gateway.md)。纯本地指令，不涉 OAuth/GrowthBook/Anthropic API。

### 2.3 Bundle-Clean Support Flags

These also bundle cleanly, but they are mostly rollout, platform, telemetry, or plumbing toggles rather than user-facing experimental features.

- `ABLATION_BASELINE` — CLI ablation/baseline entrypoint toggle.
- `ALLOW_TEST_VERSIONS` — Allows test versions in native installer flows.
- `ANTI_DISTILLATION_CC` — Adds anti-distillation request metadata.
- `BREAK_CACHE_COMMAND` — Injects the break-cache command path.
- `COWORKER_TYPE_TELEMETRY` — Adds coworker-type telemetry fields.
- `DOWNLOAD_USER_SETTINGS` — Enables settings-sync pull paths.
- `DUMP_SYSTEM_PROMPT` — Enables the system-prompt dump path.
- `FILE_PERSISTENCE` — Enables file persistence plumbing.
- `HARD_FAIL` — Enables stricter failure/logging behavior.
- `IS_LIBC_GLIBC` — Forces glibc environment detection.
- `IS_LIBC_MUSL` — Forces musl environment detection.
- `PERFETTO_TRACING` — Enables perfetto tracing hooks.
- `SKILL_IMPROVEMENT` — Enables skill-improvement hooks.
- `SKIP_DETECTION_WHEN_AUTOUPDATES_DISABLED` — Skips updater detection when auto-updates are disabled.
- `SLOW_OPERATION_LOGGING` — Enables slow-operation logging.
- `UPLOAD_USER_SETTINGS` — Enables settings-sync push paths.

### 2.4 Compile-Safe But Runtime-Caveated

These bundle today, but would still treat as experimental because they have meaningful runtime caveats:

- `VOICE_MODE` — Bundles cleanly; runtime was gated on claude.ai OAuth, which was removed entirely（voice_stream backend dead, `/voice` 恒不可用）. Local recording backend (SoX fallback) no longer relevant.
- `NATIVE_CLIPBOARD_IMAGE` — Bundles cleanly, but only accelerates macOS clipboard reads when `image-processor-napi` is present.
- `BRIDGE_MODE`, `CCR_AUTO_CONNECT`, `CCR_MIRROR`, `CCR_REMOTE_SETUP` — Bundle cleanly, but are gated at runtime on claude.ai OAuth plus GrowthBook entitlement checks.【已放弃】整族放弃：云端远程控制目标被内置网关覆盖，已从 `build.ts` `fullExperimentalFeatures` 剔除（不再编入 dev-full），源码门控代码保留（编译期 tree-shake 裁掉）。
- `KAIROS_BRIEF`, `KAIROS_CHANNELS` — Bundle cleanly, but they do not restore the full missing assistant stack. They only expose the brief/channel-specific surfaces that still exist.
- `CHICAGO_MCP` — Bundles cleanly, but the runtime path still reaches externalized `@ant/computer-use-*` packages. This is compile-safe, not fully runtime-safe, in the external snapshot.
- `TEAMMEM` — Bundles cleanly, but only does useful work when team-memory config/files are actually enabled in the environment.

### 2.5 Restored Stub Flags

These 16 flags were restored by creating the missing stub files. The stubs compile and bundle cleanly, but most are runtime-disabled (`isEnabled: () => false`) — they exist so the build passes, but their features are inert unless activated.

- `AUTO_THEME` — stub `systemThemeWatcher.js` watches OSC 11 (5s poll)
- `BG_SESSIONS` — stub `bg.js` handlers log "not available"
- `BUDDY` — stub command, disabled
- `BUILDING_CLAUDE_APPS` — stub `.md` assets for all languages
- `COMMIT_ATTRIBUTION` — stub `attributionHooks.js` (no-ops)
- `FORK_SUBAGENT` — stub command + `UserForkBoilerplateMessage`, disabled
- `HISTORY_SNIP` — stub command + `SnipTool` + `snipProjection`, disabled
- `KAIROS_GITHUB_WEBHOOKS` — stub `SubscribePRTool` + `subscribe-pr` command + `UserGitHubWebhookMessage`, disabled
- `KAIROS_PUSH_NOTIFICATION` — stub `PushNotificationTool`, disabled
- `MCP_SKILLS` — stub `mcpSkills.js` returns `[]`
- `MEMORY_SHAPE_TELEMETRY` — stub `memoryShapeTelemetry.js` (no-ops)
- `OVERFLOW_TEST_TOOL` — stub `OverflowTestTool`, disabled
- `RUN_SKILL_GENERATOR` — stub `runSkillGenerator.js` registers disabled skill
- `TEMPLATES` — stub `templateJobs.js` + `jobs/classifier.js`
- `TORCH` — stub command, disabled
- `TRANSCRIPT_CLASSIFIER` — stub prompt `.txt` files for all three classifier modes

### 2.6 Broken Flags With Partial Wiring But Medium-Sized Gaps

These do have meaningful surrounding code, but the missing piece is larger than a single wrapper or asset.

- `BYOC_ENVIRONMENT_RUNNER` — Missing `src/environment-runner/main.js`.
- `CONTEXT_COLLAPSE` — Missing `src/tools/CtxInspectTool/CtxInspectTool.js`.
- `COORDINATOR_MODE` — ✅ 已恢复：`src/coordinator/workerAgent.ts` 完整实现 `getCoordinatorAgents()`，返回两个 built-in agent——`coordinator`（tools=`COORDINATOR_MODE_ALLOWED_TOOLS`，prompt=`getCoordinatorSystemPrompt()`）与 `worker`（tools=`ASYNC_AGENT_ALLOWED_TOOLS` − `INTERNAL_WORKER_TOOLS`，独立 worker prompt）。`INTERNAL_WORKER_TOOLS` 已从 `coordinatorMode.ts` 导出；`subagent_type: 'worker'` 派遣经 `AgentTool.tsx:286` 正常解析。全量打包验证 EXIT:0。
- `DAEMON` — 【已放弃】Missing `src/commands/remoteControlServer/index.js`。不恢复：常驻远程控制服务已由内置网关实现（localGateway `--gateway` 独立进程长驻），会话状态/进度推送由 `conversationDisplay.ts` 上报网关承担。不在任何 feature 集，仅保留审计标记。
- `DIRECT_CONNECT` — ❌ 仍 broken：`main.tsx:4065` `import('./server/parseConnectUrl.js')` 与 `main.tsx:4091` `import('./server/connectHeadless.js')` 均无法解析（`src/server/` 下仅存 `createDirectConnectSession.ts` + `directConnectManager.ts`）。【已放弃】`claude open <cc://url>` 连接外部直连会话服务属远程执行方向，与本地化方向不符，不恢复。源码门控 + 残留实现保留（编译期 tree-shake）。
- `EXPERIMENTAL_SKILL_SEARCH` — Missing `src/services/skillSearch/{localSearch,prefetch,featureCheck}.js`（`commands.ts` / `query.ts` / `constants/prompts.ts` 分别 require）。
- `MONITOR_TOOL` — ✅ 已恢复：4 个文件——`tools/MonitorTool/MonitorTool.tsx`（buildTool 产出 `Monitor` 工具，`exec()` + `spawnShellTask({..., kind:'monitor'})` 后台监控进程，流式通知，streaming-only）、`tasks/MonitorMcpTask/MonitorMcpTask.ts`、`components/permissions/MonitorPermissionRequest/MonitorPermissionRequest.tsx`、`components/tasks/MonitorMcpDetailDialog.tsx`。已在 `tools.ts` / `PermissionRequest.tsx` / `BackgroundTasksDialog.tsx` / `runAgent.ts` 门控下接入；默认构建不含该模块（DCE 裁掉）。
- `REACTIVE_COMPACT` — ✅ 已恢复并默认编入：`src/services/compact/reactiveCompact.ts` 完整实现。三类自动恢复：PTL（isWithheldPromptTooLong）/ 媒体超限（isWithheldMediaSizeError）/ **Usage Policy 拒绝（stop_reason='refusal'）自动剥图恢复**——`errors.ts isUsagePolicyRefusalMessage` + `isWithheldUsagePolicyRefusal` + `policyStripRetry`（filter 尾部错误消息 → 复用 compact.ts `stripImagesFromMessages` 全剥 user/tool_result 内嵌 image/document 为文本标记 → buildStripCompactionResult 后缀保留重建，summary 文案参数化），query.ts withhold 块与恢复块各一分支（mediaRecoveryEnabled 同 gate）。仅内存剥图不动 jsonl；无媒体可剥→surface；hasAttemptedReactiveCompact 防螺旋。**入口判型约束：`tryReactiveCompact` 的显式 `errorMsg` 必传参数（唯一调用方 query.ts 传 lastMessage）——withhold 错误只出现在 assistantMessages，messagesForQuery 尾部恒为 user/tool_result**。
- `REVIEW_ARTIFACT` — ✅ 已恢复：4 个文件——`tools/ReviewArtifactTool/constants.ts`、`tools/ReviewArtifactTool/ReviewArtifactTool.tsx`（buildTool 产出 `ReviewArtifact` 工具，`requiresUserInteraction()`，批准弹窗注入 `selected` finding id，批准后把 artifact 落盘 `.claude/reviews/`）、`components/permissions/ReviewArtifactPermissionRequest/ReviewArtifactPermissionRequest.tsx`（`PermissionDialog` + `SelectMulti`）、`skills/bundled/hunter.ts`（hunter 捉虫 skill，驱动审查流程）。已在 `tools.ts` / `PermissionRequest.tsx` / `skills/bundled/index.ts` 门控下接入；默认构建不含该模块（DCE 裁掉）。
- `SELF_HOSTED_RUNNER` — Missing `src/self-hosted-runner/main.js`.
- `SSH_REMOTE` — Missing `src/ssh/createSSHSession.js`.【已放弃】`claude ssh <host>` 远程机器执行属远程执行方向，本地无需求，不恢复。源码门控 + 残留保留（编译期 tree-shake）。
- `TERMINAL_PANEL` — Missing `src/tools/TerminalCaptureTool/TerminalCaptureTool.js`.
- `UDS_INBOX` — Missing `src/utils/udsMessaging.js` + `src/tools/ListPeersTool/ListPeersTool.js`（`tools.ts` 门控下 require）。
- `WEB_BROWSER_TOOL` — Missing `src/tools/WebBrowserTool/WebBrowserTool.js`.
- `WORKFLOW_SCRIPTS` — ✅ 已恢复（单 agent 最小版）：8 个文件——`tools/WorkflowTool/workflowScripts.ts`（扫描 `.claude/workflows/*.md` + frontmatter 解析）、`WorkflowTool.tsx`（buildTool 产出 `Workflow` 工具，`exec()` 解析脚本后 spawn `LocalWorkflowTask` 后台子进程）、`WorkflowPermissionRequest.tsx`、`bundled/index.ts`、`createWorkflowCommand.ts`（`getWorkflowCommands` 把每个脚本注册为 `/name` slash 命令，`kind:'workflow'`）、`tasks/LocalWorkflowTask/LocalWorkflowTask.ts`（`local_workflow` 任务状态 + `kill/skipWorkflowAgent/retryWorkflowAgent`）、`commands/workflows/{index,workflows.ts}`（`/workflows` 命令）、`components/tasks/WorkflowDetailDialog.tsx`；默认构建不含。
  现行要点：①脚本发现用 `getProjectRoot()`（非 `getOriginalCwd()`），`WorkflowTool.call()` 与 `/workflows` 命令两处对齐；②spawn 命令带 `'--no-session-persistence'`（fork 默认持久化会话，缺它会在 `.claude/projects/` 生成独立会话 jsonl 污染 `/resume`）；③多行 CJK prompt 走 `$(cat '<temp>.md')` 临时文件机制（`buildWorkflowCommand`）；④工具 require 直连（不用 IIFE——IIFE 触发 esbuild `--minify-identifiers` 改名 bug，`initBundledWorkflows()` no-op 挂载点保留）；⑤`isInBundledMode()` 对 `--bytecode` exe 须带 `process.argv[1].includes('/~BUN/')` 分支（`Bun.embeddedFiles` 对 `--bytecode` 为空数组，误判会使 `cliCommandPrefix()` 注入垃圾参数，影响所有 spawn 前缀共用方）。

### 2.7 Broken Flags With Large Missing Subsystems

These are the ones that still look expensive to restore because the first missing import is only the visible edge of a broader absent subsystem.

- `KAIROS` — Missing `src/assistant/index.js` and much of the assistant stack with it（另有 `tools/SendUserFileTool/SendUserFileTool.js` 等缺失）。【已放弃】官方云端 assistant 模式（需 Anthropic 后端 + 账号），本地不恢复。KAIROS_BRIEF/KAIROS_CHANNELS 为独立部分可用 surface，**保留**。源码门控保留（tree-shake）。
- `KAIROS_DREAM` — Missing `src/skills/bundled/dream.js` and related dream-task behavior.【已放弃】同 KAIROS 云端 assistant 相关，不恢复。源码门控保留（tree-shake）。
- `PROACTIVE` — Missing `src/proactive/index.js` + `src/proactive/commands/proactive.js` and the proactive task/tool stack.【已放弃】云端主动任务栈（同 KAIROS/CCR 云端方向），本地无需求，不恢复。源码门控保留（tree-shake）。

### 2.8 Useful Entry Points

- Feature-aware build logic: `_agent-src/scripts/build.ts`
- Feature-gated command imports: `_agent-src/src/commands.ts`
- Feature-gated tool imports: `_agent-src/src/tools.ts`
- Feature-gated task imports: `_agent-src/src/tasks.ts`
- Feature-gated query behavior: `_agent-src/src/query.ts`
- Feature-gated CLI entry paths: `_agent-src/src/entrypoints/cli.tsx`
