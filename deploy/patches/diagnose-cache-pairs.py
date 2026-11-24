#!/usr/bin/env python3
"""深挖：低命中调用是不是「一次消息触发两次调用」里的第一次。

观察到：同一分钟内 18.9% → 91.6%。
如果一次用户消息触发两次 LLM 调用（例如"要不要主动开口"判定 + 正式回复），
那么第一次冷、第二次热是合理的——第二次能复用第一次建立的前缀。

要验证的：
  1. 低命中调用后面紧跟着的是不是高命中（成对）
  2. 两次间隔多少秒
  3. 低命中调用前一次距它多久（是不是缓存过期）
"""
import sqlite3
import datetime
import collections

DB = "/root/data/data_v4.db"
c = sqlite3.connect(DB)
cur = c.execute("""
    SELECT start_time, token_input_cached, token_input_other, token_output
    FROM provider_stats
    WHERE status='completed' AND (token_input_cached+token_input_other) > 0
    ORDER BY start_time
""")
rows = cur.fetchall()

recs = []
for t, ca, ot, out in rows:
    tot = (ca or 0) + (ot or 0)
    recs.append({
        "t": t, "cached": ca or 0, "other": ot or 0, "out": out or 0,
        "tot": tot, "rate": (ca or 0) / tot * 100 if tot else 0,
    })

print(f"总 {len(recs)} 次\n")

# ── 1. 低命中后紧接着的那次，命中率如何 ────────────────
print("=" * 68)
print("① 低命中调用 → 紧随其后那次 的命中率")
print("=" * 68)
pairs = []
for i in range(len(recs) - 1):
    a, b = recs[i], recs[i + 1]
    if a["rate"] < 30:
        gap = b["t"] - a["t"]
        pairs.append((a, b, gap))

print(f"低命中共 {sum(1 for r in recs if r['rate']<30)} 次，其中后面还有调用的 {len(pairs)} 次")
follow_high = sum(1 for a, b, g in pairs if b["rate"] >= 60)
follow_low = sum(1 for a, b, g in pairs if b["rate"] < 30)
print(f"  紧随其后高命中(≥60%): {follow_high} ({follow_high/len(pairs)*100:.1f}%)")
print(f"  紧随其后仍低命中:      {follow_low} ({follow_low/len(pairs)*100:.1f}%)")
print()

# 间隔分布
if pairs:
    gaps = sorted(g for a, b, g in pairs)
    import statistics
    print(f"  间隔秒数：中位数 {statistics.median(gaps):.1f}s，"
          f"最小 {gaps[0]:.1f}s，最大 {gaps[-1]:.0f}s")
    bucket = collections.Counter()
    for g in gaps:
        if g < 2: bucket["<2s"] += 1
        elif g < 10: bucket["2-10s"] += 1
        elif g < 60: bucket["10-60s"] += 1
        elif g < 600: bucket["1-10min"] += 1
        else: bucket[">10min"] += 1
    for k in ["<2s", "2-10s", "10-60s", "1-10min", ">10min"]:
        if bucket.get(k):
            print(f"    {k:10s} {bucket[k]:4d}")
print()

# ── 2. 低命中调用「距上一次调用」多久 ──────────────────
print("=" * 68)
print("② 低命中调用距上一次调用多久（是不是缓存过期）")
print("=" * 68)
gaps_before = []
for i in range(1, len(recs)):
    if recs[i]["rate"] < 30:
        gaps_before.append(recs[i]["t"] - recs[i - 1]["t"])

if gaps_before:
    import statistics
    print(f"  样本 {len(gaps_before)} 个")
    print(f"  中位数 {statistics.median(gaps_before):.1f}s")
    bucket = collections.Counter()
    for g in gaps_before:
        if g < 5: bucket["<5s（同一轮连发）"] += 1
        elif g < 300: bucket["5s-5min"] += 1
        elif g < 3600: bucket["5-60min"] += 1
        else: bucket[">1小时（很可能过期）"] += 1
    for k in ["<5s（同一轮连发）", "5s-5min", "5-60min", ">1小时（很可能过期）"]:
        if bucket.get(k):
            print(f"    {k:22s} {bucket[k]:4d}")

# 对照：正常调用的前置间隔
gaps_high = []
for i in range(1, len(recs)):
    if recs[i]["rate"] >= 60:
        gaps_high.append(recs[i]["t"] - recs[i - 1]["t"])
if gaps_high:
    import statistics
    print(f"\n  对照·正常调用前置间隔 中位数 {statistics.median(gaps_high):.1f}s")
print()

# ── 3. 成本归因 ────────────────────────────────────────
print("=" * 68)
print("③ 成本归因")
print("=" * 68)
low_unc = sum(r["other"] for r in recs if r["rate"] < 30)
all_unc = sum(r["other"] for r in recs)
print(f"  低命中组未命中 tokens: {low_unc:,}")
print(f"  全部未命中 tokens:     {all_unc:,}")
print(f"  低命中占未命中成本:    {low_unc/all_unc*100:.1f}%")
print(f"  → 折算 {low_unc/1e6:.2f} 元（按 1 元/百万）")
print()
print(f"  如果能消除这些低命中，可省约 {low_unc/1e6:.2f} 元（全量 {len(recs)} 次）")

c.close()
