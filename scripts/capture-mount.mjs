// 抓上座过程的连续帧：先让她走到沙发，检测到「坐上去」后连拍
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT_DIR = process.argv[2] || 'C:/Users/liato/dafeiyu-room/mount-frames';
const URL_TARGET = process.argv[3] || 'http://101.245.76.51:3100/room/?sky=day&hour=12';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9511;
const PROFILE = join(tmpdir(), 'chrome-mount');
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
await send('Page.navigate', { url: URL_TARGET });
await sleep(26000);

// 把镜头对准沙发，并下发上座指令
await send('Runtime.evaluate', {
  expression: `(() => {
    const T = window.__THREE, cam = window.__camera;
    window.__mountCam = setInterval(() => {
      cam.position.set(6.3, 1.25, 3.0);
      cam.lookAt(6.3, 0.85, 5.2);
      cam.updateMatrixWorld(true);
    }, 16);
    fetch('/api/home/act', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'command', room: 'living', spot: 'sofa' }) }).catch(() => {});
    return 'armed';
  })()`, returnByValue: true
});

let idx = 0;
for (let i = 0; i < 120; i += 1) {
  const r = await send('Runtime.evaluate', {
    expression: `(() => { const h = window.__state?.her || {}; return (h.activity || '') + '|' + (h.walking ? 'walk' : 'still'); })()`,
    returnByValue: true
  });
  const txt = String(r.result?.result?.value || '');
  if (txt.includes('坐上去') || txt.includes('到了沙发')) {
    for (let k = 0; k < 8; k += 1) {
      const shot = await send('Page.captureScreenshot', { format: 'png' });
      if (shot.result?.data) writeFileSync(join(OUT_DIR, `f${String(idx).padStart(2, '0')}.png`), Buffer.from(shot.result.data, 'base64'));
      idx += 1;
      await sleep(120);
    }
    break;
  }
  await sleep(200);
}
console.log('frames:', idx);
process.exit(0);
