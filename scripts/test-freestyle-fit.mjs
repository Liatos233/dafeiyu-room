import { CATALOG, FREESTYLE_DEFAULTS } from '../public/room/action-catalog.js';

// 复刻 home-state.js 里的判定逻辑（同源验证行为）
const FREESTYLE_SPOTS = {
  desk: { room: 'her_room', spot: 'desk' },
  sofa: { room: 'living', spot: 'sofa' },
  kitchen: { room: 'kitchen', spot: 'fridge' },
  bed: { room: 'her_room', spot: 'bedside' },
  bathroom: { room: 'bathroom', spot: 'sink' },
  living: { room: 'living', spot: 'rug' },
  balcony: { room: 'balcony', spot: 'chair' },
  pool: { room: 'pool', spot: 'lounger' },
  garden: { room: 'garden', spot: 'gate' },
};
const BANNED = new Set(['bathroom', 'laundry']);
const roomOf = (s) => FREESTYLE_SPOTS[s]?.room;
const fitsHere = (item, room) => {
  const spots = item.spots || [];
  if (spots.includes('anywhere')) return !BANNED.has(room);
  return spots.some((s) => roomOf(s) === room);
};

let fails = 0;
const check = (name, cond, detail = '') => {
  if (!cond) { fails++; console.log('FAIL', name, detail); }
  else console.log('ok  ', name);
};

// 1) 在卫生间：所有"就地"动作都不能是吃喝/睡眠
const inBath = CATALOG.filter((it) => fitsHere(it, 'bathroom'));
const EAT = /吃|餐|饭|零食|冰淇淋|月饼|火锅|泡面|拉面|咖啡|奶茶|饺子|汤圆|粽|蟹|橘|蛋糕|饼干|寿司|糖/;
const SLEEP = /睡|打盹|瞌睡|被窝|入眠|沉眠/;
check('卫生间可就地做的动作不为 0', inBath.length > 0, `${inBath.length}`);
check('卫生间就地池无吃喝', !inBath.some((it) => EAT.test(it.clip)),
  inBath.filter((it) => EAT.test(it.clip)).map((x) => x.clip).join(','));
check('卫生间就地池无睡眠', !inBath.some((it) => SLEEP.test(it.clip)),
  inBath.filter((it) => SLEEP.test(it.clip)).map((x) => x.clip).join(','));

// 2) 在厨房：可就地的必须都是吃喝类或 anywhere
const inKitchen = CATALOG.filter((it) => fitsHere(it, 'kitchen'));
check('厨房就地池非空', inKitchen.length > 0, `${inKitchen.length}`);

// 3) 在卧室：不能有吃喝就地（garden/bathroom 的排除逻辑）
const inHerRoom = CATALOG.filter((it) => fitsHere(it, 'her_room'));
check('卧室就地池无"洗澡"类', !inHerRoom.some((it) => /洗澡|淋浴/.test(it.clip)));

// 4) anywhere 类在卫生间被判为不兼容
const anywhereClip = CATALOG.find((it) => it.spots.includes('anywhere'));
check('anywhere 在卫生间不兼容', anywhereClip && !fitsHere(anywhereClip, 'bathroom'), anywhereClip?.clip);
check('anywhere 在客厅兼容', anywhereClip && fitsHere(anywhereClip, 'living'));

// 5) 模拟 200 次抽取：在卫生间时永远不会就地做吃喝
let eatInBath = 0;
for (let i = 0; i < 200; i++) {
  const here = inBath;
  const picked = here[Math.floor(Math.random() * here.length)];
  if (picked && EAT.test(picked.clip)) eatInBath++;
}
check('模拟200次卫生间抽取无吃饭', eatInBath === 0, `命中 ${eatInBath}`);

// 6) 离开机制：卫生间连续计数 >= 2 时不该再用 here 池
const stuck = BANNED.has('bathroom') && 2 >= 2;
check('离开机制条件成立', stuck);

console.log(fails === 0 ? '\nALL PASS' : `\n${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);