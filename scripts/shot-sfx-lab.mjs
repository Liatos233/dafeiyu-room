// 截一张试听台的图，确认排版没错、按钮都在、没有丑的错位。
// 用真实 Chrome + CDP（项目里没有 puppeteer，不额外装依赖）。
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, createReadStream, statSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9334;
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', 'public', 'room');
const OUT = process.argv[2] || join(HERE, '..', '..', '.tmp-sfx-lab.png');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.ogg': 'audio/ogg', '.css': 'text/css' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const srv = createServer((req, res) => {
  const rel = normalize(decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'sfx-lab.html');
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const pagePort = srv.address().port;

const userDir = mkdtempSync(join(tmpdir(), 'sfx-shot-'));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${userDir}`,
  '--headless=new', '--no-first-run', '--disable-gpu',
  '--hide-scrollbars', '--force-device-scale-factor=2',
  '--window-size=900,1200',
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
await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 1200, deviceScaleFactor: 2, mobile: false }, sessionId);
await send('Page.navigate', { url: `http://127.0.0.1:${pagePort}/sfx-lab.html` }, sessionId);
await sleep(2000);

// 触发音频初始化，让状态栏显示真实数据（不是"初始化中"）
await send('Runtime.evaluate', { expression: `document.body.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})); true`, returnByValue: true }, sessionId);
await sleep(900);

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId);
writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
const size = statSync(OUT).size;
console.log(`截图：${OUT}  ${(size / 1024).toFixed(0)}KB`);

await send('Target.closeTarget', { targetId });
ws.close();
chrome.kill();
srv.close();