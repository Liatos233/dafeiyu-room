import { CATALOG, FREESTYLE_DEFAULTS } from '../public/room/action-catalog.js';

let fails = 0;
const check = (name, cond, detail = '') => {
  if (!cond) { fails++; console.log('FAIL', name, detail); }
  else console.log('ok  ', name);
};

// 1) 结构完整性
check('CATALOG 非空', CATALOG.length > 200, `实际 ${CATALOG.length}`);

const VALID = new Set(['kitchen', 'sofa', 'kitchen', 'bed', 'bathroom', 'living', 'balcony', 'pool', 'garden', 'desk', 'anywhere']);
const badSpots = CATALOG.filter((it) => !Array.isArray(it.spots) || it.spots.length === 0
  || it.spots.some((s) => !VALID.has(s)));
check('所有 spots 合法', badSpots.length === 0, badSpots.map((x) => `${x.clip}:${x.spots}`).join(', '));

// 2) 吃喝类必须在 kitchen（不能出现 bathroom）
const EAT = /吃|餐|饭|零食|冰淇淋|月饼|火锅|泡面|拉面|咖啡|奶茶|饺子|汤圆|粽|蟹|橘|蛋糕|饼干|寿司|糖/;
const eatBad = CATALOG.filter((it) => EAT.test(it.clip)
  && !it.spots.includes('kitchen') && !it.spots.includes('anywhere'));
check('吃喝类都在厨房', eatBad.length === 0, eatBad.map((x) => `${x.clip}:${x.spots}`).join(', '));

// 3) 卫生间类不含吃喝（核心目标）
const BATH = /刷牙|洗脸|浴|照镜|面膜|口红|梳理/;
const bathBad = CATALOG.filter((it) => BATH.test(it.clip) && it.spots.includes('kitchen'));
check('洗漱类不在厨房', bathBad.length === 0, bathBad.map((x) => x.clip).join(', '));

// 4) 没有任何动作同时标 bathroom + kitchen（这是以前的模板病）
const both = CATALOG.filter((it) => it.spots.includes('bathroom') && it.spots.includes('kitchen'));
check('无 bathroom+kitchen 混标', both.length === 0, both.map((x) => x.clip).join(', '));

// 5) 睡眠类不在 bathroom
const SLEEP = /睡|打盹|瞌睡|被窝|入眠|沉眠/;
const sleepBad = CATALOG.filter((it) => SLEEP.test(it.clip) && it.spots.includes('bathroom'));
check('睡眠类不在卫生间', sleepBad.length === 0, sleepBad.map((x) => x.clip).join(', '));

// 6) 配置项
check('hereChance 存在且在 0~1', typeof FREESTYLE_DEFAULTS.hereChance === 'number'
  && FREESTYLE_DEFAULTS.hereChance > 0 && FREESTYLE_DEFAULTS.hereChance <= 1, String(FREESTYLE_DEFAULTS.hereChance));
check('travelChance 已移除', FREESTYLE_DEFAULTS.travelChance === undefined);

// 7) 统计
const stat = {};
for (const it of CATALOG) {
  const hasAny = it.spots.includes('anywhere');
  const key = hasAny ? 'anywhere' : it.spots.length > 1 ? 'multi' : 'single';
  stat[key] = (stat[key] || 0) + 1;
}
console.log('\n分布:', JSON.stringify(stat));

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);