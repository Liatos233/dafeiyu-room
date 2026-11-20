// 需求指标条的唯一事实源：条怎么算、刻度画在哪。
//
// 两条约定，改之前先读：
// 1) **统一「满 = 好」**。后端 needs 里 hunger/thirst/hygiene/bladder/pain 都是越高越糟，
//    这里逐个取反，条本身永远「越满越健康」，不用再记哪根要空、哪根要满。
// 2) 刻度标的是**她自己的行为阈值**，不是拍脑袋的数字。每个数字都要能在
//    src/home-state.js 的 decideTarget 里找到对应的那一行 if，否则这根条就是在说谎。
//    test-home.mjs 会核对这张表和 home-state 的阈值没有漂移。

/**
 * 每根条的取值口径（0~1，1 = 满 = 好）。
 * 后端 needs 现在全部统一「1 = 糟」（fatigue/hunger/thirst/hygiene/bladder/pain），
 * 所以这里**每一根都要取反**，没有例外——以前 energy 是唯一一个反方向的，容易记错。
 * @param {object} body homeView().body
 * @param {object} [state] homeView()（心情是只读快照，只有这里用到）
 * @returns {{energy:number,hunger:number,thirst:number,hygiene:number,bladder:number,mood:number}}
 */
export function barPercents(body, state) {
  const b = body || {};
  const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));
  const mood = Number(state?.emotion?.mood);
  return {
    energy: 1 - clamp01(b.fatigue),     // 体力 = 1 - 疲劳
    hunger: 1 - clamp01(b.hunger),      // 饱腹 = 1 - 饿
    thirst: 1 - clamp01(b.thirst),      // 水分 = 1 - 渴
    hygiene: 1 - clamp01(b.hygiene),    // 清爽 = 1 - 邋遢
    bladder: 1 - clamp01(b.bladder),    // 轻松 = 1 - 憋
    mood: Number.isFinite(mood) ? Math.max(0, Math.min(100, mood)) : 70
  };
}

/**
 * 她自己的行动阈值（**原始 needs 口径**，现在全部「越高越糟」）。
 * act    = 到了这个点她会自己处理（decideTarget 的普通分支）
 * urgent = 到了这个点算紧急（插队；也是 caretaker 不能占用她时间的下限）
 *
 * 注意这里**没有 pain**：疼痛没有自然增长源（只有「生病」命令会推上去），
 * 所以它不做成指标条（长期满格没有信息量），改成头部一个「生病」标签。
 */
export const NEED_THRESHOLDS = Object.freeze({
  energy: Object.freeze({ act: 0.72, urgent: 0.95 }),
  hunger: Object.freeze({ act: 0.66, urgent: 0.88 }),
  thirst: Object.freeze({ act: 0.62, urgent: 0.86 }),
  hygiene: Object.freeze({ act: 0.78, urgent: 0.92 }),
  bladder: Object.freeze({ act: 0.7, urgent: 0.93 })
});

/**
 * 条的展示配置：顺序、中文名、对应 homeView().body 的字段名。
 * 五根根条都有真实来源（自己会涨、动作会降），没有一根是摆设。
 */
export const NEED_BARS = Object.freeze([
  { key: 'energy', label: '体力', field: 'fatigue', direction: 'low-good' },
  { key: 'hunger', label: '饱腹', field: 'hunger', direction: 'low-good' },
  { key: 'thirst', label: '水分', field: 'thirst', direction: 'low-good' },
  { key: 'hygiene', label: '清爽', field: 'hygiene', direction: 'low-good' },
  { key: 'bladder', label: '轻松', field: 'bladder', direction: 'low-good' }
]);

/**
 * 把原始 needs 阈值换算成「条上的百分比位置」。
 * 取反的条要把位置镜像过来，否则刻度会画反（这条 bug 之前踩过：条是 1-x，刻度却是 x）。
 * @param {string} key NEED_BARS[].key
 * @returns {{act:number, urgent:number}} 百分比（0~100）
 */
export function tickPercents(key) {
  const t = NEED_THRESHOLDS[key];
  if (!t) return null;
  const bar = NEED_BARS.find((b) => b.key === key);
  const mirror = bar?.direction === 'low-good';
  const toPct = (v) => Math.max(0, Math.min(100, Math.round((mirror ? 1 - v : v) * 100)));
  return { act: toPct(t.act), urgent: toPct(t.urgent) };
}

/**
 * 哪些按钮该微光：需求已经越过她自己会处理的阈值，说明这只按钮现在真的有用。
 * 只做提示，不代替点击（点了还是走原来的 act）。
 * @param {object} body homeView().body
 * @param {object} [state] homeView()
 * @returns {Set<string>} data-act 集合
 */
export function glowActions(body, state) {
  const b = body || {};
  const out = new Set();
  const n = (k) => Number(b[k]) || 0;
  if (n('hunger') >= NEED_THRESHOLDS.hunger.act) out.add('feed');
  if (n('thirst') >= NEED_THRESHOLDS.thirst.act) out.add('water');
  if (n('hygiene') >= NEED_THRESHOLDS.hygiene.act) {
    // 洗脸刷牙只到「干净一点」，脏透了要点洗澡，所以两只都亮：
    // 轻清洁永远够用，但邋遢到极限时洗澡才是那个正确答案。
    out.add('wash');
    out.add('shower');
  }
  if (n('bladder') >= NEED_THRESHOLDS.bladder.act) out.add('toilet');
  if (n('fatigue') >= NEED_THRESHOLDS.energy.act) out.add('sleep');
  const mood = Number(state?.emotion?.mood);
  if (Number.isFinite(mood) && mood < 50) out.add('pet');
  return out;
}
