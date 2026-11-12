#!/usr/bin/env bash
# 在云端打包 AstrBot 全量状态（配置 + 记忆 + 插件数据 + 核心库）
# 用法：bash pack-astrbot-state.sh [/root/astrbot-full-state.tar.gz]
set -euo pipefail

DATA=/root/data
OUT="${1:-/root/astrbot-full-state.tar.gz}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# snowluma 是 QQ 客户端安装目录，与机器绑定，不打包
SKIP_PLUGIN_DATA="pulids_snowluma_go_to_astrbot"

cd "$DATA"

echo "==> plugin_data"
mkdir -p "$WORK/plugin_data"
for d in plugin_data/*/; do
  name=$(basename "$d")
  [ "$name" = "$SKIP_PLUGIN_DATA" ] && continue
  cp -a "$d" "$WORK/plugin_data/$name"
done

echo "==> config"
[ -d config ] && cp -a config "$WORK/config"

echo "==> 核心文件"
for f in cmd_config.json plugins.json mcp_server.json data_v4.db; do
  [ -e "$f" ] && cp -a "$f" "$WORK/$f" || true
done

# sqlite 一致性：用 sqlite3 .backup 覆盖副本
if command -v sqlite3 >/dev/null && [ -f "$DATA/data_v4.db" ]; then
  rm -f "$WORK/data_v4.db"
  sqlite3 "$DATA/data_v4.db" ".backup '$WORK/data_v4.db'"
fi

echo "==> 压缩"
tar -czf "$OUT" -C "$WORK" .
echo "完成：$OUT ($(du -h "$OUT" | cut -f1))"
