Add-Type -AssemblyName System.Drawing

$size = 512
$out = Join-Path $PSScriptRoot "..\build\icon.png"
$out = [System.IO.Path]::GetFullPath($out)
$dir = [System.IO.Path]::GetDirectoryName($out)
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }

$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::Transparent)

function New-RoundedPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

$bg = New-RoundedPath 16 16 480 480 116
$bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  [System.Drawing.Rectangle]::new(0, 0, $size, $size),
  [System.Drawing.Color]::FromArgb(255, 24, 33, 58),
  [System.Drawing.Color]::FromArgb(255, 47, 111, 237),
  48
)
$g.FillPath($bgBrush, $bg)

$white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
$soft = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(46, 255, 255, 255))
$mid = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(170, 255, 255, 255))
$accent = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 47, 111, 237))

$top = New-RoundedPath 96 140 320 64 20
$middle = New-RoundedPath 96 242 320 64 20
$bottom = New-RoundedPath 96 344 320 64 20
$g.FillPath($soft, $top)
$g.FillPath($white, $middle)
$g.FillPath($soft, $bottom)

$barTop = New-RoundedPath 124 163 144 18 9
$barMid = New-RoundedPath 124 265 184 18 9
$barBottom = New-RoundedPath 124 367 104 18 9
$g.FillPath($mid, $barTop)
$g.FillPath($accent, $barMid)
$g.FillPath($mid, $barBottom)

$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 47, 111, 237), 10)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$g.DrawLines($pen, [System.Drawing.Point[]]@(
  [System.Drawing.Point]::new(354, 256),
  [System.Drawing.Point]::new(370, 274),
  [System.Drawing.Point]::new(354, 292)
))

$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output $out
