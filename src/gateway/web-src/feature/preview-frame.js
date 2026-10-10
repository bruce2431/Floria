// 项目预览帧 + 外部卡申报同步 + 侧栏快捷按钮状态（2026-10-10 自 views/cards/{preview,ext} 下移为
// feature 层）：渲染实现（iframe 三级链）与「当前预览文档」域的状态清点同属 feature，engine 契约
// （registry/ext-decl）只做表编排——engine 永不 import views。唯一手改处，web/app.js 为生成物。

import { gToken } from '../engine/gateway.js'
import { state } from '../engine/state.js'
import { esc } from '../core/util.js'
import { clearExtCards, clearQuoteActions, deactivateCard, openCard, registerExtCards, registerQuoteActions, viewBody } from '../engine/registry.js'
/* @module feature/preview-frame.js */
  // 项目预览申报表同步（外部卡 卡片化二期 + 浮窗动作 2026-09-28）：两表同属「当前 .preview-frame
  // 所指项目」——与 clearRailExt 同点调用（iframe 换 src / 新文档重挂）。网关侧已按同一份规则校过
  // preview.json，registerExtCards / registerQuoteActions 再校一遍（postMessage 那条不过网关，
  // 两条外部输入共用 engine/ext-decl.js 的同一份过滤器）。**一次请求取两份申报，不新增请求**。
  // seq 守卫：只有最后一次 sync 的响应可以落表（快速连点两个项目时先发的响应可能后到）。
  let extCardsSeq = 0
  function syncExtCards(label) {
    const seq = ++extCardsSeq
    clearExtCards()
    clearQuoteActions()
    fetch(`/gateway/preview-cards?label=${encodeURIComponent(label)}${gToken ? '&token=' + encodeURIComponent(gToken) : ''}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((d) => {
        if (seq !== extCardsSeq) return
        registerExtCards(label, d && d.cards, true)
        registerQuoteActions(label, d && d.quoteActions)
      })
      .catch(() => {}) // 清单拿不到 = 该项目无外部卡/无浮窗动作（不猜不兜底）
  }

  // 项目预览：主聊天区渲染 iframe，替换管理/会话界面；退出预览走侧栏导航（route 统一清心跳）。
  // 预览页加载三级策略（2026-08-19 Web 容器）：
  //  ① preview.json 声明 backend → 网关 /gateway/backend 懒加载 spawn 后端进程，iframe 直连 http://127.0.0.1:<port>/
  //     （并 60s 心跳刷新网关侧 lastActive，防空闲回收误杀）；
  //  ② 有 .claude/preview/ 静态页（hasPreview=true）→ 加载 <项目>/.claude/preview/index.html；
  //  ③ 兜底默认项目主页（GitHub 仓库风格，web/default-preview/，/gateway/project 拉取文件树/README/会话）。
  function openProjectPreview(label, hasPreview) {
    // 硬进入（异 label / 帧不在场；软重入不清不重建 shell，见 mountPreview 两级重入说明）：先卸会话视图
    // 再占预览槽——deactivateCard('session') 即 registry 契约出口，给到会话卡自身的 teardown 钩子
    // （停实时计时 + 拆 stage 占位 + 清全局槽 + 复位 currentHash）。本卡不再懂 chat 清理清单。
    const body0 = viewBody('preview')
    if (state.preview !== label || !body0 || !body0.querySelector('.preview-frame')) {
      deactivateCard('session')
      state.preview = label
    }
    openCard('preview', { label, hasPreview })
  }

  // 预览渲染器（三级链的唯一一份实现：后端容器 → 静态 preview → 默认主页）。两个消费方——
  // 槽位预览卡（openProjectPreview，独占主区）与 work 个性化工作区第三栏（sidebar/work.js），
  // 到 iframe 这一层没有第二套代码。
  // 2026-09-04 重挂根修：WS 重连 onopen→hideGate 恢复链（state.preview → route）会重挂 iframe，
  // src 恒回站点根——iPad 后台杀 WS 后回到前台必触发，用户被弹回 Pj15 等站点开始页。
  // 2026-09-17 软重入根治（「打开项目界面有概率跳回 chat」二轮）：旧幂等守卫要求 previewMounted===label，
  // 而兜底 default-preview 恒记 null → 每次断连重连/门解锁都整区重写 shell + iframe 重载；iOS 上 iframe
  // 二次导航会污染主历史并诱发自发后退，落到 /session/<hash> 即被弹回会话 chat。故两级重入：同 label 且
  // iframe 在场（data-label 锚定）= 软重入——不重写 shell，三级链照跑但 mount 按 iframe 现有 src 校正
  // （同 src 零操作 = 零导航扰动；异 src 只换 src 纠正，覆盖 backend 就绪升级/default 换真源）；
  // 异 label 或 iframe 不在场 = 硬挂载。
  function mountPreview(container, label, hasPreview) {
    if (!container) return
    // 换项目 = 换源：上一份的帧留不得（软重入只对同 label 成立）
    const prev = container.querySelector('.preview-frame')
    if (prev && prev.dataset.label !== label) container.innerHTML = ''
    // 预览 iframe 挂在 .preview-body 里（该层由下面的 shell 建立，软重入时原样保留）
    if (!container.querySelector('.preview-body')) {
      container.innerHTML =
        '<div class="preview-shell">' +
        '<div class="preview-body"><div class="preview-loading">正在加载…</div></div>' +
        '</div>'
    }
    const mount = (src, name, already) => {
      // 异步回程守卫：三级链是异步的，回来时容器可能已离场（槽位换卡 / work 关掉预览栏）
      if (!container.isConnected) return
      const body = container.querySelector('.preview-body')
      if (!body) return
      // 软重入：iframe 已在场——同 src 零操作（不重载 = 零导航扰动）；异 src 只换 src（保 DOM/覆盖层），
      // 一律不走下方整区重建
      const cur = body.querySelector('.preview-frame')
      if (cur) {
        // iframe 换文档 → 上一份预览页注册的侧栏快捷按钮失效（不变量见 sidebar/rail-ext.js）
        if (cur.getAttribute('src') !== src) { clearRailExt(); syncExtCards(label); cur.setAttribute('src', src) }
        state.previewMounted = src.includes('/default-preview/') ? null : label
        return
      }
      // 覆盖层遮住后端前端加载时的深色初始化画面（2026-08-20 三轮反馈后定稿 v81）：
      // ① 纯遮罩无指令/按钮（用户「弹出的指令框」= 带指令文字的提示层，已去指令）；
      // ② 文案由 backend name 驱动（可插拔：preview.json backend.name，缺省「项目服务」）；
      // ③ backend 容器 load 后缓冲自动淡出 —— 用户「不点击界面就永远卡转圈，但其实早就启动好了」：
      //    后端已就绪（/gateway/backend 命中）才挂 iframe，load 后 object_info（如 ComfyUI 855 节点）拉取渲染
      //    还需数秒，缓冲 8s 自动淡出（不再永远卡转圈），点击仍可提前关闭（focus iframe 移交内部焦点）。
      // ④ 2026-08-28 生命周期解耦：already=后端进程已在跑（复用/收养）→ 不渲染覆盖层，iframe 直挂秒开
      //    （后端常驻后刷新/重进预览不再见「正在启动」，仅冷启动时显示）。
      clearRailExt() // 新文档重挂 → 清上一份预览页注册的侧栏快捷按钮（不变量见 sidebar/rail-ext.js）
      syncExtCards(label) // 同上：清上一份文档的侧栏快捷按钮 + 上一份预览页申报的外部卡，重取本项目清单
      body.innerHTML =
        `<iframe class="preview-frame" title="${esc(label)} 项目主页" data-label="${esc(label)}" src="${src}"></iframe>` +
        (already
          ? ''
          : `<div class="preview-overlay"><div class="preview-overlay-spin"></div>` +
            `<div class="preview-overlay-title">正在启动 ${esc(name || '项目服务')}…</div>` +
            `<div class="preview-overlay-sub">首次启动需等待后端就绪，加载完成后将自动进入</div></div>`)
      state.previewMounted = src.includes('/default-preview/') ? null : label // 兜底 default 记 null：真源升级由软重入 src 校正驱动
      const frame = body.querySelector('.preview-frame')
      const overlay = body.querySelector('.preview-overlay')
      if (!frame) return
      let autoDismiss = null
      const dismiss = () => {
        if (autoDismiss) { clearTimeout(autoDismiss); autoDismiss = null }
        if (overlay) { overlay.classList.add('done'); setTimeout(() => overlay.remove(), 400) }
      }
      frame.addEventListener('load', () => {
        frame.focus()
        if (!overlay) return
        // backend 容器（传了 name）：object_info 拉取渲染需数秒，缓冲后自动淡出；
        // 静态 preview / 默认主页（无 name）：无后端 loading，立即淡出不挡内容
        if (name) autoDismiss = setTimeout(dismiss, 8000)
        else dismiss()
      })
      // 点击关闭（可提前进入）：focus iframe + 移除覆盖层；首次点击把键盘焦点交给 iframe 内部
      if (overlay) overlay.addEventListener('click', () => { frame.focus(); dismiss() })
    }
    // ① Web 容器：backend 优先（/gateway/* 受网关 token 校验）
    fetch(`/gateway/backend?label=${encodeURIComponent(label)}${gToken ? '&token=' + encodeURIComponent(gToken) : ''}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((d) => {
        if (!(d && d.url)) throw new Error('no-backend')
        // 2026-08-27 远程端分流：127.0.0.1 直连仅在本机浏览器成立，手机等远程宿主一律改走
        // 网关同源代理 /backend/<label>/（访问票由上一拍 /gateway/backend 响应种下的 HttpOnly cookie 提供）
        const remotePage =
          location.protocol.startsWith('http') && ['127.0.0.1', 'localhost'].indexOf(location.hostname) < 0
        mount(remotePage ? `/backend/${encodeURIComponent(label)}/` : d.url, d.name, !!d.alreadyRunning)
        if (window.__backendHeartbeat) clearInterval(window.__backendHeartbeat)
        window.__backendHeartbeat = setInterval(() => {
          fetch(`/gateway/backend?label=${encodeURIComponent(label)}&token=${encodeURIComponent(gToken || '')}`).catch(() => {})
        }, 60000)
      })
      .catch(() => {
        // ② ③ 静态 preview / 默认项目主页兜底
        const previewSrc = `/preview/${encodeURIComponent(label)}/index.html${gToken ? '?token=' + encodeURIComponent(gToken) : ''}`
        const defaultSrc = `/default-preview/${encodeURIComponent(label)}/${gToken ? '?token=' + encodeURIComponent(gToken) : ''}`
        if (hasPreview) {
          fetch(previewSrc, { method: 'GET' })
            .then((r) => {
              if (!r.ok) throw new Error('HTTP ' + r.status)
              mount(previewSrc)
            })
            .catch(() => mount(defaultSrc))
        } else {
          mount(defaultSrc)
        }
      })
  }

  // ---------- 预览页注册的侧栏快捷按钮 · 状态与清点（2026-10-05 自 sidebar/rail-ext.js 迁入）----------
  // 快捷按钮集（floria-rail-register 申报）与外部卡申报同属「当前预览文档」域，故其清点与 EXT 清点
  // 同居本模块；preview-frame 内部（mountPreview 重挂）直接调 clearRailExt（不再横向 import
  // sidebar/rail-ext.js）。桥接与渲染（bindRailExtBridge / renderRailExt）留在 sidebar/rail-ext.js，
  // 经 setRailExtItems 写本表。
  let railExtItems = []
  function setRailExtItems(items) { railExtItems = items }
  function clearRailExt() {
    railExtItems = []
    const box = $('rail-ext')
    if (box) box.innerHTML = ''
  }

export {
  clearRailExt,
  mountPreview,
  openProjectPreview,
  railExtItems,
  setRailExtItems,
  syncExtCards,
}
