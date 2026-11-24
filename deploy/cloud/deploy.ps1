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
  # git stash create 只在有**已跟踪文件改动**时才产出一个 commit；
  # 如果工作区脏只是因为多了几个未跟踪文件（??），它返回空 ——
  # 此时 $(...).Trim() 会对 null 调方法直接崩。之前就是这么炸的。
  $stash = & $git stash create
  if ($stash) { $archiveSrc = "$stash".Trim() }
  else {
    # 没有已跟踪改动：直接用 HEAD（未跟踪文件本来也不该进部署包）
    Write-Host "==> 工作区只有未跟踪文件，按 HEAD 打包"
  }
}

# 1) 代码包（排除 assets；assets 单独打包）
& $git archive --format=tar -o $codeTar $archiveSrc -- . ':!public/room/assets'
Write-Host "==> 代码包 $head ($([math]::Round((Get-Item $codeTar).Length/1MB,1)) MB，已排除 assets)"

# 2) 资产（用 git archive 打包，UTF-8 文件名安全）
# 增量只传"新增/变更"的文件，不是全量 377MB。服务器上传带宽约 1.5MB/s，
# 全量一次要 4~5 分钟；改一个 ogg 却传 377MB 是纯浪费。
#
# 注意 git archive 的路径参数有上限（命令行长度），超了要分批。
node scripts/build-asset-manifest.mjs --out $manifestLocal
& $ssh -o BatchMode=yes -i $Key "${User}@${Server}" "cat '$AppDir/assets-manifest.json' 2>/dev/null || true" | Out-File -Encoding utf8 $serverManifest
node scripts/build-asset-manifest.mjs --out $manifestLocal --server $serverManifest --changed $changedList
$assetTarPath = ""
$assetChanged = [bool]$FullAssets
$changedPaths = @()
if (-not $assetChanged -and (Test-Path $changedList)) {
  # 清单里是相对 assets 的路径（用 / 分隔），git archive 要的是含前缀的仓库路径
  $changedPaths = @(Get-Content $changedList -Encoding UTF8 | Where-Object { $_.Trim() } | ForEach-Object {
    "public/room/assets/$($_.Trim())"
  })
  $assetChanged = $changedPaths.Count -gt 0
}
# 服务器上要删的文件：本地已经没有、但服务器清单里还记着的。
# 增量解包是覆盖式的（tar -xf 不删文件），删掉的素材不清理会一直留在盘上，
# 而且会让下次部署误判"服务器已有"从而漏传同名新文件。
$stalePaths = @()
if (-not $FullAssets -and (Test-Path $serverManifest)) {
  try {
    $serverMap = Get-Content $serverManifest -Raw -Encoding UTF8 | ConvertFrom-Json
    $localMap = Get-Content $manifestLocal -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($serverMap -and $localMap) {
      # 用 HashSet 而不是数组 .Contains：PSObject.Properties.Name 是数组，
      # 数组没有 .Contains 方法（那是 List 的），会静默返回错结果。
      $localNames = [System.Collections.Generic.HashSet[string]]::new()
      foreach ($n in $localMap.PSObject.Properties.Name) { [void]$localNames.Add($n) }
      $stalePaths = @($serverMap.PSObject.Properties.Name | Where-Object { -not $localNames.Contains($_) })
    }
  } catch { /* 清单坏就当没有，不影响主流程 */ }
}

if ($assetChanged) {
  if ($FullAssets) {
    & $git archive --format=tar -o $assetTar $archiveSrc -- public/room/assets
  } else {
    # 分批打包再合并：git archive 一次传几百个路径会撞命令行长度上限。
    # 大多数情况下只有个位数文件，走第一批就够。
    #
    # 合并不是把两个 tar 直接首尾相接 —— **那样会静默丢文件**：
    # 每个 git archive 产物尾部都有 tar 结束标记（两个全零块），
    # 解包器读到标记就停，第二个包的内容根本不会被看到。
    # 正确做法是解到一个临时目录、再打一个包，让 tar 自己生成正确的结构。
    if ($changedPaths.Count -le 100) {
      & $git archive --format=tar -o $assetTar $archiveSrc -- @changedPaths
      if ($LASTEXITCODE -ne 0) { throw "git archive 失败（资产增量）" }
    } else {
      $stage = Join-Path $tmp "assets-stage"
      Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
      New-Item -ItemType Directory -Force -Path $stage | Out-Null
      $batchSize = 100
      for ($b = 0; $b -lt $changedPaths.Count; $b += $batchSize) {
        $end = [Math]::Min($b + $batchSize - 1, $changedPaths.Count - 1)
        $batch = $changedPaths[$b..$end]
        $bt = Join-Path $tmp "assets-part$b.tar"
        & $git archive --format=tar -o $bt $archiveSrc -- @batch
        if ($LASTEXITCODE -ne 0) { throw "git archive 失败（资产第 $b 批）" }
        & $tar -xf $bt -C $stage
        Remove-Item -Force $bt
      }
      # 从暂存目录重新打一个包，路径结构与服务器端解包时的期望一致
      & $tar -cf $assetTar -C $stage .
      if ($LASTEXITCODE -ne 0) { throw "重新打包资产失败" }
      Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  $assetTarPath = $assetTar
  Write-Host "==> 资产有变更：$($changedPaths.Count) 个文件，打包 ($([math]::Round((Get-Item $assetTar).Length/1MB,2)) MB)"
} else {
  Write-Host "==> 资产无变更，跳过上传"
}
if ($stalePaths.Count -gt 0) {
  Write-Host "==> 服务器有 $($stalePaths.Count) 个已删除的文件待清理"
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
# 待删清单单独传，服务器端解包后照着删（空文件 = 不用删）
$staleList = Join-Path $tmp "assets-stale.txt"
if ($stalePaths.Count -gt 0) { $stalePaths | Set-Content -Path $staleList -Encoding UTF8 } else { Set-Content -Path $staleList -Value "" -Encoding UTF8 }
& $scp -o BatchMode=yes -i $Key $staleList "${User}@${Server}:/root/deploy-incoming-stale.txt"

if ($NoRestart) {
  Write-Host "==> 已上传（-NoRestart，未解包）"
  exit 0
}

# 4) 服务器落地
$assetArg = if ($assetTarPath) { "/root/deploy-incoming-assets.tar" } else { "" }
& $ssh -o BatchMode=yes -i $Key "${User}@${Server}" "bash /usr/local/bin/apply-deploy.sh /root/deploy-incoming-code.tar /root/deploy-incoming-manifest.json /root/deploy-incoming-dist.tar '$assetArg' $head /root/deploy-incoming-stale.txt"
if ($LASTEXITCODE -ne 0) { throw "服务器端部署失败" }

Write-Host "==> 完成：$head" -ForegroundColor Green
