// 模型选择（状态/seat/menu）（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { hideGate } from '../core/auth.js'
import { gToken, needToken, apiUrl } from '../core/gateway.js'
import { I } from '../core/icons.js'
import { inputEl, state, esc, toast, isTouch } from '../core/state.js'
import { EFFORT_LEVELS, cmd, msel, modelPop, modelSeatEl, closeCmdPop } from './commands.js'
import { closeMentionPop } from './mention.js'
import { MGR, MODELS, MODELS_LOADING, MODELS_ERR, loadModelsData } from '../sidebar/mgr-data.js'
import { modelProviderOf } from '../sidebar/mgr.js'
  function modelDir() {
    const pool = ((MODELS && Array.isArray(MODELS.items) ? MODELS.items : []) || [])
      .filter(it => it && typeof it.src === 'string' && it.src.startsWith('凭据池') && it.v)
      .map(it => String(it.v))
    const raw = pool.length
      ? pool
      : ((MODELS && Array.isArray(MODELS.providerModels) && MODELS.providerModels.length)
        ? MODELS.providerModels
        : ((MODELS && Array.isArray(MODELS.items) ? MODELS.items : []).map(it => String(it.v)).filter(Boolean)))
    const seen = new Set()
    const out = []
    for (const id of raw) {
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
    return out
  }
  // 当前选中模型（本地状态；首次 /gateway/models 加载后与凭据池 activeModel/provider/effortLevel 对齐）
  // 2026-08-24 模型 web/CLI 同步：MODEL_CUR 持久化 localStorage（刷新恢复），并按 /gateway/session 上报的
  // 会话实际模型（CLI reportCurrentModel）校准——每会话 override 只在 CLI 内存，web 不持久化会回落
  // 凭据池默认 activeModel 造成「CLI 用 vision-exp / web 显示 flash」不一致。
  const MODEL_KEY = 'floria-model-v1'
  function loadModelCur() {
    try {
      const raw = localStorage.getItem(MODEL_KEY)
      if (!raw) return null
      const o = JSON.parse(raw)
      if (o && typeof o === 'object' && typeof o.model === 'string' && o.model) return o
    } catch { /* 存储不可用忽略 */ }
    return null
  }
  function saveModelCur() {
    try {
      localStorage.setItem(MODEL_KEY, JSON.stringify({ provider: MODEL_CUR.provider, model: MODEL_CUR.model, effortLevel: MODEL_CUR.effortLevel, ts: Date.now() }))
    } catch { /* 存储不可用忽略 */ }
  }
  let MODEL_CUR = loadModelCur() || { provider: '', model: '', effortLevel: undefined }
  // 用户本次会话内主动切换过模型 → 不再被 /gateway/session 旧上报覆盖（切换会话时重置）。避免
  // POST /gateway/model 尚未落地前的一次刷新把刚切的选择回滚成旧值。
  let modelUserPicked = false
  // 命令菜单状态（对齐 dsh PopupState：open/status/options/search/active/submitting/confirming/acknowledged/error）
  // 2026-09-09 二轮定案：去 tab 单页分组（上传/技能/引用会话/指令堆放一页）；items=渲染时平铺条目（键盘索引基准）

  function currentChoice() {
    const id = MODEL_CUR.model || (MODELS && (MODELS.activeModel || (MODELS.model ? String(MODELS.model) : ''))) || ''
    if (!id) return null
    return { model: { id, name: id } }
  }
  // 推理等级名（全局；effortLevel 未设置 = Off）
  function effLabel() {
    const eff = MODEL_CUR.effortLevel
    if (eff === undefined || eff === null) return 'Off'
    const level = EFFORT_LEVELS.find(e => e.id === eff)
    return level ? level.name : String(eff)
  }
  function renderModelSeat() {
    // 显示源 = currentChoice()（MODEL_CUR.model，用户切换后即时更新），不用 MODELS.model 缓存——
    // 否则切换后仍显示初次加载的旧模型（用户反馈「输入栏没同步最新模型」）。
    const c = currentChoice()
    const name = c ? c.model.name : '选择模型'
    const eff = MODEL_CUR.effortLevel != null ? effLabel() : ''
    // dsh ModelSelect trigger：.triggerLabel=模型名 + .triggerEffort=推理等级（无则隐藏）+ 静态 .chevron（随 open 翻转）
    const label = modelSeatEl.querySelector('.triggerLabel')
    const effort = modelSeatEl.querySelector('.triggerEffort')
    if (label) label.textContent = name
    if (effort) { if (eff) { effort.textContent = eff; effort.hidden = false } else effort.hidden = true }
    modelSeatEl.title = eff ? `${name} · ${eff}` : name
    modelSeatEl.dataset.real = c ? '1' : ''
    // 真实配置尚未拉取且未过 token 门 → 懒加载一次（成功后重渲触发座，静默失败保留占位）。
    // 2026-08-25 加 !MODELS_ERR 门：loadModelsData 的 finally 现在会回调 renderModelSeat，
    // 若不加失败门，加载失败后（MODELS 仍 null、loading 已复位）此处会立即再触发 → 无限重试循环。
    // 失败后不再自动重试，改由 hideGate 显式 loadModelsData(true) / mgr 视图重试钮驱动。
    if (!c && !needToken() && !MODELS_LOADING && !MODELS && !MODELS_ERR) {
      loadModelsData(false).then(() => renderModelSeat()).catch(() => {})
    }
  }
  function toggleModelPop() {
    if (msel.open) { closeModelPop(); return }
    if (cmd.open) closeCmdPop()
    closeMentionPop()
    msel.open = true
    msel.pane = 'root'
    msel.active = 0
    renderModelPop()
    if (!isTouch()) inputEl.focus({ preventScroll: true }) // 焦点留输入栏：方向键/ESC 走 keydown；触屏跳过防 iOS 弹键盘
  }
  function closeModelPop() {
    if (!msel.open) return
    msel.open = false
    modelPop.hidden = true
    modelSeatEl.querySelector('.chevron')?.classList.remove('open')
  }
  function modelEscape() {
    if (msel.pane !== 'root') { msel.pane = 'root'; msel.active = 0; renderModelPop() } else closeModelPop()
  }
  // 当前面板的可导航行（root=两 cell；model=凭据池模型按 provider 序；effort=Off + Low/High/Max）
  function mselRows() {
    if (msel.pane === 'model') {
      const rows = []
      for (const id of modelDir()) rows.push({ kind: 'model', id })
      return rows
    }
    if (msel.pane === 'effort') {
      const rows = [{ kind: 'effort', effort: undefined, label: 'Off' }]
      for (const e of EFFORT_LEVELS) rows.push({ kind: 'effort', effort: e.id, label: e.name })
      return rows
    }
    return [{ kind: 'cell', cell: 'model' }, { kind: 'cell', cell: 'effort' }]
  }
  function mselMove(d) {
    const n = mselRows().length
    if (!n) return
    msel.active = (msel.active + d + n) % n
    renderModelPop()
  }
  function renderModelPop() {
    if (!msel.open) return
    let html = ''
    if (msel.pane === 'root') {
      // dsh root 面板：Model / Effort 两行 cell（label + value + 右 chevron），无返回按钮（dsh 用 Escape 退级）
      const c = currentChoice()
      const mname = c ? c.model.name : '—'
      const ename = effLabel() || '—'
      html += `<button type="button" class="cell"><span class="cellLabel">模型</span><span class="cellValue">${esc(mname)}</span><span class="cellChevron">${I.dshChevRight}</span></button>`
      html += `<button type="button" class="cell"><span class="cellLabel">推理等级</span><span class="cellValue">${esc(ename)}</span><span class="cellChevron">${I.dshChevRight}</span></button>`
    } else if (msel.pane === 'model') {
      // dsh model 面板：.groups > .group[.groupTitle + .option×]，check 尾勾；分组按凭据池供应商（与 MGR 模型 tab 同判据）
      const ids = modelDir()
      if (!ids.length) {
        html += `<div class="empty">暂无模型</div>`
      } else {
        html += `<div class="groups">`
        const groups = []
        for (const id of ids) {
          // 2026-08-29 全池可选：优先用网关下发的真实归属供应商标签（items[].provider），缺失再走启发式前缀判定
          const it = ((MODELS && MODELS.items) || []).find(x => x && x.v === id)
          const p = (it && it.provider) || modelProviderOf(it || { k: id, v: id })
          let g = groups.find((x) => x.provider === p)
          if (!g) { g = { provider: p, items: [] }; groups.push(g) }
          g.items.push(id)
        }
        let idx = 0
        const curId = currentChoice()?.model.id
        for (const g of groups) {
          html += `<div class="group"><div class="groupTitle">${esc(g.provider)}</div>`
          for (const id of g.items) {
            const on = idx === msel.active ? ' on' : ''
            const selected = id === curId
            html += `<button type="button" class="option${on}" data-idx="${idx}" role="menuitemradio" aria-checked="${selected}"><span class="optionCopy"><span class="modelName">${esc(id)}</span></span><span class="check">${selected ? I.dshCheck : ''}</span></button>`
            idx++
          }
          html += `</div>`
        }
        html += `</div>`
      }
    } else if (msel.pane === 'effort') {
      // dsh effort 面板：扁平 option 列表（Off + Low/High/Max，无 groups 包裹）
      let idx = 0
      const curEff = MODEL_CUR.effortLevel
      for (const r of mselRows()) {
        const on = idx === msel.active ? ' on' : ''
        // Off 项只在「未显式选择等级」时勾选；具体等级按当前显式值匹配
        const selected = r.effort === undefined ? curEff === undefined : curEff === r.effort
        html += `<button type="button" class="option${on}" data-idx="${idx}" role="menuitemradio" aria-checked="${selected}"><span class="optionCopy"><span class="modelName">${esc(r.label)}</span></span><span class="check">${selected ? I.dshCheck : ''}</span></button>`
        idx++
      }
    }
    modelPop.innerHTML = html
    modelPop.hidden = false
    modelSeatEl.querySelector('.chevron')?.classList.add('open')
    // cell/option 点击不再需要 stopPropagation：外部关闭已改 mousedown+contains（mousedown 在重渲染前命中目标，
    // innerHTML 摘除节点不再误判「点外关闭」，dsh ModelSelect 同语义）
    modelPop.querySelectorAll('.cell').forEach((b, i) => b.addEventListener('click', () => { msel.pane = i === 0 ? 'model' : 'effort'; msel.active = 0; renderModelPop() }))
    modelPop.querySelectorAll('.option').forEach(b => b.addEventListener('click', () => { msel.active = +b.dataset.idx; mselChoose() }))
    const on = modelPop.querySelector('.option.on')
    if (on) on.scrollIntoView({ block: 'nearest' })
  }
  // 2026-08-22 模型/思考等级切换接通网关：POST /gateway/model（持久化写 settings.json + 广播实时生效），
  // 未验证（needToken：网关模式且 cookie/token 均未通过）返回 false → toast 提示。
  // 2026-08-29 修复：门控从 !gToken 改 needToken()——cookie 授权设备刷新后 gToken 为空但已验证，
  // 误报「未连接网关」；/gateway/* 网关侧本就「query token 或 cookie」二选一。
  async function apiSetModel(body) {
    if (needToken()) return false
    try {
      const res = await fetch(apiUrl('/gateway/model'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      return res.ok
    } catch { return false }
  }
  function mselChoose() {
    const row = mselRows()[msel.active]
    if (!row) return
    if (msel.pane === 'model') {
      const id = row.id
      if (MODEL_CUR.model === id) { closeModelPop(); return }
      const it = ((MODELS && MODELS.items) || []).find(x => x && (x.v === id || x.k === id))
      // 2026-08-29 直接切模型自动切供应商：MODEL_CUR.provider 同步真实归属（网关侧按会话绑定供应商）
      MODEL_CUR = { ...MODEL_CUR, model: id, provider: (it && it.provider) || MODEL_CUR.provider }
      modelUserPicked = true // 2026-08-24：本次会话内主动切换，防止 /gateway/session 旧上报回滚
      saveModelCur() // 2026-08-24：持久化，刷新后恢复
      renderModelSeat()
      closeModelPop()
      // 2026-09-10 会话级供应商绑定：有会话 → 会话级覆盖（网关随路由下发该模型归属供应商，
      // 目标 CLI 进程内绑定 baseUrl/key，只影响本会话）；首页/新会话 → defaultModel（写全局池，
      // 只影响之后新建的会话）。两条路都不再改动其它在跑会话的供应商。
      const home = !state.currentHash
      void apiSetModel(home ? { defaultModel: id } : { model: id, sessionId: state.currentHash })
        .then(ok => toast(ok
          ? (home ? `新会话默认模型已设为 ${id}` : `模型已切换为 ${id}`)
          : (home ? '设置失败 · 网关未连接' : '切换失败 · 目标会话未在线或网关未连接')))
    } else if (msel.pane === 'effort') {
      const eff = row.effort === undefined ? undefined : row.effort
      if (MODEL_CUR.effortLevel === eff) { closeModelPop(); return }
      MODEL_CUR = { ...MODEL_CUR, effortLevel: eff }
      saveModelCur() // 2026-08-24：持久化推理等级
      renderModelSeat()
      closeModelPop()
      // Off（清除等级）发 'off'，网关据此 delete settings.effortLevel + 广播 null → CLI effortValue=undefined
      const payload = eff === undefined ? { effortLevel: 'off' } : { effortLevel: eff }
      void apiSetModel(payload).then(ok => toast(ok ? `推理等级已切换为 ${row.label}` : '切换失败 · 网关未连接'))
    }
  }
  renderModelSeat() // 初始渲染模型 seat（trigger 显示当前模型名 · 推理等级）

// —— 跨模块写入口（切割脚本生成）——
export function setModelCur(v) { MODEL_CUR = v }
export function setModelUserPicked(v) { modelUserPicked = v }

export {
  MODEL_CUR,
  MODEL_KEY,
  apiSetModel,
  closeModelPop,
  currentChoice,
  effLabel,
  loadModelCur,
  modelDir,
  modelEscape,
  modelUserPicked,
  mselChoose,
  mselMove,
  mselRows,
  renderModelPop,
  renderModelSeat,
  saveModelCur,
  toggleModelPop,
}
