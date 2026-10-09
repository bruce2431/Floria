// 右栏页态内容补挂 + 侧栏（项目选择/项目列表/文件树/自动对账/数据补齐）与其渲染。（拆自 sidebar/work.js，纯搬迁零行为变更；符号经单 IIFE 共享作用域可见）
/* @module sidebar/work/work-files.js */

  // ---------- 外部卡申报补拉 ----------
  // 与 ensureWork 的树/编辑区补拉同源。预览帧在场时由 renderWorkPreview → mountPreview → syncExtCards
  // 顺带拉；预览帧不在场（宿主 pane 工具态 / 右栏关着）时在此补齐——否则刷新后外部卡 tab 缺失、
  // /manage/ext:… 直进无卡可解析（EXT 是内存表，只落缓存不落盘）。两门互补：帧在场判定 = wkFrameNeeded。
  function syncWorkExtCards() {
    if (state.workProj && !wkFrameNeeded()) syncExtCards(state.workProj)
  }

  function hideWkPops() {
    for (const id of ['wk-proj-pop', 'wk-view-pop', 'wk-new-pop']) {
      const el = $(id)
      if (el) el.hidden = true
    }
  }

  function setPane(k, on) {
    if (k === 'sidebar') {
      // 侧栏开合不走「至少保留一栏」判定——那是主区内容的约束，与侧栏无关。
      // pin = 主动打开，鼠标移出侧栏不自动收（悬停预览式收起只属左缘唤出）。行状态真源见 paneOn。
      setPanel(on, { pin: on })
      applyPanes()
      saveWork() // 两开关之一：归档进工作项目的槽
      return
    }
    if (k === 'workspace') {
      state.wkPreview = on
      if (!on) state.wkPvTab = '' // 关栏即回预览态：不留「栏不在场却停在工具态」的悬空页态
      applyPanes()
      if (on) syncPvContent() // 开栏：预览帧按需挂 / 工具内容按需拉（同项目已挂则不重建）
      saveWork()
      // 评论内容不随开关走：cmtLoad/cmtRender 在选项目（selectProject）与事后补拉（ensureWork）
      // 两处恒跑（原文标记也需要它），开关只管这一列的显隐。
      return
    }
    // 助手开关（浮层已不含助手行；只剩助手头部的 × 走到这里）：关掉后若下沉格再没有别的可显，
    // 由 applyPanes 的不变量兜底（强制留一栏 + toast）。
    if (k === 'assist') {
      state.wkAssist = on
      applyPanes()
      saveWork()
    }
  }

  // ---------- 侧栏渲染 ----------
  // 名字必须全局唯一：全部 web-src 模块体拼进同一个 IIFE 作用域，顶层同名声明会静默互相覆盖。
  // 原取名 `projList` 与 inputbar/commands.js 的同名函数撞车（后者在后 ⇒ 覆盖本函数），
  // 本函数返回 group 对象数组、后者返回 label 字符串数组 ⇒ 下拉渲染出 7 行空按钮。
  // 由 `probes/probe-web-module-scope.ts` 看住这条不变量。
  function wkProjGroups() {
    return (state.projects || []).filter((g) => g && g.scope === 'project' && g.label)
  }

  // 项目名 + 底部卡 + 下拉内容 = 同一份 state.projects 的同一次渲染（2026-09-25 修）。
  // 此前下拉内容由 renderWorkProjects 单独在「点开那一刻」渲染一次，而项目列表是 ensureWork 里
  // await loadSessions() 异步落地的——切到 work 后立刻点开就会渲染出 0 项，此后列表到了也不再更新
  // （底部卡显示「7 个项目」、下拉却是空的，就是这个错位）。合并为一条渲染路径后无处可漂移。
  function renderWorkChrome() {
    const lab = document.querySelector('#wk-proj-seat .wk-proj-label')
    if (lab) lab.textContent = state.workProj || '选择项目'
    const ft = $('wk-foot-text')
    if (ft) {
      const n = wkProjGroups().length
      ft.textContent = `${state.workProj || 'Floria'} · ${n} 个项目`
    }
    const seat = $('wk-proj-seat')
    if (seat) seat.classList.toggle('empty', !state.workProj)
    renderWorkProjects()
  }

  function renderWorkProjects() {
    const box = $('wk-proj-pop')
    if (!box) return
    const ps = wkProjGroups()
    box.innerHTML = ps.length
      ? ps
          .map(
            (g) =>
              `<button class="wkp-row${g.label === state.workProj ? ' on' : ''}" data-wkproj="${esc(g.label)}">` +
              `<span class="wkp-name">${esc(g.label)}</span>` +
              `<span class="wkp-tag">${g.hasPreview ? '预览' : ''}</span></button>`,
          )
          .join('')
      : '<div class="wk-empty">未发现项目，点 ⟳ 重试</div>'
  }

  // tab 行工具区：加号只在聊天 tab 出现（新建聊天）；文件 tab 的加号（新建文件/文件夹）待新建写接口
  // 定案后接入，届时同一按钮按 tab 分派。（原就地过滤 🔍 + #wk-find-row 已并入顶栏统一搜索，2026-10-08）
  function updateWkTools() {
    const nb = $('wk-new')
    const isChat = wkTab === 'chat'
    if (nb) nb.title = isChat ? '新建聊天' : '新建文件'
    const pop = $('wk-new-pop')
    if (pop && isChat) pop.hidden = true // 文件菜单只在文件 tab 有意义，切走即收
  }

  // 侧栏体的唯一渲染出口：HTML 全量算好再比对写入。比对是自动对账的必要条件——每 5s 一次无脑重写
  // innerHTML 会让文件树的滚动位置与展开动画反复归零（内容没变就没有重写的理由）。
  function renderWorkBody() {
    const body = $('wk-body')
    if (!body) return
    updateWkTools()
    const html = wkBodyHtml()
    if (body.innerHTML !== html) {
      body.innerHTML = html
      // 重渲换掉了行节点：长按浮窗若开着，按行标识把新节点重新扶起（浮窗本身挂在 body 下不受影响）
      reliftRowMenu()
    }
  }

  function wkBodyHtml() {
    if (wkTab === 'chat') {
      // 列表 = 当前项目下的会话，条目渲染复用 recent.js 的 itemHtml（与侧栏「项目展开」同一份实现，
      // 不另写一套行）；行操作浮窗（右键 / 长按）走 recent.js 的 document 级委托，此处无需接线。
      const list = state.workProj
        ? ALL.filter((s) => s.projectScope === 'project' && s.projectLabel === state.workProj).sort(sessCmp)
        : []
      // 新建入口 = tab 行工具区的加号（updateWkTools 控制显隐），列表顶部不再占一行大按钮
      if (!state.workProj) return '<div class="wk-empty">先在上方选择一个项目</div>'
      return list.length
        ? `<div class="wk-chats">${list.map((s) => itemHtml(s, false)).join('')}</div>`
        : '<div class="wk-empty">该项目还没有聊天</div>'
    }
    if (!state.workProj) return '<div class="wk-empty">先在上方选择一个项目</div>'
    if (wkLoading) return '<div class="wk-empty">加载中…</div>'
    if (wkErr) return `<div class="wk-empty">${esc(wkErr)}</div>`
    if (!wkTree || !wkTree.length) return '<div class="wk-empty">项目内没有可列出的文件</div>'
    return wkTreeHtml(wkTree, 0, '') || '<div class="wk-empty">项目内没有可列出的文件</div>'
  }

  function wkTreeHtml(nodes, depth, prefix) {
    let h = ''
    for (const n of nodes || []) {
      const p = prefix ? `${prefix}/${n.name}` : n.name
      const pad = `padding-left:${8 + depth * 13}px`
      if (n.type === 'dir') {
        const open = wkOpen.has(p)
        h += `<button class="wk-row dir${open ? ' open' : ''}" data-wkdir="${esc(p)}" style="${pad}" title="${esc(p)}">`
        // 图标 SVG 无自带尺寸，必须落在有 svg 尺寸规则的 slot 里——裸插会取替换元素默认 300×150（巨型图标撑爆行高）
        h += `<span class="wk-chev">${open ? I.dshChevDown : I.dshChevRight}</span><span class="wk-fic">${I.folder}</span>`
        h += `<span class="wk-name">${esc(n.name)}</span></button>`
        if (open) h += wkTreeHtml(n.children, depth + 1, p)
      } else {
        const on = p === state.workFile ? ' on' : ''
        h += `<button class="wk-row file${on}" data-wkfile="${esc(p)}" style="${pad}" title="${esc(p)}">`
        h += `<span class="wk-chec"></span><span class="wk-fic">${I.dshFile}</span>`
        h += `<span class="wk-name">${esc(n.name)}</span></button>`
      }
    }
    return h
  }

  // ---------- 数据 ----------
  // silent = 自动对账调用：不置加载态、失败保留旧树（瞬时网络错误不该把已展开的树清成错误页）
  async function loadProjectTree(label, silent) {
    if (!label || needToken()) return
    if (!silent) {
      wkLoading = true
      wkErr = ''
      wkTree = null
      renderWorkBody()
    }
    try {
      const res = await fetch(apiUrl('/gateway/project?label=' + encodeURIComponent(label)))
      const data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error || '加载失败')
      wkTree = Array.isArray(data.files) ? data.files : []
    } catch (e) {
      if (silent) return
      wkErr = e.message || String(e)
    } finally {
      if (!silent) wkLoading = false
    }
    renderWorkBody()
  }

  async function selectProject(label) {
    hideWkPops()
    if (!label || label === state.workProj) return
    if (wkEdDirty) await wkEdFlush() // 切项目前 flush 旧项目文件的 pending 编辑
    stashWorkPanes() // 旧项目的两开关先归档（此刻 state.workProj 还是旧值——saveWork 里那一次归档只认当前项目）
    state.workProj = label
    loadWorkPanes(label) // 新项目：有槽恢复该项目的开关，无槽回落缺省
    state.workFile = ''
    state.wkMainTab = 'chat' // 换了项目 = 旧文件 tab 作废，回到聊天 tab
    state.wkChats = [] // 换项目 = 顶栏标签栏重置（旧项目会话胶囊不残留；纯运行时，不持久化）
    wkOpen.clear()
    renderWorkChrome()
    saveWork()
    enforceWorkScope() // 换项目 → 助手栏若停在别的项目的会话，先退回本项目的新对话（归位 currentHash）
    applyPanes() // 再落地两开关（含「至少保留一栏」判定 + 视图浮层行同步 + 顶栏按归一后的路由重渲）
    applySidebarPin() // 侧栏开合按新项目的槽（桌面）
    renderEditor()
    hydrateExtCards(label) // 换项目：外部卡先按缓存即时换槽（tab 不断档），再走下面一次网络清单
    renderWorkPreview() // 预览帧跟着换项目（异 label = 换源，mountPreview 内部重建；工具态则早退）
    cmtInvalidate() // 评论按项目分库：旧项目副本作废（下一行 cmtLoad 重拉，评论面板与原文标记共用）
    cmtLoad(label) // 原文标记也需要当前项目的评论（不止评论面板）；拉到后 cmtApplyMarks 自动补标
    cmtRender()
    syncWorkExtCards()
    await loadProjectTree(label)
  }

  // silent = 自动对账（见 workAutoTick）：不收起浮层、不动滚动位置、失败静默
  async function refreshWork(silent) {
    if (!silent) hideWkPops()
    const body = $('wk-body')
    const sc = body ? body.scrollTop : 0
    try {
      await loadSessions()
    } catch {
      /* 列表刷新失败不阻断文件树刷新 */
    }
    renderWorkChrome()
    if (state.workProj) await loadProjectTree(state.workProj, silent)
    else renderWorkBody() // 未选项目时列表/空态也要跟上（loadProjectTree 早退不渲染）
    if (body && sc && body.scrollTop !== sc) body.scrollTop = sc
  }

  // ---------- 自动刷新（2026-09-26 取代手动 ⟳） ----------
  // 三条前置：work 模式 + 页面可见 + 已过 token 门。会话列表由 /gateway/events SSE 增量推，
  // 但 work 侧栏的列表/树不在 SSE 的重渲出口里（live.js refreshList 只渲 #recent-body），
  // 所以这里定时对账一次全量，静默无变化即不写 DOM（renderWorkBody 的 HTML 比对）。
  const WK_AUTO_MS = 5000
  let wkAutoT = 0
  function startWorkAuto() {
    if (!wkAutoT) wkAutoT = setInterval(workAutoTick, WK_AUTO_MS)
  }
  function stopWorkAuto() {
    if (wkAutoT) {
      clearInterval(wkAutoT)
      wkAutoT = 0
    }
  }
  async function workAutoTick() {
    if (state.sbMode !== 'work' || document.visibilityState !== 'visible' || needToken()) return
    await refreshWork(true)
  }

  // 项目列表落地（ensureWork / 下拉打开时共用）。needToken 未解锁或网络失败时 state.projects 保持原值。
  async function ensureProjectList() {
    if (state.projects.length) return
    try {
      await loadSessions()
    } catch {
      /* 静默：renderWorkProjects 以空态呈现 */
    }
  }

  // work 模式数据补齐（启动进入 / 门后补拉 / 恢复持久化状态三处共用一条路径）。needToken() 未解锁时
  // loadProjectTree 早退 ⇒ 刷新后恢复的 workProj/workFile 无树、编辑区 401，须由 engine/auth.js hideGate
  // 的「门后补拉」链再调一次（与 mgr/models/neurons 数据同点，见该文件同名注释）。
  async function ensureWork() {
    renderWorkChrome()
    renderWorkBody()
    renderEditor()
    await ensureProjectList()
    renderWorkChrome()
    if (state.workProj && !wkTree && !wkLoading && !wkErr) await loadProjectTree(state.workProj)
    renderWorkPreview() // 挂在 ensureProjectList 之后：hasPreview 来自 groups，先拉列表才知道
    cmtLoad(state.workProj) // 评论恢复态补拉（评论面板与原文标记共用；needToken 未解锁时早退，由门后补拉再调）
    syncWorkExtCards() // 外部卡申报同上：与树/编辑区/评论同一条补拉链
    // 布局落地（tab 显隐 + 列宽 + 顶栏）在本链尾再落一次：ensureWork 是 work 一切事后补拉的唯一口
    // （启动 + token 门解锁后各一次），门/首帧里 DOM 还没量到时这里给第二次落地机会。
    applyPanes()
    cmtRender() // 评论面板空态/加载态跟着工作项目落地（needToken 未解锁时上面 cmtLoad 早退）
  }

