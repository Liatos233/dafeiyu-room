#!/usr/bin/env node
// 房间状态单测：不连桥接、不起服务，只测 src/room-state.js 的纯函数 + 落盘。
// 跑法：npm run test:room
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ROOM_ACTIONS,
  applyRoomAction,
  buildRoomPromptLine,
  describeRoomEvent,
  emptyRoomState,
  loadRoomState,
  markRoomEventsSeen,
  normalizeRoomState,
  roomStage,
  roomView,
  sanitizeText,
  saveRoomState
} from '../src/room-state.js';

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

const T0 = 1_700_000_000_000;
const MIN = 60_000;

test('emptyRoomState 是干净的初始房间', () => {
  const room = emptyRoomState(T0);
  assert.equal(room.affection, 0);
  assert.equal(room.visits, 0);
  assert.equal(room.lamp, true);
  assert.deepEqual(room.events, []);
  assert.deepEqual(room.notes, []);
});

test('visit 在 30 分钟内只算一次', () => {
  let { state } = applyRoomAction(emptyRoomState(T0), { action: 'visit', at: T0 });
  assert.equal(state.visits, 1);
  ({ state } = applyRoomAction(state, { action: 'visit', at: T0 + 5 * MIN }));
  assert.equal(state.visits, 1, '刷新页面不应刷访问次数');
  ({ state } = applyRoomAction(state, { action: 'visit', at: T0 + 31 * MIN }));
  assert.equal(state.visits, 2);
});

test('摸头/喂食/戳一下改变小屋好感，poke 不会扣成负数', () => {
  let { state } = applyRoomAction(emptyRoomState(T0), { action: 'pet', at: T0 });
  assert.equal(state.affection, 1);
  ({ state } = applyRoomAction(state, { action: 'feed', at: T0 + 1 }));
  assert.equal(state.affection, 3);
  ({ state } = applyRoomAction(state, { action: 'poke', at: T0 + 2 }));
  assert.equal(state.affection, 2);
  for (let i = 0; i < 10; i += 1) ({ state } = applyRoomAction(state, { action: 'poke', at: T0 + 10 + i }));
  assert.equal(state.affection, 0);
});

test('好感度封顶 100，阶段随分数变化', () => {
  let state = emptyRoomState(T0);
  for (let i = 0; i < 80; i += 1) ({ state } = applyRoomAction(state, { action: 'feed', at: T0 + i }));
  assert.equal(state.affection, 100);
  assert.equal(roomStage(0).name, '刚搬进来');
  assert.equal(roomStage(10).name, '眼熟');
  assert.equal(roomStage(25).name, '亲近');
  assert.equal(roomStage(50).name, '熟络');
  assert.equal(roomStage(75).name, '粘人');
});

test('talk 留言会进 notes，控制字符和长度被清洗', () => {
  const dirty = `  今天\u0007也想\u0000你了${'啊'.repeat(200)}  `;
  const { state, changed } = applyRoomAction(emptyRoomState(T0), { action: 'talk', text: dirty, at: T0 });
  assert.equal(changed, true);
  assert.equal(state.notes.length, 1);
  assert.ok(!/[\u0000-\u001f]/.test(state.notes[0].text));
  assert.ok(state.notes[0].text.length <= 120);
  assert.equal(state.events.at(-1).action, 'talk');
});

test('空留言不算一次动作', () => {
  const { changed } = applyRoomAction(emptyRoomState(T0), { action: 'talk', text: '   ', at: T0 });
  assert.equal(changed, false);
});

test('lamp 可以指定开关，并写进事件文本', () => {
  let { state } = applyRoomAction(emptyRoomState(T0), { action: 'lamp', on: false, at: T0 });
  assert.equal(state.lamp, false);
  assert.equal(state.events.at(-1).text, 'off');
  ({ state } = applyRoomAction(state, { action: 'lamp', on: true, at: T0 + 1 }));
  assert.equal(state.lamp, true);
  assert.equal(state.events.at(-1).text, 'on');
  const auto = applyRoomAction(state, { action: 'lamp', at: T0 + 2 }).state;
  assert.equal(auto.lamp, false, '不传 on 时应该切换');
});

test('事件最多留 60 条，notes 最多 20 条', () => {
  let state = emptyRoomState(T0);
  for (let i = 0; i < 80; i += 1) ({ state } = applyRoomAction(state, { action: 'pet', at: T0 + i }));
  assert.equal(state.events.length, 60);
  state = emptyRoomState(T0);
  for (let i = 0; i < 30; i += 1) ({ state } = applyRoomAction(state, { action: 'talk', text: `第 ${i} 句`, at: T0 + i }));
  assert.equal(state.notes.length, 20);
  assert.equal(state.notes.at(-1).text, '第 29 句');
});

test('roomView 只给页面需要的房间字段', () => {
  const { state } = applyRoomAction(emptyRoomState(T0), { action: 'pet', at: T0 });
  const view = roomView(state, T0 + 1);
  assert.equal(view.affection, 1);
  assert.equal(view.stage, '刚搬进来');
  assert.ok(Array.isArray(view.events));
  assert.equal(view.events[0].by, '');
});

test('buildRoomPromptLine：没事件时不打扰，首次介绍带说明', () => {
  const room = emptyRoomState(T0);
  assert.equal(buildRoomPromptLine(room, { now: T0, includeIntro: false }), '');
  const intro = buildRoomPromptLine(room, { now: T0, includeIntro: true });
  assert.ok(intro.includes('【你的小屋】'));
  assert.ok(intro.includes('qq_send_room_photo'));
  assert.ok(intro.includes('灯亮着'));
});

test('buildRoomPromptLine：有人来过时播报，标已读后不再重复', () => {
  let { state } = applyRoomAction(emptyRoomState(T0), { action: 'pet', at: T0 });
  ({ state } = applyRoomAction(state, { action: 'talk', text: '记得吃饭', at: T0 + 1 }));
  const line = buildRoomPromptLine(state, { now: T0 + 2, seenAt: 0 });
  assert.ok(line.includes('你摸了摸她的头'));
  assert.ok(line.includes('记得吃饭'));
  const seen = markRoomEventsSeen(state, T0 + 3);
  assert.equal(buildRoomPromptLine(seen, { now: T0 + 4, seenAt: seen.seenAt, includeIntro: false }), '');
});

test('describeRoomEvent 会说人话', () => {
  assert.equal(describeRoomEvent({ action: 'pet' }), '你摸了摸她的头');
  assert.equal(describeRoomEvent({ action: 'talk', text: '晚安' }), '你留了句话：「晚安」');
  assert.equal(describeRoomEvent({ action: 'lamp', text: 'off' }), '你把灯关闭了');
});

test('normalizeRoomState 能从脏 JSON 里救回房间', () => {
  const room = normalizeRoomState({
    affection: '999',
    visits: -3,
    lamp: 'yes',
    events: [{ action: 'pet', at: T0 }, { action: 'hack', at: T0 }, null],
    notes: [{ at: T0, text: 'hi' }]
  }, T0 + 1);
  assert.equal(room.affection, 100);
  assert.equal(room.visits, 0);
  assert.equal(room.lamp, true);
  assert.equal(room.events.length, 1);
  assert.equal(room.notes.length, 1);
});

test('超过 7 天的事件会被清掉', () => {
  const room = normalizeRoomState({ events: [{ action: 'pet', at: T0 }] }, T0 + 8 * 24 * 60 * MIN);
  assert.equal(room.events.length, 0);
});

test('saveRoomState / loadRoomState 原子落盘并保持字段', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-state-'));
  const file = path.join(dir, 'room.json');
  const { state } = applyRoomAction(emptyRoomState(T0), { action: 'talk', text: '留在墙上', at: T0 });
  saveRoomState(file, state, T0);
  const loaded = loadRoomState(file, T0 + 1);
  assert.equal(loaded.notes[0].text, '留在墙上');
  assert.equal(loaded.updatedAt, T0);
  const mode = fs.statSync(file).mode & 0o777;
  if (process.platform === 'win32') {
    // Windows 不保证 POSIX 权限位，只要求文件可读
    assert.ok(mode & 0o400, `房间状态至少可读，实际 ${mode.toString(8)}`);
  } else {
    assert.equal(mode, 0o600, '房间状态是私有数据，0600');
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('sanitizeText 去控制符、折叠空白', () => {
  assert.equal(sanitizeText('  a\u0001 b\n c  '), 'a b c');
  assert.equal(sanitizeText('x'.repeat(200)).length, 120);
});

test('动作清单与页面约定一致', () => {
  assert.deepEqual([...ROOM_ACTIONS], ['visit', 'pet', 'poke', 'feed', 'play', 'talk', 'sleep', 'wake', 'lamp']);
});

test('立绘动作片段都可加载（基础 + 中文扩展）', () => {
  const actorSource = fs.readFileSync(new URL('../public/room/actor.js', import.meta.url), 'utf8');
  const publicDir = new URL('../public/room/', import.meta.url);

  // 1) 基础英文 clip 必须齐全（走位/待机/反应）
  for (const clip of ['idle', 'walk', 'walk_fast', 'run_happy', 'run_hurry', 'sleep_in', 'sleep_loop', 'sleep_out', 'dance']) {
    assert.ok(new RegExp(`\\n  ${clip}:`).test(actorSource), `actor.js 缺少基础片段：${clip}`);
  }

  // 2) GEN_CLIPS 里每个路径都要在磁盘上真实存在
  const genBlock = actorSource.slice(actorSource.indexOf('export const GEN_CLIPS'));
  const entries = [...genBlock.matchAll(/'([^']+)':\s*'(assets\/[^']+)'/g)];
  assert.ok(entries.length >= 100, `GEN_CLIPS 条目过少：${entries.length}`);
  const missing = [];
  for (const [, name, rel] of entries) {
    if (!fs.existsSync(new URL(rel, publicDir))) missing.push(`${name} → ${rel}`);
  }
  assert.equal(missing.length, 0, `以下动作文件缺失：\n${missing.slice(0, 10).join('\n')}`);
});

test('动作面板清单里的动作都能在 CLIPS 中找到', () => {
  const appSource = fs.readFileSync(new URL('../public/room/app.js', import.meta.url), 'utf8');
  const actorSource = fs.readFileSync(new URL('../public/room/actor.js', import.meta.url), 'utf8');
  const manifest = fs.readFileSync(new URL('../public/room/action-manifest.js', import.meta.url), 'utf8');
  const names = [...manifest.matchAll(/^      '([^']+)',$/gm)].map((m) => m[1]);
  assert.ok(names.length > 200, `清单动作过少：${names.length}`);

  const missing = names.filter((n) => !actorSource.includes(`'${n}':`));
  assert.equal(missing.length, 0, `清单里有动作在 actor.js 找不到：\n${missing.slice(0, 10).join('\n')}`);
  assert.ok(appSource.includes('ACTION_GROUPS'), 'app.js 应使用清单渲染动作面板');
});

if (process.exitCode) {
  console.error(`\n${passed} 项通过，存在失败项`);
} else {
  console.log(`\n房间状态测试全部通过（${passed} 项）`);
}
