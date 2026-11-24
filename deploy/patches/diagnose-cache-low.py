#!/usr/bin/env python3
"""诊断：命中率 < 30% 的调用有什么共同点。

假设候选：
  H1 新会话 / conversation_id 变了 → 前缀整体没缓存过（最可能）
  H2 某个 agent_type（如 internal）走另一条路径
  H3 集中在某个 provider / model
  H4 会话历史特别长（超过缓存能覆盖的窗口）
  H5 特定时间段（凌晨批量任务）
  H6 umo 切换（私聊/群聊/房间之间）
"""
import sqlite3
import datetime
import collections

DB = "/root/data/data_v4.db"
c = sqlite3.connect(DB)
cur = c.cursor()

cur.execute("""
    SELECT start_time, token_input_cached, token_input_other, token_output,
           conversation_id, agent_type, umo, provider_model
    FROM provider_stats
    WHERE status = 'completed' AND (token_input_cached + token_input_other) > 0
    ORDER BY start_time
""")
rows = cur.fetchall()
cols = ["t", "cached", "other", "out", "conv", "agent", "umo", "model"]
recs = [dict(zip(cols, r)) for r in rows]

for r in recs:
    tot = (r["cached"] or 0) + (r["other"] or 0)
    r["total"] = tot
    r["rate"] = (r["cached"] or 0) / tot * 100 if tot else 0

low = [r for r in recs if r["rate"] < 30]
high = [r for r in recs if r["rate"] >= 30]

print(f"总 {len(recs)} 次 | 低命中 {len(low)} 次 ({len(low)/len(recs)*100:.1f}%) | 正常 {len(high)} 次")
print()

def show(title, counter, denom):
    print(f"=== {title} ===")
    for k, v in counter.most_common(8):
        pct = v / denom * 100 if denom else 0
        print(f"  {str(k)[:46]:48s} {v:5d}  ({pct:5.1f}%)")
    print()

# ── H2: agent_type ────────────────────────────────────
show("H2 · agent_type 分布（低命中组）",
     collections.Counter(r["agent"] for r in low), len(low))
show("H2 · agent_type 分布（正常组，对照）",
     collections.Counter(r["agent"] for r in high), len(high))

# ── H3: model ─────────────────────────────────────────
show("H3 · model 分布（低命中组）",
     collections.Counter(r["model"] for r in low), len(low))

# ── H6: umo ───────────────────────────────────────────
show("H6 · umo 分布（低命中组）",
     collections.Counter(r["umo"] for r in low), len(low))

# ── H1: 会话是否第一次出现 ─────────────────────────────
print("=== H1 · 低命中调用在各自会话中的序号 ===")
first_seen = {}
seq_of_call = []
for r in recs:
    conv = r["conv"]
    first_seen[conv] = first_seen.get(conv, -1) + 1
    seq_of_call.append((r, first_seen[conv]))

low_seq1 = sum(1 for r, s in seq_of_call if r["rate"] < 30 and s == 0)
low_total = len(low)
print(f"  低命中里「该会话第 1 次调用」: {low_seq1} / {low_total} ({low_seq1/low_total*100:.1f}%)")
high_seq1 = sum(1 for r, s in seq_of_call if r["rate"] >= 30 and s == 0)
print(f"  正常里「该会话第 1 次调用」:   {high_seq1} / {len(high)} ({high_seq1/len(high)*100:.1f}%)")
print()

# 会话数量
convs_low = set(r["conv"] for r in low)
convs_all = set(r["conv"] for r in recs)
print(f"  低命中涉及 {len(convs_low)} 个会话 / 总 {len(convs_all)} 个会话")
print()

# ── H4: 上下文长度 ────────────────────────────────────
print("=== H4 · 总输入 token 大小对比 ===")
import statistics
print(f"  低命中组：中位数 {statistics.median(r['total'] for r in low):,.0f} tokens")
print(f"  正常组：  中位数 {statistics.median(r['total'] for r in high):,.0f} tokens")
print(f"  低命中组：最大值 {max(r['total'] for r in low):,}")
print(f"  正常组：  最大值 {max(r['total'] for r in high):,}")
print()

# ── H5: 时间段 ────────────────────────────────────────
print("=== H5 · 低命中按小时分布 ===")
byhour = collections.Counter(datetime.datetime.fromtimestamp(r["t"]).hour for r in low)
for h in range(24):
    if byhour.get(h):
        bar = "█" * min(40, byhour[h] // 2)
        print(f"  {h:02d}时 {byhour[h]:4d} {bar}")
print()

# ── 关键：同一会话内连续调用的命中率走势 ────────────────
print("=== 同一会话内的连续走势（取样本最多的 2 个会话）===")
byconv = collections.defaultdict(list)
for r in recs:
    byconv[r["conv"]].append(r)
top = sorted(byconv.items(), key=lambda kv: -len(kv[1]))[:2]
for conv, items in top:
    print(f"\n  会话 {str(conv)[:20]}...  共 {len(items)} 次")
    for r in items[-12:]:
        t = datetime.datetime.fromtimestamp(r["t"]).strftime("%m-%d %H:%M")
        bar = "█" * int(r["rate"] / 3)
        print(f"    {t}  {r['rate']:5.1f}%  {bar}")

c.close()
