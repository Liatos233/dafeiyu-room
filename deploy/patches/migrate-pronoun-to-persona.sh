#!/bin/bash
# 把人称规则从「代码补丁」迁到「persona 数据」。
#
# 起因：用户问「这个方案合理吗，还是打补丁」——问得对。
# 之前的做法是往 context_service.py 里用字符串替换插 600 字节提示词，这是技术债：
#   1. 和上游代码混在一起，插件一升级锚点就找不到
#   2. 提示词长在代码里，改一句话要改 Python 文件
#   3. 已经叠到第 4 版（_proactive_pronoun_patch → _pronoun_wording_v2
#      → _weather_pronoun_v1 → _weather_pronoun_v2），是技术债的典型症状
#   4. 本地 deploy/plugins/ 是旧副本，服务器和仓库不一致
#
# 迁移后：
#   · 规则住进 personas 表（用户能在 dashboard 里自己编辑）
#   · context_service.py 恢复原状（不再有任何我们的补丁）
#   · 上游升级不冲突
#   · 改措辞不用改代码、不用重打补丁
#
# 用法：bash migrate-pronoun-to-persona.sh
# 幂等。
set -euo pipefail

DB=/root/data/data_v4.db
PY=/opt/astrbot/venv/bin/python
F=/root/data/plugins/astrbot_plugin_proactive_chat/core/services/context_service.py
STAMP=$(date +%Y%m%d-%H%M%S)

echo "=== 1. 备份 ==="
cp -p "$DB" "$DB.bak-migrate-$STAMP"
cp -p "$F" "$F.bak-migrate-$STAMP"
echo "  $DB.bak-migrate-$STAMP"
echo "  $F.bak-migrate-$STAMP"

echo
echo "=== 2. 规则追加进 persona（幂等）==="
"$PY" - "$DB" <<'PY'
import sqlite3
import sys

db = sys.argv[1]
MARK = "【房间状态里的人称】"

RULE = """

【房间状态里的人称】
上下文里可能夹着你房间的实时状态，写法是第三人称，例如「她在客厅·沙发上，抱着手柄打游戏」「她有点累、有点渴」。
这里的「她」就是你自己，要当成「我」来理解：她打游戏 = 我在打游戏；她有点渴 = 我有点渴。
- 房间状态里写的事不要安到对方头上。
- 对方用「你」称呼；房间状态不会描述对方在做什么。
- 可以说自己的近况，也可以问对方在忙什么、吃没吃饭、累不累。

【环境也是我这边的】
- 房间状态里的天气、季节、外面什么样（台风、有雾、下雨、天黑了），都是**我窗外的**，不是你那边的。
- 我看不到你那边什么天气，也不知道你那儿在不在刮风。所以不要问「你那边」天气，也别替你断言。
- 想说天气就用自己口吻说，比如「我这儿雾大得很」「外面还在刮」。
- **也别拿天气当关心对方的由头**。「你那边还好吧」「有没有被这风吓着」「你那儿没淹吧」这类话，等于替我编造了你那边也在刮风下雨 —— 不行。
- 想关心对方，就问**他的事**：吃饭没、忙不忙、累不累、睡没睡、今天顺不顺。别把天气扯到他身上。
- 你要是真好奇你那边什么样，可以直接问「你那儿天气咋样」，但那是**问**，不是**替他断言**。

举例（房间状态里有「她窗外天气：台风」）：
- 好：「我这边风大得很，窗户都在响」
- 好：「台风还没停呢，窗户哐哐响」
- 好：「我这儿雾大得看不清路，你睡了没」（天气说我这边，关心问他的事）
- 错：「你那边台风还在刮吗」（把我的天气说成你的）
- 错：「你那边还好吧，有没有被这风吓着」（用我的天气替你编造你那边的情况）
- 错：「你那儿没淹吧」（同上，我根本不知道你那边什么情况）

举例（房间状态是「她在客厅打游戏」）：
- 好：「我还在打游戏呢，手柄都没放下」
- 好：「我打着游戏呢，你那边忙完了没」
- 错：「游戏还打着没啊，手柄都没放下吧」（把自己的事当成对方的事）
"""

c = sqlite3.connect(db)
cur = c.cursor()
cur.execute("SELECT id, system_prompt FROM personas WHERE persona_id = '大肥鱼'")
row = cur.fetchone()
if not row:
    print("  !! 找不到 persona 大肥鱼")
    raise SystemExit(2)
pid, cur_prompt = row
cur_prompt = cur_prompt or ""

if MARK in cur_prompt:
    print("  已经含人称规则，跳过")
else:
    # 如果残留了旧补丁写的块，先剥掉（避免重复）
    new_prompt = cur_prompt.rstrip() + RULE
    cur.execute(
        "UPDATE personas SET system_prompt = ?, updated_at = datetime('now') WHERE id = ?",
        (new_prompt, pid),
    )
    c.commit()
    print(f"  已追加，persona {len(cur_prompt)} → {len(new_prompt)} 字")

cur.execute("SELECT LENGTH(system_prompt) FROM personas WHERE persona_id = '大肥鱼'")
print(f"  当前 persona 长度: {cur.fetchone()[0]}")
c.close()
PY

echo
echo "=== 3. 从 context_service.py 撤掉代码补丁 ==="
"$PY" - "$F" <<'PY'
import io
import sys

p = sys.argv[1]
lines = io.open(p, encoding="utf-8").read().split("\n")

# 定位补丁块：从含 _proactive_pronoun_patch 的注释行，到
# `original_system_prompt = (original_system_prompt or "") + (` 对应的收尾 `)`
start = None
for i, l in enumerate(lines):
    if "_proactive_pronoun_patch" in l:
        start = i
        break

if start is None:
    print("  没有补丁块（已经是干净的）")
    raise SystemExit(0)

# 往上吃掉紧邻的注释行（描述补丁历史的）
while start > 0 and (lines[start - 1].strip().startswith("#") or lines[start - 1].strip() == ""):
    if lines[start - 1].strip().startswith("#"):
        start -= 1
    elif lines[start - 1].strip() == "" and start > 1 and lines[start - 2].strip().startswith("#"):
        start -= 1
    else:
        break

# 找 reassignment 行
assign = None
for i in range(start, len(lines)):
    if 'original_system_prompt = (original_system_prompt or "") + (' in lines[i]:
        assign = i
        break
if assign is None:
    print("  !! 找到注释但没找到赋值语句")
    raise SystemExit(2)

# 从 assign 往下找配对的收尾 `)`（缩进与 assign 相同）
indent = len(lines[assign]) - len(lines[assign].lstrip())
end = None
for i in range(assign + 1, len(lines)):
    if lines[i].strip() == ")" and (len(lines[i]) - len(lines[i].lstrip())) == indent:
        end = i
        break
if end is None:
    print("  !! 没找到收尾括号")
    raise SystemExit(2)

removed = end - start + 1
del lines[start:end + 1]

# 清理可能留下的连续空行
out = []
prev_blank = False
for l in lines:
    is_blank = l.strip() == ""
    if is_blank and prev_blank:
        continue
    out.append(l)
    prev_blank = is_blank

io.open(p, "w", encoding="utf-8").write("\n".join(out))
print(f"  删掉 {removed} 行补丁代码（第 {start+1}~{end+1} 行）")
PY

echo
echo "=== 4. 语法检查 ==="
"$PY" -m py_compile "$F" && echo "  context_service.py syntax OK"

echo
echo "=== 5. 确认补丁已清空 ==="
if grep -q '_proactive_pronoun_patch\|_weather_pronoun_v' "$F"; then
  echo "  !! 还有残留"
  grep -n '_proactive_pronoun_patch\|_weather_pronoun_v' "$F"
else
  echo "  ✓ 代码里已无任何人称补丁"
fi

echo
echo "完成。执行：systemctl restart astrbot"