// Browser-independent checks for outdoor movement prediction and garden facing.
//
// 历史：这个文件原本从 app.js 里切出 `advanceRoute` 的源码、用 vm 跑它，
// 验证"客户端预测拐角"的行为。2026-11-20 的 4862339「位置改用绝对弧长」
// 把 advanceRoute 整个删了（test-project.mjs:192 还专门断言它"应该已删除"），
// 于是这里 indexOf 返回 -1、切片变成空串，vm 里直接 ReferenceError。
// 这个坏法从 11-20 一直留到现在，与音效那次改动无关。
//
// 那部分行为已经由 motion.js + test-motion.mjs 接管（弧长自洽、
// 匀速推进、换锚点不跳格、服务端与客户端一致），不需要在这里重复。
// 本文件只保留仍然有效的第三条：花园里角色朝向工作面的角度。
import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from '../public/room/vendor/three.module.js';
import { ModelActor } from '../public/room/model-actor.js';

const plain = value => JSON.parse(JSON.stringify(value));
// 供下面的断言用（原文件里靠 predict 间接引入）
void plain;

// 拐角预测的等价验证：直接测 motion.js 的纯函数，而不是从 app.js 切源码。
// 保留同名两个断言的意思，但对象换成真正还在用的实现。
import { pointAtArc } from '../public/room/motion.js';
test('弧长取点不会跳过拐角（原 advanceRoute 的职责，现由 pointAtArc 承担）', () => {
  const route = [[0, 0], [10, 0], [10, 10]];
  assert.deepEqual(pointAtArc(route, 8), [8, 0]);
  assert.deepEqual(pointAtArc(route, 12), [10, 2]);
  assert.deepEqual(pointAtArc(route, 10), [10, 0]);
  assert.deepEqual(pointAtArc(route, 16), [10, 6]);
});

test('花园西侧通道到苗圃的折线，转角处不跳段', () => {
  const route = [[-0.65, -3.6], [0.72, -3.6], [0.72, -0.9], [7.4, -0.9]];
  // 各段长度 1.370 / 2.700 / 6.680，累计 0 / 1.370 / 4.070 / 10.750
  // 沿第二条（x=0.72 的竖直段）走 0.4m
  const p = pointAtArc(route, 1.370 + 0.4);
  assert.ok(Math.abs(p[0] - 0.72) < 1e-9, `x 应为 0.72，实际 ${p[0]}`);
  assert.ok(Math.abs(p[1] + 3.2) < 1e-9, `z 应为 -3.2，实际 ${p[1]}`);
  // 走过拐角后应转入第三条线段（向右），而不是继续往上冲
  const next = pointAtArc(route, 4.070 + 0.3);
  assert.ok(Math.abs(next[0] - 1.02) < 1e-9, `x 应为 1.02，实际 ${next[0]}`);
  assert.ok(Math.abs(next[1] + 0.9) < 1e-9, `z 应为 -0.9，实际 ${next[1]}`);
  // 空/单点路线安全回落（pointAtArc 的兜底行为：[0,0]，不是传入的点）
  assert.deepEqual(pointAtArc([], 3), [0, 0]);
  assert.deepEqual(pointAtArc([[5, 6]], 3), [5, 6]);
});

const noop = () => {};
globalThis.document = { createElement(){ const c={width:256,height:256}; const ctx={canvas:c,createRadialGradient:()=>({addColorStop:noop})}; c.getContext=()=>new Proxy(ctx,{get:(t,k)=>k in t?t[k]:noop}); return c; } };
test('3D character faces the work surface rather than the camera for all garden jobs', () => {
  const scene=new THREE.Scene(), actor=new ModelActor(scene), camera=new THREE.PerspectiveCamera();
  actor.ready=true;actor.setVisible(true);camera.position.set(-7,2,8);
  for(const type of ['till','plant','water','fertilize','harvest','sell','buySeed','buyCompost']){
    for(const facing of [0,90,180,270]){
      actor.group.rotation.set(0,0,0);
      actor.setPose({pos:[2,-.9],kind:'garden_'+type,facing,walking:false});
      for(let i=0;i<80;i++)actor.update(.03,camera,{lookAtCamera:true});
      const yaw=actor.group.rotation.y,angle=Math.PI-facing*Math.PI/180;
      assert.ok(Math.abs(Math.sin(yaw)-Math.sin(angle))<1e-6);
      assert.ok(Math.abs(Math.cos(yaw)-Math.cos(angle))<1e-6);
      assert.ok(actor.group.position.toArray().every(Number.isFinite));
    }
  }
  actor.dispose();
});
