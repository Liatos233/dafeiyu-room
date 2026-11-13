// 只渲染某个颜色的材质（排查「对象在但看不见」）
// 用法：node scripts/isolate-render.mjs <url> <out.png> <colorHex> <camX,camY,camZ> <lookX,lookY,lookZ>
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const [URL_TARGET, OUT, COLOR, CAM, LOOK] = process.argv.slice(2);
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9499;
const PROFILE = join(tmpdir(), 'chrome-isolate');
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1280,800', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-sandbox', '--mute-audio', 'about:blank'
], { stdio: 'ignore' });

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
await sleep(28000);

const [cx, cy, cz] = (CAM || '9.4,1.25,11.3').split(',').map(Number);
const [lx, ly, lz] = (LOOK || '12.4,1.25,11.3').split(',').map(Number);
const expr = `(() => {
  const T = window.__THREE, w = window.__getWorld?.(), r = window.__renderer;
  if (!T || !w || !r) return null;
  const keep = [];
  w.scene.traverse((o) => {
    if (o.isMesh && o.material?.color?.getHexString?.() === '${COLOR}') keep.push(o);
  });
  w.scene.traverse((o) => { if (o.isMesh && !keep.includes(o)) o.visible = false; });
  w.scene.fog = null;
  w.scene.background = new T.Color(0x20252b);
  const cam = new T.PerspectiveCamera(46, r.domElement.width / r.domElement.height, 0.1, 200);
  cam.position.set(${cx}, ${cy}, ${cz});
  cam.lookAt(${lx}, ${ly}, ${lz});
  cam.updateMatrixWorld(true);
  r.render(w.scene, cam);
  return r.domElement.toDataURL('image/png');
})()`;
const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
const data = res.result?.result?.value;
if (!data) {
  console.log('render failed:', JSON.stringify(res.result?.exceptionDetails || {}).slice(0, 300));
  process.exit(1);
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.from(String(data).split(',')[1], 'base64'));
console.log('saved', OUT);
process.exit(0);
