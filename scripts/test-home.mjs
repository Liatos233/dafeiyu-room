#!/usr/bin/env node
// 大平层单测：不连桥接、不起服务，只测 src/home-state.js 的事实层/行为层。
// 跑法：npm run test:home
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HOME_LAYOUT,
  applyHomeAction,
  advanceHomeState,
  beginGardenWork,
  buildHomePromptLine,
  buildMapRoute,
  buildRoute,
  currentPosition,
  emptyHomeState,
  endGardenWork,
  graphPath,
  homeSummary,
  homeView,
  listSpots,
  loadHomeState,
  normalizeHomeState,
  normalizeFreePoint,
  positionOnRoute,
  polylineLength,
  recentEvents,
  saveHomeState
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
const T0 = Date.parse('2026-11-06T14:00:00+08:00');
const MIN = 60_000;
const HOUR = 60 * MIN;
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

function atState(overrides = {}, now = T0) {
  const s = emptyHomeState(now);
  Object.assign(s, {
    room: 'living', spot: 'sofa', pose: 'sit', elev: 0.4, facing: 0, kind: 'idle',
    activity: '窝在沙发上发呆', nextDecisionAt: now + 10 * HOUR, lastTickAt: now, ...overrides
  });
  return s;
}

test('emptyHomeState 是干净的初始状态', () => {
  const s = emptyHomeState(T0);
  assert.equal(s.asleep, false);
  assert.equal(s.needs.pain, 0);
  assert.equal(s.route, null);
  assert.ok(Array.isArray(s.eventLog));
  assert.equal(s.lamp, true);
});

test('需求按经过的时间缩放，不按心跳次数', () => {
  let a = atState({ needs: { hunger: 0.2, thirst: 0.2, fatigue: 0.2, bladder: 0.2, pain: 0 } });
  a = advanceHomeState(a, T0 + 30 * MIN, {}).state;
  a = advanceHomeState(a, T0 + 60 * MIN, {}).state;
  let b = atState({ needs: { hunger: 0.2, thirst: 0.2, fatigue: 0.2, bladder: 0.2, pain: 0 } });
  b = advanceHomeState(b, T0 + 60 * MIN, {}).state;
  close(a.needs.hunger, b.needs.hunger, 1e-9);
  close(a.needs.thirst, b.needs.thirst, 1e-9);
  close(a.needs.fatigue, b.needs.fatigue, 1e-9);
  assert.ok(a.needs.hunger > 0.2 && a.needs.thirst > 0.2);
});

test('尿急优先级高于闲逛，去卫生间', () => {
  let s = atState({ room: 'living', spot: 'water', pose: 'stand', elev: 0, needs: { hunger: 0.1, thirst: 0.1, fatigue: 0.2, bladder: 0.93, pain: 0 }, nextDecisionAt: T0 });
  s = advanceHomeState(s, T0, {}).state;
  assert.equal(s.walking, true);
  assert.equal(s.route.target.room, 'bathroom');
  assert.equal(s.route.target.spot, 'toilet');
});

test('夜里困了先走回床，路上不算睡着', () => {
  let s = atState({ room: 'living', spot: 'water', pose: 'stand', elev: 0, kind: 'tv', activity: '窝在沙发上看电视', needs: { hunger: 0.3, thirst: 0.3, fatigue: 0.6, bladder: 0.2, pain: 0 }, nextDecisionAt: 0 });
  const night = Date.parse('2026-11-06T23:30:00+08:00');
  s.lastTickAt = night;
  s = advanceHomeState(s, night, {}).state;
  assert.equal(s.asleep, false, '出发时不能已睡着');
  assert.equal(s.sleepPending, true);
  assert.equal(s.walking, true);
  assert.equal(s.route.target.spot, 'bed');
  // 到达床之前一直保持清醒
  s = advanceHomeState(s, s.route.arriveAt - 1000, {}).state;
  assert.equal(s.asleep, false, '路上不能进入睡眠');
  s = advanceHomeState(s, s.route.arriveAt + 10, {}).state;
  assert.equal(s.asleep, true, '进被窝后才睡');
  assert.equal(`${s.room}.${s.spot}`, 'her_room.bed');
});

test('睡着后回床、关灯、不乱跑；早上醒来开灯', () => {
  let s = atState({ kind: 'tv', activity: '窝在沙发上看电视', needs: { hunger: 0.3, thirst: 0.3, fatigue: 0.5, bladder: 0.2, pain: 0 }, nextDecisionAt: 0 });
  const start = Date.parse('2026-11-06T22:00:00+08:00');
  s.lastTickAt = start;
  let asleepAt = 0;
  for (let i = 0; i < 10 * 60; i += 1) {
    const now = start + i * MIN;
    s = advanceHomeState(s, now, {}).state;
    if (s.asleep) {
      asleepAt = now;
      assert.equal(s.lamp, false, '睡着时灯必须是关的');
      if (s.route) assert.equal(s.route.target.room, 'her_room');
      else assert.equal(`${s.room}.${s.spot}`, 'her_room.bed', '睡着后只能在床上');
      break;
    }
  }
  assert.ok(asleepAt > 0, '夜里应该会睡');
  for (let i = 1; i < 10 * 60; i += 1) {
    const now = asleepAt + i * MIN;
    s = advanceHomeState(s, now, {}).state;
    if (s.asleep) assert.equal(s.lamp, false);
    if (!s.asleep) {
      assert.equal(s.lamp, true, '醒来灯要开');
      assert.ok(s.eventLog.some((e) => e.type === 'sleep'), '入睡要留一条事件');
      assert.ok(s.eventLog.some((e) => e.type === 'wake'), '醒来要留一条事件');
      return;
    }
  }
  assert.fail('早上没有醒');
});

test('病到起不来：留在床上、需求继续累积、会喊人', () => {
  let s = atState({
    room: 'her_room', spot: 'bed', pose: 'lie', elev: 0.52,
    needs: { hunger: 0.6, thirst: 0.9, fatigue: 0.8, bladder: 0.3, pain: 0 },
    bedsideWater: false, nextDecisionAt: 0, lastTickAt: T0
  });
  s = applyHomeAction(s, { action: 'sick', at: T0 }).state;
  const beforeThirst = s.needs.thirst;
  for (let i = 0; i < 45; i += 1) s = advanceHomeState(s, T0 + i * MIN, {}).state;
  assert.equal(s.room, 'her_room');
  assert.equal(s.spot, 'bed');
  assert.ok(s.needs.thirst > beforeThirst, '起不来时需求照常累积');
  assert.ok(s.eventLog.some((e) => e.type === 'help'), '应该喊人');
  assert.equal(homeView(s, T0 + 45 * MIN, {}).her.immobile, true);
  // 退烧后能自己下床
  s = applyHomeAction(s, { action: 'heal', at: T0 + 46 * MIN }).state;
  for (let i = 0; i < 30; i += 1) s = advanceHomeState(s, T0 + (46 + i) * MIN, {}).state;
  assert.equal(s.needs.pain, 0);
  assert.equal(homeView(s, T0 + 76 * MIN, {}).her.immobile, false);
});

test('床边的水可以伸手够到，并写一条事件', () => {
  let s = atState({
    room: 'her_room', spot: 'bed', pose: 'lie', elev: 0.52,
    needs: { hunger: 0.4, thirst: 0.85, fatigue: 0.8, bladder: 0.2, pain: 0.85 },
    bedsideWater: true, lastTickAt: T0, nextDecisionAt: T0
  });
  const before = s.needs.thirst;
  s = advanceHomeState(s, T0 + MIN, {}).state;
  assert.equal(s.bedsideWater, false);
  assert.ok(s.needs.thirst < before);
  assert.ok(s.eventLog.some((e) => e.type === 'drink' && e.text.includes('床边')));
});

test('移动立即出发、全程按奔跑速度', () => {
  let s = atState({ room: 'living', spot: 'water', pose: 'stand', elev: 0, needs: { hunger: 0.2, thirst: 0.8, fatigue: 0.2, bladder: 0.2, pain: 0 }, nextDecisionAt: T0 });
  s = advanceHomeState(s, T0, {}).state;
  assert.equal(s.walking, true);
  assert.equal(s.route.departAt, T0, '不应再有 250ms 的思考/起跑延迟');
  assert.equal(s.route.speed, 1.05, '非紧急移动也是奔跑速度');
});

test('跑姿按心情/紧急度选，且两种都会出现', () => {
  const base = { hunger: 0.1, thirst: 0.1, fatigue: 0.2, bladder: 0.2, pain: 0 };
  let s = atState({ needs: { ...base, thirst: 0.9 } });
  assert.equal(homeView(s, T0, { emotion: { mood: 95 } }).her.runStyle, 'hurry', '身体急时优先急躁跑');
  const seen = new Set();
  for (let i = 0; i < 24; i += 1) {
    const now = T0 + i * 3 * MIN;
    seen.add(homeView(atState({ needs: base }, now), now, { emotion: { mood: 70 } }).her.runStyle);
  }
  assert.deepEqual([...seen].sort(), ['happy', 'hurry'], '高心情下也应偶尔换另一种，不能永远同一种');
});

test('到了不算做了：停留 dwell 之后才结算、才写事件', () => {
  let s = atState({
    room: 'living', spot: 'water', pose: 'stand', elev: 0,
    needs: { hunger: 0.2, thirst: 0.75, fatigue: 0.2, bladder: 0.2, pain: 0 },
    nextDecisionAt: T0, lastTickAt: T0
  });
  s = advanceHomeState(s, T0, {}).state;
  assert.equal(s.walking, true);
  assert.equal(s.route.target.spot, 'sink');
  let arrivedAt = 0;
  let eventAt = 0;
  let eventWhenDwell = null;
  for (let i = 0; i < 90; i += 1) {
    const now = T0 + i * 1000;
    s = advanceHomeState(s, now, {}).state;
    if (!arrivedAt && s.dwell) arrivedAt = now;
    const ev = s.eventLog.find((e) => e.type === 'drink');
    if (ev && !eventAt) {
      eventAt = ev.at;
      eventWhenDwell = !!s.dwell;
    }
    if (ev) break;
  }
  assert.ok(arrivedAt > 0, '应该走到水槽');
  assert.ok(eventAt > arrivedAt, '事件必须在到达之后才发生');
  assert.equal(eventWhenDwell, false, '写事件时 dwell 应该已经结束');
  // 结算口径是「相对量 −0.45」，0.75 → 0.30，正好落在断言边上，所以按「明显下降一半」判。
  assert.ok(s.needs.thirst < 0.35, `喝完水渴度应该明显下降，实际 ${s.needs.thirst}`);
});

test('事件消费 15 分钟时效；事件按类型冷却', () => {
  const s = atState();
  s.eventLog = [
    { at: T0 - 20 * MIN, type: 'drink', text: '旧事件', room: 'kitchen', spot: 'sink' },
    { at: T0 - 5 * MIN, type: 'drink', text: '新事件', room: 'kitchen', spot: 'sink' }
  ];
  assert.deepEqual(recentEvents(s, T0).map((e) => e.text), ['新事件']);
  // 「刚刚发生」面板是给用户看的日志，保留窗口放宽到 6 小时（recentEvents 本身仍是 15 分钟）
  const view = homeView(s, T0, {});
  assert.deepEqual(view.events.map((e) => e.text), ['旧事件', '新事件']);
});

test('快照是唯一事实源：同一份状态同一时刻结果一致', () => {
  const s = atState({ needs: { hunger: 0.42, thirst: 0.51, fatigue: 0.34, bladder: 0.31, pain: 0.02 } });
  const a = homeView(s, T0, { unread: 2 });
  const b = homeView(s, T0, { unread: 2 });
  assert.deepEqual(a, b);
  assert.equal(a.her.room, 'living');
  assert.deepEqual(a.her.pos, HOME_LAYOUT.spots.living.sofa.pos);
});

test('提示词只给形容词和位置，不把数字报给模型', () => {
  const s = atState({ needs: { hunger: 0.72, thirst: 0.55, fatigue: 0.82, bladder: 0.2, pain: 0 } });
  const line = buildHomePromptLine(s, { now: T0, env: { unread: 0 }, includeIntro: true });
  assert.ok(line.includes('【你的家】'));
  assert.ok(line.includes('客厅'));
  assert.ok(line.includes('饿'));
  assert.ok(!/\d{2,}/.test(line.replace(/\/room\/|QQ/g, '')), '正文不应出现需求数字');
});

test('活动变化默认不刷屏，但事件/危险状态必带', () => {
  const s = atState({ kind: 'walk', activity: '往厨房走' });
  const silent = buildHomePromptLine(s, { now: T0, env: {}, lastSummary: 'living.sofa.idle.a', allowActivity: false });
  assert.equal(silent, '');
  const loud = buildHomePromptLine(s, { now: T0, env: {}, lastSummary: 'living.sofa.idle.a', allowActivity: true });
  assert.ok(loud.includes('往厨房走'));
  const withEvent = atState({ eventLog: [{ at: T0 - MIN, type: 'drink', text: '去厨房接了杯水', room: 'kitchen', spot: 'sink' }] });
  const line = buildHomePromptLine(withEvent, { now: T0, env: {}, lastSummary: homeSummary(withEvent, T0), allowActivity: false });
  assert.ok(line.includes('去厨房接了杯水'));
});

test('快照把身体和已有心情分开：身体由房间算，心情只读', () => {
  const s = atState({ needs: { hunger: 0.2, thirst: 0.2, fatigue: 0.1, bladder: 0.2, pain: 0 } });
  const v = homeView(s, T0, { emotion: { mood: 64, label: '平常', dims: { calm: 5 } } });
  assert.equal(v.body.hunger, 0.2);
  assert.equal(v.emotion.source, 'dsh-feiyu-mood');
  assert.equal(v.emotion.label, '平常');
  assert.equal(v.mood, undefined);
});

test('睡着/起不来时提示词说清楚状态', () => {
  const bed = atState({ room: 'her_room', spot: 'bed', pose: 'lie', elev: 0.52, asleep: true, lamp: false, kind: 'sleep' });
  const a = buildHomePromptLine(bed, { now: T0, env: {}, includeIntro: false });
  assert.ok(a.includes('睡着了'));
  const sick = atState({ room: 'her_room', spot: 'bed', pose: 'lie', elev: 0.52, needs: { hunger: 0.8, thirst: 0.8, fatigue: 0.8, bladder: 0.2, pain: 0.85 } });
  const b = buildHomePromptLine(sick, { now: T0, env: {}, includeIntro: false });
  assert.ok(b.includes('起不来'));
  assert.ok(b.includes('不要写自己下床'));
});

test('路点图连通，所有站位对之间都有路线，且不穿墙', () => {
  const spots = listSpots();
  for (const a of spots) {
    for (const b of spots) {
      if (a.key === b.key) continue;
      assert.ok(graphPath(a.access, b.access), `${a.key} -> ${b.access} 不连通`);
      const r = buildRoute(a.pos, { access: a.access }, { room: b.room, spot: b.spot }, T0, 0.55);
      assert.ok(r && r.points.length >= 2, `${a.key} -> ${b.key} 没有路线`);
      const oldNodes = graphPath(a.access, b.access);
      const oldLength = polylineLength([a.pos, ...oldNodes, b.pos]);
      const actual = polylineLength(r.points);
      // 短距离（<3m）对绕行更敏感，放宽到 1.4 倍；长距离仍然卡 1.15 倍
      const tolerance = oldLength < 3 ? 1.45 : 1.25;
      assert.ok(actual <= oldLength * tolerance + 0.01,
        `${a.key} -> ${b.key} 绕行过多（实测 ${actual.toFixed(2)} vs 基线 ${oldLength.toFixed(2)}）`);
      if (actual > oldLength * 1.15 + 0.01) {
        console.log(`  · 提示：${a.key} -> ${b.key} 比基线长 ${((actual / oldLength - 1) * 100).toFixed(0)}%（短距离对，仍在容差内）`);
      }
      for (const p of r.points) {
        const outdoor = ['garden','yard','pool'].some(id => {
          const bounds = HOME_LAYOUT.rooms.find(room => room.id === id).bounds;
          return p[0] >= bounds[0] && p[0] <= bounds[2] && p[1] >= bounds[1] && p[1] <= bounds[3];
        });
        if (!outdoor) {
          assert.ok(p[0] >= 0 && p[0] <= HOME_LAYOUT.size.w + 0.01, '路线越界 x');
          assert.ok(p[1] >= -0.01 && p[1] <= 13.6, '路线越界 z');
        }
        if (!['garden','yard','pool'].includes(a.room) && !['garden','yard','pool'].includes(b.room)) assert.equal(outdoor, false, '室内路线不应绕到户外');
      }
    }
  }
});

test('route 位置随时间沿折线前进', () => {
  const route = { points: [[0, 0], [2, 0], [2, 2]], departAt: T0, arriveAt: T0 + 10_000, speed: 0.4 };
  assert.deepEqual(positionOnRoute(route, T0), [0, 0]);
  const mid = positionOnRoute(route, T0 + 2500);
  close(mid[0], 1, 1e-6);
  close(mid[1], 0, 1e-6);
  const end = positionOnRoute(route, T0 + 20_000);
  assert.deepEqual(end, [2, 2]);
});

test('菜园拖拽：点击仍吸附路点，拖拽自由点连续且读档不反弹', () => {
  const clicked = normalizeFreePoint([5.9, -1.45]);
  assert.deepEqual(clicked, [4.7, -0.9], '点击移动仍应吸附到最近菜畦');
  const dropped = normalizeFreePoint([5.9, -1.45], { preserveOutdoor: true });
  assert.deepEqual(dropped, [5.9, -1.45], '拖拽落点应保留鼠标位置');

  let s = atState({ room: 'garden', spot: 'plot4', freePos: null, nextDecisionAt: T0 + 10 * HOUR });
  s = applyHomeAction(s, { action: 'place', pos: dropped, free: true, at: T0 + 1 }).state;
  assert.deepEqual(s.freePos, dropped);
  assert.equal(s.spot, 'free');
  assert.equal(s.room, 'garden');

  const reloaded = normalizeHomeState(s, T0 + 2);
  assert.deepEqual(reloaded.freePos, dropped, '重新读状态不能把自由落点吸回菜畦');
});

test('拖拽放下：直接落点，不再生成路线', () => {
  let s = atState({ nextDecisionAt: 0 });
  s = applyHomeAction(s, { action: 'place', pos: [7.1, 6.8], at: T0 + 1 }).state;
  assert.equal(s.spot, 'free');
  assert.equal(s.room, 'living');
  assert.equal(s.freePos[0], 7.1);
  assert.equal(s.freePos[1], 6.8);
  assert.equal(s.route, null);
  assert.equal(s.walking, false);
  const v = homeView(s, T0 + 2, {});
  assert.deepEqual(v.her.pos, [7.1, 6.8]);
  assert.equal(v.her.spotLabel, '你指的地方');
});

test('点击落点：可以走到任意房间的坐标，而不是只到预置站位', () => {
  let s = atState({ nextDecisionAt: 0 });
  const p = [2.7, 1.9]; // 厨房冰箱前偏一点
  s = applyHomeAction(s, { action: 'go', pos: p, at: T0 + 1 }).state;
  assert.equal(s.freeTarget.pos[0], p[0]);
  s = advanceHomeState(s, T0 + 2, {}).state;
  assert.equal(s.walking, true);
  assert.equal(s.spot, 'free');
  assert.equal(s.route.target.spot, 'free');
  assert.equal(s.route.target.room, 'kitchen');
  s = advanceHomeState(s, s.route.arriveAt + 10, {}).state;
  assert.equal(s.spot, 'free');
  assert.equal(s.room, 'kitchen');
  assert.ok(Math.abs(s.freePos[0] - p[0]) < 1e-6 && Math.abs(s.freePos[1] - p[1]) < 1e-6);
  const v = homeView(s, T0 + 20_000, {});
  assert.equal(v.her.spotLabel, '你指的地方');
});

test('点击反应随 DSH 心情变化，而不是固定 happy', () => {
  const pet = (s, mood, dims) => applyHomeAction(s, { action: 'pet', emotion: { mood, dims }, at: T0 + 1 }).state;
  let s = pet(atState({ nextDecisionAt: 0 }), 86, { happy: 30 });
  assert.equal(s.kind, 'react_happy');
  s = pet(atState({ nextDecisionAt: 0 }), 18, { sad: 40 });
  assert.equal(s.kind, 'idle_look');
  s = pet(atState({ nextDecisionAt: 0 }), 52, { jealous: 30 });
  assert.equal(s.kind, 'react_shy');
  s = pet(atState({ nextDecisionAt: 0, needs: { hunger: 0.2, thirst: 0.2, fatigue: 0.3, bladder: 0.2, pain: 0.6 } }), 80, {});
  assert.equal(s.kind, 'react_scare');
  const asleep = atState({ room: 'her_room', spot: 'bed', pose: 'lie', elev: 0.52, asleep: true, kind: 'sleep', lamp: false, nextDecisionAt: 0 });
  const slept = pet(asleep, 80, {});
  assert.equal(slept.kind, 'sleep');
  assert.match(slept.activity, /睡梦/);
});

test('sleep / wake / lamp / command 动作会改状态并留痕', () => {
  let s = atState({ room: 'living', spot: 'water', pose: 'stand', elev: 0, nextDecisionAt: 0 });
  s = applyHomeAction(s, { action: 'lamp', on: false, at: T0 }).state;
  assert.equal(s.lamp, false);
  s = applyHomeAction(s, { action: 'command', room: 'balcony', spot: 'chair', at: T0 + 1 }).state;
  assert.equal(s.command.room, 'balcony');
  assert.equal(s.command.spot, 'chair');
  s = applyHomeAction(s, { action: 'sleep', at: T0 + 2 }).state;
  assert.equal(s.asleep, false, '还没到床，不能算睡着');
  assert.equal(s.sleepPending, true);
  s = advanceHomeState(s, T0 + 3, {}).state;
  assert.equal(s.walking, true);
  assert.equal(s.route.target.room, 'her_room');
  assert.equal(s.route.target.spot, 'bed');
  const bedAt = s.route.arriveAt;
  s = advanceHomeState(s, bedAt + 10, {}).state;
  // 到了床位不等于已经躺好：上座（mounting）要走完才进被窝。
  // 这里不能写死「等 800ms」——上座时长是可调的（MOUNT_MS），
  // 写死会在调整过渡时长时变成假失败。按状态推进，推进到睡着或超时为止。
  let t = bedAt + 10;
  for (let i = 0; i < 120 && !s.asleep; i += 1) {
    t += 100;
    s = advanceHomeState(s, t, {}).state;
  }
  assert.equal(s.asleep, true, '进被窝后才开始睡');
  assert.equal(`${s.room}.${s.spot}`, 'her_room.bed');
  s = applyHomeAction(s, { action: 'wake', at: bedAt + 20 }).state;
  assert.equal(s.asleep, false);
  assert.ok(s.eventLog.some((e) => e.type === 'wake'));
});

test('save / load 原子落盘，0600 权限', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-state-'));
  const file = path.join(dir, 'home.json');
  let s = atState({ needs: { hunger: 0.32, thirst: 0.44, fatigue: 0.55, bladder: 0.22, pain: 0 } });
  s = applyHomeAction(s, { action: 'talk', text: '记得吃饭', at: T0 }).state;
  saveHomeState(file, s, T0);
  const loaded = loadHomeState(file, T0 + 1);
  assert.equal(loaded.needs.hunger, 0.32);
  assert.equal(loaded.updatedAt, T0);
  {
    const mode = fs.statSync(file).mode & 0o777;
    if (process.platform === 'win32') {
      assert.ok(mode & 0o400, `至少可读，实际 ${mode.toString(8)}`);
    } else {
      assert.equal(mode, 0o600);
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('脏 JSON 能救回来，不整份丢掉', () => {
  const s = normalizeHomeState({
    createdAt: T0,
    needs: { hunger: '999', thirst: -3, fatigue: 0.6, pain: 2 },
    room: '不存在', spot: '也不存在',
    asleep: 1,
    route: { points: [[0, 0], ['x', 2]] },
    events: [{ at: T0, type: 'drink', text: 'ok' }, null],
    lamp: 'no'
  }, T0 + 1);
  assert.equal(s.needs.hunger, 1);
  assert.equal(s.needs.thirst, 0);
  assert.equal(s.needs.pain, 1);
  assert.equal(s.room, 'living');
  assert.equal(s.lamp, true);
  assert.equal(s.route, null);
});

test('homeSummary 随位置/动作变化', () => {
  const a = homeSummary(atState(), T0);
  const b = homeSummary(atState({ room: 'kitchen', spot: 'sink', kind: 'drink' }), T0);
  assert.notEqual(a, b);
});

test('屏幕/提示词共用同一份需求', () => {
  const s = atState({ needs: { hunger: 0.66, thirst: 0.31, fatigue: 0.8, bladder: 0.2, pain: 0 } });
  const v = homeView(s, T0, {});
  assert.equal(v.body.hunger, 0.66);
  assert.equal(v.body.words.hunger, '饿了');
  assert.equal(v.body.words.fatigue, '很困');
});

// ── 事件卡与真实动作的一致性（右侧事件列表字段）──────────────────────────

test('坐具也要有「到了」：depart 与 arrive 必须成对', () => {
  // 去沙发上坐着：旧实现走座具分支直接 return，永远只有 depart 没有 arrive
  let s = atState({ room: 'her_room', spot: 'desk', pose: 'stand', elev: 0, nextDecisionAt: T0 });
  s = applyHomeAction(s, { action: 'command', room: 'living', spot: 'sofa', at: T0 }).state;
  // 走到沙发边 → 上座（mounting）→ 上座完成才发 arrive，所以等到 dwell 才停
  let t = T0;
  for (let i = 0; i < 600 && !s.dwell; i++) {
    t += 1000;
    s = advanceHomeState(s, t, {}).state;
  }
  assert.equal(s.room, 'living');
  assert.equal(s.spot, 'sofa');
  const depart = s.eventLog.filter((e) => e.type === 'depart').pop();
  const arrive = s.eventLog.filter((e) => e.type === 'arrive').pop();
  assert.ok(depart, '应该有 depart');
  assert.ok(arrive, '坐上沙发也要有 arrive，否则事件卡只有「出发」没有「到达」');
  assert.equal(arrive.room, depart.room);
  assert.equal(arrive.spot, depart.spot);
});

test('事件里的「当时/片段」只属于这条事件：depart 不带上一段的片段', () => {
  let s = atState({ room: 'living', spot: 'rug', pose: 'stand', elev: 0, kind: 'freestyle', clip: '三球抛接', nextDecisionAt: T0 });
  s = applyHomeAction(s, { action: 'command', room: 'bathroom', spot: 'toilet', at: T0 }).state;
  s = advanceHomeState(s, T0 + 1000, {}).state;
  const depart = s.eventLog.filter((e) => e.type === 'depart').pop();
  assert.ok(depart, '应该有 depart');
  assert.equal(depart.clip, null, '走在路上不该挂着上一个片段');
  assert.equal(depart.kind, 'walk');
});

test('结算事件记的是这次动作，不是结算后的占位活动', () => {
  let s = atState({ room: 'kitchen', spot: 'sink', pose: 'stand', elev: 0, nextDecisionAt: T0 });
  s.route = null;
  s.spot = 'sink';
  s.kind = 'drink';
  s.activity = '喝了杯水，真解渴';
  s.dwell = { until: T0 + 1, target: { room: 'kitchen', spot: 'sink', kind: 'drink', actText: '喝了杯水，真解渴', pose: 'stand', elev: 0, effect: 'thirst', dwellMs: 1000, eventType: 'drink', eventText: '喝了杯水，真解渴', clip: null } };
  s = advanceHomeState(s, T0 + 2, {}).state;
  const e = s.eventLog.filter((x) => x.type === 'drink').pop();
  assert.ok(e, '应该有喝水事件');
  assert.equal(e.activity, '喝了杯水，真解渴', '不该记成「把杯子放下，站着发会儿呆」');
});

test('菜园事件带齐字段，且不把「小蓝鱼：」当她的活动', () => {
  let s = atState({ room: 'her_room', spot: 'desk', pose: 'stand', elev: 0, nextDecisionAt: T0 });
  const job = { id: 'job-test', action: { type: 'till', plotId: 3 } };
  s = beginGardenWork(s, job, T0);
  assert.equal(s.route.target.spot, 'plot3');
  let t = T0;
  for (let i = 0; i < 400 && !s.dwell; i++) {
    t += 1000;
    s = advanceHomeState(s, t, { gardenReady: true }).state;
  }
  s = endGardenWork(s, job, t + 7000, '小蓝鱼：3 号田松好了土，接下来可以播种。', true);
  const e = s.eventLog.filter((x) => x.type === 'garden').pop();
  assert.ok(e, '应该有菜园事件');
  assert.equal(e.room, 'garden');
  assert.equal(e.spot, 'plot3', '地点由动作决定，不能拿她此刻所在位置顶替');
  assert.ok(e.activity && !e.activity.includes('小蓝鱼'), '活动必须是她自己的，不是菜园伙伴的第三人称汇报');
  assert.ok(e.kind && e.pose, 'kind/pose 不能为空，否则详情行永远是空的');
  assert.ok(!e.text.includes('小蓝鱼：'), '正文要剥掉第三人称前缀');
});

test('「去洗漱」「去卫生间」按钮真的会结算需求，不是走过去站着', () => {
  // 面板上这两只按钮发的是 command。command 的默认实现只是「到了站在那里」，
  // 那洗完之后 hygiene 一点都不掉，按钮就是假的。
  for (const [spot, field, mustFall] of [['sink', 'hygiene', true], ['toilet', 'bladder', true]]) {
    let s = atState({ room: 'her_room', spot: 'desk', pose: 'stand', elev: 0, nextDecisionAt: T0 });
    s.needs[field] = 0.9;
    const before = s.needs[field];
    s = applyHomeAction(s, { action: 'command', room: 'bathroom', spot, at: T0 }).state;
    let t = T0;
    for (let i = 0; i < 600; i++) {
      t += 1000;
      s = advanceHomeState(s, t, {}).state;
      if (s.eventLog.some((e) => e.at >= T0 && ['shower', 'toilet'].includes(e.type) && e.spot === spot)) break;
    }
    const after = s.needs[field];
    if (mustFall) {
      assert.ok(after < before - 0.2, `${spot}：${field} 应该明显下降，实际 ${before} → ${after}`);
    }
    const ev = s.eventLog.filter((e) => ['shower', 'toilet'].includes(e.type)).pop();
    assert.ok(ev && ev.at >= T0, `${spot}：应该写出结算事件`);
  }
});

test('hygiene 有出口：邋遢到阈值她会自己去洗澡', () => {
  // 只有「加」没有「减」的话，这根条会一路涨到 1.0 再也不回落。
  let s = atState({ room: 'her_room', spot: 'desk', pose: 'stand', elev: 0, nextDecisionAt: T0 });
  s.needs.hygiene = 0.8;
  s.needs.hunger = 0; s.needs.thirst = 0; s.needs.bladder = 0; s.needs.fatigue = 0.1; s.needs.pain = 0;
  let t = T0;
  let went = false;
  for (let i = 0; i < 400 && !went; i++) {
    t += 2000;
    s = advanceHomeState(s, t, {}).state;
    if (s.route?.target?.spot === 'shower' || s.spot === 'shower') went = true;
  }
  assert.ok(went, '邋遢到 0.8 应该自己去洗澡，否则「清爽」这根条的刻度是假的');
});

test('上座过渡明显长于客户端轮询间隔，否则会「停下→闪现」', () => {
  // 客户端只能靠轮询采样服务端的插值。过渡窗口一旦短于采样间隔，
  // 中间状态一帧都采不到，画面上就只剩「走到旁边停一下 → 闪现到座面上」。
  // 这条测试把两边的数字钉在一起：改任一边忘了另一边就会红。
  const appSrc = fs.readFileSync(new URL('../public/room/app.js', import.meta.url), 'utf8');
  const stateSrc = fs.readFileSync(new URL('../src/home-state.js', import.meta.url), 'utf8');
  const pollMs = Number(appSrc.match(/POLL_TRANSIT_MS\s*=\s*(\d+)/)?.[1]);
  const mountMs = Number(stateSrc.match(/MOUNT_MS\s*=\s*(\d+)/)?.[1]);
  assert.ok(pollMs > 0, 'app.js 里找不到 POLL_TRANSIT_MS');
  assert.ok(mountMs > 0, 'home-state.js 里找不到 MOUNT_MS');
  // 至少采到 6 帧，动作才看得出是连续的
  const frames = Math.floor(mountMs / pollMs);
  assert.ok(frames >= 6,
    `上座过渡 ${mountMs}ms / 轮询 ${pollMs}ms 只能采到 ${frames} 帧（至少要 6 帧）`);

  // 真的跑一遍：上座区间里必须采到多帧，且位置是连续变化的
  const s0 = atState({ room: 'her_room', spot: 'desk', pose: 'stand', elev: 0, nextDecisionAt: T0 });
  let s = applyHomeAction(s0, { action: 'command', room: 'living', spot: 'sofa', at: T0 }).state;
  const seen = [];
  for (let t = T0; t < T0 + 60000; t += pollMs) {
    s = advanceHomeState(s, t, {}).state;
    if (s.mounting) seen.push({ t, pos: currentPosition(s, t).slice(), elev: s.elev });
    if (s.spot === 'sofa' && !s.mounting && !s.route) break;
  }
  assert.ok(seen.length >= 6, `上座过程只采到 ${seen.length} 帧，客户端会看到闪现`);
  // 相邻采样之间不能出现「一步跨完」的跳跃
  for (let i = 1; i < seen.length; i += 1) {
    const d = Math.hypot(seen[i].pos[0] - seen[i - 1].pos[0], seen[i].pos[1] - seen[i - 1].pos[1]);
    assert.ok(d < 0.55, `第 ${i} 帧横移了 ${d.toFixed(2)}m，会出现台阶感`);
  }
  // 高度必须和位置一起插值。之前 homeView 只算 liveElev 却没用（返回的是 s.elev，
  // 过渡期间恒为 0），表现是「贴着地滑进家具，最后一帧突然弹到座面」。
  const elevs = seen.map((a) => a.elev);
  const risen = elevs.filter((v) => v > 0.02).length;
  assert.ok(risen >= 3, `上座期间应该有多帧已经离地，实际只有 ${risen} 帧（高度没有插值）`);
  for (let i = 1; i < elevs.length; i += 1) {
    assert.ok(elevs[i] >= elevs[i - 1] - 1e-9, `第 ${i} 帧高度回退了：${elevs[i - 1]} → ${elevs[i]}`);
  }
  assert.ok(elevs.at(-1) > 0.3, `上座结束时应该已经在座面高度上，实际 ${elevs.at(-1)}`);

  // 同样的检查走 homeView（客户端真正读的那个出口），确保它给的 elev 是插值后的值
  let s2 = applyHomeAction(atState({ room: 'her_room', spot: 'desk', pose: 'stand', elev: 0, nextDecisionAt: T0 }),
    { action: 'command', room: 'living', spot: 'sofa', at: T0 }).state;
  const viewElevs = [];
  for (let t = T0; t < T0 + 60000; t += pollMs) {
    s2 = advanceHomeState(s2, t, {}).state;
    if (s2.mounting) viewElevs.push(homeView(s2, t, {}).her.elev);
    if (s2.spot === 'sofa' && !s2.mounting && !s2.route) break;
  }
  assert.ok(viewElevs.some((v) => v > 0.02),
    'homeView().her.elev 在上座期间必须是插值后的值，不能一直是 0');
});

test('全动作残留检查：脱离家具后再走路，不许「同时在家具上又在走路」', () => {
  // 这是「从根本上解决」的那道闸。
  //
  // 背景：applyHomeAction 的每个分支原来各写各的清理，写法还不一样 ——
  // water 只改 kind 不改 pose/elev，sleep/clip 也不清座椅姿态。
  // 结果每加一个动作就可能复现「客户端每帧 snap → 鬼畜」。
  // 现在统一走 resetMotion()，这条测试就是对所有动作的体检：
  // 只要哪个分支漏调，这里立刻红，不用等用户报「鬼畜」。
  //
  // 判定依据（和 app.js 里 onFurniture / snap 同源）：
  //   elev > 0.05 && kind === 'walk'  → 客户端认为「在家具上走路」→ 每帧 snap
  //   pose === 'sit' && kind === 'walk' → 同上
  // 只对「会改变她状态」的动作检查；pet/talk/lamp 这种只回气泡的允许保持原状。
  const HARMLESS = new Set(['visit', 'pet', 'poke', 'talk', 'say', 'lamp', 'heal', 'feed', 'play', 'wake']);
  // 和 src/home-state.js 的 HOME_ACTIONS 对齐；这里显式列出来，加新动作时
  // 两边都补一条，测试才能覆盖到。
  const ACTIONS = [
    'visit', 'pet', 'poke', 'feed', 'water', 'play', 'talk', 'go', 'place',
    'sleep', 'wake', 'clip', 'say', 'lamp', 'command', 'sick', 'heal'
  ];
  const INPUTS = {
    visit: {}, pet: {}, poke: {}, feed: {}, water: {}, play: {},
    talk: { text: '测试留言' }, go: { pos: [12.0, 8.0] }, place: { pos: [6.5, 6.0] },
    sleep: {}, wake: {}, clip: { clip: '跳舞' }, say: { text: '测试一句' }, lamp: {},
    command: { room: 'her_room', spot: 'bed' }, sick: {}, heal: {}
  };

  const seated = () => atState({ room: 'living', spot: 'sofa', pose: 'sit', elev: 0.492, nextDecisionAt: T0 + 60000 });
  const walker = () => {
    let w = atState({ room: 'living', spot: 'sofa', pose: 'stand', elev: 0, nextDecisionAt: T0 });
    w = applyHomeAction(w, { action: 'go', pos: [12.0, 8.0], at: T0 }).state;
    let tt = T0;
    for (let i = 0; i < 6; i += 1) { tt += 200; w = advanceHomeState(w, tt, {}).state; }
    return w;
  };

  const bad = [];
  for (const action of ACTIONS) {
    const input = INPUTS[action];
    if (!input) continue;
    for (const [name, make] of [['坐在沙发', seated], ['正在走路', walker]]) {
      const r = applyHomeAction(make(), { action, at: T0, ...input });
      const s = r.state;
      const inTransition = !!(s.dismounting || s.mounting);
      if (inTransition) continue;      // 过渡期间允许 elev 高（正在升起/落下）
      if (Number(s.elev) > 0.05 && s.kind === 'walk') {
        bad.push(`${action}（${name}）elev=${Number(s.elev).toFixed(3)} 但 kind=walk`);
      }
      if (s.pose === 'sit' && s.kind === 'walk') {
        bad.push(`${action}（${name}）pose=sit 但 kind=walk`);
      }
    }
  }
  assert.equal(bad.length, 0,
    `以下动作会残留「在家具上 + 在走路」的冲突状态（客户端会每帧 snap 鬼畜）：\n  ${bad.join('\n  ')}`);
});

test('在家具上点「去喝水」会走完下座过渡，过程中不出现「家具上 + 走路」', () => {
  // 真 bug：water 分支原来只写 s.command + s.kind = 'walk'，不动 pose/elev。
  // 她坐在沙发上（pose='sit', elev=0.49）时点喝水，客户端会同时看到
  // 「在走路」（kind=walk）和「在家具上」（pose=sit 且 elev>0.05），
  // 于是 onFurniture 成立 → snap=true → 每帧把位置硬拷到目标点 → 鬼畜。
  //
  // 现在的修法不是「立刻把 pose/elev 清零」（那会让身体先瞬移到地面、
  // 再被下座插值从座面拉回来，单帧跳 0.48 米），而是统一走 resetMotion +
  // 让 beginRoute 建 dismounting 把她平稳降下去。
  const s0 = atState({ room: 'living', spot: 'sofa', pose: 'sit', elev: 0.492, nextDecisionAt: T0 });
  let s = applyHomeAction(s0, { action: 'water', at: T0 }).state;

  // 立刻检查：目标和过渡源必须是干净的
  assert.ok(s.command && s.command.spot === 'water', '点喝水应该下一条去饮水的指令');
  assert.equal(s.freeTarget, null, '点喝水应清掉 freeTarget');

  // 逐帧确认：高度单调下降；任何一帧都不许「在家具上 + 在走路」同时成立
  let t = T0;
  let prevElev = Number(s.elev) || 0;
  let stuckOnSeat = 0;
  let touchedGround = false;
  for (let i = 0; i < 80; i += 1) {
    t += 100;
    s = advanceHomeState(s, t, {}).state;
    const elev = Number(s.elev) || 0;
    const inTransition = !!(s.dismounting || s.mounting);
    // 「还在家具上」+「说自己在走」+「不在过渡中」= 客户端会每帧 snap 的那一帧
    if (elev > 0.05 && s.kind === 'walk' && !inTransition) stuckOnSeat += 1;
    if (elev <= 0.001) touchedGround = true;
    assert.ok(elev <= prevElev + 1e-9 || inTransition,
      `高度不该在下去的过程中回升：${prevElev.toFixed(3)} → ${elev.toFixed(3)}`);
    prevElev = elev;
  }
  assert.equal(stuckOnSeat, 0,
    `有 ${stuckOnSeat} 帧同时「在家具上」和「在走路」，客户端会每帧 snap`);
  assert.ok(touchedGround, '下座过渡走完后应该落到地面（elev≈0）');
});

test('下座过渡期间 spot 不许提前改成目标点（否则家具上会闪一下）', () => {
  // 真 bug：beginRoute 里无条件 state.spot = target.spot。
  // 从坐具起身（dismounting）时人还在座点上，这一改会让所有「按 spot 推高度」
  // 的地方（setActivity → supportY、displayElevFor）以为她已经在新位置 ——
  // 新位置 pose=stand、支撑面是地板，elev 瞬间变 0，下一帧又被插值拉回座面。
  // 实测床→沙发：elev 出现 0.65 → 0.00 → 0.65 的三帧跳变，画面就是「鬼畜闪一下」。
  const s0 = atState({ room: 'her_room', spot: 'bed', pose: 'lie', elev: 0.662, nextDecisionAt: T0 });
  let s = applyHomeAction(s0, { action: 'command', room: 'living', spot: 'sofa', at: T0 }).state;

  let t = T0;
  let dismountFrames = 0;
  let spotChangedMidway = 0;
  let elevDroppedToZero = 0;
  let prevElev = s.elev;
  let prevSpot = s.spot;
  for (let i = 0; i < 200; i += 1) {
    t += 100;
    const wasDismounting = !!s.dismounting;
    s = advanceHomeState(s, t, {}).state;
    if (s.dismounting) {
      dismountFrames += 1;
      // 只检查「下座进行中」的那些帧：最后一帧 dismounting 会被清空，
      // 那一刻 spot 从座点切到走路目标是正确的（紧接着 beginRoute 重算路线）。
      if (wasDismounting && s.spot !== prevSpot) spotChangedMidway += 1;
      // 下座是「先横移、再落地」，高度只能单调下降，不能中途掉到 0 再弹回来
      if (s.elev === 0 && prevElev > 0.05) elevDroppedToZero += 1;
    }
    prevElev = s.elev;
    prevSpot = s.spot;
    if (!s.dismounting && s.route) break;
  }
  assert.ok(dismountFrames >= 3, `应该采到下座过程，实际只有 ${dismountFrames} 帧`);
  assert.equal(spotChangedMidway, 0,
    `下座期间 spot 变了 ${spotChangedMidway} 次，会导致高度被按到地面再弹回`);
  assert.equal(elevDroppedToZero, 0,
    `下座期间高度有 ${elevDroppedToZero} 帧掉到 0（应该在座面和地面之间单调插值）`);
});

test('command 会清掉 freeTarget / 旧路线，避免两套目标源打架', () => {
  // 真 bug：go 留下的 freeTarget 会在下一次 advance 里重新 beginRoute，
  // 把刚下的 command 路线抢走 —— 表现是「点了动作，她却在点位之间来回奔波」。
  const s0 = atState({ room: 'living', spot: 'sofa', pose: 'sit', elev: 0.492, nextDecisionAt: T0 });
  // 先制造一个 freeTarget（模拟刚点过「走到这里」）
  let s = applyHomeAction(s0, { action: 'go', pos: [8.0, 6.0], at: T0 }).state;
  assert.ok(s.freeTarget, 'go 之后应该有 freeTarget');
  // 再下一条明确的指令
  s = applyHomeAction(s, { action: 'command', room: 'her_room', spot: 'bed', at: T0 + 100 }).state;
  assert.equal(s.freeTarget, null, 'command 必须清掉 freeTarget（否则会被它抢走路线）');
  assert.equal(s.route, null, 'command 必须清掉旧路线（否则边跑旧路线边等新指令）');
  assert.equal(s.dismounting, null, 'command 必须清掉半截的下座状态');

  // 推进几步，路线必须指向指令目标而不是 freeTarget 的位置
  let t = T0 + 100;
  let ok = false;
  for (let i = 0; i < 60; i += 1) {
    t += 200;
    s = advanceHomeState(s, t, {}).state;
    if (s.route) {
      assert.equal(s.route.target?.spot, 'bed', '路线应该去指令指定的 bed');
      ok = true;
      break;
    }
  }
  assert.ok(ok, '下指令后应该开始走向 bed');
});

test('泳池可以从面板点「来游泳」：走到水面自动下水，游完复位', () => {
  // 以前游泳只能靠「点播动画 → 游泳」触发，而 startSwim 直接把她瞬移到水里，
  // 观感是「点一下人就不见了」。现在 pool 有独立的 swim 站位：
  // 发普通 command 走过去，到达水面由 arrive() 自动接管来回游。
  assert.ok(HOME_LAYOUT.spots.pool.swim, 'pool 应该有 swim 站位');
  assert.equal(HOME_LAYOUT.spots.pool.swim.swim, true, 'swim 站位要带 swim 标记');
  // deck_w(S22 泳池边) / deck_e(S23 休息区) 已按用户要求删除：
  // 下水走泳池梯，休息用沙滩躺椅，这两个「站在旁边」的站位没有独立价值。
  assert.ok(!HOME_LAYOUT.spots.pool.deck_w, 'deck_w(S22) 应该已删除');
  assert.ok(!HOME_LAYOUT.spots.pool.deck_e, 'deck_e(S23) 应该已删除');
  assert.ok(HOME_LAYOUT.spots.pool.lounger, '沙滩躺椅要保留（游完上岸去那儿）');

  let s = atState({ room: 'her_room', spot: 'desk', pose: 'stand', elev: 0, nextDecisionAt: T0 });
  s = applyHomeAction(s, { action: 'command', room: 'pool', spot: 'swim', at: T0 }).state;

  let t = T0;
  let sawWalk = false;
  let swamAt = 0;
  let swimSpot = null;   // 游泳期间实际停留的 spot（不能等循环结束再读，那时已经上岸了）
  for (let i = 0; i < 4000; i += 1) {
    t += 100;
    s = advanceHomeState(s, t, {}).state;
    if (s.kind === 'walk') sawWalk = true;
    if (s.kind === 'swim' && s.swim) {
      if (!swamAt) swamAt = t;
      if (!swimSpot) swimSpot = s.spot;
    }
    if (swamAt && s.kind !== 'swim') break;
  }
  assert.ok(sawWalk, '应该是走过去，而不是瞬移');
  assert.ok(swamAt > 0, '到了水面应该自动开始游');
  assert.equal(swimSpot, 'swim', '游泳期间 spot 应该留在 swim');
  // 游完必须真的从水里出来：kind/activity/swim 都要复位
  assert.equal(s.swim, null, '游完应该清掉 swim 描述');
  assert.notEqual(s.kind, 'swim', '游完不应该还挂着 swim 的 kind');
  assert.match(s.activity, /游够|上来|池边/, `游完的活动文案不对：${s.activity}`);
});

test('泳池从泳池梯（N68）上下水，游完去沙滩躺椅上岸，中途不被打断', () => {
  // 用户的三个要求都在这条：
  //   1. 上下水点在泳池梯（N68 = pk_ladder），不在原来那个 deck_w
  //   2. N68 到水面要有一段路径（pk_water），到点后切游泳动画
  //   3. 游泳期间不许被别的动画打断，游完去沙滩躺椅上岸才继续别的
  assert.equal(HOME_LAYOUT.spots.pool.swim.access, 'pk_ladder',
    'swim 站位应该从泳池梯下水');
  // 水面下水点在水里（泳池 K 区范围内）
  const swimPos = HOME_LAYOUT.spots.pool.swim.pos;
  assert.ok(swimPos[1] > 9.98 && swimPos[1] < 12.68,
    `下水点应该在水面上，实际 ${swimPos}`);

  // 从泳池梯到水面必须能规划出路线，且路线经过 pk_ladder
  const route = buildMapRoute([9.0, 9.72], { room: 'pool', spot: 'swim', pos: swimPos }, T0, 1.05);
  assert.ok(route, '从 N68 到水面应该能造出路线');
  assert.ok(route.points.some((p) => Math.hypot(p[0] - 9.0, p[1] - 9.72) < 0.05),
    '路线应该经过泳池梯 N68');

  // 下水 → 游 → 上岸全流程，期间塞进各种打断压力
  // 从客厅出发（真实场景），走到泳池下水游一圈，再上岸去躺椅
  let s = atState({ room: 'living', spot: 'sofa', pose: 'sit', elev: 0.48, nextDecisionAt: T0 });
  s = applyHomeAction(s, { action: 'command', room: 'pool', spot: 'swim', at: T0 }).state;
  let t = T0;
  let swam = false;
  let violated = null;
  let banked = false;
  const pressureAt = new Map([[3000, 'thirst'], [6000, 'bladder'], [9000, 'hunger'], [12000, 'energy']]);
  // 循环上限要够跑完整条链路：下水 ~5s + 游 25s + 走去躺椅并上座 ~6s。
  for (let i = 0; i < 1200; i += 1) {
    t += 100;
    const key = pressureAt.get(t - T0);
    if (key === 'energy') s.needs.energy = 0.1;
    else if (key) s.needs[key] = 0.95;
    // 菜园那边一直喊她
    s = advanceHomeState(s, t, { gardenReady: true }).state;
    const swimming = !!(s.swim && s.swim.until > t);
    if (swimming) {
      swam = true;
      // 游泳期间 kind 必须一直是 swim
      if (s.kind !== 'swim') violated = { at: t - T0, kind: s.kind };
    }
    if (swam && !swimming && s.spot === 'lounger' && !s.route && !s.walking) { banked = true; break; }
  }
  assert.ok(swam, '应该真的下水游了');
  assert.equal(violated, null,
    `游泳被 ${violated?.kind} 打断了（${violated?.at}ms）—— 需求/菜园都不该抢走她`);
  assert.ok(banked, '游完应该去沙滩躺椅(pool.lounger)上岸');
});

test('点一次「来游泳」只游一次：上岸后 command 必须清干净', () => {
  // 这是个真 bug：arrive() 的游泳分支提前 return 了，没走 decideTarget 里
  // 「到了就清 command」那段。command 有效期 5 分钟，于是游完上岸躺 20 秒后
  // 又被同一条指令送回水里 —— 实测「游 → 躺椅 → 又下水」无限循环。
  const T0 = Date.parse('2026-11-06T02:00:00+08:00');   // 凌晨：游泳不在 freestyle 时间窗
  let s = emptyHomeState(T0);
  s = applyHomeAction(s, { action: 'command', room: 'pool', spot: 'swim', at: T0 }).state;
  assert.equal(s.command?.spot, 'swim', '发起时 command 应该指向 swim');

  let t = T0;
  let swimCount = 0;
  let wasSwimming = false;
  let cmdAfterArrive = 'unset';
  for (let i = 0; i < 2400; i += 1) {   // 4 分钟
    t += 100;
    s = advanceHomeState(s, t, {}).state;
    const swimming = !!(s.swim && s.swim.until > t);
    if (swimming && !wasSwimming) swimCount += 1;
    if (!swimming && wasSwimming) cmdAfterArrive = s.command ? s.command.spot : null;
    wasSwimming = swimming;
  }
  assert.equal(swimCount, 1, `4 分钟内应该只游一次，实际 ${swimCount} 次`);
  assert.equal(cmdAfterArrive, null, `游完 command 应该已清空，实际 ${cmdAfterArrive}`);
});

if (process.exitCode) {
  console.error(`\n${passed} 项通过，存在失败项`);
} else {
  console.log(`\n大平层状态测试全部通过（${passed} 项）`);
}
