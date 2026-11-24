"""大肥鱼的心 · 纯计算层。

设计约束（很重要，改代码前先读）：
  · 这个文件**不做任何 IO**，不读文件、不发网络、不碰 AstrBot。
    这样能用 `python -m unittest` 直接测，不用起插件。
  · 所有时间相关的函数都接受 `now` 参数（毫秒），不自己调 `time.time()`。
    否则没法测"过了 10 小时会怎么变"。
  · 数值统一 0~100 浮点，落盘时再 round2。

七个维度分两类：
  · 存量（关系）：attachment / intimacy —— 半衰期 51 小时，掉得慢
  · 情绪：joy / worry / sad / curious / fatigue —— 半衰期 8~10 小时，来得快去得也快
"""

from __future__ import annotations

import math

# ── 版本 ────────────────────────────────────────────────
VERSION = 1

# ── 七个维度 ────────────────────────────────────────────
# base: 基线（不动时缓慢回归到这里）
# half: 半衰期（小时）—— 偏离基线后回落到一半距离所需时间
DIMS = {
    "attachment": {"label": "依恋", "base": 45.0, "half": 51.0, "kind": "bond"},
    "intimacy":   {"label": "亲密", "base": 40.0, "half": 51.0, "kind": "bond"},
    "joy":        {"label": "开心", "base": 50.0, "half": 10.0, "kind": "mood"},
    "worry":      {"label": "担心", "base": 15.0, "half": 10.0, "kind": "mood"},
    "sad":        {"label": "难过", "base": 10.0, "half": 10.0, "kind": "mood"},
    "curious":    {"label": "好奇", "base": 55.0, "half": 8.0,  "kind": "mood"},
    "fatigue":    {"label": "疲惫", "base": 20.0, "half": 9.0,  "kind": "mood"},
}

DIM_KEYS = tuple(DIMS.keys())

# ── 五档状态（只看 blame 责怪压力）──────────────────────
BANDS = (
    {"key": "calm",    "label": "日常", "max": 25, "tone": "语气自然就好，顺着当下的心情来"},
    {"key": "wronged", "label": "委屈", "max": 55, "tone": "话变短，想问一句是不是嫌你烦"},
    {"key": "angry",   "label": "生气", "max": 70, "tone": "冷一点、短一点，把刚被刺到的那句挑明"},
    {"key": "afraid",  "label": "害怕", "max": 80, "tone": "不顶嘴，先确认他还想不想聊"},
    {"key": "shut",    "label": "回避", "max": 101, "tone": "少说、不讨好、不追问，但别装看不见"},
)

# ── 关系阶段（沿用 affinity.js 的命名）──────────────────
STAGES = (
    {"min": 0,  "name": "陌生鱼苗",   "attitude": "先躲远点，观察一下"},
    {"min": 15, "name": "眼熟的小鱼", "attitude": "记得你，但还没记住名字"},
    {"min": 30, "name": "愿意搭话",   "attitude": "嘴上嫌麻烦，还是会回"},
    {"min": 45, "name": "嘴硬搭子",   "attitude": "先哼一声，再偷偷帮你"},
    {"min": 60, "name": "心软常客",   "attitude": "嘴上说烦，实际会护短"},
    {"min": 75, "name": "黏人",       "attitude": "主动凑过来，赖着不走"},
)

# ── 参数（默认值，可被配置覆盖）─────────────────────────
DEFAULTS = {
    "min_gap_minutes": 20,        # 同档内注入间隔
    "heat_window_minutes": 10,    # 热度折扣窗口
    "heat_divisor": 12.0,         # 同窗口内第 n+1 次增益 = base/(1+n/divisor)
    "daily_cap": 40.0,            # 正向每日上限（防刷）
    "blame_decay_hours": 6,       # 责怪每多少小时褪一次
    "blame_decay_step": 8.0,      # 每次褪多少点
    "blame_floor": 40.0,          # 心结：不会自己回日常
    "gentle_rounds_calm": 1,      # 哄够几轮往下走（日常/委屈/生气）
    "gentle_rounds_afraid": 2,    # 害怕/回避要哄更多轮
    "smother_blame_gain": 6.0,    # 重责一次涨多少
    "smother_cap_from_calm": 69.0,  # 重责不跳档：从日常最多到 69
}


# ══════════════════════════════════════════════════════
# 基础工具
# ══════════════════════════════════════════════════════
def clamp(n: float, lo: float = 0.0, hi: float = 100.0) -> float:
    """夹取，不取整。衰减每 tick 只有零点几，取整会永远抹平。"""
    v = float(n)
    if not math.isfinite(v):
        return lo
    return max(lo, min(hi, v))


def round2(n: float) -> float:
    """两位小数：落盘够用，也不会出现 91.94999999。"""
    v = float(n)
    if not math.isfinite(v):
        return 0.0
    return round(v * 100) / 100


def num(v, fallback: float = 0.0) -> float:
    """宽松取数：None/''/NaN 一律当缺失，不是 0。

    否则 JSON 里一个 null 会让 dt 变成超级大，一次性把状态全演化掉。
    """
    if v is None or v == "":
        return fallback
    try:
        f = float(v)
    except (TypeError, ValueError):
        return fallback
    return f if math.isfinite(f) else fallback


# ══════════════════════════════════════════════════════
# 状态构造
# ══════════════════════════════════════════════════════
def blank_state(now: int, overrides: dict | None = None) -> dict:
    """全新的状态。overrides 用来定初始关系值（依恋 45 / 亲密 40）。"""
    dims = {k: DIMS[k]["base"] for k in DIM_KEYS}
    if overrides:
        for k, v in overrides.items():
            if k in dims:
                dims[k] = clamp(num(v, dims[k]))
    return {
        "version": VERSION,
        "updatedAt": int(now),
        "decayedAt": int(now),
        "dims": {k: round2(v) for k, v in dims.items()},
        "blame": 0.0,
        "gentleRounds": 0,        # 连续哄了几轮
        "lastReason": "",
        "lastBand": "calm",
        "events": [],              # 情绪事件摘要（不存原文）
        "milestones": [],
        "lastInjectedFor": 0,      # 已经为哪个 updatedAt 注入过
        "lastInjectedAt": 0,
        "shockLog": [],            # 热度折扣用
        "dailyGain": 0.0,          # 今日正向累计
        "dailyGainDay": "",        # 哪一天（YYYY-MM-DD）
    }


def normalize(state: dict, now: int) -> dict:
    """把外部读进来的状态补全成可用形状。坏字段一律回落到基线。"""
    if not isinstance(state, dict):
        return blank_state(now)
    out = blank_state(now)

    dims = state.get("dims")
    if isinstance(dims, dict):
        for k in DIM_KEYS:
            if k in dims:
                out["dims"][k] = round2(clamp(num(dims[k], DIMS[k]["base"])))

    out["updatedAt"] = int(num(state.get("updatedAt"), now))
    out["decayedAt"] = int(num(state.get("decayedAt"), now))
    out["blame"] = round2(clamp(num(state.get("blame"), 0.0)))
    out["gentleRounds"] = int(num(state.get("gentleRounds"), 0))

    reason = state.get("lastReason")
    out["lastReason"] = str(reason)[:120] if reason else ""

    band = state.get("lastBand")
    valid = {b["key"] for b in BANDS}
    out["lastBand"] = band if band in valid else band_of(out["blame"])

    if isinstance(state.get("events"), list):
        out["events"] = state["events"][-60:]
    if isinstance(state.get("milestones"), list):
        out["milestones"] = state["milestones"][-40:]
    if isinstance(state.get("shockLog"), list):
        out["shockLog"] = state["shockLog"][-80:]

    out["lastInjectedFor"] = int(num(state.get("lastInjectedFor"), 0))
    out["lastInjectedAt"] = int(num(state.get("lastInjectedAt"), 0))
    out["dailyGain"] = round2(clamp(num(state.get("dailyGain"), 0.0), 0, 999))
    out["dailyGainDay"] = str(state.get("dailyGainDay") or "")
    return out


# ══════════════════════════════════════════════════════
# 衰减
# ══════════════════════════════════════════════════════
def decay_value(cur: float, base: float, half_hours: float, hours: float) -> float:
    """朝基线回归。half_hours 是走完一半距离所需时间。

    ⚠ 用浮点不取整：衰减每 tick 可能只有 0.05，
    一旦取整就永远停在原地（这是 longing 1.0.0 时间曲线完全不工作的根因）。
    """
    if hours <= 0 or half_hours <= 0:
        return cur
    remain = 0.5 ** (hours / half_hours)
    return base + (cur - base) * remain


def decay(state: dict, now: int) -> tuple[dict, bool]:
    """按真实时间推进所有维度。返回 (新状态, 是否变了)。

    时间基点是 decayedAt，不是 updatedAt ——
    因为 updatedAt 会被「注入」「事件」刷新，用它算会把衰减吞掉。
    """
    last = int(num(state.get("decayedAt"), now))
    hours = (now - last) / 3_600_000.0
    if hours <= 0:
        return state, False
    # 上限 72 小时：关机三天的补算，别让一次补算把状态冲垮
    hours = min(hours, 72.0)

    changed = False
    for k in DIM_KEYS:
        cur = num(state["dims"].get(k), DIMS[k]["base"])
        nv = round2(clamp(decay_value(cur, DIMS[k]["base"], DIMS[k]["half"], hours)))
        if abs(nv - cur) >= 0.01:
            state["dims"][k] = nv
            changed = True

    # 责怪缓慢褪去，但止于心结（不会自己回日常）
    blame = num(state.get("blame"), 0.0)
    if blame > 0:
        steps = hours / float(DEFAULTS["blame_decay_hours"])
        drop = steps * DEFAULTS["blame_decay_step"]
        nblame = max(DEFAULTS["blame_floor"], blame - drop) if blame > DEFAULTS["blame_floor"] else blame
        nblame = round2(max(0.0, nblame))
        if abs(nblame - blame) >= 0.01:
            state["blame"] = nblame
            changed = True

    state["decayedAt"] = int(now)
    if changed:
        state["updatedAt"] = int(now)
    return state, changed


# ══════════════════════════════════════════════════════
# 档位
# ══════════════════════════════════════════════════════
def band_of(blame: float) -> str:
    b = clamp(num(blame, 0.0))
    for band in BANDS:
        if b < band["max"]:
            return band["key"]
    return "shut"


def band_info(key: str) -> dict:
    for band in BANDS:
        if band["key"] == key:
            return band
    return BANDS[0]


def stage_of(state: dict) -> dict:
    """关系阶段：用 (依恋 + 亲密) / 2 映射。"""
    a = num(state["dims"].get("attachment"), DIMS["attachment"]["base"])
    i = num(state["dims"].get("intimacy"), DIMS["intimacy"]["base"])
    avg = (a + i) / 2.0
    out = STAGES[0]
    for s in STAGES:
        if avg >= s["min"]:
            out = s
    return {**out, "score": round2(avg)}


# ══════════════════════════════════════════════════════
# 事件应用
# ══════════════════════════════════════════════════════
def _heat_mult(state: dict, kind: str, now: int) -> float:
    """热度折扣：同一类事件 10 分钟内重复，增益按 1/(1+n/divisor) 缩水。"""
    win = DEFAULTS["heat_window_minutes"] * 60_000
    log = state.get("shockLog") or []
    log = [e for e in log if now - int(num(e.get("at"), 0)) <= win]
    state["shockLog"] = log
    n = sum(1 for e in log if e.get("kind") == kind)
    return 1.0 / (1.0 + n / DEFAULTS["heat_divisor"])


def _daily_ok(state: dict, now: int, delta: float) -> bool:
    """正向每日上限（只对正向、只对白名单维度）。防刷。"""
    if delta <= 0:
        return True
    day = _day_key(now)
    if state.get("dailyGainDay") != day:
        state["dailyGainDay"] = day
        state["dailyGain"] = 0.0
    return num(state.get("dailyGain")) + delta <= DEFAULTS["daily_cap"]


def _day_key(now: int) -> str:
    import datetime
    return datetime.datetime.fromtimestamp(now / 1000).strftime("%Y-%m-%d")


CAP_DIMS = {"joy", "curious", "intimacy", "attachment"}


def apply_delta(state: dict, dim: str, delta: float, now: int, kind: str = "") -> float:
    """给某一维加/减。返回实际变化量（可能被天花板/日上限/热度折扣削减）。

    天花板：增益按 (1 - 当前/100) 缩放 —— 100 是渐近线，越往上越难。
    """
    if dim not in DIMS:
        return 0.0
    d = float(delta)
    if d == 0:
        return 0.0

    cur = num(state["dims"].get(dim), DIMS[dim]["base"])

    if d > 0:
        # 天花板缩放
        room = max(0.0, (100.0 - cur) / 100.0)
        d *= room
        # 热度折扣
        d *= _heat_mult(state, kind or dim, now)
        # 日上限
        if dim in CAP_DIMS and not _daily_ok(state, now, d):
            d = 0.0
        if d > 0:
            state["dailyGain"] = round2(num(state.get("dailyGain")) + d)

    nv = round2(clamp(cur + d))
    real = round2(nv - cur)
    state["dims"][dim] = nv
    return real


def raise_blame(state: dict, amount: float, now: int, reason: str = "") -> float:
    """加重责怪压力。

    重责不跳档（抄 fish_heart 的规矩）：
    从日常/委屈被一次重责打到高位时，最多停在 69（生气上沿），下一次才可能进害怕/回避。
    已经生气/害怕/回避的不受影响。
    """
    before = num(state.get("blame"), 0.0)
    b = clamp(before + float(amount))
    if before < 55:
        b = min(b, DEFAULTS["smother_cap_from_calm"])
    state["blame"] = round2(b)
    state["gentleRounds"] = 0
    if reason:
        state["lastReason"] = str(reason)[:120]
    return round2(b - before)


def sooth_blame(state: dict, amount: float, now: int) -> float:
    """哄：降低责怪。连续哄够轮数才真正往下走（哄够了就行，不挑方式）。"""
    before = num(state.get("blame"), 0.0)
    if before <= 0:
        return 0.0
    state["gentleRounds"] = int(num(state.get("gentleRounds"), 0)) + 1
    band = band_of(before)
    need = DEFAULTS["gentle_rounds_afraid"] if band in ("afraid", "shut") else DEFAULTS["gentle_rounds_calm"]

    # 哄够轮数才生效，但每一轮都先给一点缓和（否则玩家觉得没反馈）
    eff = float(amount)
    if state["gentleRounds"] < need:
        eff *= 0.45
    b = clamp(before - eff)
    state["blame"] = round2(b)
    return round2(b - before)


# ══════════════════════════════════════════════════════
# 注入判定
# ══════════════════════════════════════════════════════
def should_inject(state: dict, now: int, min_gap_minutes: int | None = None) -> tuple[bool, str]:
    """这一轮要不要注入心境。返回 (是否注入, 原因)。

    规则：
      · 同一份状态（updatedAt 相同）只注一次 —— 一次变化只说一次
      · 跨档必注（不受间隔限制）
      · 生气档每轮都注（否则下一轮她忘了自己在生气）
      · 同档内数值漂移按 min_gap_minutes 节流
    """
    gap_min = DEFAULTS["min_gap_minutes"] if min_gap_minutes is None else int(min_gap_minutes)

    band_now = band_of(num(state.get("blame"), 0.0))
    band_last = str(state.get("lastBand") or "calm")

    if band_now != band_last:
        return True, "band-change"

    if band_now == "angry":
        return True, "angry-always"

    injected_for = int(num(state.get("lastInjectedFor"), 0))
    updated_at = int(num(state.get("updatedAt"), 0))
    if injected_for == updated_at and updated_at > 0:
        return False, "already-said"

    last_at = int(num(state.get("lastInjectedAt"), 0))
    if last_at and (now - last_at) < gap_min * 60_000:
        return False, "throttled"

    return True, "drift"
