// 无头验证环境音：点开开关后读取 __ambience.debug() 与频谱能量
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_TARGET = process.argv[2] || 'http://127.0.0.1:3100/room/?sky=rain';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9444;
const PROFILE = join(tmpdir(), 'chrome-audio-check');
rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--autoplay-policy=no-user-gesture-required',
  '--window-size=800,600',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--no-sandbox',
  '--mute-audio',
  URL_TARGET
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
  const i = ++id;
  pending.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
});

await send('Runtime.enable');
await sleep(8000);

async function evalJs(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
}

console.log('url:', await evalJs('location.href'));
console.log('sky:', await evalJs('document.getElementById(\'skyState\')?.textContent'));
console.log('before:', JSON.stringify(await evalJs('window.__ambience ? window.__ambience.debug() : "no ambience"')));
console.log('click:', await evalJs(`(() => { const b = document.getElementById('ambienceChip'); if (!b) return 'no chip'; b.click(); return 'clicked'; })()`));
await sleep(1500);
console.log('after:', JSON.stringify(await evalJs('window.__ambience.debug()')));

// 频谱能量：接一个 analyser 到 destination 前测不到，改用 debug 里的 ctx 状态 + 时长
const levels = await evalJs(`(() => {
  const a = window.__ambience;
  if (!a) return null;
  return { enabled: a.enabled, volume: a.volume, weather: a.debug().weather, room: a.debug().room, ctx: a.debug().ctxState };
})()`);
console.log('manual setScene:', await evalJs(`(() => { window.__ambience.setScene({ weather: 'rain', room: 'balcony' }); return JSON.stringify(window.__ambience.debug()); })()`));
console.log('levels:', JSON.stringify(levels));

ws.close();
chrome.kill();
