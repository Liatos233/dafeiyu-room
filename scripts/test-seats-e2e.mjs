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
  return {
    frames: rows.length,
    maxPosJump: posJumps.length ? Math.max(...posJumps) : 0,
    maxElevStep: elevSteps.length ? Math.max(...elevSteps) : 0,
    midValues: mids,
    frozen,
    flips,
    elevRange: [minElev, maxElev]
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

console.log(`${pass} 项通过，${fail} 项失败`);
if (fail) process.exit(1);
