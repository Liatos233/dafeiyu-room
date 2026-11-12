# 把 AstrBot 全量状态包恢复到本机（Windows）
# 用法：
#   # 先关闭本机 AstrBot（launcher 里点停止），再执行：
#   powershell -ExecutionPolicy Bypass -File deploy\data\apply-state-windows.ps1 -Tar _migrate\astrbot-full-state.tar.gz
param(
  [Parameter(Mandatory = $true)][string]$Tar,
  [string]$DataDir = "$env:USERPROFILE\.astrbot_launcher\instances\0390ed20-69d8-4e5b-b449-055ce88e34dc\core\data"
)

$ErrorActionPreference = "Stop"
if (-not (Test-Path $Tar)) { throw "找不到 $Tar" }
if (-not (Test-Path $DataDir)) { throw "找不到本机 AstrBot 数据目录: $DataDir" }

# 防止 AstrBot 正在运行导致写冲突
$running = Get-Process | Where-Object { $_.ProcessName -match "astrbot" -or ($_.ProcessName -eq "python" -and $_.Path -like "*astrbot*") }
if ($running) {
  Write-Host "!! 检测到 AstrBot 可能仍在运行，请先在 launcher 里停止后再执行" -ForegroundColor Yellow
  $ans = Read-Host "仍然继续？(y/N)"
  if ($ans -ne "y") { exit 1 }
}

$work = Join-Path $env:TEMP ("astrbot-state-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $work | Out-Null
Write-Host "==> 解压 $Tar"
tar -xzf $Tar -C $work

$skip = @("pulids_snowluma_go_to_astrbot")
if (Test-Path (Join-Path $work "plugin_data")) {
  $target = Join-Path $DataDir "plugin_data"
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  Get-ChildItem (Join-Path $work "plugin_data") -Directory | ForEach-Object {
    if ($skip -contains $_.Name) { return }
    $dst = Join-Path $target $_.Name
    if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
    Copy-Item $_.FullName $dst -Recurse -Force
    Write-Host "   * $($_.Name)"
  }
}

if (Test-Path (Join-Path $work "config")) {
  $cfgDst = Join-Path $DataDir "config"
  New-Item -ItemType Directory -Force -Path $cfgDst | Out-Null
  Copy-Item (Join-Path $work "config\*") $cfgDst -Recurse -Force
  Write-Host "   配置已覆盖"
}

foreach ($f in @("cmd_config.json", "plugins.json", "mcp_server.json", "data_v4.db")) {
  $src = Join-Path $work $f
  if (Test-Path $src) {
    Copy-Item $src (Join-Path $DataDir $f) -Force
    Write-Host "   * $f"
  }
}
foreach ($f in @("data_v4.db-wal", "data_v4.db-shm")) {
  $p = Join-Path $DataDir $f
  if (Test-Path $p) { Remove-Item $p -Force }
}

Remove-Item $work -Recurse -Force
Write-Host "==> 恢复完成，请在 launcher 里启动 AstrBot" -ForegroundColor Green
