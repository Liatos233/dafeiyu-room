// 无头 Chrome 抓帧：验证动画切换时是否出现重影/空白
// 用法：node scripts/visual-check.mjs [url] [outDir]
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_TARGET = process.argv[2] || 'http://127.0.0.1:3100/room/';
const OUT = process.argv[3] || join(tmpdir(), 'room-frames');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const PROFILE = join(tmpdir(), 'chrome-room-check');

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
mkdirSync(PROFILE, { recursive: true });

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--window-size=1280,800',
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--disable-gpu-sandbox',
  '--no-sandbox',
  '--mute-audio',
  URL_TARGET
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getWs() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* 等待启动 */ }
    await sleep(500);
  }
  throw new Error('Chrome 调试端口未就绪');
}

const ws = new WebSocket(await getWs());
await new Promise((r) => { ws.onopen = r; });
let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
function send(method, params = {}) {
  const id = ++seq;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

await send('Page.enable');
await send('Runtime.enable');
await sleep(9000);   // 等场景、模型、视频加载

async function evaluate(expr) {
  const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return res.result?.result?.value;
}

async function shot(name) {
  const res = await send('Page.captureScreenshot', { format: 'png' });
  if (res.result?.data) writeFileSync(join(OUT, `${name}.png`), Buffer.from(res.result.data, 'base64'));
}

// 找到动作按钮并点击
async function clickAction(label) {
  return evaluate(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)});
    if (!b) return 'missing';
    b.click();
    return 'clicked';
  })()`);
}

const plan = [];
let idx = 0;
for (let round = 0; round < 12; round += 1) {
  for (let i = 0; i < 10; i += 1) {
    await shot(`r${String(round).padStart(2, '0')}-${i}`);
    await sleep(110);
  }
  idx += 1;
}

ws.close();
chrome.kill();
console.log('frames ->', OUT);
