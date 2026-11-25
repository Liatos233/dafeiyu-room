#!/usr/bin/env node
// 直接量每一层（不是混合后）的频谱贡献 —— 定位"到底是哪一层在占低频"。
//
// 为什么需要单独量：混合后的总频谱只能告诉我"低频占 95%"，
// 但不知道是 wind 层、snow 层、还是 roomHum 在占。逐层量才有诊断力。
//
// 做法：把每个 proc 单独接到 analyser（绕开 master/roomFilter），
// 测它的频段分布。
import { spawn } from 'node:child_process';
import { mkdtempSync, createReadStream, statSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9339;
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', 'public', 'room');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.ogg': 'audio/ogg' };

const srv = createServer((req, res) => {
  const rel = normalize(decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'sfx-lab.html');
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const pagePort = srv.address().port;

const userDir = mkdtempSync(join(tmpdir(), 'layer-'));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`,
  '--headless=new', '--no-first-run', '--disable-gpu',
  '--autoplay-policy=no-user-gesture-required', '--mute-audio', 'about:blank',
], { stdio: 'ignore' });

let ws, msgId = 0;
const pending = new Map();
const send = (method, params = {}, sessionId) => {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
};
let info = null;
for (let i = 0; i < 40; i += 1) {
  try { info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; }
  catch { await sleep(250); }
}
ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
  }
};
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Page.navigate', { url: `http://127.0.0.1:${pagePort}/sfx-lab.html` }, sessionId);
await sleep(1200);

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'JS 抛错');
  return r.result?.value;
}

// 直接 import ambience.js，用它的 spectrum() 逐个天气采样。
// 「逐层」通过对比不同天气的频谱差推断 —— 每种天气只差一两层，
// 两次采样相减就能看出那一层的贡献。比抽源码拼函数可靠得多。
const out = await evaluate(`
(async () => {
  const { ambience: amb } = await import('./ambience.js');
  amb.init();
  amb.setEnabled(true);
  amb.setVolume(0.6);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  async function sample(times = 16, gap = 80) {
    const acc = [];
    for (let i = 0; i < times; i += 1) {
      await wait(gap);
      const s = amb.spectrum();
      if (s && s.total > 0) acc.push(s.shares);
    }
    if (!acc.length) return null;
    return acc[0].map((_, bi) => +(acc.reduce((s, a) => s + a[bi], 0) / acc.length).toFixed(3));
  }

  // 每种天气在**室内客厅**采一次；两两相减能看出各层的贡献
  const WEATHERS = ['day','overcast','rain','snow','fog','haze','sand','storm','night','aurora','meteor','hail','sleet','typhoon','blizzard','dusk'];
  const res = {};
  for (const w of WEATHERS) {
    amb.setScene({ weather: w, room: 'living' });
    await wait(2600);
    const sh = await sample();
    if (sh) res[w] = sh;
  }
  return res;
})()
`);

console.log('\n=== 室内客厅：各天气的频段分布（%）===');
console.log('天气        风(<400)  低(400-1.2k)  中(1.2-2.8k)  高(2.8-8k)  超高');
for (const [w, s] of Object.entries(out)) {
  console.log(
    w.padEnd(11) +
    String((s[0] * 100).toFixed(1)).padStart(7) +
    String((s[1] * 100).toFixed(1)).padStart(11) +
    String((s[2] * 100).toFixed(1)).padStart(12) +
    String((s[3] * 100).toFixed(1)).padStart(10) +
    String((s[4] * 100).toFixed(1)).padStart(7)
  );
}

await send('Target.closeTarget', { targetId });
ws.close();
chrome.kill();
srv.close();