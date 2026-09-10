# docs/ 文档库索引

> 2026-09-10 由原三文档（`FEATURES.md` / `STANDARDS.md` / `ARCHITECTURE.md`）按读者主题重组而成；原三件已归档 `.trash/2026-09-10/`（禁删红线）。git 仓库跟踪 `_agent-src/`、`README.md`、`docs/` 三路径。
> 各件头部自带「姊妹件」互链；本件只做地图与沿革，不放正文。

## 文档地图

| 文件 | 主题 | 一句话 |
|---|---|---|
| [standards.md](standards.md) | 权威规则 | skill/plugin/MCP/changelog/工作区/审批等全部约定（原 STANDARDS 主体），与 CLAUDE.md 冲突时以此为准 |
| [build.md](build.md) | 构建与 flag | 构建命令/产物规范/前端内嵌打包 cache-busting + 88 个 feature flag 活审计（原 STANDARDS §10 + FEATURES.md） |
| [glossary.md](glossary.md) | 术语表 | web/CLI 双前端 UI 实体规范名 ↔ 实际 DOM 码对照 + SSE 信号族（原 ARCHITECTURE 术语表） |
| [core.md](core.md) | 源码核心机制 | 便携配置根/会话平铺/插件双发现/沙箱权限/自愈日志/神经元 NEURON_RAG（原 ARCHITECTURE「源码核心机制」章） |
| [gateway.md](gateway.md) | 网关服务 | API 前缀/认证配对/mDNS/预览容器/反代/独立会话进程链/审批中继（原 ARCHITECTURE 网关章 + STANDARDS §13） |
| [web-ui.md](web-ui.md) | web 前端链路 | 路由/首条消息事务链/session-delta/打断收口/两层消息流占位/内存优化等交互定案（原 ARCHITECTURE web 章） |

## 阅读顺序与优先级

- **规则冲突判定**：`docs/standards.md` > 各项目 CLAUDE.md > 本库其它件。
- **新会话上手**：本件 → [glossary.md](glossary.md)（对齐交流用词）→ 按任务读对应主题件。
- **改码前必查**：涉及构建 → [build.md](build.md)；涉及网关/认证/容器 → [gateway.md](gateway.md)；涉及 web 交互 → [web-ui.md](web-ui.md)；涉及源码核心机制 → [core.md](core.md)。各件头部均注明「改动以下机制时必须同步更新本文」。

## 原三文档沿革映射

| 原件（已归档） | 去向 |
|---|---|
| `FEATURES.md`（flag 审计 311 行） | → [build.md](build.md) §2（Entry Points 官方绝对路径已修正为 `_agent-src/` 相对路径） |
| `STANDARDS.md` §1-§9/§11-§12 | → [standards.md](standards.md) §1-§11（原 §10 官方差异、§13 并走） |
| `STANDARDS.md` §10 构建 | → [build.md](build.md) §1（产物直出项目根等过期说法已修正） |
| `STANDARDS.md` §13 预览页 Web 容器 | → [gateway.md](gateway.md) §6 |
| `ARCHITECTURE.md` 术语表 | → [glossary.md](glossary.md) |
| `ARCHITECTURE.md`「一、源码核心机制」 | → [core.md](core.md) |
| `ARCHITECTURE.md`「二、内置网关 + web 前端」 | → [gateway.md](gateway.md)（网关服务侧）+ [web-ui.md](web-ui.md)（web 交互侧）；共同后端三原则留 [web-ui.md](web-ui.md) §3 |
| 原件内 feature flag 门控引用 | 统一指 [build.md](build.md) §2 |
| 原件内 NEURON_RAG 引用 | 统一指 [core.md](core.md) 神经元节 + [standards.md](standards.md) §7 |

## 重组原则

1. **规则 vs 机制分家**：约定/标准留 standards.md；链路机制按服务边界拆 gateway.md / web-ui.md；构建与 flag 独立成 build.md。
2. **重复内容归并**：原三件在构建标准、PRIVATE_GATEWAY、NEURON_RAG、预览容器、配置根解析、会话平铺等处重复 2-3 遍的内容各只保留一份，其余改交叉链接。
3. **过期内容顺手修正**：不再「原样搬运」——发现的事实错误（产物路径、失效绝对路径、已废弃命令）在落位时直接修正，并在文内注明。
