#!/usr/bin/env node
// 读取页面里 window.__renderer / window.__frames 的性能指标（需要 room 已在 3100 端口运行）
// 用法：node scripts/perf-check.mjs [url]
import { spawn } from 'node:child_process';
import http from 'node:http';

const url = process.argv[2] || 'http://127.0.0.1:3100/room/';
const port = 9599;
const chrome = process.env.CHROME_BIN || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const child = spawn(chrome, [
  '--headless=new', `--remote-debugging-port=${port}`,
  `--user-data-dir=${process.env.TEMP || '/tmp'}/dsh-perf-${Date.now()}`,
  '--no-first-run', '--disable-gpu', '--window-size=1600,1000', 'about:blank'
], { stdio: 'ignore' });

const get = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p, timeout: 4000 }, (r) => {
    let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res(b));
  }).on('error', rej);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await sleep(2500);
  const targets = JSON.parse(await get('/json'));
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  await new Promise((r) => ws.addEventListener('open', r));
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url });
  // 等页面真正就绪（世界建好会置 title=HOME_READY），最多 30 秒
  for (let i = 0; i < 60; i++) {
    const t = await send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
    if (t.result?.result?.value === 'HOME_READY') break;
    await sleep(500);
  }
  await sleep(2500);

  const expr = `(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    let calls = 0, tris = 0;
    for (let i = 0; i < 20; i++) {
      const info = (window.__getRenderer ? window.__getRenderer() : window.__renderer)?.info || null;
      if (info) { calls = Math.max(calls, info.render.calls); tris = Math.max(tris, info.render.triangles); }
      await sleep(80);
    }
    const f = (window.__frames || []).slice(-400).filter((x) => x > 0 && x < 2000);
    const sorted = f.slice().sort((a, b) => a - b);
    const pct = (p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
    const info = (window.__getRenderer ? window.__getRenderer() : window.__renderer)?.info || {};
    return JSON.stringify({
      fps: f.length ? +(1000 / (f.reduce((a, b) => a + b, 0) / f.length)).toFixed(1) : 0,
      p95ms: +pct(0.95).toFixed(1),
      drawCalls: calls,
      triangles: tris,
      geometries: info.memory && info.memory.geometries,
      textures: info.memory && info.memory.textures,
      programs: info.programs && info.programs.length,
      heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null
    });
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  console.log(r.result.result.value);
  ws.close();
  child.kill();
  process.exit(0);
})();
