param(
  [string]$Source = (Join-Path $PSScriptRoot '..\..\repo\public\branding\tf2pick-up.ru\favicon.png'),
  [string]$OutputDir = (Join-Path $PSScriptRoot '..\icons')
)

Add-Type -AssemblyName System.Drawing

function New-Ico([string]$Source, [string]$Destination, [int[]]$Sizes) {
  $sourceImage = [System.Drawing.Image]::FromFile($Source)
  $images = @()

  try {
    foreach ($size in $Sizes) {
      $bitmap = New-Object System.Drawing.Bitmap($size, $size)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.DrawImage($sourceImage, 0, 0, $size, $size)
      } finally {
        $graphics.Dispose()
      }

      $stream = New-Object System.IO.MemoryStream
      try {
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        $images += , ($size, $stream.ToArray())
      } finally {
        $stream.Dispose()
        $bitmap.Dispose()
      }
    }
  } finally {
    $sourceImage.Dispose()
  }

  $header = New-Object System.IO.MemoryStream
  $writer = New-Object System.IO.BinaryWriter($header)
  $writer.Write([uint16]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]$images.Count)

  $offset = 6 + 16 * $images.Count
  foreach ($image in $images) {
    $size = [int]$image[0]
    $bytes = [byte[]]$image[1]
    $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
    $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]$bytes.Length)
    $writer.Write([uint32]$offset)
    $offset += $bytes.Length
  }

  foreach ($image in $images) {
    $writer.Write([byte[]]$image[1])
  }
  $writer.Flush()

  [System.IO.File]::WriteAllBytes($Destination, $header.ToArray())
  $writer.Dispose()
  $header.Dispose()
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
New-Ico $Source (Join-Path $OutputDir 'app.ico') @(16, 24, 32, 48, 64, 128, 256)
New-Ico $Source (Join-Path $OutputDir 'tray.ico') @(16, 20, 24, 32)
Write-Output "Icons written to $OutputDir"
