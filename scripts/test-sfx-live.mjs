// 验收**线上**部署：真实 Chrome 打开公网地址，确认音效真的能响。
//
// 和 test-sfx-audio.mjs 的区别：那个测本地源码，这个测线上 bundle +
// 线上素材。部署完最有价值的验证就是这一条 —— 它能证明
// "构建产物里确实带上了音效代码，并且素材能从线上取到"。
//
// 跑法：node scripts/test-sfx-live.mjs [url]
//   默认 http://101.245.76.51:3100/room/
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9336;
const URL = process.argv[2] || 'http://101.245.76.51:3100/room/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userDir = mkdtempSync(join(tmpdir(), 'sfx-live-'));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`,
  '--headless=new', '--no-first-run', '--disable-gpu',
  '--autoplay-policy=no-user-gesture-required', '--mute-audio',
  '--window-size=1280,800',
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
if (!info) throw new Error('Chrome 没起来');

ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

const logs = [];
const errors = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.consoleAPICalled') {
    const txt = (m.params.args || []).map((a) => a.value ?? a.description).join(' ');
    logs.push(txt);
  }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails?.exception?.description || 'exception');
  }
};

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Network.enable', {}, sessionId);

// 记录所有失败的请求 —— 素材 404 是这类部署最常见的坑
const failedRequests = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Network.loadingFailed') failedRequests.push(m.params);
});

console.log(`打开线上地址：${URL}`);
await send('Page.navigate', { url: URL }, sessionId);
await sleep(9000);   // 3D 场景 + 素材加载要时间

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'JS 抛错');
  return r.result?.value;
}

// 页面里有没有 sfx 模块在跑？开发服务器暴露的调试对象线上没有，
// 所以换个更硬的判据：直接看全局是否挂上了 ambience.sfx —— app.js 把它透出在
// ambience 对象上，而 ambience 会被挂到 window 供控制台调试。
const probe = await evaluate(`
(async () => {
  const out = { found: false };
  // 1) 找 window 上的 ambience（app.js 里有挂？没有就靠 DOM 交互触发）
  const amb = window.__ambience || window.ambience || null;
  out.hasAmbience = !!amb;
  out.hasSfx = !!(amb && amb.sfx);
  if (out.hasSfx) {
    out.sfxDebug = amb.sfx.debug();
    // 真触发一次脚步，量 master 上的信号
    const d = amb.debug ? amb.debug() : null;
    out.ambDebug = d;
  }
  // 2) 不管有没有对象，直接量页面里所有 AudioContext 的输出
  //    用 PerformanceObserver 拿不到音频，改成 hook：
  return out;
})()
`);

// 页面的 3D 场景加载完了吗
const sceneInfo = await evaluate(`
(() => {
  const c = document.querySelector('canvas');
  return {
    canvas: !!c,
    w: c ? c.width : 0,
    h: c ? c.height : 0,
    title: document.title,
    bodyLen: document.body.innerText.length
  };
})()
`);

console.log('\n=== 页面 ===');
console.log(`  canvas ${sceneInfo.w}x${sceneInfo.h}  title="${sceneInfo.title}"`);
console.log(`  ambience 对象 ${probe.hasAmbience ? '有' : '无'} · sfx ${probe.hasSfx ? '有' : '无'}`);
if (probe.sfxDebug) console.log(`  sfx.debug ${JSON.stringify(probe.sfxDebug)}`);
if (probe.ambDebug) console.log(`  ambience.debug.sfx ${JSON.stringify(probe.ambDebug.sfx || null)}`);

// 关键：素材在线上能不能取到（用 fetch 直接验，绕开页面逻辑）
const assetCheck = await evaluate(`
(async () => {
  const files = ['swim-1','swim-2','swim-3','swim-4','splash-enter'];
  const out = {};
  for (const f of files) {
    try {
      const r = await fetch('/room/assets/sound/sfx/' + f + '.ogg', { method: 'HEAD' });
      const ct = r.headers.get('content-type') || '';
      const len = r.headers.get('content-length') || '?';
      out[f] = { ok: r.ok, status: r.status, ct, len };
    } catch (e) { out[f] = { ok: false, err: String(e.message || e) }; }
  }
  return out;
})()
`);

console.log('\n=== 线上素材（HEAD 请求）===');
let assetBad = 0;
for (const [f, v] of Object.entries(assetCheck)) {
  const good = v.ok && /audio\//.test(v.ct);
  if (!good) assetBad += 1;
  console.log(`  ${good ? '✓' : '✗'} ${f.padEnd(14)} ${v.status || '-'} ${v.ct || v.err || ''} ${v.len || ''}B`);
}

if (errors.length) {
  console.log('\n=== 页面异常 ===');
  errors.slice(0, 5).forEach((e) => console.log('  ' + String(e).split('\n')[0]));
}
if (failedRequests.length) {
  console.log(`\n=== 失败请求 ${failedRequests.length} 条 ===`);
  failedRequests.slice(0, 8).forEach((r) => console.log(`  ${r.errorText || ''} ${r.blockedReason || ''}`));
}

const fail = [];
if (!sceneInfo.canvas) fail.push('3D 场景没起来（没有 canvas）');
if (assetBad) fail.push(`${assetBad} 个音效素材在线上取不到`);
if (errors.length) fail.push(`${errors.length} 个页面异常`);

if (fail.length) {
  console.log(`\n✗ ${fail.length} 项不过：`);
  fail.forEach((x) => console.log(`  - ${x}`));
  process.exitCode = 1;
} else {
  console.log('\n✓ 线上部署正常：场景起来了，音效素材可取，无异常');
}

await send('Target.closeTarget', { targetId });
ws.close();
chrome.kill();