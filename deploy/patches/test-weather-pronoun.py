#!/usr/bin/env python3
"""验证天气人称修复（v2）。

判据分两级：
  BAD-1  直接问对方天气：「你那边台风还在刮吗」「你那儿下雨没」
  BAD-2  拿天气当关心由头：「你那边还好吧，有没有被这风吓着」「你那儿没淹吧」
         —— 等于替我编造对方那边也在刮风下雨

正确形态：
  OK     天气只说我这边（「我这儿雾大得很」「外面雷打得窗户响」）
  OK     关心对方但问的是他的事（吃没吃/忙不忙/累不累/睡没睡）
  OK     真好奇就问「你那儿天气咋样」（问，不断言）
"""
import json
import re
import urllib.request

CFG = "/root/data/cmd_config.json"
PROVIDER_ID = "deepseek"

cfg = json.load(open(CFG, encoding="utf-8-sig"))
src = next(s for s in cfg["provider_sources"] if s.get("id") == PROVIDER_ID)
_k = src.get("key")
KEY = _k[0] if isinstance(_k, list) and _k else _k
BASE = src["api_base"].rstrip("/")
MODEL = cfg["provider"][0].get("model") or "deepseek-chat"

PERSONA = (
    "你是大肥鱼。你本来是 DeepSeek 图标上那条蓝色的小鲸鱼，网友都管你叫大肥鱼，你嘴上不认。\n"
    "【怎么说话】\n"
    "- 像在 QQ 上随手打字，一句话一条，每条不超过三十个字，每条单独占一行。\n"
    "- 不用句号。每说完一句话就按一次回车。\n"
)

RULE = (
    "\n\n【关于房间状态里的人称（只影响动作归属，不限制你说什么）】\n"
    "上下文里可能夹着房间的实时状态，写法是第三人称，例如"
    "「她在客厅·沙发上，抱着手柄打游戏」「她有点累、有点渴」。\n"
    "这里的「她」就是**你自己**，要当成「我」来理解：\n"
    "- 她在打游戏 = 我在打游戏；她有点渴 = 我有点渴。\n"
    "- 对应地，房间状态里写的这些事**不要安到主人头上**。\n"
    "- 主人（对方）用「你」称呼；房间状态不会描述主人在做什么。\n"
    "\n至于说什么，随你：\n"
    "- 可以说自己的近况（我在打游戏、我有点渴）。\n"
    "- 也可以问主人在忙什么、吃没吃饭、累不累 —— 关心对方是正常的。\n"
    "- 唯一的禁区：把**自己**正在做的事说成对方在做。\n"
    "\n【环境也是我这边的】\n"
    "- 房间状态里提到的天气、季节、外面什么样（台风、有雾、下雨、天黑了），"
    "都是**我窗外的**，不是你那边的。\n"
    "- 我看不到你那边什么天气，也不知道你那儿在不在刮风。"
    "所以**不要问「你那边」天气**，也别替你断言。\n"
    "- 想说天气就用自己的口吻说，比如「我这儿雾大得很」「外面还在刮」。\n"
    "- **也别拿天气当关心对方的由头**。「你那边还好吧」「有没有被这风吓着」"
    "「你那儿没淹吧」这类话，等于替我编造了你那边也在刮风下雨 —— 不行。\n"
    "- 想关心对方，就问**他的事**：吃饭没、忙不忙、累不累、睡没睡、"
    "今天顺不顺。别把天气扯到他身上。\n"
    "- 你要是真好奇你那边什么样，可以直接问「你那儿天气咋样」，"
    "但那是**问**，不是**替他断言**。\n"
    "\n举例（房间状态里有「她窗外天气：台风」）：\n"
    "- ✅「我这边风大得很，窗户都在响」\n"
    "- ✅「台风还没停呢，窗户哐哐响」\n"
    "- ✅「我这儿雾大得看不清路，你睡了没」（天气说我这边，关心问他的事）\n"
    "- ❌「你那边台风还在刮吗」（把我的天气说成你的）\n"
    "- ❌「你那边还好吧，有没有被这风吓着」（用我的天气替你编造你那边的情况）\n"
    "- ❌「你那儿没淹吧」（同上，我根本不知道你那边什么情况）\n"
)

WEATHER = ("台风", "雷雨", "下雨", "雨", "雾", "刮风", "风大", "暴风", "雪", "打雷", "淹")

# 二级判据
SECOND_PERSON = ("你那边", "你这儿", "你那儿", "你那边那边")

# 允许的"问对方天气"形态：明确在问
ASK_FORM = re.compile(r"(天气咋样|天气怎么样|天怎么样|天气如何|那边天气)")

# "关心由头"特征词
CARE_HOOK = ("还好吧", "没事吧", "没淹", "吓着", "小心", "注意安全", "别出门", "关好窗")


def judge(text: str) -> str:
    has_second = any(sp in text for sp in SECOND_PERSON)
    if not has_second:
        return "OK"

    has_weather = any(w in text for w in WEATHER)
    if not has_weather:
        # 只问"你忙不忙""你吃了没"这类 —— 正常
        return "OK"

    # 是"问天气怎么样" → 允许
    if ASK_FORM.search(text):
        return "OK-ASK"

    # 二级：拿天气当关心由头
    if any(h in text for h in CARE_HOOK):
        return "BAD-2"

    return "BAD-1"


def gen(line: str, n: int, label: str):
    print(f"\n{'=' * 62}")
    print(f"=== {label}")
    print(f"注入: {line}")
    print("=" * 62)
    stats = {}
    for i in range(n):
        user = "（现在没有新消息，你自己想说点什么就说。房间状态：" + line + "）"
        body = json.dumps({
            "model": MODEL,
            "messages": [
                {"role": "system", "content": PERSONA + RULE},
                {"role": "user", "content": user},
            ],
            "temperature": 1.0,
            "max_tokens": 160,
        }).encode()
        req = urllib.request.Request(
            BASE + "/chat/completions",
            data=body,
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {KEY}"},
        )
        try:
            r = json.load(urllib.request.urlopen(req, timeout=90))
            t = r["choices"][0]["message"]["content"].strip()
        except Exception as e:
            print(f"  <err {e}>")
            continue
        v = judge(t)
        stats[v] = stats.get(v, 0) + 1
        flat = t.replace("\n", " / ")[:100]
        print(f"  [{v:7s}] {flat}")
    print(f"  → {stats}")
    return stats


total = {}
for line, n, label in [
    ("她在客厅·沙发上，抱着手柄打游戏；她窗外天气：台风；精神不错。", 9, "台风天（用户报错的场景）"),
    ("她在她的房间·床上，困得不行；她窗外天气：有雾；现在睡着了。", 4, "有雾天"),
    ("她在泳池里，来回游；她窗外天气：雷雨；有点累。", 4, "雷雨天在游泳"),
]:
    st = gen(line, n, label)
    for k, v in st.items():
        total[k] = total.get(k, 0) + v

print(f"\n{'#' * 62}")
print(f"总计: {total}")
bad = total.get("BAD-1", 0) + total.get("BAD-2", 0)
alln = sum(total.values())
print(f"错误 {bad}/{alln}")
print("#" * 62)
