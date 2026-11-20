#!/usr/bin/env node
// 动作表一致性测试：public/room/action-map.js 是 kind → (片段, 气泡) 的唯一事实源。
// 它同时被两侧读取：页面渲染（public/room/app.js 的 clipFor）和快照（src/home-state.js 的 speechFor）。
// 所以这里断言两件事——片段名必须真能加载，气泡必须真的说出来。
// 跑法：node scripts/test-action-map.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ACTION_MAP, SEATED_FALLBACK, FREESTYLE_BUBBLE,
  actionClip, actionSeatedClip, actionBubble
} from '../public/room/action-map.js';
import { CLIPS } from '../public/room/actor.js';
import { homeView, emptyHomeState, HOME_LAYOUT } from '../src/home-state.js';

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
const kinds = Object.keys(ACTION_MAP);

test('动作表覆盖了所有会被渲染的 kind', () => {
  // 这几个是 home-state 真正会产出并交给 clipFor 的 kind；
  // 漏一个就会掉回旧的关键词兜底，也就是用户看到「本鱼在这儿呢」的那种情况。
  const required = [
    'idle', 'free', 'sit', 'walk', 'eat', 'drink', 'toilet', 'bath', 'nap', 'sleep', 'wake',
    'laundry', 'sick', 'help', 'swim', 'tv', 'phone', 'play', 'desk', 'balcony', 'freestyle',
    'react_happy', 'react_shy', 'react_scare', 'idle_look',
    'garden_till', 'garden_plant', 'garden_water', 'garden_fertilize', 'garden_harvest',
    'garden_sell', 'garden_buySeed', 'garden_buyCompost', 'garden_visit'
  ];
  const missing = required.filter((k) => !kinds.includes(k));
  assert.equal(missing.length, 0, `动作表缺少 kind：${missing.join(', ')}`);
});

test('表里的每个片段名都在 CLIPS 注册表里', () => {
  const bad = [];
  for (const [kind, def] of Object.entries(ACTION_MAP)) {
    const samples = [
      ['clip', typeof def.clip === 'function' ? def.clip({ activity: '' }) : def.clip],
      ['seated', typeof def.seated === 'function' ? def.seated({ activity: '' }) : def.seated]
    ];
    for (const [slot, value] of samples) {
      if (!value) continue;
      if (!CLIPS[value]) bad.push(`${kind}.${slot} → ${value}`);
    }
  }
  assert.equal(bad.length, 0, `这些片段在 actor.js 里不存在：\n${bad.join('\n')}`);
});

test('函数型片段对真实文案也能给出合法片段', () => {
  // 这几个 kind 按 activity 文案细分，必须两条分支都落在 CLIPS 里。
  const cases = [
    ['eat', { activity: '抱着一袋小鱼干，坐在厨房边吃' }, 'eat_snack'],
    ['eat', { activity: '坐在餐桌边，小口小口地吃' }, '吃午餐'],
    ['bath', { activity: '在淋浴间冲了个澡' }, '换装浴袍'],
    ['bath', { activity: '站在洗手台前刷牙洗脸' }, '洗脸'],
    ['balcony', { activity: '在躺椅上躺着吹海风' }, 'mooncake', { night: true }],
    ['balcony', { activity: '在躺椅上躺着吹海风' }, 'fan', { night: false }]
  ];
  for (const [kind, her, expect, ctx = {}] of cases) {
    const got = actionClip(kind, her, ctx);
    assert.equal(got, expect, `${kind}(${her.activity}) 应为 ${expect}，实际 ${got}`);
    assert.ok(CLIPS[got], `${got} 不在 CLIPS 里`);
  }
});

test('坐姿专用片段都存在，且通用兜底可用', () => {
  assert.ok(CLIPS[SEATED_FALLBACK], `通用坐姿兜底 ${SEATED_FALLBACK} 不在 CLIPS 里`);
  const seatedKinds = Object.entries(ACTION_MAP).filter(([, d]) => d.seated);
  assert.ok(seatedKinds.length >= 5, '坐姿专用片段太少，穿模问题没被覆盖');
  for (const [kind, def] of seatedKinds) {
    const clip = actionSeatedClip(kind);
    assert.ok(clip && CLIPS[clip], `${kind} 的坐姿片段 ${clip} 不可用`);
  }
});

test('每个 kind 都有非空气泡，且不落回「本鱼在这儿呢」兜底', () => {
  const bad = [];
  for (const kind of kinds) {
    const text = actionBubble(kind, '');
    if (kind === 'freestyle') continue;          // 它的台词按 CATALOG 分组走
    if (!text) bad.push(`${kind}: 空`);
    else if (text === '本鱼在这儿呢') bad.push(`${kind}: 仍是兜底台词`);
  }
  assert.equal(bad.length, 0, `气泡缺失：\n${bad.join('\n')}`);
});

test('freestyle 的每个分组都有台词', () => {
  for (const group of ['玩耍', '起居', '吃喝', '才艺', '工作', '节日', '运动', '情绪', '其它']) {
    assert.ok(FREESTYLE_BUBBLE[group], `freestyle 分组「${group}」没有台词`);
  }
});

test('快照里的气泡跟着 kind 走，而不是永远一句兜底', () => {
  const cases = [
    ['her_room', 'desk', 'desk', '趴在书桌前写写画画', '本鱼在写东西，别吵～'],
    ['living', 'sofa', 'tv', '窝在沙发上，抱着抱枕看屏幕', '本鱼在打游戏呢！'],
    ['living', 'sofa', 'phone', '低头看手机，有人在 QQ 找你', '本鱼在刷手机～'],
    ['living', 'sofa', 'nap', '抱着抱枕在沙发上打盹', '本鱼打个盹…'],
    ['bathroom', 'sink', 'bath', '在淋浴间冲了个澡', '本鱼洗香香～'],
    ['laundry', 'washer', 'laundry', '把洗好的衣服叠起来', '本鱼把衣服叠整齐～'],
    ['balcony', 'chair', 'balcony', '在躺椅上躺着吹海风', '吹吹风，好舒服～'],
    ['pool', 'deck_w', 'swim', '在泳池里游来游去', '本鱼游两圈～'],
    ['her_room', 'bedside', 'react_happy', '被摸了摸头，尾巴晃得停不下来', '嘿嘿…再摸一下']
  ];
  const lines = [];
  for (const [room, spot, kind, activity, expect] of cases) {
    const s = emptyHomeState(T0);
    Object.assign(s, {
      room, spot, kind, activity, pose: HOME_LAYOUT.spots[room]?.[spot]?.pose || 'stand',
      elev: 0, walking: false, route: null, dwell: null, sayText: '', sayUntil: 0
    });
    const v = homeView(s, T0, {});
    if (v.her.speech !== expect) lines.push(`${kind}: 期望「${expect}」实际「${v.her.speech}」`);
  }
  assert.equal(lines.length, 0, lines.join('\n'));
});

test('她主动说话时气泡必须是原话，不被动作覆盖', () => {
  const s = emptyHomeState(T0);
  Object.assign(s, {
    room: 'her_room', spot: 'desk', kind: 'desk', activity: '趴在书桌前写写画画',
    pose: 'stand', elev: 0, walking: false, route: null, dwell: null,
    sayText: '我先忙一会儿，等我写完就来找你', sayUntil: T0 + 12_000
  });
  const v = homeView(s, T0, {});
  assert.equal(v.her.speech, '我先忙一会儿，等我写完就来找你');
  assert.equal(v.her.say, '我先忙一会儿，等我写完就来找你');
});

test('home-state 的气泡也走同一张表', () => {
  const src = fs.readFileSync(new URL('../src/home-state.js', import.meta.url), 'utf8');
  assert.ok(src.includes('actionBubble('), 'speechFor 应先查 actionBubble');
  assert.ok(src.includes('FREESTYLE_BUBBLE'), 'freestyle 气泡应按 CATALOG 分组');
});

if (process.exitCode) {
  console.error(`\n${passed} 项通过，存在失败项`);
} else {
  console.log(`\n动作表一致性测试全部通过（${passed} 项）`);
}
