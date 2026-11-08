param(
  [ValidateSet('Monitor', 'Resize')][string]$Mode,
  [string]$Ready,
  [string]$Stop,
  [string]$Report,
  [string]$AppPath
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class LatticeWindowInfo {
  public long Handle;
  public uint Pid;
  public string Title;
  public string ClassName;
}
public static class LatticeWindows {
  public delegate bool EnumCallback(IntPtr window, IntPtr state);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr state);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int length);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int length);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
  public static List<LatticeWindowInfo> Visible() {
    var result = new List<LatticeWindowInfo>();
    EnumCallback callback = (window, state) => {
      if (!IsWindowVisible(window)) return true;
      var title = new StringBuilder(1024);
      var className = new StringBuilder(256);
      GetWindowText(window, title, title.Capacity);
      GetClassName(window, className, className.Capacity);
      uint pid;
      GetWindowThreadProcessId(window, out pid);
      result.Add(new LatticeWindowInfo { Handle=window.ToInt64(), Pid=pid, Title=title.ToString(), ClassName=className.ToString() });
      return true;
    };
    EnumWindows(callback, IntPtr.Zero);
    return result;
  }
}
'@
if ($Mode -eq 'Resize') {
  $app = Get-Process | Where-Object { $_.Path -eq $AppPath -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (!$app) { throw "Could not find the installed Lattice window: $AppPath" }
  for ($index = 0; $index -lt 3; $index++) {
    [LatticeWindows]::ShowWindow($app.MainWindowHandle, 3) | Out-Null
    Start-Sleep -Milliseconds 800
    [LatticeWindows]::ShowWindow($app.MainWindowHandle, 9) | Out-Null
    Start-Sleep -Milliseconds 800
  }
  exit 0
}
$known = [System.Collections.Generic.HashSet[long]]::new()
foreach ($window in [LatticeWindows]::Visible()) { $known.Add($window.Handle) | Out-Null }
$findings = [System.Collections.Generic.List[object]]::new()
Set-Content -LiteralPath $Ready -Value 'ready' -Encoding utf8
$deadline = [DateTime]::UtcNow.AddMinutes(15)
while (!(Test-Path -LiteralPath $Stop) -and [DateTime]::UtcNow -lt $deadline) {
  foreach ($window in [LatticeWindows]::Visible()) {
    if ($window.ClassName -match '^(ConsoleWindowClass|CASCADIA_HOSTING_WINDOW_CLASS)$' -and $known.Add($window.Handle)) {
      $findings.Add($window)
    }
  }
  Start-Sleep -Milliseconds 20
}
ConvertTo-Json -InputObject @($findings.ToArray()) -Depth 4 | Set-Content -LiteralPath $Report -Encoding utf8
