// 预览页注册的侧栏快捷按钮（2026-09-23 SPEC §1.2）（唯一手改处，web/app.js 为生成物）

import { I } from '../core/icons.js'
import { esc } from '../core/util.js'
import { activePreviewFrame, railExtItems, setRailExtItems } from '../feature/preview-frame.js'
import { registerExtCards } from '../engine/ext-runtime.js'
/* @module sidebar/rail-ext.js */
  // ---------- 预览页注册的侧栏快捷按钮（2026-09-23） ----------
  // 用途：.claude/preview 页面在 iframe 内运行，可经 postMessage 往 Floria 侧栏折叠带注册自己的
  // 快捷按钮，点击回跳该页做动作（沿用既有 iframe ↔ 宿主 postMessage 通道）。
  // 契约：预览页 → 宿主 parent.postMessage({ type:'floria-rail-register', items:[{id,icon,title}] }, '*')
  //       icon = I 图标表的键（不让预览页自送 SVG——视觉沿用侧栏现成图标，SPEC §6.4「不新增视觉」）
  //       title = 悬浮提示；id 由预览页自定义，点击时原样回传。
  //       宿主 → 预览页 frame.contentWindow.postMessage({ type:'floria-rail-action', id }, '*')
  // 呈现：折叠态 = 复现成 .rail-ico（28px 圆角 8，hover --hover），挂进 #rail-mid；#rail-ext 用
  //       display:contents 不产生盒，子元素与内置四个图标同列同 gap 居中（零新增视觉）。
  // 不变量：注册集属于**当前加载的那份预览文档**——文档换（iframe 换 src / 重建 / 离开预览），
  //        注册集即失效并清空；凭 e.source 精确匹配当前 .preview-frame 才采纳，别处窗口伪报不进来。
  // 状态表 railExtItems + clearRailExt 已迁 feature/preview-frame.js（与本模块只读/写经由它）；
  // 本模块只留桥接与渲染。
  // 按来源窗口反查任一预览帧（卡池化后含隐藏帧）；无匹配返回 null。
  function frameBySource(root, src) {
    if (!src) return null
    for (const el of root.querySelectorAll('.preview-frame')) if (el.contentWindow === src) return el
    return null
  }
  function renderRailExt() {
    const box = $('rail-ext')
    if (!box) return
    box.innerHTML = railExtItems
      .map((it) => `<button class="rail-ico" data-rail-id="${esc(it.id)}" title="${esc(it.title)}">${I[it.icon]}</button>`)
      .join('')
    box.querySelectorAll('.rail-ico').forEach((b) =>
      b.addEventListener('click', () => {
        const f = activePreviewFrame(document)
        if (f && f.contentWindow) f.contentWindow.postMessage({ type: 'floria-rail-action', id: b.dataset.railId }, '*')
      }),
    )
  }
  function bindRailExtBridge() {
    addEventListener('message', (e) => {
      const d = e.data
      if (!d) return
      // 两类申报共用「当前预览帧作证」这一道门（e.source 必须就是 .preview-frame 的 contentWindow）
      const rail = d.type === 'floria-rail-register'
      const cards = d.type === 'floria-cards-register'
      if (!rail && !cards) return
      // 卡池化（2026-10-26）：池内每张卡各一枚帧，申报按来源窗口精确反查（含隐藏帧）。
      // 隐藏帧的申报不入当前表，但缓存到帧上——切回该卡（池内切显隐、无 load）时由 work-preview 恢复。
      const f = frameBySource(document, e.source)
      if (!f) return
      if (cards) {
        // 卡片化二期：预览页实时申报外部卡（同 id 覆盖静态清单项）。字段校验与 preview.json 来源共用
        // engine/ext-decl.js 的同一份过滤器——两条外部输入不给两处各写一套；label 取帧上锚定的项目。
        if (f === activePreviewFrame(document)) registerExtCards(f.dataset.label || '', d.cards, false)
        return
      }
      // 边界校验（外部输入）：id 必为非空串、icon 必是 I 表自有键（含 constructor 之类的原型键不收）
      const items = (Array.isArray(d.items) ? d.items : [])
        .filter((it) => it && typeof it.id === 'string' && it.id && Object.prototype.hasOwnProperty.call(I, it.icon))
        .map((it) => ({ id: it.id, icon: it.icon, title: typeof it.title === 'string' ? it.title : '' }))
      f.__railItems = items
      if (f !== activePreviewFrame(document)) return // 隐藏帧只记账，不改当前侧栏
      setRailExtItems(items)
      renderRailExt()
    })
  }
  bindRailExtBridge()

export {
  bindRailExtBridge,
  renderRailExt,
}
