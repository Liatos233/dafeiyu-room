"""渲染格式测试：把 /心 的 QQ 输出格式钉住，防止以后改坏。

定稿方案（A+）：
  · 每维一行、10 格进度条、去掉小数
  · QQ 的 OneBot v11 协议没有颜色/粗体，只能靠排版
"""

import re
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

    def bar(v):
        n = max(0, min(10, int(round(core.num(v) / 10))))
        return "█" * n + "░" * (10 - n)

    if band == "calm":
        head = f"心情：{stage['name']}｜没在生气"
    else:
        head = f"心情：{stage['name']}｜{binfo['label']}（{round(blame)}/100）"

    lines = [head, ""]
    for k in core.DIM_KEYS:
        v = core.num(dims.get(k), core.DIMS[k]["base"])
        lines.append(f"  {core.DIMS[k]['label']} {bar(v)} {round(v):>3}")
    lines.append("")
    lines.append(binfo["short"])

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

    def test_every_dim_on_own_line(self):
        # 定稿方案：每维独占一行（不做一行两根）
        out = render(self.st)
        for k in core.DIM_KEYS:
            label = core.DIMS[k]["label"]
            hits = [ln for ln in out.splitlines() if label in ln]
            self.assertEqual(len(hits), 1, f"{label} 应该只在一行出现")

    def test_bar_is_10_cells(self):
        # 进度条固定 10 格
        out = render(self.st)
        for line in out.splitlines():
            if "█" in line or "░" in line:
                cells = len(re.findall(r"[█░]", line))
                self.assertEqual(cells, 10, f"进度条不是 10 格：{line!r}")

    def test_no_decimals(self):
        # 数值不能带小数
        self.st["dims"]["intimacy"] = 40.12
        self.st["dims"]["curious"] = 56.07
        out = render(self.st)
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

    def test_numbers_right_aligned(self):
        # 数字要右对齐（1 位和 3 位都能对齐）
        self.st["dims"]["sad"] = 5
        self.st["dims"]["attachment"] = 100
        out = render(self.st)
        for line in out.splitlines():
            if "█" in line or "░" in line:
                # 数字前应该有空位让位宽变成 3
                m = re.search(r"[█░]+ (\s*\d+)$", line)
                self.assertIsNotNone(m, f"数字未右对齐：{line!r}")

    def test_calm_says_not_angry(self):
        out = render(self.st)
        self.assertIn("没在生气", out)

    def test_angry_shows_blame(self):
        self.st["blame"] = 66
        out = render(self.st)
        self.assertIn("生气", out)
        self.assertIn("66", out)

    def test_line_count_reasonable(self):
        # 定稿 11~12 行（每维一行，不再强压行数）
        out = render(self.st)
        n = len(out.splitlines())
        self.assertGreaterEqual(n, 10, f"太少了，可能漏了维度：{n}")
        self.assertLessEqual(n, 14, f"太多了：{n}")

    def test_no_relative_marks(self):
        # ▲▼ 标记已经去掉（破坏对齐）
        self.st["dims"]["attachment"] = 95
        out = render(self.st)
        for sym in ("▲", "▼", "△", "▽"):
            self.assertNotIn(sym, out, f"不该有 {sym} 标记")

    def test_short_tone_present(self):
        # 最后要有语气短句
        for band_key, blame in (("calm", 0), ("wronged", 40), ("angry", 66)):
            self.st["blame"] = blame
            out = render(self.st)
            info = core.band_info(core.band_of(blame))
            self.assertIn(info["short"], out, f"缺语气短句（{band_key}）")

    def test_short_field_exists_for_all_bands(self):
        for key in ("calm", "wronged", "angry", "afraid", "shut"):
            info = core.band_info(key)
            self.assertIn("short", info)
            self.assertGreater(len(info["short"]), 4)


class TestBar(unittest.TestCase):
    def test_bar_monotonic(self):
        # 数值越大填得越多
        prev = -1
        for v in range(0, 101, 10):
            n = max(0, min(10, int(round(v / 10))))
            self.assertGreaterEqual(n, prev)
            prev = n

    def test_bar_extremes(self):
        self.assertEqual(max(0, min(10, int(round(0 / 10)))), 0)
        self.assertEqual(max(0, min(10, int(round(100 / 10)))), 10)

    def test_bar_clamps_out_of_range(self):
        # 超出 0~100 也要夹住
        self.assertEqual(max(0, min(10, int(round(150 / 10)))), 10)
        self.assertEqual(max(0, min(10, int(round(-20 / 10)))), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
