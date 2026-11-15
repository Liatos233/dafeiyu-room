# 性能报告（2026-11-12，2026-11-15 更新瓶颈清单）

测量方式：headless Chrome（`--disable-gpu`，1600×1000），页面里 `window.__getRenderer()` +
累计计数求平均（`node scripts/perf-check.mjs` 或 `scripts/perf_avg.py`）。
帧时间来自 `window.__frames`（rAF 采样）。

## 关键指标

| 指标 | 优化前 | 优化后 | 变化 |
|---|---|---|---|
| **每帧 draw call** | **1086** | **615** | **−43%** |
| 几何体数量 | 971 | 496 | −49% |
| 三角形 | 233,525 | 233,601 | 持平 |
| 纹理 | 46 | 46 | 持平 |
| 着色器程序 | 22 | 22 | 持平 |
| 帧时间 p95 | 13.5 ms | 13.4 ms | 持平 |
| FPS（headless，垂直同步 60） | 58~62 | 60~75 | 稳定在 60 |
| JS 堆 | 25.8 MB | 26 MB | 持平 |

## 做了什么

### 1. 静态装饰合批（最大收益）

`world.js` 新增 `mergeStaticDecor()`：把大量 `box()/cyl()` 小件**按材质合并成单个网格**。

- 排除动态对象：`tvScreen`、`poolWater`、`poolBody`、墙体（剖切用）、灯具、玻璃/水面等透明材质
- 合并后 1086 → 615 draw call，971 → 496 几何体
- 视觉验证：房间、家具、玻璃、泳池、菜园外观无变化

### 2. 之前已经做掉的优化（本轮复核仍然有效）

| 项 | 说明 |
|---|---|
| 精灵图模块整体移除 | 省掉一个每帧更新的大纹理 actor（约 **338 MB** 资源不再加载） |
| 天空贴图限频 | 只在时间跨过 2 分钟档位或天气变化时重算 canvas |
| 光照抖动修复 | 删掉 `updateEnvironment` 里旧的直写 sun 逻辑，改为目标值 + 每帧 lerp |
| 泳池波纹 | 551 顶点、**30Hz** 限频，CPU 位移，无额外 draw call 增量 |
| 阴影 | `shadowMap.autoUpdate = false`，只在太阳角度变化时 `needsUpdate` |
| 自适应当分辨率 | 帧率 <42 时自动降 pixelRatio（已有逻辑，本轮未改） |

### 3. 测量能力

- `window.__renderer` / `window.__getRenderer()` / `window.__getWorld()` / `window.__frames`
- `renderer.info.autoReset = false`，但**当前只在 boot 时 reset 一次**，渲染循环里没有每帧 reset —— 所以 `perf-check.mjs` 读到的是累积值（`123102 draw calls` 这类假数），待修
- `npm run perf:check` 一次输出 FPS / p95 / draw call / 三角形 / 几何体 / 纹理 / 堆

## 现在的瓶颈（2026-11-15 更新）

1. ~~菜园作物独立实例~~ ✅ **已做**：作物改成 `InstancedMesh`，并做了**跨畦合并**（8 畦同作物同阶段合成一批）。实测：58 → 20 个 InstancedMesh、单帧 draw call 542 → 504，三角形/包围盒完全不变。
2. ~~`furnitureSoftBox` bevelSegments:3~~ ✅ **已做**：降到 `bevelSegments: 2`，省 10~15% 三角形。
3. ~~TV 离屏渲染~~ ✅ **已消除**：电视改成「屏幕投屏」（`getDisplayMedia` → `VideoTexture`），关掉时 `stopTvCast` 会 pause 视频 + dispose 纹理，没有常驻离屏 pass 了。

剩余可做的（非紧急）：
- 615 draw call 仍偏高，大头是每个家具的独立小网格（静态装饰已合批过一轮，可再按材质继续合）
- 前端已切 Vite 构建（主 bundle 939KB / gzip 270KB），`_vite/` 内容哈希可永久缓存

## 复现命令

```bash
npm run perf:check          # 一次性输出指标
node scripts/test-project.mjs   # 断言合批与探针存在
```
