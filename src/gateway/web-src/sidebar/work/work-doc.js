// work 文档预览（2026-10-24 待办 4）：`.xlsx` / `.docx` 的**只读前端渲染**。UI 口径参照 dsh
// （packages/client/ui-sidebar-documentpreview）——Excel = 行列表头网格 + 顶部文件条 + 底部工作表标签；
// Word = 居中的纸张页 + 正文/标题/表格排版。实现不引第三方解析器：ZIP 解压走 `web/vendor/fflate.js`
// （window.fflate），XML 走浏览器 DOMParser。边界：公式只显缓存值（不求值）、图片/图表/批注跳过；
// 行列超上限截断并显式提示（不静默丢数据）。
/* @module sidebar/work/work-doc.js */

  const WK_DOC_MAX_ROWS = 300
  const WK_DOC_MAX_COLS = 60

  function wkDocKind(path) {
    if (/\.xlsx$/i.test(path)) return 'xlsx'
    if (/\.docx$/i.test(path)) return 'docx'
    return ''
  }

  function wkDocUnzip(buf) {
    const F = window.fflate
    if (!F || !F.unzipSync) throw new Error('解压组件未加载（vendor/fflate.js）')
    return F.unzipSync(new Uint8Array(buf))
  }

  function wkDocText(files, name) {
    const b = files[name]
    return b ? new TextDecoder('utf-8').decode(b) : ''
  }

  function wkDocXml(files, name) {
    const s = wkDocText(files, name)
    if (!s) return null
    const d = new DOMParser().parseFromString(s, 'application/xml')
    return d.getElementsByTagName('parsererror').length ? null : d
  }

  function wkDocAll(root, tag) { return root ? Array.from(root.getElementsByTagNameNS('*', tag)) : [] }
  function wkDocKids(el, tag) { return el ? Array.from(el.children).filter((c) => c.localName === tag) : [] }
  function wkDocAttr(el, name) {
    if (!el) return ''
    for (const a of el.attributes) if (a.localName === name || a.name === name) return a.value
    return ''
  }
  // OOXML 开关：元素在场 = 开，val="0/false/off" = 关
  function wkDocOn(el) { return !!el && !/^(0|false|off)$/i.test(wkDocAttr(el, 'val')) }
  // ARGB / RRGGBB → #rrggbb（非法返回空）
  function wkDocRgb(v) {
    const s = String(v || '').replace(/^#/, '')
    const h = s.length === 8 ? s.slice(2) : s
    return /^[0-9a-f]{6}$/i.test(h) ? '#' + h.toLowerCase() : ''
  }

  // ---------- XLSX ----------
  function wkDocNum(raw, xf, styles) {
    const n = Number(raw)
    if (raw === '' || !Number.isFinite(n)) return raw
    const code = (styles.numFmts[xf.numFmtId] || '').replace(/\[[^\]]*\]/g, '').replace(/"[^"]*"/g, '')
    if (/%/.test(code)) {
      const d = (code.split('.')[1] || '').replace(/[^0#]/g, '').length
      return (n * 100).toFixed(d) + '%'
    }
    // 纯日期/时间格式（含 y/m/d/h/s，且不含数字占位符）→ 按 1900 日期系统换算
    if (/[ymdhs]/i.test(code) && !/[#0]/.test(code)) {
      const ms = Math.round((n - 25569) * 86400000)
      const d = new Date(ms)
      const p2 = (x) => String(x).padStart(2, '0')
      const date = d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate())
      return /[hs]/i.test(code) ? date + ' ' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) : date
    }
    const dec = /\.(0+)/.exec(code)
    if (dec) return n.toFixed(dec[1].length)
    if (/#,##0/.test(code)) return Math.round(n).toLocaleString('en-US')
    return String(n)
  }

  function wkDocParseStyles(files) {
    const doc = wkDocXml(files, 'xl/styles.xml')
    const st = { fonts: [], fills: [], borders: [], xfs: [], numFmts: {} }
    if (!doc) return st
    for (const nf of wkDocAll(doc, 'numFmt')) st.numFmts[wkDocAttr(nf, 'numFmtId')] = wkDocAttr(nf, 'formatCode')
    for (const f of wkDocKids(wkDocAll(doc, 'fonts')[0], 'font')) {
      const color = wkDocKids(f, 'color')[0]
      st.fonts.push({
        b: wkDocKids(f, 'b').some(wkDocOn),
        i: wkDocKids(f, 'i').some(wkDocOn),
        u: wkDocKids(f, 'u').length > 0,
        s: wkDocKids(f, 'strike').length > 0,
        color: wkDocRgb(wkDocAttr(color, 'rgb')),
        sz: Number(wkDocAttr(wkDocKids(f, 'sz')[0], 'val')) || 0,
      })
    }
    for (const f of wkDocKids(wkDocAll(doc, 'fills')[0], 'fill')) {
      const pf = wkDocKids(f, 'patternFill')[0]
      const fg = wkDocKids(pf, 'fgColor')[0]
      st.fills.push(pf && /solid/i.test(wkDocAttr(pf, 'patternType')) && fg ? wkDocRgb(wkDocAttr(fg, 'rgb')) : '')
    }
    for (const b of wkDocKids(wkDocAll(doc, 'borders')[0], 'border')) {
      st.borders.push(['left', 'right', 'top', 'bottom'].some((side) => {
        const e = wkDocKids(b, side)[0]
        const style = wkDocAttr(e, 'style')
        return !!style && style !== 'none'
      }))
    }
    for (const x of wkDocKids(wkDocAll(doc, 'cellXfs')[0], 'xf')) {
      const al = wkDocKids(x, 'alignment')[0]
      st.xfs.push({
        numFmtId: wkDocAttr(x, 'numFmtId') || '0',
        fontId: Number(wkDocAttr(x, 'fontId')) || 0,
        fillId: Number(wkDocAttr(x, 'fillId')) || 0,
        borderId: Number(wkDocAttr(x, 'borderId')) || 0,
        h: wkDocAttr(al, 'horizontal'),
        v: wkDocAttr(al, 'vertical'),
        wrap: /^(1|true)$/i.test(wkDocAttr(al, 'wrapText')),
      })
    }
    return st
  }

  function wkDocShared(files) {
    const doc = wkDocXml(files, 'xl/sharedStrings.xml')
    return wkDocAll(doc, 'si').map((si) => wkDocAll(si, 't').map((t) => t.textContent || '').join(''))
  }

  function wkDocResolve(target) {
    const t = String(target || '').replace(/\\/g, '/')
    const parts = (t.startsWith('/') ? t.slice(1) : 'xl/' + t).split('/')
    const out = []
    for (const p of parts) {
      if (!p || p === '.') continue
      if (p === '..') out.pop()
      else out.push(p)
    }
    return out.join('/')
  }

  function wkDocSheets(files) {
    const wb = wkDocXml(files, 'xl/workbook.xml')
    const rels = wkDocXml(files, 'xl/_rels/workbook.xml.rels')
    const map = {}
    for (const r of wkDocAll(rels, 'Relationship')) map[wkDocAttr(r, 'Id')] = wkDocResolve(wkDocAttr(r, 'Target'))
    return wkDocAll(wb, 'sheet')
      .map((s) => ({ name: wkDocAttr(s, 'name') || 'Sheet', state: wkDocAttr(s, 'state') || 'visible', file: map[wkDocAttr(s, 'id')] || '' }))
      .filter((s) => s.state !== 'hidden' && s.file)
  }

  function wkDocColIndex(ref) {
    let n = 0
    for (const ch of String(ref || '').replace(/\d+$/, '')) n = n * 26 + (ch.toUpperCase().charCodeAt(0) - 64)
    return n - 1
  }
  function wkDocColName(i) {
    let s = ''
    for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s
    return s
  }

  function wkDocParseSheet(files, sheet, shared, styles) {
    const doc = wkDocXml(files, sheet.file)
    const root = doc && wkDocAll(doc, 'worksheet')[0]
    const out = { name: sheet.name, cells: {}, merges: {}, covered: new Set(), widths: {}, heights: {}, nrows: 0, ncols: 0, truncated: false }
    if (!root) return out
    // 列宽（Excel 字符宽 → 像素，与 dsh 同式）与隐藏列
    for (const col of wkDocKids(wkDocKids(root, 'cols')[0], 'col')) {
      if (/^(1|true)$/i.test(wkDocAttr(col, 'hidden'))) continue
      const a = Number(wkDocAttr(col, 'min')) - 1
      const b = Number(wkDocAttr(col, 'max')) - 1
      const w = Number(wkDocAttr(col, 'width'))
      if (!Number.isFinite(w) || w <= 0) continue
      for (let i = a; i <= Math.min(b, WK_DOC_MAX_COLS - 1); i++) out.widths[i] = Math.max(18, Math.floor(w < 1 ? w * 12 : w * 7 + 5))
    }
    const rows = wkDocKids(wkDocKids(root, 'sheetData')[0], 'row')
    rows.forEach((row, ri) => {
      const r = Number(wkDocAttr(row, 'r')) - 1 || ri
      const ht = Number(wkDocAttr(row, 'ht'))
      if (Number.isFinite(ht) && ht > 0) out.heights[r] = Math.round(ht * 96 / 72)
      let ci = -1
      for (const c of wkDocKids(row, 'c')) {
        const ref = wkDocAttr(c, 'r')
        ci = ref ? wkDocColIndex(ref) : ci + 1
        if (r >= WK_DOC_MAX_ROWS || ci >= WK_DOC_MAX_COLS) { out.truncated = true; continue }
        out.nrows = Math.max(out.nrows, r + 1)
        out.ncols = Math.max(out.ncols, ci + 1)
        const xi = Number(wkDocAttr(c, 's')) || 0
        const xf = styles.xfs[xi] || { numFmtId: '0', fontId: 0, fillId: 0, borderId: 0 }
        const type = wkDocAttr(c, 't')
        const raw = (wkDocKids(c, 'v')[0] || {}).textContent || ''
        let v = ''
        if (type === 's') v = shared[Number(raw)] || ''
        else if (type === 'inlineStr') v = wkDocAll(c, 't').map((t) => t.textContent || '').join('')
        else if (type === 'b') v = raw === '1' ? 'TRUE' : 'FALSE'
        else if (type === 'str' || type === 'e') v = raw
        else v = wkDocNum(raw, xf, styles)
        out.cells[r + '_' + ci] = { v, style: wkDocCellStyle(xf, styles, /^-?[\d.]+$/.test(v)), raw }
      }
    })
    for (const m of wkDocAll(root, 'mergeCell')) {
      const [a, b] = String(wkDocAttr(m, 'ref')).split(':')
      if (!a || !b) continue
      const r0 = Number(String(a).replace(/^[A-Z]+/i, '')) - 1
      const c0 = wkDocColIndex(a)
      const r1 = Number(String(b).replace(/^[A-Z]+/i, '')) - 1
      const c1 = wkDocColIndex(b)
      if ([r0, c0, r1, c1].some((x) => !Number.isFinite(x))) continue
      out.merges[r0 + '_' + c0] = { rs: Math.max(1, r1 - r0 + 1), cs: Math.max(1, c1 - c0 + 1) }
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (r !== r0 || c !== c0) out.covered.add(r + '_' + c)
      out.nrows = Math.max(out.nrows, r1 + 1)
      out.ncols = Math.max(out.ncols, c1 + 1)
    }
    out.nrows = Math.min(out.nrows, WK_DOC_MAX_ROWS)
    out.ncols = Math.min(out.ncols, WK_DOC_MAX_COLS)
    return out
  }

  function wkDocCellStyle(xf, styles, numeric) {
    const bits = []
    const f = styles.fonts[xf.fontId] || {}
    if (f.b) bits.push('font-weight:600')
    if (f.i) bits.push('font-style:italic')
    if (f.u || f.s) bits.push('text-decoration:' + [f.u ? 'underline' : '', f.s ? 'line-through' : ''].filter(Boolean).join(' '))
    if (f.color) bits.push('color:' + f.color)
    if (f.sz && f.sz >= 20) bits.push('font-size:' + Math.round(f.sz * 96 / 72) + 'px')
    if (styles.fills[xf.fillId]) bits.push('background:' + styles.fills[xf.fillId])
    if (styles.borders[xf.borderId]) bits.push('border:1px solid var(--border)')
    if (xf.wrap) bits.push('white-space:pre-wrap')
    if (xf.h === 'center') bits.push('text-align:center')
    else if (xf.h === 'right') bits.push('text-align:right')
    else if (numeric) bits.push('text-align:right')
    if (xf.v === 'center') bits.push('vertical-align:middle')
    else if (xf.v === 'top') bits.push('vertical-align:top')
    return bits.join(';')
  }

  function wkDocRenderXlsx(body, path, buf) {
    const files = wkDocUnzip(buf)
    const styles = wkDocParseStyles(files)
    const shared = wkDocShared(files)
    const sheets = wkDocSheets(files)
    if (!sheets.length) throw new Error('工作簿没有可预览的工作表')
    const parsed = sheets.map((s) => wkDocParseSheet(files, s, shared, styles))
    const wrap = document.createElement('div')
    wrap.className = 'wk-doc wk-doc-xlsx'
    const bar = document.createElement('div')
    bar.className = 'wk-doc-bar'
    const nm = document.createElement('span')
    nm.className = 'wk-doc-name'
    nm.textContent = String(path).split('/').pop()
    const meta = document.createElement('span')
    meta.className = 'wk-doc-meta'
    meta.textContent = '只读预览 · ' + parsed.length + ' 个工作表'
    bar.append(nm, meta)
    const grid = document.createElement('div')
    grid.className = 'wk-doc-grid'
    const tabs = document.createElement('div')
    tabs.className = 'wk-doc-tabs'
    let active = 0
    const draw = () => {
      const sh = parsed[active]
      grid.textContent = ''
      if (sh.truncated) {
        const note = document.createElement('div')
        note.className = 'wk-doc-note'
        note.textContent = `超出预览上限，仅显示前 ${WK_DOC_MAX_ROWS} 行 / ${WK_DOC_MAX_COLS} 列`
        grid.appendChild(note)
      }
      const table = document.createElement('table')
      table.className = 'wk-doc-table'
      const thead = document.createElement('thead')
      const hrow = document.createElement('tr')
      const corner = document.createElement('th')
      corner.className = 'wk-doc-corner'
      hrow.appendChild(corner)
      for (let c = 0; c < sh.ncols; c++) {
        const th = document.createElement('th')
        th.className = 'wk-doc-ch'
        th.textContent = wkDocColName(c)
        if (sh.widths[c]) th.style.minWidth = sh.widths[c] + 'px'
        hrow.appendChild(th)
      }
      thead.appendChild(hrow)
      table.appendChild(thead)
      const tbody = document.createElement('tbody')
      for (let r = 0; r < sh.nrows; r++) {
        const tr = document.createElement('tr')
        if (sh.heights[r]) tr.style.height = sh.heights[r] + 'px'
        const rh = document.createElement('th')
        rh.className = 'wk-doc-rh'
        rh.textContent = String(r + 1)
        tr.appendChild(rh)
        for (let c = 0; c < sh.ncols; c++) {
          if (sh.covered.has(r + '_' + c)) continue
          const td = document.createElement('td')
          const mg = sh.merges[r + '_' + c]
          if (mg) {
            if (mg.cs > 1) td.colSpan = mg.cs
            if (mg.rs > 1) td.rowSpan = mg.rs
            td.className = 'wk-doc-merged'
          }
          const cell = sh.cells[r + '_' + c]
          if (cell) {
            td.textContent = cell.v
            if (cell.style) td.setAttribute('style', cell.style)
          }
          if (sh.widths[c]) td.style.minWidth = sh.widths[c] + 'px'
          tr.appendChild(td)
        }
        tbody.appendChild(tr)
      }
      table.appendChild(tbody)
      grid.appendChild(table)
      for (const [i, b] of Array.from(tabs.children).entries()) b.classList.toggle('on', i === active)
    }
    parsed.forEach((sh, i) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'wk-doc-tab'
      b.textContent = sh.name
      b.addEventListener('click', () => { active = i; draw() })
      tabs.appendChild(b)
    })
    wrap.append(bar, grid)
    if (parsed.length > 1) wrap.appendChild(tabs)
    body.textContent = ''
    body.appendChild(wrap)
    draw()
  }

  // ---------- DOCX ----------
  function wkDocDocxStyles(files) {
    const doc = wkDocXml(files, 'word/styles.xml')
    const out = {}
    for (const s of wkDocAll(doc, 'style')) {
      const id = wkDocAttr(s, 'styleId')
      if (id) out[id] = wkDocAttr(wkDocKids(s, 'name')[0], 'val')
    }
    return out
  }

  function wkDocDocxRun(r) {
    const rPr = wkDocKids(r, 'rPr')[0]
    const frag = document.createDocumentFragment()
    const style = []
    if (wkDocKids(rPr, 'b').some(wkDocOn)) style.push('font-weight:600')
    if (wkDocKids(rPr, 'i').some(wkDocOn)) style.push('font-style:italic')
    const u = wkDocKids(rPr, 'u')[0]
    if (u && wkDocAttr(u, 'val') !== 'none') style.push('text-decoration:underline')
    if (wkDocKids(rPr, 'strike').some(wkDocOn)) style.push('text-decoration:line-through')
    const color = wkDocRgb(wkDocAttr(wkDocKids(rPr, 'color')[0], 'rgb'))
    if (color) style.push('color:' + color)
    const sz = Number(wkDocAttr(wkDocKids(rPr, 'sz')[0], 'val'))
    if (Number.isFinite(sz) && sz > 0) style.push('font-size:' + (sz / 2) + 'pt')
    for (const node of Array.from(r.children)) {
      if (node.localName === 't') {
        const span = document.createElement('span')
        if (style.length) span.setAttribute('style', style.join(';'))
        span.textContent = node.textContent || ''
        frag.appendChild(span)
      } else if (node.localName === 'tab') {
        frag.appendChild(document.createTextNode('\u00a0\u00a0\u00a0\u00a0'))
      } else if (node.localName === 'br' || node.localName === 'cr') {
        frag.appendChild(document.createElement('br'))
      }
    }
    return frag
  }

  function wkDocDocxP(p, styles) {
    const pPr = wkDocKids(p, 'pPr')[0]
    const sid = wkDocAttr(wkDocKids(pPr, 'pStyle')[0], 'val')
    const name = String(styles[sid] || '').toLowerCase()
    const h = /^heading\s*([1-6])$/.exec(name) || /^heading([1-6])$/.exec(String(sid).toLowerCase())
    const numbered = !!wkDocKids(pPr, 'numPr')[0]
    const el = document.createElement(h ? 'h' + h[1] : numbered ? 'div' : 'p')
    if (h) el.className = 'wk-doc-h' + h[1]
    else if (numbered) el.className = 'wk-doc-li'
    const jc = wkDocAttr(wkDocKids(pPr, 'jc')[0], 'val')
    if (jc) el.style.textAlign = jc === 'center' ? 'center' : jc === 'right' ? 'right' : jc === 'both' ? 'justify' : 'left'
    for (const node of Array.from(p.children)) {
      if (node.localName === 'r') el.appendChild(wkDocDocxRun(node))
      else if (node.localName === 'hyperlink') for (const r of wkDocKids(node, 'r')) el.appendChild(wkDocDocxRun(r))
    }
    if (!el.textContent && !el.querySelector('br')) el.appendChild(document.createElement('br'))
    return el
  }

  function wkDocDocxTbl(tbl, styles) {
    const table = document.createElement('table')
    table.className = 'wk-doc-dtable'
    for (const tr of wkDocKids(tbl, 'tr')) {
      const row = document.createElement('tr')
      for (const tc of wkDocKids(tr, 'tc')) {
        const td = document.createElement('td')
        const tcPr = wkDocKids(tc, 'tcPr')[0]
        const span = Number(wkDocAttr(wkDocKids(tcPr, 'gridSpan')[0], 'val')) || 1
        if (span > 1) td.colSpan = span
        const fill = wkDocRgb(wkDocAttr(wkDocKids(tcPr, 'shd')[0], 'fill'))
        if (fill) td.style.background = fill
        for (const p of wkDocKids(tc, 'p')) td.appendChild(wkDocDocxP(p, styles))
        row.appendChild(td)
      }
      table.appendChild(row)
    }
    return table
  }

  function wkDocRenderDocx(body, path, buf) {
    const files = wkDocUnzip(buf)
    const doc = wkDocXml(files, 'word/document.xml')
    const root = doc && wkDocAll(doc, 'body')[0]
    if (!root) throw new Error('文档结构缺失（word/document.xml）')
    const styles = wkDocDocxStyles(files)
    const wrap = document.createElement('div')
    wrap.className = 'wk-doc wk-doc-docx'
    const bar = document.createElement('div')
    bar.className = 'wk-doc-bar'
    const nm = document.createElement('span')
    nm.className = 'wk-doc-name'
    nm.textContent = String(path).split('/').pop()
    const meta = document.createElement('span')
    meta.className = 'wk-doc-meta'
    meta.textContent = '只读预览 · Word'
    bar.append(nm, meta)
    const page = document.createElement('div')
    page.className = 'wk-doc-page'
    for (const child of Array.from(root.children)) {
      if (child.localName === 'p') page.appendChild(wkDocDocxP(child, styles))
      else if (child.localName === 'tbl') page.appendChild(wkDocDocxTbl(child, styles))
    }
    wrap.append(bar, page)
    body.textContent = ''
    body.appendChild(wrap)
  }

  // 统一入口：work-editor.readFile 在 PDF/图片分支之后调用（抛错由调用方落「读取失败」）
  function wkDocRender(body, path, buf) {
    const kind = wkDocKind(path)
    if (kind === 'xlsx') return wkDocRenderXlsx(body, path, buf)
    if (kind === 'docx') return wkDocRenderDocx(body, path, buf)
    throw new Error('不支持的文档类型')
  }
