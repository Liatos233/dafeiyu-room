// 截 UI（不是 3D 场景）：验证 chip 样式改动。
// 用本地 bridge（3100）加载真实房间页，不传 shot=1，所以 HUD 都在。
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9340;
const URL = process.argv[2] || 'http://127.0.0.1:3100/room/';
const OUT = process.argv[3] || join(process.cwd(), '..', '.tmp-ui-chips.png');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userDir = mkdtempSync(join(tmpdir(), 'ui-'));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`,
  '--headless=new', '--no-first-run', '--disable-gpu',
  '--hide-scrollbars', '--force-device-scale-factor=2',
  '--window-size=1280,800',
  'about:blank',
], { stdio: 'ignore' });

let ws, msgId = 0;
const pending = new Map();
const send = (m, p = {}, s) => {
  const id = ++msgId;
  return new Promise((res, rej) => { pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method: m, params: p, ...(s ? { sessionId: s } : {}) })); });
};
let info = null;
for (let i = 0; i < 40; i += 1) {
  try { info = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); break; } catch { await sleep(250); }
}
ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id); pending.delete(m.id);
    m.error ? rej(new Error(m.error.message)) : res(m.result);
  }
};
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false }, sessionId);
await send('Page.navigate', { url: URL }, sessionId);
await sleep(9000);

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'JS error');
  return r.result?.value;
};

// 状态快照：哪些 chip 有 active / is-idle、哪个 cam 模式被选中
const before = await evaluate(`
(() => {
  const q = (id) => document.getElementById(id);
  const amb = q('ambienceChip'), snd = q('soundChip'), qq = q('qqChip'), cam = q('camModeChip');
  const vis = (el) => el ? getComputedStyle(el).display !== 'none' : null;
  return {
    ambienceActive: amb?.classList.contains('active'),
    ambienceText: q('ambienceState')?.textContent,
    soundActive: snd?.classList.contains('active'),
    qqVisible: vis(qq), qqText: q('qqText')?.textContent, qqIdle: qq?.classList.contains('is-idle'),
    camChipActive: cam?.classList.contains('active'),
    camOn: [...(cam?.querySelectorAll('button') || [])].map(b => b.dataset.camMode + ':' + (b.classList.contains('on') ? 'ON' : '-'))
  };
})()
`);
console.log('初始状态:', JSON.stringify(before, null, 2));

// 点开环境音
await evaluate(`document.getElementById('ambienceChip')?.click(); true`);
await sleep(900);
const after = await evaluate(`
(() => {
  const q = (id) => document.getElementById(id);
  const amb = q('ambienceChip');
  const cs = amb ? getComputedStyle(amb) : null;
  return {
    ambienceActive: amb?.classList.contains('active'),
    ambienceText: q('ambienceState')?.textContent,
    ambienceBg: cs?.backgroundImage?.slice(0, 60) || cs?.backgroundColor,
    ambienceColor: cs?.color
  };
})()
`);
console.log('点开环境音后:', JSON.stringify(after, null, 2));

// 切到「组合」看选中态
await evaluate(`document.querySelector('#camModeChip button[data-cam-mode="both"]')?.click(); true`);
await sleep(400);
const camAfter = await evaluate(`
(() => {
  const cam = document.getElementById('camModeChip');
  return {
    chipActive: cam?.classList.contains('active'),
    segs: [...cam.querySelectorAll('button')].map(b => {
      const cs = getComputedStyle(b);
      return b.dataset.camMode + (b.classList.contains('on') ? ' ON bg=' + (cs.backgroundImage !== 'none' ? 'grad' : cs.backgroundColor) + ' color=' + cs.color : '');
    }),
    title: cam?.title
  };
})()
`);
console.log('切到组合后:', JSON.stringify(camAfter, null, 2));

// 双击画布：不应该改变视角（对比前后相机位置）
const dbl = await evaluate(`
(() => {
  const before = window.__roomDebug ? JSON.stringify(window.__roomDebug.camera) : 'n/a';
  const c = document.querySelector('canvas');
  for (let i = 0; i < 2; i += 1) c.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 600, clientY: 400 }));
  const after = window.__roomDebug ? JSON.stringify(window.__roomDebug.camera) : 'n/a';
  return { before, after, same: before === after };
})()
`);
console.log('双击画布:', JSON.stringify(dbl));

// 截左上角 chip 区域
const shot = await send('Page.captureScreenshot', {
  format: 'png',
  clip: { x: 0, y: 0, width: 1280, height: 210, scale: 2 },
}, sessionId);
writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log('截图:', OUT);

await send('Target.closeTarget', { targetId });
ws.close();
chrome.kill();