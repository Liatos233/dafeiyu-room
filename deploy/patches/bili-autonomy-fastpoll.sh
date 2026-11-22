#!/bin/bash
# 让「@ 她」接近即时响应：轮询改成秒级，并放宽测试期的冷却。
#
# B 站没有 @ 实时推送接口，只能轮询 get_msgfeed。原实现里三层限制叠着：
#   1. _social_loop: sleep(max(5, check_every_min) * 60)  ← 代码写死最小 5 分钟
#   2. _social_gate: min_gap_min=120                     ← 两条之间至少 2 小时
#   3. autonomy: max_per_day=2 / once_per_person=true    ← 一天 2 条、同一个人 30 天一次
# 结果：45 分钟才发现，发现后还可能被冷却挡住。
#
# 改法：
#   · 代码：支持 autonomy.check_every_sec（秒级，最小 20）；没配才退回 check_every_min
#   · 配置（测试期值）：check_every_sec=60 / max_per_day=20 / min_gap_min=0 /
#     once_per_person=false；read_daily 提到 3000 留余量
#
# 实测意义：60 秒轮询 ≈ 每小时 60 次，远低于 risk.read_hourly=300。
#
# 用法（AstrBot 所在机器，root）：
#   bash bili-autonomy-fastpoll.sh
#   systemctl restart astrbot
#
# 幂等。
set -euo pipefail

PLUGINS=${PLUGINS:-/root/data/plugins}
BW="$PLUGINS/astrbot_plugin_bili_whale/main.py"
CFG=${CFG:-/root/data/config/astrbot_plugin_bili_whale_config.json}
PY=${PY:-/opt/astrbot/venv/bin/python}
STAMP=$(date +%Y%m%d-%H%M%S)

# ── 1. 代码：秒级轮询 ────────────────────────────────────────────────────
cp -p "$BW" "$BW.bak-fastpoll-$STAMP"
python3 - "$BW" <<'PY'
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()

if '_fastpoll_patch' in s:
    print('· 代码已支持秒级轮询')
    raise SystemExit

old = '''            await asyncio.sleep(max(5, self._int("autonomy.check_every_min", 30)) * 60)'''
new = '''            # _fastpoll_patch：优先用秒级间隔（B 站没有 @ 实时推送，只能靠轮询贴近实时）。
            # 没配 check_every_sec 才退回原来的分钟级。最小 20 秒，防止把通知接口打爆。
            _sec = self._int("autonomy.check_every_sec", 0)
            if _sec > 0:
                await asyncio.sleep(max(20, _sec))
            else:
                await asyncio.sleep(max(5, self._int("autonomy.check_every_min", 30)) * 60)'''
if old in s:
    s = s.replace(old, new, 1)
    open(p, 'w', encoding='utf-8').write(s)
    print('· _social_loop 支持 check_every_sec（最小 20 秒）')
else:
    print('! 没找到 _social_loop 的 sleep 行')
PY

"$PY" -m py_compile "$BW" && echo "bili_whale OK"

# ── 2. 配置：秒级轮询 + 放宽测试期冷却 ──────────────────────────────────
cp -p "$CFG" "$CFG.bak-fastpoll-$STAMP"
python3 - "$CFG" <<'PY'
import json, sys

p = sys.argv[1]
d = json.load(open(p, encoding='utf-8-sig'))
a = d.setdefault("autonomy", {})
risk = d.setdefault("risk", {})

changes = [
    (a, "check_every_sec", 60),
    (a, "max_per_day", 20),
    (a, "min_gap_min", 0),
    (a, "once_per_person", False),
    (risk, "read_daily", 3000),
]
applied = []
for obj, k, want in changes:
    if obj.get(k) != want:
        print(f"  {k}: {obj.get(k)} -> {want}")
        obj[k] = want
        applied.append(k)

json.dump(d, open(p, "w", encoding="utf-8-sig"), ensure_ascii=False, indent=2)
d2 = json.load(open(p, encoding="utf-8-sig"))
a2 = d2["autonomy"]
print("最终 autonomy:",
      "enabled=", a2.get("enabled"),
      "reply=", a2.get("reply"),
      "comment=", a2.get("comment"),
      "check_every_sec=", a2.get("check_every_sec"),
      "max_per_day=", a2.get("max_per_day"),
      "min_gap_min=", a2.get("min_gap_min"),
      "once_per_person=", a2.get("once_per_person"))
print("改动：", applied or "无（本来就是这样）")
PY

echo
echo "完成。执行：systemctl restart astrbot"
echo "注意：max_per_day/min_gap_min/once_per_person 是为测试放开的，"
echo "      稳定后建议改回 max_per_day=2 / min_gap_min=120 / once_per_person=true"
