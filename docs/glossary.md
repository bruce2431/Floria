# 术语表（glossary）

> 本文件属 `docs/` 文档库（2026-09-10 由原 `ARCHITECTURE.md` 术语表章节独立成件）。
> 会话/文档/LOG 交流一律用本表规范名；实体列 = `gateway/web/index.html` + `app.js` 实际 DOM 码；「旧称」= 规范前的口语叫法（LOG 历史条目中常见）。
> 可视化树形版 + 信号族机制层（四泳道信号流图/12 步生命周期/信号台账/病谱/冲突清单/不变量清单，图例 chip 三视图交叉高亮）见项目预览页 `.claude/preview/index.html`「web 前端 DOM 术语树」+「web 前端机制层」两节（2026-09-08 增补机制层）。
> 链路定案正文 → [web-ui.md](web-ui.md) 与 [gateway.md](gateway.md)。

## 界面与跨端

| 规范名 | 实体 | 说明 | 旧称 |
|---|---|---|---|
| token 门 | `#gate-screen` | 未认证时的设备配对页：请求码 + PC 端 `/server auth add` 授权（阶段：趴栏图→过渡视频→配对） | 初始chat界面 |
| 新会话界面 | `#empty-hint` | 认证后空态：趴栏图 + 输入栏居中 | 初始chat界面 |
| 聊天主区 | `#chat-area`（`#chat-scroll`/`#messages`） | 会话界面主体 | chat界面 |
| 管理视图 | `.mgr-pane`（入口 `.mgr-tab`） | 管理 tabs 打开的三页：插件/项目/模型 | |
| 项目预览页 | `.preview-shell`（iframe） | 项目卡打开的 `/preview/<label>/*` 托管页 | |
| web 前端 | `gateway/web/` | 浏览器端界面（等权前端之一） | web界面 |
| CLI 界面 | REPL（React/Ink） | 终端界面（等权前端之一） | cli界面 |
| PC 端 | — | 本地电脑（exe/网关所在） | 本地 |
| 远程端 | — | iPad/iPhone 等远程设备 | 遥测（已退役） |
| 内置网关 | `localGateway.ts` | exe 内置网关进程 | 网关 |
| CLI 客户端注册表 | `cliClients` | 网关侧 CLI 会话进程路由表 | |
| web 独立会话 | wsession | web 端「笔/项目+」新建的独立 CLI 进程会话 | |

## 侧栏与会话管理

| 规范名 | 实体 | 说明 | 旧称 |
|---|---|---|---|
| 侧栏 | `#sidebar` | = 折叠轨 + 展开面板 | 侧栏 |
| 折叠轨 | `#rail` | 折叠态 64px 窄条；其图标组统称 **rail 图标族**（logo/新建/搜索/最近会话/头像） | |
| 展开面板 | `#panel` | 展开态 280px：品牌行 + 管理 tabs + 最近列表 | |
| 最近列表 | `#recent`/`#recent-body` | 会话容器（「最近」头 + 整理会话 + 模式 tabs） | |
| 整理会话弹层 | `#organize-pop` | 「一个列表 / 按项目展开」切换浮层 | |
| 模式 tabs | `#mode-tabs` | 项目/聊天两种列表排列 | |
| 项目文件夹分组 | `.folder` | 按项目分组的折叠头（含行内「+」新建） | |
| 会话 tab | `button.sess-item` | 最近列表里的单个会话条目 | 会话tab/会话行 |
| 状态点 | `.dot` | tab 左侧运行态小点（web/CLI 同一判定链） | |
| 三点钮 | `.sess-more` | tab 行内「…」按钮 | 三个点 |
| 三点菜单 | `.sess-menu` | 三点唤出的菜单（重命名/归档/关闭），**内嵌展开为 tab 第二行**（2026-09-07 起，非浮窗） | 行菜单/浮窗 |
| 侧栏浮起 | `.lift`/`.lift-anim` | 桌面 hover 时 tab 浮起动画态 | |
| 搜索覆盖层 | `#search-overlay` | 全屏搜索全部对话 | |
| 重命名弹窗 | `#rename-modal` | 会话重命名对话框 | |

## 消息流（`#messages` 内）

| 规范名 | 实体 | 说明 | 旧称 |
|---|---|---|---|
| 消息气泡 | `.msg` | 用户（u）/回复（assistant）/系统提示（`.msg-system`） | |
| 引导气泡 | `[data-t="g"]` | guide agent 产物，按碎片交错穿插 | 引导消息 |
| 处理折叠体 | `details.done-fold` | 回合处理块总称：处理状态 + 旁白 + 工具调用行 | 折叠体 |
| ├ 处理状态 | summary（`.df-dot`/`.d-dur`） | **恒两字样**「正在处理/已处理」+ 计时；**脉冲点** = `.df-dot` 呼吸小圆点（2026-09-09 定案：无响应/连接中断红标与思考状态行迁出 summary，不再轮转其它字样） | |
| ├ 状态层 | `.fold-state`（`.think-state` 扫光） | 思考/压缩实时状态层（2026-09-09 二轮定案「工具调用行=折叠体，子 DOM 分留存与暂态两类」）：有工具组并入 `tool-fold` summary（**四轮定案：并入时折叠顶只留状态层、tf-label 已处理概括不再同显**）、无工具组时段尾独立行；扫光文字 + 距最后落盘计时 + 流式预览（`.think-stream`）+ 无响应/连接中断红标（`.d-stale`）；**动画展示不留存**，回合收口即消失；工具运行态不出现（正运行工具行即活动指示） | |
| ├ 旁白 | `.done-think` | 体内 AI 叙述文本块；回合结束后渲染为回复气泡正文 | 旁白/结论 |
| ├ 工具调用行 | `.tool-line`（运行中 `.tool-running`） | 单工具一行（图标+名称+详情） | 工具调用行 |
| ├ 工具折叠 | `details.tool-fold` | 多工具成组折叠体（工具调用行自成折叠时的形态）；真空态状态层 `.fold-state` 并入其 summary（并入时顶替 tf-label，两状态不同行并存）；概括标签 `.tf-label` 超宽单行省略 | |
| └ 思考折叠 | `details.think-row` | 思考文本折叠体 | |
| 变更卡 | `.change-card` | 「N个文件已更改」文件增删清单 | |
| 乐观气泡 | 无 `data-m` 的 user 气泡 | 发送瞬间先行渲染、尚未落盘的用户气泡；落盘原地换真身 = **接管帧**（首条消息事务链 `firstSendHash`） | 开启消息/开启主张 |
| 排队 dock | `.queue-dock` > `.q-item` | 「排队中」消息条目 | 排队消息 |
| 两层消息流占位 | `.pin-stage` | 回合开启消息唤出的静态预留块（层2），挂流末恒定不收缩，高度=max(0, 视口高−输入栏预留−诞生内容脚印)（空白恰铺到输入栏上沿，长会话不加空白）；**用户滚动输入永不摘占位**（09-09 定案「释放链铲除」），拆收仅随视图退出 | 钉顶占位/`.pin-spacer`（动态补差体系已退役） |
| 撤回动画 | restored 链 | 打断无实质响应 → 气泡塌缩淡出 + 文本回填输入栏 | |
| 压缩实时态 | compact-state → 状态行 | 「正在压缩会话中……」 | |
| 图片消息 | `.msg-imgs`/`.msg-img` + 灯箱 | 内联缩略图（上限 160px）+ 点击放大层 | |
| 代码块/表格/复制钮 | `.code-block`/`.md-table`/`.msg-copy` | markdown 渲染件 | |
| turn-beat | SSE | 引擎增量活性心跳（150s 无 beat → 标「无响应」） | |

## 输入区

| 规范名 | 实体 | 说明 | 旧称 |
|---|---|---|---|
| 输入栏 | `#input-bar`（挂载 `#input-wrap`） | 会话内 docked 态贴底；空态时挂新会话界面 stage 内 | 输入栏 |
| 输入框 | `#input` | contenteditable 富文本 | |
| 发送钮/停止键 | `#send-btn` | 回合进行中变停止键（发 interrupt 打断） | 打断按钮 |
| 项目选择器 | `#proj-seat` + `#proj-pop` | 空态选目标项目（「全局」默认）；会话态锁定只读（项目 chip） | |
| 模型·推理座 | `#model-seat` + `#model-pop` | 模型与推理等级两级选择 | |
| 上下文占用环 | `#ctx-meter` | 环形百分比 + 点击展开 breakdown 面板 | |
| 图片胶囊 | `#img-pills`/`.img-pill` | 待发送图片缩略图行 | |
| `+` 浮窗 | `#cmd-btn` 唤出 | **09-09 二轮定案：去顶层 tab，单页四组堆放**（上传=选图行+已选缩略图 / 技能=MGR.skills.personal / 引用会话=近 48h ALL / 指令=MOCK_COMMANDS；`.grp` 组标题 + `.rowIco` 行图标）；等宽=输入栏同宽（`left:0;right:0`，`#mention-pop` 同款锚定 `#input-wrap`），搜索框滤全部组 | |
| 命令菜单 | `#cmd-pop` | 统一条目 `cmdEntries()` 平铺索引（键盘导航跨组）；选择分发：图片行=`img-file` 选图（选完关浮窗）/ 技能·会话=`appendMentionChip` 追加输入栏（serializeInput 序列化 `[插件:X]/[会话:X]` 令牌，与 @ 提及同链）/ 命令=原链（risk→确认门）；vision 入口门控随图片 tab 退役（粘贴/拖拽/发送链本无门控） | |
| 风险确认门 | `#risk-modal` | 高危命令确认对话框 | |
| @ 提及浮窗 | `#mention-pop` + `.mention` | 插件/技能 + 近 48h 会话提及选择 | |
| 接管栏 | `#composer-takeover`（`#input-bar` 最后一个子元素，09-08 定案） | 提问卡（`.qa-card`，AskUserQuestion）/审批卡（`.appr-card`，审批）是输入栏的子元素而非兄弟节点；`.bar-takeover` 时输入栏仅 `padding:0 + overflow:hidden`（09-09 根修：**卡自身铬全剥离贴卡面——`.question-card`/`.appr-card` 去边框/背景/圆角/阴影，黄条头贴顶，圆角由输入栏裁溢出裁出；输入栏自身边框/背景铬不动=表面连续**，不再是悬浮独立面板观感）+ 原内容组 `display:none` → 卡片即输入栏本体；出现/解决 = **单一时间轴：输入栏自身高度** h0→h1 过渡（0.32s cubic-bezier）+ overflow 裁切（09-09 根修：**整条 fade 淡入淡出机制已删**——opacity 过渡/composer-fade/animFadeIn 全链移除，杜绝淡入与高度动画双时间轴竞速、收回 0.3s 死窗）；动画期 `.composer-growing` 卡片 absolute bottom:0 底边锚定，`wrapAnimating` 期 `syncTakeoverPad` 首行直接 return（RO 守卫 09-09 落地）；聊天区 padding-bottom 一次性设终值 + `lastPad` 同值短路 | |
| 拖放覆盖层 | `#drop-overlay` | 拖图上传全屏「松开以添加图片」 | |
| toast | `#toast` | 轻提示条（2.6s 自灭，非阻塞反馈） | |

## 浮窗与覆盖层（泛指）

- **浮窗** = 锚点弹出小层统称（`.popup` 家族）：整理会话弹层、最近会话气泡（`#bubble-pop`）、提及浮窗、模型/项目弹窗等。
- **覆盖层** = 全屏层统称：搜索覆盖层、重命名弹窗、风险确认门、拖放覆盖层、灯箱。

## SSE 信号族（网关 → web 群发）

| 信号 | 用途 |
|---|---|
| `turn-state` | 回合开始/结束（打断收口双持久信号之一） |
| `turn-beat` | 引擎增量活性心跳 |
| `stream-text` | 流式字符通道（CLI 流式 delta 100ms 合帧全文快照 → 状态行后流式预览；'' = 块边界/落盘/打断清除。纯显示暂态不落盘，权威 delta 接管即让位） |
| `compact-state` | 压缩实时态起止 |
| `restored` | 撤回链（文本回填输入栏） |
| `queue-state` | CLI 入队上报（排队 dock 数据源） |
| `ws-failed` | web 独立会话启动失败 |
