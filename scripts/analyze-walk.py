import json

rows = []
for line in open("/opt/dafeiyu-room/state/client-debug.log", encoding="utf-8"):
    try:
        d = json.loads(line)
    except Exception:
        continue
    if "sector" in d:
        rows.append(d)

print("samples with sector:", len(rows))
for d in rows[-20:]:
    clip = d.get("clip")
    sector = d.get("sector")
    flip = d.get("flip")
    vel = d.get("vel")
    walking = d.get("walking")
    room = d.get("room")
    print(f"{clip} sector={sector} flip={flip} vel={vel} walk={walking} room={room}")
