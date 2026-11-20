#!/usr/bin/env node
// 位置一致性测试：public/room/motion.js 是「她现在在哪」的唯一实现，
// 服务端（home-state.js）和客户端（app.js）都 import 它。
//
// 这个测试守的是：**同一个 motion + 同一个时刻，任何调用方算出同一个位置**。
// 之前走路抖、上座闪现，根源都是「同一个概念有几份实现、互相漂移」，
// 所以这里的断言都直接对着「只有一份、且算得对」写。
// 跑法：node scripts/test-motion.mjs
import assert from 'node:assert/strict';
import {
  routeLengths, polylineLength, pointAtArc, arcLengthAt, motionAt, walkAnchorAt
} from '../public/room/motion.js';
import {
  emptyHomeState, advanceHomeState, applyHomeAction, currentPosition,
  homeView, motionOf, positionOnRoute
} from '../src/home-state.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${error?.message || error}`);
    process.exitCode = 1;
  }
}

const T0 = Date.parse('2026-11-20T14:00:00+08:00');
const ROAD = [[0, 0], [4, 0], [4, 3], [8, 3]];   // 带两个拐角的折线

test('弧长工具：总长、取点、投影互相自洽', () => {
  assert.equal(polylineLength(ROAD), 11);
  const { cum, total } = routeLengths(ROAD);
  assert.equal(total, 11);
  assert.deepEqual(cum, [0, 4, 7, 11]);
  // 取点
  assert.deepEqual(pointAtArc(ROAD, 0), [0, 0]);
  assert.deepEqual(pointAtArc(ROAD, 4), [4, 0]);
  assert.deepEqual(pointAtArc(ROAD, 7), [4, 3]);
  assert.deepEqual(pointAtArc(ROAD, 11), [8, 3]);
  assert.deepEqual(pointAtArc(ROAD, 2), [2, 0]);
  // 越界钉在两端
  assert.deepEqual(pointAtArc(ROAD, -5), [0, 0]);
  assert.deepEqual(pointAtArc(ROAD, 999), [8, 3]);
  // 投影回弧长
  assert.equal(arcLengthAt(ROAD, [2, 0]), 2);
  assert.equal(arcLengthAt(ROAD, [4, 1.5]), 5.5);
  assert.equal(arcLengthAt(ROAD, [8, 3]), 11);
});

test('沿折线匀速推进，相邻同样时间间隔的位移是恒定的', () => {
  // 这是「不卡」的数学定义：按弧长推进，每 100ms 走 0.105m。
  // 旧实现按「起点+距离」推进，换锚点会跳格，这条会失败。
  const speed = 1.05;
  const step = 0.1;                 // 100ms
  const expected = speed * step;
  let prev = null;
  let maxErr = 0;
  for (let t = 0; t <= 10; t += step) {
    const p = pointAtArc(ROAD, speed * t);
    if (prev) {
      const d = Math.hypot(p[0] - prev[0], p[1] - prev[1]);
      // 跨拐角时一步走的是对角线，直线距离会短于弧长 —— 这是几何事实，
      // 但误差有上界（不会出现「跳 1 米」）。
      maxErr = Math.max(maxErr, Math.abs(d - expected));
    }
    prev = p;
  }
  assert.ok(maxErr < expected * 0.5,
    `单步位移偏差 ${maxErr.toFixed(4)}m 太大（期望 ${expected.toFixed(4)}m）`);
});

test('换锚点不跳格：从任意 s0 出发，位置都是连续的', () => {
  // 旧实现每次轮询把起点换成服务端 pos，走过拐角后「最近线段」跳一格，
  // 同一个 elapsed 映射到完全不同的位置（实测 1.2m 跳变）。
  const speed = 1.05;
  for (let s0 = 0; s0 < 11; s0 += 0.1) {
    const a = pointAtArc(ROAD, s0);
    // 用当前位置反推锚点，再往前走 50ms —— 必须和直接取点一致
    const anchor = walkAnchorAt(ROAD, a, 0);
    assert.ok(Math.abs(anchor.s0 - s0) < 1e-9, `s0=${s0} 反推得到 ${anchor.s0}`);
    const viaAnchor = motionAt({ kind: 'walk', points: ROAD, s0: anchor.s0, t0: 0, speed }, 50).pos;
    const direct = pointAtArc(ROAD, s0 + speed * 0.05);
    assert.ok(Math.hypot(viaAnchor[0] - direct[0], viaAnchor[1] - direct[1]) < 1e-9,
      `s0=${s0} 两种算法不一致`);
  }
});

test('服务端 positionOnRoute 与共享 pointAtArc 完全一致', () => {
  // positionOnRoute 已经改成调 pointAtArc，这条断言防止有人又写回一份。
  const route = { points: ROAD, departAt: T0, speed: 1.05 };
  for (let ms = 0; ms <= 11000; ms += 73) {
    const now = T0 + ms;
    const a = positionOnRoute(route, now);
    const b = pointAtArc(ROAD, Math.max(0, (now - route.departAt) / 1000 * route.speed));
    assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9, `t=${ms}ms 不一致`);
  }
});

test('上座两段式：先原地升起，再横向滑入（高度必须一起插值）', () => {
  const seg = {
    kind: 'mount', from: [0, 0], to: [1, 0], seatY: 0.5, t0: 0, dur: 2400, up: true
  };
  const at = (ms) => motionAt(seg, ms);
  // 一开始在地面
  assert.ok(at(0).elev < 0.01);
  // 前半段抬升、几乎不横移
  const mid = at(2400 * 0.4);
  assert.ok(mid.elev > 0.1, `40% 处应该已经离地，实际 ${mid.elev}`);
  assert.ok(Math.hypot(mid.pos[0], mid.pos[1]) < 0.05, '前半段不该横移');
  // 中途高度必须是中间值（不能一直是 0，最后才弹上去）
  const elevs = [];
  for (let ms = 0; ms <= 2400; ms += 100) elevs.push(at(ms).elev);
  assert.ok(elevs.filter((v) => v > 0.05 && v < 0.45).length >= 3,
    '高度必须有多个中间值（否则就是「贴着地滑进去再弹上来」）');
  // 单调不减
  for (let i = 1; i < elevs.length; i += 1) {
    assert.ok(elevs[i] >= elevs[i - 1] - 1e-9, `高度回退了：${elevs[i - 1]} → ${elevs[i]}`);
  }
  // 结束时到位
  const end = at(2400);
  assert.ok(Math.abs(end.elev - 0.5) < 1e-6, `结束高度应该是 0.5，实际 ${end.elev}`);
  assert.ok(Math.abs(end.pos[0] - 1) < 1e-6, `结束位置应该在 to，实际 ${end.pos}`);
  assert.equal(end.done, true);
});

test('下座是上座的逆过程：先横移退出，再落地', () => {
  const seg = {
    kind: 'dismount', from: [1, 0], to: [0, 0], seatY: 0.5, t0: 0, dur: 1800, up: false
  };
  assert.ok(Math.abs(motionAt(seg, 0).elev - 0.5) < 1e-6, '开始时应该在座面高度');
  assert.ok(motionAt(seg, 1800).elev < 1e-6, '结束时应该落地');
  // 高度单调不增
  const elevs = [];
  for (let ms = 0; ms <= 1800; ms += 90) elevs.push(motionAt(seg, ms).elev);
  for (let i = 1; i < elevs.length; i += 1) {
    assert.ok(elevs[i] <= elevs[i - 1] + 1e-9, `高度反弹了：${elevs[i - 1]} → ${elevs[i]}`);
  }
});

test('still 状态直接用落点，walking=false', () => {
  const m = motionAt({ kind: 'still', pos: [3, 4], elev: 0.4 }, 12345);
  assert.deepEqual(m.pos, [3, 4]);
  assert.equal(m.elev, 0.4);
  assert.equal(m.walking, false);
});

test('服务端快照输出的位置，与用 motion 在客户端求值一致', () => {
  // 这就是「客户端可以完全自算位置」的依据：同一份 motion + 同一时刻，两边结果相同。
  let s = emptyHomeState(T0);
  s.room = 'her_room';
  s.spot = 'desk';
  s.pose = 'stand';
  s.elev = 0;
  s = applyHomeAction(s, { action: 'command', room: 'pool', spot: 'lounger', at: T0 }).state;

  let checked = 0;
  for (let t = T0; t < T0 + 90000; t += 97) {
    s = advanceHomeState(s, t, {}).state;
    const view = homeView(s, t, {});
    const viaMotion = motionAt(view.her.motion, t, view.her.motion.pos);
    // homeView 里的 pos 保留 3 位小数，所以容差放到 1e-3
    const err = Math.hypot(viaMotion.pos[0] - view.her.pos[0], viaMotion.pos[1] - view.her.pos[1]);
    assert.ok(err < 1.5e-3, `t=${t - T0}ms 位置不一致：${viaMotion.pos} vs ${view.her.pos}`);
    assert.ok(Math.abs(viaMotion.elev - view.her.elev) < 1.5e-3, `t=${t - T0}ms 高度不一致`);
    checked += 1;
    if (s.spot === 'lounger' && !s.mounting && !s.route) break;
  }
  assert.ok(checked > 100, `采样太少：${checked}`);
});

test('motionFor 的 kind 覆盖所有运动形态，且客户端能分辨', () => {
  // 客户端只靠 motion.kind 决定「怎么求位置 / 播什么动画」，所以 kind 必须齐全。
  let s = emptyHomeState(T0);
  s.room = 'her_room'; s.spot = 'desk'; s.pose = 'stand'; s.elev = 0;
  assert.equal(motionOf(s).kind, 'still');

  s = applyHomeAction(s, { action: 'command', room: 'pool', spot: 'lounger', at: T0 }).state;
  // applyHomeAction 只是记下命令；路线要等下一次 advanceHomeState 才建立。
  // 这期间 motion 仍是 still（她还站在原地），客户端画在原地是对的。
  s = advanceHomeState(s, T0, {}).state;
  assert.equal(motionOf(s).kind, 'walk');
  // walk 必须带 points/s0/t0/speed 四件套
  const w = motionOf(s);
  for (const k of ['points', 's0', 't0', 'speed']) {
    assert.ok(k in w, `walk motion 缺少 ${k}`);
  }

  // 走到躺椅后会经历 mount
  let sawMount = false;
  let t = T0;
  for (let i = 0; i < 900; i += 1) {
    t += 200;
    s = advanceHomeState(s, t, {}).state;
    if (s.mounting) { sawMount = true; break; }
  }
  assert.ok(sawMount, '应该出现上座过渡');
  const mo = motionOf(s);
  assert.equal(mo.kind, 'mount');
  for (const k of ['from', 'to', 'seatY', 't0', 'dur']) {
    assert.ok(k in mo, `mount motion 缺少 ${k}`);
  }
});

console.log(`\n位置一致性测试全部通过（${passed} 项）`);
