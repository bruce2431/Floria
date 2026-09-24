// 探针：核验「无 -w 的常规 wt.exe 启动」在已有 WT 实例时的落地形态——是并入最近窗口开新标签，
// 还是另开一枚窗口（决定 cli.tsx 分两路里「无实例」分支在误判时的代价）。用 title 标记做判据：
// 新标签成为活动标签时，其宿主窗口标题会变成标记串。
import { spawn, spawnSync } from 'node:child_process'

const windows = (): string[] => {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', 'probes/probe-wt-windows.ps1'], { encoding: 'utf8', cwd: `${import.meta.dir}/..` })
  return (r.stdout ?? '').trim().split(/\r?\n/).filter(Boolean)
}

const MARK = 'WT_PROBE_MARKER_9f3a'
console.log(`baseline (${windows().length}):`)
for (const w of windows()) console.log(`  ${w}`)

const child = spawn('wt.exe', ['nt', '-d', process.cwd(), 'cmd.exe', '/c', `title ${MARK} & ping -n 8 127.0.0.1 >nul`], { stdio: 'ignore' })
await new Promise<void>((res) => { child.once('spawn', () => res()); child.once('error', () => res()) })

for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 250))
  const ws = windows()
  const marked = ws.filter((l) => l.includes(MARK))
  if (marked.length) {
    console.log(`[t+${(i + 1) * 250}ms] MARKER visible in ${marked.length} window(s), total windows = ${ws.length}`)
    for (const m of marked) console.log(`  ${m}`)
    break
  }
}
await new Promise((r) => setTimeout(r, 1000))
console.log(`during-run total windows = ${windows().length}`)
