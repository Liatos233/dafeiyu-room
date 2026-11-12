import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 生成 public/room/nav-data.js：把 src/home-state.js 里的路点图导出成前端能读的静态数据。
// 改完 NODES / EDGES / NAV_KEEPOUT 后跑一次，刷新页面就能在 ?nav=1 看到新图。
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const mod = await import(pathToFileURL(path.join(root, 'src', 'home-state.js')).href);
const { HOME_LAYOUT, HOME_NODES, HOME_EDGES, HOME_KEEPOUT } = mod;

const spots = [];
for (const [room, list] of Object.entries(HOME_LAYOUT.spots)) {
  for (const [id, def] of Object.entries(list)) {
    spots.push({ room, id, pos: def.pos, label: def.label, access: def.access });
  }
}

const data = {
  size: HOME_LAYOUT.size,
  rooms: HOME_LAYOUT.rooms,
  nodes: HOME_NODES,
  edges: HOME_EDGES,
  keepout: HOME_KEEPOUT,
  spots
};

const out = path.join(root, 'public', 'room', 'nav-data.js');
fs.writeFileSync(out, 'export const NAV_DATA = ' + JSON.stringify(data) + ';\n', 'utf8');
console.log('wrote', out);
console.log('nodes:', Object.keys(HOME_NODES).length, 'edges:', HOME_EDGES.length, 'keepout:', HOME_KEEPOUT.length, 'spots:', spots.length);
