"""渲染格式预览：不启插件，直接跑 _render_status 看输出。

覆盖三种状态：日常 / 委屈 / 生气+高依恋。
"""

import time

import core


def render(state: dict) -> str:
    """复刻 main.py 的 _render_status，方便不启 AstrBot 就调格式。"""
    st = state
    dims = st.get("dims") or {}
    band = core.band_of(core.num(st.get("blame"), 0.0))
    binfo = core.band_info(band)
    stage = core.stage_of(st)
    blame = core.num(st.get("blame"), 0.0)

    def bar(v, width=8):
        n = int(round(max(0.0, min(100.0, v)) / 100 * width))
        return "▰" * n + "▱" * (width - n)

    def mark(v, base):
        d = v - base
        if d >= 6:
            return "▲"
        if d >= 3:
            return "△"
        if d <= -6:
            return "▼"
        if d <= -3:
            return "▽"
        return "　"

    head = f"心情 {stage['name']}"
    if band != "calm":
        head += f"｜{binfo['label']} {round(blame)}"
    else:
        head += "｜没在生气"

    lines = [head]

    bond = ("attachment", "intimacy")
    mood = tuple(k for k in core.DIM_KEYS if k not in bond)

    def cell(k):
        v = core.num(dims.get(k), core.DIMS[k]["base"])
        base = core.DIMS[k]["base"]
        label = core.DIMS[k]["label"]
        return f"{label}{bar(v)}{round(v):>3}{mark(v, base)}"

    for pair in ((bond[0], bond[1]), (mood[0], mood[1]), (mood[2], mood[3]), (mood[4], None)):
        if pair[1]:
            lines.append(f"{cell(pair[0])}  {cell(pair[1])}".rstrip())
        else:
            lines.append(cell(pair[0]).rstrip())

    lines.append("")
    lines.append(f"这会儿{binfo['short']}")

    reason = str(st.get("lastReason") or "").strip()
    if reason:
        lines.append(f"（{reason}）")
    elif band != "calm":
        lines.append("（哄够了会往下走，不一定要说对不起）")

    return "\n".join(lines)


NOW = int(time.time() * 1000)

cases = []

# 1. 日常（当前真实状态）
s = core.blank_state(NOW, {"attachment": 45, "intimacy": 40.06})
s["dims"]["joy"] = 50.2
s["dims"]["curious"] = 56.07
cases.append(("① 日常（此刻真实状态）", s))

# 2. 委屈
s = core.blank_state(NOW, {"attachment": 44, "intimacy": 42})
s["blame"] = 40
s["dims"]["sad"] = 28
s["dims"]["joy"] = 38
s["lastReason"] = "被嫌了一句"
cases.append(("② 委屈（责怪 40）", s))

# 3. 生气 + 高依恋
s = core.blank_state(NOW, {"attachment": 78, "intimacy": 72})
s["blame"] = 66
s["dims"]["sad"] = 45
s["dims"]["joy"] = 25
s["dims"]["worry"] = 32
s["lastReason"] = "被很重地说了一句"
cases.append(("③ 生气（责怪 66，关系很近）", s))

for title, st in cases:
    print("=" * 46)
    print(title)
    print("=" * 46)
    out = render(st)
    print(out)
    print(f"→ {len(out.splitlines())} 行")
    print()


