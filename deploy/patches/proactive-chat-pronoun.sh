#!/bin/bash
# 修「主动消息人称错误」：房间状态写的是「她」，但主动消息用了没有房间里规则的人格。
#
# 现象：主动消息发「游戏还打着没啊，手柄都没放下吧」—— 明明是她自己在打游戏。
#
# 日志还原：
#   [room_link] 注入房间状态（41 字）：她在客厅·沙发上，抱着手柄打游戏…
#   [主动消息] 使用默认人格设定
#
# 根因两层：
#   1. 会话没绑定人格（conversations.persona_id 全是 None），
#      于是 get_default_persona_v3 返回的是内置那句 41 字的
#      "You are a helpful and friendly assistant." —— 没有任何大肥鱼的设定，
#      也没有「房间状态里的『她』就是你自己」这条规则。
#   2. 即使拿到了大肥鱼人设（1638 字），里面同样没有这条规则 ——
#      room_link 是「对话侧」插件，主动消息走的是另一条链路，
#      只有 room_link 的注入才知道「她=你」。
#
# 改法：在 context_service 组装最终 prompt 时，追加一段「房间状态人称规则」，
# 并且把「她」明确指回自己。这段对所有主动消息都生效，不依赖人格是否绑定。
#
# 用法（AstrBot 所在机器，root）：
#   bash proactive-chat-pronoun.sh
#   systemctl restart astrbot
#
# 幂等。
set -euo pipefail

PLUGINS=${PLUGINS:-/root/data/plugins}
CS="$PLUGINS/astrbot_plugin_proactive_chat/core/services/context_service.py"
PY=${PY:-/opt/astrbot/venv/bin/python}
STAMP=$(date +%Y%m%d-%H%M%S)

[ -f "$CS" ] || { echo "找不到 $CS"; exit 1; }
cp -p "$CS" "$CS.bak-pronoun-$STAMP"
echo "备份: $CS.bak-pronoun-$STAMP"

python3 - "$CS" <<'PY'
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()

if '_proactive_pronoun_patch' in s:
    print('· 已经加过人称规则，跳过')
    raise SystemExit

old = '''            return {
                "conv_id": conv_id,
                "history": effective_history_messages,
                "platform_context": platform_context,
                "system_prompt": original_system_prompt,
                "session_id": effective_session_id,
                "conversation": conversation,
            }'''
new = '''            # _proactive_pronoun_patch：房间状态里的人称规则。
            #
            # room_link 注入的是第三人称（「她在客厅·沙发上，抱着手柄打游戏」），
            # 但主动消息这条链路不走 room_link 的那段提示，而且会话往往没绑人格
            # （conversations.persona_id 为 None → 回退到内置的
            #  "You are a helpful and friendly assistant."，什么设定都没有）。
            # 结果就是模型把「她」当成了对方 —— 明明是自己在打游戏，
            # 却问「游戏还打着没啊，手柄都没放下吧」。
            #
            # 这段加在最终 prompt 末尾：无论用哪个人格，都先把人称讲清楚。
            original_system_prompt = (original_system_prompt or "") + (
                "\\n\\n【关于房间状态里的人称（很重要）】\\n"
                "上下文里可能夹着房间的实时状态，写法是第三人称，例如"
                "「她在客厅·沙发上，抱着手柄打游戏」「她有点累、有点渴」。\\n"
                "这里的「她」就是你**自己**，请一律当成「我」来理解：\\n"
                "- 她在打游戏 = 我在打游戏；她有点渴 = 我有点渴。\\n"
                "- 不要把「她」理解成对方（对方是主人，用「你」称呼）。\\n"
                "- 主动开口时说的是**你自己的近况**，不要反过来问对方在做什么。\\n"
                "举例：房间状态是「她在客厅打游戏」时，正确说法是"
                "「我还在打游戏呢，手柄都不肯放下」，"
                "错误说法是「游戏还打着没啊，手柄都没放下吧」。"
            )

            return {
                "conv_id": conv_id,
                "history": effective_history_messages,
                "platform_context": platform_context,
                "system_prompt": original_system_prompt,
                "session_id": effective_session_id,
                "conversation": conversation,
            }'''

if old in s:
    s = s.replace(old, new, 1)
    print('· 最终 prompt 追加「房间状态人称」规则')
else:
    print('!! 没找到 return 块（插件升级过？），请手动加')
    raise SystemExit(2)

open(p, 'w', encoding='utf-8').write(s)
PY

echo "=== 语法检查 ==="
"$PY" -m py_compile "$CS" && echo "syntax OK"

echo
echo "完成。执行：systemctl restart astrbot"
echo "验证：下次主动消息应该说的是自己的事，不再反问主人在做什么"
