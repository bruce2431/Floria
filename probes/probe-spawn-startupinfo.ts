// 探针：Bun 的 node:child_process.spawn 在 Windows 上给子进程传的 STARTUPINFO 是什么。
// 背景：cli.tsx 入口护栏 spawn('wt.exe', ['-w','last','nt',...]) 时若父进程带了
// STARTF_USESHOWWINDOW + SW_HIDE，无窗时新开的 WindowsTerminal.exe 会继承隐藏
// （2026-09-09 双启动根因）。源码已删显式 windowsHide，但需确认 Bun 默认是否仍在传。
// 判据：dwFlags & 1（STARTF_USESHOWWINDOW）且 wShowWindow == 0（SW_HIDE）即为隐藏继承源。
import { spawnSync } from 'node:child_process'

const PS = `
$src = @'
using System;
using System.Runtime.InteropServices;
public class SI {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb;
    public IntPtr lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [DllImport("kernel32.dll", SetLastError=true)] public static extern void GetStartupInfoW(out STARTUPINFO si);
  public static string Dump() {
    STARTUPINFO si; GetStartupInfoW(out si);
    return si.dwFlags + "|" + si.wShowWindow;
  }
}
'@
Add-Type -TypeDefinition $src
[SI]::Dump()
`

function dump(label: string, opts: Record<string, unknown>): void {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', PS], {
    encoding: 'utf8',
    ...opts,
  })
  const out = (r.stdout ?? '').trim()
  const [flags, show] = out.split('|')
  const f = Number(flags)
  const s = Number(show)
  const hidden = (f & 1) !== 0 && s === 0
  console.log(
    `${label.padEnd(28)} dwFlags=${flags} (USESHOWWINDOW=${(f & 1) !== 0}) wShowWindow=${show} => ${hidden ? 'HIDDEN(SW_HIDE)' : 'visible'}`,
  )
}

dump('default(no windowsHide)', {})
dump('windowsHide:false', { windowsHide: false })
dump('windowsHide:true', { windowsHide: true })
