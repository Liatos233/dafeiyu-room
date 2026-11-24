#!/bin/bash
# 修「裸 base64 换画失败」。
#
# 上一版补丁的判断：
#     if b64 and not b64.startswith("data:") and "/" in b64 and "\n" not in b64:
#         if b64.startswith("/") or (_os.path.exists(b64) and ...)
#
# 纯 base64 字符串本身就可能包含 "/"（base64 字符集含 /），所以第一个条件会通过，
# 进到内层 _os.path.exists(b64) —— 对 ~940KB 的字符串 stat(2) 直接抛
# OSError: [Errno 36] File name too long，异常没被捕获，整个工具报错。
#
# 改法：判路径之前先卡长度（真实路径不会超过 400 字符），并把 exists 包进 try。
#
# 用法：bash room-link-gallery-b64.sh && systemctl restart astrbot
# 幂等。
set -euo pipefail

PLUGINS=${PLUGINS:-/root/data/plugins}
F="$PLUGINS/astrbot_plugin_room_link/main.py"
PY=${PY:-/opt/astrbot/venv/bin/python}
STAMP=$(date +%Y%m%d-%H%M%S)

[ -f "$F" ] || { echo "找不到 $F"; exit 1; }
if grep -q 'len(b64) <= 400' "$F"; then
  echo "· 已经修过，跳过"
  exit 0
fi

cp -p "$F" "$F.bak-galb64-$STAMP"
echo "备份: $F.bak-galb64-$STAMP"

python3 - "$F" <<'PY'
import io
import re
import sys

p = sys.argv[1]
lines = io.open(p, encoding='utf-8').read().split('\n')
out = []
patched = False
i = 0
while i < len(lines):
    line = lines[i]
    # 定位那行 `if b64 and not b64.startswith("data:") and "/" in b64`
    if (not patched) and 'not b64.startswith("data:")' in line and '"/" in b64' in line:
        indent = line[:len(line) - len(line.lstrip())]
        # 输出新的长度保护判断
        out.append(f'{indent}# 真实文件路径不会超过 400 字符。必须先卡长度再调 exists ——')
        out.append(f'{indent}# 纯 base64 也可能含 "/"，对近 1MB 的字符串 stat() 会抛')
        out.append(f'{indent}# ENAMETOOLONG，整个工具就崩了。')
        out.append(f'{indent}if b64 and len(b64) <= 400 and not b64.startswith("data:") and "/" in b64 and "\\n" not in b64:')
        # 跳过原来那行
        i += 1
        # 可选：跳过紧跟的注释行
        while i < len(lines) and lines[i].strip().startswith('#'):
            i += 1
        # 找并替换内层 if（缩进多一级）
        if i < len(lines) and 'b64.startswith("/")' in lines[i]:
            inner = lines[i][:len(lines[i]) - len(lines[i].lstrip())]
            body_indent = inner + '    '
            out.append(f'{inner}_looks_like_file = b64.startswith("/")')
            out.append(f'{inner}if not _looks_like_file:')
            out.append(f'{body_indent}try:')
            out.append(f'{body_indent}    _looks_like_file = bool(')
            out.append(f'{body_indent}        _os.path.exists(b64)')
            out.append(f'{body_indent}        and _re.search(r"\\.(jpe?g|png|webp|gif)$", b64, _re.I)')
            out.append(f'{body_indent}    )')
            out.append(f'{body_indent}except (OSError, ValueError):')
            out.append(f'{body_indent}    _looks_like_file = False')
            out.append(f'{inner}if _looks_like_file:')
            out.append(f'{body_indent}_path_candidate = b64')
            i += 1
            patched = True
            continue
        continue
    out.append(line)
    i += 1

if not patched:
    print('!! 没找到待修片段')
    raise SystemExit(2)

io.open(p, 'w', encoding='utf-8').write('\n'.join(out))
print('· 路径判断加了长度保护 + 异常兜底')
PY

"$PY" -m py_compile "$F" && echo "syntax OK"
echo
echo "完成。执行：systemctl restart astrbot"