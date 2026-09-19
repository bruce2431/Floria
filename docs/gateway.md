# 内置网关服务层（gateway）

> 本文件属 `docs/` 文档库。
> 网关 = `src/gateway/localGateway.ts`（node:http + ws），随 `feature('PRIVATE_GATEWAY')`（默认开）编译进 exe；`/server on` detached spawn 自身 exe 以 `--gateway` 独立进程长驻，CLI 退出不影响网关。flag 审计 → [build.md](build.md)；web 界面链路定案 → [web-ui.md](web-ui.md)；术语 → [glossary.md](glossary.md)。改动本文件覆盖的任一链路时必须同步更新本文。

## 1. API 前缀与端点总览

网关全部端点挂 `/gateway/<端点>`（health/activate/shutdown/sessions/plugins/models/model/model-report/wsession[/stop]/diagnostics/session[/rename/.queued]/backend/project/file/image-cache/conversation/activity/upload/events），根 `/api` 撤空（旧路径不保留、无兼容双挂）——**不变量**：网关命名空间与 `/backend/<label>/` 代理页面共享同一 origin，端点若挂根，被代理页面写死的绝对路径会误打网关自身；迁移后被代理页面绝对路径写错只会 404，永不误伤网关；「故意打网关」的预览页显式用 `/gateway/*`。CLI 侧 `gatewayClient`/`conversationDisplay`/`server` 命令、前端 `app.js`/`sw.js`/`default-preview/default.js` 同此前缀。**唯一例外**：`readyPath` 缺省 `/api/system_stats` 是项目后端（ComfyUI）自身 API，不属网关前缀，勿迁移。总门鉴权 `startsWith('/gateway/')`（health/activate 公开例外不变），sw 缓存排除同步 `/gateway/`。

**文件上传 `/gateway/upload`**：`POST /gateway/upload?name=<文件名>&sid=<会话hash>|&project=<项目>`，body=原始字节（单文件上限 20MB，超限 413 复用 `readBodyWithLimit` 限流）。**落盘跟随会话**：sid 解码（`decodeSessionPath`，base64url 解回 `<启动根>/.claude/projects/<uuid>.jsonl`、强制限便携根内）剥 `.claude/projects` marker 得会话启动根 = 落盘根（全局笔=全局根、项目会话=项目根、桥接 CLI=其 cwd，与消息占位相对化 relPath 同根同源）→ `<该根>/uploads/<文件名>`；解码失败 → `sessionProjectRootOf` 磁盘扫描兜一层；新会话（首页首送前上传，尚无 sid）带 `project` → `webSessionProjectRoot` 同源解析（与 wsession 同语义，label 不命中回落全局根）；无任何会话上下文 → `getProjectRoot()`（exe 目录）。同名不覆盖 → `-1`/`-2` 序号；文件名 basename 化 + Windows 非法字符清洗（`\/:*?"<>|` 及控制符 → `_`）+ 保留名防护（CON/PRN/AUX/NUL/COM1-9/LPT1-9 加 `_` 前缀）+ 截断 120 字符。响应 `{ok, name, path:'uploads/<名>', abs:<绝对路径>, size}`；非超限错误走 `sendError` 500。前端入口 = + 浮窗「上传文件」行（docs/web-ui.md §23）。**文件占位相对化配套**：①wsession 响应附 `cwd`（=webSessionProjectRoot，与 spawnWebSession 的 spawn cwd 同源）——新会话 jsonl 未落盘，是首条消息文件占位相对化唯一 cwd 源；②`readSession` 记录缺失分支从 id 编码路径派生 cwd——新会话空 fetch 回调 `setSessionCwd(cwd)` 不再洗掉 wsession 带回值。

**安全加固**：HTTP 数据接口与 WS 升级一致要求 token——`/gateway/*`（除 `/gateway/health` 探活）与 `/preview/*` 一律校验，失败 401；CLI 侧上报（`conversationDisplay.ts`）经 `src/utils/gatewayToken.ts` 读取 token 附加；前端所有数据请求/EventSource/预览 iframe 带凭据（token 门锁定态不发请求、解锁后补拉）。

## 2. 认证：token 出 URL + cookie 票证 + 设备配对

**机制**：首链仍带 `?token=<hex>`（CLI `/server on` 打印的 localUrl/lanUrl 就是首链）→ 网关 `handleRequest` 开头 query token 命中即种 `floria_auth` HttpOnly cookie（Path=/、SameSite=Lax、1 年；票证 `randomBytes(24)` 落盘便携根 `.claude/gateway/tickets` JSON 数组，`gatewayToken.ts` 存取，上限 64 个）；此后 `/gateway/*`、`/preview/*` 与 WS 升级校验改「**query token 或 cookie 票证二选一**」——浏览器 URL 不再携带 token（`hideGate()` 清 query）。

**设备认证配对**：浏览器侧无 token 授权链，授权只走手动配对——①设备未授权 → 前端门显示**设备请求码**（8 位 hex，localStorage `floria-device-code` 持久、同设备恒定）；②PC `/server auth add <请求码>` 手动加入授权名单（票证=码本身，`.claude/gateway/tickets` {id,created} 数组落盘，上限 64）；③设备端门态每 2.5s 轮询 `GET /gateway/activate?code=`（公开端点，防枚举靠码熵；命中名单 → 种 HttpOnly floria_auth cookie 1 年）→ 自动 connect 进入门过渡动画。`/server auth` 列出设备、`auth off <n>` 撤销。**无任何 token 授权通道**：query token 仅剩 CLI 内部 gateway-token（上报/WS/关闭，不种 cookie）；/server on/status 不打印 token。

**设备匹配语义**：token 是钥匙、cookie 是每台设备自己记住的钥匙——token 轮换（`/server off` 清盘后再启换新）不影响已授权设备；`/server off` 清盘时同步清票证与 custom token（全设备掉线）。

**gateway/token 稳定密钥**：token 改「读盘-or-创建」——盘上有值即复用（`startLocalGateway` 与 `/server on` spawn 链同序：显式覆盖 > 读盘 > 随机），仅 `/server off` 清盘后才轮换；落盘时机在 **listen 成功回调**，不变量「盘上 token/port 恒描述现网关，只有端口持有者可发布」（否则多进程抢起网关时，bind 失败者会把败者 token 覆盖盘上胜者 token → 全部 CLI `/clients` 注册 401：侧栏无状态 / web 误 spawn resume / 消息悬空 / session-delta 断流会话退化折叠）。CLI 侧 `gatewayClient` 每轮探测重读盘上 token（3s TTL），盘/内存对齐后 ≤10s 自动重连，无需重启进程。

**前端门控**：`needToken()` 判据 =「`GATEWAY && !gateVerified`」（gateVerified 声明提前）；`initGateway` 统一先 `connect()`（cookie 有效 WS 直过 → `hideGate` 直进空态，无效 onclose 回 token 门）；门内输入 token 先 HTTP 预验证（种 cookie）再 connect；`apiUrl` 仍附加 gToken（空串附加无害，网关看 cookie）。

**访问地址（mDNS 自广播 `floria.local`，全设备免配置）**：同 WiFi/热点设备一律 `http://floria.local:<port>/`，换网络/换 IP 免配置免重授权（授权按设备码恒定）；**仅支持 Apple/Windows（`/server` 输出唯一地址不列 IP 直连；Android 浏览器 `.local` 解析差不在支持面）**。本机 hosts `127.0.0.1 floria.local` → 本机走 hosts、远程走 mDNS（floria.com 是公网真实注册域名，勿用作别名）。

**设备自报类型 hint**：iPadOS Safari 桌面模式 UA 与 macOS 全同（无 iPad 字样），网关按 UA 判设备恒显示 Mac——iPad 判定只能前端做（`navigator.platform==='MacIntel' && maxTouchPoints>1`，app.js `deviceHint()`），随 activate 轮询与 WS 连接 query `device=` 上报，网关记 `.claude/gateway/devices` 的 `hint`（`touchGatewayTicket` 第 4 参），`/server auth` 展示 hint 优先于 UA 判定（存量票证 WS 重连即补齐）。

## 3. 局网零配置 mDNS 应答器

`localGateway.ts` 手写最小应答器（~150 行，无新依赖；bun compile 下 dgram 多播 bind/addMembership/send 可用）：HTTP listen 成功且 host=`0.0.0.0` 时，UDP 5353 入多播组 224.0.0.251（逐局域网接口入组，WiFi/热点并存全覆盖），应答 `floria.local` 的 A/ANY 查询——A 记录实时读全部局域网 IPv4（过滤 169.254/198.18/100.64-127 虚拟段，TTL 300s，IP/网络变化自动跟随）；**应答双发：多播组 + 单播回源**（AP 的 IGMP snooping/多播抑制常丢多播回程，单播直达查询者；mDNS 应答幂等收两份无害）；5353 被占/入组失败静默放弃回落 IP 直连（自动路径禁抢端口）；`stopLocalGateway` 一并 `mdnsStop`。首次可能触发 Windows 防火墙 UDP 5353 入站放行提示（允许一次）。

**socket 绑定真实 LAN 地址**：监听 socket `bind(5353, mdnsLanAddrs()[0])` 而非 0.0.0.0——Windows「socket 绑定特定单播地址时多播默认出接口=该地址所属接口，压过 224.0.0.0/4 路由 metric」；Meta/Clash TUN（198.18.0.1，默认路由 metric 最小）在线时 bind 0.0.0.0 的多播应答整个被吸进隧道（查询入站正常、应答从未上 WLAN 空气）；bun 的 `setMulticastInterface` 在 Windows 无效（不抛错不生效），bind 具体地址实测有效；`mdnsHandleQuery` 另补 QR 位检查（无参 addMembership 落默认接口，自听回环应答会形成反馈循环）。无 LAN 地址回退 0.0.0.0。

**网络切换自愈**：bind/入组都是启动时按当时网卡定的，换网后旧 bind 地址失效 → 新网段查询收不到；`mdnsWatch` 每 30s 实时读网卡与 socket 集合 **diff 增量增删**（关消失接口的 socket、补新接口，`mdnsPendingBinds` 占位防 bind 异步期重复发起；增量化根因=热点 IP 每分钟抖动，集合不等即全量 stop/start 会把健康接口一起拆掉、服务网段出现无人应答窗口）；无地址（断网抖动瞬间）不动避免降级 0.0.0.0 被 TUN 吸走多播。

**单播 announce（吞多播网络的替代路径）**：iPhone 个人热点/AP 隔离网络吞 mDNS 多播——设备查询根本到不了 PC，「查询可达」前提不成立。补主动推送 `mdnsAnnounceOne`：对每个 LAN IP 的 socket 向同子网全部主机地址（`mdnsSubnetPeers` 枚举，排除网络/广播/自身；网段总地址数>512 跳过——校园网 /16 是 AP 隔离环境，单播同样不通）单播发送 announce（**legacy unicast response 格式：header QR=1 AA=1 ID=0/QD=1/AN=1 + floria.local A IN 问题段 + 0xc00c 压缩指针 A 记录、TTL 300s、目的端口 5353；CLASS=0x0001，RFC 6762 §18.11 单播应答禁 cache-flush 位 0x8001**——iOS 严格实现会拒收，新鲜度靠重发；纯 answer 无问题段版属 unsolicited，**iPad mDNSResponder 实测无视**；带问题段走 mDNSResponder 常规应答通道=商用 mDNS 网关同款做法）。触发四路：socket bind 成功 **3 连发（0s/1s/2s，RFC 6762 §8.3 announce 连发 ≥2 次语义）**、60s 周期单发（TTL 之半无断档）、watch 网络切换重建后新 socket bind 即推、**收到任一 mDNS 查询即对该源单播回推一份**（30s/源节流表 `mdnsAnnounceSeen`，含 _companion-link 等系统查询——覆盖设备亮屏/入网瞬间先发系统查询的黄金窗口）。**定向 announce 推送（直连客户端自愈闭环）**：AP 隔离网络下设备与 PC 单播互通但查询到不了 PC，全网枚举推因 >512 跳过、查询回推又收不到查询，推送链路闲置——`mdnsPushToReachableClient`：handleRequest 每请求取 remoteAddress（归一化 IPv4/滤回环/`mdnsSameSubnet` 同网段判定），命中即向该客户端**定向单播推 legacy announce 3 连发**（30s/IP 节流与查询回推共用 `mdnsAnnounceSeen`），iPad 直连一次即建立 floria.local 解析（直连一次→域名永通）；全网枚举推 >512 跳过保留，定向推不受限。**取证日志**：收到 mDNS 查询落盘「mDNS 查询到达：IP:port（QD=n）」+节流内「单播回推 announce → IP」（gateway.log）。

**概率性失败三缺陷根修（现行实现已含）**：「IP 直连一直能连、floria.local 概率性打不开」的三个确定性缺陷已全部打根因，探针 `20260916212639-mDNS域名概率性失败根修/mdns-packet-probe.ts`（模拟 iOS 打包查询：QD=2、floria.local 不在首位、名字用压缩指针）可复验：
① **应答问题段被压缩指针污染（主根因）**：旧版把匹配问题的原始字节复制进应答，而 iOS QD=2 打包查询里 floria.local（常不在首位）名字多用压缩指针指向包内别处——指针复制到新包后指向错位，设备端解出的问题名退化 → 整个应答被丢弃 → 设备重试 = 宏观「概率性」。修：问题段一律以 `MDNS_NAME_ENC` **内联全名重编码**（A 记录构造统一走 `mdnsAddrRecord`），绝不复制原字节；QU 位按 §5.4 清除。
② **legacy 查询未回显 ID**：源端口 ≠5353 的查询（Windows/Node 等解析器）按 RFC 6762 §6.7 必须回显查询 ID，恒写 0 会被丢弃；现按源端口区分（5353 → ID=0，legacy → 回显查询 ID）。
③ **缺多播 announce 保活**：单播 announce 本质是 unsolicited unicast response，mDNSResponder 对「无匹配 outstanding query」的单播包多数直接丢弃 → 设备 TTL 到期后必须重新查询（5353 被 msedge×2 + svchost(DNS Client) 多进程复用，Windows 不做 UDP 端口复用分发、AP 多播抑制）。补 RFC 6762 §8.3 **多播 announce**（`mdnsMulticastAnnouncePacket`：QD=0 + 内联全名 + class 0x8001 cache-flush），60s 周期推送使设备缓存永不过期；单播枚举路径保留——那是吞多播热点/AP 网络的替代路径（拓扑适配），非冗余兜底。**TTL 300s**：配合 60s 保活，正常网络下设备不再重查询；IP 变化时旧缓存最多多留几分钟，由 30s watch 重绑 + 保活新地址覆盖。

**实测结论与判定口径**：iPhone 热点下设备经 `floria.local` 直连可用（换网自愈：接口变化→重绑→重新公告，网关进程全程未重启）；网关日志「mDNS 定向推（直连客户端 X）」行即域名解析与 TCP 全通。**客户端隔离网络（BIT 校园网 bit-web 型）的定性口径**：ping 网关通 + ARP 邻居多 ≠ 单播可达（ICMP 常被设备防火墙丢弃）；判定 = 网关日志有无「mDNS 定向推（直连客户端 X）」行 + `netstat` 8124 有无非回环连接——两者皆零即「包没到 PC」，直接跳网络层，勿在网关/域名里绕。

## 4. 项目预览页机制

点管理视图项目胶囊一律进预览（`openProjectPreview(label, hasPreview)`）——若该项目 `<工作区根>/<项目>/.claude/preview/` 存在（`findProjects` 探测 `hasPreview`，`/gateway/sessions` 会话附 `preview` 标志），在消息区渲染 iframe 加载网关静态路由 `GET /preview/<项目>/*`（默认 index.html，label 须命中 findProjects 且 hasPreview、resolve 须落在 preview 目录内防越界）；无预览内返回按钮——退出预览全靠侧栏导航，`route()` 每次导航统一清 `__backendHeartbeat`；**无预览或真预览 404 → 加载内置默认项目主页**（GitHub 仓库风格 `GET /default-preview/<项目>/*`，内嵌资源 `web/default-preview/`，数据来自 `GET /gateway/project?label=`：文件树/README/会话，会话点击 postMessage `floria-open-session` 通知父级跳会话）。真预览页由项目自己维护（自包含静态网页，可带相对 css/js），网关只做静态托管；默认主页是网关内置兜底。**label decode 防护**：`/preview/<label>` 与 `/default-preview/<label>` 的 `decodeURIComponent` 必须包 try-catch（decode 失败保留原文 → 404 兜底）——畸形 % 序列（如 `%ZZ`）未捕获 URIError 会崩掉整个网关进程（default-preview 免鉴权公开可达，任意设备单个请求即可触发）；新增同类路由时 decode 一律照 `/backend` 同款防护。

## 5. 远程宿主同源反代 /backend/<label>/

**动机**：iframe 直连 `http://127.0.0.1:<port>/` 只在本机浏览器成立——手机/平板等远程宿主上 127.0.0.1 指向设备自身 → 连接拒绝、预览覆盖层永转圈；`/preview/*` 静态兜底因子资源不带 query token 全 401，不可用。

- **路由**：`/backend/<label>/<path>?<query>` → `http://127.0.0.1:<port>/<path>?<query>`。rest/search 原样透传（保留原始 %xx 编码，不二次解码重组，防中文路径双重编码错乱）；`proxyBackendRequest` 双向流式管道（媒体大文件不落盘），请求侧剥 hop-by-hop + host + cookie（不向项目后端泄露 floria_bp 票证），响应侧剥 hop-by-hop + 上游 set-cookie（防作用域泄漏），Location 改写回 `/backend` 前缀。后端仍只绑回环，访问面不变。（旧 /bp/ 保留解析兼容不再生成。）
- **鉴权**：不靠 query token（页面内相对子请求必裸奔）。`/gateway/backend` 成功响应种 `HttpOnly` cookie `floria_bp`（Path=/backend、SameSite=Lax、24h）；票证存网关内存 Map（含 label 白名单，多项目并行预览互不顶掉，sweep 过期）。`/backend/*` 凭 cookie + 白名单放行，否则 401；label 须命中 findProjects 且 hasBackend，否则 404。
- **前端分流**：`openProjectPreview` 按 `location.hostname ∉ {127.0.0.1, localhost}` 判远程宿主 → iframe 用 `/backend/<label>/`（cookie 由上一拍 `/gateway/backend` 响应种下，子请求自动携带）；本机保持直连零开销。心跳 60s `GET /gateway/backend` 不变（保 lastActive + 续票证）。
- **配套约束**：**经 /backend 代理的项目前端 API 一律相对路径**（根绝对路径 `/delete` 等在 /backend 前缀下会指回网关根 404）。

**断连联动收尸**：`proxyBackendRequest` 四道防线——①req 'aborted'/'close'(complete===false) → destroy 上游；②res 'close'（响应中途 writableEnded=false）→ destroy 上游；③上游 socket 180s 静默超时（按静默计非总时长）→ 504；④异常路径落请求级取证日志 `/backend <label><path> 转发中止: <原因>`（gateway.log）。只监听 'error' 不够——隧道抖动/刷新页只触发 'aborted'/'close' 不触发 'error'，pipe 不传播断开 → 上游 socket 永挂 → 后端线程在 `rfile.read` 永久阻塞（僵尸连接还是网关空闲自旋烧 CPU 的燃料）。配套 server 侧 `connection` 对 'end'（对端 FIN）回应 FIN——CLOSE_WAIT 不再积压。

**上传串行队列**：`proxyBackendRequest` 对 POST/PUT/PATCH（带 body）按 backend label 走 `bpForwardQueues` 串行队列逐个转发、GET/HEAD 直通（媒体大文件下载不走队列）——并发带 body 请求经 Bun node:http 兼容层 pipe 泵会卡死（同一请求多次重试全 400、降级串行后全 200）；转发中止取证日志带 aborted/close 来源区分与已收/声明字节数，upReq 创建推迟到轮到转发时。

## 6. Web 容器后端进程标准（preview.json backend）

> 预览页不止静态 HTML——项目 `.claude/preview/preview.json` 声明 `backend` 字段 → 网关懒加载 **spawn 后端进程**、前端 iframe **直连后端端口**（仿 Hugging Face Spaces）。实例：Pj14-AI动画制作 官方 ComfyUI 前端 + 真实 ComfyUI 后端。

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
- `cwd`：相对 preview.json 所在目录。
- `port`：`0` = 网关从 8130 起探测顺延（上限 8160）；显式端口则固定。
- `idleMinutes`：后端无活跃持续该时长被空闲回收（默认继承 `GATEWAY_IDLE_MINUTES`=10 分钟）。
- `readyPath`：就绪探测路径（默认 `/api/system_stats`，项目后端自身 API，非网关前缀）。

### 6.2 网关机制（localGateway.ts）

- `findProjects` 读 `<项目>/.claude/preview/preview.json`，有 `backend` → 项目附 `hasBackend` + `backendCfg`。
- `GET /gateway/backend?label=`（受 token 保护）：ensureBackend（未起则 spawn）→ `{url, port, pid}`；无 backend → 404。
- spawn：`{port}` 替换 → cmd[0] resolve 到 cwd → `spawn`（env 加 PORT，日志落盘 **该项目自己的** `<项目>/.claude/preview/backend.log`，5MB 截断轮转）；就绪探测窗口 120×200ms（容忍 ~22s 冷启动）。
- **就绪探测用原生 net socket**（`backendReady`）：编译产物 node:http 的 request 对 aiohttp/Python 后端会挂起，net 直连写 HTTP 头读响应状态（200/404 即就绪）。
- 生命周期：`stopLocalGateway` 遍历 killAllBackends（child.kill + taskkill /F /T /PID 兜底）+ 停回收 timer；空闲回收每 60s（仅 `--gateway` 模式）。
- 前端三级加载：① `/gateway/backend` 命中 → iframe 直连 + 60s 心跳防误回收；② 静态 preview；③ 默认项目主页兜底。

### 6.3 后端进程生命周期解耦

**后端进程不随网关关停**：`/server off/restart`、空闲自动退出、网关被硬杀均不 kill 后端——注册表落盘 `.claude/gateway/backends.json`（label→{pid,port,startedAt}），网关重启后 `ensureBackend` 按注册表**收养**存活进程（isPidAlive + readyPath 就绪即接管，child=null 走 pid 判活/killTree）；后端仅由空闲回收（idleMinutes，缺省 30min，预览页 60s 心跳保活）与用户手动关闭管理。`/gateway/backend` 响应带 `alreadyRunning`（进程已在册存活）→ 前端不渲染「正在启动」覆盖层，iframe 直挂秒开，仅冷启动显示。**不变量**：网关 stop 一律 killAllBackends 会造成每次重启后端冷启动、网关硬杀来不及 kill 造成后端孤儿占端口（下次 spawn 端口漂移）——两者都由本解耦消除。

### 6.4 安全

- 后端只监听 `127.0.0.1`（ComfyUI `--listen` 默认）；后端 URL 获取须过网关 token（`/gateway/backend` 属 `/gateway/*` 自动受保护）。
- 后端文件写路径由后端自身约束（如 ComfyUI `--input-directory`/`--output-directory`），粘贴图片落到项目内目录。

## 7. web 独立会话进程链

web 独立会话 = 本地可见交互 REPL 窗口（`/clients` 注册，不再 headless 管道），与普通 CLI 同路径、同样可被远程审批。**会话落盘按来源定案**：「笔」新建（无 project）→ 全局根 `@WrokSpace/.claude/projects/`（projectScope:'global'）；「项目 +」新建（有 project）→ 该项目根 `.claude/projects/`；不落 Pj16 项目根。落盘位置与 exe 来源无关（cwd 由 `webSessionProjectRoot` 路由）。

**弹窗行为：启动链脱离默认终端委托（defterm），网关直调 `wt.exe -w last nt`**：spawn 不带任何 `-WindowStyle`（实测 `-WindowStyle Minimized`=WT 拒绝托管→回落独立 conhost 老式黑窗；`-WindowStyle Hidden`=进程启动注册但窗口完全不可见；只有无 flag 才并入 WT，代价=并入时新标签激活 WT 窗口可能抢焦点）；不再信任 defterm（25H2 更新弄坏 defterm 激活链且委托键屡遭系统更新重置），四件配套：①`spawnWebSession` 改 `spawn('wt.exe', ['-w','last','nt','-d',cwd,exe,...args])` 直并最近 WT 窗口（无窗自动开新窗），行为不随 defterm 配置漂移；②CLI 入口自检护栏（cli.tsx main 顶部）——交互式 TTY 且无 `WT_SESSION` 且未自举过（`FLORIA_IN_WT`）且非 bun 源码直跑 → 同样 wt 直并后本进程退出（双击 exe 防 conhost 黑窗；wt 不可用留宿主运行），护栏不变量=每交互进程至多自举一次（WT 正常标签自带 `WT_SESSION`，VSCode 等自带宿主终端不接管）；③真实 CLI pid 改由 cli-hello 上报补填（wt 自身即退拿不到 pid：gatewayClient 握手带 process.pid，网关 spawn 在途经 `cliHelloPids` 暂存、注册成功取走填入 webSessions；WebSessionProc.child 字段删除，stopWebSession 只用 p.pid）；④网关启动端口落盘 `.claude/gateway/port`（gatewayToken.ts 三件套 save/load/clear，TTL 3s）——并入已存在 WT 窗口时新标签继承旧 WT 进程环境，env 传不到 CLI 子进程，`baseUrl()` env 缺失时读盘发现再回退 8124。spawn 失败判定：wt exit 非 0 且未注册即 reject（无中转进程可杀），注册超时 20s。**spawn 链两处（spawnWebSession + cli.tsx main 自举块）不得带 `windowsHide: true`**——SW_HIDE 随 STARTUPINFO 被无窗时新开的 WindowsTerminal.exe 继承=首窗创建即隐藏、父进程即退，二次启动命中已存窗才可见（「启动两次」现象）；wt.exe 是 GUI 子系统，spawn 它不会带出控制台黑窗，无窗可防。

**发送即 resume（会话打开预览/发送才恢复窗口）**：点开 web 会话不再自动 resume（与 CLI 会话一致仅预览；进程停止时列表状态点由常驻红改透明无点——任何会话仅进程在跑时 busy 绿点、否则 null）；会话进程未在线时**发送消息才恢复**——网关 `handleWsMessage 'send'` 对 `cliClients` 未命中且非启动中的会话走 `resumeAndDeliver`（**web 与 CLI 一视同仁**：`sessionProjectRootOf(sessionId)` 按磁盘 `<项目根>/.claude/projects/<id>.jsonl` 定位项目/全局根 → 复用 `spawnWebSession --resume` 按定位项目选 cwd，注册完成后再经 `cliClients` 注入消息；同一会话 resume 在途复用同一 promise 防双 spawn 双写 jsonl；会话文件不在磁盘 → 拒绝「目标会话未在线」）。

**账面活性统一判定（`webSessionEntryAlive`）**：账面记录命中「存续」判定时，必有活进程或其活跃连接可承接消息——pid 已知 → isPidAlive；pid 空 → cliClients WS 在即进程在。三处一判：①send 暂存分支按真实活性判定，死记录落空走 resumeAndDeliver 恢复（否则 pid 空残留记录会挡住恢复路径：消息进 `pendingDeliveries` 暂存后无任何进程被拉起，web 恒显「无响应」且暂存零反馈）；spawn 在途常态不弹回执，活进程断连重连间隙暂存回 status「会话连接恢复中，消息已暂存，CLI 重连后自动补投」；②`spawnWebSession` 幂等复用前验活，死记录清理后走正常 spawn（活进程重连窗口由 cliRegisterAt 近期痕迹保护兜住，无双写）；③`reclaimIdleWebSessions` 判活统一走同函数，pid 空孤儿注册 60s 步进可清。

**`spawningPromises` settle 即清**：`const tracked = p.finally(() => { spawningPromises.delete(sid) })` + `.set(sid, tracked)` + `return tracked`——不变量「`spawningPromises` 里的条目恒为真在途、未 settle 的 spawn」（表即真值源）。只 set 不 delete 会让幂等短路恒命中旧 promise（该 sid 再也 spawn 不起来）且 send 路由恒判在途（消息全落 pendingDeliveries 等一个永不再来的注册）。

**WS 心跳回收僵尸连接**：`HEARTBEAT_INTERVAL_MS=30_000` + `HEARTBEAT_MAX_MISS=2`（≈60s 判死）+ `wsMisses: WeakMap`；`markAlive(ws)` 接在 `wss.on('connection')` 与 `/clients` upgrade 回调两处；`startSocketHeartbeat()` 遍历 `[...sockets, ...cliClients.values()]`，非 OPEN 跳过、misses ≥ MAX 则 `terminate()`（→ close → `detach` 清 `cliClients` + 3s 复核窗），否则 misses+1 且 `ping()`；`unref()` 不阻进程退出；`stopSocketHeartbeat()` 在 `stopLocalGateway` 内调用。不变量「sockets/cliClients 里的连接恒为最近一个心跳窗内可应答的活连接」（无心跳时半开死链 `cliClients.has(sid)` 恒 true，给账面判活喂错判据）。

**防双进程 + web 会话 exe 一律用网关自身**：`webSessionExe` = `process.execPath`（协议必然匹配；目录扫描旧版 exe 会探测旧端点 404 → 永不注册 → wsession 超时）；`spawnWebSession` resume 前查 `cliRegisterAt`（/clients 注册时间戳 Map，CLI_RECENT_REGISTER_MS=10s）：近期有痕迹 = 活进程断连重连中 → 复用 resolve 不 spawn（否则与重连中的原进程形成同会话双进程：网关对重复注册 `prev.close()` → 每秒互踢乒乓、消息路由 50% miss、审批回调每秒清、双写 jsonl，永不自愈）；`resumeAndDeliver` 注入改 400ms×5s 轮询等重连进程回来再注入。取证日志：重复注册顶替落日志、`spawnWebSession` 全程日志（spawn 开始含 exe/cwd / 注册成功含耗时 / 注册超时）、网关日志逐行时间戳（`stampGatewayConsole` 在 startLocalGateway 劫持 console，仅 --gateway 独立进程）。

**网关关停不杀 web 会话窗口 + pid 注册表收养**：**web 会话与普通 CLI 会话同等权重，网关 off/restart/空闲退出/SIGINT 一律不杀存活窗口**（gatewayClient 自动重连新网关；与 backend 生命周期解耦同构；否则 `/server restart` 会把正在执行 restart 的那个会话自己杀掉，restart 断在半路）。代价是重启后内存 `webSessions` 丢失 → resume 幂等失效，故有**运行 pid 注册表落盘** `.claude/gateway/websessions.json`（`[{sessionId,pid,startedAt}]`，变更即写防 kill -9 留脏；`persistWebSessions` 在 set/各 delete 点调用），网关启动 `adoptWebSessions()` 读表收养 isPidAlive 的条目（无 child 仅凭 pid 判活/killTree，同 backend 收养先例）。**与旧 web-sessions.json 区别**：旧表是「web 创建来源标记」（已由磁盘定位取代，勿复辟）；本表是「运行进程 pid 表」（生命周期管理用，与 backends.json 同构）。`stopWebSession`（taskkill 窗口）仅剩显式关闭单会话端点与超时清理使用，网关关停路径不得调用。

**SSE 关停显式 end()**：`stopLocalGateway` 里 WS 被显式 `close()` → 页面自动重连成功；但 HTTP `server.close()` **只停止接受新连接、不断开既有连接**，`sseClients.clear()` 只清引用——浏览器 EventSource 收不到 TCP FIN → `onerror` 永不触发 → 前端永不重连 → 僵尸 ES 收不到 updated/session-delta/stream-text，消息区实时链静默死亡。修复 = 关停时对 `sseClients` 逐个显式 `c.res.end()` 再清集合：客户端收到流结束 → onerror → 3s 后 `initLive` 重连新网关 → hello → `refreshSession` 全量对账，旧页面**不刷新自动恢复**（与 WS 侧显式 close → 自动重连完全对称，不加状态源）。

**状态点链路**：REPL `sendSessionActivity` 上报 → 网关 `sessionActivity` 内存 Map → `/gateway/sessions` 附 `state` → 侧栏着色。三件套保证不丢点：①REPL 上报 useEffect 带 60s 心跳（网关 `ACTIVITY_TTL_MS=10min` 清扫后点不消失）；②前端 `refreshList` 签名 `listSigOf()` 纳入各会话 state 拼串（状态翻转必触发重渲染）；③`/gateway/activity` 收报即向 sseClients 群发轻量 `{type:'activity',session,state}`，前端 `refreshList()`（只刷列表不刷会话区）。语义：waiting 独立橘点 `.st-ask #f59e0b`（等待用户）· busy 绿（运行中）· idle 红（暂停/已完成）· 无（进程退出/未打开）；网关重启后已开 CLI 靠首个心跳（≤60s）恢复点。

## 8. web 审批双操作中继（web 与 CLI 均可操作同一会话）

CLI 交互权限弹窗接网关中继——`src/bridge/gatewayPermissionRelay.ts`（模块级 set/get 回调）+ `src/utils/gatewayClient.ts`（`/clients` WS 上行 `approval-request`/`approval-local-resolved`/`approval-cancel`、下行 `approval-response`/`approval-cancel`）+ `src/hooks/useCanUseTool.tsx`（非 BRIDGE_MODE 时 `bridgeCallbacks` 改读网关回调）→ 本地终端弹窗与 floria 审批卡**竞速（claim），先操作者生效**、另一端自动收起；网关 `/clients` 增 message 监听（审批请求→broadcast `{type:'approval'}` 卡片、本地已决→broadcast `{type:'approval-dismiss'}` 撤卡），`handleWsMessage` `'approve'` 路由 `cliClients` 回 `approval-response`（allow 带 `updatedInput:{}`、deny 带 message）；前端 app.js 处理 `approval-dismiss` 撤卡。

**floria 亦可答复提问**：AskUserQuestion 走同一中继——前端 `renderQuestionApproval` 渲染逐题单选交互表单，`sendApprove` 带 `{input, answers}`，网关 approve 路由对 `data.answers` 生成 `updatedInput={questions:数组, answers}`（questions 取数组本体勿嵌套），CLI 交互应答 `buildAllow(updatedInput)` 拿到 answers 执行工具。

**审批中继常驻化（现状）**：`permissionCallbacks` 为 `gatewayClient.ts` 模块级常量、**模块加载即 `setGatewayPermissionCallbacks(...)` 常驻注册**（open/close 两处注册与清空全部删除）。不变量：**「审批请求一旦产生，必入待发表」与 WS 连接状态彻底解耦**——若回调挂在 `sock.on('open')`，断连窗口内回调为 null，弹窗创建瞬间取快照拿到 null ⇒ 整条 bridge 分支被跳过、`sendRequest` 都不调用，请求既不上报也不进 `pendingApprovalRequests`，之后任何重连补发都无据可依。探针 `probes/probe-approval-relay-resident.ts` 6/6。

**审批确认送达后才关卡**：CLI 消费 `approval-response` 后回执 `approval-processed`（仅本地消费才发，竞速输不发）→ 网关转发 `approval-confirmed`（session_id+requestId）、approve 路由 else 分支回 `approval-rejected` → 前端 `sendApprove` 不再立即清卡，设 `approvalPending` 等待确认（8s 超时 + 断连 `showApprovalError` 保留卡片+重试）；`approval-dismiss` 撤卡清理 pending。

**pending 跨网关重启补发**：①模块级 `pendingApprovalRequests` 补发表——`sendRequest` 记入，`sendResponse`/`cancelRequest`/`approval-response` 消费（含 handler miss 死请求）/`onResponse` 退订（abort 清理路径）逐点移除；②WS `open`（含重连）`resendPendingApprovalRequests` 逐条重发 → 走网关现有暂存+broadcast 链路（网关零改动），web 先订阅收 broadcast、后订阅收重放，两序均补弹可交互卡；③`pendingResponses` 应答表提升模块级跨重连保留 + close 处 `clear()` 删除（原断开即清会杀掉重启前挂起弹窗的 handler），作答经新连接仍命中 handler 唤醒重启前弹窗。

**调试**：`GET /gateway/diagnostics`（token 保护）返回审批轨迹 + cliClients/sockets/webSessions 概览。`cliClients` 有会话但 trail 无 `cli-approval-request` 有两类含义：①该 CLI 是**旧 exe**（常驻化之前，回调只在连接建立期存在）；②CLI 为新 exe 但弹窗仍在网关断连窗口内出现（常驻化后此类已可自愈：请求照常入 `pendingApprovalRequests`，重连即补发）。判据：查 trail 是否只有 `cli-register`/`cli-hello` 而无后续审批事件，并比对该进程的 exe 时间戳（`Get-CimInstance Win32_Process` 看 CommandLine）。

## 9. web 重命名 → CLI 实时同步

网关 `/gateway/session/rename` 落盘后按会话精确路由 `{type:'rename',sessionId,title}` 给 `/clients` 注册的在线 CLI（`routeToClient`，未命中静默）；CLI 侧 `gatewayClient` 收到 → `controlOverrideHandle('rename')` → `GatewayControlBridge`：`applyExternalRename`（sessionStorage 新增，只更新 currentSessionTitle/currentSessionAgentName 内存缓存 + PID 注册表 name，不重复 append 文件，sessionId 不匹配忽略）+ `setAppState` 更新 `standaloneAgentContext.name`（输入栏 `─ name ─` 徽标即时更新）+ REPL 订阅 standaloneAgentContext（terminal tab title 即时重算）。rename 落盘格式 = 与 CLI /rename 同格式 append `custom-title`+`agent-name` 两条记录，**必须带 sessionId**——缺字段会被 `loadTranscriptFile`/`restoreSessionMetadata` 跳过，CLI resume 读旧标题且退出时 re-append 把旧标题写回 EOF 导致 web 列表也回退。

## 10. web 插件/技能管理视图数据源（MGR）

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
| `queue-nudge` | **排队消息催办**：点击排队气泡 → CLI 侧判活置位催办标记，`query.ts` 生成流就地断流、本轮中链 drain 把该消息纳入当前回合（不等于 interrupt：不改回合边界、不撤回、不产生新回合） | status 提示 |
| `shutdown` | 优雅退出该会话 CLI（exit 0 让 WT 自动收 tab，3s 后树杀兜底，§7） | status/树杀兜底 |
| `approve` | 审批/提问应答回路由（§8） | status 提示 |

CLI 侧接收口：`src/utils/gatewayClient.ts` 的 `msg.type` 分支 → 各 `bridge/*Handle.ts` 模块级句柄（REPL 挂载则生效，headless 无句柄静默忽略）。链路细节 → [web-ui.md](web-ui.md) §6/§13。

## 12. CLI 上行信号族（`/clients` WS，网关按会话镜像 + SSE 群发）

CLI（`src/utils/gatewayClient.ts`）主动上报的会话态信号经 `/clients` WS 送上网关，网关三类处置：**无状态转发**（原样 SSE 群发）、**按会话镜像 + 首载快照**（网关内存 Map + CLI `detach()` 清 + 重连 open 补发，`/gateway/session` 首次加载附全量，SSE 增量事件体直带全量快照供前端免拉；是否配时间 TTL 见下表——CLI 上行是事件驱动/去重后的快照，**载荷不变不发的镜像表禁配时间 TTL**）、**单调去重**（seq 账本）。

| 信号 | 处置 | 首载字段 | 备注 |
| --- | --- | --- | --- |
| `turn-state` / `turn-beat` | 无状态转发 | — | 回合开始/结束（打断收口持久信号之一）+ 150s 活性心跳（web 端审批接管在场时抑制红标） |
| `stream-text` | 无状态转发 | — | 流式字符暂态（'' = 块边界/落盘/打断清除） |
| `restored` | 无状态转发 | — | 撤回链（文本回填输入栏） |
| `compact-state` | 无状态转发 | — | 压缩实时态起止（网关无状态，前端按 `live.compactFlags` Map + TTL 自管） |
| `queue-state` | 镜像 `sessionQueues`（无时间 TTL） | `.queued` | CLI `subscribeToCommandQueue` 订阅 + 重连补发；**每项可带 `from:{title,sid?}`（会话间通信来源）**——CLI 上报前已 `parseSessionMessage` 剥壳，网关只做形状边界白名单（title ≤200、可选 sid ≤200），见 §13 |
| `task-state` | **镜像 `sessionTasks`（无时间 TTL）** | `.tasks` | CLI `useTasksV2.getSnapshot()` 单源上报 + 重连补发；形状边界 `normalizeGatewayTasks` 只此一处（非对象/缺 id/缺 subject 丢弃、未知 status→pending、subject 截 500、blockedBy 只留字符串）。生命周期=upsert + detach 清 + 重连补发（时间 TTL 与「载荷不变不发」矛盾——活跃会话清单 10 分钟不变即被清仓 → web 浮窗消失） |
| `activity` | 镜像 `sessionActivity`（TTL 10min + REPL 60s 心跳） | `.state`（`/gateway/sessions` 列表） | 会话状态点判定兼需 `isPidAlive(act.pid)`（busy 绿/idle 红/waiting 橘/停止无点） |
| `session-delta` | 单调去重 `sessionDeltaSeq`（cli-hello 重置） | `.deltaSeq` | 展示增量（`{seq, anchorSid, messages}`），见 [web-ui.md](web-ui.md) §4 |
| `cli-hello` | 注册 `cliClients` + 复位 seq 水位 | — | 握手（带 `process.pid` 供网关补填真实 pid，§7） |

**新增信号的收编规范**：内容类通知优先并入 `session-delta` 流（web-ui.md §4 定案）；仅当信号语义不属于「展示序列内容」（如队列/任务清单/压缩态/活性）才单开一类，且一律照上表镜像三件套（Map + `detach()` 清 + 重连 open 补发 + `/gateway/session` 首载字段 + SSE 全量快照）落地。时间 TTL 只配给上行端有心跳/持续重报语义的镜像（activity/display/model）；载荷不变不发的快照表（queue/task）**禁配时间 TTL**。

## 13. 会话间通信：`session-message` 上行→跨会话投递（`SESSION_LINK`）

**这是目前唯一的 CLI→网关→另一 CLI 的端到端消息路径**（其余 `/clients` 帧都是「web ↔ 某一个 CLI」或纯上行信号）。链路：

```
会话 A 的 CLI ──上行 /clients {type:'session-message', requestId, toSid, text, from}──► 网关
                                                                                      │ 纯 sid 路由（不解析标题）
                                                                                      ▼
                                                         deliverToSession(toSid, {type:'session-message', text, from})
                                                          ├─ cliClients.get(toSid) 在线 ──► 直投
                                                          ├─ spawningPromises.has ────────► pendingDeliveries 暂存
                                                          │                                  （/clients 注册钩子 flushPendingDeliveries 补投）
                                                          └─ 离线/从未 spawn ─────────────► resumeAndDeliver（定位项目根 → spawn --resume
                                                                                             → 400ms×5s 轮询 tryInject）
会话 B 的 CLI ◄── 下行 {type:'session-message', text, from} ──► enqueue(wrapSessionMessage(from, text), mode:'prompt',
                                                                 skipSlashCommands:true)  ← 与本地打字同队列同分叉
回执：{type:'session-message-result', requestId, ok, error?}
```

**职责分界（定案）**：

| 侧 | 职责 |
|---|---|
| CLI（发送方） | 标题/sid → sid 解析（`utils/sessionAddressing.ts` + `GET /gateway/sessions`），**寻址在转录所在的那一侧完成**；无授权门——目录内任何会话可发 |
| 网关 | **纯 sid 路由**：形状校验（空 `toSid`/空文本/**自发自收** → 回执错误）、三岔投递、回执。**不做标题匹配、无标题索引** |

**`deliverToSession(sessionId, frame, fb)` 是统一三岔口**（发送方与 web `send` 共用同一投递语义）；`DeliveryFeedback` 三态 `staged`/`resuming`/`done`，只有 `done` 回执——前两态由发送侧 20s 超时兜底（`SESSION_MESSAGE_TIMEOUT_MS`）。

**为什么单独开 `session-message` 帧而不复用 `send`**：`send` 帧无 `from` 字段，而来源要一路带到接收侧转录（模型可见，见 [core.md](core.md)）。

**离线拉起沿用既有行为**：不新增信号源——`resumeAndDeliver` 就是 web `send` 那条路径（§7「发送即 resume」），仅复用。风险（拉起产生意外副作用）已定案允可。

**回环**：**网关不做代码级刹车**——靠 `@WrokSpace/.claude/CLAUDE.md` 的「非必要不通信」约束。唯一硬边界是「自发自收」直接拒。

**相关端点**：`GET /gateway/sessions` 返回 `{file, title, state?}[]`，CLI 侧 `fetchSessionDirectory()` 取 `file` 去掉 `.jsonl` 作为 sid（与 web 消息路由的 `hashOf(s)` 同键）、`title` 空则记「未命名会话」。

## 14. 神经元可视化数据端点（`/gateway/neurons[/graph]`，只读）

web「神经」tab（[web-ui.md](web-ui.md) §26）的两个只读数据源，实现于 `src/gateway/neuronViz.ts`，`localGateway.ts` 注册在 `/gateway/models` 之后，token/cookie 鉴权同其它 `/gateway/*`。

| 端点 | 返回 | 说明 |
|---|---|---|
| `GET /gateway/neurons` | `{neurons: [{id,name,type,description,mem_count,cog_count,community_count,last_updated}]}` | 层级1 清单卡片；`listNeuronsInRoots()` 多根扫描（roots 由 `gatewayNeuronRoots()` 组装：cwd 根 → 各项目根 `.claude/neturon`（跳 `.` 目录与根级临时任务目录，目录存在才入列）→ 全局根，同 id keep-first=roots 顺序即优先级），cog/社群数读 `l1.cog` 两 JSON 快照（缺文件=0），**不含盘上路径字段** |
| `GET /gateway/neurons/graph?id=<注册id>&res=<分辨率>` | `{neuron:{id,name,description}, resolution, resolutions[], communities[], cogs[], mems[], cognition:{graph,communities}}` | 层级2 图数据包；`id` = 注册 id（=config.yaml `person.id`，如本库 `PJ16`，目录名 `Neuron-` 前缀扫描时被剥）；`res` 缺省 = **cog2.json 命名档**（认知管线 `abstraction.default_resolution` 的落盘痕迹；无 cog2 时兜底 `resolution_1.0`）；**认知层可缺省**：`cog_graph.json`/`community.json` 均为认知管线（recall → fill_precog → build_graph → detect_communities）产物，未跑过的库只有记忆层——此时照实出记忆层图（`cognition` 两标志 false、`resolution` 空串、cogs/communities 空数组），**不报错**；仅「community.json 存在却无该分辨率档」（含显式 `res` 指定不存在档）抛错（sendError 带可用档清单）；communities[] 元素挂 `name`/`description`/`confidence`（读 cog2.json 按 members 集合精确挂载，无命名/他档群照实缺省） |

**图数据包三级结构**：`communities[]`（`i/size/density/cog_ids/mem_count/chars/members[{id,query,role,core_score}]`，来自 community.json 指定档；另挂 `name/description/confidence` 可选字段，来自 cog2.json 命名记录按 members 集合精确匹配）+ `cogs[]`（`id/query/keywords/mem_ids/rel_ids/community(-1=未入群)/chars`，来自 cog_graph.json nodes，`true_memories`/`revelant_memories` 过滤为库内存在 id）+ `mems[]`（`id/chars/source/time/preview(≤80)`，来自 mem.db）。

**连边派生在前端**（后端只给事实，不给边）：mem↔cog 由 `cogs[].mem_ids/rel_ids` 派生（同一 mem 挂多 cog 时每 cog 各一条=事实闭合）；cog↔社群由 `cogs[].community` 派生。`chars` 一律由 blocks 派生文本长度（`deriveEntryText`）。

**不做 NEURON_RAG 门控**：本模块只读盘上 JSON/sqlite，不引入 embedder/transformers；库文件独立于该编译期 flag 存在，默认构建即可出图。**只读不写**，不触发 build_graph/detect_communities 管线。
