# 权威标准（standards）

> 本 fork（便携版 Claude Code 重构源码）已与官方产生结构性差异，官方文档不再适用。
> 本文件是**权威标准**：新建/修改 skill、plugin、MCP、changelog、工作区内容时以本文为准。
> 优先级：**本文 > `.claude/CLAUDE.md` 对应章节 > 官方文档**。
>
> 本文件属 `docs/` 文档库（2026-09-10 由原 `STANDARDS.md` 重组而来）。同库姊妹件：
> **构建标准与 feature flag 活审计 → [build.md](build.md)**；
> **项目预览页 Web 容器标准 → [gateway.md](gateway.md)**；
> **代码机制细节 → [core.md](core.md)**（本文只写规则约束）。

## 1. 总则 / 设计原则

| 原则 | 说明 |
|---|---|
| **便携优先** | 整个 `@WrokSpace` 可整体拷到任意盘符/路径，配置、插件、记忆、凭证不失效 |
| **全相对路径（红线）** | 任何命令/配置/脚本/引用一律相对路径，禁止 `C:\...`、`C:/...`、写死盘符、写死用户目录 |
| **扩展只走两个口** | 简单工作流 = skill（`.claude/skills/`）；带 MCP/引擎 = plugin（`.claude/plugins/`）。目录严格分离 |
| **数据随插件走** | 插件活数据放插件目录内（如 `brain/`），随插件整体拷贝，不依赖外部路径 |
| **MCP 只经插件注册** | 禁止在 `settings.json` 的 `mcpServers` 或项目根 `.mcp.json` 单独注册 |
| **会话级生效** | MCP 工具/插件/hook 改动**重启会话才生效**（会话启动时一次性加载） |

## 2. 目录结构标准

```
@WrokSpace/               ← 便携根 = 主工作区（日常产出、项目、临时任务）
├── .claude/              ← 便携全局配置根（settings/skills/plugins；会话与自动记忆均在项目级）
│   └── .claude-portable  ← 便携标记（在配置根内部，不可移动/删除）
├── Pj16-CodeAgent构建/   ← 源码构建区 + 权威标准（原 CODE2431 根 _agent-src 迁入）
│   ├── _agent-src/       ← 构建源码（src/ scripts/ package.json node_modules/ …）
│   ├── docs/             ← 文档库（本文件 + build/glossary/core/gateway/web-ui/README）
│   └── README.md         ← 目录结构说明
├── Pj1-…/Pj15-…/         ← 项目
├── .trash/YYYY-MM-DD/    ← 归档（禁止删除，只归档）
├── LOG.md                ← 工作区 LOG
├── README.md             ← 工作区规范
└── STATUS.md             ← 工作区状态
```

- `.claude/` 内部：
  - `skills/` — 纯 skill（json-canvas / officecli / wetrace-wechat-tool）
  - `plugins/` — 插件（agent-browser / codegraph）
  - `plugins/` 下 `marketplaces/`、`data/`、`known_marketplaces.json` 是**系统管理目录，勿动**；缓存清理只动 `cache/` 三层，不碰插件目录
  - `projects/` — 旧版全局自动记忆桶（2026-08-11 起自动记忆改项目级，遗留桶不再读写），App 管理
  - `sessions/`、`history.jsonl` — 旧版会话存储，App 管理（新会话写入项目 `.claude/projects/*.jsonl` 平铺目录）

### 2.1 会话 / 自动记忆存储布局（2026-08-11 扁平化）

| 数据 | 位置 | 说明 |
|---|---|---|
| **会话** | `<项目>/.claude/projects/*.jsonl` | **项目本地、平铺**（不再按启动目录分桶），随项目文件夹打包/归档不丢失 |
| **自动记忆** | `<项目>/.claude/projects/memory/` | **项目本地、平铺**，随项目文件夹打包/归档不丢失；`MEMORY.md` + 各主题文件 |

- 会话目录：`getProjectDir()`（`sessionStoragePortable.ts`）＝ `<项目>/.claude/projects`（**平铺**）。跨项目会话列表（`/resume`、stats、cleanup、insights 等）用**逐级向上扫描**：`getProjectSessionDirsUpToHome(cwd)` / `getSessionProjectsParentsUpToHome(cwd)` 从 CWD 逐级收集 `<dir>/.claude/projects` 直至配置根，再加配置根本身的 projects 目录 → 从任何子目录启动都能看到该项目全部会话。
- 自动记忆：`getAutoMemPath()`（`memdir/paths.ts`），优先级 = `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` → settings.json `autoMemoryDirectory`（policy/local/user，排除 projectSettings）→ 默认 `<项目>/.claude/projects/memory/`（镜像会话目录 `getProjectDir()`，随项目移动）。`getMemoryBaseDir()` 仍锚定全局配置根，仅服务**用户级 agent-memory**（`<配置根>/agent-memory/`）与旧路径检测；自动记忆不再落全局根。
- **启动位置决定记忆**：记忆按「启动时 CWD 的项目根」解析，写入该项目 `.claude/projects/memory/`——从 `@WrokSpace` 启动读写工作区记忆，从 `@WrokSpace/Pj2-…` 启动读写 Pj2 记忆。统一从 `@WrokSpace/cli-dev.exe` 启动。从同一项目不同子目录启动，会话/记忆共用同一平铺目录，不再碎片化。
- **归档**：要归档某项目时，直接 zip 整个项目文件夹（含 `.claude/projects/`）即带走会话**和自动记忆**（两者同目录），无需单独导出。
- **迁移现状（2026-08-11 完成）**：一次性扁平化迁移（`@WrokSpace/.claude/scripts/migrate-flat-sessions.mjs`）已收尾——各项目与配置根的 `<sanitized>` 旧桶内 `*.jsonl` / `<sessionId>/` 子目录 / `memory/` 全部上移合并到 `.claude/projects/` 顶层，跨桶按 sessionId 去重保留最新（仅 `fs.rename`，mtime/会话名不变），旧桶与重复文件移 `.trash/YYYY-MM-DD/`。原「当前会话 harness 记忆桶」由用户手动平铺合并；并发活跃会话桶在会话重启改走平铺写入后由脚本归档。另发现并归档了 4 个项目根级的**更早期**遗留记忆桶（`<项目>/<sanitized>/memory/`，早于 `.claude/projects` 结构，内容与平铺完全一致）。当前全工作区已无任何 `<sanitized>` 桶，全部平铺。

## 3. 便携配置根与路径红线

**配置根解析**（`Pj16-CodeAgent构建/_agent-src/src/utils/envUtils.ts` `getClaudeConfigHomeDir`，优先级从高到低）：

1. `CLAUDE_CONFIG_DIR` 环境变量
2. exe 旁边的 `.claude/`（**须带配置根标记**：`.claude-portable`/`.claude.json`/`settings.json`/`plugins`/`skills`/`commands`/`credentials.json`/`history.jsonl` 任一存在才认；**只有 `projects/` 不算** → 项目本地会话目录不会误判）
3. 从 exe 目录**逐级向上**找 `.claude/.claude-portable` 标记 → 命中用「该 `.claude` 目录」
4. 兜底 `~/.claude`

（解析链与裸机初始化的机制细节 → [core.md](core.md)「便携配置根」。）

**硬性约束**：
- `.claude/.claude-portable` 和 `.claude/` **必须留在 `@WrokSpace` 根目录**。挪进子文件夹后，exe 副本从 `@WrokSpace\<项目>\` 运行向上找不到标记 → 配置掉回 `~/.claude`，插件/记忆/凭证全失效。
- 写命令/配置/脚本引用一律相对路径；只在极少数无法用相对路径处（如 hook 子进程 CWD 不固定）先与用户确认。

## 4. Skill 标准

### 4.1 定义
- 一组 markdown 工作流指令（`SKILL.md`）+ 可选脚本/参考文档，**纯 skill 不注册 MCP**。
- 需要 MCP / 引擎 / 活数据时**升级为 plugin**（§5），不要塞进 skills/。

### 4.2 目录结构
```
.claude/skills/<name>/
├── SKILL.md          # 必须
└── references/       # 可选（如 EXAMPLES.md）
```

### 4.3 SKILL.md 格式
```yaml
---
name: <英文短横线名，如 json-canvas>
description: <何时用/怎么用，一句话，供 Skill 工具自动命中>
---
# <标题>
## 工作流
1. ...
```
- frontmatter 必填 `name` + `description`；name 用英文短横线。
- 复杂脚本/工具全文存插件的 `l3.raw/`，SKILL.md 只写工作流 + 相对路径引用（见 §7）。

### 4.4 发现与注册（无 manifest 门槛）
- 项目 skills 加载器从 **originalCwd 逐级向上**扫 `.claude/skills/<name>/SKILL.md`（便携下命中 `@WrokSpace/.claude/skills/`）。
- **SKILL.md 存在即注册**；bare 模式 / projectSettings 源禁用时跳过。
- 触发：Skill 工具按 description 自动命中，或 `/skill名`。

### 4.5 规则
- 纯 skill 目录**不带** `.claude-plugin/plugin.json`——带了的目录会被插件加载器当插件（§5），skills 加载器反而跳过它。

## 5. Plugin 标准

### 5.1 定义
- 目录内**含 `.claude-plugin/plugin.json` 即视为插件**（manifest 驱动）。
- 带 MCP 服务器、引擎代码、活数据（如 neturon `brain/`）、模板的扩展一律走 plugin。

### 5.2 plugin.json（清单）
```json
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "一句话说明",
  "author": { "name": "bruce2431" },
  "homepage": "https://…（可选）"
}
```
- 必填：`name`（英文短横线、无空格）。建议：`version`(semver)、`description`、`author`。
- 完整 schema（`PluginManifestSchema`，顶层均为可选 partial）还支持：`hooks` / `commands` / `agents` / `skills` / `outputStyles` / `channels` / `mcpServers`（内联或「相对 JSON 路径 / `.mcpb`」引用）/ `lspServers` / `settings`（合并时只保留白名单键）/ `userConfig`。
- 运行时未知顶层字段被静默剥掉（容错）；开发期用 `claude plugin validate` 严格校验（typo/非 kebab-case/缺字段会给告警）。

### 5.3 目录结构
```
.claude/plugins/<name>/
├── .claude-plugin/plugin.json   # 必须；name 决定 MCP 命名空间
├── .mcp.json                    # 可选；注册本插件 MCP 服务器
├── skills/                      # 可选；插件 skill，触发 /插件名:skill名
├── docs/                        # 可选
└── 引擎代码 / 活数据(brain/) / 模板
```

### 5.4 发现与注册（两个来源，manifest 驱动）
| 来源 | 目录 | source 标记 |
|---|---|---|
| @skills-dir | 项目 `.claude/skills/<name>/`（含 plugin.json 的才算插件） | `skillsdir` |
| @plugins-dir | 便携插件目录 `@WrokSpace/.claude/plugins/<name>/`（=`getPluginsDirectory()` = 配置根 plugins/） | `pluginsdir` |

- **判定**：子目录含 `.claude-plugin/plugin.json` → 加载为插件；纯 skill 目录（无 manifest）→ 交给 skills 加载器；系统条目（`marketplaces/`、`data/`、`*.json`）无 manifest 自动跳过。
- **常驻启用**（always enabled）、**不复制到 cache**——活在项目内，随配置根整体搬（便携）。
- 加载连带效果：
  - 插件 skills 以 `/<插件name>:<skill名>` 触发
  - 插件根 `.mcp.json` **自动注册 MCP 服务器**（`loadPluginMcpServers`）
  - MCP 工具命名空间 = `mcp__plugin_<plugin.json 的 name>_<server>__*`（**与目录名无关**）
- gates：bare 模式 / projectSettings 源禁用时跳过。

### 5.5 注册优先级与覆盖
- `--plugin-dir`（session 插件）**>** 同名 @skills-dir 插件（同名时 skillsdir 被过滤）。
- marketplace 安装插件按名被 session/skillsdir 覆盖，**除非**被 managed（policySettings）锁定。
- 依赖缺失 → `verifyAndDemote` 临时禁用（session 级，不写 settings）。

### 5.6 生命周期
- 会话启动时一次性加载；改动**重启会话才生效**。
- `.mcp.json` 用 `${CLAUDE_PLUGIN_ROOT}` 指向插件根定位脚本（相对路径，便携）。

### 5.7 现状清单
- ~~`neturon/`~~（已移除，2026-09-04 核实不存在）— neturon-rag RAG 插件（MCP 形态 `rag_search`/`rag_cog_context`/`rag_fill_precog`/`rag_source`/`rag_should_search`）。已被 Pj16 TS 内置版取代：引擎重写为纯进程内置工具 `_agent-src/src/tools/neturon/`（15 件，NEURON_RAG 门控，标准见 §7），插件随之退役。**数据根 `@WrokSpace/.claude/neturon/` 不动**（neurons/ 记忆库 + cache/models 模型，TS 版原样续用）；`engine/` Python 引擎已随之归档 `.trash/2026-09-04/engine/`（用户定案不留兜底，出问题直接报错；neurons/ 记忆库与 cache/models 留原位供 TS 版使用）。
- `codegraph/`（name=`codegraph`）— 代码知识图谱 MCP，索引 `Pj16-CodeAgent构建/_agent-src/src/.codegraph/`
- ~~`qwen-mm/`~~（已移除 2026-08-24 → `.trash/2026-08-24/qwen-mm/`）— Qwen-MM-Plugins 便携版（2026-08-14）：core（本地多模态读取/可视化 MCP + skill）+ api（云端 Qwen VL/Omni/ASR，需 DashScope key）。引擎 `src/`（精简 pyproject：core viz 全依赖 + api 依赖并入 `[project].dependencies`，entry `qwen-mm-plugins-core`/`qwen-mm-plugins-api`）+ `skills/qwen-mm-plugins-core/`、`skills/qwen-mm-plugins-api/` + `config/config` 活数据。`.mcp.json` 两个 server，均 `uvx --from ${CLAUDE_PLUGIN_ROOT}`（本地构建，不联网）：`qwen-mm-plugins-core` / `qwen-mm-plugins-api`，env `PYTHONUTF8=1`（防 Windows GBK `UnicodeEncodeError`）+ `QWEN_MM_CONFIG_DIR=${CLAUDE_PLUGIN_ROOT}/config`（便携）。config 写 `DASHSCOPE_API_KEY` + `DASHSCOPE_BASE_URL`（用户百炼专属网关 `…maas.aliyuncs.com/compatible-mode/v1`，可覆盖默认 dashscope 地址）。MCP 工具命名空间 `mcp__plugin_qwen-mm_qwen-mm-plugins-core__*` / `mcp__plugin_qwen-mm_qwen-mm-plugins-api__*`。移除原因：用户主动移除视觉插件；config 内 `DASHSCOPE_API_KEY` 已随目录进 `.trash` 未删除。MCP 工具下次重启会话后消失。
- ~~`telemetry-monitor/`~~（已移除 2026-08-14 → `.trash/2026-08-14/telemetry-monitor/`）：会话遥测 MCP（notify_progress 推飞书 / get_session_status 读会话摘要）。`get_session_status` 用的旧桶 glob（`projects/*/*.jsonl`）与平铺会话存储不兼容已失效，功能被内置网关 `/gateway/sessions` 覆盖；`notify_progress` 飞书推送能力随内置网关接管。MCP 工具下次重启会话后消失。

## 6. MCP 服务器标准

- 只通过插件 `.mcp.json` 注册（`"command"` + `"args"`，可含 `${CLAUDE_PLUGIN_ROOT}`）。
- **参数来源仅两个**：config 或指令运行时显式提供；**禁写死默认值**（如 `top_k` 必填，`default_res`/`model` 已在 config）。
- **序列化必须用管线序列化器**：cog.json → `_write_cog_json(_serialize_cog)`，mem.json → `serialize_revelant_inline`；**禁裸 `json.dump(indent=2)`**——numpy `float32` 等会直接序列化崩溃。
- **MCP 必须完全复刻管线逻辑**（管线=成熟摹本，MCP 须完全实现，不允许近似）。
- 检索类工具返回 `precog.record_id` 时，调用方**必须立即** `rag_fill_precog` 填 accuracy/description（`true`=直接回答 / `revelant`=相关非直接 / `false`=噪音）。
- 已知坑：`rag_cog_context` 曾报 `Object of type float32 is not JSON serializable`（cog 层 numpy 分数未转 Python float）——MCP 侧修复时注意。

## 7. 记忆 / RAG 标准（neturon）

- **TS 内置化进行时（2026-09-03/09-04）**：引擎已重写为纯进程内置工具 `_agent-src/src/tools/neturon/`（15 件：config/serialize/npyio/embedder/segment/retriever/memwriter/precog/usageHint/recall/remember/leiden/coggraph/roster/index），`feature('NEURON_RAG')` 门控**默认关**。工具 = `neuron_recall` / `neuron_remember` / `neuron_list` / `neuron_source` / `neuron_fill_precog` / `neuron_cog`（build_graph / detect_communities）。双引擎对照 114/114 全绿。**两个 Python quirk 保真勿「修正」**：`partition.q` = igraph VertexClustering.q 无权 γ=1 模块度（加权 Q 以 `q_weighted` 随工具返回）、fold 路径 `merged_from` 恒空（仅 phase1 全量归并写入）。neturon-rag 插件**已移除**（2026-09-04，见 §5.7）——下方 MCP 时代流程描述仅作数据格式/管线语义参考。待重建 NEURON_RAG exe（构建命令见 [build.md](build.md)）实测 p5/p6（`neuron_cog`），通过后定案 NEURON_RAG 转默认开。机制细节 → [core.md](core.md)「神经元内置检索/记忆」；定案全文 → 项目根 `20260829142535-神经元内置架构定案.md`（v2.2）。
- **三层管线**：`l3.raw`（脚本/工具全文）→ `l2.mem`（记忆片段，blocks[0] 必须是原始 query）→ `l1.cog`（概念/社群/precog）。**raw 层惯例（2026-09-10 照 Neuron-李京瑾 定案）**：每条 mem 条目的 `revelant[0]` = 其 raw 层 `message_id`（`l3.raw/<来源>/message.db`），`source` = 来源标签（'LOG'/'MEM'/'QQ'/'微信'…）——Pj16 实例同此（LOG.md 原文已真移动进 `l3.raw/LOG/`，项目根不再有 LOG.md；新条目走 mem 层 = `log_append.ts`，LOG.md 冻结为历史存档）。
- **写记忆**：脚本/工具全文存 `l3.raw/`，`core_file` 只存**相对路径**引用；同一源不重复记录（复用同一源）。
- **检索（双检索）**：`rag_search` 查 mem（唯一写 precog）+ `rag_cog_context` 全查五层（概念/社群/precog节点/聚合节点/mem）。
- 命中后用 `rag_source` 取完整 `men.content` 确认真实上下文，按 `core_file[].path` 复用脚本，不重复造轮子。
- 同一话题有失败（pattern=try）和成功（pattern=succeed）两条时，认准成功那条。
- 提及人物名（ljj/lcx/gky/sc/lyg 等）先 `rag_should_search`，人名 = explicit 触发。
- 查询用自然语句（做了什么/怎么做的），不要关键词堆砌（BGE 对自然语句友好）。

## 8. Changelog 标准

- **源文件 = `changes.md`**（exe 旁或 CWD）。App 启动时 `syncLocalChangesToCache()` 把它同步进 `.claude/cache/changelog.md`（供 "What's new" 展示）。
- `cache/changelog.md` 是 **App 展示缓存**，会被同步/网络拉取**覆盖**，**禁止手工往里写**。
- **禁止**在 `@WrokSpace` 根创建 `CHANGELOG.md`——官方惯例在本 fork 不适用，App 不读它（2026-08-07 已踩坑归档）。
- 格式：`## <版本号/日期>` + `- 条目`；支持非 semver 键（如日期），解析器会自动按日期排序。
- 工作区的变更记录走 `@WrokSpace/LOG.md`（LOG 只追加），两者职责不同，不混用。

## 9. 工作区约定（@WrokSpace）

- **🔴 所有文件只能在项目内建立（红线）**：任何生成/创建/修改文件都必须落在 `Pj16-CodeAgent构建/**` 内（Pj16 会话：本项目与工作区根 `LOG.md` + 规范四件（`CLAUDE.md`/`README.md`/`STATUS.md`/`.hermes.md`）自动放行，其它落点写操作**弹审批**（`defaultMode: default`，仅 `rm`/`rmdir` 直接拒绝）；Pj1/Pj2/Pj11/Pj13/Pj14/Pj15 各自 `.claude/settings.json` 为 deny 锁死，只写自身 + 根 5 件）。**严禁在项目外创建任何文件**，包括但不限于：系统临时目录（`/tmp`、`%TEMP%`）、桌面根、其它盘符、工作区根等。截图/临时产物一律放任务目录或项目内子目录（如 `SubPj1-*/shots/`）（2026-08-12 曾把截图拷到 `/tmp` 违规，须避免）。
- **LOG 只追加不修改**，`patch` 追加模式，时间戳从 `date` 命令获取。
- **临时任务目录命名**：`YYYYMMDDHHMMSS-名称`（紧凑时间戳无方括号）；存量 `[YYYY-MM-DD-HH-MM-SS]-名称` 旧目录不改名（含其中会话，改名断接续）。
- **单文件产出不建临时目录**：单个 md/脚本/图等直接建 `YYYYMMDDHHMMSS-名称.ext` 放目标位置（如项目根 `Pj16-CodeAgent构建/`），多文件才建 `YYYYMMDDHHMMSS-名称/` 目录（`.hermes.md` 规则A）。
- **禁止删除**：废弃内容移到 `.trash/YYYY-MM-DD/`。
- **操作后立即验证结果**。
- 项目变更需**同时更新**项目内 LOG 和工作区 LOG；状态目录树见 `STATUS.md`。
- 门控规则见 `.hermes.md`（禁止捏造事实、禁止删除、临时任务命名、操作后验证）。
- **不自己运行** `启动.bat` / `start_site.py` 启动本地站点（0zijun 等由用户自己双击启动；需要站点运行时告知用户去启动）。

## 10. 与官方版本的主要差异

| 项 | 官方 Claude Code | 本 fork |
|---|---|---|
| 全局配置根 | `~/.claude` | `@WrokSpace/.claude`（`.claude/.claude-portable` 标记逐级向上找） |
| 插件发现 | marketplace + `--plugin-dir` | 额外扫描 `.claude/plugins/`（@pluginsdir 原地插件） |
| MCP 命名空间 | `mcp__<server>__*` | `mcp__plugin_<plugin name>_<server>__*` |
| Changelog | 根 CHANGELOG.md / GitHub 拉取 | `changes.md` → `cache/changelog.md` 同步 |
| 构建 | npm 官方发布流程 | `bun --compile --bytecode` 自包含单文件（→ [build.md](build.md)） |
| 项目 `.claude/` | trust/onboarding 触发创建 | **惰性创建**（首次写项目设置才 mkdir；会话存储的 `.claude/projects/` 写会话时自动建） |
| 会话/记忆存储 | 全局 `~/.claude/projects/` 统一 | **会话/自动记忆均项目级、平铺**：会话 `<项目>/.claude/projects/*.jsonl`，记忆 `<项目>/.claude/projects/memory/` |
| 权限规则 `@/` 前缀 | 无此语法 | **自定义特性，生效中**：`@/` 解析到便携根（`.claude-portable` 标记所在 `.claude` 的父目录 = `@WrokSpace`），Edit/Read 的 allow/deny 规则均有效（`filesystem.ts` `patternWithRoot`） |
| `.claude` 目录编辑 | 可直接编辑 | **危险目录守卫**：路径任意段 = `.claude`（`.claude/worktrees` 除外）→ acceptEdits 与项目级 allow 被无视，强制弹「编辑自己配置」审批；唯一豁免 = **会话级** allow 规则 `/.claude/**` 或 `~/.claude/**`（审批框选项 2 即写入，会话结束失效） |
| 品牌身份 | Claude Code / Anthropic | **白标 Floria**（2026-09-01 P0 落实：身份句族 11 处 + env 假情报 3 句 + 主提示散句 + 工具描述 + guide agent 改造为 Floria guide；`CLAUDE_CODE_ATTRIBUTION_HEADER` 全局关；D 层功能性标识 `.claude`/`CLAUDE_*`/工具协议等不动） |

## 11. 常见坑速查

- **`.claude/.claude-portable` / `.claude/` 挪走** → exe 副本向上找不到标记 → 配置掉回 `~/.claude`，插件/记忆/凭证全失效。
- **exe 副本放进带配置根标记的项目 `.claude/`**（含 `.claude.json`/`settings.json`/`plugins`/`skills` 等）→ 配置根判定第 2 步静默切到项目本地，插件/记忆/凭证全失效（Pj2 已踩坑，见记忆 portable_config_behavior）。**只有 `projects/` 的目录不算配置根**。Pj16 现状（2026-09-04 核实）：`Pj16-CodeAgent构建/.claude/` 自带 `settings.json`（08-12 会话权限）标记位本就命中，但本机 `CLAUDE_CONFIG_DIR` 已设 **HKCU 用户级**恒指 `@WrokSpace/.claude`（envUtils.ts 第 1 步 env 永远赢）→ 邻接判定永不生效，项目级 skill（archify）/`preview/` 可安全存放；仅无该 env 的拷 exe 部署场景按本条处理。
- **会话/自动记忆项目级、平铺**（2026-08-11 起，不再按启动目录分 `<sanitized>` 桶）：会话写入 `<项目>/.claude/projects/*.jsonl`，自动记忆写入 `<项目>/.claude/projects/memory/`，均随项目打包归档不丢失。跨项目会话列表用逐级向上扫描。
- **项目级 `.claude/` 启动不自动建** → 只在首次写项目设置（`/permissions`、`/config`、MCP 审批、插件装项目 scope）才惰性创建；要手动放 `CLAUDE.md` 或空 `settings.json`。
- **settings.json hooks 用 CWD 相对路径**（`.claude/...`）→ 在 `@WrokSpace\[项目]\` 等子目录会话里 `recall_hook.py`/`statusline.mjs` 静默跳过（RAG 自动触发失效），只在 `@WrokSpace` 根目录跑才命中。
- **MCP/插件/hook 改动不热加载** → 必须重启会话。
- **编辑 `.claude` 下文件总弹审批** → 是危险目录守卫（`isDangerousFilePathToAutoEdit`）在拦，不是权限规则失效；审批框选项 2 = 写会话级 `/.claude/**` 豁免（会话结束失效）。`@/` 前缀规则本身有效，勿建议改写成绝对路径（违反便携红线）。
- **MCP 序列化** → 禁裸 `json.dump(indent=2)`，用管线序列化器，否则 float32 崩溃。
