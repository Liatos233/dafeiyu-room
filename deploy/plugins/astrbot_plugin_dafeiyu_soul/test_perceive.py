"""perceive.py 单元测试。

运行：python -m unittest test_perceive -v
"""

import unittest

import perceive


def kinds(text):
    return [e["kind"] for e in perceive.classify(text)]


def top(text):
    ev = perceive.classify(text)
    return ev[0] if ev else None


class TestPraise(unittest.TestCase):
    def test_strong_praise(self):
        for s in ["你好厉害", "真棒", "太优秀了", "牛逼", "绝了", "佩服"]:
            self.assertEqual(kinds(s)[0], "praise_strong", f"「{s}」应判为明确夸奖")

    def test_soft_praise(self):
        for s in ["不错", "挺好", "靠谱", "有点东西"]:
            self.assertEqual(kinds(s)[0], "praise_soft", f"「{s}」应判为含蓄夸奖")

    def test_praise_beats_chat(self):
        # 夸奖优先于普通闲聊
        self.assertNotEqual(kinds("你这次做得不错")[0], "chat")


class TestNegation(unittest.TestCase):
    def test_negated_praise_not_praise(self):
        # 「不厉害」不应该涨好感
        k = kinds("你一点都不厉害")
        self.assertNotEqual(k[0], "praise_strong", "否定词必须挡住夸奖判定")

    def test_negated_scold_not_scold(self):
        # 「你一点也不笨」是安慰，不是骂
        k = kinds("你一点也不笨")
        self.assertNotIn("scold_strong", k)
        self.assertNotIn("scold_mild", k)

    def test_negation_window(self):
        # 否定词要在情绪词附近才算
        self.assertEqual(kinds("我昨天不小心把杯子打碎了，不过你真厉害")[0], "praise_strong")


class TestScold(unittest.TestCase):
    def test_strong_scold(self):
        for s in ["你真笨", "废物", "滚", "闭嘴", "恶心"]:
            self.assertEqual(kinds(s)[0], "scold_strong", f"「{s}」应判为重责")

    def test_mild_scold(self):
        for s in ["有点笨", "好烦", "讨厌"]:
            self.assertEqual(kinds(s)[0], "scold_mild", f"「{s}」应判为轻责")

    def test_strong_beats_mild(self):
        # 「你真笨」同时含「笨」（轻责），但应该判重责
        self.assertEqual(kinds("你真笨")[0], "scold_strong")

    def test_only_one_event(self):
        # 一句话最多一个主事件，不能涨八维
        self.assertEqual(len(perceive.classify("你真笨，但我还是喜欢你，抱抱")), 1)


class TestComfort(unittest.TestCase):
    def test_comfort(self):
        for s in ["对不起", "我错了", "别生气了", "原谅我"]:
            self.assertEqual(kinds(s)[0], "comfort", f"「{s}」应判为哄")

    def test_comfort_beats_mild_scold(self):
        # 「是我不好，别生气」应该判哄，不是骂
        self.assertEqual(kinds("是我不好，别生气")[0], "comfort")


class TestCuddle(unittest.TestCase):
    def test_cuddle(self):
        for s in ["抱抱", "贴贴", "想你了", "摸摸"]:
            self.assertEqual(kinds(s)[0], "cuddle", f"「{s}」应判为撒娇")

    def test_cuddle_beats_praise(self):
        self.assertEqual(kinds("抱抱，你真厉害")[0], "cuddle")


class TestSnub(unittest.TestCase):
    def test_bare_snub(self):
        for s in ["哦", "嗯", "行吧", "随便", "知道了"]:
            self.assertEqual(kinds(s)[0], "snub", f"「{s}」应判为敷衍")

    def test_snub_with_more_text_is_chat(self):
        # 「哦对了你看这个」不是敷衍
        self.assertNotEqual(kinds("哦对了你看这个")[0], "snub")


class TestCare(unittest.TestCase):
    def test_care(self):
        for s in ["你累不累", "吃饭了没", "早点睡", "注意身体"]:
            self.assertEqual(kinds(s)[0], "care", f"「{s}」应判为关心")


class TestShare(unittest.TestCase):
    def test_share(self):
        for s in ["你看这个", "我发现个东西", "给你看", "推荐一本"]:
            self.assertEqual(kinds(s)[0], "share", f"「{s}」应判为分享")


class TestFallback(unittest.TestCase):
    def test_plain_chat(self):
        for s in ["今天天气不错啊", "我在写代码", "后来呢"]:
            self.assertEqual(kinds(s)[0], "chat", f"「{s}」应回落为闲聊")

    def test_empty(self):
        self.assertEqual(perceive.classify(""), [])
        self.assertEqual(perceive.classify(None), [])
        self.assertEqual(perceive.classify("   "), [])

    def test_chat_barely_moves_attachment(self):
        # 关键：闲聊不能大幅推依恋，否则一天聊 100 句就黏人了
        ev = top("今天天气不错啊")
        self.assertLess(ev["deltas"].get("attachment", 0), 0.5)


class TestQuestion(unittest.TestCase):
    def test_is_question(self):
        self.assertTrue(perceive.is_question("你在干嘛？"))
        self.assertTrue(perceive.is_question("为什么"))
        self.assertFalse(perceive.is_question("我回来了"))


class TestOwnerDm(unittest.TestCase):
    def test_owner_dm_true(self):
        self.assertTrue(perceive.is_owner_dm("aiocqhttp:FriendMessage:000000000", "000000000"))
        self.assertTrue(perceive.is_owner_dm("大肥鱼:FriendMessage:000000000", "000000000"))

    def test_group_is_false(self):
        # 已确认只服务私聊主人
        self.assertFalse(perceive.is_owner_dm("aiocqhttp:GroupMessage:000000001", "000000000"))

    def test_other_person_dm_false(self):
        self.assertFalse(perceive.is_owner_dm("aiocqhttp:FriendMessage:123456", "000000000"))

    def test_malformed_false(self):
        for bad in ["", "000000000", "a:b", "a:b:c:d", None]:
            self.assertFalse(perceive.is_owner_dm(bad, "000000000"), f"「{bad}」应判 False")


if __name__ == "__main__":
    unittest.main(verbosity=2)
