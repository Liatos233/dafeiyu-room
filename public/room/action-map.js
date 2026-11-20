// kind → (片段, 气泡) 的唯一事实源。
//
// 为什么要有这张表：她「在做什么」只有一份状态（src/home-state.js 的 kind/activity/pose/elev），
// 但这句话要被翻译成两套互不相干的表现——
//   · 动画：public/room/app.js 的 clipFor(her)
//   · 气泡：src/home-state.js 的 speechFor(kind, activity)
// 以前这两套各写各的：clipFor 覆盖 25+ 种 kind，speechFor 只有 11 条 includes 规则 + 兜底
// 「本鱼在这儿呢」，于是书桌前写代码、躺着打盹、被摸头全都在说「本鱼在这儿呢」。
// 现在两边都先查这张表，查不到才回落到老的关键词规则。
//
// 约定：
//   clip   —— 片段名，必须是 public/room/actor.js 的 CLIPS 注册表里存在的 key；
//   bubble —— 第一人称台词，用于气泡；activity 是第三人称描述，两者不能混用；
//   seated —— 这个 kind 在坐具上（elev > 0.2）时改用的片段。素材里坐姿帧很少，
//             只填确实有对应素材的，没填的就沿用通用坐姿兜底。
// clip/bubble 都可以写成函数 (her, ctx) => string，用于「同一 kind 按文案细分」。

export const ACTION_MAP = Object.freeze({
  // ── 基本状态 ──────────────────────────────────────────────
  idle: { bubble: '本鱼发会儿呆～', seated: '轻快摇摆舞' },
  free: { bubble: '本鱼在这儿待着～', seated: '轻快摇摆舞' },
  sit: { bubble: '本鱼坐会儿～', seated: '轻快摇摆舞' },
  walk: { clip: 'walk', bubble: '本鱼去那边看看' },

  // ── 吃喝 ────────────────────────────────────────────────
  eat: {
    // 小鱼干是零食（大口吃零食），正经饭是吃饭·碗饭
    clip: (her) => (her?.activity || '').includes('小鱼干') ? 'eat_snack' : '吃午餐',
    bubble: '本鱼开吃啦！',
    seated: '吃午餐'
  },
  drink: { clip: '举杯敬酒', bubble: '本鱼喝口水，真解渴～' },

  // ── 起居 ────────────────────────────────────────────────
  toilet: { clip: 'mutter', bubble: '本鱼去个卫生间…' },
  bath: {
    // 素材里没有「淋浴」片段：冲澡用换装浴袍（湿着头发换衣服最近似），
    // 刷牙洗脸用洗脸。以前一律播「晨间刷牙」，所以冲澡时在演刷牙。
    clip: (her) => /洗澡|冲澡|淋浴|热水澡/.test(her?.activity || '') ? '换装浴袍' : '洗脸',
    bubble: '本鱼洗香香～'
  },
  // 打盹：坐具上也用同一个 nap（原地小憩沉眠）。
  // 以前的 seated 是「沙发打瞌睡」，那段素材画面里自带一把扶手椅，
  // 叠在真实沙发上就是两把椅子（app/docs/HANDOVER-clipping.md 阶段九记过）。
  nap: { clip: 'nap', bubble: '本鱼打个盹…', seated: 'nap' },
  sleep: { clip: 'sleep_loop', bubble: '本鱼睡一会儿…' },
  wake: { clip: 'stretch', bubble: '唔…本鱼醒啦' },
  laundry: { clip: '叠衣服', bubble: '本鱼把衣服叠整齐～' },
  sick: { clip: 'sick', bubble: '本鱼有点不舒服…' },
  help: { clip: 'sick', bubble: '有人在吗…本鱼难受' },
  swim: { clip: '游泳', bubble: '本鱼游两圈～' },

  // ── 玩 / 屏幕 ────────────────────────────────────────────
  tv: { clip: '打主机游戏', bubble: '本鱼在打游戏呢！', seated: '打主机游戏' },
  phone: { clip: '熬夜刷手机', bubble: '本鱼在刷手机～', seated: '玩手机' },
  play: { clip: 'dance', bubble: '本鱼玩会儿～', seated: '轻快摇摆舞' },

  // ── 工作 ────────────────────────────────────────────────
  desk: { clip: '写代码', bubble: '本鱼在写东西，别吵～', seated: '写代码' },
  balcony: {
    clip: (her, ctx) => (ctx?.night ? 'mooncake' : 'fan'),
    // 躺椅也是坐具：坐上去之后同样要有个坐着的样子，不能突然站起来。
    seated: (her, ctx) => (ctx?.night ? 'mooncake' : 'fan'),
    bubble: '吹吹风，好舒服～'
  },
  freestyle: { clip: (her) => her?.clip || 'idle_look', bubble: null },   // 气泡按 CATALOG 的 group 走 FREESTYLE_BUBBLE

  // ── 反应 ────────────────────────────────────────────────
  react_happy: { clip: 'react_happy', bubble: '嘿嘿…再摸一下' },
  react_shy: { clip: 'react_shy', bubble: '……哼，只准摸一下' },
  react_scare: { clip: 'react_scare', bubble: '呀！吓本鱼一跳' },
  idle_look: { clip: 'idle_look', bubble: '本鱼看看那边～' },

  // ── 菜园 ────────────────────────────────────────────────
  garden_till: { clip: 'desk_tap', bubble: '本鱼在松土～' },
  garden_plant: { clip: 'desk_tap', bubble: '本鱼在播种～' },
  garden_harvest: { clip: 'desk_tap', bubble: '本鱼在收菜～' },
  garden_water: { clip: 'idle_look', bubble: '本鱼在浇水～' },
  garden_fertilize: { clip: 'idle_look', bubble: '本鱼在施肥～' },
  garden_sell: { clip: 'idle_look', bubble: '本鱼在卖菜～' },
  garden_buySeed: { clip: 'idle_look', bubble: '本鱼在挑种子～' },
  garden_buyCompost: { clip: 'idle_look', bubble: '本鱼在搬堆肥～' },
  garden_visit: { clip: 'idle_look', bubble: '本鱼在逛菜园～' }
});

// 坐具上的通用兜底：素材里没有通用坐姿帧，用与上座脚本一致的摇摆舞。
export const SEATED_FALLBACK = '轻快摇摆舞';

// freestyle 的气泡按 action-catalog 的 group 给，不再靠 activity 里的字面词。
export const FREESTYLE_BUBBLE = Object.freeze({
  玩耍: '本鱼玩会儿～',
  起居: '本鱼收拾一下～',
  吃喝: '本鱼弄点吃的～',
  才艺: '本鱼露一手～',
  工作: '本鱼干点活～',
  节日: '本鱼也过个节～',
  运动: '本鱼活动活动～',
  情绪: '本鱼有点小情绪…',
  其它: '本鱼自个儿待会儿～'
});

export function actionFor(kind) {
  return ACTION_MAP[String(kind || '')] || null;
}

/** clip：给出片段名，查不到就 null（调用方自己决定兜底）。 */
export function actionClip(kind, her, ctx) {
  const def = actionFor(kind);
  if (!def || !def.clip) return null;
  return typeof def.clip === 'function' ? def.clip(her, ctx) : def.clip;
}

/** 坐具上（elev > 0.2）改用的片段；返回 null 表示这张表没给，走通用兜底。 */
export function actionSeatedClip(kind, her, ctx) {
  const def = actionFor(kind);
  if (!def || !def.seated) return null;
  return typeof def.seated === 'function' ? def.seated(her, ctx) : def.seated;
}

/** bubble：第一人称台词，查不到就 null（调用方回落关键词规则）。 */
export function actionBubble(kind, activity) {
  const def = actionFor(kind);
  if (!def) return null;
  if (typeof def.bubble === 'function') return def.bubble(activity);
  return def.bubble || null;
}
