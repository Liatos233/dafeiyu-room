#!/usr/bin/env node
// 项目级自检：导航图一致性 + 客户端静态资源/ID 契约 + 合批/性能结构检查
// 运行：node scripts/test-project.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const navSource = read('public/room/nav-data.js').replace(/^export const NAV_DATA\s*=\s*/, '').trim().replace(/;\s*$/, '');
const NAV = JSON.parse(navSource);

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

console.log(`\n${pass} 项通过，${fail} 项失败`);
if (fail) process.exit(1);
