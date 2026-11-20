#!/usr/bin/env node
// 需求指标条一致性测试：public/room/need-bars.js 是「条怎么算 / 刻度画在哪」的唯一事实源。
// 这里守三条线：
//   1) 后端每个 needs 字段都有一根对应的条（漏一个，那件事在面板上就是隐形的）；
//   2) 条上的刻度 = home-state 里她自己的行为阈值（数字漂移了刻度就在说谎）；
//   3) 页面不再自己算一套（没有硬编码刻度、没有 moodTips、没有躺椅假上座残留）。
// 跑法：node scripts/test-need-bars.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEED_BARS, NEED_THRESHOLDS, barPercents, tickPercents, glowActions } from '../public/room/need-bars.js';
import { homeView, emptyHomeState, HOME_ACTIONS } from '../src/home-state.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
// 只留代码、去掉 // 与 /* */ 注释：有些检查项（比如「不许再出现 chaisePlay」）
// 要允许注释里提到旧实现，否则把删掉的原因写进注释反而会挂测试。
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

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

test('后端每个 needs 字段都有一根对应的条（疼痛除外，它改成了生病标签）', () => {
  const s = emptyHomeState(T0);
  const body = homeView(s, T0).body;
  // pain 不是连续条：它没有自然增长源，长期满格没有信息量，
  // 改成头部「生病」标签（由 her.immobile 驱动）。所以从覆盖检查里排除。
  const fields = Object.keys(body).filter((k) => k !== 'words' && k !== 'pain');
  const covered = new Set(NEED_BARS.map((b) => b.field));
  const missing = fields.filter((f) => !covered.has(f));
  assert.equal(missing.length, 0, `这些需求没有对应的指标条：${missing.join(', ')}`);
  // 反向也要紧：条指向的字段必须真的存在，否则那根条永远读 undefined
  const ghost = [...covered].filter((f) => !(f in body));
  assert.equal(ghost.length, 0, `这些条指向的字段 homeView().body 里没有：${ghost.join(', ')}`);
  assert.ok(!covered.has('pain'), 'pain 不该有指标条，它走头部「生病」标签');
  assert.equal(NEED_BARS.length, 5, '应该正好五根条');
});

test('刻度数字和 home-state 里的行为阈值一一对应（防漂移）', () => {
  const src = readText('src/home-state.js');
  // 每一项都对应 decideTarget / advanceHomeState 里真实存在的那一行 if。
  // act = 到了会自己处理，urgent = 到了算紧急。needs 现在全部「越高越糟」。
  const anchors = [
    ['hunger.act', ['n.hunger >= 0.66'], 0.66],
    ['thirst.act', ['n.thirst >= 0.62'], 0.62],
    ['bladder.act', ['n.bladder >= 0.7'], 0.7],
    ['hygiene.act', ['n.hygiene >= 0.78'], 0.78],
    ['energy.act', ['n.fatigue >= 0.72'], 0.72],
    ['hunger.urgent', ['n.hunger >= 0.88'], 0.88],
    ['thirst.urgent', ['n.thirst >= 0.86'], 0.86],
    ['bladder.urgent', ['n.bladder >= 0.93'], 0.93],
    ['hygiene.urgent', ['n.hygiene >= 0.92'], 0.92],
    ['energy.urgent', ['n.fatigue > 0.95', 'n.fatigue >= 0.95'], 0.95]
  ];
  for (const [label, needles, value] of anchors) {
    const [group, side] = label.split('.');
    assert.equal(NEED_THRESHOLDS[group][side], value, `need-bars 里 ${label} 应该是 ${value}`);
    assert.ok(
      needles.some((needle) => src.includes(needle)),
      `home-state.js 里找不到 ${label} 的行为阈值（试过：${needles.join(' / ')}）。` +
      '改行为阈值时必须同步改 need-bars.js，否则条上的刻度会指向一个不存在的动作。'
    );
  }
});

test('取反的条把刻度镜像过去了，不会画反', () => {
  // 现在**每一根**都是 low-good（后端全部「越高越糟」），全部镜像。
  // hunger 原始 0.66 → 条上落在 34%，而不是 66%
  const hunger = tickPercents('hunger');
  assert.equal(hunger.act, 34);
  assert.equal(hunger.urgent, 12);
  // energy 走 fatigue：原始 0.72（很累）→ 条上体力只剩 28%
  const energy = tickPercents('energy');
  assert.equal(energy.act, 28);
  assert.equal(energy.urgent, 5);
  // 没有刻度配置的 key 返回 null，不抛错
  assert.equal(tickPercents('nope'), null);
  assert.equal(tickPercents('pain'), null, 'pain 没有条，也不该有刻度');
});

test('每根条都是「满 = 好」，取值一律落在 0~1', () => {
  // 一个「很糟」的身体：饿 0.9、渴 0.9、邋遢 0.9、疲劳 0.95、憋 1.0
  const bad = barPercents({ hunger: 0.9, thirst: 0.9, hygiene: 0.9, fatigue: 0.95, bladder: 1 });
  assert.ok(Math.abs(bad.hunger - 0.1) < 1e-9, '饿 0.9 时饱腹条应该是 10%');
  assert.ok(Math.abs(bad.hygiene - 0.1) < 1e-9, '邋遢 0.9 时清爽条应该是 10%');
  assert.ok(Math.abs(bad.energy - 0.05) < 1e-9, '疲劳 0.95 时体力条应该是 5%');
  assert.equal(bad.bladder, 0, '憋到 1.0 时轻松条应该是 0%');
  // 一个「很健康」的身体：所有条都该是满的
  const good = barPercents({ hunger: 0, thirst: 0, hygiene: 0, fatigue: 0, bladder: 0 });
  for (const [k, v] of Object.entries(good)) {
    if (k === 'mood') continue;
    assert.ok(Math.abs(v - 1) < 1e-9, `${k} 在健康状态下应该是满条，实际 ${v}`);
  }
  // 脏数据不炸，也不会越界
  const dirty = barPercents({ hunger: 'x', thirst: -3, hygiene: 9, fatigue: null, bladder: undefined });
  for (const [k, v] of Object.entries(dirty)) {
    if (k === 'mood') continue;
    assert.ok(Number.isFinite(v) && v >= 0 && v <= 1, `${k} 越界了：${v}`);
  }
});

test('需求越线时对应的按钮才微光', () => {
  const quiet = glowActions({ hunger: 0.1, thirst: 0.1, hygiene: 0.1, bladder: 0.1, fatigue: 0.2 }, { emotion: { mood: 80 } });
  assert.equal(quiet.size, 0, `没有任何需求越线时不该有微光，实际：${[...quiet].join(',')}`);
  const loud = glowActions({ hunger: 0.9, thirst: 0.9, hygiene: 0.9, bladder: 0.9, fatigue: 0.95 }, { emotion: { mood: 40 } });
  for (const act of ['feed', 'water', 'wash', 'shower', 'toilet', 'sleep', 'pet']) {
    assert.ok(loud.has(act), `需求全线告急时 ${act} 应该微光`);
  }
  // 脏到阈值时，洗脸刷牙和洗澡都该亮：前者够用，后者才是脏透了的正解
  const dirty = glowActions({ hunger: 0, thirst: 0, hygiene: 0.8, bladder: 0, fatigue: 0 }, { emotion: { mood: 80 } });
  assert.ok(dirty.has('wash') && dirty.has('shower'), '脏到阈值时 wash 和 shower 都该微光');
});

test('页面上的五根条、五个词条都在，且没有旧的心情条/健康值/舒适条/推荐排', () => {
  const html = readText('public/room/index.html');
  for (const bar of NEED_BARS) {
    assert.ok(html.includes(`data-need="${bar.key}"`), `index.html 缺 .mood-row[data-need="${bar.key}"]`);
  }
  for (const id of ['barEnergy', 'barHunger', 'barThirst', 'barHygiene', 'barBladder']) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺 #${id}`);
  }
  for (const id of ['wordEnergy', 'wordHunger', 'wordThirst', 'wordHygiene', 'wordBladder']) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺 #${id}`);
  }
  // 已删除的那套：健康值（pain/bladder/hygiene 的加权和）、重复的心情条、推荐排、
  // 以及恒为满格的「舒适」条（改成头部「生病」标签）
  for (const gone of ['id="barMood"', 'id="wordMood"', 'id="moodTips"', 'class="mood-tips"',
    'id="barPain"', 'id="wordPain"', 'data-need="pain"']) {
    assert.ok(!html.includes(gone), `index.html 还留着旧元素：${gone}`);
  }
  // 生病标签必须在头部，且默认隐藏
  assert.ok(/id="sickChip"[^>]*hidden/.test(html), 'index.html 应该有默认隐藏的 #sickChip（生病标签）');
  // 刻度不许写死在 HTML 里——写死就一定会和 home-state 漂移。
  // 只看指标区（.mood 那块），指南针那边也有自己的 .tick，不关这里的事。
  const moodBlock = html.slice(html.indexOf('<div class="mood"'), html.indexOf('</div>', html.indexOf('data-need="bladder"')));
  assert.ok(moodBlock.length > 0, 'index.html 里找不到指标区 <div class="mood">');
  assert.ok(!/class="tick/.test(moodBlock), 'index.html 的指标区里不该有硬编码刻度，刻度由 need-bars.js 在启动时画');
});

test('按钮清单覆盖了她能做的所有事，且都接得上', () => {
  const html = readText('public/room/index.html');
  const acts = [...html.matchAll(/data-act="([a-z_]+)"/g)].map((m) => m[1]);
  // 前端专门分发的（服务端没有同名 action，是前端翻成 command / 打开面板）
  const frontendOnly = new Set(['wash', 'shower', 'toilet', 'garden', 'roomchat']);
  for (const a of acts) {
    assert.ok(
      HOME_ACTIONS.includes(a) || frontendOnly.has(a),
      `按钮 data-act="${a}" 既不在 HOME_ACTIONS 里，也不是前端专门分发的那个`
    );
  }
  // 以前只藏在「现在可以」里的入口，现在必须有正式按钮
  for (const a of ['wash', 'shower', 'toilet', 'poke']) {
    assert.ok(acts.includes(a), `缺少按钮 data-act="${a}"`);
  }
  // 客户端假上座已经删干净：两个按钮都不该还在
  for (const a of ['sofa_play', 'chaise_play']) {
    assert.ok(!acts.includes(a), `按钮 data-act="${a}" 应该已删除（上座只走场景物件 + 服务端 mounting）`);
  }
});

test('页面代码不再自己算一套：无 chaisePlay、无硬编码阈值', () => {
  const app = stripComments(readText('public/room/app.js'));
  for (const gone of ['chaisePhase', 'chaisePlay', 'CHAISE_POINT', 'CHAISE_STAGE', 'chaiseEase', 'chaiseT0']) {
    assert.ok(!app.includes(gone), `app.js 里还有躺椅假上座的残留：${gone}`);
  }
  assert.ok(/from '\.\/need-bars\.js'/.test(app), 'app.js 应该从 need-bars.js 取指标条口径');
  assert.ok(app.includes('buildNeedTicks()'), 'app.js 应该在启动时画刻度');
  assert.ok(app.includes('syncActionHints('), 'app.js 应该有按钮微光/置灰逻辑');
});

console.log(`\n指标条一致性测试全部通过（${passed} 项）`);
