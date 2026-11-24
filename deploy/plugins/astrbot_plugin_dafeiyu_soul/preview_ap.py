import time
import core

NOW = int(time.time() * 1000)


def render(st):
    dims = st["dims"]
    band = core.band_of(core.num(st.get("blame"), 0))
    binfo = core.band_info(band)
    stage = core.stage_of(st)
    blame = core.num(st.get("blame"), 0)

    def bar(v):
        n = max(0, min(10, int(round(core.num(v) / 10))))
        return "█" * n + "░" * (10 - n)

    head = (f"心情：{stage['name']}｜没在生气" if band == "calm"
            else f"心情：{stage['name']}｜{binfo['label']}（{round(blame)}/100）")
    lines = [head, ""]
    for k in core.DIM_KEYS:
        v = core.num(dims.get(k), core.DIMS[k]["base"])
        lines.append(f"  {core.DIMS[k]['label']} {bar(v)} {round(v):>3}")
    lines.append("")
    lines.append(binfo["short"])
    r = str(st.get("lastReason") or "").strip()
    if r:
        lines.append(f"（{r}）")
    elif band != "calm":
        lines.append("（哄够了会往下走，不一定要说对不起）")
    return "\n".join(lines)


s = core.blank_state(NOW, {"attachment": 45, "intimacy": 40})
s["dims"]["joy"] = 50.2
s["dims"]["curious"] = 56.07
out1 = render(s)
print("=" * 50)
print("① 日常（真实状态）")
print("=" * 50)
print(out1)
print(f"→ {len(out1.splitlines())} 行")

s2 = core.blank_state(NOW, {"attachment": 78, "intimacy": 72})
s2["dims"].update({"joy": 25, "sad": 45, "worry": 32})
s2["blame"] = 66
s2["lastReason"] = "被很重地说了一句"
out2 = render(s2)
print()
print("=" * 50)
print("② 生气（责怪 66）")
print("=" * 50)
print(out2)
print(f"→ {len(out2.splitlines())} 行")
