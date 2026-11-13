// 用自定义相机渲染一帧并保存（用于定向看某个模型）
// 用法：node scripts/render-view.mjs <url> <out.png> <camX,camY,camZ> <lookX,lookY,lookZ>
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const URL_TARGET = process.argv[2];
const OUT = process.argv[3];
const CAM = process.argv[4] || '10.2,2.35,9.2';
const LOOK = process.argv[5] || '12.5,1.55,11.3';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9488;
const PROFILE = join(tmpdir(), 'chrome-render-view');
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1280,800', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-sandbox', '--mute-audio', 'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let url = null;
for (let i = 0; i < 60; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page?.webSocketDebuggerUrl) { url = page.webSocketDebuggerUrl; break; }
  } catch { /* wait */ }
  await sleep(400);
}
const ws = new WebSocket(url);
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

const expr = `(() => {
  const T = window.__THREE, w = window.__getWorld?.(), r = window.__renderer;
  if (!T || !w || !r) return null;
  const cam = new T.PerspectiveCamera(46, r.domElement.width / r.domElement.height, 0.1, 200);
  cam.position.set(${CAM.split(',').map(Number).join(',')});
  cam.lookAt(${LOOK.split(',').map(Number).join(',')});
  cam.updateMatrixWorld(true);
  r.render(w.scene, cam);
  return r.domElement.toDataURL('image/png');
})()`;
const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
const data = res.result?.result?.value;
if (!data) {
  console.log('render failed:', JSON.stringify(res.result?.exceptionDetails || {}).slice(0, 200));
  process.exit(1);
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.from(String(data).split(',')[1], 'base64'));
console.log('saved', OUT);
process.exit(0);
