#!/usr/bin/env bash
# ============================================================
# 更新已部署的 dafeiyu-room（保留 state / config）
# 用法：
#   bash update.sh                     # 更新房间（代码 + 依赖 + 重启）
#   bash update.sh --astrbot           # 同时更新 AstrBot 本体
#   bash update.sh --plugins <tar.gz>  # 同时同步 AstrBot 插件包
# ============================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/dafeiyu-room}"
BRANCH="${BRANCH:-main}"
DO_ASTRBOT=0
PLUGIN_TAR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --astrbot) DO_ASTRBOT=1; shift ;;
    --plugins) PLUGIN_TAR="${2:-}"; shift 2 ;;
    *) shift ;;
  esac
done

log() { echo -e "\n\033[1;36m==> $*\033[0m"; }

log "0/5 先备份"
bash /usr/local/bin/dafeiyu-backup.sh || echo "!! 备份失败，继续（请自行确认）"

log "1/5 拉取代码"
cd "$APP_DIR"
if [ -d .git ]; then
  BEFORE=$(git rev-parse --short HEAD)
  git fetch --depth=1 origin "$BRANCH"
  git reset --hard "origin/$BRANCH"
  AFTER=$(git rev-parse --short HEAD)
  echo "   $BEFORE → $AFTER"
else
  echo "!! $APP_DIR 不是 git 仓库；请用 deploy/cloud/install.sh 重新部署，或手动覆盖"
fi

log "2/5 安装依赖"
npm ci --omit=dev --no-audit --no-fund

log "3/5 重启房间服务"
systemctl restart dafeiyu-room
sleep 5
systemctl is-active dafeiyu-room
curl -s -o /dev/null -w "   /api/home/state: %{http_code}\n" -H "Host: 127.0.0.1:3101" http://127.0.0.1:3101/api/home/state || true

if [ "$DO_ASTRBOT" = "1" ]; then
  log "4/5 更新 AstrBot"
  /opt/astrbot/venv/bin/pip install -q -U astrbot -i https://pypi.tuna.tsinghua.edu.cn/simple
  systemctl restart astrbot
  sleep 20
  systemctl is-active astrbot
  curl -s -o /dev/null -w "   room_link: %{http_code}\n" http://127.0.0.1:6188/room/ping || true
else
  log "4/5 跳过 AstrBot 更新"
fi

if [ -n "$PLUGIN_TAR" ]; then
  log "5/5 同步插件：$PLUGIN_TAR"
  bash "$(dirname "$0")/sync-plugins.sh" "$PLUGIN_TAR"
else
  log "5/5 跳过插件同步"
fi

log "完成"
