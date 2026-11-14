// 在同一个页面会话里依次让她去四个座位，到位后立即用自定义相机抓图
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT_DIR = process.argv[2] || 'C:/Users/liato/dafeiyu-room/seat-check';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9521;
const PROFILE = join(tmpdir(), 'chrome-seats');
rmSync(PROFILE, { recursive: true, force: true });
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
mkdirSync(OUT_DIR, { recursive: true });

spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1100,700', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
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
await send('Page.navigate', { url: 'http://101.245.76.51:3100/room/?sky=day&hour=12' });
await sleep(26000);

const seats = [
  { room: 'living', spot: 'sofa', cam: [6.3, 2.0, 1.9], look: [6.3, 0.7, 5.0], name: 'sofa' },
  { room: 'her_room', spot: 'bed', cam: [11.5, 2.2, 4.6], look: [11.4, 0.7, 1.5], name: 'bed' },
  { room: 'pool', spot: 'lounger', cam: [10.4, 2.3, 13.2], look: [12.4, 0.7, 10.6], name: 'lounger' },
  { room: 'balcony', spot: 'chair', cam: [5.2, 2.0, 10.6], look: [2.9, 0.8, 8.2], name: 'chair' }
];

const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

const state = () => evalJs(`(async () => {
  const res = await fetch('/api/home/state');
  const d = await res.json();
  const h = (d && d.her) || {};
  return { pos: h.pos, elev: h.elev, activity: h.activity || '', spot: h.spot, walking: h.walking };
})()`);

for (const s of seats) {
  await evalJs(`fetch('/api/home/act', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(${JSON.stringify({ action: 'command', room: s.room, spot: s.spot })}) }).catch(() => {})`);
  // 等她到位（动作里出现「到了/坐/躺」或 pos 接近目标）
  let st = null;
  for (let i = 0; i < 90; i += 1) {
    await sleep(400);
    st = await state();
    if (st && !st.walking && /到了|坐上去|躺/.test(st.activity || '')) break;
  }
  // 等到高度稳定（上座动画结束）再截图，否则拍到的是半途
  for (let i = 0; i < 20; i += 1) {
    await sleep(200);
    const s2 = await state();
    if (s2 && (s2.elev || 0) > 0.25) { st = s2; break; }
  }
  await sleep(400);
  const shot = await evalJs(`(() => {
    const T = window.__THREE, w = window.__getWorld?.(), r = window.__renderer;
    if (!T || !w || !r) return null;
    const cam = new T.PerspectiveCamera(44, r.domElement.width / r.domElement.height, 0.1, 200);
    cam.position.set(${s.cam[0]}, ${s.cam[1]}, ${s.cam[2]});
    cam.lookAt(${s.look[0]}, ${s.look[1]}, ${s.look[2]});
    cam.updateMatrixWorld(true);
    r.render(w.scene, cam);
    return r.domElement.toDataURL('image/png');
  })()`);
  if (shot) {
    writeFileSync(join(OUT_DIR, `${s.name}.png`), Buffer.from(String(shot).split(',')[1], 'base64'));
  }
  console.log(s.name, st && st.activity, st && st.elev);
}
process.exit(0);
