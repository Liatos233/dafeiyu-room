# 从云端拉最新备份到本机（Windows PowerShell）
# 用法：
#   powershell -ExecutionPolicy Bypass -File deploy\data\fetch-backup.ps1
#   powershell -ExecutionPolicy Bypass -File deploy\data\fetch-backup.ps1 -Host 101.245.76.51 -User root -Key $env:USERPROFILE\.ssh\dafeiyu_cloud

param(
  [string]$Server = "101.245.76.51",
  [string]$User = "root",
  [string]$Key = "$env:USERPROFILE\.ssh\dafeiyu_cloud",
  [string]$RemoteDir = "/var/backups/dafeiyu",
  [string]$OutDir = "backups"
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $root
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$ssh = "C:\Windows\System32\OpenSSH\ssh.exe"
$scp = "C:\Windows\System32\OpenSSH\scp.exe"
if (-not (Test-Path $ssh)) { throw "未找到 ssh.exe" }

Write-Host "==> 查询最新备份" -ForegroundColor Cyan
$latest = & $ssh -o BatchMode=yes -i $Key "$User@$Server" "ls -1t $RemoteDir/dafeiyu-*.tar.gz 2>/dev/null | head -n 1"
if (-not $latest) { throw "服务器上没有备份文件（$RemoteDir）" }
$latest = $latest.Trim()
Write-Host "    $latest"

$name = Split-Path $latest -Leaf
$dest = Join-Path $OutDir $name
Write-Host "==> 下载到 $dest"
& $scp -o BatchMode=yes -i $Key "$User@${Server}:$latest" $dest
if ($LASTEXITCODE -ne 0) { throw "scp 失败" }

Write-Host "==> 完成：$dest" -ForegroundColor Green
Write-Host "恢复：powershell -ExecutionPolicy Bypass -File deploy\local\restore-windows.ps1 -Backup $dest"
