#!/usr/bin/env bash
# 检查云端代码是否与 GitHub main 一致（有没有被手工 scp 改漂移）
# 用法：bash check-drift.sh [app_dir]
set -euo pipefail

APP_DIR="${1:-${APP_DIR:-/opt/dafeiyu-room}}"
cd "$APP_DIR"

if [ ! -d .git ]; then
  echo "!! $APP_DIR 不是 git 仓库，无法比对" >&2
  exit 2
fi

BRANCH="${BRANCH:-main}"
git fetch --depth=1 origin "$BRANCH" >/dev/null 2>&1 || {
  echo "!! fetch 失败（网络或权限）" >&2
  exit 2
}

LOCAL=$(git rev-parse --short HEAD)
REMOTE=$(git rev-parse --short "origin/$BRANCH")

echo "本地 HEAD : $LOCAL"
echo "远端 HEAD : $REMOTE"

DIRTY=$(git status --porcelain | wc -l | tr -d ' ')
echo "未提交改动: $DIRTY 个文件"

if [ "$LOCAL" != "$REMOTE" ]; then
  echo "--- 与远端的提交差异 ---"
  git log --oneline "$LOCAL..$REMOTE" | head -n 10 || true
fi

if [ "$DIRTY" -gt 0 ]; then
  echo "--- 有改动的文件（可能是热修未提交）---"
  git status --short | head -n 20
fi

if [ "$LOCAL" = "$REMOTE" ] && [ "$DIRTY" -eq 0 ]; then
  echo "✅ 与远端一致，无漂移"
  exit 0
fi

echo "⚠️ 存在漂移：远端已有新提交，或本地有未提交的热修" >&2
exit 1
