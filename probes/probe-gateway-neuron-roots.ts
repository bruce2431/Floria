/**
 * probe-gateway-neuron-roots.ts — 网关多根发现修复验证（2026-09-18，不依赖重启网关）
 * 复刻 localGateway gatewayNeuronRoots 组装序：cwd 根 → 全部项目根 → 全局根（keep-first）。
 * 预期 11 库：PJ16 真身 + PJ2/PJ5/PJ11/PJ13/PJ14/PJ15/PJ17/PJ18 + BUG/LJJ（全局根）。
 */
import { readdirSync, statSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { listNeuronsInRoots, resolveNeuronPathInRoots } from '../src/tools/neturon/config.js'

const projectRoot = resolve(import.meta.dir, '..', '..', '..') // Pj16 项目根（= 网关进程 cwd 语义）
const portable = resolve(projectRoot, '..') // @WrokSpace

const roots = [join(projectRoot, '.claude', 'neturon')]
for (const e of readdirSync(portable, { withFileTypes: true })) {
  if (!e.isDirectory()) continue
  if (e.name.startsWith('.')) continue
  if (/^\d{8,14}-/.test(e.name)) continue // 根级临时任务目录
  const nr = join(portable, e.name, '.claude', 'neturon')
  if (existsSync(nr) && statSync(nr).isDirectory()) roots.push(nr)
}
roots.push(join(portable, '.claude', 'neturon')) // 全局根（CLAUDE_CONFIG_DIR 恒指 @WrokSpace/.claude）

const list = listNeuronsInRoots(roots)
const ids = list.map((n) => n.id)
console.log('roots:', roots.length)
for (const r of roots) console.log('  -', r)
console.log('neurons(' + ids.length + '):', ids.join(', '))
const expect = ['PJ16', 'PJ2', 'PJ5', 'PJ11', 'PJ13', 'PJ14', 'PJ15', 'PJ17', 'PJ18', 'BUG', 'LJJ']
const missing = expect.filter((id) => !ids.includes(id))
console.log('check:', missing.length === 0 ? 'PASS 11/11' : 'FAIL missing=' + missing.join(','))
for (const n of list) console.log(`  ${n.id.padEnd(5)} mem=${String(n.mem_count).padStart(3)}  ${n.name}`)

// graph 解析抽测：新库 PJ11 必须经 resolveNeuronPathInRoots 命中（修复前抛「未发现」）
const p = resolveNeuronPathInRoots('PJ11', roots)
console.log('resolve PJ11:', p.includes('Pj11') ? 'PASS' : 'FAIL ' + p)
