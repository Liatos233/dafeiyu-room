// 用页面自己的相机渲染并截图：node scripts/shot-view.mjs <url> <out.png> "<js>"
import { spawn } from 'node:child_process';
import { writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_TARGET = process.argv[2];
const OUT = process.argv[3];
const JS = process.argv[4] || '';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9487;
const PROFILE = join(tmpdir(), 'chrome-shot-view');
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1280,760', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
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
await sleep(12000);
if (JS) {
  const r = await send('Runtime.evaluate', { expression: JS, returnByValue: true, awaitPromise: true });
  console.log('js ->', JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.text ?? null));
  await sleep(2500);
}
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) {
  writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
  console.log('saved', OUT);
} else {
  console.log('capture failed', JSON.stringify(shot).slice(0, 200));
}
process.exit(0);
