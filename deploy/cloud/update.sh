#!/usr/bin/env bash
# ============================================================
# 云端更新说明
#
# 重要：服务器无法访问 GitHub（网络策略），所以更新不再从云端 git pull。
#
# 正确做法（在你自己的电脑上执行）：
#   powershell -ExecutionPolicy Bypass -File deploy\cloud\deploy.ps1
#
# 它会：
#   1. 检查未提交改动（默认拒绝部署，可 -AllowDirty）
#   2. git archive 打包当前提交（只含被跟踪的文件）
#   3. scp 上传到服务器，解包到 /opt/dafeiyu-room（保留 state/ config/ node_modules/）
#   4. 依赖有变化才 npm ci，然后重启服务并自检
#
# 本脚本仅保留为「服务器上手动重放」的入口。
# ============================================================
set -euo pipefail

TAR="${1:-/root/deploy-incoming.tar}"
if [ -f "$TAR" ]; then
  echo "用法：deploy.ps1 在本地执行；这里可以手动重放最近一次上传的包"
  echo "  检测到 $TAR，执行 apply-deploy.sh"
  exec bash /usr/local/bin/apply-deploy.sh "$TAR"
fi

cat <<'EOF'
服务器不再从 GitHub 拉代码。

请在本地仓库目录执行：
  powershell -ExecutionPolicy Bypass -File deploy\cloud\deploy.ps1

查看当前线上版本：
  bash /usr/local/bin/check-drift.sh
EOF
