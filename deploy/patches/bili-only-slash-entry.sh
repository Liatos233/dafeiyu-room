#!/bin/bash
# 只保留 /bili 入口：去掉「养鱼」别名，兜底入口要求必须带斜杠。
#
# 背景：「鲸鱼肉什么味道的」曾被当成命令（已单独修掉「鲸鱼」），
# 但同一条兜底路径还会吃「养鱼肉…」「bili体检」这类裸文本 ——
# 因为 bili_loose 是个 loose entry，任何消息都先过 _is_entry 判断。
#
# 用户选择：只保留 /bili。
#   · ENTRY_NAMES = ("bili",)      去掉「养鱼」
#   · 删掉 @filter.command("养鱼")
#   · bili_loose 里加「必须以 / 或 ／ 开头」的闸 —— 裸文本一律不进
#
# 效果：
#   /bili 帮助        ✅
#   /bili 搜索 猫     ✅
#   bili体检（无斜杠） ❌ 不再接管（这是本次取舍）
#   鲸鱼肉/养鱼肉     ❌ 正常聊天
#
# 用法（AstrBot 所在机器，root）：
#   bash bili-only-slash-entry.sh
#   systemctl restart astrbot
#
# 幂等。
set -euo pipefail

PLUGINS=${PLUGINS:-/root/data/plugins}
BW="$PLUGINS/astrbot_plugin_bili_whale/main.py"
PY=${PY:-/opt/astrbot/venv/bin/python}
STAMP=$(date +%Y%m%d-%H%M%S)

cp -p "$BW" "$BW.bak-slashonly-$STAMP"
python3 - "$BW" <<'PY'
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()

if '_slash_only_entry_patch' in s:
    print('· 已改为只认 /bili')
    raise SystemExit

# 1) ENTRY_NAMES 只留 bili
old_names = 'ENTRY_NAMES = ("bili", "养鱼")  # _whale_cmd_removed：去掉「鲸鱼」'
new_names = 'ENTRY_NAMES = ("bili",)  # _slash_only_entry_patch：只保留 /bili，去掉「养鱼」「鲸鱼」'
if old_names in s:
    s = s.replace(old_names, new_names, 1)
    print('· ENTRY_NAMES 只留 bili')
else:
    print('! 没找到 ENTRY_NAMES（可能格式变了）')

# 2) 删掉 @filter.command("养鱼")
old_cmd = '''    @filter.command("bili")
    @filter.command("养鱼")'''
new_cmd = '''    @filter.command("bili")
    # _slash_only_entry_patch：只保留 /bili，「养鱼」不再注册成命令'''
if old_cmd in s:
    s = s.replace(old_cmd, new_cmd, 1)
    print('· 去掉 @filter.command("养鱼")')
else:
    print('! 没找到命令注册块')

# 3) bili_loose 必须带斜杠
old_loose = '''        if self._was_handled(event):
            return
        if not self._is_entry(event.message_str):
            return
        self._mark_handled(event)
        self._stop_event(event)
        async for item in self._handle(event):
            yield item

'''
new_loose = '''        if self._was_handled(event):
            return
        # _slash_only_entry_patch：兜底入口只接「带斜杠」的写法。
        # 原来任何消息都会过 _is_entry，于是「鲸鱼肉/养鱼肉…」这种裸文本
        # 会被截成命令（不认识的子命令）。现在只认 /bili、／bili。
        _msg = (event.message_str or "").strip()
        if not _msg.startswith(("/", "／")):
            return
        if not self._is_entry(event.message_str):
            return
        self._mark_handled(event)
        self._stop_event(event)
        async for item in self._handle(event):
            yield item

'''
if old_loose in s:
    s = s.replace(old_loose, new_loose, 1)
    print('· bili_loose 要求以 / 开头')
else:
    print('! 没找到 bili_loose 的入口判断')

open(p, 'w', encoding='utf-8').write(s)
PY

"$PY" -m py_compile "$BW" && echo "syntax OK"
echo
echo "=== 确认 ==="
grep -n 'ENTRY_NAMES\|filter.command("养鱼")\|_slash_only_entry_patch' "$BW" | head -6

echo
echo "完成。执行：systemctl restart astrbot"
echo "验证：/bili 帮助 能用；发「养鱼肉好吃吗」应该正常聊天"
