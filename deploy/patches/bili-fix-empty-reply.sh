#!/bin/bash
# 修「@ 她了但没回复」：_social_clean 的 @ 正则把整句删空。
#
# 证据：
#   state.json: social.sent=0，但 seen 里有两条 at:... 记录
#     → 说明轮询取到了 @、也读了视频（日志有「回复前已读取视频上下文」），
#       但生成回复后内容被判成空，静默跳过并标记 seen，永不重试
#   实测正则：
#     输入 "@Liatos3906这个视频讲的是AI做菜"
#     re.sub(r"@\S+", "", s) → ""      ← 中文无空格时 \S+ 贪婪到行尾，整句没了
#
# 改法：
#   1. _social_clean 里的 @ 处理改成「只吃英文/数字昵称」，再兜底删掉孤立 @ 符号，
#      不再用 \S+ 贪婪匹配
#   2. _social_reply_tick 在内容为空时打一条日志（原来静默，排查时完全看不见）
#   3. 清掉 state.json 里 social.seen 的两条记录，让那次 @ 能重新走一遍
#
# 用法（AstrBot 所在机器，root）：
#   bash bili-fix-empty-reply.sh
#   systemctl restart astrbot
#
# 幂等：重复执行不会重复改；seen 只在还有记录时清。
set -euo pipefail

PLUGINS=${PLUGINS:-/root/data/plugins}
BW="$PLUGINS/astrbot_plugin_bili_whale/main.py"
STATE=${STATE:-/root/data/plugin_data/astrbot_plugin_bili_whale/state.json}
PY=${PY:-/opt/astrbot/venv/bin/python}
STAMP=$(date +%Y%m%d-%H%M%S)

# ── 1. 代码 ──────────────────────────────────────────────────────────────
cp -p "$BW" "$BW.bak-emptyreply-$STAMP"
python3 - "$BW" <<'PY'
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()

if '_empty_reply_patch' in s:
    print('· 代码已修过')
    raise SystemExit

old = '''        s = re.sub(r"https?://\\S+", "", s)
        s = re.sub(r"@\\S+", "", s)  # 自主回复/评论不 @ 人，避免打扰'''
new = '''        s = re.sub(r"https?://\\S+", "", s)
        # _empty_reply_patch：原来这里是 r"@\\S+" —— 中文不带空格时 \\S+ 会一路吃到行尾，
        # 把「@Liatos3906这个视频讲的是AI做菜」整句删空，然后被当成"没话说"静默跳过。
        # 改成只吃英文/数字昵称（B 站昵称基本是这个字符集），再兜底删掉孤立 @ 符号。
        s = re.sub(r"@[A-Za-z0-9_.\\-]+", "", s)
        s = s.replace("@", "")'''
if old in s:
    s = s.replace(old, new, 1)
    print('· _social_clean 的 @ 处理改安全')
else:
    print('! 没找到 _social_clean 的 @ 行')

old_empty = '''        text = await self._reply_say(item)
        if not text:
            self._social_mark_seen(self._item_key(item))
            return ""'''
new_empty = '''        text = await self._reply_say(item)
        if not text:
            # _empty_reply_patch：原来这里是静默的，排查时完全看不出「取到了但没话说」
            logger.info(
                f"[bili-whale] 回复内容为空，跳过：{item.get('who')}「{clip(str(item.get('text') or ''), 40)}」"
            )
            self._social_mark_seen(self._item_key(item))
            return ""'''
if old_empty in s:
    s = s.replace(old_empty, new_empty, 1)
    print('· 空内容时加日志')
else:
    print('! 没找到 _social_reply_tick 的空判断')

open(p, 'w', encoding='utf-8').write(s)
PY

"$PY" -m py_compile "$BW" && echo "bili_whale OK"

# ── 2. 清掉 seen，让那次 @ 能重来 ────────────────────────────────────────
if [ -f "$STATE" ]; then
  cp -p "$STATE" "$STATE.bak-seen-$STAMP"
  python3 - "$STATE" <<'PY'
import json, sys

p = sys.argv[1]
d = json.load(open(p, encoding='utf-8'))
soc = d.get("social")
if not isinstance(soc, dict):
    print("· 没有 social 段，跳过")
    raise SystemExit
seen = soc.get("seen")
if isinstance(seen, dict) and seen:
    n = len(seen)
    soc["seen"] = {}
    # 顺手把「上次尝试时间」清掉，免得被 min_gap 挡住
    soc["last_try_at"] = 0
    json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"· 清掉 {n} 条 seen 记录（那次 @ 会重新处理），并重置 last_try_at")
else:
    print("· seen 已经是空的，跳过")
PY
else
  echo "· 没有 state.json，跳过"
fi

echo
echo "完成。执行：systemctl restart astrbot"
echo "重启后 60 秒内应该重新取到那条 @，日志会依次出现："
echo "  回复前已读取视频上下文：BVxxx"
echo "  ✓ 自主回复了 xxx：「…」"
