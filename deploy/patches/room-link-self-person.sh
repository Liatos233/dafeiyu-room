#!/bin/bash
# 修「人称」第二次翻车：房间状态注入不再让模型自己做代词换算。
#
# 背景（为什么这不是又一次打补丁，而是把补丁拆掉）：
#   /api/home/context 以前把她的状态写成第三人称「她在客厅…」，然后插件在这里
#   补一句「下面这段里的『她』就是你自己，请当成『我』来读」。
#   这等于把「人称换算」交给模型，实测会翻车：
#     · 把「她在菜园采收」记成「Liatos 在菜园采收」（第一次翻车，注释里已记）
#     · 把自己的状态安到主人头上，问出「来说说看 又卡哪儿了」（第二次翻车）
#
#   现在 bridge 那边已经把 line 改成第二人称（【你自己此刻】你此刻在…），
#   数据源本身就是「你」，模型没有换算余地。所以这里删除那句免责补丁，
#   否则两套口径并存，反而互相干扰。
#
# 用法：bash room-link-self-person.sh && systemctl restart astrbot
# 幂等。
set -euo pipefail

F=/root/data/plugins/astrbot_plugin_room_link/main.py
[ -f "$F" ] || { echo "找不到 $F"; exit 1; }

if grep -q 'pingfang_self_person_v1' "$F"; then
  echo "· 已经是 self-person v1，跳过"
  exit 0
fi

STAMP=$(date +%Y%m%d-%H%M%S)
cp -p "$F" "$F.bak-selfperson-$STAMP"
echo "备份: $F.bak-selfperson-$STAMP"

python3 - "$F" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
orig = s

# ── 1) 删掉「请把『她』当成『我』」的免责段，以及解释它的注释 ──────────────
old_block = '''                # 房间服务给的 line 是第三人称（"她在菜园采收""她钻进被窝"）。
                # 模型有时候分不清这个「她」是自己还是别人 —— 实测记忆里出现过
                # 把「她在菜园采收」记成「Liatos 在菜园采收」。这里用一句话点明主体，
                # 不改 line 原文（改原文要动房间那边的文案，影响面更大）。
                "\\n（下面这段里的「她」就是你自己，请当成「我」来读，不要理解成主人或别人）"
'''
new_block = '''                # 房间服务已经把这段写成第二人称（【你自己此刻】你此刻在…），
                # 所以这里**不再**让模型做「她→我」的代词换算。
                # 让模型换算人称实测会翻车（把她的状态安到主人头上），
                # 数据源直接是「你」才没有歧义。
                "\\n（以下说的「你」都是你自己，不是主人）"
'''
if old_block in s:
    s = s.replace(old_block, new_block, 1)
elif '（以下说的「你」都是你自己' not in s:
    print('⚠ 没找到旧的免责段，插件可能已被改过，跳过第 1 步')
else:
    print('· 第 1 步已经是新文案')

# ── 2) 贴到用户消息末尾的那句同步简化 ────────────────────────────────────
old_tail = '（房间实时状态，以此为准；其中「她」= 你自己：{line}）'
new_tail = '（房间实时状态，以此为准：{line}）'
if old_tail in s:
    s = s.replace(old_tail, new_tail, 1)

# ── 3) 兜底状态文案也改第二人称（它同样只喂给模型/工具）─────────────────
old_status = 'line = f"她现在在{home}·{where}，{doing}"'
new_status = 'line = f"你现在在{home}·{where}，{doing}"'
if old_status in s:
    s = s.replace(old_status, new_status, 1)

if s == orig:
    print('⚠ 没有发生任何替换，请人工确认文件结构')
    sys.exit(1)

# 打标记，保证幂等
marker = '\n# pingfang_self_person_v1\n'
if 'pingfang_self_person_v1' not in s:
    s = s + marker

open(p, 'w', encoding='utf-8').write(s)
print('已写入')
PY

PY=/opt/astrbot/venv/bin/python
[ -x "$PY" ] || PY=python3
"$PY" -m py_compile "$F" && echo "main.py 语法 OK"
echo "完成。记得：systemctl restart astrbot"
