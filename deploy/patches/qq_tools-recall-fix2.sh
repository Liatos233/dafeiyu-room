#!/bin/bash
# 修「撤回撤错对象」：/撤回 和 delete_message 都拿主人的消息去撤。
#
# 现象：发 /撤回，插件报成功，但被撤掉的是主人刚发的 /撤回 那条消息本身；
# 日志里 bili-whale 收到 '撤回 [MSG_ID:185603666]'，185603666 是主人消息的 ID。
#
# 根因：插件的 message_cache 是**混合缓存** —— main.py 里有两处写入：
#   1207 行：处理消息时缓存（所有消息，含主人的）
#   2057 行：_cache_bot_sent_messages（只缓存 bot 自己的）
# 而 /撤回 和 delete_message 取「最近一条」时没筛发送者，于是拿到主人的。
#
# 修三处：
#   1. /撤回：只从缓存里筛 sender_id == 自己
#   2. delete_message 的「无 ID 取缓存」：同样筛发送者
#   3. 私聊兜底：即使模型传了别人的 message_id，也自动改成撤自己最近一条
#      （私聊撤别人的必被 QQ 拒绝，改成撤销自己的才有意义）
#
# 用法（AstrBot 所在机器，root）：
#   bash qq_tools-recall-fix2.sh
#   systemctl restart astrbot
#
# 幂等：重复执行不会重复改。
set -euo pipefail

PLUGIN_DIR=${PLUGIN_DIR:-/root/data/plugins/astrbot_plugin_qq_tools}
MAIN="$PLUGIN_DIR/main.py"
DEL="$PLUGIN_DIR/tools/delete_message.py"
PY=${PY:-/opt/astrbot/venv/bin/python}
STAMP=$(date +%Y%m%d-%H%M%S)

# ── 1. /撤回 命令：筛发送者 ──────────────────────────────────────────────
cp -p "$MAIN" "$MAIN.bak-recallfix-$STAMP"
python3 - "$MAIN" <<'PY'
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()

if '_recall_filter_patch' in s:
    print('· main.py 已修过')
    raise SystemExit

old = '''            cache = list(self.message_cache.get(session_id, []))
            while cache and not target:
                target = str((cache.pop() or {}).get("message_id", "")).strip()'''
new = '''            # _recall_filter_patch：message_cache 是混合缓存（主人的消息也在里面，
            # 见 main.py 里处理消息时的那处 append），必须按发送者筛，否则会撤主人的
            cache = [
                m for m in self.message_cache.get(session_id, [])
                if str((m or {}).get("sender_id") or "") == self_id
            ]
            while cache and not target:
                target = str((cache.pop() or {}).get("message_id", "")).strip()'''
if old in s:
    s = s.replace(old, new, 1)
    open(p, 'w', encoding='utf-8').write(s)
    print('· /撤回 缓存加发送者筛选')
else:
    print('! main.py 没找到 /撤回 的缓存段（插件升级过？），需手动确认')
PY

# ── 2+3. delete_message：缓存筛选 + 私聊自动纠正 ─────────────────────────
cp -p "$DEL" "$DEL.bak-recallfix-$STAMP"
python3 - "$DEL" <<'PY'
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()

if '_recall_filter_patch2' in s:
    print('· delete_message 已修过')
    raise SystemExit

# 2) 无 ID 取缓存时筛发送者
old_cache = '''                cache = list(self.plugin.message_cache.get(session_id, [])) if self.plugin else []
                while cache and not picked:
                    picked = str((cache.pop() or {}).get("message_id", "")).strip()'''
new_cache = '''                # _recall_filter_patch2：缓存是混合的（主人消息也在），必须筛发送者
                cache = [
                    m for m in (self.plugin.message_cache.get(session_id, []) if self.plugin else [])
                    if str((m or {}).get("sender_id") or "") == self_id
                ]
                while cache and not picked:
                    picked = str((cache.pop() or {}).get("message_id", "")).strip()'''
if old_cache in s:
    s = s.replace(old_cache, new_cache, 1)
    print('· delete_message 缓存加发送者筛选')
else:
    print('! delete_message 没找到缓存段')

# 3) 私聊里目标不是自己的消息 → 自动改撤自己最近一条
old_loop = '''        for mid in ids:
            # Check permissions
            msg_info = await self._get_msg_info(client, mid, session_id)'''
new_loop = '''        for mid in ids:
            # Check permissions
            msg_info = await self._get_msg_info(client, mid, session_id)

            # _recall_filter_patch2：私聊里撤别人的必然被 QQ 拒绝（"私聊不可撤回对方的消息"），
            # 而模型拿到的往往只有主人消息的 ID。这里自动改成撤自己最近一条，别让对话空转。
            if msg_info and not event.get_group_id():
                target_sender = str(msg_info.get("sender_id") or "")
                if target_sender and target_sender != self_id:
                    alt = ""
                    try:
                        cache = [
                            m for m in (self.plugin.message_cache.get(session_id, []) if self.plugin else [])
                            if str((m or {}).get("sender_id") or "") == self_id
                        ]
                        while cache and not alt:
                            alt = str((cache.pop() or {}).get("message_id") or "").strip()
                    except Exception:
                        alt = ""
                    if alt:
                        logger.info(
                            f"[delete_message] 私聊里想撤别人的消息({mid})，改撤自己最近一条 {alt}"
                        )
                        mid = alt
                        msg_info = await self._get_msg_info(client, mid, session_id)'''
if old_loop in s:
    s = s.replace(old_loop, new_loop, 1)
    print('· delete_message 加「私聊自动改撤自己」')
else:
    print('! delete_message 没找到 for mid 循环')
PY

echo "=== 语法检查 ==="
"$PY" -m py_compile "$MAIN" && echo "main.py OK"
"$PY" -m py_compile "$DEL" && echo "delete_message.py OK"
echo
echo "=== 模块可导入 ==="
cd /root/data/plugins && "$PY" -c "
import sys; sys.path.insert(0, '/root/data/plugins')
import astrbot_plugin_qq_tools.main
print('✓ import OK')
" 2>&1 | tail -3

echo
echo "完成。执行：systemctl restart astrbot"
