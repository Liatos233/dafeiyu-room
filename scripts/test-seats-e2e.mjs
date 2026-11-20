#!/usr/bin/env node
// 上下家具的**端到端**测试（对着运行中的 bridge 实测，不是纯函数）。
//
// 纯函数测试（test-motion.mjs）证明插值公式对，这个脚本证明**线上真的滑**：
// 逐帧采样 her.motion → motionAt，检查四件事：
//   ① 位置连续（没有跳变）
//   ② 高度和位置两段式分开（先原地升起、再横移），且都有中间值
//   ③ 没有「完全静止」的僵住帧
//   ④ walking 不翻转（动画不会闪）
//
// 跑法：先起 bridge（端口 3100），然后 node scripts/test-seats-e2e.mjs
// 它是**在线测试**，所以不并入 `npm test` 那套离线测试。
import { motionAt } from '../public/room/motion.js';

const BASE = process.env.ROOM_BASE || 'http://127.0.0.1:3100';
const SAMPLE_MS = 60;

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`); }
  else { fail += 1; console.error(`  ✗ ${name}${detail ? '  ' + detail : ''}`); }
}

const get = async (p) => (await fetch(BASE + p, { cache: 'no-store' })).json();
const post = async (p, b) => (await fetch(BASE + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b)
})).json();

async function reachRoom(room, spot, timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = await get('/api/home/state');
    if (s.her.room === room && s.her.spot === spot && !s.her.walking && !s.her.transitioning) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/** 采一段，只看指定 kind 的帧。 */
async function captureKind(kind, doneFn, timeoutMs = 60000) {
  const rows = [];
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = await get('/api/home/state');
    const h = s.her;
    if (h.motion?.kind === kind) {
      const m = motionAt(h.motion, Number(s.now), h.motion.pos);
      rows.push({ pos: m.pos, elev: m.elev, walking: m.walking });
    }
    if (doneFn(s)) break;
    await new Promise((r) => setTimeout(r, SAMPLE_MS));
  }
  return rows;
}

function analyze(rows) {
  const posJumps = [];
  const elevSteps = [];
  let frozen = 0;
  let flips = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const dp = Math.hypot(rows[i].pos[0] - rows[i - 1].pos[0], rows[i].pos[1] - rows[i - 1].pos[1]);
    const de = Math.abs(rows[i].elev - rows[i - 1].elev);
    posJumps.push(dp);
    elevSteps.push(de);
    if (dp < 0.002 && de < 0.002) frozen += 1;
    if (rows[i].walking !== rows[i - 1].walking) flips += 1;
  }
  const elevs = rows.map((r) => r.elev);
  const maxElev = Math.max(...elevs);
  const minElev = Math.min(...elevs);
  const mids = elevs.filter((v) => v > minElev + 0.05 && v < maxElev - 0.05).length;

  // 上升/下降过程中的**高度速度**连续性：
  // 只看真正在升降的帧（增量为正的），算相邻两帧的速度变化。
  // 如果高度上还有残留的指数平滑，这里会出现「忽快忽慢」的锯齿。
  const riseSteps = [];
  for (let i = 1; i < rows.length; i += 1) {
    riseSteps.push(rows[i].elev - rows[i - 1].elev);
  }
  const moving = riseSteps.filter((v) => v > 0.0005);
  let elevJerk = 0;
  if (moving.length >= 3) {
    // 相邻增量的差值，归一化到最大增量
    let maxDiff = 0;
    for (let i = 1; i < riseSteps.length; i += 1) {
      if (riseSteps[i] <= 0.0005 || riseSteps[i - 1] <= 0.0005) continue;
      maxDiff = Math.max(maxDiff, Math.abs(riseSteps[i] - riseSteps[i - 1]));
    }
    elevJerk = maxDiff / Math.max(...moving);
  }
  return {
    frames: rows.length,
    maxPosJump: posJumps.length ? Math.max(...posJumps) : 0,
    maxElevStep: elevSteps.length ? Math.max(...elevSteps) : 0,
    midValues: mids,
    frozen,
    flips,
    elevRange: [minElev, maxElev],
    elevJerk
  };
}

const CASES = [
  { name: '沙发', room: 'living', spot: 'sofa' },
  { name: '床', room: 'her_room', spot: 'bed' },
  { name: '沙滩躺椅', room: 'pool', spot: 'lounger' },
  { name: '阳台躺椅', room: 'balcony', spot: 'chair' }
];

console.log(`上下家具端到端实测（${BASE}）\n`);
for (const c of CASES) {
  // 每次先站到地上，保证下一步是「上座」而不是「先下座」
  await post('/api/home/act', { action: 'command', room: 'her_room', spot: 'desk' });
  await reachRoom('her_room', 'desk');
  await new Promise((r) => setTimeout(r, 500));

  // ── 上座 ────────────────────────────────────────────────
  await post('/api/home/act', { action: 'command', room: c.room, spot: c.spot });
  const up = await captureKind('mount', (s) =>
    s.her.spot === c.spot && !s.her.transitioning && !s.her.walking);
  if (up.length < 8) {
    fail += 1;
    console.error(`  ✗ ${c.name} 上座：只采到 ${up.length} 帧，无法判断`);
  } else {
    const a = analyze(up);
    console.log(`${c.name} · 上座（${a.frames} 帧，高度 ${a.elevRange[0].toFixed(2)}→${a.elevRange[1].toFixed(2)}）`);
    ok('位置连续无跳变', a.maxPosJump < 0.3, `单帧最大 ${a.maxPosJump.toFixed(3)}m`);
    ok('高度有多个中间值', a.midValues >= 3, `${a.midValues} 个`);
    ok('没有僵住帧', a.frozen === 0, `${a.frozen} 帧`);
    ok('walking 不翻转', a.flips === 0, `${a.flips} 次`);
    // 高度速度连续性：残留指数平滑会让相邻帧的增高量忽大忽小
    ok('上升速度平滑', a.elevJerk < 0.6, `相邻增量跳变比 ${a.elevJerk.toFixed(2)}`);
  }

  // ── 下座 ────────────────────────────────────────────────
  await post('/api/home/act', { action: 'command', room: 'her_room', spot: 'desk' });
  const down = await captureKind('dismount', (s) =>
    s.her.spot === 'desk' && !s.her.transitioning && !s.her.walking);
  if (down.length < 8) {
    fail += 1;
    console.error(`  ✗ ${c.name} 下座：只采到 ${down.length} 帧，无法判断`);
  } else {
    const a = analyze(down);
    console.log(`${c.name} · 下座（${a.frames} 帧，高度 ${a.elevRange[0].toFixed(2)}→${a.elevRange[1].toFixed(2)}）`);
    ok('位置连续无跳变', a.maxPosJump < 0.3, `单帧最大 ${a.maxPosJump.toFixed(3)}m`);
    ok('高度单调下降', down.every((r, i) => i === 0 || r.elev <= down[i - 1].elev + 1e-6));
    ok('没有僵住帧', a.frozen === 0, `${a.frozen} 帧`);
    ok('walking 不翻转', a.flips === 0, `${a.flips} 次`);
  }
  console.log('');
}

// ── 离开坐具后不能闪现 ──────────────────────────────────────
// 这是个独立的真实 bug：下座落地在座点，重新寻路时如果旧路线没清掉，
// currentPosition 会沿那条过期路线算出「她已经走出去 1.2m」，新路线就从错位置起步，
// 表现是「落地后停一会儿，然后突然闪现到远处」。
console.log('离开坐具衔接');
for (const c of CASES) {
  await post('/api/home/act', { action: 'command', room: c.room, spot: c.spot });
  await reachRoom(c.room, c.spot);
  await new Promise((r) => setTimeout(r, 400));

  await post('/api/home/act', { action: 'command', room: 'her_room', spot: 'desk' });
  let lastDismount = null;
  let firstWalk = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    const s = await get('/api/home/state');
    const h = s.her;
    if (h.motion?.kind === 'dismount') lastDismount = h.pos.slice();
    if (h.motion?.kind === 'walk') {
      firstWalk = { pos: h.pos.slice(), start: h.motion.points?.[0] };
      break;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  if (lastDismount && firstWalk) {
    const jump = Math.hypot(firstWalk.pos[0] - lastDismount[0], firstWalk.pos[1] - lastDismount[1]);
    const startGap = Math.hypot(firstWalk.start[0] - lastDismount[0], firstWalk.start[1] - lastDismount[1]);
    ok(`${c.name} 离开后不闪现`, jump < 0.1, `落地→首帧 ${jump.toFixed(3)}m`);
    ok(`${c.name} 新路线从座点起步`, startGap < 0.1, `偏差 ${startGap.toFixed(3)}m`);
  } else {
    fail += 1;
    console.error(`  ✗ ${c.name} 离开：没采到下座/走路帧`);
  }
}

console.log('');
console.log(`${pass} 项通过，${fail} 项失败`);
if (fail) process.exit(1);
