// 通用：用无头 Chrome 在页面里执行一段 JS 并打印结果
// 用法：node scripts/page-eval.mjs <url> "<js expression>"
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_TARGET = process.argv[2];
const EXPR = process.argv[3] || 'document.title';
if (!URL_TARGET) {
  console.error('用法: node scripts/page-eval.mjs <url> "<js>"');
  process.exit(2);
}

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9455;
const PROFILE = join(tmpdir(), 'chrome-page-eval');
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--autoplay-policy=no-user-gesture-required', '--window-size=900,700',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox', '--mute-audio',
  'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wsUrl() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* wait */ }
    await sleep(400);
  }
  throw new Error('cdp not ready');
}
const ws = new WebSocket(await wsUrl());
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
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    console.log('EXCEPTION:', d.text, d.exception?.description?.split('\n')[0] || '');
  }
});
await sleep(200);
await sleep(7000);
for (let i = 0; i < 8; i += 1) {
  const st = await send('Runtime.evaluate', { expression: 'JSON.stringify({ready:document.readyState, r:typeof window.__renderer, a:typeof window.__ambience, err:(window.__homeErrors||[]).length})', returnByValue: true });
  console.log('t+' + (7 + i * 5) + 's', st.result?.result?.value);
  if (st.result?.result?.value?.includes('"r":"object"')) break;
  await sleep(5000);
}
const r = await send('Runtime.evaluate', { expression: EXPR, returnByValue: true, awaitPromise: true });
if (r.result?.exceptionDetails) console.log('ERROR:', r.result.exceptionDetails.text);
else console.log(JSON.stringify(r.result?.result?.value, null, 2));
ws.close(); chrome.kill();
