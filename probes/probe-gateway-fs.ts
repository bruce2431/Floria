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
import { resolveWithinRoot } from '../src/gateway/localGateway.js'

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

console.log(`\n${pass}/${pass + fail}`)
if (fail) process.exit(1)
