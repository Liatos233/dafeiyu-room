// 活动路径冒烟测试：驱动角色依次走动/上床/上沙发/上下躺椅，
// 逐帧用占用网格判断「身体柱是否和实体相交」，记录违例并截图。
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.argv[2] || 'C:/Users/liato/dafeiyu-room/smoke';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9531;
const PROFILE = join(tmpdir(), 'chrome-smoke');
rmSync(PROFILE, { recursive: true, force: true });
rmSync(OUT, { recursive: true, force: true });
mkdirSync(PROFILE, { recursive: true });
mkdirSync(OUT, { recursive: true });

spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--window-size=1024,640', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--no-sandbox', '--mute-audio', 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let wsUrl = null;
for (let i = 0; i < 60; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    const page = list.find((t) => t.type === 'page');
    if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break; }
  } catch { /* wait */ }
  await sleep(400);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const i = ++id; pending.set(i, resolve);
  ws.send(JSON.stringify({ id: i, method, params }));
});
await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: 'http://101.245.76.51:3100/room/?sky=day&hour=12' });
await sleep(34000);

const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

const steps = [
  { name: 'walk-kitchen', action: { action: 'command', room: 'kitchen', spot: 'sink' }, wait: 9000 },
  { name: 'mount-sofa', action: { action: 'command', room: 'living', spot: 'sofa' }, wait: 12000 },
  { name: 'dismount-sofa', action: { action: 'command', room: 'kitchen', spot: 'stove' }, wait: 10000 },
  { name: 'mount-bed', action: { action: 'command', room: 'her_room', spot: 'bed' }, wait: 14000 },
  { name: 'dismount-bed', action: { action: 'command', room: 'living', spot: 'sofa' }, wait: 13000 },
  { name: 'mount-lounger', action: { action: 'command', room: 'pool', spot: 'lounger' }, wait: 14000 },
  { name: 'dismount-lounger', action: { action: 'command', room: 'pool', spot: 'deck_w' }, wait: 9000 },
  { name: 'mount-chair', action: { action: 'command', room: 'balcony', spot: 'chair' }, wait: 14000 },
  { name: 'dismount-chair', action: { action: 'command', room: 'living', spot: 'sofa' }, wait: 13000 },
  // 直接点家具内部的地面（应被推到区域外，而不是走进去）
  { name: 'floor-inside-sofa', action: { action: 'go', pos: [6.3, 5.1] }, wait: 9000 }
];

const frames = [];
let shotIdx = 0;

async function sample(label) {
  const r = await evalJs(`(() => {
    const w = window.__getWorld?.();
    const d = window.__drawState || null;
    if (!w || !d) return null;
    const elev = d.elev || 0;
    const hit = w.blockedAt(d.pos[0], d.pos[1], 0.18, elev + 0.06, 1.25);
    return { pos: [ +d.pos[0].toFixed(3), +d.pos[1].toFixed(3) ], elev: +elev.toFixed(3), pose: d.pose, spot: d.spot, clip: d.clip, walking: !!d.walking, hit };
  })()`);
  if (r) frames.push({ t: Date.now(), label, ...r });
  return r;
}

async function shot(name) {
  const data = await evalJs(`(() => {
    const T = window.__THREE, w = window.__getWorld?.(), r = window.__renderer;
    if (!T || !w || !r) return null;
    const cam = new T.PerspectiveCamera(46, r.domElement.width / r.domElement.height, 0.1, 200);
    cam.position.set(7.2, 7.5, 12.0);
    cam.lookAt(7.0, 0.6, 5.2);
    cam.updateMatrixWorld(true);
    r.render(w.scene, cam);
    return r.domElement.toDataURL('image/png');
  })()`);
  if (data) {
    writeFileSync(join(OUT, `${String(shotIdx).padStart(2, '0')}-${name}.png`), Buffer.from(String(data).split(',')[1], 'base64'));
    shotIdx += 1;
  }
}

for (const st of steps) {
  await evalJs(`fetch('/api/home/act', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(${JSON.stringify(st.action)}) }).catch(() => {})`);
  const until = Date.now() + st.wait;
  while (Date.now() < until) {
    await sleep(250);
    await sample(st.name);
  }
  await shot(st.name);
}

// 汇总
const byLabel = {};
for (const f of frames) {
  if (!byLabel[f.label]) byLabel[f.label] = { n: 0, hits: 0, samples: [] };
  const b = byLabel[f.label];
  b.n += 1;
  if (f.hit) {
    b.hits += 1;
    if (b.samples.length < 4) b.samples.push({ pos: f.pos, elev: f.elev, spot: f.spot, pose: f.pose });
  }
}
// 位置跳变 & 动画切换统计
let maxJump = 0, jumps = [], clipSwitches = 0, lastClip = null;
for (let i = 1; i < frames.length; i += 1) {
  const a = frames[i - 1], b = frames[i];
  if (a.label !== b.label) { if (b.clip && lastClip && b.clip !== lastClip) clipSwitches += 1; if (b.clip) lastClip = b.clip; continue; }
  const d = Math.hypot(b.pos[0] - a.pos[0], b.pos[1] - a.pos[1]);
  if (!b.walking && d > maxJump) { maxJump = d; jumps.push({ label: b.label, d: +d.toFixed(2), pos: b.pos, elev: b.elev }); }
  if (b.clip && lastClip && b.clip !== lastClip) clipSwitches += 1;
  if (b.clip) lastClip = b.clip;
}
const summary = { total: frames.length, byLabel, maxStillJump: +maxJump.toFixed(2), jumps: jumps.slice(-5), clipSwitches };
writeFileSync(join(OUT, 'report.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
process.exit(0);
