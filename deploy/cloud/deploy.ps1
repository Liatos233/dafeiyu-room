# 一键部署：本地 git archive（代码，排除 assets）→ scp → 服务器解包重启（不依赖 GitHub）
# 资产（public/room/assets，~380MB）走增量：按 sha256 清单只上传新增/变更的文件。
# 用法：
#   powershell -ExecutionPolicy Bypass -File deploy\cloud\deploy.ps1
#   ... -AllowDirty        # 有未提交改动也部署（会把工作区改动一起打包）
#   ... -NoRestart         # 只上传解包，不重启
#   ... -FullAssets        # 资产不做增量，强制全量上传
param(
  # 服务器地址不再写死在仓库里：用环境变量 DAFEIYU_SERVER（或 -Server 显式传）
  [string]$Server = "$env:DAFEIYU_SERVER",
  [string]$User = "root",
  # 私钥带口令，走 Windows ssh-agent：先跑 ssh-add 再部署（见 scripts/setup-ssh-agent.ps1）
  [string]$Key = $(if ($env:DAFEIYU_SSH_KEY) { $env:DAFEIYU_SSH_KEY } else { "$env:USERPROFILE\.ssh\dafeiyu_cloud_final" }),
  [string]$AppDir = "/opt/dafeiyu-room",
  [switch]$AllowDirty,
  [switch]$NoRestart,
  [switch]$FullAssets
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $root

# 服务器地址不再写死在仓库里。第一次用先设一次用户级环境变量：
#   setx DAFEIYU_SERVER <你的服务器 IP>
if (-not $Server) {
  Write-Host "!! 没设置服务器地址：setx DAFEIYU_SERVER <服务器IP>，或加 -Server 传入" -ForegroundColor Yellow
  exit 1
}
# 私钥带口令，脚本是 BatchMode，必须先把密钥放进 ssh-agent
$sshAdd = "C:\Windows\System32\OpenSSH\ssh-add.exe"
if (Test-Path $sshAdd) {
  & $sshAdd -l *> $null
  if ($LASTEXITCODE -ne 0) {
    Write-Host "!! ssh-agent 里没有密钥。先跑一次（首次需管理员）：" -ForegroundColor Yellow
    Write-Host "     powershell -ExecutionPolicy Bypass -File scripts\setup-ssh-agent.ps1"
    exit 1
  }
}

$git = "C:\Program Files\Git\cmd\git.exe"
$scp = "C:\Windows\System32\OpenSSH\scp.exe"
$ssh = "C:\Windows\System32\OpenSSH\ssh.exe"
$tar = "C:\Windows\System32\tar.exe"

$dirty = & $git status --porcelain
if ($dirty -and -not $AllowDirty) {
  Write-Host "!! 有未提交改动，先提交再部署（或加 -AllowDirty）：" -ForegroundColor Yellow
  $dirty | Select-Object -First 10 | ForEach-Object { Write-Host "   $_" }
  exit 1
}

$head = (& $git rev-parse --short HEAD).Trim()
$tmp = Join-Path $env:TEMP "dafeiyu-deploy"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$codeTar = Join-Path $tmp "code.tar"
$assetTar = Join-Path $tmp "assets.tar"
$manifestLocal = Join-Path $tmp "assets-manifest.json"
$serverManifest = Join-Path $tmp "assets-manifest.server.json"
$changedList = Join-Path $tmp "assets-changed.txt"

# 未提交改动（-AllowDirty）打成一个临时 commit，代码与资产都从它归档
$archiveSrc = "HEAD"
if ($AllowDirty) {
  $stash = (& $git stash create).Trim()
  if ($stash) { $archiveSrc = $stash }
}

# 1) 代码包（排除 assets；assets 单独打包）
& $git archive --format=tar -o $codeTar $archiveSrc -- . ':!public/room/assets'
Write-Host "==> 代码包 $head ($([math]::Round((Get-Item $codeTar).Length/1MB,1)) MB，已排除 assets)"

# 2) 资产（用 git archive 打包，UTF-8 文件名安全；清单 sha256 只用于判断是否变更）
node scripts/build-asset-manifest.mjs --out $manifestLocal
& $ssh -o BatchMode=yes -i $Key "${User}@${Server}" "cat '$AppDir/assets-manifest.json' 2>/dev/null || true" | Out-File -Encoding utf8 $serverManifest
node scripts/build-asset-manifest.mjs --out $manifestLocal --server $serverManifest --changed $changedList
$assetTarPath = ""
$assetChanged = [bool]$FullAssets
if (-not $assetChanged -and (Test-Path $changedList)) {
  $assetChanged = (Get-Item $changedList).Length -gt 0
}
if ($assetChanged) {
  & $git archive --format=tar -o $assetTar $archiveSrc -- public/room/assets
  $assetTarPath = $assetTar
  Write-Host "==> 资产有变更，打包 ($([math]::Round((Get-Item $assetTar).Length/1MB,1)) MB)"
} else {
  Write-Host "==> 资产无变更，跳过上传"
}

# 2.5) 前端构建产物（dist/room/，内容哈希 JS/CSS）
Write-Host "==> 构建前端（vite build）"
npm run build
if ($LASTEXITCODE -ne 0) { throw "前端构建失败（npm run build）" }
$distTar = Join-Path $tmp "dist.tar"
& $tar -cf $distTar -C dist/room .

# 3) 上传（代码包 + 清单 + 构建产物必传，资产增量包有才传）
$applyScript = Join-Path $PSScriptRoot "apply-deploy.sh"
& $scp -o BatchMode=yes -i $Key $applyScript "${User}@${Server}:/usr/local/bin/apply-deploy.sh"
& $ssh -o BatchMode=yes -i $Key "${User}@${Server}" 'chmod +x /usr/local/bin/apply-deploy.sh'
& $scp -o BatchMode=yes -i $Key $codeTar "${User}@${Server}:/root/deploy-incoming-code.tar"
& $scp -o BatchMode=yes -i $Key $manifestLocal "${User}@${Server}:/root/deploy-incoming-manifest.json"
& $scp -o BatchMode=yes -i $Key $distTar "${User}@${Server}:/root/deploy-incoming-dist.tar"
if ($assetTarPath) { & $scp -o BatchMode=yes -i $Key $assetTarPath "${User}@${Server}:/root/deploy-incoming-assets.tar" }

if ($NoRestart) {
  Write-Host "==> 已上传（-NoRestart，未解包）"
  exit 0
}

# 4) 服务器落地
$assetArg = if ($assetTarPath) { "/root/deploy-incoming-assets.tar" } else { "" }
& $ssh -o BatchMode=yes -i $Key "${User}@${Server}" "bash /usr/local/bin/apply-deploy.sh /root/deploy-incoming-code.tar /root/deploy-incoming-manifest.json /root/deploy-incoming-dist.tar '$assetArg' $head"
if ($LASTEXITCODE -ne 0) { throw "服务器端部署失败" }

Write-Host "==> 完成：$head" -ForegroundColor Green
