# Floria

便携版 Claude Code fork 的**源码构建区 + 权威标准**所在仓库（原 `Pj16-CodeAgent构建/_agent-src/`，现为独立 git 仓库根，远程 `bruce2431/Floria`）。

## 仓库内容

- `src/` — Claude Code 源码（bun + ink + React，入口 `src/entrypoints/cli.tsx`）；web 前端唯一手改处 `src/gateway/web-src/`，内置网关 `src/gateway/`。
- `scripts/` — 构建与维护入口：`build.ts`（构建 + 编译期 feature 裁剪）、`bundle-web-modules.ts`（前端拼接器）、`gen-web-assets.ts`（资产内联）、`init-neuron-project.ts` / `rebuild-neuron-index.ts`（神经元库维护）。
- `probes/` — 本地探针 `probe-*.ts`（秒级只读验证，`bun probes/probe-X.ts` 直跑）。
- `docs/` — 文档库（索引 `docs/README.md`）：`standards.md`（权威规则）/ `build.md`（构建 + flag 审计）/ `glossary.md`（术语）/ `core.md`（源码核心机制）/ `gateway.md`（网关服务）/ `web-ui.md`（web 链路）；`docs/screenshots/` 界面截图。
- `assets/` — 构建资源；`package.json` / `bun.lock` / `tsconfig.json` / `env.d.ts` — 构建环境。
- `temp/` — 临时产物落点（不入库）。

## 功能速览

- **单文件便携 exe**：`bun build --compile` 自包含单文件（CLI + 内置网关 + web 前端全打包），拷到任意目录运行；便携根标记 `.claude/.claude-portable`（不可移动/删除）让 settings/插件/记忆/凭据跟随 exe 文件夹；裸机首次启动在信任对话框选 yes 即在 exe 旁播种便携根（`maybeInitPortableRoot`）。
- **双等权前端，共同后端**：CLI（React/Ink REPL）与 web（网关静态托管单页）是同一会话引擎的两个等权前端；局域网 iPad/手机访问 `floria.local`（mDNS）远程使用。
- **设备配对授权**：新设备连入时授权门出一次性配对码，PC 端 `/server auth add <配对码>` 完成授权；票证持久化挂域 cookie，换网不重复授权。
- **实时处理折叠**：处理中折叠流式展开旁白/思考/工具步 + 「正在处理」实时计时；回复落地自动收起为「已处理 X」（计时定格），仅保留总结。回复操作条含复制 / 用量明细面板（本轮+合计/缓存/模型）/ 时间。
- **视图卡片化 + chat ⇄ work 双模式**：web 主区一视图一卡（注册表 `views/registry.js`，`#chat-area` 为无形共享槽）；`floria·work` 为 Prism 式工作区——侧栏白卡 + 编辑/聊天下沉洞 + 预览常驻右栏 + 顶栏会话胶囊；编辑区 Obsidian 式源码编辑 / 阅读切换 + 语法高亮。
- **夜晚模式**：`<html data-theme>` 驱动，缺省跟随系统 `prefers-color-scheme`，手动切换写 `localStorage['floria-theme']`。
- **带图/带文件消息全链**：web 端拖拽/粘贴上传图片（一次最多 9 张）与任意文件（胶囊/卡片），气泡内联缩略图 + lightbox 查看；CLI/web 双端渲染一致。可选 AI 生图展示链：模型输出 `![](代号.png)`，图落 `<项目根>/.claude/images/`。
- **消息渲染增强**：数学公式 KaTeX（`$…$` / `$$…$$`，仅 web）、```chart 双段围栏（web 渲 html / CLI 显 ascii）、轮次导航轨、底栏任务栏浮窗。
- **项目评论批注**：work 右栏评论 tab + 文件内选中「添加评论」，存 `<项目>/.claude/comments.json`，原文内联标记 + 定位回跳。
- **远程审批**：CLI 权限弹窗实时中继为 web 审批卡，iPad/手机可远程批准/拒绝，双端竞速先操作者生效。
- **会话间协作**：输入栏 `@` 浮窗或「+」菜单「引用会话」选定目标会话（目录寻址，无授权门），agent 可用 `session_send` 跨会话投递消息（含 `new_session` 拉起新会话）；接收侧与本地 user 消息同构落盘、同路入队，气泡外带一行来源灰字。
- **项目个性化预览**：项目产物（架构图/可视化页）落 `<项目>/.claude/preview/`，由网关静态托管，web 项目预览页内直接查看；预览可申报卡片（`preview.json` cards 段）与浮窗动作（`quoteActions`）。
- **神经元知识库（NEURON_RAG，默认 feature）**：BGE 本地嵌入 + recall/remember 内置工具 + leiden 社群认知形成链，全链 TS 化进 exe；全项目 `Neuron-PjN` 三层库 + 认知管线（mem→cog→社群命名）。

## 界面速览

> 下列截图取自 2026-09-07 前版本；此后界面已经历视图卡片化与 `floria·work` 双模式改版，几何与配色以运行中的实际界面为准（机制见 [docs/web-ui.md](docs/web-ui.md) §41、§43）。

**Web 前端**：插件页（官方市场 + 个人插件）/ 项目页（项目分组，点击进入个性化预览）/ 模型页（全局默认模型切换）。

![插件页](./docs/screenshots/web-plugins.jpeg)

![项目页](./docs/screenshots/web-projects.jpeg)

![模型页](./docs/screenshots/web-models.jpeg)

**会话处理折叠**：处理中流式展示旁白/思考/工具 + 计时；完成后自动收起为「已处理 X」，仅留总结。

![处理中：流式展开](./docs/screenshots/session-live.png)

![完成后：自动折叠仅留总结](./docs/screenshots/session-fold.png)

**引导消息碎片化交错渲染**：旁白与工具折叠行按线性序交错。

![引导消息](./docs/screenshots/session-guide.png)

**设备配对授权门**：新设备连入时出一次性配对码。

![设备配对授权门](./docs/screenshots/pairing-gate.png)

**项目个性化预览**：产物由 skill 落 `<项目>/.claude/preview/`，网关静态托管 `/preview/<label>/*`，项目页 iframe 直开（无预览回落内置默认主页），远程设备经 `/backend/<label>/` 反代可看。

![Pj13 项目个性化预览：论文精读](./docs/screenshots/preview-pj13.png)

## 构建与部署

- 命令（在本仓库根目录执行）：`bun install` / `bun run dev`（源码直跑）/ `bun run build:dev`（dev 构建，默认含内置网关，构建与发布统一用本命令）/ `bun run compile`（正式编译 `dist/cli-<ts>.exe`）。
- 产物：dev 构建直出**项目根**（`Pj16-CodeAgent构建/`）`cli-dev-<YYYYMMDDHHMMSS>[-<flag>].exe`，正式编译出 `dist/cli-<YYYYMMDDHHMMSS>.exe`。**带时间戳是强制规范，不允许覆盖**（不设固定名副本）。
- 部署：构建完成即已在项目根，直接用带时间戳的产物 exe 启动，**重启会话/网关进程才生效**（web 前端资源内嵌进 exe，换 exe 即换前端）。
- codegraph 索引：`src/.codegraph/`（相对路径存储），MCP 查询带 `projectPath=Pj16-CodeAgent构建/Floria/src`。

## 版本控制（git）

- 本目录即仓库根，远程 `bruce2431/Floria`；`node_modules/`、`.codegraph/`、`dist/`、`temp/`、`*.exe`、`.env*` 由 `.gitignore` 排除。
- **GitHub Release 发布**：tag 与版本串格式 = `v<X.Y.Z>+<YYYYMMDD>.t<UTC时分秒>.sha<HEAD 8 位>`。构建元数据必须挂 `+` 不挂 `-`——`-` 是 SemVer 的 pre-release 段（语义「该版本的预发布」，优先级还低于该版本本身），会把已发布正式版标成自相矛盾的预发布；`+` 是 build metadata，不参与优先级比较。`X.Y.Z` 取 `package.json` 的 `version`，dev 构建版本串 = `<version>+<构建元数据>`（`scripts/build.ts` `getDevVersion`）。**Release 标题 = 裸 tag 名**（不另起游离标题）；notes = 功能一句话 + 缺陷一行（不写「现象→根因→修法」叙事）。**递增按改动性质走标准 SemVer**：不兼容 → MAJOR、新功能 → MINOR、纯修复/调参 → **单独切 PATCH（末位 +1，不并入功能版）**。流程 = commit+push → 按该 HEAD 构建 exe → 建同名 tag → Release → 附该次构建的 exe 为 asset（产物带时间戳，不覆盖）。远程 `github.com:443` 不通时走 REST（推送模板 `Neuron-Pj16/l3.raw/files/20260922140000-push-via-api.py`）。
