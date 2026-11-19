# AI Gateway 0.9.9 installer builder (Inno Setup exe)
#
# build-web.ps1 produces a runnable directory (build\release-web).
# This script strips every license/readme file from that directory, then
# compresses it into a single exe installer.
#
# NOTE: keep this file pure ASCII. PowerShell ISE-less runs read .ps1 as ANSI
# unless the file has a BOM; Chinese comments break the parser with
# "MissingEndCurlyBrace"/"MissingExpressionAfterToken" errors.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File build-installer.ps1
# Output: build\installer\AI-Gateway-Setup-0.9.9.exe

$ErrorActionPreference = 'Stop'
Set-Location -Path (Split-Path -Parent $MyInvocation.MyCommand.Path)

$VER     = '0.9.9'
$SRC     = Join-Path $PWD 'build\release-web'
$ISCC    = 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe'
# Output MUST live outside $SRC: putting it in $SRC\installer makes the iss
# [Files] entry "Source: $SRC\*" pack the installer into itself, leaving a
# stray installer\_setup.iss inside the installed app directory.
$OUTDIR  = Join-Path $PWD 'build\installer'
$TEMPL   = Join-Path $PWD 'shell\setup-aigw.iss'
$LANGDIR = Join-Path $PWD 'shell\iss-lang'

if (-not (Test-Path (Join-Path $SRC 'AI Gateway.exe'))) {
    throw "run build-web.ps1 first: missing $SRC\AI Gateway.exe"
}
if (-not (Test-Path $ISCC))  { throw "Inno Setup 6 not found: $ISCC" }
if (-not (Test-Path $TEMPL)) { throw "iss template not found: $TEMPL" }

Write-Host '[1/4] strip license / readme files'

# Explicit list, no wildcard sweep: a bad glob could delete app\*.jar and
# break the program at startup.
$targets = @(
    (Join-Path $SRC 'README.txt'),      # version notes copied in by build-web.ps1
    (Join-Path $SRC 'licenses'),        # license dir injected by the old flow
    (Join-Path $SRC 'runtime\legal'),   # JDK ships 55 GPL/third-party notices (283 KB)
    (Join-Path $SRC 'runtime\conf\security\policy\README.txt')
)

$removed = 0
foreach ($t in $targets) {
    if (-not (Test-Path $t)) { continue }
    $item = Get-Item $t -Force
    if ($item.PSIsContainer) {
        $removed += (Get-ChildItem $t -Recurse -File -Force | Measure-Object).Count
        Remove-Item $t -Recurse -Force
    }
    else {
        $removed++
        Remove-Item $t -Force
    }
    Write-Host ("      - {0}" -f $item.Name)
}
Write-Host ("      removed {0} files" -f $removed)

Write-Host '[2/4] render Inno Setup script'
# Drop a leftover installer dir from the previous script layout
$staleOut = Join-Path $SRC 'installer'
if (Test-Path -LiteralPath $staleOut) { Remove-Item -LiteralPath $staleOut -Recurse -Force }
New-Item -ItemType Directory -Path $OUTDIR -Force | Out-Null
$issPath = Join-Path $OUTDIR '_setup.iss'
$iss = (Get-Content $TEMPL -Raw -Encoding UTF8) `
    -replace '__OUTDIR__', $OUTDIR `
    -replace '__SRC__', $SRC `
    -replace '__LANGDIR__', $LANGDIR
Set-Content -Path $issPath -Value $iss -Encoding UTF8

Write-Host '[3/4] Inno Setup compile'
& $ISCC $issPath
if ($LASTEXITCODE -ne 0) { throw ("ISCC failed with exit code {0}" -f $LASTEXITCODE) }

Write-Host '[4/4] cleanup'
Remove-Item $issPath -Force -ErrorAction SilentlyContinue

$exe = Join-Path $OUTDIR ("AI-Gateway-Setup-{0}.exe" -f $VER)
if (-not (Test-Path $exe)) { throw "installer not produced: $exe" }
$mb = (Get-Item $exe).Length / 1MB
Write-Host ''
Write-Host ("DONE  {0}  ({1:N1} MB)" -f $exe, $mb)
