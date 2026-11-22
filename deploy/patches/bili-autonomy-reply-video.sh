#!/bin/bash
# 让「自主回复 @我」真正能结合视频内容。
#
# 需求：在某个视频评论区 @ 她，她要根据「@ 的那句话 + 这条视频的内容」回复。
#
# 原实现（_reply_say）只拿评论文字生成回复，body 里只有 uri/rpid 元信息，
# 完全没读视频 —— 所以她只会「接着你的话说」，答不出跟视频相关的东西。
#
# 改法：_reply_say 里从 item.uri 提取 BV，跑一次 `video`（简介+字幕+弹幕+评论），
# 把结果放进 body 给模型参考。
#
# 同时开两个开关：
#   write.allow      false -> true   （写操作总闸）
#   autonomy.reply   false -> true   （只回 @我/回复我的）
#   autonomy.comment 保持 false      （不主动给别人写评论）
#
# 用法（AstrBot 所在机器，root）：
#   bash bili-autonomy-reply-video.sh
#   systemctl restart astrbot
#
# 幂等：重复执行不会重复改；配置只在还是 false 时改。
set -euo pipefail

PLUGINS=${PLUGINS:-/root/data/plugins}
BW="$PLUGINS/astrbot_plugin_bili_whale/main.py"
CFG=${CFG:-/root/data/config/astrbot_plugin_bili_whale_config.json}
PY=${PY:-/opt/astrbot/venv/bin/python}
STAMP=$(date +%Y%m%d-%H%M%S)

# ── 1. 代码：回复时带上视频上下文 ────────────────────────────────────────
cp -p "$BW" "$BW.bak-replyvideo-$STAMP"
python3 - "$BW" <<'PY'
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()

if '_reply_video_ctx_patch' in s:
    print('· 代码已改过')
    raise SystemExit

old = '''        body = f"（这条来自 {item.get('uri') or 'B 站'}，rpid={item.get('rpid')}）"
        text = await self._say(task, body, limit=self._social_limit())'''
new = '''        # _reply_video_ctx_patch：把「这条评论所在视频」的内容也给它，
        # 否则它只会接着对方的话说，答不出任何和视频有关的东西。
        body = f"（这条来自 {item.get('uri') or 'B 站'}，rpid={item.get('rpid')}）"
        try:
            _uri = str(item.get("uri") or "")
            _m = re.search(r"(BV[0-9A-Za-z]{10})", _uri)
            if _m:
                _code, _info = await self._run(["video", _m.group(1)], timeout=300)
                _ctx = clip(_info or "", 3000).strip()
                if _ctx:
                    body = (
                        f"【这条评论所在视频的信息（供你理解上下文；别复述、别像在念简介）】\\n"
                        f"{_ctx}\\n\\n" + body
                    )
                    logger.info(f"[bili-whale] 回复前已读取视频上下文：{_m.group(1)}（{len(_ctx)} 字）")
        except Exception as _exc:  # noqa: BLE001
            logger.warning(f"[bili-whale] 读取视频上下文失败（继续回复）：{_exc}")
        text = await self._say(task, body, limit=self._social_limit())'''
if old in s:
    s = s.replace(old, new, 1)
    open(p, 'w', encoding='utf-8').write(s)
    print('· _reply_say 回复前读取视频上下文')
else:
    print('! 没找到 _reply_say 的 body 段（插件升级过？）')
PY

"$PY" -m py_compile "$BW" && echo "bili_whale OK"

# ── 2. 配置：开写操作总闸 + 只开 reply ───────────────────────────────────
cp -p "$CFG" "$CFG.bak-autonomy-$STAMP"
python3 - "$CFG" <<'PY'
import json, sys

p = sys.argv[1]
d = json.load(open(p, encoding='utf-8-sig'))
changed = []

w = d.setdefault("write", {})
if w.get("allow") is not True:
    print(f"  write.allow: {w.get('allow')} -> True")
    w["allow"] = True
    changed.append("write.allow")

a = d.setdefault("autonomy", {})
for key, want in (("enabled", True), ("reply", True), ("comment", False)):
    if a.get(key) != want:
        print(f"  autonomy.{key}: {a.get(key)} -> {want}")
        a[key] = want
        changed.append(f"autonomy.{key}")

json.dump(d, open(p, "w", encoding="utf-8-sig"), ensure_ascii=False, indent=2)
d2 = json.load(open(p, encoding="utf-8-sig"))
print("最终：write.allow=", d2["write"].get("allow"),
      " autonomy: enabled=", d2["autonomy"].get("enabled"),
      "reply=", d2["autonomy"].get("reply"),
      "comment=", d2["autonomy"].get("comment"))
print("改动项：", changed or "无（本来就是这样）")
PY

echo
echo "完成。执行：systemctl restart astrbot"
echo "验证：日志里应出现「自主互动已启动」，之后每 45 分钟查一次通知"
