# 一键部署：本地 git archive → scp → 服务器解包重启（不依赖 GitHub）
# 用法：
#   powershell -ExecutionPolicy Bypass -File deploy\cloud\deploy.ps1
#   ... -AllowDirty        # 有未提交改动也部署（会把工作区改动一起打包）
#   ... -NoRestart         # 只上传解包，不重启
param(
  [string]$Server = "101.245.76.51",
  [string]$User = "root",
  [string]$Key = "$env:USERPROFILE\.ssh\dafeiyu_cloud",
  [string]$AppDir = "/opt/dafeiyu-room",
  [switch]$AllowDirty,
  [switch]$NoRestart
)

$ErrorActionPreference = "Stop"
$root = Resolve-Path (Join-Path $PSScriptRoot "..\..")
Set-Location $root

$git = "C:\Program Files\Git\cmd\git.exe"
$scp = "C:\Windows\System32\OpenSSH\scp.exe"
$ssh = "C:\Windows\System32\OpenSSH\ssh.exe"

$dirty = & $git status --porcelain
if ($dirty -and -not $AllowDirty) {
  Write-Host "!! 有未提交改动，先提交再部署（或加 -AllowDirty）：" -ForegroundColor Yellow
  $dirty | Select-Object -First 10 | ForEach-Object { Write-Host "   $_" }
  exit 1
}

$head = (& $git rev-parse --short HEAD).Trim()
$tar = Join-Path $env:TEMP "dafeiyu-deploy.tar"
if ($AllowDirty) {
  # 工作区快照（含未提交改动），用 git stash create 生成临时对象
  $stash = (& $git stash create).Trim()
  if ($stash) { & $git archive --format=tar $stash -o $tar } else { & $git archive --format=tar HEAD -o $tar }
} else {
  & $git archive --format=tar HEAD -o $tar
}
Write-Host "==> 打包 $head ($([math]::Round((Get-Item $tar).Length/1MB,1)) MB)"

# 先确保服务器上有应用脚本（首次或脚本更新时）
$applyScript = Join-Path $PSScriptRoot "apply-deploy.sh"
& $scp -o BatchMode=yes -i $Key $applyScript "${User}@${Server}:/usr/local/bin/apply-deploy.sh"
& $ssh -o BatchMode=yes -i $Key "${User}@${Server}" 'perl -pi -e "s/\r//g" /usr/local/bin/apply-deploy.sh; chmod +x /usr/local/bin/apply-deploy.sh'

& $scp -o BatchMode=yes -i $Key $tar "${User}@${Server}:/root/deploy-incoming.tar"
if ($LASTEXITCODE -ne 0) { throw "上传失败" }

if ($NoRestart) {
  Write-Host "==> 已上传（-NoRestart，未解包）"
  exit 0
}

& $ssh -o BatchMode=yes -i $Key "${User}@${Server}" "bash /usr/local/bin/apply-deploy.sh /root/deploy-incoming.tar"
if ($LASTEXITCODE -ne 0) { throw "服务器端部署失败" }

Write-Host "==> 完成：$head" -ForegroundColor Green
