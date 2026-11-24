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
  step: { synth: 'step', gain: 0.30, cooldown: 90, panScale: 1 },
  // 跑步**不抬高 rate**。Coopanion 对桌宠用 ×1.25，那是因为它只有"嗒"一声、
  // 想表达"跑起来了"只能靠音高。脚步声的"跑"应该靠**更多低频**和更密的步频，
  // 抬高音高只会变尖。实测 rate 1.12 会让过零率（zcr）涨到走路的 1.5 倍，
  // 听着像"哒哒"而不像"咚咚"。这里交给 SYNTHS.step 内部的 gait 因子去加重。
  run: { synth: 'step', gain: 0.38, cooldown: 80, panScale: 1 },
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
  wood: { thump: 1.00, body: 210, bodyVol: 0.16, bodyDur: 0.070, scuff: 2300, scuffVol: 0.14 },
  tile: { thump: 1.08, body: 340, bodyVol: 0.10, bodyDur: 0.045, scuff: 3200, scuffVol: 0.20 },
  carpet: { thump: 0.92, body: 150, bodyVol: 0.06, bodyDur: 0.050, scuff: 1500, scuffVol: 0.09 },
  stone: { thump: 1.05, body: 300, bodyVol: 0.12, bodyDur: 0.055, scuff: 2800, scuffVol: 0.18 },
  grass: { thump: 0.88, body: 140, bodyVol: 0.05, bodyDur: 0.060, scuff: 1200, scuffVol: 0.22 }
};

const SYNTHS = {
  /**
   * 脚步。结构参考 Coopanion 的 `step(run, i)`：
   * 一个**下滑**的正弦 +（跑步时）一层摩擦噪声，并且**两只脚用不同的基音**
   * （它用 440→330 与 520→380 交替）。
   *
   * 双脚交替是它最聪明的一处：光靠随机 detune 分不出左右脚，
   * 而每步固定换一个基音，连续两步天然不完全相同 —— 更像"真的在走"。
   *
   * 但桌宠那版是轻声"嗒"一下（f0 440 起、音量 0.05，一只小宠物够用）。
   * 木地板上的人脚步需要体重感，所以在它的结构上补了三层：
   *   ① 脚跟   更低更短的撞击，负责"重"
   *   ② 地面   一段中频短共鸣，负责"这块地是什么材质"
   *   ③ 摩擦   鞋底擦过地面的"沙"，不是"嘶"（带通要窄）
   * 跑步再多一层蹬地，并把整体音高抬起来 —— 但抬得比它克制：
   * 它用 ×1.25，真跑起来是"更密更重"，不是"更尖"。
   */
  step(ctx, dest, { at = 0, rate = 1, running = false, surface = 'wood', foot = 0, gainMul = 1 } = {}) {
    const s = SURFACES[surface] || SURFACES.wood;
    // 跑步不加 gait 音高因子：跑步的"重"全部来自下面 ④ 那层蹬地低频，
    // 以及更长的摩擦尾巴。抬音高只会让它变尖（见 EVENTS.run 的注释）。
    const side = foot ? 1.12 : 1;
    // ±1.5% 的随机，避免机械重复。再多就"跑调"了
    const wobble = 1 + (Math.random() * 2 - 1) * 0.015;
    const k = rate * side * s.thump * wobble;

    // ① 脚跟：这一步的重量。滑向 45Hz 而不是纯低频正弦 ——
    //    下滑让听觉上是"落地压实"，恒定正弦只是"嗡"。
    thump(ctx, dest, {
      at, type: 'sine',
      f0: 105 * k, f1: 45 * k,
      dur: running ? 0.065 : 0.085,
      vol: (running ? 0.30 : 0.24) * gainMul,
      attack: 0.004
    });

    // ② 地面共鸣：短、很轻，但去掉就没有"房间感"，脚步会像在真空里
    thump(ctx, dest, {
      at: at + 0.006, type: 'triangle',
      f0: s.body * k, f1: s.body * k * 0.62,
      dur: s.bodyDur,
      vol: s.bodyVol * gainMul,
      attack: 0.003
    });

    // ③ 摩擦：Q 值高一点，出来是"沙"而不是"嘶"
    noise(ctx, dest, {
      at: at + 0.004,
      f0: s.scuff * k, f1: s.scuff * k * 0.7, q: 1.4,
      dur: running ? 0.055 : 0.035,
      // 跑步的摩擦**不该**加得更多。实测加 1.5× 会让过零率翻到走路的 2.25 倍，
      // 听感变成"哒哒"的尖响，而跑步真正该多的是下面那层蹬地低频。
      // 这里给 1.15× 已经是"鞋底更用力擦过"的程度。
      vol: s.scuffVol * (running ? 1.15 : 1) * gainMul
    });

    // ④ 跑步的蹬地：这是"跑"的**唯一来源** —— 比走多一个更低更闷的撞击。
    //    不加音高（那会变尖），只加低频厚度，所以听起来是"咚咚"不是"哒哒"。
    if (running) {
      thump(ctx, dest, {
        at: at + 0.010, type: 'sine',
        f0: 72 * k, f1: 34 * k, dur: 0.085, vol: 0.26 * gainMul, attack: 0.006
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