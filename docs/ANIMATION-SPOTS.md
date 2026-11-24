# 动画场所标签与调度方案（已确认，待实施）

> 状态：**方案已确认，代码未改**（2026-11-25）
> 目标：杜绝「在卫生间吃饭」这类动画位置错配。

## 一、问题根因

### 1. `CATALOG.spots` 数据质量差

`public/room/action-catalog.js` 的 269 条里，大量 `spots` 是按 `group` 批量套模板生成的：

- 起居组 → `['bed', 'bathroom', 'anywhere']`（于是洗碗、叠衣服、擦窗户都标了卫生间和床）
- 玩耍组 → `['living', 'sofa', 'pool']`
- 吃喝组 → `['kitchen']`（基本正确）

从未逐条按素材语义核对。

### 2. `pickFreestyle` 的 50% 就地逻辑

`src/home-state.js`：

```js
const travel = spots.length > 0 && Math.random() < 0.5;
```

抽中「吃午餐」后只有 50% 概率走到厨房，**另外 50% 就在当前位置原地吃**——人在卫生间就在卫生间吃。**这是"位置奇怪"的直接原因，光修标签拦不住。**

### 3. `FREESTYLE_SPOTS` 缺 `garden` key

```js
const FREESTYLE_SPOTS = { desk, sofa, kitchen, bed, bathroom, living, balcony, pool };
// 缺 garden → 所有标 garden 的动画在 filter 时被丢弃，永远走不到位
```

## 二、已确认的设计

### 复用 `spots` 字段，语义定为「允许在哪做」

| 值 | 含义 | 例 |
|---|---|---|
| `['kitchen']` | 只能厨房 | 吃午餐、煮泡面 |
| `['bed','sofa']` | 二者之一 | 打盹、看恐怖片 |
| `['living','sofa']` | 二者之一 | 玩魔方、打游戏 |
| `['anywhere']` | 除禁止场所外任意 | 才艺、运动、情绪 |

- **禁止场所**（`anywhere` 不覆盖）：`bathroom`、`laundry`
- 不新增 `where` 字段（复用 `spots`，避免双字段维护）

### 抽卡池：兼容为主 + 小概率换场

```
here 池 = 当前场所能做的动作        → 85%
away 池 = 不兼容但合法的动作（走位） → 15%
```

### 离开机制

连续 2 次空闲调剂都在 `bathroom`/`laundry` → 强制只从 `away` 池抽，并走位离开。

### 职责分层

| 逻辑 | 职责 | 是否移动 |
|---|---|---|
| `decideTarget` | 需求驱动（饿/困/憋） | ✅ 走过去 |
| `pickFreestyle` | 空闲调剂 | 85% 就地，15% 换场 |

## 三、实施清单

### 1. 数据：`public/room/action-catalog.js`

141 条 `spots` 按下表调整（完整清单见「附录 A」的核对表文件）。

分类统计（269 条）：

- **at-spot** 145 条：吃喝→`kitchen`、睡眠→`bed/sofa`、洗漱→`bathroom`、工作→`desk`、家务→`living/kitchen`、室内玩耍→`living/sofa`、户外玩耍→`garden/pool/balcony`
- **anywhere** 63 条：才艺/运动/节日（除卫生间、家政间外）
- **in-place** 61 条：情绪/待机/特效（就地）

### 2. 调度：`src/home-state.js`

```js
// ① 补 garden spot
const FREESTYLE_SPOTS = {
  desk: { room: 'her_room', spot: 'desk' },
  sofa: { room: 'living', spot: 'sofa' },
  kitchen: { room: 'kitchen', spot: 'fridge' },
  bed: { room: 'her_room', spot: 'bedside' },
  bathroom: { room: 'bathroom', spot: 'sink' },
  living: { room: 'living', spot: 'rug' },
  balcony: { room: 'balcony', spot: 'chair' },
  pool: { room: 'pool', spot: 'lounger' },
  garden: { room: 'garden', spot: 'gate' },   // ← 新增
};

// ② 双池抽取
const BANNED = new Set(['bathroom', 'laundry']);
const roomOfSpot = (s) => FREESTYLE_SPOTS[s]?.room;

function fitsHere(item, state) {
  const spots = item.spots || [];
  if (spots.includes('anywhere')) return !BANNED.has(state.room);
  return spots.some((s) => roomOfSpot(s) === state.room);
}

const here = scored.filter(([, it]) => fitsHere(it, state));
const away = scored.filter(([, it]) =>
  !fitsHere(it, state) && (it.spots || []).some((s) => s !== 'anywhere' && FREESTYLE_SPOTS[s]));

// 离开机制：在禁止场所连续 2 次 → 强制换场
const escaping = BANNED.has(state.room) && (state.freestyleInBanned || 0) >= 2;
const useHere = !escaping && here.length > 0 && (!away.length || Math.random() < 0.85);
const pool = useHere ? here : away;
const forceTravel = !useHere;
```

### 3. 状态字段

```js
// emptyHomeState 新增
freestyleInBanned: 0,

// normalize 时保留
out.freestyleInBanned = Number(raw.freestyleInBanned) || 0;
```

## 四、不在本次范围

- `clipFor` 的状态机硬约束（走路/睡眠/过渡/坐姿优先级）**不动**
- `decideTarget` 的需求驱动逻辑**不动**
- `ACTION_MAP`（kind→片段）**不动**——它管的是"已决定做什么"，不管"在哪做"

## 五、已知限制

1. `anywhere` 的禁止场所检查在**调度层**，若有别处（手动点动作）直接触发 `freestyle`，仍可能出现在卫生间。要彻底禁止需在 `clipFor` 层也加检查。
2. `pool` 只有 `lounger`/`swim` 两个 spot，`balcony` 只有 `chair`——跑位落点有限，观感需实测。
3. 本方案会**降低跑动频率**（85% 就地），部署后建议观察行为节奏。

## 附录 A：核对清单文件

生成脚本逻辑见提交历史，产出物：

- `动画场所核对清单-最终版.md`：269 条逐条列「现 spots → 建议 spots → 分类 → 理由」
- `clip-spots-map.json`：机器可读映射（片段 → 建议 spots），改代码时可直接消费

清单统计：建议修改 **141** 条、保持 128 条、未定 0 条。