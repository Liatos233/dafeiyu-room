#!/usr/bin/env bash
# 服务器端部署落地：解包代码 tar（不含 assets），可选解包资产增量 tar，
# 更新资产清单，清理已删除的资产，保留 state/config/node_modules。
# 用法：apply-deploy.sh <code.tar> <manifest.json> <dist.tar> [assets.tar] [commit] [stale.txt]
set -euo pipefail

CODE_TAR="${1:-/root/deploy-incoming-code.tar}"
MANIFEST="${2:-/root/deploy-incoming-manifest.json}"
DIST_TAR="${3:-/root/deploy-incoming-dist.tar}"
ASSET_TAR="${4:-}"           # 空 = 无资产变更
COMMIT="${5:-}"
STALE_LIST="${6:-}"          # 每行一个相对 assets 的路径，空/不存在 = 不用删
APP="${APP_DIR:-/opt/dafeiyu-room}"

[ -f "$CODE_TAR" ] || { echo "找不到代码包 $CODE_TAR" >&2; exit 1; }

cd "$APP"
PREV_LOCK=$(md5sum package-lock.json 2>/dev/null | cut -d' ' -f1 || echo none)

echo "==> 停止服务"
systemctl stop dafeiyu-room || true

echo "==> 解包代码"
tar -xf "$CODE_TAR" -C "$APP"

if [ -f "$DIST_TAR" ]; then
  echo "==> 解包前端构建产物"
  rm -rf "$APP/dist/room"
  mkdir -p "$APP/dist/room"
  tar -xf "$DIST_TAR" -C "$APP/dist/room"
fi

if [ -n "$ASSET_TAR" ] && [ -f "$ASSET_TAR" ]; then
  echo "==> 解包资产（git archive，路径含 public/room/assets/ 前缀）"
  tar -xf "$ASSET_TAR" -C "$APP"
fi

# 清理已删除的资产。增量解包是覆盖式的（tar -xf 只写不删），
# 本地删掉的素材如果不清理，会一直占盘、也会让下次判断"服务器已有"而出错。
if [ -n "$STALE_LIST" ] && [ -s "$STALE_LIST" ]; then
  REMOVED=0
  while IFS= read -r rel || [ -n "$rel" ]; do
    rel=$(printf '%s' "$rel" | tr -d '\r' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [ -z "$rel" ] && continue
    # 只允许动 assets 目录内的相对路径，挡住 ../ 之类的穿越
    case "$rel" in
      *..*) echo "   跳过可疑路径 $rel" >&2; continue ;;
    esac
    target="$APP/public/room/assets/$rel"
    if [ -f "$target" ]; then
      rm -f "$target"
      REMOVED=$((REMOVED + 1))
    fi
  done < "$STALE_LIST"
  echo "==> 清理已删除资产 $REMOVED 个"
fi

if [ -f "$MANIFEST" ]; then
  cp "$MANIFEST" "$APP/assets-manifest.json"
fi

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
