#!/bin/bash
# 给 astrbot_plugin_bili_whale 加「抽帧 → 视觉模型」能力。
#
# 背景：插件原本只把抽帧九宫格**发给用户看**（main.py 里的 _send_image），
# 模型自己收不到图，所以 AI 只能读字幕、说不了画面。
# 这个补丁加一个 llm_tool `bili_watch_frames`：抽帧后把九宫格作为
# CallToolResult 的 ImageContent 返回，AstrBot 会把它缓存进模型上下文。
#
# 同时把 bili-watch.mjs 的画质从 qn=80(1080P) 降到 qn=32(≥360P)：
# 1080P 流在服务器上下载会被 B 站 CDN 掐断（ECONNRESET），且抽帧九宫格
# 根本不需要 1080P —— 实测 360P 的九宫格 2160×1215，画面文字依然清晰。
#
# 用法（在 AstrBot 所在机器上，root）：
#   bash bili_whale-vision.sh
#   systemctl restart astrbot
#
# 幂等：重复执行不会重复插入。插件升级后重跑一次即可。
set -euo pipefail

PLUGIN_DIR=${PLUGIN_DIR:-/root/data/plugins/astrbot_plugin_bili_whale}
MAIN="$PLUGIN_DIR/main.py"
WATCH="$PLUGIN_DIR/tools/commands/bili-watch.mjs"

[ -f "$MAIN" ] || { echo "找不到 $MAIN"; exit 1; }

STAMP=$(date +%Y%m%d-%H%M%S)
cp -p "$MAIN" "$MAIN.bak-vision-$STAMP"
echo "备份: $MAIN.bak-vision-$STAMP"

python3 - "$MAIN" <<'PY'
import sys

p = sys.argv[1]
src = open(p, encoding='utf-8').read()

if 'bili_watch_frames' in src:
    print('· 已经加过 bili_watch_frames，跳过')
else:
    if 'import base64' not in src:
        src = src.replace('import asyncio\n', 'import asyncio\nimport base64\n', 1)
        print('· + import base64')
    if 'from mcp.types import' not in src:
        anchor = 'from astrbot.api.star import Context, Star, register\n'
        src = src.replace(
            anchor,
            anchor + 'from mcp.types import CallToolResult, ImageContent, TextContent\n',
            1,
        )
        print('· + from mcp.types import ...')

    marker = '    @_llm_tool(name="bili_send_dm")'
    if marker not in src:
        print('!! 找不到插入点（插件结构变了？），请手动加')
        raise SystemExit(2)

    new = '''    @_llm_tool(name="bili_watch_frames")
    async def tool_watch_frames(self, event: AstrMessageEvent, bvid: str, grid: str = "3x3") -> Any:
        """看一个 B 站视频的**画面**：抽帧拼成九宫格，你会直接看到这些帧。

        当主人问「这视频画面里在讲什么 / 演示了什么 / 长什么样 / 有没有出现某个东西」，
        或者内容依赖视觉（PPT、代码、界面操作、展示物）时调用。
        只想知道"说了什么"，用 bili_video 更快更省。

        Args:
            bvid (string): BV 号，形如 BV1xx411c7mD
            grid (string): 抽几帧：3x3（9 帧，默认）或 4x4（16 帧，更细但更慢）
        """
        blocked = self._llm_blocked()
        if blocked:
            return blocked
        m = BV_RE.search(bvid or "")
        if not m:
            return f"✗ 没看出 BV 号：{bvid}"
        g = (grid or "3x3").strip().lower()
        if g not in ("3x3", "4x4"):
            g = "3x3"
        code, text = await self._run(["watch-video", m.group(0), g], timeout=900)
        sheet = _SHEET_RE.search(text or "")
        if not sheet:
            return f"✗ 抽帧失败（退出码 {code}）：\\n{clip(text or '（没有输出）', 600)}"
        p = Path(sheet.group(1).strip())
        if not p.is_file():
            return f"✗ 九宫格文件不存在：{p}"
        try:
            raw = p.read_bytes()
        except Exception as exc:  # noqa: BLE001
            return f"✗ 读九宫格失败：{exc}"
        return CallToolResult(
            content=[
                TextContent(
                    type="text",
                    text=(f"{m.group(0)} 的 {g} 抽帧九宫格（{len(raw)//1024} KB）。"
                          f"你可以直接看这 {9 if g == '3x3' else 16} 帧画面。\\n\\nCLI 输出：\\n{clip(text or '', 800)}"),
                ),
                ImageContent(
                    type="image",
                    data=base64.b64encode(raw).decode("ascii"),
                    mimeType="image/png",
                ),
            ]
        )

'''
    src = src.replace(marker, new + marker, 1)
    print('· + tool bili_watch_frames')

open(p, 'w', encoding='utf-8').write(src)
PY

if [ -f "$WATCH" ]; then
  cp -p "$WATCH" "$WATCH.bak-qn-$STAMP"
  python3 - "$WATCH" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
if 'qn=32&fnval=1' in s:
    print('· 画质已经是 qn=32，跳过')
elif 'qn=80&fnval=1' in s:
    s = s.replace('qn=80&fnval=1', 'qn=32&fnval=1', 1)
    open(p, 'w', encoding='utf-8').write(s)
    print('· 画质 qn=80(1080P) -> qn=32(≥360P)')
else:
    print('! 没找到 qn=80 也没找到 qn=32，可能上游改了，请手动确认')
PY
fi

echo "=== 语法检查 ==="
"${PY:-/opt/astrbot/venv/bin/python}" -m py_compile "$MAIN" && echo "syntax OK"

echo
echo "完成。执行：systemctl restart astrbot"
echo "验证：日志里应出现 'Added llm tool: bili_watch_frames'"
