// 菜园合批探针：统计菜园作物组的 InstancedMesh 数量 / 实例数 / 三角形 / 包围盒，
// 并做一次单帧渲染读 draw call 与三角形（相机无关的确定性指标，用于合批前后对照）。
// 用法：node scripts/garden-probe.mjs <url> [out.png]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const URL_TARGET = process.argv[2] || 'http://127.0.0.1:8830/room/?sky=day&hour=12';
const OUT = process.argv[3] || null;
const CHROME = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9489;
const PROFILE = join(tmpdir(), 'chrome-garden-probe');
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1280,800', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-sandbox', '--mute-audio', 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl = null;
for (let i = 0; i < 60; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch { /* wait */ }
  await sleep(400);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const i = ++id; pending.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
});
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: URL_TARGET });

let ready = false;
for (let i = 0; i < 120; i += 1) {
  await sleep(500);
  const t = await send('Runtime.evaluate', {
    expression: '!!(window.__getWorld?.()?.scene && window.__renderer)',
    returnByValue: true
  });
  if (t.result?.result?.value === true) { ready = true; break; }
}
if (!ready) { console.log('{"error":"page not ready"}'); process.exit(1); }
// 等菜园异步 fetch /api/garden/state 并完成 drawCrop（作物是异步画的）
await sleep(6000);

const expr = `(() => {
  const T = window.__THREE, w = window.__getWorld?.(), r = window.__renderer;
  if (!T || !w || !r) return null;
  // 收集菜园作物组（name 含 garden-crop 或 garden-crops 的 Group 里的 InstancedMesh）
  let groups = [];
  w.scene.traverse((o) => {
    if (o.isGroup && (o.name === 'garden-crops' || (o.name && o.name.startsWith('garden-crop')))) groups.push(o);
  });
  let meshes = 0, instances = 0, triangles = 0;
  const box = new T.Box3();
  const gather = (o) => {
    if (o.isInstancedMesh) {
      meshes += 1;
      instances += o.count;
      triangles += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) * o.count;
      box.expandByObject(o);
    }
  };
  groups.forEach((g) => g.traverse(gather));
  // 单帧渲染读数（固定花园俯视相机）
  const cam = new T.PerspectiveCamera(46, r.domElement.width / r.domElement.height, 0.1, 200);
  cam.position.set(6.6, 9.5, -13.0);
  cam.lookAt(6.6, 0, -3.8);
  cam.updateMatrixWorld(true);
  r.info.autoReset = false;
  r.info.reset();
  r.render(w.scene, cam);
  const calls = r.info.render.calls;
  const tris = r.info.render.triangles;
  const png = ${OUT ? 'r.domElement.toDataURL("image/png")' : 'null'};
  return JSON.stringify({
    cropGroups: groups.length,
    instancedMeshes: meshes,
    instances,
    triangles,
    bboxMin: [ +box.min.x.toFixed(2), +box.min.y.toFixed(2), +box.min.z.toFixed(2) ],
    bboxMax: [ +box.max.x.toFixed(2), +box.max.y.toFixed(2), +box.max.z.toFixed(2) ],
    frameDrawCalls: calls,
    frameTriangles: tris,
    png
  });
})()`;

const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
const val = res.result?.result?.value;
if (!val) { console.log('{"error":"evaluate failed"}'); process.exit(1); }
const data = JSON.parse(val);
if (OUT && data.png) {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, Buffer.from(String(data.png).split(',')[1], 'base64'));
}
data.png = data.png ? '<captured>' : null;
console.log(JSON.stringify(data, null, 2));
process.exit(0);
