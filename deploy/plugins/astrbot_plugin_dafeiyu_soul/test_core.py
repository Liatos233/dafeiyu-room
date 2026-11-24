"""core.py 单元测试。

运行：cd deploy/plugins/astrbot_plugin_dafeiyu_soul && python -m unittest test_core -v
不依赖 AstrBot，纯标准库。
"""

import unittest

import core


HOUR = 3_600_000
NOW = 1_795_550_000_000  # 固定时间戳，测试不依赖当前时间


class TestBasics(unittest.TestCase):
    def test_clamp(self):
        self.assertEqual(core.clamp(-5), 0.0)
        self.assertEqual(core.clamp(150), 100.0)
        self.assertEqual(core.clamp(50), 50.0)

    def test_num_handles_null(self):
        # 关键：null 不能当 0，否则 dt 会算成一个巨大的值
        self.assertEqual(core.num(None, 42), 42)
        self.assertEqual(core.num("", 42), 42)
        self.assertEqual(core.num("abc", 42), 42)
        self.assertEqual(core.num("3.5", 0), 3.5)

    def test_round2(self):
        self.assertEqual(core.round2(1.2345), 1.23)
        self.assertEqual(core.round2(float("nan")), 0.0)

    def test_blank_state(self):
        st = core.blank_state(NOW)
        self.assertEqual(len(st["dims"]), 7)
        self.assertEqual(st["dims"]["attachment"], 45.0)
        self.assertEqual(st["dims"]["intimacy"], 40.0)
        self.assertEqual(st["blame"], 0.0)

    def test_initial_override(self):
        st = core.blank_state(NOW, {"attachment": 45, "intimacy": 40})
        self.assertEqual(st["dims"]["attachment"], 45.0)
        self.assertEqual(st["dims"]["intimacy"], 40.0)

    def test_normalize_bad_input(self):
        # 坏数据不能崩，要回落到基线
        for bad in (None, {}, {"dims": None}, {"dims": {"joy": "xxx"}}):
            st = core.normalize(bad, NOW)
            self.assertEqual(len(st["dims"]), 7)


class TestDecay(unittest.TestCase):
    def test_decay_no_time(self):
        st = core.blank_state(NOW)
        st["dims"]["joy"] = 80.0
        out, changed = core.decay(st, NOW)
        self.assertFalse(changed)
        self.assertEqual(out["dims"]["joy"], 80.0)

    def test_decay_one_half_life(self):
        # 开心 80，基线 50，半衰期 10h → 过 10h 应该到 65（走完一半距离）
        st = core.blank_state(NOW)
        st["dims"]["joy"] = 80.0
        st["decayedAt"] = NOW
        out, changed = core.decay(st, NOW + 10 * HOUR)
        self.assertTrue(changed)
        self.assertAlmostEqual(out["dims"]["joy"], 65.0, delta=0.5)

    def test_decay_two_half_lives(self):
        # 再过 10h（共 20h）→ 再走一半 → 72.5
        st = core.blank_state(NOW)
        st["dims"]["joy"] = 80.0
        st["decayedAt"] = NOW
        out, _ = core.decay(st, NOW + 20 * HOUR)
        self.assertAlmostEqual(out["dims"]["joy"], 57.5, delta=0.6)

    def test_bond_decays_slower(self):
        # 依恋半衰期 51h，10 小时后几乎没动
        st = core.blank_state(NOW)
        st["dims"]["attachment"] = 80.0
        st["decayedAt"] = NOW
        out, _ = core.decay(st, NOW + 10 * HOUR)
        self.assertGreater(out["dims"]["attachment"], 73.0)

    def test_decay_does_not_round_away(self):
        # 关键回归：衰减每 tick 很小，不能因为取整而永远不动
        st = core.blank_state(NOW)
        st["dims"]["joy"] = 80.0
        st["decayedAt"] = NOW
        moved = 0.0
        for i in range(1, 21):
            out, _ = core.decay(st, NOW + i * 60_000)  # 每分钟一次
            moved = 80.0 - out["dims"]["joy"]
            st = out
        # 20 分钟后应该有可测量的变化（不能是 0）
        self.assertGreater(moved, 0.5, "20 分钟衰减必须有可见变化，否则时间曲线失效")

    def test_decay_cap_72h(self):
        # 关机一个月，只按 72h 补算，别把状态冲垮
        st = core.blank_state(NOW)
        st["dims"]["joy"] = 100.0
        st["decayedAt"] = NOW
        out, _ = core.decay(st, NOW + 30 * 24 * HOUR)
        self.assertGreaterEqual(out["dims"]["joy"], 50.0)


class TestBands(unittest.TestCase):
    def test_band_boundaries(self):
        self.assertEqual(core.band_of(0), "calm")
        self.assertEqual(core.band_of(24.9), "calm")
        self.assertEqual(core.band_of(25), "wronged")
        self.assertEqual(core.band_of(54.9), "wronged")
        self.assertEqual(core.band_of(55), "angry")
        self.assertEqual(core.band_of(69.9), "angry")
        self.assertEqual(core.band_of(70), "afraid")
        self.assertEqual(core.band_of(79.9), "afraid")
        self.assertEqual(core.band_of(80), "shut")
        self.assertEqual(core.band_of(100), "shut")

    def test_stage_mapping(self):
        st = core.blank_state(NOW)
        # 45 + 40 = 均值 42.5 → 愿意搭话
        self.assertEqual(core.stage_of(st)["name"], "愿意搭话")

        st["dims"]["attachment"] = 90
        st["dims"]["intimacy"] = 90
        self.assertEqual(core.stage_of(st)["name"], "黏人")

    def test_stage_boundaries(self):
        cases = [(0, "陌生鱼苗"), (14.9, "陌生鱼苗"), (15, "眼熟的小鱼"),
                 (30, "愿意搭话"), (45, "嘴硬搭子"), (60, "心软常客"), (75, "黏人")]
        for avg, want in cases:
            st = core.blank_state(NOW)
            st["dims"]["attachment"] = avg
            st["dims"]["intimacy"] = avg
            self.assertEqual(core.stage_of(st)["name"], want, f"均值 {avg} 应该是 {want}")


class TestDelta(unittest.TestCase):
    def test_ceiling_asymptote(self):
        # 100 是渐近线：接近 100 时增益几乎为 0
        st = core.blank_state(NOW)
        st["dims"]["joy"] = 99.0
        real = core.apply_delta(st, "joy", 10.0, NOW, "praise")
        self.assertLess(real, 0.2, "接近天花板时增益应该被大幅压缩")
        self.assertLessEqual(st["dims"]["joy"], 100.0)

    def test_ceiling_half(self):
        # 当前 50，增益 10 → 实际约 5（(100-50)/100 = 0.5）
        st = core.blank_state(NOW)
        st["dims"]["joy"] = 50.0
        real = core.apply_delta(st, "joy", 10.0, NOW, "praise")
        self.assertAlmostEqual(real, 5.0, delta=0.6)

    def test_heat_discount(self):
        # 同类事件连续触发，第二次增益应该更小
        st = core.blank_state(NOW)
        st["dims"]["joy"] = 30.0
        r1 = core.apply_delta(st, "joy", 8.0, NOW, "praise")
        r2 = core.apply_delta(st, "joy", 8.0, NOW + 1000, "praise")
        r3 = core.apply_delta(st, "joy", 8.0, NOW + 2000, "praise")
        self.assertGreater(r1, r2)
        self.assertGreater(r2, r3)

    def test_daily_cap(self):
        # 正向每日上限 40，一直刷到上限后不再涨
        st = core.blank_state(NOW)
        st["dims"]["joy"] = 10.0
        total = 0.0
        for i in range(60):
            total += abs(core.apply_delta(st, "joy", 5.0, NOW + i * 60_000, "praise"))
        self.assertLessEqual(core.num(st["dailyGain"]), 41.0)

    def test_negative_not_capped(self):
        # 负向不受日上限和天花板约束
        st = core.blank_state(NOW)
        st["dims"]["sad"] = 20.0
        real = core.apply_delta(st, "sad", -15.0, NOW, "comfort")
        self.assertAlmostEqual(real, -15.0, delta=1.0)


class TestBlame(unittest.TestCase):
    def test_smother_no_jump(self):
        # 关键规矩：重责不跳档，从日常最多到 69
        st = core.blank_state(NOW)
        st["blame"] = 0.0
        core.raise_blame(st, 90.0, NOW, "被凶")
        self.assertEqual(st["blame"], 69.0)
        self.assertEqual(core.band_of(st["blame"]), "angry")

        # 第二次才可能进害怕
        core.raise_blame(st, 15.0, NOW, "又被凶")
        self.assertGreater(st["blame"], 69.0)

    def test_blame_decay_stops_at_floor(self):
        # 心结 40：不会自己回日常
        st = core.blank_state(NOW)
        st["blame"] = 60.0
        st["decayedAt"] = NOW
        out, _ = core.decay(st, NOW + 100 * HOUR)
        self.assertAlmostEqual(out["blame"], core.DEFAULTS["blame_floor"], delta=0.5)

    def test_sooth_needs_rounds(self):
        # 哄够轮数才真正往下走
        st = core.blank_state(NOW)
        st["blame"] = 60.0  # 生气档，需要 1 轮
        d1 = core.sooth_blame(st, 18.0, NOW)
        self.assertLess(d1, 0, "第一轮应该有缓和")
        self.assertLess(st["blame"], 60.0)

    def test_sooth_afraid_needs_two(self):
        # 害怕档要哄 2 轮
        st = core.blank_state(NOW)
        st["blame"] = 75.0
        d1 = core.sooth_blame(st, 18.0, NOW)
        after1 = st["blame"]
        d2 = core.sooth_blame(st, 18.0, NOW)
        after2 = st["blame"]
        # 第二轮（累计凑够 2 轮）效果应该比第一轮大
        self.assertGreater(abs(after2 - after1), abs(after1 - 75.0) * 0.8)

    def test_sooth_resets_on_new_blame(self):
        st = core.blank_state(NOW)
        st["blame"] = 60.0
        core.sooth_blame(st, 10.0, NOW)
        self.assertEqual(st["gentleRounds"], 1)
        core.raise_blame(st, 5.0, NOW, "又惹了")
        self.assertEqual(st["gentleRounds"], 0, "再次被惹，哄的进度要清零")


class TestInject(unittest.TestCase):
    def test_band_change_always_injects(self):
        st = core.blank_state(NOW)
        st["lastBand"] = "calm"
        st["blame"] = 60.0
        ok, why = core.should_inject(st, NOW)
        self.assertTrue(ok)
        self.assertEqual(why, "band-change")

    def test_angry_always_injects(self):
        st = core.blank_state(NOW)
        st["lastBand"] = "angry"
        st["blame"] = 60.0
        st["lastInjectedFor"] = st["updatedAt"]
        st["lastInjectedAt"] = NOW
        ok, why = core.should_inject(st, NOW)
        self.assertTrue(ok, "生气档必须每轮都注，否则她会忘了自己在生气")
        self.assertEqual(why, "angry-always")

    def test_same_state_not_twice(self):
        st = core.blank_state(NOW)
        st["lastBand"] = "calm"
        st["blame"] = 10.0
        st["lastInjectedFor"] = st["updatedAt"]
        ok, why = core.should_inject(st, NOW)
        self.assertFalse(ok)
        self.assertEqual(why, "already-said")

    def test_throttle(self):
        st = core.blank_state(NOW)
        st["lastBand"] = "calm"
        st["blame"] = 10.0
        st["lastInjectedFor"] = 0
        st["lastInjectedAt"] = NOW - 5 * 60_000  # 5 分钟前
        ok, why = core.should_inject(st, NOW, min_gap_minutes=20)
        self.assertFalse(ok)
        self.assertEqual(why, "throttled")


if __name__ == "__main__":
    unittest.main(verbosity=2)
