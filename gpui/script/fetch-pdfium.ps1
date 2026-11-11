# Download the PDFium build the prototype is pinned to (bblanchon/pdfium-binaries
# chromium/8125, matching pdfium-render's `pdfium_8125` feature) into
# vendor\pdfium\win-x64\, verifying its SHA-256.
$ErrorActionPreference = "Stop"

$release = "chromium%2F8125"
$platform = "win-x64"
$sha = "9a964261760cff52570aabf038ab346d3a5034dd8b30d0d5fe8861235d356b8b"
$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root "vendor\pdfium\$platform"

if (Test-Path (Join-Path $target "bin\pdfium.dll")) {
    Write-Host "PDFium already present in $target"
    exit 0
}

$archive = Join-Path ([System.IO.Path]::GetTempPath()) "pdfium-$platform.tgz"
Invoke-WebRequest -Uri "https://github.com/bblanchon/pdfium-binaries/releases/download/$release/pdfium-$platform.tgz" -OutFile $archive
$actual = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLower()
if ($actual -ne $sha) { throw "PDFium archive checksum mismatch: $actual" }
New-Item -ItemType Directory -Force -Path $target | Out-Null
tar -xzf $archive -C $target
Remove-Item $archive
Write-Host "PDFium installed in $target"
