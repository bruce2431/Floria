// default.js —— 默认项目预览页（GitHub 仓库风格）：从网关 /gateway/project 拉项目数据，
// 渲染 文件树 + README + About + 会话列表；会话点击 postMessage 通知父级（app.js）打开会话。
(function () {
  'use strict'
  const $ = (id) => document.getElementById(id)

  // 从 URL 解析项目 label（/default-preview/<label>/）与 token
  const pm = location.pathname.match(/^\/default-preview\/([^/]+)/)
  const label = pm ? decodeURIComponent(pm[1]) : ''
  const token = new URLSearchParams(location.search).get('token') || ''

  // ---------------- 工具 ----------------
  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
  function relTime(ts) {
    if (!ts) return '—'
    const d = Date.now() - ts
    if (d < 60e3) return '刚刚'
    if (d < 3600e3) return Math.floor(d / 60e3) + ' 分钟前'
    if (d < 86400e3) return Math.floor(d / 3600e3) + ' 小时前'
    if (d < 2592e6) return Math.floor(d / 86400e3) + ' 天前'
    const dt = new Date(ts)
    return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0')
  }

  // ---------------- 行内 markdown ----------------
  function inline(t) {
    t = esc(t)
    t = t.replace(/`([^`]+)`/g, (m, c) => '<code>' + c + '</code>')
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, a, u) => '<img alt="' + a + '" src="' + u + '" />')
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, a, u) =>
      /^(https?:|data:|#|\/)/.test(u) ? '<a href="' + u + '" target="_blank" rel="noopener">' + a + '</a>' : '<a href="' + u + '">' + a + '</a>',
    )
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>')
    return t
  }

  // ---------------- 块级 markdown ----------------
  function renderMarkdown(md) {
    const lines = md.split(/\r?\n/)
    let html = ''
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (/^```/.test(line)) {
        const out = []
        let j = i + 1
        while (j < lines.length && !/^```/.test(lines[j])) { out.push(lines[j]); j++ }
        html += '<pre><code>' + esc(out.join('\n')) + '</code></pre>\n'
        i = j + 1
        continue
      }
      if (line.trim().startsWith('|') && i + 1 < lines.length && /^\s*\|[\s:|-]+\|?\s*$/.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        const rows = []
        while (i < lines.length && lines[i].trim().startsWith('|')) { rows.push(lines[i].trim()); i++ }
        html += tableHtml(rows)
        continue
      }
      const hm = /^(#{1,6})\s+(.*)$/.exec(line)
      if (hm) {
        const lv = hm[1].length
        html += '<h' + lv + '>' + inline(hm[2]) + '</h' + lv + '>\n'
        i++
        continue
      }
      if (/^\s*([-*_])\s*(?:\1\s*){2,}$/.test(line)) { html += '<hr>\n'; i++; continue }
      if (/^\s*>\s?/.test(line)) {
        const out = []
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { out.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
        html += '<blockquote>' + renderMarkdown(out.join('\n')) + '</blockquote>\n'
        continue
      }
      if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
        const out = []
        const ol = /^\s*\d+\.\s+/.test(line)
        while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
          const task = /^\s*([-*+]|\d+\.)\s+\[([ xX])\]\s*(.*)$/.exec(lines[i])
          if (task) out.push('<li class="task-item"><input type="checkbox" disabled' + (task[2].toLowerCase() === 'x' ? ' checked' : '') + ' /> ' + inline(task[3]) + '</li>')
          else out.push('<li>' + inline(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, '')) + '</li>')
          i++
        }
        html += (ol ? '<ol>' : '<ul>') + out.join('') + (ol ? '</ol>' : '</ul>') + '\n'
        continue
      }
      if (!line.trim()) { i++; continue }
      const para = []
      while (
        i < lines.length && lines[i].trim() &&
        !/^#{1,6}\s/.test(lines[i]) && !/^```/.test(lines[i]) &&
        !/^\s*([-*+]|\d+\.)\s+/.test(lines[i]) && !/^\s*>/.test(lines[i])
      ) { para.push(lines[i]); i++ }
      html += '<p>' + inline(para.join(' ')) + '</p>\n'
    }
    return html
  }
  function tableHtml(rows) {
    const parse = (r) => r.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
    const header = parse(rows[0])
    let h = '<table><thead><tr>' + header.map((c) => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>'
    for (let k = 2; k < rows.length; k++) h += '<tr>' + parse(rows[k]).map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>'
    return h + '</tbody></table>\n'
  }

  // ---------------- 文件树 ----------------
  const ICON_DIR = '<svg class="t-ic tree-ic-dir" viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.4l-.9-1.2C6.07 1.16 5.55 1 5.02 1H1.75Z"/></svg>'
  const ICON_FILE = '<svg class="t-ic tree-ic-file" viewBox="0 0 16 16" fill="currentColor"><path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"/></svg>'
  const ICON_CHEV = '<svg class="t-chev" viewBox="0 0 16 16" fill="currentColor"><path d="M6 4l4 4-4 4V4z"/></svg>'

  function treeHtml(nodes, depth) {
    let h = ''
    for (const n of nodes) {
      const pad = 'padding-left:' + (8 + depth * 16) + 'px'
      if (n.type === 'dir') {
        // 默认折叠：目录不挂 open，点击才展开（tree-row.dir + .tree-children 联动）
        h += '<div class="tree-row dir" style="' + pad + '">' + ICON_CHEV + ICON_DIR + '<span class="t-name">' + esc(n.name) + '</span></div>'
        h += '<div class="tree-children">' + (n.children ? treeHtml(n.children, depth + 1) : '') + '</div>'
      } else {
        h += '<div class="tree-row" style="' + pad + '">' + ICON_FILE + '<span class="t-name">' + esc(n.name) + '</span></div>'
      }
    }
    return h
  }

  // ---------------- 主渲染 ----------------
  function render(data) {
    document.title = data.label + ' · 项目主页'
    const name = $('repo-name')
    if (name) name.textContent = data.label
    const desc = $('repo-desc')
    if (desc) desc.textContent = data.description || '（无描述）'
    const sc = $('sess-count')
    if (sc) sc.textContent = data.sessionCount || 0

    // 文件树
    const fl = $('file-list')
    if (fl) {
      if (data.files && data.files.length) {
        fl.innerHTML = treeHtml(data.files, 0)
        fl.querySelectorAll('.tree-row.dir').forEach((r) =>
          r.addEventListener('click', () => r.classList.toggle('open')),
        )
      } else {
        fl.innerHTML = '<div class="tree-empty">无文件（仅会话项目）</div>'
      }
    }

    // README
    const rb = $('readme-body')
    if (rb) {
      rb.classList.remove('loading')
      rb.innerHTML = data.readme
        ? renderMarkdown(data.readme)
        : '<p class="tree-empty" style="padding:0">此项目没有 README 文件。</p>'
    }

    // 会话
    renderSessions(data.sessions || [])
  }

  function renderSessions(sessions) {
    const el = $('sessions-list')
    if (!el) return
    if (!sessions.length) {
      el.innerHTML = '<div class="tree-empty">该项目暂无会话</div>'
      return
    }
    el.innerHTML = sessions
      .map(
        (s) =>
          '<div class="sess-row" data-hash="' + esc(s.hash) + '">' +
          '<span class="sess-ico"><svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V2.75C2 1.784 2.784 1 3.75 1ZM8.5 4a.75.75 0 0 0-1.5 0v4a.75.75 0 0 0 1.5 0ZM8 10a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z"/></svg></span>' +
          '<span class="sess-title">' + esc(s.title || '（未命名会话）') + '</span>' +
          '<span class="sess-meta">' + (s.messageCount || 0) + ' 条 · ' + relTime(s.updatedAt) + '</span>' +
          '<span class="sess-open">打开 ›</span>' +
          '</div>',
      )
      .join('')
    el.querySelectorAll('.sess-row').forEach((r) =>
      r.addEventListener('click', () => {
        // 通知父级（app.js）打开该会话：父级监听 floria-open-session
        window.parent.postMessage({ type: 'floria-open-session', hash: r.dataset.hash }, '*')
      }),
    )
  }

  // ---------------- tab 切换 ----------------
  document.querySelectorAll('.repo-tab').forEach((t) =>
    t.addEventListener('click', () => {
      document.querySelectorAll('.repo-tab').forEach((x) => x.classList.toggle('on', x === t))
      document.querySelectorAll('.repo-view').forEach((v) => v.classList.toggle('on', v.id === 'view-' + t.dataset.tab))
    }),
  )

  // ---------------- 拉取数据 ----------------
  const api = '/gateway/project?label=' + encodeURIComponent(label) + (token ? '&token=' + encodeURIComponent(token) : '')
  fetch(api)
    .then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    })
    .then(render)
    .catch((err) => {
      const rb = $('readme-body')
      if (rb) {
        rb.classList.remove('loading')
        rb.innerHTML = '<div class="tree-empty">项目数据加载失败：' + esc(err.message) + '</div>'
      }
      const fl = $('file-list')
      if (fl) fl.innerHTML = '<div class="tree-empty">加载失败</div>'
    })
})()
