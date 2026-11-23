# 一次性准备：让部署脚本能用带口令的私钥（Windows OpenSSH Agent）
#
# 背景：部署私钥 dafeiyu_cloud_final 带口令，脚本里用 BatchMode 跑，不会弹交互提示。
#       所以口令要在 ssh-agent 里，ssh 才能自动签名。
#
# 用法（第一次必须用【管理员】PowerShell 跑，因为要改服务启动类型）：
#   powershell -ExecutionPolicy Bypass -File scripts\setup-ssh-agent.ps1
#
# 之后每次开机只要 agent 是自动启动，跑一次 ssh-add 即可（本脚本也会帮你做）。
param(
  [string]$Key = $(if ($env:DAFEIYU_SSH_KEY) { $env:DAFEIYU_SSH_KEY } else { "$env:USERPROFILE\.ssh\dafeiyu_cloud_final" })
)

$ErrorActionPreference = "Stop"
$sshAdd = "C:\Windows\System32\OpenSSH\ssh-add.exe"
if (-not (Test-Path $sshAdd)) { throw "未找到 ssh-add.exe（Windows 可选功能 OpenSSH Client 没装？）" }
if (-not (Test-Path $Key)) { throw "找不到私钥：$Key（可用 -Key 或环境变量 DAFEIYU_SSH_KEY 指定）" }

$svc = Get-Service ssh-agent -ErrorAction Stop
if ($svc.StartType -ne "Automatic") {
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $admin) {
    Write-Host "!! 需要管理员权限才能把 ssh-agent 设为自动启动并启动：" -ForegroundColor Yellow
    Write-Host "     Set-Service ssh-agent -StartupType Automatic; Start-Service ssh-agent"
    Write-Host "   或者直接用管理员 PowerShell 重跑本脚本。"
    exit 1
  }
  Set-Service ssh-agent -StartupType Automatic
  Write-Host "==> ssh-agent 已设为自动启动" -ForegroundColor Cyan
}
if ((Get-Service ssh-agent).Status -ne "Running") {
  Start-Service ssh-agent
  Write-Host "==> ssh-agent 已启动" -ForegroundColor Cyan
}

# 已经在 agent 里的就别重复加（ssh-add 会提示 passphrase）
$existing = & $sshAdd -l 2>&1
if ($LASTEXITCODE -eq 0 -and ($existing -match [regex]::Escape((Get-Content "$Key.pub" -Raw).Split(" ")[1].Substring(0, 20)))) {
  Write-Host "==> 密钥已在 agent 中" -ForegroundColor Green
} else {
  Write-Host "==> 添加密钥（会提示输入一次口令）" -ForegroundColor Cyan
  & $sshAdd $Key
}

Write-Host "`n==> 当前 agent 里的密钥：" -ForegroundColor Cyan
& $sshAdd -l
