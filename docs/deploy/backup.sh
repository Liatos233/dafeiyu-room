#!/usr/bin/env bash
# 每日备份：房间状态 + AstrBot 配置/数据库 + 插件数据
# 默认对配置里的 API Key / token / 密码做脱敏（REDACTED），避免备份包外传泄露。
# 需要原始密钥时：KEEP_SECRETS=1 bash dafeiyu-backup.sh
set -euo pipefail

DEST=/var/backups/dafeiyu
KEEP=7
STAMP=$(date +%Y%m%d-%H%M%S)
KEEP_SECRETS="${KEEP_SECRETS:-0}"
# 表情包库图片很大（~900MB），日常备份跳过；需要整包用 FULL=1
FULL="${FULL:-0}"
mkdir -p "$DEST"

TAR="$DEST/dafeiyu-$STAMP.tar"
OUT="$TAR.gz"

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "==> 房间状态"
mkdir -p "$WORK/room"
cp -a /opt/dafeiyu-room/state/. "$WORK/room/" 2>/dev/null || true

echo "==> AstrBot 数据"
mkdir -p "$WORK/astrbot"
for item in cmd_config.json data_v4.db plugins.json mcp_server.json config; do
  [ -e "/root/data/$item" ] && cp -a "/root/data/$item" "$WORK/astrbot/" 2>/dev/null || true
done

# 插件数据：默认跳过表情包图片库（体积大且可重新下载）
mkdir -p "$WORK/astrbot/plugin_data"
for d in /root/data/plugin_data/*/; do
  name=$(basename "$d")
  [ "$name" = "pulids_snowluma_go_to_astrbot" ] && continue   # QQ 客户端安装目录
  if [ "$FULL" != "1" ] && [ "$name" = "meme_manager" ]; then
    echo "   skip meme_manager（FULL=1 可包含）"
    continue
  fi
  cp -a "$d" "$WORK/astrbot/plugin_data/$name" 2>/dev/null || true
done

if [ "$KEEP_SECRETS" != "1" ]; then
  echo "==> 脱敏（API Key / token / 密码 → REDACTED）"
  python3 - "$WORK" <<'PY'
import json, os, re, sys

root = sys.argv[1]
SECRET_KEYS = {
    "key", "keys", "api_key", "apikey", "api_token", "token", "access_token",
    "secret", "client_secret", "password", "passwd", "webui_password",
    "embedding_api_key", "auth_token", "cookie", "session_key",
}
SECRET_SUFFIX = ("_key", "_token", "_secret", "_password")
SK_RE = re.compile(r"^(sk-[A-Za-z0-9_\-]{12,}|AIza[0-9A-Za-z_\-]{20,}|gh[pous]_[A-Za-z0-9]{20,})$")

def redact(obj):
    if isinstance(obj, dict):
        out = {}
        for k, v in obj.items():
            lk = str(k).lower()
            if lk in SECRET_KEYS or lk.endswith(SECRET_SUFFIX):
                if isinstance(v, list):
                    out[k] = ["REDACTED"] if v else v
                elif isinstance(v, str):
                    out[k] = "REDACTED" if v else v
                else:
                    out[k] = v
            else:
                out[k] = redact(v)
        return out
    if isinstance(obj, list):
        return [redact(x) for x in obj]
    if isinstance(obj, str) and SK_RE.match(obj):
        return "REDACTED"
    return obj

n = 0
for base, _dirs, files in os.walk(root):
    for f in files:
        if not f.endswith(".json"):
            continue
        p = os.path.join(base, f)
        try:
            with open(p, encoding="utf-8-sig") as fh:
                data = json.load(fh)
            with open(p, "w", encoding="utf-8") as fh:
                json.dump(redact(data), fh, ensure_ascii=False, indent=2)
            n += 1
        except Exception as e:
            print(f"   skip {f}: {e}")
print(f"   已处理 {n} 个 JSON")
PY
fi

echo "==> 打包"
tar -cf "$TAR" -C "$WORK" room astrbot 2>/dev/null || tar -cf "$TAR" -C "$WORK" .
gzip -f "$TAR"

ls -1t "$DEST"/dafeiyu-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "[$(date '+%F %T')] backup ok: $OUT ($(du -h "$OUT" | cut -f1), $(tar -tzf "$OUT" | wc -l) files)$( [ "$KEEP_SECRETS" = "1" ] && echo ' [含明文密钥]' || echo ' [已脱敏]')"
