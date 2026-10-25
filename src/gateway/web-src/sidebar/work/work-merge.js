// 行级三方合并（编辑卡外部改动 + 本地未落盘编辑）。纯函数，无 DOM/网络依赖。
// base = 上次与磁盘一致的内容，local = 编辑器当前内容，remote = 磁盘新内容。
// 返回 { ok:true, text } 或 { ok:false, reason }（reason='conflict' | 'too-large'）。
// 算法 = patience diff（剥公共前后缀 → 唯一行锚点 + LIS 递归切分 → 无锚点整段视为替换）：
// 不用 Myers 是为了避免大文件整篇重写时 O(D²) 的 trace 内存；合并判定只需要「变动块」，
// 粗粒度整段替换在重叠判定上只会更保守（宁判冲突不误合）。
/* @module sidebar/work/work-merge.js */

  // 参与合并的规模上限：超限直接交回调用方走非模态提示（不在这里做压缩/截断）。
  const WK_MERGE_MAX_LINES = 20000

  function wkMergeSplit(text) {
    return String(text == null ? '' : text).split('\n')
  }

  // 两个变动块是否算冲突。同一起止（含同点插入）＝同一处两边都动 → 冲突；半开区间严格相交也算重叠。
  // 纯插入（be===bs）落在另一侧变动区间的**内部**同样判冲突——插到别人替换掉的段中间无法有序拼接；
  // 落在边界（bs/be 上）则可以，按 bs 排序后先插入再替换即等价。
  function wkBlocksOverlap(x, y) {
    if (x.bs === y.bs && x.be === y.be) return true
    if (x.bs === x.be) return y.bs < x.bs && x.bs < y.be
    if (y.bs === y.be) return x.bs < y.bs && y.bs < x.be
    return Math.max(x.bs, y.bs) < Math.min(x.be, y.be)
  }

  // 区间 [as,ae) 与 [bs,be) 内「两侧都唯一」的行配对，按 b 侧顺序取 a 索引的最长上升子序列（LIS）。
  // 返回 [[ai, bi], …]，用作递归切分的锚点（patience diff 核心）。
  function wkUniqueAnchors(a, as, ae, b, bs, be) {
    const cntA = new Map()
    const posA = new Map()
    for (let i = as; i < ae; i++) {
      cntA.set(a[i], (cntA.get(a[i]) || 0) + 1)
      posA.set(a[i], i)
    }
    const cand = []
    const seenB = new Set()
    for (let j = bs; j < be; j++) {
      const line = b[j]
      if (cntA.get(line) !== 1) continue
      if (seenB.has(line)) continue // b 侧重复出现 → 不是唯一，跳过
      seenB.add(line)
      cand.push([posA.get(line), j])
    }
    if (!cand.length) return []
    // LIS（按 a 索引上升），O(n log n)；tails 存候选下标，prev 回溯配对序列
    const tails = []
    const prev = new Array(cand.length).fill(-1)
    for (let i = 0; i < cand.length; i++) {
      const v = cand[i][0]
      let lo = 0
      let hi = tails.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (cand[tails[mid]][0] < v) lo = mid + 1
        else hi = mid
      }
      if (lo > 0) prev[i] = tails[lo - 1]
      tails[lo] = i
    }
    const seq = []
    for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) seq.push(cand[k])
    return seq.reverse()
  }

  // base → other 的变动块列表：[{bs,be,os,oe,src}]（base 区间 [bs,be) 换成 src[os,oe)）。
  // 显式栈而非递归：极长文件里锚点可能只切掉一行，递归深度会打穿调用栈。
  function wkDiffBlocks(base, other, src) {
    const out = []
    const stack = [[0, base.length, 0, other.length]]
    while (stack.length) {
      let [as, ae, bs, be] = stack.pop()
      while (as < ae && bs < be && base[as] === other[bs]) { as++; bs++ }
      while (as < ae && bs < be && base[ae - 1] === other[be - 1]) { ae--; be-- }
      if (as === ae && bs === be) continue
      if (as === ae || bs === be) {
        out.push({ bs: as, be: ae, os: bs, oe: be, src })
        continue
      }
      const anchors = wkUniqueAnchors(base, as, ae, other, bs, be)
      if (!anchors.length) {
        out.push({ bs: as, be: ae, os: bs, oe: be, src })
        continue
      }
      let pa = as
      let pb = bs
      for (const [ai, bi] of anchors) {
        if (ai > pa || bi > pb) stack.push([pa, ai, pb, bi])
        pa = ai + 1
        pb = bi + 1
      }
      if (pa < ae || pb < be) stack.push([pa, ae, pb, be])
    }
    out.sort((x, y) => x.bs - y.bs || x.be - y.be || x.os - y.os)
    return out
  }

  function wkMerge3(base, local, remote) {
    const b0 = String(base == null ? '' : base)
    const l0 = String(local == null ? '' : local)
    const r0 = String(remote == null ? '' : remote)
    if (l0 === b0) return { ok: true, text: r0 } // 本地无改动：直接取磁盘版
    if (r0 === b0 || r0 === l0) return { ok: true, text: l0 } // 磁盘无改动 / 两侧一致
    const bl = wkMergeSplit(b0)
    const ll = wkMergeSplit(l0)
    const rl = wkMergeSplit(r0)
    if (bl.length > WK_MERGE_MAX_LINES || ll.length > WK_MERGE_MAX_LINES || rl.length > WK_MERGE_MAX_LINES) {
      return { ok: false, reason: 'too-large' }
    }
    const lb = wkDiffBlocks(bl, ll, ll)
    const rb = wkDiffBlocks(bl, rl, rl)
    // 冲突检测：两个块列表各自按 bs 升序且内部不重叠 → 双指针即可
    let i = 0
    let j = 0
    while (i < lb.length && j < rb.length) {
      const x = lb[i]
      const y = rb[j]
      if (wkBlocksOverlap(x, y)) return { ok: false, reason: 'conflict' }
      if (x.be <= y.bs) i++
      else j++
    }
    // 应用：按 base 位置顺序输出，插入块（be===bs）先于同起点的替换块
    const all = lb.concat(rb).sort((x, y) => x.bs - y.bs || x.be - y.be)
    const out = []
    let p = 0
    for (const b of all) {
      while (p < b.bs) out.push(bl[p++])
      for (let k = b.os; k < b.oe; k++) out.push(b.src[k])
      p = b.be
    }
    while (p < bl.length) out.push(bl[p++])
    return { ok: true, text: out.join('\n') }
  }
