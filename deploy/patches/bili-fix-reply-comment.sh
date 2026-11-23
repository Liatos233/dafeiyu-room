#!/bin/bash
# 修 bili_reply_comment 发不出去（usage 退出码 2）。
#
# 现象：让大肥鱼回复某条评论，她直接评论了视频；打日志能看到她试了
# bili_reply_comment 但失败：
#   ✗ 没发出去（退出码 2）：usage: --oid <aid|comment_id_str>
#     [--bvid <BV...> | --referer <url>] --message "<text>"
#
# 三个问题：
#   1. 模型手里只有 BV（她刚看过那个视频），没有 oid 也没有 uri ——
#      工具的 oid/rpid 是必填，她填不出来，于是 oid 传了空，
#      但守卫只判断了「oid 和 rpid 都空」才拦，单缺 oid 时放行到 CLI，
#      CLI 报 usage 退出 2。
#   2. _send_reply 里 `--go` 加了两遍（3290 和 3298 行）—— 参数重复。
#   3. 没有 bvid 参数：只要 uri 里提取不到 BV，args 里就没有 --bvid，
#      comment.mjs 要求「--oid 之外还要有 --bvid 或 --referer」，
#      于是必然 usage 失败。
#
# 改法：
#   · 工具加可选 bvid 参数（模型有 BV 就传）
#   · 缺 oid 时用 bvid 反查 aid 补上
#   · 缺 rpid 时明确报错并提示用 bili_messages 查
#   · bvid 传进 _send_reply 的 item.uri，让 --bvid 一定带上
#   · 去掉重复的 --go
#
# 用法（AstrBot 所在机器，root）：
#   bash bili-fix-reply-comment.sh
#   systemctl restart astrbot
#
# 幂等。
set -euo pipefail

PLUGINS=${PLUGINS:-/root/data/plugins}
F="$PLUGINS/astrbot_plugin_bili_whale/main.py"
PY=${PY:-/opt/astrbot/venv/bin/python}
STAMP=$(date +%Y%m%d-%H%M%S)

[ -f "$F" ] || { echo "找不到 $F"; exit 1; }
cp -p "$F" "$F.bak-replyfix-$STAMP"
echo "备份: $F.bak-replyfix-$STAMP"

python3 - "$F" <<'PY'
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()

if '_reply_bvid_patch' in s:
    print('· 已经修过')
    raise SystemExit

# ── 1. 工具签名加 bvid，并补 oid 反查 ──────────────────────────────────
old_sig = '''        root: str = "",
        business: int = 1,
        emote: bool = False,
    ) -> str:
        """回复 B 站上一条「回复我的 / @我的」评论（自主互动开启时才能真正发出）。

        oid / rpid 必须来自 bili_messages 返回的真实数据，不要自己编。

        Args:
            oid (string): 评论所属的 oid（视频 aid 或动态 id），来自 bili_messages
            rpid (string): 要回复的那条评论的 rpid
            message (string): 回复正文，一句话，80 字以内
            root (string): 楼根 rpid；不填就用 rpid
            business (number): 1=视频，11/17=动态，默认 1
            emote (boolean): 要不要在末尾带一个 B 站官方表情（如 [大笑]），默认不带
        """'''

new_sig = '''        root: str = "",
        business: int = 1,
        emote: bool = False,
        bvid: str = "",
    ) -> str:
        """回复 B 站上一条「回复我的 / @我的」评论（自主互动开启时才能真正发出）。

        oid / rpid 必须来自 bili_messages 返回的真实数据，不要自己编。
        如果你只知道视频的 BV（比如刚看过那条视频），可以只传 bvid + rpid，
        工具会用 BV 反查 oid。

        Args:
            oid (string): 评论所属的 oid（视频 aid 或动态 id），来自 bili_messages；不知道可留空，改传 bvid
            rpid (string): 要回复的那条评论的 rpid（必须有，来自 bili_messages）
            message (string): 回复正文，一句话，80 字以内
            root (string): 楼根 rpid；不填就用 rpid
            business (number): 1=视频，11/17=动态，默认 1
            emote (boolean): 要不要在末尾带一个 B 站官方表情（如 [大笑]），默认不带
            bvid (string): 视频 BV 号（可选）；给了就能反查 oid，并让评论带上正确的 referer
        """'''

if old_sig in s:
    s = s.replace(old_sig, new_sig, 1)
    print('· 工具签名加 bvid 参数')
else:
    print('! 没找到工具签名块')

# ── 2. 参数校验 + oid 反查 ─────────────────────────────────────────────
old_check = '''        if not str(oid or "").strip() or not str(rpid or "").strip():
            return "✗ 缺 oid / rpid，先用 bili_messages 查收件箱"
        item = {
            "kind": "reply",
            "oid": str(oid).strip(),
            "rpid": str(rpid).strip(),
            "root": str(root or rpid).strip(),
            "business": int(business or 1),
            "who": "",
        }'''

new_check = '''        # _reply_bvid_patch：rpid 必须有（那是要回的那条评论）；oid 可以缺，
        # 缺了就用 bvid 反查 —— 模型手上常常只有 BV，没有 oid。
        _rpid = str(rpid or "").strip()
        _oid = str(oid or "").strip()
        _bv = ""
        _m = BV_RE.search(bvid or "")
        if _m:
            _bv = _m.group(0)
        if not _rpid:
            return (
                "✗ 缺 rpid：那是我要回复的那条评论的 id，先用 bili_messages "
                "查「谁回复/@了我」，从结果里拿到 rpid 再回"
            )
        if not _oid and _bv:
            try:
                _c, _info = await self._run(["video", _bv], timeout=180)
                _aid = re.search(r"aid=(\\d+)", _info or "")
                if _aid:
                    _oid = _aid.group(1)
                    logger.info(f"[bili-whale] bili_reply_comment 用 BV 反查 oid：{_bv} -> {_oid}")
            except Exception as _exc:  # noqa: BLE001
                logger.warning(f"[bili-whale] bili_reply_comment 反查 oid 失败：{_exc}")
        if not _oid:
            return (
                "✗ 缺 oid：这条评论属于哪个视频/动态。可以传 bvid（BV 号）让我反查，"
                "或者先用 bili_messages 查收件箱拿 oid"
            )
        item = {
            "kind": "reply",
            "oid": _oid,
            "rpid": _rpid,
            "root": str(root or _rpid).strip(),
            "business": int(business or 1),
            "who": "",
            # _reply_bvid_patch：把 BV 塞进 uri，_send_reply 才能带上 --bvid
            "uri": f"https://www.bilibili.com/video/{_bv}" if _bv else "",
        }'''

if old_check in s:
    s = s.replace(old_check, new_check, 1)
    print('· 参数校验 + BV 反查 oid')
else:
    print('! 没找到参数校验块')

# ── 3. 去掉重复的 --go ─────────────────────────────────────────────────
old_go = '''        if self._bool("autonomy.once_per_person", True):
            args.append("--once-per-person")
        args.append("--go")'''
new_go = '''        if self._bool("autonomy.once_per_person", True):
            args.append("--once-per-person")
        # _reply_bvid_patch：这里原来又 append 了一次 --go（上面 args 里已有），
        # 参数重复虽然多半被 argparse 吃掉了，但没必要。删掉。'''

if old_go in s:
    s = s.replace(old_go, new_go, 1)
    print('· 去掉重复的 --go')
else:
    print('! 没找到重复 --go 的位置')

open(p, 'w', encoding='utf-8').write(s)
PY

"$PY" -m py_compile "$F" && echo "syntax OK"
echo
echo "完成。执行：systemctl restart astrbot"
