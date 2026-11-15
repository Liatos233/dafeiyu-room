# 交接文档（深潜）：可站立家具 / 穿模 / 动画

> 本篇是 [`HANDOVER.md`](./HANDOVER.md) 第 4.3 节「状态机要点」与第 9 节「行为约定」的展开，
> 面向要改**房间走动、坐具上下、穿模检测、角色动画**的会话。
> 只写本次会话**实际核实过**的内容；不确定的标注「未核实」。

---

## 1. 坐标与尺寸约定

- **1 世界单位 = 1 米**。房间按真实尺寸摆，走道净宽都 ≥ 0.9m。
- 户型 `size = { w: 13.2, d: 9.0, h: 2.8, wall: 0.16 }`；菜园/屋外小径在负 z 侧（`garden` / `yard`）。
- 坐标是 `[x, z]`（俯视平面），`y` 是高度。`facing` 是朝向角（度，0=北，90=东）。
- 房间 `bounds` 形如 `[x0, z0, x1, z1]`；重叠区域取**面积最小**的房间（玄关优先于餐厅）。

---

## 2. 支撑面（`SURFACES`，唯一 elev 来源）

`src/home-state.js` 里角色离地高度**只由「点位用哪个面」+「姿态」决定**，不人肉配 elev：

| 键 | 高度 | 用途 |
|---|---|---|
| `floor` | 0 | 默认地面 |
| `rug` | 0.02 | 地毯 |
| `sofa_seat` | 0.48 | 沙发坐垫 |
| `bed_top` | 0.54 | 床垫顶面 |
| `balcony_chair` | 0.40 | 阳台躺椅 |
| `pool_lounger` | 0.445 | 沙滩躺椅 |
| `dining_seat` / `desk_seat` / `toilet_seat` | 0 | 站/坐用，不抬升 |

**不变量**：新增坐具必须同时给 `SURFACES` 一个键、并在 spot 上写 `support`，否则高度不对。

---

## 3. 点位（`HOME_LAYOUT.spots`）

每个可交互位置（spot）字段：

- `pos`：脚底落点 `[x, z]`
- `pose`：`stand` / `sit` / `lie`（决定立绘高度与动作）
- `facing`：朝向（度）
- `label`：中文名（用于事件文案）
- `access`：寻路用的最近节点 id（见 §5）
- `support`：支撑面键（决定 `elev`；缺省 = `floor`）
- `mount`：**固定上/下座点** `[x, z]`——只有 `support` 高度 > 0.05 的坐具需要（沙发/床/躺椅）。角色先走到 `mount`，再过渡到 `pos`。

**不变量**：`mount` 是「座点（地面）→ 座面（抬升）」两段式的第一段终点；没有 `mount` 的坐具走旧近似（沿最后一段退 0.5m）。

---

## 4. 障碍 / 平台 / 寻路阻塞（派生顺序是关键）

```
NAV_KEEPOUT ──┬──> HOME_PLATFORMS（由 spots 里 support>0.05 的点位生成，rect 从 KEEPOUT 回填）
              └──> NAV_BLOCKS = NAV_KEEPOUT + 平台地面投影（寻路用）
```

- `NAV_KEEPOUT`（`home-state.js:778`）：手工维护的纯障碍矩形 + 带 `top` 的家具占地。
  - 带 `top`（如沙发 `top:0.48`、床 `top:0.54`）= 可站立家具内部。
  - 不带 `top`（电视柜/茶几/书架/马桶等）= 纯障碍，地面不可走。
- `HOME_PLATFORMS`（`home-state.js:1188`）：从 `spots` 里 `support` 高度 > 0.05 的点位自动派生，
  `rect` **只能用 `NAV_KEEPOUT` 回填，不能用 `NAV_BLOCKS`**——因为这段代码运行时 `NAV_BLOCKS` 还没初始化。
  这正是 `c1b45ac` 修的启动崩溃：`NAV_BLOCKS` 在初始化前被引用。
- `NAV_BLOCKS`（`home-state.js:1213`）：`NAV_KEEPOUT` + 平台投影，寻路时**地面高度都不可穿过**。
- `seatZoneAt(pos)`：判断自由落点是否落在带 `top` 的家具内部，落进去就把目标推到区域外（避免「走进去」）。

**不变量**：改家具占地/坐具，要同时改 `HOME_LAYOUT.spots` 与 `NAV_KEEPOUT` 两处（服务端），
客户端另有一份见 §6 技术债 #3。两处不一致 = 穿模或走不进去。

---

## 5. 状态机：路线与上下座（`beginRoute` / `arrive`）

`src/home-state.js`：

- `beginRoute(state, target, now)`（`home-state.js:1227`）：
  1. **下座优先**：若当前在坐具上（`curY>0.05` 且有 `mount`）且没在 dismounting，先 `dismounting`：
     从 `cur.pos → cur.mount`，`dur:520`，`up:false`，姿态回到 `stand`，然后下一轮才真正寻路。
  2. **上座**：目标坐具的路线终点是 `mount` 点（`routeTarget.pos = mount`），不是座面。
  3. **自由落点钳制**：`spot==='free'` 且落在 `seatZoneAt` 内 → 推到矩形外 0.16m。
  4. 同站位不造路线，直接摆好进 `dwell`。
- `arrive(state, now)`（`home-state.js:1334`）：
  1. **睡眠**只在「已经到床」这一帧生效：先 `mounting`（`from mount → bed.pos`，`dur:700`，`sleepAfter:true`），
     过渡结束才 `asleep=true`；路上 `sleeping=false`，客户端不播睡眠动画。
  2. **坐具**：`mounting`（`from mount → pos`，`dur:620`，`up:true`），不瞬移。
  3. 普通点：`setActivity` → `dwell`。
- **dwell 结算**：到了不算做，`dwell` 到期才结算效果、写事件（`home-state.js:1895`）。
- `currentPosition(state, now)`：`mounting/dismounting` 时用 `seatLerp` 插值，否则按路线取点。

**不变量**：任何坐具上下必须走 `mounting` / `dismounting` 过渡，禁止直接把 `elev` 从 0 跳到座面高度。

---

## 6. 客户端：占用网格与穿模检测（`world.js`）

`public/room/world.js`：

- `mergeStaticDecor(world)`（`world.js:744`）：静态装饰按材质合批。
  **合批前必须先 `world.root.updateMatrixWorld(true)`**，否则子网格按旧矩阵烘焙、位置全错（看起来「消失」）。
  跳过动态对象（sky/poolWater/poolBody/tvScreen）、透明/贴图/灯具/墙体。
- `buildOccupancy()`（`world.js:911`）：把整间屋子一次性栅格化成占用网格（`cell:0.1`），
  之后高度/占位查询 O(1)。**上一版逐帧打射线是卡顿根源**，不要回退。
- `surfaceYAt(x,z)`（`world.js:945`）：可站立表面高度（邻域取最高，避免缝隙/圆角）。
- `blockedAt(x, z, radius, footY, height)`（`world.js:959`）：身体柱（脚底 `footY`、高 `height`）里是否有实体挡路。
  判据：`cellTop > footY+0.08 && cellLow < footY+height`。
- `bestSeatPoint(x, z, expectedY, radius)`（`world.js:980`）：座面内找最佳站立点（同高度 + 净空）。
- `nearestClearSpot(x, z, radius)`（`world.js:1000`）：附近找一个不撞东西的地面位置。

冒烟测试（`scripts/smoke-path.mjs`）正是用 `window.__drawState`（`pos/elev/pose/spot/clip/walking`）
+ `world.blockedAt(...)` 逐帧判穿模。

---

## 7. 动画（`actor.js` + `app.js` `clipFor`）

- `actor.js`：2D 立绘播放器，**三层交叉淡化** + 脚底锚点；`fade` 过渡（`actor.js:588`）。
- `clipFor(her)`（`app.js:1967`）片段选择优先级：
  1. `walking` → `run_hurry` / `run_happy`（行走最高）
  2. `petActionOverride`（点播动画）
  3. `asleep` → 兜底「不在床绝不播睡眠」（`her.spot !== 'bed'` 时回 idle/run）
  4. `elev > 0.2` 且 kind ∈ {idle, free, sit} → 坐姿兜底（`pose='lie'`→nap/sleep，`pose='sit'`→dance；素材无通用坐姿帧）
  5. 背视角站立 → `back_idle`
  6. 按 `kind` 查表（eat/drink/swim/toilet/bath/balcony/tv/desk/…）
- **片段最短保持 350ms**（`app.js:2334`）：切换新片段前，若 `now - _lastAt < 350` 且新片段不在
  `URGENT = {run_happy, run_hurry, walk, sleep_in, sleep_loop, sleep_out}` 里，就**不切**，避免抖动。
- 坐具 play 阶段（`sofaPhase/chaisePhase === 'play'`）强制 `dance`；上/下座阶段强制 `mutter`。

**已知偏置**：2D 立绘被家具近侧栏杆遮挡时，已加 **0.22m 朝相机偏置**（遮挡 ≠ 相交）；根治需坐姿素材（技术债 #1/#2）。

---

## 8. 测试与验收

| 工具 | 用途 |
|---|---|
| `npm run test:home` | 大平层状态机（需求衰减、睡眠回精力、寻路、脏数据、提示词）|
| `npm run test:project` | 项目级契约：导航图一致性、客户端资源、动作清单、合批与性能探针 |
| `node scripts/smoke-path.mjs <目录>` | **主验收**：10 段路径（走/上沙发/上床/上下躺椅/点家具内部地面）逐帧判穿模 + 位置跳变 + 动画快速切换 |
| `node scripts/seat-check.mjs` | 同页内依次去四个座位抓图 |
| `node scripts/capture-mount.mjs` | 上座过程逐帧抓图 |

冒烟判定指标（`smoke-path.mjs` 汇总）：`byLabel.hits`（穿模帧）、`maxStillJump`（静止位置跳变）、
`clipSwitches` / `quickCuts`（动画切换，<900ms 算快速切换）。

> 无头 Chrome 冷启动约 12–35 秒，等待时间要留足（等待不够会误判「页面没加载」）。

---

## 9. 已知问题（对应 `HANDOVER.md` 技术债）

1. 2D 立绘被家具近侧栏杆遮挡（观感像穿模）→ 已加 0.22m 偏置；根治需坐姿素材。
2. 窄座椅（阳台/沙滩躺椅）宽度接近立绘宽度 → 站上去边缘悬空 → 改「站椅旁」或补坐姿素材。
3. **平台数据服务端（`home-state.js`）与客户端（`nav-data.js`）各一份**，需手工同步 → 建议抽共享数据文件。

---

## 10. 排障速查

| 现象 | 处理 |
|---|---|
| 服务启动即崩 | 查 `NAV_BLOCKS` 是否在初始化前被引用（`c1b45ac` 同类）；平台 rect 只能用 `NAV_KEEPOUT` 回填 |
| 角色「走进」沙发/床内部 | 查 `seatZoneAt` 与自由落点钳制是否命中；`NAV_KEEPOUT` 里该家具是否带正确 `top` |
| 上/下座瞬移 | 确认坐具 spot 有 `mount`；`mounting/dismounting` 过渡是否被绕过 |
| 合批后家具「消失」 | `mergeStaticDecor` 前是否 `updateMatrixWorld(true)` |
| 动画来回抖 | 查 `clipFor` 的最短保持 350ms 与 `URGENT` 集合 |
| 穿模误报/漏报 | 查 `blockedAt` 的 `footY`/`height` 参数；占用网格是否过期（`buildOccupancy` 未重跑） |
