#!/usr/bin/env bash
# 基础环境：Node 24、4G swap、ufw、常用工具（Ubuntu 24.04）
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
NODE_VER="${NODE_VER:-24.21.0}"
NODE_MIRROR="${NODE_MIRROR:-https://npmmirror.com/mirrors/node}"

echo "==> 时区"
timedatectl set-timezone Asia/Shanghai || true

echo "==> apt 基础包"
apt-get update -y
apt-get install -y curl ca-certificates gnupg git unzip xz-utils zstd sqlite3 ufw htop rsync jq

echo "==> 4G swap"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 4G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=4096 status=none
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -w vm.swappiness=20 >/dev/null
grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=20' >> /etc/sysctl.conf

echo "==> Node.js $NODE_VER"
if ! command -v node >/dev/null || [ "$(node -v | sed 's/^v//' | cut -d. -f1)" -lt 22 ]; then
  tmpdir=$(mktemp -d)
  tarball="node-v$NODE_VER-linux-x64.tar.xz"
  if curl -fsSL --retry 3 -o "$tmpdir/$tarball" "$NODE_MIRROR/v$NODE_VER/$tarball"; then
    tar -xJf "$tmpdir/$tarball" -C /usr/local --strip-components=1
    ln -sf /usr/local/bin/node /usr/bin/node
    ln -sf /usr/local/bin/npm /usr/bin/npm
    ln -sf /usr/local/bin/npx /usr/bin/npx
  else
    echo "!! 镜像失败，改用 NodeSource" >&2
    mkdir -p /etc/apt/keyrings
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
    apt-get update -y && apt-get install -y nodejs
  fi
  rm -rf "$tmpdir"
fi

echo "==> Python"
apt-get install -y python3 python3-venv python3-pip python3-dev build-essential

echo "==> 防火墙（云安全组仍需单独放行 22/3100）"
ufw allow 22/tcp
ufw allow 3100/tcp
ufw --force enable || true

node -v
free -h | head -n 3
