// 模型卡（管理视图「模型」tab）（2026-10-01 卡片化：自 sidebar/mgr.js 迁出；唯一手改处，web/app.js 为生成物）

import { needToken, apiSetModel } from '../../../core/gateway.js'
import { I } from '../../../core/icons.js'
import { esc, state, toast } from '../../../core/state.js'
import { MODELS, MODELS_ERR, MODELS_LOADING, loadModelsData, mgrColor, modelProviderOf } from '../../../sidebar/mgr-data.js'
  // ---------- 模型卡 ----------
  // 数据源 = 网关 /gateway/models（只读展示 + 设为默认）。modelProviderOf 同被输入栏模型菜单复用（唯一一份）。
  const modelsCardDef = {
    id: 'models', title: '模型', tip: '模型配置', icon: 'chip', tab: true,
    mount(body) { renderMgrModels(body) },
  }

  // 「模型」卡体：便携根 settings.json 的模型配置（只读；数据源 = 网关 /gateway/models）
  function renderMgrModels(body) {
    body.innerHTML =
      '<div class="mgr-pane">' +
      '<div class="mgr-head"><h2 class="mgr-title">模型列表</h2></div>' +
      '<div class="mgr-model-list" id="mgr-model-list"></div>' +
      '<div class="mgr-foot">数据源：网关 /gateway/models</div>' +
      '</div>'
    renderMgrModelList()
    loadModelsData(false)
  }

  // 模型列表的卡体渲染（写进 .mgr-model-list）
  function renderMgrModelList() {
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
      renderMgrModelList()
      toast(`默认模型已设为 ${id}`)
    } else {
      toast('设置失败 · 模型不在凭据池或网关未连接')
    }
  }

export {
  modelCapHtml,
  modelsCardDef,
  renderMgrModelList,
  renderMgrModels,
  setDefaultModel,
}
