param([Parameter(Mandatory=$true)][string]$AppPath, [Parameter(Mandatory=$true)][string]$Artifacts)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$guard = Join-Path $PSScriptRoot 'windows-console-guard.ps1'
. $guard -Mode Library -AppPath $AppPath
New-Item -ItemType Directory -Force $Artifacts | Out-Null
$ready = Join-Path $Artifacts 'console-monitor.ready'
$stop = Join-Path $Artifacts 'console-monitor.stop'
$report = Join-Path $Artifacts 'console-windows.json'
$monitor = $null
$app = $null
$checks = [System.Collections.Generic.List[string]]::new()

function Wait-Check([scriptblock]$Condition, [string]$Label, [int]$Seconds=30) {
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 100
  }
  throw "Timed out: $Label"
}
function Record([string]$Text) { $checks.Add($Text); Write-Output "ok: $Text" }
function Screenshot([string]$Name) {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $image = [System.Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
  $graphics = [System.Drawing.Graphics]::FromImage($image)
  try {
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $image.Save((Join-Path $Artifacts $Name), [System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $graphics.Dispose(); $image.Dispose() }
}
function Focus-App {
  $app.Refresh()
  [LatticeWindows]::SetForegroundWindow($app.MainWindowHandle) | Out-Null
  Start-Sleep -Milliseconds 250
}
function Successful-Builds {
  $path = Join-Path $env:LOCALAPPDATA 'app.lattice.windows/logs/lattice.log'
  if (!(Test-Path $path)) { return 0 }
  return @(Get-Content $path | Where-Object { $_ -match '"event":"latex.compile"' -and $_ -match '"outcome":"success"' -and $_ -match '"has_pdf":true' }).Count
}
try {
  $arguments = @('-NoProfile', '-NonInteractive', '-File', $guard, '-Mode', 'Monitor', '-Ready', $ready, '-Stop', $stop, '-Report', $report)
  $monitor = Start-Process powershell.exe -WindowStyle Hidden -ArgumentList $arguments -PassThru -RedirectStandardOutput (Join-Path $Artifacts 'monitor-stdout.log') -RedirectStandardError (Join-Path $Artifacts 'monitor-stderr.log')
  Wait-Check { Test-Path $ready } 'console monitor readiness'
  $app = Start-Process -FilePath $AppPath -PassThru
  Wait-Check { $app.Refresh(); !$app.HasExited -and $app.MainWindowHandle -ne 0 } 'the native Lattice window' 60
  Record 'installed executable opens a native window'
  Wait-Check { (Successful-Builds) -ge 1 } 'the tutorial PDF to build through Lattice' 180
  $tutorials = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Lattice Tutorials'
  $source = Get-ChildItem $tutorials -Filter main.tex -Recurse | Where-Object { $_.FullName -notmatch '\\(papers|\.research)\\' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (!$source) { throw 'The tutorial source was not created' }
  $pdf = [IO.Path]::ChangeExtension($source.FullName, '.pdf')
  $bytes = [IO.File]::ReadAllBytes($pdf)
  if ($bytes.Length -lt 1000 -or [Text.Encoding]::ASCII.GetString($bytes, 0, 5) -ne '%PDF-') { throw 'The tutorial PDF is not valid' }
  Record 'Lattice compiled the tutorial into a real PDF'

  for ($cycle=0; $cycle -lt 3; $cycle++) {
    [LatticeWindows]::ShowWindow($app.MainWindowHandle, 3) | Out-Null
    Wait-Check { [LatticeWindows]::IsZoomed($app.MainWindowHandle) } 'maximization'
    [LatticeWindows]::ShowWindow($app.MainWindowHandle, 9) | Out-Null
    Wait-Check { ![LatticeWindows]::IsZoomed($app.MainWindowHandle) } 'restoring the window'
  }
  Record 'native maximization and restore work for three cycles'
  Focus-App
  [System.Windows.Forms.SendKeys]::SendWait('{F11}')
  Wait-Check { [LatticeWindows]::IsFullscreen($app.MainWindowHandle) } 'F11 entering native fullscreen'
  Screenshot 'native-fullscreen.png'
  [System.Windows.Forms.SendKeys]::SendWait('{F11}')
  Wait-Check { ![LatticeWindows]::IsFullscreen($app.MainWindowHandle) } 'F11 leaving native fullscreen'
  Record 'F11 enters and leaves borderless monitor-sized native fullscreen'
  [System.Windows.Forms.SendKeys]::SendWait('{F11}')
  Wait-Check { [LatticeWindows]::IsFullscreen($app.MainWindowHandle) } 'entering fullscreen again'
  Start-Sleep -Milliseconds 300
  [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
  Wait-Check { ![LatticeWindows]::IsFullscreen($app.MainWindowHandle) } 'Escape leaving fullscreen'
  Record 'Escape exits fullscreen'

  $before = Successful-Builds
  Focus-App
  [System.Windows.Forms.SendKeys]::SendWait('^s')
  Wait-Check { (Successful-Builds) -gt $before } 'Save and build recompiling the tutorial' 90
  Record 'the native Save and build shortcut recompiles the project'

  Focus-App
  [System.Windows.Forms.SendKeys]::SendWait('^`')
  Start-Sleep -Seconds 3
  [System.Windows.Forms.Clipboard]::SetText("[IO.File]::WriteAllText(([IO.Path]::Combine(`$PWD.ProviderPath, 'terminal-proof.txt')), 'ConPTY works')")
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  $proof = Join-Path $source.DirectoryName 'terminal-proof.txt'
  Wait-Check { (Test-Path $proof) -and (Get-Content $proof -Raw) -eq 'ConPTY works' } 'PowerShell executing inside the project'
  Record 'the integrated ConPTY terminal executes PowerShell in the project folder'
  Focus-App
  [System.Windows.Forms.SendKeys]::SendWait('^k')
  Start-Sleep -Milliseconds 500
  [System.Windows.Forms.SendKeys]::SendWait('Export Word')
  Start-Sleep -Milliseconds 500
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Wait-Check { @([LatticeWindows]::Visible() | Where-Object { $_.Title -eq 'Export Word' }).Count -gt 0 } 'Word export information dialog'
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Wait-Check { @([LatticeWindows]::Visible() | Where-Object { $_.Title -eq 'Export editable Word document' }).Count -gt 0 } 'Word destination dialog'
  $wordPath = Join-Path $Artifacts 'tutorial-review.docx'
  [System.Windows.Forms.Clipboard]::SetText($wordPath)
  [System.Windows.Forms.SendKeys]::SendWait('^a')
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Wait-Check { (Test-Path $wordPath) -and (Get-Item $wordPath).Length -gt 1000 } 'Word document exported from the command palette' 120
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $word = [IO.Compression.ZipFile]::OpenRead($wordPath)
  try {
    $entry = $word.GetEntry('word/document.xml')
    if (!$entry) { throw 'The exported Word package has no document' }
    $reader = [IO.StreamReader]::new($entry.Open())
    try { $xml = $reader.ReadToEnd() } finally { $reader.Dispose() }
    if ($xml -notmatch 'Understanding Attention' -or $xml -notmatch 'oMath') { throw 'The exported Word document is missing editable text or equations' }
  } finally { $word.Dispose() }
  Record 'the command palette exports a DOCX with editable tutorial text and equations'
  Screenshot 'native-window.png'
  Set-Content -LiteralPath $stop -Value 'stop'
  if (!$monitor.WaitForExit(10000)) { throw 'The console monitor did not stop' }
  $consoles = @(Get-Content $report -Raw | ConvertFrom-Json | Where-Object { $null -ne $_ })
  if ($consoles.Count -ne 0) { throw "Visible external consoles were detected: $(Get-Content $report -Raw)" }
  Record 'no external console windows appeared during startup, resizing, builds and terminal use'
  $checks | Set-Content (Join-Path $Artifacts 'result.txt') -Encoding utf8
} catch {
  $_ | Out-String | Set-Content (Join-Path $Artifacts 'failure.txt')
  try { Screenshot 'failure.png' } catch { Write-Warning $_ }
  throw
} finally {
  Set-Content -LiteralPath $stop -Value 'stop'
  if ($monitor -and !$monitor.HasExited) { $monitor.WaitForExit(10000) | Out-Null }
  if ($app -and !$app.HasExited) { Stop-Process -Id $app.Id -ErrorAction SilentlyContinue }
}
