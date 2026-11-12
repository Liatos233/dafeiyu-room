import { pathToFileURL } from 'node:url';

const mod = await import(pathToFileURL('C:/Users/liato/dafeiyu-room/app/src/home-state.js').href);
const { HOME_LAYOUT, buildRoute, HOME_KEEPOUT, roomAtPoint } = mod;

const spots = [];
for (const [room, list] of Object.entries(HOME_LAYOUT.spots)) {
  for (const [id, def] of Object.entries(list)) spots.push({ room, id, pos: def.pos, def });
}

const PAD = 0.30;
function pointInRect(p, r, pad) {
  return p[0] >= r[0] - pad && p[0] <= r[2] + pad && p[1] >= r[1] - pad && p[1] <= r[3] + pad;
}
function segHits(p1, p2, r, pad) {
  const x0 = r[0] - pad, z0 = r[1] - pad, x1 = r[2] + pad, z1 = r[3] + pad;
  let t0 = 0, t1 = 1;
  const dx = p2[0] - p1[0], dz = p2[1] - p1[1];
  for (const [p, q] of [[-dx, p1[0] - x0], [dx, x1 - p1[0]], [-dz, p1[1] - z0], [dz, z1 - p1[1]]]) {
    if (Math.abs(p) < 1e-9) { if (q < 0) return false; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
    else { if (t < t0) return false; if (t < t1) t1 = t; }
  }
  return t0 <= t1;
}

const now = Date.now();
let checked = 0;
const hits = [];
for (const a of spots) {
  for (const b of spots) {
    if (a === b) continue;
    const route = buildRoute(a.pos, a.def, { room: b.room, spot: b.id, pos: b.pos }, now + 1000, 0.55);
    if (!route) continue;
    checked += 1;
    for (let i = 1; i < route.points.length; i++) {
      const p1 = route.points[i - 1], p2 = route.points[i];
      const roomId = roomAtPoint(p1)?.id;
      if (!roomId) continue;
      for (const item of HOME_KEEPOUT) {
        if (item.room !== roomId) continue;
        const pad = item.pad ?? PAD;
        if (pointInRect(p1, item.rect, pad) || pointInRect(p2, item.rect, pad)) continue;
        if (segHits(p1, p2, item.rect, pad)) {
          hits.push(`${a.room}.${a.id} -> ${b.room}.${b.id} 段 ${i} @${roomId} 撞 ${item.rect.join(',')}`);
        }
      }
    }
  }
}
console.log('检查路线数:', checked, '穿模段:', hits.length);
for (const h of [...new Set(hits)].slice(0, 20)) console.log('  ', h);
