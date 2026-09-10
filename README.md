# Pj16-CodeAgent构建

便携版 Claude Code 的源码构建区 + 权威标准所在项目（2026-08-11 全工作区重组后，由原 CODE2431 根目录迁入）。

## 本项目内容

- `_agent-src/` — Claude Code 源码 + 构建环境。包含 `src/`、`scripts/`、`package.json`、`bun.lock`、`node_modules/` 等。构建命令在 `cd _agent-src &&` 后执行（`bun install` / `bun run build:dev` / `bun run compile` / `bun run dev`）。
- `docs/` — 文档库（2026-09-10 自原 STANDARDS/FEATURES/ARCHITECTURE 三件重组，索引 `docs/README.md`）：`standards.md`（权威规则）/ `build.md`（构建+flag 审计）/ `glossary.md`（术语）/ `core.md`（源码核心机制）/ `gateway.md`（网关服务）/ `web-ui.md`（web 链路）。权威标准见 `@WrokSpace/.claude/CLAUDE.md` 顶部引用。
- `README.md` — 本文（原 CODE2431 根目录结构说明迁入后重写）。
- `CLAUDE.md` — 项目级 AI 指引（规则+指针型，架构细节在 `docs/`）。
- `LOG.md` — 项目变更日志（只追加）。
- `.claude/` — 项目级配置（会话存档 + 跨会话记忆 `projects/memory/`），`settings.json` 按 Pj 权限同步惯例。
- `SubPj3-角色形象设计/` — 唯一现存子项目：#char 四态图源 + 界面动效/预览 demo。SubPj1（遥测前端）/SubPj2（私有化网关）实现已分别并入源码 `src/gateway/web/` 与 `src/gateway/localGateway.ts`（2026-08-29 起前端直改源码），子项目目录已移除。
- `refer/` — 界面设计参考截图。

## 功能速览

- **单文件便携 exe**：`bun build --compile` 自包含单文件（CLI + 内置网关 + web 前端全打包），拷到任意目录运行；便携根标记 `.claude/.claude-portable`（在配置根内部，不可移动/删除）让 settings/插件/记忆/凭据跟随 exe 文件夹；裸机首次启动在信任对话框选 yes 即在 exe 旁播种便携根（`maybeInitPortableRoot`，下一轮启动生效）。
- **双等权前端，共同后端**：CLI（React/Ink REPL）与 web（网关静态托管单页）是同一会话引擎的两个等权前端；局域网 iPad/手机访问 `floria.local`（mDNS）远程使用。
- **设备配对授权**：新设备连入时授权门出一次性配对码，PC 端 `/server auth add <配对码>` 完成授权；票证持久化挂域 cookie，换网不重复授权。
- **实时处理折叠**：处理中折叠流式展开旁白/思考/工具步 + 「正在处理」实时计时；回复落地自动收起为「已处理 X」（计时定格），仅保留总结，节约纵向空间。
- **带图消息全链**：web 端拖拽/粘贴上传图片（一次最多 4 张），气泡内联缩略图 + lightbox 查看；CLI/web 双端渲染一致。
- **远程审批**：CLI 权限弹窗实时中继为 web 审批卡，iPad/手机可远程批准/拒绝，双端竞速先操作者生效。
- **项目个性化预览**：项目产物（架构图/可视化页）落 `<项目>/.claude/preview/`，由网关静态托管，web 项目预览页内直接查看。
- **神经元知识库（NEURON_RAG，feature 门控）**：BGE 本地嵌入 + recall/remember 内置工具 + leiden 社群认知形成链，全链 TS 化进 exe。

### Web 前端：插件页（官方市场 + 个人插件）

![插件页：官方市场插件与个人插件](./_agent-src/docs/screenshots/web-plugins.jpeg)

### Web 前端：项目页（项目分组 + 个性化预览入口）

![项目页：按项目分组，点击进入项目个性化预览](./_agent-src/docs/screenshots/web-projects.jpeg)

### Web 前端：模型页（全局默认模型切换）

![模型页：设置全局默认模型](./_agent-src/docs/screenshots/web-models.jpeg)

### 会话处理折叠：进行中流式展开 → 完成后自动收起

处理中流式展示旁白/思考/工具 + 计时；完成后自动收起为「已处理 X」，仅留总结。

![处理中：流式展开](./_agent-src/docs/screenshots/session-live.png)

![完成后：自动折叠仅留总结](./_agent-src/docs/screenshots/session-fold.png)

### 引导消息碎片化交错渲染

![引导消息：旁白与工具折叠行按线性序交错](./_agent-src/docs/screenshots/session-guide.png)

### 设备配对授权门

![设备配对授权门](./_agent-src/docs/screenshots/pairing-gate.png)

### 项目个性化预览

产物由 skill 落 `<项目>/.claude/preview/`，网关静态托管 `/preview/<label>/*`，项目页 iframe 直开（无预览回落内置默认主页），远程设备经 `/backend/<label>/` 反代可看。

![Pj13 项目个性化预览：论文精读](./_agent-src/docs/screenshots/preview-pj13.png)

## 构建与部署

- 构建命令（在 `_agent-src/` 内执行）：`bun install` / `bun run dev`（源码直跑）/ `bun run build:dev`（dev 构建 `cli-dev-<ts>.exe`，2026-08-25 起**默认含内置私有化网关**；2026-09-04 定案统一本命令）/ `bun run compile`（正式编译 `dist/cli-<ts>.exe`）。
- 构建产物（2026-08-25 起 dev 构建直出项目根，免手动复制）：dev 构建（`build:dev`）→ **项目根** `cli-dev-<YYYYMMDDHHMMSS>[-<flag>].exe`；正式编译 → `_agent-src/dist/cli-<YYYYMMDDHHMMSS>.exe`。带时间戳命名，独立保留。
- 部署/运行：构建完成即已在项目根，直接用带时间戳的产物 exe 启动（如 `cli-dev-<YYYYMMDDHHMMSS>.exe`；2026-08-28 起 PRIVATE_GATEWAY 进默认特性，`build:dev` 即含网关，产物名不再带 -PRIVATE_GATEWAY 代号），**重启会话/网关进程才生效**。**产物带时间戳是强制规范，不允许覆盖**（不设固定名部署副本）。当前最新构建：`cli-dev-20260910104228.exe`（**09-10 v15 发布资产=本产物（版本主题 app.js 大改前备份）**：web 前端 sw v241→v287 大迭代——事件流统一 P1（会话增量流 session-delta + 投影 mode 同构）、两层消息流乐观占位 stage 体系、状态显示行真空根治+行为分级文本、流式字符通道、提问卡折叠随动根修、两层占位 dvh 根修、侧栏滚轮死区根修、限流降级可见提示；CLI resume 历史全丢根治（renderCap 占位泄漏）+默认终端委托根治（wt.exe 直并）+网关 SSE 僵尸连接根治；**sw v287 待实测**；09-07 v14=`cli-dev-20260907110439.exe`（手机档输入栏变形/项目 chip 省略号/钉顶图片异步撑高/README 截图扩充，已实测）；09-06=首条消息接管帧收口（sw v235）+wsession 异步化与消息暂存补投（v233）+首条消息三态根治（v229）+侧栏浮起/会话行菜单终局（v219-v234）+web 拖拽上传图片（v231）+web 打断撤回链+便携根裸机初始化（maybeInitPortableRoot），均经用户实测通过；09-05=神经元 schema v2.3 收口+NEURON_RAG exe 全链实测，见下「版本控制」；历史部署链见 `LOG.md`，此处不再累积**）。注：`build:dev` 产物名不带 `-PRIVATE_GATEWAY` 代号但同样含内置网关；**2026-09-04 定案：构建（含发布）一律用 `build:dev`，`build:dev:gateway` 废弃不再使用，历史带代号产物仅存档**。
- codegraph 索引：`_agent-src/src/.codegraph/`（相对路径存储，随 `_agent-src` 迁移有效），MCP 查询带 `projectPath=Pj16-CodeAgent构建/_agent-src/src`。

## 版本控制（git）

- 2026-08-15 git init，远程 `bruce2431/codeagent-build`，**仅跟踪 `_agent-src/`、`README.md`、`docs/` 三个路径**（2026-09-10 起以 docs/ 替代原 STANDARDS.md，文档库重组）；`CLAUDE.md`/`LOG.md`/子项目目录/报告 md 由项目根 `.gitignore` 排除，`.gitignore` 本身不入库。
- 构建产物 exe 不在 git（`.gitignore` 排除 `*.exe`），部署副本只在项目根。
- **GitHub Release 发布（2026-08-31 起）**：版本号 = exe 内嵌的 dev 版本串（构建自动生成，格式 `2.1.<sw>-dev.<日期>.t<UTC时分秒>.sha<HEAD 8 位>`，如 `2.1.87-dev.20260831.t062738.sha60f851fa`）；流程 = commit+push → 同名 tag → GitHub Release（notes 按 LOG 当日条目主题分组）→ 附对应 gateway 代号版 exe 为 asset。发布记录见 `LOG.md`（最新：版本 15，2026-09-10 发布，版本主题「app.js 大改前备份」，tag `2.1.87-dev.20260910.t024228.sha37e00c61`，asset `cli-dev-20260910104228.exe`；上版：版本 14，2026-09-07，tag `2.1.87-dev.20260907.t030439.shab9158a14`，asset `cli-dev-20260907110439.exe`；再上：版本 13，2026-09-04，tag `2.1.87-dev.20260904.t041234.shacff088a0`，asset `cli-dev-20260904121234.exe`）。

## 新结构速览（便携根 = `@WrokSpace`）

```
@WrokSpace/
├── .claude/              ← 全局配置根（settings/skills/plugins/记忆/会话）
│   └── .claude-portable  ← 便携标记（在配置根内部，不可移动/删除）
├── Pj16-CodeAgent构建/   ← 本项目（源码构建区 + 权威标准）
│   ├── SubPj3-角色形象设计/ ← #char 四态图源 + 界面动效 demo（唯一现存子项目）
│   ├── refer/            ← 界面设计参考截图
│   └── <时间戳>-<名称>/   ← 临时任务目录（发布/验证等，用毕归档 .trash）
└── Pj1-…/Pj17-…/         ← 其他项目
```

## 归档

- 废弃文件按工作区「禁止删除」规则归档到 `@WrokSpace/.trash/YYYY-MM-DD/`。
