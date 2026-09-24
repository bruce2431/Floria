# Enumerate Windows Terminal top-level windows (CASCADIA_HOSTING_WINDOW_CLASS).
# Output: hwnd | pid | procname | class | vis|HIDDEN | min|norm | title
# Purpose: decide whether "wt.exe -w last/new nt" actually created a window,
# and whether that window is visible (judge for the SW_HIDE-inheritance hypothesis).
# NOTE: keep this file pure ASCII -- Windows PowerShell 5.1 reads BOM-less files as ANSI.
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class WTW {
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static List<string> Find() {
    var res = new List<string>();
    EnumWindows((h, l) => {
      var cn = new StringBuilder(256); GetClassName(h, cn, 256);
      if (cn.ToString().IndexOf("CASCADIA", StringComparison.OrdinalIgnoreCase) < 0) return true;
      int pid; GetWindowThreadProcessId(h, out pid);
      string pn = "";
      try { pn = System.Diagnostics.Process.GetProcessById(pid).ProcessName; } catch {}
      var tt = new StringBuilder(512); GetWindowText(h, tt, 512);
      res.Add(h.ToInt64() + "|" + pid + "|" + pn + "|" + cn + "|" + (IsWindowVisible(h) ? "vis" : "HIDDEN") + "|" + (IsIconic(h) ? "min" : "norm") + "|" + tt);
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
"@
$r = [WTW]::Find()
if ($r.Count -eq 0) { Write-Output "(no WT window)" } else { $r | ForEach-Object { Write-Output $_ } }
