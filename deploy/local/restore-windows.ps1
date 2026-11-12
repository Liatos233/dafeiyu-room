# 把 dafeiyu-room 恢复到本机（Windows PowerShell）
# 用法：
#   powershell -ExecutionPolicy Bypass -File deploy\local\restore-windows.ps1
#   powershell -ExecutionPolicy Bypass -File deploy\local\restore-windows.ps1 -Backup backups\dafeiyu-xxx.tar.gz
#   powershell -ExecutionPolicy Bypass -File deploy\local\restore-windows.ps1 -NoStart

param(
  [string]$Backup = "",
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $root

Write-Host "==> 仓库: $root" -ForegroundColor Cyan

# 1) Node
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw "未找到 node，请先安装 Node.js >= 22.13" }
$ver = (node -v).TrimStart("v")
$major = [int]($ver.Split(".")[0])
if ($major -lt 22) { throw "Node 版本过低：$ver（需要 >= 22.13）" }
Write-Host "Node $ver OK"

# 2) 依赖
if (-not (Test-Path "node_modules")) {
  Write-Host "==> 安装依赖（npm ci）"
  npm ci --no-audit --no-fund
} else {
  Write-Host "==> node_modules 已存在，跳过安装"
}

# 3) 配置
if (-not (Test-Path "config.json")) {
  Copy-Item "config.example.json" "config.json"
  Write-Host "!! 已生成 config.json，请填写 ownerQQ / allow 后再启动" -ForegroundColor Yellow
}
New-Item -ItemType Directory -Force -Path "state" | Out-Null

# 4) 恢复备份
if ($Backup -and (Test-Path $Backup)) {
  Write-Host "==> 恢复备份: $Backup"
  $tmp = Join-Path $env:TEMP ("dafeiyu-restore-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  tar -xzf $Backup -C $tmp
  if (Test-Path (Join-Path $tmp "state")) {
    Copy-Item (Join-Path $tmp "state\*") "state\" -Recurse -Force
    Write-Host "   state/ 已恢复"
  }
  if (Test-Path (Join-Path $tmp "astrbot")) {
    Write-Host "   备份里含 AstrBot 数据，本机 AstrBot 请手动把 astrbot\cmd_config.json / data_v4.db 覆盖到 %USERPROFILE%\.astrbot 对应目录" -ForegroundColor Yellow
  }
  Remove-Item $tmp -Recurse -Force
} elseif ($Backup) {
  Write-Host "!! 备份文件不存在: $Backup" -ForegroundColor Yellow
} else {
  Write-Host "==> 未指定 -Backup，使用现有 state/"
}

if ($NoStart) {
  Write-Host "==> 已跳过启动（-NoStart）"
  exit 0
}

# 5) 启动
Write-Host "==> 启动 bridge（新窗口）"
$startBat = Join-Path $PSScriptRoot "start-room.bat"
Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$startBat`"" -WorkingDirectory $root
Start-Sleep -Seconds 5
try {
  $r = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:3100/room/" -TimeoutSec 8
  Write-Host "房间已就绪：http://127.0.0.1:3100/room/ (HTTP $($r.StatusCode))" -ForegroundColor Green
} catch {
  Write-Host "尚未就绪，查看 bridge 窗口或 state\bridge.log" -ForegroundColor Yellow
}
