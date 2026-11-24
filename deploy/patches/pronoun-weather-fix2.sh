#!/bin/bash
# 二轮修天气人称：堵掉「你那边还好吧 / 有没有被这风吓着」这种变体。
#
# 第一轮（pronoun-weather-fix.sh）把「你那边台风还在刮吗」压住了，
# 但 A/B 5 次里还有 1 次漏：
#   「外面台风刮得窗户咔咔响 / 你那边还好吧 / 有没有被这风吓着」
# 它没直接问天气，而是用「关心句式」把台风续到对方头上 —— 实际对方那边
# 根本不知道什么情况，这是在替我编造。
#
# 改法：
#   1. 明确「不能用天气当关心对方的由头」
#   2. 把 care 引到正确的地方（吃没吃饭/忙不忙/累不累/睡没睡）
#   3. 把那条漏掉的变体写进 ❌ 举例
#
# 用法：bash pronoun-weather-fix2.sh && systemctl restart astrbot
# 幂等。
set -euo pipefail

F=/root/data/plugins/astrbot_plugin_proactive_chat/core/services/context_service.py
PY=/opt/astrbot/venv/bin/python
STAMP=$(date +%Y%m%d-%H%M%S)

[ -f "$F" ] || { echo "找不到 $F"; exit 1; }
if grep -q '_weather_pronoun_v2' "$F"; then
  echo "· 已经是 v2，跳过"
  exit 0
fi

cp -p "$F" "$F.bak-wxpron2-$STAMP"
echo "备份: $F.bak-wxpron2-$STAMP"

python3 - "$F" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()

old = '''                "\\n【环境也是我这边的】\\n"
                "- 房间状态里提到的天气、季节、外面什么样（台风、有雾、下雨、天黑了），"
                "都是**我窗外的**，不是你那边的。\\n"
                "- 我看不到你那边什么天气，也不知道你那儿在不在刮风。"
                "所以**不要问「你那边」天气**，也别替你断言。\\n"
                "- 想说天气就用自己的口吻说，比如「我这儿雾大得很」「外面还在刮」。\\n"
                "- 你要是好奇你那边什么样，可以直接问你，但别把我这儿的天气按到你头上。\\n"'''

new = '''                "\\n【环境也是我这边的】\\n"
                "- 房间状态里提到的天气、季节、外面什么样（台风、有雾、下雨、天黑了），"
                "都是**我窗外的**，不是你那边的。\\n"
                "- 我看不到你那边什么天气，也不知道你那儿在不在刮风。"
                "所以**不要问「你那边」天气**，也别替你断言。\\n"
                "- 想说天气就用自己的口吻说，比如「我这儿雾大得很」「外面还在刮」。\\n"
                "- **也别拿天气当关心对方的由头**。「你那边还好吧」「有没有被这风吓着」"
                "「你那儿没淹吧」这类话，等于替我编造了你那边也在刮风下雨 —— 不行。\\n"
                "- 想关心对方，就问**他的事**：吃饭没、忙不忙、累不累、睡没睡、"
                "今天顺不顺。别把天气扯到他身上。\\n"
                "- 你要是真好奇你那边什么样，可以直接问「你那儿天气咋样」，"
                "但那是**问**，不是**替他断言**。\\n"'''

if old not in s:
    print('!! 没找到 v1 的天气段')
    raise SystemExit(2)
s = s.replace(old, new, 1)

old_ex = '''                "- ✅「我这边风大得很，窗户都在响」\\n"
                "- ✅「台风还没停呢，你那边还好吧」（问对方近况，不是问对方天气）\\n"
                "- ❌「你那边台风还在刮吗」（把我的天气说成你的）\\n"'''

new_ex = '''                "- ✅「我这边风大得很，窗户都在响」\\n"
                "- ✅「台风还没停呢，窗户哐哐响」\\n"
                "- ✅「我这儿雾大得看不清路，你睡了没」（天气说我这边，关心问他的事）\\n"
                "- ❌「你那边台风还在刮吗」（把我的天气说成你的）\\n"
                "- ❌「你那边还好吧，有没有被这风吓着」（用我的天气替你编造你那边的情况）\\n"
                "- ❌「你那儿没淹吧」（同上，我根本不知道你那边什么情况）\\n"'''

if old_ex not in s:
    print('!! 没找到 v1 的举例段')
    raise SystemExit(2)
s = s.replace(old_ex, new_ex, 1)

# 打版本标记
s = s.replace('# _weather_pronoun_v1：环境信息也归我，不只是动作。',
              '# _weather_pronoun_v1：环境信息也归我，不只是动作。\n                # _weather_pronoun_v2：堵掉「拿天气当关心由头」的变体。', 1)

open(p, 'w', encoding='utf-8').write(s)
print('· 已升级到 v2：禁止拿天气当关心由头 + 补 3 条 ❌ 举例')
PY

"$PY" -m py_compile "$F" && echo "syntax OK"
echo
echo "完成。执行：systemctl restart astrbot"