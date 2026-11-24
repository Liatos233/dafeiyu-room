// 脚步声合成器的客观验收：不靠耳朵，靠**波形和频谱**。
//
// 要证的三件事（这三件坏了，听感立刻垮）：
//   1. 真的出声 —— analyser 的 RMS 不能是 0
//   2. 左右脚不一样 —— 连续两步的波形不该高度相似（交替失效 = 复读机）
//   3. 走和跑不一样 —— 跑步能量更大、频谱更低更厚，不是"音量调大"
//
// 做法：用 OfflineAudioContext 离线渲染合成音，把 PCM 取出来算特征。
// 离线渲染的好处是不依赖真实时间、不受浏览器节流，几毫秒就能拿到波形。
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, createReadStream, statSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9335;
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

const userDir = mkdtempSync(join(tmpdir(), 'sfx-wave-'));
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
await send('Page.navigate', { url: `http://127.0.0.1:${pagePort}/sfx-lab.html` }, sessionId);
await sleep(1600);

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'JS 抛错');
  return r.result?.value;
}

// 在页面里离线渲染脚步，返回波形特征。
// 直接 import sfx.js 拿 SYNTHS —— 测的是真源码里的那个合成器。
const result = await evaluate(`
(async () => {
  const m = await import('./sfx.js');
  const { SYNTHS } = m.__internals;

  // 离线渲染一次合成，返回 Float32Array
  async function render(fn, seconds = 0.5, rate = 44100) {
    const len = Math.floor(rate * seconds);
    const ctx = new OfflineAudioContext(1, len, rate);
    const out = ctx.createGain();
    out.connect(ctx.destination);
    fn(ctx, out);
    const buf = await ctx.startRendering();
    return buf.getChannelData(0);
  }

  function feats(pcm) {
    let sum = 0, peak = 0, energy = 0;
    for (let i = 0; i < pcm.length; i += 1) {
      const v = pcm[i];
      sum += v * v;
      energy += Math.abs(v);
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    const rms = Math.sqrt(sum / pcm.length);
    // 过零率：低频多的波形过零少。用来区分"更闷"和"更尖"
    let zc = 0;
    for (let i = 1; i < pcm.length; i += 1) if ((pcm[i] >= 0) !== (pcm[i - 1] >= 0)) zc += 1;
    return { rms, peak, energy, zcr: zc / pcm.length };
  }

  // 相关系数：判断两段波形像不像。1 = 完全一样（复读机），0 = 无关
  function corr(a, b) {
    const n = Math.min(a.length, b.length);
    let sa = 0, sb = 0, sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < n; i += 1) {
      sa += a[i]; sb += b[i]; sab += a[i] * b[i];
      saa += a[i] * a[i]; sbb += b[i] * b[i];
    }
    const num = n * sab - sa * sb;
    const den = Math.sqrt((n * saa - sa * sa) * (n * sbb - sb * sb));
    return den === 0 ? 0 : num / den;
  }

  const out = {};
  // 左脚 / 右脚（同一次渲染里只响一步）
  const L = await render((c, d) => SYNTHS.step(c, d, { foot: 0, running: false, surface: 'wood' }));
  const R = await render((c, d) => SYNTHS.step(c, d, { foot: 1, running: false, surface: 'wood' }));
  out.left = feats(L);
  out.right = feats(R);
  out.footCorr = corr(L, R);

  // 两次同参数渲染：应该也很像（决定性），用来校准 corr 的判读
  const L2 = await render((c, d) => SYNTHS.step(c, d, { foot: 0, running: false, surface: 'wood' }));
  out.sameCorr = corr(L, L2);

  // 跑 vs 走
  const W = await render((c, d) => SYNTHS.step(c, d, { running: false, surface: 'wood' }));
  const Rr = await render((c, d) => SYNTHS.step(c, d, { running: true, surface: 'wood' }));
  out.walk = feats(W);
  out.run = feats(Rr);

  // 地面差异：瓷砖应该比地毯亮（过零率高），地毯更闷
  const tile = await render((c, d) => SYNTHS.step(c, d, { surface: 'tile' }));
  const carpet = await render((c, d) => SYNTHS.step(c, d, { surface: 'carpet' }));
  out.tile = feats(tile);
  out.carpet = feats(carpet);
  out.tileVsCarpetCorr = corr(tile, carpet);

  // 左右脚交替：连续 6 步的基音序列（用 DOM 抓不到，直接看 state）
  const m2 = m.sfx;
  const feet = [];
  for (let i = 0; i < 6; i += 1) { feet.push(m2.debug().foot); m2.playStep({ running: false }); }
  out.footSeq = feet;

  return out;
})()
`);

const f = (v) => (typeof v === 'number' ? v.toFixed(5) : v);
console.log('\n=== 波形特征 ===');
console.log(`  左脚      rms=${f(result.left.rms)} peak=${f(result.left.peak)} zcr=${f(result.left.zcr)}`);
console.log(`  右脚      rms=${f(result.right.rms)} peak=${f(result.right.peak)} zcr=${f(result.right.zcr)}`);
console.log(`  走        rms=${f(result.walk.rms)} peak=${f(result.walk.peak)} zcr=${f(result.walk.zcr)}`);
console.log(`  跑        rms=${f(result.run.rms)} peak=${f(result.run.peak)} zcr=${f(result.run.zcr)}`);
console.log(`  瓷砖      zcr=${f(result.tile.zcr)}`);
console.log(`  地毯      zcr=${f(result.carpet.zcr)}`);
console.log('\n=== 相似度（1 = 完全一样）===');
console.log(`  同参数两次渲染   ${f(result.sameCorr)}   ← 校准基准，应该接近 1`);
console.log(`  左脚 vs 右脚     ${f(result.footCorr)}   ← 应该明显小于基准`);
console.log(`  瓷砖 vs 地毯     ${f(result.tileVsCarpetCorr)}`);
console.log(`\n  左右脚序列（每次 playStep 前读）：${JSON.stringify(result.footSeq)}`);

const fail = [];
if (!(result.walk.rms > 0.001)) fail.push('走路没声音');
if (!(result.run.rms > 0.001)) fail.push('跑步没声音');
// 左右脚必须真的不同：相似度要明显低于同参数基准
if (!(result.footCorr < result.sameCorr - 0.1)) {
  fail.push(`左右脚太像（${result.footCorr.toFixed(3)} vs 基准 ${result.sameCorr.toFixed(3)}），交替失效`);
}
// 跑步要比走路更厚：能量更大，且过零率不高于走路（更低更闷，不是更尖）
if (!(result.run.rms > result.walk.rms)) fail.push(`跑步不比走路响（${result.run.rms} vs ${result.walk.rms}）`);
if (!(result.run.zcr <= result.walk.zcr * 1.15)) fail.push(`跑步听起来太尖（zcr ${result.run.zcr} vs ${result.walk.zcr}）`);
// 瓷砖要比地毯亮
if (!(result.tile.zcr > result.carpet.zcr)) fail.push(`瓷砖不比地毯亮（${result.tile.zcr} vs ${result.carpet.zcr}），地面没区分`);
// 交替序列必须是 0,1,0,1...
for (let i = 1; i < result.footSeq.length; i += 1) {
  if (result.footSeq[i] === result.footSeq[i - 1]) { fail.push(`左右脚序列没交替：${result.footSeq}`); break; }
}

writeFileSync(join(tmpdir(), 'sfx-wave-result.json'), JSON.stringify(result, null, 2));

if (fail.length) {
  console.log(`\n✗ ${fail.length} 项不过：`);
  fail.forEach((x) => console.log(`  - ${x}`));
  process.exitCode = 1;
} else {
  console.log('\n✓ 全部通过');
}

await send('Target.closeTarget', { targetId });
ws.close();
chrome.kill();
srv.close();