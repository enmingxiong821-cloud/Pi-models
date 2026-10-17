# pi-model-hub 一键安装（Windows PowerShell）
#   powershell -ExecutionPolicy Bypass -File install.ps1
param([switch]$NoPath)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host ""
Write-Host "pi-model-hub 安装器" -ForegroundColor Cyan
Write-Host ""

# 1) Node 检查
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "✗ 没找到 Node.js。请先安装 Node 20 或更高版本：https://nodejs.org" -ForegroundColor Red
  exit 1
}
$version = (& node -v).Trim().TrimStart("v")
$major = [int]($version.Split(".")[0])
if ($major -lt 20) {
  Write-Host "✗ Node 版本过低：$version（需要 20+）" -ForegroundColor Red
  exit 1
}
Write-Host "✓ Node $version" -ForegroundColor Green

# 2) 把 bin 目录加进用户 PATH，以后直接敲 pmh
$binDir = Join-Path $repo "bin"
if (-not $NoPath) {
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($null -eq $userPath) { $userPath = "" }
  if (($userPath -split ";") -notcontains $binDir) {
    [Environment]::SetEnvironmentVariable("Path", ($userPath.TrimEnd(";") + ";" + $binDir), "User")
    Write-Host "✓ 已把 $binDir 加入用户 PATH（重开终端后生效）" -ForegroundColor Green
  } else {
    Write-Host "✓ 用户 PATH 里已经有 $binDir" -ForegroundColor Green
  }
}

# 3) 给 pi 装上 /switch 扩展
$piRoot = Join-Path $env:USERPROFILE ".pi\agent"
if (Test-Path $piRoot) {
  & node (Join-Path $repo "bin\pmh.mjs") install-extension
} else {
  Write-Host "! 没检测到 pi（$piRoot 不存在），跳过扩展安装。" -ForegroundColor Yellow
  Write-Host "  装好 pi 之后再运行：pmh install-extension"
}

Write-Host ""
Write-Host "接下来三步：" -ForegroundColor Cyan
Write-Host "  1. 重新开一个终端窗口（让 PATH 生效）"
Write-Host "  2. pmh quick" -ForegroundColor White
Write-Host "     —— 地址 + Key 一键接入；Key 可以先复制到剪贴板，它会自动读"
Write-Host "  3. 在 pi 里输入 /reload，然后 /switch 或 Ctrl+Shift+M 切换模型"
Write-Host ""
