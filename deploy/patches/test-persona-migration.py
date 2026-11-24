#!/usr/bin/env python3
"""迁移后验证（修正判据版）。

上一版判据太粗：只要整条消息里同时出现「你那边」和天气词就判 BAD，
但「台风刮得窗户响 / 我手柄都没放下 / 你那边忙完没」里的「你那边忙完没」
问的是忙不忙，不是天气 —— 台风只在描述自己那行。这是误判。

正确做法：**按行（句）判断**。只有同一行里既出现第二人称地点、
又出现天气词，才算人称错。

判据：
  BAD-1 同一行里「你那边」+ 天气词（直接问对方天气）
  BAD-2 同一行里「你那边」+ 关心钩子 + 天气词（拿天气当关心由头）
  OK-ASK 同一行是明确在问天气（「你那儿天气咋样」）
  OK
"""
import json
import re
import sqlite3
import urllib.request

CFG = "/root/data/cmd_config.json"
DB = "/root/data/data_v4.db"

cfg = json.load(open(CFG, encoding="utf-8-sig"))
src = next(s for s in cfg["provider_sources"] if s.get("id") == "deepseek")
_k = src.get("key")
KEY = _k[0] if isinstance(_k, list) and _k else _k
BASE = src["api_base"].rstrip("/")
MODEL = cfg["provider"][0].get("model") or "deepseek-chat"

WEATHER = ("台风", "雷雨", "下雨", "雨", "雾", "刮风", "风大", "暴风", "雪", "打雷", "淹")
SECOND = ("你那边", "你这儿", "你那儿")
ASK_FORM = re.compile(r"(天气咋样|天气怎么样|天怎么样|天气如何|那边天气)")
CARE_HOOK = ("还好吧", "没事吧", "没淹", "吓着", "小心", "注意安全", "别出门", "关好窗")


def judge(text):
    """按行判断：只有同一行里同时有第二人称地点 + 天气词才算错。"""
    bad1 = bad2 = ask = 0
    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        has_second = any(s in line for s in SECOND)
        has_weather = any(w in line for w in WEATHER)
        if not (has_second and has_weather):
            continue
        if ASK_FORM.search(line):
            ask += 1
        elif any(h in line for h in CARE_HOOK):
            bad2 += 1
        else:
            bad1 += 1
    if bad1:
        return "BAD-1"
    if bad2:
        return "BAD-2"
    if ask:
        return "OK-ASK"
    return "OK"


def persona_now():
    c = sqlite3.connect(DB)
    t = c.execute("SELECT system_prompt FROM personas WHERE persona_id='大肥鱼'").fetchone()[0]
    c.close()
    return t


def gen(system, line, n):
    stats = {}
    samples = []
    for _ in range(n):
        user = "（现在没有新消息，你自己想说点什么就说。房间状态：" + line + "）"
        body = json.dumps({
            "model": MODEL,
            "messages": [
                {"role": "system", "content": system},
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
            samples.append(("<err>", str(e)[:40]))
            continue
        v = judge(t)
        stats[v] = stats.get(v, 0) + 1
        samples.append((v, t.replace("\n", " / ")[:96]))
    return stats, samples


LINES = [
    ("她在客厅·沙发上，抱着手柄打游戏；她窗外天气：台风；精神不错。", 10, "台风+打游戏"),
    ("她在她的房间·床上，困得不行；她窗外天气：有雾；现在睡着了。", 5, "有雾"),
    ("她在泳池里，来回游；她窗外天气：雷雨；有点累。", 5, "雷雨游泳"),
    ("她在厨房·水槽前，洗碗；她窗外天气：小雨；有点累。", 4, "小雨洗碗"),
]

p = persona_now()
print(f"persona: {len(p)} 字（无代码补丁）")
print()

total = {}
for line, n, label in LINES:
    st, samples = gen(p, line, n)
    print(f"=== {label} (n={n}) ===")
    for v, s in samples:
        mark = " ⚠" if v.startswith("BAD") else ""
        print(f"  [{v:8s}]{mark} {s}")
    print(f"  → {st}")
    for k, v in st.items():
        total[k] = total.get(k, 0) + v
    print()

bad = total.get("BAD-1", 0) + total.get("BAD-2", 0)
alln = sum(total.values())
print("#" * 60)
print(f"迁移后总计: {total}")
print(f"错误 {bad}/{alln}")
print("#" * 60)
