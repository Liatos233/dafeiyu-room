#!/bin/bash
# 撤回仍撤错：不再信任插件缓存，直接问 OneBot 要历史来定位「我自己最近一条」。
#
# 13:55 的证据：
#   [delete_message] 缓存里属于自己(2086213845)的候选 11 条
#   [delete_message] 没给 ID，自动用自己最近一条：-1034691282
#   Result: 消息 -1034691282: 撤回失败 (私聊不可撤回对方的消息)
# 但直接查 OneBot 历史，-1034691282 是**主人**发的「撤回你刚才那条」。
# 也就是说插件里那个 message_cache 的 sender_id 是错的（把主人的消息标成了 bot 的），
# 所以按 sender_id 筛根本没意义。
#
# 改法：一律用 get_friend_msg_history / get_group_msg_history 拿原始消息，
# 按 sender.user_id == 登录账号 筛，取最新一条。缓存只作为最后的兜底。
#
# 用法（AstrBot 所在机器，root）：
#   bash qq_tools-recall-fix4.sh
#   systemctl restart astrbot
#
# 幂等：重复执行不会重复改。
set -euo pipefail

PLUGIN_DIR=${PLUGIN_DIR:-/root/data/plugins/astrbot_plugin_qq_tools}
DEL="$PLUGIN_DIR/tools/delete_message.py"
MAIN="$PLUGIN_DIR/main.py"
PY=${PY:-/opt/astrbot/venv/bin/python}
STAMP=$(date +%Y%m%d-%H%M%S)

# ── 1. delete_message.py ─────────────────────────────────────────────────
cp -p "$DEL" "$DEL.bak-recallfix4-$STAMP"
python3 - "$DEL" <<'PY'
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()

if '_history_lookup_patch' in s:
    print('· delete_message 已改为查历史')
    raise SystemExit

# 1a) 加一个工具方法：直接问 OneBot 要「我自己最近一条」
helper = '''
    async def _find_my_latest(self, client, event, self_id: str):
        """_history_lookup_patch：直接问 OneBot 要历史，找我自己最近发的一条。

        不用插件那个 message_cache —— 实测它的 sender_id 会标错（把主人的消息
        标成 bot 的），按它筛会把主人的消息当自己的。
        返回 (message_id, timestamp)；找不到返回 ("", 0)。
        """
        try:
            if event.get_group_id():
                resp = await call_onebot(
                    client, 'get_group_msg_history',
                    group_id=int(event.get_group_id()), count=15
                )
            else:
                resp = await call_onebot(
                    client, 'get_friend_msg_history',
                    user_id=int(event.get_sender_id()), count=15
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[delete_message] 查历史失败：{exc}")
            return "", 0
        msgs = (resp or {}).get('messages') or []
        for m in reversed(msgs):
            if str((m.get('sender') or {}).get('user_id')) == str(self_id):
                return str(m.get('message_id') or ''), int(m.get('time') or 0)
        return "", 0

'''
anchor_method = '    async def _get_role(self, client, group_id, user_id):'
if anchor_method in s:
    s = s.replace(anchor_method, helper + anchor_method, 1)
    print('· 加 _find_my_latest（查 OneBot 历史）')
else:
    print('! 找不到 _get_role 插入点')

# 1b) 「无 ID」分支：改用 _find_my_latest，缓存只兜底
old_block = '''            picked = ""
            try:
                # _recall_filter_patch2：缓存是混合的（主人消息也在），必须筛发送者
                cache = [
                    m for m in (self.plugin.message_cache.get(session_id, []) if self.plugin else [])
                    if str((m or {}).get("sender_id") or "") == self_id
                ]
                logger.info(f"[delete_message] 缓存里属于自己({self_id})的候选 {len(cache)} 条")
                while cache and not picked:
                    picked = str((cache.pop() or {}).get("message_id", "")).strip()
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"[delete_message] 读自身消息缓存失败：{exc}")'''
new_block = '''            # _history_lookup_patch：以 OneBot 历史为准（缓存 sender_id 不可信）
            picked, picked_ts = await self._find_my_latest(client, event, self_id)
            if picked:
                logger.info(
                    f"[delete_message] 没给 ID，从 OneBot 历史找到自己最近一条：{picked}（{int(time.time()) - picked_ts}s 前）"
                )
            else:
                # 兜底：历史里没有（可能太新还没入库），再看缓存
                try:
                    cache = [
                        m for m in (self.plugin.message_cache.get(session_id, []) if self.plugin else [])
                        if str((m or {}).get("sender_id") or "") == self_id
                    ]
                    logger.info(f"[delete_message] 历史没找到，退回缓存（候选 {len(cache)} 条）")
                    while cache and not picked:
                        picked = str((cache.pop() or {}).get("message_id", "")).strip()
                except Exception as exc:  # noqa: BLE001
                    logger.warning(f"[delete_message] 读自身消息缓存失败：{exc}")'''
if old_block in s:
    s = s.replace(old_block, new_block, 1)
    print('· 「无 ID」改用历史查询')
else:
    print('! <(无 ID 分支没找到，跳过>)')

# 1c) 私聊兜底：模型传了别人的 ID → 也用历史找自己的
old_fb = '''                    alt = ""
                    try:
                        cache = [
                            m for m in (self.plugin.message_cache.get(session_id, []) if self.plugin else [])
                            if str((m or {}).get("sender_id") or "") == self_id
                        ]
                        while cache and not alt:
                            alt = str((cache.pop() or {}).get("message_id") or "").strip()
                    except Exception:
                        alt = ""'''
new_fb = '''                    alt, _alt_ts = await self._find_my_latest(client, event, self_id)'''
if old_fb in s:
    s = s.replace(old_fb, new_fb, 1)
    print('· 私聊兜底也改用历史查询')
else:
    print('! 私聊兜底段没找到，跳过')

open(p, 'w', encoding='utf-8').write(s)
PY

# ── 2. /撤回 命令也改成查历史 ────────────────────────────────────────────
cp -p "$MAIN" "$MAIN.bak-recallfix4-$STAMP"
python3 - "$MAIN" <<'PY'
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()

if '_history_lookup_patch_main' in s:
    print('· /撤回 已改为查历史')
    raise SystemExit

old = '''            # _recall_filter_patch：message_cache 是混合缓存（主人的消息也在里面，
            # 见 main.py 里处理消息时的那处 append），必须按发送者筛，否则会撤主人的
            cache = [
                m for m in self.message_cache.get(session_id, [])
                if str((m or {}).get("sender_id") or "") == self_id
            ]
            while cache and not target:
                target = str((cache.pop() or {}).get("message_id", "")).strip()'''
new = '''            # _history_lookup_patch_main：直接问 OneBot 要历史（插件缓存的 sender_id
            # 实测会标错，把主人的消息当成 bot 的），取我自己最近一条。
            try:
                if event.get_group_id():
                    resp = await call_onebot(
                        client, 'get_group_msg_history',
                        group_id=int(event.get_group_id()), count=15
                    )
                else:
                    resp = await call_onebot(
                        client, 'get_friend_msg_history',
                        user_id=int(event.get_sender_id()), count=15
                    )
                for m in reversed((resp or {}).get('messages') or []):
                    if str((m.get('sender') or {}).get('user_id')) == self_id:
                        target = str(m.get('message_id') or '').strip()
                        break
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"[qq_tools] /撤回 查历史失败：{exc}")'''
if old in s:
    s = s.replace(old, new, 1)
    open(p, 'w', encoding='utf-8').write(s)
    print('· /撤回 改用 OneBot 历史')
else:
    print('! /撤回 的缓存段没找到（可能已被别处替换），跳过')
PY

echo "=== 语法检查 ==="
"$PY" -m py_compile "$DEL" && echo "delete_message.py OK"
"$PY" -m py_compile "$MAIN" && echo "main.py OK"
cd /root/data/plugins && "$PY" -c "
import sys; sys.path.insert(0, '/root/data/plugins')
import astrbot_plugin_qq_tools.main
print('✓ import OK')
" 2>&1 | tail -3

echo
echo "完成。执行：systemctl restart astrbot"
