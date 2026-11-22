#!/bin/bash
# 修两件事：
#   1. 模型偶尔把「工具调用」当文本吐出来（<qqprofile_set_avatar> <image>/path</image>），
#      这些标签会直接发到聊天里。dafeiyu_clean 插件负责清洗这类残留，但它的规则里
#      只覆盖了 system_reminder / DSML / tool_call，没有这种「工具名标签」。
#   2. qqprofile 的 set_avatar 同时挂了 @filter.command 和 @filter.llm_tool，
#      但函数是普通 async（return 字符串）—— command 要的是 async generator（yield），
#      所以 /设置头像 命令一直是坏的（不报错但没反应）。
#      拆成 _do_set_avatar（公共逻辑）+ set_avatar（llm_tool，return）+
#      set_avatar_cmd（command，yield）。
#
# 用法（AstrBot 所在机器，root）：
#   bash qqprofile-clean-fixes.sh
#   systemctl restart astrbot
#
# 幂等：重复执行不会重复改。插件升级后重跑一次即可。
set -euo pipefail

PLUGINS=${PLUGINS:-/root/data/plugins}
CLEAN="$PLUGINS/astrbot_plugin_dafeiyu_clean/clean.py"
QPROF="$PLUGINS/astrbot_plugin_qqprofile/main.py"
PY=${PY:-/opt/astrbot/venv/bin/python}
STAMP=$(date +%Y%m%d-%H%M%S)

# ── 1. clean.py：加「工具名标签」清洗规则 ────────────────────────────────
if [ -f "$CLEAN" ]; then
  cp -p "$CLEAN" "$CLEAN.bak-tags-$STAMP"
  python3 - "$CLEAN" <<'PY'
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()

if 'qqprofile_' in s:
    print('· clean.py 已有工具标签规则')
else:
    old = '    re.compile(r"User ID:\\s*\\d+\\s*,\\s*Nickname:[^\\n<]*"),\n]'
    new = ('    re.compile(r"User ID:\\s*\\d+\\s*,\\s*Nickname:[^\\n<]*"),\n'
           '    # 模型把「工具调用」当文本吐出来时的残留：<qqprofile_set_avatar>、<bili_xxx> 等。\n'
           '    # 实测：让它换头像，它输出「…<qqprofile_set_avatar> <image>/root/data/temp/…」，\n'
           '    # 工具根本没被调用，标签反而发到聊天里。\n'
           '    re.compile(r"<\\s*/?\\s*(?:qqprofile|bili|draw|set|send|meme|livingmemory|room)_[a-z0-9_]*\\s*>", re.I),\n'
           '    re.compile(r"<\\s*/?\\s*(?:qqprofile_set_avatar|qqprofile_set_nickname|qqprofile_set_signature|qqprofile_set_status|draw_picture|set_signature|send_message_to_user|bili_video|bili_watch_frames)\\s*>", re.I),\n'
           '    # <image>路径</image> 或孤立的 <image>路径（到行尾）\n'
           '    re.compile(r"<\\s*image\\s*>[^<\\n]*(?:<\\s*/\\s*image\\s*>)?", re.I),\n'
           '    re.compile(r"<\\s*/\\s*image\\s*>", re.I),\n'
           ']')
    if old not in s:
        print('!! clean.py 没找到 _PATTERNS 结尾，需手动改')
    else:
        s = s.replace(old, new, 1)
        old_hint = '_HINT = re.compile(r"system_reminder|DSML|tool▁|tool_call|User ID:", re.I)'
        new_hint = '_HINT = re.compile(r"system_reminder|DSML|tool▁|tool_call|User ID:|qqprofile_|bili_|<image", re.I)'
        if old_hint in s:
            s = s.replace(old_hint, new_hint, 1)
            print('· clean.py 加 4 条正则 + 更新 _HINT')
        else:
            print('· clean.py 加 4 条正则（_HINT 没找到，跳过）')
        open(p, 'w', encoding='utf-8').write(s)
PY
  "$PY" -m py_compile "$CLEAN" && echo "clean.py OK"
  "$PY" - <<'PY'
import sys
sys.path.insert(0, '/root/data/plugins/astrbot_plugin_dafeiyu_clean')
from clean import clean
print('  自测:', repr(clean("试试 <qqprofile_set_avatar> <image>/root/x.jpg")))
PY
else
  echo "· 没装 dafeiyu_clean，跳过"
fi

# ── 2. qqprofile/main.py：拆 set_avatar ──────────────────────────────────
if [ -f "$QPROF" ]; then
  cp -p "$QPROF" "$QPROF.bak-split-$STAMP"
  python3 - "$QPROF" <<'PY'
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()

if 'set_avatar_cmd' in s:
    print('· qqprofile 已经拆过')
    raise SystemExit

start_marker = '    @filter.permission_type(PermissionType.ADMIN)\n    @filter.llm_tool(name="qqprofile_set_avatar")'
end_marker = '        return "头像换好了"\n'
if start_marker not in s or end_marker not in s:
    print('!! qqprofile 结构对不上（插件可能升级过），请手动改')
    raise SystemExit(2)

start = s.index(start_marker)
end = s.index(end_marker, start) + len(end_marker)

new = '''    async def _do_set_avatar(self, event: AiocqhttpMessageEvent, image: str) -> str:
        """换头像的实际逻辑，返回给用户看的文字。"""
        if not event.is_admin():
            return "仅管理员可以修改机器人头像"
        src = str(image or "").strip()
        if not src:
            for seg in event.get_messages():
                if isinstance(seg, Comp.Image):
                    src = seg.url
                    break
                if isinstance(seg, Comp.Reply) and seg.chain:
                    for reply_seg in seg.chain:
                        if isinstance(reply_seg, Comp.Image):
                            src = reply_seg.url
                            break
                    if src:
                        break
        if not src:
            return "没找到图片：请在消息里附图，或者把图片的本地路径 / URL 作为 image 参数传给我"

        # 本地文件转成 base64://，OneBot 两端都认
        try:
            if src.startswith("/") and __import__("os").path.isfile(src):
                import base64
                with open(src, "rb") as f:
                    src = "base64://" + base64.b64encode(f.read()).decode()
        except Exception as e:  # noqa: BLE001
            return f"读取图片失败：{e}"

        try:
            bot = getattr(event, "bot", None)
            if bot is None:
                raise AttributeError("no bot on event")
            await bot.set_qq_avatar(file=src)
        except Exception as first_err:  # noqa: BLE001
            # 网页聊天等没有 OneBot 客户端的场景：直连 SnowLuma
            try:
                await self._onebot_set_avatar(src)
            except Exception as e:  # noqa: BLE001
                logger.warning(f"[qqprofile] 设置头像失败：{first_err} / 兜底也失败：{e}")
                return f"换头像失败：{e}"
        logger.info("[qqprofile] 头像已更换")
        return "头像换好了"

    @filter.permission_type(PermissionType.ADMIN)
    @filter.llm_tool(name="qqprofile_set_avatar")
    async def set_avatar(self, event: AiocqhttpMessageEvent, image: str = ""):
        """把机器人（你自己）的 QQ 头像换成一张图片。

        你自己刚画好的图、或者主人消息里附带的图片都可以用来换头像。
        换完会返回结果文本；如果失败，把失败原因原样告诉主人。
        主人说「换个头像」「用这张图当头像」时调用。

        Args:
            image(string): 图片路径或 URL。通常填 draw_picture 工具结果里给出的本地路径；留空则用这条消息里附带的图片
        """
        return await self._do_set_avatar(event, image)

    @filter.permission_type(PermissionType.ADMIN)
    @filter.command("设置头像")
    async def set_avatar_cmd(self, event: AiocqhttpMessageEvent):
        """手动画：/设置头像（附图）"""
        result = await self._do_set_avatar(event, "")
        yield event.plain_result(result)
'''

s = s[:start] + new + s[end:]
open(p, 'w', encoding='utf-8').write(s)
print('· qqprofile 拆成 _do_set_avatar + set_avatar(llm_tool) + set_avatar_cmd(command)')
PY
  "$PY" -m py_compile "$QPROF" && echo "qqprofile OK"
else
  echo "· 没装 qqprofile，跳过"
fi

echo
echo "完成。执行：systemctl restart astrbot"
echo "验证：/设置头像（附图）应能直接换；模型漏标签会被 clean 插件删掉"
