// work 模式侧栏 + 主区编辑区（2026-09-25，参考 Prism）（唯一手改处，web/app.js 为生成物）

import { navigate } from '../chat/route.js'
import { needToken, apiUrl } from '../core/gateway.js'
import { I } from '../core/icons.js'
import { mdHtml } from '../core/markdown.js'
import { ALL, chatArea, esc, isMobile, loadWork, saveWork, state, toast } from '../core/state.js'
import { loadSessions, sessCmp } from '../core/sessions.js'
import { itemHtml, setPanel } from './recent.js'
  // ---------- work 模式侧栏（Prism 式） ----------
  // 状态源 = core/state.js 的 sbMode / projects / workspace / workProj / workFile / wkEditor / wkAssist
  // （localStorage floria-ui-v1 持久化，见 saveWork/loadWork）。数据源全部是现成端点，本模块零后端改动：
  //   项目列表 → /gateway/sessions 的 groups（sessions.js 顺带存进 state.projects）
  //   文件树   → GET /gateway/project?label=  的 files（walkProjectTree，深度 3 / 每层 50）
  //   单文件   → GET /gateway/file?label=&path=（只读原始字节，带路径穿越防护 + 4MB 上限）
  // 主区：sbMode=work → #chat-area 加 .work（flex-direction:row），#work-editor 与 #session-card
  // 并排成两栏；两栏开关只控制显隐，**至少保留一栏**（全关会让主区空白，属无效态）。
  // 与「管理/预览卡」互斥：那两者是 chat 模式的视图，route.js 进入 mgr/preview 时会调 setSbMode('chat')。

  const IMG_EXT = /\.(png|jpe?g|webp|gif|svg|bmp|ico|avif)$/i
  const MD_EXT = /\.(md|markdown)$/i
  let wkTab = 'files'      // 'files' | 'chat'
  let wkTree = null        // 当前项目文件树（/gateway/project 的 files）；null = 未加载
  let wkFilter = ''        // 文件过滤词（前端过滤，不重拉）
  let wkLoading = false
  let wkErr = ''
  const wkOpen = new Set() // 已展开目录（项目内相对路径）
  let edSeq = 0            // 编辑区读取序号：快速连点文件时丢弃迟到的旧响应

  function setSbMode(mode) {
    state.sbMode = mode === 'work' ? 'work' : 'chat'
    applySbMode()
    saveWork()
  }

  // 面板与主区布局按 state 落地。启动恢复与运行期切换共用这一条路径（无第二份初始化旁路）。
  function applySbMode() {
    const on = state.sbMode === 'work'
    document.querySelectorAll('.ms-btn').forEach((b) => b.classList.toggle('on', b.dataset.sbmode === state.sbMode))
    // #panel.work：work 模式下隐藏顶栏 #panel-search（会话搜索的 chat 模式入口）——work 的 🔍 已覆盖
    // 当前 tab 的过滤，两者同为放大镜同屏并存即「两个搜索」的重复观感（样式见 styles.css 该段）
    $('panel').classList.toggle('work', on)
    $('chat-panel').hidden = on
    $('work-panel').hidden = !on
    chatArea.classList.toggle('work', on)
    if (!on) chatArea.classList.remove('hide-editor', 'hide-assist', 'wk-file-open')
    applyPanes()
    if (on) ensureWork()
    else hideWkPops()
  }

  // 两栏开关落地。不变量：编辑区与助手至少一栏可见（都关 → 强制回助手栏）。
  function applyPanes() {
    if (state.sbMode === 'work') {
      if (!state.wkEditor && !state.wkAssist) state.wkAssist = true
      chatArea.classList.toggle('hide-editor', !state.wkEditor)
      chatArea.classList.toggle('hide-assist', !state.wkAssist)
    }
    document.querySelectorAll('.wkv-row').forEach((b) => {
      b.classList.toggle('on', b.dataset.wkpane === 'editor' ? state.wkEditor : state.wkAssist)
    })
  }

  function hideWkPops() {
    for (const id of ['wk-proj-pop', 'wk-view-pop']) {
      const el = $(id)
      if (el) el.hidden = true
    }
  }

  function setPane(k, on) {
    if (k === 'editor') state.wkEditor = on
    else state.wkAssist = on
    if (!state.wkEditor && !state.wkAssist) {
      if (k === 'editor') state.wkEditor = true
      else state.wkAssist = true
      toast('至少保留一栏')
    }
    applyPanes()
    saveWork()
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

  function renderWorkBody() {
    const body = $('wk-body')
    if (!body) return
    if (wkTab === 'chat') {
      // 列表 = 当前项目下的会话，条目渲染复用 recent.js 的 itemHtml（与侧栏「项目展开」同一份实现，
      // 不另写一套行）；行菜单（…）依赖 #recent-body 机制，此处 more:false 关掉。
      const f = wkFilter.trim().toLowerCase()
      const list = state.workProj
        ? ALL.filter((s) => s.projectScope === 'project' && s.projectLabel === state.workProj)
            .sort(sessCmp)
            .filter((s) => !f || String(s.title || '').toLowerCase().includes(f))
        : []
      const rows = !state.workProj
        ? '<div class="wk-empty">先在上方选择一个项目</div>'
        : list.length
          ? `<div class="wk-chats">${list.map((s) => itemHtml(s, false, { more: false })).join('')}</div>`
          : `<div class="wk-empty">${f ? '没有匹配的聊天' : '该项目还没有聊天'}</div>`
      body.innerHTML =
        `<div class="wk-newchat-wrap"><button class="wk-newchat" id="wk-newchat">${I.dshPlus}<span>新聊天</span></button></div>` +
        rows
      return
    }
    if (!state.workProj) {
      body.innerHTML = '<div class="wk-empty">先在上方选择一个项目</div>'
      return
    }
    if (wkLoading) {
      body.innerHTML = '<div class="wk-empty">加载中…</div>'
      return
    }
    if (wkErr) {
      body.innerHTML = `<div class="wk-empty">${esc(wkErr)}</div>`
      return
    }
    if (!wkTree || !wkTree.length) {
      body.innerHTML = '<div class="wk-empty">项目内没有可列出的文件</div>'
      return
    }
    const f = wkFilter.trim().toLowerCase()
    body.innerHTML = wkTreeHtml(wkTree, 0, '', f) || '<div class="wk-empty">没有匹配的文件</div>'
  }

  // 目录命中判定：过滤词命中自身或任一子孙即保留（否则目录被过滤掉，里面的命中项也没了）
  function wkNodeHit(n, f) {
    if (!f) return true
    if (String(n.name).toLowerCase().includes(f)) return true
    return (n.children || []).some((c) => wkNodeHit(c, f))
  }

  function wkTreeHtml(nodes, depth, prefix, f) {
    let h = ''
    for (const n of nodes || []) {
      if (!wkNodeHit(n, f)) continue
      const p = prefix ? `${prefix}/${n.name}` : n.name
      const pad = `padding-left:${8 + depth * 13}px`
      if (n.type === 'dir') {
        const open = wkOpen.has(p)
        h += `<button class="wk-row dir${open ? ' open' : ''}" data-wkdir="${esc(p)}" style="${pad}" title="${esc(p)}">`
        // 图标 SVG 无自带尺寸，必须落在有 svg 尺寸规则的 slot 里——裸插会取替换元素默认 300×150（巨型图标撑爆行高）
        h += `<span class="wk-chev">${open ? I.dshChevDown : I.dshChevRight}</span><span class="wk-fic">${I.folder}</span>`
        h += `<span class="wk-name">${esc(n.name)}</span></button>`
        if (open) h += wkTreeHtml(n.children, depth + 1, p, f)
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
  async function loadProjectTree(label) {
    if (!label || needToken()) return
    wkLoading = true
    wkErr = ''
    wkTree = null
    renderWorkBody()
    try {
      const res = await fetch(apiUrl('/gateway/project?label=' + encodeURIComponent(label)))
      const data = await res.json()
      if (!res.ok || data.error) throw new Error(data.error || '加载失败')
      wkTree = Array.isArray(data.files) ? data.files : []
    } catch (e) {
      wkErr = e.message || String(e)
    } finally {
      wkLoading = false
      renderWorkBody()
    }
  }

  async function selectProject(label) {
    hideWkPops()
    if (!label || label === state.workProj) return
    state.workProj = label
    state.workFile = ''
    wkOpen.clear()
    wkFilter = ''
    const fi = $('wk-find-input')
    if (fi) fi.value = ''
    renderWorkChrome()
    saveWork()
    renderEditor()
    await loadProjectTree(label)
  }

  async function refreshWork() {
    hideWkPops()
    try {
      await loadSessions()
    } catch {
      /* 列表刷新失败不阻断文件树刷新 */
    }
    renderWorkChrome()
    if (state.workProj) await loadProjectTree(state.workProj)
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
  // loadProjectTree 早退 ⇒ 刷新后恢复的 workProj/workFile 无树、编辑区 401，须由 core/auth.js hideGate
  // 的「门后补拉」链再调一次（与 mgr/models/neurons 数据同点，见该文件同名注释）。
  async function ensureWork() {
    renderWorkChrome()
    renderWorkBody()
    renderEditor()
    await ensureProjectList()
    renderWorkChrome()
    if (state.workProj && !wkTree && !wkLoading && !wkErr) await loadProjectTree(state.workProj)
  }

  // ---------- 编辑区（主区左栏，只读） ----------
  function fileUrl(p) {
    return apiUrl(`/gateway/file?label=${encodeURIComponent(state.workProj)}&path=${encodeURIComponent(p)}`)
  }

  function renderEditor() {
    const pathEl = $('wk-ed-path')
    const body = $('wk-ed-body')
    if (pathEl) pathEl.textContent = state.workFile || ''
    if (!body) return
    if (!state.workFile) {
      body.innerHTML = '<div class="wk-ed-empty">从左侧文件树选择一个文件</div>'
      return
    }
    if (!state.workProj) {
      body.innerHTML = '<div class="wk-ed-empty">未选择项目</div>'
      return
    }
    readFile(state.workFile)
  }

  async function readFile(p) {
    const body = $('wk-ed-body')
    if (!body) return
    const seq = ++edSeq
    if (IMG_EXT.test(p)) {
      body.innerHTML = `<div class="wk-ed-img"><img src="${esc(fileUrl(p))}" alt="${esc(p)}" /></div>`
      return
    }
    body.innerHTML = '<div class="wk-ed-empty">读取中…</div>'
    try {
      const res = await fetch(fileUrl(p))
      if (seq !== edSeq) return
      if (!res.ok) {
        body.innerHTML = `<div class="wk-ed-empty">${esc(
          res.status === 413 ? '文件超过 4 MB，不支持预览' : res.status === 403 ? '该项目外的路径不可访问' : `读取失败（HTTP ${res.status}）`,
        )}</div>`
        return
      }
      const ct = (res.headers.get('content-type') || '').toLowerCase()
      const looksText = /^text\/|json|javascript|typescript|xml|svg|x-sh|csv|yaml/.test(ct) || MD_EXT.test(p)
      if (!looksText) {
        body.innerHTML = `<div class="wk-ed-empty">二进制文件（${esc(ct || '未知类型')}），不支持预览</div>`
        return
      }
      const text = await res.text()
      if (seq !== edSeq) return
      body.innerHTML = MD_EXT.test(p)
        ? `<div class="wk-ed-md md">${mdHtml(text)}</div>`
        : `<pre class="wk-code">${esc(text)}</pre>`
    } catch (e) {
      if (seq !== edSeq) return
      body.innerHTML = `<div class="wk-ed-empty">读取失败：${esc(e.message || e)}</div>`
    }
  }

  function openWorkFile(p) {
    if (!p) return
    state.workFile = p
    // 编辑区被开关关掉时点文件 = 明确要看内容 → 自动把编辑区打开（不静默什么都不发生）
    if (!state.wkEditor) {
      state.wkEditor = true
      applyPanes()
    }
    saveWork()
    renderWorkBody()
    renderEditor()
    // 手机端两栏不成立：编辑区以覆盖层打开（.wk-file-open 由 CSS 接管），返回键收起
    if (isMobile()) {
      chatArea.classList.add('wk-file-open')
      $('work-panel').hidden = true
    }
  }

  function closeWorkFile() {
    chatArea.classList.remove('wk-file-open')
    if (state.sbMode === 'work') $('work-panel').hidden = false
  }

  function newWorkChat() {
    // 新会话落在当前 work 项目下（沿用 state.newProject 契约：首条消息按它落项目）。
    // 不切回 chat 模式：#/ 空态由 renderHome() 渲染进会话卡（非视图卡），work 两栏布局照样成立；
    // 模式互斥只对 mgr/preview 两张视图卡生效（route.js 内那一处 setSbMode('chat')）。
    state.newProject = state.workProj || null
    navigate('#/')
    if (isMobile()) setPanel(false)
  }

  // ---------- 事件 ----------
  function mountWork() {
    $('wk-refresh').innerHTML = I.refresh
    $('wk-find').innerHTML = I.mag
    $('wk-view').innerHTML = I.toggle
    $('wk-ed-back').innerHTML = I.collapse
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
    $('wk-refresh').addEventListener('click', () => refreshWork())
    $('wk-find').addEventListener('click', () => {
      const row = $('wk-find-row')
      row.hidden = !row.hidden
      // 过滤词作用于「当前 tab」——文件 tab 滤文件名/路径、聊天 tab 滤会话标题（同一 wkFilter，各自判据）
      if (!row.hidden) $('wk-find-input').focus()
      else if (wkFilter) {
        wkFilter = ''
        $('wk-find-input').value = ''
        renderWorkBody()
      }
    })
    $('wk-find-input').addEventListener('input', (e) => {
      wkFilter = e.target.value
      renderWorkBody()
    })
    document.querySelectorAll('.wk-tab').forEach((b) =>
      b.addEventListener('click', () => {
        wkTab = b.dataset.wktab === 'chat' ? 'chat' : 'files'
        // 两个 tab 的过滤判据不同，切 tab 时清词（否则会以旧词在新 tab 里给出「没有匹配」的假空态）
        wkFilter = ''
        const fi = $('wk-find-input')
        if (fi) fi.value = ''
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
        // 与侧栏会话条目同语义（recent.js bindSessClicks）：已在该会话内不重复 navigate
        if (s.dataset.hash !== state.currentHash) navigate('#/' + encodeURIComponent(s.dataset.hash))
        if (isMobile()) setPanel(false)
        return
      }
      if (e.target.closest('#wk-newchat')) newWorkChat()
    })
    $('wk-ed-back').addEventListener('click', closeWorkFile)
    $('wk-foot').addEventListener('click', () => toast(state.workspace ? `工作区：${state.workspace}` : '工作区路径未知'))
    // 点空白收起两个浮层（浮层与触发按钮之外的点击都算）
    document.addEventListener('click', (e) => {
      if (!e.target.closest('#wk-proj-pop') && !e.target.closest('#wk-proj-seat')) $('wk-proj-pop').hidden = true
      if (!e.target.closest('#wk-view-pop') && !e.target.closest('#wk-view')) $('wk-view-pop').hidden = true
    })
    // 窗口跨越手机断点时收起覆盖层：两栏本身能重新排开，覆盖层留着会挡住助手
    window.addEventListener('resize', () => {
      if (!isMobile() && chatArea.classList.contains('wk-file-open')) closeWorkFile()
    })
  }

  // 启动一次：恢复持久化状态 → 绑定事件 → 落地（顺序不可换：绑定要先于 applySbMode 的渲染，
  // 否则 work 面板首个渲染出来的行（文件树/新聊天）没有容器级委托）
  function initWork() {
    loadWork()
    mountWork()
    applySbMode()
  }

export {
  applySbMode,
  ensureWork,
  initWork,
  setSbMode,
}
