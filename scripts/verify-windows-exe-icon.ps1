param(
  [Parameter(Mandatory = $true)]
  [string]$ExecutablePath,
  [string]$ExpectedPngPath = (Join-Path $PSScriptRoot '..\assets\brand\generated\novus-atelier-32.png')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$exe = (Resolve-Path -LiteralPath $ExecutablePath).Path
$png = (Resolve-Path -LiteralPath $ExpectedPngPath).Path
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exe)
if ($null -eq $icon) { throw "No embedded icon: $exe" }
$actual = $icon.ToBitmap()
$expected = [System.Drawing.Bitmap]::FromFile($png)
try {
  if ($actual.Width -ne $expected.Width -or $actual.Height -ne $expected.Height) {
    throw "Embedded icon dimensions differ: $($actual.Width)x$($actual.Height) versus $($expected.Width)x$($expected.Height)"
  }
  for ($y = 0; $y -lt $actual.Height; $y++) {
    for ($x = 0; $x -lt $actual.Width; $x++) {
      if ($actual.GetPixel($x, $y).ToArgb() -ne $expected.GetPixel($x, $y).ToArgb()) {
        throw "Embedded icon pixels differ at ($x,$y): $exe"
      }
    }
  }
  Write-Output "PASS: embedded executable icon matches $png ($($actual.Width)x$($actual.Height))"
} finally {
  $actual.Dispose()
  $expected.Dispose()
  $icon.Dispose()
}
