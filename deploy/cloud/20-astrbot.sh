#!/usr/bin/env bash
# AstrBot + room_link + Snowluma Go（Ubuntu 24.04）
# 说明：QQ 本体（linuxqq deb）无法脚本直连腾讯 CDN（403），需手动放到 /root/QQ.deb
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

ASTRBOT_DIR=/opt/astrbot
DATA_DIR=/root/data
MIRROR=https://pypi.tuna.tsinghua.edu.cn/simple
HERE="$(cd "$(dirname "$0")" && pwd)"

echo "==> AstrBot venv + pip"
mkdir -p "$ASTRBOT_DIR"
[ -x "$ASTRBOT_DIR/venv/bin/python" ] || python3 -m venv "$ASTRBOT_DIR/venv"
"$ASTRBOT_DIR/venv/bin/pip" install -q -U pip wheel
"$ASTRBOT_DIR/venv/bin/pip" config set global.index-url "$MIRROR" >/dev/null 2>&1 || true
"$ASTRBOT_DIR/venv/bin/pip" install -q astrbot

echo "==> 初始化数据目录"
mkdir -p "$DATA_DIR/logs" "$DATA_DIR/config" "$DATA_DIR/plugins"
cd /root
[ -f "$DATA_DIR/cmd_config.json" ] || "$ASTRBOT_DIR/venv/bin/astrbot" init -y || true

echo "==> 插件"
# room_link：本仓库自带
cp -r "$HERE/../plugins/astrbot_plugin_room_link" "$DATA_DIR/plugins/" 2>/dev/null || true
# Snowluma Go：从上游拉
if [ ! -d "$DATA_DIR/plugins/pulids_snowluma_go_to_astrbot" ]; then
  git clone --depth=1 https://github.com/SATA-F5/Snowluma-Go "$DATA_DIR/plugins/pulids_snowluma_go_to_astrbot" || \
    echo "!! Snowluma-Go 拉取失败，请在面板插件页安装"
fi

# 插件仓库地址修正（上游仓库已迁移）
UTILS="$DATA_DIR/plugins/pulids_snowluma_go_to_astrbot/utils.py"
if [ -f "$UTILS" ]; then
  sed -i "s#repos/SnowLuma/SnowLuma#repos/TomyJan/SnowLuma#; s#https://github.com/SnowLuma/SnowLuma/releases/download#https://github.com/TomyJan/SnowLuma/releases/download#" "$UTILS"
fi

echo "==> room_link 插件配置"
python3 - "$DATA_DIR" <<'PY'
import json, os, sys
d = sys.argv[1]
p = os.path.join(d, "config", "astrbot_plugin_room_link_config.json")
cfg = {}
if os.path.exists(p):
    cfg = json.load(open(p, encoding="utf-8-sig"))
cfg.update({
    "listen_host": "127.0.0.1",
    "listen_port": 6188,
    "bridge_dir": "/opt/dafeiyu-room",
    "bridge_node": "/usr/bin/node",
    "bridge_port": 3101,
    "bridge_auto_start": False,
})
json.dump(cfg, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("room_link bridge_port =", cfg["bridge_port"])
PY

echo "==> 无头依赖（Xvfb / VNC / 截图）"
apt-get install -y xvfb x11vnc x11-utils fluxbox xdotool imagemagick scrot fonts-wqy-microhei >/dev/null
echo "kernel.yama.ptrace_scope=0" > /etc/sysctl.d/99-ptrace.conf
sysctl -w kernel.yama.ptrace_scope=0 >/dev/null

echo "==> QQ 本体"
if [ -x /opt/QQ/qq ]; then
  echo "QQ 已安装：$(dpkg-query -W -f='${Version}' linuxqq 2>/dev/null || echo unknown)"
elif [ -f /root/QQ.deb ]; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y /root/QQ.deb
else
  echo "!! 未检测到 /opt/QQ/qq"
  echo "   请手动下载 LinuxQQ deb 后放到 /root/QQ.deb 再重跑：bash $0"
fi
if [ -x /opt/QQ/qq ]; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y \
    libasound2t64 libgbm1 libnss3 libxss1 libxtst6 libatk1.0-0t64 libatk-bridge2.0-0t64 \
    libcups2t64 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libpango-1.0-0 \
    libcairo2 libatspi2.0-0 libexpat1 libxshmfence1 >/dev/null
fi

echo "==> systemd"
install -m 644 "$HERE/units/astrbot.service" /etc/systemd/system/astrbot.service
systemctl daemon-reload
systemctl enable --now astrbot
sleep 20
systemctl is-active astrbot || { journalctl -u astrbot -n 30 --no-pager; exit 1; }
curl -s -m 5 http://127.0.0.1:6188/room/ping || echo "插件 HTTP 尚未就绪"

cat <<'EOF'

后续（需要人工）：
1. 面板：ssh -L 16185:127.0.0.1:6185 root@<服务器> → http://127.0.0.1:16185
   首次账号见 /root/data/cmd_config.json 或 `astrbot password --username astrbot` 重置
2. 插件页 → Snowluma Go → 安装 → 启动 → 手机 QQ 扫码
3. QQ 登录后插件会自动把 OneBot 反向 WS 指到 AstrBot 6199
EOF
