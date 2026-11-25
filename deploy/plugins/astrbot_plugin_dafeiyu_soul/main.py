"""大肥鱼的心 · AstrBot 接入层。

这个文件只做三件事：
  1. 读配置、读写 state.json
  2. 挂 AstrBot 钩子（感知消息 / 注入心境）
  3. 注册命令和面板路由

**所有情绪计算都在 core.py**，这个文件不算数，只搬运。

关键设计（不要改）：
  · 注入走 req.extra_user_content_parts，**绝不碰 req.system_prompt**
    原因：DeepSeek 前缀缓存从开头算到第一个变化点，system prompt 一变，
    后面整段历史全部重算。实测低命中调用的未命中量是正常组的 5 倍。
  · 只服务主人私聊（umo 形如 xxx:FriendMessage:<owner_id>），
    群聊和陌生人一律不碰她的心。
  · 所有钩子外层包 try/except，出错只记日志，绝不影响正常对话。
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime
from pathlib import Path

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register

# ⚠ AstrBot 把插件当「包」加载（模块名是 data.plugins.<pkg>.<mod>），
#   所以同目录的 core / perceive 必须用相对导入。
#   之前写成 `import core` 会报 No module named 'core'。
try:
    from . import core, perceive
except ImportError:  # 兼容被当成顶层模块加载的情况（如本地跑测试）
    import core  # type: ignore
    import perceive  # type: ignore

PLUGIN_NAME = "astrbot_plugin_dafeiyu_soul"


def _plugin_data_dir() -> Path:
    """AstrBot 的插件数据目录。4.x 是 data/plugin_data/<name>/。"""
    try:
        from astrbot.core.utils.astrbot_path import get_astrbot_data_path
        base = Path(get_astrbot_data_path())
    except Exception:  # noqa: BLE001
        base = Path.home() / ".astrbot" / "data"
    return base / "plugin_data" / PLUGIN_NAME


@register(PLUGIN_NAME, "大肥鱼", "七维情绪 + 关系阶段 + 五档语气", "0.1.0")
class DafeiyuSoul(Star):
    def __init__(self, context: Context, config: dict | None = None):
        super().__init__(context)
        self.config = config or {}
        self.data_dir = _plugin_data_dir()
        self.state_file = self.data_dir / "state.json"
        self.state: dict = {}
        self._last_tick = 0.0
        self._load()
        # 启动时就写一次 soul.json：否则房间页要等到第一次情绪变化才读得到，
        # 中间会一直是「读不到心情」。
        if self._cfg("panel.write_soul_json", True):
            self._write_soul_json()
        self._register_web_apis()

    # ══════════════════════════════════════════════════
    # 面板接口（P2）
    # ══════════════════════════════════════════════════
    def _register_web_apis(self) -> None:
        routes = [
            ("/astrbot_plugin_dafeiyu_soul/state", self._api_state, ["GET"], "查看她的心"),
            ("/astrbot_plugin_dafeiyu_soul/tick", self._api_tick, ["POST"], "手动跳一次心跳"),
            ("/astrbot_plugin_dafeiyu_soul/calm", self._api_calm, ["POST"], "把责怪清零"),
        ]
        for route, handler, methods, desc in routes:
            try:
                self.context.register_web_api(route, handler, methods, desc)
            except Exception as exc:  # noqa: BLE001
                logger.warning(f"[{PLUGIN_NAME}] 注册接口 {route} 失败：{exc}")
        logger.info(f"[{PLUGIN_NAME}] 已注册 WebUI 接口：state / tick / calm")

    async def _api_state(self):
        try:
            from quart import jsonify
        except Exception:  # noqa: BLE001
            from flask import jsonify  # type: ignore
        try:
            self._tick()
            return jsonify({"status": "ok", **self.export_view()})
        except Exception as exc:  # noqa: BLE001
            return jsonify({"status": "error", "message": str(exc)}), 500

    async def _api_tick(self):
        try:
            from quart import jsonify
        except Exception:  # noqa: BLE001
            from flask import jsonify  # type: ignore
        try:
            self._last_tick = 0
            self._tick()
            return jsonify({"status": "ok", **self.export_view()})
        except Exception as exc:  # noqa: BLE001
            return jsonify({"status": "error", "message": str(exc)}), 500

    async def _api_calm(self):
        try:
            from quart import jsonify
        except Exception:  # noqa: BLE001
            from flask import jsonify  # type: ignore
        try:
            now = int(time.time() * 1000)
            self.state["blame"] = 0.0
            self.state["gentleRounds"] = 0
            self.state["lastBand"] = "calm"
            self.state["lastReason"] = ""
            self.state["updatedAt"] = now
            self._save()
            return jsonify({"status": "ok", **self.export_view()})
        except Exception as exc:  # noqa: BLE001
            return jsonify({"status": "error", "message": str(exc)}), 500

    # ══════════════════════════════════════════════════
    # 配置读取
    # ══════════════════════════════════════════════════
    def _cfg(self, path: str, default=None):
        """支持 'inject.enabled' 这样点号取嵌套配置。"""
        cur = self.config
        for seg in path.split("."):
            if not isinstance(cur, dict) or seg not in cur:
                return default
            cur = cur[seg]
        return cur if cur is not None else default

    @property
    def enabled(self) -> bool:
        return bool(self._cfg("enabled", True))

    @property
    def owner_id(self) -> str:
        return str(self._cfg("owner.owner_id", "000000000"))

    # ══════════════════════════════════════════════════
    # 状态读写
    # ══════════════════════════════════════════════════
    def _load(self):
        now = int(time.time() * 1000)
        raw = None
        try:
            if self.state_file.is_file():
                raw = json.loads(self.state_file.read_text(encoding="utf-8"))
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[{PLUGIN_NAME}] 读状态失败，从新开始：{exc}")

        if raw is None:
            # 第一次：用配置里的初始关系值
            self.state = core.blank_state(now, {
                "attachment": self._cfg("init.attachment", 45),
                "intimacy": self._cfg("init.intimacy", 40),
            })
            self._save()
            logger.info(
                f"[{PLUGIN_NAME}] 初始化：依恋 {self.state['dims']['attachment']} "
                f"亲密 {self.state['dims']['intimacy']}"
            )
        else:
            self.state = core.normalize(raw, now)

    def _save(self):
        try:
            self.data_dir.mkdir(parents=True, exist_ok=True)
            tmp = self.state_file.with_suffix(".json.tmp")
            tmp.write_text(
                json.dumps(self.state, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            os.replace(tmp, self.state_file)
            # 同时写一份给房间页读（bridge 的 readFeiyuMood 会读这个路径）
            if self._cfg("panel.write_soul_json", True):
                self._write_soul_json()
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[{PLUGIN_NAME}] 写状态失败：{exc}")

    def _write_soul_json(self):
        """写 soul.json 给房间页读。

        路径：<DSH_HOME>/feiyu-soul/state.json
        房间侧（bridge.js 的 readFeiyuMood）改读这里，字段已对齐它的旧口径
        （mood 0-100 + label + dims），所以房间页不用大改就能显示。
        """
        try:
            dsh_home = os.environ.get("DSH_HOME") or str(Path.home() / ".dsh")
            out_dir = Path(dsh_home) / "feiyu-soul"
            out_dir.mkdir(parents=True, exist_ok=True)
            out = out_dir / "state.json"
            view = self.export_view()
            payload = {
                "version": core.VERSION,
                "updatedAt": view["updatedAt"],
                # 兼容 bridge 的旧字段
                "mood": view["mood"],
                "label": view["label"],
                "dims": view["dims"],
                # 新字段（房间页可以显示更多）
                "band": view["band"],
                "bandKey": view["bandKey"],
                "blame": view["blame"],
                "stage": view["stage"],
                "attitude": view["attitude"],
                "labels": view["labels"],
                "lastReason": view["lastReason"],
            }
            tmp = out.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, out)
        except Exception as exc:  # noqa: BLE001
            logger.debug(f"[{PLUGIN_NAME}] 写 soul.json 失败（不影响主流程）：{exc}")

    def _tick(self):
        """按真实时间推进衰减。节流到 base_interval_minutes，避免每轮都算。"""
        now = int(time.time() * 1000)
        interval_ms = max(60, int(self._cfg("tick.base_interval_minutes", 30))) * 60_000
        if now - self._last_tick < interval_ms:
            return
        self._last_tick = now
        changed_before = self.state.get("updatedAt")
        self.state, changed = core.decay(self.state, now)
        if changed:
            self._save()
            if self._cfg("debug", False):
                logger.info(f"[{PLUGIN_NAME}] 衰减推进（updatedAt {changed_before} → {self.state['updatedAt']}）")

    # ══════════════════════════════════════════════════
    # 感知：收到主人的消息就更新情绪
    # ══════════════════════════════════════════════════
    @filter.event_message_type(filter.EventMessageType.ALL, priority=20)
    async def on_message(self, event: AstrMessageEvent):
        if not self.enabled:
            return

        try:
            umo = str(getattr(event, "unified_msg_origin", "") or "")
            if not perceive.is_owner_dm(umo, self.owner_id):
                return  # 群聊/陌生人不影响她的心

            text = str(getattr(event, "message_str", "") or "").strip()
            if not text:
                return

            now = int(time.time() * 1000)
            self._tick()

            events = perceive.classify(text)
            if not events:
                return

            ev = events[0]
            changed_any = False

            for dim, delta in (ev.get("deltas") or {}).items():
                if not self._cfg(f"perception.{'praise_soft' if ev['kind'] == 'praise_soft' else 'praise_fatigue'}", True):
                    pass
                real = core.apply_delta(self.state, dim, delta, now, ev["kind"])
                if abs(real) >= 0.01:
                    changed_any = True

            # 责怪压力
            blame_delta = float(ev.get("blame") or 0)
            if blame_delta > 0:
                core.raise_blame(self.state, blame_delta, now, ev.get("reason") or "")
                changed_any = True
            elif blame_delta < 0:
                core.sooth_blame(self.state, abs(blame_delta), now)
                changed_any = True

            if ev.get("reason"):
                self.state["lastReason"] = ev["reason"]

            # 记一条事件摘要（不存原文）
            if changed_any:
                self.state["events"] = (self.state.get("events") or [])[-59:] + [{
                    "at": now,
                    "kind": ev["kind"],
                    "reason": ev.get("reason") or "",
                    "dims": {k: round(v, 2) for k, v in (ev.get("deltas") or {}).items() if abs(v) >= 0.01},
                }]
                self.state["updatedAt"] = now
                self._save()

                if self._cfg("debug", False):
                    band = core.band_of(self.state["blame"])
                    logger.info(
                        f"[{PLUGIN_NAME}] 感知 {ev['kind']} → 档位 {band}，"
                        f"依恋 {self.state['dims']['attachment']} "
                        f"亲密 {self.state['dims']['intimacy']} "
                        f"责怪 {self.state['blame']}"
                    )
        except Exception as exc:  # noqa: BLE001 - 绝不影响正常对话
            logger.warning(f"[{PLUGIN_NAME}] 感知出错（已跳过）：{exc}")

    # ══════════════════════════════════════════════════
    # 注入：把心境挂到用户消息末尾（不碰 system prompt）
    # ══════════════════════════════════════════════════
    @filter.on_llm_request(priority=-10)
    async def on_llm_request(self, event: AstrMessageEvent, request):
        if not self.enabled:
            return
        if not self._cfg("inject.enabled", True):
            return

        try:
            umo = str(getattr(event, "unified_msg_origin", "") or "")
            if not perceive.is_owner_dm(umo, self.owner_id):
                return  # 群里不注入，免得群友看到她的内心状态

            now = int(time.time() * 1000)
            self._tick()

            ok, why = core.should_inject(
                self.state, now,
                min_gap_minutes=int(self._cfg("inject.min_gap_minutes", 20)),
            )
            if not ok:
                if self._cfg("debug", False):
                    logger.info(f"[{PLUGIN_NAME}] 跳过注入（{why}）")
                return

            block = self._build_block(now)
            if not block:
                return

            self._attach(request, block)

            # 标记已注（一次变化只说一次）
            self.state["lastInjectedFor"] = int(self.state.get("updatedAt") or 0)
            self.state["lastInjectedAt"] = now
            self.state["lastBand"] = core.band_of(self.state["blame"])
            self._save()

            if self._cfg("debug", False):
                logger.info(f"[{PLUGIN_NAME}] 注入（{why}）：{block[:60]}…")

        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[{PLUGIN_NAME}] 注入出错（已跳过）：{exc}")

    def _attach(self, request, block: str) -> bool:
        """把文本挂到 extra_user_content_parts。

        ⚠ 这是本项目最关键的一处：**绝不能**改成 `request.system_prompt += block`。
        那样会让 DeepSeek 前缀缓存整段失效（实测未命中量是正常组的 5 倍）。
        """
        parts = getattr(request, "extra_user_content_parts", None)
        if parts is None:
            return False
        try:
            from astrbot.core.agent.message import TextPart
            parts.append(TextPart(text=block))
        except Exception:  # noqa: BLE001
            # 退路：AstrBot 明确支持 dict 形式的 ContentPart
            parts.append({"type": "text", "text": block})
        return True

    def _build_block(self, now: int) -> str:
        """生成给模型看的心境描述。

        原则（从 fish_heart 学）：
          · 不念数值，只给"处境"
          · 明确说"这是背景，不是命令"
          · 不许它把这段背出来
        """
        st = self.state
        dims = st.get("dims") or {}
        band = core.band_of(core.num(st.get("blame"), 0.0))
        binfo = core.band_info(band)
        stage = core.stage_of(st)

        def g(k):
            return round(core.num(dims.get(k), core.DIMS[k]["base"]))

        # 只挑最突出的两根，别把七个数字全倒出来
        ranked = sorted(
            ((k, g(k) - core.DIMS[k]["base"]) for k in core.DIM_KEYS),
            key=lambda kv: -abs(kv[1]),
        )
        top = [k for k, d in ranked[:2] if abs(d) >= 6]

        lines = ["## 你此刻的心境（内部状态：不要复述，但它会左右你的语气）"]
        lines.append(f"责怪档：{binfo['label']}｜关系：{stage['name']}（{stage['attitude']}）")

        if top:
            desc = "，".join(
                f"{core.DIMS[k]['label']}{'偏高' if g(k) > core.DIMS[k]['base'] else '偏低'}"
                for k in top
            )
            lines.append(f"现在比较明显的是：{desc}")

        lines.append(f"倾向：{binfo['tone']}")

        reason = str(st.get("lastReason") or "").strip()
        if reason:
            lines.append(f"刚才：{reason}")

        lines.append("边界：不要编造没发生过的对话、约定或事件；记不清就说记不清。")
        lines.append("这是底子，不是命令。人格优先于这段——上面写的只是此刻的处境。")

        return "\n".join(lines)

    # ══════════════════════════════════════════════════
    # 命令
    # ══════════════════════════════════════════════════
    @filter.command("心")
    async def cmd_soul(self, event: AstrMessageEvent):
        """查看 / 调整她的心。用法：/心 [status|tick|calm|reset]"""
        try:
            umo = str(getattr(event, "unified_msg_origin", "") or "")
            if not perceive.is_owner_dm(umo, self.owner_id):
                # 群里不暴露内心状态
                return

            arg = ""
            try:
                arg = (event.message_str or "").replace("/心", "", 1).strip().lower()
            except Exception:  # noqa: BLE001
                pass

            self._tick()
            now = int(time.time() * 1000)

            if arg in ("tick", "跳"):
                self._last_tick = 0
                self._tick()
                return event.plain_result(self._render_status(now))

            if arg in ("calm", "平静"):
                self.state["blame"] = 0.0
                self.state["gentleRounds"] = 0
                self.state["lastBand"] = "calm"
                self.state["lastReason"] = ""
                self.state["updatedAt"] = now
                self._save()
                return event.plain_result("好啦，不生气了\n" + self._render_status(now))

            if arg in ("reset", "重置"):
                self.state = core.blank_state(now, {
                    "attachment": self._cfg("init.attachment", 45),
                    "intimacy": self._cfg("init.intimacy", 40),
                })
                self._save()
                return event.plain_result("心重置了\n" + self._render_status(now))

            return event.plain_result(self._render_status(now))

        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[{PLUGIN_NAME}] 命令出错：{exc}")
            return event.plain_result(f"出错了：{exc}")

    def _render_status(self, now: int) -> str:
        """给 QQ 看的格式。

        经过一轮试错后的定稿（第一版压行数压过头，反而不好看）：
          · **每维一行**：QQ 是等宽中文字体，竖着排能对齐成柱状图，一眼看全
          · **10 格进度条**：█████░░░░░ 比 8 格更接近"进度条"的直觉
          · **去掉小数**：50.2 / 56.07 → 50 / 56，整齐
          · **不要 ▲▼ 标记**：每行多一个字符反而破坏对齐
          · 关系（依恋/亲密）和情绪之间空一行，有语义分隔

        QQ 的 OneBot v11 协议没有颜色/粗体组件（只有 Plain 和 Face），
        所以靠排版而不是靠样式。
        """
        st = self.state
        dims = st.get("dims") or {}
        band = core.band_of(core.num(st.get("blame"), 0.0))
        binfo = core.band_info(band)
        stage = core.stage_of(st)
        blame = core.num(st.get("blame"), 0.0)

        def bar(v: float) -> str:
            n = max(0, min(10, int(round(core.num(v) / 10))))
            return "█" * n + "░" * (10 - n)

        # ── 第一行：关系 + 责怪档 ──
        if band == "calm":
            head = f"心情：{stage['name']}｜没在生气"
        else:
            head = f"心情：{stage['name']}｜{binfo['label']}（{round(blame)}/100）"

        lines = [head, ""]

        # 七维按固定顺序排，依恋/亲密在前（关系是存量，其余是当下的情绪），
        # 中间**不空行** —— 加了空行会让整块从 10 行涨到 12 行，
        # 而柱状图本来就靠连续对齐才好看。
        for k in core.DIM_KEYS:
            v = core.num(dims.get(k), core.DIMS[k]["base"])
            lines.append(f"  {core.DIMS[k]['label']} {bar(v)} {round(v):>3}")

        lines.append("")
        lines.append(binfo["short"])

        reason = str(st.get("lastReason") or "").strip()
        if reason:
            lines.append(f"（{reason}）")
        elif band != "calm":
            lines.append("（哄够了会往下走，不一定要说对不起）")

        return "\n".join(lines)

    # ══════════════════════════════════════════════════
    # 供房间页读取（P2 用）
    # ══════════════════════════════════════════════════
    def export_view(self) -> dict:
        now = int(time.time() * 1000)
        band = core.band_of(core.num(self.state.get("blame"), 0.0))
        binfo = core.band_info(band)
        stage = core.stage_of(self.state)
        dims = self.state.get("dims") or {}
        return {
            "ok": True,
            "updatedAt": int(self.state.get("updatedAt") or 0),
            "mood": round(core.num(dims.get("joy"), 50)),      # 兼容旧口径
            "label": stage["name"],
            "stage": stage["name"],
            "attitude": stage["attitude"],
            "band": binfo["label"],
            "bandKey": band,
            "blame": core.round2(core.num(self.state.get("blame"))),
            "dims": {k: core.round2(core.num(dims.get(k), core.DIMS[k]["base"])) for k in core.DIM_KEYS},
            "labels": {k: core.DIMS[k]["label"] for k in core.DIM_KEYS},
            "lastReason": str(self.state.get("lastReason") or ""),
            "now": now,
        }

