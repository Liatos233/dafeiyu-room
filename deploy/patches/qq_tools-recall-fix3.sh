#!/bin/bash
# 撤回仍然撤错对象：改用 OneBot 的 get_login_info 拿 bot 自己的 QQ。
#
# 证据（12:46~12:48 三次）：
#   [delete_message] 没给 ID，自动用自己最近一条：-483552975
#   Result: 消息 -483552975: 撤回失败 (私聊不可撤回对方的消息)
# 模型这次调用是对的（参数 {}，没传 ID），插件也走了「取自己最近一条」的分支，
# 但取到的仍是**主人**的消息 —— 说明按 sender_id == self_id 的筛选没起到作用。
#
# 根因：self_id 来自 event.get_self_id() -> message_obj.self_id。这个值在
# aiocqhttp 事件里通常是 bot 的 QQ，但实测这里取到的与真实登录账号不一致，
# 于是 sender_id == self_id 一个都匹配不上（或匹配到了主人的）。
#
# 改法：一律用 OneBot 的 get_login_info 取 user_id 作为 self_id（已实测返回
# <bot-qq> 吃饱的鱼），拿不到才回退 event.get_self_id()。
#
# 用法（AstrBot 所在机器，root）：
#   bash qq_tools-recall-fix3.sh
#   systemctl restart astrbot
#
# 幂等：重复执行不会重复改。
set -euo pipefail

PLUGIN_DIR=${PLUGIN_DIR:-/root/data/plugins/astrbot_plugin_qq_tools}
DEL="$PLUGIN_DIR/tools/delete_message.py"
MAIN="$PLUGIN_DIR/main.py"
PY=${PY:-/opt/astrbot/venv/bin/python}
STAMP=$(date +%Y%m%d-%H%M%S)

cp -p "$DEL" "$DEL.bak-recallfix3-$STAMP"
python3 - "$DEL" <<'PY'
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()

if '_selfid_login_patch' in s:
    print('· delete_message 已改用 get_login_info')
    raise SystemExit

old = '''        client = event.bot
        session_id = event.get_session_id()
        self_id = str(event.get_self_id())'''
new = '''        client = event.bot
        session_id = event.get_session_id()
        self_id = str(event.get_self_id())
        # _selfid_login_patch：以 OneBot 登录信息为准。
        # event.get_self_id() 取自 message_obj.self_id，实测与真实登录账号不一致，
        # 导致「按发送者筛缓存」全部落空，撤到了主人头上。
        try:
            _me = await call_onebot(client, 'get_login_info')
            _login_id = str((_me or {}).get('user_id') or '').strip()
            if _login_id:
                if _login_id != self_id:
                    logger.info(f"[delete_message] self_id 校正：{self_id} -> {_login_id}")
                self_id = _login_id
        except Exception as _exc:  # noqa: BLE001
            logger.warning(f"[delete_message] 取登录信息失败，沿用 event.self_id：{_exc}")'''
if old not in s:
    print('!! delete_message 没找到 client/session_id/self_id 三连')
    raise SystemExit(2)
s = s.replace(old, new, 1)

# 再补一条调试日志：把筛出来的候选打出来，下次一眼能看出对不对
old_pick = '''                while cache and not picked:
                    picked = str((cache.pop() or {}).get("message_id", "")).strip()'''
new_pick = '''                logger.info(f"[delete_message] 缓存里属于自己({self_id})的候选 {len(cache)} 条")
                while cache and not picked:
                    picked = str((cache.pop() or {}).get("message_id", "")).strip()'''
if old_pick in s and '属于自己' not in s:
    s = s.replace(old_pick, new_pick, 1)

open(p, 'w', encoding='utf-8').write(s)
print('· delete_message 改用 get_login_info 校正 self_id')
PY

# /撤回 命令同样校正（它目前能用，但同一个来源，保险起见统一）
cp -p "$MAIN" "$MAIN.bak-recallfix3-$STAMP"
python3 - "$MAIN" <<'PY'
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()

if '_selfid_login_patch_main' in s:
    print('· /撤回 已校正过')
    raise SystemExit

old = '''            client = event.bot
            session_id = event.get_session_id()
            self_id = str(event.get_self_id())'''
new = '''            client = event.bot
            session_id = event.get_session_id()
            self_id = str(event.get_self_id())
            # _selfid_login_patch_main：同 delete_message，以登录信息为准
            try:
                _me = await call_onebot(client, 'get_login_info')
                _login_id = str((_me or {}).get('user_id') or '').strip()
                if _login_id:
                    self_id = _login_id
            except Exception:  # noqa: BLE001
                pass'''
if old not in s:
    print('! /撤回 里没找到 client/session_id/self_id，跳过')
    raise SystemExit
s = s.replace(old, new, 1)
open(p, 'w', encoding='utf-8').write(s)
print('· /撤回 也用 get_login_info 校正 self_id')
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
