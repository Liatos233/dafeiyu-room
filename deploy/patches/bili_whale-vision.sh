#!/bin/bash
# 给 astrbot_plugin_bili_whale 加「抽帧 → 视觉模型」能力，并把抽帧提速。
#
# 一、视觉能力（原先模型看不到画面）
#   插件原来只把抽帧九宫格**发给用户看**（main.py 里 _send_image），模型自己收不到图，
#   所以 AI 只能读字幕、说不了画面。这个补丁加 llm_tool `bili_watch_frames`：
#   抽帧后把九宫格作为 CallToolResult 的 ImageContent 返回，AstrBot 会缓存进模型上下文。
#
# 二、为什么还要 --fast（不下载整片）
#   B 站 CDN 对服务器出口限速：实测单连接 62 KB/s、8 并发反而 34 KB/s（按 IP 限）。
#   15 MB 的视频要下 4 分钟，必然撞上 AstrBot 的 tool_call_timeout（默认 120s）。
#   改成对 URL 直接 seek 抽帧：首帧 ~10s、之后 ~4.4s/帧，9 帧 ≈ 50s，稳定进超时。
#   代价：只能等间隔取样，用不了「画面变化点吸附」（那要全片解码）。
#
# 三、画质 qn=80 -> qn=32
#   1080P 流本来就是下载被掐断的元凶（ECONNRESET），而且九宫格不需要 1080P。
#
# 用法（AstrBot 所在机器，root）：
#   bash bili_whale-vision.sh
#   systemctl restart astrbot
#
# 幂等：重复执行不会重复插入。插件升级后重跑一次即可。
set -euo pipefail

PLUGIN_DIR=${PLUGIN_DIR:-/root/data/plugins/astrbot_plugin_bili_whale}
MAIN="$PLUGIN_DIR/main.py"
OPTS="$PLUGIN_DIR/tools/lib/watch-options.mjs"
WATCH="$PLUGIN_DIR/tools/commands/bili-watch.mjs"
CMDCFG=${CMDCFG:-/root/data/cmd_config.json}
PY=${PY:-/opt/astrbot/venv/bin/python}
NODE=${NODE:-/usr/local/bin/node}

[ -f "$MAIN" ] || { echo "找不到 $MAIN"; exit 1; }
STAMP=$(date +%Y%m%d-%H%M%S)

backup() { [ -f "$1" ] && cp -p "$1" "$1.bak-vision-$STAMP" && echo "备份: $1.bak-vision-$STAMP"; }
backup "$MAIN"; backup "$OPTS"; backup "$WATCH"

# ── 1. main.py：import + 新工具 + 走 --fast ───────────────────────────────
python3 - "$MAIN" <<'PY'
import sys

p = sys.argv[1]
src = open(p, encoding='utf-8').read()

if 'bili_watch_frames' in src:
    print('· main.py 已加过 bili_watch_frames')
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
        # --fast：不下载整片，直接对 URL seek 抽帧（见补丁头注释）
        code, text = await self._run(["watch-video", m.group(0), g, "--fast"], timeout=240)
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

# 让工具走 --fast（如果还是老写法）
old_call = 'code, text = await self._run(["watch-video", m.group(0), g], timeout=900)'
if old_call in src:
    src = src.replace(
        old_call,
        'code, text = await self._run(["watch-video", m.group(0), g, "--fast"], timeout=240)',
        1,
    )
    print('· bili_watch_frames 改走 --fast')

open(p, 'w', encoding='utf-8').write(src)
PY

# ── 2. watch-options.mjs：允许 --fast ─────────────────────────────────────
if [ -f "$OPTS" ]; then
  python3 - "$OPTS" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
if 'fast' in s:
    print('· watch-options 已支持 --fast')
else:
    s = s.replace('const positional=[];let tile=720',
                  'const positional=[];let tile=720;let fast=false', 1)
    s = s.replace(
        "    } else if(!arg.startsWith('--'))positional.push(arg)\n    else if(arg!=='--uniform')throw Error('未知抽帧选项：'+arg)",
        "    } else if(!arg.startsWith('--'))positional.push(arg)\n"
        "    else if(arg==='--fast')fast=true\n"
        "    else if(arg!=='--uniform')throw Error('未知抽帧选项：'+arg)", 1)
    s = s.replace(
        "return {bvid:positional[0],grid:(positional[1]??'3x3').toLowerCase(),outDir:positional[2]??defaultDir,tile}",
        "return {bvid:positional[0],grid:(positional[1]??'3x3').toLowerCase(),"
        "outDir:positional[2]??defaultDir,tile,fast}", 1)
    open(p, 'w', encoding='utf-8').write(s)
    print('· watch-options + --fast')
PY
fi

# ── 3. bili-watch.mjs：画质 + fast 分支 ───────────────────────────────────
if [ -f "$WATCH" ]; then
  python3 - "$WATCH" <<'PY'
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()

# 3a. 画质
if 'qn=32&fnval=1' in s:
    print('· 画质已是 qn=32')
elif 'qn=80&fnval=1' in s:
    s = s.replace('qn=80&fnval=1', 'qn=32&fnval=1', 1)
    print('· 画质 qn=80(1080P) -> qn=32(≥360P)')
else:
    print('! 没找到 qn=80/32，画质可能上游改过，请手动确认')

# 3b. fast 分支
if 'URL 直抽' in s:
    print('· bili-watch 已有 fast 分支')
else:
    anchor = "console.log(`实际画质: ${QN[p.data.quality] ?? p.data.quality}`)\n"
    if anchor not in s:
        print('!! bili-watch 找不到插入点，跳过 fast 分支')
    else:
        fast = r'''
// ── --fast：不下载整片，直接对 URL 做 seek 抽帧 ──────────────────────────
// B 站 CDN 对服务器出口限速（实测单连接 62 KB/s、8 并发 34 KB/s），15MB 要下
// 4 分钟，会撞 AstrBot 的 tool_call_timeout。URL 直抽：首帧 ~10s、之后 ~4.4s/帧。
// 代价：只能等间隔取样，用不了「画面变化点吸附」（那要全片解码）。
if (parsed.fast) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  fs.mkdirSync(outDir, { recursive: true })
  const tmp = path.join(outDir, `.fast-${stamp}`)
  fs.mkdirSync(tmp, { recursive: true })
  const sheet = path.join(outDir, `${bvid}-${stamp}-${cols}x${rows}.jpg`)
  const HDR = `Referer: https://www.bilibili.com/\r\nUser-Agent: ${UA}\r\nCookie: SESSDATA=${cred.sessdata}; bili_jct=${cred.bili_jct}; buvid3=${cred.buvid3}\r\n`
  // 超长视频（B 站有 40 小时的合集）seek 到十几小时处会失败：只取前 2 小时。
  const MAX_SPAN = 2 * 3600
  const span = Math.min(duration, MAX_SPAN)
  if (duration > MAX_SPAN) console.log(`（视频 ${(duration / 3600).toFixed(1)} 小时，只取前 2 小时抽帧）`)
  const times = Array.from({ length: N }, (_, i) => ((i + 0.5) * span) / N)
  const fmtT = (x) => `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(Math.floor(x % 60)).padStart(2, '0')}`
  const ok = []
  const t0 = Date.now()
  times.forEach((t, i) => {
    const f = path.join(tmp, `f${String(i).padStart(2, '0')}.jpg`)
    try {
      execFileSync(FFMPEG, ['-y', '-loglevel', 'error', '-headers', HDR,
        '-ss', t.toFixed(2), '-i', url, '-frames:v', '1', '-q:v', '2', f],
        { stdio: 'ignore', timeout: 90_000 })
      if (fs.existsSync(f) && fs.statSync(f).size > 0) ok.push(f)
    } catch { /* 单帧失败跳过 */ }
  })
  if (!ok.length) {
    console.error('URL 直抽全部失败：直链可能失效、或这是超长合集/直播回放（B 站对这类不给可 seek 的直链）。\n'
      + '换一条短视频再试；只想了解内容的话改用 video / debrief 读字幕，不抽画面。')
    process.exit(6)
  }
  const list = path.join(tmp, 'list.txt')
  fs.writeFileSync(list, ok.map((f) => `file '${f}'`).join('\n'))
  try {
    execFileSync(FFMPEG, ['-y', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0', '-i', list,
      '-vf', `scale=${TILE}:-1,tile=${cols}x${rows}`, '-frames:v', '1', sheet],
      { stdio: 'ignore', timeout: 120_000 })
  } catch (e) {
    console.error('拼图失败：' + e.message); process.exit(6)
  }
  if (!fs.existsSync(sheet)) { console.error('九宫格没生成'); process.exit(6) }
  console.log(`取帧方式: URL 直抽（不下载整片，${((Date.now() - t0) / 1000).toFixed(1)}s，${ok.length}/${N} 帧）`)
  console.log(`时间点  : ${times.map((t, i) => `${i + 1}=${fmtT(t)}`).join('  ')}`)
  console.log(`\nSHEET: ${sheet}`)
  fs.rmSync(tmp, { recursive: true, force: true })
  process.exit(0)
}
'''
        s = s.replace(anchor, anchor + fast, 1)
        print('· bili-watch + fast 分支')

open(p, 'w', encoding='utf-8').write(s)
PY
fi

# ── 4. AstrBot 工具超时 120 -> 180 ────────────────────────────────────────
if [ -f "$CMDCFG" ]; then
  cp -p "$CMDCFG" "$CMDCFG.bak-vision-$STAMP"
  python3 - "$CMDCFG" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p, encoding='utf-8-sig'))
misc = d.setdefault('agent_runner', {}).setdefault('config', {}).setdefault('misc', {})
old = misc.get('tool_call_timeout')
if old == 180:
    print('· tool_call_timeout 已是 180')
else:
    misc['tool_call_timeout'] = 180
    json.dump(d, open(p, 'w', encoding='utf-8-sig'), ensure_ascii=False, indent=2)
    print(f'· tool_call_timeout: {old} -> 180')
PY
fi

# ── 5. 语法检查 ───────────────────────────────────────────────────────────
echo "=== 语法检查 ==="
"$PY" -m py_compile "$MAIN" && echo "main.py OK"
[ -f "$OPTS" ] && "$NODE" --check "$OPTS" && echo "watch-options.mjs OK"
[ -f "$WATCH" ] && "$NODE" --check "$WATCH" && echo "bili-watch.mjs OK"

echo
echo "完成。执行：systemctl restart astrbot"
echo "验证：日志里应出现 'Added llm tool: bili_watch_frames'"
