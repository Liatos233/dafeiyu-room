#!/bin/bash
# 让 poke_user 不传 qq_id 也能戳当前对话的人。
#
# 问题：poke_user 的 qq_id 是必填，但 dafeiyu_clean 会把上下文里的
# "User ID: 630151911, Nickname: ..." 删掉（防串台），模型拿不到主人的 QQ 号，
# 于是这个工具从注册起一次都没被调用过（日志里只有 added LLM tool: poke_user）。
#
# 改法：qq_id 改可选；不传时用 event.get_sender_id()（私聊里就是主人）。
#
# 用法：
#   bash qq_tools-poke-default-target.sh
#   systemctl restart astrbot
# 幂等：重复执行不会重复改。
set -euo pipefail

PLUGIN_DIR=${PLUGIN_DIR:-/root/data/plugins/astrbot_plugin_qq_tools}
P="$PLUGIN_DIR/tools/poke.py"
PY=${PY:-/opt/astrbot/venv/bin/python}
STAMP=$(date +%Y%m%d-%H%M%S)

[ -f "$P" ] || { echo "找不到 $P"; exit 1; }
cp -p "$P" "$P.bak-defaulttarget-$STAMP"

python3 - "$P" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
if '_default_target_patch' in s:
    print('· 已修过'); raise SystemExit

old_desc = '''            description="发送“戳一戳”消息给指定QQ用户（双击头像效果）。返回结果包含动作文案（如“你踢了踢xxx”）。",'''
new_desc = '''            description=("发送\\"戳一戳\\"消息（双击头像效果）。"
                         "**不传 qq_id 就戳当前对话的人**（私聊里就是主人，推荐这样用）；"
                         "返回结果包含动作文案（如\\"你踢了踢xxx\\"）。"),'''
if old_desc in s:
    s = s.replace(old_desc, new_desc, 1)
    print('· 更新描述')

old_req = '''                "required": ["qq_id"],'''
new_req = '''                "required": [],'''
if old_req in s:
    s = s.replace(old_req, new_req, 1)
    print('· qq_id 改为可选')

old_use = '''        if not qq_id:
            return "未指定QQ号。"'''
new_use = '''        # _default_target_patch：不传 qq_id 就戳当前对话的人。
        # 原因：dafeiyu_clean 会把上下文里的 "User ID: xxx" 删掉，模型根本拿不到
        # 主人的 QQ 号，于是这个工具永远调不起来。私聊里直接戳对方最合理。
        if not qq_id:
            qq_id = str(event.get_sender_id() or "")
        if not qq_id:
            return "未指定QQ号，也拿不到当前对话对象。"'''
if old_use in s:
    s = s.replace(old_use, new_use, 1)
    print('· 不传 qq_id 时默认戳当前对话对象')

open(p, 'w', encoding='utf-8').write(s)
PY

"$PY" -m py_compile "$P" && echo "syntax OK"
echo "完成。执行：systemctl restart astrbot"
