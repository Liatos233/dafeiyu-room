#!/usr/bin/env bash
# 在云端用备份恢复（服务器上执行）
# 用法：bash restore-backup.sh [/var/backups/dafeiyu/dafeiyu-xxxx.tar.gz]
set -euo pipefail

TAR="${1:-$(ls -1t /var/backups/dafeiyu/dafeiyu-*.tar.gz 2>/dev/null | head -n 1)}"
[ -f "$TAR" ] || { echo "找不到备份文件: $TAR" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
tar -xzf "$TAR" -C "$WORK"
echo "==> 备份：$TAR"

if [ -d "$WORK/state" ]; then
  systemctl stop dafeiyu-room || true
  mkdir -p /opt/dafeiyu-room/state
  cp -a "$WORK/state/." /opt/dafeiyu-room/state/
  systemctl start dafeiyu-room
  echo "    room state 已恢复"
fi

if [ -d "$WORK/cmd_config.json" ] || [ -f "$WORK/cmd_config.json" ]; then
  systemctl stop astrbot || true
  cp -a "$WORK/cmd_config.json" /root/data/cmd_config.json
  [ -f "$WORK/data_v4.db" ] && cp -a "$WORK/data_v4.db" /root/data/data_v4.db
  [ -d "$WORK/config" ] && cp -a "$WORK/config/." /root/data/config/
  [ -d "$WORK/plugin_data" ] && cp -a "$WORK/plugin_data/." /root/data/plugin_data/
  systemctl start astrbot
  echo "    AstrBot 配置/数据库已恢复"
fi

sleep 5
curl -s -o /dev/null -w "room: %{http_code}\n" http://127.0.0.1:3101/api/home/state || true
curl -s -o /dev/null -w "plugin: %{http_code}\n" http://127.0.0.1:6188/room/ping || true
