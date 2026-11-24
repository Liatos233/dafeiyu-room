// 动作音效：她做了什么，就出什么声。
//
// 和 ambience.js 分工 —— ambience 是**背景床**（天气、房间嗡鸣，一直在响），
// 这里是**事件音**（走一步、入水，短、一次性）。两者共用 ambience 的音量树，
// 但走不同的总线：这个模块接 sfxBus，绕开室内的 1200Hz 低通。
// 原因见 ambience.js 的 `applyLevels()`：室内会把整棵树低通到 1200Hz，
// 那是给风雨声"进屋"用的；脚步声要是也滤到这个程度就闷成敲纸盒了。
//
// 拓展方式（这是设计目标，别破坏它）：
//   在 EVENTS 里加一条 { name: { file|synth, gain, cooldown, variants } }，
//   素材丢进 assets/sound/sfx/，代码一行不用改。
//   要加新事件只动这张表；要加新素材只动这张表 + 一个文件。

const DIR = 'assets/sound/sfx/';

/** 文件型音效：多取几个变体，同一个动作连着响才不像复读机。 */
const FILES = {
  swim: [1, 2, 3, 4].map((i) => `${DIR}swim-${i}.ogg`),
  splashEnter: [`${DIR}splash-enter.ogg`]
};

/**
 * 事件表。键是事件名，值是：
 *   file     素材（数组 = 变体池，随机取一个；字符串 = 单个）
 *   synth    合成器（见 SYNTHS）
 *   gain     这条音效的基准增益（0–1），再乘总音量
 *   cooldown 两次触发的最小间隔（毫秒），防连发糊成一片
 *   jitter   音高随机浮动比例，进一步打散重复感（如 0.06 = ±6%）
 *   panScale 这一条受声像影响的程度，1 = 全受
 *
 * 一条事件可以**同时**有 file 和 synth：素材优先，解码失败或还没下载好
 * 就退到合成器。这样不会出现"素材挂了一个文件就彻底没声音"。
 */
const EVENTS = {
  // ── 已接入：走 / 跑 / 游泳 ───────────────────────────────
  // 脚步用**合成**而不是采样：合成天然没有复读感（每步都有随机 detune 和
  // 左右脚交替），也不用背 91KB 的素材和它的许可证记录。
  // Coopanion 的做法证明这套在桌宠上够用；这里按木地板/瓷砖的体量加了低频，
  // 参数见 SYNTHS.step 和 SURFACES。
  step: { synth: 'step', gain: 0.55, cooldown: 70, panScale: 1 },
  // 跑步：音高在合成器里已经抬到 550（Coopanion 的 ×1.25），
  // 这里再给一点增益，让它比走更"跳"。
  run: { synth: 'step', gain: 0.62, cooldown: 60, panScale: 1 },
  swim: { file: FILES.swim, gain: 0.34, cooldown: 260, jitter: 0.07, panScale: 1 },
  splashEnter: { file: FILES.splashEnter, gain: 0.42, cooldown: 900, panScale: 1 },
  splashExit: { synth: 'splash', gain: 0.26, cooldown: 900, panScale: 1 },

  // ── 预留：素材到位、或要加挂点时才用得上 ─────────────────
  // 这些现在没有触发点，写在这里是把"事件名"先定下来，
  // 免得将来各写一套命名。没有 file/synth 的条目 play() 会静默跳过。
  doorOpen: { gain: 0.4, cooldown: 300 },
  doorClose: { gain: 0.4, cooldown: 300 },
  sitDown: { synth: 'thud', gain: 0.3, cooldown: 400, jitter: 0.04 },
  standUp: { synth: 'thud', gain: 0.22, cooldown: 400, jitter: 0.04, rate: 1.1 },
  // UI 类：纯合成，永远不需要素材
  uiClick: { synth: 'click', gain: 0.25, cooldown: 40 },
  uiPop: { synth: 'pop', gain: 0.22, cooldown: 60 }
};

// ── 合成兜底 ──────────────────────────────────────────────────
// 有素材时优先用素材；这些只在素材缺失/解码失败时接管，
// 以及给纯合成音效（UI）用。参数按"听起来像什么"调，不是按物理。

/**
 * 每种地面的一组参数。同一个脚步声换地面就换这三样，其余不动：
 *   thump    撞击音高的整体缩放（瓷砖比木头脆、地毯比木头闷）
 *   body     地面共鸣的中频位置 —— 决定"这块地是木头的还是瓷砖的"
 *   scuff    鞋底摩擦的噪声中心频率与音量
 */
const SURFACES = {
  wood: { thump: 1.00, body: 320, bodyVol: 0.07, bodyDur: 0.045, scuff: 3200, scuffVol: 0.16 },
  tile: { thump: 1.06, body: 460, bodyVol: 0.05, bodyDur: 0.032, scuff: 4200, scuffVol: 0.22 },
  carpet: { thump: 0.94, body: 240, bodyVol: 0.03, bodyDur: 0.032, scuff: 2100, scuffVol: 0.10 },
  stone: { thump: 1.04, body: 420, bodyVol: 0.06, bodyDur: 0.038, scuff: 3800, scuffVol: 0.19 },
  grass: { thump: 0.90, body: 220, bodyVol: 0.025, bodyDur: 0.040, scuff: 1700, scuffVol: 0.24 }
};

const SYNTHS = {
  /**
   * 脚步。**结构照 Coopanion 的 `step(run, i)`，并且刻意贴近它的音色取向。**
   *
   * 它的做法（web/sound.js）：
   *   tone({ f0: 440|520, f1: 330|380, dur: .06, vol: .05 })
   *   跑步时 rate ×1.25，再加一层 2500Hz 的高通噪声当摩擦
   * 关键点：
   *   ① 基音在 **440–520Hz**，很高 —— 这是"嗒"而不是"咚"，轻快的来源
   *   ② 音高**向下滑**（440→330），60ms 就结束，非常短促
   *   ③ **两只脚用不同基音**（440 与 520 交替），连续两步不完全相同
   *   ④ 音量只有 .05，很轻
   *
   * 我上一版加了 105→45Hz 的"脚跟低频"和 210Hz 的"地面共鸣"，
   * 出发点是想让木地板有体重感 —— 结果就是把那个轻快感压没了，
   * 听起来闷、响、像穿靴子。那一版作废。
   *
   * 现在：**基音回到 Coopanion 的高度**，只保留极轻的一层地面色，
   * 用来区分木地板/瓷砖/地毯（否则换地面完全听不出差别）。
   * 低频只在其 1/3 音量上做一点点"落地的实感"，不做主角。
   */
  step(ctx, dest, { at = 0, rate = 1, running = false, surface = 'wood', foot = 0, gainMul = 1 } = {}) {
    const s = SURFACES[surface] || SURFACES.wood;
    // 两只脚不同基音：Coopanion 用 440/520（差 18%）。
    // 这里取 440/500（差 14%）—— 18% 已经接近一个音阶，连听两步像音高错乱。
    const side = foot ? 1.136 : 1;
    // ±2% 随机，避免机械重复
    const wobble = 1 + (Math.random() * 2 - 1) * 0.02;
    // 走 440 起、跑抬到 Coopanion 的 1.25 倍（它就是这么做的）
    const base = (running ? 550 : 440) * side * wobble * s.thump;

    // ① 主音：高、短、向下滑 —— 这一步的"嗒"
    thump(ctx, dest, {
      at, type: 'sine',
      f0: base, f1: base * 0.75,     // 440→330，就是它的比例
      dur: 0.060,
      vol: 0.50 * gainMul,
      attack: 0.003
    });

    // ② 地面色：极轻的中频，比主音低一个八度附近。
    //    没有它，木地板和瓷砖听起来一模一样；有它又别太响 —— 只占主音 1/7。
    thump(ctx, dest, {
      at: at + 0.002, type: 'triangle',
      f0: s.body * side, f1: s.body * side * 0.72,
      dur: s.bodyDur,
      vol: s.bodyVol * gainMul,
      attack: 0.002
    });

    // ③ 摩擦：Coopanion 跑步时才加的那层噪声，这里走和跑都加一点，
    //    但走的时候很轻（鞋底擦过地面的"沙"），Q 高一些免得出"嘶"。
    noise(ctx, dest, {
      at: at + 0.003,
      f0: s.scuff * side, f1: s.scuff * side * 0.78, q: 1.2,
      dur: running ? 0.050 : 0.030,
      vol: s.scuffVol * (running ? 1.35 : 1) * gainMul
    });

    // ④ 跑步的额外一层：它用 ×1.25 抬音高 + 更响的噪声。
    //    音高已在 base 里抬过，这里补一层很轻的短促高频，让跑步更"脆"。
    if (running) {
      thump(ctx, dest, {
        at: at + 0.008, type: 'sine',
        f0: base * 1.5, f1: base * 1.2,
        dur: 0.035, vol: 0.18 * gainMul, attack: 0.002
      });
    }
  },
  /** 溅水：带通噪声从高滑到低，尾巴拖一点。 */
  splash(ctx, dest, { at }) {
    noise(ctx, dest, { at, type: 'bandpass', f0: 2600, f1: 700, q: 1.1, dur: 0.34, vol: 0.5, attack: 0.004 });
    thump(ctx, dest, { at, f0: 150, f1: 55, dur: 0.22, vol: 0.3 });
  },
  /** 坐下/落座：闷响，没有金属感。 */
  thud(ctx, dest, { at, rate = 1 }) {
    thump(ctx, dest, { at, f0: 130 * rate, f1: 48 * rate, dur: 0.16, vol: 0.6 });
    noise(ctx, dest, { at, type: 'lowpass', f0: 420, f1: 160, dur: 0.1, vol: 0.2 });
  },
  click(ctx, dest, { at }) {
    thump(ctx, dest, { at, f0: 1300, f1: 820, dur: 0.035, vol: 0.5 });
  },
  pop(ctx, dest, { at }) {
    thump(ctx, dest, { at, f0: 300, f1: 760, dur: 0.06, vol: 0.5 });
  }
};

// ── 底层发声 ──────────────────────────────────────────────────
function thump(ctx, dest, { at, f0, f1, dur, vol, type = 'sine', attack = 0.005 }) {
  const t0 = ctx.currentTime + (at || 0);
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  // attack 可调：脚步要"硬起"（4ms），共鸣要"软起"（3ms 但更轻），
  // 统一的 5ms 会让脚跟那一下听起来钝
  g.gain.exponentialRampToValueAtTime(vol, t0 + Math.min(attack, dur * 0.5));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g); g.connect(dest);
  osc.start(t0); osc.stop(t0 + dur + 0.02);
}

function noise(ctx, dest, { at, type = 'bandpass', f0, f1 = f0, q = 1, dur, vol, attack = 0.005 }) {
  const t0 = ctx.currentTime + (at || 0);
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  const bq = ctx.createBiquadFilter();
  bq.type = type;
  bq.Q.value = q;
  bq.frequency.setValueAtTime(f0, t0);
  if (f1 !== f0) bq.frequency.exponentialRampToValueAtTime(Math.max(30, f1), t0 + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(bq); bq.connect(g); g.connect(dest);
  src.start(t0, Math.random() * 0.4);
  src.stop(t0 + dur + 0.02);
}

/** 一秒白噪声，全模块共用一个 buffer（每次新建是纯浪费）。 */
let noiseBuf = null;
function noiseBuffer(ctx) {
  if (noiseBuf && noiseBuf.sampleRate === ctx.sampleRate) return noiseBuf;
  const len = Math.floor(ctx.sampleRate);
  noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i += 1) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
}

// ── 对外接口 ──────────────────────────────────────────────────
const state = {
  ctx: null,
  bus: null,       // 由 ambience 提供的总线（已接好音量树）
  buffers: {},     // 已解码的素材
  decoding: {},    // 正在解码的 Promise
  failed: {},      // 解码失败过，别反复重试
  lastAt: {},      // 每条事件上次触发时刻，用于 cooldown
  pan: 0,          // -1 … 1，由外部按她的屏幕位置给
  panMax: 0.25,    // 声像上限（轻微，不要飘）
  enabled: true,
  volume: 1,
  variantIdx: {},  // 每条事件上一次用了哪个变体，避免连续重复
  foot: 0,         // 下一步是哪只脚（0/1 交替）。Coopanion 用不同基音区分左右脚
  surface: 'wood', // 脚下是什么地面，换地面就换音色
  failing: {}      // 素材连续失败几次后放弃，退到合成音
};

/** 解码一个文件；同一个文件只解一次。 */
function loadBuffer(file) {
  if (state.buffers[file] || state.failed[file] || !state.ctx) return state.decoding[file] || null;
  if (state.decoding[file]) return state.decoding[file];
  state.decoding[file] = fetch(file)
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((buf) => state.ctx.decodeAudioData(buf))
    .then((decoded) => { state.buffers[file] = decoded; return decoded; })
    .catch((err) => {
      // 解码失败就永久记住，退到合成兜底；不然每次走路都重试一次网络请求
      state.failed[file] = true;
      console.warn(`音效 ${file} 载入失败，改用合成音：`, err?.message || err);
      return null;
    });
  return state.decoding[file];
}

/** 预载一批事件用到的素材（进房间时调一次，避免第一步声音迟到）。 */
function preload(names) {
  if (!state.ctx) return;
  for (const name of names || Object.keys(EVENTS)) {
    const ev = EVENTS[name];
    if (!ev?.file) continue;
    for (const f of asArray(ev.file)) loadBuffer(f);
  }
}

const asArray = (v) => (Array.isArray(v) ? v : [v]);

/** 从变体池里挑一个；尽量不和上一次相同（只有 1 个时自然只能重复）。 */
function pickVariant(name, list) {
  if (list.length === 1) return list[0];
  const prev = state.variantIdx[name];
  let i = Math.floor(Math.random() * list.length);
  if (i === prev) i = (i + 1) % list.length;
  state.variantIdx[name] = i;
  return list[i];
}

/** 播放一个已解码的素材，带音高浮动与声像。 */
function playBuffer(name, buffer, ev, rate) {
  const ctx = state.ctx;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const jitter = ev.jitter ? 1 + (Math.random() * 2 - 1) * ev.jitter : 1;
  src.playbackRate.value = (rate || 1) * jitter;
  const g = ctx.createGain();
  g.gain.value = ev.gain ?? 0.3;
  let tail = src;
  // 声像：轻微即可。真按 ±1 来，镜头一转声音就大幅偏侧，听着像在飘。
  if (ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-state.panMax, Math.min(state.panMax, state.pan * (ev.panScale ?? 1)));
    src.connect(g); g.connect(p); p.connect(state.bus);
    tail = p;
  } else {
    src.connect(g); g.connect(state.bus);
    tail = g;
  }
  src.start(ctx.currentTime);
  // 播完自动断开，避免节点越积越多（长时间挂着会拖慢音频线程）
  src.onended = () => { try { tail.disconnect(); g.disconnect(); } catch { /* 已经断了 */ } };
}

/**
 * 触发一个事件。
 * @param {string} name EVENTS 的键
 * @param {object} opts { rate, gain, running, surface } —— gain 用来做「这一刻比平时轻/重」
 * @returns {boolean} 是否真的发声（被冷却挡住、没上下文、静音时为 false）
 */
function play(name, opts = {}) {
  const ev = EVENTS[name];
  if (!ev || !state.enabled || !state.ctx || !state.bus) return false;

  // 冷却：同一条事件太密就丢掉，不然连发会糊成一片噪声
  const now = state.ctx.currentTime * 1000;
  if (ev.cooldown && state.lastAt[name] && now - state.lastAt[name] < ev.cooldown) return false;
  state.lastAt[name] = now;

  const rate = (opts.rate ?? 1) * (ev.rate ?? 1);

  if (ev.file) {
    const list = asArray(ev.file);
    const file = pickVariant(name, list);
    const buf = state.buffers[file];
    if (buf) {
      const g = opts.gain != null ? { ...ev, gain: (ev.gain ?? 0.3) * opts.gain } : ev;
      playBuffer(name, buf, g, rate);
      return true;
    }
    // 素材还没下载好 → 立刻用合成音顶上。
    // 早先这里返回 false（怕同一串脚步混进不同音色），结果是**完全没声**，
    // 比混一个音色更糟：用户听到的是"走路没声音"。
    // 现在脚步本身就走合成，素材型音效（水声）也允许兜底。
    if (!state.failed[file]) loadBuffer(file);
  }

  const synth = ev.synth && SYNTHS[ev.synth];
  if (!synth) return false;
  const gainMul = opts.gain != null ? opts.gain : 1;
  synth(state.ctx, state.bus, { at: 0, rate, gainMul, ...opts });
  return true;
}

/**
 * 走路的一步。走和跑共用同一个合成器，靠 running 改音色：
 * 跑步是「更密、更重、鞋底摩擦更大」，不是「把走路的音高调高」。
 * @param {object} opts { running, surface, gain }
 */
function playStep({ running = false, surface = null, gain = 1 } = {}) {
  // 左右脚交替。放在这里而不是调用方，是为了让"每一步换一只脚"
  // 不受调用频率影响（跑起来步子更密，但左右仍严格交替）
  const foot = state.foot;
  state.foot = state.foot ? 0 : 1;
  return play(running ? 'run' : 'step', {
    gain,
    running,
    foot,
    surface: surface || state.surface
  });
}

export const sfx = {
  /**
   * 由 ambience 调用：把上下文和总线交进来。
   * 音效模块**自己不管音量**（主音量、静音、说话压低都在 ambience 那一棵树里），
   * 这样用户按静音时不会出现「环境音停了、脚步还在响」。
   */
  attach(ctx, bus) {
    state.ctx = ctx;
    state.bus = bus;
    preload();
  },
  detach() {
    state.ctx = null;
    state.bus = null;
    state.buffers = {};
    state.decoding = {};
    state.failed = {};
    noiseBuf = null;
  },
  get ready() { return !!(state.ctx && state.bus); },
  /** 总开关（由 ambience 的静音联动调用；单独用一般不需要）。 */
  setEnabled(v) { state.enabled = !!v; },
  get enabled() { return state.enabled; },
  /** 她的屏幕位置 -1…1，声音轻微偏向那一侧。 */
  setPan(v) { state.pan = Math.max(-1, Math.min(1, Number(v) || 0)); },
  get pan() { return state.pan; },
  /** 脚下地面：wood / tile / carpet / stone / grass。换地面就换音色。 */
  setSurface(s) { if (SURFACES[s]) state.surface = s; },
  get surface() { return state.surface; },
  /** 可用的地面清单，给试听页/测试用。 */
  get surfaces() { return Object.keys(SURFACES); },
  /** 声像上限，默认 0.25（轻微）。 */
  setPanMax(v) { state.panMax = Math.max(0, Math.min(1, Number(v) || 0)); },
  play,
  playStep,
  preload,
  /** 事件名清单，给试听页/测试用。 */
  get events() { return Object.keys(EVENTS); },
  /** 只读一份事件表，给试听页展示参数。 */
  describe(name) {
    const ev = EVENTS[name];
    if (!ev) return null;
    return {
      name,
      hasFile: !!ev.file,
      file: ev.file ? asArray(ev.file) : null,
      synth: ev.synth || (ev.file ? 'step' : null),
      gain: ev.gain,
      cooldown: ev.cooldown || 0
    };
  },
  debug() {
    return {
      ready: this.ready,
      enabled: state.enabled,
      pan: state.pan,
      panMax: state.panMax,
      surface: state.surface,
      foot: state.foot,
      loaded: Object.keys(state.buffers).length,
      failed: Object.keys(state.failed),
      ctxState: state.ctx?.state || 'none'
    };
  }
};

// 便于无头测试
export const __internals = { EVENTS, SYNTHS, FILES, SURFACES };