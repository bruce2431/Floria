// 管理视图数据源（插件/模型）（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

import { hideGate } from '../core/auth.js'
import { needToken, apiUrl } from '../core/gateway.js'
import { loadModelCur, saveModelCur, MODEL_CUR, renderModelSeat } from '../inputbar/model-select.js'
import { renderMgrGrid, renderMgrModels } from './mgr.js'
  // ---------- 管理视图数据源（2026-08-15 起接后端 /gateway/plugins：真实已安装插件/技能 + 官方市场） ----------
  // 结构镜像后端返回：{ plugins:{personal,public}, skills:{personal,public} }，每项 {n, d, v, inst}。
  // 首次进入管理视图 fetch，刷新按钮 force 重新拉取；失败显示错误 + 重试（不回落假数据）。
  let MGR = null
  let MGR_LOADING = false
  let MGR_ERR = ''
  async function loadMgrData(force) {
    if (MGR && !force) return MGR
    if (needToken()) return null // token 门锁定态：不发起数据请求（hideGate 解锁后刷新）
    MGR_LOADING = true
    MGR_ERR = ''
    renderMgrGrid()
    try {
      const res = await fetch(apiUrl('/gateway/plugins'))
      const data = await res.json()
      if (!data || !data.plugins || !data.skills) throw new Error(data.error || 'bad response')
      MGR = data
    } catch (e) {
      MGR_ERR = e.message || String(e)
    } finally {
      MGR_LOADING = false
      renderMgrGrid()
    }
    return MGR
  }
  // 模型配置数据源（/gateway/models：便携根 settings.json 的 model + 模型类环境变量；只读展示）
  let MODELS = null
  let MODELS_LOADING = false
  let MODELS_ERR = ''
  async function loadModelsData(force) {
    if (MODELS && !force) return MODELS
    if (needToken()) return null // token 门锁定态：不发起数据请求
    MODELS_LOADING = true
    MODELS_ERR = ''
    renderMgrModels()
    try {
      const res = await fetch(apiUrl('/gateway/models'))
      const data = await res.json()
      if (!data || !('model' in data)) throw new Error(data.error || 'bad response')
      MODELS = data
      // 与凭据池真实状态对齐（CLI 同源）：model 优先本地持久化（刷新恢复，含 CLI 上报的会话模型），
      // 次之 activeModel；provider=activeProvider；effortLevel=settings.effortLevel。
      const saved = loadModelCur()
      setModelCur({
        provider: data.activeProvider || (saved ? saved.provider : '') || MODEL_CUR.provider,
        model: (saved && saved.model) || data.activeModel || (data.model ? String(data.model) : MODEL_CUR.model),
        effortLevel: data.effortLevel != null ? String(data.effortLevel) : (saved && saved.effortLevel !== undefined ? saved.effortLevel : undefined),
      })
      saveModelCur()
    } catch (e) {
      // 2026-08-25 竞态防护：若期间已有一次成功加载（如 hideGate 用新 token 补拉已先落地），
      // 此陈旧失败（典型：gate 前空 token 的 401）不覆盖已就绪数据，避免把成功态又标成错误。
      if (!MODELS) MODELS_ERR = e.message || String(e)
    } finally {
      MODELS_LOADING = false
      renderMgrModels()
      renderModelSeat() // 2026-08-25 模型数据落地后刷新输入栏模型 seat（含 hideGate 补拉场景）
    }
    return MODELS
  }
  const MGR_PALETTE = ['#5b8ff9', '#61a1c2', '#7b6bd6', '#5aa57a', '#d98a4a', '#c96a6a', '#4aa3a0', '#a06ba8', '#6b8f71', '#b48a5a']
  function mgrColor(n) {
    let h = 0
    for (const c of n) h = (h * 31 + c.charCodeAt(0)) >>> 0
    return MGR_PALETTE[h % MGR_PALETTE.length]
  }

export {
  MGR,
  MGR_ERR,
  MGR_LOADING,
  MGR_PALETTE,
  MODELS,
  MODELS_ERR,
  MODELS_LOADING,
  loadMgrData,
  loadModelsData,
  mgrColor,
}
