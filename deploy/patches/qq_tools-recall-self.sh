#!/bin/bash
# 修 qq_tools 的「撤回」：让 AI 能撤自己刚发的消息。
#
# 现象：让大肥鱼撤回消息，它说撤不了。日志显示它确实调了 delete_message，
# 但传的是**主人消息**的 ID —— 私聊里撤对方消息会被 QQ 拒绝：
#   "撤回失败 (私聊不可撤回对方的消息)"
# 它自己最后也说了："我这边只有你消息的ID，我自己的ID拿不到"。
#
# 根因有两层：
#   1. 上下文里只有用户消息带 [MSG_ID:xxx]，bot 自己的回复不带
#   2. 插件其实**已经缓存了** bot 自己发的消息（@filter.after_message_sent
#      -> _cache_bot_sent_messages），但没有任何工具让模型查这个缓存；
#      delete_message 的 desc 里还让模型「用 get_recent_messages 查」，
#      而那个工具根本不存在
#   3. 更糟的是 call() 里直接 message_id.split(",")，不给 ID 会 AttributeError
#
# 改法：message_id 改成可选；不传（或传 self/last）就从缓存取 bot 自己最近一条。
#
# 用法（AstrBot 所在机器，root）：
#   bash qq_tools-recall-self.sh
#   systemctl restart astrbot
#
# 幂等：重复执行不会重复改。插件升级后重跑一次即可。
set -euo pipefail

PLUGIN_DIR=${PLUGIN_DIR:-/root/data/plugins/astrbot_plugin_qq_tools}
F="$PLUGIN_DIR/tools/delete_message.py"
PY=${PY:-/opt/astrbot/venv/bin/python}
STAMP=$(date +%Y%m%d-%H%M%S)

[ -f "$F" ] || { echo "找不到 $F"; exit 1; }
cp -p "$F" "$F.bak-recall-$STAMP"
echo "备份: $F.bak-recall-$STAMP"

python3 - "$F" <<'PY'
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()

if '_recall_self_patch' in s:
    print('· 已经改过，跳过')
    raise SystemExit

# 1) parameters：message_id 从必填改成可选，描述写清楚
old_desc = '''        desc_message_id = "要撤回的消息ID。多个ID用逗号分隔，例如 '123,456'。可以直接从用户消息的 [MSG_ID:xxx] 中获取 xxx。"
        if not show_message_id:
            desc_message_id = "要撤回的消息ID。多个ID用逗号分隔，例如 '123,456'。如果你无法从当前上下文获取消息ID，请先使用 get_recent_messages 工具查找。"'''
new_desc = '''        # _recall_self_patch：不传 ID 时自动撤回 bot 自己最近发的一条（从插件缓存里取）
        desc_message_id = (
            "要撤回的消息ID。多个ID用逗号分隔，例如 '123,456'。"
            "通常从用户消息的 [MSG_ID:xxx] 中获取 xxx。"
            "**留空即可撤回你自己最近发送的一条**（推荐：你只能撤回自己发的消息，"
            "私聊里撤不了主人的消息）。也可以填 self / last。"
        )'''
if old_desc in s:
    s = s.replace(old_desc, new_desc, 1)
    print('· 更新 message_id 描述')
else:
    print('! 没找到原来的 desc 块，跳过描述更新')
    print('  (若下面 required 也没改，说明插件升级过，请手动确认)')

if '"required": ["message_id"]' in s:
    s = s.replace('"required": ["message_id"]', '"required": []', 1)
    print('· message_id 改为可选')
else:
    print('! 没找到 required: ["message_id"]')

# 2) call()：兜住「没给 ID」，并从缓存取 bot 自己最近一条
old_call = '''        event = context.context.event
        message_id = kwargs.get("message_id")
        '''
new_call = '''        event = context.context.event
        # _recall_self_patch：没给 ID 时不要崩（原来是 message_id.split 直接 AttributeError）
        message_id = kwargs.get("message_id") or ""
        '''
if old_call in s:
    s = s.replace(old_call, new_call, 1)
    print('· 兜住空 message_id')
else:
    print('! 没找到 call() 开头的 message_id 读取')

old_parse = '''        ids = clean_ids
'''
new_parse = '''        ids = clean_ids

        # _recall_self_patch：没给 ID（或给了 self/last/最近/自己）→ 从缓存取 bot 自己最近一条。
        # 插件在 @filter.after_message_sent 里已经缓存 bot 发的消息（_cache_bot_sent_messages），
        # 这里直接用，省得模型去猜一个它拿不到的 ID。
        if not ids or all(i.lower() in ("self", "last", "最近", "自己") for i in ids):
            picked = ""
            try:
                cache = list(self.plugin.message_cache.get(session_id, [])) if self.plugin else []
                while cache and not picked:
                    picked = str((cache.pop() or {}).get("message_id", "")).strip()
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"[delete_message] 读自身消息缓存失败：{exc}")
            if picked:
                ids = [picked]
                logger.info(f"[delete_message] 没给 ID，自动用自己最近一条：{picked}")
            else:
                return ("没拿到要撤回的消息：你自己最近发的那几条我这边没缓存到。"
                        "试试让主人把那条消息引用一下再让我撤，或者过一会儿再说。")
'''
if old_parse in s:
    s = s.replace(old_parse, new_parse, 1)
    print('· 加「无 ID → 取自己最近一条」')
else:
    print('! 没找到 ids = clean_ids，请手动确认')

open(p, 'w', encoding='utf-8').write(s)
PY

echo "=== 语法检查 ==="
"$PY" -m py_compile "$F" && echo "syntax OK"
echo
echo "=== 关键片段确认 ==="
grep -n '_recall_self_patch\|"required": \[\]' "$F" | head -6

echo
echo "完成。执行：systemctl restart astrbot"
