// 预览页注册的侧栏快捷按钮（2026-09-23 SPEC §1.2）（唯一手改处，web/app.js 为生成物）

import { I } from '../core/icons.js'
import { esc } from '../core/state.js'
import { registerExtCards } from '../views/registry.js'
  // ---------- 预览页注册的侧栏快捷按钮（2026-09-23） ----------
  // 用途：.claude/preview 页面在 iframe 内运行，可经 postMessage 往 Floria 侧栏折叠带注册自己的
  // 快捷按钮，点击回跳该页做动作（沿用既有 iframe ↔ 宿主 postMessage 通道，同 default-preview
  // 的 floria-open-session 先例；宿主侧此前无对应监听，本模块补上）。
  // 契约：预览页 → 宿主 parent.postMessage({ type:'floria-rail-register', items:[{id,icon,title}] }, '*')
  //       icon = I 图标表的键（不让预览页自送 SVG——视觉沿用侧栏现成图标，SPEC §6.4「不新增视觉」）
  //       title = 悬浮提示；id 由预览页自定义，点击时原样回传。
  //       宿主 → 预览页 frame.contentWindow.postMessage({ type:'floria-rail-action', id }, '*')
  // 呈现：折叠态 = 复现成 .rail-ico（28px 圆角 8，hover --hover），挂进 #rail-mid；#rail-ext 用
  //       display:contents 不产生盒，子元素与内置四个图标同列同 gap 居中（零新增视觉）。
  // 不变量：注册集属于**当前加载的那份预览文档**——文档换（iframe 换 src / 重建 / 离开预览），
  //        注册集即失效并清空；凭 e.source 精确匹配当前 .preview-frame 才采纳，别处窗口伪报不进来。
  let railExtItems = []
  function clearRailExt() {
    railExtItems = []
    const box = $('rail-ext')
    if (box) box.innerHTML = ''
  }
  function renderRailExt() {
    const box = $('rail-ext')
    if (!box) return
    box.innerHTML = railExtItems
      .map((it) => `<button class="rail-ico" data-rail-id="${esc(it.id)}" title="${esc(it.title)}">${I[it.icon]}</button>`)
      .join('')
    box.querySelectorAll('.rail-ico').forEach((b) =>
      b.addEventListener('click', () => {
        const f = document.querySelector('.preview-frame')
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
      const f = document.querySelector('.preview-frame')
      if (!f || f.contentWindow !== e.source) return
      // 卡片化二期：预览页实时申报外部卡（同 id 覆盖静态清单项）。字段校验与 preview.json 来源共用
      // views/ext-card.js 的同一份过滤器——两条外部输入不给两处各写一套；label 取帧上锚定的项目。
      if (cards) { registerExtCards(f.dataset.label || '', d.cards, false); return }
      // 边界校验（外部输入）：id 必为非空串、icon 必是 I 表自有键（含 constructor 之类的原型键不收）
      railExtItems = (Array.isArray(d.items) ? d.items : [])
        .filter((it) => it && typeof it.id === 'string' && it.id && Object.prototype.hasOwnProperty.call(I, it.icon))
        .map((it) => ({ id: it.id, icon: it.icon, title: typeof it.title === 'string' ? it.title : '' }))
      renderRailExt()
    })
  }
  bindRailExtBridge()

export {
  bindRailExtBridge,
  clearRailExt,
  renderRailExt,
}
