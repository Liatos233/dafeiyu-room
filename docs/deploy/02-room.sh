#!/usr/bin/env bash
# 阶段 3：部署 dafeiyu-room（Node bridge + 3D 房间）
# 在服务器上执行，前提：/opt/dafeiyu-room 已放好代码（git archive 或 rsync）
set -euo pipefail

APP_DIR=/opt/dafeiyu-room
SVC_USER=dafeiyu
PORT=3100

echo "==> 运行用户"
id -u "$SVC_USER" >/dev/null 2>&1 || useradd -r -m -d /home/$SVC_USER -s /bin/bash "$SVC_USER"

echo "==> 目录与权限"
mkdir -p "$APP_DIR" /var/lib/dafeiyu-room
chown -R "$SVC_USER":"$SVC_USER" "$APP_DIR" /var/lib/dafeiyu-room

cd "$APP_DIR"
if [ ! -f package.json ]; then
  echo "!! $APP_DIR 里没有 package.json，请先把代码放进去" >&2
  exit 1
fi

echo "==> 安装依赖（跳过可选）"
sudo -u "$SVC_USER" npm ci --omit=dev --no-audit --no-fund || sudo -u "$SVC_USER" npm install --omit=dev --no-audit --no-fund

echo "==> 配置"
if [ ! -f config.json ]; then
  cp config.example.json config.json
  chown "$SVC_USER":"$SVC_USER" config.json
  echo "!! 已生成 config.json，需要填写：ownerQQ / allow / dsh.baseUrl / room.access=token"
fi
mkdir -p state && chown -R "$SVC_USER":"$SVC_USER" state

echo "==> systemd 服务"
cat > /etc/systemd/system/dafeiyu-room.service <<'UNIT'
[Unit]
Description=dafeiyu-room bridge (QQ <-> DSH <-> 3D room)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=dafeiyu
WorkingDirectory=/opt/dafeiyu-room
Environment=NODE_ENV=production
ExecStart=/usr/bin/node src/bridge.js
Restart=always
RestartSec=5
LimitNOFILE=65535
StandardOutput=append:/var/log/dafeiyu-room.log
StandardError=append:/var/log/dafeiyu-room.log

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now dafeiyu-room
sleep 3
systemctl --no-pager status dafeiyu-room | head -n 12

echo "==> 自检"
curl -fsS -m 5 "http://127.0.0.1:$PORT/api/home/state" -o /dev/null && echo "API OK" || echo "API 未就绪（看 /var/log/dafeiyu-room.log）"
