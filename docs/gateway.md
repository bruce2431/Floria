# 内置网关服务层（gateway）

> 本文件属 `docs/` 文档库（2026-09-10 由原 `ARCHITECTURE.md`「二、内置网关 + web 前端」服务侧与原 `STANDARDS.md` §13 合并重组而来）。
> 网关 = `src/gateway/localGateway.ts`（node:http + ws），随 `feature('PRIVATE_GATEWAY')`（默认开）编译进 exe；`/server on` detached spawn 自身 exe 以 `--gateway` 独立进程长驻（2026-08-17 起），CLI 退出不影响网关。flag 审计 → [build.md](build.md)；web 界面链路定案 → [web-ui.md](web-ui.md)；术语 → [glossary.md](glossary.md)。改动本文件覆盖的任一链路时必须同步更新本文。

## 1. API 前缀与端点总览（2026-08-30 根治定案）

网关全部端点挂 `/gateway/<端点>`（health/activate/shutdown/sessions/plugins/models/model/model-report/wsession[/stop]/diagnostics/session[/rename/.queued]/backend/project/file/image-cache/conversation/activity/events），根 `/api` 撤空（旧路径不保留、无兼容双挂）——定案背景：原端点挂根 `/api/*` 与 `/backend/<label>/` 代理页面共享同一 origin 命名空间，被代理页面写死绝对路径 `/api/*` 会打到网关自身（token 401 → 前端探测失败锁 mock，Pj13 两个会话均踩坑）；迁移后被代理页面绝对路径写错只会 404，永不误伤网关；「故意打网关」的预览页（Pj1）显式用 `/gateway/*`。CLI 侧 `gatewayClient`/`conversationDisplay`/`server` 命令、前端 `app.js`/`sw.js`/`default-preview/default.js` 同批迁移。**唯一例外**：`readyPath` 缺省 `/api/system_stats` 是项目后端（ComfyUI）自身 API，不属网关前缀，勿迁移。总门鉴权 `startsWith('/gateway/')`（health/activate 公开例外不变），sw 缓存排除同步 `/gateway/`。

**安全加固（2026-08-15）**：HTTP 数据接口与 WS 升级一致要求 token——`/gateway/*`（除 `/gateway/health` 探活）与 `/preview/*` 一律校验，失败 401；CLI 侧上报（`conversationDisplay.ts`）经 `src/utils/gatewayToken.ts`（localGateway 启动写/停止清）读取 token 附加；前端所有数据请求/EventSource/预览 iframe 带凭据（token 门锁定态不发请求、解锁后补拉）。

## 2. 认证：token 出 URL + cookie 票证 + 设备配对（2026-08-28）

**机制**：首链仍带 `?token=<hex>`（CLI `/server on` 打印的 localUrl/lanUrl 就是首链）→ 网关 `handleRequest` 开头 query token 命中即种 `floria_auth` HttpOnly cookie（Path=/、SameSite=Lax、1 年；票证 `randomBytes(24)` 落盘便携根 `.claude/gateway-tickets` JSON 数组，`gatewayToken.ts` 存取，上限 64 个）；此后 `/gateway/*`、`/preview/*` 与 WS 升级校验改「**query token 或 cookie 票证二选一**」——浏览器 URL 不再携带 token（`hideGate()` 清 query）。

**设备认证配对（2026-08-28 用户定案：浏览器侧完全删除 token 授权链）**：授权只走手动配对——①设备未授权 → 前端门显示**设备请求码**（8 位 hex，localStorage `floria-device-code` 持久、同设备恒定）；②PC `/server auth add <请求码>` 手动加入授权名单（票证=码本身，`.claude/gateway-tickets` {id,created} 数组落盘，上限 64）；③设备端门态每 2.5s 轮询 `GET /gateway/activate?code=`（公开端点，防枚举靠码熵；命中名单 → 种 HttpOnly floria_auth cookie 1 年）→ 自动 connect 进入门过渡动画。`/server auth` 列出设备、`auth off <n>` 撤销。**无任何 token 授权通道**：query token 仅剩 CLI 内部 gateway-token（上报/WS/关闭，不种 cookie）；/server on/status 不打印 token。

**设备匹配语义**：token 是钥匙、cookie 是每台设备自己记住的钥匙——token 轮换（网关重启）不影响已授权设备；`/server off` 清盘时同步清票证与 custom token（全设备掉线）。

**前端门控**：`needToken()` 判据 =「`GATEWAY && !gateVerified`」（gateVerified 声明提前）；`initGateway` 统一先 `connect()`（cookie 有效 WS 直过 → `hideGate` 直进空态，无效 onclose 回 token 门）；门内输入 token 先 HTTP 预验证（种 cookie）再 connect；`apiUrl` 仍附加 gToken（空串附加无害，网关看 cookie）。

**访问地址（2026-08-29 定案 mDNS 自广播 `floria.local`，全设备免配置）**：同 WiFi/热点设备一律 `http://floria.local:<port>/`，换网络/换 IP 免配置免重授权（授权按设备码恒定）；**仅考虑 Apple/Windows（2026-08-29 用户定案，`/server` 输出唯一地址不列 IP 直连；Android 浏览器 `.local` 解析差不在支持面）**。本机 hosts `127.0.0.1 floria.local`（08-28 备用条目沿用）→ 本机走 hosts、远程走 mDNS。沿革：08-28 曾定 floria.home 走路由器 DNS → 当日弃用全部域名统一 LAN IP → 08-29 mDNS 应答器落地后 floria.local 复活（floria.com 是公网真实注册域名，勿用作别名）。

**设备自报类型 hint（2026-09-05）**：iPadOS Safari 桌面模式 UA 与 macOS 全同（无 iPad 字样），网关按 UA 判设备恒显示 Mac——iPad 判定只能前端做（`navigator.platform==='MacIntel' && maxTouchPoints>1`，app.js `deviceHint()`），随 activate 轮询与 WS 连接 query `device=` 上报，网关记 `gateway-devices.hint`（`touchGatewayTicket` 第 4 参），`/server auth` 展示 hint 优先于 UA 判定（存量票证 WS 重连即补齐）。

## 3. 局网零配置 mDNS 应答器（2026-08-29）

`localGateway.ts` 手写最小应答器（~150 行，无新依赖；bun compile 下 dgram 多播 bind/addMembership/send 先行实测可用）：HTTP listen 成功且 host=`0.0.0.0` 时，UDP 5353 入多播组 224.0.0.251（逐局域网接口入组，WiFi/热点并存全覆盖），应答 `floria.local` 的 A/ANY 查询——A 记录实时读全部局域网 IPv4（过滤 169.254/198.18/100.64-127 虚拟段，TTL 120s，IP/网络变化自动跟随）；**应答双发：多播组 + 单播回源**（多播走标准组内路径，单播直达查询者——AP 的 IGMP snooping/多播抑制常丢多播回程，首版单发多播时设备解析不到 floria.local 即此因，140859 双发后 iPad 实测通过；mDNS 应答幂等收两份无害）；5353 被占/入组失败静默放弃回落 IP 直连（自动路径禁抢端口）；`stopLocalGateway` 一并 `mdnsStop`。首次可能触发 Windows 防火墙 UDP 5353 入站放行提示（允许一次）。

**socket 绑定真实 LAN 地址（2026-08-29 185844 Meta TUN 根修）**：监听 socket `bind(5353, mdnsLanAddrs()[0])` 而非 0.0.0.0——Windows「socket 绑定特定单播地址时多播默认出接口=该地址所属接口，压过 224.0.0.0/4 路由 metric」；Meta/Clash TUN（198.18.0.1，默认路由 metric 0 + 多播 256 < WLAN 286）在线时 bind 0.0.0.0 的多播应答整个被吸进隧道（查询入站正常、应答从未上 WLAN 空气，受控实验实证应答 src 变 198.18.0.1 仅本地回环）；bun 的 `setMulticastInterface` 在 Windows 无效（不抛错不生效），bind 具体地址实测有效；`mdnsHandleQuery` 另补 QR 位检查（无参 addMembership 落默认接口，自听回环应答会形成反馈循环）。无 LAN 地址回退 0.0.0.0 同旧行为。

**网络切换自愈（2026-08-30 热点根修 / 09-01 增量化）**：bind/入组都是启动时按当时网卡定的，换网（家 WiFi ↔ 热点）后旧 bind 地址失效 → 新网段查询收不到（08-30 热点实证：floria.local 解析失败、IP 直连正常）；`mdnsWatch` 每 30s 实时读网卡与 socket 集合 **diff 增量增删**（关消失接口的 socket、补新接口，`mdnsPendingBinds` 占位防 bind 异步期重复发起；增量化根因=gateway.log 实证热点 IP 每分钟抖动，旧版集合不等即全量 stop/start 会把健康接口一起拆掉、服务网段出现 30s 无人应答窗口）；无地址（断网抖动瞬间）不动避免降级 0.0.0.0 被 Meta TUN 吸走多播。

**单播 announce（2026-09-01 iPhone 热点多播被吞根修）**：iPhone 个人热点/AP 隔离网络吞 mDNS 多播——设备查询根本到不了 PC（现场分流实测：iPad IP 直连通、floria.local 恒不解析且从未通过），多接口化/双发所依赖的「查询可达」前提不成立、应答器空转。补主动推送 `mdnsAnnounceOne`：对每个 LAN IP 的 socket 向同子网全部主机地址（`mdnsSubnetPeers` 枚举，排除网络/广播/自身；网段总地址数>512 跳过——校园网 /16 是 AP 隔离环境，单播同样不通）单播发送 announce（**legacy unicast response 格式，2026-09-01 第三轮定稿：header QR=1 AA=1 ID=0/QD=1/AN=1 + floria.local A IN 问题段 + 0xc00c 压缩指针 A 记录、TTL 120s、目的端口 5353**；**CLASS=0x0001，RFC 6762 §18.11 单播应答禁 cache-flush 位 0x8001**，iOS 严格实现会拒收，新鲜度靠重发不靠该位。三轮实证演进：纯 answer 无问题段版属 unsolicited，**iPad mDNSResponder 实测无视**；带问题段走 mDNSResponder 常规应答通道=商用 mDNS 网关同款做法），iOS mDNSResponder 收 legacy 应答即建/刷缓存 → floria.local 免查询可解析。触发四路：socket bind 成功 **3 连发（0s/1s/2s，RFC 6762 §8.3 announce 连发 ≥2 次语义）**（新网络设备免等周期）、60s 周期单发（TTL 之半无断档，周期轮静默）、watch 网络切换重建后新 socket bind 即推、**收到任一 mDNS 查询即对该源单播回推一份**（30s/源节流表 `mdnsAnnounceSeen`，含 _companion-link 等系统查询——覆盖设备亮屏/入网瞬间先发系统查询的黄金窗口；回推自动继承 legacy 格式）。**取证日志**：收到任一 mDNS 查询即落盘「mDNS 查询到达：IP:port（QD=n）」+节流内「单播回推 announce → IP」（gateway.log）——下轮实测 iPad 查询到底到没到 PC 一锤定音；**不通分叉判据：日志有「查询到达」=查询上行通、应答仍被无视（升级回推策略）；无=iPad 查询上行也被吞，announce 路线到头（转 Windows 自建热点方案/iPad 侧 DNS 配置）**。**定向 announce 推送（09-01 第四轮，直连客户端自愈闭环）**：iPad 与 PC 同校园网**单播互通**（AP 仅吞多播、查询仍到不了 PC）——但全网枚举推在校园网 /16 因 >512 跳过、查询回推又收不到查询，推送链路闲置。`mdnsPushToReachableClient`：handleRequest 每请求取 remoteAddress（归一化 IPv4/滤回环（PC 有 hosts 兜底）/`mdnsSameSubnet` 同网段判定），命中即向该客户端**定向单播推 legacy announce 3 连发**（30s/IP 节流与查询回推共用 `mdnsAnnounceSeen`），iPad 直连一次即建立 floria.local 解析（直连一次→域名永通）；全网枚举推 >512 跳过保留，定向推不受限。**部署断层教训（09-01）**：132805（announce 首版）从未被运行——用户实测时 Get-Process 实证仍是旧 exe 183943，「还是有问题」首因是未换 exe；announce 首测=135131；第三轮 legacy 格式+watch 增量版=142430。

## 4. 项目预览页机制（2026-08-15 / 默认主页 2026-08-16）

点管理视图项目胶囊一律进预览（`openProjectPreview(label, hasPreview)`）——若该项目 `<工作区根>/<项目>/.claude/preview/` 存在（`findProjects` 探测 `hasPreview`，`/gateway/sessions` 会话附 `preview` 标志），在消息区渲染 iframe 加载网关静态路由 `GET /preview/<项目>/*`（默认 index.html，label 须命中 findProjects 且 hasPreview、resolve 须落在 preview 目录内防越界）；**2026-08-27 移除预览内「返回项目列表」按钮**（用户定案）——退出预览全靠侧栏导航，`route()` 每次导航统一清 `__backendHeartbeat`（原 `closeProjectPreview` 已删）；**无预览或真预览 404 → 加载内置默认项目主页**（GitHub 仓库风格 `GET /default-preview/<项目>/*`，内嵌资源 `web/default-preview/`，数据来自 `GET /gateway/project?label=`：文件树/README/会话，会话点击 postMessage `floria-open-session` 通知父级跳会话）。真预览页由项目自己维护（自包含静态网页，可带相对 css/js），网关只做静态托管；默认主页是网关内置兜底。**label decode 防护（2026-08-29）**：`/preview/<label>` 与 `/default-preview/<label>` 的 `decodeURIComponent` 必须包 try-catch（decode 失败保留原文 → 404 兜底）——畸形 % 序列（如 `%ZZ`）曾因未捕获 URIError 崩掉整个网关进程（default-preview 免鉴权公开可达，任意设备单个请求即可触发；事发 gateway.log 取证 `URIError at handleRequest`，反复崩溃重启 → 远程端断连/预览打不开）；新增同类路由时 decode 一律照 `/backend` 同款防护。

## 5. 远程宿主同源反代 /backend/<label>/（2026-08-27 定案）

**背景**：iframe 直连 `http://127.0.0.1:<port>/` 只在本机浏览器成立——手机/平板等远程宿主上 127.0.0.1 指向设备自身 → 连接拒绝、预览覆盖层永转圈；`/preview/*` 静态兜底因子资源不带 query token 全 401，不可用。

- **路由**：`/backend/<label>/<path>?<query>` → `http://127.0.0.1:<port>/<path>?<query>`。rest/search 原样透传（保留原始 %xx 编码，不二次解码重组，防中文路径双重编码错乱）；`proxyBackendRequest` 双向流式管道（媒体大文件不落盘），请求侧剥 hop-by-hop + host + cookie（不向项目后端泄露 floria_bp 票证），响应侧剥 hop-by-hop + 上游 set-cookie（防作用域泄漏），Location 改写回 `/backend` 前缀。后端仍只绑回环，访问面不变。（2026-08-29 全称定案：旧 /bp/ 保留解析兼容不再生成。）
- **鉴权**：不靠 query token（页面内相对子请求必裸奔）。`/gateway/backend` 成功响应种 `HttpOnly` cookie `floria_bp`（Path=/backend、SameSite=Lax、24h）；票证存网关内存 Map（含 label 白名单，多项目并行预览互不顶掉，sweep 过期）。`/backend/*` 凭 cookie + 白名单放行，否则 401；label 须命中 findProjects 且 hasBackend，否则 404。
- **前端分流**：`openProjectPreview` 按 `location.hostname ∉ {127.0.0.1, localhost}` 判远程宿主 → iframe 用 `/backend/<label>/`（cookie 由上一拍 `/gateway/backend` 响应种下，子请求自动携带）；本机保持直连零开销。心跳 60s `GET /gateway/backend` 不变（保 lastActive + 续票证）。
- **配套约束**：**经 /backend 代理的项目前端 API 一律相对路径**（根绝对路径 `/delete` 等在 /backend 前缀下会指回网关根 404）——Pj15 已清理全部根绝对 API 路径（2026-08-27）。

**断连联动收尸（2026-08-28，Pj15 上传卡死根修）**：`proxyBackendRequest` 原仅 req 'error' 时 destroy 上游——隧道抖动/刷新页只触发 'aborted'/'close' 不触发 'error'，pipe 不传播断开 → 上游 socket 永挂（请求头已转发、body 永没送齐）→ 后端线程在 `rfile.read` 永久阻塞（事发 12 条 ESTABLISHED 僵尸连接，且死连接是网关空闲自旋烧 CPU 的燃料，事发 0.76 核）。现补四道防线：①req 'aborted'/'close'(complete===false) → destroy 上游；②res 'close'（响应中途 writableEnded=false）→ destroy 上游；③上游 socket 180s 静默超时（对齐 Pj15 后端 Handler.timeout，按静默计非总时长）→ 504；④异常路径落请求级取证日志 `/backend <label><path> 转发中止: <原因>`（gateway.log）。配套 server 侧 `connection` 对 'end'（对端 FIN）回应 FIN——CLOSE_WAIT 不再积压（旧版实测空闲积 8+ 条）。实测（`20260828223208-网关断流修复验证/`）：优雅 FIN 与 RST 两条断开路径后 8131 连接归零、8199 侧零 CLOSE_WAIT、后端复测正常。

**上传串行队列（2026-08-29，Pj15 上传断流根修 `20260829204832-`）**：`proxyBackendRequest` 对 POST/PUT/PATCH（带 body）按 backend label 走 `bpForwardQueues` 串行队列逐个转发、GET/HEAD 直通（媒体大文件下载不走队列）——并发带 body 请求经 Bun node:http 兼容层 pipe 泵会卡死（后端日志铁证：同一张图 90s×3 重试全 400、前端降级串行后全 200；aborted/close 双保险判定无责，abort 是前端超时真断开）；转发中止取证日志带 aborted/close 来源区分与已收/声明字节数，upReq 创建推迟到轮到转发时。配套 Bun 1.3.12→1.4.0（Bun 内部 panic「start index>end index」同型 oven-sh/bun#20470 的根修候选）。

## 6. Web 容器后端进程标准（preview.json backend，原 STANDARDS §13）

> 预览页不止静态 HTML——项目 `.claude/preview/preview.json` 声明 `backend` 字段 → 网关懒加载 **spawn 后端进程**、前端 iframe **直连后端端口**（仿 Hugging Face Spaces）。首个案例：Pj14-AI动画制作 官方 ComfyUI 前端 + 真实 ComfyUI 后端（2026-08-19 落地）。

### 6.1 preview.json 的 backend 字段

```json
{
  "name": "pj14-animation-workbench",
  "version": "3.0.0",
  "backend": {
    "cmd": [".venv/Scripts/python.exe", "main.py", "--port", "{port}", "--listen", "127.0.0.1", "--cpu"],
    "cwd": "../../comfyui-backend",
    "port": 0,
    "idleMinutes": 10,
    "readyPath": "/api/system_stats"
  }
}
```

- `cmd`：spawn 命令数组；可含 `{port}` 占位符（网关 spawn 时替换为实际分配端口）；`cmd[0]` 相对路径按 `cwd` resolve（node spawn 只按进程 cwd 解析，须手动 resolve）。
- `cwd`：相对 preview.json 所在目录（`../../comfyui-backend` → 项目根下 comfyui-backend）。
- `port`：`0` = 网关从 8130 起探测顺延（上限 8160）；显式端口则固定。
- `idleMinutes`：后端无活跃持续该时长被空闲回收（默认继承 `GATEWAY_IDLE_MINUTES`=10 分钟）。
- `readyPath`：就绪探测路径（默认 `/api/system_stats`，项目后端自身 API，非网关前缀）。

### 6.2 网关机制（localGateway.ts，已实现）

- `findProjects` 读 `<项目>/.claude/preview/preview.json`，有 `backend` → 项目附 `hasBackend` + `backendCfg`。
- `GET /gateway/backend?label=`（受 token 保护）：ensureBackend（未起则 spawn）→ `{url, port, pid}`；无 backend → 404。
- spawn：`{port}` 替换 → cmd[0] resolve 到 cwd → `spawn`（env 加 PORT，日志落盘 `便携根/.claude/backend-<safeLabel>.log`）；就绪探测窗口 120×200ms（容忍 ~22s 冷启动）。
- **就绪探测用原生 net socket**（`backendReady`）：编译产物 node:http 的 request 对 aiohttp/Python 后端会挂起，net 直连写 HTTP 头读响应状态（200/404 即就绪）。
- 生命周期：`stopLocalGateway` 遍历 killAllBackends（child.kill + taskkill /F /T /PID 兜底）+ 停回收 timer；空闲回收每 60s（仅 `--gateway` 模式）。
- 前端三级加载：① `/gateway/backend` 命中 → iframe 直连 + 60s 心跳防误回收；② 静态 preview；③ 默认项目主页兜底。

### 6.3 后端进程生命周期解耦（2026-08-28 定案）

**后端进程不随网关关停**：`/server off/restart`、空闲自动退出、网关被硬杀均不 kill 后端——注册表落盘 `.claude/backend-registry.json`（label→{pid,port,startedAt}），网关重启后 `ensureBackend` 按注册表**收养**存活进程（isPidAlive + readyPath 就绪即接管，child=null 走 pid 判活/killTree）；后端仅由空闲回收（idleMinutes，缺省 30min，预览页 60s 心跳保活）与用户手动关闭管理。`/gateway/backend` 响应带 `alreadyRunning`（进程已在册存活）→ 前端不渲染「正在启动」覆盖层，iframe 直挂秒开，仅冷启动显示。**历史教训**：旧机制网关 stop 一律 killAllBackends → 每次重启网关后端冷启动；网关硬杀来不及 kill → 后端孤儿占端口 → 下次 spawn 端口漂移（8130→8131）。

### 6.4 安全

- 后端只监听 `127.0.0.1`（ComfyUI `--listen` 默认）；后端 URL 获取须过网关 token（`/gateway/backend` 属 `/gateway/*` 自动受保护）。
- 后端文件写路径由后端自身约束（如 ComfyUI `--input-directory`/`--output-directory`），粘贴图片落到项目内目录。

## 7. web 独立会话进程链（2026-08-24 改造起）

web 独立会话 = 本地可见交互 REPL 窗口（`/clients` 注册，不再 headless 管道），与普通 CLI 同路径、同样可被远程审批。**会话落盘按来源定案（2026-08-24）**：「笔」新建（无 project）→ 全局根 `@WrokSpace/.claude/projects/`（projectScope:'global'）；「项目 +」新建（有 project）→ 该项目根 `.claude/projects/`；不落 Pj16 项目根。落盘位置与 exe 来源无关（cwd 由 `webSessionProjectRoot` 路由）。

**弹窗行为（2026-09-02 三次定稿）**：spawn 不带任何 `-WindowStyle`；合并进已有终端窗口由系统层承担——默认终端委托设为 Windows Terminal（注册表 `HKCU\Console\%Startup`：DelegationConsole={2EACA947-7F5F-4CFA-BA87-8F7FBEEFBE69}+DelegationTerminal={E12CFF52-A866-4C77-9A90-F570A7AA2C6B}）+ WT `windowingBehavior=useAnyExisting`。**WindowStyle 三版实测**：初版 `-WindowStyle Minimized`=WT 拒绝托管→回落独立 conhost 老式黑窗；二版 `-WindowStyle Hidden`=SW_HIDE 被委托链尊重→进程正常启动注册但窗口完全不可见；cmd 探针 A/B/C 实验（归档 `.trash/2026-09-02/20260902174824-wt-delegate-test.ps1`）实证只有无 flag 才并入 WT → 定稿无 flag，代价=并入时新标签激活 WT 窗口（可能抢焦点）。

**2026-09-07 根治定案：启动链彻底脱离默认终端委托（defterm），网关直调 `wt.exe -w last nt`**：25H2 更新（26200.9168）把 defterm 激活链本身弄坏——注册表委托配置正确仍全部落 conhost 老式黑窗（用户所见「管理员指令框」置顶抢眼、多窗不合并），配置层无解；且委托键屡遭系统更新重置（08-29/09-02/09-07 三次实证）。根治=不再信任 defterm，四件配套：①`spawnWebSession` 改 `spawn('wt.exe', ['-w','last','nt','-d',cwd,exe,...args])` 直并最近 WT 窗口（无窗自动开新窗），行为不随 defterm 配置漂移，原 powershell Start-Process 链（psQuote/-PassThru/outBuf）全数删除；②CLI 入口自检护栏（cli.tsx main 顶部）——交互式 TTY 且无 `WT_SESSION` 且未自举过（`FLORIA_IN_WT`）且非 bun 源码直跑 → 同样 wt 直并后本进程退出（双击 exe 防 conhost 黑窗；wt 不可用留宿主运行），护栏不变量=每交互进程至多自举一次（`FLORIA_IN_WT` 由自举注入，WT 正常标签自带 `WT_SESSION`，VSCode 等自带宿主终端不接管）；③真实 CLI pid 改由 cli-hello 上报补填（wt 自身即退拿不到 pid：gatewayClient 握手带 process.pid，网关 spawn 在途经 `cliHelloPids` 暂存、注册成功取走填入 webSessions；WebSessionProc.child 字段删除，stopWebSession 只用 p.pid）；④网关启动端口落盘 `.claude/gateway-port`（gatewayToken.ts 三件套 save/load/clear，TTL 3s）——并入已存在 WT 窗口时新标签继承旧 WT 进程环境，`FLOIRA_GATEWAY` env 传不到 CLI 子进程，`baseUrl()` env 缺失时读盘发现再回退 8124。spawn 失败判定同步改写：wt exit 非 0 且未注册即 reject（无中转进程可杀），注册超时 20s 不变。**windowsHide 双启动根修（2026-09-09，exe 124320）**：spawn 链两处（spawnWebSession + cli.tsx main 自举块）原带 `windowsHide: true`（旧注释称「不受此 flag 影响」=假设错误）——SW_HIDE 随 STARTUPINFO 被 `-w last` 无窗时新开的 WindowsTerminal.exe 继承=首窗创建即隐藏、父进程即退，二次启动命中已存窗才可见（「启动两次」现象）；根修=两处删 windowsHide（wt.exe 是 GUI 子系统，spawn 它不会带出控制台黑窗，无窗可防），taskkill 等其它 windowsHide:true 调用点与 WT 窗口无关不动。

**发送即 resume（2026-08-25 定案，会话打开预览/发送才恢复窗口）**：点开 web 会话不再自动 resume（与 CLI 会话一致仅预览；进程停止时列表状态点由常驻红改透明无点——任何会话仅进程在跑时 busy 绿点、否则 null）；会话进程未在线时**发送消息才恢复**——网关 `handleWsMessage 'send'` 对 `cliClients` 未命中且非启动中的会话走 `resumeAndDeliver`（**web 与 CLI 一视同仁**：`sessionProjectRootOf(sessionId)` 按磁盘 `<项目根>/.claude/projects/<id>.jsonl` 定位项目/全局根 → 复用 `spawnWebSession --resume` 按定位项目选 cwd，注册完成后再经 `cliClients` 注入消息；同一会话 resume 在途复用同一 promise 防双 spawn 双写 jsonl；会话文件不在磁盘 → 拒绝「目标会话未在线」）。

**账面活性统一判定（2026-09-10 根修，exe 134517）**：send 暂存分支原判定 `webSessions.has(sid)` 只查账面不查进程——pid 空记录（cli-hello 未上报，reclaim 原条件 `p.pid && !isPidAlive(p.pid)` 恒不清）或进程已死的残留记录会**挡住 resumeAndDeliver 恢复路径**：消息进 `pendingDeliveries` 暂存后无任何进程被拉起，web 恒显「无响应」且暂存零反馈；用户后来手动启动该会话 CLI（/clients 注册钩子 `flushPendingDeliveries`）才补投——即 09-10 实测「web 无响应 + 本地启动 CLI 后莫名接续」事故（消息不丢是暂存补投设计内行为，「恒无响应+零反馈」是缺口）。根治三处一判（`webSessionEntryAlive`：pid 已知 → isPidAlive；pid 空 → cliClients WS 在即进程在）：①send 暂存分支改按真实活性判定，死记录落空走 resumeAndDeliver 恢复；spawn 在途常态不弹回执，活进程断连重连间隙暂存回 status「会话连接恢复中，消息已暂存，CLI 重连后自动补投」（前端 `addSystem` 现成展示链零改动）；②`spawnWebSession` 幂等复用前验活，死记录清理后走正常 spawn（防双写不破：死进程不写盘，活进程重连窗口由 cliRegisterAt 近期痕迹保护兜住）；③`reclaimIdleWebSessions` 判活统一走同函数，pid 空孤儿注册 60s 步进可清（活进程 WS 重连间隙被清的边角由 cliRegisterAt 保护兜住，无双写风险）。守护的不变量：账面记录命中「存续」判定时，必有活进程或其活跃连接可承接消息。

**WS 心跳回收僵尸连接 + spawn 在途登记 settle 即清（2026-09-11 四缺陷根治，exe `cli-dev-20260911102646`）**：症状「web 和 cli 通信总是显示中断」+「web 发送信息，cli 侧无法正常 resume 并运行，手动 resume 后发送的信息自动出现」。**② 根因 = `spawningPromises` 只 set 不 delete**（全文件 `.set`/`.get`/`.has` 三族、零 `delete`，3011-3014 注释自称「settle 即清」从未兑现）：某会话首次 `spawnWebSession` 后条目（含已 settle 的 promise）永久驻留 ⇒ ①顶部 `inflight = spawningPromises.get(sid)` 幂等短路恒命中旧 promise，该 sid **再也 spawn 不起来**；②send 路由 `spawningPromises.has(sid)` 恒真 → 消息全落 `pendingDeliveries` 等一个永不再来的注册。用户手动 resume（CLI 原生 `--resume`，不经此表）→ `/clients` 钩子 `flushPendingDeliveries(sid)` 一次补投 ⇒ 表现为「手动 resume 后消息自己出现」；新建会话 sid 每次新分配不经此表 ⇒「开启会话是正常的」；「偶发」= 只有该 sid 曾被 spawn 过才中。修 = `const tracked = p.finally(() => { spawningPromises.delete(sid) })` + `.set(sid, tracked)` + `return tracked`（与既有 `resumingSessions` 的 `.finally` 清理同构）；不变量「`spawningPromises` 里的条目恒为真在途、未 settle 的 spawn」——表本身即真值源，send 路由 park 判定与 spawn 幂等短路同时恢复正确，无新增状态、无兜底分支。**① 根因 = 应用层零心跳**（无 ping/pong、无活性探测；`cliClients.has(sid)` 对半开死链恒 true ⇒ web 显示「连接中断」且 `webSessionEntryAlive` 误判活进程，反过来给 ② 的 park 分支喂错判据）。修 = `HEARTBEAT_INTERVAL_MS=30_000` + `HEARTBEAT_MAX_MISS=2`（≈60s 判死）+ `wsMisses: WeakMap`；`markAlive(ws)` 接在 `wss.on('connection')` 与 `/clients` upgrade 回调两处；`startSocketHeartbeat()` 遍历 `[...sockets, ...cliClients.values()]`，非 OPEN 跳过、misses ≥ MAX 则 `terminate()`（→ close → `detach` 清 `cliClients` + 3s 复核窗，与既有收尸链同一路径），否则 misses+1 且 `ping()`；`unref()` 不阻进程退出；`stopSocketHeartbeat()` 在 `stopLocalGateway` 内调用。协议依据（非猜测）：RFC 6455 端点须自动回 pong，浏览器网络层自动应答（前端零改动）、CLI 侧 `ws` 客户端默认 `autoPong`——本机实测 4/4 次 ping 均收 pong；回收路径用 `node:net` 裸 socket 握手后从不回 pong 实测 `terminate@97427 → closed` 而正常连接 `open: true` 不受影响。不变量「sockets/cliClients 里的连接恒为最近一个心跳窗内可应答的活连接」。**③ 展示层**：审批接管在场（`takeover === 'approval'`）时抑制 150s「无响应」红标（读既有状态，不新增信号源），详见 [web-ui.md](web-ui.md) §4。

**防双进程+exe 翻案（2026-08-31，新会话/同步异常根修 `20260830222122` 委派双会话实锤）**：①`webSessionExe` 废弃 08-24「笔=全局根/项目=项目根目录扫描 cli-dev*.exe」旧案，**一律用网关自身 exe**（process.execPath，协议必然匹配）——旧案在 `/gateway/*` 迁移后选中目录里的旧 exe（全局根仅 08-29 版），探测旧 `/api/health` 404 → 永不注册 → wsession 20s 超时=「远程端无法启动新会话」；②`spawnWebSession` resume 前查 `cliRegisterAt`（/clients 注册时间戳 Map，CLI_RECENT_REGISTER_MS=10s）：近期有痕迹 = 活进程断连重连中 → 复用 resolve 不 spawn（此前 miss 即 spawn，与重连中的原进程形成同会话双进程：网关对重复注册 `prev.close()` → 每秒互踢乒乓、消息路由 50% miss、审批回调每秒清、双写 jsonl，永不自愈——92bbd49b 事故）；`resumeAndDeliver` 注入改 400ms×5s 轮询等重连进程回来再注入（原单次 miss 即报「未注入」）。③取证日志三件：重复注册顶替落日志（乒乓从此可见）、`spawnWebSession` 全程日志（spawn 开始含 exe/cwd / 注册成功含耗时 / 注册超时含 exe）、网关日志逐行 `[MM-DD HH:MM:SS]` 时间戳（`stampGatewayConsole` 在 startLocalGateway 劫持 console，仅 --gateway 独立进程）。

**网关关停不杀 web 会话窗口 + pid 注册表收养（2026-08-29 根修）**：web 启动的会话窗口里执行 `/server restart` 曾把自己杀掉——`doOff` → `/gateway/shutdown` → `stopLocalGateway` 内 `killAllWebSessions()` 把 `webSessions` 全部 CLI pid taskkill，包括正在执行 restart 的那个会话（CLI 死 → doRestart 后续 doOn 重拉网关永不执行，restart 断在半路、窗口退出）。定案：**web 会话与普通 CLI 会话同等权重，网关 off/restart/空闲退出/SIGINT 一律不杀存活窗口**（gatewayClient 自动重连新网关；与 backend 生命周期解耦同构）。代价是重启后内存 `webSessions` 丢失 → resume 幂等（防双进程写同一 jsonl）失效，故新增**运行 pid 注册表落盘** `.claude/gateway-websessions.json`（`[{sessionId,pid,startedAt}]`，变更即写防 kill -9 留脏；`persistWebSessions` 在 set/各 delete 点调用），网关启动 `adoptWebSessions()` 读表收养 isPidAlive 的条目（无 child 仅凭 pid 判活/killTree，同 backend 收养先例）。**注意与 2026-08-25 删除的旧 web-sessions.json 区别**：旧表是「web 创建来源标记」（resume 路由用，已由磁盘定位取代，勿复辟）；本表是「运行进程 pid 表」（生命周期管理用，与 backend-registry.json 同构），两者不冲突。`stopWebSession`（taskkill 窗口）仅剩显式关闭单会话端点与超时清理使用，网关关停路径不得调用。

**SSE 僵尸连接根治：网关关停显式 end() 全部 SSE 流（2026-09-09，exe 183527）**：「web 新建会话长时间空白（只剩首个乐观气泡，刷新立即恢复）」根因链——用户 `/server restart` 换 exe 重启网关时，`stopLocalGateway` 里 WS 被显式 `close()` → 页面 4s 自动重连成功（「已连接」徽章、审批/提问卡正常）；但 HTTP `server.close()` **只停止接受新连接、不断开既有连接**，`sseClients.clear()` 只清引用——浏览器 EventSource 收不到 TCP FIN → `onerror` 永不触发 → 前端永不重连 → 僵尸 ES 收不到 updated/session-delta/stream-text，消息区实时链静默死亡（CLI 侧照常写 jsonl，SSE 推送自测正常，仅推给已清空的空集合）。修复 = 关停时对 `sseClients` 逐个显式 `c.res.end()` 再清集合：客户端收到流结束 → onerror → 3s 后 `initLive` 重连新网关 → hello → `refreshSession` 全量对账，旧页面**不刷新自动恢复**（与 WS 侧显式 close → 自动重连完全对称，不加状态源）。

**状态点偶发观测不到根治（2026-08-29 / 前端 v150）**：状态点链路 = REPL `sendSessionActivity` 上报 → 网关 `sessionActivity` 内存 Map → `/gateway/sessions` 附 `state` → 侧栏着色。此前三处缺陷叠加致「偶发无点」：①REPL 只在状态变化时上报一次（无心跳），网关 `ACTIVITY_TTL_MS=10min` 清扫后点消失（长回合 busy>10min/挂机 idle>10min 必现）→ **REPL 上报 useEffect 加 60s 心跳**；②前端 `refreshList` 签名不含 state，状态翻转被判同跳过重渲染 → **签名改 `listSigOf()` 纳入各会话 state 拼串**；③`/gateway/activity` 只写 Map 不广播，前端只在 jsonl 落盘时刷列表 → **网关收报即向 sseClients 群发轻量 `{type:'activity',session,state}`，前端 `refreshList()`**（只刷列表不刷会话区）。语义：waiting 独立橘点 `.st-ask #f59e0b`（等待用户）· busy 绿（运行中）· idle 红（暂停/已完成）· 无（进程退出/未打开）；网关重启后已开 CLI 靠首个心跳（≤60s）恢复点。

## 8. web 审批双操作中继（2026-08-24，web 与 CLI 均可操作同一会话）

CLI 交互权限弹窗接网关中继——`src/bridge/gatewayPermissionRelay.ts`（模块级 set/get 回调）+ `src/utils/gatewayClient.ts`（`/clients` WS 上行 `approval-request`/`approval-local-resolved`/`approval-cancel`、下行 `approval-response`/`approval-cancel`，回调**模块加载即常驻注册**、与连接生命周期无关——见本节 09-11 段）+ `src/hooks/useCanUseTool.tsx`（非 BRIDGE_MODE 时 `bridgeCallbacks` 改读网关回调）→ 本地终端弹窗与 floria 审批卡**竞速（claim），先操作者生效**、另一端自动收起；网关 `/clients` 增 message 监听（审批请求→broadcast `{type:'approval'}` 卡片、本地已决→broadcast `{type:'approval-dismiss'}` 撤卡），`handleWsMessage` `'approve'` 路由 `cliClients` 回 `approval-response`（allow 带 `updatedInput:{}`、deny 带 message）；前端 app.js 处理 `approval-dismiss` 撤卡。

**floria 亦可答复提问（2026-08-24）**：AskUserQuestion 走同一中继——前端 `renderQuestionApproval` 渲染逐题单选交互表单，`sendApprove` 带 `{input, answers}`，网关 approve 路由对 `data.answers` 生成 `updatedInput={questions:数组, answers}`（questions 取数组本体勿嵌套），CLI 交互应答 `buildAllow(updatedInput)` 拿到 answers 执行工具。

**调试**：`GET /gateway/diagnostics`（token 保护）返回审批轨迹 + cliClients/sockets/webSessions 概览。`cliClients` 有会话但 trail 无 `cli-approval-request` 有两类含义：①该 CLI 是**旧 exe**（本次修复前，回调只在连接建立期存在，断连窗口内的弹窗不会上报）；②CLI 为新 exe 但弹窗**仍在网关断连窗口内出现**（09-11 常驻化后此类已可自愈：请求照常入 `pendingApprovalRequests`，重连即补发）。判据补充：查 trail 是否只有 `cli-register`/`cli-hello` 而无后续审批事件，并比对该进程的 exe 时间戳（`Get-CimInstance Win32_Process` 看 CommandLine）。

**审批确认送达后才关卡（2026-08-26，Codex 意见 P0）**：CLI 消费 `approval-response` 后回执 `approval-processed`（仅本地消费才发，竞速输不发）→ 网关转发 `approval-confirmed`（session_id+requestId）、approve 路由 else 分支回 `approval-rejected` → 前端 `sendApprove` 不再立即清卡，设 `approvalPending` 等待确认（8s 超时 + 断连 `showApprovalError` 保留卡片+重试）；`approval-dismiss` 撤卡清理 pending。

**pending 跨网关重启补发（2026-08-31，纯 CLI 侧 gatewayClient.ts）**：重放表 `pendingApprovals` 只在网关内存，网关重启清空后存活 CLI（注册表收养）重连却不重发仍挂起的请求 → web subscribe 重放查空，只剩 jsonl 只读兜底卡无法作答（08-31 实测「重启服务器选择题无法交互」）。修复：①模块级 `pendingApprovalRequests` 补发表——`sendRequest` 记入，`sendResponse`/`cancelRequest`/`approval-response` 消费（含 handler miss 死请求）/`onResponse` 退订（abort 清理路径）逐点移除；②WS `open`（含重连）`resendPendingApprovalRequests` 逐条重发 → 走网关现有暂存+broadcast 链路（网关零改动），web 先订阅收 broadcast、后订阅收重放，两序均补弹可交互卡；③`pendingResponses` 应答表提升模块级跨重连保留 + close 处 `clear()` 删除（原断开即清会杀掉重启前挂起弹窗的 handler），作答经新连接仍命中 handler 唤醒重启前弹窗。

**审批中继常驻化（2026-09-11，根治「网关断连窗口内弹出的审批永不中继」，exe `cli-dev-20260911100248`）**：现场为 web 打开会话 `6983e5be` 时 CLI 侧弹窗、web 审批卡不弹——`/gateway/diagnostics` trail 只有 09:53:26 的 `cli-register`/`cli-hello(relay-on)` 8 条、**零条 `cli-approval-request`**，即请求从未离开 CLI 进程。根因：回调注册原挂在 `sock.on('open')`、清空挂在 `sock.on('close')`，而 `useCanUseTool.tsx` 在**弹窗创建瞬间**对 `appState.replBridgePermissionCallbacks ?? getGatewayPermissionCallbacks()` 取快照，`interactiveHandler` 又是 `if (bridgeCallbacks && bridgeRequestId) sendRequest(...)` —— 断连窗口内回调为 null ⇒ 整条 bridge 分支被跳过，**连 `sendRequest` 都不调用** ⇒ 请求既不上报也不进 `pendingApprovalRequests`，之后任何重连补发都无据可依（与 08-31 的补发机制是同一条链上的两段）。修法：`permissionCallbacks` 提升为 `gatewayClient.ts` 模块级常量、**模块加载即 `setGatewayPermissionCallbacks(...)` 常驻注册**（闭包内改读模块级 `ws`，`sendResponse`/`cancelRequest` 用局部 `const sock = ws` 收窄），open/close 两处注册与清空全部删除。不变量：**「审批请求一旦产生，必入待发表」与 WS 连接状态彻底解耦**——断连期照常入表，重连由 open 的 `resendPendingApprovalRequests` 链送达；`interactiveHandler`/`useCanUseTool` 零改动、无兜底分支，状态源变少（消除「回调是否存在」这一第二状态）。验收：探针 `_agent-src/probe-approval-relay-resident.ts` 6/6（判据同步不依赖网络，`startGatewayProbeAndConnect` 未调用 ⇒ `ws` 恒 null）；修前对照 `git show HEAD:_agent-src/src/utils/gatewayClient.ts` 仅 open/close 两处、无顶层注册 ⇒ 判据必败。

## 9. web 重命名 → CLI 实时同步（2026-08-25）

网关 `/gateway/session/rename` 落盘后按会话精确路由 `{type:'rename',sessionId,title}` 给 `/clients` 注册的在线 CLI（`routeToClient`，未命中静默）；CLI 侧 `gatewayClient` 收到 → `controlOverrideHandle('rename')` → `GatewayControlBridge`：`applyExternalRename`（sessionStorage 新增，只更新 currentSessionTitle/currentSessionAgentName 内存缓存 + PID 注册表 name，不重复 append 文件，sessionId 不匹配忽略）+ `setAppState` 更新 `standaloneAgentContext.name`（输入栏 `─ name ─` 徽标即时更新）+ REPL 订阅 standaloneAgentContext（terminal tab title 即时重算，不再等下条消息）。rename 落盘格式 = 与 CLI /rename 同格式 append `custom-title`+`agent-name` 两条记录，**必须带 sessionId**——缺字段会被 `loadTranscriptFile`/`restoreSessionMetadata` 跳过，CLI resume 读旧标题且退出时 re-append 把旧标题写回 EOF 导致 web 列表也回退（2026-08-24 修复）。

## 10. web 插件/技能管理视图数据源（MGR，2026-08-15 起）

入口 = 管理视图三态之一 `/manage/plugins`（另有 projects/models），顶部「插件/技能」切换 + 个人/公开分类 + 搜索过滤，卡片网格渲染（app.js fetch `/gateway/plugins`，每类底部标「数据源：网关实时扫描」）。

网关端点 `GET /gateway/plugins`（`localGateway.ts` `listPlugins`，每次请求便携根实时扫描、无缓存）：
- 已安装插件 = `.claude/plugins/<name>/.claude-plugin/plugin.json`（跳过 `data`/`marketplaces`/隐藏目录）
- 已安装技能 = `.claude/skills/<name>/SKILL.md` frontmatter（name/description）
- 公开市场 = `.claude/plugins/marketplaces/*/.claude-plugin/marketplace.json` 的 `plugins[]`（名称含 "skill" 归技能类）
- 响应 `{workspace, plugins:{personal,public}, skills:{personal,public}}`，每项 `{n,d,v,inst}`；`inst=1` = 已安装（市场条目按已装集合打标，前端显「已安装」徽标），列表已安装置顶 + 字母序。

**定位 = 只读清单**（浏览/检索/已装标记）；装卸/启停/配置仍走 CLI `/plugin`（`ManagePlugins.tsx`），web 不做插件写操作。

## 11. `/clients` 下行控制消息路由（按会话精确转发给在线 CLI）

web 前端在 `/clients` WS 上行发控制帧，网关 `handleWsMessage` `switch (data.type)` 逐类处理；需要落到具体会话的走 `cliClients.get(sessionId)` 精确单发（未命中只回 `{type:'status'}` 提示，**不默认 resumeAndDeliver**——这类动作针对「正在运行的会话」，离线会话上做它没有意义；唯一例外是 `send`，它走 resume 全链）。当前成员：

| type | 语义 | 未在线时 |
| --- | --- | --- |
| `send` | 投递用户消息（可带 `images`）→ CLI `enqueue`（与本地打字同路径） | 暂存/`resumeAndDeliver` 恢复（§7） |
| `interrupt` | web 停止键 = CLI 一次 Ctrl+C（`onCancel` 全套） | status 提示 |
| `queue-nudge` | **排队消息催办（2026-09-10）**：点击排队气泡 → CLI 侧判活置位催办标记，`query.ts` 生成流就地断流、本轮中链 drain 把该消息纳入当前回合（不等于 interrupt：不改回合边界、不撤回、不产生新回合） | status 提示 |
| `shutdown` | 优雅退出该会话 CLI（exit 0 让 WT 自动收 tab，3s 后树杀兜底，§7） | status/树杀兜底 |
| `approve` | 审批/提问应答回路由（§8） | status 提示 |

CLI 侧接收口：`src/utils/gatewayClient.ts` 的 `msg.type` 分支 → 各 `bridge/*Handle.ts` 模块级句柄（REPL 挂载则生效，headless 无句柄静默忽略）。链路细节 → [web-ui.md](web-ui.md) §6/§13。

## 12. CLI 上行信号族（`/clients` WS，网关按会话镜像 + SSE 群发）

CLI（`src/utils/gatewayClient.ts`）主动上报的会话态信号经 `/clients` WS 送上网关，网关三类处置：**无状态转发**（原样 SSE 群发）、**按会话镜像 + 首载快照**（网关内存 Map + TTL + CLI `detach()` 清，`/gateway/session` 首次加载附全量，SSE 增量事件体直带全量快照供前端免拉）、**单调去重**（seq 账本）。

| 信号 | 处置 | 首载字段 | 备注 |
| --- | --- | --- | --- |
| `turn-state` / `turn-beat` | 无状态转发 | — | 回合开始/结束（打断收口持久信号之一）+ 150s 活性心跳（web 端审批接管在场时抑制红标，2026-09-11） |
| `stream-text` | 无状态转发 | — | 流式字符暂态（'' = 块边界/落盘/打断清除） |
| `restored` | 无状态转发 | — | 撤回链（文本回填输入栏） |
| `compact-state` | 无状态转发 | — | 压缩实时态起止（网关无状态，前端按 `live.compactFlags` Map + TTL 自管） |
| `queue-state` | 镜像 `sessionQueues`（TTL 10min） | `.queued` | CLI `subscribeToCommandQueue` 订阅 + 重连补发 |
| `task-state` | **镜像 `sessionTasks`（TTL 10min，2026-09-10）** | `.tasks` | CLI `useTasksV2.getSnapshot()` 单源上报 + 重连补发；形状边界 `normalizeGatewayTasks` 只此一处（非对象/缺 id/缺 subject 丢弃、未知 status→pending、subject 截 500、blockedBy 只留字符串） |
| `activity` | 镜像 `sessionActivity`（TTL 10min + REPL 60s 心跳） | `.state`（`/gateway/sessions` 列表） | 会话状态点判定兼需 `isPidAlive(act.pid)`（busy 绿/idle 红/waiting 橘/停止无点，§7 恒绿根修） |
| `session-delta` | 单调去重 `sessionDeltaSeq`（cli-hello 重置） | `.deltaSeq` | 展示增量（`{seq, anchorSid, messages}`），见 [web-ui.md](web-ui.md) §4 |
| `cli-hello` | 注册 `cliClients` + 复位 seq 水位 | — | 握手（带 `process.pid` 供网关补填真实 pid，§7） |

**新增信号的收编规范**：内容类通知优先并入 `session-delta` 流（web-ui.md §4 定案）；仅当信号语义不属于「展示序列内容」（如队列/任务清单/压缩态/活性）才单开一类，且一律照上表镜像三件套（Map + TTL + `detach()` 清 + `/gateway/session` 首载字段 + SSE 全量快照）落地。
