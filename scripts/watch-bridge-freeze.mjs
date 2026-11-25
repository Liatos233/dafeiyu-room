// 打真实 bridge，长时间**不干预**，只观察。
// 目标：让 autonomoy（freestyle / 需求 / 菜园）自己驱动她走动，
// 自动检出「声明在走但位置不动」的时段并打印当时的完整状态。
const BASE = process.env.BRIDGE || 'http://127.0.0.1:3100';
const MINUTES = Number(process.argv[2]) || 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getState() {
  const r = await fetch(`${BASE}/api/home/state`, { headers: { 'cache-control': 'no-store' } });
  if (!r.ok) throw new Error(`GET ${r.status}`);
  return r.json();
}

const t0 = Date.now();
let prev = null;
let run = null;
const runs = [];

while (Date.now() - t0 < MINUTES * 60_000) {
  let v;
  try { v = await getState(); } catch (e) { console.error('poll 失败:', e.message); await sleep(500); continue; }
  const h = v.her || {};
  const m = h.motion || {};
  const pos = Array.isArray(h.pos) ? h.pos : null;
  const claimed = m.kind === 'walk' || m.kind === 'dismount' || m.kind === 'mount' || h.walking === true;
  const rec = {
    at: Date.now(),
    room: h.room, spot: h.spot, kind: h.kind,
    walking: h.walking === true,
    motion: m.kind || 'still',
    pts: m.points ? m.points.length : 0,
    departAgo: m.t0 ? Math.round(v.now - m.t0) : null,
    pos,
    activity: h.activity,
  };
  if (prev && pos) {
    const moved = Math.hypot(pos[0] - prev.pos[0], pos[1] - prev.pos[1]);
    const still = moved < 0.004;
    if (claimed && still) {
      if (!run) run = { from: rec.at, ...rec, samples: 0 };
      run.samples += 1;
      run.last = rec;
    } else if (run) { runs.push(run); run = null; }
  }
  prev = rec;
  await sleep(200);
}
if (run) runs.push(run);

const secs = (ms) => (ms / 1000).toFixed(1);
const bad = runs.filter((r) => r.samples * 0.2 >= 1.5);
console.log(`观察 ${MINUTES} 分钟，检出 ${runs.length} 段静止，其中 >=1.5s 的 ${bad.length} 段`);
for (const r of bad) {
  console.log(
    `  卡 ${(r.samples * 0.2).toFixed(1)}s  ${r.room}/${r.spot} kind=${r.kind} motion=${r.motion}` +
    ` walking=${r.walking} pts=${r.pts} departAgo=${r.departAgo}ms pos=${r.last.pos}  活动=${r.activity}`
  );
}
if (!bad.length) console.log('  未检出长时间静止');
