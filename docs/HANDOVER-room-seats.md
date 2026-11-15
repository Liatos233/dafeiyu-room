# 交接文档：房间「可站立家具 / 穿模 / 动画稳定」系统

> 面向接手的新会话/新模型。本文只写**已在本次会话中落地并验证过**的内容；未验证的推测会明确标注。
> 代码根目录：`C:\Users\liato\dafeiyu-room\app`（本地事实源）
> 线上：`http://101.245.76.51:3100/room/`（nginx 3100 → bridge 3101）

---

## 0. 一句话背景

角色是 **2D 立绘（billboard 平面）**，房间是 **3D 场景**。之前「上沙发/上床/上躺椅」会出现穿模、瞬移、动画被掐断。本次把这些改成：**几何驱动的落点与高度 + 平台/攀爬点规则 + 过渡期不做视觉修正 + 动画最短保持**。

核心思想：**位置和高度不再写死常量，由场景几何（占用网格）决定；进出家具只能走固定攀爬点，抬升进入、先退出再下降。**

---

## 1. 系统分层

```
服务端 src/home-state.js
  ├─ HOME_LAYOUT.spots     每个可交互位置（含 support / mount / pose）
  ├─ SURFACES              支撑面高度（floor/sofa_seat/bed_top/…）
  ├─ NAV_KEEPOUT           纯障碍：墙、水面、柜体…（不再包含可站立家具）
  ├─ HOME_PLATFORMS        可站立平台（由 spots.support>0 自动派生）
  ├─ NAV_BLOCKS            = NAV_KEEPOUT + 平台地面投影（寻路时一起避让）
  ├─ seatZoneAt(pos)       点是否落在平台内部
  ├─ beginRoute(...)       路线；目标点若落在平台内 → 推到区域外 0.16m
  └─ seatLerp(seg,now)     上/下座两段式插值（先升降，后横移）

客户端 public/room
  ├─ world.js
  │   ├─ buildOccupancy()  一次性栅格化：0.1m 网格，记录每格最高顶面/最低底面/是否有实体
  │   ├─ surfaceYAt(x,z)   邻域取最高表面（微秒级）
  │   ├─ blockedAt(x,z,r,footY,height)  身体柱是否与实体相交
  │   ├─ bestSeatPoint(x,z,expectedY)   座面范围内找「同一表面 + 身体柱净空」的落点
  │   └─ nearestClearSpot(x,z)          附近找不撞东西的地面点
  ├─ app.js
  │   ├─ 落点解缓存（seatSolveKey/seatSolve，位置/座位变才重算）
  │   ├─ 过渡期（her.transitioning）+ 过渡后 300ms 内不套用落点解
  │   ├─ 座面高度收紧：表面 +1.2cm ～ +6cm
  │   ├─ 深度偏置：站立家具时朝相机前移 0.22m（缓解近侧栏杆遮挡观感）
  │   ├─ 动画最短保持 350ms（走路/睡眠类紧急片段不受限）
  │   └─ window.__drawState 调试快照（pos/elev/pose/spot/clip/walking）
  └─ nav-data.js          keepout(23 条障碍) 与 platforms(6 条) 已拆分
```

---

## 2. 关键数据

### 2.1 平台（`/api/home/state` → `layout.platforms`）

```
living.sofa    rect [5.28, 4.66, 7.32, 5.58]    top 0.48   climb [6.3, 4.45]
her_room.bed   rect [10.35, 0.18, 12.65, 2.33]  top 0.54   climb [10.2, 1.5]
balcony.chair  rect [2, 7.88, 3.34, 8.58]       top 0.40   climb [3, 7.7]
pool.lounger   rect [11.55, 10.2, 13.15, 10.96] top 0.445  climb [11.38, 10.58]
```

- `rect` 是**地面禁入区**（平台投影），`top` 是**可站立面高度**，`climb` 是**唯一允许进出的点**
- 攀爬点必须在 `rect` 外：床/沙滩躺椅/阳台躺椅之前落在区域内部，已外移

### 2.2 座位点（`HOME_LAYOUT.spots`，节选）

```
sofa   pos [6.3, 4.98]  support sofa_seat  mount [6.3, 4.45]
bed    pos [11.4,1.32]  support bed_top    mount [10.2, 1.5]
chair  pos [3.0, 8.4]   support balcony_chair mount [3.0, 7.7]
lounger pos [12.30,10.58] support pool_lounger mount [11.38, 10.58]
```

### 2.3 占用网格

- 单元 0.1m，范围 x −1.5…15.5、z −8.0…15.0
- 构建时机：世界建完后一次（`world.buildOccupancy()`，在 `mergeStaticDecor` 之后）
- 三张表：`cellTop`（最高顶面）、`cellLow`（最低底面）、`cellSolid`（是否有实体）
- 跳过：天空、水面、电视屏、透明材质、编辑用热点柱

---

## 3. 不变量（改动时必须守住）

1. **平台内地面高度不可进入**：`beginRoute` 对 `spot==='free'` 的目标点做 `seatZoneAt` 判定并外推；寻路用 `NAV_BLOCKS`。
2. **进出只能走 climb 点**：`spot.mount` 必须是 `rect` 外的点；上座 = 抬升→横移，下座 = 横移→下降（`seatLerp` 的 `RISE=0.55` 分段）。
3. **过渡期不做视觉修正**：`her.transitioning`（服务端 `mounting||dismounting`）为真时，客户端不套用 `bestSeatPoint`、不做深度偏置；结束后 300ms 内同样不做。
4. **高度只能落在座面附近**：`drawElev = clamp(max(serverElev, surface+0.012), surface+0.012, surface+0.06)`。
5. **床面抬升（BED_RAISE）只在休息态**：`asleep || kind in (sleep,nap)` 且非过渡。
6. **每帧不做重几何查询**：`bestSeatPoint` 只在缓存 key 变化时调用；不要恢复逐帧射线。

---

## 4. 测试工具（都在 `scripts/`）

| 脚本 | 用途 |
|---|---|
| `smoke-path.mjs` | **主验收**：驱动角色走 10 段路径（走动/上沙发/下沙发/上床/下床/上沙滩躺椅/下躺椅/上阳台躺椅/下躺椅/点沙发内部地面），每 250ms 采样 `window.__drawState`，用网格判定穿模，输出 `report.json` 与截图 |
| `seat-check.mjs` | 单页内依次让她去四个座位，到位后用自定义相机抓图 |
| `capture-mount.mjs` | 上座过程逐帧抓图（自定义相机，避免被主循环覆盖） |
| `render-view.mjs` | 指定相机渲染一帧到 PNG（验收模型改动） |
| `page-eval.mjs` | 在页面里执行任意 JS 并取回结果（调试主力） |
| `isolate-render.mjs` | 只渲染指定颜色材质（排查「对象在但看不见」） |
| `shot.mjs` | 加载页面→执行 JS→整页截图 |

**指标解读**：

- `byLabel[*].hits`：身体柱与实体相交的采样数（验收要求 0）
- `maxStillJump`：非行走状态下相邻采样位移（正常 ≈0.2m；>0.5m 说明有瞬移）
- `clipSwitches` / `quickCuts`：片段切换总数 / 900ms 内连续切换次数（掐断指标）

**最近一次结果**（commit `283715e`）：

```
435 帧采样 / 10 段路径 / 穿模 0 次
maxStillJump 0.22m
clipSwitches 22，quickCuts 2（约 110 秒）
查询成本：surfaceYAt 0.15µs、blockedAt 0.40µs
```

> 注意：无头 Chrome 是 swiftshader 软件渲染，帧时间（~900ms/帧）**不代表实机**。性能要看 JS 侧查询成本与是否有逐帧重查询。

---

## 5. 部署与排障

```powershell
# 部署（走 scp，服务器连不上 GitHub）
powershell -ExecutionPolicy Bypass -File deploy\cloud\deploy.ps1
```

- 健康检查失败会报「服务器端部署失败」
- **服务启动崩溃排查**：`cd /opt/dafeiyu-room && node src/bridge.js`（直接跑可看到堆栈）
- 服务日志：`journalctl -u dafeiyu-room -n 40`、`/opt/dafeiyu-room/state/bridge.log`
- 静态资源头：`curl -s -D - -o /dev/null http://101.245.76.51:3100/room/app.js` → `cache-control: no-cache`（刷新即最新，**不是缓存问题**）
- 本次踩过：`NAV_BLOCKS` 在 `NAV_KEEPOUT` 初始化过程中被提前引用 → 服务启动即崩，修复为补平台 rect 的循环用 `NAV_KEEPOUT`

---

## 6. 已知问题 / 未完成

1. **立绘平面 vs 3D 家具的遮挡**：她站/坐在家具上时，家具近侧栏杆在相机前面会正常遮挡小腿，观感像「插进去」。已用 0.22m 朝相机偏置缓解，换个视角仍可能露馅。**彻底解决需要坐姿素材**（素材库里唯一坐姿帧 `沙发打瞌睡` 自带一把扶手椅，不可用）。
2. **窄座椅**：沙滩躺椅座垫约 1.0m、阳台躺椅约 0.9m，而立绘视觉宽度约 0.9m；站上去必然有一部分悬在座面外。可选方案：改成「站在椅子旁的地面」或补坐姿素材。
3. **平台在调试层还没有独立配色**：`nav-data.js` 已拆出 `platforms`，但 `nav3D` 绘制仍只画 keepout（红框）。若需要，在 `buildNav3D()` 里加一组青色矩形。
4. **动画掐断只做到「缓解」**：350ms 最短保持 + 坐姿兜底限定了条件；`quickCuts` 仍有 2 次/110s。若要更稳，可把「片段决策」抽成状态机（进入/保持/退出带最小驻留）。
5. **服务端与客户端平台数据是两份**：`src/home-state.js` 的 `HOME_PLATFORM_LIST` 与 `public/room/nav-data.js` 的 `platforms` 需要同步维护（目前手工保持一致）。

---

## 7. 其他已在本会话改动、可能相关的系统

| 系统 | 关键点 |
|---|---|
| 天气同步 & 菜园 | 客户端每 15s POST `/api/home/weather`；`src/weather-store.js`；菜园按天气补水/暂停生长/雷雨损坏 |
| 主动消息格式 | `proactive_chat` 插件：`split_text` 改为统一按「句末标点或换行」切句；历史注入前压平换行（模型会照抄历史排版） |
| 开发编辑器 | `?edit=1` 打开；右键选中、方向键移动、Q/E 旋转、Shift+W/S 升降、网格地板、补丁导出；`public/room/dev-editor.js` |
| 场景合批 | `mergeStaticDecor` 前必须 `world.root.updateMatrixWorld(true)`，否则带 Group 偏移的模型会被烘焙到错误位置（绿植/伞柱消失的往事） |

---

## 8. 交接建议的下一步（按优先级）

1. **实机验收**：跑 `scripts/smoke-path.mjs`，并让用户实机确认「沙发↔床切换」「动画是否还掐断」。
2. 若仍有瞬移：优先检查 `drawState` 中 `elev` 的非行走突变，以及 `her.transitioning` 是否及时到达客户端。
3. 若仍有穿模观感：先区分是**几何相交**（网格 hits）还是**遮挡**（billboard 被栏杆挡住）——两者修法完全不同。
4. 资源允许时补一个坐姿循环 webm，替换 `clipFor` 里的 `sit → dance` 兜底。
