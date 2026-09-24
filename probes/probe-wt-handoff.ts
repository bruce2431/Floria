// 探针：复刻 cli.tsx:63-76 的自举调用（spawn wt.exe → 'spawn' 事件 → 父进程立即退出），
// 测「wt 命令发出」到「WT 窗口出现」的延迟。
// 与生产的唯一差别：-w last → -w new（避免并入用户窗口，新建窗口才好在监视器日志里观察）。
import { spawn, spawnSync } from 'node:child_process'

function wtWindows(): string[] {
  const r = spawnSync('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    'probes/probe-wt-windows.ps1',
  ], { encoding: 'utf8', cwd: `${import.meta.dir}/..` })
  return (r.stdout ?? '').trim().split(/\r?\n/).filter(Boolean)
}

const before = new Set(wtWindows().map((l) => l.split('|')[0]))
console.log(`baseline windows: ${[...before].join(',') || '(none)'}`)

const t0 = Date.now()
const child = spawn(
  'wt.exe',
  ['-w', 'new', 'nt', '-d', process.cwd(), 'cmd.exe', '/c', 'ping -n 10 127.0.0.1 >nul'],
  { env: { ...process.env, FLORIA_IN_WT: '1' }, stdio: 'ignore' },
)
await new Promise<void>((res) => {
  child.once('spawn', () => {
    console.log(`[t+${Date.now() - t0}ms] 'spawn' event = cli.tsx would exit here`)
    res()
  })
  child.once('error', (e) => {
    console.log(`spawn error: ${e.message}`)
    res()
  })
})

// 父进程已"退出"语义达成；探针自身继续轮询观测窗口出现时刻
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 250))
  const now = wtWindows().map((l) => l.split('|')[0])
  const fresh = now.filter((h) => !before.has(h))
  if (fresh.length) {
    const line = wtWindows().find((l) => fresh.includes(l.split('|')[0]))
    console.log(`[t+${Date.now() - t0}ms] NEW WINDOW: ${line}`)
    break
  }
}
