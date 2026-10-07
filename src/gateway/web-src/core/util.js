// 基础工具（HTML 转义 / toast / 设备判定 / 新会话落项目）（2026-10-07 自 core/state.js 拆出；唯一手改处，web/app.js 为生成物）

import { state, toastEl } from './state.js'
  // ---------- 工具 ----------
  let timer = null

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))


  function toast(msg) {
    toastEl.textContent = msg
    toastEl.hidden = false
    clearTimeout(timer)
    timer = setTimeout(() => (toastEl.hidden = true), 2600)
  }

  // 新会话的落项目（唯一真源）：work 模式 = 「在项目中工作」，目标项目恒 = 工作项目（state.workProj）；
  // 其余情况 = chat 侧栏/初始界面选的 state.newProject（null = 全局）。所有建会话/上传的落项目判定
  // 都读本函数——写死 state.newProject 的消费点会在 work 模式下漏掉工作项目（会话落到全局）。
  function newSessionProject() {
    return state.sbMode === 'work' && state.workProj ? state.workProj : state.newProject
  }

  // 手机端（≤720px）：侧栏为全屏抽屉，选择会话后自动收起
  const isMobile = () => window.matchMedia('(max-width: 720px)').matches
  // 纯触屏设备（iPad/iPhone Safari）：打开弹层时不得程序化聚焦输入框——iOS 会因此弹出系统键盘
  // （2026-08-28：+ 命令菜单搜索框 / 模型菜单回填输入栏焦点均被识别为文本输入；桌面不受影响，方向键导航保留）
  const isTouch = () => window.matchMedia('(hover: none) and (pointer: coarse)').matches

export {
  esc,
  isMobile,
  isTouch,
  newSessionProject,
  toast,
}
