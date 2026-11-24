"""对比几种 /心 输出方案。跑这个脚本看效果，不用启 AstrBot。"""

import time

import core

NOW = int(time.time() * 1000)


def make_state(kind="calm"):
    s = core.blank_state(NOW, {"attachment": 45, "intimacy": 40})
    if kind == "calm":
        s["dims"]["joy"] = 50.2
        s["dims"]["curious"] = 56.07
    elif kind == "wronged":
        s["dims"].update({"attachment": 44, "intimacy": 42, "joy": 38, "sad": 28})
        s["blame"] = 40
        s["lastReason"] = "被嫌了一句"
    elif kind == "angry":
        s["dims"].update({"attachment": 78, "intimacy": 72, "joy": 25, "sad": 45, "worry": 32})
        s["blame"] = 66
        s["lastReason"] = "被很重地说了一句"
    return s


def head_line(st):
    band = core.band_of(core.num(st.get("blame"), 0))
    binfo = core.band_info(band)
    stage = core.stage_of(st)
    blame = core.num(st.get("blame"), 0)
    if band == "calm":
        return band, binfo, stage, blame, f"心情 {stage['name']}｜没在生气"
    return band, binfo, stage, blame, f"心情 {stage['name']}｜{binfo['label']} {round(blame)}"


# ══════════════════════════════════════════════════════
# 方案 A：恢复原样（10 格 + 每维一行 + 小数）
# ══════════════════════════════════════════════════════
def plan_a(st):
    band, binfo, stage, blame, head = head_line(st)
    dims = st["dims"]

    def bar(v):
        n = max(0, min(10, int(round(v / 10))))
        return "█" * n + "░" * (10 - n)

    lines = [f"心情：{stage['name']}｜责怪档：{binfo['label']}（{core.round2(blame):g}/100）", ""]
    for k in core.DIM_KEYS:
        v = core.num(dims.get(k), core.DIMS[k]["base"])
        lines.append(f"  {core.DIMS[k]['label']} {bar(v)} {core.round2(v):g}")
    r = str(st.get("lastReason") or "").strip()
    if r:
        lines += ["", f"最近：{r}"]
    elif band != "calm":
        lines += ["", "（哄够了会往下走，不一定要说对不起）"]
    return "\n".join(lines)


# ══════════════════════════════════════════════════════
# 方案 B：极简 —— 只有数字，用斜杠分隔（最短）
# ══════════════════════════════════════════════════════
def plan_b(st):
    band, binfo, stage, blame, head = head_line(st)
    dims = st["dims"]

    def g(k):
        return round(core.num(dims.get(k), core.DIMS[k]["base"]))

    lines = [
        head,
        f"依恋{g('attachment')} 亲密{g('intimacy')} 开心{g('joy')} 担心{g('worry')}",
        f"难过{g('sad')} 好奇{g('curious')} 疲惫{g('fatigue')}",
        f"{binfo['short']}",
    ]
    r = str(st.get("lastReason") or "").strip()
    if r:
        lines.append(f"（{r}）")
    return "\n".join(lines)


# ══════════════════════════════════════════════════════
# 方案 C：分组卡片 —— 关系 / 情绪 两段，中间分隔
# ══════════════════════════════════════════════════════
def plan_c(st):
    band, binfo, stage, blame, head = head_line(st)
    dims = st["dims"]

    def bar(v, w=6):
        n = max(0, min(w, int(round(v / 100 * w))))
        return "█" * n + "·" * (w - n)

    def g(k):
        return round(core.num(dims.get(k), core.DIMS[k]["base"]))

    lines = [head, ""]
    # 关系段
    lines.append("关系")
    lines.append(f"  依恋 {bar(g('attachment'))} {g('attachment'):>3}")
    lines.append(f"  亲密 {bar(g('intimacy'))} {g('intimacy'):>3}")
    lines.append("")
    # 情绪段
    lines.append("情绪")
    moods = ["joy", "worry", "sad", "curious", "fatigue"]
    for k in moods:
        lines.append(f"  {core.DIMS[k]['label']} {bar(g(k))} {g(k):>3}")
    lines.append("")
    lines.append(binfo["short"])
    r = str(st.get("lastReason") or "").strip()
    if r:
        lines.append(f"（{r}）")
    return "\n".join(lines)


# ══════════════════════════════════════════════════════
# 方案 D：表情符号 + 名字对齐（最有画面感）
# ══════════════════════════════════════════════════════
def plan_d(st):
    band, binfo, stage, blame, head = head_line(st)
    dims = st["dims"]

    ICON = {
        "attachment": "💙", "intimacy": "🤍", "joy": "😊", "worry": "😟",
        "sad": "😢", "curious": "👀", "fatigue": "😪",
    }

    def g(k):
        return round(core.num(dims.get(k), core.DIMS[k]["base"]))

    def seg(v, w=8):
        # 用 8 格，但只填到当前值
        n = max(0, min(w, int(round(v / 100 * w))))
        return "▰" * n + "▱" * (w - n)

    lines = [head, ""]
    for k in core.DIM_KEYS:
        v = g(k)
        lines.append(f"{ICON[k]} {core.DIMS[k]['label']} {seg(v)} {v:>3}")
    lines.append("")
    lines.append(binfo["short"])
    r = str(st.get("lastReason") or "").strip()
    if r:
        lines.append(f"（{r}）")
    return "\n".join(lines)


# ══════════════════════════════════════════════════════
# 方案 E：当前版（一行两根 + ▰▱ + ▲▼ 标记）
# ══════════════════════════════════════════════════════
def plan_e(st):
    band, binfo, stage, blame, head = head_line(st)
    dims = st["dims"]

    def bar(v, w=8):
        n = int(round(max(0.0, min(100.0, v)) / 100 * w))
        return "▰" * n + "▱" * (w - n)

    def mark(v, base):
        d = v - base
        if d >= 6: return "▲"
        if d >= 3: return "△"
        if d <= -6: return "▼"
        if d <= -3: return "▽"
        return "　"

    bond = ("attachment", "intimacy")
    mood = tuple(k for k in core.DIM_KEYS if k not in bond)

    def cell(k):
        v = core.num(dims.get(k), core.DIMS[k]["base"])
        return f"{core.DIMS[k]['label']}{bar(v)}{round(v):>3}{mark(v, core.DIMS[k]['base'])}"

    lines = [head]
    for pair in ((bond[0], bond[1]), (mood[0], mood[1]), (mood[2], mood[3]), (mood[4], None)):
        lines.append((f"{cell(pair[0])}  {cell(pair[1])}" if pair[1] else cell(pair[0])).rstrip())
    lines.append("")
    lines.append(f"这会儿{binfo['short']}")
    r = str(st.get("lastReason") or "").strip()
    if r:
        lines.append(f"（{r}）")
    return "\n".join(lines)


PLANS = [
    ("方案 A · 恢复原样", plan_a, "10 行，10 格进度条，带小数，每维一行。信息最全但最长"),
    ("方案 B · 极简", plan_b, "4~5 行，纯数字无进度条。最短，一扫就能读完"),
    ("方案 C · 分组卡片", plan_c, "关系/情绪分两段，6 格条。有结构感，但仍偏长"),
    ("方案 D · 表情图标", plan_d, "每维一个 emoji + 8 格条。最有画面感，但 QQ 上 emoji 可能显大"),
    ("方案 E · 当前版", plan_e, "一行两根 + ▲▼ 相对基线。最紧凑，但不能一眼看全"),
]


def main():
    for kind, title in [("calm", "日常"), ("angry", "生气")]:
        print()
        print("#" * 60)
        print(f"#  状态：{title}")
        print("#" * 60)
        st = make_state(kind)
        for name, fn, desc in PLANS:
            out = fn(st)
            print()
            print("─" * 60)
            print(f"{name}   （{len(out.splitlines())} 行）")
            print(f"  {desc}")
            print("─" * 60)
            print(out)
        print()


if __name__ == "__main__":
    main()
