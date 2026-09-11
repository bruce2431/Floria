// 管理三界面渲染（插件/项目/模型）（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { route, navigate } from '../chat/route.js'
import { stageRelease } from '../chat/stage.js'
import { hideGate } from '../core/auth.js'
import { gToken, needToken } from '../core/gateway.js'
import { I } from '../core/icons.js'
import { stopLiveFoldTimer } from '../core/live.js'
import { hashOf, sorted } from '../core/sessions.js'
import { chatArea, messagesEl, inputWrap, bodyEl, overlay, state, saveMgrView, ALL, esc, toast, isMobile } from '../core/state.js'
import { closeMentionPop } from '../inputbar/mention.js'
import { apiSetModel } from '../inputbar/model-select.js'
import { gwSend } from '../inputbar/send.js'
import { MGR, MGR_LOADING, MGR_ERR, loadMgrData, MODELS, MODELS_LOADING, MODELS_ERR, loadModelsData, mgrColor } from './mgr-data.js'
import { setPanel, itemHtml, bindSessClicks, isArchived, newWebSession } from './recent.js'
  function renderMgr() {
    closeMentionPop()
    stopLiveFoldTimer()
    stageRelease()
    state.currentHash = null
    state.preview = null
    const scrollEl = document.querySelector('#chat-scroll')
    const prevTop = scrollEl ? scrollEl.scrollTop : 0
    // 「项目」入口：仿照插件布设，每个项目胶囊占据一整行（数据源 = 会话按 projectLabel 分组）
    if (state.mgr === 'projects') {
      // 顶部结构与插件视图完全同构（mgr-top mgr-kind + mgr-cats 占位），避免切换跳动；无刷新/设置按钮
      const projCount = new Set(ALL.filter((s) => s.projectScope === 'project' && s.projectLabel && !isArchived(s)).map((s) => s.projectLabel)).size
      messagesEl.innerHTML =
        '<div class="mgr-pane">' +
        // 空 mgr-top 占位：与插件视图「插件/技能」切换行等高（.mgr-top min-height），避免切换时标题跳动
        '<div class="mgr-top"></div>' +
        '<div class="mgr-head"><h2 class="mgr-title">项目</h2>' +
        '<div class="mgr-sub">按项目文件夹分组 · 会话按最近活跃排序</div></div>' +
        `<div class="mgr-search">${I.mag}<input id="mgr-pq" type="text" placeholder="搜索项目…" value="${esc(state.mgrView.q)}"></div>` +
        `<div class="mgr-cats"><span class="mgr-cat on">共 ${projCount} 个项目</span></div>` +
        '<div class="mgr-list" id="mgr-list"></div>' +
        '<div class="mgr-foot">数据源：会话按项目分组（/gateway/sessions）</div>' +
        '</div>'
      inputWrap.classList.remove('docked')
      chatArea.classList.remove('in-session')
      chatArea.classList.add('mgr-on')
      renderMgrProj()
      const pq = $('mgr-pq')
      if (pq) pq.addEventListener('input', () => { state.mgrView.q = pq.value; saveMgrView(); renderMgrProj() })
      return
    }
    // 「模型」入口：仿照项目布设，展示便携根 settings.json 的模型配置（只读）
    if (state.mgr === 'models') {
      // 顶部结构与插件视图完全同构（空 mgr-top 占位等高防跳）
      messagesEl.innerHTML =
        '<div class="mgr-pane">' +
        '<div class="mgr-top"></div>' +
        '<div class="mgr-head"><h2 class="mgr-title">模型列表</h2></div>' +
        '<div class="mgr-model-list" id="mgr-model-list"></div>' +
        '<div class="mgr-foot">数据源：网关 /gateway/models</div>' +
        '</div>'
      inputWrap.classList.remove('docked')
      chatArea.classList.remove('in-session')
      chatArea.classList.add('mgr-on')
      renderMgrModels()
      loadModelsData(false)
      return
    }
    const v = state.mgrView
    const kindName = v.kind === 'skills' ? '技能' : '插件'
    const sub =
      v.kind === 'skills'
        ? '个人 = 已安装技能（扫描便携根 .claude/skills）· 公开 = 官方市场技能'
        : '个人 = 已安装插件（扫描便携根 .claude/plugins）· 公开 = 官方市场插件'
    messagesEl.innerHTML =
      '<div class="mgr-pane">' +
      '<div class="mgr-top">' +
      '<div class="mgr-kind">' +
      `<button class="mgr-kind-btn${v.kind === 'plugins' ? ' on' : ''}" data-kind="plugins">插件</button>` +
      `<button class="mgr-kind-btn${v.kind === 'skills' ? ' on' : ''}" data-kind="skills">技能</button>` +
      '</div>' +
      '</div>' +
      `<div class="mgr-head"><h2 class="mgr-title">${kindName}</h2><div class="mgr-sub">${sub}</div></div>` +
      `<div class="mgr-search">${I.mag}<input id="mgr-q" type="text" placeholder="${v.kind === 'skills' ? '搜索技能…' : '搜索插件…'}" value="${esc(v.q)}"></div>` +
      '<div class="mgr-cats">' +
      `<button class="mgr-cat${v.cat === 'public' ? ' on' : ''}" data-cat="public">公开</button>` +
      `<button class="mgr-cat${v.cat === 'personal' ? ' on' : ''}" data-cat="personal">个人</button>` +
      '</div>' +
      '<div class="mgr-grid" id="mgr-grid"></div>' +
      '<div class="mgr-foot">数据源：网关 /gateway/plugins 实时扫描</div>' +
      '</div>'
    inputWrap.classList.remove('docked')
    chatArea.classList.remove('in-session')
    chatArea.classList.add('mgr-on')
    renderMgrGrid()
    loadMgrData(false) // 真实数据：首次进入拉取，刷新按钮 force 重拉
    // 恢复滚动位置（scroll-behavior:smooth 会让赋值动画，临时切 auto 立即归位）
    if (scrollEl) {
      const old = scrollEl.style.scrollBehavior
      scrollEl.style.scrollBehavior = 'auto'
      scrollEl.scrollTop = prevTop
      scrollEl.style.scrollBehavior = old
    }
    const pane = messagesEl.querySelector('.mgr-pane')
    pane.querySelectorAll('.mgr-kind-btn').forEach((b) =>
      b.addEventListener('click', () => {
        v.kind = b.dataset.kind
        saveMgrView()
        renderMgr()
      }),
    )
    pane.querySelectorAll('.mgr-cat').forEach((b) =>
      b.addEventListener('click', () => {
        v.cat = b.dataset.cat
        saveMgrView()
        renderMgr()
      }),
    )
    const q = $('mgr-q')
    if (q) q.addEventListener('input', () => { v.q = q.value; saveMgrView(); renderMgrGrid() })
  }

  // 管理视图：插件/技能卡片网格（按 kind + cat + 搜索词过滤；数据源 = 后端 /gateway/plugins）
  function renderMgrGrid() {
    const v = state.mgrView
    const grid = $('mgr-grid')
    if (!grid) return
    const label = v.kind === 'skills' ? '技能' : '插件'
    if (MGR_LOADING) {
      grid.innerHTML = '<div class="mgr-empty">加载真实清单中…</div>'
      return
    }
    if (MGR_ERR) {
      grid.innerHTML =
        '<div class="mgr-empty">清单加载失败：' + esc(MGR_ERR) +
        '<br><button class="mgr-retry" id="mgr-retry">重试</button></div>'
      const retry = $('mgr-retry')
      if (retry) retry.addEventListener('click', () => loadMgrData(true))
      return
    }
    const src = (MGR && MGR[v.kind] && MGR[v.kind][v.cat]) || []
    const q = (v.q || '').trim().toLowerCase()
    const rows = q ? src.filter((x) => x.n.toLowerCase().includes(q) || x.d.toLowerCase().includes(q)) : src
    grid.innerHTML = rows.length
      ? rows.map(mgrCardHtml).join('')
      : `<div class="mgr-empty">没有匹配的${label}</div>`
  }
  function mgrCardHtml(x) {
    const badge = x.inst ? '<span class="inst-badge">已安装</span>' : ''
    return (
      `<div class="mgr-card"><div class="mgr-ic" style="background:${mgrColor(x.n)}">${esc((x.n[0] || '?').toUpperCase())}</div>` +
      `<div class="mgr-meta"><div class="mgr-name">${esc(x.n)}${badge}</div><div class="mgr-desc">${esc(x.d)}</div></div>` +
      '<button class="mgr-more" title="更多">…</button></div>'
    )
  }

  // 管理视图：项目列表（仿照插件布设，每个项目胶囊占据一整行）
  // 数据源 = 已加载会话 ALL 按 projectLabel 分组（projectScope==='project'），不另起后端接口。
  function renderMgrProj() {
    const list = $('mgr-list')
    if (!list) return
    const q = (state.mgrView.q || '').trim().toLowerCase()
    const byProject = {}
    for (const s of ALL) if (s.projectScope === 'project' && s.projectLabel && !isArchived(s)) (byProject[s.projectLabel] = byProject[s.projectLabel] || []).push(s)
    const labels = Object.keys(byProject).filter((l) => !q || l.toLowerCase().includes(q))
    // 按项目最近活跃时间降序（同 renderProject 排序）
    labels.sort((a, b) => {
      const la = Math.max(0, ...byProject[a].map((s) => s.updatedAt))
      const lb = Math.max(0, ...byProject[b].map((s) => s.updatedAt))
      return lb - la
    })
    // 该项目是否带 .claude/preview/（会话 preview 标志由后端 findProjects.hasPreview 透传）
    const hasPreview = (l) => ALL.some((s) => s.projectScope === 'project' && s.projectLabel === l && s.preview)
    list.innerHTML = labels.length
      ? labels.map((l) => mgrProjHtml(l, byProject[l], hasPreview(l))).join('')
      : '<div class="mgr-empty">' + (q ? '没有匹配的项目' : '暂无项目会话') + '</div>'
    list.querySelectorAll('.mgr-proj').forEach((b) =>
      b.addEventListener('click', () => {
        // 点项目胶囊一律进预览：带 .claude/preview 加载真预览页；不带 → 默认项目主页
        // （GitHub 仓库风格，web/default-preview/，由网关 /gateway/project 拉数据）。
        if (b.dataset.label) {
          // 进预览走 hash 路由（#preview/<label>），刷新后可恢复当前预览页
          navigate('#preview/' + encodeURIComponent(b.dataset.label))
          if (isMobile()) setPanel(false)
          return
        }
        const hash = b.dataset.hash
        if (!hash) return
        navigate('#/' + encodeURIComponent(hash))
        if (isMobile()) setPanel(false)
      }),
    )
  }
  function mgrProjHtml(label, chats, hasPreview) {
    const latest = [...chats].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    const n = chats.length
    return (
      `<button class="mgr-proj" data-hash="${latest ? esc(hashOf(latest)) : ''}" data-label="${esc(label)}" data-preview="${hasPreview ? '1' : '0'}" title="${esc(label)} · ${n} 个会话（点击进入项目主页）">` +
      `<span class="mgr-ic" style="background:${mgrColor(label)}">${I.folder}</span>` +
      `<span class="mgr-meta"><span class="mgr-name">${esc(label)}${hasPreview ? '<span class="pv-badge">预览</span>' : ''}<span class="inst-badge">${n} 个会话</span></span>` +
      `<span class="mgr-desc">${hasPreview ? '点击打开项目预览页（.claude/preview）' : '点击打开默认项目主页（无预览页）'}</span></span>` +
      '<span class="mgr-more" title="打开">›</span></button>'
    )
  }

  // 管理视图：模型列表（按供应商分组；数据源 = 网关 /gateway/models，只读展示）
  const MODEL_PROVIDER_KEYS = [
    [/^ANTHROPIC_/, 'Claude · Anthropic'],
    [/^OPENAI_/, 'OpenAI'],
    [/^GEMINI_/, 'Google Gemini'],
    [/^DEEPSEEK_/, 'DeepSeek'],
    [/^QWEN_/, 'Qwen · 通义千问'],
    [/^DASHSCOPE_/, 'Qwen · 通义千问'],
    [/^GLM_/, '智谱 GLM'],
    [/^MOONSHOT_/, 'Moonshot Kimi'],
    [/^OPENROUTER_/, 'OpenRouter'],
  ]
  // 供应商判定：key 优先（模型类环境变量名带供应商前缀），通用 model 键或未命中则按模型串前缀。
  function modelProviderOf(it) {
    const k = String(it.k || '')
    const v = String(it.v || '')
    if (k !== 'model') {
      for (const [re, name] of MODEL_PROVIDER_KEYS) if (re.test(k)) return name
    }
    const vl = v.toLowerCase()
    if (vl.startsWith('claude')) return 'Claude · Anthropic'
    if (vl.startsWith('deepseek')) return 'DeepSeek'
    if (vl.startsWith('qwen')) return 'Qwen · 通义千问'
    if (vl.startsWith('gpt') || vl.startsWith('o1') || vl.startsWith('o3')) return 'OpenAI'
    if (vl.startsWith('gemini')) return 'Google Gemini'
    if (vl.startsWith('glm')) return '智谱 GLM'
    if (vl.startsWith('moonshot') || vl.includes('kimi')) return 'Moonshot Kimi'
    if (vl.includes('doubao')) return '字节豆包'
    return '自定义 / 其他'
  }
  function renderMgrModels() {
    const list = $('mgr-model-list')
    if (!list) return
    if (MODELS_LOADING) {
      list.innerHTML = '<div class="mgr-empty">加载模型列表…</div>'
      return
    }
    if (MODELS_ERR) {
      list.innerHTML =
        '<div class="mgr-empty">模型列表加载失败：' + esc(MODELS_ERR) +
        '<br><button class="mgr-retry" id="mgr-models-retry">重试</button></div>'
      const retry = $('mgr-models-retry')
      if (retry) retry.addEventListener('click', () => loadModelsData(true))
      return
    }
    const d = MODELS
    if (!d) {
      list.innerHTML = '<div class="mgr-empty">暂无模型配置</div>'
      return
    }
    const items = Array.isArray(d.items) ? d.items : []
    if (!items.length) {
      list.innerHTML = '<div class="mgr-empty">暂无模型配置</div>'
      return
    }
    // 按供应商分组（保持配置出现顺序，组内保持原序）；2026-08-29 优先网关下发的真实归属（items[].provider）
    const groups = []
    for (const it of items) {
      const p = it.provider || modelProviderOf(it)
      let g = groups.find((x) => x.provider === p)
      if (!g) {
        g = { provider: p, items: [] }
        groups.push(g)
      }
      g.items.push(it)
    }
    list.innerHTML = groups
      .map(
        (g) =>
          '<div class="mgr-model-group">' +
          `<div class="mgr-model-ghead"><span class="mgr-model-gname">${esc(g.provider)}</span></div>` +
          g.items.map(modelCapHtml).join('') +
          '</div>',
      )
      .join('')
    list.querySelectorAll('.mgr-model-item.settable').forEach((row) => {
      row.addEventListener('click', () => setDefaultModel(row.dataset.model))
    })
  }
  // 模型胶囊：完全复用项目胶囊 .mgr-proj 的风格与尺寸（40px 彩块 icon + 名称行 + 描述行）。
  // 2026-08-23 设为默认：凭据池内模型 → 整行可点「设为默认」；2026-08-29 直接切模型自动切供应商 →
  // 放开为全池（src 以「凭据池」开头的行，跨商由网关 switchModelAuto 自动切供应商）；
  // 当前默认模型（MODELS.activeModel）标「默认」徽标；其余配置项保持只读。
  function modelCapHtml(it) {
    const name = String(it.v || '')
    // 备注小字 = 是否为视觉模型（凭据池 modelVision 配置；未标记按非视觉）
    const desc = it.vision === true ? '支持视觉' : '不支持视觉'
    // DeepSeek 供应商 → 白底 + 蓝色鲸鱼；其它供应商保留彩块 + 芯片线条
    const isDs = (it.provider || modelProviderOf(it)) === 'DeepSeek'
    const icStyle = isDs ? 'background:#fff;color:#4d6bfe;border:1px solid #d9e2f8' : 'background:' + mgrColor(name)
    const icSvg = isDs ? I.whale : I.chip
    // 凭据池内模型 → 整行可点「设为默认」；默认模型整行绿色高亮（无文字徽标）。
    // 不渲染右侧装饰箭头：模型胶囊右侧无任何按钮。
    const settable = !!(typeof it.src === 'string' && it.src.startsWith('凭据池'))
    const isDefault = settable && MODELS.activeModel === name
    const cls = 'mgr-proj mgr-model-item' + (settable ? ' settable' : '') + (isDefault ? ' is-default' : '')
    return (
      `<div class="${cls}"${settable ? ' title="点击设为默认模型"' : ''} data-model="${esc(name)}">` +
      `<span class="mgr-ic" style="${icStyle}">${icSvg}</span>` +
      `<span class="mgr-meta"><span class="mgr-name">${esc(name)}</span>` +
      `<span class="mgr-desc">${esc(desc)}</span></span>` +
      '</div>'
    )
  }
  // 2026-08-23 设为默认：POST /gateway/model { defaultModel } → 写 credentials.json activeModel（仅全局默认，
  // 不影响当前会话）。成功后本地更新 MODELS.activeModel 重渲染，默认徽标移到新模型。
  async function setDefaultModel(id) {
    if (needToken()) { toast('未连接网关，无法设置'); return } // 2026-08-29 !gToken → needToken()（cookie 设备误报修复）
    if (MODELS && MODELS.activeModel === id) { toast('已是默认模型'); return }
    const ok = await apiSetModel({ defaultModel: id })
    if (ok) {
      if (MODELS) MODELS.activeModel = id
      renderMgrModels()
      toast(`默认模型已设为 ${id}`)
    } else {
      toast('设置失败 · 模型不在凭据池或网关未连接')
    }
  }
  // 项目预览：主聊天区渲染 iframe，替换管理/会话界面；退出预览走侧栏导航（route 统一清心跳）。
  // 预览页加载三级策略（2026-08-19 Web 容器）：
  //  ① preview.json 声明 backend → 网关 /gateway/backend 懒加载 spawn 后端进程，iframe 直连 http://127.0.0.1:<port>/
  //     （并 60s 心跳刷新网关侧 lastActive，防空闲回收误杀）；
  //  ② 有 .claude/preview/ 静态页（hasPreview=true）→ 加载 <项目>/.claude/preview/index.html；
  //  ③ 兜底默认项目主页（GitHub 仓库风格，web/default-preview/，/gateway/project 拉取文件树/README/会话）。
  function openProjectPreview(label, hasPreview) {
    // 2026-09-04 预览重挂根修：WS 重连 onopen→hideGate 恢复链（state.preview → route）会重挂 iframe，
    // src 恒回站点根——iPad 后台杀 WS 后回到前台必触发，用户被弹回 Pj15 等站点开始页。
    // 同 label 且 iframe 仍挂载（且非 default 兜底误挂，previewMounted=null）→ 幂等跳过，保留站内位置。
    if (state.preview === label && state.previewMounted === label && messagesEl.querySelector('.preview-frame')) return
    state.currentHash = null
    stopLiveFoldTimer()
    stageRelease()
    state.preview = label
    inputWrap.classList.remove('docked')
    chatArea.classList.remove('in-session')
    chatArea.classList.add('mgr-on')
    messagesEl.innerHTML =
      '<div class="preview-shell">' +
      '<div class="preview-body"><div class="preview-loading">正在加载…</div></div>' +
      '</div>'
    const mount = (src, name, already) => {
      const body = document.querySelector('.preview-body')
      if (!body) return
      // 覆盖层遮住后端前端加载时的深色初始化画面（2026-08-20 三轮反馈后定稿 v81）：
      // ① 纯遮罩无指令/按钮（用户「弹出的指令框」= 带指令文字的提示层，已去指令）；
      // ② 文案由 backend name 驱动（可插拔：preview.json backend.name，缺省「项目服务」）；
      // ③ backend 容器 load 后缓冲自动淡出 —— 用户「不点击界面就永远卡转圈，但其实早就启动好了」：
      //    后端已就绪（/gateway/backend 命中）才挂 iframe，load 后 object_info（如 ComfyUI 855 节点）拉取渲染
      //    还需数秒，缓冲 8s 自动淡出（不再永远卡转圈），点击仍可提前关闭（focus iframe 移交内部焦点）。
      // ④ 2026-08-28 生命周期解耦：already=后端进程已在跑（复用/收养）→ 不渲染覆盖层，iframe 直挂秒开
      //    （后端常驻后刷新/重进预览不再见「正在启动」，仅冷启动时显示）。
      body.innerHTML =
        `<iframe class="preview-frame" title="${esc(label)} 项目主页" src="${src}"></iframe>` +
        (already
          ? ''
          : `<div class="preview-overlay"><div class="preview-overlay-spin"></div>` +
            `<div class="preview-overlay-title">正在启动 ${esc(name || '项目服务')}…</div>` +
            `<div class="preview-overlay-sub">首次启动需等待后端就绪，加载完成后将自动进入</div></div>`)
      state.previewMounted = src.includes('/default-preview/') ? null : label // 兜底误挂不算已挂载，hideGate 解锁后重挂
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

  function renderList() {
    const box = document.createElement('div')
    // 2026-08-25「在一个列表中」堆叠视图：项目会话显示所属项目短编号气泡（Pj16），根会话无气泡
    box.innerHTML = sorted().map((s) => itemHtml(s, true)).join('')
    bindSessClicks(box)
    bodyEl.appendChild(box)
  }

  function renderProject() {
    bodyEl.innerHTML = ''
    if (state.pt === 'projects') {
      const byProject = {}
      for (const s of ALL) if (s.projectScope === 'project' && !isArchived(s)) (byProject[s.projectLabel] = byProject[s.projectLabel] || []).push(s)
      const labels = Object.keys(byProject).sort((a, b) => {
        const la = Math.max(0, ...byProject[a].map((s) => s.updatedAt))
        const lb = Math.max(0, ...byProject[b].map((s) => s.updatedAt))
        return lb - la
      })
      if (labels.length === 0) {
        bodyEl.innerHTML = '<div class="no-hit" style="padding:10px">暂无项目会话</div>'
        return
      }
      const box = document.createElement('div')
      box.innerHTML = labels
        .map((label) => {
          const chats = [...byProject[label]].sort((a, b) => b.updatedAt - a.updatedAt)
          // 2026-08-24 项目新建会话：项目文件夹行 + 按钮 → 在指定项目下新建 web 会话
          // （与「笔」新建会话并存，两者指向不同 exe——见 newWebSession 注释）
          return `<div class="folder" data-f="${esc(label)}"><button class="folder-head">
            <span class="chev">▶</span><span class="ficon">${I.folder}</span><span class="fname">${esc(label)}</span>
            <span class="fcount">${chats.length}</span>
            <span class="folder-add" role="button" tabindex="-1" title="在 ${esc(label)} 新建会话">${I.dshPlus}</span></button><div class="folder-body">${chats.map(itemHtml).join('')}</div></div>`
        })
        .join('')
      box.querySelectorAll('.folder-head').forEach((h) => h.addEventListener('click', () => h.parentElement.classList.toggle('open')))
      // 2026-08-24 项目新建会话入口：点击 → 在指定项目新建 web 会话
      // 2026-08-25 改造：与「笔」一致，先到初始化界面（#/ 空态 + 目标项目 chip），
      // 首条消息发送时才真正建会话（gwSend 空态分支带 project 调 newWebSession）。不再直接弹 CLI。
      box.querySelectorAll('.folder-add').forEach((a) =>
        a.addEventListener('click', (e) => {
          e.stopPropagation()
          const f = a.closest('.folder')
          if (f && f.dataset.f) {
            state.newProject = f.dataset.f
            navigate('#/')
            if (isMobile()) setPanel(false)
          }
        }),
      )
      bindSessClicks(box)
      bodyEl.appendChild(box)
    } else {
      const root = ALL.filter((s) => s.projectScope !== 'project' && !isArchived(s))
      const box = document.createElement('div')
      box.innerHTML = root.length ? root.map(itemHtml).join('') : '<div class="no-hit" style="padding:10px">暂无根会话</div>'
      bindSessClicks(box)
      bodyEl.appendChild(box)
    }
  }

export {
  MODEL_PROVIDER_KEYS,
  mgrCardHtml,
  mgrProjHtml,
  modelCapHtml,
  modelProviderOf,
  openProjectPreview,
  renderList,
  renderMgr,
  renderMgrGrid,
  renderMgrModels,
  renderMgrProj,
  renderProject,
  setDefaultModel,
}
