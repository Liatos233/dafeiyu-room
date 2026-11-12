#!/usr/bin/env bash
# 每日备份：房间状态 + AstrBot 配置/数据库 + 插件数据
set -euo pipefail

DEST=/var/backups/dafeiyu
KEEP=7
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$DEST"

TAR="$DEST/dafeiyu-$STAMP.tar"
OUT="$TAR.gz"

tar -cf "$TAR" -C /opt/dafeiyu-room state

cd /root/data
ITEMS=()
for item in cmd_config.json data_v4.db plugins.json mcp_server.json config plugin_data; do
  [ -e "$item" ] && ITEMS+=("$item")
done
if [ ${#ITEMS[@]} -gt 0 ]; then
  tar -rf "$TAR" "${ITEMS[@]}"
fi
gzip -f "$TAR"

ls -1t "$DEST"/dafeiyu-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "[$(date '+%F %T')] backup ok: $OUT ($(du -h "$OUT" | cut -f1), $(tar -tzf "$OUT" | wc -l) files)"
