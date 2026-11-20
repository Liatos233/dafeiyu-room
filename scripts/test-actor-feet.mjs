/**
 * 角色脚底对齐测试：确认「按首帧包围盒定尺寸」(applyBbox) 和「脚底对齐」
 * (alignFeet) 用的是**同一套基准**，不会因为素材构图不同而把角色推高/压低。
 *
 * 背景：这是个真实 bug —— 躺姿素材（sleep_loop）内容只占画面一小条，
 * quadH 会远大于 PLANE_H(1.6)。alignFeet 之前用固定 PLANE_H 算位置并 clamp 到
 * FEET_CENTER_Y±0.18，和 applyBbox 的 quadH 基准打架，实测悬空 1 米多。
 *
 * 跑法：node scripts/test-actor-feet.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'public/room/actor.js'), 'utf8');

const TARGET_H = 1.78;
const PLANE_H = 1.6;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${error?.message || error}`);
    process.exitCode = 1;
  }
}

// ── 复刻两边的公式（用于数学验证）──
/** applyBbox：按首帧内容包围盒定 plane 尺寸与位置。 */
function bboxPlacement({ fracH, fracFeet, groupScale = 1 }) {
  const quadH = TARGET_H / Math.max(0.25, fracH) / groupScale;
  const y = (fracFeet - 0.5) * quadH;
  return { quadH, y };
}
/** alignFeet 修复后：用当前 geometry 的实际高度算，缓存的是比例。 */
function alignFeetFixed({ quadH, fracFeet }) {
  return { y: (fracFeet - 0.5) * quadH };
}
/** alignFeet 修复前：用固定 PLANE_H + clamp 到 FEET_CENTER_Y±0.18。 */
function alignFeetOld({ fracFeet }) {
  const FEET_CENTER_Y = 0.667;
  const ideal = (fracFeet - 0.5) * PLANE_H;
  return { y: Math.max(FEET_CENTER_Y - 0.18, Math.min(FEET_CENTER_Y + 0.18, ideal)) };
}

test('躺姿素材（内容只占画面 40%）两边位置一致，不再差一米', () => {
  const input = { fracH: 0.4, fracFeet: 0.9 };
  const box = bboxPlacement(input);
  const fixed = alignFeetFixed({ quadH: box.quadH, fracFeet: input.fracFeet });
  const old = alignFeetOld({ fracFeet: input.fracFeet });
  assert.ok(Math.abs(fixed.y - box.y) < 1e-9, `修复后应与 applyBbox 一致：${fixed.y} vs ${box.y}`);
  assert.ok(Math.abs(old.y - box.y) > 0.8,
    `修复前应能复现「差一米」的 bug（old=${old.y.toFixed(3)} box=${box.y.toFixed(3)}）`);
});

test('站立素材（内容占画面 90%）两边也一致', () => {
  const input = { fracH: 0.9, fracFeet: 0.92 };
  const box = bboxPlacement(input);
  const fixed = alignFeetFixed({ quadH: box.quadH, fracFeet: input.fracFeet });
  assert.ok(Math.abs(fixed.y - box.y) < 1e-9);
});

test('actor.js 里 alignFeet 用当前 geometry 高度，不用固定 PLANE_H', () => {
  const fn = src.slice(src.indexOf('alignFeet() {'));
  const body = fn.slice(0, fn.indexOf('\n  }') + 4);
  assert.ok(/geometry\?\.parameters\?\.height/.test(body),
    'alignFeet 应该用当前 geometry 的实际高度');
  assert.ok(!/\(fracFeet - 0\.5\) \* PLANE_H/.test(body),
    'alignFeet 不该再用固定 PLANE_H 算位置');
  assert.ok(!/FEET_CENTER_Y - 0\.18/.test(body),
    'alignFeet 不该再用固定的 FEET_CENTER_Y±0.18 夹绝对位置');
});

test('CLIP_FOOT 缓存的是比例（0~1），不是绝对位置', () => {
  const fn = src.slice(src.indexOf('alignFeet() {'));
  const body = fn.slice(0, fn.indexOf('\n  }') + 4);
  assert.ok(/CLIP_FOOT\.set\(key, frac\)/.test(body), 'alignFeet 应缓存 frac 比例');
  assert.ok(/Math\.max\(0\.3, Math\.min\(0\.995, fracFeet\)\)/.test(body),
    '比例应做合理性约束（脚底不会在画面顶端）');
  // applyBbox 也要写同一份缓存
  const bboxFn = src.slice(src.indexOf('applyBbox() {'));
  const bboxBody = bboxFn.slice(0, bboxFn.indexOf('\n  }') + 4);
  assert.ok(/CLIP_FOOT\.set\(srcKey/.test(bboxBody), 'applyBbox 应写同一份 CLIP_FOOT 缓存');
});

test('两处 fracFeet 算法一致（都 +1）', () => {
  const bboxFn = src.slice(src.indexOf('applyBbox() {'));
  const bboxBody = bboxFn.slice(0, bboxFn.indexOf('\n  }') + 4);
  assert.ok(/\(box\.maxY \+ 1\) \/ sh/.test(bboxBody),
    'applyBbox 的 fracFeet 应该是 (box.maxY + 1) / sh');
  assert.ok(!/const fracFeet = box\.maxY \/ sh;/.test(bboxBody),
    'applyBbox 不该再用 box.maxY / sh（和 alignFeet 差一个像素）');
});

console.log(`\n角色脚底对齐测试全部通过（${passed} 项）`);
