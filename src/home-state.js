// 小蓝鱼的家 —— 服务端「事实层 + 行为层」。
//
// 设计边界（与《给陪伴角色做一个家》对齐）：
//   · 事实层：需求、睡眠、病痛、房间/站位、事件日志。唯一事实源，页面与提示词都只读它。
//   · 行为层：这张文件里的 advanceHomeState（优先级表）+ 预置站位/路点，纯逻辑、不画图。
//   · 表现层：public/room/ 下的 three.js 页面，只消费 homeView 的快照，不参与决策。
//
// 三条必须守住的规则：
//   1. 需求按「经过的时间」缩放，绝不按心跳次数累加；
//   2. 到了站位不算做了，停留 dwell 之后才结算效果、才写事件；
//   3. 同一类事件有冷却，消费端只读 15 分钟内的（旧事件不补做）。
import fs from 'node:fs';
import path from 'node:path';

import { CATALOG, FREESTYLE_DEFAULTS } from '../public/room/action-catalog.js';

const MIN = 60_000;
const HOUR = 3_600_000;
// 泳池水面范围（与 world.js 的 POOL_X0..X1 / POOL_Z0..Z1 对齐，内缩 0.6m）
const SWIM_LANE = Object.freeze({ z: 10.8, x0: 2.2, x1: 8.6, oneWayMs: 5_000, totalMs: 25_000 });
const EVENT_TTL = 15 * MIN;
const VIEW_EVENT_TTL = 6 * 60 * MIN;   // 「刚刚发生」面板最多回看 6 小时
const MAX_EVENT_LOG = 300;
const MAX_ELAPSED_HOURS = 8; // 桥接停了一整天，也不让需求一口气爆表

export const HOME_ACTIONS = Object.freeze([
  'visit', 'pet', 'poke', 'feed', 'water', 'play', 'talk', 'sleep', 'wake', 'lamp', 'command', 'go', 'place', 'sick', 'heal',
  'clip', 'say'   // QQ 联动：点播动画 / 让她冒句话
]);

// ── 支撑面（P0）：角色离地高度只由「点位用哪个面」+「姿态」决定，不再人肉配 elev
export const SURFACES = Object.freeze({
  floor: 0,
  rug: 0.02,
  sofa_seat: 0.48,
  bed_top: 0.54,
  balcony_chair: 0.40,
  pool_lounger: 0.445,
  dining_seat: 0,
  desk_seat: 0,
  toilet_seat: 0
});

// 1 世界单位 = 1 米。房间按真实尺寸摆，走道净宽都 ≥ 0.9。
export const HOME_LAYOUT = Object.freeze({
  size: { w: 13.2, d: 9.0, h: 2.8, wall: 0.16 },
  rooms: [
    { id: 'kitchen', name: '厨房', bounds: [0, 0, 4.2, 3.6] },
    { id: 'dining', name: '餐厅', bounds: [0, 3.6, 4.2, 7.6] },
    { id: 'living', name: '客厅', bounds: [4.2, 0, 8.4, 7.6] },
    { id: 'her_room', name: '她的房间', bounds: [8.4, 0, 13.2, 4.4] },
    { id: 'corridor', name: '走廊', bounds: [8.4, 4.4, 13.2, 5.6] },
    { id: 'bathroom', name: '卫生间', bounds: [10.8, 5.6, 13.2, 8.2] },
    { id: 'laundry', name: '家政间', bounds: [8.4, 5.6, 10.8, 7.6] },
    { id: 'balcony', name: '阳台', bounds: [0, 7.6, 13.2, 9.0] },
    { id: 'pool', name: '泳池露台', bounds: [0.15, 9.0, 13.2, 13.5] },
    { id: 'foyer', name: '玄关', bounds: [0, 5.2, 1.4, 7.2] },
    { id: 'garden', name: '菜园', bounds: [-1.05, -7.55, 13.15, -0.25] },
    { id: 'yard', name: '屋外小径', bounds: [-1.05, -0.25, -0.2, 7] }
  ],
  // spot：pos 是脚底落点；pose 决定立绘高度/动作；facing 是朝向（度，0=北，90=东）。
  spots: {
    kitchen: {
      fridge: { pos: [1.5, 2.7], pose: 'stand', facing: -90, label: '冰箱前', access: 'k_fridge' },
      sink: { pos: [1.3, 1.45], pose: 'stand', facing: 0, label: '水槽前', access: 'k_sink' },
      stove: { pos: [2.85, 1.45], pose: 'stand', facing: 0, label: '灶台前', access: 'kitchen' },
      dining: { pos: [2.1, 6.3], pose: 'stand', facing: 0, label: '餐桌边', access: 'dining_s', support: 'dining_seat' }
    },
    living: {
      sofa: { pos: [6.3, 5.12], pose: 'sit', facing: 0, label: '沙发上', access: 'sofa_front_l', support: 'sofa_seat', mount: [6.3, 4.55] },
      water: { pos: [1.52, 3.26], pose: 'stand', facing: -90, label: '饮水机旁', access: 'living_wm' },
      shelf: { pos: [7.85, 1.75], pose: 'stand', facing: 90, label: '书架前', access: 'living_n' },
      rug: { pos: [5.4, 2.7], pose: 'sit', facing: 180, label: '地毯上', access: 'living_rug', support: 'rug' },
      tv: { pos: [6.3, 3.2], pose: 'sit', facing: 0, label: '电视前', access: 'living_tvfront', elev: 0.02 }
    },
    her_room: {
      bed: { pos: [11.4, 1.32], pose: 'lie', facing: 180, label: '床上', access: 'beside', support: 'bed_top', mount: [11.4, 2.05] },
      bedside: { pos: [10.1, 1.55], pose: 'stand', facing: 90, label: '床边', access: 'beside' },
      desk: { pos: [9.5, 3.15], pose: 'stand', facing: -90, label: '书桌前', access: 'desk', support: 'desk_seat' },
      wardrobe: { pos: [12.1, 3.45], pose: 'stand', facing: 0, label: '衣柜前', access: 'wardrobe' },
      window: { pos: [12.55, 2.75], pose: 'stand', facing: 90, label: '窗边', access: 'window_n' }
    },
    corridor: {
      gallery: { pos: [9.8, 4.68], pose: 'stand', facing: 0, label: '画廊墙前', access: 'corridor_door' }
    },
    bathroom: {
      sink: { pos: [12.0, 6.45], pose: 'stand', facing: 90, label: '洗手台前', access: 'bath_vanity' },
      toilet: { pos: [11.9, 6.2], pose: 'stand', facing: -90, label: '马桶边', access: 'bath_toilet', support: 'toilet_seat' },
      shower: { pos: [11.5, 7.1], pose: 'stand', facing: 180, label: '淋浴间', access: 'bath_shower' }
    },
    laundry: {
      washer: { pos: [9.7, 6.5], pose: 'stand', facing: 90, label: '洗衣机前', access: 'laundry' }
    },
    balcony: {
        chair: { pos: [3.0, 8.4], pose: 'sit', facing: 180, label: '躺椅上', access: 'bal_chair', support: 'balcony_chair', mount: [3.0, 7.85] },
      },
    pool: {
      lounger: { pos: [12.30, 10.58], pose: 'sit', facing: -90, label: '沙滩躺椅上', access: 'pk_ne', support: 'pool_lounger', mount: [11.72, 10.58] },
      deck_w: { pos: [3.2, 9.5], pose: 'stand', facing: 180, label: '泳池边', access: 'pk_nw' },
      deck_e: { pos: [12.7, 11.0], pose: 'stand', facing: 180, label: '休息区', access: 'pk_ne' }
    },
    garden: {
      gate: { pos: [.72, -3.6], pose: 'stand', facing: 90, label: '菜园门口', access: 'g_gate' },
      shop: { pos: [2, -6.35], pose: 'stand', facing: 0, label: '种子工作台', access: 'g_shop' },
      market: { pos: [4.7, -6.35], pose: 'stand', facing: 0, label: '收成篮旁', access: 'g_market' },
      compost: { pos: [11.42, -6.35], pose: 'stand', facing: 90, label: '堆肥箱旁', access: 'g_compost' },
      ...Object.fromEntries(Array.from({length: 8}, (_, i) => [`plot${i}`, {pos: [[2,4.7,7.4,10.1][i % 4], i < 4 ? -.9 : -3.6], pose: 'stand', facing: 0, label: `第 ${i + 1} 畦旁`, access: `g_plot${i}`}]))
    },
    yard: { path: { pos: [-.65, 3], pose: 'stand', facing: 0, label: '屋外小径', access: 'yard_mid' } },
    foyer: {
      door: { pos: [0.95, 6.25], pose: 'stand', facing: -90, label: '门口', access: 'foyer' },
      shoe: { pos: [0.85, 5.4], pose: 'stand', facing: -90, label: '鞋柜旁', access: 'shoe' }
    }
  }
});

export const ROOM_NAMES = Object.freeze(Object.fromEntries(HOME_LAYOUT.rooms.map((r) => [r.id, r.name])));

/** 点是否在某个房间里；重叠区域取面积最小的（玄关优先于餐厅）。 */
export function roomAtPoint(pos) {
  const x = Number(Array.isArray(pos) ? pos[0] : pos?.x);
  const z = Number(Array.isArray(pos) ? pos[1] : pos?.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  let best = null;
  let bestArea = Infinity;
  for (const room of HOME_LAYOUT.rooms) {
    const [x0, z0, x1, z1] = room.bounds;
    if (x < x0 || x > x1 || z < z0 || z > z1) continue;
    const area = (x1 - x0) * (z1 - z0);
    if (area < bestArea) { best = room; bestArea = area; }
  }
  return best;
}

/** 点击落点：限制在家里、房间内、离墙留 0.22m；不在任何房间返回 null。 */
export function normalizeFreePoint(raw, { preserveOutdoor = false } = {}) {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const x = Number(raw[0]);
  const z = Number(raw[1]);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const room = roomAtPoint([x, z]);
  if (!room) return null;
  // 点击移动仍吸附到菜园安全路点；鼠标拖拽（preserveOutdoor）保留连续落点，
  // 否则从鼠标抬起的位置跳到最近菜畦，观感会一顿一顿的。
  if (room.id === 'garden' || room.id === 'yard') {
    if (!preserveOutdoor) {
      const node = nearestNodeInRoom([x, z], room.id);
      return node.pos.slice();
    }
    const [x0, z0, x1, z1] = room.bounds;
    const pad = 0.18;
    return [
      Math.min(x1 - pad, Math.max(x0 + pad, x)),
      Math.min(z1 - pad, Math.max(z0 + pad, z))
    ];
  }
  const [x0, z0, x1, z1] = room.bounds;
  const pad = 0.22;
  return [
    Math.min(x1 - pad, Math.max(x0 + pad, x)),
    Math.min(z1 - pad, Math.max(z0 + pad, z))
  ];
}

/** 目标点所在房间里最近的路点，避免最后一段穿到别的房间。 */
function nearestNodeInRoom(pos, roomId) {
  const room = HOME_LAYOUT.rooms.find((r) => r.id === roomId);
  if (!room) return nearestNode(pos);
  const [x0, z0, x1, z1] = room.bounds;
  let best = null;
  let bestD = Infinity;
  for (const [id, p] of Object.entries(NODES)) {
    if (p[0] < x0 || p[0] > x1 || p[1] < z0 || p[1] > z1) continue;
    const d = Math.hypot(p[0] - pos[0], p[1] - pos[1]);
    if (d < bestD) { bestD = d; best = id; }
  }
  return best ? { id: best, pos: NODES[best], distance: bestD } : nearestNode(pos);
}

function freeTargetFor(pos, state, now) {
  const p = normalizeFreePoint(pos);
  if (!p) return null;
  const room = roomAtPoint(p);
  if (!room) return null;
  const node = nearestNodeInRoom(p, room.id);
  return {
    room: room.id,
    spot: 'free',
    pos: p,
    access: node.id,
    kind: 'free',
    walkText: '往你指的地方走',
    actText: '到了你指的地方，站住了',
    dwellMs: 1200,
    pose: 'stand',
    elev: 0,
    facing: state.facing ?? 0,
    effect: null,
    eventType: null,
    eventText: null,
    urgent: false,
    free: true,
    awakeHold: true
  };
}


// 预置路点：房间内的合法落点 + 门口。移动=沿这些点走直线，不做寻路、不用物理。
const NODES = Object.freeze({
  yard_door: [-.65, 6.25],
  yard_mid: [-.65, 3],
  yard_gate: [-.65, -3.6],
  g_gate: [.72, -3.6],
  g_front: [.72, -.9],
  g_back: [.72, -6.35],
  g_shop: [2, -6.35],
  g_market: [4.7, -6.35],
  g_compost: [11.42, -6.35],
  ...Object.fromEntries(Array.from({length:8}, (_,i)=>[`g_plot${i}`, [[2,4.7,7.4,10.1][i % 4],i<4?-.9:-3.6]])),
  foyer: [0.95, 6.25],
  shoe: [0.85, 5.4],
  dining_s: [2.1, 6.3],
  dining_wm: [0.9, 4.2],
  kitchen: [2.1, 2.6],
  kitchen_e: [3.65, 3.60],
  kitchen_mid: [2.93, 2.75],
  kitchen_east: [4.04, 2.57],
  dining_se: [3.60, 6.50],
  dining_es: [3.62, 5.05],
  k_sink: [1.3, 1.45],
  k_fridge: [1.5, 2.7],
  living_w: [4.9, 5.9],
  living_wm: [1.52, 3.26],
  living_n: [6.3, 1.5],
  living_rug: [5.4, 2.7],
  living_south: [6.40, 6.48],
  living_tvfront: [6.3, 3.2],
  living_e: [7.9, 3.9],
  living_gate: [7.9, 4.9],
  sofa_front_l: [5.12, 4.42],
  sofa_front_r: [7.48, 4.42],
  l_tv_e: [7.80, 3.20],
  living_r: [7.62, 6.02],
  gate: [8.55, 5.0],
  corridor: [9.2, 5.0],
  corridor_e: [12.3, 5.0],
  corridor_door: [9.15, 4.75],
  bedroom_in: [9.15, 4.05],
  bedroom_c: [10.4, 2.7],
  beside: [10.1, 1.55],
  desk: [9.5, 3.15],
  wardrobe: [12.1, 3.4],
  window_n: [12.55, 2.75],
  bath_out: [12.35, 5.4],
  bath_in: [12.35, 5.95],
  bath_c: [11.8, 6.55],
  bath_vanity: [12.0, 6.45],
  bath_toilet: [11.9, 6.2],
  bath_shower: [11.5, 7.1],
  laundry: [9.7, 6.5],
  bal_door_in: [7.10, 7.28],
  bal_door_out: [7.10, 7.95],
  bal_w: [3.0, 8.4],
  bal_e: [7.6, 8.4],
  bal_chair: [3.58, 8.30],
  pool_gate: [9.0, 8.4],
  pk_nw: [0.75, 9.72],
  pk_ne: [10.6, 9.72],
  pk_se: [10.6, 12.88],
  pk_sw: [0.75, 12.88],
  pk_ladder: [9.0, 9.72]
});

// 每条边都是「同一房间内直线可达」或「穿过门洞」。不写穿墙的捷径。
const EDGES = Object.freeze([
  ['foyer','yard_door'], ['yard_door','yard_mid'], ['yard_mid','yard_gate'], ['yard_gate','g_gate'],
  ['g_gate','g_front'], ['g_gate','g_back'], ['g_back','g_shop'], ['g_shop','g_market'], ['g_market','g_compost'],
  ['g_front','g_plot0'], ['g_plot0','g_plot1'], ['g_plot1','g_plot2'], ['g_plot2','g_plot3'],
  ['g_gate','g_plot4'], ['g_plot4','g_plot5'], ['g_plot5','g_plot6'], ['g_plot6','g_plot7'],
  ['foyer', 'shoe'], ['foyer', 'dining_s'], ['dining_s', 'shoe'], ['shoe', 'dining_wm'],
  ['dining_wm', 'kitchen'], ['kitchen', 'k_sink'], ['kitchen', 'k_fridge'],
  ['kitchen', 'kitchen_e'], ['kitchen', 'kitchen_mid'], ['kitchen_mid', 'kitchen_e'],
  ['kitchen_east', 'kitchen_e'], ['kitchen_east', 'kitchen_mid'], ['kitchen_east', 'living_n'],
  ['kitchen_e', 'dining_es'], ['dining_es', 'dining_se'], ['kitchen_e', 'living_wm'],
  ['dining_se', 'dining_s'], ['dining_se', 'living_w'],
  ['living_r', 'living_w'], ['living_r', 'living_gate'],
  ['dining_es', 'living_w'], ['dining_s', 'living_w'],
  ['living_wm', 'living_n'],
  ['living_n', 'living_e'], ['living_rug', 'kitchen_e'], ['living_rug', 'living_n'], ['living_tvfront', 'living_rug'],
  ['living_south', 'living_w'], ['living_south', 'bal_door_in'], ['living_south', 'living_r'],
  ['living_e', 'living_gate'],
  
  ['sofa_front_l', 'sofa_front_r'], ['sofa_front_r', 'living_gate'],
  ['sofa_front_l', 'living_wm'], ['sofa_front_r', 'l_tv_e'],
  ['l_tv_e', 'living_n'], ['l_tv_e', 'living_e'],
  ['living_gate', 'gate'], ['gate', 'corridor'],
  ['gate', 'corridor_door'],
  ['bal_door_in', 'living_r'],
  ['bal_door_in', 'bal_door_out'], ['bal_w', 'bal_chair'], ['bal_door_out', 'bal_chair'],
  ['bal_door_out', 'bal_e'],
  ['bal_e', 'pool_gate'], ['pool_gate', 'pk_ne'],
  ['pk_nw', 'pk_ne'], ['pk_ne', 'pk_se'], ['pk_se', 'pk_sw'], ['pk_sw', 'pk_nw'],
  ['pk_nw', 'pk_ladder'], ['pk_ladder', 'pk_ne'], ['pk_ladder', 'pool_gate'],
  ['corridor', 'corridor_door'], ['corridor_door', 'bedroom_in'], ['bedroom_in', 'bedroom_c'],
  ['bedroom_c', 'beside'], ['bedroom_c', 'desk'], ['bedroom_c', 'wardrobe'], ['bedroom_c', 'window_n'],
  ['corridor', 'corridor_e'], ['corridor_e', 'bath_out'], ['bath_out', 'bath_in'], ['bath_in', 'bath_c'],
  ['bath_c', 'bath_vanity'], ['bath_c', 'bath_toilet'], ['bath_c', 'bath_shower'],
  ['corridor', 'laundry']
]);

const ADJ = new Map();
for (const [a, b] of EDGES) {
  if (!NODES[a] || !NODES[b]) continue;
  const d = Math.hypot(NODES[a][0] - NODES[b][0], NODES[a][1] - NODES[b][1]);
  if (!ADJ.has(a)) ADJ.set(a, []);
  if (!ADJ.has(b)) ADJ.set(b, []);
  ADJ.get(a).push([b, d]);
  ADJ.get(b).push([a, d]);
}

const SPOT_INDEX = Object.freeze((() => {
  const out = {};
  for (const [room, spots] of Object.entries(HOME_LAYOUT.spots)) {
    for (const [id, spot] of Object.entries(spots)) out[`${room}.${id}`] = { ...spot, room, id };
  }
  return out;
})());

// 每类事件的冷却：同一件事在冷却期内不重复写，避免记忆被「喝水 ×20」刷屏。
const EVENT_COOLDOWN = Object.freeze({
  eat: 45 * MIN,
  drink: 25 * MIN,
  toilet: 40 * MIN,
  shower: 4 * HOUR,
  balcony: 60 * MIN,
  tv: 50 * MIN,
  desk: 90 * MIN,
  nap: 90 * MIN,
  phone: 20 * MIN,
  help: 30 * MIN,
  laundry: 3 * HOUR,
  visit: 30 * MIN,
  sleep: 6 * HOUR,
  wake: HOUR,
  pet: 0,
  feed: 0,
  water: 0,
  sick: 0,
  recover: 0,
  // 详细日志用的类型：短冷却，避免刷屏但保留过程
  depart: 90_000,
  arrive: 90_000,
  done: 60_000,
  freestyle: 5 * MIN,
  clip: 0,
  say: 0,
  mood: 20 * MIN,
  need_hunger: 25 * MIN,
  need_thirst: 20 * MIN,
  need_energy: 20 * MIN,
  need_hygiene: 40 * MIN,
  need_bladder: 25 * MIN
});

// 进入泳池水面来回游（点播和自主抽中「游泳」都走这里）
function startSwim(state, now, ms = SWIM_LANE.totalMs) {
  state.room = 'pool';
  state.spot = 'deck_w';
  state.freePos = null;
  state.kind = 'swim';
  state.clip = '游泳';
  state.pose = 'stand';
  state.elev = 0;
  state.walking = false;
  state.route = null;
  state.activity = '在泳池里游来游去';
  state.swim = {
    from: [SWIM_LANE.x0, SWIM_LANE.z],
    to: [SWIM_LANE.x1, SWIM_LANE.z],
    startedAt: now,
    until: now + ms,
    oneWayMs: SWIM_LANE.oneWayMs
  };
}

function clamp01(n) {
  return Math.min(1, Math.max(0, Number(n) || 0));
}
function clamp(n, a, b) {
  return Math.min(b, Math.max(a, Number(n) || 0));
}
function localHour(now) {
  const d = new Date(now);
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}
function clockText(now) {
  return new Date(now).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function hashPick(seed, list) {
  if (!list.length) return null;
  return list[hash(String(seed)) % list.length];
}
function dayKey(now) {
  return new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

export function sanitizeText(value, max = 120) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function daypart(hour) {
  if (hour < 5) return '深夜';
  if (hour < 8) return '清晨';
  if (hour < 12) return '上午';
  if (hour < 14) return '中午';
  if (hour < 18) return '下午';
  if (hour < 21) return '傍晚';
  return '夜里';
}

export function skyOf(hour) {
  if (hour < 5 || hour >= 21) return 'night';
  if (hour < 7.5) return 'dawn';
  if (hour < 17) return 'day';
  if (hour < 19.5) return 'dusk';
  return 'night';
}

export function needsWords(needs) {
  const hunger = clamp01(needs?.hunger);
  const thirst = clamp01(needs?.thirst);
  const energy = clamp01(needs?.energy);
  const pain = clamp01(needs?.pain);
  return {
    hunger: hunger < 0.25 ? '不饿' : hunger < 0.5 ? '有点想吃东西' : hunger < 0.72 ? '饿了' : hunger < 0.9 ? '很饿' : '饿得不行',
    thirst: thirst < 0.25 ? '不渴' : thirst < 0.5 ? '有点渴' : thirst < 0.72 ? '渴了' : thirst < 0.9 ? '很渴' : '渴得嗓子发干',
    energy: energy > 0.75 ? '精神不错' : energy > 0.5 ? '还行' : energy > 0.3 ? '有点累' : energy > 0.12 ? '很困' : '快撑不住了',
    pain: pain < 0.15 ? '没有不舒服' : pain < 0.4 ? '有点不舒服' : pain < 0.7 ? '很难受' : '疼得动不了',
    hygiene: (needs?.hygiene ?? 0) > 0.7 ? '该洗漱了' : (needs?.hygiene ?? 0) > 0.45 ? '有点邋遢'
      : (needs?.hygiene ?? 0) > 0.25 ? '还算清爽' : '清清爽爽'
  };
}

export function describeSpot(room, spot) {
  if (spot === 'free') return `${ROOM_NAMES[room] || room || '家里'} · 你指的地方`;
  const s = HOME_LAYOUT.spots?.[room]?.[spot];
  return s ? `${ROOM_NAMES[room] || room} · ${s.label}` : (ROOM_NAMES[room] || room || '家里');
}

function defaultArrival(room, spot, kind, actText, dwellMs, effect, eventType, eventText, extra = {}) {
  const s = HOME_LAYOUT.spots[room][spot];
  return {
    room, spot, pose: s.pose, elev: s.elev || 0, facing: s.facing ?? 0,
    walkText: `往${ROOM_NAMES[room] || '屋里'}走`,
    actText, kind, dwellMs, effect, eventType, eventText, ...extra
  };
}

// 预置的「一次出门」：走路文案、到了做什么、停留多久、结算什么、写什么事件。
const TRIPS = {
  drink: (now) => defaultArrival('kitchen', 'sink', 'drink', '喝了杯水，真解渴', 12_000, 'drink', 'drink', '喝了杯水，真解渴'),
  eat: (now) => defaultArrival('kitchen', 'fridge', 'eat', '在厨房翻冰箱，找了点吃的', 28_000, 'eat', 'eat', '在厨房吃了点东西，胃里暖了一点'),
  snack: (now) => defaultArrival('kitchen', 'fridge', 'eat', '抱着一袋小鱼干，坐在厨房边吃', 22_000, 'snack', 'eat', '抱着一袋小鱼干吃得很开心'),
  toilet: (now) => defaultArrival('bathroom', 'toilet', 'toilet', '在卫生间里待了一会儿', 35_000, 'toilet', 'toilet', '去了趟卫生间'),
  brush: (now) => defaultArrival('bathroom', 'sink', 'bath', '站在洗手台前刷牙洗脸', 25_000, 'brush', 'shower', '在卫生间洗漱完，清醒了一点'),
  shower: (now) => defaultArrival('bathroom', 'shower', 'bath', '在淋浴间冲了个澡', 45_000, 'shower', 'shower', '洗了个热水澡，头发还湿着'),
  balcony: (now) => defaultArrival('balcony', 'chair', 'balcony', '在躺椅上躺着吹海风', 28_000, 'balcony', 'balcony', '在阳台吹了会儿风'),
  tv: (now) => defaultArrival('living', 'sofa', 'tv', '窝在沙发上，抱着抱枕看屏幕', 35_000, 'tv', 'tv', '窝在沙发上看了一会儿电视'),
  desk: (now) => defaultArrival('her_room', 'desk', 'desk', '趴在书桌前写写画画', 40_000, 'desk', 'desk', '在书桌前写了一会儿东西'),
  phone: (now) => defaultArrival('living', 'sofa', 'phone', '低头看手机，有人在 QQ 找你', 10_000, 'phone', 'phone', '看到手机上有未读，凑过去看了一会儿'),
  nap: (now) => defaultArrival('living', 'sofa', 'nap', '抱着抱枕在沙发上打盹', 60_000, 'nap', 'nap', '在沙发上眯了一会儿'),
  laundry: (now) => defaultArrival('laundry', 'washer', 'laundry', '在研究洗衣机，把衣服塞进去', 30_000, 'laundry', 'laundry', '把攒的衣服丢进洗衣机'),
  window: (now) => defaultArrival('her_room', 'window', 'idle', '站在窗边看楼下的灯', 20_000, 'window', 'balcony', '在窗边站了一会儿'),
  dinner: (now) => defaultArrival('kitchen', 'dining', 'eat', '坐在餐桌边，小口小口地吃', 30_000, 'eat', 'eat', '在餐桌边吃了顿饭'),
  sickBed: (now) => defaultArrival('her_room', 'bed', 'sick', '烧得厉害，只能裹着被子躺着', 0, 'sick', null, '')
};

export function emptyHomeState(now = Date.now()) {
  const base = {
    v: 1,
    createdAt: now,
    updatedAt: now,
    lastTickAt: now,
    seed: hash(`home:${dayKey(now)}`),
    needs: { hunger: 0.3, thirst: 0.32, energy: 0.7, bladder: 0.2, pain: 0, hygiene: 0.1 },
    asleep: false,
    sleepPending: false,
    // 指令/互动后的「别急着睡」保护期（时间戳，ms）；0 = 无保护。旧存档缺省为 0。
    awakeUntil: 0,
    freePos: null,
    freeTarget: null,
    room: 'living',
    spot: 'sofa',
    pose: 'sit',
    elev: 0.4,
    facing: 0,
    kind: 'idle',
    activity: '窝在沙发上发呆',
    walking: false,
    reactionUntil: 0,
    route: null,
    dwell: null,
    nextDecisionAt: 0,
    lastInteractionAt: 0,
    lamp: true,
    bedsideWater: true,
    command: null,
    lastPhoneAt: 0,
    lastDefaultSpot: '',
    visits: 0,
    lastVisitAt: 0,
    counts: { pet: 0, poke: 0, feed: 0, water: 0, play: 0, talk: 0, help: 0, wake: 0 },
    eventLog: [],
    lastEventAt: {}
  };
  return base;
}

function initialState(now = Date.now()) {
  const s = emptyHomeState(now);
  const hour = localHour(now);
  s.needs = {
    hunger: clamp01(0.18 + Math.max(0, hour - 7) / 18 * 0.32),
    thirst: clamp01(0.2 + Math.max(0, hour - 7) / 18 * 0.3),
    energy: hour >= 23 || hour < 7 ? 0.78 : 0.72,
    bladder: 0.2,
    pain: 0
  };
  const asleep = hour >= 23.5 || hour < 7;
  if (asleep) {
    Object.assign(s, {
      asleep: true, room: 'her_room', spot: 'bed', pose: 'lie', elev: 0.52, facing: 180,
      kind: 'sleep', activity: '睡着了', lamp: false
    });
    s.lastTickAt = now;
    s.nextDecisionAt = now + 5 * MIN;
    return s;
  }
  const pick = (() => {
    if (hour < 9) return ['bathroom', 'sink', 'bath', '刚起床，在洗漱'];
    if (hour < 11) return ['her_room', 'desk', 'desk', '坐在书桌前，不知道在写什么'];
    if (hour < 13) return ['kitchen', 'fridge', 'idle', '在厨房翻冰箱，想找点吃的'];
    if (hour < 15) return ['living', 'rug', 'nap', '铺了张毯子，在地毯上打盹'];
    if (hour < 18) return ['her_room', 'desk', 'desk', '趴在书桌前写写画画'];
    if (hour < 20) return ['kitchen', 'dining', 'idle', '坐在餐桌边，端着杯子发呆'];
    if (hour < 22.5) return ['living', 'sofa', 'tv', '窝在沙发上看电视'];
    return ['her_room', 'bedside', 'idle', '在床边坐着，准备睡了'];
  })();
  const [room, spot, kind, activity] = pick;
  const sp = HOME_LAYOUT.spots[room][spot];
  Object.assign(s, {
    room, spot, kind, activity, pose: sp.pose, elev: sp.elev || 0, facing: sp.facing ?? 0,
    lamp: hour >= 19 || hour < 7
  });
  s.lastTickAt = now;
  s.nextDecisionAt = now + 6 * MIN;
  return s;
}

export function normalizeHomeState(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return initialState(now);
  if (!raw.createdAt) return initialState(now);
  const base = emptyHomeState(now);
  const out = { ...base, ...raw };
  out.v = 1;
  out.createdAt = Number(out.createdAt) || now;
  out.updatedAt = Number(out.updatedAt) || now;
  out.lastTickAt = Number(out.lastTickAt) || now;
  out.seed = Number(out.seed) >>> 0;
  const needs = raw.needs && typeof raw.needs === 'object' ? raw.needs : {};
  out.needs = {
    hygiene: clamp01(needs.hygiene ?? base.needs.hygiene ?? 0.1),
    hunger: clamp01(needs.hunger ?? base.needs.hunger),
    thirst: clamp01(needs.thirst ?? base.needs.thirst),
    energy: clamp01(needs.energy ?? base.needs.energy),
    bladder: clamp01(needs.bladder ?? base.needs.bladder),
    pain: clamp01(needs.pain ?? 0)
  };
  out.asleep = raw.asleep === true;
  // 已经落地的自由点必须保留，否则拖拽放下后一读档就又吸回菜畦。
  out.freePos = normalizeFreePoint(raw.freePos, { preserveOutdoor: true });
  if (out.spot === 'free' && out.freePos) {
    const r = roomAtPoint(out.freePos);
    if (r) out.room = r.id;
  }
  const validSpotDef = HOME_LAYOUT.spots[out.room]?.[out.spot];
  const isFreeSpot = out.spot === 'free' && out.freePos;
  if (!validSpotDef && !isFreeSpot) {
    out.room = 'living';
    out.spot = 'sofa';
    out.freePos = null;
  }
  const sp = HOME_LAYOUT.spots[out.room]?.[out.spot] || { pose: 'stand', elev: 0, facing: 0 };
  out.sleepPending = raw.sleepPending === true;
  // 旧存档/正在走回床的中间态：人还没到 bed 就不算睡着。
  if (out.asleep && !(out.room === 'her_room' && out.spot === 'bed')) {
    out.asleep = false;
    out.sleepPending = true;
  }
  if (out.asleep) out.sleepPending = false;
  out.freeTarget = raw.freeTarget && normalizeFreePoint(raw.freeTarget.pos)
    ? { pos: normalizeFreePoint(raw.freeTarget.pos), until: Math.max(0, Number(raw.freeTarget.until) || 0) }
    : null;
  out.pose = ['stand', 'sit', 'lie'].includes(raw.pose) ? raw.pose : sp.pose;
  out.elev = supportY(out);
  out.facing = Number(raw.facing) || sp.facing || 0;
  out.kind = sanitizeText(raw.kind, 24) || 'idle';
  out.clip = sanitizeText(raw.clip, 40) || null;
  out.swim = raw.swim && typeof raw.swim === 'object' && Array.isArray(raw.swim.from) && Array.isArray(raw.swim.to) ? {
    from: raw.swim.from.map(Number), to: raw.swim.to.map(Number),
    startedAt: Number(raw.swim.startedAt) || 0, until: Number(raw.swim.until) || 0,
    oneWayMs: Number(raw.swim.oneWayMs) || 6000
  } : null;
  out.sayText = sanitizeText(raw.sayText, 140) || '';
  out.sayUntil = Math.max(0, Number(raw.sayUntil) || 0);
  out.lastSayAt = Math.max(0, Number(raw.lastSayAt) || 0);
  out.freestyleNextAt = Math.max(0, Number(raw.freestyleNextAt) || 0);
  out.lastFreestyleAt = Math.max(0, Number(raw.lastFreestyleAt) || 0);
  out.recentFreestyle = Array.isArray(raw.recentFreestyle) ? raw.recentFreestyle.map((x) => sanitizeText(x, 40)).filter(Boolean).slice(0, 8) : [];
  out.freestylePick = raw.freestylePick && typeof raw.freestylePick === 'object' ? {
    by: sanitizeText(raw.freestylePick.by, 20) || '',
    clip: sanitizeText(raw.freestylePick.clip, 40) || '',
    group: sanitizeText(raw.freestylePick.group, 12) || '',
    travel: raw.freestylePick.travel === true,
    top: Array.isArray(raw.freestylePick.top) ? raw.freestylePick.top.map((x) => sanitizeText(x, 40)).slice(0, 3) : []
  } : null;
  out.activity = sanitizeText(raw.activity, 80) || '在发呆';
  out.walking = raw.walking === true;
  out.reactionUntil = Math.max(0, Number(out.reactionUntil) || 0);
  out.nextDecisionAt = Math.max(0, Number(out.nextDecisionAt) || 0);
  out.awakeUntil = Math.max(0, Number(out.awakeUntil) || 0);
  out.lastInteractionAt = Math.max(0, Number(out.lastInteractionAt) || 0);
  out.lamp = out.lamp !== false;
  out.bedsideWater = out.bedsideWater !== false;
  out.lastPhoneAt = Math.max(0, Number(out.lastPhoneAt) || 0);
  out.lastDefaultSpot = sanitizeText(out.lastDefaultSpot, 32);
  out.visits = Math.max(0, Number(out.visits) || 0);
  out.lastVisitAt = Math.max(0, Number(out.lastVisitAt) || 0);
  out.counts = { ...base.counts };
  for (const k of Object.keys(out.counts)) out.counts[k] = Math.max(0, Number(raw.counts?.[k]) || 0);
  out.command = raw.command && typeof raw.command === 'object' && HOME_LAYOUT.spots[raw.command.room]?.[raw.command.spot]
    ? { room: raw.command.room, spot: raw.command.spot, until: Math.max(0, Number(raw.command.until) || 0), by: sanitizeText(raw.command.by, 24) }
    : null;
  out.route = null;
  if (raw.route && Array.isArray(raw.route.points) && raw.route.points.length >= 2) {
    const points = raw.route.points
      .filter((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
      .map((p) => [Number(p[0]), Number(p[1])]);
    const rt = raw.route.target;
    const routeTargetValid = rt && (
      HOME_LAYOUT.spots[rt.room]?.[rt.spot]
      || (rt.spot === 'free' && normalizeFreePoint(rt.pos))
    );
    if (points.length >= 2 && routeTargetValid) {
      out.route = {
        points,
        departAt: Number(raw.route.departAt) || now,
        arriveAt: Number(raw.route.arriveAt) || now,
        speed: clamp(Number(raw.route.speed) || 0.55, 0.2, 2),
        target: raw.route.target
      };
    }
  }

  if (out.asleep && out.route) {
    out.asleep = false;
    out.sleepPending = true;
  }
  out.dwell = null;
  if (raw.dwell && raw.dwell.until && raw.dwell.target) {
    out.dwell = {
      until: Number(raw.dwell.until) || 0,
      target: raw.dwell.target
    };
  }
  out.eventLog = Array.isArray(raw.eventLog)
    ? raw.eventLog
      .filter((e) => e && typeof e === 'object' && e.at && e.text)
      .map((e) => ({
        at: Number(e.at) || 0,
        type: sanitizeText(e.type, 24),
        text: sanitizeText(e.text, 140),
        room: sanitizeText(e.room, 24),
        spot: sanitizeText(e.spot, 24)
      }))
      .filter((e) => e.at > 0 && now - e.at < 24 * HOUR)
      .slice(-MAX_EVENT_LOG)
    : [];
  out.lastEventAt = {};
  if (raw.lastEventAt && typeof raw.lastEventAt === 'object') {
    for (const [k, v] of Object.entries(raw.lastEventAt)) {
      if (Number(v) > 0 && now - Number(v) < 7 * 24 * HOUR) out.lastEventAt[k] = Number(v);
    }
  }
  return out;
}

export function loadHomeState(filePath, now = Date.now()) {
  try {
    return normalizeHomeState(JSON.parse(fs.readFileSync(filePath, 'utf8')), now);
  } catch {
    return initialState(now);
  }
}

export function saveHomeState(filePath, state, now = Date.now()) {
  const normalized = normalizeHomeState(state, now);
  normalized.updatedAt = now;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  // Windows 忽略 mode，显式补一次（失败不影响功能）
  try { fs.chmodSync(tmp, 0o600); } catch { /* 忽略 */ }
  fs.renameSync(tmp, filePath);
  return normalized;
}

export function spotOf(room, spot) {
  return SPOT_INDEX[`${room}.${spot}`] || null;
}

export function nearestNode(pos) {
  let best = null;
  let bestD = Infinity;
  for (const [id, p] of Object.entries(NODES)) {
    const d = Math.hypot(p[0] - pos[0], p[1] - pos[1]);
    if (d < bestD) { bestD = d; best = id; }
  }
  return { id: best, pos: NODES[best], distance: bestD };
}

/** Dijkstra：图很小（40 个点），用不着 A*，也保证结果是预置路点。 */
export function graphPath(fromId, toId) {
  if (!NODES[fromId] || !NODES[toId]) return null;
  if (fromId === toId) return [NODES[fromId]];
  const dist = new Map([[fromId, 0]]);
  const prev = new Map();
  const open = [[0, fromId]];
  const seen = new Set();
  while (open.length) {
    open.sort((a, b) => a[0] - b[0]);
    const [d, id] = open.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    if (id === toId) break;
    for (const [next, w] of ADJ.get(id) || []) {
      const nd = d + w;
      if (nd < (dist.get(next) ?? Infinity)) {
        dist.set(next, nd);
        prev.set(next, id);
        open.push([nd, next]);
      }
    }
  }
  if (!dist.has(toId)) return null;
  const out = [];
  let cur = toId;
  while (cur) { out.push(NODES[cur]); cur = prev.get(cur); }
  return out.reverse();
}

// 大件家具的近似禁行区：只用于同房间直达边的碰撞检查，不改变站位。
// 这是“地图建模”的保守近似；小摆件不参与，避免把路网打得太碎。
const NAV_KEEPOUT = Object.freeze([
  // pool water: 泳池水面，平时绕行（只有游泳点位靠端点豁免进入）
  // 泳池水面：绕行（游泳点位靠端点豁免）
  { rect: [0.9, 9.98, 10.34, 12.68], pad: 0.12 },
  // 阳台南侧玻璃栏杆：不能穿过去，只能走东端缺口
  { rect: [0.05, 8.88, 8.2, 9.02], pad: 0.1 },

  // 客厅
  { room: 'living', rect: [5.20, 0.15, 7.40, 0.60] },   // 电视柜（2.2×0.42 @6.3,0.36）
  { room: 'living', rect: [5.28, 4.66, 7.32, 5.58], top: 0.48 },   // 沙发（坐垫顶面 0.48）
  { room: 'living', rect: [5.70, 3.52, 6.90, 4.18] },   // 茶几（1.16×0.6 @6.3,3.85）
  { room: 'living', rect: [8.03, 1.04, 8.37, 2.46] },   // 书架（0.3×1.38 @8.2,1.75）
  { room: 'living', rect: [4.20, 0.10, 5.04, 0.94] },   // 电视柜左侧绿植
  { room: 'living', rect: [7.48, 0.10, 8.32, 0.94] },   // 电视柜右侧绿植
  { room: 'living', rect: [4.33, 4.90, 4.77, 5.34], pad: 0.15 },   // 落地灯（沙发左侧）
  { room: 'living', rect: [4.72, 7.42, 6.42, 7.78], pad: 0.12 },  // 阳台推拉门（左侧叠扇，右侧 x>6.45 才是门洞）
  // 厨房
  { room: 'kitchen', rect: [0.30, 0.29, 3.90, 0.87] },  // 北墙整排橱柜
  { room: 'kitchen', rect: [0.28, 0.85, 1.05, 3.08] },  // 西侧橱柜 + 冰箱
  { room: 'kitchen', rect: [0.44, 3.04, 0.88, 3.48], pad: 0.15 },  // 饮水机
  // 餐厅
  { room: 'dining', rect: [1.35, 4.45, 2.85, 5.35], top: 0.46 },   // 餐桌桌面（椅面 0.46）
  { room: 'dining', rect: [1.85, 4.06, 2.35, 4.50] },              // 北侧椅子
  { room: 'dining', rect: [1.85, 5.31, 2.35, 5.75] },              // 南侧椅子
  // 她的房间
  { room: 'her_room', rect: [10.35, 0.18, 12.65, 2.33], top: 0.54 }, // 床（床垫顶面 0.54）
  { room: 'her_room', rect: [8.50, 0.33, 9.84, 1.00] },   // 书桌 1.3×0.62 @9.17,0.66
  { room: 'her_room', rect: [11.33, 3.93, 12.97, 4.33] }, // 衣柜 1.6×0.36 @12.15,4.13
  // 卫生间
  { room: 'bathroom', rect: [11.02, 5.83, 11.48, 6.47], pad: 0.15 }, // 马桶
  { room: 'bathroom', rect: [12.48, 5.98, 13.16, 7.02] }, // 洗手台
  { room: 'bathroom', rect: [11.03, 7.11, 12.47, 8.07] }, // 淋浴
  // 家政间
  { room: 'laundry', rect: [10.08, 5.83, 10.72, 6.47] },  // 洗衣机 0.6×0.6 @10.4,6.15
  { room: 'laundry', rect: [8.45, 7.25, 9.25, 7.60], pad: 0.15 },    // 晾衣架
  // 阳台
  { room: 'balcony', rect: [0.45, 7.70, 1.80, 8.55] },    // 西侧花盆
  { room: 'balcony', rect: [2.00, 7.88, 3.34, 8.58], top: 0.40 },    // 躺椅
  // 玄关
  { room: 'foyer', rect: [0.05, 4.85, 0.50, 5.75] },      // 鞋柜
  // 泳池露台：两张沙滩躺椅（坐下会穿模，走动也不该踩进去）
  { room: 'pool', rect: [11.55, 10.20, 13.15, 10.96], top: 0.445 },
  { room: 'pool', rect: [11.55, 11.64, 13.15, 12.40], top: 0.445 }
]);

// 角色安全半径（米）：路径与家具保持的间距
const NAV_PAD = 0.30;

function pointInRect(p, rect, pad = 0) {
  return p[0] >= rect[0] - pad && p[0] <= rect[2] + pad
    && p[1] >= rect[1] - pad && p[1] <= rect[3] + pad;
}
function segmentHitsRect(a, b, rect, pad = NAV_PAD) {
  const x0 = rect[0] - pad, z0 = rect[1] - pad, x1 = rect[2] + pad, z1 = rect[3] + pad;
  // Liang–Barsky：线段与轴对齐矩形的相交测试。
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dz = b[1] - a[1];
  for (const [p, q] of [[-dx, a[0] - x0], [dx, x1 - a[0]], [-dz, a[1] - z0], [dz, z1 - a[1]]]) {
    if (Math.abs(p) < 1e-9) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return t0 <= t1;
}
// 房间之间的实墙（只用于“直线能不能直接穿过去”的判断）：
// axis='x' 表示墙沿 x 方向、fixed 是 z；holes 是可通行的门洞区间。
const WALL_SEGMENTS = [
  { axis: 'x', fixed: 0.0, from: 0.0, to: 13.2, holes: [] },
  { axis: 'z', fixed: 0.0, from: 0.0, to: 7.6, holes: [[5.8, 6.7]] },
  { axis: 'z', fixed: 13.2, from: 0.0, to: 8.2, holes: [] },
  { axis: 'x', fixed: 7.6, from: 0.0, to: 4.8, holes: [] },
  { axis: 'x', fixed: 7.6, from: 4.8, to: 7.8, holes: [[4.8, 7.8]] },   // 阳台推拉门
  { axis: 'x', fixed: 7.6, from: 7.8, to: 10.8, holes: [] },
  { axis: 'x', fixed: 8.2, from: 10.8, to: 13.2, holes: [] },
  { axis: 'z', fixed: 8.4, from: 0.0, to: 4.4, holes: [] },
  { axis: 'z', fixed: 8.4, from: 5.6, to: 7.6, holes: [] },
  { axis: 'x', fixed: 4.4, from: 8.4, to: 13.2, holes: [[8.7, 9.6]] },
  { axis: 'z', fixed: 10.8, from: 5.6, to: 8.2, holes: [] },
  { axis: 'x', fixed: 5.6, from: 10.8, to: 13.2, holes: [[11.9, 12.8]] },
  { axis: 'x', fixed: 5.6, from: 8.4, to: 10.8, holes: [[9.15, 9.95]] }
];

function segmentCrossesWall(a, b) {
  for (const w of WALL_SEGMENTS) {
    const aAxis = w.axis === 'x' ? a[1] : a[0];
    const bAxis = w.axis === 'x' ? b[1] : b[0];
    const d = bAxis - aAxis;
    if (Math.abs(d) < 1e-9) continue;
    const t = (w.fixed - aAxis) / d;
    if (t <= 0.0001 || t >= 0.9999) continue;
    const along = (w.axis === 'x' ? a[0] : a[1]) + ((w.axis === 'x' ? b[0] : b[1]) - (w.axis === 'x' ? a[0] : a[1])) * t;
    if (along < w.from - 0.05 || along > w.to + 0.05) continue;
    const inHole = (w.holes || []).some(([h0, h1]) => along >= h0 - 0.06 && along <= h1 + 0.06);
    if (!inHole) return true;
  }
  return false;
}

function segmentClearTwoRooms(a, b, roomA, roomB, padScale = 1) {
  for (const item of NAV_KEEPOUT) {
    // 注意：直线可能从第三个房间穿过去，所以这里不能按房间过滤

    const pad = (item.pad ?? NAV_PAD) * padScale;
    if (pointInRect(a, item.rect, 0) || pointInRect(b, item.rect, 0)) continue;
    if (pointInRect(a, item.rect, pad) || pointInRect(b, item.rect, pad)) {
      if (segmentHitsRect(a, b, item.rect, 0)) return false;
      continue;
    }
    if (segmentHitsRect(a, b, item.rect, pad)) return false;
  }
  return true;
}

function segmentClear(a, b, roomId, padScale = 1) {
  if (!roomId) return false;
  for (const item of NAV_KEEPOUT) {
    // 起点/终点本来就贴着这件家具（沙发、床、洗手台等）时，允许它离场，
    // 否则会被自己的站位锁死。这里和外扩半径保持一致，避免“贴墙就被判堵死”。
    const pad = (item.pad ?? NAV_PAD) * padScale;
    // 站/坐在家具上：允许离场（否则会被自己的站位锁死）
    if (pointInRect(a, item.rect, 0) || pointInRect(b, item.rect, 0)) continue;
    // 只是落在家具外扩区里：不能借这个豁免直接穿过家具本体
    if (pointInRect(a, item.rect, pad) || pointInRect(b, item.rect, pad)) {
      if (segmentHitsRect(a, b, item.rect, 0)) return false;
      continue;
    }
    if (segmentHitsRect(a, b, item.rect, pad)) return false;
  }
  return true;
}
function dijkstraPath(nodeMap, edgeMap, startId, endId) {
  if (!nodeMap[startId] || !nodeMap[endId]) return null;
  if (startId === endId) return [startId];
  const dist = new Map([[startId, 0]]);
  const prev = new Map();
  const open = [[0, startId]];
  const seen = new Set();
  while (open.length) {
    open.sort((a, b) => a[0] - b[0]);
    const [d, id] = open.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    if (id === endId) break;
    for (const [next, w] of edgeMap.get(id) || []) {
      const nd = d + w;
      if (nd < (dist.get(next) ?? Infinity)) {
        dist.set(next, nd); prev.set(next, id); open.push([nd, next]);
      }
    }
  }
  if (!dist.has(endId)) return null;
  const out = [];
  let cur = endId;
  while (cur) { out.push(cur); cur = prev.get(cur); }
  return out.reverse();
}

/** 动态地图路由：同房间可见节点直达，跨房间仍走门洞图。 */
export function buildMapRoute(from, target, now, speed = 0.55) {
  if (!Array.isArray(from) || from.length < 2) return null;
  const toPos = Array.isArray(target.pos) ? target.pos : spotOf(target.room, target.spot)?.pos;
  if (!Array.isArray(toPos)) return null;
  const fromRoom = roomAtPoint(from);
  const toRoom = roomAtPoint(toPos);
  if (!fromRoom || !toRoom) return null;
  const nodeMap = {};
  const edgeMap = new Map();
  const addNode = (id, pos) => { nodeMap[id] = pos; if (!edgeMap.has(id)) edgeMap.set(id, []); };
  const addEdge = (a, b) => {
    if (!nodeMap[a] || !nodeMap[b] || a === b) return;
    const d = Math.hypot(nodeMap[a][0] - nodeMap[b][0], nodeMap[a][1] - nodeMap[b][1]);
    edgeMap.get(a).push([b, d]); edgeMap.get(b).push([a, d]);
  };
  for (const [id, p] of Object.entries(NODES)) addNode(id, p);
  const fromId = '__from__', toId = '__to__';
  addNode(fromId, from); addNode(toId, toPos);
  // 原有门洞图：过门边也要过家具检查（用较小的间距，避免把门洞边误删）
  const DOOR_PAD_OK = (a, b) => {
    const ra = roomAtPoint(a)?.id;
    const rb = roomAtPoint(b)?.id;
    for (const item of NAV_KEEPOUT) {
      // 同上：过门边也可能擦到第三个房间的家具
      const pad = item.pad ?? NAV_PAD;
      if (pointInRect(a, item.rect, 0) || pointInRect(b, item.rect, 0)) continue;
      if (pointInRect(a, item.rect, pad) || pointInRect(b, item.rect, pad)) {
        if (segmentHitsRect(a, b, item.rect, 0)) return false;
        continue;
      }
      if (segmentHitsRect(a, b, item.rect, pad)) return false;
    }
    return true;
  };
  for (const [id, list] of ADJ) for (const [next, w] of list) {
    if (!nodeMap[id] || !nodeMap[next]) continue;
    if (!DOOR_PAD_OK(nodeMap[id], nodeMap[next])) continue;
    edgeMap.get(id).push([next, w]);
    if (!edgeMap.get(next).some(([n]) => n === id)) edgeMap.get(next).push([id, w]);
  }
  const outdoor = (room) => room.id === 'garden' || room.id === 'yard' || room.id === 'pool';
  // 室外保持原来的菜畦/小径图：菜畦和围栏不是规则矩形，不能用室内可见性捷径。
  if (outdoor(fromRoom)) addEdge(fromId, nearestNodeInRoom(from, fromRoom.id).id);
  if (outdoor(toRoom)) addEdge(toId, nearestNodeInRoom(toPos, toRoom.id).id);
  if (!outdoor(fromRoom) && !outdoor(toRoom)) {
    // 家具外扩后的四个角点：让路线能贴着家具绕，不用非得走到命名路点再折返。
    const cornerNodes = (roomId) => {
      const out = [];
      let n = 0;
      for (const item of NAV_KEEPOUT) {
        if (item.room !== roomId) continue;
        const pad = (item.pad ?? NAV_PAD) + 0.04;
        const [x0, z0, x1, z1] = item.rect;
        for (const [cx, cz] of [[x0 - pad, z0 - pad], [x1 + pad, z0 - pad], [x1 + pad, z1 + pad], [x0 - pad, z1 + pad]]) {
          const room = roomAtPoint([cx, cz]);
          if (!room || room.id !== roomId) continue;
          const id = `__c${roomId}_${n++}`;
          addNode(id, [cx, cz]);
          out.push([id, [cx, cz]]);
        }
      }
      return out;
    };
    const cf = cornerNodes(fromRoom.id);
    const ct = fromRoom.id === toRoom.id ? cf : cornerNodes(toRoom.id);
    // 同房间可见性捷径：只在同一个矩形房间内，避开大件家具。
    const roomNodes = Object.entries(NODES).filter(([, p]) => roomAtPoint(p)?.id === fromRoom.id).concat(cf);
    const targetNodes = Object.entries(NODES).filter(([, p]) => roomAtPoint(p)?.id === toRoom.id).concat(ct);
    for (const [a] of roomNodes) {
      if (segmentClear(from, nodeMap[a], fromRoom.id)) addEdge(fromId, a);
      for (const [b] of roomNodes) {
        if (a < b && segmentClear(nodeMap[a], nodeMap[b], fromRoom.id)) addEdge(a, b);
      }
    }
    for (const [b] of targetNodes) {
      if (segmentClear(nodeMap[b], toPos, toRoom.id)) addEdge(b, toId);
      for (const [a] of targetNodes) {
        if (a < b && segmentClear(nodeMap[a], nodeMap[b], toRoom.id)) addEdge(a, b);
      }
    }
    // 直线能直接过去（不穿墙、不穿家具）就不经过任何路点；
    // 缓冲太保守时逐档放宽，只影响这一条直连。
    if (!segmentCrossesWall(from, toPos)) {
      const direct = segmentClearTwoRooms(from, toPos, fromRoom.id, toRoom.id, 1);
      if (direct) addEdge(fromId, toId);
    }
  } else {
    // 一端在室外：室内/室外端点各接最近路点，跨房间仍然只走已有门洞图。
    if (!outdoor(fromRoom)) {
      const roomNodes = Object.entries(NODES).filter(([, p]) => roomAtPoint(p)?.id === fromRoom.id);
      for (const [a] of roomNodes) if (segmentClear(from, nodeMap[a], fromRoom.id)) addEdge(fromId, a);
    }
    if (!outdoor(toRoom)) {
      const targetNodes = Object.entries(NODES).filter(([, p]) => roomAtPoint(p)?.id === toRoom.id);
      for (const [b] of targetNodes) if (segmentClear(nodeMap[b], toPos, toRoom.id)) addEdge(b, toId);
    }
  }
  const ids = dijkstraPath(nodeMap, edgeMap, fromId, toId);
  if (!ids) return null;
  const points = ids.map((id) => nodeMap[id].slice());
  const total = polylineLength(points);
  return { points, departAt: now, arriveAt: now + Math.max(1, total / speed * 1000), speed, target };
}

/** 从当前点走到目标 spot：按地图可见性选最近路线。 */
export function buildRoute(from, fromSpotDef, target, now, speed = 0.55) {
  if (!Array.isArray(from) || from.length < 2) return null;
  const toSpotDef = spotOf(target.room, target.spot);
  const toPos = Array.isArray(target.pos) ? target.pos : toSpotDef?.pos;
  if (!toPos) return null;
  const mapped = buildMapRoute(from, { ...target, pos: toPos }, now, speed);
  if (mapped) return mapped;
  // 极端情况下（房间数据不完整）保底走原来的门洞图。
  const startId = fromSpotDef?.access || nearestNode(from).id;
  const endId = target.access || toSpotDef?.access || nearestNode(toPos).id;
  const nodes = graphPath(startId, endId);
  if (!nodes) return null;
  const points = [from, ...nodes];
  const end = toPos.slice();
  if (Math.hypot(points.at(-1)[0] - end[0], points.at(-1)[1] - end[1]) > 0.04) points.push(end);
  const total = polylineLength(points);
  return { points, departAt: now, arriveAt: now + Math.max(1, total / speed * 1000), speed, target };
}

export function polylineLength(points) {
  let d = 0;
  for (let i = 1; i < points.length; i += 1) d += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return d;
}

export function positionOnRoute(route, now) {
  if (!route?.points?.length) return null;
  const pts = route.points;
  if (now <= route.departAt) return pts[0].slice();
  const traveled = Math.max(0, (now - route.departAt) / 1000 * route.speed);
  let left = traveled;
  for (let i = 1; i < pts.length; i += 1) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (left <= seg) {
      const t = seg ? left / seg : 0;
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
    }
    left -= seg;
  }
  return pts.at(-1).slice();
}

// 上/下座插值：t=0 在地面座点，t=1 在座面上
function seatLerp(seg, now) {
  const t = Math.max(0, Math.min(1, (now - seg.t0) / Math.max(1, seg.dur)));
  const e = t * t * (3 - 2 * t);
  const x = seg.from[0] + (seg.to[0] - seg.from[0]) * e;
  const z = seg.from[1] + (seg.to[1] - seg.from[1]) * e;
  const y = (seg.seatY || 0) * (seg.up ? e : 1 - e);
  return { pos: [x, z], elev: y, done: t >= 1 };
}

export function currentPosition(state, now) {
  if (state.mounting) return seatLerp(state.mounting, now).pos;
  if (state.dismounting) return seatLerp(state.dismounting, now).pos;
  if (state.route) {
    const p = positionOnRoute(state.route, now);
    if (p) return p;
  }
  if (state.spot === 'free' && Array.isArray(state.freePos)) return state.freePos.slice();
  return spotOf(state.room, state.spot)?.pos?.slice() || [6.3, 5.1];
}

export function currentFacing(state, now) {
  if (state.route) {
    const pts = state.route.points;
    const pos = positionOnRoute(state.route, now) || pts[0];
    let best = null;
    let bestD = Infinity;
    for (let i = 1; i < pts.length; i += 1) {
      const mx = (pts[i - 1][0] + pts[i][0]) / 2;
      const mz = (pts[i - 1][1] + pts[i][1]) / 2;
      const d = Math.hypot(mx - pos[0], mz - pos[1]);
      if (d < bestD) {
        bestD = d;
        best = pts[i];
      }
    }
    if (best) {
      const dx = best[0] - pos[0];
      const dz = best[1] - pos[1];
      if (Math.hypot(dx, dz) > 0.01) return Math.atan2(dx, -dz) * 180 / Math.PI;
    }
  }
  return Number(state.facing) || 0;
}

function emit(state, type, text, now, extra = {}) {
  const cd = EVENT_COOLDOWN[type] ?? 30 * MIN;
  const last = Number(state.lastEventAt?.[type]) || 0;
  if (cd > 0 && now - last < cd) return false;
  state.lastEventAt = { ...(state.lastEventAt || {}), [type]: now };
  state.eventLog.push({
    at: now,
    type,
    text: sanitizeText(text, 140),
    room: extra.room || state.room,
    spot: extra.spot || state.spot
  });
  state.eventLog = state.eventLog.slice(-MAX_EVENT_LOG);
  return true;
}

export function recentEvents(state, now = Date.now(), ttl = EVENT_TTL) {
  return (state.eventLog || []).filter((e) => e.at <= now && now - e.at <= ttl);
}

// 离地高度唯一推导：支撑面 × 姿态（sit/lie 才离地）
function supportY(state) {
  const sp = HOME_LAYOUT.spots[state.room]?.[state.spot];
  const base = Number(SURFACES[sp?.support || 'floor'] ?? 0) || 0;
  return (state.pose === 'sit' || state.pose === 'lie') ? base : 0;
}

function setActivity(state, kind, activity, pose, elev, facing) {
  state.kind = kind || 'idle';
  state.activity = sanitizeText(activity, 80) || '在发呆';
  if (pose) state.pose = pose;
  state.elev = supportY(state);
  if (facing !== undefined) state.facing = Number(facing) || 0;
  state.walking = false;
}

function beginRoute(state, target, now, env = {}) {
  // 从坐具上离开：先退到座点并落地，再开始寻路
  {
    const cur = spotOf(state.room, state.spot);
    const curY = Number(SURFACES[cur?.support || 'floor'] || 0);
    if (!state.dismounting && curY > 0.05 && Array.isArray(cur?.mount) && !state.route) {
      state.dismounting = {
        from: (cur.pos || currentPosition(state, now)).slice(),
        to: cur.mount.slice(),
        seatY: curY,
        t0: now,
        dur: 520,
        up: false,
        target
      };
      state.elev = curY;
      state.pose = 'stand';
      state.kind = 'idle';
      state.activity = '起身';
      state.walking = false;
      state.route = null;
      state.spot = 'free';
      state.freePos = cur.mount.slice();
      return;
    }
  }
  const prevRoom = state.room;
  const speed = target.urgent ? 1.45 : 1.05;
  const rawFrom = currentPosition(state, now);
  const fromSpotDef = state.route ? null : (spotOf(state.room, state.spot) || (state.spot === 'free' ? { access: nearestNodeInRoom(rawFrom, state.room).id, pos: rawFrom } : null));
  const destSpotDef = spotOf(target.room, target.spot);
  const destSeatY = Number(SURFACES[destSpotDef?.support || 'floor'] || 0);
  const mountTo = destSeatY > 0.05 && Array.isArray(destSpotDef?.mount) ? destSpotDef.mount : null;
  const curSeatY = fromSpotDef ? Number(SURFACES[fromSpotDef.support || 'floor'] || 0) : 0;
  const mountFrom = curSeatY > 0.05 && Array.isArray(fromSpotDef?.mount) ? fromSpotDef.mount : null;
  // 从坐具起身：先从固定座点下到地面，再走；上座：路线终点就是固定座点
  const fromPos = mountFrom ? mountFrom.slice() : rawFrom;
  const routeTarget = mountTo ? { ...target, pos: mountTo.slice() } : target;
  const route = buildRoute(fromPos, fromSpotDef, routeTarget, now, speed);
  if (route) route.target = target;
  // 没有显式 mount 的坐具（旧数据）：退回「沿最后一段退 0.5m」的近似做法
  if (!mountTo && route && Array.isArray(route.points) && route.points.length >= 2) {
    if (destSeatY > 0.05) {
      const pts = route.points;
      const last = pts[pts.length - 1];
      const prev = pts[pts.length - 2];
      const dx = last[0] - prev[0];
      const dz = last[1] - prev[1];
      const len = Math.hypot(dx, dz);
      const back = 0.5;
      if (len > back + 0.05) {
        pts[pts.length - 1] = [last[0] - (dx / len) * back, last[1] - (dz / len) * back];
        const total = polylineLength(pts);
        route.arriveAt = route.departAt + Math.max(1, (total / speed) * 1000);
      }
    }
  }
  if (!route) {
    // 同一站位：不造路线，直接摆好，让它进入停留。
    state.room = target.room;
    state.spot = target.spot;
    if (target.spot === 'free' && Array.isArray(target.pos)) state.freePos = target.pos.slice();
    setActivity(state, target.kind, target.actText, target.pose, target.elev, target.facing);
    state.clip = target.clip || null;
    if (target.clip === '游泳') startSwim(state, now);
    state.dwell = { until: now + Math.max(1, target.dwellMs || 0), target };
    // 原地就是目标点（没造路线）也要享受同样的清醒保护期。
    if (target.awakeHold) state.awakeUntil = Math.max(Number(state.awakeUntil) || 0, now + 9 * MIN);
    return;
  }
  state.route = route;
  state.room = target.room;
  state.spot = target.spot;
  if (target.spot === 'free' && Array.isArray(target.pos)) state.freePos = target.pos.slice();
  else if (target.spot !== 'free') state.freePos = null;
  state.pose = 'stand';
  state.elev = 0;
  state.facing = target.facing ?? state.facing;
  state.kind = 'walk';
  state.activity = target.walkText || `往${ROOM_NAMES[target.room] || '屋里'}走`;
  state.walking = true;
  // 详细日志：只在跨房间时记「出发」，同房间走动由到达日志体现，避免刷屏
  if (prevRoom && target.room !== prevRoom) {
    const destRoom = ROOM_NAMES[target.room] || target.room;
    const destSpot = HOME_LAYOUT.spots[target.room]?.[target.spot]?.label || '';
    emit(state, 'depart', `去${destRoom}${destSpot ? '·' + destSpot : ''}`, now, { room: target.room, spot: target.spot });
  }
}

function arrive(state, now) {
  const route = state.route;
  state.route = null;
  const t = route.target;
  state.room = t.room;
  state.spot = t.spot;
  if (t.spot === 'free' && Array.isArray(t.pos)) state.freePos = t.pos.slice();
  state.arrivedAt = now;
  // 睡眠只在「已经到床」这一帧生效；路上 sleeping=false，客户端不会播睡眠动画。
  if (t.effect === 'sleep' && t.room === 'her_room' && t.spot === 'bed') {
    state.sleepPending = false;
    const bedDef = spotOf(t.room, t.spot);
    const bedY = Number(SURFACES[bedDef?.support || 'floor'] || 0);
    if (bedY > 0.05 && Array.isArray(bedDef?.mount)) {
      // 先「爬床」，过渡结束再钻进被窝
      state.mounting = {
        from: bedDef.mount.slice(),
        to: (bedDef.pos || [0, 0]).slice(),
        seatY: bedY,
        t0: now,
        dur: 700,
        up: true,
        target: t,
        sleepAfter: true
      };
      state.pose = 'stand';
      state.elev = 0;
      state.kind = 'idle';
      state.activity = '爬上床';
      state.walking = false;
      state.dwell = null;
      return;
    }
    state.asleep = true;
    state.lamp = false;
    setActivity(state, 'sleep', t.actText || '钻进被窝，闭上眼', 'lie', 0.52, 180);
    emit(state, 'sleep', '关了灯，钻进被窝', now, { room: 'her_room', spot: 'bed' });
    state.dwell = null;
    return;
  }
  // 坐具：不瞬移，走「座点 → 座面」的上座过渡
  {
    const spDef = spotOf(t.room, t.spot);
    const seatY = Number(SURFACES[spDef?.support || 'floor'] || 0);
    if (seatY > 0.05 && Array.isArray(spDef?.mount)) {
      state.mounting = {
        from: spDef.mount.slice(),
        to: (spDef.pos || currentPosition(state, now)).slice(),
        seatY,
        t0: now,
        dur: 620,
        up: true,
        target: t
      };
      state.pose = 'stand';
      state.elev = 0;
      state.kind = 'idle';
      state.activity = '坐上去';
      state.walking = false;
      state.dwell = null;
      return;
    }
  }
  setActivity(state, t.kind, t.actText, t.pose, t.elev, t.facing);
  state.clip = t.clip || null;
  if (t.clip === '游泳') startSwim(state, now);
  state.dwell = { until: now + Math.max(0, Number(t.dwellMs) || 0), target: t };
  // 详细日志：到了、开始做什么
  {
    const where = HOME_LAYOUT.spots[t.room]?.[t.spot]?.label || ROOM_NAMES[t.room] || '那边';
    emit(state, 'arrive', `${where}：${t.actText || '待着'}`, now, { room: t.room, spot: t.spot });
  }
  // 被主人指到某个位置：到了之后至少清醒活动 9 分钟，别一落地就自己摸回床上。
  if (t.awakeHold) state.awakeUntil = Math.max(Number(state.awakeUntil) || 0, now + 9 * MIN);
}

function applyEffect(state, target, now, env) {
  const effect = target.effect;
  const n = state.needs;
  // 这些动作做完要回到「站着」，不然动画会一直循环播放
  const settleToIdle = () => {
    if (state.asleep || state.walking || state.route) return;
    setActivity(state, 'idle', '把杯子放下，站着发会儿呆', 'stand', 0, state.facing);
  };
  if (effect === 'drink') { n.thirst = clamp01(n.thirst - 0.55); settleToIdle(); }
  else if (effect === 'eat') { n.hunger = clamp01(n.hunger - 0.52); settleToIdle(); }
  else if (effect === 'snack') { n.hunger = clamp01(n.hunger - 0.28); settleToIdle(); }
  else if (effect === 'toilet') n.bladder = clamp01(0.06);
  else if (effect === 'brush') { n.energy = clamp01(n.energy + 0.06); n.hygiene = 0.15; }
  else if (effect === 'shower') { n.energy = clamp01(n.energy + 0.06); n.hygiene = 0.03; }
  else if (effect === 'balcony') n.energy = clamp01(n.energy + 0.02);
  else if (effect === 'tv') n.energy = clamp01(n.energy - 0.02);
  else if (effect === 'desk') n.energy = clamp01(n.energy - 0.03);
  else if (effect === 'phone') { n.energy = clamp01(n.energy - 0.01); state.lastPhoneAt = now; }
  else if (effect === 'nap') n.energy = clamp01(n.energy + 0.09);
  else if (effect === 'laundry') { /* 只是过日子 */ }
  else if (effect === 'window') { /* 发呆 */ }
  else if (effect === 'sick') { /* 不动 */ }
  else if (effect === 'freestyle_snack') { n.hunger = clamp01(n.hunger - 0.05); settleToIdle(); }
  else if (effect === 'freestyle_move') { n.energy = clamp01(n.energy - 0.02); n.hunger = clamp01(n.hunger + 0.02); settleToIdle(); }
  else if (effect === 'freestyle_rest') { n.energy = clamp01(n.energy + 0.01); settleToIdle(); }
  // 没有专门事件类型的动作，也留一条「做完了」的日志
  const DONE_TEXT = {
    drink: '喝完了一杯水', eat: '吃了点东西', snack: '吃完了零食',
    toilet: '上完厕所了', brush: '洗漱完了', shower: '洗完澡了',
    nap: '打了个盹，醒了', balcony: '吹够风了', tv: '看完了一段',
    desk: '写完了，站起来伸了个懒腰', phone: '看完手机了', laundry: '衣服洗好了'
  };
  if (target.eventType && target.eventText) {
    if (emit(state, target.eventType, target.eventText, now, { room: target.room, spot: target.spot })) {
      state.lastEventAt[target.eventType] = now;
    }
  } else if (effect && DONE_TEXT[effect]) {
    emit(state, 'done', DONE_TEXT[effect], now, { room: target.room, spot: target.spot });
  }
  // 事件消费端（提示词/记忆）只读 15 分钟内的，见 recentEvents。
  if (target.eventType === 'help') state.counts.help += 1;
}

function idleMinutesFor(seed, kind) {
  const base = ({ tv: 9, desk: 8, balcony: 7, nap: 12, eat: 8, drink: 5, bath: 4, toilet: 3, phone: 6, laundry: 6, idle: 4 })[kind] || 6;
  return (base + (hash(`${seed}:${kind}`) % 4)) * MIN;
}

/**
 * 「别急着睡」的保护期截止时间：
 * - 被指令/被指到某个位置（awakeUntil），到达后再清醒活动 9 分钟；
 * - 最近一次交互（lastInteractionAt）后 10 分钟内也不考虑睡觉。
 * 只是推迟睡觉，不禁止；保护期过后仍按精力/时段正常判定。
 */
function sleepHoldUntil(state) {
  return Math.max(
    Number(state.awakeUntil) || 0,
    (Number(state.lastInteractionAt) || 0) + 10 * MIN
  );
}

/**
 * 空闲时从动作目录里抽一个「自由动作」。
 * 只做表演（轻度数值影响），不打断需求/指令/睡觉。
 */
const FREESTYLE_SPOTS = {
  desk: { room: 'her_room', spot: 'desk' },
  sofa: { room: 'living', spot: 'sofa' },
  kitchen: { room: 'kitchen', spot: 'fridge' },
  bed: { room: 'her_room', spot: 'bedside' },
  bathroom: { room: 'bathroom', spot: 'sink' },
  living: { room: 'living', spot: 'rug' },
  balcony: { room: 'balcony', spot: 'chair' },
  pool: { room: 'pool', spot: 'lounger' },
};

function pickFreestyle(state, now, env = {}) {
  const hour = localHour(now);
  const month = new Date(now).getMonth() + 1;
  const mood = Number(env?.emotion?.mood);
  const weather = String(env?.weather || 'clear');
  const recent = Array.isArray(state.recentFreestyle) ? state.recentFreestyle : [];
  const rainy = weather === 'rain' || weather === 'storm' || weather === 'snow';

  const scored = [];
  for (const item of CATALOG) {
    const win = item.win || [[0, 24]];
    if (!win.some(([a, b]) => hour >= a && hour < b)) continue;
    let w = item.weight ?? 1;
    // 节日：只在对应月份附近出现，其余时间几乎不选
    if (item.festivalMonth) w *= (Math.abs(month - item.festivalMonth) <= 0 ? 1.4 : 0.05);
    // 心情：低落时偏情绪类，开心时偏玩耍/才艺
    if (item.group === '情绪') w *= Number.isFinite(mood) && mood < 45 ? 2 : 0.8;
    if (item.group === '玩耍' && Number.isFinite(mood) && mood >= 62) w *= 1.4;
    // 天气：下雨/下雪偏向室内组
    const outdoorSpots = ['balcony', 'pool', 'garden'];
    if (rainy && (item.spots || []).some((x) => outdoorSpots.includes(x))) w *= 0.2;
    if (!rainy && (item.spots || []).some((x) => outdoorSpots.includes(x))) w *= 1.2;
    // 防重复
    if (recent.includes(item.clip)) w *= FREESTYLE_DEFAULTS.repeatPenalty;
    if (w > 0) scored.push([w, item]);
  }
  if (!scored.length) return null;

  scored.sort((a, b) => b[0] - a[0]);
  const top = scored.slice(0, 8);
  const sum = top.reduce((a, [w]) => a + w, 0);
  let r = Math.random() * sum;
  let picked = top[top.length - 1][1];
  for (const [w, item] of top) {
    r -= w;
    if (r <= 0) { picked = item; break; }
  }

  // 是否走到匹配点位
  const spots = (picked.spots || []).filter((x) => x !== 'anywhere' && FREESTYLE_SPOTS[x]);
  const travel = spots.length > 0 && Math.random() < FREESTYLE_DEFAULTS.travelChance;
  const place = travel ? FREESTYLE_SPOTS[spots[Math.floor(Math.random() * spots.length)]] : null;

  // 已经在那个点位就当作就地做
  const sameSpot = place && state.room === place.room && state.spot === place.spot;
  if (place && !sameSpot) {
    return {
      room: place.room,
      spot: place.spot,
      kind: 'freestyle',
      clip: picked.clip,
      actText: `${picked.clip}（${picked.group}）`,
      walkText: `去${ROOM_NAMES[place.room] || '那边'}做点什么`,
      pose: picked.pose || 'stand',
      dwellMs: Math.min(FREESTYLE_DEFAULTS.maxDwellMs, 10_000),
      effect: picked.effect ? `freestyle_${picked.effect}` : null,
      eventType: null,
      eventText: '',
      freestyle: true,
      reason: { by: '空闲调剂', clip: picked.clip, group: picked.group, travel: true, top: top.slice(0, 3).map(([w, it]) => `${it.clip}:${w.toFixed(2)}`) }
    };
  }
  return {
    room: state.room,
    spot: state.spot,
    kind: 'freestyle',
    clip: picked.clip,
    actText: `${picked.clip}（${picked.group}）`,
    pose: picked.pose || 'stand',
    dwellMs: Math.min(FREESTYLE_DEFAULTS.maxDwellMs, 10_000),
    effect: picked.effect ? `freestyle_${picked.effect}` : null,
    eventType: null,
    eventText: '',
    freestyle: true,
    reason: { by: '空闲调剂', clip: picked.clip, group: picked.group, travel: false, top: top.slice(0, 3).map(([w, it]) => `${it.clip}:${w.toFixed(2)}`) }
  };
}

function decideTarget(state, now, env) {
  const hour = localHour(now);
  const n = state.needs;
  const night = hour >= 22.5 || hour < 6.5;
  const immobile = n.pain >= 0.7;
  const inBed = state.room === 'her_room' && state.spot === 'bed' && !state.route;
  // 「别急着睡」保护期内不选任何睡觉/打盹目标。
  const canSleep = now >= sleepHoldUntil(state);

  if (!state.asleep && state.sleepPending) {
    if (inBed) {
      state.sleepPending = false;
      state.asleep = true;
      state.lamp = false;
      setActivity(state, 'sleep', '钻进被窝，闭眼', 'lie', 0.52, 180);
      emit(state, 'sleep', '关了灯，钻进被窝', now, { room: 'her_room', spot: 'bed' });
      return null;
    }
    return { ...TRIPS.sickBed(now), room: 'her_room', spot: 'bed', kind: 'walk', walkText: '困得迷迷糊糊，摸回卧室', actText: '钻进被窝，闭眼', dwellMs: 0, effect: 'sleep', pose: 'lie', elev: 0.52, urgent: false };
  }

  if (state.asleep) {
    if (!inBed) return { ...TRIPS.sickBed(now), room: 'her_room', spot: 'bed', kind: 'walk', walkText: '困得迷迷糊糊，摸回卧室', actText: '钻进被窝，闭眼', dwellMs: 0, effect: 'sleep', pose: 'lie', elev: 0.52, urgent: false };
    return null;
  }

  if (immobile) {
    if (!inBed) return { ...TRIPS.sickBed(now), urgent: true };
    return null;
  }

  if (state.command && now < state.command.until) {
    // 到了就结束这条指令，避免每轮都重新「去同一个地方」。
    if (state.room === state.command.room && state.spot === state.command.spot) {
      state.command = null;
      return null;
    }
    const target = commandTarget(state.command, now);
    if (target) return target;
  }

  // 刚刚被摸/被喂/被说话：先待在原地反应一会儿，不立刻执行需求。
  if (now < state.lastInteractionAt + 2 * MIN) return null;

  if (n.bladder >= 0.82) return { ...TRIPS.toilet(now), urgent: n.bladder >= 0.93 };
  if (n.thirst >= 0.86) return { ...TRIPS.drink(now), urgent: true };
  if (n.hunger >= 0.88) return { ...TRIPS.eat(now), urgent: true };

  // QQ 里有人找她，但优先级低于生理与睡眠，高于「闲逛」。
  if ((env.unread || 0) > 0 && now - (state.lastPhoneAt || 0) > 20 * MIN && !night) return TRIPS.phone(now);

  if (n.bladder >= 0.7) return TRIPS.toilet(now);
  if (n.thirst >= 0.62) return TRIPS.drink(now);
  if (n.hunger >= 0.66) return TRIPS.eat(now);

  if (n.energy < 0.28 && canSleep) {
    if (inBed) return null;
    if (hour >= 21 || hour < 8) return { ...TRIPS.sickBed(now), kind: 'nap', pose: 'lie', elev: 0.52, actText: '困得不行，爬上床躺一会儿', walkText: '困得睁不开眼，往卧室走', eventType: 'nap', eventText: '困得不行，回床上躺了一会儿', dwellMs: 0, effect: 'sleep' };
    return TRIPS.nap(now);
  }

  // 昼夜节律：夜里准备睡；白天按时间段轮换。
  if (night) {
    // 保护期内、或精力还很足时不主动上床：先待在原地清醒着，等条件满足再判睡。
    if (!canSleep || n.energy >= 0.45) return null;
    if (inBed) {
      state.asleep = true;
      state.lamp = false;
      setActivity(state, 'sleep', '钻进被窝，闭眼', 'lie', 0.52, 180);
      emit(state, 'sleep', '关了灯，钻进被窝', now, { room: 'her_room', spot: 'bed' });
      return null;
    }
    return { ...TRIPS.sickBed(now), room: 'her_room', spot: 'bed', kind: 'walk', walkText: '打了个哈欠，关了客厅的灯往卧室走', actText: '钻进被窝，闭眼', dwellMs: 0, effect: 'sleep', pose: 'lie', elev: 0.52 };
  }

  // 空闲调剂：隔一段时间抽一个自主动作（表演性质，不抢需求）
  {
    const nextAt = Number(state.freestyleNextAt) || 0;
    if (!state.route && !state.dwell && !state.walking && now >= nextAt) {
      const act = pickFreestyle(state, now, env);
      if (act) {
        const [lo, hi] = FREESTYLE_DEFAULTS.intervalMs;
        state.freestyleNextAt = now + lo + Math.random() * (hi - lo);
        state.lastFreestyleAt = now;
        const recent = Array.isArray(state.recentFreestyle) ? state.recentFreestyle.slice() : [];
        recent.unshift(act.clip);
        state.recentFreestyle = recent.slice(0, FREESTYLE_DEFAULTS.recentWindow);
        state.freestylePick = act.reason;
        emit(state, 'freestyle', `自己找了点事：${act.clip}`, now, { room: act.room, spot: act.spot });
        return act;
      }
      state.freestyleNextAt = now + 30_000;
    }
  }

  const rotation = (() => {
    if (hour < 9) return ['bathroom', 'sink'];
    if (hour < 12) return ['her_room', 'desk'];
    if (hour < 13.5) return ['kitchen', 'dining'];
    if (hour < 15) return ['living', 'sofa'];
    if (hour < 18) return ['her_room', 'desk'];
    if (hour < 19.5) return ['kitchen', 'dining'];
    if (hour < 22.5) return ['living', 'sofa'];
    return ['her_room', 'bedside'];
  })();
  const key = `${rotation[0]}.${rotation[1]}`;
  if (state.lastDefaultSpot !== key) {
    state.lastDefaultSpot = key;
    if (rotation[1] === 'desk') return TRIPS.desk(now);
    if (rotation[1] === 'sofa') {
      if (n.energy < 0.34 && canSleep) return TRIPS.nap(now);
      return hour >= 19.5 ? TRIPS.tv(now) : TRIPS.balcony(now);
    }
    if (rotation[1] === 'dining') return n.hunger > 0.42 ? TRIPS.dinner(now) : TRIPS.snack(now);
    if (rotation[1] === 'sink') return TRIPS.brush(now);
    if (rotation[1] === 'bedside') return { ...TRIPS.window(now), room: 'her_room', spot: 'bedside', kind: 'idle', walkText: '关了客厅的灯，往卧室走', actText: '在床边坐着，准备睡了' };
    return TRIPS.window(now);
  }

  // 同一个时段待够了，就在几个「打发时间」里换一个，避免像钉在椅子上。
  const options = n.energy < 0.34 && canSleep
    ? [TRIPS.nap(now), TRIPS.tv(now), TRIPS.balcony(now)]
    : hour < 15
      ? [TRIPS.balcony(now), TRIPS.tv(now), TRIPS.desk(now)]
      : hour < 19
        ? [TRIPS.balcony(now), TRIPS.desk(now), TRIPS.tv(now)]
        : [TRIPS.tv(now), TRIPS.balcony(now), TRIPS.desk(now)];
  return hashPick(`${state.seed}:${Math.floor(now / (25 * MIN))}:${state.room}.${state.spot}`, options);
}

function commandTarget(command, now) {
  const sp = HOME_LAYOUT.spots[command.room]?.[command.spot];
  if (!sp) return null;
  const isWater = command.room === 'living' && command.spot === 'water';
  return {
    room: command.room,
    spot: command.spot,
    pose: sp.pose,
    elev: sp.elev || 0,
    facing: sp.facing ?? 0,
    kind: isWater ? 'drink' : 'idle',
    walkText: isWater ? '去饮水机接水' : `往${ROOM_NAMES[command.room] || '屋里'}走`,
    actText: isWater
      ? '喝了杯水，真解渴'
      : (sp.pose === 'sit' ? `到了${sp.label}，坐下来` : sp.pose === 'lie' ? `到了${sp.label}，躺下` : `到了${sp.label}，站在那里`),
    dwellMs: isWater ? 12_000 : 9000,
    effect: isWater ? 'drink' : null,
    eventType: null,
    urgent: false,
    // 到站后保持清醒 9 分钟，避免「刚被指过去又回去睡」。
    awakeHold: true
  };
}

/**
 * 推进状态：需求按真实时间衰减，然后按优先级表决定要不要出门。
 * 纯函数（会返回新对象）；调用方决定什么时候落盘。
 */
export function advanceHomeState(input, now = Date.now(), env = {}) {
  const state = normalizeHomeState(input, now);
  let changed = false;

  const elapsed = Math.max(0, Math.min(now - state.lastTickAt, MAX_ELAPSED_HOURS * HOUR));
  if (elapsed > 0) {
    const h = elapsed / HOUR;
    const prevNeeds = { ...state.needs };
    const n = state.needs;
    n.hunger = clamp01(n.hunger + 0.055 * h);
    n.hygiene = clamp01((n.hygiene ?? 0.1) + 0.06 * h);
    n.thirst = clamp01(n.thirst + 0.085 * h);
    n.bladder = clamp01(n.bladder + 0.095 * h);
    if (state.asleep) {
      // 睡觉回精力：原来 0.12/小时太慢（睡一晚才回满），改成 0.9/小时，
      // 约 1 小时能从见底回到 0.9，观感上「睡一觉就缓过来」。
      n.energy = clamp01(n.energy + 2.0 * h);
      // 睡着时饥饿/口渴/如厕都放慢，醒来才不至于崩溃
      n.hunger = clamp01(n.hunger - 0.02 * h);
      n.thirst = clamp01(n.thirst - 0.02 * h);
      n.bladder = clamp01(n.bladder - 0.01 * h);
    } else {
      n.energy = clamp01(n.energy - 0.042 * h);
    }
    if (n.pain > 0) n.pain = clamp01(n.pain - 0.055 * h);
    if (n.energy < 0.05 && n.pain < 0.28) n.pain = 0.28;
    // 需求越线日志（只记「变糟」的那一次）
    const bucketOf = (v) => (v < 0.4 ? 0 : v < 0.6 ? 1 : v < 0.78 ? 2 : 3);
    const NEED_TEXT = {
      hunger: ['有点饿了', '饿了', '饿得不行'],
      thirst: ['有点渴了', '渴了', '渴得难受'],
    };
    for (const key of ['hunger', 'thirst']) {
      const before = prevNeeds[key], after = state.needs[key];
      const b0 = bucketOf(before), b1 = bucketOf(after);
      if (b1 > b0 && NEED_TEXT[key][b1 - 1]) {
        emit(state, `need_${key}`, NEED_TEXT[key][b1 - 1], now);
      }
    }
    if (bucketOf(1 - state.needs.energy) > bucketOf(1 - prevNeeds.energy) && state.needs.energy < 0.35) {
      emit(state, 'need_energy', '累了，快撑不住了', now);
    }
    if ((state.needs.hygiene ?? 0) >= 0.6 && (prevNeeds.hygiene ?? 0) < 0.6) {
      emit(state, 'need_hygiene', '身上有点黏，该洗洗了', now);
    }
    if (state.needs.bladder >= 0.7 && prevNeeds.bladder < 0.7) {
      emit(state, 'need_bladder', '有点憋，想上厕所', now);
    }
    state.lastTickAt = now;
    changed = true;
  }

  const hour = localHour(now);
  const n = state.needs;
  const immobile = n.pain >= 0.7;
  // 情绪变化日志（跟着 DSH 心情插件走）
  {
    const label = String(env?.emotion?.label || '').trim();
    const mood = Number(env?.emotion?.mood);
    const key = Number.isFinite(mood) ? `${label}|${Math.round(mood / 15)}` : label;
    if (label && key !== state.lastMoodKey) {
      state.lastMoodKey = key;
      const desc = Number.isFinite(mood) ? `${label}（${Math.round(mood)}/100）` : label;
      emit(state, 'mood', `心情变成：${desc}`, now);
    }
  }

  // 睡觉 / 醒来
  // 收紧判定：深夜 + 精力确实很低 + 过了「别急着睡」保护期，才自己上床睡。
  // 被主人指到某处后至少清醒活动 9 分钟（awakeUntil），交互后 10 分钟内也不睡。
  if (!state.asleep && !state.sleepPending && now >= sleepHoldUntil(state)
    && (hour >= 23.5 || hour < 6) && n.energy < 0.45) {
    state.command = null;
    state.nextDecisionAt = 0;
    changed = true;
    if (state.room === 'her_room' && state.spot === 'bed' && !state.route) {
      state.sleepPending = false;
      state.asleep = true;
      state.lamp = false;
      setActivity(state, 'sleep', '钻进被窝，闭眼', 'lie', 0.52, 180);
      emit(state, 'sleep', '关了灯，钻进被窝', now, { room: 'her_room', spot: 'bed' });
    } else {
      // 只是困了，先走回床；asleep 必须等到 arrive() 到 bed 才置 true。
      state.sleepPending = true;
      if (!state.route) setActivity(state, 'walk', '困得迷迷糊糊，往卧室走', 'stand', 0, state.facing);
    }
  }
  if (state.asleep) {
    const inBed = state.room === 'her_room' && state.spot === 'bed';
    if (hour >= 6.8 && hour < 10 && n.energy >= 0.5) {
      state.asleep = false;
      state.lamp = true;
      state.nextDecisionAt = now + 2 * MIN;
      state.reactionUntil = now + 12_000;
      setActivity(state, 'wake', '刚醒，赖在床上不想动', 'lie', 0.52, 180);
      emit(state, 'wake', '睡醒了，伸了个懒腰', now, { room: 'her_room', spot: 'bed' });
      changed = true;
    }
    if (state.asleep && inBed) {
      if (state.lamp) { state.lamp = false; changed = true; }
      if (state.kind !== 'sleep') { setActivity(state, 'sleep', '睡着了', 'lie', 0.52, 180); changed = true; }
    }
  }

  // 被动状态（疼到起不来）下的「求助」与床边水，不占用正常决策。
  if (!state.asleep && immobile && state.room === 'her_room' && state.spot === 'bed') {
    if (!state.dwell && state.kind !== 'help' && state.kind !== 'sick') {
      setActivity(state, 'sick', '烧得厉害，裹着被子躺着', 'lie', 0.52, 180);
      changed = true;
    }
    if (state.bedsideWater && n.thirst > 0.72) {
      state.bedsideWater = false;
      n.thirst = clamp01(n.thirst - 0.32);
      emit(state, 'drink', '伸手够到床边的水，喝了一口', now, { room: 'her_room', spot: 'bed' });
      changed = true;
    }
    if ((n.thirst > 0.8 || n.hunger > 0.8) && now - (state.lastEventAt.help || 0) > 26 * MIN) {
      if (emit(state, 'help', n.thirst > n.hunger ? '渴得嗓子发干，喊了一声：有人吗……' : '饿得胃疼，喊了一声：有人吗……', now, { room: 'her_room', spot: 'bed' })) {
        state.counts.help += 1;
        state.activity = '裹着被子，小声喊人';
        state.kind = 'help';
        changed = true;
      }
    }
  }

  // 上座推进
  if (state.mounting) {
    const seg = seatLerp(state.mounting, now);
    state.elev = seg.elev;
    if (seg.done) {
      const t = state.mounting.target;
      const sleepAfter = state.mounting.sleepAfter === true;
      state.mounting = null;
      state.elev = seg.elev;
      if (sleepAfter) {
        state.asleep = true;
        state.lamp = false;
        setActivity(state, 'sleep', t.actText || '钻进被窝，闭上眼', 'lie', seg.elev, 180);
        emit(state, 'sleep', '关了灯，钻进被窝', now, { room: 'her_room', spot: 'bed' });
        state.dwell = null;
      } else {
        setActivity(state, t.kind, t.actText, t.pose, t.elev, t.facing);
        state.clip = t.clip || null;
        state.dwell = { until: now + Math.max(0, Number(t.dwellMs) || 0), target: t };
      }
      changed = true;
    } else {
      changed = true;
    }
  }

  // 下座推进：落地后重新开始寻路
  if (state.dismounting) {
    const seg = seatLerp(state.dismounting, now);
    state.elev = seg.elev;
    if (seg.done) {
      const target = state.dismounting.target;
      state.dismounting = null;
      state.elev = 0;
      state.spot = 'free';
      state.freePos = seg.pos.slice();
      beginRoute(state, target, now, env);
    }
    changed = true;
  }

  // 路线推进
  if (state.route && now >= state.route.arriveAt) {
    arrive(state, now);
    changed = true;
  }

  // 停留结算：到了不算做了，dwell 之后才结算 + 写事件。
  // Garden effects commit atomically with the garden save in garden-autonomy.js.
  // Keep this completed dwell locked until the coordinator acknowledges it.
  if (state.dwell && now >= state.dwell.until && !state.dwell.target?.gardenJobId) {
    const target = state.dwell.target;
    const doneAt = state.dwell.until;
    state.dwell = null;
    applyEffect(state, target, doneAt, env);
    if (target?.effect === 'sleep') {
      state.asleep = true;
      state.lamp = false;
      setActivity(state, 'sleep', '睡着了', 'lie', 0.52, 180);
      emit(state, 'sleep', '关了灯，钻进被窝', doneAt, { room: 'her_room', spot: 'bed' });
    }
    state.nextDecisionAt = now + idleMinutesFor(state.seed, target?.kind || state.kind);
    changed = true;
  }

  // 正在反应/发呆：不打断。
  if (state.reactionUntil && now >= state.reactionUntil) {
    state.reactionUntil = 0;
    if (/^react_|^wake$/.test(state.kind)) setActivity(state, 'idle', '安静下来，继续做自己的事', state.pose, state.elev, state.facing);
    changed = true;
  }
  if (now < state.reactionUntil) return { state, changed };

  // 鼠标指点：立即覆盖当前停留/路线（go 动作已经把 route 清掉，这里兜底）。
  if (state.freeTarget) {
    if (now > state.freeTarget.until) {
      state.freeTarget = null;
      changed = true;
    } else {
      const target = freeTargetFor(state.freeTarget.pos, state, now);
      state.freeTarget = null;
      if (target) {
        beginRoute(state, target, now, env);
        changed = true;
        return { state, changed };
      }
    }
  }

  if (state.asleep) {
    if (!(state.room === 'her_room' && state.spot === 'bed')) {
      if (!state.route && !state.dwell) {
        const bed = { ...TRIPS.sickBed(now), room: 'her_room', spot: 'bed', kind: 'walk', walkText: '困得迷迷糊糊，摸回卧室', actText: '钻进被窝，闭眼', dwellMs: 0, effect: 'sleep', pose: 'lie', elev: 0.52 };
        beginRoute(state, bed, now, env);
        changed = true;
      }
    }
    return { state, changed };
  }

  if (immobile && !(state.room === 'her_room' && state.spot === 'bed')) {
    if (!state.route && !state.dwell) {
      beginRoute(state, { ...TRIPS.sickBed(now), urgent: true }, now, env);
      changed = true;
    }
    return { state, changed };
  }

  if (state.route || state.dwell) return { state, changed };

  const critical = n.bladder >= 0.93 || n.thirst >= 0.9 || n.hunger >= 0.93 || n.pain >= 0.7;
  // The caretaker may claim idle time, never sleep, commands, or bodily needs.
  if (env.gardenReady && !(state.command && now < state.command.until) && !state.sleepPending && !critical
    && n.thirst < .62 && n.hunger < .66 && n.bladder < .7 && n.energy >= .35 && n.pain < .28) return { state, changed };
  if (now < state.nextDecisionAt && !critical) return { state, changed };

  const target = decideTarget(state, now, env);
  if (!target) {
    if (state.room !== 'her_room' || state.spot !== 'bed') state.nextDecisionAt = now + 4 * MIN;
    return { state, changed };
  }
  if (target.room === state.room && target.spot === state.spot) {
    setActivity(state, target.kind, target.actText, target.pose, target.elev, target.facing);
    state.clip = target.clip || null;
    state.dwell = { until: now + Math.max(1, target.dwellMs || 0), target };
    state.walking = false;
  } else {
    beginRoute(state, target, now, env);
  }
  changed = true;
  return { state, changed };
}

/**
 * 页面/QQ 的一次交互。不落盘；调用方决定何时 save。
 * action: visit/pet/poke/feed/water/play/talk/sleep/wake/lamp/command/go/place/sick/heal
 */
/**
 * 点击/摸头反应：只读 DSH 心情快照（0~100 + dims 0~100），不写回心情。
 * 返回 kind 决定动画；texts 由种子挑一句。
 */
function choosePetReaction(s, emotion) {
  const mood = Number(emotion?.mood);
  const d = (name) => Number(emotion?.dims?.[name]) || 0;
  if (s.asleep) {
    const low = (Number.isFinite(mood) && mood < 42) || d('sad') >= 20 || d('worry') >= 20;
    return {
      kind: 'sleep',
      texts: low
        ? ['睡梦里皱了下眉，往被子里缩了缩', '睡梦里没醒，只把手往被角里藏了藏']
        : ['睡梦里往你手心里蹭了蹭，没醒', '睡梦里尾巴轻轻晃了一下，呼吸很稳']
    };
  }
  if (Number(s.needs.pain) >= 0.45) {
    return { kind: 'react_scare', texts: ['疼得缩了一下，小声说：轻一点……', '被碰到不舒服的地方，倒吸了一口凉气'] };
  }
  if (d('jealous') >= 20 || d('heartache') >= 20) {
    return { kind: 'react_shy', texts: ['……哼，只准摸一下，别得寸进尺', '明明还在别扭，尾巴却先靠过来了', '别过脸去，耳朵尖却红了'] };
  }
  if ((Number.isFinite(mood) && mood < 42) || d('sad') >= 20 || d('worry') >= 20) {
    return { kind: 'idle_look', texts: ['被你摸了摸，没躲，只是轻轻叹了口气', '把脸往你手心靠了一会儿，没说话', '低着头，往你手边又挪近了半步'] };
  }
  if ((Number.isFinite(mood) && mood >= 62) || d('happy') >= 20 || d('sweet') >= 20) {
    return { kind: 'react_happy', texts: ['被摸了摸头，尾巴晃得停不下来', '被摸了摸头，忍不住往你手心蹭', '眯起眼睛，尾巴尖抖了抖'] };
  }
  return { kind: 'react_shy', texts: ['被摸了摸头，耳朵尖红了一下', '被摸了摸头，小声嗯了一声', '侧过脸，用尾巴轻轻碰了碰你的手'] };
}

export function applyHomeAction(state, input = {}) {
  const now = Number(input.at) || Date.now();
  const s = normalizeHomeState(state, now);
  const action = String(input.action || '').trim();
  if (!HOME_ACTIONS.includes(action)) return { state: s, changed: false, event: null };
  const text = sanitizeText(input.text, 120);
  const inBed = s.room === 'her_room' && s.spot === 'bed' && !s.route && !s.walking;
  let event = null;

  if (action === 'visit') {
    if (now - s.lastVisitAt < 30 * MIN) return { state: s, changed: false, event: null };
    s.lastVisitAt = now;
    s.visits += 1;
    event = { type: 'visit', text: '你来家里坐了坐' };
    emit(s, 'visit', '你来家里坐了坐', now);
  } else if (action === 'pet') {
    s.counts.pet += 1;
    s.lastInteractionAt = now;
    s.reactionUntil = now + 9_000;
    s.needs.energy = clamp01(s.needs.energy + 0.01);
    const reaction = choosePetReaction(s, input.emotion);
    const reactionText = pickText(`${s.seed}:pet:${reaction.kind}`, reaction.texts);
    if (s.asleep) {
      // 睡着时不换姿势/动画，只让气泡回一句睡梦里的反应。
      s.activity = reactionText;
    } else if (!s.walking) {
      // 点击优先打断「到了之后坐着」的 dwell，让心情动画真的播出来；
      // 正在走路则不打断路线，只让 response 里的 reaction 气泡回应。
      s.dwell = null;
      setActivity(s, reaction.kind, reactionText, s.pose, s.elev, s.facing);
    }
    event = { type: 'pet', text: '你摸了摸她的头', reaction: reactionText };
  } else if (action === 'poke') {
    s.counts.poke += 1;
    s.lastInteractionAt = now;
    s.reactionUntil = now + 6_000;
    if (!s.walking && !s.dwell) setActivity(s, 'react_scare', '被戳了一下，吓了一跳', s.pose, s.elev, s.facing);
    event = { type: 'poke', text: '你戳了她一下' };
  } else if (action === 'feed') {
    s.counts.feed += 1;
    s.needs.hunger = clamp01(s.needs.hunger - 0.36);
    s.lastInteractionAt = now;
    s.reactionUntil = now + 12_000;
    if (!s.walking && !s.dwell) setActivity(s, 'eat', '叼着小鱼干，嚼得很认真', s.pose, s.elev, s.facing);
    emit(s, 'feed', '你喂了她一块小鱼干', now);
    event = { type: 'feed', text: '你喂了她一块小鱼干' };
  } else if (action === 'water') {
    s.counts.water += 1;
    // 喝水只是个小动作，不该像摸摸头那样把「反应保护期」拉满 2 分钟，
    // 否则她会捧着杯子在饮水机旁站到两分钟，动画一直循环。
    s.lastInteractionAt = now - 100_000;
    const waterSpot = HOME_LAYOUT.spots.living?.water;
    const here = currentPosition(s, now);
    // 只要没贴着饮水机，就先走过去；贴得很近才就地喝
    const far = waterSpot && Array.isArray(here)
      && Math.hypot(here[0] - waterSpot.pos[0], here[1] - waterSpot.pos[1]) > 0.3;
    if (far && !s.asleep) {
      // 先去饮水机旁，到了再喝（client 会播举杯动画）
      s.command = { room: 'living', spot: 'water', until: now + 30_000, by: '访客' };
      s.dwell = null;
      s.kind = 'walk';
      emit(s, 'water', '你让她去接杯水', now);
      event = { type: 'water', text: '你让她去接杯水' };
    } else {
      s.reactionUntil = now + 12_000;
      // 直接在水边喝：同样走 dwell 结算，12 秒后自动回到站立待机，
      // 否则 kind 会一直停在 drink，动画无限循环。
      if (!s.walking) {
        setActivity(s, 'drink', '捧着杯子，小口小口喝水', s.pose, s.elev, s.facing);
        s.dwell = {
          until: now + 12_000,
          target: {
            room: 'living', spot: 'water', kind: 'drink',
            actText: '捧着杯子，小口小口喝水', pose: s.pose, elev: s.elev, facing: s.facing,
            effect: 'drink', eventType: 'water', eventText: '喝完了一杯水'
          }
        };
      }
      emit(s, 'water', '喝了杯水，真解渴', now);
      event = { type: 'water', text: '喝了杯水，真解渴' };
    }
  } else if (action === 'play') {
    s.counts.play += 1;
    s.needs.energy = clamp01(s.needs.energy + 0.02);
    s.lastInteractionAt = now;
    s.reactionUntil = now + 10_000;
    if (!s.walking && !s.dwell) setActivity(s, 'play', '被人拉着玩了一会儿，笑出了声', s.pose, s.elev, s.facing);
    event = { type: 'play', text: '你陪她玩了一会儿' };
  } else if (action === 'talk') {
    if (!text) return { state: s, changed: false, event: null };
    s.counts.talk += 1;
    s.lastInteractionAt = now;
    s.reactionUntil = now + 8_000;
    if (!s.walking && !s.dwell) setActivity(s, 'idle', '停下来听你说话，尾巴尖晃了晃', s.pose, s.elev, s.facing);
    event = { type: 'talk', text: `你留了句话：「${text}」` };
  } else if (action === 'go') {
    if (s.asleep) return { state: s, changed: false, event: null };
    const p = normalizeFreePoint(input.pos);
    if (!p) return { state: s, changed: false, event: null };
    const from = currentPosition(s, now);
    const fromRoom = roomAtPoint(from);
    s.command = null;
    s.sleepPending = false;
    s.reactionUntil = 0;
    s.dwell = null;
    s.route = null;
    s.walking = false;
    s.freePos = normalizeFreePoint(from) || s.freePos || null;
    s.room = fromRoom?.id || s.room;
    s.spot = s.freePos ? 'free' : s.spot;
    s.pose = 'stand';
    s.elev = 0;
    s.freeTarget = { pos: p, until: now + 5 * MIN };
    s.nextDecisionAt = 0;
    s.awakeUntil = Math.max(Number(s.awakeUntil) || 0, now + 10 * MIN);
    const dx = p[0] - from[0];
    const dz = p[1] - from[1];
    if (Math.hypot(dx, dz) > 0.2) s.facing = Math.atan2(dx, -dz) * 180 / Math.PI;
    setActivity(s, 'walk', '往你指的地方走', 'stand', 0, s.facing);
    event = { type: 'go', text: '你指了一个地方' };
  } else if (action === 'place') {
    if (s.asleep) return { state: s, changed: false, event: null };
    const p = normalizeFreePoint(input.pos, { preserveOutdoor: input.free === true });
    if (!p) return { state: s, changed: false, event: null };
    const room = roomAtPoint(p);
    if (!room) return { state: s, changed: false, event: null };
    s.command = null;
    s.sleepPending = false;
    s.reactionUntil = 0;
    s.dwell = null;
    s.route = null;
    s.freeTarget = null;
    s.walking = false;
    s.freePos = p;
    s.room = room.id;
    s.spot = 'free';
    s.pose = 'stand';
    s.elev = 0;
    s.nextDecisionAt = now + 5 * MIN;
    s.awakeUntil = Math.max(Number(s.awakeUntil) || 0, now + 9 * MIN);
    setActivity(s, 'idle', '被你放到这里，站稳了', 'stand', 0, s.facing);
    event = { type: 'place', text: '你把她抱到了这里' };
  } else if (action === 'sleep') {
    s.command = null;
    s.nextDecisionAt = 0;
    s.sleepPending = true;
    s.dwell = null;
    if (inBed) {
      s.asleep = true;
      s.sleepPending = false;
      s.lamp = false;
      setActivity(s, 'sleep', '睡着了', 'lie', 0.52, 180);
    } else {
      s.asleep = false;
      setActivity(s, 'walk', '困了，往卧室走', 'stand', 0, s.facing);
    }
    emit(s, 'sleep', '关了灯，钻进被窝', now);
    event = { type: 'sleep', text: '你哄她睡觉' };
  } else if (action === 'wake') {
    const wasSleepPending = s.sleepPending && !s.asleep;
    if (!s.asleep && !wasSleepPending) return { state: s, changed: false, event: null };
    s.asleep = false;
    s.sleepPending = false;
    s.lamp = true;
    s.reactionUntil = now + 10_000;
    // 被叫醒也是一次交互：给一段清醒保护期，别下一帧又自动睡回去。
    s.lastInteractionAt = now;
    s.awakeUntil = Math.max(Number(s.awakeUntil) || 0, now + 9 * MIN);
    if (wasSleepPending) {
      // 她还在去床的路上：叫住她，不要继续走到床上然后自动睡着。
      s.route = null;
      s.dwell = null;
      setActivity(s, 'idle', '被叫住，停在原地', 'stand', 0, s.facing);
    } else {
      setActivity(s, 'wake', '被叫醒，揉着眼睛赖床', 'lie', 0.52, 180);
    }
    s.needs.energy = clamp01(s.needs.energy + 0.04);
    emit(s, 'wake', '被叫醒，迷迷糊糊坐起来', now);
    event = { type: 'wake', text: '你把她叫醒了' };
  } else if (action === 'clip') {
    // QQ / 外部点播某个动画（268 个目录动作 + 基础片段都支持）
    const clip = sanitizeText(input.clip, 40);
    if (!clip) return { state: s, changed: false, event: null };
    // 睡着时被点播：先叫醒，否则下一帧又会被睡眠状态覆盖回睡觉动作
    if (s.asleep) { s.asleep = false; s.sleepPending = false; s.lamp = true; }
    s.command = null;
    s.route = null;
    s.walking = false;
    s.reactionUntil = now + 15_000;
    s.kind = 'freestyle';
    s.clip = clip;
    s.activity = `${clip}（你点的）`;
    s.dwell = {
      until: now + 15_000,
      target: { room: s.room, spot: s.spot, kind: 'freestyle', clip, actText: `${clip}（你点的）`, pose: s.pose, elev: s.elev, facing: s.facing, effect: null }
    };
    if (clip === '游泳' || clip.toLowerCase() === 'swim') {
      // 游泳不是站着演：挪到泳池水面，交给状态里的 swim 描述做来回游
      startSwim(s, now);
      s.dwell = { until: now + SWIM_LANE.totalMs, target: { room: 'pool', spot: 'deck_w', kind: 'swim', clip: '游泳', actText: '在泳池里游来游去', pose: 'stand', elev: 0, facing: s.facing, effect: null } };
      s.freestylePick = { by: '你点的', clip, group: '运动', travel: false, top: [] };
      event = { type: 'play', text: '你让她去游泳了' };
      emit(s, 'clip', '在泳池里游来游去', now);
    } else {
    s.freestylePick = { by: '你点的', clip, group: '', travel: false, top: [] };
    event = { type: 'play', text: `你点了「${clip}」` };
    emit(s, 'clip', `演了「${clip}」`, now);
    }
  } else if (action === 'say') {
    // 让她在房间气泡里说一句话（QQ 里说的话可以同步过来）
    const words = sanitizeText(input.text, 140);
    if (!words) return { state: s, changed: false, event: null };
    s.sayText = words;
    s.sayUntil = now + 12_000;
    s.lastSayAt = now;
    event = { type: 'say', text: words };
    emit(s, 'say', `说了一句：「${words}」`, now);
  } else if (action === 'lamp') {
    s.lamp = input.on !== undefined ? !!input.on : !s.lamp;
    if (s.asleep) s.lamp = false;
    event = { type: 'lamp', text: s.lamp ? '你把灯打开了' : '你把灯关闭了' };
    emit(s, 'lamp', event.text, now);
  } else if (action === 'command') {
    const room = String(input.room || '').trim();
    const spot = String(input.spot || '').trim();
    if (!HOME_LAYOUT.spots[room]?.[spot]) return { state: s, changed: false, event: null };
    s.command = { room, spot, until: now + 5 * MIN, by: sanitizeText(input.by, 24) };
    s.nextDecisionAt = 0;
    s.reactionUntil = 0;
    s.sleepPending = false;
    // 这是「主人让她去哪」：记一次交互，并给到站后的清醒保护期兜底。
    s.lastInteractionAt = now;
    s.awakeUntil = Math.max(Number(s.awakeUntil) || 0, now + 10 * MIN);
    // 用户点「让她去」时，不能让她先把上一段「到了沙发坐下」的停留耗完；
    // 清掉 dwell，下一次 advance 立即出发。
    s.dwell = null;
    event = { type: 'command', text: `你让她去${HOME_LAYOUT.spots[room][spot].label}` };
  } else if (action === 'sick') {
    s.needs.pain = 0.82;
    s.needs.energy = Math.min(s.needs.energy, 0.2);
    s.command = null;
    s.nextDecisionAt = 0;
    emit(s, 'sick', '突然发起了烧，浑身没力气', now);
    event = { type: 'sick', text: '发烧了' };
  } else if (action === 'heal') {
    s.needs.pain = 0;
    s.bedsideWater = true;
    s.nextDecisionAt = 0;
    emit(s, 'recover', '烧退了，身上轻快了些', now);
    event = { type: 'recover', text: '退烧了' };
  }

  s.updatedAt = now;
  return { state: s, changed: true, event };
}

function pickText(seed, arr) {
  return arr[hash(String(seed)) % arr.length];
}

/**
 * 移动时用哪种跑姿（只影响表现，不新增事实状态）：
 * - happy：开心小跑；心情好、不紧急时概率高；
 * - hurry：侧身急躁跑；身体急/疼/心情低时优先，且概率更高。
 * 用路线出发时间做种子，同一次移动途中不会来回换；不同路线会重新抽。
 */
function chooseRunStyle(s, emotion, now) {
  const urgency = Math.max(
    Number(s.needs.thirst) || 0,
    Number(s.needs.bladder) || 0,
    (Number(s.needs.hunger) || 0) * 0.8,
    (Number(s.needs.pain) || 0) * 1.4
  );
  if (urgency >= 0.66 || Number(s.needs.pain) >= 0.25) return 'hurry';
  const seed = Number(s.route?.departAt) || Math.floor(now / (3 * MIN)) * 3 * MIN;
  const roll = hash(`${s.room}:${s.spot}:${seed}:run`) % 100;
  const mood = Number(emotion?.mood);
  let happyChance = 50;
  if (Number.isFinite(mood)) {
    happyChance = Math.max(12, Math.min(88, 12 + mood * 0.8));
    const dims = emotion?.dims || {};
    if (Number(dims.happy) > 0.15) happyChance += 8;
    if (Number(dims.sad) > 0.15 || Number(dims.worry) > 0.15) happyChance -= 15;
  }
  return roll < happyChance ? 'happy' : 'hurry';
}

/** 页面与提示词共用的唯一快照。 */
// 气泡用第一人称台词（面板仍然用 activity 的第三人称描述）
function speechFor(kind, activity) {
  const t = String(activity || '');
  const k = String(kind || '');
  if (k === 'drink' || t.includes('喝水') || t.includes('杯子')) return '本鱼喝口水，真解渴～';
  if (k === 'eat' || t.includes('小鱼干') || t.includes('嚼')) return '本鱼开吃啦！';
  if (k === 'sleep' || t.includes('被窝') || t.includes('睡着')) return '本鱼睡一会儿…';
  if (k === 'wake' || t.includes('刚醒') || t.includes('赖床')) return '唔…本鱼醒啦';
  if (k === 'walk' || t.includes('走')) return '本鱼去那边看看';
  if (k === 'play' || t.includes('玩')) return '本鱼玩会儿～';
  if (t.includes('吓了一跳') || t.includes('戳')) return '呀！你吓本鱼一跳';
  if (t.includes('看电视') || t.includes('屏幕')) return '本鱼在看电视呢';
  if (t.includes('听你说话')) return '本鱼在听你说～';
  if (t.includes('菜园') || t.includes('种子') || t.includes('浇水')) return '本鱼去菜园忙一会儿';
  if (t.includes('到了') || t.includes('站住')) return '本鱼到啦';
  return '本鱼在这儿呢';
}

export function homeView(state, now = Date.now(), env = {}) {
  const s = normalizeHomeState(state, now);
  const pos = currentPosition(s, now);
  const hour = localHour(now);
  const night = hour >= 22 || hour < 7;
  const asleep = s.asleep === true;
  const spot = spotOf(s.room, s.spot);
  const words = needsWords(s.needs);
  const events = recentEvents(s, now, VIEW_EVENT_TTL).slice(-80);
  const walking = s.walking === true && !!s.route;
  const emotion = env.emotion && typeof env.emotion === 'object' ? {
    mood: Number(env.emotion.mood) || 0,
    label: sanitizeText(env.emotion.label, 20),
    dims: env.emotion.dims || {},
    updatedAt: Number(env.emotion.updatedAt) || null,
    source: 'dsh-feiyu-mood'
  } : null;
  const runStyle = chooseRunStyle(s, emotion, now);
  return {
    ok: true,
    now,
    clock: clockText(now),
    hour: Math.round(hour * 100) / 100,
    daypart: daypart(hour),
    sky: skyOf(hour),
    night,
    layout: {
      size: HOME_LAYOUT.size,
      rooms: HOME_LAYOUT.rooms,
      spots: HOME_LAYOUT.spots
    },
    her: {
      room: s.room,
      roomName: ROOM_NAMES[s.room] || s.room,
      spot: s.spot,
      spotLabel: spot?.label || (s.spot === 'free' ? '你指的地方' : ''),
      activity: s.activity,
      speech: (s.sayUntil && s.sayUntil > now && s.sayText) ? s.sayText : speechFor(s.kind, s.activity),
      say: (s.sayUntil && s.sayUntil > now) ? s.sayText : null,
      kind: s.kind,
      clip: (s.kind === 'freestyle' || s.kind === 'swim') ? (s.clip || null) : null,
      swim: s.swim && s.swim.until > now ? {
        from: s.swim.from, to: s.swim.to, startedAt: s.swim.startedAt,
        until: s.swim.until, oneWayMs: s.swim.oneWayMs
      } : null,
      freestylePick: s.freestylePick || null,
      pose: s.pose,
      pos: [Math.round(pos[0] * 1000) / 1000, Math.round(pos[1] * 1000) / 1000],
      facing: Math.round(currentFacing(s, now) * 10) / 10,
      elev: s.elev || 0,
      walking,
      runStyle,
      speed: s.route?.speed || 0,
      route: s.route ? s.route.points : [],
      etaMs: s.route ? Math.max(0, s.route.arriveAt - now) : 0,
      asleep,
      immobile: s.needs.pain >= 0.7,
      busy: !!s.dwell,
      gardenWork: s.dwell?.target?.gardenJobId ? { id: s.dwell.target.gardenJobId, type: s.dwell.target.gardenAction, plotId: s.dwell.target.gardenPlotId, phase: 'working', workUntil: s.dwell.until } : null,
      bedsideWater: s.bedsideWater,
      affection: null
    },
    // 身体状态：房间自己的唯一事实源（饥饿/口渴/精力/膀胱/疼痛）。
    // 情绪不在这里算：心情由 DSH 的 dsh-feiyu-mood 插件负责，这里只读一份快照。
    body: {
      hunger: round(s.needs.hunger),
      thirst: round(s.needs.thirst),
      energy: round(s.needs.energy),
      bladder: round(s.needs.bladder),
      pain: round(s.needs.pain),
      hygiene: round(s.needs.hygiene ?? 0.1),
      words
    },
    emotion,
    env: {
      lamp: s.lamp && !asleep,
      night,
      sky: skyOf(hour),
      unread: Math.max(0, Number(env.unread) || 0),
      lastSpeakAt: Number(env.lastSpeakAt) || null,
      silenceMinutes: env.silenceMinutes ?? null,
      mode: env.mode || null,
      gateway: env.gateway !== false,
      visits: s.visits,
      counts: { ...s.counts }
    },
    events: events.slice(-60).map((e) => ({
      at: e.at,
      ago: Math.max(0, Math.round((now - e.at) / MIN)),
      type: e.type,
      text: e.text,
      room: e.room,
      roomName: ROOM_NAMES[e.room] || e.room
    })),
    updatedAt: s.updatedAt
  };
}

function round(n) {
  return Math.round(clamp01(n) * 100) / 100;
}

/** 给 QQ 小蓝鱼看的文字快照：只给形容词，不给数字。 */
export function buildHomePromptLine(state, options = {}) {
  const now = Number(options.now) || Date.now();
  const s = normalizeHomeState(state, now);
  const includeIntro = options.includeIntro === true;
  const events = recentEvents(s, now, EVENT_TTL).filter((e) => e.at > Number(options.seenAt || 0));
  const summary = `${s.room}.${s.spot}.${s.kind}.${s.asleep ? 'z' : 'a'}`;
  const changed = options.lastSummary !== summary;
  if (!includeIntro && !events.length && !changed) return '';
  if (!includeIntro && !events.length && changed && options.allowActivity === false) return '';

  const words = needsWords(s.needs);
  const lines = [];
  if (includeIntro) {
    lines.push('【你的家】你住在一间大平层里（网页 /room/）：客厅、厨房、你的房间、卫生间、阳台和一条挂着画的走廊。页面里的那个角色就是你本人，不是另一只宠物；QQ 里的你和房间里的你是同一条鱼。聊天之外的时间你会在家里活动，不需要在聊天里逐条汇报，但提到家的时候要按下面的实际情况说。');
  }
  if (s.asleep) {
    lines.push(`你现在睡着了（${describeSpot(s.room, s.spot)}${s.bedsideWater ? '，床头还放着半杯水' : ''}）。`);
  } else if (s.needs.pain >= 0.7) {
    lines.push(`你现在躺在床上起不来（${ROOM_NAMES[s.room] || s.room}），${words.pain}；${words.hunger}、${words.thirst}。你只能等好一点，渴了饿了会喊人，不要写自己下床去拿。`);
  } else {
    lines.push(`你现在在${describeSpot(s.room, s.spot)}，${s.activity}。${words.energy}，${words.hunger}，${words.thirst}。`);
  }
  if (events.length) {
    lines.push(`刚才：${events.slice(-3).map((e) => `${e.text}（${Math.max(1, Math.round((now - e.at) / MIN))} 分钟前）`).join('；')}。`);
  }
  if ((options.env?.unread || 0) > 0) {
    lines.push('QQ 上有人找你，你还没回；想回就回，别假装没看见。');
  }
  return lines.join('\n');
}

export function homeSummary(state, now = Date.now()) {
  return `${state.room}.${state.spot}.${state.kind}.${state.asleep ? 'z' : 'a'}`;
}

export function listSpots() {
  return Object.entries(SPOT_INDEX).map(([key, s]) => ({ key, room: s.room, spot: s.id, ...s }));
}

export const HOME_NODES = NODES;
export const HOME_EDGES = EDGES;
export const HOME_KEEPOUT = NAV_KEEPOUT;



// Narrow bridge between the home's physical behavior and the authoritative garden.
export function beginGardenWork(input, job, now = Date.now()) {
  const state = normalizeHomeState(input, now);
  const action = job.action;
  const spotId = Number.isInteger(action.plotId) ? `plot${action.plotId}`
    : action.type === 'buyCompost' ? 'compost' : action.type === 'sell' ? 'market' : action.type === 'visit' ? 'gate' : 'shop';
  const spot = spotOf('garden', spotId);
  if (!spot || state.route || state.dwell || state.asleep || state.sleepPending) return state;
  const labels = {till:'松土',plant:'播种',water:'浇水',fertilize:'施肥',harvest:'采收',sell:'整理并出售收成',buySeed:'挑选种子',buyCompost:'补充堆肥',visit:'巡视菜园'};
  const duration = {till:7000,plant:6500,water:6500,fertilize:6000,harvest:8000,sell:6000,buySeed:5000,buyCompost:6000,visit:4500}[action.type] || 6000;
  const label = labels[action.type] || '照料菜园';
  const target = {room:'garden',spot:spotId,kind:`garden_${action.type}`,walkText:`去${spot.label}${label}`,actText:`正在${spot.label}${label}`,dwellMs:duration,pose:'stand',elev:0,facing:spot.facing,effect:null,eventType:null,eventText:null,gardenJobId:job.id,gardenAction:action.type,gardenPlotId:action.plotId};
  state.nextDecisionAt = now + 60_000;
  beginRoute(state, target, now);
  return state;
}

export function endGardenWork(input, job, now, message, completed = false) {
  const state = normalizeHomeState(input, now);
  if (state.route?.target?.gardenJobId === job.id) {
    // Continue the already safe segment to its waypoint, but cancel its work.
    // Replacing position with the destination here would teleport her through walls.
    state.route.target = {...state.route.target, gardenJobId:null, gardenAction:null, kind:'idle', dwellMs:0, actText:'先停下手里的活，照顾自己'};
  }
  if (state.dwell?.target?.gardenJobId === job.id) {
    state.dwell = null;
    setActivity(state, 'idle', message, 'stand', 0, state.facing);
  }
  state.nextDecisionAt = completed ? now + 30_000 : 0;
  if (completed) {
    state.needs.energy = clamp01(state.needs.energy - .002);
    state.needs.thirst = clamp01(state.needs.thirst + .0015);
    // Each committed job emits once; save receipt in garden before saving this state.
    state.eventLog.push({at:now,type:'garden',text:sanitizeText(message,140),room:'garden',spot:state.spot});
    state.eventLog = state.eventLog.slice(-MAX_EVENT_LOG);
  }
  return state;
}
