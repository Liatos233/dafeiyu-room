"""房间联动插件：把 3D 房间接进 AstrBot 主线，并让 QQ 能查询/指挥。

房间侧不用面板接口（面板的 /api 有全局 JWT 鉴权），插件自己起一个只监听
127.0.0.1 的小 HTTP 服务，用 X-Room-Token 校验。
"""

from __future__ import annotations

import asyncio
import json
import os
import socket
import time
import uuid
from pathlib import Path
from typing import Any

import aiohttp
from aiohttp import web

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register
from astrbot.core.message.message_event_result import MessageChain
from astrbot.core.utils.astrbot_path import get_astrbot_data_path

try:
    from astrbot.core.platform.sources.webchat.webchat_queue_mgr import (
        webchat_queue_mgr,
    )
except Exception:  # pragma: no cover
    webchat_queue_mgr = None

PLUGIN_NAME = "astrbot_plugin_room_link"
DATA_DIR = Path(get_astrbot_data_path()) / "plugin_data" / PLUGIN_NAME
STATE_FILE = DATA_DIR / "state.json"

DEFAULT_STATE: dict[str, Any] = {
    "location": "客厅",
    "activity": "窝在沙发上发呆",
    "mood": "",
    "note": "",
    "since": 0,
    "updated": 0,
    "log": [],
    "commands": [],
}


def _now() -> float:
    return time.time()


def _fmt_ago(ts: float) -> str:
    if not ts:
        return "很久"
    mins = int((_now() - ts) // 60)
    if mins < 1:
        return "刚刚"
    if mins < 60:
        return f"{mins} 分钟前"
    hours = mins // 60
    if hours < 24:
        return f"{hours} 小时前"
    return f"{hours // 24} 天前"


@register(PLUGIN_NAME, "liato", "让 3D 房间和 QQ 共用同一只大肥鱼", "0.1.0")
class RoomLinkPlugin(Star):
    def __init__(self, context: Context, config: dict | None = None) -> None:
        super().__init__(context)
        self.config = config or {}
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        self.state = self._load_state()
        self._chat_lock = asyncio.Lock()
        self._state_lock = asyncio.Lock()
        self._runner: web.AppRunner | None = None
        self._bridge_proc: asyncio.subprocess.Process | None = None
        self._ctx_cache_at = 0.0
        self._ctx_cache: dict[str, Any] | None = None

    # ---------------------------------------------------------------- 生命周期

    async def initialize(self) -> None:
        host = str(self.config.get("listen_host") or "127.0.0.1")
        port = int(self.config.get("listen_port") or 6188)
        app = web.Application()
        app.router.add_get("/room/ping", self.h_ping)
        app.router.add_get("/room/state", self.h_state)
        app.router.add_post("/room/event", self.h_event)
        app.router.add_get("/room/commands", self.h_commands)
        app.router.add_post("/room/ack", self.h_ack)
        app.router.add_post("/room/chat", self.h_chat)
        app.router.add_get("/room/diag", self.h_diag)
        app.router.add_get("/room/places", self.h_places)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, host, port)
        try:
            await site.start()
            self._runner = runner
            logger.info(f"[room_link] 房间接口已启动：http://{host}:{port}/room/")
        except Exception as exc:
            logger.error(f"[room_link] 房间接口启动失败（{host}:{port}）：{exc}")
        await self._ensure_bridge()

    async def terminate(self) -> None:
        await self._stop_bridge()
        self._save_state()
        if self._runner is not None:
            try:
                await self._runner.cleanup()
            except Exception:
                pass
        logger.info("[room_link] 已停止，状态已保存")

    # ---------------------------------------------------------------- 状态

    def _load_state(self) -> dict[str, Any]:
        if STATE_FILE.exists():
            try:
                data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
                if isinstance(data, dict):
                    merged = dict(DEFAULT_STATE)
                    merged.update(data)
                    merged.setdefault("log", [])
                    merged.setdefault("commands", [])
                    return merged
            except Exception as exc:
                logger.warning(f"[room_link] 状态文件读取失败：{exc}")
        return dict(DEFAULT_STATE)

    def _save_state(self) -> None:
        try:
            STATE_FILE.write_text(
                json.dumps(self.state, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception as exc:
            logger.warning(f"[room_link] 状态写入失败：{exc}")

    def _places(self) -> dict:
        raw = self.config.get("places") or {}
        out = {}
        if isinstance(raw, dict):
            for key, val in raw.items():
                if isinstance(val, str) and "/" in val:
                    room, spot = val.split("/", 1)
                    room, spot = room.strip(), spot.strip()
                    if room and spot:
                        out[str(key).strip()] = (room, spot)
                elif isinstance(val, dict) and val.get("room") and val.get("spot"):
                    out[str(key).strip()] = (str(val["room"]), str(val["spot"]))
        return out

    def _display_location(self, location: str, room: str = "") -> str:
        """按 room_names 配置把房间名换掉（location 形如「客厅·沙发上」）。"""
        names = self.config.get("room_names") or {}
        if not isinstance(names, dict) or not location:
            return location
        alias = ""
        if room:
            alias = str(names.get(room) or "").strip()
        if not alias and "·" in location:
            head = location.split("·", 1)[0]
            for rid, nm in names.items():
                if str(nm).strip() == head and rid != room:
                    alias = head
                    break
            if not alias:
                # 反查房间 id：默认名与当前 head 相同则保持
                alias = ""
        if not alias:
            return location
        if "·" in location:
            return alias + "·" + location.split("·", 1)[1]
        return alias

    def _status_text(self) -> str:
        s = self.state
        where = self._display_location(s.get("location") or "房间", s.get("room") or "")
        home = str(self.config.get("home_name") or "家").strip() or "家"
        doing = s.get("activity") or "发呆"
        since = s.get("since") or s.get("updated") or 0
        line = f"她现在在{home}·{where}，{doing}"
        if since:
            line += f"，已经这样 {_fmt_ago(since).replace('前', '')}"
        if s.get("mood"):
            line += f"；心情：{s['mood']}"
        logs = [x for x in (s.get("log") or []) if isinstance(x, dict)][-5:]
        if logs:
            line += "\n最近：\n" + "\n".join(
                f"- {x.get('text', '')}（{_fmt_ago(x.get('t', 0))}）" for x in logs
            )
        return line

    def _bridge_base(self) -> str:
        return f"http://127.0.0.1:{int(self.config.get('bridge_port') or 3100)}"

    def _bridge_token(self) -> str:
        p = str(self.config.get("bridge_token") or "").strip()
        if p:
            return p
        try:
            f = Path(str(self.config.get("bridge_dir") or "")) / "state" / "console-token"
            if f.exists():
                return f.read_text(encoding="utf-8").strip()
        except Exception:
            pass
        return ""

    async def _bridge_json(self, path: str, timeout: float = 2.5) -> dict[str, Any] | None:
        headers = {}
        token = self._bridge_token()
        if token:
            headers["Authorization"] = f"Bearer {token}"
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as sess:
                async with sess.get(self._bridge_base() + path, headers=headers) as resp:
                    if resp.status != 200:
                        return None
                    data = await resp.json()
                    return data if isinstance(data, dict) else None
        except Exception:
            return None

    async def _live_context(self, ttl: float = 10.0) -> dict[str, Any] | None:
        """房间的实时状态（位置/在做什么/需求/心情），10 秒缓存。"""
        if not self.config.get("use_live_context", True):
            return None
        if self._ctx_cache and _now() - self._ctx_cache_at < ttl:
            return self._ctx_cache
        data = await self._bridge_json("/api/home/context")
        if data and data.get("ok"):
            self._ctx_cache = data
            self._ctx_cache_at = _now()
            return data
        return None

    async def _status_text_async(self) -> str:
        ctx = await self._live_context()
        if ctx:
            bits = [str(ctx.get("line") or "").strip()]
            her = ctx.get("her") or {}
            if her.get("clip"):
                bits.append(f"正在播「{her['clip']}」")
            if her.get("asleep"):
                bits.append("睡着了")
            events = [e for e in (ctx.get("recentEvents") or []) if e][-3:]
            if events:
                bits.append("最近：" + "；".join(events))
            return "\n".join([b for b in bits if b])
        return self._status_text()

    async def _apply_event(self, payload: dict[str, Any]) -> dict[str, Any]:
        async with self._state_lock:
            s = self.state
            location = str(payload.get("location") or "").strip()
            activity = str(payload.get("activity") or "").strip()
            note = str(payload.get("note") or "").strip()
            changed = False
            if location and location != s.get("location"):
                s["location"] = location
                changed = True
            if payload.get("room"):
                s["room"] = str(payload["room"])[:32]
            if activity and activity != s.get("activity"):
                s["activity"] = activity
                changed = True
            if payload.get("type"):
                s["lastType"] = str(payload["type"])[:24]
            if payload.get("mood"):
                s["mood"] = str(payload["mood"])[:40]
            if isinstance(payload.get("needs"), dict):
                s["needs"] = payload["needs"]
            if note:
                s["note"] = note[:200]
                changed = True
            now = _now()
            if changed:
                s["since"] = now
            s["updated"] = now
            text = note or f"{s.get('location')}：{s.get('activity')}"
            if not payload.get("silent"):
                log = s.setdefault("log", [])
                log.append({"t": now, "text": text[:120]})
                del log[:-40]
            self._save_state()
            snapshot = dict(s)
        if changed and self.config.get("notify_owner"):
            await self._notify_owner(
                f"（房间里）{snapshot.get('location')}，{snapshot.get('activity')}"
            )
        return snapshot

    async def _notify_owner(self, text: str) -> None:
        umo = str(self.config.get("owner_session") or "").strip()
        if not umo:
            return
        try:
            await self.context.send_message(umo, MessageChain().message(text))
        except Exception as exc:
            logger.warning(f"[room_link] 主动通知失败：{exc}")

    # ---------------------------------------------------------------- 对话

    async def _ask(self, text: str) -> str:
        if webchat_queue_mgr is None:
            raise RuntimeError("当前 AstrBot 版本没有 webchat 队列")
        conv = str(self.config.get("room_conversation_id") or "room")
        user = str(self.config.get("webchat_username") or "630151911")
        timeout = int(self.config.get("reply_timeout") or 90)

        async with self._chat_lock:
            rid = f"room-{uuid.uuid4().hex[:12]}"
            back = webchat_queue_mgr.get_or_create_back_queue(rid, conv)
            queue = webchat_queue_mgr.get_or_create_queue(conv)
            payload = {
                "message_id": rid,
                "message": [{"type": "plain", "text": text}],
                "locale": "zh-CN",
            }
            await queue.put((user, conv, payload))

            chunks: list[str] = []
            deadline = time.monotonic() + timeout
            try:
                while True:
                    remain = deadline - time.monotonic()
                    if remain <= 0:
                        raise TimeoutError("AstrBot 没有在超时内回复")
                    item = await asyncio.wait_for(back.get(), timeout=remain)
                    if not isinstance(item, dict):
                        continue
                    kind = item.get("type")
                    if kind == "plain":
                        piece = str(item.get("data") or "")
                        t = piece.strip()
                        noisy = t.startswith("{") and (
                            "token_usage" in t
                            or "current_context_tokens" in t
                            or '"arguments"' in t
                            or '"id":"call' in t
                            or '"id": "call' in t
                        )
                        if piece and not noisy:
                            chunks.append(piece)
                    elif kind in ("end", "complete"):
                        break
                    elif kind == "image":
                        chunks.append("[图片]")
            finally:
                try:
                    webchat_queue_mgr.remove_back_queue(rid)
                except Exception:
                    pass
            reply = "".join(chunks).strip()
            # 去掉 AstrBot 追加在回复末尾的用量 JSON
            cut = reply.rfind('{"token_usage"')
            if cut > 0:
                reply = reply[:cut].rstrip()
            return reply

    # ---------------------------------------------------------------- 桥接

    async def _bridge_port_open(self) -> bool:
        port = int(self.config.get("bridge_port") or 3100)
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection("127.0.0.1", port), timeout=1.5
            )
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            return True
        except Exception:
            return False

    async def _ensure_bridge(self) -> None:
        if not self.config.get("bridge_auto_start"):
            return
        if await self._bridge_port_open():
            logger.info("[room_link] 房间桥接已在运行，跳过启动")
            return
        app_dir = str(self.config.get("bridge_dir") or "").strip()
        node_exe = str(self.config.get("bridge_node") or "").strip() or "node"
        if not app_dir or not os.path.isdir(app_dir):
            logger.warning(f"[room_link] 桥接目录不存在：{app_dir}")
            return
        log_path = os.path.join(app_dir, "bridge.log")
        flags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
        try:
            out = open(log_path, "ab")
            self._bridge_proc = await asyncio.create_subprocess_exec(
                node_exe, "src/bridge.js",
                cwd=app_dir,
                stdin=asyncio.subprocess.DEVNULL,
                stdout=out,
                stderr=asyncio.subprocess.STDOUT,
                creationflags=flags,
            )
            logger.info(f"[room_link] 已启动房间桥接 pid={self._bridge_proc.pid}")
        except Exception as exc:
            logger.error(f"[room_link] 启动房间桥接失败：{exc}")

    async def _stop_bridge(self) -> None:
        proc = self._bridge_proc
        self._bridge_proc = None
        if proc is None or proc.returncode is not None:
            return
        try:
            proc.terminate()
            await asyncio.wait_for(proc.wait(), timeout=6)
            logger.info("[room_link] 房间桥接已停止")
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass

    # ---------------------------------------------------------------- HTTP

    def _token_ok(self, request: web.Request) -> bool:
        want = str(self.config.get("api_token") or "").strip()
        if not want:
            return True
        return str(request.headers.get("X-Room-Token") or "").strip() == want

    def _denied(self) -> web.Response:
        return web.json_response({"ok": False, "error": "token 不对"}, status=401)

    async def h_ping(self, request: web.Request) -> web.Response:
        return web.json_response({"ok": True, "plugin": PLUGIN_NAME, "ts": _now()})

    async def h_diag(self, request: web.Request) -> web.Response:
        if not self._token_ok(request):
            return self._denied()
        names = []
        try:
            for p in self.context.platform_manager.platform_insts:
                try:
                    names.append(p.meta().id)
                except Exception:
                    continue
        except Exception:
            pass
        return web.json_response(
            {
                "ok": True,
                "platforms": names,
                "webchat": webchat_queue_mgr is not None,
                "conv": self.config.get("room_conversation_id"),
                "username": self.config.get("webchat_username"),
            }
        )

    async def h_places(self, request: web.Request) -> web.Response:
        if not self._token_ok(request):
            return self._denied()
        return web.json_response({
            "ok": True,
            "places": {k: f"{r}/{sp}" for k, (r, sp) in self._places().items()},
            "room_names": self.config.get("room_names") or {},
            "home_name": self.config.get("home_name") or "小蓝鱼的家",
        })

    async def h_state(self, request: web.Request) -> web.Response:
        if not self._token_ok(request):
            return self._denied()
        return web.json_response({"ok": True, "state": self.state, "text": await self._status_text_async()})

    async def h_event(self, request: web.Request) -> web.Response:
        if not self._token_ok(request):
            return self._denied()
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        if not isinstance(payload, dict):
            payload = {}
        state = await self._apply_event(payload)
        return web.json_response({"ok": True, "state": state})

    async def h_commands(self, request: web.Request) -> web.Response:
        if not self._token_ok(request):
            return self._denied()
        pending = [c for c in self.state.get("commands", []) if c.get("status") == "pending"]
        return web.json_response({"ok": True, "commands": pending, "places": {k: f"{r}/{sp}" for k, (r, sp) in self._places().items()}, "home_name": self.config.get("home_name") or "小蓝鱼的家"})

    async def h_ack(self, request: web.Request) -> web.Response:
        if not self._token_ok(request):
            return self._denied()
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        cid = str((payload or {}).get("id") or "")
        async with self._state_lock:
            for c in self.state.get("commands", []):
                if c.get("id") == cid:
                    c["status"] = "done"
                    c["done_at"] = _now()
            self._save_state()
        return web.json_response({"ok": True})

    async def h_chat(self, request: web.Request) -> web.Response:
        if not self._token_ok(request):
            return self._denied()
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        text = str((payload or {}).get("text") or "").strip()
        if not text:
            return web.json_response({"ok": False, "error": "想说什么？"}, status=400)
        ctx = await self._live_context()
        s = self.state
        if ctx:
            here = str(ctx.get("line") or f"{s.get('location')}，{s.get('activity')}")
        else:
            here = f"{s.get('location')}，{s.get('activity')}"
        prefix = (f"（你在房间里：{here}现在主人正在房间网页里直接跟你说话。"
                  f"如果主人让你去某处、做某件事或播某个动作，必须调用 room_command / room_play 工具真的去做，不要只说。）")
        try:
            reply = await self._ask(prefix + text)
        except Exception as exc:
            logger.warning(f"[room_link] 房间对话失败：{exc}")
            return web.json_response({"ok": False, "error": str(exc)}, status=502)
        return web.json_response({"ok": True, "reply": reply})

    # ---------------------------------------------------------------- QQ 侧

    @filter.llm_tool(name="room_status")
    async def room_status(self, event: AstrMessageEvent):
        """查看自己此刻在房间里做什么、在哪里、多久了、最近做过什么。

        当主人问「你在干嘛」「你在哪」「房间怎么样」时调用。

        Args:
        """
        return await self._status_text_async()

    @filter.llm_tool(name="room_command")
    async def room_command(self, event: AstrMessageEvent, action: str, target: str = ""):
        """把指令真正下发给房间执行（只有主人能用）。

        主人让你去某个地方、睡觉、浇花、看电视、喂鱼这类「动作」时，**必须调用本工具**，
        只回一句「好我去睡了」而不调用，等于没做，房间里的你不会动。

        默认可去的地点（可在插件配置 places 里增改）：
        厨房、冰箱、水槽、餐厅、客厅、沙发、电视、书架、卧室、床上、书桌、衣柜、窗边、
        阳台、躺椅、卫生间、洗澡、走廊、玄关、门口、洗衣机、菜园、屋外。

        Args:
            action(string): 要做的动作或目标，例如「去睡觉」「去厨房」「浇花」「看电视」
            target(string): 可选，更细的目标，例如「床」「菜园」
        """
        if str(event.get_sender_id()) != str(self.config.get("owner_qq") or "630151911"):
            return "这个只有主人能指挥。"
        cmd = {
            "id": uuid.uuid4().hex[:8],
            "action": action[:40],
            "target": target[:40],
            "status": "pending",
            "created": _now(),
        }
        async with self._state_lock:
            self.state.setdefault("commands", []).append(cmd)
            del self.state["commands"][:-10]
            self._save_state()
        suffix = f"·{target}" if target else ""
        return f"已经让她「{action}{suffix}」，房间那边会去执行。"

    @filter.llm_tool(name="room_play")
    async def room_play(self, event: AstrMessageEvent, clip: str):
        """让房间里的她立刻播一个指定动画（跳舞、写毛笔字、游泳、撸猫…）。

        只有主人能用。主人说「跳个舞」「写个字让我看看」「去游个泳」这类
        「指定某个动作」时调用本工具（比 room_command 更精确）。

        Args:
            clip(string): 动画名，例如「跳街舞」「写毛笔字」「游泳」「撸猫」「吹气球」
        """
        if str(event.get_sender_id()) != str(self.config.get("owner_qq") or "630151911"):
            return "这个只有主人能指挥。"
        name = str(clip or "").strip()[:40]
        if not name:
            return "要点播哪个动作？"
        idx = await self._bridge_json("/api/home/clips", timeout=4)
        names = [str(x) for x in ((idx or {}).get("clips") or [])]
        matched = ""
        if name in names:
            matched = name
        else:
            for cand in names:
                if name in cand or cand in name:
                    matched = cand
                    break
        if not matched:
            hint = "、".join(names[:12]) if names else "（还没拿到动作清单）"
            return f"没有找到「{name}」。可选的有：{hint} 等。"
        cmd = {
            "id": uuid.uuid4().hex[:8],
            "action": "clip",
            "clip": matched,
            "status": "pending",
            "created": _now(),
        }
        async with self._state_lock:
            self.state.setdefault("commands", []).append(cmd)
            del self.state["commands"][:-10]
            self._save_state()
        return f"已经让她演「{matched}」，房间那边马上开始。"

    @filter.llm_tool(name="room_say")
    async def room_say(self, event: AstrMessageEvent, text: str):
        """让房间里的她在头顶气泡说一句话（会把这句话同步显示在房间里）。

        主人说「你跟房间里说一句 XXX」「让她说 XXX」这类时调用。

        Args:
            text(string): 要她说的话，尽量保持她的语气
        """
        if str(event.get_sender_id()) != str(self.config.get("owner_qq") or "630151911"):
            return "这个只有主人能指挥。"
        words = str(text or "").strip()[:140]
        if not words:
            return "要她说什么？"
        cmd = {
            "id": uuid.uuid4().hex[:8],
            "action": "say",
            "text": words,
            "status": "pending",
            "created": _now(),
        }
        async with self._state_lock:
            self.state.setdefault("commands", []).append(cmd)
            del self.state["commands"][:-10]
            self._save_state()
        return f"已经让她在房间里说：「{words}」"

    @filter.command("房间地点")
    async def room_places(self, event: AstrMessageEvent):
        """列出当前可以让她去的地点。"""
        places = self._places()
        if not places:
            yield event.plain_result("还没配置地点。")
            return
        yield event.plain_result("可以去：" + "、".join(places.keys()))

    @filter.command("房间")
    async def room_cmd(self, event: AstrMessageEvent):
        """查看大肥鱼此刻在房间里的状态。"""
        yield event.plain_result(self._status_text())
