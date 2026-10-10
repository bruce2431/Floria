// 角色形象切换（2026-09-10 web-src 模块化切割自 app.js v287；唯一手改处，web/app.js 为生成物）

/* @module core/char.js */
  // 一元素一所有者：本模块自持 #char 句柄（原取 engine/state.js ⇒ core→engine 逆向边）。
  const charEl = $('char')
  // ---------- 角色形象（2026-08-14 实验） ----------
  // 右侧空缺处的 AI 形象随操作类型切换：读取/搜索=3、书写/编辑=2、执行代码/插件/命令行=4、其余（思考/输出/空闲）=1。
  const CHAR_READ = /^(read|grep|glob|web(fetch|search)|search|lookup|view|show|list|ls|cat|head|tail|find)$/i
  const CHAR_WRITE = /^(edit|write|notebookedit|todowrite|task(create|update|get|list|stop|delete)?)$/i
  const CHAR_EXEC = /^(bash|skill|agent|task|mcp__plugin|plugin:|kill|bash_sandbox|run)/i
  function toolToChar(name) {
    const n = String(name || '').toLowerCase()
    if (CHAR_EXEC.test(n)) return 4
    if (CHAR_READ.test(n)) return 3
    if (CHAR_WRITE.test(n)) return 2
    return 1
  }
  function setChar(n) {
    if (!charEl) return
    charEl.src = '/char/' + n + '.jpg'
  }

export {
  CHAR_EXEC,
  CHAR_READ,
  CHAR_WRITE,
  setChar,
  toolToChar,
}
