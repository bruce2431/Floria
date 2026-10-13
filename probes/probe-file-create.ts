#!/usr/bin/env bun
/**
 * probe-file-create —— 项目内新建文件/目录（POST /gateway/file/create）与上传
 * （POST /gateway/file/upload）的语义与防护（2026-10-13 work 侧栏 #wk-new-pop 接入）
 *
 * 直测真实现（import localGateway.createProjectEntry / uploadProjectFile），
 * 不在探针里复刻算法。不变量：
 *  - 落点目录必须已存在（新建不做多级 mkdir）→ 404；越界落点 → 403；
 *  - 显式输入不静默换名：create 目标已存在 → 409 且磁盘无变化；
 *  - upload 同名 -1/-2 序号避让（不覆盖），落点目录 recursive 创建（上传文件夹语义），越界 → 403；
 *  - 名称清洗走 sanitizeEntryName 同一口径（非法字符 / 保留名 / 超长保扩展名）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createProjectEntry, uploadProjectFile } from '../src/gateway/localGateway.js'

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

const root = join(tmpdir(), 'floria-file-create-probe')
rmSync(root, { recursive: true, force: true })
mkdirSync(join(root, 'docs', 'sub'), { recursive: true })
writeFileSync(join(root, 'a.txt'), 'A')

// ---------- createProjectEntry：新建文件 ----------
const f1 = createProjectEntry(root, 'docs', 'new.md', false)
ok('新建文件成功：path = docs/new.md', f1.ok && f1.path === 'docs/new.md' && f1.name === 'new.md')
ok('新建文件内容为空且真实落盘', existsSync(join(root, 'docs/new.md')) && readFileSync(join(root, 'docs/new.md'), 'utf8') === '')
ok('新建文件落盘产物是普通文件（非目录）', statSync(join(root, 'docs/new.md')).isFile())

const f2 = createProjectEntry(root, '', 'top.txt', false)
ok("落点 '' = 项目根（合法）：path = top.txt", f2.ok && f2.path === 'top.txt' && existsSync(join(root, 'top.txt')))

// ---------- createProjectEntry：新建目录 ----------
const d1 = createProjectEntry(root, 'docs', 'chapters', true)
ok('新建目录成功：path = docs/chapters', d1.ok && d1.path === 'docs/chapters')
ok('新建目录落盘产物是目录', statSync(join(root, 'docs/chapters')).isDirectory())

// ---------- 防护 ----------
const f3 = createProjectEntry(root, 'docs', 'new.md', false)
ok('create 目标已存在 → 409', !f3.ok && f3.code === 409)
ok('409 时磁盘无变化', readFileSync(join(root, 'docs/new.md'), 'utf8') === '')

const d3 = createProjectEntry(root, 'docs', 'chapters', true)
ok('create 目标目录已存在 → 409', !d3.ok && d3.code === 409)

const f4 = createProjectEntry(root, '../escape', 'x.txt', false)
ok("落点逃逸 '../escape' → 403", !f4.ok && f4.code === 403)
ok('逃逸落点未落盘', !existsSync(join(tmpdir(), 'escape')))

const f5 = createProjectEntry(root, 'no-such-dir', 'x.txt', false)
ok('落点目录不存在 → 404（不做多级 mkdir）', !f5.ok && f5.code === 404 && !existsSync(join(root, 'no-such-dir')))

const f6 = createProjectEntry(root, 'docs', 'con', false)
ok('Windows 保留名加 _ 前缀（同 sanitizeEntryName）', f6.ok && f6.name === '_con' && existsSync(join(root, 'docs/_con')))

const f7 = createProjectEntry(root, 'docs', '', false)
ok('空名称 → 400', !f7.ok && f7.code === 400)

const f8 = createProjectEntry(root, 'a.txt', 'x.txt', false)
ok('落点不是目录（是文件）→ 404', !f8.ok && f8.code === 404)

// ---------- uploadProjectFile ----------
const u1 = uploadProjectFile(root, 'docs', 'paper.pdf', Buffer.from('PDF1'))
ok('上传成功：path/size 返回', u1.ok && u1.path === 'docs/paper.pdf' && u1.size === 4)
ok('上传字节真实落盘', readFileSync(join(root, 'docs/paper.pdf'), 'utf8') === 'PDF1')

const u2 = uploadProjectFile(root, 'docs', 'paper.pdf', Buffer.from('PDF2'))
ok('上传同名 → -1 序号避让（不覆盖）', u2.ok && u2.path === 'docs/paper-1.pdf' && u2.name === 'paper-1.pdf')
ok('原名文件内容未被覆盖', readFileSync(join(root, 'docs/paper.pdf'), 'utf8') === 'PDF1')

const u3 = uploadProjectFile(root, 'docs', 'paper.pdf', Buffer.from('PDF3'))
ok('再撞名 → -2 序号', u3.ok && u3.path === 'docs/paper-2.pdf')

const u4 = uploadProjectFile(root, 'upload/new/deep', 'x.txt', Buffer.from('X'))
ok("上传落点目录不存在 → recursive 创建（上传文件夹语义）", u4.ok && u4.path === 'upload/new/deep/x.txt' && existsSync(join(root, 'upload/new/deep/x.txt')))

const u5 = uploadProjectFile(root, '../escape', 'x.txt', Buffer.from('X'))
ok('上传落点逃逸 → 403', !u5.ok && u5.code === 403)
ok('上传逃逸未落盘', !existsSync(join(tmpdir(), 'escape')))

const u6 = uploadProjectFile(root, 'docs', 'sub/evil.txt', Buffer.from('E'))
ok('上传名带路径段 → sanitizeEntryName basename 化解（仍落落点内）', u6.ok && u6.name === 'evil.txt' && u6.path === 'docs/evil.txt')
ok('上传名化解后未逃出落点目录', existsSync(join(root, 'docs/evil.txt')) && !existsSync(join(root, 'evil.txt')))

const u7 = uploadProjectFile(root, 'docs', '', Buffer.from('E'))
ok('上传空名称 → 400', !u7.ok && u7.code === 400)

// ---------- 清理 ----------
rmSync(root, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
