#!/bin/bash
# 修「自主回复内容为空」的最后一环：_llm 拿不到 provider 时静默返回空串。
#
# 证据（18:27:09）：
#   回复前已读取视频上下文：BV1wiTx6FEg7（465 字）
#   回复内容为空，跳过：Liatos「@<bilibili-handle> 大肥鱼，能看到吗」
#
# _llm 的实现：
#   provider_id = self._str("auto.provider_id").strip()      # 配置里是空的
#   if not provider_id and umo:
#       provider_id = await self.context.get_current_chat_provider_id(umo=umo)
#   if not provider_id:
#       return ""                                            # 静默返回空
# 而 umo 来自 auto.push_session（空）或 _last_umo（重启后没人说话时也是空）。
# 18:26 刚重启、你那会儿还没发消息 → 两个来源都空 → provider 空 → 回空串。
#
# 改两处：
#   1. 配置：auto.provider_id 填上当前唯一的聊天模型 "deepseek/deepseek-flash"
#   2. 代码：_llm 在 provider 为空时打 warn（原来完全静默，排查时看不见）
#
# 用法（AstrBot 所在机器，root）：
#   bash bili-fix-llm-provider.sh
#   systemctl restart astrbot
#
# 幂等。
set -euo pipefail

PLUGINS=${PLUGINS:-/root/data/plugins}
BW="$PLUGINS/astrbot_plugin_bili_whale/main.py"
CFG=${CFG:-/root/data/config/astrbot_plugin_bili_whale_config.json}
STATE=${STATE:-/root/data/plugin_data/astrbot_plugin_bili_whale/state.json}
PY=${PY:-/opt/astrbot/venv/bin/python}
STAMP=$(date +%Y%m%d-%H%M%S)
PROVIDER=${PROVIDER:-deepseek/deepseek-flash}

# ── 1. 代码：provider 为空时告警 ─────────────────────────────────────────
cp -p "$BW" "$BW.bak-llmprov-$STAMP"
python3 - "$BW" <<'PY'
import sys

p = sys.argv[1]
s = open(p, encoding='utf-8').read()

if '_llm_provider_warn_patch' in s:
    print('· 代码已加告警')
    raise SystemExit

old = '''        if not provider_id:
            return ""
        resp = await self.context.llm_generate(chat_provider_id=provider_id, prompt=prompt)'''
new = '''        if not provider_id:
            # _llm_provider_warn_patch：原来这里静默 return ""，导致「回复内容为空」
            # 完全看不出原因。补一条 warn，并说明两个来源都空时才发生。
            logger.warning(
                "[bili-whale] 生成时拿不到 provider（auto.provider_id 为空，"
                f"且 umo={umo or '空'}）→ 本次生成返回空"
            )
            return ""
        resp = await self.context.llm_generate(chat_provider_id=provider_id, prompt=prompt)'''
if old in s:
    s = s.replace(old, new, 1)
    open(p, 'w', encoding='utf-8').write(s)
    print('· _llm 缺 provider 时加 warn')
else:
    print('! 没找到 _llm 的 provider 判断')
PY

"$PY" -m py_compile "$BW" && echo "bili_whale OK"

# ── 2. 配置：填 provider_id ─────────────────────────────────────────────
cp -p "$CFG" "$CFG.bak-llmprov-$STAMP"
python3 - "$CFG" "$PROVIDER" <<'PY'
import json, sys

p, prov = sys.argv[1], sys.argv[2]
d = json.load(open(p, encoding="utf-8-sig"))
a = d.setdefault("auto", {})
cur = (a.get("provider_id") or "").strip()
if cur == prov:
    print(f"· auto.provider_id 已经是 {prov}")
else:
    print(f"  auto.provider_id: {cur!r} -> {prov!r}")
    a["provider_id"] = prov
    json.dump(d, open(p, "w", encoding="utf-8-sig"), ensure_ascii=False, indent=2)
print("最终 auto.provider_id =", json.load(open(p, encoding="utf-8-sig"))["auto"].get("provider_id"))
PY

# ── 3. 再清一次 seen（那两条又被标记了）──────────────────────────────────
if [ -f "$STATE" ]; then
  cp -p "$STATE" "$STATE.bak-llmprov-$STAMP"
  python3 - "$STATE" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p, encoding="utf-8"))
soc = d.get("social") or {}
seen = soc.get("seen")
if isinstance(seen, dict) and seen:
    n = len(seen); soc["seen"] = {}; soc["last_try_at"] = 0
    json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    print(f"· 清掉 {n} 条 seen，重置 last_try_at")
else:
    print("· seen 已空")
PY
fi

echo
echo "完成。执行：systemctl restart astrbot"
