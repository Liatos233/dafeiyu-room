#!/bin/bash
# 修「B 站分享卡片解析不了」：卡片只有短链接时，用标题去搜。
#
# 现象：分享一张 B 站卡片给她，她说"短链接我这边认不出来 你给我BV号吧"。
#
# 查清的事实：
#   · 卡片消息是 [ComponentType.Json]，payload 里没有 BV 号，只有
#     "qqdocurl": "https://b23.tv/e1URQfQ"（短链接）+ "desc": 完整视频标题
#   · 服务器展开 b23.tv 一律 HTTP 412（反爬，带 cookie 也一样）
#   · 但拿卡片里的 desc 去 B 站搜索，第一条就精确命中：
#       BV12ysw67EdW  UP=憧錦  「鲸鲸帮你忙活一天累坏了，回头给乖宝宝买大白饭」
#   · qq_tools 其实已经能提取 url（输出 [BILI_CARD ref= p=1 url=https://b23.tv/...]），
#     但没有 title；模型只好自己从短链接里拼了个假的 BV1e1URQfQ
#
# 改两处：
#   1. qq_tools：_parse_bilibili_from_payload 提取 title（卡片 desc），
#      _format_bili_card_block 输出里带 title="..."
#   2. bili_whale：bili_video 的工具在「输入不是标准 BV」时，当成标题走 search，
#      取第一个 BV。这样模型把 title 传进来就能用。
#
# 用法（AstrBot 所在机器，root）：
#   bash bili-card-title-fallback.sh
#   systemctl restart astrbot
#
# 幂等：重复执行不会重复改。
set -euo pipefail

PLUGINS=${PLUGINS:-/root/data/plugins}
QT="$PLUGINS/astrbot_plugin_qq_tools/main.py"
BW="$PLUGINS/astrbot_plugin_bili_whale/main.py"
PY=${PY:-/opt/astrbot/venv/bin/python}
STAMP=$(date +%Y%m%d-%H%M%S)

# ── 1. qq_tools：卡片块带 title ──────────────────────────────────────────
if [ -f "$QT" ]; then
  cp -p "$QT" "$QT.bak-cardtitle-$STAMP"
  python3 - "$QT" <<'PY'
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()

if '_card_title_patch' in s:
    print('· qq_tools 已带 title')
    raise SystemExit

# 1a) 加一个小工具：从 JSON 里递归找卡片标题（优先 desc）
helper = '''
    def _find_card_title(self, obj, depth: int = 0) -> str:
        """_card_title_patch：从卡片 JSON 里递归找标题。

        B站分享卡片的标题在 meta.detail_1.desc；title 字段往往是"哔哩哔哩"（app 名），
        所以优先 desc。只在 4~150 字之间才认，避免抓到 appicon 之类的短串。
        用途：卡片只有 b23.tv 短链接时，靠它去 B站搜索反查 BV。
        """
        if depth > 15:
            return ""
        if isinstance(obj, dict):
            for k in ("desc", "title"):
                v = obj.get(k)
                if isinstance(v, str):
                    t = v.strip()
                    if 4 <= len(t) <= 150:
                        return t
            for v in obj.values():
                r = self._find_card_title(v, depth + 1)
                if r:
                    return r
        elif isinstance(obj, list):
            for it in obj:
                r = self._find_card_title(it, depth + 1)
                if r:
                    return r
        return ""

'''
anchor = "    def _parse_bilibili_from_payload(self, payload: str, source_type: str) -> Optional[Dict]:"
if anchor in s:
    s = s.replace(anchor, helper + anchor, 1)
    print('· 加 _find_card_title')
else:
    print('! 找不到 _parse_bilibili_from_payload 插入点')

# 1b) 解析时提取 title
old_ret = '''        return {
            'bvid': bvid,
            'aid': aid,
            'url': url,
            'p': p
        }'''
new_ret = '''        # _card_title_patch：把标题也带出来，短链接反查 BV 时要用
        title = ""
        try:
            if payload.strip().startswith("{") or payload.strip().startswith("["):
                title = self._find_card_title(json.loads(payload))
        except Exception:
            title = ""

        return {
            'bvid': bvid,
            'aid': aid,
            'url': url,
            'p': p,
            'title': title,
        }'''
if old_ret in s:
    s = s.replace(old_ret, new_ret, 1)
    print('· 解析结果加 title')
else:
    print('! 没找到 return 块')

# 1c) 输出格式带上 title
old_fmt = '''        if url:
            parts.append(f"url={url}")
        parts.append(f"source={source_type}")'''
new_fmt = '''        if url:
            parts.append(f"url={url}")
        title = (info.get("title") or "").strip()
        if title:
            # _card_title_patch：只有短链接（ref 为空）时，让模型把 title 传给 bili_video
            safe = title.replace('"', "'")
            parts.append(f'title="{safe}"')
        parts.append(f"source={source_type}")'''
if old_fmt in s:
    s = s.replace(old_fmt, new_fmt, 1)
    print('· 输出格式加 title')
else:
    print('! 没找到 format 的 url 段')

open(p, 'w', encoding='utf-8').write(s)
PY
  "$PY" -m py_compile "$QT" && echo "qq_tools OK"
else
  echo "· 没有 qq_tools，跳过"
fi

# ── 2. bili_whale：bili_video 支持非 BV 输入（按标题搜）──────────────────
if [ -f "$BW" ]; then
  cp -p "$BW" "$BW.bak-titleload-$STAMP"
  python3 - "$BW" <<'PY'
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()

if '_title_lookup_patch' in s:
    print('· bili_whale 已支持标题反查')
    raise SystemExit

old = '''        blocked = self._llm_blocked()
        if blocked:
            return blocked
        m = BV_RE.search(bvid or "")
        if not m:
            return f"✗ 没看出 BV 号：{bvid}"
        return await self._tool_text(["video", m.group(0)], timeout=300)'''
new = '''        blocked = self._llm_blocked()
        if blocked:
            return blocked
        m = BV_RE.search(bvid or "")
        if not m:
            # _title_lookup_patch：不是标准 BV 时，当成「标题 / 短链接」去搜索反查。
            # 典型场景：QQ 的 B站分享卡片只给 https://b23.tv/xxx（服务器展开会 412），
            # 但卡片里带完整标题，用它搜第一条基本就是同一条视频。
            q = re.sub(r"https?://\\S+", " ", bvid or "").strip()
            q = re.sub(r"\\s+", " ", q)
            if len(q) >= 4:
                try:
                    _code, _text = await self._run(["search", q], timeout=180)
                    _bv = re.search(r"BV[0-9A-Za-z]{10}", _text or "")
                except Exception:
                    _bv = None
                if _bv:
                    m = _bv
                    logger.info(f"[bili-whale] 按标题反查到 BV：{m.group(0)}（查询：{q[:40]}）")
        if not m:
            return f"✗ 没看出 BV 号：{bvid}（如果是 B站卡片，可以把卡片标题发我，我按标题搜）"
        return await self._tool_text(["video", m.group(0)], timeout=300)'''
if old in s:
    s = s.replace(old, new, 1)
    open(p, 'w', encoding='utf-8').write(s)
    print('· bili_video 支持标题反查')
else:
    print('! 没找到 tool_video 的主体（插件升级过？）')
PY
  "$PY" -m py_compile "$BW" && echo "bili_whale OK"
else
  echo "· 没有 bili_whale，跳过"
fi

echo
echo "完成。执行：systemctl restart astrbot"
