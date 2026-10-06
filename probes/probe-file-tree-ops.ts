#!/usr/bin/env bun
/**
 * probe-file-tree-ops —— 文件树写操作（POST /gateway/file/rename | /delete）的语义与防护
 *
 * 直测真实现（import localGateway.renameProjectEntry / trashProjectEntry / sanitizeEntryName），
 * 不在探针里复刻算法。三个不变量：
 *  - 越界一律 403：`..` 逃逸 / 盘符 / 空 rel（= 项目根自身）都不得落到项目根之外；
 *  - 重命名不覆盖：目标已存在 → 409 且磁盘无变化（不自动序号——静默换名比报错更糟）；
 *  - 删除 = 移动进项目根 .trash/：原路径消失、.trash/ 下出现，同名冲突加时间戳前缀而非覆盖。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readProjectComments, renameProjectEntry, sanitizeEntryName, trashProjectEntry, writeProjectComments, writeProjectFile } from '../src/gateway/localGateway.js'

let pass = 0
let fail = 0
const ok = (name: string, cond: boolean) => {
  if (cond) {
    pass++
    console.log(`PASS  ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}`)
  }
}

const root = join(tmpdir(), 'floria-file-tree-ops-probe')
rmSync(root, { recursive: true, force: true })
mkdirSync(join(root, 'sub', 'deep'), { recursive: true })
writeFileSync(join(root, 'a.txt'), 'A')
writeFileSync(join(root, 'keep.txt'), 'K')
writeFileSync(join(root, 'sub', 'b.txt'), 'B')
writeFileSync(join(root, 'sub', 'deep', 'c.txt'), 'C')

// ---------- 重命名 ----------
const r1 = renameProjectEntry(root, 'a.txt', 'a2.txt')
ok('重命名文件成功', r1.ok && r1.ok && r1.name === 'a2.txt' && r1.path === 'a2.txt')
ok('重命名：新名存在、旧名消失', existsSync(join(root, 'a2.txt')) && !existsSync(join(root, 'a.txt')))
ok('重命名内容不变', readFileSync(join(root, 'a2.txt'), 'utf8') === 'A')

const r2 = renameProjectEntry(root, 'sub/b.txt', 'b2.txt')
ok('子目录内重命名：path 前缀保留', r2.ok && r2.path === 'sub/b2.txt' && existsSync(join(root, 'sub/b2.txt')))

const r3 = renameProjectEntry(root, 'sub/b2.txt', 'b2.txt')
ok('同名重命名 = 幂等 no-op（不是 409）', r3.ok && existsSync(join(root, 'sub/b2.txt')))

const r4 = renameProjectEntry(root, 'sub/b2.txt', 'deep')
ok('目标同名条目已存在 → 409', !r4.ok && r4.code === 409)
ok('409 时磁盘无变化', existsSync(join(root, 'sub/b2.txt')) && existsSync(join(root, 'sub/deep')))

// path 参数逃逸 → 403（防护在 resolveWithinRoot）
const r5 = renameProjectEntry(root, '../escaped.txt', 'x.txt')
ok("path 逃逸 '../escaped.txt' → 403", !r5.ok && r5.code === 403)
// name 参数逃逸 → sanitizeEntryName 只取 basename，改名仍落在原目录内（不是 403，是化解）
const r5b = renameProjectEntry(root, 'a2.txt', '../../escaped.txt')
ok('name 逃逸被 basename 化解（仍落项目根内）', r5b.ok && r5b.name === 'escaped.txt' && r5b.path === 'escaped.txt')
ok('name 逃逸未落到项目根之外', existsSync(join(root, 'escaped.txt')) && !existsSync(join(tmpdir(), 'escaped.txt')))

ok('空 rel（项目根自身）→ 403', !renameProjectEntry(root, '', 'x').ok)
ok('不存在的条目 → 404', (() => { const r = renameProjectEntry(root, 'nope.txt', 'x'); return !r.ok && r.code === 404 })())
ok('空名称 → 400', (() => { const r = renameProjectEntry(root, 'escaped.txt', '   '); return !r.ok && r.code === 400 })())

const r6 = renameProjectEntry(root, 'escaped.txt', 'C:/Windows/x.txt')
ok('名称只取 basename（禁带路径）', r6.ok && r6.name === 'x.txt' && existsSync(join(root, 'x.txt')))
const r7 = renameProjectEntry(root, 'x.txt', 'a?b*c.txt')
ok('非法字符清洗为 _', r7.ok && r7.name === 'a_b_c.txt')
// 盘符式前缀被 path.win32 basename 当路径剥掉（'c:notes' → 'notes'）——只可能「少字」，不可能逃出项目根
ok('盘符式前缀被剥掉而非落盘', sanitizeEntryName('c:notes') === 'notes')
const r8 = renameProjectEntry(root, 'a_b_c.txt', 'con')
ok('Windows 保留名加 _ 前缀', r8.ok && r8.name === '_con')

const r9 = renameProjectEntry(root, 'sub', 'sub2')
ok('目录重命名：子内容随迁', r9.ok && r9.path === 'sub2' && existsSync(join(root, 'sub2/b2.txt')) && existsSync(join(root, 'sub2/deep/c.txt')))

ok('sanitizeEntryName 超长保留扩展名', (() => {
  const n = sanitizeEntryName('x'.repeat(200) + '.md')
  return n.length === 120 && n.endsWith('.md')
})())
ok('sanitizeEntryName 空串/./.. 归空', sanitizeEntryName('') === '' && sanitizeEntryName('..') === '' && sanitizeEntryName('.') === '')

// ---------- 写内容（POST /gateway/file/write）----------
writeFileSync(join(root, 'w.txt'), 'old')
const w1 = writeProjectFile(root, 'w.txt', 'new content')
ok('写回成功且回新 mtime', w1.ok && w1.path === 'w.txt' && typeof w1.mtime === 'number')
ok('写回内容已落盘', readFileSync(join(root, 'w.txt'), 'utf8') === 'new content')

// 基线不符（模拟外部改动）→ 409 且不覆盖
const w2 = writeProjectFile(root, 'w.txt', 'mine', (w1.ok ? w1.mtime : 0) + 12345)
ok('基线不符 → 409 且不覆盖', !w2.ok && w2.code === 409 && readFileSync(join(root, 'w.txt'), 'utf8') === 'new content')
// 基线正确 → 正常写
const w3 = writeProjectFile(root, 'w.txt', 'ok2', w1.ok ? w1.mtime : 0)
ok('基线正确 → 写入成功', w3.ok && readFileSync(join(root, 'w.txt'), 'utf8') === 'ok2')
// 无基线（强制覆盖）
const w4 = writeProjectFile(root, 'w.txt', 'forced')
ok('无基线 → 强制覆盖成功', w4.ok && readFileSync(join(root, 'w.txt'), 'utf8') === 'forced')

ok('写越界 → 403', (() => { const r = writeProjectFile(root, '../evil.txt', 'x'); return !r.ok && r.code === 403 })())
ok('写空 rel（项目根）→ 403', !writeProjectFile(root, '', 'x').ok)
ok('写不存在文件 → 404', (() => { const r = writeProjectFile(root, 'nope.txt', 'x'); return !r.ok && r.code === 404 })())
ok('写目录 → 404', (() => { const r = writeProjectFile(root, 'sub2', 'x'); return !r.ok && r.code === 404 })())
ok('写不存在的父目录（越界防护不误放行）→ 404', (() => { const r = writeProjectFile(root, 'nope/deep.txt', 'x'); return !r.ok && r.code === 404 })())

// ---------- 删除（= 移入 .trash/）----------
const d1 = trashProjectEntry(root, 'keep.txt')
ok('删除移入 .trash/：原路径消失', d1.ok && !existsSync(join(root, 'keep.txt')))
ok('删除移入 .trash/<原名>', d1.ok && d1.trash === '.trash/keep.txt' && existsSync(join(root, '.trash', 'keep.txt')))
ok('.trash 内容保持不变', readFileSync(join(root, '.trash', 'keep.txt'), 'utf8') === 'K')

writeFileSync(join(root, 'keep.txt'), 'K2')
const d2 = trashProjectEntry(root, 'keep.txt')
ok('同名冲突 → 加时间戳前缀而非覆盖', d2.ok && d2.trash !== '.trash/keep.txt' && /^\.trash\/\d{14}-keep\.txt$/.test(d2.trash!))
ok('冲突时两条都在 .trash/', existsSync(join(root, '.trash', 'keep.txt')) && existsSync(join(root, d2.trash!)))

const d3 = trashProjectEntry(root, 'sub2')
ok('目录删除：整棵子树进 .trash/', d3.ok && !existsSync(join(root, 'sub2')) && existsSync(join(root, '.trash', 'sub2', 'deep', 'c.txt')))

ok('删除逃逸 → 403', (() => { const r = trashProjectEntry(root, '../evil'); return !r.ok && r.code === 403 })())
ok('删除空 rel → 403', !trashProjectEntry(root, '').ok)
ok('删除不存在 → 404', (() => { const r = trashProjectEntry(root, 'nope.txt'); return !r.ok && r.code === 404 })())

// ---------- 评论批注（GET/POST /gateway/comments）----------
ok('初始无 comments.json → 空列表', readProjectComments(root).length === 0)
const cw1 = writeProjectComments(root, [
  { id: 'c1', path: 'a2.txt', l0: 1, l1: 2, excerpt: 'x', body: 'hello', author: 'u', createdAt: '2026-10-06T00:00:00Z', resolved: false },
])
ok('写入成功且计数正确', cw1.ok && cw1.count === 1)
ok('落盘在 .claude/comments.json（允许新建）', existsSync(join(root, '.claude', 'comments.json')))
const cr1 = readProjectComments(root)
ok('读回内容一致', cr1.length === 1 && cr1[0].body === 'hello' && cr1[0].path === 'a2.txt')
const cw2 = writeProjectComments(root, [])
ok('全量替换为空列表', cw2.ok && cw2.count === 0 && readProjectComments(root).length === 0)
ok('非数组 → 400', (() => { const r = writeProjectComments(root, null as unknown as unknown[]); return !r.ok && r.code === 400 })())
const cw3 = writeProjectComments(root, [{ id: 'a' }, 'bad', 3, null, { id: 'b' }])
ok('非对象元素被剔除', cw3.ok && cw3.count === 2 && readProjectComments(root).length === 2)
writeFileSync(join(root, '.claude', 'comments.json'), '{ not json')
ok('坏 JSON → 空列表且不抛', readProjectComments(root).length === 0)
writeFileSync(join(root, '.claude', 'comments.json'), JSON.stringify([1, 2]))
ok('顶层非对象 → 空列表', readProjectComments(root).length === 0)

// .trash 以 . 开头 → 不进 /gateway/project 文件树（walkProjectTree 跳过点开头条目，此处核对常量）
const gw = readFileSync(join(import.meta.dir, '..', 'src/gateway/localGateway.ts'), 'utf8')
ok('.trash 在 SKIP_TREE_DIRS 内', /SKIP_TREE_DIRS = new Set\(\[[^\]]*'\.trash'/.test(gw))
ok('两个端点各自转译纯函数结果码', /file\/rename'\)[\s\S]{0,600}?sendJson\(res, rOut\.code/.test(gw) && /file\/delete'\)[\s\S]{0,600}?sendJson\(res, dOut\.code/.test(gw))
ok('写端点转译纯函数结果码', /file\/write'\)[\s\S]{0,2000}?sendJson\(res, wOut\.code/.test(gw))
ok('GET /gateway/file 带 ETag（写回冲突基线）', /ETag:/.test(gw) && /Last-Modified/.test(gw))
ok('comments 两端点存在且转译结果码', /'\/gateway\/comments'/.test(gw) && /readProjectComments/.test(gw) && /writeProjectComments/.test(gw) && /gateway\/comments'\)[\s\S]{0,1200}?sendJson\(res, cOut\.code/.test(gw))

rmSync(root, { recursive: true, force: true })
console.log(`\n${pass}/${pass + fail}`)
if (fail) process.exit(1)
