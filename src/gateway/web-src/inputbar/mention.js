// @ 提及浮窗 + 输入变化入口（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { messagesHtml, addUser } from '../chat/messages.js'
import { GATEWAY, gateAwait, apiUrl } from '../engine/gateway.js'
import { I } from '../core/icons.js'
import { mdInline, relTime } from '../core/markdown.js'
import { MENTION_FILE_ICON, MENTION_PATH_RE, MENTION_PLUGIN_RE, MENTION_SESSION_ICON, MENTION_SESSION_RE, QUOTE_PDF_RE, QUOTE_REF_RE, QUOTE_REPLY_RE, mentionChipHtml, quotePdfChipHtml, quoteRefChipHtml, quoteReplyChipHtml, splitSessionToken } from '../core/mention-syntax.js'
import { findSession, sessionCwd } from '../engine/sessions.js'
import { inputEl, state } from '../engine/state.js'
import { esc, newSessionProject } from '../core/util.js'
import { syncGwSend } from './send.js'
import { uploadedMentionItems } from './images.js'
import { MGR, loadMgrData } from '../sidebar/mgr-data.js'
/* @module inputbar/mention.js */
  // ---------- @ 提及（2026-08-15）：输入 @ 弹出「近48h 会话 + 插件/技能」浮窗（2026-09-18 会话区提前），选中插入内联 chip ----------
  // 消息文本中 chip 序列化为 [插件:名称] / [会话:名称] 令牌（CLI 终端渲染为 [名称]，遥测端渲染为 chip；
  // 令牌保留 kind 供两端差异化渲染 + 未来插件激活扩展）。
  // @ 提及 icon（2026-09-28 换 dsh v0.2.0-rc.1 产品图标集，16 描线/currentColor；旧 24 手绘那套作废）。
  // 语义与 dsh 一致：会话=ChatLines、插件=PluginPinwheel、技能=Skill、目录=FolderClose、文件=Browse
  // ——与 + 浮窗行图标同源（同一批 I.* 常量），两处不得分叉。会话/文件两枚随 chip 构造器下移 core/mention-syntax.js。
  const MENTION_PLUGIN_ICON = I.dshPlugin
  const MENTION_SKILL_ICON = I.dshSkill
  // ---------- 目录 / 文件引用（2026-09-26）：@ 浮窗与 + 工具栏共用的一组「逐级浏览工作区根」状态 ----------
  // 数据源 = GET /gateway/fs?path=<相对工作区根的子路径>（只读单层；网关侧复用 listOneLevel，跳过隐藏项
  // 与重型目录、目录在前、每层 ≤50）。pick.path 是**相对工作区根**的当前层路径，'' = 根——与 chip 上行的
  // 路径同基准（用户定案：相对全局根）。令牌形态 [@目录:路径] / [@文件:路径] 见 core/mention-syntax.js。
  const QUOTE_REPLY_BODY_RE = /\[@引用回复:(\d+)\|([^\]]*)\]\n[\s\S]*?\n\[\/引用回复\]/g
  const QUOTE_PDF_BODY_RE = /(\[@引用PDF:[^\]]*\])\n[\s\S]*?\n\[\/引用PDF\]/g
  const MENTION_DIR_ICON = I.dshFolder
  const MENTION_UP_ICON = I.dshUp
  // CM6 接管后 sentinel（零宽 DOM 锚）退役：@ 查询锚点 = doc 位置 anchor（'@' 所在 pos）
  let mention = { open: false, anchor: 0, q: '', items: [], sel: 0 }
  // entries: null=未加载；[]=空目录；[TreeNode…]=已加载。seq 丢弃迟到的旧响应（快速连点目录）。
  // searchOff：搜索/浏览模式开关（2026-10-14 待办 20）——false 且查询非空 = 全局搜索模式；
  // 下钻/返回目录后翻 true（回到层内浏览），浮窗重开（refreshPick）复位 false。
  const pick = { path: '', entries: null, loading: false, err: '', seq: 0, searchOff: false, q: '' }
  // 全工作区递归清单（待办 20 的数据层）：BFS 逐层 /gateway/fs（每层并发），层间 await。
  // 上限：目录 ≤250 / 条目 ≤2000 / 深度 ≤4——够覆盖散件与项目浅层，防全库深扫拖垮浮窗。
  // 浮窗每次打开经 refreshPick 重置重建（目录内容是外部可变状态，不跨打开缓存）。
  const pickAll = { items: null, busy: false, seq: 0 }

  // ---------- 分组序 + 每组上限（两个浮窗的唯一真源）----------
  // 组序固定为「上传 → 聊天 → 文件 → 技能 → 指令」，每组只列 GROUP_MAX 行；两处浮窗都走 arrangeItems，
  // 新增条目只声明 kind、不各自排位（否则两处排位迟早分叉）。
  const GROUP_ORDER = ['上传', '聊天', '文件', '技能', '指令']
  const GROUP_MAX = 3
  const GROUP_OF = { imgpick: '上传', filepick: '上传', session: '聊天', plugin: '技能', skill: '技能', path: '文件', pathup: '文件' }
  function groupOf(it) {
    return GROUP_OF[it.kind] || '指令'
  }
  // 组排序 + 每组截断。**「上级目录」是导航行**：既排在本组最前、也不占列表名额——截到 3 行的是可选项，
  // 导航入口被截掉会让子目录变成死层。
  function arrangeItems(items) {
    const seen = {}
    const kept = items.filter((it) => {
      if (it.kind === 'pathup') return true
      if (it.glob) return true // 全局搜索命中（待办 20）：就是要看的重点结果，不受每组 3 行截断
      const g = groupOf(it)
      seen[g] = (seen[g] || 0) + 1
      return seen[g] <= GROUP_MAX
    })
    return kept
      .map((it, i) => ({ it, i, g: GROUP_ORDER.indexOf(groupOf(it)) }))
      .sort((a, b) => (a.g - b.g) || (a.i - b.i))
      .map((x) => x.it)
  }

  // ---------- 目录 / 文件浏览（数据层；两个浮窗共用，渲染各自负责） ----------
  // 文件组的落点 = 当前上下文项目目录（用户定案「先显示本项目的文件」）：会话态取该会话所属项目，
  // 非会话态取目标项目（`newSessionProject()`——work 模式即工作项目）。空串 = 无项目上下文 → 从工作区根起。
  function pickHome() {
    const s = state.currentHash ? findSession(state.currentHash) : null
    if (s) return s.projectScope === 'project' && s.projectLabel ? s.projectLabel : ''
    return newSessionProject() || ''
  }
  function pickParent() {
    const p = pick.path
    const i = p.lastIndexOf('/')
    return i < 0 ? '' : p.slice(0, i)
  }
  function pickLabel() {
    // 搜索模式（2026-10-14 待办 20）：文件组标题提示结果口径（层内浏览则照旧标当前层）
    if (pick.q && !pick.searchOff) return pickAll.items ? '工作区全局搜索' : '全局搜索…'
    if (pick.loading) return '加载中…'
    if (pick.err) return '加载失败'
    return pick.path || '工作区根'
  }
  // 构建全工作区递归清单（幂等；构建期间 busy 挡重入，seq 丢弃被 refreshPick 作废的旧轮）。
  // 完成不自行重渲——由调用方的 after 回调负责（浮窗还开着才重渲）。
  async function ensurePickAll() {
    if (pickAll.items || pickAll.busy) return
    pickAll.busy = true
    const seq = ++pickAll.seq
    const out = []
    let layer = [{ p: '', d: 0 }]
    const seen = new Set()
    try {
      while (layer.length && seen.size < 250 && out.length < 2000) {
        const next = []
        await Promise.all(
          layer.map(async ({ p, d }) => {
            try {
              const r = await fetch(apiUrl('/gateway/fs?path=' + encodeURIComponent(p)))
              const data = await r.json()
              if (!r.ok || !data || !Array.isArray(data.entries)) return
              for (const e of data.entries) {
                const cp = p ? `${p}/${e.name}` : e.name
                out.push({ ptype: e.type === 'dir' ? 'dir' : 'file', name: e.name, path: cp })
                if (e.type === 'dir' && d < 4 && !seen.has(cp) && seen.size < 250) {
                  seen.add(cp)
                  next.push({ p: cp, d: d + 1 })
                }
              }
            } catch { /* 单层失败跳过，不拖垮整轮 */ }
          }),
        )
        if (seq !== pickAll.seq) return
        layer = next
      }
    } finally {
      if (seq === pickAll.seq) {
        pickAll.items = out
        pickAll.busy = false
      }
    }
  }
  // 搜索模式的异步补拉口（两个浮窗的渲染函数各调一次）：查询非空且处于搜索模式、清单未建 →
  // 建清单，完成后浮窗仍开着才重渲。
  function pickSearchKick(re) {
    if (pick.q && !pick.searchOff && !pickAll.items && !pickAll.busy) ensurePickAll().then(re).catch(() => {})
  }
  // 加载某一层（path 相对工作区根）。完成后由调用方重渲自己的浮窗（本函数不碰 DOM）。
  async function loadPickPath(path) {
    const seq = ++pick.seq
    pick.path = String(path || '')
    pick.loading = true
    pick.err = ''
    try {
      const res = await fetch(apiUrl('/gateway/fs?path=' + encodeURIComponent(pick.path)))
      const data = await res.json()
      if (seq !== pick.seq) return false
      if (!res.ok || data.error) throw new Error(data.error || '加载失败')
      pick.entries = Array.isArray(data.entries) ? data.entries : []
    } catch (e) {
      if (seq !== pick.seq) return false
      pick.entries = null
      pick.err = e.message || String(e)
    } finally {
      if (seq === pick.seq) pick.loading = false
    }
    return seq === pick.seq
  }
  // 当前层的可选条目 / 全局搜索结果（2026-10-14 待办 20）。
  // q 为空或已下钻（searchOff）= 原层内浏览：上级目录行 + 当前层按 q 过滤。
  // q 非空且未下钻 = 全局搜索：跨工作区递归清单（pickAll）按名称过滤，glob 标记免组截断，
  // 上限 30 行防溢屏。清单未就绪时文件组暂空（其余组照常），pickSearchKick 建完重渲补上。
  // 「上级目录」只取决于「当前是不是工作区根」，与**这一层的内容**无关——故加载中/加载失败时它照样在，
  // 否则某一层拉不到（目录已删/端点失败）就退不回去，整个文件组成死层。条目本身不塞假行。
  function pickItems(q) {
    const ql = (q || '').trim().toLowerCase()
    pick.q = ql
    const items = []
    if (ql && !pick.searchOff) {
      if (!pickAll.items) return items
      for (const e of pickAll.items) {
        if (!e.name.toLowerCase().includes(ql)) continue
        items.push({ kind: 'path', ptype: e.ptype, name: e.name, path: e.path, glob: true })
        if (items.length >= 30) break
      }
      return items
    }
    if (pick.path) items.push({ kind: 'pathup', name: '上级目录', path: pickParent() })
    if (pick.loading || !pick.entries) return items
    for (const e of pick.entries) {
      if (ql && !String(e.name).toLowerCase().includes(ql)) continue
      const p = pick.path ? `${pick.path}/${e.name}` : e.name
      items.push({ kind: 'path', ptype: e.type === 'dir' ? 'dir' : 'file', name: e.name, path: p })
    }
    return items
  }
  // 目录项进入下一层 / 上级目录返回（两个浮窗的选择入口共用同一处判定）。下钻 = 用户已明确
  // 「要看这个位置」→ 翻回层内浏览模式（此后 q 只做层内过滤，不再全局搜）。
  function pickEnter(it) {
    pick.searchOff = true
    return loadPickPath(it.path)
  }
  function mentionChipIcon(kind, ptype) {
    if (kind === 'session') return MENTION_SESSION_ICON
    if (kind === 'path' || kind === 'filepick' || kind === 'imgpick') return ptype === 'dir' ? MENTION_DIR_ICON : MENTION_FILE_ICON
    if (kind === 'skill') return MENTION_SKILL_ICON
    return MENTION_PLUGIN_ICON
  }
  // 输入栏内联 chip 的 HTML（@ 插入与 + 工具栏追加共用一份，勿各写一套）
  function mentionChipInner(kind, name, ptype) {
    const label = kind === 'path' ? '@' + name : name
    return `<span class="m-ic">${mentionChipIcon(kind, ptype)}</span><span class="m-nm">${esc(label)}</span><span class="m-x" title="删除">×</span>`
  }
  function buildMentionChip(kind, name, sid, ptype) {
    const chip = document.createElement('span')
    chip.className = 'mention'
    chip.contentEditable = 'false'
    chip.dataset.kind = kind
    chip.dataset.name = name
    if (kind === 'session' && sid) chip.dataset.sid = sid
    if (kind === 'path') chip.dataset.ptype = ptype === 'dir' ? 'dir' : 'file'
    chip.innerHTML = mentionChipInner(kind, name, ptype)
    return chip
  }

  // chip HTML 构造器（mentionChipHtml / quote*ChipHtml）与令牌正则、splitSessionToken 已下移
  // core/mention-syntax.js（core 叶子，供 core/markdown.js 与本源共用，断开 core→feature 成环）。

  // 引用 chip → 消息文本。两条链的落地形态刻意不同（用户定案 2026-09-28）：
  //  文件引用 = 只给位置，模型自己 Read；
  //  回复引用 = 原文必须进消息——回复不属于任何文件，没有位置可查。原文包在令牌块里（`QUOTE_REPLY_BODY_RE`），
  //  渲染层整块剥掉只留锚点令牌 → 胶囊。首尾不留多余换行（留了会撑出多余行距，2026-09-28 用户实报「自带一个换行」）。
  function refToken(d) {
    if (d.rkind === 'pdf') {
      const p = refPath(d.file, d.proj)
      const loc = d.p0 ? `#p${d.p0}${d.p1 && d.p1 !== d.p0 ? '-' + d.p1 : ''}` : ''
      return `[@引用PDF:${p}${loc}]\n${String(d.quote || '')}\n[/引用PDF]`
    }
    if (d.rkind !== 'file') {
      const title = String(d.title || '本会话').replace(/[\]|\r\n]/g, ' ').trim() || '本会话'
      return `[@引用回复:${d.idx || 0}|${title}]\n${String(d.quote || '')}\n[/引用回复]`
    }
    const p = refPath(d.file, d.proj)
    return d.l0 ? `[@引用:${p}#L${d.l0}-${d.l1}]` : `[@引用:${p}]`
  }

  // 引用路径基准 = 模型能直接 Read 的形式：会话启动根（模型 cwd）就是该 work 项目本身时用项目内
  // 相对路径；否则带项目 label（工作区相对——会话开在别的项目下时仍指向同一文件）。cwd 未知同样带 label。
  function refPath(file, proj) {
    const cwd = String(sessionCwd || '').replace(/\\/g, '/').replace(/\/+$/, '')
    if (proj && cwd.split('/').pop() === proj) return file
    return proj ? proj + '/' + file : file
  }

  // 引用**原文块**在气泡里必须消失：整块压回单一锚点令牌，再由 QUOTE_REPLY_RE / QUOTE_PDF_RE 出胶囊。
  // 原文只是给模型看的 payload（模型侧原文不动），气泡里只留胶囊。三个渲染入口
  // （messages.js userBodyHtml / approval.js renderTransient 的 bodyText 与队列 txt）在渲染前先过这里。
  // 回复块与 PDF 块共用这一个收口（两族形态不同，但不该有第三个剥块入口）。
  function stripQuoteBodies(text) {
    return String(text || '')
      .replace(QUOTE_REPLY_BODY_RE, '[@引用回复:$1|$2]')
      .replace(QUOTE_PDF_BODY_RE, '$1')
  }

  // 实时回显的用户消息：把令牌转 chip（与离线 messagesHtml 的 mdInline 一致）
  function renderUserText(text) {
    return esc(text)
      .replace(MENTION_PLUGIN_RE, (_, n) => mentionChipHtml('plugin', n))
      .replace(MENTION_SESSION_RE, (_, n) => mentionChipHtml('session', n))
      .replace(MENTION_PATH_RE, (_, t, p) => mentionChipHtml('path', p, t === '目录' ? 'dir' : 'file'))
      .replace(QUOTE_REF_RE, (_, p, a, b) => quoteRefChipHtml(p, a, b))
      .replace(QUOTE_REPLY_RE, (_, i, t) => quoteReplyChipHtml(i, t))
      .replace(QUOTE_PDF_RE, (_, p, a, b) => quotePdfChipHtml(p, a, b))
  }

  // 序列化 = CM doc 原文（2026-10-14 CM6 接管）：令牌文本本就是序列化形态、chip 是它的装饰视图，
  // doc 单真源 ⇒ serializeInput 退化为 doc.toString()。签名与语义冻结（接缝不变量）。
  function serializeInput() {
    return composerDocText()
  }

  function closeMentionPop() {
    mention.open = false
    mention.anchor = 0
    mention.q = ''
    mention.items = []
    mention.sel = 0
    const pop = $('mention-pop')
    if (pop) pop.hidden = true
  }

  function openMentionPopAtCaret() {
    if (!cmView) return
    mention.open = true
    mention.anchor = cmView.state.selection.main.from - 1 // '@' 的 doc 位置（composer onInputMention 判定后调）
    mention.sel = 0
    mention.q = ''
    renderMentionPop()
    // 首次打开确保插件/技能清单已加载（异步），加载完用当前查询重新渲染
    loadMgrData().then(() => { if (mention.open) renderMentionPop() }).catch(() => {})
    refreshPick(() => { if (mention.open) renderMentionPop() })
  }

  // 浮窗打开时定位到当前上下文项目并加载该层（不缓存：目录内容是外部可变状态，缓存会让新建的文件不可见）。
  // **每次打开都回到项目层**（同 @ 浮窗每次打开重置 q/sel）——打开是新的一轮手势，不是接着上次浏览的位置；
  // 层内下钻/返回由 pickEnter 自己拉，走同一处 loadPickPath。
  function refreshPick(after) {
    pick.entries = null // 立刻清旧层：否则换项目后先闪一帧上一个项目的条目（在途请求由 loadPickPath 的 seq 作废）
    pick.err = ''
    pick.searchOff = false // 浮窗重开 = 新一轮手势：回到全局搜索模式（待办 20）
    pickAll.items = null // 递归清单随打开重建（目录内容外部可变，不跨打开缓存；在途轮由 seq 作废）
    pickAll.seq++
    // 作废在途轮时必须同步释放 busy：旧轮 finally 见 seq 不符只跳过写回、不会复位 busy，
    // 否则下一次输入永远起不了新轮（文件搜索整组空白）
    pickAll.busy = false
    loadPickPath(pickHome()).then((ok) => { if (ok && after) after() })
  }

  function mentionItems(q) {
    const ql = (q || '').trim().toLowerCase()
    const match = (s) => !ql || String(s).toLowerCase().includes(ql)
    const items = []
    // 会话：**空查询**只给近 48h 建议（免浮窗一开就几百条）；**有查询词**时搜全量——标题检索必须与
    // 侧栏一致，不能因会话旧于 48h 就查不到（2026-10-17 用户实测：侧栏有「202610131215-有机随想」，
    // 输入 @2026101312 却只剩文件命中）。
    const cutoff = Date.now() - 48 * 3600 * 1000
    // 「上传」组（待办 6）：本次上传的附件（图片/文件），选中插回正文 md 引用。排最前（GROUP_ORDER 亦首位）。
    for (const u of uploadedMentionItems()) if (match(u.name)) items.push(u)
    for (const s of [...ALL].filter((x) => ql || x.updatedAt >= cutoff).sort((a, b) => b.updatedAt - a.updatedAt)) {
      // sid = 会话转录文件名主干，与会话间协作的寻址键同源（engine/sessions.js hashOf = 路由 hash）
      if (match(s.title || '')) items.push({ kind: 'session', name: s.title || '未命名会话', sid: hashOf(s), desc: relTime(s.updatedAt) })
    }
    if (MGR) {
      for (const p of (MGR.plugins && MGR.plugins.personal) || []) if (match(p.n)) items.push({ kind: 'plugin', name: p.n, desc: p.d })
      for (const s of (MGR.skills && MGR.skills.personal) || []) if (match(s.n)) items.push({ kind: 'skill', name: s.n, desc: s.d })
    }
    items.push(...pickItems(q))
    return arrangeItems(items)
  }

  function renderMentionPop() {
    const pop = $('mention-pop')
    if (!pop || !mention.open) return
    const items = mentionItems(mention.q)
    const searching = pick.q && !pick.searchOff && !pickAll.items
    pickSearchKick(() => { if (mention.open) renderMentionPop() }) // 搜索清单未就绪 → 建完补渲（待办 20）
    if (!items.length && searching) {
      // 清单在建：占位不关窗（一关就永远等不到补渲），到位后由 pickSearchKick 重渲出真结果
      pop.innerHTML = '<div class="mp-sec">文件 · 全局搜索…</div>'
      pop.hidden = false
      return
    }
    if (!items.length) { closeMentionPop(); return }
    mention.items = items
    mention.sel = Math.min(mention.sel, items.length - 1)
    let html = ''
    let lastGroup = ''
    let idx = 0
    for (const it of items) {
      const g = groupOf(it)
      const group = g === '文件' ? '文件 · ' + pickLabel() : g
      if (group !== lastGroup) { html += `<div class="mp-sec">${esc(group)}</div>`; lastGroup = group }
      const on = idx === mention.sel ? ' on' : ''
      const icon = `<span class="mp-ic">${it.kind === 'pathup' ? MENTION_UP_ICON : mentionChipIcon(it.kind, it.ptype)}</span>`
      const desc = it.kind === 'path' ? it.path : it.desc
      html += `<button type="button" class="mp-item${on}" data-idx="${idx}">${icon}<span class="mp-t"><span class="mp-nm">${esc(it.name)}</span>${desc ? `<span class="mp-d">${esc(desc)}</span>` : ''}</span></button>`
      idx++
    }
    pop.innerHTML = html
    pop.hidden = false
    pop.querySelectorAll('.mp-item').forEach((b) =>
      b.addEventListener('click', () => {
        const it = mention.items[+b.dataset.idx]
        if (it) selectMentionItem(it)
      }),
    )
  }

  // 条目落地的唯一入口（点击与回车共用）：目录/上级=下钻重渲；文件=插 chip；会话/技能=插 chip。
  function selectMentionItem(it) {
    if (it.kind === 'pathup' || (it.kind === 'path' && it.ptype === 'dir')) {
      pickEnter(it).then(() => { if (mention.open) renderMentionPop() })
      return
    }
    // 已上传附件（待办 6）：把正文 md 引用原文写回 doc（与自动插入同一形态，CM 行内直渲）。
    if (it.kind === 'imgpick' || it.kind === 'filepick') {
      const pos = cmView ? cmView.state.selection.main.from : mention.anchor
      composerReplaceRange(mention.anchor, pos, it.md + ' ')
      closeMentionPop()
      syncGwSend()
      return
    }
    if (it.kind === 'path') insertMention('path', it.path, '', 'file')
    else insertMention(it.kind, it.name, it.sid)
  }

  function moveMentionSel(d) {
    const n = mention.items.length
    if (!n) return
    mention.sel = (mention.sel + d + n) % n
    const pop = $('mention-pop')
    if (!pop) return
    pop.querySelectorAll('.mp-item').forEach((b, i) => b.classList.toggle('on', i === mention.sel))
    const el = pop.querySelector('.mp-item.on')
    if (el) el.scrollIntoView({ block: 'nearest' })
  }

  function selectMention() {
    const it = mention.items[mention.sel]
    if (it) selectMentionItem(it)
  }

  // 选中项 → 令牌 + 尾随空格替换 @查询区间（[mention.anchor, 光标]），光标到空格后。sid 仅会话
  // chip 有（寻址键，序列化为 `[会话:标题|sid]`；插件/技能无 sid）。
  function insertMention(kind, name, sid, ptype) {
    const token = kind === 'session'
      ? (sid ? `[会话:${name}|${sid}]` : `[会话:${name}]`)
      : kind === 'path'
        ? `[@${ptype === 'dir' ? '目录' : '文件'}:${name}]`
        : `[插件:${name}]`
    const pos = cmView ? cmView.state.selection.main.from : mention.anchor
    composerReplaceRange(mention.anchor, pos, token + ' ')
    closeMentionPop()
    syncGwSend()
  }

  // doc/选区变化：检测 @ 触发 / 维护已打开的 @查询（光标前是 @ 则开浮窗）。锚点 = '@' 的 doc 位置
  function onInputMention() {
    if (!GATEWAY || gateAwait || state.mgr || !cmView) { closeMentionPop(); return }
    const st = cmView.state
    const pos = st.selection.main.from
    // IME 组合期（中文键盘敲字母即进入组合）：组合中的 doc 文本是**临时拼音/候选**，
    // 选区也不可信——拿它过滤会把浮窗筛空并按「无结果」关掉，或按选区判定误杀。
    // 组合期一律不判不动（不开、不更新查询、不关），等 compositionend 上屏后的 doc 事务
    // 走正常判定。compositionStarted（composing>=0）而非 composing（>0）：compositionstart
    // 先把状态置 0，首个组合字符进 doc 才 ++，用 composing 会漏掉「刚开始组合」这一拍。
    if (cmView.compositionStarted) return
    if (st.selection.main.from !== st.selection.main.to || !st.selection.main.empty) { if (mention.open) closeMentionPop(); return }
    if (mention.open) {
      const between = st.doc.sliceString(mention.anchor, pos)
      if (pos <= mention.anchor || /[\n\r]/.test(between)) { closeMentionPop(); return }
      const q = between.slice(1)
      if (q !== mention.q) { mention.q = q; renderMentionPop() }
      return
    }
    if (pos > 0 && st.doc.sliceString(pos - 1, pos) === '@') openMentionPopAtCaret()
  }
  function onInputChange() { syncGwSend(); onInputMention() }

export {
  GROUP_MAX,
  GROUP_ORDER,
  MENTION_PATH_RE,
  MENTION_PLUGIN_ICON,
  MENTION_PLUGIN_RE,
  MENTION_SESSION_ICON,
  MENTION_SESSION_RE,
  MENTION_SKILL_ICON,
  MENTION_UP_ICON,
  QUOTE_PDF_RE,
  QUOTE_REF_RE,
  QUOTE_REPLY_RE,
  arrangeItems,
  buildMentionChip,
  groupOf,
  closeMentionPop,
  insertMention,
  loadPickPath,
  mention,
  mentionChipHtml,
  mentionChipIcon,
  mentionItems,
  moveMentionSel,
  onInputChange,
  onInputMention,
  openMentionPopAtCaret,
  pick,
  pickAll,
  pickEnter,
  pickHome,
  pickItems,
  pickLabel,
  pickSearchKick,
  quotePdfChipHtml,
  quoteRefChipHtml,
  quoteReplyChipHtml,
  refreshPick,
  renderMentionPop,
  renderUserText,
  selectMention,
  selectMentionItem,
  serializeInput,
  stripQuoteBodies,
}
