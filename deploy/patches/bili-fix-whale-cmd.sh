#!/bin/bash
# 修「说『鲸鱼肉什么味道的』会被当成命令执行」。
#
# 现象：用户随口问「鲸鱼肉什么味道的」，她回「不认识的子命令：肉是什么味道的」。
#
# 根因：bili_whale 把「鲸鱼」注册成了命令别名：
#   ENTRY_NAMES = ("bili", "养鱼", "鲸鱼")
#   @filter.command("鲸鱼")
#   _WORDY_RE = re.compile(r"^(?:bili|养鱼|鲸鱼)[A-Za-z0-9]")   # 只挡英文/数字
# 于是任何以「鲸鱼」开头的中文都会被截成 `鲸鱼 <剩余>` 当命令，
# 而「鲸鱼」本身是她的称呼（人设里叫「鲸鲸」），根本不适合做命令。
#
# 改法：
#   1. 去掉 @filter.command("鲸鱼")（保留 bili / 养鱼）
#   2. ENTRY_NAMES 去掉「鲸鱼」，连写容错也跟着不再把「鲸鱼xxx」当命令
#
# 用法（AstrBot 所在机器，root）：
#   bash bili-fix-whale-cmd.sh
#   systemctl restart astrbot
#
# 幂等。
set -euo pipefail

PLUGINS=${PLUGINS:-/root/data/plugins}
BW="$PLUGINS/astrbot_plugin_bili_whale/main.py"
PY=${PY:-/opt/astrbot/venv/bin/python}
STAMP=$(date +%Y%m%d-%H%M%S)

cp -p "$BW" "$BW.bak-whalecmd-$STAMP"
python3 - "$BW" <<'PY'
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()

if '_whale_cmd_removed' in s:
    print('· 已去掉「鲸鱼」命令')
    raise SystemExit

# 1) 去掉命令注册
old_cmd = '''    @filter.command("bili")
    @filter.command("养鱼")
    @filter.command("鲸鱼")'''
new_cmd = '''    @filter.command("bili")
    @filter.command("养鱼")
    # _whale_cmd_removed：「鲸鱼」不再注册成命令。
    # 它是她的称呼，任何以「鲸鱼」开头的中文都会被截成命令，
    # 比如「鲸鱼肉什么味道的」→「不认识的子命令：肉是什么味道的」。'''
if old_cmd in s:
    s = s.replace(old_cmd, new_cmd, 1)
    print('· 去掉 @filter.command("鲸鱼")')
else:
    print('! 没找到命令注册块')

# 2) ENTRY_NAMES 去掉鲸鱼
old_names = 'ENTRY_NAMES = ("bili", "养鱼", "鲸鱼")'
new_names = 'ENTRY_NAMES = ("bili", "养鱼")  # _whale_cmd_removed：去掉「鲸鱼」'
if old_names in s:
    s = s.replace(old_names, new_names, 1)
    print('· ENTRY_NAMES 去掉鲸鱼')
else:
    print('! 没找到 ENTRY_NAMES')

open(p, 'w', encoding='utf-8').write(s)
PY

"$PY" -m py_compile "$BW" && echo "syntax OK"
echo
echo "=== 确认 ==="
grep -n 'ENTRY_NAMES\|filter.command("鲸鱼")' "$BW" | head -5

echo
echo "完成。执行：systemctl restart astrbot"
echo "验证：发「鲸鱼肉什么味道的」应该正常聊天，回「不认识的子命令」"
