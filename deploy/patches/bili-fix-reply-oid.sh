#!/bin/bash
# 修「自动回复返回 12022 已经被删除了」：oid 是动态 id，却按视频(type=1)去评论。
#
# 证据：
#   comment-digest 返回 {"oid":"116856211903862","business":1,"uri":".../BV1wiTx6FEg7"}
#   → oid 15 位，是动态/opus 的 id（视频 aid 一般 9~10 位）
#   comment.mjs 注释：「oid 使用 subject_id / basic.comment_id_str 的完整字符串；
#                     动态评论的 referer 要指到 opus 页」
#   而 _send_reply 把 business 直接当 --type（=1 视频），拿动态 id 去视频评论接口
#   → code=12022「已经被删除了」（其实是对象对不上，不是真被删）
#
# 改法：_send_reply 里如果能从 uri 提取到 BV，就先跑一次 `video` 拿到真实 aid，
# 用它覆盖 --oid，并把 --type 固定成 1（视频）。查不到才沿用原 oid。
#
# 用法（AstrBot 所在机器，root）：
#   bash bili-fix-reply-oid.sh
#   systemctl restart astrbot
#
# 幂等。
set -euo pipefail

PLUGINS=${PLUGINS:-/root/data/plugins}
BW="$PLUGINS/astrbot_plugin_bili_whale/main.py"
PY=${PY:-/opt/astrbot/venv/bin/python}
STAMP=$(date +%Y%m%d-%H%M%S)

cp -p "$BW" "$BW.bak-oidfix-$STAMP"
python3 - "$BW" <<'PY'
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()

if '_reply_oid_fix_patch' in s:
    print('· 已修过')
    raise SystemExit

old = '''        root = str(item.get("root") or "").strip()
        if not root or root == "0":
            root = str(item.get("rpid"))
        args = [
            "comment",
            "--oid", str(item.get("oid")),
            "--root", root,
            "--parent", str(item.get("rpid")),
            "--message", text,
            "--type", str(int(item.get("business") or 1)),
            "--auto",
        ]
        uri = str(item.get("uri") or "").strip()
        hit = re.search(r"(BV[0-9A-Za-z]{10})", uri)
        if hit:
            args += ["--bvid", hit.group(1)]
        elif uri:
            args += ["--referer", uri]'''

new = '''        root = str(item.get("root") or "").strip()
        if not root or root == "0":
            root = str(item.get("rpid"))

        uri = str(item.get("uri") or "").strip()
        hit = re.search(r"(BV[0-9A-Za-z]{10})", uri)

        # _reply_oid_fix_patch：通知里的 oid 可能是**动态 id**（15 位），
        # 而 business=1 会被当成视频评论接口，于是报 code=12022「已经被删除了」
        # （其实对象对不上，不是真删）。能从 BV 查到真实 aid 就覆盖掉。
        oid = str(item.get("oid") or "")
        reply_type = int(item.get("business") or 1)
        if hit:
            try:
                _c, _info = await self._run(["video", hit.group(1)], timeout=180)
                _m = re.search(r"aid=(\\d+)", _info or "")
                if _m:
                    if _m.group(1) != oid:
                        logger.info(
                            f"[bili-whale] 回复目标 oid 校正：{oid} -> {_m.group(1)}（按 BV 查到的 aid）"
                        )
                    oid = _m.group(1)
                    reply_type = 1  # 视频
            except Exception as _exc:  # noqa: BLE001
                logger.warning(f"[bili-whale] 查 aid 失败，沿用通知里的 oid：{_exc}")

        args = [
            "comment",
            "--oid", oid,
            "--root", root,
            "--parent", str(item.get("rpid")),
            "--message", text,
            "--type", str(reply_type),
            "--auto",
        ]
        if hit:
            args += ["--bvid", hit.group(1)]
        elif uri:
            args += ["--referer", uri]'''

if old in s:
    s = s.replace(old, new, 1)
    open(p, 'w', encoding='utf-8').write(s)
    print('· _send_reply 用 BV 反查 aid 覆盖 oid')
else:
    print('! 没找到 _send_reply 的参数段（插件升级过？）')
PY

"$PY" -m py_compile "$BW" && echo "bili_whale OK"
echo
echo "完成。执行：systemctl restart astrbot"
