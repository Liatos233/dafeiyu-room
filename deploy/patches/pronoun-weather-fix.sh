#!/bin/bash
# ⚠️ DEPRECATED —— 已被 deploy/patches/migrate-pronoun-to-persona.sh 取代。
#
# 这个脚本往 context_service.py 里插提示词，属于技术债（见迁移脚本头部说明）。
# 规则现在住在 personas 表里，代码侧已恢复原状。
# **不要再运行本脚本**，否则会在代码里重新插入一份，和 persona 里的重复。
#
# 保留此文件仅为历史记录：它记录了「为什么当初这么改」以及两轮踩的坑。
# ---------------------------------------------------------------------------
# 修「你那边台风还在刮吗」——天气的人称归错了。
#
# 现象：她说「你那边台风还在刮吗」。天气是**她窗外**的，主人那边完全未知。
#
# 两层根因：
#   1. bridge 的 /api/home/context 里天气是个裸片段「天气：台风」，
#      没有主语。同一句里前半截是「她在客厅…」（第三人称自己），
#      后半截突然出现「天气」，模型就按对话习惯理解成「对方那边」。
#   2. proactive_chat 的人称规则只钉了「动作归属」
#      （「她在打游戏 = 我在打游戏」），**没提环境/天气**，
#      所以「天气」这类非动作信息漏在规则之外。
#
# 修法（两层都改）：
#   A. bridge 注入改成「她窗外天气：台风」——带归属主语
#   B. 人称规则扩一段「环境也归我」：天气/季节/外面什么样都是我这边的，
#      不知道主人那边，不要替主人断言，也不要问「你那边」天气。
#
# 用法：bash pronoun-weather-fix.sh && systemctl restart astrbot
# 幂等。
set -euo pipefail

STAMP=$(date +%Y%m%d-%H%M%S)

# ── A. bridge：天气注入带归属 ────────────────────────────────────────
BRIDGE=/opt/dafeiyu-room/src/bridge.js
if [ -f "$BRIDGE" ]; then
  if grep -q '她窗外天气' "$BRIDGE"; then
    echo "· bridge 天气归属已存在，跳过"
  else
    cp -p "$BRIDGE" "$BRIDGE.bak-wxown-$STAMP"
    python3 - "$BRIDGE" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
old = "env.weatherLabel ? `天气：${env.weatherLabel}` : '',"
new = ("env.weatherLabel ? `她窗外天气：${env.weatherLabel}` : '',")
if old not in s:
    print('!! bridge 没找到天气注入行')
    raise SystemExit(2)
s = s.replace(old, new, 1)
open(p, 'w', encoding='utf-8').write(s)
print('· bridge：天气注入改为「她窗外天气：…」')
PY
    node --check "$BRIDGE" && echo "  bridge syntax OK"
  fi
else
  echo "! 找不到 $BRIDGE"
fi

# ── B. proactive_chat：人称规则补「环境也归我」 ──────────────────────
F=/root/data/plugins/astrbot_plugin_proactive_chat/core/services/context_service.py
[ -f "$F" ] || { echo "找不到 $F"; exit 1; }

if grep -q '_weather_pronoun_v1' "$F"; then
  echo "· 人称规则已含天气段，跳过"
else
  cp -p "$F" "$F.bak-wxpron-$STAMP"
  echo "备份: $F.bak-wxpron-$STAMP"

  python3 - "$F" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()

# 在「唯一的禁区」那条之后、举例之前插入环境归属段
anchor = '''                "\\n举例（房间状态是「她在客厅打游戏」）：\\n"'''

insert = '''                # _weather_pronoun_v1：环境信息也归我，不只是动作。
                "\\n【环境也是我这边的】\\n"
                "- 房间状态里提到的天气、季节、外面什么样（台风、有雾、下雨、天黑了），"
                "都是**我窗外的**，不是你那边的。\\n"
                "- 我看不到你那边什么天气，也不知道你那儿在不在刮风。"
                "所以**不要问「你那边」天气**，也别替你断言。\\n"
                "- 想说天气就用自己的口吻说，比如「我这儿雾大得很」「外面还在刮」。\\n"
                "- 你要是好奇你那边什么样，可以直接问你，但别把我这儿的天气按到你头上。\\n"
                "\\n举例（房间状态里有「她窗外天气：台风」）：\\n"
                "- ✅「我这边风大得很，窗户都在响」\\n"
                "- ✅「台风还没停呢，你那边还好吧」（问对方近况，不是问对方天气）\\n"
                "- ❌「你那边台风还在刮吗」（把我的天气说成你的）\\n"
'''

if anchor not in s:
    print('!! 没找到举例锚点')
    raise SystemExit(2)

s = s.replace(anchor, insert + anchor, 1)
open(p, 'w', encoding='utf-8').write(s)
print('· proactive_chat：人称规则补了「环境也归我」+ 3 条举例')
PY

  /opt/astrbot/venv/bin/python -m py_compile "$F" && echo "  syntax OK"
fi

echo
echo "完成。执行：systemctl restart astrbot（bridge 也要重启）"
echo "  systemctl restart dafeiyu-room astrbot"
