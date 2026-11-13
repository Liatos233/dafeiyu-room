import json, sys

path = "/opt/dafeiyu-room/state/client-debug.log"
rows = []
for line in open(path, encoding="utf-8"):
    line = line.strip()
    if not line:
        continue
    try:
        d = json.loads(line)
    except Exception:
        continue
    if "clip" not in d:
        continue
    rows.append(d)

print("客户端样本数:", len(rows))
if not rows:
    sys.exit(0)

def fmt(d):
    return (
        f'{d.get("clip")} | {d.get("spot")} {d.get("pose")}/{d.get("kind")} | '
        f'server={d.get("elev")} shown={d.get("shownElev")} display={d.get("displayElev")} '
        f'walk={d.get("walking")} chaise={d.get("chaise")} sofa={d.get("sofa")} seat={d.get("seatOverride")}'
    )

print("--- 最后 15 条 ---")
for d in rows[-15:]:
    print(fmt(d))

print("--- 异常：displayElev>0.05 但 pose 不是 sit/lie ---")
bad = [d for d in rows if (d.get("displayElev") or 0) > 0.05 and d.get("pose") not in ("sit", "lie")]
for d in bad[-10:]:
    print(fmt(d))
print("异常条数:", len(bad))

print("--- 异常：walking 但 displayElev>0.05 ---")
bad2 = [d for d in rows if d.get("walking") and (d.get("displayElev") or 0) > 0.05]
for d in bad2[-10:]:
    print(fmt(d))
print("异常条数:", len(bad2))
