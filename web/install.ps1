# installs steer (https://github.com/EwoudVV/steer) into ~\.steer\bin and sets it up
#   irm https://steer.duck.hackclub.app/install.ps1 | iex
$ErrorActionPreference = "Stop"

$bin = Join-Path $HOME ".steer\bin"
New-Item -ItemType Directory -Force -Path $bin | Out-Null
$exe = Join-Path $bin "steer.exe"

Write-Host "downloading steer..."
Invoke-WebRequest -UseBasicParsing "https://github.com/EwoudVV/steer/releases/latest/download/steer-windows-x64.exe" -OutFile "$exe.new"
# a running watcher keeps the old file locked
Get-Process steer -ErrorAction SilentlyContinue | Stop-Process -Force
Move-Item -Force "$exe.new" $exe

if (-not (Test-Path (Join-Path $HOME ".steer\config.json"))) {
  Write-Host "sign in with your hack club account:"
  & $exe login
  if ($LASTEXITCODE -ne 0) { exit 1 }
}

& $exe setup
Write-Host "done. check on it anytime with: ~\.steer\bin\steer status"
