# pmh 一键安装（Windows PowerShell）
# 一行命令：
#   irm https://raw.githubusercontent.com/enmingxiong821-cloud/pi-model/main/install.ps1 | iex
# 双击安装：解压源码 zip 后双击 install.cmd / 一键安装.cmd
# 可选参数：
#   -Version <tag|main>   版本，默认最新 Release
#   -Dir <path>           安装目录，默认 %LOCALAPPDATA%\pmh
#   -Url <地址>           预设中转站地址
#   -Copy                 复制扩展，而不是登记为 pi 包
#   -NoSetup              只安装，不进入配置向导
#   -NoPath               不修改 PATH
#   -DryRun               只打印计划
[CmdletBinding()]
param(
  [string]$Version = "latest",
  [string]$Dir = "",
  [string]$Url = "",
  [switch]$Copy,
  [switch]$NoSetup,
  [switch]$NoPath,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$Repo = "enmingxiong821-cloud/pi-model"
$NodeMinMajor = 20

function Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Done($text) { Write-Host "[ok] $text" -ForegroundColor Green }
function Note($text) { Write-Host "[!] $text" -ForegroundColor Yellow }

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  throw "未找到 Node.js。请先安装 Node.js 20+：winget install OpenJS.NodeJS.LTS 或 https://nodejs.org/"
}
$nodeVersion = (& node -v).Trim().TrimStart("v")
$nodeMajor = [int]($nodeVersion.Split(".")[0])
if ($nodeMajor -lt $NodeMinMajor) {
  throw "Node.js 版本过低（当前 $nodeVersion，需要 20+）：winget upgrade OpenJS.NodeJS.LTS"
}
Write-Host "[ok] Node $nodeVersion" -ForegroundColor Green

# 脚本所在目录有源码时优先本地安装（源码 zip 双击、或已 clone 的仓库）
$localSource = $null
if ($PSCommandPath) {
  $candidate = Split-Path -Parent $PSCommandPath
  if (Test-Path (Join-Path $candidate "bin\pmh.mjs")) { $localSource = $candidate }
}

$inPlace = $false
if ($localSource -and (Test-Path (Join-Path $localSource ".git"))) {
  if (-not $Dir) {
    $Dir = $localSource
    $inPlace = $true
  } elseif ([IO.Path]::GetFullPath($Dir) -eq [IO.Path]::GetFullPath($localSource)) {
    $inPlace = $true
  }
}
if (-not $Dir) {
  $base = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME "AppData\Local" }
  $Dir = Join-Path $base "pmh"
}
$Dir = [IO.Path]::GetFullPath($Dir)
$binDir = Join-Path $Dir "bin"

$isBranch = $Version -in @("main", "master")
if ($Version -eq "latest" -and -not $localSource) {
  try {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers @{ "User-Agent" = "pmh-installer" }
    $Version = $release.tag_name
    if (-not $Version) { throw "empty tag" }
  } catch {
    $Version = "main"
    $isBranch = $true
    Note "获取最新 Release 失败，改用 main 分支"
  }
}
$archiveUrl = if ($isBranch) {
  "https://github.com/$Repo/archive/refs/heads/$Version.zip"
} else {
  "https://github.com/$Repo/archive/refs/tags/$Version.zip"
}

if ($DryRun) {
  Write-Host "源码:     $(if ($localSource) { $localSource } else { $archiveUrl })"
  Write-Host "安装目录: $Dir$(if ($inPlace) { '（仓库原地使用）' } else { '' })"
  Write-Host "PATH:     $(if ($NoPath) { '不修改' } else { "加入 $binDir（用户级）" })"
  Write-Host "配置:     $(if ($NoSetup) { '跳过' } else { '安装后进入 bootstrap 向导' })"
  return
}

$temp = $null
try {
  if (-not $localSource) {
    $temp = Join-Path ([IO.Path]::GetTempPath()) ("pmh-install-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $temp -Force | Out-Null
    Step "下载 pmh $Version"
    $zip = Join-Path $temp "pmh.zip"
    Invoke-WebRequest -Uri $archiveUrl -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $temp -Force
    $localSource = Get-ChildItem $temp -Directory |
      Where-Object { Test-Path (Join-Path $_.FullName "bin\pmh.mjs") } |
      Select-Object -First 1 -ExpandProperty FullName
  }
  if (-not $localSource -or -not (Test-Path (Join-Path $localSource "bin\pmh.mjs"))) {
    throw "安装包里没有找到 bin/pmh.mjs"
  }

  if (-not $inPlace) {
    $staging = "$Dir.new-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
    Step "安装到 $Dir"
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    # 与 install.sh 保持一致，只装运行所需文件（不带 docs/tools/.git）
    foreach ($item in @("bin", "src", "extensions", "package.json", "README.md", "README.en.md", "LICENSE")) {
      $sourceItem = Join-Path $localSource $item
      if (Test-Path $sourceItem) {
        Copy-Item -Path $sourceItem -Destination $staging -Recurse -Force
      }
    }
    if (Test-Path $Dir) {
      $backup = "$Dir.bak-" + (Get-Date -Format "yyyyMMddHHmmss")
      Move-Item -Path $Dir -Destination $backup
      Note "旧版本已备份到 $backup"
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $Dir) -Force | Out-Null
    Move-Item -Path $staging -Destination $Dir
  }
  Done "pmh 已就位：$Dir"
} finally {
  if ($temp) { Remove-Item -Path $temp -Recurse -Force -ErrorAction SilentlyContinue }
}

if (-not $NoPath) {
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not $userPath) { $userPath = "" }
  $parts = @($userPath -split ";" | Where-Object { $_ })
  if ($parts -notcontains $binDir) {
    $newPath = if ($userPath.Trim()) { $userPath.TrimEnd(";") + ";" + $binDir } else { $binDir }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Done "已把 $binDir 加入用户 PATH（新开终端生效）"
  }
  if (-not (($env:Path -split ";") -contains $binDir)) {
    $env:Path = "$env:Path;$binDir"
  }
}

if ($NoSetup) {
  Write-Host ""
  Write-Host "安装完成。之后运行：pmh bootstrap"
  return
}

Step "进入配置向导"
$bootstrapArgs = @((Join-Path $Dir "bin\pmh.mjs"), "bootstrap")
if ($Copy) { $bootstrapArgs += "--copy" }
if ($Url) { $bootstrapArgs += @("--base", $Url) }
& node @bootstrapArgs
if ($LASTEXITCODE -ne 0) {
  throw "配置向导未完成（退出码 $LASTEXITCODE）。之后可以重新运行：pmh bootstrap"
}

Write-Host ""
Done "全部完成。重开终端后可直接运行 pmh；在 pi 里输入 /switch。"
