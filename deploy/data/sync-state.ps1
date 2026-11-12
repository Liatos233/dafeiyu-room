# 本地 → 云端 / 云端 → 本地 的 AstrBot 状态同步
# 用法：
#   powershell -ExecutionPolicy Bypass -File deploy\data\sync-state.ps1 -Direction push   # 本地覆盖云端
#   powershell -ExecutionPolicy Bypass -File deploy\data\sync-state.ps1 -Direction pull   # 云端覆盖本地
# 注意：同一时间只跑一端，避免双写分叉。
param(
  [ValidateSet("push", "pull")][string]$Direction = "push",
  [string]$Server = "101.245.76.51",
  [string]$User = "root",
  [string]$Key = "$env:USERPROFILE\.ssh\dafeiyu_cloud",
  [string]$Tar = "_migrate\astrbot-full-state.tar.gz"
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $root

$ssh = "C:\Windows\System32\OpenSSH\ssh.exe"
$scp = "C:\Windows\System32\OpenSSH\scp.exe"

if ($Direction -eq "push") {
  Write-Host "==> 本地打包（含 livingmemory / memewiki / meme_manager / 配置 / 核心库）" -ForegroundColor Cyan
  python scripts\pack-astrbot-state.py
  Write-Host "==> 上传"
  & $scp -o BatchMode=yes -i $Key $Tar "$User@${Server}:/root/astrbot-full-state.tar.gz"
  if ($LASTEXITCODE -ne 0) { throw "上传失败" }
  Write-Host "==> 云端恢复"
  & $ssh -o BatchMode=yes -i $Key "$User@$Server" "bash /usr/local/bin/restore-astrbot-state.sh /root/astrbot-full-state.tar.gz"
} else {
  Write-Host "==> 云端打包" -ForegroundColor Cyan
  & $ssh -o BatchMode=yes -i $Key "$User@$Server" "bash /usr/local/bin/pack-astrbot-state.sh /root/astrbot-full-state.tar.gz"
  Write-Host "==> 下载"
  New-Item -ItemType Directory -Force -Path (Split-Path $Tar) | Out-Null
  & $scp -o BatchMode=yes -i $Key "$User@${Server}:/root/astrbot-full-state.tar.gz" $Tar
  if ($LASTEXITCODE -ne 0) { throw "下载失败" }
  Write-Host "==> 本机恢复（请先停止本机 AstrBot）"
  powershell -ExecutionPolicy Bypass -File deploy\data\apply-state-windows.ps1 -Tar $Tar
}
