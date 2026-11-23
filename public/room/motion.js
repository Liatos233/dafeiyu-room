// 运动求值的唯一实现。服务端和客户端 import 同一个文件。
//
// 这个模块存在的理由，是之前「走路一卡一卡 / 动画一闪一闪」的根因：
// 同一个概念（她现在在哪）有过多份实现——
//   服务端 positionOnRoute / seatLerp
//   客户端 pointAtArc / arcLengthAt / walkPredict 锚点
// 每加一个功能就补一份，改一处另外几处就不同步，于是反复出现「路径对但一走就抖」。
//
// 现在的位置是一个**纯函数**：pos = motionAt(motion, now).pos。
// 服务端用它算快照/事件，客户端用它算每帧渲染，两边输入相同、输出必然相同。
//
// 约定：所有函数无副作用、不读全局、不依赖 Date.now()（时间一律由调用方传入）。

/** 每段长度与累计弧长。点集不变时可缓存（调用方自己缓存，本模块不存状态）。 */
export function routeLengths(points) {
  const lens = [];
  const cum = [0];
  for (let i = 1; i < points.length; i += 1) {
    const len = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    lens.push(len);
    cum.push(cum[i - 1] + len);
  }
  return { lens, cum, total: cum[cum.length - 1] || 0 };
}

export function polylineLength(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  return routeLengths(points).total;
}

/** 按**绝对弧长**取点；超出范围就钉在两端。 */
export function pointAtArc(points, s) {
  if (!Array.isArray(points) || points.length < 2) return (points?.[0] || [0, 0]).slice();
  const { lens, cum, total } = routeLengths(points);
  const target = Math.max(0, Math.min(total, Number(s) || 0));
  for (let i = 0; i < lens.length; i += 1) {
    if (target <= cum[i + 1]) {
      const t = lens[i] > 1e-9 ? (target - cum[i]) / lens[i] : 0;
      return [
        points[i][0] + (points[i + 1][0] - points[i][0]) * t,
        points[i][1] + (points[i + 1][1] - points[i][1]) * t
      ];
    }
  }
  return points[points.length - 1].slice();
}

/** 把任意位置投影到折线上，返回它的绝对弧长。 */
export function arcLengthAt(points, pos) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  const { cum } = routeLengths(points);
  let best = { s: 0, d: Infinity };
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len2 = dx * dx + dz * dz;
    const t = len2 > 1e-12
      ? Math.max(0, Math.min(1, ((pos[0] - a[0]) * dx + (pos[1] - a[1]) * dz) / len2))
      : 0;
    const px = a[0] + dx * t;
    const pz = a[1] + dz * t;
    const d = Math.hypot(px - pos[0], pz - pos[1]);
    if (d < best.d) best = { s: cum[i] + Math.sqrt(len2) * t, d };
  }
  return best.s;
}

const smooth = (v) => {
  const c = Math.max(0, Math.min(1, v));
  return c * c * (3 - 2 * c);
};

// 上/下座的两段式插值：
//   上座：先原地抬到座面（0~RISE），再横移进座位（RISE~1）
//   下座：先横移退到座点，再落回地面
// 分两段是为了不让身体斜着穿过坐垫/床沿。
const RISE = 0.55;
function seatAt(seg, now) {
  const dur = Math.max(1, Number(seg.dur) || 1);
  const t = Math.max(0, Math.min(1, (now - seg.t0) / dur));
  const seatY = Number(seg.seatY) || 0;
  // 起点高度：默认 0（从地面升起/落到地面）。
  // 但「从一张家具直接换到另一张」时起点不是地面，传 fromElev 才不会被
  // 瞬间拽到 0 再拉回来（实测床→沙发的第一帧会出现 render=0 而 elev=0.48）。
  const fromY = Number.isFinite(Number(seg.fromElev)) ? Number(seg.fromElev) : 0;
  const up = seg.up !== false;
  const v = smooth(up ? t / RISE : (t - RISE) / (1 - RISE));   // 高度进度
  const h = smooth(up ? (t - RISE) / (1 - RISE) : t / RISE);   // 横向进度
  const from = seg.from || [0, 0];
  const to = seg.to || [0, 0];
  return {
    pos: [from[0] + (to[0] - from[0]) * h, from[1] + (to[1] - from[1]) * h],
    // 高度在 fromY 和 seatY 之间插值（正常情况下 fromY=0，等价于原来的 seatY*v）
    elev: up ? fromY + (seatY - fromY) * v : seatY + (fromY - seatY) * v,
    walking: false,
    done: t >= 1
  };
}

/**
 * 运动求值：给定 motion 描述和时刻，返回此刻的位置/高度/是否在走。
 *
 * motion.kind:
 *   'still'   站着/坐着不动，pos 直接取 spot 落点
 *   'walk'    沿 points 匀速前进；s0 是 t0 时刻的绝对弧长
 *   'mount'   上座（两段式）
 *   'dismount'下座（两段式）
 *
 * @param {object} motion
 * @param {number} now 毫秒时间戳（必须和服务端同一时钟基准）
 * @param {[number,number]} [fallbackPos] 非运动状态下的落点（服务端给 spot.pos）
 * @returns {{pos:[number,number], elev:number, walking:boolean, done:boolean}}
 */
export function motionAt(motion, now, fallbackPos) {
  const m = motion || { kind: 'still' };
  if (m.kind === 'walk' && Array.isArray(m.points) && m.points.length > 1) {
    const speed = Math.max(0.01, Number(m.speed) || 1.05);
    const elapsed = Math.max(0, (now - (Number(m.t0) || 0)) / 1000);
    const s = (Number(m.s0) || 0) + speed * elapsed;
    return { pos: pointAtArc(m.points, s), elev: 0, walking: true, done: false };
  }
  if (m.kind === 'mount' || m.kind === 'dismount') {
    return seatAt(m, now);
  }
  return {
    pos: (fallbackPos || m.pos || [0, 0]).slice(),
    elev: Number(m.elev) || 0,
    walking: false,
    done: true
  };
}

/**
 * 由「当前位置 + 时刻」反推 walk 的锚点（s0）。
 * 客户端拿到快照后需要这个：快照给的可能是「几毫秒前」的位置，
 * 用它和 t0 一起构造 motion，就能继续往前推，而不用每次重设起点（重设会跳格）。
 */
export function walkAnchorAt(points, pos, atMs) {
  return { s0: arcLengthAt(points, pos), t0: atMs };
}
