import os, tarfile, sqlite3, shutil, tempfile

DATA = r"C:\Users\liato\.astrbot_launcher\instances\0390ed20-69d8-4e5b-b449-055ce88e34dc\core\data"
OUT = r"C:\Users\liato\dafeiyu-room\_migrate\astrbot-full-state.tar.gz"

# 需要迁移的插件数据（排除 snowluma：那是 QQ 客户端安装目录，与机器绑定）
PLUGIN_DATA_KEEP = [
    "astrbot_plugin_livingmemory",
    "astrbot_plugin_memewiki",
    "meme_manager",
    "astrbot_plugin_bili_whale",
    "astrbot_plugin_group_chat_plus",
    "astrbot_plugin_proactive_chat",
    "astrbot_plugin_qqprofile",
    "astrbot_plugin_qzone",
    "astrbot_plugin_room_link",
    "astrbot_plugin_dafeiyu_clean",
    "astrbot_plugin_dafeiyu_signature",
    "astrbot_plugin_dafeiyu_sing",
    "astrbot_plugin_seed_audio_tts",
]
SQLITE_EXT = (".db", ".sqlite", ".sqlite3", ".db3")
EXCLUDE_DIRS = {"__pycache__", ".git", "node_modules"}

tmp = tempfile.mkdtemp(prefix="astrbot-state-")

def copytree_safe(src, dst):
    """复制目录；sqlite 文件用 backup API 保证一致性"""
    for root, dirs, files in os.walk(src):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        rel = os.path.relpath(root, src)
        outdir = os.path.join(dst, rel) if rel != "." else dst
        os.makedirs(outdir, exist_ok=True)
        for f in files:
            sp = os.path.join(root, f)
            dp = os.path.join(outdir, f)
            try:
                if f.lower().endswith(SQLITE_EXT):
                    src_db = sqlite3.connect(f"file:{sp}?mode=ro", uri=True)
                    dst_db = sqlite3.connect(dp)
                    with dst_db:
                        src_db.backup(dst_db)
                    dst_db.close()
                    src_db.close()
                else:
                    shutil.copy2(sp, dp)
            except Exception as e:
                print(f"  skip {f}: {e}")

# 1) 插件数据
pd_src = os.path.join(DATA, "plugin_data")
pd_dst = os.path.join(tmp, "plugin_data")
for name in PLUGIN_DATA_KEEP:
    src = os.path.join(pd_src, name)
    if os.path.isdir(src):
        print(f"打包 {name} …")
        copytree_safe(src, os.path.join(pd_dst, name))

# 2) 插件配置
cfg_src = os.path.join(DATA, "config")
cfg_dst = os.path.join(tmp, "config")
os.makedirs(cfg_dst, exist_ok=True)
# 环境相关配置不随包走（换了机器会因为路径/端口不对而失效）
ENV_SPECIFIC_CFG = {
    "astrbot_plugin_room_link_config.json",      # bridge_dir / bridge_port
    "pulids_snowluma_go_to_astrbot_config.json",  # 本机 SnowLuma 路径
}
for f in os.listdir(cfg_src):
    if f.endswith(".json") and f not in ENV_SPECIFIC_CFG:
        shutil.copy2(os.path.join(cfg_src, f), os.path.join(cfg_dst, f))

# 3) 主配置 / 核心库 / 插件清单
for f in ("cmd_config.json", "data_v4.db", "plugins.json", "mcp_server.json"):
    sp = os.path.join(DATA, f)
    if os.path.isfile(sp):
        if f.endswith(SQLITE_EXT):
            src_db = sqlite3.connect(f"file:{sp}?mode=ro", uri=True)
            dst_db = sqlite3.connect(os.path.join(tmp, f))
            with dst_db:
                src_db.backup(dst_db)
            dst_db.close(); src_db.close()
        else:
            shutil.copy2(sp, os.path.join(tmp, f))

with tarfile.open(OUT, "w:gz") as tar:
    for name in os.listdir(tmp):
        tar.add(os.path.join(tmp, name), arcname=name)

shutil.rmtree(tmp, ignore_errors=True)
print(f"完成: {os.path.getsize(OUT)/1024/1024:.0f} MB -> {OUT}")
