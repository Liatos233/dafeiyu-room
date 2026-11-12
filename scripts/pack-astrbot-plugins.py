import os, tarfile, pathlib

SRC = r"C:\Users\liato\.astrbot_launcher\instances\0390ed20-69d8-4e5b-b449-055ce88e34dc\core\data"
PLUGINS = os.path.join(SRC, "plugins")
CFG = os.path.join(SRC, "config")
OUT = r"C:\Users\liato\dafeiyu-room\_migrate\astrbot-plugins.tar.gz"

# 已单独部署过，不重复打包
SKIP = {"astrbot_plugin_room_link", "pulids_snowluma_go_to_astrbot"}
EXCLUDE_DIRS = {"__pycache__", ".git", "node_modules", ".venv", "data"}

def add_dir(tar, base, arcbase):
    for root, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        for f in files:
            if f.endswith((".pyc", ".pyo")):
                continue
            p = os.path.join(root, f)
            arc = os.path.join(arcbase, os.path.relpath(p, base))
            try:
                tar.add(p, arcname=arc)
            except OSError:
                pass

os.makedirs(os.path.dirname(OUT), exist_ok=True)
count = 0
with tarfile.open(OUT, "w:gz") as tar:
    for name in sorted(os.listdir(PLUGINS)):
        d = os.path.join(PLUGINS, name)
        if not os.path.isdir(d) or name in SKIP:
            continue
        add_dir(tar, d, os.path.join("plugins", name))
        count += 1
    for name in sorted(os.listdir(CFG)):
        if not name.endswith("_config.json"):
            continue
        if name.startswith(("astrbot_plugin_room_link", "pulids_snowluma")):
            continue
        tar.add(os.path.join(CFG, name), arcname=os.path.join("config", name))

size = os.path.getsize(OUT) / 1024 / 1024
print(f"打包完成: {count} 个插件, {size:.1f} MB -> {OUT}")
