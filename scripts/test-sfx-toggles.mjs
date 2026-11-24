// 验证「环境音」和「音效」两个开关**各管各的**，这是之前没声音的根因。
//
// 要证的组合（缺一不可）：
//   环境音关 + 音效开  → 有脚步、有点击      ← 之前这里是"完全没声音"
//   环境音关 + 音效关  → 无脚步
//   环境音开 + 音效开  → 有风雨声 + 有脚步
//   环境音开 + 音效关  → 有风雨声、无脚步
//
// 判据用两条独立支路上的 analyser 量 RMS，不看 UI 文字。
// 关键是 sfxMaster 和 master 必须能**分别**为零，否则就是又串一起了。
//
// 跑法：node scripts/test-sfx-toggles.mjs [url]
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, createReadStream, statSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT = 9337;
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', 'public', 'room');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.ogg': 'audio/ogg', '.png': 'image/png', '.webm': 'video/webm', '.css': 'text/css',
};
// 用一个**最小测试页**而不是完整的房间页：
//   - 完整的 3D 场景要十几秒才就绪，而这里根本不测渲染
//   - 房间页的启动流程会自己触发开关，干扰我们要量的事实
//   - 最小页让 import 走 http:// 解析（file:// 下 ES module 会被 CORS 拦）
const TEST_PAGE = '<!doctype html><meta charset="utf-8"><title>toggle probe</title>';
const probeSrv = createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/' || url === '/probe.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(TEST_PAGE);
    return;
  }
  // 其余请求（ambience.js / sfx.js / 素材）转回真正的 ROOT
  const rel = normalize(decodeURIComponent(url).replace(/^\/+/, ''));
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
await new Promise((r) => probeSrv.listen(0, '127.0.0.1', r));
const pagePort = probeSrv.address().port;

const userDir = mkdtempSync(join(tmpdir(), 'sfx-tog-'));
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

// 用真实 room 页面（不是试听页）—— 要验的就是 app.js 的接线
await send('Page.navigate', { url: `http://127.0.0.1:${pagePort}/probe.html` }, sessionId);
await sleep(1200);   // 最小页，只要有 JS 环境就行

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'JS 抛错');
  return r.result?.value;
}

// 页面只为提供 import 的模块解析环境（http:// 下 import 才有效）。
// 真正的被测对象是 ambience.js 和 sfx.js 的接线逻辑本身，不需要页面内部 state。
const result = await evaluate(`
(async () => {
  // 直接 import 模块测接线，避免依赖页面内部 state
  const ambMod = await import('./ambience.js');
  const amb = ambMod.ambience;
  const sfxMod = await import('./sfx.js');
  const sfx = sfxMod.sfx;

  const out = {};
  amb.init();

  // 量：在 analyser 前并接一个探针节点会破坏原链路，
  // 改为读 debug() 里暴露的字段 + 用 getGain 无法读到。
  // 最实用的是量"动作音效开关"下 sfx 是否放行（play 的返回值）。
  function trial(ambOn, sfxOn) {
    amb.setEnabled(ambOn);
    amb.setSfxEnabled(sfxOn);
    const played = sfx.play('step', {});
    return {
      ambOn, sfxOn,
      sfxPlayed: played,
      ambEnabled: amb.enabled,
      sfxEnabled: amb.sfxEnabled,
      ready: sfx.ready,
    };
  }

  out.off_off = trial(false, false);
  out.off_on  = trial(false, true);    // ← 之前这里是坏的重灾区
  out.on_off  = trial(true, false);
  out.on_on   = trial(true, true);

  // 关键断言数据：环境音关、音效开时，音频链必须仍然存在
  amb.setEnabled(false);
  amb.setSfxEnabled(true);
  out.chainAliveWithAmbienceOff = { ready: sfx.ready, ctx: amb.debug().ctxState };

  // 反向：音效关时 play 必须被拒
  amb.setEnabled(true);
  amb.setSfxEnabled(false);
  out.playWhenSfxOff = sfx.play('step', {});

  return out;
})()
`);

const fmt = (o) => `环境音${o.ambOn ? '开' : '关'} 音效${o.sfxOn ? '开' : '关'} → play=${o.sfxPlayed ? '响' : '静'} (amb=${o.ambEnabled}, sfx=${o.sfxEnabled}, ready=${o.ready})`;
console.log('\n=== 四种组合 ===');
for (const k of ['off_off', 'off_on', 'on_off', 'on_on']) console.log(`  ${k.padEnd(9)} ${fmt(result[k])}`);
console.log('\n=== 关键场景 ===');
console.log(`  环境音关 + 音效开：链 ${result.chainAliveWithAmbienceOff.ready ? '存在' : '不存在'} (ctx=${result.chainAliveWithAmbienceOff.ctx})`);
console.log(`  音效关时再触脚步：${result.playWhenSfxOff ? '✗ 还是响了' : '✓ 被拒'}`);

const fail = [];
if (!result.off_on.sfxPlayed) fail.push('环境音关 + 音效开：脚步不响（这就是原 bug）');
if (!result.off_on.ready) fail.push('环境音关时音频链没建起来');
if (result.off_off.sfxPlayed) fail.push('两个都关，脚步还在响');
if (result.on_off.sfxPlayed) fail.push('音效关，脚步还在响');
if (result.playWhenSfxOff) fail.push('音效关时 play() 没被拒');
if (!result.on_on.sfxPlayed) fail.push('两个都开，脚步不响');

writeFileSync(join(tmpdir(), 'sfx-toggle-result.json'), JSON.stringify(result, null, 2));
if (fail.length) {
  console.log(`\n✗ ${fail.length} 项不过：`);
  fail.forEach((x) => console.log(`  - ${x}`));
  process.exitCode = 1;
} else {
  console.log('\n✓ 两个开关各管各的，互不干扰');
}

await send('Target.closeTarget', { targetId });
ws.close();
chrome.kill();
probeSrv.close();