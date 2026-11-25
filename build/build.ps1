param(
  [string]$NodeDir
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

if (-not $NodeDir) {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCommand) {
    $NodeDir = Split-Path -Parent $nodeCommand.Source
  } else {
    throw 'Node.js 20+ not found. Install Node.js or pass -NodeDir with the folder containing node.exe.'
  }
}

$env:Path = "$NodeDir;$env:Path"
Push-Location $root
try {
  # A running unpacked app locks its DLLs, so stop it before repacking.
  Get-Process TF2Pickup -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 2
  Remove-Item -Recurse -Force dist\win-unpacked -ErrorAction SilentlyContinue

  & "$NodeDir\npm.cmd" install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }

  & "$NodeDir\npm.cmd" run pack
  if ($LASTEXITCODE -ne 0) { throw "electron-builder failed with exit code $LASTEXITCODE" }

  & "$NodeDir\node.exe" build\patch-icon.js dist\win-unpacked\TF2Pickup.exe icons\app.ico
  if ($LASTEXITCODE -ne 0) { throw "icon patch failed with exit code $LASTEXITCODE" }

  Remove-Item dist\win-unpacked\debug.log -ErrorAction SilentlyContinue

  $iscc = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
  if (-not (Test-Path $iscc)) {
    throw "Inno Setup 6 not found: $iscc"
  }
  & $iscc build\installer.iss
  if ($LASTEXITCODE -ne 0) { throw "Inno Setup failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}
