#!/usr/bin/env node
// 把 CC0 原始素材规整成 room 用的动作音效：单声道 44.1k ogg，统一 RMS 响度。
//
// 只在**准备素材**时跑一次，产物（app/public/room/assets/sound/sfx/*.ogg）提交进仓库。
// 运行时不依赖本脚本，也不依赖 ffmpeg。
//
// 用法：
//   node scripts/build-sfx.mjs                 用默认 ffmpeg 路径
//   FFMPEG_BIN=/path/to/ffmpeg node scripts/build-sfx.mjs
//   node scripts/build-sfx.mjs --check         只报告当前产物电平，不重新生成
//
// 原始素材不放仓库（体积大、来源在 SOUND-CREDITS.md），按下面 SOURCES 里的
// 地址自己下到 --src 目录。
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DST = join(ROOT, 'public', 'room', 'assets', 'sound', 'sfx');

const argv = process.argv.slice(2);
const CHECK_ONLY = argv.includes('--check');
const argVal = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

/** 原始素材在哪（不提交进仓库；下载地址见 assets/sound/sfx/SOUND-CREDITS.md）。 */
const SRC = argVal('--src', join(ROOT, '..', '_tmp', 'sfx-src'));
const FF = process.env.FFMPEG_BIN || 'ffmpeg';

const TARGET_RMS = -20;   // 目标 RMS（听觉响度）dBFS
/**
 * 水声单独给低一点的目标。
 *
 * 溅水是瞬态音：能量全集中在开头几十毫秒，原始峰值就贴着 0dBFS。
 * 硬推到 -20 会被限制器压平，出来是"啪"的一下削波失真，听感比响度不齐更糟。
 * 低 1.5dB 换干净的音头。
 */
const WATER_TARGET_RMS = -21.5;
const LIMIT = 0.85;       // 限制器上限，约 -1.4dBFS，留余量防爆音

/** 源文件 → 产物。`trim` 是保留长度（秒），按动作的实际时长裁。 */
const JOBS = [
  // 游泳：4 个划水声（rubberduck 的 CC0 溅水包）
  ...['09', '10', '06', '15'].map((n, i) => ({
    in: join(SRC, 'water', `splash_${n}.ogg`),
    out: `swim-${i + 1}.ogg`, trim: 0.45, kind: 'swim', label: '划水',
  })),
  // 入水：一次较大的溅水
  { in: join(SRC, 'water', 'splash_01.ogg'), out: 'splash-enter.ogg', trim: 0.90, kind: 'splash', label: '入水' },
];

function ff(args) {
  // 参数走数组、不经 shell：避免引号与转义（PowerShell 版在这里踩过三次坑）
  const r = spawnSync(FF, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`跑不起 ffmpeg（${FF}）：${r.error.message}`);
  return { code: r.status, text: `${r.stdout || ''}\n${r.stderr || ''}` };
}

function probe(p) {
  const r = ff(['-hide_banner', '-i', p, '-af', 'volumedetect', '-f', 'null', 'NUL']);
  const mean = /mean_volume:\s*(-?[\d.]+)/.exec(r.text);
  const max = /max_volume:\s*(-?[\d.]+)/.exec(r.text);
  const dur = /Duration:\s*(\d+):(\d+):(\d+\.\d+)/.exec(r.text);
  if (!mean || !max) return null;
  return {
    mean: +mean[1],
    max: +max[1],
    dur: dur ? (+dur[1] * 3600 + +dur[2] * 60 + +dur[3]) : 0,
  };
}

/**
 * 迭代把输出响度压到目标。
 *
 * 一步算完会失真：水声原始峰值已在 0dBFS 附近，按 RMS 加 +9.6dB 后会被限制器
 * 硬压回去，实际 RMS 反而低 4dB。所以先给一版、测实际结果、把差值补回去。
 */
function renderOne(job, outPath) {
  const src = probe(job.in);
  if (!src) return { error: '读不出源电平' };
  const target = job.kind === 'step' ? TARGET_RMS : WATER_TARGET_RMS;
  let gain = target - src.mean;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const fade = Math.max(0, job.trim - 0.02).toFixed(3);
    const af = [
      `atrim=0:${job.trim}`,
      `volume=${gain.toFixed(1)}dB`,
      `alimiter=limit=${LIMIT}:level=0`,
      `afade=t=out:st=${fade}:d=0.02`,
    ].join(',');

    const r = ff(['-hide_banner', '-loglevel', 'error', '-y', '-i', job.in,
      '-af', af, '-ac', '1', '-ar', '44100', '-c:a', 'libvorbis', '-q:a', '5', outPath]);
    if (r.code !== 0) return { error: `ffmpeg ${r.code}: ${r.text.slice(-300)}` };

    const got = probe(outPath);
    if (!got) return { error: '读不出输出电平' };
    const err = target - got.mean;
    if (Math.abs(err) < 0.5) return { gain, result: got, target };
    gain += err;
  }
  return { gain, result: probe(outPath), target };
}

mkdirSync(DST, { recursive: true });

if (CHECK_ONLY) {
  // 只体检现有产物：确认没有哪个文件被漏掉电平、或响度跑偏
  const bad = [];
  for (const job of JOBS) {
    const p = join(DST, job.out);
    if (!existsSync(p)) { bad.push(`${job.out} 缺失`); continue; }
    const got = probe(p);
    if (!got) { bad.push(`${job.out} 读不出电平`); continue; }
    const target = job.kind === 'step' ? TARGET_RMS : WATER_TARGET_RMS;
    const off = got.mean - target;
    const flag = Math.abs(off) > 1.5 ? '  ⚠响度偏' : '';
    console.log(`${job.out.padEnd(18)} ${job.label}  rms=${got.mean.toFixed(1)}dB (目标 ${target}) peak=${got.max.toFixed(1)}dB${flag}`);
    if (Math.abs(off) > 1.5) bad.push(`${job.out} 响度偏 ${off.toFixed(1)}dB`);
  }
  if (bad.length) { console.log(`\n${bad.length} 项有问题：`); bad.forEach((b) => console.log(`  ${b}`)); process.exitCode = 1; }
  else console.log('\n全部正常');
} else {
  const manifest = [];
  for (const job of JOBS) {
    if (!existsSync(job.in)) { console.log(`SKIP 缺源文件 ${job.in}`); continue; }
    const { error, gain, result, target } = renderOne(job, join(DST, job.out));
    if (error) { console.log(`FAIL ${job.out} — ${error}`); continue; }

    const bytes = statSync(join(DST, job.out)).size;
    manifest.push({
      file: `assets/sound/sfx/${job.out}`,
      kind: job.kind,
      label: job.label,
      seconds: +result.dur.toFixed(2),
      rmsDb: +result.mean.toFixed(1),
      targetRmsDb: target,
      peakDb: +result.max.toFixed(1),
      bytes,
    });
    console.log(
      `${job.out.padEnd(18)} ${job.label.padEnd(5)} gain=${gain.toFixed(1).padStart(6)}dB` +
      `  dur=${result.dur.toFixed(2)}s  rms=${result.mean.toFixed(1)}dB  peak=${result.max.toFixed(1)}dB  ${(bytes / 1024).toFixed(1)}KB`
    );
  }

  writeFileSync(join(DST, 'built-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const rms = manifest.map((m) => m.rmsDb);
  console.log(`\n${manifest.length} 个文件写入 ${DST}`);
  if (rms.length) {
    console.log(`RMS 范围 ${Math.min(...rms).toFixed(1)} … ${Math.max(...rms).toFixed(1)} dB（极差 ${(Math.max(...rms) - Math.min(...rms)).toFixed(1)} dB）`);
    console.log(`总体积 ${(manifest.reduce((s, m) => s + m.bytes, 0) / 1024).toFixed(1)} KB`);
  }
}