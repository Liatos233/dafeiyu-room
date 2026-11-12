import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL('C:/Users/liato/dafeiyu-room/app/src/home-state.js').href);
const { HOME_LAYOUT, buildRoute } = mod;

const spots = [];
for (const [room, list] of Object.entries(HOME_LAYOUT.spots)) {
  for (const [id, def] of Object.entries(list)) {
    spots.push({ room, id, pos: def.pos, def });
  }
}

const now = Date.now();
let total = 0;
const failed = [];
const tooLong = [];
const OFFSET = 1000; // 出发点从 1 秒后算

for (const from of spots) {
  for (const to of spots) {
    if (from === to) continue;
    total += 1;
    let route = null;
    try {
      route = buildRoute(from.pos, from.def, { room: to.room, spot: to.id, pos: to.pos }, now + OFFSET, 0.55);
    } catch (err) {
      failed.push([from.room + '.' + from.id, to.room + '.' + to.id, 'throw: ' + err.message]);
      continue;
    }
    if (!route || !route.points || route.points.length < 2) {
      failed.push([from.room + '.' + from.id, to.room + '.' + to.id, 'no route']);
      continue;
    }
    let len = 0;
    for (let i = 1; i < route.points.length; i++) {
      len += Math.hypot(route.points[i][0] - route.points[i - 1][0], route.points[i][1] - route.points[i - 1][1]);
    }
    const direct = Math.hypot(to.pos[0] - from.pos[0], to.pos[1] - from.pos[1]);
    if (direct > 1.2 && len > direct * 4.5) {
      tooLong.push([from.room + '.' + from.id, to.room + '.' + to.id, len.toFixed(1), direct.toFixed(1)]);
    }
  }
}

console.log('spot 数量:', spots.length, '路由组合:', total);
console.log('失败:', failed.length);
for (const f of failed.slice(0, 40)) console.log('  FAIL', f.join(' -> '));
console.log('绕路过长(>4.5x直线):', tooLong.length);
for (const t of tooLong.slice(0, 20)) console.log('  LONG', t.join(' | '));
