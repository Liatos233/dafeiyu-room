// 诊断：打开页面并打印所有异常/日志/失败请求
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_TARGET = process.argv[2] || 'http://127.0.0.1:3100/room/';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9466;
const PROFILE = join(tmpdir(), 'chrome-diag');
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=900,700', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-sandbox', '--mute-audio', '--autoplay-policy=no-user-gesture-required',
  'about:blank'
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
for (let i = 0; i < 60; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page?.webSocketDebuggerUrl) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
  } catch { /* wait */ }
  await sleep(400);
}
await new Promise((r) => { ws.onopen = r; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    console.log('EXCEPTION:', d.text, '|', (d.exception?.description || '').split('\n').slice(0, 3).join(' / '));
  } else if (m.method === 'Log.entryAdded') {
    const e = m.params.entry;
    console.log(`LOG[${e.level}] ${e.text}`);
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    console.log('CONSOLE.ERROR:', m.params.args.map((a) => a.value || a.description).join(' '));
  } else if (m.method === 'Network.loadingFailed') {
    console.log('LOAD FAIL:', m.params.errorText, m.params.type);
  }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const i = ++id; pending.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
});

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Network.enable');
await send('Page.navigate', { url: URL_TARGET });
await sleep(9000);
console.log('ambience:', await (async () => {
  const r = await send('Runtime.evaluate', { expression: 'typeof window.__ambience', returnByValue: true });
  return r.result?.result?.value;
})());
process.exit(0);
