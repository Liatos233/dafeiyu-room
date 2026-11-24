#!/bin/bash
# 修「发 JPG 说格式不支持」。
#
# 现象：
#   Agent 使用工具: ['room_gallery_set']
#   参数: {'slot': 4, 'image_base64': '/root/data/temp/media_image_20261124195840133_c543.jpg'}
#   Result: ✗ 不支持的图片格式：未知
#
# 根因：AstrBot 把用户发的图存成临时文件（/root/data/temp/media_image_*.jpg），
# 模型看到这条路径就把它当成 image_base64 传进来了。工具当时只处理
# 「base64 / data URL / http 直链」三种，路径这种既不是 base64 也不是 URL，
# 被原样 POST 给 bridge，base64 解码得到垃圾字节，mime 为空 → 「不支持的图片格式」。
#
# 改法：
#   1. image_base64 参数如果看起来是**本地文件路径**（以 / 开头且文件存在），
#      就读文件、按扩展名定 mime、转 base64
#   2. 顺手把「看不清 mime」的情况按文件头（magic bytes）兜底判断，
#      JPEG(FFD8FF) / PNG(89504E47) / GIF(474946) / WEBP(RIFF....WEBP)
#   3. 参数说明里明确写「也可以直接给本地文件路径」
#
# 用法（AstrBot 所在机器，root）：
#   bash room-link-gallery-path.sh
#   systemctl restart astrbot
#
# 幂等。
set -euo pipefail

PLUGINS=${PLUGINS:-/root/data/plugins}
F="$PLUGINS/astrbot_plugin_room_link/main.py"
PY=${PY:-/opt/astrbot/venv/bin/python}
STAMP=$(date +%Y%m%d-%H%M%S)

[ -f "$F" ] || { echo "找不到 $F"; exit 1; }
if grep -q '_gallery_path_patch' "$F"; then
  echo "· 已经支持路径，跳过"
  exit 0
fi

cp -p "$F" "$F.bak-galpath-$STAMP"
echo "备份: $F.bak-galpath-$STAMP"

python3 - "$F" <<'PY'
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()

# ── 1. 参数说明补「可以给本地路径」 ─────────────────────────────────────
old_doc = '''        主人发图给你、说「把走廊第 N 幅换成这个」时调用。
        图片要么给 image_url（http 直链），要么给 image_base64（data URL 或纯 base64）。

        Args:
            slot (number): 换第几幅，1~4
            image_url (string): 图片直链（可留空）
            image_base64 (string): 图片 base64 或 data URL（可留空）
            caption (string): 这幅画画的是什么，一句话，方便以后你记得
        """'''
new_doc = '''        主人发图给你、说「把走廊第 N 幅换成这个」时调用。

        图片来源三选一（哪个方便给哪个）：
          · 主人发来的图落在了服务器临时文件里 → 直接把**文件路径**给 image_base64
            （例如 /root/data/temp/media_image_xxx.jpg）
          · 给了 http 直链 → 给 image_url
          · 本来就是 base64 或 data:image/... → 给 image_base64

        Args:
            slot (number): 换第几幅，1~4
            image_url (string): 图片直链（可留空）
            image_base64 (string): 本地文件路径 / 纯 base64 / data URL（可留空）
            caption (string): 这幅画画的是什么，一句话，方便以后你记得
        """'''
if old_doc in s:
    s = s.replace(old_doc, new_doc, 1)
    print('· 参数说明已补「可给本地路径」')
else:
    print('! 没找到参数说明块')

# ── 2. 插入「路径 → 文件字节」与 magic bytes 兜底 ──────────────────────
anchor = '''        if not image_url and not image_base64:
            return "✗ 没有图片：要么给我直链，要么给 base64"
        b64 = image_base64
        mime = ""'''

insert = '''        if not image_url and not image_base64:
            return "✗ 没有图片：要么给我直链，要么给文件路径/base64"

        # _gallery_path_patch：模型常把「主人发来的图」当成路径塞进 image_base64
        # （AstrBot 把 QQ 图片落在 /root/data/temp/media_image_*.jpg）。
        # 这种既不是 base64 也不是 URL，原样送去会 base64 解码失败 → 「格式未知」。
        import base64 as _b64mod
        import os as _os
        import re as _re

        def _magic_mime(raw: bytes) -> str:
            """按文件头认格式，认不出返回空。"""
            if raw[:3] == b"\\xff\\xd8\\xff":
                return "image/jpeg"
            if raw[:8] == b"\\x89PNG\\r\\n\\x1a\\n":
                return "image/png"
            if raw[:6] in (b"GIF87a", b"GIF89a"):
                return "image/gif"
            if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
                return "image/webp"
            return ""

        _EXT_MIME = {
            ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".jpe": "image/jpeg",
            ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif",
        }

        b64 = str(image_base64 or "").strip()
        mime = ""

        # 情况 A：看起来是本地文件路径 → 读文件转 base64
        _path_candidate = ""
        if b64 and not b64.startswith("data:") and "/" in b64 and "\\n" not in b64:
            # 绝对路径，或明确像文件（带图片扩展名且路径存在）
            if b64.startswith("/") or (_os.path.exists(b64) and _re.search(r"\\.(jpe?g|png|webp|gif)$", b64, _re.I)):
                _path_candidate = b64
        if _path_candidate:
            if not _os.path.isfile(_path_candidate):
                return f"✗ 找不到那个图片文件：{_path_candidate}"
            _size = _os.path.getsize(_path_candidate)
            if _size > 4 * 1024 * 1024:
                return f"✗ 图片太大（{_size / 1024 / 1024:.1f}MB，上限 4MB）"
            try:
                with open(_path_candidate, "rb") as _fh:
                    _raw = _fh.read()
            except Exception as exc:  # noqa: BLE001
                return f"✗ 读图片文件失败：{exc}"
            _ext = _os.path.splitext(_path_candidate)[1].lower()
            mime = _EXT_MIME.get(_ext) or _magic_mime(_raw) or ""
            if not mime:
                return f"✗ 认不出这个文件的图片格式（扩展名 {_ext or '无'}）"
            b64 = _b64mod.b64encode(_raw).decode("ascii")
            import logging as _lg
            _lg.getLogger(__name__).info(
                "[room_link] 画廊换画：从本地文件读取 %s（%d 字节，%s）",
                _path_candidate, len(_raw), mime,
            )

        # 情况 B：本来就是 base64，但没声明 mime → 解码前 12 字节判类型
        if b64 and not b64.startswith("data:") and not mime:
            try:
                _head = _b64mod.b64decode(b64[:32] + "=" * (-len(b64[:32]) % 4), validate=False)
                mime = _magic_mime(_head) or ""
            except Exception:  # noqa: BLE001
                mime = ""
            if not mime:
                return (
                    "✗ 认不出图片格式：收到的既不像本地文件路径、也不像有效图片数据。"
                    "请把主人发的图**文件路径**给我，或者给 http 直链"
                )
'''

if anchor in s:
    s = s.replace(anchor, insert, 1)
    print('· 加了路径读取 + magic bytes 兜底')
else:
    print('!! 没找到插入锚点，插件可能改过')
    raise SystemExit(2)

# ── 3. 下面原有的 mime 变量名要能沿用（原代码里 mime = "" 已被上面替换）──
# 原代码在直链分支里会重置 mime；这里不动，直链优先即可。

open(p, 'w', encoding='utf-8').write(s)
PY

"$PY" -m py_compile "$F" && echo "syntax OK"
echo
echo "完成。执行：systemctl restart astrbot"