#!/bin/bash
# 给 room_link 加「换走廊壁画」的 LLM 工具：
#   她可以在 QQ 上听主人一句话，把走廊画廊墙的第 N 幅画换成主人发的图。
#
# 依赖 bridge 侧的 /api/room/gallery（已在 src/bridge.js 里实现）：
#   GET  /api/room/gallery        查 4 幅现状
#   POST /api/room/gallery        换一幅（dataUrl / base64 + slot + caption）
#   POST /api/room/gallery/clear  恢复默认
#
# 用法（AstrBot 所在机器，root）：
#   bash room-link-gallery.sh
#   systemctl restart astrbot
#
# 幂等。
set -euo pipefail

PLUGINS=${PLUGINS:-/root/data/plugins}
F="$PLUGINS/astrbot_plugin_room_link/main.py"
PY=${PY:-/opt/astrbot/venv/bin/python}
STAMP=$(date +%Y%m%d-%H%M%S)

[ -f "$F" ] || { echo "找不到 $F"; exit 1; }
if grep -q '_gallery_tool_patch' "$F"; then
  echo "· 已经加过换画工具，跳过"
  exit 0
fi

cp -p "$F" "$F.bak-gallery-$STAMP"
echo "备份: $F.bak-gallery-$STAMP"

python3 - "$F" <<'PY'
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()

# 找到类的结尾前插入：用「最后一个 @filter.」或文件末尾的顶层函数作锚点不太好定位，
# 改成在 _bridge_json 定义之后插入 —— 那里一定能找到，而且在类内部。
anchor = '''    async def _live_context(self, ttl: float = 10.0) -> dict[str, Any] | None:'''
if anchor not in s:
    print('!! 没找到 _live_context 锚点，插件版本可能变了')
    raise SystemExit(2)

addition = '''    # ── _gallery_tool_patch：走廊画廊墙 ────────────────────────────────────
    async def _bridge_post_json(self, path: str, payload: dict[str, Any],
                                timeout: float = 20.0) -> dict[str, Any] | None:
        """POST 到 bridge。换画要传图，超时给得比 GET 长。"""
        headers = {"Content-Type": "application/json"}
        token = self._bridge_token()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as sess:
                async with sess.post(self._bridge_base() + path, headers=headers,
                                     data=json.dumps(payload)) as resp:
                    data = await resp.json()
                    return data if isinstance(data, dict) else None
        except Exception:
            return None

    @filter.llm_tool(name="room_gallery_show")
    async def tool_gallery_show(self, event: AstrMessageEvent) -> str:
        """看走廊画廊墙现在挂了什么（4 幅画）。

        主人问「走廊的画是什么样的」「墙上那几幅画换了吗」时调用。
        """
        data = await self._bridge_json("/api/room/gallery", timeout=6)
        if not data or not data.get("ok"):
            return "看不了走廊的画（房间没连上）"
        slots = data.get("slots") or []
        if not slots:
            return "画廊墙上没有画"
        lines = []
        for it in slots:
            n = it.get("slot")
            if it.get("custom"):
                cap = it.get("caption") or "换过的画"
                by = it.get("by") or "谁"
                lines.append(f"第{n}幅：{cap}（{by}换的）")
            else:
                lines.append(f"第{n}幅：原来那张")
        return "走廊画廊墙：" + "；".join(lines)

    @filter.llm_tool(name="room_gallery_set")
    async def tool_gallery_set(self, event: AstrMessageEvent, slot: int,
                               image_url: str = "", image_base64: str = "",
                               caption: str = "") -> str:
        """把走廊画廊墙的某一幅换成一张新画。

        主人发图给你、说「把走廊第 N 幅换成这个」时调用。
        图片要么给 image_url（http 直链），要么给 image_base64（data URL 或纯 base64）。

        Args:
            slot (number): 换第几幅，1~4
            image_url (string): 图片直链（可留空）
            image_base64 (string): 图片 base64 或 data URL（可留空）
            caption (string): 这幅画画的是什么，一句话，方便以后你记得
        """
        if not image_url and not image_base64:
            return "✗ 没有图片：要么给我直链，要么给 base64"
        b64 = image_base64
        mime = ""
        # 给了直链就先下载（限制 4MB）
        if not b64 and image_url:
            try:
                async with aiohttp.ClientSession(
                    timeout=aiohttp.ClientTimeout(total=30)
                ) as sess:
                    async with sess.get(image_url) as resp:
                        if resp.status != 200:
                            return f"✗ 图片下载失败（HTTP {resp.status}）"
                        mime = str(resp.headers.get("Content-Type") or "").split(";")[0].strip()
                        raw = await resp.content.read(4 * 1024 * 1024 + 1)
                        if len(raw) > 4 * 1024 * 1024:
                            return "✗ 图片太大（超过 4MB）"
                        import base64 as _b64
                        b64 = _b64.b64encode(raw).decode("ascii")
            except Exception as exc:  # noqa: BLE001
                return f"✗ 图片下载失败：{exc}"
        payload = {
            "slot": int(slot),
            "caption": str(caption or "")[:60],
            "by": "主人",
        }
        if b64.startswith("data:"):
            payload["dataUrl"] = b64
        else:
            payload["base64"] = b64
            if mime:
                payload["mime"] = mime
        data = await self._bridge_post_json("/api/room/gallery", payload, timeout=30)
        if not data:
            return "✗ 换画没成功（房间没回应）"
        if not data.get("ok"):
            return f"✗ {data.get('error') or '换画失败'}"
        got = None
        for it in data.get("slots") or []:
            if int(it.get("slot") or 0) == int(slot):
                got = it
                break
        if got and got.get("custom"):
            cap = got.get("caption") or caption or "新的一张"
            return f"✓ 走廊第 {slot} 幅换成了「{cap}」"
        return f"✓ 换过了，但没在清单里看到第 {slot} 幅"

    @filter.llm_tool(name="room_gallery_clear")
    async def tool_gallery_clear(self, event: AstrMessageEvent, slot: int) -> str:
        """把走廊画廊墙的某一幅恢复成原来那张（撤掉换过的画）。

        Args:
            slot (number): 哪一幅，1~4
        """
        data = await self._bridge_post_json("/api/room/gallery/clear", {"slot": int(slot)}, timeout=10)
        if not data or not data.get("ok"):
            return f"✗ 恢复失败：{(data or {}).get('error') or '房间没回应'}"
        if data.get("cleared"):
            return f"✓ 走廊第 {slot} 幅换回原来那张了"
        return f"第 {slot} 幅本来就是原来那张"

'''

s = s.replace(anchor, addition + anchor, 1)
open(p, 'w', encoding='utf-8').write(s)
print('· 加了 3 个工具：room_gallery_show / room_gallery_set / room_gallery_clear')
PY

echo "=== 检查 json 是否已 import ==="
grep -n '^import json\|^import aiohttp\|import json$' "$F" | head -3

"$PY" -m py_compile "$F" && echo "syntax OK"
echo
echo "完成。执行：systemctl restart astrbot"