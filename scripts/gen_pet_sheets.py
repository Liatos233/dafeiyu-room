import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHEETS = os.path.join(ROOT, "public", "room", "assets", "pet-sheets")
OUT = os.path.join(ROOT, "public", "room", "pet-sheets.js")

# 游戏行为 -> 精灵图动作（包/动作名）
MAP = {
    "idle": ("dsh", "待机呼吸休闲"),
    "idle_look": ("dsh", "东张西望"),
    "idle_hum": ("dsh", "碎碎念-发呆碎碎念"),
    "walk": ("dsh1", "走路"),
    "walk_fast": ("dsh1", "走路"),
    "run_happy": ("dsh", "原地左转奔跑"),
    "run_hurry": ("dsh", "原地左转奔跑"),
    "back_idle": ("dsh", "待机呼吸休闲"),
    "sleep_in": ("dsh1", "沙发打瞌睡"),
    "sleep_loop": ("dsh1", "沙发打瞌睡"),
    "sleep_out": ("dsh", "打瞌睡被惊醒"),
    "eat_rice": ("dsh", "吃午餐"),
    "eat_snack": ("dsh", "大口吃零食"),
    "wait_food": ("dsh", "吃早餐"),
    "brush": ("dsh", "晨间刷牙"),
    "mirror": ("dsh", "优雅女仆舞"),
    "desk_code": ("dsh", "写代码"),
    "desk_tap": ("dsh", "工作状态-忙碌点按"),
    "desk_mutter": ("dsh", "工作状态-思考冒泡"),
    "fan": ("dsh1", "雪克杯摇奶茶"),
    "mooncake": ("dsh", "中秋赏月吃月饼"),
    "kite": ("dsh", "螃蟹走路"),
    "react_happy": ("dsh", "点击回应-开心跃动"),
    "react_shy": ("dsh", "点击回应-挠痒咯咯笑"),
    "react_scare": ("dsh", "点击回应-傲娇生气"),
    "stretch": ("dsh", "超大伸懒腰"),
    "sick": ("dsh1", "生气鼓腮跺脚"),
    "game": ("dsh", "工作状态-雀跃庆祝"),
    "dance": ("dsh", "优雅女仆舞"),
    "nap": ("dsh1", "站着晃神打瞌睡"),
    "curtsy": ("dsh", "优雅女仆舞"),
    "yawn": ("dsh", "超大伸懒腰"),
    "mutter": ("dsh", "碎碎念-发呆碎碎念"),
    "drink": ("dsh1", "举杯敬酒"),
}


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    meta = {}
    names = {}
    for pack in ("dsh", "dsh1"):
        path = os.path.join(SHEETS, pack, "actions.json")
        data = json.load(open(path, encoding="utf-8"))
        for a in data.get("animations", []):
            rel = (a.get("sources") or {}).get("webp")
            if not rel:
                continue
            base = rel.replace("\\", "/").split("/")[-1]
            sp = a.get("spritesheet") or {}
            key = f"{pack}/{a['id']}"
            meta[key] = {
                "file": f"assets/pet-sheets/{pack}/spritesheet/{base}",
                "fw": sp.get("frameWidth", 640),
                "fh": sp.get("frameHeight", 360),
                "cols": sp.get("columns", 8),
                "count": sp.get("frameCount", 1),
                "fps": sp.get("fps", 12),
            }
            names[key] = a["id"]

    clips = {}
    missing = []
    for k, (pack, name) in MAP.items():
        key = f"{pack}/{name}"
        if key in meta:
            clips[k] = key
        else:
            missing.append(key)

    lines = [
        "// 由 scripts/gen_pet_sheets.py 生成：aboutme-pets 精灵图元数据",
        "// 素材来源：https://github.com/hunmer/aboutme-pets （禁止商用，二创需署名上游 PC2005-cloud/dsh-pet）",
        "export const SHEET_META = " + json.dumps(meta, ensure_ascii=False, indent=0) + ";",
        "export const SHEET_CLIPS = " + json.dumps(clips, ensure_ascii=False, indent=2) + ";",
        "",
    ]
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    print(f"写出 {OUT}：{len(meta)} 个动作，映射 {len(clips)} 个行为")
    if missing:
        print("缺失映射：", missing)


if __name__ == "__main__":
    main()
