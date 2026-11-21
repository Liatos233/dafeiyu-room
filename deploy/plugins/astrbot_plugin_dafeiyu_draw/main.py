"""大肥鱼画画插件：把智谱 BigModel 的 CogView-4 生图接进 AstrBot。

- 给模型注册 LLM 工具 `draw_picture`：主人让她画什么，她就真去画并发图。
- 给主人一个手动命令 `/画 <描述>`，方便验证和单独出图。
- 生图走智谱 /api/paas/v4/images/generations（模型 cogview-4-250304）。

配置（插件配置页 / astrbot_plugin_dafeiyu_draw_config.json）：
  api_key   智谱 API Key（必填）
  model     默认 cogview-4-250304
  size      默认 1024x1024
  owner_qq  只有这个 QQ 能触发（默认 630151911）
  daily_limit 每人每天最多画几张（默认 20，0 = 不限）
"""

from __future__ import annotations

import asyncio
import base64
import time
import uuid
from pathlib import Path

import aiohttp
from mcp.types import CallToolResult, ImageContent, TextContent

from astrbot.api import logger
from astrbot.api import message_components as Comp
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.star import Context, Star, register
from astrbot.core.utils.astrbot_path import get_astrbot_data_path

PLUGIN_NAME = "astrbot_plugin_dafeiyu_draw"
DATA_DIR = Path(get_astrbot_data_path()) / "plugin_data" / PLUGIN_NAME
IMAGE_DIR = DATA_DIR / "images"
API_URL = "https://open.bigmodel.cn/api/paas/v4/images/generations"

# CogView-4 支持的尺寸
ALLOWED_SIZES = {
    "1024x1024", "768x1344", "864x1152", "1344x768",
    "1152x864", "1440x720", "720x1440",
}


@register(
    PLUGIN_NAME,
    "dafeiyu-pack",
    "智谱 CogView-4 生图：给大肥鱼一个画画工具，画完直接把图发出来",
    "v0.1.0",
)
class DafeiyuDraw(Star):
    def __init__(self, context: Context, config: dict | None = None):
        super().__init__(context)
        self.config = config or {}
        # provider: zhipu（智谱 CogView）| qwen（阿里通义万相 / Qwen-Image）
        self.provider = str(self.config.get("provider") or "zhipu").strip().lower()
        self.api_key = str(self.config.get("api_key") or "").strip()
        self.qwen_api_key = str(self.config.get("qwen_api_key") or "").strip()
        self.qwen_model = str(self.config.get("qwen_model") or "qwen-image-3.0").strip()
        self.qwen_endpoint = str(
            self.config.get("qwen_endpoint")
            or "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
        ).strip()
        self.model = str(self.config.get("model") or "cogview-4-250304").strip()
        size = str(self.config.get("size") or "1024x1024").strip()
        self.default_size = size if size in ALLOWED_SIZES else "1024x1024"
        self.owner_qq = str(self.config.get("owner_qq") or "630151911").strip()
        self.daily_limit = max(0, int(self.config.get("daily_limit") or 20))
        self._usage: dict[str, list[float]] = {}
        self._last: dict[str, float] = {}
        IMAGE_DIR.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------ 工具
    def _is_owner(self, event: AstrMessageEvent) -> bool:
        try:
            return str(event.get_sender_id()) == self.owner_qq
        except Exception:
            return False

    def _quota_ok(self, user: str) -> tuple[bool, str]:
        now = time.time()
        last = self._last.get(user, 0)
        if now - last < 8:
            return False, "刚画过一张，等我喘口气再来（8 秒冷却）"
        used = [t for t in self._usage.get(user, []) if now - t < 86400]
        self._usage[user] = used
        if self.daily_limit and len(used) >= self.daily_limit:
            return False, f"今天已经画了 {len(used)} 张，到上限了，明天再画"
        return True, ""

    async def _generate(self, prompt: str, size: str) -> tuple[bytes, str]:
        """按 provider 生成图片，返回 (图片字节, 落盘路径)。"""
        if self.provider == "qwen":
            image_bytes = await self._generate_qwen(prompt, size)
            path = IMAGE_DIR / f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}.png"
            path.write_bytes(image_bytes)
            return image_bytes, str(path)
        return await self._generate_zhipu(prompt, size)

    async def _generate_qwen(self, prompt: str, size: str) -> bytes:
        """Qwen-Image / 通义万相：多模态生成接口，同步返回图片 URL。"""
        if not self.qwen_api_key:
            raise RuntimeError("没有配置 DashScope API Key（qwen_api_key）")
        # DashScope 用 1024*1024 这种写法
        dash_size = size.replace("x", "*")
        body = {
            "model": self.qwen_model,
            "input": {"messages": [{"role": "user", "content": [{"text": prompt}]}]},
            "parameters": {"size": dash_size, "n": 1, "watermark": False},
        }
        timeout = aiohttp.ClientTimeout(total=180)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                self.qwen_endpoint,
                json=body,
                headers={
                    "Authorization": f"Bearer {self.qwen_api_key}",
                    "Content-Type": "application/json",
                },
            ) as resp:
                raw = await resp.text()
                if resp.status != 200:
                    raise RuntimeError(f"Qwen 生图失败 HTTP {resp.status}：{raw[:200]}")
                data = _loads(raw)
            image_url = ""
            try:
                choices = data["output"]["choices"]
                for part in choices[0]["message"]["content"]:
                    if isinstance(part, dict) and part.get("image"):
                        image_url = part["image"]
                        break
            except Exception:
                image_url = ""
            if not image_url:
                raise RuntimeError(f"Qwen 返回里没有图片：{raw[:200]}")
            async with session.get(image_url) as img:
                if img.status != 200:
                    raise RuntimeError(f"下载 Qwen 图片失败 HTTP {img.status}")
                return await img.read()

    async def _generate_zhipu(self, prompt: str, size: str) -> tuple[bytes, str]:
        """智谱 CogView-4，返回 (图片字节, 落盘路径)。"""
        if not self.api_key:
            raise RuntimeError("没有配置智谱 API Key（插件配置 api_key）")
        body = {
            "model": self.model,
            "prompt": prompt,
            "size": size,
            # 关水印。注意：智谱要求账号先在「个人中心 → 安全管理 → 去水印管理」
            # 签署免责声明；没签的话服务端会**静默忽略**这个字段（实测仍出水印）。
            "watermark_enabled": False,
        }
        timeout = aiohttp.ClientTimeout(total=180)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                API_URL,
                json=body,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
            ) as resp:
                raw = await resp.text()
                if resp.status != 200:
                    raise RuntimeError(f"智谱生图失败 HTTP {resp.status}：{raw[:200]}")
                data = _loads(raw)

            item = (data.get("data") or [{}])[0]
            if item.get("b64_json"):
                image_bytes = base64.b64decode(item["b64_json"])
            elif item.get("url"):
                async with session.get(item["url"]) as img:
                    if img.status != 200:
                        raise RuntimeError(f"下载生成的图片失败 HTTP {img.status}")
                    image_bytes = await img.read()
            else:
                raise RuntimeError(f"智谱返回里没有图片：{raw[:200]}")

        path = IMAGE_DIR / f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}.png"
        path.write_bytes(image_bytes)
        return image_bytes, str(path)

    async def _draw_for_tool(self, event: AstrMessageEvent, prompt: str, size: str):
        """生成并发图；返回 (给模型看的文字, 图片字节或 None)。"""
        user = str(event.get_sender_id())
        ok, why = self._quota_ok(user)
        if not ok:
            return why, None
        clean = (prompt or "").strip()
        if not clean:
            return "要画什么？把画面描述给我", None
        if len(clean) > 1000:
            return "描述太长了（最多 1000 字），精简一下", None
        want = size.strip() if size and size.strip() in ALLOWED_SIZES else self.default_size
        try:
            image_bytes, path = await self._generate(clean, want)
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[draw] 生图失败：{exc}")
            return f"画失败了：{exc}", None
        self._last[user] = time.time()
        self._usage.setdefault(user, []).append(time.time())
        sent_ok = True
        try:
            await event.send(event.chain_result([Comp.Image.fromBytes(image_bytes)]))
        except Exception as exc:  # noqa: BLE001
            sent_ok = False
            logger.warning(f"[draw] 发送图片失败：{exc}")
        logger.info(f"[draw] {user} 画好一张：{clean[:40]} size={want} file={path}")
        if sent_ok:
            text = f"画好了，已经发到聊天里了（{want}）。画面：{clean[:80]}"
        else:
            text = f"画好了但发送失败（{want}），文件在 {path}。画面：{clean[:80]}"
        return text, image_bytes

    async def _draw_and_send(self, event: AstrMessageEvent, prompt: str, size: str) -> str:
        user = str(event.get_sender_id())
        ok, why = self._quota_ok(user)
        if not ok:
            return why
        clean = (prompt or "").strip()
        if not clean:
            return "要画什么？把画面描述给我"
        if len(clean) > 1000:
            return "描述太长了（最多 1000 字），精简一下"
        want = size.strip() if size and size.strip() in ALLOWED_SIZES else self.default_size
        try:
            image_bytes, path = await self._generate(clean, want)
        except Exception as exc:  # noqa: BLE001 - 给模型可读错误
            logger.warning(f"[draw] 生图失败：{exc}")
            return f"画失败了：{exc}"
        self._last[user] = time.time()
        self._usage.setdefault(user, []).append(time.time())
        try:
            await event.send(event.chain_result([Comp.Image.fromBytes(image_bytes)]))
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[draw] 发送图片失败：{exc}")
            return f"画好了但发不出去：{exc}（文件在 {path}）"
        logger.info(f"[draw] {user} 画好一张：{clean[:40]} size={want} file={path}")
        return f"画好了，已经发出去了（{want}）。画面：{clean[:60]}"

    @filter.llm_tool(name="draw_picture")
    async def draw_picture(self, event: AstrMessageEvent, prompt: str, size: str = ""):
        """按描述画一张图并发给主人，同时把画好的图返回给你自己看。

        主人让你画图、要你「画一个/画张/来张图」、想要头像/壁纸/表情时调用。
        图会直接发到当前会话；你在返回结果里也能看到这张图，可以照着它继续聊。

        Args:
            prompt(string): 画面描述，越具体越好（主体、动作、风格、配色、构图）
            size(string): 可选尺寸，如 1024x1024 / 1344x768 / 768x1344，默认 1024x1024
        """
        if not self._is_owner(event):
            return "只有主人能让我画画。"
        text, image_bytes = await self._draw_for_tool(event, prompt, size)
        if image_bytes is None:
            return text
        # 把图片作为工具结果的一部分返回：核心会缓存并让模型真正“看到”这张图
        return CallToolResult(
            content=[
                TextContent(type="text", text=text),
                ImageContent(
                    type="image",
                    data=base64.b64encode(image_bytes).decode("ascii"),
                    mimeType="image/png",
                ),
            ]
        )

    @filter.command("画")
    async def draw_cmd(self, event: AstrMessageEvent):
        """手动画一张：/画 一只圆滚滚的蓝白色小肥鱼，卡通风格"""
        if not self._is_owner(event):
            yield event.plain_result("只有主人能让我画画。")
            return
        text = str(getattr(event, "message_str", "") or "")
        prompt = text.split(" ", 1)[1].strip() if " " in text else ""
        result = await self._draw_and_send(event, prompt, "")
        yield event.plain_result(result)

    async def terminate(self):
        """插件卸载时调用。"""
        logger.info("[draw] 插件已停止")


def _loads(raw: str) -> dict:
    import json

    try:
        return json.loads(raw)
    except Exception:
        return {}
