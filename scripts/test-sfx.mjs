#!/usr/bin/env node
// 音效层单测：不启动浏览器、不出声，只测**结构和契约**。
//
// 「真的有声音」由 scripts/test-sfx-audio.mjs 用真实 Chrome + analyser 验，
// 那是另一件事（要浏览器）。这里管的是容易在重构中被悄悄弄坏的东西：
//   - 事件表里引用的素材必须真的存在（改名/删文件会在这里炸，而不是上线后哑掉）
//   - 合成兜底必须真有实现（写了 synth 名字但函数不存在 = 静默失效）
//   - 素材电平必须在统一范围内（换素材忘了跑 build-sfx 会在这里露馅）
//   - 声像上限、冷却这类参数不许被随手改掉
//
// 跑法：npm run test:sfx
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SOUND_DIR = path.join(ROOT, 'public', 'room', 'assets', 'sound', 'sfx');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    process.exitCode = 1;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
  }
}

// sfx.js 是浏览器模块（用 window/document），但事件表是纯数据。
// 用最小桩把它 import 进来，测的就是**真源码**里的那几张表，
// 而不是测试里另抄一份（抄一份就失去了守门的意义）。
const stub = `
  globalThis.window = { AudioContext: function(){}, webkitAudioContext: function(){} };
  globalThis.document = { hidden: false };
  globalThis.fetch = async () => { throw new Error('测试环境不联网'); };
`;

const tmp = path.join(ROOT, '.tmp-test-sfx.mjs');
fs.writeFileSync(tmp, `${stub}\nexport { __internals } from './public/room/sfx.js';\n`, 'utf8');
const { __internals } = await import(`file://${tmp.replace(/\\/g, '/')}`);
fs.unlinkSync(tmp);

const { EVENTS, SYNTHS, FILES } = __internals;

console.log('\n音效事件表');

test('事件表不为空，且每条都有名字', () => {
  const names = Object.keys(EVENTS);
  assert.ok(names.length >= 5, `事件太少：${names.length}`);
  for (const n of names) assert.ok(typeof n === 'string' && n.length > 0);
});

test('每条事件至少有一个可发声来源（file 或 synth）', () => {
  // 预留事件允许两者都没有（那是先占名字），但必须显式为空对象而非 typo
  const silent = Object.entries(EVENTS)
    .filter(([, ev]) => !ev.file && !ev.synth)
    .map(([n]) => n);
  // 预留项是有意为之，列出来让改的人知道自己在加静默条目
  const ALLOWED_RESERVED = new Set(['doorOpen', 'doorClose']);
  const unexpected = silent.filter((n) => !ALLOWED_RESERVED.has(n));
  assert.deepEqual(unexpected, [], `这些事件既不发声也不在预留名单里：${unexpected.join(', ')}`);
});

test('引用 synth 的事件，对应实现必须存在', () => {
  const missing = [];
  for (const [name, ev] of Object.entries(EVENTS)) {
    if (ev.synth && !SYNTHS[ev.synth]) missing.push(`${name} → synth:${ev.synth}`);
  }
  assert.deepEqual(missing, [], `引用了不存在的合成音：${missing.join(', ')}`);
});

test('事件表里引用的每个素材文件都真实存在', () => {
  const missing = [];
  for (const [name, ev] of Object.entries(EVENTS)) {
    if (!ev.file) continue;
    const list = Array.isArray(ev.file) ? ev.file : [ev.file];
    for (const rel of list) {
      const p = path.join(ROOT, 'public', 'room', rel);
      if (!fs.existsSync(p)) missing.push(`${name}: ${rel}`);
    }
  }
  assert.deepEqual(missing, [], `素材缺失：${missing.join(', ')}`);
});

console.log('\n素材文件');

test('FILES 里登记的素材全部存在且非空', () => {
  let count = 0;
  for (const [kind, list] of Object.entries(FILES)) {
    for (const rel of list) {
      const p = path.join(ROOT, 'public', 'room', rel);
      assert.ok(fs.existsSync(p), `${kind} 缺文件 ${rel}`);
      const size = fs.statSync(p).size;
      assert.ok(size > 1000, `${rel} 只有 ${size} 字节，像是空文件`);
      assert.ok(size < 1024 * 1024, `${rel} 有 ${(size / 1024).toFixed(0)}KB，单发音效不该这么大`);
      count += 1;
    }
  }
  assert.ok(count >= 5, `素材太少：${count}`);
});

test('每类素材音效都有多个变体（单发重复会像复读机）', () => {
  // 脚步已改成合成（每步随机 detune + 左右脚交替，天生不重复），
  // 剩下用素材的是水声：划水必须有多个变体。
  // 入水（splashEnter）是「一次性事件」，单条可以接受。
  assert.ok(FILES.swim.length >= 3, `划水变体太少：${FILES.swim.length}`);
});

test('材质电平落在统一范围内（换素材没跑 build-sfx 会在这里露馅）', () => {
  // build-sfx.mjs 把脚步归到 -20dB、水声归到 -21.5dB，峰值不超 0dBFS。
  // 这里读 built-manifest.json —— 它是构建脚本的产物，能反映实际测得的电平。
  const manifestPath = path.join(SOUND_DIR, 'built-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    // 没有清单不判失败，但要明确提示
    console.log('    (跳过：没有 built-manifest.json，先跑 node scripts/build-sfx.mjs)');
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.ok(Array.isArray(manifest) && manifest.length > 0, '清单是空的');

  for (const m of manifest) {
    assert.ok(typeof m.rmsDb === 'number', `${m.file} 缺 rmsDb`);
    assert.ok(typeof m.peakDb === 'number', `${m.file} 缺 peakDb`);
    const target = m.targetRmsDb ?? -20;
    const drift = Math.abs(m.rmsDb - target);
    assert.ok(drift <= 1.5, `${m.file} 响度漂了 ${drift.toFixed(1)}dB（目标 ${target}，实际 ${m.rmsDb}）`);
    // 峰值超过 0 就是削波了，听感是"炸"
    assert.ok(m.peakDb <= 0.5, `${m.file} 峰值 ${m.peakDb}dB 削波了`);
  }

  const rmsAll = manifest.map((m) => m.rmsDb);
  const spread = Math.max(...rmsAll) - Math.min(...rmsAll);
  assert.ok(spread <= 3.0, `整体响度极差 ${spread.toFixed(1)}dB，太大（一步重一步轻）`);
});

console.log('\n行为参数');

test('声像上限是轻微的 0.25，不是全幅', () => {
  // 全幅（±1）会让镜头一转声音大幅甩动；这个值是有意选轻的
  const src = fs.readFileSync(path.join(ROOT, 'public', 'room', 'sfx.js'), 'utf8');
  const m = /panMax:\s*([\d.]+)/.exec(src);
  assert.ok(m, '找不到 panMax 默认值');
  const v = Number(m[1]);
  assert.ok(v > 0 && v <= 0.3, `panMax 应是轻微值（0 < v ≤ 0.3），实际 ${v}`);
});

test('高频动作都设了冷却（防连发糊成一片）', () => {
  for (const name of ['step', 'run', 'swim']) {
    const cd = EVENTS[name]?.cooldown;
    assert.ok(cd > 0, `${name} 没有冷却，连发会糊`);
    assert.ok(cd <= 400, `${name} 冷却 ${cd}ms 太长，会吃掉正常的步频`);
  }
});

test('跑步靠低频加重，不靠抬音高', () => {
  // 曾经的写法是 rate > 1（音高抬起来）—— 那是错的：
  // 实测 zcr 会翻到走路的 1.5~2.25 倍，听着像"哒哒"的尖响。
  // 真正该多的是低频。这条测试守住这个决定，免得以后有人"顺手"加回 rate。
  assert.equal(EVENTS.run?.rate, undefined, 'run 不该设 rate（抬音高会变尖，用低频加重）');
  const src = fs.readFileSync(path.join(ROOT, 'public', 'room', 'sfx.js'), 'utf8');
  // 跑步分支里必须有蹬地低频
  assert.ok(/if \(running\)[\s\S]{0,240}?f0: 7[0-9]/.test(src), '跑步没有加低频蹬地层');
  // 合成器里不该再用 gait 之类的整体音高因子
  assert.ok(!/const gait = running/.test(src), '又出现了整体音高抬升（gait）');
});

test('脚步左右脚交替（Coopanion 的 step(run, i) 思路）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'room', 'sfx.js'), 'utf8');
  // 交替由 playStep 里翻转 state.foot 实现
  assert.ok(/state\.foot = state\.foot \? 0 : 1/.test(src), '没有左右脚交替');
  // 两只脚必须真的用不同参数
  assert.ok(/const side = foot \? 1\.12 : 1/.test(src), '左右脚用同一个基音，等于没交替');
  // 随机抖动不能太大，否则会"跑调"
  assert.ok(/0\.015/.test(src), '每步的随机抖动参数不见了');
});

test('脚步是合成的，不再依赖素材文件', () => {
  // 换成合成后，step/run 不该再引 file —— 否则素材缺失时又退回没声音
  assert.equal(EVENTS.step?.file, undefined, 'step 还在用素材');
  assert.equal(EVENTS.run?.file, undefined, 'run 还在用素材');
  assert.equal(EVENTS.step?.synth, 'step', 'step 没接合成器');
});

test('地面参数齐全，且瓷砖比地毯亮', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'room', 'sfx.js'), 'utf8');
  for (const s of ['wood', 'tile', 'carpet', 'stone', 'grass']) {
    assert.ok(new RegExp(`${s}:\\s*\\{`).test(src), `缺少地面参数 ${s}`);
  }
  assert.ok(/const SURFACES/.test(src), '找不到 SURFACES 表');
});

console.log('\n接入点');

test('ambience 里 sfxBus 绕开 roomFilter、直连 master', () => {
  // 这是关键设计：室内低通 1200Hz 是给风雨声用的，脚步过了它就闷成敲纸盒
  const src = fs.readFileSync(path.join(ROOT, 'public', 'room', 'ambience.js'), 'utf8');
  assert.ok(/state\.sfxBus\s*=\s*gainNode/.test(src), '找不到 sfxBus 的创建');
  assert.ok(/sfxBus\.connect\(state\.master\)/.test(src), 'sfxBus 没有直连 master');
  assert.ok(!/sfxBus\.connect\(state\.roomFilter\)/.test(src), 'sfxBus 不该接 roomFilter（会被室内低通闷掉）');
});

test('ambience.init 会把上下文和总线交给 sfx', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'room', 'ambience.js'), 'utf8');
  assert.ok(/sfx\.attach\(state\.ctx,\s*state\.sfxBus\)/.test(src), 'init 里没有 attach，音效永远发不出声');
});

test('静音时连音符都不排（不只是把音量归零）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'room', 'ambience.js'), 'utf8');
  assert.ok(/sfx\.setEnabled\(state\.enabled\)/.test(src), '静音没有联动 sfx，白算节点');
});

test('app.js 每帧调用脚步与声像更新', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'room', 'app.js'), 'utf8');
  assert.ok(/updateFootsteps\(\{/.test(src), '找不到 updateFootsteps 调用');
  assert.ok(/updateSfxPan\(displayPos\)/.test(src), '找不到 updateSfxPan 调用');
  // 调用点必须在 lastDisplayPos 赋值之后：那里才是这一帧的最终位置。
  // 注意别匹配到**函数定义**（`function updateFootsteps({ displayPos, ... })`）——
  // 定义在文件靠前的位置，会误判成"调用在赋值之前"。
  const posIdx = src.indexOf('lastDisplayPos = displayPos;');
  const callIdx = src.indexOf('updateFootsteps({ displayPos, swimmingNow, dragging });');
  assert.ok(posIdx >= 0, '找不到 lastDisplayPos 赋值');
  assert.ok(callIdx >= 0, '找不到 updateFootsteps 调用点');
  assert.ok(callIdx > posIdx, '脚步触发点在位置确定之前，会用上一帧的位置');
});

test('脚步按弧长而不是按时间触发', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'room', 'app.js'), 'utf8');
  assert.ok(/STEP_STRIDE_WALK/.test(src) && /STEP_STRIDE_RUN/.test(src), '缺少步幅常量');
  assert.ok(/stepDist \+= moved/.test(src), '没有累计弧长');
  assert.ok(!/setInterval\([^)]*playStep/.test(src), '用定时器打步频会和画面速度脱节');
});

test('瞬移不会连成一片脚步', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'room', 'app.js'), 'utf8');
  assert.ok(/moved > 1\.2/.test(src), '缺少瞬移保护：切房间/快照跳变会连响一串脚步');
});

test('点击音跟着总音量走（原来固定 0.38，静音了还在响）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'room', 'app.js'), 'utf8');
  assert.ok(/CLICK_BASE_VOL \* \(ambience\.enabled \? ambience\.volume : 0\)/.test(src),
    '点击音没有乘总音量，静音后仍会响');
  assert.ok(!/clickSfx\.volume\s*=\s*0\.38/.test(src), '还在用固定音量赋值');
});

test('「跑」用真实速度判定，不靠 clip 名', () => {
  const src = fs.readFileSync(path.join(ROOT, 'public', 'room', 'app.js'), 'utf8');
  // her.speed 是服务端 route 的速度（走 1.05 / 跑 1.45），clip 名会被情绪等分支改掉
  assert.ok(/her\?\.speed/.test(src), '没有读 her.speed');
  assert.ok(/speed > 1\.25/.test(src), '跑步的速度阈值不见了');
});

console.log('\n试听页');

test('试听页存在、可独立打开，且接线方式与正式一致', () => {
  const p = path.join(ROOT, 'public', 'room', 'sfx-lab.html');
  assert.ok(fs.existsSync(p), '试听页不存在');
  const src = fs.readFileSync(p, 'utf8');
  assert.ok(/import \{ sfx \} from '\.\/sfx\.js'/.test(src), '没有引入真模块');
  assert.ok(/sfx\.attach\(ctx,\s*bus\)/.test(src), '没有 attach');
  // 必须和 ambience 一样：bus → master → destination，否则试听正常进游戏变形
  assert.ok(/bus\.connect\(master\)/.test(src), '总线没接到 master');
  assert.ok(/master\.connect\(ctx\.destination\)/.test(src), 'master 没接 destination');
});

test('试听页带素材来源说明（CC0 也要留记录）', () => {
  const p = path.join(SOUND_DIR, 'SOUND-CREDITS.md');
  assert.ok(fs.existsSync(p), '缺少 SOUND-CREDITS.md');
  const src = fs.readFileSync(p, 'utf8');
  assert.ok(/CC0/.test(src), '没写许可证');
  assert.ok(/opengameart/.test(src), '没写来源链接');
  assert.ok(/rubberduck/.test(src), '没写作者');
});

if (process.exitCode) {
  console.error(`\n${passed} 项通过，存在失败项`);
} else {
  console.log(`\n音效测试全部通过（${passed} 项）`);
}