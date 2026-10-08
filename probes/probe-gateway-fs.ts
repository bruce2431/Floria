#!/usr/bin/env bun
/**
 * probe-gateway-fs —— /gateway/fs（@ 提及「目录 / 文件」数据源）的路径穿越防护与裁剪口径
 *
 * 直测真实现（import localGateway.resolveWithinRoot），不在探针里复刻算法：
 *  - 越界（`..` 逃逸 / 盘符 / 根绝对路径）必须返回 null → 403；
 *  - 工作区根内路径必须落在 root 之下；
 *  - 只读属性：端点只做 readdirSync，本探针核对源码里该分支无写调用。
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveWithinRoot, sniffBinary } from '../src/gateway/localGateway.js'

const root = join(import.meta.dir, '..')
const gw = readFileSync(join(root, 'src/gateway/localGateway.ts'), 'utf8')

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

const R = 'F:/fake-root'
const inside: Array<[string, string]> = [
  ['', `${R}`],
  ['Pj16-CodeAgent构建', `${R}/Pj16-CodeAgent构建`],
  ['a/b/c', `${R}/a/b/c`],
  ['/a/b/', `${R}/a/b`],
  ['a\\b', `${R}/a/b`],
  ['a/./b', `${R}/a/b`],
]
for (const [input, want] of inside) {
  const got = resolveWithinRoot(R, input)
  ok(`root 内 ${JSON.stringify(input)} → ${want}`, !!got && resolve(got) === resolve(want))
}

const outside = ['..', '../..', 'a/../../..', '/../x', 'C:/Windows', 'D:/', 'a/b/../../../../etc']
for (const input of outside) {
  ok(`越界 ${JSON.stringify(input)} → null`, resolveWithinRoot(R, input) === null)
}

// 端点分支只读：fs 分支体内不得出现写盘/建目录调用
const fsBranch = /url\.pathname === '\/gateway\/fs'\) \{[\s\S]*?\n  \}/.exec(gw)?.[0] ?? ''
ok('端点分支存在', fsBranch.length > 0)
ok('只读（无 writeFileSync/mkdirSync/rmSync）', !/writeFileSync|mkdirSync|rmSync|unlinkSync/.test(fsBranch))
ok('复用 listOneLevel（不另立排除表）', /listOneLevel\(qAbs\)/.test(fsBranch))
ok('越界 → 403', /if \(!qAbs\) \{\s*sendJson\(res, 403/.test(fsBranch))
ok('非目录 → 404', /'not a directory'/.test(fsBranch))

// /gateway/file 的文本嗅探（MIME 未覆盖扩展名的兜底分类）：源码/TeX 等文本不得被判二进制
ok('纯 ASCII 文本 → 非二进制', sniffBinary(Buffer.from('\\documentclass{article}\\n')) === false)
ok('UTF-8 中文文本 → 非二进制', sniffBinary(Buffer.from('公式 $E=mc^2$ 注释 % x\\n', 'utf8')) === false)
ok('含 NUL 字节 → 二进制', sniffBinary(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x41])) === true)
{
  const big = Buffer.concat([Buffer.from('x'.repeat(9000)), Buffer.from([0x00])])
  ok('NUL 只在 8 KB 之后 → 判文本（同 git 启发式）', sniffBinary(big) === false)
}
{
  const nul = Buffer.concat([Buffer.from('abc'), Buffer.from([0x00]), Buffer.from('def')])
  ok('前 8 KB 内 NUL → 二进制', sniffBinary(nul) === true)
}

console.log(`\n${pass}/${pass + fail}`)
if (fail) process.exit(1)
