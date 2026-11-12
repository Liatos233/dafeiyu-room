#!/usr/bin/env bash
# ============================================================
# 同步 AstrBot 插件（从本地打好的 tar.gz）
# 包结构：
#   plugins/<plugin_dir>/...         插件目录
#   config/<name>_config.json        插件配置（可选）
# 用法：
#   bash sync-plugins.sh /root/astrbot-plugins.tar.gz
#   FORCE_CONFIG=0 bash sync-plugins.sh ...   # 不覆盖云端已有配置
# ============================================================
set -euo pipefail

TAR="${1:?用法: bash sync-plugins.sh <plugins.tar.gz>}"
DATA_DIR="${DATA_DIR:-/root/data}"
VENV="${VENV:-/opt/astrbot/venv}"
MIRROR="${MIRROR:-https://pypi.tuna.tsinghua.edu.cn/simple}"
FORCE_CONFIG="${FORCE_CONFIG:-1}"

[ -f "$TAR" ] || { echo "找不到 $TAR" >&2; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
tar -xzf "$TAR" -C "$WORK"

echo "==> 停止 AstrBot"
systemctl stop astrbot || true

if [ -d "$WORK/plugins" ]; then
  echo "==> 安装插件目录"
  for d in "$WORK/plugins"/*/; do
    name=$(basename "$d")
    rm -rf "$DATA_DIR/plugins/$name"
    cp -a "$d" "$DATA_DIR/plugins/$name"
    find "$DATA_DIR/plugins/$name" -name "__pycache__" -type d -prune -exec rm -rf {} + 2>/dev/null || true
    echo "   + $name"
  done
fi

if [ -d "$WORK/config" ]; then
  mkdir -p "$DATA_DIR/config"
  for f in "$WORK/config"/*.json; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    if [ -f "$DATA_DIR/config/$name" ] && [ "$FORCE_CONFIG" != "1" ]; then
      echo "   = $name（已存在，跳过）"
    else
      cp -a "$f" "$DATA_DIR/config/$name"
      echo "   * $name"
    fi
  done
fi

echo "==> 安装插件依赖"
shopt -s nullglob
for req in "$DATA_DIR"/plugins/*/requirements.txt; do
  plugin=$(basename "$(dirname "$req")")
  echo "   - $plugin"
  "$VENV/bin/pip" install -q -r "$req" -i "$MIRROR" 2>&1 | tail -n 2 || echo "     !! $plugin 依赖安装失败（插件可能仍能加载）"
done
shopt -u nullglob

echo "==> 启动 AstrBot"
systemctl start astrbot
sleep 25
systemctl is-active astrbot || { journalctl -u astrbot -n 40 --no-pager; exit 1; }

echo "==> 插件加载结果（日志摘要）"
grep -aiE "plugin|插件" /root/data/logs/astrbot-stdout.log | tail -n 30 \
  | grep -aiE "已加载|loaded|fail|error|Traceback|导入失败" | tail -n 15 || true

echo "==> room_link 自检"
curl -s -m 5 http://127.0.0.1:6188/room/ping || echo "   !! 未就绪"
