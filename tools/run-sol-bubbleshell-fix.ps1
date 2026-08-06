$ErrorActionPreference = 'Stop'

$repo = 'J:\Users\Mr. Edwards\Documents\kimi\workspace\webgpu-fractal-modeler'
Set-Location -LiteralPath $repo

$source = Join-Path $repo 'tools\apply-sol-bubbleshell.ps1'
$temp = Join-Path $env:TEMP 'apply-sol-bubbleshell-fixed.ps1'

$text = [System.IO.File]::ReadAllText($source, [System.Text.Encoding]::UTF8)
$text = [System.Text.RegularExpressions.Regex]::Replace(
  $text,
  '(?m)^\$startMarker\s*=.*$',
  '$startMarker = "const BS_LEVELS : i32 = 6;"'
)
$text = [System.Text.RegularExpressions.Regex]::Replace(
  $text,
  '(?m)^\$endMarker\s*=.*$',
  '$endMarker = "// ---- Penrose quasicrystal"'
)

$utf8Bom = New-Object System.Text.UTF8Encoding($true)
[System.IO.File]::WriteAllText($temp, $text, $utf8Bom)

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $temp
if ($LASTEXITCODE -ne 0) {
  throw "Bubble-shell patch failed with exit code $LASTEXITCODE."
}
