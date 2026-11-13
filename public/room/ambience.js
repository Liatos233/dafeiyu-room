// 环境音系统：程序化底层 + 场景点缀
// 设计目标：0 素材依赖、无缝循环、随天气/房间/室内外连续变化
// 用法：
//   ambience.init()                     // 首次用户手势后调用
//   ambience.setEnabled(true)
//   ambience.setVolume(0.45)
//   ambience.setScene({ weather: 'rain', room: 'living' })
//   ambience.setSpeaking(true)          // 她说话时自动压低

const AC = window.AudioContext || window.webkitAudioContext;

const OUTDOOR_ROOMS = new Set(['pool', 'garden', 'balcony', 'yard', 'corridor']);

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
function makeRain(ctx, dest, heavy) {
  const g = gainNode(ctx);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = heavy ? 500 : 900;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = heavy ? 2400 : 3200;
  band.Q.value = 0.6;
  const src = loopSource(ctx, noiseBuffer(ctx, 4, 'white'));
  src.connect(hp);
  hp.connect(band);
  band.connect(g);
  g.connect(dest);
  src.start();
  g.gain.value = heavy ? 0.26 : 0.16;
  return { gain: g, stop: () => { try { src.stop(); } catch { /* 忽略 */ } } };
}

function makeWind(ctx, dest, { strength = 1, gust = 0.5 } = {}) {
  const g = gainNode(ctx);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 300;
  const src = loopSource(ctx, noiseBuffer(ctx, 5, 'brown'));
  src.connect(lp);
  lp.connect(g);
  g.connect(dest);
  src.start();

  // 阵风：用 LFO 推进低通与小音量
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.08 + gust * 0.12;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 260 + gust * 620;
  lfo.connect(lfoGain);
  lfoGain.connect(lp.frequency);
  lfo.start();

  const volLfo = ctx.createOscillator();
  volLfo.frequency.value = 0.05 + gust * 0.08;
  const volGain = ctx.createGain();
  volGain.gain.value = 0.018 * strength;
  volLfo.connect(volGain);
  volGain.connect(g.gain);
  volLfo.start();

  g.gain.value = 0.06 * strength;
  return {
    gain: g,
    stop: () => {
      try { src.stop(); lfo.stop(); volLfo.stop(); } catch { /* 忽略 */ }
    }
  };
}

function makeSnow(ctx, dest) {
  const g = gainNode(ctx);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 300;
  const src = loopSource(ctx, noiseBuffer(ctx, 5, 'brown'));
  src.connect(lp);
  lp.connect(g);
  g.connect(dest);
  src.start();
  g.gain.value = 0.045;

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

function makeAurora(ctx, dest) {
  const g = gainNode(ctx, 0.05);
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

// 静态房间底噪（厨房抽油烟机、卫生间、菜园虫鸣）
function makeRoomHum(ctx, dest, kind) {
  if (kind === 'kitchen') {
    const g = gainNode(ctx, 0.035);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 320;
    const src = loopSource(ctx, noiseBuffer(ctx, 4, 'pink'));
    src.connect(lp); lp.connect(g); g.connect(dest); src.start();
    return { gain: g, stop: () => { try { src.stop(); } catch { /* 忽略 */ } } };
  }
  if (kind === 'bathroom') {
    const g = gainNode(ctx, 0.02);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 900;
    const src = loopSource(ctx, noiseBuffer(ctx, 4, 'white'));
    src.connect(lp); lp.connect(g); g.connect(dest); src.start();
    return { gain: g, stop: () => { try { src.stop(); } catch { /* 忽略 */ } } };
  }
  return null;
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
const state = {
  ctx: null,
  master: null,
  roomFilter: null,
  bedBus: null,
  shotBus: null,
  roomBus: null,
  enabled: false,
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
      return [{ sample: 'rain', gain: 0.7, fallback: { type: 'rain', heavy: false } }];
    case 'storm':
      return [
        { sample: 'storm', gain: 0.75, fallback: { type: 'rain', heavy: true } },
        { proc: 'wind', gain: 0.25, opts: { strength: 1.1, gust: 0.8 } }
      ];
    case 'sleet':
      return [
        { sample: 'rain', gain: 0.35, fallback: { type: 'rain', heavy: false } },
        { sample: 'wind', gain: 0.18 }
      ];
    case 'hail':
      return [
        { sample: 'storm', gain: 0.55, fallback: { type: 'rain', heavy: true } },
        { sample: 'wind', gain: 0.25, opts: { strength: 1.2, gust: 0.8 } }
      ];
    case 'haze':
      return [{ sample: 'wind', gain: 0.16, fallback: { type: 'wind', opts: { strength: 0.4, gust: 0.1 } } }];
    case 'typhoon':
      return [
        { sample: 'storm', gain: 0.8, fallback: { type: 'rain', heavy: true } },
        { sample: 'wind', gain: 0.85 },
        { proc: 'wind', gain: 0.4, opts: { strength: 1.8, gust: 1.2 } }
      ];
    case 'blizzard':
      return [
        { sample: 'wind', gain: 0.55, fallback: { type: 'snow' } },
        { proc: 'snow', gain: 0.6 }
      ];
    case 'meteor':
      return [
        { sample: 'crickets', gain: 0.3, fallback: { proc: 'wind', gain: 0.2 } },
        { proc: 'aurora', gain: 0.5 }
      ];
    case 'snow':
      return [
        { sample: 'wind', gain: 0.22, fallback: { type: 'snow' } },
        { proc: 'snow', gain: 0.5 }
      ];
    case 'fog':
      return [{ sample: 'wind', gain: 0.2, fallback: { type: 'wind', opts: { strength: 0.5, gust: 0.2 } } }];
    case 'overcast':
      return [{ sample: 'wind', gain: 0.3, fallback: { type: 'wind', opts: { strength: 0.7, gust: 0.3 } } }];
    case 'sand':
      return [{ sample: 'wind', gain: 0.55, fallback: { type: 'wind', opts: { strength: 1.4, gust: 1 } } }];
    case 'aurora':
      return [{ proc: 'aurora', gain: 1 }];
    case 'night':
    case 'starry':
    case 'dusk':
      return [
        { sample: 'crickets', gain: 0.4, fallback: { proc: 'wind', gain: 0.3 } },
        { sample: 'wind', gain: 0.12 }
      ];
    case 'dawn':
    case 'day':
    case 'rainbow':
      return [
        { sample: 'birds', gain: 0.35, fallback: { proc: 'wind', gain: 0.5 } },
        { sample: 'wind', gain: 0.18, fallback: { type: 'wind', opts: { strength: 0.6, gust: 0.35 } } }
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
  let node = null;
  if (type === 'rain') node = makeRain(ctx, dest, entry.fallback?.heavy === true);
  else if (type === 'snow') node = makeSnow(ctx, dest);
  else if (type === 'aurora') node = makeAurora(ctx, dest);
  else node = makeWind(ctx, dest, entry.opts || entry.fallback?.opts || {});
  if (node && entry.gain !== undefined && entry.sample) {
    try { node.gain.gain.value = entry.gain; } catch { /* 忽略 */ }
  }
  return node;
}

function buildBeds() {
  const dest = state.bedBus;
  const layers = sceneLayers(state.weather);
  const nodes = [];
  for (const entry of layers) {
    if (entry.sample && sampleBuf[entry.sample]) {
      const n = makeSampleBed(entry.sample, entry.gain ?? 0.4, dest);
      if (n) { nodes.push(n); continue; }
    }
    if (entry.proc || entry.fallback) {
      const n = buildProc(entry, dest);
      if (n) nodes.push(n);
    }
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
  const hum = makeRoomHum(state.ctx, state.roomBus, state.room === 'kitchen' ? 'kitchen' : (state.room === 'bathroom' ? 'bathroom' : ''));
  if (hum) state.roomLayer = hum;
}

function indoorNow() {
  return !OUTDOOR_ROOMS.has(state.room);
}

function applyLevels() {
  if (!state.ctx) return;
  const now = state.ctx.currentTime;
  const target = state.enabled ? state.volume * (state.speaking ? 0.55 : 1) : 0;
  state.master.gain.cancelScheduledValues(now);
  state.master.gain.linearRampToValueAtTime(target, now + 0.6);
  // 室内低通
  const indoor = indoorNow();
  state.roomFilter.frequency.cancelScheduledValues(now);
  state.roomFilter.frequency.linearRampToValueAtTime(indoor ? 1200 : 18000, now + 0.8);
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
    state.bedBus.connect(state.roomFilter);
    state.shotBus.connect(state.roomFilter);
    state.roomBus.connect(state.roomFilter);
    state.roomFilter.connect(state.master);
    state.analyser = state.ctx.createAnalyser();
    state.analyser.fftSize = 1024;
    state.master.connect(state.analyser);
    state.analyser.connect(state.ctx.destination);
    rebuildBeds();
    applyLevels();
    scheduleShots();
    loadSamples();
    return true;
  },
  setEnabled(v) {
    state.enabled = !!v;
    if (state.enabled) {
      this.init();
      if (state.ctx?.state === 'suspended') state.ctx.resume().catch(() => {});
    }
    applyLevels();
  },
  toggle() {
    this.setEnabled(!state.enabled);
    return state.enabled;
  },
  get enabled() { return state.enabled; },
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
  }
};

// 便于无头测试
window.__ambience = ambience;
