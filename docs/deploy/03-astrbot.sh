#!/usr/bin/env bash
# 阶段 1：安装 AstrBot + room_link 插件（Ubuntu 24.04，无 Docker 版本）
set -euo pipefail

ASTRBOT_DIR=/opt/astrbot
SVC_USER=astrbot
PORT=6188

echo "==> 运行用户"
id -u "$SVC_USER" >/dev/null 2>&1 || useradd -r -m -d /home/$SVC_USER -s /bin/bash "$SVC_USER"

echo "==> 目录"
mkdir -p "$ASTRBOT_DIR" /home/$SVC_USER/.astrbot
chown -R "$SVC_USER":"$SVC_USER" "$ASTRBOT_DIR" /home/$SVC_USER

echo "==> 虚拟环境"
apt-get install -y python3-venv python3-pip
sudo -u "$SVC_USER" python3 -m venv "$ASTRBOT_DIR/venv"
sudo -u "$SVC_USER" "$ASTRBOT_DIR/venv/bin/pip" install -U pip wheel

echo "==> 安装 AstrBot（PyPI 包名以安装时为准）"
if ! sudo -u "$SVC_USER" "$ASTRBOT_DIR/venv/bin/pip" install astrbot; then
  echo "!! pip 安装失败：请改用官方脚本或 Docker，命令写在 docs/deploy/CLOUD-MIGRATION.md"
  exit 1
fi

echo "==> room_link 插件"
PLUGIN_DIR=/home/$SVC_USER/.astrbot/data/plugins/astrbot_plugin_room_link
mkdir -p "$PLUGIN_DIR"
if [ ! -f "$PLUGIN_DIR/main.py" ]; then
  echo "!! 需要把插件源码放到 $PLUGIN_DIR（从本地 scp 上来）"
fi
chown -R "$SVC_USER":"$SVC_USER" "$PLUGIN_DIR" 2>/dev/null || true

echo "==> systemd 服务"
cat > /etc/systemd/system/astrbot.service <<UNIT
[Unit]
Description=AstrBot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
WorkingDirectory=$ASTRBOT_DIR
ExecStart=$ASTRBOT_DIR/venv/bin/python -m astrbot
Restart=always
RestartSec=5
StandardOutput=append:/var/log/astrbot.log
StandardError=append:/var/log/astrbot.log

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now astrbot
sleep 5
systemctl --no-pager status astrbot | head -n 12

echo "==> 自检（插件 HTTP 由 AstrBot 进程内启动）"
for i in $(seq 1 10); do
  if curl -fsS -m 3 "http://127.0.0.1:$PORT/room/ping" >/dev/null 2>&1; then
    echo "room_link 插件 HTTP OK"
    break
  fi
  sleep 2
done
