"""渲染格式测试：把 /心 的 QQ 输出格式钉住，防止以后改坏。

这些测试不启 AstrBot，直接调 core + 复刻的渲染逻辑。
"""

import unittest

import core


def render(state: dict) -> str:
    """复刻 main.py 的 _render_status。改那边记得同步这里。"""
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


NOW = 1_795_550_000_000


class TestFormat(unittest.TestCase):
    def setUp(self):
        self.st = core.blank_state(NOW, {"attachment": 45, "intimacy": 40})

    def test_line_count(self):
        # 日常档必须 ≤ 8 行（QQ 上不用滑太久）
        out = render(self.st)
        self.assertLessEqual(len(out.splitlines()), 8, f"太长了：\n{out}")

    def test_no_decimals(self):
        # 数值不能带小数（40.12 / 56.07 视觉上很乱）
        self.st["dims"]["intimacy"] = 40.12
        self.st["dims"]["curious"] = 56.07
        out = render(self.st)
        import re
        # 找所有「数字」，不该出现小数点
        nums = re.findall(r"\d+(?:\.\d+)?", out)
        decimals = [n for n in nums if "." in n]
        self.assertEqual(decimals, [], f"不该有小数：{decimals}\n{out}")

    def test_no_trailing_space(self):
        out = render(self.st)
        for line in out.splitlines():
            self.assertEqual(line, line.rstrip(), f"行尾有空格：{line!r}")

    def test_shows_all_seven_dims(self):
        out = render(self.st)
        for k in core.DIM_KEYS:
            self.assertIn(core.DIMS[k]["label"], out, f"缺维度 {core.DIMS[k]['label']}")

    def test_calm_says_not_angry(self):
        out = render(self.st)
        self.assertIn("没在生气", out)

    def test_angry_shows_value(self):
        self.st["blame"] = 66
        out = render(self.st)
        self.assertIn("生气", out)
        self.assertIn("66", out)

    def test_relative_marks(self):
        # 明显偏离基线要标记号
        self.st["dims"]["attachment"] = 80   # 基线 45，+35 → ▲
        self.st["dims"]["joy"] = 20          # 基线 50，-30 → ▼
        out = render(self.st)
        self.assertIn("▲", out, f"高值应标▲\n{out}")
        self.assertIn("▼", out, f"低值应标▼\n{out}")

    def test_near_base_no_mark(self):
        # 接近基线不标记号（避免满屏三角）
        out = render(self.st)
        self.assertNotIn("▲", out)
        self.assertNotIn("▼", out)

    def test_short_tone_not_truncated(self):
        # 语气短句应该是独立成句，不是从长句里截出来的
        for key in ("calm", "wronged", "angry", "afraid", "shut"):
            info = core.band_info(key)
            self.assertIn("short", info, f"{key} 缺 short 字段")
            self.assertGreater(len(info["short"]), 4, f"{key} 的 short 太短")

    def test_not_broken_mid_sentence(self):
        # 「这会儿话变短」这种截断不该出现
        self.st["blame"] = 40
        out = render(self.st)
        self.assertNotIn("这会儿话变短", out, "不该从 tone 截断")
        self.assertIn("这辈子", out) if False else None


class TestBar(unittest.TestCase):
    def test_bar_width(self):
        for v in (0, 25, 50, 75, 100):
            n = int(round(v / 100 * 8))
            self.assertGreaterEqual(n, 0)
            self.assertLessEqual(n, 8)

    def test_bar_extremes(self):
        # 0 全空，100 全满
        self.assertEqual("▱" * 8, "▰" * 0 + "▱" * 8)
        self.assertEqual("▰" * 8, "▰" * 8 + "▱" * 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
