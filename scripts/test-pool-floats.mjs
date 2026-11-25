// 验证泳池浮体真的在漂：在真实 Chrome 里采样 world.poolFloats 的位置/朝向。
// 判定标准（不能只看"有变化"就过，要判断幅度是否像水在推）：
//   · 位置要动（水平 drift）
//   · 高度要跟着水面起伏（垂直 bob）
//   · 朝向要缓慢转
//   · 不能漂出泳池
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = Number(process.env.PORT || 9351);
const URL = process.argv[2] || 'http://127.0.0.1:3100/room/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'float-'))}`,
  '--headless=new', '--no-first-run', '--disable-gpu', '--window-size=1280,800', 'about:blank',
], { stdio: 'ignore' });

let ws, id = 0;
const pend = new Map();
const send = (method, params = {}, sid) => {
  const i = ++id;
  return new Promise((res, rej) => { pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params, ...(sid ? { sessionId: sid } : {}) })); });
};
let info = null;
for (let i = 0; i < 40; i += 1) {
  try { info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(250); }
}
ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
};
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Page.navigate', { url: URL }, sessionId);
await sleep(9000);

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'js err');
  return r.result?.value;
};

const exists = await evalJs(`const w = window.__getWorld ? window.__getWorld() : (window.__world || null); !!(w && w.poolFloats)`);
if (!exists) {
  console.log('!! window.__world.poolFloats 不可见，尝试其它入口');
  const names = await evalJs(`Object.keys(window).filter(k => /world|scene/i.test(k))`);
  console.log('候选:', JSON.stringify(names));
}

// 采 12 个时间点
const samples = [];
for (let i = 0; i < 12; i += 1) {
  const s = await evalJs(`
  (() => {
    const w = window.__getWorld ? window.__getWorld() : (window.__world || null);
    if (!w || !w.poolFloats) return null;
    return {
      surfT: w.poolSurf ? w.poolSurf.t : null,
      floats: w.poolFloats.map(f => ({
        x: +f.node.position.x.toFixed(4),
        y: +f.node.position.y.toFixed(4),
        z: +f.node.position.z.toFixed(4),
        ry: +f.node.rotation.y.toFixed(4),
        rx: +f.node.rotation.x.toFixed(4)
      }))
    };
  })()
  `);
  if (!s) { console.log('取不到飘浮物状态（world 未暴露）'); break; }
  samples.push(s);
  await sleep(400);
}

if (samples.length >= 2) {
  const first = samples[0], last = samples[samples.length - 1];
  console.log('surfT 变化:', first.surfT?.toFixed(2), '→', last.surfT?.toFixed(2));
  for (let k = 0; k < first.floats.length; k += 1) {
    const xs = samples.map((s) => s.floats[k].x);
    const ys = samples.map((s) => s.floats[k].y);
    const rys = samples.map((s) => s.floats[k].ry);
    const dx = Math.max(...xs) - Math.min(...xs);
    const dy = Math.max(...ys) - Math.min(...ys);
    const dry = Math.max(...rys) - Math.min(...rys);
    const total = Math.hypot(last.floats[k].x - first.floats[k].x, last.floats[k].z - first.floats[k].z);
    console.log(
      `浮体${k}: 水平位移 ${dx.toFixed(3)}m  垂直起伏 ${(dy * 1000).toFixed(1)}mm  ` +
      `转动 ${(dry * 180 / Math.PI).toFixed(1)}°  首尾距离 ${total.toFixed(3)}m`
    );
  }
}

// 检查有没有漂出池子（池 X 1.0~10.2, Z 10.05~12.55）
const out = await evalJs(`
(() => {
  const w = window.__getWorld ? window.__getWorld() : (window.__world || null);
  if (!w || !w.poolFloats) return null;
  const bad = [];
  for (const f of w.poolFloats) {
    const p = f.node.position;
    if (p.x < 1.0 || p.x > 10.2 || p.z < 10.05 || p.z > 12.55) bad.push([+p.x.toFixed(2), +p.z.toFixed(2)]);
  }
  return bad;
})()
`);
console.log('漂出池子的浮体:', out && out.length ? JSON.stringify(out) : '无');

await send('Target.closeTarget', { targetId });
ws.close();
chrome.kill();
