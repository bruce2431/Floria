// @ 提及浮窗 + 输入变化入口（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { messagesHtml, addUser } from '../chat/messages.js'
import { GATEWAY, gateAwait, apiUrl } from '../core/gateway.js'
import { I } from '../core/icons.js'
import { mdInline, relTime } from '../core/markdown.js'
import { findSession } from '../core/sessions.js'
import { inputEl, state, esc, newSessionProject } from '../core/state.js'
import { syncGwSend } from './send.js'
import { MGR, loadMgrData } from '../sidebar/mgr-data.js'
  // ---------- @ 提及（2026-08-15）：输入 @ 弹出「近48h 会话 + 插件/技能」浮窗（2026-09-18 会话区提前），选中插入内联 chip ----------
  // 消息文本中 chip 序列化为 [插件:名称] / [会话:名称] 令牌（CLI 终端渲染为 [名称]，遥测端渲染为 chip；
  // 令牌保留 kind 供两端差异化渲染 + 未来插件激活扩展）。
  const MENTION_PLUGIN_RE = /\[插件:([^\]]+)\]/g
  const MENTION_SESSION_RE = /\[会话:([^\]]+)\]/g
  // @ 提及 icon：与侧栏插件/项目 tab 一致，纯线条（stroke）风格，颜色走 currentColor
  const MENTION_PLUGIN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M10.2 3.5H4.6a1.1 1.1 0 0 0-1.1 1.1v5.6a1.1 1.1 0 0 0 1.1 1.1h5.6a1.1 1.1 0 0 0 1.1-1.1V4.6a1.1 1.1 0 0 0-1.1-1.1z"/><path d="M19.4 3.5h-5.6a1.1 1.1 0 0 0-1.1 1.1v5.6a1.1 1.1 0 0 0 1.1 1.1h5.6a1.1 1.1 0 0 0 1.1-1.1V4.6a1.1 1.1 0 0 0-1.1-1.1z"/><path d="M10.2 13.7H4.6a1.1 1.1 0 0 0-1.1 1.1v5.6a1.1 1.1 0 0 0 1.1 1.1h5.6a1.1 1.1 0 0 0 1.1-1.1v-5.6a1.1 1.1 0 0 0-1.1-1.1z"/><path d="M19.4 13.7h-5.6a1.1 1.1 0 0 0-1.1 1.1v5.6a1.1 1.1 0 0 0 1.1 1.1h5.6a1.1 1.1 0 0 0 1.1-1.1v-5.6a1.1 1.1 0 0 0-1.1-1.1z"/></svg>'
  const MENTION_SESSION_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M4 5h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8l-5 3.5v-3.5H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/></svg>'
  // ---------- 目录 / 文件引用（2026-09-26）：@ 浮窗与 + 工具栏共用的一组「逐级浏览工作区根」状态 ----------
  // 数据源 = GET /gateway/fs?path=<相对工作区根的子路径>（只读单层；网关侧复用 listOneLevel，跳过隐藏项
  // 与重型目录、目录在前、每层 ≤50）。pick.path 是**相对工作区根**的当前层路径，'' = 根——与 chip 上行的
  // 路径同基准（用户定案：相对全局根）。令牌 [@目录:路径] / [@文件:路径] 刻意与上传附件占位 [文件:<路径>]
  // 不同名：后者会被 messages.js 的附件卡片链（userFilesHtml/userBodyHtml）剥走，同名会吞掉 @ chip。
  const MENTION_PATH_RE = /\[@(目录|文件):([^\]]+)\]/g
  const MENTION_DIR_ICON = I.folder
  const MENTION_FILE_ICON = I.dshFile
  const MENTION_UP_ICON = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 3.4 13 8.4l-.9.9L8.6 6.8V13H7.4V6.8L4 9.3l-.9-.9z"/></svg>'
  let mention = { open: false, sentinel: null, q: '', items: [], sel: 0 }
  // entries: null=未加载；[]=空目录；[TreeNode…]=已加载。seq 丢弃迟到的旧响应（快速连点目录）。
  const pick = { path: '', entries: null, loading: false, err: '', seq: 0 }

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
      const g = groupOf(it)
      seen[g] = (seen[g] || 0) + 1
      return seen[g] <= GROUP_MAX
    })
    return kept
      .map((it, i) => ({ it, i, g: GROUP_ORDER.indexOf(groupOf(it)) }))
      .sort((a, b) => (a.g - b.g) || (a.i - b.i))
      .map((x) => x.it)
  }

  // 令牌形态解析（会话令牌可带 sid：`标题|sid`，@ 提及 chip 序列化产出，CLI 侧按它精确寻址——
  // 见 src/utils/sessionAddressing.ts）。渲染一律只显示标题，sid 是给工具用的寻址键。
  function splitSessionToken(v) {
    const i = String(v).indexOf('|')
    return i >= 0 ? { title: String(v).slice(0, i), sid: String(v).slice(i + 1) } : { title: String(v), sid: '' }
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
    if (pick.loading) return '加载中…'
    if (pick.err) return '加载失败'
    return pick.path || '工作区根'
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
  // 当前层的可选条目（q 在当前层内过滤名称）：上级目录行 + 目录 + 文件。
  // 「上级目录」只取决于「当前是不是工作区根」，与**这一层的内容**无关——故加载中/加载失败时它照样在，
  // 否则某一层拉不到（目录已删/端点失败）就退不回去，整个文件组成死层。条目本身不塞假行。
  function pickItems(q) {
    const ql = (q || '').trim().toLowerCase()
    const items = []
    if (pick.path) items.push({ kind: 'pathup', name: '上级目录', path: pickParent() })
    if (pick.loading || !pick.entries) return items
    for (const e of pick.entries) {
      if (ql && !String(e.name).toLowerCase().includes(ql)) continue
      const p = pick.path ? `${pick.path}/${e.name}` : e.name
      items.push({ kind: 'path', ptype: e.type === 'dir' ? 'dir' : 'file', name: e.name, path: p })
    }
    return items
  }
  // 目录项进入下一层 / 上级目录返回（两个浮窗的选择入口共用同一处判定）
  function pickEnter(it) {
    return loadPickPath(it.path)
  }
  function mentionChipIcon(kind, ptype) {
    if (kind === 'session') return MENTION_SESSION_ICON
    if (kind === 'path') return ptype === 'dir' ? MENTION_DIR_ICON : MENTION_FILE_ICON
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

  // chip HTML（name 为已转义文本：mdInline/addUser 入口已 esc，这里不再二次转义）
  // 消息内渲染=透明胶囊（无图标），仅保留名称文本（用户要求「只要一个白色浮窗似的胶囊」→ 透明胶囊）
  // 路径 chip 额外包一层 .mc-t：长路径在胶囊内省略号收口（inline-flex 直挂文本无法 text-overflow）
  function mentionChipHtml(kind, name, ptype) {
    if (kind === 'path') {
      const label = '@' + name
      return `<span class="mention-chip m-path" title="${label}"><span class="mc-t">${label}</span></span>`
    }
    const label = kind === 'session' ? splitSessionToken(name).title : name
    return `<span class="mention-chip ${kind === 'session' ? 'm-session' : 'm-plugin'}">${label}</span>`
  }

  // 实时回显的用户消息：把令牌转 chip（与离线 messagesHtml 的 mdInline 一致）
  function renderUserText(text) {
    return esc(text)
      .replace(MENTION_PLUGIN_RE, (_, n) => mentionChipHtml('plugin', n))
      .replace(MENTION_SESSION_RE, (_, n) => mentionChipHtml('session', n))
      .replace(MENTION_PATH_RE, (_, t, p) => mentionChipHtml('path', p, t === '目录' ? 'dir' : 'file'))
  }

  // 序列化 contenteditable → 纯文本（chip → [插件:X]/[会话:X]，nbsp→空格，块级→换行）
  function serializeInput() {
    let out = ''
    const walk = (nodes) => {
      for (const n of nodes) {
        if (n.nodeType === 3) { out += n.nodeValue; continue }
        if (n.nodeType !== 1) continue
        if (n.classList && n.classList.contains('mention')) {
          // 会话 chip 带 sid → `[会话:标题|sid]`：sid 是会话的稳定键（改名免疫），CLI 侧会话暴露
          // 集合据此精确命中（重名也能寻址）；无 sid（不该发生，兜住手改 DOM）回落纯标题形态。
          // 路径 chip → `[@目录:路径]` / `[@文件:路径]`（路径相对工作区根，与网关 /gateway/fs 同基准）。
          const k = n.dataset.kind
          out += k === 'session'
            ? (n.dataset.sid ? `[会话:${n.dataset.name}|${n.dataset.sid}]` : `[会话:${n.dataset.name}]`)
            : k === 'path'
              ? `[@${n.dataset.ptype === 'dir' ? '目录' : '文件'}:${n.dataset.name}]`
              : `[插件:${n.dataset.name}]`
        } else if (n.tagName === 'BR') {
          out += '\n'
        } else {
          walk(n.childNodes)
          if (/^(DIV|P)$/.test(n.tagName)) out += '\n'
        }
      }
    }
    walk(inputEl.childNodes)
    return out.replace(/\u00A0/g, ' ')
  }

  function closeMentionPop() {
    if (mention.sentinel && mention.sentinel.isConnected) mention.sentinel.remove()
    mention.open = false
    mention.sentinel = null
    mention.q = ''
    mention.items = []
    mention.sel = 0
    const pop = $('mention-pop')
    if (pop) pop.hidden = true
  }

  // 在光标处插入零宽锚点（紧跟 @），作为「@查询区间」标记；后续输入夹在 @ 与锚点之间
  function ensureSentinel() {
    if (mention.sentinel && mention.sentinel.isConnected) return mention.sentinel
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) return null
    const r = sel.getRangeAt(0)
    if (!r.collapsed) return null
    const sp = document.createElement('span')
    sp.className = 'm-sentinel'
    r.insertNode(sp)
    r.setStartAfter(sp); r.setEndAfter(sp)
    sel.removeAllRanges(); sel.addRange(r)
    mention.sentinel = sp
    return sp
  }

  function openMentionPopAtCaret() {
    const sp = ensureSentinel()
    if (!sp) return
    mention.open = true
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
    loadPickPath(pickHome()).then((ok) => { if (ok && after) after() })
  }

  function mentionItems(q) {
    const ql = (q || '').trim().toLowerCase()
    const match = (s) => !ql || String(s).toLowerCase().includes(ql)
    const items = []
    const cutoff = Date.now() - 48 * 3600 * 1000 // 会话仅展示近 48 小时
    for (const s of [...ALL].filter((x) => x.updatedAt >= cutoff).sort((a, b) => b.updatedAt - a.updatedAt)) {
      // sid = 会话转录文件名主干，与会话间协作的寻址键同源（core/sessions.js hashOf = 路由 hash）
      if (match(s.title || '')) items.push({ kind: 'session', name: s.title || '未命名会话', sid: hashOf(s), desc: relTime(s.updatedAt) })
    }
    if (MGR) {
      for (const p of (MGR.plugins && MGR.plugins.personal) || []) if (match(p.n)) items.push({ kind: 'plugin', name: p.n, desc: p.d })
      for (const s of (MGR.skills && MGR.skills.personal) || []) if (match(s.n)) items.push({ kind: 'plugin', name: s.n, desc: s.d })
    }
    items.push(...pickItems(q))
    return arrangeItems(items)
  }

  function renderMentionPop() {
    const pop = $('mention-pop')
    if (!pop || !mention.open) return
    const items = mentionItems(mention.q)
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

  // 选中项 → 用 chip + 尾随空格替换 @查询区间，光标放到空格后。sid 仅会话 chip 有（寻址键，
  // 序列化为 `[会话:标题|sid]`；插件/技能无 sid）。
  function insertMention(kind, name, sid, ptype) {
    const sp = mention.sentinel
    if (sp && sp.isConnected) {
      const prev = sp.previousSibling
      if (prev && prev.nodeType === 3 && /@$/.test(prev.nodeValue || '')) {
        prev.nodeValue = prev.nodeValue.replace(/@$/, '')
        if (!prev.nodeValue) prev.remove()
      }
      let nx = sp.nextSibling
      while (nx && nx.nodeType === 3) { const t = nx; nx = nx.nextSibling; t.remove() }
      const chip = buildMentionChip(kind, name, sid, ptype)
      sp.replaceWith(chip)
      const space = document.createTextNode('\u00A0')
      chip.after(space)
      const sel = window.getSelection()
      const r = document.createRange()
      r.setStartAfter(space); r.collapse(true)
      sel.removeAllRanges(); sel.addRange(r)
    }
    closeMentionPop()
    inputEl.focus()
    syncGwSend()
  }

  function removeChip(chip) {
    let nx = chip.nextSibling
    if (nx && nx.nodeType === 3 && /^\s*$/.test(nx.nodeValue)) nx.remove()
    chip.remove()
    syncGwSend()
  }

  // 光标前的 @chip（跳过尾随空格文本），供退格/× 删除
  function mentionBeforeCaret() {
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return null
    const node = sel.anchorNode
    if (!node) return null
    let prev = null
    if (node.nodeType === 3) {
      const off = sel.anchorOffset
      if (off === 0) prev = node.previousSibling
      else if (off >= node.nodeValue.length && /^\s*$/.test(node.nodeValue)) prev = node.previousSibling
      else if (/^\s+$/.test(node.nodeValue.slice(0, off))) prev = node.previousSibling
      else return null
    } else if (node.nodeType === 1) {
      // 光标落在根元素（contenteditable 本体）边界：取光标前一个子节点（跳过随后的空白后找 chip）；
      // 落在其它子元素（块级 div/p）时沿用「其前一个兄弟」。
      prev = (node === inputEl) ? node.childNodes[sel.anchorOffset - 1] : node.previousSibling
    }
    while (prev && prev.nodeType === 3 && /^\s*$/.test(prev.nodeValue || '')) prev = prev.previousSibling
    if (prev && prev.nodeType === 1 && prev.classList && prev.classList.contains('mention')) return prev
    return null
  }

  // input 事件：检测 @ 触发 / 维护已打开的 @查询（光标前是 @ 则开浮窗）
  function onInputMention() {
    if (!GATEWAY || gateAwait || state.mgr) { closeMentionPop(); return }
    if (mention.sentinel && mention.sentinel.isConnected) {
      const sp = mention.sentinel
      const prev = sp.previousSibling
      const ok = prev && prev.nodeType === 3 && /@$/.test(prev.nodeValue || '')
      if (!ok) { closeMentionPop(); return }
      let q = ''
      let nx = sp.nextSibling
      while (nx && nx.nodeType === 3) { q += nx.nodeValue; nx = nx.nextSibling }
      if (q !== mention.q) { mention.q = q; renderMentionPop() }
      return
    }
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount || !sel.isCollapsed) return
    const node = sel.anchorNode
    if (node && node.nodeType === 3 && node.nodeValue.slice(0, sel.anchorOffset).endsWith('@')) {
      openMentionPopAtCaret()
    }
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
  MENTION_UP_ICON,
  arrangeItems,
  buildMentionChip,
  groupOf,
  closeMentionPop,
  ensureSentinel,
  insertMention,
  loadPickPath,
  mention,
  mentionBeforeCaret,
  mentionChipHtml,
  mentionChipIcon,
  mentionItems,
  moveMentionSel,
  onInputChange,
  onInputMention,
  openMentionPopAtCaret,
  pick,
  pickEnter,
  pickHome,
  pickItems,
  pickLabel,
  refreshPick,
  removeChip,
  renderMentionPop,
  renderUserText,
  selectMention,
  selectMentionItem,
  serializeInput,
}
