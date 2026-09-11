// 命令菜单 + 项目 seat + 风险确认门（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { I } from '../core/icons.js'
import { relTime } from '../core/markdown.js'
import { findSession } from '../core/sessions.js'
import { inputEl, state, ALL, esc, toast, isTouch } from '../core/state.js'
import { pendingImages, renderImgPills } from './images.js'
import { MENTION_PLUGIN_ICON, MENTION_SESSION_ICON, mention, serializeInput, closeMentionPop } from './mention.js'
import { MODEL_CUR, closeModelPop } from './model-select.js'
import { syncGwSend } from './send.js'
import { MGR, loadMgrData, MODELS } from '../sidebar/mgr-data.js'
import { isArchived } from '../sidebar/recent.js'
  // ---------- 命令菜单 + 模型选择（2026-08-21 dsh 输入栏逻辑移植）----------
  // ⚠️ 数据源 = 本地内置展示数据（⚠️ 非 dsh 真实注册表、非网关接口）：
  // 网关暂无 /gateway/commands 与 /gateway/models，命令列表/模型目录先本地内置供 UI 审阅——
  // 命令 = floria(Claude Code) 真实斜杠命令（claim=带参数/bare=直接执行/risk=需确认门），
  // 模型目录 = 真实 Claude 模型（对齐 dsh ModelDirectory：provider 分组 + reasoning.defaultEffort/efforts[]）。
  // 待网关接口就绪后替换数据源，交互逻辑不变。
  const MOCK_COMMANDS = [
    { name: 'compact', desc: '压缩当前会话上下文', claim: true },
    { name: 'clear', desc: '清除当前会话上下文', risk: '将清空当前会话的所有消息（含文件状态与上下文），不可恢复。' },
    { name: 'model', desc: '切换模型', claim: true },
    { name: 'permission', desc: '调整权限模式', claim: true },
    { name: 'plan', desc: '进入计划模式', claim: true },
    { name: 'rename', desc: '重命名会话', claim: true },
    { name: 'resume', desc: '继续子代理会话', claim: true },
    { name: 'retry', desc: '重试上一条消息', bare: true },
    { name: 'status', desc: '会话状态', bare: true },
    { name: 'skills', desc: '查看可用技能', bare: true },
    { name: 'plugins', desc: '查看插件清单', bare: true },
  ]
  // 浮窗单页分组（2026-09-09 二轮定案：去顶层 tab，四类堆放一页）组名映射
  const CMD_GROUP = { imgpick: '上传', skill: '技能', session: '引用会话', cmd: '指令' }
  // 推理等级（全局：Off/Low/High/Max，对齐 CLI effortValue 语义；Off=不发送 effort 参数。2026-08-22 由 per-model reasoning 改为全局）
  const EFFORT_LEVELS = [
    { id: 'low', name: 'Low' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max' },
  ]
  // 模型目录（真实凭据池，与 floria MGR 模型 tab 同源）：2026-08-29 直接切模型自动切供应商 →
  // 全池模型可选（items 内 src 以「凭据池」开头的行，跨商直选由网关自动切供应商）；回落 providerModels → items。
  // 2026-08-22 取代 MOCK_MODEL_DIR（anthropic 上游）。

  const cmd = { open: false, status: 'pending', items: [], search: '', active: 0, submitting: false, confirming: null, acknowledged: false, error: null }
  // 模型菜单状态（对齐 dsh ModelSelect Pane：root | model | effort）
  const msel = { open: false, pane: 'root', active: 0 }
  const cmdPop = $('cmd-pop')
  const modelPop = $('model-pop')
  const modelSeatEl = $('model-seat')

  // ---- 项目选择器（2026-09-02）：初始界面工具行 + 右侧切换目标项目 ----
  // 数据源=侧栏项目同款（ALL 按 projectLabel 分组派生，最近活跃降序）；选中=state.newProject
  // （与侧栏项目「+」同链路：首条消息发送时 /gateway/wsession 带 project → 会话落该项目根）。
  // 全局行=清回默认（同 chip X）。仅初始界面显示（CSS：#empty-hint 内才 display:flex）。
  const psel = { open: false }
  const projPop = $('proj-pop')
  const projSeatEl = $('proj-seat')
  projSeatEl.querySelector('.projIco').innerHTML = I.folder
  projSeatEl.querySelector('.chevron').innerHTML = I.dshChevDown
  function projList() {
    const byProject = {}
    for (const s of ALL) if (s.projectScope === 'project' && s.projectLabel && !isArchived(s)) (byProject[s.projectLabel] = byProject[s.projectLabel] || []).push(s)
    return Object.keys(byProject).sort((a, b) => {
      const la = Math.max(0, ...byProject[a].map((s) => s.updatedAt))
      const lb = Math.max(0, ...byProject[b].map((s) => s.updatedAt))
      return lb - la
    })
  }
  function renderProjSeat() {
    // 会话态=只读工作文件夹标识（显示当前会话所属项目全称，.locked 锁不可改）；空态=目标项目选择
    const locked = !!state.currentHash
    const s = locked ? findSession(state.currentHash) : null
    const label = locked
      ? (s && s.projectScope === 'project' && s.projectLabel ? s.projectLabel : '全局')
      : (state.newProject || '全局')
    projSeatEl.querySelector('.projLabel').textContent = label
    projSeatEl.title = locked ? '工作文件夹：' + label : (state.newProject ? '目标项目：' + state.newProject : '目标项目：全局（默认）')
    projSeatEl.classList.toggle('locked', locked)
  }
  function renderProjPop() {
    if (!psel.open) return
    const rows = ['<div class="row" data-p=""><span class="pIco">' + I.pen + '</span><span class="pLabel">全局（默认）</span>' + (state.newProject ? '' : '<span class="check">' + I.dshCheck + '</span>') + '</div>']
    for (const l of projList()) {
      rows.push('<div class="row" data-p="' + esc(l) + '" title="' + esc(l) + '"><span class="pIco">' + I.folder + '</span><span class="pLabel">' + esc(l) + '</span>' + (state.newProject === l ? '<span class="check">' + I.dshCheck + '</span>' : '') + '</div>')
    }
    projPop.innerHTML = rows.join('')
    projPop.querySelectorAll('.row').forEach((r) =>
      r.addEventListener('click', () => {
        state.newProject = r.dataset.p || null
        renderProjSeat()
        closeProjPop()
      }))
    projPop.hidden = false
  }
  function openProjPop() {
    if (cmd.open) closeCmdPop()
    if (msel.open) closeModelPop()
    closeMentionPop()
    psel.open = true
    renderProjPop()
  }
  function closeProjPop() {
    if (!psel.open) return
    psel.open = false
    projPop.hidden = true
  }
  projSeatEl.addEventListener('click', () => {
    if (state.currentHash) return // 会话态锁定：工作文件夹标识只读，不弹选择层
    psel.open ? closeProjPop() : openProjPop()
  })

  // ---- 命令菜单（dsh PopupSelectController 移植：open→加载一次→本地过滤→高亮→选择→确认门）----
  // 2026-09-09 二轮：统一条目 = 图片选择行（恒首位）+ 技能（MGR.skills.personal，/gateway/plugins）
  // + 近 48h 会话（同 @ 提及链）+ 命令（MOCK_COMMANDS）；搜索滤 name/desc（图片行恒显）。
  function cmdEntries() {
    const q = cmd.search.trim().toLowerCase().replace(/^\//, '')
    const match = (s) => !q || String(s || '').toLowerCase().includes(q)
    const items = [{ kind: 'imgpick', name: pendingImages.length ? '继续选择图片…' : '选择图片…', desc: pendingImages.length ? `已选 ${pendingImages.length}/4 · 自动压缩` : '一次最多 4 张，自动压缩' }]
    if (MGR) for (const s of (MGR.skills && MGR.skills.personal) || []) if (match(s.n) || match(s.d)) items.push({ kind: 'skill', name: s.n, desc: s.d })
    const cutoff = Date.now() - 48 * 3600 * 1000 // 会话仅展示近 48 小时（同 @ 提及）
    for (const s of [...ALL].filter((x) => x.updatedAt >= cutoff).sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (match(s.title || '')) items.push({ kind: 'session', name: s.title || '未命名会话', desc: relTime(s.updatedAt) })
    }
    for (const o of MOCK_COMMANDS) if (match(o.name) || match(o.desc)) items.push({ kind: 'cmd', name: o.name, desc: o.desc, ref: o })
    return items
  }
  function toggleCmdPop() {
    if (cmd.open) { closeCmdPop(); return }
    if (msel.open) closeModelPop()
    closeMentionPop()
    cmd.open = true
    cmd.status = 'ready'
    cmd.search = ''
    cmd.active = 0
    cmd.confirming = null
    cmd.acknowledged = false
    cmd.error = null
    renderCmdPop()
    // 首次打开确保技能清单已加载（异步），加载完用当前状态重渲（同 @ 提及浮窗）
    loadMgrData().then(() => { if (cmd.open) renderCmdPop() }).catch(() => {})
  }
  function closeCmdPop() {
    if (!cmd.open) return
    cmd.open = false
    cmd.confirming = null
    cmd.acknowledged = false
    cmdPop.hidden = true
    const rm = $('risk-modal')
    if (!rm.hidden) closeRiskModal()
  }
  function renderCmdPop() {
    if (!cmd.open) return
    // dsh confirmation gate：确认态下命令卡隐藏，改由全屏 RiskConfirmation 模态接管
    if (cmd.confirming) { cmdPop.hidden = true; renderRiskModal(); return }
    // 2026-09-09 二轮：单页分组渲染（无 tab）——搜索框 + 已选图片缩略图 + 四组行列表
    cmd.items = cmdEntries()
    let html = `<input class="search" type="text" placeholder="搜索全部类别…" aria-label="搜索" autocomplete="off"/>`
    if (cmd.error !== null) {
      html += `<div class="error" role="alert"><span class="errorText">${esc(cmd.error)}</span>${cmd.status === 'failed' ? `<button type="button" class="retry">重试</button>` : ''}</div>`
    } else {
      if (pendingImages.length) {
        // 已选图片缩略图（可移除）：粘贴/拖拽/未发送遗留，同旧图片 tab
        html += `<div class="imggrid">${pendingImages.map((p, i) => `<span class="imgpill"><img src="${p.dataUrl}" alt=""/><button type="button" class="img-x" data-i="${i}" title="移除">×</button></span>`).join('')}</div>`
      }
      let lastGrp = ''
      html += `<div role="listbox" class="viewport">${cmd.items.map((it, i) => {
        const grp = CMD_GROUP[it.kind] || ''
        const gh = grp !== lastGrp ? `<div class="grp">${grp}</div>` : ''
        lastGrp = grp
        const on = i === cmd.active ? ' rowActive' : ''
        const ico = it.kind === 'imgpick' ? I.dshImage : it.kind === 'skill' ? MENTION_PLUGIN_ICON : it.kind === 'session' ? MENTION_SESSION_ICON : I.dshPlus
        const label = it.kind === 'cmd' ? `/${it.name}` : it.name
        return gh + `<button type="button" role="option" aria-selected="${i === cmd.active}" class="row${on}" data-idx="${i}"><span class="rowIco">${ico}</span><span class="label">${esc(label)}</span>${it.desc ? `<span class="detail">${esc(it.desc)}</span>` : ''}</button>`
      }).join('')}</div>`
    }
    cmdPop.innerHTML = html
    cmdPop.hidden = false
    // 搜索输入：本地过滤（dsh 语义——敲字不重查选项；←→ 保留原生光标）
    const box = cmdPop.querySelector('.search')
    if (box) {
      box.value = cmd.search
      box.addEventListener('input', () => { cmd.search = box.value; cmd.active = 0; renderCmdPop() })
      box.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') { e.preventDefault(); cmdMove(1) }
        if (e.key === 'ArrowUp') { e.preventDefault(); cmdMove(-1) }
        if (e.key === 'Enter') { e.preventDefault(); cmdSelect() }
        if (e.key === 'Escape') { e.preventDefault(); closeCmdPop() }
      })
      if (!isTouch()) box.focus() // 触屏不聚焦：iOS 会弹键盘；搜索仍可手动点输入框唤起
    }
    cmdPop.querySelectorAll('.row').forEach(b => b.addEventListener('click', () => { cmd.active = +b.dataset.idx; cmdSelect() }))
    cmdPop.querySelectorAll('.img-x').forEach(x => x.addEventListener('click', () => {
      pendingImages.splice(+x.dataset.i, 1)
      renderImgPills()
      renderCmdPop()
    }))
    cmdPop.querySelector('.retry')?.addEventListener('click', () => { cmd.error = null; cmd.status = 'ready'; renderCmdPop() })
    const on = cmdPop.querySelector('.row.rowActive')
    if (on) on.scrollIntoView({ block: 'nearest' })
  }
  // 风险确认门（dsh RiskConfirmation + Modal 移植）：全屏遮罩 + 居中对话框，checkbox 勾选后才可确认
  function renderRiskModal() {
    const o = cmd.confirming
    if (!o) { const m = $('risk-modal'); if (!m.hidden) m.hidden = true; return }
    const rm = $('risk-modal')
    rm.innerHTML = `
      <div class="mask"></div>
      <div class="dialog" role="dialog" aria-modal="true" aria-label="执行 /${esc(o.name)}？">
        <div class="header">
          <h2 class="title">执行 /${esc(o.name)}？</h2>
          <button type="button" class="close" aria-label="关闭">${I.dshClose}</button>
        </div>
        <div class="body">
          <div class="warning">${I.dshWarn}<p>${esc(o.risk)}</p></div>
          <label class="acknowledgement"><input type="checkbox" ${cmd.acknowledged ? 'checked' : ''}/><span>我已了解该操作的风险</span></label>
        </div>
        <div class="footer">
          <button type="button" class="button outline">取消</button>
          <button type="button" class="button primary" ${cmd.acknowledged ? '' : 'disabled'}>确认执行</button>
        </div>
      </div>`
    rm.hidden = false
    const cb = rm.querySelector('.acknowledgement input')
    if (cb) cb.addEventListener('change', () => { cmdAck(cb.checked) })
    // 无需 stopPropagation：外部关闭已改 mousedown+contains（mousedown 在重渲染前命中目标），不再误判（dsh Modal 同语义）
    rm.querySelector('.mask')?.addEventListener('click', () => closeRiskModal())
    rm.querySelector('.close')?.addEventListener('click', () => closeRiskModal())
    rm.querySelector('.outline')?.addEventListener('click', () => closeRiskModal())
    rm.querySelector('.primary')?.addEventListener('click', () => cmdConfirm())
  }
  // 取消确认：清除确认态、恢复命令列表（dsh cancelConfirmation：确认卡关闭、列表重显）
  function closeRiskModal() {
    const rm = $('risk-modal')
    rm.hidden = true
    rm.innerHTML = ''
    cmd.confirming = null
    cmd.acknowledged = false
    renderCmdPop()
  }
  function cmdMove(d) {
    const n = cmd.items.length
    if (!n) return
    cmd.active = (cmd.active + d + n) % n
    renderCmdPop()
  }
  // 统一选择分发（2026-09-09 二轮）：图片行=选图（选完 img-file change 关浮窗）；技能/会话=chip 追加输入栏；
  // 命令=原链（risk→确认门 / settle→写入输入栏）
  function cmdSelect() {
    const it = cmd.items[cmd.active]
    if (!it || cmd.submitting) return
    if (it.kind === 'imgpick') { $('img-file').click(); return }
    if (it.kind === 'skill') { appendMentionChip('plugin', it.name); closeCmdPop(); return }
    if (it.kind === 'session') { appendMentionChip('session', it.name); closeCmdPop(); return }
    const o = it.ref
    if (o.risk) { cmd.confirming = o; cmd.acknowledged = false; renderCmdPop(); return }
    cmdSettle(o)
  }
  // 浮窗直选落地（无 @ 光标锚点）：同构 chip 追加到输入栏末尾 + 尾随空格，光标到末尾。
  // serializeInput 把 .mention chip 序列化为 [插件:X]/[会话:X] 令牌，发送链与 @ 提及完全同路。
  function appendMentionChip(kind, name) {
    const chip = document.createElement('span')
    chip.className = 'mention'
    chip.contentEditable = 'false'
    chip.dataset.kind = kind
    chip.dataset.name = name
    chip.innerHTML = `<span class="m-ic">${kind === 'session' ? MENTION_SESSION_ICON : MENTION_PLUGIN_ICON}</span><span class="m-nm">${esc(name)}</span><span class="m-x" title="删除">×</span>`
    inputEl.appendChild(chip)
    chip.after(document.createTextNode('\u00A0'))
    syncGwSend()
    inputEl.focus()
    const sel = window.getSelection()
    if (sel) {
      const r = document.createRange()
      r.selectNodeContents(inputEl); r.collapse(false)
      sel.removeAllRanges(); sel.addRange(r)
    }
  }
  function cmdAck(v) { cmd.acknowledged = v; renderCmdPop() }
  function cmdConfirm() {
    if (!cmd.confirming || !cmd.acknowledged) return
    const o = cmd.confirming
    cmd.confirming = null
    cmd.acknowledged = false
    cmdSettle(o)
  }
  // 选择落地：把命令文本写入输入栏（claim 带参数提示 / bare 直接插入），回车发送由 CLI 端执行；本地展示同闭环
  function cmdSettle(o) {
    setInputText(o.claim ? `/${o.name} ` : `/${o.name}`)
    closeCmdPop()
    inputEl.focus()
    toast(`命令已写入输入栏：/${o.name}（回车发送）`)
  }
  function setInputText(text) {
    if (inputEl.contentEditable !== 'true') return
    inputEl.textContent = text
    syncGwSend()
  }

  // ---- 模型选择（dsh ModelSelect 移植：trigger 显示「模型名 · 推理等级」，root 两行 Model/Effort 各自 drill）----
  // 当前选中模型 id：本地 MODEL_CUR 优先，未同步时回落 MODELS 的 activeModel/model（凭据池同源）
export {
  CMD_GROUP,
  EFFORT_LEVELS,
  MOCK_COMMANDS,
  appendMentionChip,
  closeCmdPop,
  closeProjPop,
  closeRiskModal,
  cmd,
  cmdAck,
  cmdConfirm,
  cmdEntries,
  cmdMove,
  cmdPop,
  cmdSelect,
  cmdSettle,
  modelPop,
  modelSeatEl,
  msel,
  openProjPop,
  projList,
  projPop,
  projSeatEl,
  psel,
  renderCmdPop,
  renderProjPop,
  renderProjSeat,
  renderRiskModal,
  setInputText,
  toggleCmdPop,
}
