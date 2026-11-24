#!/usr/bin/env node
// 量步频：只测**下半身条带**的运动能量。
//
// 前面几次失败的原因各不相同，记下来免得重走：
//   ① 脚最低点 → 贴底不动，1px
//   ② 全帧帧差 → 混进头发/光环，walk 比 run 还快（明显错）
//   ③ 鞋水平重心 → 腿被裙子挡住，0.3px 噪声
//   ④ 头顶起伏 → walk 测到的是整体缓慢漂移（32→41 一次跳变），不是步频
//
// 这次限定在"裙子到脚"这一条横带内算帧间差 —— 那里只有腿和裙摆，
// 是真正跟步频同步运动的部分。同时打印自相关全表，用数据判断。
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FF = 'C:\\Users\\liato\\.dsh\\drawai-ffmpeg\\win32-x64\\ffmpeg.exe';
const FPS = 24;
const W = 320;
const H = 180;
// 下半身条带（按 180 高度归一）：裙摆到底部一点
const BAND = [0.62, 0.99];

function framesToGray(videoPath, seconds) {
  const out = execFileSync(FF, [
    '-hide_banner', '-loglevel', 'error', '-i', videoPath,
    '-t', String(seconds), '-vf', `scale=${W}:${H}`, '-r', String(FPS),
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
  ], { maxBuffer: 1024 * 1024 * 1024 });
  const fs = W * H;
  const frames = [];
  for (let i = 0; i + fs <= out.length; i += fs) frames.push(out.subarray(i, i + fs));
  return frames;
}

function bandMotion(a, b) {
  const y0 = Math.floor(H * BAND[0]);
  const y1 = Math.floor(H * BAND[1]);
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = 0; x < W; x += 1) {
      sum += Math.abs(a[y * W + x] - b[y * W + x]);
      n += 1;
    }
  }
  return n ? sum / n : 0;
}

const videos = [
  ['walk', 'public/room/assets/pet/walk.webm'],
  ['run_happy', 'public/room/assets/pet/run_happy.webm'],
  ['run_hurry', 'public/room/assets/pet-import/侧身急躁跑.webm'],
];
const seconds = Number(process.argv[2]) || 4;
const result = {};

for (const [name, rel] of videos) {
  const p = join(process.cwd(), rel);
  let frames;
  try { frames = framesToGray(p, seconds); } catch { console.log(`${name}: 读不了`); continue; }

  const sig = [];
  for (let i = 1; i < frames.length; i += 1) sig.push(bandMotion(frames[i - 1], frames[i]));

  console.log(`\n=== ${name}（下半身运动量，${sig.length} 点）===`);
  // ASCII：运动量随时间
  const min = Math.min(...sig), max = Math.max(...sig);
  const rows = 8;
  for (let r = 0; r < rows; r += 1) {
    const level = max - (r * (max - min)) / (rows - 1);
    let line = '';
    for (let i = 0; i < sig.length; i += 1) {
      line += Math.abs(sig[i] - level) <= (max - min) / (rows * 2) + 0.02 ? '█' : ' ';
    }
    console.log(`  ${level.toFixed(1).padStart(5)} |${line}`);
  }

  // 自相关
  const n = sig.length;
  const mean = sig.reduce((a, b) => a + b, 0) / n;
  const x = sig.map((v) => v - mean);
  const corr = [];
  for (let lag = 2; lag <= Math.min(48, n - 3); lag += 1) {
    let s = 0;
    for (let i = 0; i + lag < n; i += 1) s += x[i] * x[i + lag];
    corr.push({ lag, v: s / (n - lag) });
  }
  const maxAbs = Math.max(...corr.map((c) => Math.abs(c.v))) || 1;
  const norm = corr.map((c) => ({ lag: c.lag, v: c.v / maxAbs }));
  // 找所有局部峰（>=0.4）。短 lag 的峰是帧间抖动，要用全部候选来判读。
  const found = [];
  for (let i = 1; i < norm.length - 1; i += 1) {
    if (norm[i].v >= 0.4 && norm[i].v >= norm[i - 1].v && norm[i].v >= norm[i + 1].v) found.push(norm[i]);
  }
  console.log('  lag相关: ' + norm.map((c) => `${c.lag}:${c.v.toFixed(2)}`).join(' '));
  if (!found.length) { console.log('  没有 >=0.4 的峰'); continue; }

  // 一个**步态周期**（左右各一步）对应自相关最强的那个峰。
  //
  // 注意别被短 lag 骗了：lag 2~4 的相关值也很高（相邻帧本来就相似），
  // 那是帧间抖动，不是步频。真正的周期要看**相关回到最高点的那个 lag**。
  // 实测三个动画都在 lag 12（=0.5s @24fps）取得最强或次强峰，
  // 且 lag 12 处正好是 lag 24 的一半（周期的一半），互相自洽。
  const primary0 = found[0];
  // **别用 found[0]**：短 lag（2~4）的相关天然很高（相邻帧本来就相似），
  // 那是帧间抖动而不是步频。真正的步态周期要满足两个条件：
  //   ① 该 lag 的相关值接近最强（>=0.85）
  //   ② 它的 2 倍 lag 处也有一个强峰（自洽：半个周期/一个周期交替出现）
  // 实测三个动画都满足 ①+② 的是 lag 12（24fps → 0.5s 一个左右各一步的周期）。
  const strong = found.filter((f) => f.v >= 0.85);
  let primary = null;
  for (const cand of strong) {
    const half = found.find((f) => f.lag === cand.lag * 2);
    // 半周期的相关应该**为负**（相位相反）才算真周期；
    // 若 2 倍处仍强正相关，说明 cand 是半个周期
    if (!half || half.v < 0) { primary = cand; break; }
  }
  if (!primary) primary = strong[0] || found[0];
  const cycleFrames = primary.lag;
  const cycleSec = cycleFrames / FPS;
  const secPerStep = cycleSec / 2;      // 一个周期左右各一步
  const stepsPerSec = 1 / secPerStep;

  result[name] = {
    frames: frames.length,
    cycleFrames,
    cycleSeconds: +cycleSec.toFixed(3),
    secPerStep: +secPerStep.toFixed(3),
    stepsPerSec: +stepsPerSec.toFixed(2),
    strength: +primary.v.toFixed(2),
    motionRange: [+min.toFixed(1), +max.toFixed(1)],
    candidates: found.map((f) => `${f.lag}(${f.v})`).join(' '),
  };
  console.log(
    `${name.padEnd(10)} 步态周期 ${String(cycleFrames).padStart(2)} 帧 (${cycleSec.toFixed(2)}s)  ` +
    `→ ${secPerStep.toFixed(3)}s/步 = ${stepsPerSec.toFixed(2)} 步/秒  [峰: ${found.map((f) => f.lag).join(',')}]`
  );
}

console.log('\n=== 与服务端速度换算（声音该多久响一次）===');
const SPEED = { walk: 1.05, run: 1.45 };
for (const [name, r] of Object.entries(result)) {
  const speed = name.startsWith('run') ? SPEED.run : SPEED.walk;
  const stride = speed * r.secPerStep;
  r.serverSpeed = speed;
  r.strideMeters = +stride.toFixed(3);
  console.log(`  ${name.padEnd(10)} ${speed}m/s ÷ ${r.stepsPerSec}步/s = 每步 ${stride.toFixed(2)}m`);
}

writeFileSync(join(process.env.TEMP || '.', 'anim-gait.json'), JSON.stringify(result, null, 2), 'utf8');