# 动画播放与切换逻辑（当前实现）

> 面向接手的人。本文描述**房间里角色动画**从「服务端状态」到「实际播放哪段 webm」的完整链路，
> 以及每一层切换的判定条件。改动画前先读这里，避免又改出「频繁切换」或「站着播坐姿」。

---

## 1. 数据从哪来

服务端 `src/home-state.js` 每 500ms 生成快照，客户端轮询 `/api/home/state`：

| 字段 | 含义 | 谁在用 |
|---|---|---|
| `her.kind` | 当前活动类型（`walk`/`tv`/`desk`/`eat`/`nap`/`sleep`/`freestyle`/`idle`…） | 决定播哪段 |
| `her.activity` | 中文描述（"窝在沙发上看电视"） | 气泡、`eat` 细节 |
| `her.pose` | `stand` / `sit` / `lie` | 坐/躺姿势与高度 |
| `her.spot` | 所在点位（`sofa`/`bed`/`chair`/`free`…） | 座位判定、idle 变体 |
| `her.elev` | 离地高度（座面/床面） | 坐姿判定、显示高度 |
| `her.asleep` | 是否睡着 | 睡眠三段（入睡/循环/醒来） |
| `her.walking` | 是否在移动（客户端用位移再判一次） | 行走动画最高优先 |
| `her.clip` | 仅 `freestyle` 用：服务端抽好的片段名 | 自主动作具体播什么 |

客户端另有几个**本地状态**（不来自服务端）：`seatPhase` / `sofaPhase`（座位小流程）、
`petActionOverride`（宠物动作）、`opinionClip`（电视弹幕吐槽）、`sleepPhase`。

---

## 2. 播放层级（优先级从高到低）

`syncCharacter()`（`public/room/app.js`）按顺序判定，命中即返回：

| 优先级 | 判定 | 判据 | 结果片段 |
|---|---|---|---|
| 1 | 强制调试 | `?forceclip=` | 指定片段 |
| 2 | 钉住测试 | `?pintest=1` | `idle` |
| 3 | **在移动** | `motionWalking`（位移 > 0.0035/帧） | `run_happy` / `run_hurry`；并清空所有表演类覆盖 |
| 4 | 座位玩（server 流程） | `seatPhase === 'play'` | `dance`；`up/down` → `mutter` |
| 5 | 沙发玩（本地流程） | `sofaPhase === 'play'` | `dance`；`rise/enter/exit/lower` → `mutter` |
| 6 | 沙发玩冷却 | `sofaPlayUntil` 未到期且距沙发 ≤0.5m | `dance` |
| 7 | 预览 | `?preview=sit/lie` | `mutter` / `sleep_loop` |
| 8 | **睡眠** | `her.asleep` | 未到床 → `idle/run`；到床 → `sleep_in`（一次）→ `sleep_loop`；醒来 → `sleep_out`（一次）→ 回到 `clipFor` |
| 9 | 普通决策 | `clipFor(her)` | 见下表 |

> 曾经还有一层「躺椅玩（本地流程）」（`chaisePhase`），已经删掉：它自己算了一套坐标
> （离服务端 `chair.pos` 差 0.37 米），又用 `act('go')` 绕过了服务端 `mounting/dismounting`，
> 违反交接文档里「坐具上下必须走 mounting/dismounting」的不变量。躺椅现在只走
> 「点场景物件 → 来这里玩」→ 服务端 `command` 流程。

`clipFor()` 的决策表（第 10 层）：

| kind / 条件 | 片段 |
|---|---|
| `walking` | `run_happy`（侧面方向 `run_hurry`） |
| `asleep` 且不在床 | `idle`（防止在客厅睡） |
| `opinionUntil` 未过期 | 电视吐槽片段 |
| `garden_till/plant/harvest` | `desk_tap` |
| 其他 `garden_*` | `idle_look` |
| `elev > 0.2` 且 kind ∈ {idle, free, sit} | `lie` → `nap`/`sleep_loop`；`sit` → `dance` |
| 背视角 + 站姿 + idle/free | `back_idle` |
| `eat` | `吃午餐` / `eat_snack` |
| `drink` | `举杯敬酒` |
| `freestyle` | **`her.clip`**（服务端抽的片段） |
| `swim` / `toilet` / `bath` / `balcony` / `tv` / `desk` / `phone` / `nap` / `laundry` / `sick` / `help` / `react_*` / `wake` / `play` | 各自固定片段 |
| `idle` / 兜底 | 见下 |

**idle 兜底变体**（最容易变的地方）：

```
hour ≥22 或 <6  → yawn
mood < 40       → idle_look
mood ≥ 78 且 hash%4==0 → dance
否则 hash(spot + kind.length) 取模 → dance / idle_hum / idle_look / idle
```

---

## 3. 切换判定（防抖）

`syncCharacter()` 末尾统一切换，规则：

```
next = clipFor(her)
urgent = next ∈ {run_happy, run_hurry, walk, sleep_in, sleep_loop, sleep_out}
      || pose 变了（stand↔sit↔lie）
      || spot 变了

如果 actor.current !== next：
  - urgent：立刻切
  - 非 urgent：
      1) 当前片段至少驻留 1200ms，否则跳过这一帧
      2) 新片段必须连续 "想要" 350ms（want hysteresis），否则跳过
```

目的：避免「某一帧判定跳一下」就切走；同时保证走路/睡醒/坐下这些必须立刻响应。

**一次性片段**（`ONCE` 集合：`react_happy/react_shy/react_scare/stretch/curtsy`）：
播放一次后自动回到 `clipFor`；同一 `clip + activity + spot` 在 9 秒内不重复触发，防止刷屏。

---

## 4. 服务端调度（决定 kind 什么时候变）

`src/home-state.js` 的 tick：

1. **需求/日程**：按小时段轮换默认活动（`rotation`），25 分钟一档（`hashPick`）。
2. **自主动作（freestyle）**：
   - 间隔 `FREESTYLE_DEFAULTS.intervalMs` = **90–180 秒**（原先 20–45 秒，太频繁）
   - **只在严格 idle/free 时触发**；`tv/desk/eat/drink/nap/sleep/laundry/bath/phone/swim/garden_*` 等主活动期间**不插**
   - 单次驻留 `dwellMs = min(maxDwell 20s, 10s)`
   - 抽中的片段写进 `her.clip`，客户端 `clipFor` 的 `freestyle` 分支直接用它
3. **坐具/上床**：`arrive()` 之后走 `mounting`（抬升+平移），期间 `transitioning = true`，客户端锁定姿态片段。
4. **天气/事件**：下雨、雷雨、菜园等会改 `kind` 或触发一次性活动。

---

## 5. 已知坑（改之前看）

1. **idle 变体依赖 mood**：mood 每次 tick 都会微调，如果直接拿 mood 做阈值（78/40），会在阈值附近来回切。
   现在有 350ms + 1200ms 防抖挡着，但更稳的做法是给 mood 分桶（如每 20 点一档）。
2. **坐姿素材缺失**：`sit` 用 `dance`（站姿）兜底，所以坐在沙发上看起来是站着的；这是素材问题，不是逻辑问题。
3. **`freestyle` 的 clip 名字是中文**，和 `CLIPS` 的 key 一致；拼错会 fallback 到 `idle_look`。
4. **本地座位流程**（`sofaPlay` / `seatPlay`）会覆盖服务端 kind，直到流程结束；
   如果中途被走动打断，`syncCharacter` 顶部的 `motionWalking` 分支会强制清零这些 phase。
5. **切换日志**：`window.__clipLog`（最近 200 条 `{t, from, to}`）记录每次 `actor.setClip`；
   `window.__drawState` 带 `kind/activity/pose/spot/clip`，排查时先看这两个。

---

## 6. 调试方法

```js
// 看当前状态
window.__drawState

// 看最近切换
window.__clipLog.slice(-10)

// 强制某段动画（URL）：?forceclip=dance
// 直接把她放到沙发/床上调姿势：?preview=sit / ?preview=lie
// 钉住 idle 单独看素材：?pintest=1
```

排查「动画乱跳」的步骤：

1. 采样 `__clipLog` 60 秒，看切换间隔；间隔 <1.5s 说明是判定抖动，间隔 5–20s 说明是活动本身在换
2. 间隔大且 to 是中文名 → 是 `freestyle` / `seat` 流程，看服务端调度
3. 间隔小且 to 在固定几个名字间来回 → 看 `clipFor` 的 idle 兜底与 mood/hour 条件

---

## 7. 加新动画的步骤

1. 把 webm 放进 `public/room/assets/clips/`，在 `public/room/actor.js` 的 `CLIPS` 注册名字
2. 需要由服务端决定 → 在 `home-state.js` 对应活动里写 `kind`，并在 `clipFor` 加分支
3. 需要一次性播放 → 把名字加进 `app.js` 的 `ONCE` 集合
4. 需要坐/躺专用 → 在 `clipFor` 的 `elev > 0.2` 分支里按 `pose` 区分
5. 改完用 `?forceclip=<名字>` 先单独看素材，再看真实调度
