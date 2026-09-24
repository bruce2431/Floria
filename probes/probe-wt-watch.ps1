param(
  [string]$Log = "",
  [int]$Minutes = 45,
  [int]$IntervalMs = 400
)
# Passive watcher: samples WindowsTerminal process count + top-level windows
# (hwnd | pid | visible | iconic | title) with timestamps, appending to a log file.
# Purpose: capture the exact moment of a "double-click the exe" test so we can tell
# whether the first launch really created a window, whether it was HIDDEN, and how
# long it took to become visible.
# Keep this file pure ASCII (Windows PowerShell 5.1 reads BOM-less files as ANSI).
if (-not $Log) { $Log = Join-Path $PSScriptRoot "..\temp\wt-watch.log" }
$Log = [System.IO.Path]::GetFullPath($Log)
$dir = Split-Path -Parent $Log
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class WTW2 {
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
      var tt = new StringBuilder(512); GetWindowText(h, tt, 512);
      string title = tt.ToString().Replace("|", "/");
      if (title.Length > 40) title = title.Substring(0, 40);
      res.Add(h.ToInt64() + "@" + pid + "@" + (IsWindowVisible(h) ? "vis" : "HIDDEN") + "@" + (IsIconic(h) ? "min" : "norm") + "@" + title);
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
"@

$start = Get-Date
$end = $start.AddMinutes($Minutes)
"=== watch start $($start.ToString('yyyy-MM-dd HH:mm:ss')) (pid $PID), ${Minutes}min ===" | Out-File -Append -Encoding utf8 $Log

$last = ""
while ((Get-Date) -lt $end) {
  $procs = @(Get-Process WindowsTerminal -ErrorAction SilentlyContinue)
  $wins = [WTW2]::Find()
  $state = "p=" + $procs.Count + " w=" + ($wins -join ",")
  if ($state -ne $last) {
    $ts = (Get-Date).ToString("HH:mm:ss.fff")
    $pt = ($procs | ForEach-Object { $_.Id.ToString() + ":" + $_.StartTime.ToString("HH:mm:ss") }) -join " "
    "$ts $state | procs[$pt]" | Out-File -Append -Encoding utf8 $Log
    $last = $state
  }
  Start-Sleep -Milliseconds $IntervalMs
}
"=== watch end $((Get-Date).ToString('yyyy-MM-dd HH:mm:ss')) ===" | Out-File -Append -Encoding utf8 $Log
