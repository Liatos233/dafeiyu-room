#!/usr/bin/env node
// 量步频：跟踪**裙子/脚部区域的最低点纵向位置**。
//
// 为什么之前都失败（记下来免得再绕）：
//   ① 自相关 → 这个素材的自相关是一串等间距谐波（3,6,9,12...），挑不准
//   ② 数峰   → 间隔恒为 3 帧，那是视频压缩噪声，不是落脚
//   ③ 鞋水平重心 → 侧身跑的腿被裙子挡了大半，横移不足 1px
//
// 侧身跑的步态特征其实很明确：**裙摆/身体每迈一步就上下起伏一次**，
// 这是画面里幅度最大的运动。取"非背景像素的最低行"作为下摆位置，
// 它的上下往复就是步频。
//
// 为了抗噪，先把整个立绘做归一化：只统计"每列最下面的非背景像素"，
// 取它们的众数/中位数，比逐帧取全局最低更稳。
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FF = 'C:\\Users\\liato\\.dsh\\drawai-ffmpeg\\win32-x64\\ffmpeg.exe';
const W = 480;
const H = 270;
const FPS = 24;
const SECONDS = Number(process.argv[2]) || 6;

function framesToGray(videoPath, seconds) {
  const out = execFileSync(FF, [
    '-hide_banner', '-loglevel', 'error', '-i', videoPath,
    '-t', String(seconds), '-vf', `scale=${W}:${H}`, '-r', String(FPS),
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
  ], { maxBuffer: 2048 * 1024 * 1024 });
  const fs = W * H;
  const frames = [];
  for (let i = 0; i + fs <= out.length; i += fs) frames.push(out.subarray(i, i + fs));
  return frames;
}

/** 每列最下面的非背景像素行；对全部列取中位数作为"下摆高度"。 */
function hemY(frame) {
  const bg = frame[0];
  const isBg = (v) => Math.abs(v - bg) < 30;
  const bottoms = [];
  for (let x = 0; x < W; x += 1) {
    let b = -1;
    for (let y = H - 1; y >= Math.floor(H * 0.4); y -= 1) {
      if (!isBg(frame[y * W + x])) { b = y; break; }
    }
    if (b >= 0) bottoms.push(b);
  }
  if (bottoms.length < W * 0.2) return -1;
  bottoms.sort((a, b) => a - b);
  // 用 80 分位（偏下的那部分），比中位数更能代表"下摆的最低处"
  return bottoms[Math.floor(bottoms.length * 0.8)];
}

/** 自相关 + 局部峰。 */
function analyze(sig) {
  const n = sig.length;
  const mean = sig.reduce((a, b) => a + b, 0) / n;
  const x = sig.map((v) => v - mean);
  const corr = [];
  for (let lag = 2; lag <= Math.min(60, n - 3); lag += 1) {
    let s = 0;
    for (let i = 0; i + lag < n; i += 1) s += x[i] * x[i + lag];
    corr.push({ lag, v: s / (n - lag) });
  }
  const maxAbs = Math.max(...corr.map((c) => Math.abs(c.v))) || 1;
  const norm = corr.map((c) => ({ lag: c.lag, v: c.v / maxAbs }));
  const peaks = [];
  for (let i = 1; i < norm.length - 1; i += 1) {
    if (norm[i].v >= 0.3 && norm[i].v >= norm[i - 1].v && norm[i].v >= norm[i + 1].v) peaks.push(norm[i]);
  }
  return { norm, peaks };
}

const videos = [
  ['run_hurry', 'public/room/assets/pet-import/侧身急躁跑.webm'],
  ['run_happy', 'public/room/assets/pet/run_happy.webm'],
  ['walk', 'public/room/assets/pet/walk.webm'],
];

const result = {};
for (const [name, rel] of videos) {
  const p = join(process.cwd(), rel);
  let frames;
  try { frames = framesToGray(p, SECONDS); } catch { console.log(`${name}: 读不了`); continue; }
  const hem = frames.map(hemY);
  const valid = hem.filter((v) => v >= 0);
  if (valid.length < frames.length * 0.7) { console.log(`${name}: 下摆检测不稳`); continue; }
  const med = valid.sort((a, b) => a - b)[Math.floor(valid.length / 2)];
  const sig = hem.map((v) => (v >= 0 ? v : med));

  console.log(`\n=== ${name} ===`);
  // ASCII 显示波形（起伏一眼可见）
  const min = Math.min(...sig), max = Math.max(...sig);
  const rows = 7;
  for (let r = 0; r < rows; r += 1) {
    const level = max - (r * (max - min)) / (rows - 1);
    let line = '';
    for (const v of sig) line += Math.abs(v - level) <= (max - min) / (rows * 2) + 0.6 ? '█' : ' ';
  }
  console.log(`  下摆 y 范围 ${min}..${max}（${max - min}px 起伏）`);

  const { norm, peaks } = analyze(sig);
  console.log('  lag相关: ' + norm.slice(0, 32).map((c) => `${c.lag}:${c.v.toFixed(2)}`).join(' '));
  if (!peaks.length) { console.log('  无峰'); continue; }

  // 挑真正的主周期：相关最强，且不是最短的几个（避开帧间抖动）
  const sorted = [...peaks].sort((a, b) => b.v - a.v);
  const best = sorted.find((p) => p.lag >= 6) || sorted[0];
  const cycleFrames = best.lag;
  const cycleSec = cycleFrames / FPS;
  const secPerStep = cycleSec / 2;
  const stepsPerSec = 1 / secPerStep;

  result[name] = {
    hemRange: [min, max],
    swingPx: max - min,
    cycleFrames,
    cycleSeconds: +cycleSec.toFixed(3),
    secPerStep: +secPerStep.toFixed(3),
    stepsPerSec: +stepsPerSec.toFixed(2),
    strength: +best.v.toFixed(2),
    allPeaks: peaks.map((p) => `${p.lag}(${p.v.toFixed(2)})`).join(' '),
  };
  console.log(
    `  → 主周期 ${cycleFrames} 帧 = ${cycleSec.toFixed(2)}s（左右各一步）` +
    ` → ${secPerStep.toFixed(3)}s/步 = ${stepsPerSec.toFixed(2)} 步/秒（相关 ${best.v.toFixed(2)}）`
  );
}

const SPEED = { walk: 1.05, run: 1.45 };
console.log('\n=== 换算步幅 ===');
for (const [name, r] of Object.entries(result)) {
  const speed = name.startsWith('run') ? SPEED.run : SPEED.walk;
  const stride = speed * r.secPerStep;
  r.serverSpeed = speed;
  r.strideMeters = +stride.toFixed(3);
  console.log(`  ${name.padEnd(10)} ${speed} m/s × ${r.secPerStep}s/步 = 步幅 ${stride.toFixed(2)} m`);
}

writeFileSync(join(process.env.TEMP || '.', 'gait-hem.json'), JSON.stringify(result, null, 2), 'utf8');
console.log('\n写入 gait-hem.json');