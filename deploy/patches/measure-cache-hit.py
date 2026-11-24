#!/usr/bin/env python3
"""量化 persona 改动对 prompt 缓存命中率的影响。

数据源：AstrBot 的 provider_stats 表
  token_input_cached = 命中的输入 token
  token_input_other  = 未命中（要重新算）的输入 token

命中率 = cached / (cached + other)

要回答的问题：
  1. 基线命中率是多少（改 persona 之前）
  2. 改 persona 之后命中率有没有掉
  3. 如果掉，掉了多少、每次多花多少钱

关键时间点（北京时间）：
  2026-11-24 20:0x  加天气人称规则到 context_service.py（代码补丁，v1）
  2026-11-24 23:18  升级到 v2（代码补丁）
  2026-11-24 23:51  迁移到 persona（persona 1787 → 2600 字）
"""
import sqlite3
import datetime

DB = "/root/data/data_v4.db"

# 关键时间点（Unix 秒）
T_CODE_V1 = 1795531200   # 2026-11-24 20:00 左右
T_CODE_V2 = 1795533480   # 2026-11-24 23:18
T_PERSONA = 1795535460   # 2026-11-24 23:51

c = sqlite3.connect(DB)
cur = c.cursor()

cur.execute("""
    SELECT start_time, token_input_cached, token_input_other, token_output, umo
    FROM provider_stats
    WHERE status = 'completed'
      AND (token_input_cached + token_input_other) > 0
    ORDER BY start_time
""")
rows = cur.fetchall()
print(f"总记录: {len(rows)}")
print()


def agg(subset, label):
    if not subset:
        print(f"  {label}: 无数据")
        return None
    cached = sum(r[1] or 0 for r in subset)
    other = sum(r[2] or 0 for r in subset)
    out = sum(r[3] or 0 for r in subset)
    total = cached + other
    rate = cached / total * 100 if total else 0
    print(f"  {label}")
    print(f"    调用 {len(subset):5d} 次 | 命中 {cached:>9,} | 未命中 {other:>9,} | 输出 {out:>7,}")
    print(f"    命中率 {rate:5.1f}%")
    return {"n": len(subset), "cached": cached, "other": other, "out": out, "rate": rate}


def ts(t):
    return datetime.datetime.fromtimestamp(t).strftime("%m-%d %H:%M")


# ── 按天看 ──────────────────────────────────────────────
print("=" * 70)
print("按自然日")
print("=" * 70)
byday = {}
for r in rows:
    d = datetime.datetime.fromtimestamp(r[0]).strftime("%m-%d")
    byday.setdefault(d, []).append(r)
for d in sorted(byday):
    agg(byday[d], d)

# ── 按阶段看（今天） ─────────────────────────────────────
print()
print("=" * 70)
print("今天（11-24）分段：代码补丁前 / 代码补丁后 / 迁到 persona 后")
print("=" * 70)
today = [r for r in rows if datetime.datetime.fromtimestamp(r[0]).strftime("%m-%d") == "11-24"]

a = [r for r in today if r[0] < T_CODE_V1]
b = [r for r in today if T_CODE_V1 <= r[0] < T_PERSONA]
d = [r for r in today if r[0] >= T_PERSONA]

ra = agg(a, f"① 代码补丁前（今天 00:00 ~ 20:00）")
rb = agg(b, f"② 代码补丁期间（20:00 ~ 23:51）")
rd = agg(d, f"③ 迁到 persona 后（23:51 之后）")

# ── 最近 N 次滚动命中率（更能反映"当前"状态） ──────────────
print()
print("=" * 70)
print("最近 40 次调用的滚动命中率（每 10 次一组）")
print("=" * 70)
recent = rows[-40:]
for i in range(0, len(recent), 10):
    chunk = recent[i:i + 10]
    cached = sum(r[1] or 0 for r in chunk)
    other = sum(r[2] or 0 for r in chunk)
    rate = cached / (cached + other) * 100 if (cached + other) else 0
    t0 = ts(chunk[0][0])
    t1 = ts(chunk[-1][0])
    print(f"  {t0} ~ {t1}  命中率 {rate:5.1f}%  (命中 {cached:>7,} / 未命中 {other:>7,})")

# ── 成本估算 ────────────────────────────────────────────
print()
print("=" * 70)
print("成本影响估算（deepseek 定价：命中 0.02 / 未命中 1 / 输出 4，单位：元每百万 token）")
print("=" * 70)
PRICE_HIT = 0.02
PRICE_MISS = 1.0
PRICE_OUT = 4.0


def cost(r):
    if not r:
        return 0
    return (r["cached"] * PRICE_HIT + r["other"] * PRICE_MISS + r["out"] * PRICE_OUT) / 1e6


if ra and rd:
    ca, cd = cost(ra), cost(rd)
    print(f"  代码补丁前：{ra['n']} 次 共 {ca:.4f} 元，单次均 {ca/ra['n']*1000:.3f} 厘")
    print(f"  迁 persona 后：{rd['n']} 次 共 {cd:.4f} 元，单次均 {cd/rd['n']*1000:.3f} 厘")
    if ra["n"] and rd["n"]:
        per_a = ca / ra["n"]
        per_d = cd / rd["n"]
        diff = (per_d - per_a) / per_a * 100 if per_a else 0
        print(f"  单次成本变化：{diff:+.1f}%")

c.close()
