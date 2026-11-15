#!/usr/bin/env bash
# 查看云端当前部署的是哪个版本（不联网，不访问 GitHub）
set -euo pipefail
APP_DIR="${1:-${APP_DIR:-/opt/dafeiyu-room}}"
cd "$APP_DIR"

echo "部署版本: $(cat .deployed-commit 2>/dev/null || echo '未知（还没用 deploy.ps1 部署过）')"
echo "部署时间: $(cat .deployed-at 2>/dev/null || echo '未知')"

if [ -d .git ]; then
  echo "--- 部署后仍有改动的文件（可能是热修）---"
  git status --short | head -n 20 || true
fi

echo "--- 资产清单 ---"
if [ -f assets-manifest.json ]; then
  python3 - "$APP_DIR" <<'PY'
import json, hashlib, os, sys
app = sys.argv[1]
try:
    m = json.load(open(os.path.join(app, "assets-manifest.json"), encoding="utf-8"))
except Exception as e:
    print("  资产清单不可读:", e); sys.exit(0)
print("  资产文件数:", len(m))
bad = 0
for rel, h in list(m.items())[:5]:
    p = os.path.join(app, "public", "room", "assets", rel)
    if not os.path.exists(p):
        print(f"  缺失: {rel}"); bad += 1; continue
    got = hashlib.sha256(open(p, "rb").read()).hexdigest()
    if got != h:
        print(f"  哈希不符: {rel}"); bad += 1
print("  资产清单校验:", "OK（抽查前 5 个）" if bad == 0 else f"{bad} 个不一致")
PY
else
  echo "  无资产清单（尚未用新版 deploy.ps1 部署过）"
fi

echo "--- 服务 ---"
systemctl is-active dafeiyu-room || true
curl -s -m 6 -o /dev/null -w "room: %{http_code}\n" -H "Host: 127.0.0.1:3101" http://127.0.0.1:3101/room/ || true
