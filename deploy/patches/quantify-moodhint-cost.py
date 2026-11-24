#!/usr/bin/env python3
"""量化：group_chat_plus 的 mood_hint 追加到 system prompt 造成的损失。

机制（已从源码确认）：
  main.py:7771-7782  情绪值每轮更新（mood_decay_time=300 秒衰减）
                      → 非"平静"时生成 mood_hint
                      → event.set_extra
  main.py:11072-11074 on_llm_request 里把它 += 到 req.system_prompt 末尾
                      → system prompt 每轮都可能不同
                      → DeepSeek 前缀缓存从开头算到第一个变化点
                      → 整段 system prompt 之后的内容全部重算

正确做法应该是 extra_user_content_parts（挂在用户消息末尾，不破坏前缀）。

这里算：如果这些低命中调用能变成高命中，能省多少。
"""
import sqlite3
import datetime
import statistics

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

PRICE_HIT = 0.02 / 1e6
PRICE_MISS = 1.0 / 1e6

# 全局基准命中率（排除低命中组后的"正常"水平）
high = [r for r in recs if r["rate"] >= 60]
if high:
    hc = sum(r["cached"] for r in high)
    ho = sum(r["other"] for r in high)
    base_rate = hc / (hc + ho)
else:
    base_rate = 0.68

print("=" * 68)
print("现状")
print("=" * 68)
all_c = sum(r["cached"] for r in recs)
all_o = sum(r["other"] for r in recs)
print(f"  总调用 {len(recs)} 次")
print(f"  命中 {all_c:,} / 未命中 {all_o:,}")
print(f"  整体命中率 {all_c/(all_c+all_o)*100:.1f}%")
print(f"  实际成本 {(all_c*PRICE_HIT + all_o*PRICE_MISS):.3f} 元")
print()

# 低命中组
low = [r for r in recs if r["rate"] < 30]
low_o = sum(r["other"] for r in low)
low_c = sum(r["cached"] for r in low)
print(f"  其中低命中组（<30%）{len(low)} 次，未命中 {low_o:,} tokens")
print(f"  → 这部分成本 {low_o*PRICE_MISS:.3f} 元")
print()

# 反事实：如果低命中组能达到正常命中率
print("=" * 68)
print("如果低命中组变成正常命中率（修掉 mood_hint 的 system prompt 污染）")
print("=" * 68)
print(f"  正常组基准命中率 {base_rate*100:.1f}%")

# 低命中组的总输入量不变，只是命中/未命中比例变化
low_tot = sum(r["tot"] for r in low)
new_hit = low_tot * base_rate
new_miss = low_tot * (1 - base_rate)
saved_tokens = low_o - new_miss
saved_yuan = saved_tokens * PRICE_MISS - (new_hit - low_c) * PRICE_HIT

print(f"  低命中组总输入 {low_tot:,} tokens")
print(f"    现在：命中 {low_c:,} / 未命中 {low_o:,}")
print(f"    修后：命中 {new_hit:,.0f} / 未命中 {new_miss:,.0f}")
print(f"  少算 {saved_tokens:,.0f} tokens")
print(f"  省 {saved_yuan:.2f} 元（全量 {len(recs)} 次）")
print()

# 换算日均
cur2 = c.execute("""
    SELECT COUNT(*) FROM provider_stats
    WHERE status='completed' AND start_time > (strftime('%s','now') - 7*86400)
""")
week_n = cur2.fetchone()[0]
per_day = week_n / 7 if week_n else 0
ratio = per_day / len(recs) if recs else 0
print(f"  最近 7 天 {week_n} 次 → 日均 {per_day:.0f} 次")
print(f"  按日均折算：每天省 {saved_yuan * ratio:.3f} 元，每月省 {saved_yuan * ratio * 30:.2f} 元")
print()

# 另一个角度：mood_hint 会让多少调用变低
print("=" * 68)
print("验证：mood_hint 的触发频率（情绪 != 平静 的比例）")
print("=" * 68)
print("  源码：只有 current_mood != '平静' 才生成 hint")
print("  mood_decay_time = 300 秒（5 分钟衰减回平静）")
print("  → 只要最近 5 分钟内有情绪波动，就会追加 hint 到 system prompt")
print()
print(f"  实测低命中占比 {len(low)/len(recs)*100:.1f}%")
print(f"  如果 mood_hint 是主因，这个比例应该和「非平静状态占比」接近")
print()

# 看低命中调用是否集中在有情绪关键词的时段——用输出长度间接判断
print("  低命中组 vs 正常组 的 other(未命中) 规模对比：")
print(f"    低命中中位 {statistics.median(r['other'] for r in low):,.0f}")
print(f"    正常组中位 {statistics.median(r['other'] for r in high):,.0f}")

c.close()
