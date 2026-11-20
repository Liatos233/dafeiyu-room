#!/usr/bin/env node
// 项目级自检：导航图一致性 + 客户端静态资源/ID 契约 + 合批/性能结构检查
// 运行：node scripts/test-project.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// nav-data.js 是 ESM（对象字面量允许尾逗号），直接 import 比 JSON.parse 稳健，避免尾逗号炸解析。
const { NAV_DATA: NAV } = await import('../public/room/nav-data.js');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  ✓', name); }
  catch (e) { fail++; console.log('  ✗', name); console.log('   ', String(e.message).split('\n').slice(0, 3).join('\n    ')); }
}

console.log('— 导航数据 —');

test('节点/边/禁行区/点位结构完整', () => {
  assert.ok(NAV.nodes && typeof NAV.nodes === 'object');
  assert.ok(Array.isArray(NAV.edges) && NAV.edges.length > 40);
  assert.ok(Array.isArray(NAV.keepout));
  assert.ok(Array.isArray(NAV.spots) && NAV.spots.length > 20);
});

test('所有边都指向已存在的节点', () => {
  const bad = NAV.edges.filter(([a, b]) => !NAV.nodes[a] || !NAV.nodes[b]);
  assert.equal(bad.length, 0, `悬空边：${JSON.stringify(bad.slice(0, 5))}`);
});

test('所有点位的接入节点都存在', () => {
  const bad = NAV.spots.filter((s) => !NAV.nodes[s.access]);
  assert.equal(bad.length, 0, `缺少接入点：${bad.map((s) => s.id).slice(0, 5).join(', ')}`);
});

test('禁行区矩形合法（左下 < 右上，pad 合理）', () => {
  for (const k of NAV.keepout) {
    const [x0, z0, x1, z1] = k.rect;
    assert.ok(x1 > x0 && z1 > z0, `非法矩形 ${JSON.stringify(k.rect)}`);
    assert.ok((k.pad ?? 0) >= 0 && (k.pad ?? 0) <= 0.5, `pad 异常 ${k.pad}`);
  }
});

test('整张图连通（所有点位之间可达）', () => {
  const adj = new Map();
  for (const id of Object.keys(NAV.nodes)) adj.set(id, []);
  for (const [a, b] of NAV.edges) { adj.get(a).push(b); adj.get(b).push(a); }
  const start = NAV.spots[0].access;
  const seen = new Set([start]);
  const q = [start];
  while (q.length) for (const n of adj.get(q.shift()) || []) if (!seen.has(n)) { seen.add(n); q.push(n); }
  const missing = [...new Set(NAV.spots.map((s) => s.access))].filter((a) => !seen.has(a));
  assert.equal(missing.length, 0, `不可达的点位接入节点：${missing.join(', ')}`);
});

test('边不穿过泳池水面禁行区（端点在区内除外）', () => {
  const water = NAV.keepout.find((k) => k.rect[0] > 0.5 && k.rect[0] < 1.5 && k.rect[3] > 12 && k.rect[3] < 13.2);
  assert.ok(water, '找不到泳池水面禁行区');
  const [x0, z0, x1, z1] = water.rect;
  const inside = (p) => p[0] > x0 && p[0] < x1 && p[1] > z0 && p[1] < z1;
  let bad = 0;
  for (const [a, b] of NAV.edges) {
    const pa = NAV.nodes[a], pb = NAV.nodes[b];
    if (inside(pa) || inside(pb)) continue;
    for (let t = 0.05; t < 1; t += 0.05) {
      const x = pa[0] + (pb[0] - pa[0]) * t;
      const z = pa[1] + (pb[1] - pa[1]) * t;
      if (x > x0 && x < x1 && z > z0 && z < z1) { bad++; break; }
    }
  }
  assert.equal(bad, 0, `${bad} 条边穿过泳池水面`);
});

console.log('— 客户端契约 —');

const appSource = read('public/room/app.js');
const actorSource = read('public/room/actor.js');
const html = read('public/room/index.html');

test('index.html / 动态 UI 里被 app.js 引用的 id 都存在', () => {
  const ids = [...appSource.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]);
  // 菜园面板等由 garden-ui.js 运行时创建，不算模板缺失
  const dynamic = new Set(['garden-panel']);
  const missing = [...new Set(ids)].filter((id) => {
    if (dynamic.has(id)) return !read('public/room/garden-ui.js').includes(`'${id}'`);
    return !new RegExp(`id="${id}"`).test(html);
  });
  assert.equal(missing.length, 0, `模板缺少：${missing.slice(0, 8).join(', ')}`);
});

test('动作面板清单全部能在 CLIPS 中找到', () => {
  const manifest = read('public/room/action-manifest.js');
  const names = [...manifest.matchAll(/^      '([^']+)',$/gm)].map((m) => m[1]);
  assert.ok(names.length > 200, `动作过少：${names.length}`);
  const missing = names.filter((n) => !actorSource.includes(`'${n}':`));
  assert.equal(missing.length, 0, `CLIPS 缺失：${missing.slice(0, 6).join(', ')}`);
});

test('GEN_CLIPS 引用的文件都真实存在', () => {
  const block = actorSource.slice(actorSource.indexOf('export const GEN_CLIPS'));
  const entries = [...block.matchAll(/'([^']+)':\s*'(assets\/[^']+)'/g)];
  const missing = entries.filter(([, , rel]) => !fs.existsSync(path.join(ROOT, 'public/room', rel)));
  assert.equal(missing.length, 0, `文件缺失：${missing.slice(0, 5).map((m) => m[2]).join(', ')}`);
});

test('静态装饰合批已启用，且不合并动态对象', () => {
  const world = read('public/room/world.js');
  assert.ok(world.includes('function mergeStaticDecor'), '缺少合批函数');
  assert.ok(world.includes('mergeStaticDecor(world)'), '合批函数没有被调用');
  for (const dyn of ['tvScreen', 'poolWater', 'poolBody']) {
    assert.ok(new RegExp(`DYNAMIC[\\s\\S]{0,120}${dyn}`).test(world), `动态对象 ${dyn} 未被排除`);
  }
});

test('视觉性能探针存在（window.__renderer / __frames）', () => {
  assert.ok(appSource.includes('window.__renderer'), '缺少 renderer 探针');
  assert.ok(appSource.includes('window.__frames'), '缺少帧时间采样');
});

test('家具菜单只给真实能去的站位，且不残留左下角卡片', () => {
  // 菜单按钮必须按 state.layout.spots 生成：hotspot 里有些 spot 服务端根本没有
  // （pool.gate / pool.water / pool.ladder），发 command 会被直接拒掉。
  assert.ok(appSource.includes('state?.layout?.spots?.'), '菜单应该按 layout.spots 判断能不能去');
  assert.ok(appSource.includes("'去不了这里'"), '没有站位时应该明说去不了，而不是给个点了没反应的按钮');
  // 每个 addHotspot 的 spot 必须在 home-state 里有对应站位，否则菜单会露出「去不了」。
  // 注意 addHotspot(...) 里含嵌套括号/逗号，不能用「匹配到第一个 ) 」那种偷懒正则
  // （之前就漏掉了 pool.gate / pool.water）。
  const world = read('public/room/world.js');
  const homeState = read('src/home-state.js');
  const pairs = [...world.matchAll(/addHotspot\(world,[\s\S]*?room:\s*'([^']+)',\s*spot:\s*'([^']+)'/g)];
  assert.ok(pairs.length > 20, `hotspot 数量异常：${pairs.length}`);
  const missing = pairs.filter(([, room, spot]) => {
    // 站位在 home-state 的 spots 表里以 `spot: { pos: ...` 出现；菜畦这类动态 spot 用 plotN 生成
    const re = new RegExp(`\\b${spot}:\\s*\\{`);
    return !re.test(homeState);
  }).map(([, room, spot]) => `${room}.${spot}`);
  assert.equal(missing.length, 0,
    `这些 hotspot 在 home-state 里没有站位（菜单会显示「去不了」）：${missing.join(', ')}`);
  // 旧卡片必须彻底删掉
  for (const gone of ['id="info"', 'id="infoGo"', 'id="infoTitle"', 'showInfo(']) {
    assert.ok(!html.includes(gone) && !appSource.includes(gone), `还在引用旧的左下角卡片：${gone}`);
  }
  assert.ok(html.includes('id="spotMenu"'), '缺少新的家具菜单 #spotMenu');

  // 出场动画必须是「原地淡入」，不能有位移。
  // 位置的写法是每帧 style.transform = translate(...)；一旦外层也写了 transition:transform，
  // 浏览器就会在两个 translate 之间补间 —— 表现就是菜单从屏幕左上角滑到家具上。
  const menuRule = html.match(/\.spot-menu\{[^}]*\}/)?.[0] || '';
  assert.ok(menuRule, 'index.html 里找不到 .spot-menu 规则');
  assert.ok(!/transition[^;}]*transform/.test(menuRule),
    `.spot-menu 是定位壳，不能过渡 transform（会从左上角滑过来）：${menuRule}`);
  assert.ok(!/transition/.test(menuRule),
    `.spot-menu 只负责定位，任何 transition 都不该加在这里：${menuRule}`);
  // 淡入放大得在内层卡片上做
  assert.ok(/\.spot-card\{/.test(html), '缺少内层卡片 .spot-card（出场动画挂在它上面）');
  const cardRule = html.match(/\.spot-card\{[^}]*\}/)?.[0] || '';
  assert.ok(/transition[^;}]*opacity/.test(cardRule), `.spot-card 应该过渡 opacity：${cardRule}`);
  // 打开时先量尺寸、摆好位置，再取消 hide —— 否则会先用上一个家具的位置画一帧
  assert.ok(/visibility\s*=\s*'hidden'[\s\S]{0,220}layoutSpotMenu\(\)[\s\S]{0,220}classList\.remove\('hide'\)/.test(appSource),
    '打开菜单的顺序应该是「先定位再淡入」（hidden → layoutSpotMenu() → remove("hide")）');
});

test('位置只有一份实现：服务端与客户端共用 public/room/motion.js', () => {
  // 「走路一卡一卡 / 动画一闪一闪」的根源是同一个概念有多份实现：
  // 服务端 positionOnRoute、客户端 pointAtArc/arcLengthAt、客户端再套一层指数平滑，
  // 改一处另外几处就漂。现在位置只能有一个求值函数 motionAt，两边都 import 它。
  const motionSrc = read('public/room/motion.js');
  for (const fn of ['routeLengths', 'pointAtArc', 'arcLengthAt', 'motionAt']) {
    assert.ok(new RegExp(`export function ${fn}\\b`).test(motionSrc), `motion.js 缺少 ${fn}`);
  }

  // 两边都必须 import 它，且不许各自再实现一遍
  assert.ok(/from '\.\/motion\.js'/.test(appSource), 'app.js 应该 import ./motion.js');
  assert.ok(/from '\.\.\/public\/room\/motion\.js'/.test(read('src/home-state.js')),
    'home-state.js 应该 import ../public/room/motion.js（同一份实现）');
  for (const gone of ['function routeLengths', 'function pointAtArc', 'function arcLengthAt']) {
    assert.ok(!appSource.includes(gone), `app.js 不该再自己实现 ${gone.replace('function ', '')}`);
  }
  // 旧的、会跳格的 advanceRoute 必须彻底消失
  assert.ok(!/function advanceRoute\s*\(/.test(appSource), '旧 advanceRoute 应该已删除');

  // 客户端渲染位置必须来自 motionAt，而不是读 pos
  assert.ok(/motionAt\(her\.motion/.test(appSource), '客户端应该用 motionAt(her.motion, ...) 求位置');
  // 服务端快照必须带 motion（客户端的唯一运动契约）
  assert.ok(/motion,\s*$|\bmotion,/.test(read('src/home-state.js')), 'homeView 应该输出 motion');

  // 走路动画的判据不能依赖「这一帧位移」
  const fromDerived = appSource.slice(appSource.indexOf('const derivedWalk ='));
  const derivedWalkStmt = fromDerived.slice(0, fromDerived.indexOf(';') + 1);
  assert.ok(derivedWalkStmt.length > 10, '找不到 derivedWalk 判定');
  assert.ok(!/movingNow/.test(derivedWalkStmt),
    `derivedWalk 不该掺 movingNow（会让动画随位移抖动而闪）：${derivedWalkStmt.trim()}`);
  assert.ok(/her\.walking === true/.test(derivedWalkStmt),
    `derivedWalk 应该以服务端 walking 为准：${derivedWalkStmt.trim()}`);
});

console.log(`\n${pass} 项通过，${fail} 项失败`);
if (fail) process.exit(1);
