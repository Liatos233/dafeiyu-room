#!/bin/bash
# 修「禁了句号之后，主动消息不再分段」。
#
# 因果链：
#   上一轮为了去掉句号，把人设里「不用句号」强化了 → 模型不再写句号
#   → 而分段逻辑 SENTENCE_RE 只认「句末标点（。！？；…~）或换行」
#   → 她本来就不用感叹号/问号，也很少换行，于是整段切不出来
#   → segment_decorated_chain 返回 1 条，segmented=False
#   → 日志里就只剩「LLM 已生成文本」，没有「分段回复已启用」
#   → 三句话挤成一条发出去
#
# 实测（SENTENCE_RE 复刻）：
#   有句号「…躺下。 鱼也要休息了。」      → 2 条
#   无句号用空格「…了 反正…了 我…」       → 1 条  ✗
#   有换行「…了\n反正…了\n我…」           → 3 条
#
# 两头都修：
#   1. 人设：把「想说好几句就换行」写成硬要求（每句单独占一行），
#      并说明「换行才是分段的方式，句号不是」
#   2. 代码兜底：split_text 在整段切不出多句时，按空格/U+3000 再切一次
#      （每段 ≥4 字才切，避免把「好的 呀」这种切碎）
#
# 用法（AstrBot 所在机器，root）：
#   bash proactive-split-fix.sh
#   systemctl restart astrbot
#
# 幂等。
set -euo pipefail

PLUGINS=${PLUGINS:-/root/data/plugins}
SS="$PLUGINS/astrbot_plugin_proactive_chat/core/services/sender_service.py"
DB=${DB:-/root/data/data_v4.db}
PY=${PY:-/opt/astrbot/venv/bin/python}
STAMP=$(date +%Y%m%d-%H%M%S)

# ── 1. 代码：空格兜底 ───────────────────────────────────────────────────
if [ -f "$SS" ]; then
  cp -p "$SS" "$SS.bak-splitfix-$STAMP"
  python3 - "$SS" <<'PY'
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()

if '_split_fallback_patch' in s:
    print('· 代码已加兜底')
    raise SystemExit

old = '''        segments: list[str] = []
        for part in self.SENTENCE_RE.findall(body):
            part = part.strip()
            if cleanup:
                part = cleanup.sub("", part).strip()
            if part:
                segments.append(part)
        return segments or [body]'''

new = '''        segments: list[str] = []
        for part in self.SENTENCE_RE.findall(body):
            part = part.strip()
            if cleanup:
                part = cleanup.sub("", part).strip()
            if part:
                segments.append(part)

        # _split_fallback_patch：人格要求「不用句号」，于是模型常写成
        # 「好，那不折腾了 反正评论挂上去了 我去躺会儿」（用空格断句）。
        # SENTENCE_RE 只认句末标点和换行，这种整段切不出来 →
        # 分段失效、三句话挤成一条。这里补一条兜底：整段没切出多句时，
        # 按空格/U+3000 再切（每段够长才切，避免把「好 呀 嗯」切碎）。
        if len(segments) <= 1 and body and "\\n" not in body:
            pieces = re.split(r"[ \\u3000]+", body)
            pieces = [x.strip() for x in pieces if x and x.strip()]
            if len(pieces) >= 2 and all(len(x) >= 4 for x in pieces):
                segments = pieces

        return segments or [body]'''

if old not in s:
    print('!! 没找到 split_text 主体')
    raise SystemExit(2)
s = s.replace(old, new, 1)
open(p, 'w', encoding='utf-8').write(s)
print('· split_text 加空格兜底')
PY
  "$PY" -m py_compile "$SS" && echo "sender_service OK"
fi

# ── 2. 人设：换行才是分段方式 ───────────────────────────────────────────
if [ -f "$DB" ]; then
  cp -p "$DB" "$DB.bak-splitfix-$STAMP"
  python3 - "$DB" <<'PY'
import sqlite3, sys

db = sys.argv[1]
con = sqlite3.connect(db)
cur = con.cursor()
cur.execute("SELECT system_prompt FROM personas WHERE persona_id='大肥鱼'")
row = cur.fetchone()
if not row:
    print('· 找不到大肥鱼人格，跳过')
    raise SystemExit
p = row[0]

if '_newline_split_v4' in p:
    print('· 人设已改过')
    raise SystemExit

old = ('- **不用句号**（。和 . 都不用，句末也不用）。想说好几句就换行，'
       '别用句号把句子隔开 —— 拼成长条时最容易犯这个错。  <!-- _no_period_v2 -->')
new = ('- **不用句号**（。和 . 都不用，句末也不用）。想说好几句就把每句**单独占一行**'
       '（换行才是分段的方式，句号不是）\n'
       '- **每说完一句话就按一次回车**。不要把几句话用空格连成一大段 —— '
       '换行发出去才像在 QQ 上随手打字，连成一段像写小作文  <!-- _newline_split_v4 -->')

if old in p:
    p2 = p.replace(old, new, 1)
    cur.execute("UPDATE personas SET system_prompt=? WHERE persona_id='大肥鱼'", (p2,))
    con.commit()
    print(f'· 人设已更新（{len(p)} -> {len(p2)} 字）')
else:
    print('· 没找到旧规则（可能已改），跳过')
con.close()
PY
fi

echo
echo "完成。执行：systemctl restart astrbot"
