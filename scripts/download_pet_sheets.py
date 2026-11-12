import json
import os
import sys
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = "https://raw.githubusercontent.com/hunmer/aboutme-pets/main/"
ROOT = r"C:\Users\liato\dafeiyu-room\app\public\room\assets\pet-sheets"
PACKS = ["dsh", "dsh1"]

sys.stdout.reconfigure(encoding="utf-8")


def get(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 1024:
        return ("skip", path, os.path.getsize(path))
    req = urllib.request.Request(url, headers={"User-Agent": "room-import/1.0"})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = r.read()
    tmp = path + ".part"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)
    return ("ok", path, len(data))


def main():
    total = 0
    errors = []
    for pack in PACKS:
        manifest_url = f"{BASE}pets/{pack}/actions.json"
        mpath = os.path.join(ROOT, pack, "actions.json")
        os.makedirs(os.path.dirname(mpath), exist_ok=True)
        if not os.path.exists(mpath):
            get(manifest_url, mpath)
        acts = json.load(open(mpath, encoding="utf-8")).get("animations", [])
        jobs = []
        for a in acts:
            rel = (a.get("sources") or {}).get("webp")
            if not rel:
                continue
            url = BASE + "pets/" + pack + "/" + urllib.parse.quote(rel.replace("\\", "/"))
            dest = os.path.join(ROOT, pack, "spritesheet", os.path.basename(rel.replace("\\", "/")))
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            jobs.append((url, dest))
        print(f"[{pack}] {len(jobs)} 个精灵图待下载", flush=True)
        done = 0
        with ThreadPoolExecutor(max_workers=8) as ex:
            futs = {ex.submit(get, u, d): (u, d) for u, d in jobs}
            for fut in futs:
                try:
                    st, path, size = fut.result()
                    total += size
                    done += 1
                    if done % 20 == 0:
                        print(f"  {pack}: {done}/{len(jobs)} 累计 {total/1048576:.1f} MB", flush=True)
                except Exception as e:  # noqa: BLE001
                    errors.append(str(e)[:160])
        print(f"[{pack}] 完成 {done}/{len(jobs)}", flush=True)
    print(f"总计约 {total/1048576:.1f} MB，错误 {len(errors)}", flush=True)
    for e in errors[:10]:
        print(" -", e, flush=True)


if __name__ == "__main__":
    t0 = time.time()
    main()
    print(f"耗时 {time.time()-t0:.0f}s", flush=True)
