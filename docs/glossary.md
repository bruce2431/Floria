# 术语表（glossary）

> 本文件属 `docs/` 文档库。
> 会话/文档/LOG 交流一律用本表规范名；实体列 = `gateway/web/index.html` + `app.js` 实际 DOM 码；「旧称」= 规范前的口语叫法（LOG 历史条目中常见）。
> 可视化树形版 + 信号族机制层（四泳道信号流图/12 步生命周期/信号台账/病谱/冲突清单/不变量清单，图例 chip 三视图交叉高亮）见项目预览页 `.claude/preview/index.html`「web 前端 DOM 术语树」+「web 前端机制层」两节。
> 链路定案正文 → [web-ui.md](web-ui.md) 与 [gateway.md](gateway.md)。

## 界面与跨端

| 规范名 | 实体 | 说明 | 旧称 |
|---|---|---|---|
| token 门 | `#gate-screen` | 未认证时的设备配对页：请求码 + PC 端 `/server auth add` 授权（阶段：趴栏图→过渡视频→配对） | 初始chat界面 |
| 新会话界面 | `#empty-hint` | 认证后空态：趴栏图 + 输入栏居中 | 初始chat界面 |
| 聊天主区 | `#chat-area`（`#chat-scroll`/`#messages`） | 会话界面主体 | chat界面 |
| 管理视图 | `.mgr-pane`（入口 `.mgr-tab`） | 管理 tabs 打开的四页：插件/项目/模型/神经 | |
| 项目预览页 | `.preview-shell`（iframe） | 项目卡打开的 `/preview/<label>/*` 托管页 | |
| 神经元视图 | `.neu-pane`（`.neu-card` / `.neu-graph` / `.neu-pop`） | 「神经」tab：层级1 神经元库选择卡片 + 层级2 三级节点图（mem→cog→社群，Canvas 力导向）+ 悬停/点击浮窗；数据源 [gateway.md](gateway.md) §14 | |
| web 前端 | `gateway/web/` | 浏览器端界面（等权前端之一） | web界面 |
| CLI 界面 | REPL（React/Ink） | 终端界面（等权前端之一） | cli界面 |
| PC 端 | — | 本地电脑（exe/网关所在） | 本地 |
| 远程端 | — | iPad/iPhone 等远程设备 | 遥测（已退役） |
| 内置网关 | `localGateway.ts` | exe 内置网关进程 | 网关 |
| CLI 客户端注册表 | `cliClients` | 网关侧 CLI 会话进程路由表 | |
| web 独立会话 | wsession | web 端「笔/项目+」新建的独立 CLI 进程会话 | |
| 会话间通信 | `session_send` 工具 / `session-message` 帧 | 会话 A 的 agent 向会话 B 发一条消息，B 侧以与 user 消息同构的形态接收（空闲开回合/忙则排队/离线自动拉起），气泡外带来源灰字行；**无授权门**——会话目录内任何会话可发，唯一硬门是寻址（sid 精确 > 标题唯一，不猜不兜底）。链路 → [core.md](core.md) 末节 + [gateway.md](gateway.md) §13 | 跨会话消息/会话互发 |
| 来源灰字行 | `.msg .who`（气泡外）/ `.q-who`（排队区） | 「来自 会话：X」小灰字；**在气泡容器内、`.body` 之前**（气泡上方，文档流占位，不影响几何）；**随其气泡一侧对齐**——用户气泡右对齐故来源行右对齐（`.msg.user .who { align-self: flex-end }`；CLI 侧同义的行盒 flex-end） | |

## 侧栏与会话管理

| 规范名 | 实体 | 说明 | 旧称 |
|---|---|---|---|
| 侧栏 | `#sidebar` | = 折叠轨 + 展开面板；展开态右缘可拖拽调宽（`#panel-resizer` 把手，仅展开态 ≥721px 显示，范围 [232, min(560, 视口−120)] 写 `:root --panel-w`，**不记忆**——折叠即清内联值回默认 280px） | 侧栏 |
| 折叠轨 | `#rail` | 折叠态 64px 窄条；其图标组统称 **rail 图标族**（logo/新建/搜索/最近会话/头像） | |
| 展开面板 | `#panel` | 展开态 280px：品牌行 + 管理 tabs + 最近列表 | |
| 最近列表 | `#recent`/`#recent-body` | 会话容器（「最近」头 + 整理会话 + 模式 tabs） | |
| 整理会话弹层 | `#organize-pop` | 「一个列表 / 按项目展开」切换浮层 | |
| 模式 tabs | `#mode-tabs` | 项目/聊天两种列表排列 | |
| 项目文件夹分组 | `.folder` | 按项目分组的折叠头（含行内「+」新建） | |
| 会话 tab | `button.sess-item` | 最近列表里的单个会话条目；**排序 = 有状态（运行态点在场）置顶 + 组内 createdAt 降序**（`core/sessions.js` `sessCmp` 单一排序器，createdAt 由网关 `/gateway/sessions` 透传 jsonl birthtime；气泡弹层/搜索覆盖层同序；项目胶囊与文件夹维持最近活跃不动） | 会话tab/会话行 |
| 状态点 | `.dot` | tab 左侧运行态小点（web/CLI 同一判定链） | |
| 三点钮 | `.sess-more` | tab 行内「…」按钮 | 三个点 |
| 三点菜单 | `.sess-menu` | 三点唤出的菜单（重命名/关闭），**内嵌展开为 tab 第二行**（非浮窗） | 行菜单/浮窗 |
| 侧栏浮起 | `.lift`/`.lift-anim` | 桌面 hover 时 tab 浮起动画态 | |
| 搜索覆盖层 | `#search-overlay` | 全屏搜索全部对话 | |
| 重命名弹窗 | `#rename-modal` | 会话重命名对话框 | |

## 消息流（`#messages` 内）

| 规范名 | 实体 | 说明 | 旧称 |
|---|---|---|---|
| 消息气泡 | `.msg` | 用户（u）/回复（assistant）/系统提示（`.msg-system`） | |
| 引导气泡 | `[data-t="g"]` | guide agent 产物，按碎片交错穿插 | 引导消息 |
| 处理折叠体 | `details.done-fold` | 回合处理块总称：处理状态 + 旁白 + 工具调用行 | 折叠体 |
| ├ 处理状态 | summary（`.df-dot`/`.d-dur`） | **恒两字样**「正在处理/已处理」+ 计时；**脉冲点** = `.df-dot` 呼吸小圆点（无响应/连接中断红标与状态行均不在 summary 轮转） | |
| ├ 状态显示行 | `.fold-state` 宿主行 | **容器统称（状态显示行 = 状态行 + 记录行两类子元素）**：回合处理中的实时活动行——有工具组并入 `tool-fold` summary 同行、无工具组=段尾独立行；**并发复合态**：工具在飞且引擎仍在产出（turn-beat 新鲜）时，状态**作原子尾缀并进运行行所在的唯一行容器**成「正在运行:<工具> <detail> 并思考」一行一句，二者正交不再二选一；**唯一性不变量：本行一次只有一个状态占用者**——红标在场即挂 `.is-flagged` 独占（见「红标独占」） | 状态层/状态行（旧混称） |
| ├ ├ 状态行 | `.fold-state`（`.think-state` 扫光）/ 运行中 `.tool-running` | **一次性实时动画子元素**，回合收口即消失、不留存不折叠：正在思考/正在生成/正在压缩（扫光文字 + 距最后落盘计时 + 流式预览 `.think-stream` + 无响应/连接中断红标 `.d-stale`）与「正在运行:<工具>」（运行中工具行即活动指示）；并入 `tool-fold` 时折叠顶只留状态行、tf-label 记录概括不同显；**「引擎仍在产出」的判定＝`vacuumOf`**：无工具在飞按「回合未收口」推断、有工具在飞按 turn-beat 新鲜度取证（6s），压缩态为显式实证先于取证；**行首槽对齐**：状态行与工具行共用 `.t-ico` 16px 槽 + 5px gap，文字左缘恒 21px——同一宿主行两类状态轮转/并存时零横移；文本另置 `.ts-text` 子节点，tick 只写该节点 | 思考状态行/状态层 |
| ├ ├ 状态尾缀 | `.think-state.ts-join` | **并发复合态的原子尾缀**：无独立图标槽（同行已有工具图标），文案「并思考/并生成/并压缩中」由 `messages.js vacuumLabel(mode, join)` 单一映射后写入 `data-label`，`live.js` tick 只读该字段补「 Ns」（状态行/记录行一律空格分隔、无分隔点；不复刻 mode→label 三元链）；`flex:none` + `.think-state` 恒 `white-space:nowrap` ⇒ 几何上不可被挤（`.tl-text` 是让位方）；不重复扫光（宿主组用 `:not(.ts-join)`，扫光随「正在运行」行）；**红标在场时随状态文字一并隐去（见「红标独占」）** | |
| ├ ├ 红标独占 | `.fold-state.is-flagged` + `.d-stale` | **单状态槽不变量**：僵死红标「无响应 Nm Ns」/ 断连红标「连接中断」是状态槽的**唯一占用者**（非状态文字旁的注解）——`live.js` tick 以唯一判据（红标 HTML 非空）给宿主行挂 `.is-flagged`，`styles.css` 隐去同行 `.think-state`（含并发尾缀）与 `.think-stream`（引擎产出的暂态，无产出即过期），`.d-stale` margin 归零＝红标即行首；信号恢复每秒重算自动摘标、状态文字原样复原。文案/阈值单源 = `messages.js statusFlags(connUp, staleSec)` + `STALE_SEC=150`（优先级：连接中断 > 无响应；`staleSec<=0` = 本帧判据不适用） | |
| ├ ├ 记录行 | `tool-fold` summary（`.tf-label`） | **被折叠进状态显示行的留存子元素**：完成工具的概括记录（「运行了命令 (1)」等），收口后留存、可折叠展开工具明细（`.tool-line` 单工具行） | |
| ├ 旁白 | `.done-think` | 体内 AI 叙述文本块；回合结束后渲染为回复气泡正文 | 旁白/结论 |
| ├ 行首槽 | `.t-ico` | 状态行与工具行的共用行首图标槽（16px 固定宽、内含 14px svg，**通用类**——从 `.tool-line .t-ico` 提升）；扫光宿主之一（透明覆盖扫光条 `::after`，与 `.tool-line.tool-running`/`.tool-fold[data-state='running'] summary`/`.tool-cur summary` 共用同一规则组，`.think-state` 侧限 `:not(.ts-join)`） | |
| ├ 工具调用行 | `.tool-line`（运行中 `.tool-running`） | 单工具一行（图标+名称+详情）；**并发复合时它是唯一行容器 `.fold-state` 里的让位方**（`.tl-text` 省略号 + 可收缩），状态尾缀恒完整（见上「状态尾缀」） | 工具调用行 |
| ├ 工具折叠 | `details.tool-fold` | 多工具成组折叠体（工具调用行自成折叠时的形态）；真空态状态层 `.fold-state` 并入其 summary（并入时顶替 tf-label）；概括标签 `.tf-label` 超宽单行省略；**开合态恢复用结构稳定键 `foldKey`**（宿主段 `data-m|data-t` + 主类名 + 段内同类序号；取代数组下标——下标错位会把旧 done-fold 的 open 灌给新 tool-fold）。**注：`foldKey` 只治「折叠体自动展开」；「运行命令块异常大」真因是并发复合态的行内挤压（见「状态尾缀」）** | |
| └ 思考折叠 | `details.think-row` | 思考文本折叠体 | |
| 变更卡 | `.change-card` | 「N个文件已更改」文件增删清单 | |
| 乐观气泡 | 无 `data-m` 的 user 气泡 | 发送瞬间先行渲染、尚未落盘的用户气泡；落盘原地换真身 = **接管帧**（首条消息事务链 `firstSendHash`）；乐观/落盘两态 body **同走 `mdHtml`**（同源渲染，两态气泡尺寸零差异） | 开启消息/开启主张 |
| 排队 dock | `.queue-dock` > `.q-item` | 排队消息条目（无「排队中」文本标签） | 排队消息 |
| 两层消息流占位 | `.pin-stage` | 回合开启消息唤出的静态预留块（层2），挂流末恒定在场，高度=max(0, 视口高−输入栏预留−**当前**内容脚印)（脚印实时读取——内容增长/收起都不产生额外滚动余量，未超一屏时滚动极限恒=开启气泡贴顶位；空白恰铺到输入栏上沿，长会话不加空白）；**用户滚动输入永不摘占位**，拆收仅随视图退出 | 钉顶占位/`.pin-spacer`（动态补差体系已退役） |
| 撤回动画 | restored 链 | 打断无实质响应 → 气泡塌缩淡出 + 文本回填输入栏 | |
| 压缩实时态 | compact-state → 状态行 | 「正在压缩会话中……」 | |
| 图片消息 | `.msg-imgs`/`.msg-img` + 灯箱 | 内联缩略图（上限 160px）+ 点击放大层 | |
| 文件卡片 | `.msg-files`（`.file-card`） | 消息内文件附件卡片（dshFile 图标 + 文件名，点击复制路径）；发送占位 `[文件:<会话 cwd 相对路径>]` 在渲染层剥出 | |
| 代码块/表格/复制钮 | `.code-block`/`.md-table`/`.msg-copy` | markdown 渲染件 | |
| 图表卡 | `.chart-frame`（` ```chart ` 围栏） | 双段围栏的 web 渲染形态：`%%html` 段进沙箱 iframe（`sandbox="allow-scripts"` srcdoc，opaque origin），`%%ascii` 段弃用、`chart-raw` 留全文供「源码」按钮切换；高度自适应（srcdoc 尾注 CHART_BOOT ResizeObserver postMessage 上报，CSS max-height 60vh 内部滚动） | |
| turn-beat | SSE | 引擎增量活性心跳（150s 无 beat 且无已知阻塞原因在场 → 标「无响应」；**已知阻塞原因在场时抑制**——审批接管（等待审批）与**工具在飞**（等待工具结果）都属正常停顿非僵死，工具在飞判据取 `.tool-line.tool-running` 运行态标记）；**红标文案/阈值单源 = `messages.js statusFlags(connUp, staleSec)` + `STALE_SEC=150`**，豁免场景由调用方传 `staleSec=0` 表达「判据不适用」；红标在场时独占状态槽（见「红标独占」） | |

## 输入区

| 规范名 | 实体 | 说明 | 旧称 |
|---|---|---|---|
| 输入栏 | `#input-bar`（挂载 `#input-wrap`） | 会话内 docked 态贴底；空态时挂新会话界面 stage 内 | 输入栏 |
| 输入框 | `#input` | contenteditable 富文本；**粘贴一律落 text/plain**（图片粘贴分支除外：`clipboardData.files` 优先入列） | |
| 发送钮/停止键 | `#send-btn` | 回合进行中变停止键（发 interrupt 打断；空输入才响应停止键） | 打断按钮 |
| 项目选择器 | `#proj-seat` + `#proj-pop` | 空态选目标项目（「全局」默认）；会话态锁定只读（项目 chip） | |
| 模型·推理座 | `#model-seat` + `#model-pop` | 模型与推理等级两级选择（等级菜单按供应商 `effortLevels` 声明动态渲染，GLM 未设置显「默认」） | |
| 上下文占用环 | `#ctx-meter` | 环形百分比 + 点击展开 breakdown 面板 | |
| 附件胶囊 | `#img-pills`（`.img-pill` 图片 / `.file-pill` 文件） | 待发送附件行：图片缩略图（base64 内联）+ 文件卡片（64×64 方卡、灰底薄描边、dshFile 图标+文件名两行居中、× 收进卡内右上 hover 显形/触屏恒显；落盘 uploads/ 后按占位发送） | |
| `+` 浮窗 | `#cmd-btn` 唤出 | 去顶层 tab，单页四组堆放（上传=选图行+已选缩略图+文件上传行 / 技能=MGR.skills.personal / 引用会话=近 48h ALL / 指令=MOCK_COMMANDS；`.grp` 组标题 + `.rowIco` 行图标）；等宽=输入栏同宽，搜索框滤全部组 | |
| 命令菜单 | `#cmd-pop` | 统一条目 `cmdEntries()` 平铺索引（键盘导航跨组）；选择分发：图片行=`img-file` 选图 / 文件上传行=`file-upload` 选文件（`addUploadFiles` 上传**落盘跟随会话**：带 sid/project 网关按会话根落 `<会话根>/uploads/` → 文件胶囊进附件行，发送时消息拼 `[文件:<会话 cwd 相对路径>]` 占位[同会话恒 `uploads/<名>`]、web 渲染剥出文件卡片）/ 技能·会话=`appendMentionChip` 追加输入栏（serializeInput 序列化 `[插件:X]/[会话:X]` 令牌，与 @ 提及同链）/ 命令=原链（risk→确认门）；vision 入口门控随图片 tab 退役（粘贴/拖拽/发送链本无门控） | |
| 风险确认门 | `#risk-modal` | 高危命令确认对话框 | |
| @ 提及浮窗 | `#mention-pop` + `.mention` | 插件/技能 + 近 48h 会话提及选择（会话区为浮窗第一区） | |
| 提及令牌 | `[会话:标题\|sid]` / `[插件:X]` | chip 随消息文本发出的字面令牌（`serializeInput` 单一序列化点）；**会话令牌恒带 sid**（精确寻址，免疫改名），chip 与 CLI 终端**只显示标题**（按 `\|` 切分）；sid 由 `hashOf(s)` 得出（与 web 消息路由同键）。两个提及入口 = `@` 浮窗（`mention.js`）与「+」菜单「引用会话」（`commands.js`）——**两处都输出带 sid 形态**；令牌为纯 UI 引用手势，**不产生授权** | |
| 接管栏 | `#composer-takeover`（`#input-bar` 最后一个子元素） | **仅审批/提问卡（`.appr-card`）**；可交互提问走 CLI 审批链 `renderQuestionApproval` 下发的 `.appr-card.qa-card`（选项点选/多选/自定义输入/跳过/上一题下一题）；审批卡是输入栏的子元素而非兄弟节点；`.bar-takeover` 时输入栏仅 `padding:0 + overflow:hidden`（**卡自身铬全剥离贴卡面**——`.appr-card` 去边框/背景/圆角/阴影，黄条头贴顶，圆角由输入栏裁溢出裁出；输入栏自身边框/背景铬不动=表面连续）+ 原内容组 `display:none` → 卡片即输入栏本体；出现/解决 = **单一时间轴：输入栏自身高度** h0→h1 过渡（0.32s cubic-bezier）+ overflow 裁切（无 fade 淡入淡出——杜绝淡入与高度动画双时间轴竞速）；动画期 `.composer-growing` 卡片 absolute bottom:0 底边锚定，`wrapAnimating` 期 `syncTakeoverPad` 首行直接 return（RO 守卫）；聊天区 padding-bottom 一次性设终值 + `lastPad` 同值短路 | |
| 任务浮窗 | `#task-dock` + `.td-panel`/`.td-lip`（`#input-bar` 子元素） | 底栏上的生长式浮窗，渲 TodoV2 任务清单（CLI `task-state` 上报，与 CLI `TaskListV2` 同源同判定）；收敛态露出 **12px 把手条**（`.td-lip`，白表面 + 1px 0.10 描边＝与输入栏/面板同族材质），点击上展、再点 `.td-head` 向下收敛；宽=输入栏宽−48px 居中，展开底边与输入栏上沿留 `--td-gap`=10px 间距、最高 `min(40vh,460px)` 内部滚动；审批/提问接管在场 → `.blocked` 自动收敛 + 禁点 | 任务栏/任务清单窗 |
| 拖放覆盖层 | `#drop-overlay` | 拖图上传全屏「松开以添加图片」 | |
| toast | `#toast` | 轻提示条（2.6s 自灭，非阻塞反馈） | |

## 浮窗与覆盖层（泛指）

- **浮窗** = 锚点弹出小层统称（`.popup` 家族）：整理会话弹层、最近会话气泡（`#bubble-pop`）、提及浮窗、模型/项目弹窗等。
- **覆盖层** = 全屏层统称：搜索覆盖层、重命名弹窗、风险确认门、拖放覆盖层、灯箱。

## SSE 信号族（网关 → web 群发）

| 信号 | 用途 |
|---|---|
| `turn-state` | 回合开始/结束（打断收口双持久信号之一） |
| `turn-beat` | 引擎增量活性心跳（150s 缺席且无已知阻塞原因——无审批接管、无工具在飞 → 标「无响应」；红标在场即独占状态槽，状态文字/流式预览同隐） |
| `stream-text` | 流式字符通道（CLI 流式 delta 100ms 合帧全文快照 → 状态行后流式预览；'' = 块边界/落盘/打断清除。纯显示暂态不落盘，权威 delta 接管即让位） |
| `compact-state` | 压缩实时态起止 |
| `restored` | 撤回链（文本回填输入栏） |
| `queue-state` | CLI 入队上报（排队 dock 数据源；每项可带 `from:{title,sid?}` = 会话间通信来源，CLI 上报前已剥包装，见 [gateway.md](gateway.md) §12/§13） |
| `task-state` | CLI TodoV2 任务清单上报（任务浮窗数据源；空数组=清单清空 → 浮窗整体不出现） |
| `model` | CLI 每会话实际模型上报（HTTP `/gateway/model-report` 落值即群发，唯一不走 `/clients` WS 的信号；底栏模型 seat 实时校准源，见 [web-ui.md](web-ui.md) §5） |
| `ws-failed` | web 独立会话启动失败 |
