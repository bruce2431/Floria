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
| 外部卡 | `ext:<label>:<id>`（`.ext-shell` > `.ext-frame`） | preview 申报、由宿主摆进主区/侧栏的卡片：**一卡一 iframe**（`/preview/<label>/<path>`，同源），内容跑在自己的文档里（宿主不解释、不注入） | 卡片化二期/外部卡片 |
| 卡片申报 | `preview.json` 的 `cards` 段 / `floria-cards-register` | preview 向宿主声明「我有哪些卡、摆在哪」（静态清单 + 运行期 postMessage 同 id 覆盖）；与 `backend` 并列的第二种能力申报，渲染位置由 preview 要求（`host:"view"`）。链路 → [web-ui.md](web-ui.md) §42 + [gateway.md](gateway.md) §6.5 | |
| 神经元视图 | `.neu-pane`（`.neu-card` / `.neu-graph` / `.neu-pop`） | 「神经」tab：层级1 神经元库选择卡片 + 层级2 三级节点图（mem→cog→社群，Canvas 力导向）+ 悬停/点击浮窗；数据源 [gateway.md](gateway.md) §14 | |
| web 前端 | `gateway/web/` | 浏览器端界面（等权前端之一） | web界面 |
| 主题 | `<html data-theme>`（`html[data-theme="dark"]`） | 前端配色主题：缺省属性 = 浅色；`data-theme="dark"` = **夜晚模式**（配色参考 Prism）。真源 = `<html data-theme>`；`localStorage['floria-theme']`（`'light'`/`'dark'`，缺省跟随 `prefers-color-scheme`）只作下次首帧的预置输入。所有暗色差异只在 `html[data-theme="dark"]` 一处覆盖语义令牌，浅色路径逐像素不变。见 web-ui §56 | 夜晚模式 / 暗色主题 |
| 主题切换钮 | `#panel-theme`（`.act-btn`，`I.sun`⇄`I.moon`） | 侧栏头部动作区 `#panel-actions` 内的日/月图标钮（与搜索/折叠并列，chat/work 两模式均可见）：点击翻转 `<html data-theme>` + 写 localStorage + 换图标 + 同步 `theme-color`。见 web-ui §56 | 明暗切换钮 |
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
| 底板 | `--plane`（浅 `#ececf1` / 暗 `#000000`） | 容器底色，`body` 与 `#app` 同色 ⇒ 整窗读作一块底板（`#app` 的 22px 外框圆弧融进底板不再显形）；**侧栏与视图卡之间的缝隙露出它当分隔**。卡化读法见 web-ui §41 | 底子/画布 |
| 无形槽 | `#chat-area` | 承载视图卡的无形状容器：通高、无圆角/无背景/无边距，只作定位与卡的 flex 容器；`#gate-screen`（token 门浮层）与 `#menu-btn`（侧栏唤出汉堡，全视口共用）留槽级，与「当前哪张卡」无关。**同一时刻槽里恰好一张卡**；**会话级浮层禁直挂此槽**（须挂 `#session-card` 内），否则跨卡残留（见 web-ui §41） | 主区/内容区 |
| 视图卡 | `.view-card` | 浮在底板上的圆角卡（`border-radius: var(--radius)` + 边距 2px + `background: var(--chat-bg)` + `position: relative`）：会话流/管理视图/项目预览各一张；**不画线、不加阴影**，分隔只靠与底板的底色差。`margin: 2px` 从槽移到卡上 ⇒ 卡矩形 ≡ 卡化前 `#chat-area` 的矩形 | 内容卡 |
| 会话卡 | `#session-card`（`.view-card.session`） | 会话视图那张卡，常驻 `index.html`——承载 `messagesEl`/`inputWrap`/`charEl` 等模块级 const 引用的单例 DOM，**离开只切 `hidden` 不销毁**；描述符 `views/cards/session/session-card.js`（`deactivate` = `teardownSessionView`），见 web-ui §53 | |
| 管理卡 | `.view-card.mgr` | 插件/项目/模型/神经四个管理视图的卡，按需创建、离开即 `.remove()`（神经元图 rAF 以 `canvas.isConnected` 自毁） | |
| 预览卡 | `.view-card[data-view=preview]` | 项目预览那张卡（`views/cards/preview/preview-card.js` 描述符，`CARDS` 条目，经 `openCard('preview', {label,hasPreview})` 挂载）；同样按需创建、离开即 `.remove()` | |
| 卡内滚动层 | `.view-scroll` / `.view-body` | 管理卡的滚动层与内容列（`24px 20px 8px` 内边距 + 920px 内容宽），镜像会话卡 `#chat-scroll` 的几何；全高视图（预览/神经元图）由 `.view-card:has(...)` 改 padding/overflow | |
| 视图注册表 | `views/registry.js` `CARDS` | 卡定义单一真源（`{id,title,tip,icon,tab,mount\|card,deactivate?}`，一卡一目录 `views/cards/<name>/<name>-card.js`）：侧栏 tab 生成 / `#mgr/<id>` 路由 / 卡体挂载三处查同一张表；**整卡切换唯一入口 `openCard(id, payload)`**（切换先调离场卡 `deactivate?.()`）+ 契约出口 `deactivateCard(id)`，会话卡以 `tab:false` 入表走同一路径（web-ui §41/§53） | tab 定义 |
| 卡生命周期契约 | `openCard` 离场钩子 / `deactivateCard` | 切卡时通道自动调用离场卡描述符的 `deactivate()`（`prev && prev !== id` 才触发），承载会话语义卸载等收尾；`deactivateCard(id)` 是供卡主动卸另一卡的契约出口。**依赖方向不变量**：卡 → 小底座（core + mgr-data + registry + 卡自身目录），禁卡依赖兄弟子系统（web-ui §53，`probes/probe-web-card-boundary.ts` 锁） | 卡片契约 |
| 侧栏开合核 | `engine/panel.js` `applyPanelOpen`/`closePanel` | 侧栏开合落地唯一实现（钉住态 `state.panelPinned` + 可见态 `state.panelOpen` + `#sidebar.open` + 折叠清 `--panel-w`）；`sidebar/recent.js` 的 `setPanel` 委托其核（popup/行浮窗清理留包装层），卡只经 `closePanel()` 收抽屉（web-ui §53） | 侧栏 |
| 侧栏 | `#sidebar` | = 折叠态（宽度 0，无自带外观）+ 展开面板。**是 `#app` 的真实 flex 子元素**（桌面 ≥721px 亦然）：折叠 0 ↔ 展开 280 **只由自身宽度驱动**，主区 `#chat-area` 靠 flex 跟随收放（无 `padding-left` 避让，门期收宽至 0）。展开态是**圆角卡壳**（`#sidebar.open`：`border-radius: var(--radius)` + 2px 外浮缝），**填充按模式分**——**chat 透明**（`background: transparent`，透出底板 `--plane`，主区会话白卡与之成对比）；**work 白卡**并与 `#chat-area.work` **拼成同一张**（`#app.work #sidebar.open` 覆盖 `background: var(--chat-bg)` + 右缝归零 + 右角不圆）；手机 ≤720px 为覆盖式抽屉（脱离 flex 流，宽 `min(300px, 84vw)`，显式给白底，否则透出 `#scrim` 发黑）。展开态右缘可拖拽调宽（`#panel-resizer` 把手，仅展开态 ≥721px 显示，范围 [232, min(560, 视口−120)] 写 `:root --panel-w`，**不记忆**——折叠即清内联值回默认 280px）。唤出入口 = `#menu-btn`（钉住）/ 窗口左缘唤出（`document` 级监听，无对应元素，悬停预览、离开即收），见 web-ui §38 | 侧栏 |
| 注册快捷按钮 | `.rail-ico` | **预览页**经 `postMessage` 注册的快捷按钮（点击回跳预览页）；注册集属于当前那份预览文档，换文档即清（web-ui §39）。**挂载点暂缺（2026-09-25）**——原容器 `#rail-ext` 随 64px 折叠带撤除，样式与注册链保留、落地位置待定 | 预览注册按钮 / 注册轨按钮 |
| 展开面板 | `#panel` | 展开态 280px：模式行 + 两个面板（chat / work，同一时刻恰一个非 hidden）；底色同底板、**不画右缘分隔线**（侧栏是通高平面，分隔由底板色从卡缝露出承担，web-ui §41） | |
| 模式切换 tab | `.mode-switch` > `.ms-thumb` + `.ms-btn` | 侧栏模式分段控件（`floria·chat` / `floria·work`），占原位品牌行；**无任何胶囊元素**——无轨道底色、无浮起白块。卡面上唯一一块形状 = `.ms-thumb`「**空位**」（从卡面缺掉的一块：半透明暗底 `rgba(0,0,0,.06)` + 内阴影），**落在非当前模式那侧**（处于的模式在卡片上），当前那侧什么都不画。两钮恒 `font-weight:600`（防 CJK 字宽跳动）；当前钮 `.ms-btn.on` **不画底色**（与所在表面同色，只翻字色，禁自绘白片）。切换 = 空位**变形 + 位移**：`left`/`right` 双内衬（= 非当前钮矩形，由 `positionMsThumb()` 实测写入），前缘快、后缘慢 ⇒ 中途拉长再收回；方向性 transition 由 JS 按方向写内联，非切换定位写 `none`。原 `.floria-logo` 品牌按钮退役，折叠入口仍是右侧 `#panel-collapse`。见 web-ui §43 | 品牌行/logo 行 |
| 模式色钩子 | `#app.work` → `--sunken-bg` | **workstate**：随模式切换的颜色统一挂 `#app.work` 一个类（唯一写口 `applySbMode()`）。`#app { --sunken-bg: var(--chat-bg) }` / `#app.work { --sunken-bg: var(--plane) }` = 下沉区/内容卡底色；消费方 = `#composer-mask`、`#app.work #sidebar.open`。新增随模式的颜色只在此加一行，旧 `:has(#panel.work)` 旁路已清。见 web-ui §43/§51 | workstate / 模式色 |
| chat 面板 | `#chat-panel` | 现行侧栏（管理 tabs + 最近列表）；`sbMode=chat` 时在场 | |
| work 面板 | `#work-panel` | Prism 式工作区侧栏（白卡，work 下与主区拼成同一张白卡）：项目切换（`#wk-proj-seat` + `#wk-proj-pop`）/ 文件·聊天 tab / 新建入口（`#wk-new` + `#wk-new-pop`）/ 文件树（`#wk-body`）/ 视图开关浮层（`#wk-view-pop`，侧栏右上角 `#wk-view` 展开）/ 工作区卡（`#wk-foot`）；`sbMode=work` 时在场。见 web-ui §43 | 项目态侧栏 |
| 工作区编辑区 | `#work-editor` | work 模式**下沉区**（`#chat-area.work` grid `col1/row2`）里的**文件 tab** 内容，与 `#session-card`（聊天 tab）**二选一**显示（`.wk-show-file` / `.wk-show-chat` 类，判据 = `wkShownTab()`）；**源码编辑 + 阅读双模**（编辑态 `.editing` 挂栏、阅读态渲染 md/pre），图片/二进制只读。**刻意不用 `.view-card` 类**（常驻栏，不参与「槽里恰好一张卡」语义）。手机 ≤720px 单列铺满（原 `.wk-file-open` 覆盖层 + `#wk-ed-back` 已删）。见 web-ui §43/§54 | 编辑器/文件 tab |
| 编辑/阅读切换钮 | `#wk-ed-mode` | 编辑区头部右侧图标钮（`I.dshEdit`⇄`I.dshBook`），点按或 **Ctrl+E** 切换源码编辑态/阅读态；图片与二进制不显示该钮（不可编辑）。`state.wkEdit` 记忆模式（默认 `false`=阅读） | 编辑模式按钮 |
| 保存态 | `#wk-ed-save` | 编辑区头部路径右侧文本，单点写（`wkEdState`）：空=干净、`已保存`、`.dirty`=未保存（停输 ~1s 自动存，Ctrl+S 立即存）、`.conflict`=外部已改（409，`window.confirm` 选覆盖/重载，绝不静默覆盖） | 保存指示 |
| 源码编辑框 | `.wk-ed-ta` | 编辑态的 `<textarea>`（叠在着色层上、自身滚动，等宽、**文本透明 + `caret-color` 显光标**）；值经 **DOM 属性赋值 `ta.value`** 灌入（不走 innerHTML 转义）。textarea 内部选区不进 `window.getSelection()` ⇒ 编辑态 `#work-editor.editing` 屏蔽引用浮窗（web-ui §54） | textarea/编辑框 |
| 编辑区着色层 | `.wk-ed-hl` | 编辑态叠在 textarea 下的**只读着色层**（`aria-hidden`，`pointer-events:none`）。`wkHlHtml` 按扩展名分词上色；**token 只改 color**（禁字重/字形，否则与 textarea 错位）。`wkEdPaint` 重绘后回填 scroll、`wkEdPaintSoon` rAF 合帧；textarea `scroll` 同步。token 类 `.hl-kw/str/num/com/h/b/i/code/link/quote/li/hr`（web-ui §54） | 语法高亮/着色层 |
| 视图开关浮层 | `#wk-view-pop` | work 模式「预览 / 侧边栏」两个开关（`.wkv-row`，`data-wkpane` = workspace/sidebar），由侧栏右上角 `#wk-view`（`\|\|` 图标）展开；**与「折叠侧栏」合并成同一个浮层**（`sidebar` 行走 `setPanel(on,{pin:on})`，work 模式下 `#panel-collapse` 隐藏）。编辑区/助手两行已随改版退场（改由顶栏 tab 承载）。不变量 = 聊天 tab / 文件 tab / 预览至少一个在场（`applyPanes()` 全关时强制回聊天 tab 并 toast） | 两栏开关浮层 |
| 个性化工作区预览栏 | `#work-preview` | work 模式**常驻最右列**（`state.wkPreview` 门控，`#chat-area.work.wk-preview`；列宽 = `state.wkPrevW` → CSS 变量 `--wk-pw`），含头部 tab 条 `#wk-pv-tabs`（预览 / 评论）。**预览 tab** 渲染当前工作项目的项目预览——**复用 `views/cards/preview/preview-card.js` 的 `mountPreview()` 三级链**（backend 容器 → `.claude/preview/` 静态页 → 默认项目页），挂 `#wk-pv-body`，切项目跟随、关掉不销毁重开零重载。**持久列、非 `.view-card`**，不清会话槽、不切模式（区别于打开「项目」页的槽预览卡，web-ui §43） | 预览栏 |
| 右栏 tab 条 | `#wk-pv-tabs`（`.wk-pv-tab`） | 右栏 `#work-preview` 头部两钮「预览 / 评论」，`data-wkpv` = `preview`/`comments`，active 恰一个。真源 = `state.wkPvTab`（全局持久化）；`work.js` `applyPvTab()` 单口渲染（`.pv-comments` 类 / `.wk-pv-tab.on` / `#wk-pv-body`⇄`#wk-cmt` hidden 互斥）。见 web-ui §55 | 预览/评论 tab |
| 评论面板 | `#wk-cmt`（`.cmt-*`；`sidebar/comments.js`） | 右栏评论 tab 内容：筛选按钮（`data-cmtf` 全部/未解决）+ 按 path→行号排序的列表；条目 `.cmt-item`（`.resolved` 灰化）含定位钮 `data-cmtloc` / 时间 / `.cmt-ex` 摘录 / `.cmt-text` 正文 / 解决·重开·删除（`data-cmtact`）。事件一次委托（`cmtMount`）。数据 = `GET/POST /gateway/comments`，存 `<项目根>/.claude/comments.json`，整份替换 + 失败回滚。见 web-ui §55 / [gateway.md](gateway.md) §17 | 评论列表 |
| 原文评论标记 | `.cmt-mark` / `.cmt-mark-res`（阅读态 `#wk-ed-body` 内 `[data-l]` 元素） | 被批注的行/块在**阅读态原文**上的可见标记（暖色底 + 左竖条；已解决=中性灰淡显）——`work.js` `cmtApplyMarks()` 据 `comments.js` `cmtRangesFor(path)` 的行范围 l0..l1 落类 + `data-cmt-id`。md 走 `mdHtml(...,'data-l')` 行锚、纯文本走 `wkCodeHtml` 逐行 `<span class="wk-ln" data-l>`。**编辑态（textarea 载体）无标记**。面板定位 → `wkCmtScrollId` → 滚到该行 + `.cmt-flash` 闪烁。见 web-ui §55 | 批注高亮 |
| 评论胶囊 | `#wk-tb-comment` | 顶栏 `.wk-topbar` 最右工具钮（`.wk-tb-tabs` 用 `flex:1 1 auto` 顶到最右），图标 `I.msg`。点击 `toggleComments()`：**右栏未开则先自动打开**（`state.wkPreview=true` + `applyPanes()`）再翻转 `state.wkPvTab`。active 态 `.on` 用 inset 阴影（不改尺寸）。见 web-ui §55 | 评论按钮 |
| 添加评论浮层 | `.cmt-pop`（`.cmp-*`；`openCommentComposer`） | 文件选区「添加评论」行唤出的浅色浮窗（顶部 `+` 浮窗同族定位：锚 `snap.rect` 夹取视口内）：`.cmp-loc` 位置（文件 · 行范围）+ `.cmp-ex` 摘录 + `.cmp-in` textarea + 取消/评论；Ctrl+Enter 提交、Escape/点外/滚动关闭。提交构 `ProjectComment` 落当前项目。见 web-ui §55 | 评论输入浮层 |
| 下沉区 | `#chat-area.work` grid 的 `col1` | work 模式主区左侧的编辑/聊天容器（`#work-editor` / `#session-card` 二选一），在**一整张白卡**（`#sidebar.open` + `#chat-area.work` 拼接）上「挖」出的圆角矩形**洞**的下半——底色 = 底板 `--plane`（与底板同源，等价于露底板）、`margin: 0 8px 8px` + 下圆角；上半 = 顶栏 tab 条（同底色 + 上圆角），两格拼成同一个 8px 白边的圆角矩形。助手浮卡/收敛条脱流、不参与拼洞（`:not()` 排除）。见 web-ui §43 | 主区左侧 |
| 顶栏 tab 条 | `.wk-topbar`（`#wk-tb-new` / `#wk-tb-tabs` / `#wk-tb-comment`） | 下沉区顶部一行 `[+] [聊天胶囊 × N] [文件名] …… [评论]`：`#wk-tb-new` = 新建聊天（`newWorkChat()`）；聊天胶囊 = 开放集 `state.wkChats` 一条一枚（`data-wkchat` = 会话 hash 或哨兵 `new`），命名用会话标题、右端 `×`（`.wk-tb-x`）= `wkCloseTab()` 只移除不删会话；文件 pill（`data-wktb="file"`）= 编辑区、在场 ⇔ `state.workFile` 非空，右端 `×` = `closeWkFile()`（先 flush pending 编辑再清 `workFile` + 回聊天 tab）。全部 pill 由 `renderTopbar()` 单口渲染，**同一时刻 active 恰一个**（与下沉区实际显示同源 = `wkShownTab()`）。点胶囊 = 切路由 + 靠回栏；点文件 pill = `wkMainTab='file'`；**点侧栏会话行（`.sess-item`）与点胶囊同语义**（强制聊天 tab + 助手靠回栏）；最右 `#wk-tb-comment` = 评论胶囊 | tab 条/切换条 |
| 聊天 tab / 文件 tab | `state.wkMainTab`（`'chat'`/`'file'`） | 下沉区**二选一**显示：`'chat'` = 助手卡（靠栏，`#session-card`）/ `'file'` = 编辑区（`state.workFile` 非空）。助手脱流（float/slim）时下沉格按「有文件给 file、否则空」显示。全局持久化。见 web-ui §43 | 下沉区内容 |
| 新建入口「+」 | `#wk-new` / `#wk-new-pop` | work 侧栏 tab 行右侧加号：聊天 tab = 新建聊天（`navigate('#/')`）；文件 tab = 弹 `#wk-new-pop`（新建文件/新建文件夹/上传文件/上传文件夹，**功能暂未接入**）。按钮 title 与 🔍 提示随 tab 切换 | 加号/新建 |
| 最近列表 | `#recent`/`#recent-body` | 会话容器（「最近」头 + 整理会话 + 模式 tabs）；连接状态点 `#floria-conn` 随模式行改址落在此头左侧 | |
| 整理会话弹层 | `#organize-pop` | 「一个列表 / 按项目展开」切换浮层 | |
| 模式 tabs | `#mode-tabs` | 项目/聊天两种列表排列 | |
| 项目文件夹分组 | `.folder` | 按项目分组的折叠头（含行内「+」新建） | |
| 会话 tab | `button.sess-item` | 最近列表里的单个会话条目；**排序 = 有状态（运行态点在场）置顶 + 组内 createdAt 降序**（`engine/sessions.js` `sessCmp` 单一排序器，createdAt 由网关 `/gateway/sessions` 透传 jsonl birthtime；气泡弹层/搜索覆盖层同序；项目胶囊与文件夹维持最近活跃不动） | 会话tab/会话行 |
| 状态点 | `.dot` | tab 左侧运行态小点（web/CLI 同一判定链） | |
| 行操作浮窗 | `.row-menu-pop` | 行右键（桌面）/ 长按（触屏）唤出的浮窗，挂 `document.body` 的 fixed 卡片，落点 = 行左下（长按）/ 指针处（右键）；与浮起同生同灭。**注册式（`registerRowMenu`）一源多用**：会话行（`recent.js`，重命名 / 关闭会话）与 work 文件树行（`work.js`，重命名 / 删除=移入 `.trash/`）——菜单项由各列表声明（web-ui §7 / §45） | 三点菜单/会话行菜单/文件行菜单/浮窗 |
| 侧栏浮起 | `.lift`/`.lift-anim` | 桌面 hover 时 tab 浮起动画态 | |
| 搜索覆盖层 | `#search-overlay` | 全屏搜索全部对话 | |
| 重命名弹窗 | `#rename-modal` | 重命名对话框，**一件两用**（`openRenameDialog({heading,placeholder,okText,value,onSubmit})`）：会话行 → 会话标题、work 文件行 → 文件/目录名（web-ui §7） | |

## 消息流（`#messages` 内）

| 规范名 | 实体 | 说明 | 旧称 |
|---|---|---|---|
| 消息气泡 | `.msg` | 用户（u）/回复（assistant）/系统提示（`.msg-system`） | |
| 引导气泡 | `[data-t="g"]` | guide agent 产物，按碎片交错穿插 | 引导消息 |
| 处理折叠体 | `details.done-fold` | 回合处理块总称：处理状态 + 旁白 + 工具调用行 | 折叠体 |
| ├ 处理状态 | summary（`.df-dot`/`.d-count`/`.d-dur`） | 终态词三态「正在处理 / 已处理 / 已停止」+ 计数段 + 计时：处理中「正在处理」、正常收尾「已处理」、无正文非正常收尾「已停止」（不显时长与计数）；**计数段** = `.d-count`（`N 次工具调用`/`N 次提问`，0 值省略，成果态显）；**脉冲点** = `.df-dot` 呼吸小圆点（无响应/连接中断红标与状态行均不在 summary 轮转） | |
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
| 排队 dock | `.queue-dock` > `.q-item` | 排队消息条目（无「排队中」文本标签）；`.q-item` = 纯命中盒（无背景/边框/内边距），**气泡壳挂文字段 `.q-text`**——气泡归属文字、不归属图片：纯文本项=一个气泡、纯图项无 `.q-text` 即无气泡（整张图即点击体）、文字+图项=文字带气泡而图片在气泡外裸渲染；排队图恒 `.q-img` 不换 `.msg-img`（不开大图） | 排队消息 |
| 两层消息流占位 | `.pin-stage` | 回合开启消息唤出的静态预留块（层2），挂流末恒定在场，高度=max(0, 视口高−输入栏预留−**当前**内容脚印)（脚印实时读取——内容增长/收起都不产生额外滚动余量，未超一屏时滚动极限恒=开启气泡贴顶位；空白恰铺到输入栏上沿，长会话不加空白）；**用户滚动输入永不摘占位**，拆收仅随视图退出 | 钉顶占位/`.pin-spacer`（动态补差体系已退役） |
| 撤回动画 | restored 链 | 打断无实质响应 → 气泡塌缩淡出 + 文本回填输入栏 | |
| 压缩实时态 | compact-state → 状态行 | 「正在压缩会话中……」 | |
| 图片消息 | `.msg-imgs`/`.msg-img` + 灯箱 | 内联缩略图（上限 160px）+ 点击放大层 | |
| 文件卡片 | `.msg-files`（`.file-card`） | 消息内文件附件卡片（dshFile 图标 + 文件名，点击复制路径）；发送占位 `[文件:<会话 cwd 相对路径>]` 在渲染层剥出 | |
| 代码块/表格 | `.code-block`/`.md-table` | markdown 渲染件 | |
| 消息操作条 | `.msg-actions`（`.msg-copy`/`.usage-wrap`/`.msg-time`） | 气泡底部一行：复制钮（copy→check 1s，复制文本经 `messageCopyText` 剔 `.msg-actions` 等）→ `.usage-wrap`（含「用量 X tok」**按钮** `<button class="msg-usage">`〔`ICON_USAGE` 数据库图标 + 该条回复请求 token 合计 `input+cache_creation+cache_read+output`，`fmtUsage` ≥1e3 折 K 一位小数；点击弹 `.usage-pop` 明细面板〕）+ `.usage-pop`）→ 时间（本地中文单位 `YYYY 年 M 月 D 日 HH : MM`、前导零省略，`fmtClock`）；用量按钮文字与时间**同字号 12px**；**仅 assistant 回复气泡携带**（用户气泡只有复制钮）。数据源 = 投影层 `DisplayMessage.usage` 明细对象 `{input,cacheRead,cacheWrite,output}`（`conversationDisplay.ts` assistant 分支 `usageDetail`）+ `DisplayMessage.model` + `DisplayMessage.timestamp` |
| 用量明细面板 | `.usage-pop`（`.up-head`/`.up-title`/`.up-total`/`.up-rows`/`.up-row`/`.up-k`/`.up-v`） | 点 `.msg-usage` 弹出的卡片（绝对定位在 `.usage-wrap` 内，`left:0` **左缘对齐用量按钮左缘**〔dsh 同款〕、底部对其上方 8px、宽 280px，`--bg`+`--border`+`--shadow`）：头部「本轮用量」+ 合计（`fmtTok` 千分位）→ 行 = 提供方 / 模型（`modelProviderOf({k:'model',v:model})/model`）、缓存命中 `cacheRead/(input+cacheRead+cacheWrite)`、未缓存输入、缓存读取、缓存写入、输出（各 `fmtTok` tok）。打开时 `.msg-usage` `aria-expanded="true"`；单开互斥（`closeUsagePops` 开本关它）+ 点外区关闭 | |
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
| `+` 浮窗 | `#cmd-btn` 唤出 | 去顶层 tab，单页四组堆放（上传=选图行+已选缩略图+文件上传行 / 技能=MGR.skills.personal / 引用会话=近 48h ALL / 指令=MOCK_COMMANDS；`.grp` 组标题 + `.rowIco` 行图标）；等宽=输入栏同宽，搜索框滤全部组。**行图标 = dsh `MenuView .itemIcon` 逐字（14×14 裸图标，无背景/圆角，色随行文本）**；**每条命令各有字形**（`commands.js` `CMD_ICON` 表，同 dsh `HOST_FACES` 语义，表外回落 `dshPlus`），非整列共用「+」；图片行字形 = Radix Icons `image`（dsh 产品集无图片图标，取 `icons.js` 里唯一非 dsh 原件）；`/clear` 行已删（无对应前端动作）；goal 字形备存 `I.dshGoal` 未上行（floria 后端无 `/goal` 命令）。**dsh 图标族不变量：`stroke="currentColor"` 逐条挂 path、绝不挂 `<svg>`**（只有 `stroke-width` 在 `<svg>`）——含 `fill="currentColor"` 实心路径的字形（dshFile、dshSkill）若在 `<svg>` 上写 stroke，实心轮廓会被再描一遍、比同排粗一倍 | |
| 命令菜单 | `#cmd-pop` | 统一条目 `cmdEntries()` 平铺索引（键盘导航跨组）；选择分发：图片行=`img-file` 选图 / 文件上传行=`file-upload` 选文件（`addUploadFiles` 上传**落盘跟随会话**：带 sid/project 网关按会话根落 `<会话根>/uploads/` → 文件胶囊进附件行，发送时消息拼 `[文件:<会话 cwd 相对路径>]` 占位[同会话恒 `uploads/<名>`]、web 渲染剥出文件卡片）/ 技能·会话=`appendMentionChip` 追加输入栏（serializeInput 序列化 `[插件:X]/[会话:X]` 令牌，与 @ 提及同链）/ 命令=原链（risk→确认门）；vision 入口门控随图片 tab 退役（粘贴/拖拽/发送链本无门控） | |
| 风险确认门 | `#risk-modal` | 高危命令确认对话框 | |
| @ 提及浮窗 | `#mention-pop` + `.mention` | 插件/技能 + 近 48h 会话提及选择（会话区为浮窗第一区） | |
| 引用浮窗 | `.quote-pop`（`inputbar/quote.js`） | 编辑区/消息流选中文本**松开鼠标**即唤出（document mouseup）；**浅色竖排菜单**（色值不跟主题变量）：动作行（内置「使用 AI 编辑」+ 项目申报行，见「浮窗动作」）+ 下行输入行（写话术即发「引用 + 话术」）；**右键不拦**，浏览器原生菜单照旧；开窗即快照选区（点浮窗输入框会清 DOM selection；快照 = `quoteSnapOfRange(range)` 单一构造入口、无模块级状态）。两条来源：宿主机内选区（桌面鼠标）+ 预览页 `postMessage` 自报。**触屏设备不弹本浮窗**（走 iOS 原生选中菜单）。见 web-ui §47/§48 | 选中引用浮窗 |
| 引用胶囊 | 输入栏 `.mention.ref` / 消息内 `.mention-chip.m-ref` | 选中引用的 chip：**file 类** = 文件 icon +「引用自 <basename>」（只给位置，序列化 `[@引用:<路径>#L<s>-<e>]`）；**reply 类** = 消息 icon +「引用自「<标题>」· 第 N 条回复」（序列化 = 锚点令牌 `[@引用回复:<第N条>|<标题>]` + 原文块）；**pdf 类** = 文件 icon +「引用自 <basename> · 第 N 页」（序列化 `[@引用PDF:<路径>#p<s>-<e>]` + 原文块）；两类原文块只进消息、气泡渲染前由 `stripQuoteBodies` 剥掉；回显双入口 `renderUserText`/`mdInline`。见 web-ui §47/§48 | 引用 chip |
| 浮窗动作 | `preview.json` `quoteActions` 段 / `.quote-pop .qp-row` | 项目向宿主申报的浮窗动作行（与 `backend`/`cards` 并列的**第三种能力申报**）：纯数据（无 path，不指向文件；`id` 白名单 + 组内唯一、`title` 非空、`icon` 取 `I` 表键缺省 `plug`）。宿主与内置行「使用 AI 编辑」合流（同 id 内置优先），点击**只回发 id**（`floria-quote-action`）给预览帧，**执行逻辑在项目页面自己的运行上下文**。载体复用 `GET /gateway/preview-cards`（一次请求取两份申报），动作表常驻 `views/registry.js`，与 EXT 卡同生命周期。见 web-ui §48 | 申报动作/浮窗 tab |
| 预览桥 | `floria-quote-open` / `-close` / `-action`（`window.message`） | 预览页（iframe）内的选区跨文档不可达 ⇒ 预览页自报开窗/关窗（`-open` 带 `{text, rect, pdf, page, pageEnd?}`，rect = 帧内视口坐标），宿主点申报动作回发 `-action`（`{id}`）。**门 = `e.source` 必须是当前 `.preview-frame` 的 `contentWindow`**（按 e.source 反查帧，不取第一个）；宿主 `quoteFrameRect` 叠帧偏移换算坐标。见 web-ui §48 | 预览引用桥 |
| 提及令牌 | `[会话:标题\|sid]` / `[插件:X]` | chip 随消息文本发出的字面令牌（`serializeInput` 单一序列化点）；**会话令牌恒带 sid**（精确寻址，免疫改名），chip 与 CLI 终端**只显示标题**（按 `\|` 切分）；sid 由 `hashOf(s)` 得出（与 web 消息路由同键）。两个提及入口 = `@` 浮窗（`mention.js`）与「+」菜单「引用会话」（`commands.js`）——**两处都输出带 sid 形态**；令牌为纯 UI 引用手势，**不产生授权** | |
| 接管栏 | `#composer-takeover`（`#input-bar` 最后一个子元素） | **仅审批/提问卡（`.appr-card`）**；可交互提问走 CLI 审批链 `renderQuestionApproval` 下发的 `.appr-card.qa-card`（选项点选/多选/自定义输入/跳过/上一题下一题）；审批卡是输入栏的子元素而非兄弟节点；`.bar-takeover` 时输入栏仅 `padding:0 + overflow:hidden`（**卡自身铬全剥离贴卡面**——`.appr-card` 去边框/背景/圆角/阴影，黄条头贴顶，圆角由输入栏裁溢出裁出；输入栏自身边框/背景铬不动=表面连续）+ 原内容组 `display:none` → 卡片即输入栏本体；出现/解决 = **单一时间轴：输入栏自身高度** h0→h1 过渡（0.32s cubic-bezier）+ overflow 裁切（无 fade 淡入淡出——杜绝淡入与高度动画双时间轴竞速）；动画期 `.composer-growing` 卡片 absolute bottom:0 底边锚定，`wrapAnimating` 期 `syncTakeoverPad` 首行直接 return（RO 守卫）；聊天区 padding-bottom 一次性设终值 + `lastPad` 同值短路 | |
| 任务浮窗 | `#task-dock` + `.td-panel`/`.td-lip`/`.td-head`（`#input-bar` 子元素） | 底栏上的生长式浮窗，渲 TodoV2 任务清单（CLI `task-state` 上报，与 CLI `TaskListV2` 同源同判定）；**dsh 任务栏形态**（2026-10-04 定案）——收敛态露出**整条头部条**（`.td-lip`，与 `.td-panel` 同族白卡）：计划图标 `.td-hico` + 「任务」`.td-title` + 计数 `.td-counts` + 折叠箭头 `.td-chev`（收敛朝上/展开朝下，`:not(.open)` `rotate(180deg)`），点击上展、再点 `.td-head`（同 header）向下收敛；展开态=头部 + 圆点状态行列表（`.td-item`/`.td-dot`：完成绿实心 / 进行中蓝环 / 待办灰实心，语义挂 `data-st`），仅阻塞行 dim（完成行不变暗）；宽=输入栏宽−48px 居中，展开底边与输入栏上沿留 `--td-gap`=10px 间距、最高 `min(40vh,460px)` 内部滚动；审批/提问接管在场 → `.blocked` 自动收敛 + 禁点 | 任务栏/任务清单窗 |
| composer 遮罩 | `#composer-mask`（`#session-card` 内、`#chat-scroll` 兄弟） | 会话态贴底栏的全卡宽渐隐层：`linear-gradient(180deg, color-mix(in srgb, var(--sunken-bg) 0%, transparent) 0, var(--sunken-bg) 36px)` 上叠实心底（透明→底色 36px 渐隐带 + 其下实心遮住滚过的消息；**底色 = 模式色钩子 `--sunken-bg`**，chat 白卡 / work 底板随模式换色）；高度 `calc(var(--bar-h,116px) + 58px)`——`--bar-h` = 底栏布局高（`engine/viewport.js` settle 实测 `#input-wrap` offsetHeight），故多行输入/接管卡长高时渐隐带上沿随底栏上沿同步上移；仅 `#chat-area.in-session` 显形（空态/管理卡隐，`#session-card.wk-assist-slim` 一并隐）；z-index 3：盖消息流、低于 `#char`(4)/`#input-wrap`(5)，`pointer-events:none` 不挡交互。移植自 dsh `ConversationRoot` `.composerSeat` input mask，见 web-ui §51 | |
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
