#!/usr/bin/env node
// 客观测量环境音：各天气 × 室内外，统计**风频段能量占比**。
//
// 为什么这个指标有意义：
//   用户抱怨"风喧宾夺主"。根因不是风变响了，而是**别的声源被室内低通
//   滤掉了**，只剩风（全低频，<1200Hz 完整通过）。
//   所以要看的不是"风的绝对音量"，而是"风占了多少"：
//   windShare = 风频段(<400Hz)能量 / 总能量。
//
// 目标：优化后应从 60~100% 降到 30~45%。
//
// 做法：真实 AudioContext（ambience.init 建链）→ analyser 频域数据 →
// 按 bin 中心频率分频段积分。每次换天气/房间后等 3 秒让床层重建稳定再采。
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9338;
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', 'public', 'room');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.png': 'image/png', '.webm': 'video/webm',
};

const srv = createServer((req, res) => {
  const rel = normalize(decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'probe.html');
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const pagePort = srv.address().port;

const userDir = mkdtempSync(join(tmpdir(), 'amb-'));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`,
  '--headless=new', '--no-first-run', '--disable-gpu',
  '--autoplay-policy=no-user-gesture-required', '--mute-audio',
  'about:blank',
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
// 导航到一个**真实存在**的页面（相对 import 才解析得到）。
// 用 sfx-lab.html：它是同目录下的独立页面，import './ambience.js' 一定能解析。
await send('Page.navigate', { url: `http://127.0.0.1:${pagePort}/sfx-lab.html` }, sessionId);
await sleep(1200);

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'JS 抛错');
  return r.result?.value;
}

const WEATHERS = ['day', 'overcast', 'fog', 'haze', 'sand', 'rain', 'storm', 'snow', 'night', 'dusk', 'typhoon', 'blizzard', 'aurora', 'meteor', 'hail', 'sleet'];
const ROOMS = ['living', 'balcony', 'kitchen', 'her_room', 'bathroom'];

const out = await evaluate(`
(async () => {
  const { ambience: amb } = await import('./ambience.js');
  amb.init();
  amb.setEnabled(true);
  amb.setVolume(0.6);

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // 采样：连续取 N 次 spectrum，取各频段占比的均值
  async function sample(times = 14, gap = 90) {
    const acc = [];
    for (let i = 0; i < times; i += 1) {
      await wait(gap);
      const s = amb.spectrum();
      if (s && s.total > 0) acc.push(s.shares);
    }
    if (!acc.length) return null;
    return acc[0].map((_, bi) => +(acc.reduce((s, a) => s + a[bi], 0) / acc.length).toFixed(4));
  }

  const results = [];
  for (const weather of ${JSON.stringify(WEATHERS)}) {
    for (const room of ${JSON.stringify(ROOMS)}) {
      amb.setScene({ weather, room });
      await wait(2600);           // 等床层重建 + 渐入稳定
      const shares = await sample();
      if (!shares) { results.push({ weather, room, shares: null }); continue; }
      results.push({
        weather, room,
        shares,
        wind: shares[0],           // 0-400Hz
        low: shares[1],            // 400-1200
        mid: shares[2],            // 1200-2800
        high: shares[3],           // 2800-8000
        veryHigh: shares[4]        // >8000
      });
    }
  }
  return results;
})()
`);

console.log('\n=== 各天气 × 房间：频段能量占比（%）===');
console.log('风频段 = 0-400Hz（风的所在）\n');
const hdr = ['天气', '房间'].concat(['风', '低', '中', '高', '超高']);
const w = [10, 12, 8, 8, 8];
console.log(hdr.map((h, i) => h.padStart(w[i])).join(''));
console.log('-'.repeat(w.reduce((a, b) => a + b, 0)));
for (const r of out) {
  if (!r.shares) { console.log(`${r.weather.padEnd(w[0])}${r.room.padEnd(w[1])}  采样失败`); continue; }
  const cells = [r.weather, r.room,
    `${(r.wind * 100).toFixed(1)}%`,
    `${(r.low * 100).toFixed(1)}%`,
    `${(r.mid * 100).toFixed(1)}%`,
    `${(r.high * 100).toFixed(1)}%`,
    `${(r.veryHigh * 100).toFixed(1)}%`];
  console.log(cells.map((c, i) => String(c).padStart(w[i])).join(''));
}

// 汇总
const indoor = out.filter((r) => r.shares && ['living', 'kitchen', 'her_room', 'bathroom'].includes(r.room));
const outdoor = out.filter((r) => r.shares && r.room === 'balcony');
const avg = (arr, k) => arr.length ? +(arr.reduce((s, r) => s + r[k], 0) / arr.length).toFixed(4) : 0;
console.log('\n=== 汇总 ===');
console.log(`  室内平均风占比: ${(avg(indoor, 'wind') * 100).toFixed(1)}%`);
console.log(`  室外平均风占比: ${(avg(outdoor, 'wind') * 100).toFixed(1)}%`);
const worst = [...indoor].sort((a, b) => b.wind - a.wind).slice(0, 5);
console.log('  室内风占比最高的 5 个:');
worst.forEach((r) => console.log(`    ${r.weather}/${r.room}: ${(r.wind * 100).toFixed(1)}%`));
const best = [...indoor].sort((a, b) => a.wind - b.wind).slice(0, 3);
console.log('  室内风占比最低的 3 个（说明其他声源在起作用）:');
best.forEach((r) => console.log(`    ${r.weather}/${r.room}: ${(r.wind * 100).toFixed(1)}%`));

writeFileSync(join(process.env.TEMP || '.', 'ambience-spectrum.json'), JSON.stringify(out, null, 2), 'utf8');
console.log('\n写入 ambience-spectrum.json');

await send('Target.closeTarget', { targetId });
ws.close();
chrome.kill();
srv.close();