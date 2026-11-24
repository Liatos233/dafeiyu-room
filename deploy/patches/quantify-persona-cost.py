#!/usr/bin/env python3
"""量化：persona 从 1787 → 2600 字的成本影响。

思路：
  persona 在 system prompt 里，每轮都要发一遍。
  它属于「稳定的前缀」，所以大多数时候应该命中缓存（0.02 元/百万）。
  只有缓存未命中的时候才按全价（1 元/百万）算。

所以要分开算两种情况：
  A. 命中缓存：增量成本 = 813字 × 0.02 元/百万
  B. 未命中：  增量成本 = 813字 × 1 元/百万

再乘上实测的命中/未命中比例，得到真实期望成本。
"""
import sqlite3

DB = "/root/data/data_v4.db"

# persona 增量的字符数
ADDED_CHARS = 2600 - 1787

# 中文 1 字 ≈ 1 token 到 1.5 token（DeepSeek 分词器对中文大致 1:1~1:1.5）
# 保守取 1.0，也给 1.5 的情况
for ratio in (1.0, 1.5):
    added_tokens = ADDED_CHARS * ratio
    print(f"=== 假设中文 {ratio} token/字 → 增量 {added_tokens:.0f} tokens ===")

    PRICE_HIT = 0.02    # 元/百万 token
    PRICE_MISS = 1.0

    print(f"  全部命中缓存：  {added_tokens * PRICE_HIT / 1e6 * 1000:.6f} 厘/次")
    print(f"  全部未命中：    {added_tokens * PRICE_MISS / 1e6 * 1000:.4f} 厘/次")
    print()

# 用实测的全局命中率算期望
c = sqlite3.connect(DB)
cur = c.execute("""
    SELECT token_input_cached, token_input_other
    FROM provider_stats
    WHERE status = 'completed' AND (token_input_cached + token_input_other) > 0
""")
rows = cur.fetchall()
cached = sum(r[0] or 0 for r in rows)
other = sum(r[1] or 0 for r in rows)
total = cached + other
global_rate = cached / total

print("=" * 66)
print("用全局实测数据算期望成本")
print("=" * 66)
print(f"  总调用 {len(rows)} 次")
print(f"  命中 {cached:,} tokens / 未命中 {other:,} tokens")
print(f"  全局命中率 {global_rate*100:.1f}%")
print()

for ratio in (1.0, 1.5):
    added_tokens = ADDED_CHARS * ratio
    # 期望：命中的部分按 hit 价，未命中的按 miss 价
    expect = (added_tokens * global_rate * 0.02 + added_tokens * (1 - global_rate) * 1.0) / 1e6
    print(f"  中文 {ratio} token/字：每次多花 {expect*1000:.4f} 厘")

print()
print("=" * 66)
print("换算成每天/每月")
print("=" * 66)
# 最近 7 天日均调用次数
cur = c.execute("""
    SELECT COUNT(*) FROM provider_stats
    WHERE status = 'completed' AND start_time > (strftime('%s','now') - 7*86400)
""")
per_week = cur.fetchone()[0]
per_day = per_week / 7
print(f"  最近 7 天共 {per_week} 次 → 日均 {per_day:.0f} 次")
print()

for ratio in (1.0, 1.5):
    added_tokens = ADDED_CHARS * ratio
    expect_yuan = (added_tokens * global_rate * 0.02 + added_tokens * (1 - global_rate) * 1.0) / 1e6
    print(f"  中文 {ratio} token/字：")
    print(f"    每天  {expect_yuan * per_day:.4f} 元")
    print(f"    每月  {expect_yuan * per_day * 30:.3f} 元")

c.close()

print()
print("=" * 66)
print("对比：如果这段规则不写在 system prompt，而是挂在用户消息末尾")
print("=" * 66)
print("  system prompt 每字每轮都要发 → 上面算的就是这个")
print("  用户消息末尾每轮也要发，但它在历史末尾，不影响前缀缓存 ----------------")
print("  实际差别不在「发不发」，而在「有没有把前面的缓存搞失效」")
print()
print("  关键：persona 是**稳定前缀**，改了才失效一次；")
print("        之后每一轮都从同一前缀开始 → 命中率不受影响。")
print("        所以代价是「一次性的重算」+「每轮多发的 813 字」。")
