#!/usr/bin/env bash
# 在云端把 AstrBot 全量状态包覆盖回去（配置 + 记忆 + 插件数据 + 核心库）
# 用法：bash restore-astrbot-state.sh /root/astrbot-full-state.tar.gz
set -euo pipefail

TAR="${1:?用法: bash restore-astrbot-state.sh <state.tar.gz>}"
DATA=/root/data
[ -f "$TAR" ] || { echo "找不到 $TAR" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
tar -xzf "$TAR" -C "$WORK"

echo "==> 停止 AstrBot"
systemctl stop astrbot || true

echo "==> 恢复插件数据（整目录替换，避免残留旧文件）"
if [ -d "$WORK/plugin_data" ]; then
  for d in "$WORK"/plugin_data/*/; do
    name=$(basename "$d")
    # snowluma 不覆盖（机器绑定）
    [ "$name" = "pulids_snowluma_go_to_astrbot" ] && continue
    rm -rf "$DATA/plugin_data/$name"
    cp -a "$d" "$DATA/plugin_data/$name"
    echo "   * $name"
  done
fi

echo "==> 恢复插件配置"
if [ -d "$WORK/config" ]; then
  mkdir -p "$DATA/config"
  cp -a "$WORK/config/." "$DATA/config/"
  echo "   $(ls "$WORK/config" | wc -l) 个配置"
fi

echo "==> 恢复核心文件"
for f in cmd_config.json plugins.json mcp_server.json data_v4.db; do
  if [ -f "$WORK/$f" ]; then
    cp -a "$WORK/$f" "$DATA/$f"
    echo "   * $f"
  fi
done
rm -f "$DATA/data_v4.db-wal" "$DATA/data_v4.db-shm"

echo "==> 启动 AstrBot"
systemctl start astrbot
sleep 25
systemctl is-active astrbot || { journalctl -u astrbot -n 40 --no-pager; exit 1; }

echo "==> 自检"
curl -s -m 5 http://127.0.0.1:6188/room/ping || echo "   room_link 未就绪"
echo
grep -a "livingmemory" /root/data/logs/astrbot-stdout.log | tail -n 3 || true
