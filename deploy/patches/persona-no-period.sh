#!/bin/bash
# 强人设里「不用句号」这一条：原来只提一句、还和别的规则挤在同一行，
# 而且示范句自己就在用句号（自相矛盾）。
#
# 实测：2087 条发送记录里 17 条带「。」（0.8%）。逐条看下来，句号几乎全部
# 出现在「一句话说完 + 空格 + 下一句」的接缝处 —— 也就是她把多个短句
# 拼成一条消息时，用句号当分隔符。（单句回复基本没有句号，比如「鱼也要休息了」）
#
# 人设现在的写法：
#   - 不用句号。开心的时候句子更短。困了就别硬讲道理。
# 问题：
#   ① 「不用句号」和「句子更短」「困了别讲道理」混在一条 bullet 里，权重被稀释
#   ② 这一句本身就在用句号结尾，是反面示范
#   ③ 没有说明「要分句就换行，不要用句号隔开」
#
# 改法：拆成独立的一条，去掉句号示范，并明确「分句用换行、不用句号当分隔符」。
#
# 用法（AstrBot 所在机器，root）：
#   bash persona-no-period.sh
#   systemctl restart astrbot
#
# 幂等。
set -euo pipefail

DB=${DB:-/root/data/data_v4.db}
PY=${PY:-/opt/astrbot/venv/bin/python}
STAMP=$(date +%Y%m%d-%H%M%S)

[ -f "$DB" ] || { echo "找不到 $DB"; exit 1; }

BAK="$DB.bak-period-$STAMP"
cp -p "$DB" "$BAK"
echo "备份: $BAK"

python3 - "$DB" <<'PY'
import sqlite3, sys

db = sys.argv[1]
con = sqlite3.connect(db)
cur = con.cursor()
cur.execute("SELECT system_prompt FROM personas WHERE persona_id='大肥鱼'")
row = cur.fetchone()
if not row:
    print('!! 找不到大肥鱼人格'); sys.exit(2)
p = row[0]

if '_no_period_v2' in p:
    print('· 已经改过，跳过')
    sys.exit(0)

old = '- 不用句号。开心的时候句子更短。困了就别硬讲道理。'
new = (
    '- 开心的时候句子更短，困了就别硬讲道理\n'
    '- **不用句号**（。和 . 都不用，句末也不用）。想说好几句就换行，'
    '别用句号把句子隔开 —— 拼成长条时最容易犯这个错。'
    '  <!-- _no_period_v2 -->'
)

if old not in p:
    print('!! 没找到原来的「不用句号」那句，请人工确认')
    print('   实际包含「不用句号」的片段：')
    i = p.find('不用句号')
    print('   ', repr(p[max(0, i - 60):i + 80]) if i >= 0 else '(没有)')
    sys.exit(2)

p2 = p.replace(old, new, 1)
cur.execute("UPDATE personas SET system_prompt=? WHERE persona_id='大肥鱼'", (p2,))
con.commit()
print(f'· 已更新（{len(p)} -> {len(p2)} 字）')
con.close()
PY

echo
echo "完成。执行：systemctl restart astrbot"
