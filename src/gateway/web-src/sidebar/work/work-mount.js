// 事件绑定（mountWork）与启动一次（initWork）。（拆自 sidebar/work.js，纯搬迁零行为变更；符号经单 IIFE 共享作用域可见）
/* @module sidebar/work/work-mount.js */
  // ---------- 事件 ----------
  function mountWork() {
    registerWorkRows() // 文件树行的右键 / 长按浮窗（与会话行共用 recent.js 的手势委托）
    document.querySelectorAll('#chat-area > .work-gutter').forEach(bindGutter) // 主区一条分界条（下沉区 ↔ 预览）
    // 助手三态：头部工具条的四个图标 + 收敛输入栏的 pill；形态切换统一走 setAssistMode / setPane。
    const bindIco = (id, fn) => {
      const b = $(id)
      if (b) b.addEventListener('click', fn)
    }
    bindIco('wk-assist-slim', () => setAssistMode('slim'))
    bindIco('wk-assist-float', () => setAssistMode('float'))
    bindIco('wk-assist-dock', () => setAssistMode('side'))
    bindIco('wk-assist-close', () => setPane('assist', false))
    bindIco('wk-assist-pill', () => setAssistMode('float'))
    bindAssistGrip()
    // 主区尺寸变化 → 重锚悬浮卡：ResizeObserver 一把覆盖分界条拖拽、侧栏开合、窗口缩放、栏开关
    // （比 window.resize + 视口算更准：锚栏宽变了就重算，没变就不动）。
    const ro = new ResizeObserver(() => wkReflowAssist())
    ro.observe(chatArea)
    for (const id of ['work-editor', 'work-preview']) {
      const el = $(id)
      if (el) ro.observe(el)
    }
    // 模式 tab 白块：applySbMode 首次定位时字体可能还没到位（字宽变 ⇒ 白块错位），fonts.ready 后重量一次；
    // 窗口宽变同理（面板拖宽不改钮宽，但换字号/系统缩放下会）。
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(positionMsThumb)
    window.addEventListener('resize', positionMsThumb)
    $('wk-new').innerHTML = I.dshPlus
    $('wk-view').innerHTML = I.toggle
    $('wk-tb-new').innerHTML = I.dshPlus // 顶栏 + 按钮图标（单源 core/icons.js）
    // 顶栏「工具栏」胶囊的图标/文字由 applyPvTab 按页态写（预览态 = 插件图标 + 「工具栏」，工具态 = ✕ +
    // 「关闭」），此处不预置——applySbMode → applyPanes → applyPvTab 在 mountWork 之后立刻落一次。
    // 右栏工具注册（注册序即 tab 序）：评论（pane = #wk-cmt，渲染仍归 comments.js；mount = 切到本 tab 时
    // 按需拉+渲）。外部注册 = 任意模块调 registerWkTool 追加，本模块不感知其内容。
    registerWkTool({
      id: 'comments',
      title: '评论',
      pane: 'wk-cmt',
      mount: () => {
        cmtLoad(state.workProj)
        cmtRender()
      },
    })
    // 评论模块 ↔ work 解耦：注册回调（点评论定位开文件 / 选区添加评论时切到评论工具页 /
    // 评论增删改后重绘原文标记）
    cmtSetHooks({
      openFile: (p, id) => {
        wkCmtScrollId = id || ''
        openWorkFile(p) // 打开 + 渲染后由 cmtApplyMarks 消费 wkCmtScrollId 滚到被批注行
      },
      ensurePane: () => setPvTab('comments'), // 切评论工具页（含开栏 + 拉内容）
      refreshMarks: cmtApplyMarks,
    })
    cmtMount()
    // 下沉区顶栏 tab：[+] = 新建聊天；两个 pill 的点击只切 wkMainTab/助手形态，渲染由 renderTopbar 收口。
    $('wk-tb-new').addEventListener('click', () => newWorkChat())
    $('wk-tb-tool').addEventListener('click', () => toggleToolbar())
    // 右栏工具 tab 条：唯一切换口 = setPvTab（渲染 + 内容补挂 + 持久化都在其内）。tab 条由
    // work-tools.js 的 renderWkToolTabs 重渲 → 事件必须委托在容器上（逐钮绑定会被下次重渲抹掉）。
    $('wk-pv-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-wkpv]')
      if (b) setPvTab(b.dataset.wkpv)
    })
    // 预览帧 → 宿主：申报本页的工具 tab（Pj18 等预览页把「编译日志」之类挂进工具栏面板）。沿用既有
    // iframe↔宿主通道（同 rail-ext / ext-card），凭 e.source 必须就是 work 右栏当前那枚 .preview-frame
    // 才采纳。字段：{ type:'floria-wk-tool-register', tools:[{ id, title }] }，整份替换（页面最了解自己有什么）。
    // 帧工具的 pane 由预览页自管（宿主只渲 tab + 回传选中 id，见 syncPvContent/notifyFrame）。
    addEventListener('message', (e) => {
      const d = e.data
      if (!d || d.type !== 'floria-wk-tool-register') return
      const f = wkFrame()
      if (!f || f.contentWindow !== e.source) return
      const tools = (Array.isArray(d.tools) ? d.tools : [])
        .filter((t) => t && typeof t.id === 'string' && t.id)
        .map((t) => ({ id: t.id, title: typeof t.title === 'string' ? t.title : t.id, pane: '', mount: null }))
      registerWkFrameTools(f.dataset.label || '', tools)
      // 申报集变了：当前 active 若已不存在（被撤的帧工具）→ 回落预览态；否则照旧。
      if (state.wkPvTab && !wkToolDef(state.wkPvTab)) state.wkPvTab = ''
      wkFrameSentId = null // 帧重挂/重申报 → 强制再回传一次当前选中
      applyPanes()
      notifyFrame(state.wkPvTab && !(wkToolDef(state.wkPvTab) || {}).pane ? state.wkPvTab : '')
    })
    $('wk-tb-tabs').addEventListener('click', (e) => {
      const cap = e.target.closest('[data-wkchat]')
      if (cap) {
        if (e.target.closest('.wk-tb-x')) { wkCloseTab(cap.dataset.wkchat); return } // × = 关这枚 tab
        // 点胶囊 = 明确要看这个会话：助手在场且靠回栏（浮起/收敛先靠回），再切到该会话路由
        state.wkMainTab = 'chat'
        state.wkAssist = true
        state.wkAssistMode = 'side'
        const hash = wkKeyHash(cap.dataset.wkchat)
        if (state.currentHash !== hash) navigate(hash ? '#/' + encodeURIComponent(hash) : '#/')
        applyPanes() // 形态 + 顶栏 active 一并落地（applyWorkCols 内 applyAssistMode 收口）
        saveWork()
        return
      }
      const b = e.target.closest('[data-wktb]')
      if (!b || b.dataset.wktb !== 'file') return
      if (e.target.closest('.wk-tb-x')) { closeWkFile(); return } // × = 关掉打开的文件
      state.wkMainTab = 'file'
      applyPanes()
      saveWork()
    })
    // 收敛输入栏末端的箭头 = 正常底栏发送钮的同一枚图标（单源 core/icons.js，勿在 HTML 内联自绘）
    const wap = document.querySelector('.wap-arrow')
    if (wap) wap.innerHTML = I.dshSend
    const ico = document.querySelector('#wk-proj-seat .wk-proj-ico')
    if (ico) ico.innerHTML = I.folder
    const fic = document.querySelector('.wk-foot-ico')
    if (fic) fic.innerHTML = I.logo

    $('wk-proj-seat').addEventListener('click', async (e) => {
      e.stopPropagation() // 同步：先掐断 document 的收起委托，后面的 await 才不会被它提前关掉
      const pop = $('wk-proj-pop')
      const willShow = pop.hidden
      hideWkPops()
      if (!willShow) return
      // 列表还在途中（切到 work 后立刻点开）就先等它落地——绝不给用户弹一个空框，也避免弹完不再更新
      await ensureProjectList()
      renderWorkChrome()
      pop.hidden = false
    })
    $('wk-proj-pop').addEventListener('click', (e) => {
      e.stopPropagation()
      const b = e.target.closest('[data-wkproj]')
      if (b) selectProject(b.dataset.wkproj)
    })
    $('wk-view').addEventListener('click', (e) => {
      e.stopPropagation()
      const pop = $('wk-view-pop')
      const willShow = pop.hidden
      hideWkPops()
      pop.hidden = !willShow
      applyPanes()
    })
    $('wk-view-pop').addEventListener('click', (e) => {
      e.stopPropagation()
      const b = e.target.closest('[data-wkpane]')
      if (b) setPane(b.dataset.wkpane, !b.classList.contains('on'))
    })
    // 加号按 tab 分派：聊天 tab = 直接新建对话；文件 tab = 展开新建菜单（创建/上传，功能待接入）
    $('wk-new').addEventListener('click', (e) => {
      e.stopPropagation() // 同步：先掐断 document 的收起委托，否则菜单刚开就被关掉
      if (wkTab !== 'files') {
        newWorkChat()
        return
      }
      const pop = $('wk-new-pop')
      const willShow = pop.hidden
      hideWkPops()
      pop.hidden = !willShow
    })
    $('wk-new-pop').addEventListener('click', (e) => {
      e.stopPropagation()
      if (!e.target.closest('[data-wknew]')) return
      $('wk-new-pop').hidden = true
      toast('创建 / 上传功能暂未接入')
    })
    document.querySelectorAll('.wk-tab').forEach((b) =>
      b.addEventListener('click', () => {
        wkTab = b.dataset.wktab === 'chat' ? 'chat' : 'files'
        document.querySelectorAll('.wk-tab').forEach((x) => x.classList.toggle('on', x === b))
        renderWorkBody()
      }),
    )
    // 文件树整块由 innerHTML 重渲 → 事件必须委托在容器上（逐行绑定会被下次重渲抹掉）
    $('wk-body').addEventListener('click', (e) => {
      const d = e.target.closest('[data-wkdir]')
      if (d) {
        const p = d.dataset.wkdir
        if (wkOpen.has(p)) wkOpen.delete(p)
        else wkOpen.add(p)
        renderWorkBody()
        return
      }
      const f = e.target.closest('[data-wkfile]')
      if (f) {
        openWorkFile(f.dataset.wkfile)
        return
      }
      const s = e.target.closest('.sess-item')
      if (s && s.dataset.hash) {
        wkEnsureTab(s.dataset.hash) // 显式打开一个会话 = 顶栏占一枚胶囊
        // 点会话 = 明确要看这个会话：聊天 tab 顶上来（否则文件 tab 占着格，看着像「点了没反应」）
        state.wkMainTab = 'chat'
        state.wkAssist = true
        state.wkAssistMode = 'side'
        // 与侧栏会话条目同语义（recent.js bindSessClicks）：已在该会话内不重复 navigate
        if (s.dataset.hash !== state.currentHash) navigate('#/' + encodeURIComponent(s.dataset.hash))
        applyPanes() // 新胶囊 + active 落地
        saveWork()
        if (isMobile()) setPanel(false)
        return
      }
    })
    // 编辑区：Ctrl+S 立即保存（绑在 #work-editor 上；编辑器自身处理其余按键，未消费的键冒泡到此处）
    $('work-editor').addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return
      if (e.key.toLowerCase() === 's') {
        e.preventDefault()
        wkEdSave({ interactive: true })
      }
    })
    $('wk-foot').addEventListener('click', () => toast(state.workspace ? `工作区：${state.workspace}` : '工作区路径未知'))
    // 点空白收起两个浮层（浮层与触发按钮之外的点击都算）
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#wk-proj-pop') && !e.target.closest('#wk-proj-seat')) $('wk-proj-pop').hidden = true
      if (!e.target.closest('#wk-view-pop') && !e.target.closest('#wk-view')) $('wk-view-pop').hidden = true
      if (!e.target.closest('#wk-new-pop') && !e.target.closest('#wk-new')) $('wk-new-pop').hidden = true
    })
    // 后台标签页不做对账（定时器仍在跑，tick 内自会跳过）；切回前台立刻补一次，不等下一个间隔
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') workAutoTick()
    })
  }

  // 启动一次：恢复持久化状态 → 绑定事件 → 落地（顺序不可换：绑定要先于 applySbMode 的渲染，
  // 否则 work 面板首个渲染出来的行（文件树/新聊天）没有容器级委托）
  function initWork() {
    loadWork()
    // 外部卡申报按缓存即时回填（同步、无网络）：刷新后在门解锁前 tab 就在位，/manage/ext:… 直进也有卡
    // 可解析；权威清单由 ensureWork → syncWorkExtCards 拉新覆盖。必须在 loadWork 之后（要知道工作项目）。
    hydrateExtCards(state.workProj)
    mountWork()
    applySbMode()
  }

