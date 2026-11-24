#!/usr/bin/env python3
"""端到端验证：换画工具能不能吃「本地文件路径」。

复刻模型当时传的参数：
    {'slot': 4, 'image_base64': '/root/data/temp/media_image_20261124195840133_c543.jpg'}
修复前 -> 不支持 的图片格式：未知
修复后 -> 应该真的换上。
"""
import asyncio
import base64
import importlib.util
import json
import shutil
import sys
import urllib.request

PLUGIN = "/root/data/plugins/astrbot_plugin_room_link/main.py"
TEST_IMG = "/root/data/temp/media_image_20261124195840133_c543.jpg"

spec = importlib.util.spec_from_file_location("rl_test", PLUGIN)
mod = importlib.util.module_from_spec(spec)
sys.modules["rl_test"] = mod
spec.loader.exec_module(mod)

cls = None
for name, obj in vars(mod).items():
    if isinstance(obj, type) and hasattr(obj, "tool_gallery_set") and name != "Star":
        cls = obj
        break
if cls is None:
    print("FAIL: plugin class not found")
    raise SystemExit(1)
print("plugin class:", cls.__name__)

fn = cls.tool_gallery_set
for attr in ("__wrapped__", "wrapped", "fn"):
    if hasattr(fn, attr):
        fn = getattr(fn, attr)
        print("  unwrapped via", attr)
        break


class FakeSelf:
    def _bridge_token(self):
        return ""

    def _bridge_base(self):
        return "http://127.0.0.1:3100"

    async def _bridge_post_json(self, path, payload, timeout=20.0):
        req = urllib.request.Request(
            self._bridge_base() + path,
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        try:
            return json.load(urllib.request.urlopen(req, timeout=timeout))
        except Exception as exc:
            print("  bridge request failed:", exc)
            return None


async def main():
    me = FakeSelf()

    print()
    print("=== TEST 1: real JPG path ===")
    r = await fn(me, None, slot=4, image_base64=TEST_IMG, caption="Q版蓝毛小鲸鱼女仆")
    print("result:", r)

    print()
    print("=== TEST 2: no-extension file (magic bytes) ===")
    tmp = "/tmp/noext_test"
    shutil.copyfile(TEST_IMG, tmp)
    r2 = await fn(me, None, slot=2, image_base64=tmp, caption="无扩展名测试")
    print("result:", r2)

    print()
    print("=== TEST 3: bare base64 without mime ===")
    raw = open(TEST_IMG, "rb").read()
    r3 = await fn(me, None, slot=1, image_base64=base64.b64encode(raw).decode(), caption="裸base64测试")
    print("result:", r3)

    print()
    print("=== TEST 4: non-existent path (should fail cleanly) ===")
    r4 = await fn(me, None, slot=3, image_base64="/root/data/temp/definitely_missing.jpg", caption="x")
    print("result:", r4)


asyncio.run(main())
