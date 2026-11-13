#!/usr/bin/env bash
# 服务器端部署落地：解包本地推上来的 tar（只含 git 跟踪文件），保留 state/config/node_modules
set -euo pipefail

TAR="${1:-/root/deploy-incoming.tar}"
COMMIT="${2:-}"
APP="${APP_DIR:-/opt/dafeiyu-room}"
[ -f "$TAR" ] || { echo "找不到 $TAR" >&2; exit 1; }

cd "$APP"
PREV_LOCK=$(md5sum package-lock.json 2>/dev/null | cut -d' ' -f1 || echo none)

echo "==> 停止服务"
systemctl stop dafeiyu-room || true

echo "==> 解包"
tar -xf "$TAR" -C "$APP"

NEW_LOCK=$(md5sum package-lock.json 2>/dev/null | cut -d' ' -f1 || echo none)
if [ "$PREV_LOCK" != "$NEW_LOCK" ]; then
  echo "==> 依赖有变化，npm ci"
  npm ci --omit=dev --no-audit --no-fund
else
  echo "==> 依赖未变，跳过 npm ci"
fi

date '+%F %T' > "$APP/.deployed-at"
if [ -n "$COMMIT" ]; then
  echo "$COMMIT" > "$APP/.deployed-commit"
else
  git rev-parse --short HEAD > "$APP/.deployed-commit" 2>/dev/null || \
    echo "local-$(date +%Y%m%d-%H%M)" > "$APP/.deployed-commit"
fi

echo "==> 启动"
systemctl start dafeiyu-room
sleep 4
systemctl is-active dafeiyu-room
curl -s -m 6 -o /dev/null -w "room: %{http_code}\n" -H "Host: 127.0.0.1:3101" http://127.0.0.1:3101/room/ || true
echo "部署标记: $(cat "$APP/.deployed-commit") @ $(cat "$APP/.deployed-at")"
