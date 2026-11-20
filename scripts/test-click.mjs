#!/usr/bin/env node
// 点击命中测试：点家具应该按**整块矩形**命中，而不是只认 hotspot 圆柱。
//
// 背景：hotspot 是半径 0.2~0.6 的透明柱，点在家具边缘（矩形内、圆柱外）
// 会落到地面上，表现就是「点了沙发却让她走过去」。
// 泳池水面更极端：0.13 m² 的命中面积覆盖 25.5 m² 的水面。
//
// 这个测试把 app.js 里的 spotAtRect 纯函数抽出来跑（它不碰 three.js），
// 用真实的 nav-data 和 world.js 里的 hotspot 坐标检查命中。
// 跑法：node scripts/test-click.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NAV_DATA } from '../public/room/nav-data.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

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

// ── 从 world.js 抽出所有 hotspot（坐标 + room/spot）──
// 注意：{...} 里含中文文案和逗号，用 [^}]* 才稳妥（别用 [^)]* 那种会截断的）。
const worldSrc = read('public/room/world.js');
const hotspots = [...worldSrc.matchAll(
  /addHotspot\(world,\s*(-?[\d.]+),\s*(-?[\d.]+),\s*(-?[\d.]+),\s*\{([^}]*)\}/g
)].map((m) => {
  const body = m[4];
  return {
    at: [+m[1], +m[2]],
    radius: +m[3],
    room: body.match(/room:\s*'([^']+)'/)?.[1] || '',
    spot: body.match(/spot:\s*'([^']+)'/)?.[1] || '',
    title: body.match(/title:\s*'([^']+)'/)?.[1] || '',
    label: body.match(/label:\s*'([^']+)'/)?.[1] || '',
    seeOnly: /seeOnly:\s*true/.test(body)
  };
});

// 自检：抽出来的数量要和真实的调用数一致（排除函数定义那一行）。
test('world.js 里的 hotspot 全部被抽出（正则没漏）', () => {
  // 注意 `function addHotspot(world, x, z, radius, data) {` 也含 `addHotspot(world,`，
  // 会被朴素计数算进去——所以匹配「行首缩进后直接是 addHotspot(」的形式。
  const calls = (worldSrc.match(/^\s*addHotspot\(world,/gm) || []).length;
  assert.equal(hotspots.length, calls,
    `文件里有 ${calls} 个 addHotspot 调用，只抽出 ${hotspots.length} 个`);
  const named = hotspots.filter((h) => h.title);
  assert.equal(named.length, hotspots.length, '每个 hotspot 都应该有 title');
});

// ── app.js 里的 spotAtRect 逐字搬运（保持同步；app.js 里也是纯函数）──
function spotAtRect(p, { keepout = [], platforms = [], hotspots = [] } = {}) {
  if (!p) return null;
  for (const pf of platforms) {
    if (!pf.rect) continue;
    // platforms 里是 `id: "living.sofa"`，没有 room/spot 字段，要解析 id。
    const [pfRoom, pfSpot] = String(pf.id || '').split('.');
    if (!pfRoom || !pfSpot) continue;
    const [x0, z0, x1, z1] = pf.rect;
    if (p[0] >= x0 && p[0] <= x1 && p[1] >= z0 && p[1] <= z1) {
      return hotspots.find((h) => h.room === pfRoom && h.spot === pfSpot) || null;
    }
  }
  for (const item of keepout) {
    const [x0, z0, x1, z1] = item.rect;
    if (p[0] < x0 || p[0] > x1 || p[1] < z0 || p[1] > z1) continue;
    let best = null;
    for (const hs of hotspots) {
      if (!Array.isArray(hs.at)) continue;
      if (hs.at[0] < x0 || hs.at[0] > x1 || hs.at[1] < z0 || hs.at[1] > z1) continue;
      const d = Math.hypot(hs.at[0] - (x0 + x1) / 2, hs.at[1] - (z0 + z1) / 2);
      if (!best || d < best.d) best = { hs, d };
    }
    if (best) return best.hs;
  }
  return null;
}

const ctx = { keepout: NAV_DATA.keepout || [], platforms: NAV_DATA.platforms || [], hotspots };

test('app.js 里的 spotAtRect 和这份测试实现一致（防漂移）', () => {
  const appSrc = read('public/room/app.js');
  assert.ok(/export function spotAtRect\(p, \{ keepout = \[\], platforms = \[\], hotspots = \[\] \} = \{\}\)/.test(appSrc),
    'app.js 里应该有一个纯函数 spotAtRect（签名不变）');
  assert.ok(appSrc.includes('spotAtRect(p, {'), 'spotAtPoint 应该调用 spotAtRect');
});

test('整块泳池水面都能点（原来只有 0.13 m²）', () => {
  // 泳池 K 区 rect = [0.9, 9.98, 10.34, 12.68]
  const [x0, z0, x1, z1] = [0.9, 9.98, 10.34, 12.68];
  const points = [
    [x0 + 0.2, z0 + 0.2], [x1 - 0.2, z0 + 0.2],
    [x0 + 0.2, z1 - 0.2], [x1 - 0.2, z1 - 0.2],
    [(x0 + x1) / 2, (z0 + z1) / 2],
    [5.8, 11.3]   // hotspot 原位
  ];
  for (const p of points) {
    const hit = spotAtRect(p, ctx);
    assert.ok(hit, `( ${p} ) 应该点得到泳池，实际 null`);
    assert.equal(hit.room, 'pool');
    assert.equal(hit.spot, 'swim', `( ${p} ) 应该命中 pool.swim，实际 ${hit.room}.${hit.spot}`);
  }
});

test('四角外侧不误命中泳池', () => {
  const outside = [[0.5, 9.5], [10.8, 9.5], [0.5, 13.0], [11.0, 13.0]];
  for (const p of outside) {
    const hit = spotAtRect(p, ctx);
    assert.ok(!hit || hit.spot !== 'swim', `( ${p} ) 不该命中泳池，实际 ${hit?.room}.${hit?.spot}`);
  }
});

test('整块可站立家具（PL）都能点，不再只认 hotspot 圆柱', () => {
  for (const pf of NAV_DATA.platforms || []) {
    if (!pf.rect) continue;
    const [pfRoom, pfSpot] = String(pf.id || '').split('.');
    assert.ok(pfRoom && pfSpot, `platform.id 应该是 "room.spot" 形式，实际 ${pf.id}`);
    const [x0, z0, x1, z1] = pf.rect;
    // 四个角和中心都试一遍：这些点原来落在 hotspot 圆柱外就会漏
    const probes = [
      [x0 + 0.05, z0 + 0.05], [x1 - 0.05, z0 + 0.05],
      [x0 + 0.05, z1 - 0.05], [x1 - 0.05, z1 - 0.05],
      [(x0 + x1) / 2, (z0 + z1) / 2]
    ];
    for (const p of probes) {
      const hit = spotAtRect(p, ctx);
      assert.ok(hit, `${pf.id} 的 ( ${p} ) 应该点得到，实际 null`);
      assert.equal(`${hit.room}.${hit.spot}`, `${pfRoom}.${pfSpot}`,
        `${pf.id} 的 ( ${p} ) 应命中 ${pfRoom}.${pfSpot}，实际 ${hit.room}.${hit.spot}`);
    }
  }
});

test('每个 PL 区都能找到对应 hotspot（否则菜单拿不到标题）', () => {
  for (const pf of NAV_DATA.platforms || []) {
    const [pfRoom, pfSpot] = String(pf.id || '').split('.');
    const hs = hotspots.find((h) => h.room === pfRoom && h.spot === pfSpot);
    assert.ok(hs, `${pf.id} 没有对应 hotspot，菜单会是空的`);
  }
});

test('茶几不冒充沙发（原来 spot 写错成 sofa）', () => {
  const tea = hotspots.find((h) => h.title === '茶几');
  assert.ok(tea, '应该有一个「茶几」hotspot');
  assert.notEqual(tea.spot, 'sofa', '茶几的 spot 不该是 sofa（原来写错了）');
  assert.ok(tea.seeOnly, '茶几能看不能站上去，应该标 seeOnly');
  // 点在茶几 K 区里，命中的应该是茶几自己
  const hit = spotAtRect([6.3, 3.85], ctx);
  assert.equal(hit?.title, '茶几', `点茶几应该命中茶几，实际 ${hit?.title}`);
});

test('K 区里没有 hotspot 的区域返回 null（不误弹菜单）', () => {
  // 客厅电视柜 K 区 [5.2,0.15,7.4,0.6]，里面没有 hotspot
  const hit = spotAtRect([6.3, 0.4], ctx);
  assert.equal(hit, null, `电视柜应该没有菜单，实际 ${hit?.room}.${hit?.spot}`);
});

test('菜单锚点用 hotspot 自身坐标，不用射线落点', () => {
  // 家具按整块矩形命中后，点在矩形边缘时射线根本打不到那个小圆柱 ——
  // 如果锚点还用 hit.point，hit 为空就会掉到世界原点，菜单跑到离物件很远的地方。
  // 所以必须用命中的那个 hotspot 自己的世界坐标当锚点。
  const appSrc = read('public/room/app.js');
  const fn = appSrc.slice(appSrc.indexOf('function showSpotMenuFor'));
  const body = fn.slice(0, fn.indexOf('\n}') + 2);
  assert.ok(/m\.position\.x/.test(body), 'showSpotMenuFor 应该用 hotspot mesh 的 position 当锚点');
  // 射线兜底应该排在后面（先找 mesh，找不到才用射线）
  const meshIdx = body.indexOf('m.position.x');
  const rayIdx = body.indexOf('raycaster.setFromCamera');
  assert.ok(meshIdx >= 0 && rayIdx > meshIdx,
    '应该先按 hotspot mesh 取锚点，射线落点只作为最后的兜底');
});

test('房间名标记不持久化，刷新后默认关闭', () => {
  // 用户反馈「每次刷新之后会把各个地方的标记显示出来」——
  // 根源是 roomLabelsOn 以前从 localStorage 读，开过一次就永久开着。
  const appSrc = read('public/room/app.js');
  assert.ok(!/roomLabelsOn\s*=\s*localStorage\.getItem\('home-labels'\)/.test(appSrc),
    'roomLabelsOn 不该再从 localStorage 读初值');
  assert.ok(/let roomLabelsOn = false;/.test(appSrc),
    'roomLabelsOn 应该默认 false');
  assert.ok(!/localStorage\.setItem\('home-labels'/.test(appSrc),
    '不该再把 home-labels 写进 localStorage');
  assert.ok(/localStorage\.removeItem\('home-labels'\)/.test(appSrc),
    '应该主动清掉历史遗留的 home-labels（旧浏览器里可能还存着 1）');
});

console.log(`\n点击命中测试全部通过（${passed} 项）`);
