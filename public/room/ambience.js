// 环境音系统：程序化底层 + 场景点缀
// 设计目标：0 素材依赖、无缝循环、随天气/房间/室内外连续变化
// 用法：
//   ambience.init()                     // 首次用户手势后调用
//   ambience.setEnabled(true)
//   ambience.setVolume(0.45)
//   ambience.setScene({ weather: 'rain', room: 'living' })
//   ambience.setSpeaking(true)          // 她说话时自动压低

import { sfx } from './sfx.js';

const AC = window.AudioContext || window.webkitAudioContext;

const OUTDOOR_ROOMS = new Set(['pool', 'garden', 'balcony', 'yard', 'corridor']);

/**
 * 室内低通截止频率。
 *
 * 原来是 1200Hz，问题很实际：鸟叫在 2200~3800Hz、雨声细节在 2400~3200Hz、
 * 蟋蟀在 4200Hz —— **全部被切光**，而风声（<300Hz 程序化 / <1100Hz 采样）
 * 完整通过。于是室内永远「只剩呼呼的风声」，这就是"风喧宾夺主"的根因：
 * 不是风变响了，是别的声源被消音了。
 *
 * 抬到 2800Hz 后：鸟叫能隔着窗漏进来一部分，雨声有颗粒感；
 * 蟋蟀（4200Hz）仍被切 —— 这符合常识，住宅里确实听不清蟋蟀。
 * 代价是雨声最刺的高频也会进来，所以 makeRain 和 rain 采样单独再压一刀。
 */
const INDOOR_CUTOFF = 2800;
/** 雨声额外限频：挡住 2800Hz 以上会显得刺耳的频段。 */
const RAIN_TAME = 2200;

// ── 噪声缓冲（生成一次，反复循环） ───────────────────────────────
function noiseBuffer(ctx, seconds = 4, kind = 'white') {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i += 1) {
    const white = Math.random() * 2 - 1;
    if (kind === 'white') data[i] = white * 0.6;
    else if (kind === 'pink') {
      last = 0.98 * last + 0.02 * white;
      data[i] = last * 3.2;
    } else { // brown
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
  }
  return buf;
}

function loopSource(ctx, buffer) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  return src;
}

function gainNode(ctx, value = 0) {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

// ── CC0 采样（OpenGameArt，均已转成 96kbps 单声道 OGG） ─────────
const SAMPLE_URLS = {
  rain: 'assets/sound/ambience/rain.ogg',
  storm: 'assets/sound/ambience/storm.ogg',
  birds: 'assets/sound/ambience/birds.ogg',
  crickets: 'assets/sound/ambience/crickets.ogg',
  wind: 'assets/sound/ambience/wind.ogg',
  drip: 'assets/sound/ambience/drip.ogg'
};
const sampleBuf = {};
let samplesReady = false;

async function loadSamples() {
  if (samplesReady || !state.ctx) return;
  try {
    await Promise.all(Object.entries(SAMPLE_URLS).map(async ([name, url]) => {
      const res = await fetch(url);
      const arr = await res.arrayBuffer();
      sampleBuf[name] = await state.ctx.decodeAudioData(arr);
    }));
    samplesReady = true;
    if (state.enabled) rebuildBeds();
  } catch (e) {
    console.warn('[ambience] 采样加载失败，使用程序化兜底', e);
  }
}

// ── 各天气底层 ─────────────────────────────────────────────────
function makeRain(ctx, dest, heavy, gain) {
  const g = gainNode(ctx);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = heavy ? 500 : 900;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = heavy ? 2400 : 3200;
  band.Q.value = 0.6;
  const src = loopSource(ctx, noiseBuffer(ctx, 4, 'white'));
  // 雨声再收一刀：室内低通抬到 2800 后，最刺的那层高频会漏进来。
  // 带通本身已经在 2400~3200，这里再加个低通把尖头磨掉，
  // 出来是"沙沙"而不是"嘶嘶"。
  const tame = ctx.createBiquadFilter();
  tame.type = 'lowpass';
  tame.frequency.value = RAIN_TAME;
  tame.Q.value = 0.4;
  src.connect(hp);
  hp.connect(band);
  band.connect(tame);
  tame.connect(g);
  g.connect(dest);
  src.start();
  g.gain.value = gain != null ? gain : (heavy ? 0.26 : 0.16);
  return { gain: g, stop: () => { try { src.stop(); } catch { /* 忽略 */ } } };
}

function makeWind(ctx, dest, { strength = 1, gust = 0.5, gain } = {}) {
  const g = gainNode(ctx);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 300;
  const src = loopSource(ctx, noiseBuffer(ctx, 5, 'brown'));
  src.connect(lp);
  lp.connect(g);
  g.connect(dest);
  src.start();

  // 阵风：用 LFO 推进低通与小音量。
  //
  // 原频率 0.08/0.05Hz（12~20 秒一个周期）慢到听不出来变化，
  // 实际就是一段**恒定的呼呼声** —— 这是"风很烦"的主观来源。
  // 现在加快到 0.20/0.14Hz（约 5~7 秒一轮），配合下面的大幅音量起伏，
  // 听感变成"一阵一阵"，而不是持续底噪。
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.20 + gust * 0.12;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 320 + gust * 720;
  lfo.connect(lfoGain);
  lfoGain.connect(lp.frequency);
  lfo.start();

  const volLfo = ctx.createOscillator();
  volLfo.frequency.value = 0.14 + gust * 0.08;
  const volGain = ctx.createGain();
  // 音量起伏幅度 ×3（0.018 → 0.055）：让"风小了"真的接近无声
  volGain.gain.value = 0.055 * strength;
  volLfo.connect(volGain);
  volGain.connect(g.gain);
  volLfo.start();

  // 基准再压低：风是背景，不该盖过雨声/鸟叫/室内底噪。
  // gain 给了就用它当基准（绝对电平），否则用 strength 换算。
  g.gain.value = (gain != null ? gain : 0.06 * strength);
  return {
    gain: g,
    stop: () => {
      try { src.stop(); lfo.stop(); volLfo.stop(); } catch { /* 忽略 */ }
    }
  };
}

/**
 * 风的"让位"：周期性把风声压到很低，持续几秒。
 *
 * 为什么需要它：即使把阵风加快，风仍然是**一直在响**的底噪。
 * 真实环境里风会停 —— 而"停下来"这一刻，别的声源（鸟叫、房间嗡鸣）
 * 才有机会被听见。这是解决"风喧宾夺主"最直接的手段：
 * 不是把风调小一点，而是让它**主动让出空间**。
 *
 * baseGain 传**函数**而不是数值：采样风（makeSampleBed）用
 * linearRampToValueAtTime 在 2.2 秒内渐入到目标增益，若在挂载那一刻
 * 就把当前值（0）读出来当基准，ducker 会把风压到错误的水平。
 * 每次用的时候再读一次，就能拿到真实基准。
 *
 * 返回 stop()：调用方负责在换天气/换房间时停掉，
 * 否则旧的定时器会继续压新建的风声节点。
 */
function makeWindDucker(ctx, windGain, baseOf) {
  let timer = null;
  const base = () => {
    const v = typeof baseOf === 'function' ? baseOf() : baseOf;
    return Math.max(0.0001, Number(v) || 0.06);
  };
  const set = (v, sec) => {
    const now = ctx.currentTime;
    windGain.gain.cancelScheduledValues(now);
    windGain.gain.setValueAtTime(Math.max(0.0001, windGain.gain.value), now);
    windGain.gain.linearRampToValueAtTime(Math.max(0.0001, v), now + sec);
  };

  const schedule = () => {
    // 8~16 秒后安静 2.5~5 秒，然后回到基准
    const gap = 8000 + Math.random() * 8000;
    timer = setTimeout(() => {
      if (!ctx || ctx.state === 'closed') return;
      // 安静段压到基准的 18%~30%
      set(base() * (0.18 + Math.random() * 0.12), 1.4);
      timer = setTimeout(() => {
        if (!ctx || ctx.state === 'closed') return;
        set(base(), 2.2);
        schedule();
      }, 2500 + Math.random() * 2500);
    }, gap);
  };
  schedule();

  return { stop: () => { if (timer) clearTimeout(timer); timer = null; } };
}

function makeSnow(ctx, dest, gain) {
  const g = gainNode(ctx);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 300;
  const src = loopSource(ctx, noiseBuffer(ctx, 5, 'brown'));
  src.connect(lp);
  lp.connect(g);
  g.connect(dest);
  src.start();
  g.gain.value = gain != null ? gain : 0.045;

  const hiss = gainNode(ctx, 0.012);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 5200;
  const hsrc = loopSource(ctx, noiseBuffer(ctx, 3, 'white'));
  hsrc.connect(hp); hp.connect(hiss); hiss.connect(dest);
  hsrc.start();
  return {
    gain: g,
    stop: () => { try { src.stop(); hsrc.stop(); } catch { /* 忽略 */ } }
  };
}

function makeAurora(ctx, dest, gain) {
  const g = gainNode(ctx, gain != null ? gain : 0.05);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 500;
  const a = ctx.createOscillator(); a.type = 'sine'; a.frequency.value = 72;
  const b = ctx.createOscillator(); b.type = 'sine'; b.frequency.value = 108;
  const trem = ctx.createOscillator(); trem.frequency.value = 0.06;
  const tremGain = ctx.createGain(); tremGain.gain.value = 0.03;
  a.connect(lp); b.connect(lp); lp.connect(g); g.connect(dest);
  trem.connect(tremGain); tremGain.connect(g.gain);
  a.start(); b.start(); trem.start();
  return { gain: g, stop: () => { try { a.stop(); b.stop(); trem.stop(); } catch { /* 忽略 */ } } };
}

/**
 * 远处车流：霾天的第二层。
 *
 * 霾通常伴随交通/城市底噪 —— 只有风的霾天听起来像荒野，不像城市。
 *
 * 频段说明（重要）：第一版用褐噪 + 低通 480Hz，**全是 0-400Hz**，
 * 和风的频段完全重叠 —— 频段占比测出来还是 100% 风，听感上「一片嗡嗡」
 * 也没解决。城市车流其实有中频（引擎、轮胎路噪在 200~800Hz），
 * 所以改成带通 500Hz 为主，保留一点低频底。
 */
function makeTraffic(ctx, dest, gain) {
  const g = gainNode(ctx, gain != null ? gain : 0.04);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 520;
  bp.Q.value = 0.8;
  const src = loopSource(ctx, noiseBuffer(ctx, 5, 'brown'));
  src.connect(bp); bp.connect(g); g.connect(dest);
  src.start();
  // 车流起伏：0.07Hz（约 14 秒一轮），幅度不大但足以听出"有车经过"
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.07;
  const lg = ctx.createGain();
  lg.gain.value = 0.022;
  lfo.connect(lg); lg.connect(g.gain);
  lfo.start();
  return { gain: g, stop: () => { try { src.stop(); lfo.stop(); } catch { /* 忽略 */ } } };
}

/**
 * 雾的空气感：中高频的极轻"嘶"。
 *
 * 雾天的听感特点是**空气发闷、发黏**，声音像被包住。
 * 用一条 2000~4000Hz 的窄带噪声能做出这种"隔着东西"的感觉，
 * 而且它在**中频段**（不会和风的低频叠加成一片嗡嗡）。
 * 之前给 fog 用的是 aurora（72/108Hz 纯低频），恰好是错误频段。
 */
function makeMist(ctx, dest, gain) {
  const g = gainNode(ctx, gain != null ? gain : 0.012);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  // 中心频率必须**低于**室内低通截止（INDOOR_CUTOFF = 2800Hz）。
  // 原来定在 2800Hz —— 正好落在截止点上，衰减掉一半能量，
  // 于是加大增益也没用（测出来 snow/hail 仍是 95%+ 低频）。
  // 2200Hz 在 2800Hz 截止点内侧约 1/3 个八度，衰减很小。
  bp.frequency.value = 2200;
  // Q 放宽到 0.7：Q=1.1 的窄带通太"尖"，听起来像啸叫而不是空气感
  bp.Q.value = 0.7;
  const src = loopSource(ctx, noiseBuffer(ctx, 4, 'white'));
  src.connect(bp); bp.connect(g); g.connect(dest);
  src.start();
  // 极慢起伏，避免像固定的白噪声嘶嘶
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.05;
  const lg = ctx.createGain();
  lg.gain.value = 0.006;
  lfo.connect(lg); lg.connect(g.gain);
  lfo.start();
  return { gain: g, stop: () => { try { src.stop(); lfo.stop(); } catch { /* 忽略 */ } } };
}

/**
 * 颗粒噪声：沙尘天的第二层。
 *
 * 沙尘不只是"风大"，还有沙粒打在物体上的细碎声响。
 * 做法：白噪声过带通（1500Hz, Q 高）得到"沙沙"的颗粒感，
 * 再用快 LFO 让颗粒时有时无 —— 恒定带通噪声听起来像收音机底噪，不像沙。
 */
function makeGrit(ctx, dest, gain) {
  const g = gainNode(ctx, gain != null ? gain : 0.05);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  // 中心频率从 1500 移到 2200Hz：1500 落在中频段(1200-2800)的低边缘，
  // 能量被挤在段首，测出来只占 1%。2200 在段中部，颗粒感才立得住。
  bp.frequency.value = 2200;
  // Q 从 2.2 放宽到 1.2：窄带通听着像啸叫，不像沙粒/冰粒的颗粒感
  bp.Q.value = 1.2;
  const src = loopSource(ctx, noiseBuffer(ctx, 4, 'white'));
  src.connect(bp); bp.connect(g); g.connect(dest);
  src.start();
  // 颗粒断续：1.7Hz，模拟沙粒一阵阵打过来
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 1.7;
  const lg = ctx.createGain();
  lg.gain.value = 0.035;
  lfo.connect(lg); lg.connect(g.gain);
  lfo.start();
  return { gain: g, stop: () => { try { src.stop(); lfo.stop(); } catch { /* 忽略 */ } } };
}

/**
 * 每个房间的室内底噪。
 *
 * 原来只有厨房（0.035）和卫生间（0.02），其余 9 个房间直接 `return null` ——
 * 客厅、卧室、餐厅完全没有室内声，于是室内听起来"空"，只剩窗外的风。
 * 低通修好之后这一点更明显：别的声源有了，房间本身却还是空的。
 *
 * 各房间的差异要有意义，不能只改数字：
 *   卧室     最静（0.008），且低通更低 —— 安静的地方该真的安静
 *   厨房     抽油烟机式的低频（pink 噪声 + 低通）
 *   浴室     白噪声（空间小、混响亮）
 *   洗衣房  白噪声 + 稍高的截止（洗衣机/管道）
 *   其余     极轻的 pink 噪声当"空调/房屋底噪"
 */
const ROOM_HUM = {
  kitchen:  { gain: 0.035, lp: 320,  kind: 'pink' },
  bathroom: { gain: 0.020, lp: 900,  kind: 'white' },
  laundry:  { gain: 0.018, lp: 500,  kind: 'white' },
  living:   { gain: 0.012, lp: 260,  kind: 'pink' },
  dining:   { gain: 0.010, lp: 280,  kind: 'pink' },
  corridor: { gain: 0.010, lp: 240,  kind: 'pink' },
  foyer:    { gain: 0.010, lp: 260,  kind: 'pink' },
  her_room: { gain: 0.008, lp: 200,  kind: 'pink' }
};

/** 静态房间底噪（抽油烟机、水汽、房屋底噪） */
function makeRoomHum(ctx, dest, kind) {
  const spec = ROOM_HUM[kind];
  if (!spec) return null;
  const g = gainNode(ctx, spec.gain);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = spec.lp;
  const src = loopSource(ctx, noiseBuffer(ctx, 4, spec.kind));
  src.connect(lp); lp.connect(g); g.connect(dest); src.start();
  return { gain: g, stop: () => { try { src.stop(); } catch { /* 忽略 */ } } };
}

// ── 点缀音（合成） ─────────────────────────────────────────────
function thunder(ctx, dest) {
  const now = ctx.currentTime;
  const g = gainNode(ctx, 0.0001);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(420, now);
  lp.frequency.exponentialRampToValueAtTime(70, now + 1.6);
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, 2, 'brown');
  src.connect(lp); lp.connect(g); g.connect(dest);
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.9, now + 0.05);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 2.2);
  src.start(now);
  src.stop(now + 2.4);
}

function birdChirp(ctx, dest) {
  const now = ctx.currentTime;
  const n = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i += 1) {
    const t0 = now + i * (0.09 + Math.random() * 0.06);
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const base = 2200 + Math.random() * 1600;
    osc.frequency.setValueAtTime(base, t0);
    osc.frequency.exponentialRampToValueAtTime(base * (1.2 + Math.random() * 0.5), t0 + 0.05);
    const g = gainNode(ctx, 0.0001);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.05, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.07);
    osc.connect(g); g.connect(dest);
    osc.start(t0); osc.stop(t0 + 0.1);
  }
}

function cricket(ctx, dest) {
  const now = ctx.currentTime;
  const pulses = 3 + Math.floor(Math.random() * 3);
  for (let i = 0; i < pulses; i += 1) {
    const t0 = now + i * 0.055;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 4200 + Math.random() * 400;
    const g = gainNode(ctx, 0.0001);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.02, t0 + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.03);
    osc.connect(g); g.connect(dest);
    osc.start(t0); osc.stop(t0 + 0.04);
  }
}

function waterDrip(ctx, dest) {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(900 + Math.random() * 500, now);
  osc.frequency.exponentialRampToValueAtTime(300, now + 0.12);
  const g = gainNode(ctx, 0.0001);
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.03, now + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
  osc.connect(g); g.connect(dest);
  osc.start(now); osc.stop(now + 0.2);
}

// ── 主控制器 ───────────────────────────────────────────────────
//
// 两条独立的音量支路，共用一个 AudioContext 和输出：
//
//   bedBus/shotBus/roomBus → roomFilter → master ─┐
//                                                 ├→ analyser → destination
//   sfxBus →────────────────────────→ sfxMaster ──┘
//
// 为什么要分两支：「环境音」和「音效」在 UI 上是两个开关，
// 环境音默认关（背景风雨声太吵，多数人不开），音效默认开（点击/脚步的反馈）。
// 早先把 sfxBus 挂在 master 下面，等于让默认关着的环境音开关
// 顺手管住了动作音效 —— 用户没开环境音，脚步就永远不响。
// 现在各走各的增益，互不影响。
const state = {
  ctx: null,
  master: null,      // 环境音总音量（受 enabled / volume 控制）
  sfxMaster: null,   // 动作音效总音量（受动作音效开关控制）
  roomFilter: null,
  bedBus: null,
  shotBus: null,
  roomBus: null,
  sfxBus: null,
  enabled: false,        // 环境音开关
  sfxEnabled: true,      // 动作音效开关（默认开，和 UI 的「音效」一致）
  volume: 0.45,
  speaking: false,
  weather: 'day',
  room: 'living',
  beds: [],
  roomLayer: null,
  timer: null,
  lastShotAt: 0
};

function sceneKey(weather, room) {
  return `${weather}|${room}`;
}

// 每种天气的声场编排：sample 优先，proc 兜底
// gain 是相对增益（0–1）
function sceneLayers(weather) {
  switch (weather) {
    case 'rain':
      // 雨：雨声本身是高频的（2400~3200Hz 带通），但**室内低通会削掉它的高频**，
      // 剩下的雨声偏闷。加一层 mist（中高频空气感）把"雨打窗"的颗粒感留住，
      // 否则室内听起来只是一片低频轰隆。
      return [
        { sample: 'rain', gain: 0.62, fallback: { type: 'rain', heavy: false } },
        { proc: 'mist', gain: 0.028 }
      ];
    case 'storm':
      // 雷雨：storm 采样是雷雨实录，低频很足，所以室内几乎是纯低频。
      // 补一层雨的高频颗粒（mist），让雷雨有"雨打窗"的层次，
      // 而不是一整片轰隆。
      return [
        { sample: 'storm', gain: 0.62, fallback: { type: 'rain', heavy: true } },
        { proc: 'wind', gain: 0.12, opts: { strength: 1.1, gust: 0.8 } },
        { proc: 'mist', gain: 0.042 }
      ];
    case 'sleet':
      return [
        { sample: 'rain', gain: 0.35, fallback: { type: 'rain', heavy: false } },
        { sample: 'wind', gain: 0.18 }
      ];
    case 'hail':
      // 冰雹：冰粒砸落是**高频**的（冰是硬的），雷雨实录补低频。
      // grit 是 1500Hz 带通，正好是冰粒的质感。
      return [
        { sample: 'storm', gain: 0.30, fallback: { type: 'rain', heavy: true } },
        { sample: 'wind', gain: 0.07, opts: { strength: 1.2, gust: 0.8 } },
        { proc: 'grit', gain: 0.16 }
      ];
    case 'haze':
      // 霾：原来只有风（100%），像荒野。补一层远处车流 —— 霾常伴随城市交通。
      return [
        { proc: 'traffic', gain: 0.10 },
        { sample: 'wind', gain: 0.10, fallback: { type: 'wind', opts: { strength: 0.35, gust: 0.1 } } }
      ];
    case 'typhoon':
      // 台风本来就该是压倒性的，所以这里风保持强势；
      // 但第二层程序化风的 gain 是**绝对电平**（不是乘 strength），要显式给。
      return [
        { sample: 'storm', gain: 0.8, fallback: { type: 'rain', heavy: true } },
        { sample: 'wind', gain: 0.55 },
        { proc: 'wind', gain: 0.22, opts: { strength: 1.8, gust: 1.2 } }
      ];
    case 'blizzard':
      return [
        { sample: 'wind', gain: 0.22, fallback: { type: 'snow' } },
        { proc: 'snow', gain: 0.09 },
        { proc: 'mist', gain: 0.050 }
      ];
    case 'meteor':
      // 流星雨夜：蟋蟀 + 极光。同样给极光补一层空气感，
      // 否则整段都是低频正弦（频段占比 100%，听感单一）。
      return [
        { sample: 'crickets', gain: 0.3, fallback: { proc: 'wind', gain: 0.12 } },
        { proc: 'aurora', gain: 0.10 },
        { proc: 'mist', gain: 0.010 }
      ];
    case 'snow':
      // 雪：雪的沙沙声本来偏**高频**（雪粒碰撞），但现在两层都在低频，
      // 测出来 97% 都是 <400Hz —— 听着是闷响不是雪。
      // 修正：mist（2800Hz）给到能听见的量，风和雪的底噪压低。
      return [
        { sample: 'wind', gain: 0.05, fallback: { type: 'snow' } },
        { proc: 'snow', gain: 0.035 },
        { proc: 'mist', gain: 0.055 }
      ];
    case 'fog':
      // 雾：声音传不远、环境闷。第二层用**中高频的空气感**（mist），
      // 不用 aurora —— aurora 是 72/108Hz 纯低频，和风重叠，测出来仍是 100% 风。
      return [
        { sample: 'wind', gain: 0.09, fallback: { type: 'wind', opts: { strength: 0.3, gust: 0.08 } } },
        { proc: 'mist', gain: 0.022 }
      ];
    case 'overcast':
      // 阴天：安静，不该有大风。风退到很轻，再补一点空气感，
      // 让"阴天的沉闷"和"什么都没有"是两回事。
      return [
        { sample: 'wind', gain: 0.11, fallback: { type: 'wind', opts: { strength: 0.4, gust: 0.12 } } },
        { proc: 'mist', gain: 0.014 }
      ];
    case 'sand':
      // 沙尘：不只是风大，还有沙粒打在物体上的细碎声响。
      return [
        { proc: 'grit', gain: 0.12 },
        { sample: 'wind', gain: 0.30, fallback: { type: 'wind', opts: { strength: 1.2, gust: 0.9 } } }
      ];
    case 'aurora':
      // 极光本身是低频正弦（72/108Hz），**全是 0-400Hz** —— 频段占比 100%，
      // 听起来就是纯嗡嗡。补一层极轻的空气感（mist，中高频），
      // 让它变成"低频底 + 一点空气"，而不是单一音。
      return [
        { proc: 'aurora', gain: 0.16 },
        { proc: 'mist', gain: 0.010 }
      ];
    case 'night':
    case 'starry':
    case 'dusk':
      return [
        { sample: 'crickets', gain: 0.4, fallback: { proc: 'wind', gain: 0.14 } },
        { sample: 'wind', gain: 0.08 }
      ];
    case 'dawn':
    case 'day':
    case 'rainbow':
      // 晴天/彩虹：鸟叫是主角，风只是底噪。之前风 0.18 偏大，
      // 室内低通又把鸟叫滤掉，结果只剩风 —— 降到 0.09。
      return [
        { sample: 'birds', gain: 0.35, fallback: { proc: 'wind', gain: 0.14 } },
        { sample: 'wind', gain: 0.09, fallback: { type: 'wind', opts: { strength: 0.45, gust: 0.25 } } }
      ];
    default:
      return [{ sample: 'wind', gain: 0.3, fallback: { type: 'wind', opts: { strength: 0.5, gust: 0.25 } } }];
  }
}

function makeSampleBed(name, gainValue, dest) {
  const buf = sampleBuf[name];
  if (!buf) return null;
  const ctx = ctxOf();
  const g = gainNode(ctx, 0);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  let tail = src;
  let lfo = null;
  // 风声柔化：低通压掉砂砾感，再用极慢 LFO 让滤波缓慢游走，避免「死板」
  if (name === 'wind' || name === 'storm') {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = name === 'wind' ? 1100 : 2600;
    lp.Q.value = 0.5;
    src.connect(lp);
    tail = lp;
    if (name === 'wind') {
      lfo = ctx.createOscillator();
      lfo.frequency.value = 0.045;
      const depth = ctx.createGain();
      depth.gain.value = 260;
      lfo.connect(depth);
      depth.connect(lp.frequency);
      lfo.start();
    }
  }
  tail.connect(g);
  g.connect(dest);
  src.start();
  g.gain.linearRampToValueAtTime(gainValue, ctx.currentTime + 2.2);
  return {
    gain: g,
    stop: () => { try { src.stop(); if (lfo) lfo.stop(); } catch { /* 忽略 */ } }
  };
}

function ctxOf() { return state.ctx; }

function buildProc(entry, dest) {
  const ctx = state.ctx;
  const type = entry.proc || entry.fallback?.type || 'wind';
  const g = entry.gain;
  let node = null;
  if (type === 'rain') node = makeRain(ctx, dest, entry.fallback?.heavy === true, g);
  else if (type === 'snow') node = makeSnow(ctx, dest, g);
  else if (type === 'aurora') node = makeAurora(ctx, dest, g);
  else if (type === 'traffic') node = makeTraffic(ctx, dest, g);
  else if (type === 'mist') node = makeMist(ctx, dest, g);
  else if (type === 'grit') node = makeGrit(ctx, dest, g);
  else node = makeWind(ctx, dest, { ...(entry.opts || entry.fallback?.opts || {}), gain: g });
  // 增益已由各 make* 自己应用（gain 参数），这里不再二次覆盖 ——
  // 二次覆盖会把 makeWind 里 strength 换算出来的基准盖掉。
  //
  // 注意：以前这里有个条件 `entry.gain !== undefined && entry.sample`，
  // 导致**所有 proc 条目的 gain 都被忽略**（proc 没有 sample 字段）。
  // 现在 gain 走参数直传，语义统一为"这条层的绝对电平"。
  // 标记这是风层：buildBeds 据此统一挂"让位"定时器。
  // 用标记而不是在这里直接挂，是因为采样风（makeSampleBed）走的是另一条路径，
  // 两条都得让位，在 buildBeds 里统一处理更不容易漏。
  if (node) node.isWind = type === 'wind';
  return node;
}

function buildBeds() {
  const dest = state.bedBus;
  const layers = sceneLayers(state.weather);
  const nodes = [];
  for (const entry of layers) {
    if (entry.sample && sampleBuf[entry.sample]) {
      const n = makeSampleBed(entry.sample, entry.gain ?? 0.4, dest);
      if (n) {
        n.isWind = entry.sample === 'wind';
        nodes.push(n);
        continue;
      }
    }
    if (entry.proc || entry.fallback) {
      const n = buildProc(entry, dest);
      if (n) nodes.push(n);
    }
  }

  // 给每一层风挂"让位"定时器：周期性压到很低几秒，让鸟叫/房间底噪透出来。
  // 基准增益用**函数**延迟读取 —— 采样风是 2.2 秒渐入的，挂载那一刻读不到真值。
  for (const n of nodes) {
    if (!n.isWind || !n.gain) continue;
    try {
      n.ducker = makeWindDucker(state.ctx, n.gain, () => n.gain.gain.value);
    } catch { /* 忽略：没有 ctx 就不挂 */ }
  }
  return nodes;
}

function rebuildBeds() {
  stopBeds();
  if (!state.ctx) return;
  state.beds = buildBeds();
  rebuildRoomLayer();
}

function stopBeds() {
  for (const b of state.beds) {
    // 先停"让位"定时器：它持有 setTimeout，不停会在换天气后继续压新节点
    try { b.ducker?.stop(); } catch { /* 忽略 */ }
    try { b.stop(); } catch { /* 忽略 */ }
  }
  state.beds = [];
}

function rebuildBed() {
  stopBeds();
  if (!state.ctx) return;
  const bed = buildBed(desiredBedConfig(state.weather));
  if (bed) state.beds.push(bed);
  rebuildRoomLayer();
}

function rebuildRoomLayer() {
  if (state.roomLayer) {
    try { state.roomLayer.stop(); } catch { /* 忽略 */ }
    state.roomLayer = null;
  }
  if (!state.ctx) return;
  // 传完整房间 key，底噪由 ROOM_HUM 表决定（原来只给 kitchen/bathroom，
  // 其余房间是空的）。不在表里的房间（pool/garden/balcony/yard 等室外）
  // 自然没有室内底噪 —— 这是对的，室外不该有"房间嗡鸣"。
  const hum = makeRoomHum(state.ctx, state.roomBus, state.room);
  if (hum) state.roomLayer = hum;
}

function indoorNow() {
  return !OUTDOOR_ROOMS.has(state.room);
}

function applyLevels() {
  if (!state.ctx) return;
  const now = state.ctx.currentTime;
  // 环境音：由环境音开关 + 环境音音量控制；她说话时让路压低
  const target = state.enabled ? state.volume * (state.speaking ? 0.55 : 1) : 0;
  state.master.gain.cancelScheduledValues(now);
  state.master.gain.linearRampToValueAtTime(target, now + 0.6);
  // 动作音效：只看自己的开关。**不乘环境音音量** —— 那是背景声的偏好，
  // 不该连带把脚步也调小；动作音效的音量在这里固定，靠各事件自己的 gain 调。
  if (state.sfxMaster) {
    state.sfxMaster.gain.cancelScheduledValues(now);
    state.sfxMaster.gain.linearRampToValueAtTime(state.sfxEnabled ? 1 : 0, now + 0.15);
  }
  // 室内低通（只作用于环境音那一路，sfxBus 不经过它）
  // 1200Hz → INDOOR_CUTOFF(2800Hz)：见常量处的注释，
  // 原来那个值把鸟叫/雨声细节全切了，只剩风声。
  const indoor = indoorNow();
  state.roomFilter.frequency.cancelScheduledValues(now);
  state.roomFilter.frequency.linearRampToValueAtTime(indoor ? INDOOR_CUTOFF : 18000, now + 0.8);
  state.roomFilter.Q.value = indoor ? 0.4 : 0.0001;
}

function scheduleShots() {
  const interval = 900;
  state.timer = setInterval(() => {
    if (!state.enabled || !state.ctx) return;
    const now = Date.now();
    if (now - state.lastShotAt < 1400) return;
    const w = state.weather;
    const r = Math.random();
    const outdoor = !indoorNow();
    if ((w === 'storm') && r < 0.12) {
      state.lastShotAt = now; thunder(state.ctx, state.shotBus);
    } else if ((w === 'rain') && r < 0.05) {
      state.lastShotAt = now; thunder(state.ctx, state.shotBus);
    } else if ((w === 'day' || w === 'dawn' || w === 'rainbow') && outdoor && r < 0.10) {
      state.lastShotAt = now; birdChirp(state.ctx, state.shotBus);
    } else if ((w === 'night' || w === 'starry' || w === 'dusk') && outdoor && r < 0.14) {
      state.lastShotAt = now; cricket(state.ctx, state.shotBus);
    } else if ((state.room === 'bathroom' || state.room === 'kitchen') && r < 0.05) {
      state.lastShotAt = now; waterDrip(state.ctx, state.shotBus);
    }
  }, interval);
}

export const ambience = {
  init() {
    if (state.ctx) return true;
    if (!AC) return false;
    state.ctx = new AC();
    state.master = gainNode(state.ctx, 0);
    state.roomFilter = state.ctx.createBiquadFilter();
    state.roomFilter.type = 'lowpass';
    state.roomFilter.frequency.value = 18000;
    state.bedBus = gainNode(state.ctx, 1);
    state.shotBus = gainNode(state.ctx, 0.9);
    state.roomBus = gainNode(state.ctx, 1);
    // 动作音效（脚步/水声，见 sfx.js）走自己的一条支路。
    state.sfxBus = gainNode(state.ctx, 1);
    state.sfxMaster = gainNode(state.ctx, 1);
    state.bedBus.connect(state.roomFilter);
    state.shotBus.connect(state.roomFilter);
    state.roomBus.connect(state.roomFilter);
    // 动作音效：sfxBus → sfxMaster → analyser（不经 roomFilter、不经 master）。
    // 不过 roomFilter：室内低通 1200Hz 是给风雨声「进屋」用的，
    // 脚步过了它会被闷成敲纸盒。不过 master：那个由环境音开关管着，
    // 而动作音效有自己独立的开关。
    state.sfxBus.connect(state.sfxMaster);
    state.roomFilter.connect(state.master);
    state.analyser = state.ctx.createAnalyser();
    state.analyser.fftSize = 1024;
    state.master.connect(state.analyser);
    state.sfxMaster.connect(state.analyser);
    state.analyser.connect(state.ctx.destination);
    rebuildBeds();
    applyLevels();
    scheduleShots();
    loadSamples();
    // 把上下文和总线交给动作音效模块；素材预载在 attach 里发生
    sfx.attach(state.ctx, state.sfxBus);
    return true;
  },
  setEnabled(v) {
    state.enabled = !!v;
    if (state.enabled) {
      this.init();
      if (state.ctx?.state === 'suspended') state.ctx.resume().catch(() => {});
    }
    // **只影响环境音**。动作音效有自己的开关（setSfxEnabled），
    // 早先在这里顺手调 sfx.setEnabled(state.enabled)，导致没开环境音时
    // 脚步永远不响 —— 而环境音是默认关的。
    applyLevels();
  },
  toggle() {
    this.setEnabled(!state.enabled);
    return state.enabled;
  },
  get enabled() { return state.enabled; },
  /**
   * 动作音效开关（对应 UI 的「音效」）。
   * 和 UI 上的 soundOn 是同一个概念：点击、抓取、放下、脚步、水声都归它管。
   *
   * 注意：**开音效时要自己把音频链建起来**。链的创建原本只发生在
   * setEnabled(true) 里，而环境音默认关，于是「开着音效却从没初始化过」
   * 是一个极易复现的状态 —— 用户点开音效，什么都听不到。
   */
  setSfxEnabled(v) {
    state.sfxEnabled = !!v;
    if (state.sfxEnabled) {
      this.init();   // 幂等：ctx 已存在就直接返回
      if (state.ctx?.state === 'suspended') state.ctx.resume().catch(() => {});
    }
    // 静音时连音符都别再排（增益归零也能挡住，但没必要白算节点）
    sfx.setEnabled(state.sfxEnabled);
    applyLevels();
  },
  toggleSfx() {
    this.setSfxEnabled(!state.sfxEnabled);
    return state.sfxEnabled;
  },
  get sfxEnabled() { return state.sfxEnabled; },
  get volume() { return state.volume; },
  setVolume(v) {
    state.volume = Math.max(0, Math.min(1, Number(v) || 0));
    applyLevels();
  },
  setScene({ weather, room } = {}) {
    let changed = false;
    if (weather && weather !== state.weather) { state.weather = weather; changed = true; }
    if (room && room !== state.room) { state.room = room; changed = true; }
    if (!changed) return;
    if (!state.ctx) return;
    if (weather !== undefined) rebuildBeds();
    else rebuildRoomLayer();
    applyLevels();
  },
  // 供闪电/雷雨调用的一声雷
  thunder() {
    if (!state.ctx || !state.enabled) return;
    try { thunder(state.ctx, state.shotBus); } catch { /* 忽略 */ }
  },
  setSpeaking(v) {
    if (state.speaking === !!v) return;
    state.speaking = !!v;
    applyLevels();
  },
  /** 动作音效：直接透出，免得 app.js 到处 import 两个模块。 */
  sfx,
  /** 她在画面里的横向位置 -1…1，动作音效轻微跟过去。 */
  setSfxPan(v) { sfx.setPan(v); },
  // 调试用
  debug() {
    const an = state.ctx ? state.master : null;
    return {
      enabled: state.enabled,
      volume: state.volume,
      weather: state.weather,
      room: state.room,
      indoor: indoorNow(),
      ctxState: state.ctx?.state || 'none',
      beds: state.beds.length,
      roomLayer: !!state.roomLayer,
      hasAnalyser: !!an,
      sfx: sfx.debug(),
      rms: (() => {
        const a = state.analyser;
        if (!a) return 0;
        const buf = new Float32Array(a.fftSize);
        a.getFloatTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i += 1) sum += buf[i] * buf[i];
        return Math.sqrt(sum / buf.length);
      })()
    };
  },
  /**
   * 频谱分析：返回各频段的能量占比。
   *
   * 给验收脚本用 —— "风喧宾夺主"这件事光听不好判断，得有数字：
   *   windShare = 风频段(<400Hz)能量 / 总能量
   * 优化前室内是 60~100%（别的声源被 1200Hz 低通滤光，只剩风），
   * 优化后应降到 30~45%。
   *
   * 用 analyser 的频域数据（getByteFrequencyData），按 bin 中心频率分频段积分。
   */
  spectrum({ bands = [[0, 400], [400, 1200], [1200, 2800], [2800, 8000], [8000, 24000]] } = {}) {
    const a = state.analyser;
    if (!a || !state.ctx) return null;
    const bins = new Uint8Array(a.frequencyBinCount);
    a.getByteFrequencyData(bins);
    const nyquist = state.ctx.sampleRate / 2;
    const perBin = nyquist / bins.length;
    const totals = bands.map(() => 0);
    let sum = 0;
    for (let i = 0; i < bins.length; i += 1) {
      // 字节 0~255 对应 -100~0dB，转回线性幅度后平方作为能量权重
      const db = (bins[i] / 255) * 100 - 100;
      const lin = Math.pow(10, db / 20);
      const e = lin * lin;
      const f = i * perBin;
      sum += e;
      for (let b = 0; b < bands.length; b += 1) {
        if (f >= bands[b][0] && f < bands[b][1]) { totals[b] += e; break; }
      }
    }
    return {
      bands,
      shares: totals.map((t) => (sum > 0 ? +(t / sum).toFixed(4) : 0)),
      total: +sum.toFixed(8)
    };
  }
};

// 便于无头测试
window.__ambience = ambience;
