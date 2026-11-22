#!/bin/bash
# 给 qq_tools 加一个 /撤回 命令，作为「让 AI 自己撤」的兜底。
#
# 背景：让大肥鱼撤消息，它反复说"撤不了"。
# 实测证明链路完全正常 —— 走 OneBot API 撤回它自己 38 秒前那条，retcode 0。
# 问题是模型没调用工具（上文刚失败过两次，形成了"撤不了"的惯性）。
# 所以加一个不依赖模型判断的命令：主人直接发 /撤回 就撤她自己最后一条。
#
# 用法（AstrBot 所在机器，root）：
#   bash qq_tools-recall-cmd.sh
#   systemctl restart astrbot
# 使用：直接发 /撤回（管理员）
#
# 幂等：重复执行不会重复插入。
set -euo pipefail

PLUGIN_DIR=${PLUGIN_DIR:-/root/data/plugins/astrbot_plugin_qq_tools}
F="$PLUGIN_DIR/main.py"
PY=${PY:-/opt/astrbot/venv/bin/python}
STAMP=$(date +%Y%m%d-%H%M%S)

[ -f "$F" ] || { echo "找不到 $F"; exit 1; }
cp -p "$F" "$F.bak-recallcmd-$STAMP"
echo "备份: $F.bak-recallcmd-$STAMP"

python3 - "$F" <<'PY'
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()

if 'recall_last_cmd' in s:
    print('· 已经加过 /撤回 命令')
    raise SystemExit

marker = '    @filter.command_group("qts wk")'
if marker not in s:
    print('!! 找不到插入点（插件升级过？），请手动加')
    raise SystemExit(2)

new = '''    @filter.permission_type(filter.PermissionType.ADMIN)
    @filter.command("撤回")
    async def recall_last_cmd(self, event):
        # 注意：这里不能写 `event: AiocqhttpMessageEvent` —— 该模块顶部没有导入这个类
        # （都是函数体内延迟导入），写注解会让整个插件 NameError 加载失败。
        """撤我自己最后发的一条消息。直接发 /撤回 就行，不用带参数。"""
        try:
            client = event.bot
            session_id = event.get_session_id()
            self_id = str(event.get_self_id())
            target = ""
            # 优先用插件自己缓存的（@filter.after_message_sent 里存进去的）
            cache = list(self.message_cache.get(session_id, []))
            while cache and not target:
                target = str((cache.pop() or {}).get("message_id", "")).strip()
            if not target:
                # 缓存空（比如刚重启）：直接查最近的聊天历史，挑自己发的最后一条
                if event.get_group_id():
                    resp = await call_onebot(
                        client, 'get_group_msg_history',
                        group_id=int(event.get_group_id()), count=10
                    )
                else:
                    resp = await call_onebot(
                        client, 'get_friend_msg_history',
                        user_id=int(event.get_sender_id()), count=10
                    )
                msgs = (resp or {}).get('messages') or []
                for m in reversed(msgs):
                    if str((m.get('sender') or {}).get('user_id')) == self_id:
                        target = str(m.get('message_id') or '').strip()
                        break
            if not target:
                yield event.plain_result("没找到我自己最近发的消息，撤不了。")
                return
            await call_onebot(client, 'delete_msg', message_id=int(target))
            logger.info(f"[qq_tools] /撤回 成功：{target}")
            # 成功就不回复：撤回本身就是"少一条消息"，那条消息消失已经是反馈了，
            # 再发一句"撤回了。"反而又补一条回来。只有失败才提示。
            return
        except Exception as e:  # noqa: BLE001
            logger.warning(f"[qq_tools] /撤回 失败：{e}")
            yield event.plain_result(f"撤回失败：{e}")

'''
s = s.replace(marker, new + marker, 1)
open(p, 'w', encoding='utf-8').write(s)
print('· 加了 /撤回 命令（管理员）')
PY

echo "=== 语法检查 ==="
"$PY" -m py_compile "$F" && echo "syntax OK"
grep -n 'recall_last_cmd\|filter.command("撤回")' "$F" | head -4

echo
echo "完成。执行：systemctl restart astrbot"
echo "使用：直接发 /撤回"
