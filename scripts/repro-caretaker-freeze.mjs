// 用真实的 gardenCaretaker.tick 快进模拟（不真等），复现「下座/行走卡死」。
//
// 为什么这么测：
//   - 只调 advanceHomeState（纯函数）测不出来 —— 它不经过 save→load→normalize。
//   - 打真实 bridge 要真等，一小时也就一小时。
//   tick(now) 的 now 是参数，所以可以把**模拟时间快进**：每 250ms 调一次、
//   循环几千次，等于跑几小时，而真实耗时只有几秒。这条路径与线上完全一致
//   （同一个 caretaker、同一套节流与 normalize）。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGardenCaretaker } from '../src/garden-autonomy.js';
import { currentPosition } from '../src/home-state.js';

if (!process.env.VERBOSE) console.warn = () => {};
const dir = mkdtempSync(join(tmpdir(), 'caretaker-'));
const homeFile = join(dir, 'home.json');
const gardenFile = join(dir, 'garden.json');

const T0 = Date.parse('2026-11-06T13:00:00+08:00');
const STEP = 250;
const HOURS = Number(process.argv[2]) || 6;

const caretaker = createGardenCaretaker({
  homeFile,
  gardenFile,
  getEnv: () => ({}),
});

let t = T0;
const total = Math.round((HOURS * 3600 * 1000) / STEP);
let prev = null;
let run = null;
const runs = [];
const motionHistory = [];

for (let i = 0; i < total; i += 1) {
  t += STEP;
  let out;
  try { out = caretaker.tick(t); } catch (e) { console.error('tick 抛错', e); break; }
  const h = out.state;
  const pos = currentPosition(h, t);
  const m = h.route ? 'walk' : (h.dismounting ? 'dismount' : (h.mounting ? 'mount' : 'still'));
  const rec = {
    t, room: h.room, spot: h.spot, kind: h.kind, pose: h.pose, elev: +Number(h.elev || 0).toFixed(2),
    motion: m, pos: pos.map((v) => +v.toFixed(3)), activity: h.activity,
    hasRoute: !!h.route, hasDis: !!h.dismounting, hasMount: !!h.mounting,
    disT0: h.dismounting ? Math.round(h.dismounting.t0 - T0) : null,
    disFrom: h.dismounting ? h.dismounting.from.map((v) => +v.toFixed(2)) : null,
    disTo: h.dismounting ? h.dismounting.to.map((v) => +v.toFixed(2)) : null,
    disDur: h.dismounting ? h.dismounting.dur : null,
    disUp: h.dismounting ? h.dismounting.up : null,
    dwell: !!h.dwell, cmd: !!h.command,
    departAgo: h.route ? Math.round(t - (Number(h.route.departAt) || 0)) : null,
  };
  motionHistory.push(rec);
  if (motionHistory.length > 8) motionHistory.shift();

  if (prev) {
    const moved = Math.hypot(rec.pos[0] - prev.pos[0], rec.pos[1] - prev.pos[1]);
    const claimed = m !== 'still';
    if (claimed && moved < 0.004) {
      if (!run) run = { startT: t, first: { ...prev }, samples: [], len: 0 };
      run.len += 1;
      if (run.samples.length < 12) run.samples.push({ ...rec });
      run.last = rec;
    } else if (run) { runs.push(run); run = null; }
  }
  prev = rec;
}
if (run) runs.push(run);

const secs = (ms) => +(ms / 1000).toFixed(1);
const bad = runs.filter((r) => secs(r.len * STEP) >= 1.5);
console.log(`模拟 ${HOURS} 小时（${total} tick），检出 ${runs.length} 段静止，其中 >=1.5s 的 ${bad.length} 段\n`);

for (const r of bad.slice(0, 6)) {
  console.log(`■ 卡 ${secs(r.len * STEP)}s  从 ${new Date(r.startT).toISOString().slice(11, 19)}`);
  console.log(`   起始: ${r.first.room}/${r.first.spot} motion=${r.first.motion} pose=${r.first.pose} elev=${r.first.elev} pos=${JSON.stringify(r.first.pos)} 活动=${r.first.activity}`);
  for (const s of r.samples) {
    console.log(
      `     +${secs(s.t - r.startT)}s ${String(s.spot).padEnd(12)} ${String(s.motion).padEnd(8)} ` +
      `pose=${String(s.pose).padEnd(4)} elev=${String(s.elev).padStart(4)} pos=${JSON.stringify(s.pos).padEnd(22)} ` +
      `route=${s.hasRoute ? 'Y' : '.'} dis=${s.hasDis ? 'Y' : '.'} mnt=${s.hasMount ? 'Y' : '.'} ` +
      `dwell=${s.dwell ? 'Y' : '.'} cmd=${s.cmd ? 'Y' : '.'} departAgo=${s.departAgo} ` +
      `disT0=${s.disT0} from=${JSON.stringify(s.disFrom)} to=${JSON.stringify(s.disTo)} dur=${s.disDur} up=${s.disUp}`
    );
  }
  console.log('');
}
if (!bad.length) console.log('未检出 >=1.5s 的卡住');

try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ }
