#!/usr/bin/env bash
# ============================================================
# dafeiyu-room 云服务器一键部署
# 用法（Ubuntu 24.04，root）：
#   bash install.sh                  # 只装房间 + nginx + 备份
#   bash install.sh --with-astrbot   # 额外装 AstrBot + 两个插件
#   REPO=git@github.com:you/repo.git bash install.sh
# ============================================================
set -euo pipefail

REPO="${REPO:-https://github.com/Liatos233/dafeiyu-room.git}"
APP_DIR="${APP_DIR:-/opt/dafeiyu-room}"
PUBLIC_HOST="${PUBLIC_HOST:-$(curl -s -m 5 ifconfig.me || echo 127.0.0.1)}"
WITH_ASTRBOT=0
for arg in "$@"; do
  case "$arg" in
    --with-astrbot) WITH_ASTRBOT=1 ;;
  esac
done

log() { echo -e "\n\033[1;36m==> $*\033[0m"; }

log "1/8 基础环境（Node 24 / swap / ufw / git）"
bash "$(dirname "$0")/10-bootstrap.sh"

log "2/8 拉取代码到 $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --depth=1 origin main
  git -C "$APP_DIR" reset --hard origin/main
else
  # 非 git 目录（例如手工上传的）：先保住 state/ 和 config.json，再重建
  KEEP=""
  if [ -d "$APP_DIR" ]; then
    KEEP=$(mktemp -d)
    [ -d "$APP_DIR/state" ] && cp -a "$APP_DIR/state" "$KEEP/" || true
    [ -f "$APP_DIR/config.json" ] && cp -a "$APP_DIR/config.json" "$KEEP/" || true
    echo "   已暂存 $(du -sh "$KEEP" | cut -f1) 的本地数据"
    rm -rf "$APP_DIR"
  fi
  git clone --depth=1 "$REPO" "$APP_DIR"
  if [ -n "$KEEP" ]; then
    [ -d "$KEEP/state" ] && cp -a "$KEEP/state" "$APP_DIR/" || true
    [ -f "$KEEP/config.json" ] && cp -a "$KEEP/config.json" "$APP_DIR/" || true
    rm -rf "$KEEP"
    echo "   state/ 与 config.json 已还原"
  fi
fi

log "3/8 安装依赖"
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund

log "4/8 生成配置（首次）"
if [ ! -f config.json ]; then
  cp config.example.json config.json
  python3 - "$PUBLIC_HOST" <<'PY'
import json, sys
host = sys.argv[1]
p = "config.json"
c = json.load(open(p, encoding="utf-8-sig"))
c["consolePort"] = 3101
c.setdefault("room", {})["access"] = "loopback"
c["room"]["allowedHosts"] = [f"{host}:3100"]
c.setdefault("astrbot", {})["baseUrl"] = "http://127.0.0.1:6188"
c.setdefault("snowluma", {})["wsUrl"] = ""
c["snowluma"]["httpUrl"] = ""
json.dump(c, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("config.json 已生成：allowedHosts =", c["room"]["allowedHosts"])
PY
  echo "!! 请填写 ownerQQ / allow.private / allow.groups 后再继续"
fi
mkdir -p state

log "5/8 房间 systemd 服务"
install -m 644 "$(dirname "$0")/units/dafeiyu-room.service" /etc/systemd/system/dafeiyu-room.service
systemctl daemon-reload
systemctl enable --now dafeiyu-room

log "6/8 nginx 反代（3100 → 3101）"
DEBIAN_FRONTEND=noninteractive apt-get install -y nginx >/dev/null
install -m 644 "$(dirname "$0")/nginx-room.conf" /etc/nginx/sites-available/dafeiyu-room
ln -sf /etc/nginx/sites-available/dafeiyu-room /etc/nginx/sites-enabled/dafeiyu-room
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable --now nginx
systemctl restart nginx

log "7/8 每日备份"
install -m 755 "$(dirname "$0")/backup.sh" /usr/local/bin/dafeiyu-backup.sh
install -m 644 "$(dirname "$0")/units/dafeiyu-backup.service" /etc/systemd/system/dafeiyu-backup.service
install -m 644 "$(dirname "$0")/units/dafeiyu-backup.timer" /etc/systemd/system/dafeiyu-backup.timer
systemctl daemon-reload
systemctl enable --now dafeiyu-backup.timer
bash /usr/local/bin/dafeiyu-backup.sh || true

if [ "$WITH_ASTRBOT" = "1" ]; then
  log "8/8 AstrBot + 插件"
  bash "$(dirname "$0")/20-astrbot.sh"
else
  log "8/8 跳过 AstrBot（需要时加 --with-astrbot 重跑）"
fi

log "完成"
cat <<EOF
房间地址： http://$PUBLIC_HOST:3100/room/
bridge：   systemctl status dafeiyu-room
备份：     /var/backups/dafeiyu（每日 04:00）
AstrBot：  $( [ "$WITH_ASTRBOT" = "1" ] && echo "systemctl status astrbot；面板 127.0.0.1:6185" || echo "未安装" )
EOF
