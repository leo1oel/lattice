# Run only on a disposable runner: never replace a developer's installed Lattice.
param([Parameter(Mandatory)][string]$Installer, [Parameter(Mandatory)][string]$Artifacts)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Installation checks require a disposable Windows Actions runner.'
}
$existing = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
    Where-Object DisplayName -EQ 'Lattice'
if ($existing -or (Get-Process research-writer -ErrorAction SilentlyContinue)) { throw 'Lattice already exists on this runner.' }
$installRoot = Join-Path $env:RUNNER_TEMP ('lattice-installed-' + [guid]::NewGuid().ToString('N'))
$version = (Get-Content 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json).version
$nodeVersion = (Get-Content 'scripts/synara-runtime.json' -Raw | ConvertFrom-Json).nodeVersion
New-Item -ItemType Directory -Force -Path $Artifacts | Out-Null
$installed = $false
try {
    $process = Start-Process -FilePath (Resolve-Path $Installer).Path -ArgumentList @('/S', "/D=$installRoot") -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Installer exited with $($process.ExitCode)" }
    $installed = $true
    $app = Join-Path $installRoot 'research-writer.exe'
    if ((Get-Item $app).VersionInfo.ProductVersion -ne $version) { throw 'Installed version does not match source.' }
    foreach ($relative in @('synara-runtime/bin/node.exe', 'synara-runtime/licenses/Node-LICENSE.txt',
        'synara-runtime/manifest.json', 'presentation-runtime/server.mjs', 'presentation-runtime/manifest.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $installRoot $relative) -PathType Leaf)) { throw "Missing installed resource: $relative" }
    }
    $manifest = Get-Content (Join-Path $installRoot 'synara-runtime/manifest.json') -Raw | ConvertFrom-Json
    if ($manifest.agentAvailable -ne $false -or $manifest.nodeVersion -ne $nodeVersion) { throw 'Unexpected runtime manifest.' }
    if (Test-Path -LiteralPath (Join-Path $installRoot 'synara-runtime/server')) { throw 'Windows must not bundle the disabled Agent server.' }
    $bundledNode = Join-Path $installRoot 'synara-runtime/bin/node.exe'
    if ((& $bundledNode --version) -ne "v$nodeVersion") { throw 'Installed Node version does not match the pin.' }
    if ($LASTEXITCODE -ne 0) { throw 'Installed Node did not execute.' }
    node scripts/check-font-leaks.mjs windows $installRoot
    if ($LASTEXITCODE -ne 0) { throw 'Installed fonts check failed.' }
    # The existing module graph check runs with the installed Node, not the CI Node.
    node --input-type=module -e 'import {checkPresentationRuntime} from "./scripts/check-presentation-runtime.mjs"; await checkPresentationRuntime(process.argv[1], process.argv[2]);' (Join-Path $installRoot 'presentation-runtime') $bundledNode
    if ($LASTEXITCODE -ne 0) { throw 'Installed Open Slide module graph failed.' }
    node scripts/windows-installed-e2e.mjs --app $app --artifacts $Artifacts
    if ($LASTEXITCODE -ne 0) { throw 'Installed app checks failed.' }
} finally {
    if ($installed) {
        $uninstaller = Join-Path $installRoot 'uninstall.exe'
        if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'Uninstaller is missing.' }
        $process = Start-Process -FilePath $uninstaller -ArgumentList '/S' -WindowStyle Hidden -Wait -PassThru
        if ($process.ExitCode -ne 0) { throw "Uninstaller exited with $($process.ExitCode)" }
        $deadline = (Get-Date).AddSeconds(60)
        while ((Test-Path -LiteralPath (Join-Path $installRoot 'research-writer.exe')) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
        if (Test-Path -LiteralPath (Join-Path $installRoot 'research-writer.exe')) { throw 'Uninstall left the executable behind.' }
        $registration = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object DisplayName -EQ 'Lattice'
        if ($registration) { throw 'Uninstall left its application registration behind.' }
    }
}
'Installation, installed resources, native app checks and uninstall passed.' | Set-Content (Join-Path $Artifacts 'install-result.txt')
