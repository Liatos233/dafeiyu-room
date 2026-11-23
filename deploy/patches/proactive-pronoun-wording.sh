#!/bin/bash
# 修正主动消息人称规则的措辞：不是「只能说自己」，而是「动作归属不能错」。
#
# 上一版写成了「主动开口时说的是你自己的近况，不要反过来问对方在做什么」——
# 这把「人称正确」和「只能说自己」混为一谈了。她当然可以问主人在忙什么、
# 也可以说自己的事，两种都对；错的只是**把房间状态里自己的动作算到主人头上**。
#
# 用法（AstrBot 所在机器，root）：
#   bash proactive-pronoun-wording.sh
#   systemctl restart astrbot
#
# 幂等：已经是新措辞时跳过。
set -euo pipefail

PLUGINS=${PLUGINS:-/root/data/plugins}
CS="$PLUGINS/astrbot_plugin_proactive_chat/core/services/context_service.py"
PY=${PY:-/opt/astrbot/venv/bin/python}
STAMP=$(date +%Y%m%d-%H%M%S)

[ -f "$CS" ] || { echo "找不到 $CS"; exit 1; }

if grep -q '_pronoun_wording_v2' "$CS"; then
  echo "· 已经是新措辞，跳过"
  exit 0
fi

cp -p "$CS" "$CS.bak-pronoun2-$STAMP"
echo "备份: $CS.bak-pronoun2-$STAMP"

python3 - "$CS" <<'PY'
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()

old = '''            original_system_prompt = (original_system_prompt or "") + (
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
            )'''

new = '''            # _pronoun_wording_v2：只钉「动作归属」，不限制「能不能问主人」。
            original_system_prompt = (original_system_prompt or "") + (
                "\\n\\n【关于房间状态里的人称（只影响动作归属，不限制你说什么）】\\n"
                "上下文里可能夹着房间的实时状态，写法是第三人称，例如"
                "「她在客厅·沙发上，抱着手柄打游戏」「她有点累、有点渴」。\\n"
                "这里的「她」就是**你自己**，要当成「我」来理解：\\n"
                "- 她在打游戏 = 我在打游戏；她有点渴 = 我有点渴。\\n"
                "- 对应地，房间状态里写的这些事**不要安到主人头上**。\\n"
                "- 主人（对方）用「你」称呼；房间状态不会描述主人在做什么。\\n"
                "\\n至于说什么，随你：\\n"
                "- 可以说自己的近况（我在打游戏、我有点渴）。\\n"
                "- 也可以问主人在忙什么、吃没吃饭、累不累 —— 关心对方是正常的。\\n"
                "- 唯一的禁区：把**自己**正在做的事说成对方在做。\\n"
                "\\n举例（房间状态是「她在客厅打游戏」）：\\n"
                "- ✅「我还在打游戏呢，手柄都没放下」\\n"
                "- ✅「我打着游戏呢，你那边忙完了没」\\n"
                "- ✅「你吃饭了没，我这边手柄都不肯放下」\\n"
                "- ❌「游戏还打着没啊，手柄都没放下吧」（把自己的事当成对方的事）"
            )'''

if old in s:
    s = s.replace(old, new, 1)
    open(p, 'w', encoding='utf-8').write(s)
    print('· 措辞已修正（保留「可以问主人」，只钉动作归属）')
else:
    print('!! 没找到上一版规则原文，可能已被手改；请人工确认')
    raise SystemExit(2)
PY

"$PY" -m py_compile "$CS" && echo "syntax OK"
echo
echo "完成。执行：systemctl restart astrbot"
