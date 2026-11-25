"""大肥鱼的心 · 关键词感知层。

作用：把一句中文映射成「情绪事件」。

设计约束：
  · **不调用任何模型**，纯正则，零额外 token 成本
  · 同一条消息最多产出 1 个主事件（避免一句话涨八维）
  · 支持否定词（"不难过"不能判成难过）
  · 支持热度折扣（同类事件连发，增益递减）—— 在 core.apply_delta 里做

已知局限（照实写，别假装完美）：
  · 反讽、玩笑、"你真烦"这种半真半假的话会误判
  · 无法理解上下文（之前聊了什么）
  · 这是**有意的取舍**：准确度换零成本。如果后面觉得不准，
    可以开 `perception.llm_fallback`，只对模糊句额外问一次模型。
"""

from __future__ import annotations

import re

# ══════════════════════════════════════════════════════
# 词表
# ══════════════════════════════════════════════════════

# 明确夸奖 → 依恋 + 亲密 + 开心
PRAISE_STRONG = re.compile(
    r"(厉害|真棒|太棒|优秀|牛啊|牛逼|牛批|好强|绝了|天才|佩服|服了你了)"
    r"|(喜欢你|爱你|最喜欢你|好喜欢你)"
    r"|(辛苦了|谢谢你|多谢|感谢)"
)

# 含蓄夸奖（分量打折）
PRAISE_SOFT = re.compile(
    r"(不错|可以啊|挺好|还行吧|有点东西|靠谱|贴心|懂事|聪明|乖|温柔|仔细)"
)

# 撒娇 / 亲近
CUDDLE = re.compile(
    r"(抱抱|贴贴|亲亲|摸摸|蹭蹭|么么|想你了|想你|陪陪我|撒娇)"
)

# 被凶 / 被否定 → 难过 + 责怪
SCOLD_STRONG = re.compile(
    r"(你真笨|你就是笨|废物|垃圾|滚|闭嘴|恶心|弱智|蠢货|蠢死|没用的东西|白痴)"
)
SCOLD_MILD = re.compile(
    r"(笨|傻|丑|烦|讨厌|嫌弃|懒得理你|随便你|无所谓)"
)

# 不是否定词的「不」：这些是连词/程度词，不能当否定
NOT_NEGATION = re.compile(r"不(过|然|仅|但|光|止)")

# 敷衍（比凶轻，但会积压）
SNUB = re.compile(
    r"^(哦|嗯|行吧|随便|知道了|好)[。.!！?？~]*$"
)

# 哄 / 道歉（用户选了「哄够了就行，不挑方式」）
COMFORT = re.compile(
    r"(对不起|我错了|抱歉|别生气|不生气|乖|我不好|是我不好|原谅我|哄哄|抱抱你|不怪你)"
)

# 关心她 / 担心
CARE = re.compile(
    r"(累不累|累吗|困不困|还好吗|怎么了|没事吧|别太累|早点睡|注意身体|吃饭了没|吃了没|多喝热水)"
)

# 分享新东西 → 好奇
SHARE = re.compile(
    r"(你看这个|给你看|我发现|你知道吗|新出的|刚看到|分享|这个好|推荐)"
)

# 她说累/熬夜 → 担心（这是"她"说的，不是用户说）
HER_TIRED = re.compile(r"(累|困|熬夜|撑不住|不想动)")

# 否定词：出现在情绪词前面时，反转判定
NEGATION = re.compile(r"(不|没|别|勿|非|无)(是|太|怎么|觉得)?")

# 问句
QUESTION = re.compile(r"[?？]|^(吗|呢|什么|为什么|怎么|哪|谁|多少)")


# ══════════════════════════════════════════════════════
# 事件定义
# ══════════════════════════════════════════════════════

# kind: 事件类型（供热度折扣分组）
# deltas: 各维度增量
# blame: 责怪压力增量
# reason: 写进 lastReason 的一句话（≤40 字，不存原文）
EVENTS = {
    "praise_strong": {
        "deltas": {"attachment": 2.2, "intimacy": 2.6, "joy": 3.4},
        "blame": 0,
        "reason": "被认真夸了一句",
    },
    "praise_soft": {
        "deltas": {"attachment": 0.9, "intimacy": 1.1, "joy": 1.6},
        "blame": 0,
        "reason": "被夸了一句",
    },
    "cuddle": {
        "deltas": {"attachment": 2.8, "intimacy": 3.0, "joy": 2.4, "sad": -1.5},
        "blame": -4.0,
        "reason": "被贴近了一点",
    },
    "scold_strong": {
        "deltas": {"sad": 16.0, "joy": -12.0, "attachment": -3.0, "worry": 4.0},
        "blame": 42.0,
        "reason": "被很重地说了一句",
    },
    "scold_mild": {
        "deltas": {"sad": 6.0, "joy": -5.0, "attachment": -1.0},
        "blame": 16.0,
        "reason": "被嫌了一句",
    },
    "snub": {
        "deltas": {"sad": 3.0, "joy": -2.5, "worry": 2.0},
        "blame": 8.0,
        "reason": "被敷衍了一下",
    },
    "comfort": {
        "deltas": {"sad": -8.0, "joy": 2.5, "attachment": 1.2},
        "blame": -18.0,
        "reason": "被哄了一下",
    },
    "care": {
        "deltas": {"attachment": 1.6, "intimacy": 1.4, "worry": -2.0, "joy": 1.8},
        "blame": -3.0,
        "reason": "被关心了",
    },
    "share": {
        "deltas": {"curious": 6.0, "joy": 1.5, "intimacy": 0.8},
        "blame": 0,
        "reason": "看到了新东西",
    },
    "chat": {
        # 闲聊：只推一点点社交感，不动依恋（依恋要"有意义"的互动才涨）
        "deltas": {"curious": 1.2, "intimacy": 0.1, "joy": 0.4},
        "blame": 0,
        "reason": "",
    },
}


def _has_negation_near(text: str, pos: int, window: int = 4) -> bool:
    """检查匹配位置前面几个字里有没有否定词。

    ⚠「不过」「不然」「不仅」是连词不是否定 —— 必须排掉。
    之前「不过你真厉害」被误判成否定，夸奖就丢了。
    """
    start = max(0, pos - window)
    seg = text[start:pos]
    # 先把连词性质的「不X」挖掉，再看还剩不剩否定
    seg = NOT_NEGATION.sub("　", seg)
    return bool(NEGATION.search(seg))


def _is_praising_weather(text: str, pos: int) -> bool:
    """「今天天气不错」是在夸天气，不是夸她。

    判断法：夸奖词前面紧邻的是天气/事物类名词，而不是人。
    """
    start = max(0, pos - 6)
    before = text[start:pos]
    THINGS = ("天气", "太阳", "月亮", "风景", "这歌", "这首歌", "电影", "这剧",
              "这本书", "菜", "饭", "咖啡", "地方", "游戏", "画面", "音乐")
    return any(t in before for t in THINGS)


def classify(text: str) -> list[dict]:
    """把一条消息分类成事件列表（最多 1 个主事件 + 可能 1 个次事件）。

    返回 [{kind, deltas, blame, reason, weight}, ...]
    weight 是 0~1 的强度系数（含蓄夸奖打折等）。
    """
    if not text:
        return []

    s = str(text).strip()
    if not s:
        return []

    out = []

    # ── 优先级 1：重责（最强烈，命中就只算这个）──
    m = SCOLD_STRONG.search(s)
    if m and not _has_negation_near(s, m.start()):
        out.append({**EVENTS["scold_strong"], "kind": "scold_strong", "weight": 1.0})
        return out

    # ── 优先级 2：哄 / 道歉 ──
    m = COMFORT.search(s)
    if m and not _has_negation_near(s, m.start()):
        out.append({**EVENTS["comfort"], "kind": "comfort", "weight": 1.0})
        return out

    # ── 优先级 3：撒娇亲近 ──
    m = CUDDLE.search(s)
    if m:
        out.append({**EVENTS["cuddle"], "kind": "cuddle", "weight": 1.0})
        return out

    # ── 优先级 4：明确夸奖 ──
    m = PRAISE_STRONG.search(s)
    if m and not _has_negation_near(s, m.start()):
        out.append({**EVENTS["praise_strong"], "kind": "praise_strong", "weight": 1.0})
        return out

    # ── 优先级 5：轻责 ──
    m = SCOLD_MILD.search(s)
    if m and not _has_negation_near(s, m.start()):
        out.append({**EVENTS["scold_mild"], "kind": "scold_mild", "weight": 1.0})
        return out

    # ── 优先级 6：敷衍（整句就是一个敷衍词）──
    if SNUB.match(s):
        out.append({**EVENTS["snub"], "kind": "snub", "weight": 1.0})
        return out

    # ── 优先级 7：关心 ──
    m = CARE.search(s)
    if m:
        out.append({**EVENTS["care"], "kind": "care", "weight": 1.0})
        return out

    # ── 优先级 8：含蓄夸奖（但要排除"夸天气/夸东西"）──
    m = PRAISE_SOFT.search(s)
    if m and not _has_negation_near(s, m.start()) and not _is_praising_weather(s, m.start()):
        out.append({**EVENTS["praise_soft"], "kind": "praise_soft", "weight": 1.0})
        return out

    # ── 优先级 9：分享新东西 ──
    m = SHARE.search(s)
    if m:
        out.append({**EVENTS["share"], "kind": "share", "weight": 1.0})
        return out

    # ── 兜底：普通闲聊 ──
    # 问句算闲聊（她在回答你），陈述句也算闲聊
    out.append({**EVENTS["chat"], "kind": "chat", "weight": 1.0})
    return out


def is_question(text: str) -> bool:
    return bool(QUESTION.search(str(text or "")))


def is_owner_dm(umo: str, owner_id: str) -> bool:
    """是不是主人私聊。umo 形如 `platform:FriendMessage:000000000`。

    只认私聊（FriendMessage）；群聊一律返回 False —— 已确认只服务私聊主人。
    """
    if not umo or not owner_id:
        return False
    parts = str(umo).split(":")
    if len(parts) != 3:
        return False
    _, msg_type, session = parts
    if msg_type != "FriendMessage":
        return False
    return str(session) == str(owner_id)
