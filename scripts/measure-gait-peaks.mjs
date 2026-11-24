#!/usr/bin/env node
// 量 run_hurry 的真实步频：**数峰**，不用自相关。
//
// 为什么要换方法：自相关在这个素材上给出 3,6,9,12,15,... 一串等间距的峰，
// 那是帧间抖动的谐波，肉眼判断会挑到错的那个。数峰更直接 ——
// 一个峰 = 一次落脚的冲击。
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FF = 'C:\\Users\\liato\\.dsh\\drawai-ffmpeg\\win32-x64\\ffmpeg.exe';
const W = 320;
const H = 180;
const SECONDS = Number(process.argv[2]) || 6;

function framesToGray(videoPath, seconds, fps) {
  const out = execFileSync(FF, [
    '-hide_banner', '-loglevel', 'error', '-i', videoPath,
    '-t', String(seconds), '-vf', `scale=${W}:${H}`, '-r', String(fps),
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-',
  ], { maxBuffer: 2048 * 1024 * 1024 });
  const fs = W * H;
  const frames = [];
  for (let i = 0; i + fs <= out.length; i += fs) frames.push(out.subarray(i, i + fs));
  return frames;
}

/** 下半身条带的帧间平均绝对差。 */
function bandMotion(a, b, y0f, y1f) {
  const y0 = Math.floor(H * y0f);
  const y1 = Math.floor(H * y1f);
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = 0; x < W; x += 1) {
      sum += Math.abs(a[y * W + x] - b[y * W + x]);
      n += 1;
    }
  }
  return n ? sum / n : 0;
}

/** 找显著局部极大：比左右邻域高，且突出度超过阈值。 */
function findPeaks(sig, minProminence) {
  const peaks = [];
  for (let i = 2; i < sig.length - 2; i += 1) {
    const v = sig[i];
    if (v <= sig[i - 1] || v <= sig[i + 1]) continue;
    // 突出度 = 峰高 - 两侧最近谷底的较高者
    let leftMin = Infinity, rightMin = Infinity;
    for (let j = i - 1; j >= Math.max(0, i - 6); j -= 1) leftMin = Math.min(leftMin, sig[j]);
    for (let j = i + 1; j <= Math.min(sig.length - 1, i + 6); j += 1) rightMin = Math.min(rightMin, sig[j]);
    const prom = v - Math.max(leftMin, rightMin);
    if (prom >= minProminence) peaks.push({ i, v, prom });
  }
  // 合并太近的峰（<3 帧）取最高的
  const merged = [];
  for (const p of peaks) {
    const last = merged[merged.length - 1];
    if (last && p.i - last.i < 3) {
      if (p.v > last.v) merged[merged.length - 1] = p;
    } else merged.push(p);
  }
  return merged;
}

const videos = [
  ['run_hurry', 'public/room/assets/pet-import/侧身急躁跑.webm'],
  ['run_happy', 'public/room/assets/pet/run_happy.webm'],
  ['walk', 'public/room/assets/pet/walk.webm'],
];

const FPS = 24;
const out = {};

for (const [name, rel] of videos) {
  const p = join(process.cwd(), rel);
  let frames;
  try { frames = framesToGray(p, SECONDS, FPS); } catch { console.log(`${name}: 读不了`); continue; }

  // 试两个条带，看哪个更稳
  const bands = [[0.62, 0.99], [0.50, 0.99]];
  console.log(`\n=== ${name} ===`);
  for (const [y0f, y1f] of bands) {
    const sig = [];
    for (let i = 1; i < frames.length; i += 1) sig.push(bandMotion(frames[i - 1], frames[i], y0f, y1f));
    const mean = sig.reduce((a, b) => a + b, 0) / sig.length;
    const peaks = findPeaks(sig, mean * 0.25);
    const dur = (sig.length) / FPS;
    const rate = peaks.length / dur;
    const intervals = [];
    for (let i = 1; i < peaks.length; i += 1) intervals.push(peaks[i].i - peaks[i - 1].i);
    const avgInt = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0;

    console.log(
      `  条带 ${(y0f * 100).toFixed(0)}-${(y1f * 100).toFixed(0)}%: ` +
      `${peaks.length} 个峰 / ${dur.toFixed(1)}s = ${rate.toFixed(2)} 次/秒  ` +
      `平均间隔 ${avgInt.toFixed(1)} 帧 (${(avgInt / FPS).toFixed(3)}s)  ` +
      `间隔序列 [${intervals.slice(0, 14).join(',')}]`
    );

    if (y0f === 0.62) {
      out[name] = {
        peaks: peaks.length,
        seconds: +dur.toFixed(2),
        peaksPerSec: +rate.toFixed(2),
        avgIntervalFrames: +avgInt.toFixed(1),
        avgIntervalSec: +(avgInt / FPS).toFixed(3),
        intervals: intervals.slice(0, 20),
      };
    }
  }
}

const SPEED = { walk: 1.05, run: 1.45 };
console.log('\n=== 换算步幅 ===');
for (const [name, r] of Object.entries(out)) {
  const speed = name.startsWith('run') ? SPEED.run : SPEED.walk;
  // 峰 = 一次落脚 → 步幅 = 速度 / (次/秒)
  const stride = speed / r.peaksPerSec;
  r.serverSpeed = speed;
  r.strideMeters = +stride.toFixed(3);
  console.log(
    `  ${name.padEnd(10)} ${speed} m/s ÷ ${r.peaksPerSec} 次/秒 = 步幅 ${stride.toFixed(2)} m  ` +
    `（即每 ${r.avgIntervalSec}s 响一次）`
  );
}

writeFileSync(join(process.env.TEMP || '.', 'gait-peaks.json'), JSON.stringify(out, null, 2), 'utf8');
console.log('\n写入 gait-peaks.json');