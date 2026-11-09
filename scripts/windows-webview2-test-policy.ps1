# WebView2 150+ ignores environment overrides in elevated hosted runners.
# https://github.com/MicrosoftEdge/WebView2Feedback/issues/5645
param(
    [Parameter(Mandatory)][ValidateSet('Acquire', 'Release')][string]$Mode,
    [Parameter(Mandatory)][ValidateRange(1024, 65535)][int]$Port
)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'WebView2 test policy is restricted to a disposable Windows Actions runner.'
}
$key = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments'
$name = 'research-writer.exe'
$value = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$Port"
$existing = Get-ItemPropertyValue -LiteralPath $key -Name $name -ErrorAction SilentlyContinue
if ($Mode -eq 'Acquire') {
    if ($null -ne $existing) { throw 'A WebView2 policy already exists for this app; refusing to replace it.' }
    if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
    New-ItemProperty -LiteralPath $key -Name $name -Value $value -PropertyType String | Out-Null
    'Configured the CI-only app-specific WebView2 test port.'
} else {
    if ($null -eq $existing) { return }
    if ($existing -ne $value) { throw 'The WebView2 policy changed; refusing to remove another owner''s value.' }
    Remove-ItemProperty -LiteralPath $key -Name $name
    'Removed the CI-only app-specific WebView2 test port.'
}

