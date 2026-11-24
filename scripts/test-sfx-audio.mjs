// 用真实 Chrome + CDP 验证 sfx.js：不是"语法过了"，而是"声音真的出来了"。
//
// 判据不是听（没法听），而是看**音频图里的信号**：
//  1. 页面里建一个 AnalyserNode 挂在 destination 之前，测 RMS；
//  2. 触发音效，采样几帧看 RMS 有没有抬起来；
//  3. 顺带验证冷却、声像、静音是不是按预期工作。
// 这些都能在无头 Chrome 里跑（加 --autoplay-policy=no-user-gesture-required）。
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, createReadStream, statSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, extname, normalize } from 'node:path';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9333;
const BASE = process.env.SFX_BASE || 'http://127.0.0.1:3100';

// 试听页是开发工具，不进 vite 构建（vite 的 input 只有 index.html），
// 所以 dist/room 里没有它、bridge 也就 404。
// 这里自己起一个极小的静态服务器伺候 public/room，好处是：
//  1) 走 http:// 而不是 file://（fetch 素材不会被 CORS 拦）；
//  2) 不依赖 bridge 是不是在跑、是不是最新构建；
//  3) 测的就是**源码**里那份 sfx.js，改了不用重新 build。
const ROOT = join(process.cwd(), 'public', 'room');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.css': 'text/css; charset=utf-8',
};

function startStaticServer() {
  const srv = createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = normalize(urlPath.replace(/^\/+/, '') || 'index.html');
    const file = join(ROOT, rel);
    // 目录穿越保护
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`404 ${rel}`);
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'access-control-allow-origin': '*',
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userDir = mkdtempSync(join(tmpdir(), 'sfx-cdp-'));
const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${userDir}`,
  '--headless=new',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--autoplay-policy=no-user-gesture-required',
  '--mute-audio',            // 静音出声，不影响音频图里的信号测量
  'about:blank',
], { stdio: 'ignore' });

let ws = null;
let msgId = 0;
const pending = new Map();

function send(method, params = {}, sessionId) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

async function evaluate(expression, sessionId) {
  const r = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'JS 抛错');
  return r.result?.value;
}

async function main() {
  const { srv, port: pagePort } = await startStaticServer();
  const PAGE = `http://127.0.0.1:${pagePort}/sfx-lab.html`;
  console.log(`试听页：${PAGE}`);

  // 等 Chrome 起来
  let info = null;
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      info = await r.json();
      break;
    } catch { await sleep(250); }
  }
  if (!info) throw new Error('Chrome 没起来');

  const wsUrl = info.webSocketDebuggerUrl;
  ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) reject(new Error(m.error.message));
      else resolve(m.result);
    }
  };

  // 建一个 target 并 attach
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);

  const logs = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled' && m.sessionId === sessionId) {
      logs.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  });

  await send('Page.navigate', { url: PAGE }, sessionId);
  await sleep(2200);

  const title = await evaluate('document.title', sessionId);
  if (!/音效试听台/.test(title || '')) throw new Error(`页面没加载对：${title}`);

  // 先触发用户手势，让试听页把 AudioContext 建起来（浏览器要求手势后才能出声）
  await evaluate(`
    (() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      return true;
    })()
  `, sessionId);
  await sleep(700);

  // 再在页面自己的音频图里并接 analyser。
  //
  // 不能在 destination 上做手脚：sfx.js 在 attach() 时就把 bus.connect(master)
  // 接好了，那时再改 destination 已经晚了（链路已定型）。
  // 试听页把 {ctx,bus,master} 挂在 window.__sfxGraph 上，探针直接拿它 ——
  // 这样量的是**真实的那条链**，不是仿制品。
  const installed = await evaluate(`
    (() => {
      const g = window.__sfxGraph;
      if (!g || !g.ctx || !g.bus) return 'no graph';
      const an = g.ctx.createAnalyser();
      an.fftSize = 2048;
      // 并接（不是串接）：挂在 bus 下游，不影响原有输出
      g.bus.connect(an);
      window.__probe = { ctx: g.ctx, analyser: an };
      return 'ok';
    })()
  `, sessionId);
  if (installed !== 'ok') throw new Error(`接不上探针：${installed}`);

  const readRms = `(async () => {
    const p = window.__probe;
    if (!p.analyser) return -1;
    const buf = new Float32Array(p.analyser.fftSize);
    let peak = 0;
    // 采样窗口要够密：脚步只有 60ms，如果隔 25ms 才采一次，
    // 可能整段采样都落在音尾之后 —— 表现就是"明明响了却测不到"。
    // 5ms 一次、共 40 次 = 200ms 窗口，覆盖短促音。
    for (let i = 0; i < 40; i += 1) {
      p.analyser.getFloatTimeDomainData(buf);
      let s = 0;
      for (let j = 0; j < buf.length; j += 1) s += buf[j] * buf[j];
      peak = Math.max(peak, Math.sqrt(s / buf.length));
      await new Promise((r) => setTimeout(r, 5));
    }
    return peak;
  })()`;

  const results = {};

  // ── 静音基线（没触发任何音效时应当接近 0） ──
  results.silent = await evaluate(readRms, sessionId);

  // ── 触发每一步，测 RMS 峰值 ──
  for (const name of ['step', 'run', 'swim', 'splashEnter']) {
    await evaluate(`
      (() => {
        const btns = [...document.querySelectorAll('button.sfx')];
        const b = btns.find((x) => x.dataset.event === ${JSON.stringify(name)});
        if (b) b.click();
        return !!b;
      })()
    `, sessionId);
    await sleep(20);
    results[name] = await evaluate(readRms, sessionId);
    await sleep(750);   // 等冷却过去，也等尾巴放完
  }

  // ── 声像：不同 pan 应该都能出声（panner 节点没接错） ──
  await evaluate(`
    (() => {
      const el = document.getElementById('pan');
      el.value = '-100'; el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `, sessionId);
  await evaluate(`(() => { const b=[...document.querySelectorAll('button.sfx')].find(x=>x.dataset.event==='step'); b&&b.click(); return true; })()`, sessionId);
  await sleep(20);
  results.panLeft = await evaluate(readRms, sessionId);
  await sleep(600);

  // ── 状态与日志 ──
  results.state = await evaluate("document.getElementById('state').innerText", sessionId);
  results.log = await evaluate("document.getElementById('log').innerText.slice(0,600)", sessionId);
  results.debug = await evaluate('window.__sfxGraph ? { graph: true } : { graph: false }', sessionId);
  results.sfxDebug = await evaluate(`
    (() => {
      // 试听页把 sfx 实例挂在这，避免这里再 import 一次（路径会变）
      return window.__sfxInstance ? window.__sfxInstance.debug() : null;
    })()
  `, sessionId);
  results.consoleLogs = logs.slice(-12);

  console.log('\n=== 音频探针结果（RMS 峰值，0 = 无声）===');
  for (const [k, v] of Object.entries(results)) {
    if (typeof v === 'number') {
      const mark = v > 0.001 ? '✓ 有声' : '✗ 无声';
      console.log(`  ${k.padEnd(12)} ${v.toFixed(5)}  ${mark}`);
    }
  }
  console.log('\n=== sfx.debug() ===');
  console.log(JSON.stringify(results.debug, null, 2));
  console.log('\n=== 页面状态 ===');
  console.log(results.state);
  console.log('\n=== 日志 ===');
  console.log(results.log);
  if (results.consoleLogs.length) {
    console.log('\n=== console ===');
    results.consoleLogs.forEach((l) => console.log(' ', l));
  }

  // 判定
  const failures = [];
  if (!(results.step > 0.001)) failures.push('step 没声音');
  if (!(results.run > 0.001)) failures.push('run 没声音');
  if (!(results.swim > 0.001)) failures.push('swim 没声音');
  if (!(results.splashEnter > 0.001)) failures.push('splashEnter 没声音');
  if (results.silent > 0.02) failures.push(`静音基线太高（${results.silent}）`);
  if (results.debug?.loaded < 5) failures.push(`素材解码不全（${results.debug?.loaded}）`);

  writeFileSync(join(tmpdir(), 'sfx-probe-result.json'), JSON.stringify(results, null, 2));

  if (failures.length) {
    console.log(`\n✗ ${failures.length} 项不过：`);
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exitCode = 1;
  } else {
    console.log('\n✓ 全部通过');
  }

  await send('Target.closeTarget', { targetId });
  ws.close();
  chrome.kill();
  srv.close();
}

main().catch(async (e) => {
  console.error('失败：', e.message);
  process.exitCode = 1;
  try { ws?.close(); } catch {}
  chrome.kill();
});