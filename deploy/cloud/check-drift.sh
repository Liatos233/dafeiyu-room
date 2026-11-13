#!/usr/bin/env bash
# 查看云端当前部署的是哪个版本（不联网，不访问 GitHub）
set -euo pipefail
APP_DIR="${1:-${APP_DIR:-/opt/dafeiyu-room}}"
cd "$APP_DIR"

echo "部署版本: $(cat .deployed-commit 2>/dev/null || echo '未知（还没用 deploy.ps1 部署过）')"
echo "部署时间: $(cat .deployed-at 2>/dev/null || echo '未知')"

if [ -d .git ]; then
  echo "--- 部署后仍有改动的文件（可能是热修）---"
  git status --short | head -n 20 || true
fi

echo "--- 服务 ---"
systemctl is-active dafeiyu-room || true
curl -s -m 6 -o /dev/null -w "room: %{http_code}\n" -H "Host: 127.0.0.1:3101" http://127.0.0.1:3101/room/ || true
