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
const STAND_FRAC_REF = 0.78;

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
function bboxPlacement({ fracH, fracFeet, isLie = false, groupScale = 1 }) {
  const quadH = isLie
    ? TARGET_H / STAND_FRAC_REF / groupScale
    : TARGET_H / Math.max(0.25, fracH) / groupScale;
  const y = (fracFeet - 0.5) * quadH;
  return { quadH, y };
}
/** alignFeet 修复后：用当前 geometry 的实际高度算，缓存的是比例。 */
function alignFeetFixed({ quadH, fracFeet }) {
  return { y: (fracFeet - 0.5) * quadH };
}

test('躺姿素材不归一化身高：蜷缩的身体不会被放大成站立那么高', () => {
  // 实测素材：idle 角色占画面 78%，sleep_loop 只占 57%
  const stand = bboxPlacement({ fracH: 0.78, fracFeet: 0.93 });
  const lie = bboxPlacement({ fracH: 0.57, fracFeet: 0.892, isLie: true });
  // 同一比例尺：两者 plane 高度相同
  assert.ok(Math.abs(lie.quadH - stand.quadH) < 1e-9,
    `躺姿和站姿应共用同一比例尺（lie=${lie.quadH.toFixed(3)} stand=${stand.quadH.toFixed(3)}）`);
  // 站姿仍是 1.78 米
  assert.ok(Math.abs(stand.quadH * 0.78 - TARGET_H) < 1e-6, '站姿角色应仍是 1.78m');
  // 躺姿按原比例显示，明显比站立矮 —— 这才像蜷着睡，而不是被拉成 1.78m 浮在床上
  const lieHeight = lie.quadH * 0.57;
  assert.ok(lieHeight < 1.45, `躺姿显示高度应低于站立（实际 ${lieHeight.toFixed(2)}m）`);
  // 反例：不区分躺姿（旧行为）会把蜷缩体拉到 1.78m
  const lieWrong = bboxPlacement({ fracH: 0.57, fracFeet: 0.892, isLie: false });
  assert.ok(Math.abs(lieWrong.quadH * 0.57 - TARGET_H) < 1e-6,
    '旧行为会把蜷缩体也拉到 1.78m（这正是悬空感/放大感的来源）');
});

test('躺姿和站姿两边位置一致（同一套脚底对齐）', () => {
  for (const [fracH, fracFeet, isLie] of [[0.4, 0.9, true], [0.9, 0.92, false], [0.57, 0.892, true]]) {
    const box = bboxPlacement({ fracH, fracFeet, isLie });
    const fixed = alignFeetFixed({ quadH: box.quadH, fracFeet });
    assert.ok(Math.abs(fixed.y - box.y) < 1e-9,
      `fracFeet=${fracFeet} isLie=${isLie} 时两边应一致：${fixed.y} vs ${box.y}`);
  }
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
