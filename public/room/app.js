// 小蓝鱼的家 —— 页面表现层。
// 事实/行为在 src/home-state.js；这里只读快照、画房间、处理相机与交互。
import * as THREE from './vendor/three.module.js';
import { ambience } from './ambience.js';
import { createWorld } from './world.js';
import { SpriteActor, CLIPS } from './actor.js';
import { ACTION_GROUPS } from './action-manifest.js';
import { NAV_DATA } from './nav-data.js';
import { createGardenClient } from './garden-client.js';
import { createGardenWorld } from './garden-world.js';
import { getGardenFraming } from './garden-camera.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const SHOT = params.get('shot') === '1';
const SHOT_VIEW = params.get('shotView') || (params.get('pov') === '1' ? 'eyes' : 'overview');
const SHOT_LOOK = params.get('shotLook') || 'forward';
const INITIAL_CAM = params.get('cam');
const INITIAL_ROOM = params.get('room');
const TOKEN = params.get('token') || '';
const isTouch = matchMedia('(pointer: coarse)').matches || innerWidth < 760;
const tier = params.get('q') || (isTouch ? 'low' : 'balanced');

// 有些云端工作区把端口映射到 https://host/proxy/13100/… 这种带路径前缀的 URL。
// 页面资源是相对路径，天然能跟上；API 是绝对路径，需要把前缀补回去。
const BASE_PATH = (() => {
  const i = location.pathname.indexOf('/room/');
  return i > 0 ? location.pathname.slice(0, i) : '';
})();
const api = (path) => {
  const u = new URL(BASE_PATH && path.startsWith('/') ? BASE_PATH + path : path, location.origin);
  if (TOKEN) u.searchParams.set('token', TOKEN);
  return u.toString();
};
const withToken = api;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

// 客户端沿服务端给的路点前进：快照每 1.2 秒才来一次，靠它做插值，
// 出发那一刻就能连续移动，不再等下一次轮询。
function advanceRoute(points, start, distance) {
  if (!Array.isArray(points) || points.length < 2) return start;
  let idx = 0;
  let best = Infinity;
  // Choose the current segment, not the nearest waypoint. After a segment's
  // midpoint, nearest-waypoint prediction would skip the next corner and cut
  // through a wall or raised bed before the next server snapshot arrives.
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i], b = points[i + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1], len2 = dx * dx + dz * dz;
    const t = len2 ? clamp(((start[0] - a[0]) * dx + (start[1] - a[1]) * dz) / len2, 0, 1) : 0;
    const d = Math.hypot(a[0] + dx * t - start[0], a[1] + dz * t - start[1]);
    if (d < best) { best = d; idx = i; }
  }
  let pos = [start[0], start[1]];
  let left = Math.max(0, distance);
  for (let i = idx + 1; i < points.length; i += 1) {
    const nx = points[i][0];
    const nz = points[i][1];
    const seg = Math.hypot(nx - pos[0], nz - pos[1]);
    if (seg < 1e-6) continue;
    if (left <= seg) {
      const t = left / seg;
      return [pos[0] + (nx - pos[0]) * t, pos[1] + (nz - pos[1]) * t];
    }
    left -= seg;
    pos = [nx, nz];
  }
  return pos;
}

const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, tier === 'low' ? 1 : 1.35));
renderer.setSize(innerWidth, innerHeight, false);
renderer.shadowMap.enabled = tier !== 'low';
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
// 性能探针：headless 侧读取 draw call / 三角形 / 纹理数
renderer.info.autoReset = false;
window.__renderer = renderer;
window.__getRenderer = () => renderer;
window.__getWorld = () => world;
// 帧耗时采样（每帧记一次，供 perf 脚本读取）
window.__frames = [];
(function sampleFrames() {
  let last = performance.now();
  const loop = (t) => {
    window.__frames.push(t - last);
    last = t;
    if (window.__frames.length > 900) window.__frames.shift();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
})();

renderer.shadowMap.needsUpdate = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.04;
renderer.outputColorSpace = THREE.SRGBColorSpace;
if ('useLegacyLights' in renderer) renderer.useLegacyLights = false;

// 全局名字：取「xxx 的家」里的 xxx，供菜园等模块统一使用
const PET_NAME = (() => {
  const h1 = document.querySelector('.brand h1') || document.querySelector('h1');
  const t = (h1 && h1.textContent ? h1.textContent : '').trim();
  const m = t.match(/^(.+?)的家$/);
  return ((m ? m[1] : '小蓝鱼') || '小蓝鱼').trim();
})();
window.__PET_NAME = PET_NAME;

const world = createWorld(renderer, { quality: tier });

// ── 电视投屏（浏览器标签页 → 电视纹理）───────────────────────────────────
// 抖音网页不能可靠地 iframe 进 3D 画布；这里用用户主动选择的屏幕共享流做实时纹理，
// 选「抖音标签页」后，原标签页里滚动/刷视频，房间电视同步显示。
let tvStream = null;
let tvTexture = null;
let tvVideoEl = null;
const tvMat = world.tvScreen?.material || null;
const tvOriginalMap = tvMat?.map || null;
const tvOriginalEmissiveMap = tvMat?.emissiveMap || null;
const tvOriginalEmissiveIntensity = tvMat?.emissiveIntensity ?? 0.55;

// 投屏控制扩展：页面只发命令，真正的鼠标事件由本机 Chrome/Edge 扩展转发到抖音标签页。
let tvControlOn = false;
let tvFollowOn = false;
let tvCompanionSize = Math.max(160, Math.min(520, Number(localStorage.getItem('home-tv-companion-size')) || 320));
let tvBubbleOn = localStorage.getItem('home-tv-bubble') === '1';
let tvOpinionBusy = false;
let tvOpinionTimer = 0;
let tvOpinionWarmup = 0;
let tvBubbleTimer = 0;
let tvExtensionReady = false;
let tvCommandSeq = 0;
const tvCommandWaiters = new Map();
let tvLastMoveAt = 0;
let tvPointerStart = null;

function tvExtensionPost(data) {
  window.postMessage({ source: 'dafiyu-tv-page', ...data }, '*');
}
function sendTvCommand(action, payload = {}) {
  if (!tvStream) return Promise.reject(new Error('先打开电视投屏'));
  if (!tvExtensionReady) return Promise.reject(new Error('没有检测到投屏控制扩展；请安装 extensions/douyin-control'));
  const id = `tv-${Date.now()}-${++tvCommandSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      tvCommandWaiters.delete(id);
      reject(new Error('抖音标签页没有响应，请确认它已打开'));
    }, 3000);
    tvCommandWaiters.set(id, { resolve, reject, timer });
    tvExtensionPost({ type: 'command', id, action, payload });
  });
}
function applyTvControlPref() {
  const overlay = $('tvOverlay');
  const button = $('tvControlBtn');
  if (overlay) overlay.classList.toggle('control', tvControlOn && !!tvStream);
  if (button) {
    button.classList.toggle('active', tvControlOn && !!tvStream);
    button.textContent = tvControlOn && !!tvStream ? '控制中' : '控制';
    button.title = tvExtensionReady
      ? '在电视画面上移动/点击/滚动，把鼠标操作转发到抖音标签页'
      : '需要安装扩展 extensions/douyin-control';
  }
}
function applyTvFollow() {
  const box = $('tvCompanion');
  const video = $('tvCompanionVideo');
  const button = $('tvFollowBtn');
  const on = !!tvFollowOn && !!tvStream;
  if (box) {
    box.classList.toggle('on', on);
    box.setAttribute('aria-hidden', String(!on));
  }
  if (video) {
    if (on) video.play().catch(() => {});
    else { try { video.pause(); } catch {} }
  }
  if (button) {
    button.classList.toggle('active', on);
    button.textContent = on ? '跟随中' : '跟随一起看';
    button.setAttribute('aria-pressed', String(on));
  }
  if (!on) hideTvCompanionBubble();
  syncTvOpinionTimer();
}

function applyTvCompanionSize() {
  const box = $('tvCompanion');
  const input = $('tvCompanionSize');
  tvCompanionSize = Math.max(160, Math.min(520, Number(tvCompanionSize) || 320));
  if (box) box.style.setProperty('--tv-companion-size', `${tvCompanionSize}px`);
  if (input && Number(input.value) !== tvCompanionSize) input.value = String(tvCompanionSize);
}
function applyTvBubblePref() {
  const button = $('tvCompanionBubbleBtn');
  if (button) {
    button.classList.toggle('active', tvBubbleOn);
    button.textContent = tvBubbleOn ? '气泡 开' : '气泡 关';
    button.setAttribute('aria-pressed', String(tvBubbleOn));
  }
  if (!tvBubbleOn) hideTvCompanionBubble();
}
function hideTvCompanionBubble() {
  const bubble = $('tvCompanionBubble');
  if (bubble) bubble.hidden = true;
  if (tvBubbleTimer) { clearTimeout(tvBubbleTimer); tvBubbleTimer = 0; }
}
function showTvCompanionBubble(text) {
  if (!tvBubbleOn || !tvFollowOn || !text) return;
  const bubble = $('tvCompanionBubble');
  if (!bubble) return;
  bubble.textContent = String(text).trim().slice(0, 260);
  bubble.hidden = false;
  if (tvBubbleTimer) clearTimeout(tvBubbleTimer);
  tvBubbleTimer = setTimeout(() => { bubble.hidden = true; tvBubbleTimer = 0; }, 14_000);
}
function captureTvFrame() {
  const video = ($('tvOverlayVideo')?.videoWidth ? $('tvOverlayVideo') : tvVideoEl);
  if (!video || !video.videoWidth || video.readyState < 2) return '';
  const maxW = 1280;
  const scale = Math.min(1, maxW / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  try { ctx.drawImage(video, 0, 0, canvas.width, canvas.height); } catch { return ''; }
  return canvas.toDataURL('image/jpeg', 0.82);
}
async function requestTvOpinion(manual = false) {
  if (tvOpinionBusy) return;
  if (!tvStream || !tvFollowOn) { if (manual) toast(!tvStream ? '先打开电视投屏' : '先让她跟随一起看'); return; }
  if (!manual && document.hidden) return;
  const image = captureTvFrame();
  if (!image) { if (manual) toast('电视画面还没准备好'); return; }
  tvOpinionBusy = true;
  if (manual && tvBubbleOn) showTvCompanionBubble('……让我看看。');
  try {
    const response = await fetch(api('/api/tv/opinion'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
    const reply = String(data.reply || '').trim();
    if (!reply) throw new Error('她没说出看法');
    showTvCompanionBubble(reply);
    if (manual && !tvBubbleOn) toast(`她：${reply.slice(0, 90)}`);
  } catch (error) {
    if (manual) toast(`她没看清：${error?.message || error}`);
  } finally {
    tvOpinionBusy = false;
  }
}
function syncTvOpinionTimer() {
  if (tvOpinionTimer) { clearInterval(tvOpinionTimer); tvOpinionTimer = 0; }
  if (tvOpinionWarmup) { clearTimeout(tvOpinionWarmup); tvOpinionWarmup = 0; }
  if (!tvFollowOn || !tvBubbleOn || !tvStream) return;
  tvOpinionWarmup = setTimeout(() => { tvOpinionWarmup = 0; requestTvOpinion(false); }, 2200);
  tvOpinionTimer = setInterval(() => requestTvOpinion(false), 60_000);
}

async function takeHerToTv() {
  try {
    if (state?.her?.asleep) {
      await act('wake');
      setTimeout(() => { act('command', { room: 'living', spot: 'tv' }); }, 500);
    } else {
      act('command', { room: 'living', spot: 'tv' });
    }
  } catch { /* 状态轮询会继续；不阻断陪伴层 */ }
}

function tvContentPoint(e) {
  const video = $('tvOverlayVideo');
  if (!video) return { x: 0.5, y: 0.5 };
  const rect = video.getBoundingClientRect();
  const vw = Number(video.videoWidth) || rect.width || 1;
  const vh = Number(video.videoHeight) || rect.height || 1;
  const scale = Math.min(rect.width / vw, rect.height / vh);
  const contentW = vw * scale;
  const contentH = vh * scale;
  const left = rect.left + (rect.width - contentW) / 2;
  const top = rect.top + (rect.height - contentH) / 2;
  return {
    x: clamp((e.clientX - left) / contentW, 0, 1),
    y: clamp((e.clientY - top) / contentH, 0, 1)
  };
}

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.source !== 'dafiyu-tv-extension') return;
  if (event.data.type === 'ready') {
    tvExtensionReady = true;
    applyTvControlPref();
    return;
  }
  if (event.data.type !== 'result' || !event.data.id) return;
  const waiter = tvCommandWaiters.get(event.data.id);
  if (!waiter) return;
  clearTimeout(waiter.timer);
  tvCommandWaiters.delete(event.data.id);
  if (event.data.ok === false) waiter.reject(new Error(event.data.error || '投屏控制失败'));
  else waiter.resolve(event.data);
});
// 扩展的 content script 可能比 app.js 晚，页面主动握手并重试两次。
tvExtensionPost({ type: 'ping' });
setTimeout(() => tvExtensionPost({ type: 'ping' }), 900);
setTimeout(() => tvExtensionPost({ type: 'ping' }), 2600);

function applyTvCastChip() {
  const chip = $('tvChip');
  if (!chip) return;
  const on = !!tvStream;
  chip.classList.toggle('active', on);
  chip.setAttribute('aria-pressed', String(on));
  const state = $('tvState');
  if (state) state.textContent = on ? '投屏中' : '投屏';
  const bar = $('tvBar');
  if (bar) bar.hidden = !on;
  if (!on) {
    tvControlOn = false;
    tvFollowOn = false;
    setTvOverlayMode('off');
  }
  applyTvControlPref();
  applyTvFollow();
}

function stopTvCast(message) {
  if (tvStream) {
    const stream = tvStream;
    tvStream = null;
    try { stream.getTracks().forEach((track) => { try { track.stop(); } catch {} }); } catch {}
  }
  if (tvVideoEl) {
    try { tvVideoEl.pause(); } catch {}
    try { tvVideoEl.srcObject = null; } catch {}
    try { tvVideoEl.remove(); } catch {}
    tvVideoEl = null;
  }
  const overlayVideo = $('tvOverlayVideo');
  if (overlayVideo) {
    try { overlayVideo.pause(); } catch {}
    try { overlayVideo.srcObject = null; } catch {}
  }
  if (tvQuoteTimer) { clearTimeout(tvQuoteTimer); tvQuoteTimer = 0; }
  const quote = $('tvQuote');
  if (quote) quote.hidden = true;
  if (tvTexture) {
    try { tvTexture.dispose(); } catch {}
    tvTexture = null;
  }
  if (tvMat) {
    tvMat.map = tvOriginalMap;
    tvMat.emissiveMap = tvOriginalEmissiveMap;
    tvMat.emissiveIntensity = tvOriginalEmissiveIntensity;
    tvMat.needsUpdate = true;
  }
  tvControlOn = false;
  tvFollowOn = false;
  applyTvControlPref();
  applyTvFollow();
  applyTvCompanionSize();
applyTvBubblePref();
applyTvCastChip();
  if (message) toast(message);
}

function tvCastUnavailableReason() {
  if (!window.isSecureContext) {
    const where = location.host || location.protocol;
    return `投屏需要 HTTPS 或 localhost；当前是 ${where}。用局域网 IP 直接打开时浏览器不会弹共享窗口，请用 localhost/SSH 隧道或 HTTPS。`;
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    return '这个浏览器不支持投屏，请用桌面 Chrome / Edge，不要用手机内置浏览器';
  }
  return '';
}

async function startTvCast() {
  if (tvStream) return;
  if (!tvMat) { toast('电视屏幕还没准备好，等房间加载完再点'); return; }
  const reason = tvCastUnavailableReason();
  if (reason) { toast(reason); return; }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: false
    });
    if (!stream) return;
    tvStream = stream;
    tvVideoEl = document.createElement('video');
    tvVideoEl.muted = true;
    tvVideoEl.playsInline = true;
    tvVideoEl.autoplay = true;
    tvVideoEl.srcObject = stream;
    tvVideoEl.style.cssText = 'position:fixed;left:-2px;top:-2px;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.appendChild(tvVideoEl);
    tvVideoEl.play().catch(() => { /* 静音的 MediaStream 一般能自动播放 */ });
    tvTexture = new THREE.VideoTexture(tvVideoEl);
    tvTexture.colorSpace = THREE.SRGBColorSpace;
    tvTexture.minFilter = THREE.LinearFilter;
    tvTexture.magFilter = THREE.LinearFilter;
    tvTexture.generateMipmaps = false;
    tvMat.map = tvTexture;
    tvMat.emissiveMap = tvTexture;
    tvMat.emissiveIntensity = 0.95;
    tvMat.needsUpdate = true;
    const overlayVideo = $('tvOverlayVideo');
    if (overlayVideo) {
      overlayVideo.srcObject = stream;
      overlayVideo.play().catch(() => { /* 用户已点击，静音视频通常可以播放 */ });
    }
    const track = stream.getVideoTracks?.()[0];
    if (track) track.addEventListener('ended', () => stopTvCast('电视投屏已结束'), { once: true });
    applyTvCastChip();
    toast('已投到电视：在原标签页里打开抖音并滚动，房间电视会同步');
  } catch (error) {
    const name = String(error?.name || '');
    if (name === 'NotAllowedError' || name === 'AbortError') {
      stopTvCast();
      toast('投屏已取消：你没有选择标签页，或浏览器/系统权限拦截了屏幕共享。请点允许后重试。');
      return;
    }
    if (name === 'NotFoundError') {
      stopTvCast();
      toast('没有可共享的窗口：请打开一个抖音标签页后再点投屏');
      return;
    }
    if (name === 'NotReadableError' || name === 'SecurityError' || name === 'NotSupportedError') {
      stopTvCast();
      toast(`投屏被浏览器拦截（${name}）：请检查系统屏幕录制权限、企业策略，或换桌面 Chrome/Edge`);
      return;
    }
    tvStream = null;
    stopTvCast();
    toast(`投屏失败：${error?.message || name || '浏览器拒绝共享'}`);
  }
}

const scene = world.scene;
let gardenController = null;

// 点击移动用的透明拾取面：放在所有地面装饰之上、家具之下。
const pickFloor = new THREE.Mesh(
  new THREE.PlaneGeometry(14.4, 16.8),
  new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false })
);
pickFloor.rotation.x = -Math.PI / 2;
pickFloor.position.set(6.0, 0.12, .6);
pickFloor.name = 'pick-floor';
pickFloor.renderOrder = -1;
scene.add(pickFloor);

const clickMarker = new THREE.Mesh(
  new THREE.RingGeometry(0.17, 0.235, 36),
  new THREE.MeshBasicMaterial({ color: 0x8fc1ff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })
);
clickMarker.rotation.x = -Math.PI / 2;
clickMarker.position.set(6.6, 0.13, 4.5);
clickMarker.visible = false;
clickMarker.raycast = () => {}; // 不挡住下一次点击
scene.add(clickMarker);
let clickMarkerUntil = 0;

// 角色的统一外层：点击时对整只角色做 Q 弹/压扁，不碰地面阴影和相机。
const charWrap = new THREE.Group();
charWrap.name = 'char-wrap';
scene.add(charWrap);
let bounceAt = 0;

function bounceCharacter() {
  bounceAt = performance.now();
}

function updateBounce(now) {
  if (!bounceAt) return;
  const t = (now - bounceAt) / 420;
  if (t >= 1) {
    bounceAt = 0;
    charWrap.position.y = 0;
    charWrap.scale.set(1, 1, 1);
    return;
  }
  const e = Math.sin(t * Math.PI);
  // 只压 Y；X/Z 缩放会把角色按世界原点缩放，导致她横向漂移。
  charWrap.position.y = e * 0.055;
  charWrap.scale.set(1, 1 - e * 0.10, 1);
}
// 临时错误面板：出错时把信息画在页面上，方便无头截图定位
window.addEventListener('error', (e) => {
  try {
    document.title = 'HOME_READY';
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;background:#000;color:#f66;font:12px monospace;padding:10px;white-space:pre-wrap;max-width:92vw';
    d.textContent = `ERR ${e.message}\n${e.filename || ''}:${e.lineno}:${e.colno}\n${(e.error && e.error.stack) || ''}`.slice(0, 1200);
    document.body.appendChild(d);
  } catch { /* 忽略 */ }
});
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.08, 800);

const actorWebm = new SpriteActor(scene, {
  onEnded: () => { /* 由 syncActor 兜底 */ }
});
// 进房间就把走/跑两种姿态预取下来：否则首次跑动会在 2Mbps 链路上等首帧，
// 看起来就像「跑了但前几帧不动」。prefetch 只建隐藏 video 预热 HTTP 缓存，不参与渲染。
requestIdleCallback
  ? requestIdleCallback(() => actorWebm.prefetch(['walk', 'run_happy', 'walk_fast']))
  : setTimeout(() => actorWebm.prefetch(['walk', 'run_happy', 'walk_fast']), 1200);
// 立绘只有一个来源：视频素材（精灵图那套已全量转成 webm）
const actor = {
  _visible: true,
  get group() { return actorWebm.group; },
  get current() { return actorWebm.current; },
  get active() { return actorWebm.active; },
  setVisible(v) { actorWebm.setVisible(v); },
  prime(name) { return actorWebm.prime(name); },
  setClip(name, opts) { return actorWebm.setClip(name, opts); },
  update(dt, camera, opts) { actorWebm.update(dt, camera, opts); },
  prepareShot(name, d) { return actorWebm.prepareShot(name, d); },
  prepareShotPoster(name) { return actorWebm.prepareShotPoster ? actorWebm.prepareShotPoster(name) : Promise.resolve(); }
};
charWrap.add(actorWebm.group);
let chibi = null;
let chibiReady = false;
let chibiLoading = null;
let model3d = null;
let modelReady = false;
let modelLoading = null;
let modelQuality = 'optimized';
let modelSwitching = null;
const MODEL_URLS = Object.freeze({
  optimized: './assets/models/da-feiyu.opt.glb',
  source: './assets/models/da-feiyu.glb'
});
const CHAR_PARAM = params.get('char');
let charMode = localStorage.getItem('home-char-mode') === '3d' ? '3d' : 'webm';
// 调试/截图用：?char=webm 或 ?char=3d 显式指定立绘/模型，优先于本地偏好。
if (CHAR_PARAM === '3d' || CHAR_PARAM === 'webm') charMode = CHAR_PARAM;
const HIDE_HUD = params.get('hud') === '0';

// 成品模型优先；加载失败才退回程序化占位。默认（立绘）不加载 3D 模型。
// 两个画质档共用同一套 ModelActor，只换 GLB URL。
function ensureModel3d(quality = modelQuality) {
  if (modelReady && model3d && modelQuality === quality) return Promise.resolve(true);
  if (modelLoading) return modelLoading;
  modelLoading = import('./model-actor.js').then(async (mod) => {
    if (!mod?.ModelActor) return false;
    const url = MODEL_URLS[quality] || MODEL_URLS.optimized;
    const m = new mod.ModelActor(scene, { url, quality });
    charWrap.add(m.group);
    const ok = await m.load();
    if (!ok) { try { m.dispose(); } catch { /* 忽略 */ } return false; }
    const old = model3d;
    model3d = m;
    modelReady = true;
    modelQuality = quality;
    if (old) { try { old.dispose(); } catch { /* 忽略 */ } }
    return true;
  }).catch(() => false).finally(() => { modelLoading = null; });
  return modelLoading;
}
function ensureChibi() {
  if (chibiLoading) return chibiLoading;
  chibiLoading = import('./actor3d.js').then((mod) => {
    if (!mod?.ChibiActor) return false;
    chibi = new mod.ChibiActor(scene);
    charWrap.add(chibi.group);
    chibiReady = true;
    return true;
  }).catch(() => false);
  return chibiLoading;
}
async function ensure3d(quality = modelQuality) {
  if (await ensureModel3d(quality)) return true;
  return ensureChibi();
}
function updateModelQualityChip(loading = false) {
  const button = $('modelQualityChip');
  const stateEl = $('modelQualityState');
  if (!button) return;
  const high = modelQuality === 'source';
  button.classList.toggle('active', high);
  button.setAttribute('aria-pressed', String(high));
  button.disabled = loading;
  button.title = high
    ? '当前：高画质 58.9 MB 原始模型；点击切回 6.7 MB 标准模型'
    : '当前：标准 6.7 MB；点击加载 58.9 MB 原始模型（首次较慢）';
  if (stateEl) stateEl.textContent = loading ? '加载中…' : high ? '高画质' : '标准';
}

async function switchModelQuality() {
  if (modelSwitching || modelLoading) return;
  const next = modelQuality === 'source' ? 'optimized' : 'source';
  const previousMode = charMode;
  const previousQuality = modelQuality;
  modelSwitching = next;
  updateModelQualityChip(true);
  toast(next === 'source'
    ? '正在加载 58.9 MB 原始模型，首次会比较久…'
    : '正在切回 6.7 MB 标准模型…');
  try {
    // 如果当前还在加载标准模型，等它结束后再加载目标档；不能误报成功。
    let ok = await ensureModel3d(next);
    if (ok && modelQuality !== next) ok = await ensureModel3d(next);
    if (!ok) {
      toast(next === 'source' ? '原始模型加载失败，继续用标准模型' : '模型切换失败');
      if (!modelReady && previousQuality === 'optimized') await ensureModel3d('optimized').catch(() => false);
      if (!modelReady) {
        charMode = previousMode;
        document.querySelectorAll('#modeChip button').forEach((x) => x.classList.toggle('on', x.dataset.mode === charMode));
      }
    } else {
      charMode = '3d';
      document.querySelectorAll('#modeChip button').forEach((x) => x.classList.toggle('on', x.dataset.mode === charMode));
      applySpriteViewPref();
      applyCharVisibility();
      syncCharacter();
      focusCharacter();
      toast(next === 'source' ? '已切换高画质：原始模型 58.9 MB' : '已切回标准画质：6.7 MB');
    }
  } catch (error) {
    toast(`模型切换失败：${error?.message || error}`);
  } finally {
    modelSwitching = null;
    updateModelQualityChip(false);
    applyCharVisibility();
  }
}

function use3dActive() { return charMode === '3d' && (modelReady || chibiReady); }
function applyCharVisibility() {
  const eyes = VIEW.mode === 'eyes';
  const use = use3dActive();
  actor.setVisible(!eyes && !use);
  model3d?.setVisible(!eyes && charMode === '3d' && modelReady);
  chibi?.setVisible(!eyes && charMode === '3d' && !modelReady && chibiReady);
}

// ── 相机 ──────────────────────────────────────────────────────────────────
const VIEW = {
  target: new THREE.Vector3(6.7, 0.35, 4.6),
  az: -0.62,
  elev: 1.0,
  radius: 19.2,
  mode: 'overview',
  fpRoom: 'living',
  fpPos: new THREE.Vector3(4.7, 1.55, 7.0),
  fpLook: new THREE.Vector3(7.2, 1.05, 2.2),
  fpYaw: 0,
  fpPitch: 0,
  follow: false,
  shot: false
};
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3(6.4, 1.0, 4.35);
const desiredPos = new THREE.Vector3();
const desiredLook = new THREE.Vector3();

// 房间照片用的近景机位：给 QQ 发图时，重点是她和所在的房间，而不是整张大平层平面图。
const ROOM_CAM = {
  living: { center: [6.3, 4.3], az: -0.72, elev: 0.8, r: 8.2 },
  kitchen: { center: [2.0, 2.1], az: 0.65, elev: 0.78, r: 7.0 },
  dining: { center: [2.1, 5.1], az: 0.55, elev: 0.78, r: 6.8 },
  her_room: { center: [10.8, 2.2], az: -0.75, elev: 0.78, r: 7.6 },
  corridor: { center: [10.4, 5.0], az: 0.55, elev: 0.8, r: 6.0 },
  bathroom: { center: [12.0, 6.9], az: -0.6, elev: 0.76, r: 5.4 },
  laundry: { center: [9.6, 6.5], az: 0.5, elev: 0.78, r: 5.2 },
  balcony: { center: [4.6, 8.2], az: 0.15, elev: 0.72, r: 7.0 },
  foyer: { center: [1.0, 6.2], az: -0.55, elev: 0.76, r: 5.2 },
  garden: { center: [6.6, -3.8], az: -2.92, elev: .85, r: 9.2 },
  yard: { center: [-.65, 3.0], az: -1.8, elev: .75, r: 7 }
};

const FP_PRESETS = {
  living: { pos: [4.7, 1.55, 7.05], look: [7.2, 1.05, 2.1], label: '客厅' },
  kitchen: { pos: [3.9, 1.55, 3.25], look: [0.8, 1.0, 0.9], label: '厨房' },
  dining: { pos: [0.75, 1.55, 6.95], look: [2.6, 1.0, 4.6], label: '餐厅' },
  her_room: { pos: [8.75, 1.55, 4.15], look: [11.6, 0.95, 1.15], label: '她的房间' },
  corridor: { pos: [12.9, 1.55, 5.0], look: [8.6, 1.2, 5.0], label: '走廊' },
  bathroom: { pos: [12.85, 1.55, 5.8], look: [11.1, 1.0, 7.4], label: '卫生间' },
  laundry: { pos: [9.0, 1.55, 5.8], look: [10.4, 1.0, 7.0], label: '家政间' },
  balcony: { pos: [7.55, 1.55, 7.85], look: [1.8, 1.1, 8.8], label: '阳台' },
  pool: { pos: [12.45, 1.62, 11.3], look: [0.6, 1.02, 11.3], label: '泳池露台' },
  foyer: { pos: [1.55, 1.55, 6.9], look: [0.15, 1.2, 5.55], label: '玄关' },
  garden: { pos: [.72, 1.55, -3.6], look: [6.2, .85, -4.6], label: '菜园' },
  yard: { pos: [-.65, 1.55, 3], look: [-.65, 1, -3.6], label: '屋外小径' }
};
function setFP(room, snap = true) {
  if (room === 'garden' && gardenController) {
    gardenController.setOpen(true);
    return;
  }
  const p = FP_PRESETS[room] || FP_PRESETS.living;
  VIEW.fpRoom = FP_PRESETS[room] ? room : 'living';
  if (snap) {
    VIEW.fpPos.set(...p.pos);
    VIEW.fpLook.set(...p.look);
    const d = new THREE.Vector3().subVectors(VIEW.fpLook, VIEW.fpPos);
    VIEW.fpYaw = Math.atan2(d.x, d.z);
    VIEW.fpPitch = Math.asin(clamp(d.y / d.length(), -1, 1));
  }
  updateRoomsUI();
}
function applyRoomLabels() {
  const visible = roomLabelsOn && VIEW.mode === 'overview' && !VIEW.shot && !VIEW.garden;
  world.setLabelsVisible(visible);
  const btn = document.getElementById('roomLabelBtn');
  if (btn) {
    btn.textContent = roomLabelsOn ? '房间名：开' : '房间名：关';
    btn.setAttribute('aria-pressed', String(roomLabelsOn));
  }
}
function setRoomLabels(on) {
  roomLabelsOn = !!on;
  try { localStorage.setItem('home-labels', roomLabelsOn ? '1' : '0'); } catch {}
  applyRoomLabels();
}

function setMode(mode, requestedRoom = null) {
  VIEW.mode = mode;
  if (mode !== 'overview') VIEW.follow = false;
  document.querySelectorAll('#cams button').forEach((b) => b.classList.toggle('active', b.dataset.cam === mode));
  const fp = mode === 'first';
  $('rooms').classList.toggle('show', fp);
  world.setCeilingVisible(mode !== 'overview');
  applyRoomLabels();
  if (fp) setFP(requestedRoom || state?.her?.room || VIEW.fpRoom);
  if (mode === 'eyes') {
    $('bubble').classList.remove('show');
    eyesPrev = null;   // 刚切进她的视角：不要拿旧位置算方向
  }
}
function resetView() {
  VIEW.follow = false;
  setMode('overview');
  VIEW.az = -0.62; VIEW.elev = 1.02; VIEW.radius = 19.2;
  VIEW.target.set(6.7, 0.35, 4.6);
}
// 切到 3D 时给一个「在她正面偏侧」的半身机位：静态模型坐在沙发上也不会被靠背挡住。
function focusCharacter() {
  const her = state?.her;
  if (!her) return;
  const facing = (Number(her.facing) || 0) * Math.PI / 180;
  VIEW.follow = true;
  VIEW.mode = 'overview';
  document.querySelectorAll('#cams button').forEach((b) => b.classList.toggle('active', b.dataset.cam === 'overview'));
  world.setCeilingVisible(false);
  applyRoomLabels();
  $('rooms').classList.remove('show');
  VIEW.target.set(her.pos[0], (her.elev || 0) + 0.8, her.pos[1]);
  VIEW.az = Math.PI - facing + 0.42;
  VIEW.elev = 0.6;
  VIEW.radius = 5.0;
}

function updateCamera(dt) {
  if (VIEW.mode === 'overview' || VIEW.shot) {
    if (VIEW.follow && !VIEW.shot && state?.her) {
      const h = state.her;
      const dp = lastDisplayPos || h.pos;
      VIEW.target.lerp(new THREE.Vector3(dp[0], (h.elev || 0) + 0.8, dp[1]), Math.min(1, dt * 3.2));
    }
    const az = VIEW.shot ? -0.58 : VIEW.az;
    const elev = VIEW.shot ? 1.0 : VIEW.elev;
    const r = VIEW.shot ? 18.8 : VIEW.radius;
    const cy = Math.sin(elev) * r;
    const horiz = Math.cos(elev) * r;
    desiredPos.set(
      VIEW.target.x + Math.sin(az) * horiz,
      VIEW.target.y + cy,
      VIEW.target.z + Math.cos(az) * horiz
    );
    desiredLook.copy(VIEW.target);
  } else if (VIEW.mode === 'first') {
    desiredPos.copy(VIEW.fpPos);
    const dir = new THREE.Vector3(
      Math.sin(VIEW.fpYaw) * Math.cos(VIEW.fpPitch),
      Math.sin(VIEW.fpPitch),
      Math.cos(VIEW.fpYaw) * Math.cos(VIEW.fpPitch)
    );
    desiredLook.copy(VIEW.fpPos).add(dir.multiplyScalar(5));
  } else {
    // 她的视角：朝向跟随「实际移动方向」，不跟立绘翻转（立绘走路时会突然掉头）
    const her = state?.her;
    if (her) {
      const eye = her.asleep ? 0.86 : 1.22;
      const dp = lastDisplayPos || her.pos;
      let tx = 0;
      let tz = 0;
      if (eyesPrev) {
        const dx = dp[0] - eyesPrev[0];
        const dz = dp[1] - eyesPrev[1];
        const d = Math.hypot(dx, dz);
        if (d > 0.004) { tx = dx / d; tz = dz / d; }   // 正在移动 → 用位移方向
      }
      if (!tx && !tz) {
        const f = (her.facing || 0) * Math.PI / 180;   // 静止 → 才用立绘朝向
        tx = Math.sin(f);
        tz = -Math.cos(f);
      }
      eyesPrev = [dp[0], dp[1]];
      // 平滑转向，避免路点拐弯时镜头猛甩
      const s = Math.min(1, dt * 7);
      eyesDir.x += (tx - eyesDir.x) * s;
      eyesDir.z += (tz - eyesDir.z) * s;
      const len = Math.hypot(eyesDir.x, eyesDir.z) || 1;
      const nx = eyesDir.x / len;
      const nz = eyesDir.z / len;
      desiredPos.set(dp[0], eye, dp[1]);
      desiredLook.set(dp[0] + nx * 4, eye - 0.35, dp[1] + nz * 4);
    } else {
      desiredPos.set(6.3, 1.5, 5.0);
      desiredLook.set(6.3, 1.2, 2.0);
    }
  }
  const k = 1 - Math.pow(VIEW.mode === 'eyes' ? 0.00002 : 0.0008, Math.min(dt, 0.06));
  camPos.lerp(desiredPos, k);
  camLook.lerp(desiredLook, k);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
}

// 初始化相机位置，避免第一帧从原点飞过来
(() => {
  const cy = Math.sin(VIEW.elev) * VIEW.radius;
  const horiz = Math.cos(VIEW.elev) * VIEW.radius;
  camPos.set(VIEW.target.x + Math.sin(VIEW.az) * horiz, VIEW.target.y + cy, VIEW.target.z + Math.cos(VIEW.az) * horiz);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
})();

// ── 输入 ──────────────────────────────────────────────────────────────────
let dragging = false;
let charPress = null;
let charPressTimer = 0;
let charDrag = null;
let placeHold = null;
let last = { x: 0, y: 0 };
let moved = 0;

// 开放视角：用移动键改变观察位置/方向，不依赖右键拖拽。
const openViewKeys = new Set();
let openViewBoost = false;
const OPEN_VIEW_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
function openViewTypingTarget(target) {
  if (!target) return false;
  const tag = String(target.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}
function updateOpenView(dt) {
  if (!cameraUsesKeyboard() || SHOT || VIEW.mode !== 'overview') return;
  const boost = openViewBoost ? 2.1 : 1;
  const pan = Math.min(0.12, Math.max(0, dt)) * 3.6 * boost;
  const turn = Math.min(0.12, Math.max(0, dt)) * 1.35 * boost;
  const tilt = Math.min(0.12, Math.max(0, dt)) * 0.85 * boost;
  const rightX = Math.cos(VIEW.az);
  const rightZ = -Math.sin(VIEW.az);
  const forwardX = -Math.sin(VIEW.az);
  const forwardZ = -Math.cos(VIEW.az);
  if (openViewKeys.has('KeyW')) { VIEW.target.x += forwardX * pan; VIEW.target.z += forwardZ * pan; }
  if (openViewKeys.has('KeyS')) { VIEW.target.x -= forwardX * pan; VIEW.target.z -= forwardZ * pan; }
  if (openViewKeys.has('KeyD')) { VIEW.target.x += rightX * pan; VIEW.target.z += rightZ * pan; }
  if (openViewKeys.has('KeyA')) { VIEW.target.x -= rightX * pan; VIEW.target.z -= rightZ * pan; }
  if (openViewKeys.has('ArrowLeft')) VIEW.az += turn;
  if (openViewKeys.has('ArrowRight')) VIEW.az -= turn;
  if (openViewKeys.has('ArrowUp')) VIEW.elev = clamp(VIEW.elev + tilt, 0.06, 1.45);
  if (openViewKeys.has('ArrowDown')) VIEW.elev = clamp(VIEW.elev - tilt, 0.06, 1.45);
  VIEW.target.x = clamp(VIEW.target.x, -4, 15);
  VIEW.target.z = clamp(VIEW.target.z, -9.5, 11);
  VIEW.target.y = clamp(VIEW.target.y, 0.15, 2.6);
}
function clearOpenViewKeys() {
  openViewKeys.clear();
  openViewBoost = false;
}
window.addEventListener('keydown', (e) => {
  if (!cameraUsesKeyboard() || SHOT) return;
  if (e.key === 'Shift') { openViewBoost = true; return; }
  if (!OPEN_VIEW_CODES.has(e.code)) return;
  if (openViewTypingTarget(e.target) || openViewTypingTarget(document.activeElement)) return;
  e.preventDefault();
  openViewKeys.add(e.code);
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'Shift') { openViewBoost = false; return; }
  openViewKeys.delete(e.code);
});
window.addEventListener('blur', clearOpenViewKeys);
document.addEventListener('visibilitychange', () => { if (document.hidden) clearOpenViewKeys(); });

function clearCharPress() {
  if (charPressTimer) {
    clearTimeout(charPressTimer);
    charPressTimer = 0;
  }
  charPress = null;
}

function legalDragPoint(p) {
  const rooms = state?.layout?.rooms;
  if (!Array.isArray(rooms) || !rooms.length) {
    return [clamp(p[0], 0.3, 12.9), clamp(p[1], 0.3, 8.7)];
  }
  for (const room of rooms) {
    const [x0, z0, x1, z1] = room.bounds;
    if (p[0] >= x0 && p[0] <= x1 && p[1] >= z0 && p[1] <= z1) {
      if (room.id === 'garden' || room.id === 'yard') {
        // 和房间一样连续跟随鼠标；不要每一步都吸附到最近的菜畦/门口，
        // 否则拖拽会一跳一跳。服务端 place 会保留这个自由落点。
        const pad = 0.18;
        return [
          Math.min(x1 - pad, Math.max(x0 + pad, p[0])),
          Math.min(z1 - pad, Math.max(z0 + pad, p[1]))
        ];
      }
      return [p[0], p[1]];
    }
  }
  let best = rooms[0];
  let bestD = Infinity;
  for (const room of rooms) {
    const [x0, z0, x1, z1] = room.bounds;
    const d = Math.hypot(p[0] - (x0 + x1) / 2, p[1] - (z0 + z1) / 2);
    if (d < bestD) { bestD = d; best = room; }
  }
  const [x0, z0, x1, z1] = best.bounds;
  return [clamp(p[0], x0 + 0.22, x1 - 0.22), clamp(p[1], z0 + 0.22, z1 - 0.22)];
}

function beginCharDrag() {
  if (!charPress || !dragging || SHOT) return;
  const e = { clientX: charPress.lastX, clientY: charPress.lastY };
  const base = (lastDisplayPos || state?.her?.pos || [6.3, 5.1]).slice();
  const fp = floorPointAt(e) || base;
  charDrag = {
    active: true,
    pos: base.slice(),
    offset: [base[0] - fp[0], base[1] - fp[1]]
  };
  clearCharPress();
  dragging = false;
  canvas.classList.remove('dragging');
  canvas.classList.add('grabbing');
  if (charMode === 'webm') {
    try { actor.setClip('react_scare'); } catch { /* 忽略 */ }
  }
  showClickMarker(base);
  playPickup();
  toast('按住拖动她，松手放下');
}

function updateCharDrag(e) {
  if (!charDrag?.active) return;
  const fp = floorPointAt(e);
  if (!fp) return;
  charDrag.pos = legalDragPoint([fp[0] + charDrag.offset[0], fp[1] + charDrag.offset[1]]);
  showClickMarker(charDrag.pos);
}

function finishCharDrag(e) {
  if (!charDrag?.active) return;
  if (e) updateCharDrag(e);
  const p = charDrag.pos.slice();
  charDrag = null;
  canvas.classList.remove('grabbing');
  placeHold = { pos: p, until: performance.now() + 1800 };
  lastDisplayPos = p.slice();
  showClickMarker(p);
  playDrop();
  bounceCharacter();
  act('place', { pos: p, free: true });
}

function cancelCharDrag() {
  charDrag = null;
  clearCharPress();
  canvas.classList.remove('grabbing');
  try { syncCharacter(); } catch { /* 恢复当前片段 */ }
}

canvas.addEventListener('pointerdown', (e) => {
  if (SHOT || charDrag?.active) return;
  if (e.button !== 0) return;
  // 有 UI 浮在画布上方时（按钮、面板、气泡），不要当成点地面
  if (typeof document.elementFromPoint === 'function'
    && document.elementFromPoint(e.clientX, e.clientY) !== canvas) return;
  if (soundOn) unlockAudio();
  dragging = true;
  moved = 0;
  last = { x: e.clientX, y: e.clientY };
  canvas.classList.add('dragging');
  try { canvas.setPointerCapture?.(e.pointerId); } catch { /* 合成事件/无活动指针 */ }
  // 点在角色身上：先挂 330ms 长按；移动超过阈值就作废，交给相机拖拽。
  if (charHit(e) && !state?.her?.asleep) {
    clearCharPress();
    charPress = { startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY };
    charPressTimer = setTimeout(() => {
      charPressTimer = 0;
      beginCharDrag();
    }, 330);
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (charDrag?.active) { updateCharDrag(e); return; }
  if (!dragging) return;
  const dx = e.clientX - last.x;
  const dy = e.clientY - last.y;
  last = { x: e.clientX, y: e.clientY };
  moved += Math.abs(dx) + Math.abs(dy);
  if (charPress) {
    charPress.lastX = e.clientX;
    charPress.lastY = e.clientY;
    if (Math.hypot(e.clientX - charPress.startX, e.clientY - charPress.startY) > 8) clearCharPress();
  }
  if (!isTouch && !cameraUsesMouse()) return;
  if (VIEW.mode === 'overview') {
    VIEW.az -= dx * 0.0045;
    VIEW.elev = clamp(VIEW.elev + dy * 0.0035, -0.62, 1.42);
  } else if (VIEW.mode === 'first') {
    VIEW.fpYaw -= dx * 0.004;
    VIEW.fpPitch = clamp(VIEW.fpPitch - dy * 0.003, -1.15, 1.25);
  }
});
canvas.addEventListener('pointerup', (e) => {
  if (charDrag?.active) { finishCharDrag(e); return; }
  const wasDragging = dragging;
  dragging = false;
  clearCharPress();
  canvas.classList.remove('dragging');
  if (!wasDragging || SHOT) return;
  if (moved < 5) onClick(e);
});
canvas.addEventListener('pointercancel', () => {
  dragging = false;
  clearCharPress();
  if (charDrag) cancelCharDrag();
  canvas.classList.remove('dragging', 'grabbing');
});
canvas.addEventListener('lostpointercapture', () => {
  if (charDrag) cancelCharDrag();
  clearCharPress();
  dragging = false;
  canvas.classList.remove('dragging', 'grabbing');
});
canvas.addEventListener('wheel', (e) => {
  if (SHOT) return;
  e.preventDefault();
  if (VIEW.mode === 'overview') VIEW.radius = clamp(VIEW.radius + e.deltaY * 0.012, 2.5, gardenController?.isOpen ? 90 : 60);
}, { passive: false });
canvas.addEventListener('dblclick', () => { if (!SHOT) { if (gardenController?.isOpen) focusGarden(); else resetView(); } });

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function hotspotAt(e) {
  ndc.x = (e.clientX / innerWidth) * 2 - 1;
  ndc.y = -(e.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(world.hotspots, false);
  return hits[0]?.object?.userData?.hotspot || null;
}
function charHit(e) {
  if (!state?.her) return false;
  const dp = lastDisplayPos || state.her.pos;
  const p = new THREE.Vector3(dp[0], (state.her.elev || 0) + 0.85, dp[1]);
  p.project(camera);
  if (p.z > 1) return false;
  const x = (p.x * 0.5 + 0.5) * innerWidth;
  const y = (-p.y * 0.5 + 0.5) * innerHeight;
  return Math.hypot(x - e.clientX, y - e.clientY) < (isTouch ? 80 : 58);
}
// 沙发、床等家具体积上点到的位置不可走：命中家具禁区就当作「点不动」。
function blockedByFurniture(p) {
  const keep = NAV_DATA?.keepout || [];
  for (const item of keep) {
    const M = 0.15; // 稍微放大一点，点到家具边缘也算不可走
    const [x0, z0, x1, z1] = item.rect;
    if (p[0] >= x0 - M && p[0] <= x1 + M && p[1] >= z0 - M && p[1] <= z1 + M) return true;
  }
  return false;
}

function onClick(e) {
  if (typeof document.elementFromPoint === 'function'
    && document.elementFromPoint(e.clientX, e.clientY) !== canvas) return;
  if (gardenController?.handlePointer(e)) return;
  if (VIEW.mode === 'eyes') return;
  // 点角色优先于点击移动：轻点永远是 Q 弹 + 摸头，不会误触地板。
  if (charHit(e)) {
    playClick();
    bounceCharacter();
    act('pet');
    return;
  }
  if (gardenController?.isOpen) {
    if (!clickMoveOn) return;
    const p = floorPointAt(e);
    if (!p) { toast('点菜园地面，别点房子或围栏'); return; }
    if (blockedByFurniture(p)) { toast('去不了这里'); return; }
    showClickMarker(p);
    playTap();
    requestGo(p);
    return;
  }
  if (clickMoveOn) {
    $('info').classList.add('hide');
    const p = floorPointAt(e);
    if (!p) { toast('点地面，别点墙或家具'); return; }
    if (blockedByFurniture(p)) { toast('去不了这里'); return; }
    showClickMarker(p);
    playTap();
    requestGo(p);
    return;
  }
  const hs = hotspotAt(e);
  if (hs) { showInfo(hs); return; }
  $('info').classList.add('hide');
}

// ── 数据 / 表现 ───────────────────────────────────────────────────────────
let state = null;
let roomView = null;
let petActionOverride = null;
let pendingGo = null;
let pendingGoAt = 0;   // 动作播放期间点地面：等动作演完再走

function requestGo(pos) {
  if (petActionOverride) {
    pendingGo = pos;
    pendingGoAt = Date.now();
    toast('她马上就过去');
    return;
  }
  void act('go', { pos });
}

function flushPendingGo() {
  if (!pendingGo) return;
  if (petActionOverride) return;
  const pos = pendingGo;
  const waited = Date.now() - (pendingGoAt || 0);
  pendingGo = null;
  // 太久的排队目标作废，避免“过了一会儿突然自己跑走”
  if (waited > 15000) return;
  void act('go', { pos });
}

let requestInFlight = false;
let lastActivity = '';
let bubbleUntil = 0;
let bubbleAnchorPos = null;   // 坐姿覆盖时气泡要跟着覆盖位置
let bubbleAnchorElev = 0;
// 当前气泡的类别：action=动作过渡文案（下一次状态刷新会被真实 activity 接管）；talk=她主动说的话；activity=活动/动作标签。
let bubbleKind = '';
// 动作气泡的时间戳：界定「到站后接管」的有效窗口，避免过期的动作文案一直占位。
let bubbleKindAt = 0;
let lastSleep = false;
let flipState = false;   // 侧跑朝向：跟随镜头横向方向，带滞回
let motionWalking = false;   // 真正在移动（按画面位移判断，不依赖轮询状态）
let walkPrevPos = null;
let stillMs = 0;
let sleepPhase = 'none';
let lastOnceKey = '';
let lastOnceAt = 0;
let opinionUntil = 0;
let opinionClip = '';
let opinionTimer = 0;
let tvOverlayMode = 'off';
let tvQuoteTimer = 0;
let pendingAction = '';
let bubbleOn = localStorage.getItem('home-bubble') !== '0';
if (params.get('bubble') === '0') bubbleOn = false;
let clickMoveOn = localStorage.getItem('home-click-move') === '1';
const CAMERA_MODES = new Set(['open', 'left', 'both']);
const CAMERA_MODE_SAVED = (() => {
  const saved = localStorage.getItem('home-camera-mode');
  if (CAMERA_MODES.has(saved)) return saved;
  // 兼容旧版“开放视角开/关”：开=只用键盘，关=原来的左键视角。
  return localStorage.getItem('home-free-cam') === '1' ? 'open' : 'left';
})();
let cameraMode = CAMERA_MODE_SAVED;
function cameraUsesKeyboard() { return cameraMode === 'open' || cameraMode === 'both'; }
function cameraUsesMouse() { return cameraMode === 'left' || cameraMode === 'both'; }
if (params.get('clickmove') === '1') clickMoveOn = true;
if (params.get('clickmove') === '0') clickMoveOn = false;
let soundOn = localStorage.getItem('home-sound') !== '0';
if (params.get('sound') === '0') soundOn = false;
let spriteView = localStorage.getItem('home-sprite-view') === 'free' ? 'free' : 'front';
if (params.get('view') === 'free') spriteView = 'free';
if (params.get('view') === 'front') spriteView = 'front';
let lastBackView = null;
let lastViewZone = null;
let audioCtx = null;
// ── 环境音：默认关，用户点开才响（浏览器也需要一次手势）
const ambienceOn = localStorage.getItem('home-ambience') === '1';
const ambienceVol = Number(localStorage.getItem('home-ambience-vol') || 45) / 100;
function paintAmbience() {
  const st = document.getElementById('ambienceState');
  const chip = document.getElementById('ambienceChip');
  if (st) st.textContent = ambience.enabled ? '开' : '关';
  if (chip) chip.setAttribute('aria-pressed', ambience.enabled ? 'true' : 'false');
  const volState = document.getElementById('ambienceVolState');
  const vol = document.getElementById('ambienceVol');
  if (volState) volState.textContent = `${Math.round(ambience.volume * 100)}%`;
  if (vol) vol.value = String(Math.round(ambience.volume * 100));
}
let ambienceBooted = false;
function bootAmbience() {
  if (ambienceBooted) return;
  ambienceBooted = true;
  ambience.init();
  ambience.setVolume(ambienceVol);
  if (ambienceOn) ambience.setEnabled(true);
  paintAmbience();
}
document.addEventListener('pointerdown', bootAmbience, { once: true });
document.addEventListener('keydown', bootAmbience, { once: true });
function bindAmbienceUi() {
  const chip = document.getElementById('ambienceChip');
  chip?.addEventListener('click', () => {
    bootAmbience();
    ambience.toggle();
    localStorage.setItem('home-ambience', ambience.enabled ? '1' : '0');
    paintAmbience();
  });
  const vol = document.getElementById('ambienceVol');
  vol?.addEventListener('input', () => {
    const v = Number(vol.value) / 100;
    ambience.setVolume(v);
    localStorage.setItem('home-ambience-vol', String(Math.round(v * 100)));
    paintAmbience();
  });
  paintAmbience();
}
// 模块可能在 load 之后才执行，直接绑；没绑上再等 DOMContentLoaded
bindAmbienceUi();

const clickSfx = new Audio('assets/sound/click-duck.wav');
clickSfx.preload = 'auto';
clickSfx.volume = 0.38;

function unlockAudio() {
  if (!soundOn) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  } catch { /* 浏览器禁用音频 */ }
}

function playClick() {
  if (!soundOn) return;
  try {
    const a = new Audio(clickSfx.src);
    a.volume = clickSfx.volume;
    a.play().catch(() => {});
  } catch { /* 忽略 */ }
}

function playTone({ from = 440, to = from, dur = 0.12, vol = 0.07, type = 'sine' } = {}) {
  if (!soundOn) return;
  unlockAudio();
  if (!audioCtx) return;
  try {
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(from, t);
    if (to !== from) o.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start(t);
    o.stop(t + dur + 0.03);
  } catch { /* 忽略 */ }
}

function playPickup() { playTone({ from: 430, to: 690, dur: 0.10, vol: 0.055, type: 'sine' }); }
function playDrop() { playTone({ from: 190, to: 105, dur: 0.16, vol: 0.085, type: 'triangle' }); }
function playTap() { playTone({ from: 520, to: 610, dur: 0.065, vol: 0.032, type: 'sine' }); }
let walkPredict = null;
let lastDisplayPos = null;

// 事件文案统一成「你」的视角（也兼容历史数据里的旧文案）
function toSecondPerson(text) {
  let t = String(text || '');
  const table = [
    [/^有人帮你把灯关了/, '你把灯关闭了'],
    [/^有人帮你把灯打开了/, '你把灯打开了'],
    [/^有人摸了摸你的头/, '你摸了摸她的头'],
    [/^有人戳了你一下/, '你戳了她一下'],
    [/^有人喂了你(一块小鱼干)?/, '你喂了她$1'],
    [/^有人喂你吃了/, '你喂她吃了'],
    [/^有人陪你在屋里玩了一会儿/, '你陪她玩了一会儿'],
    [/^有人哄你睡觉/, '你哄她睡觉'],
    [/^有人把你叫醒了/, '你把她叫醒了'],
    [/^有人让你去/, '你让她去'],
    [/^有人来你的小屋坐了坐/, '你来小屋坐了坐'],
    [/^有人来/, '你来'],
    [/^有人留了句话/, '你留了句话'],
    [/^有人动了你的灯/, '你动了她的灯']
  ];
  for (const [re, rep] of table) if (re.test(t)) { t = t.replace(re, rep); break; }
  return t.replace(/^有人/, '你');
}

function fmtAgo(min) {
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  return `${Math.floor(min / 60)} 小时前`;
}

const SKY_PRESETS = {
  day: 12, dusk: 18.2, night: 23, dawn: 6.2,
  rain: 15, overcast: 13, fog: 7.5, snow: 10,
  storm: 18, starry: 23, rainbow: 17, sand: 14, aurora: 23,
  sleet: 12, hail: 13, haze: 9, blizzard: 10, meteor: 23
};
// 天气菜单只放「天气」，时段（黎明/白天/黄昏/夜晚）由时间决定，不在这里选
const SKY_ORDER = ['day', 'rain', 'overcast', 'fog', 'snow', 'storm', 'starry', 'rainbow', 'sand', 'aurora', 'sleet', 'hail', 'haze', 'blizzard', 'meteor'];
const SKY_LABEL = {
  day: '晴天', dusk: '黄昏', night: '夜晚', dawn: '黎明',
  rain: '雨天', overcast: '阴天', fog: '雾天', snow: '雪天',
  storm: '雷雨', starry: '星空', rainbow: '彩虹', sand: '沙尘', aurora: '极光',
  sleet: '雨夹雪', hail: '冰雹', haze: '霾', blizzard: '暴雪', meteor: '流星雨'
};
const SKY_ICON = {
  day: '☀️', dusk: '🌅', night: '🌙', dawn: '🌄',
  rain: '🌧️', overcast: '☁️', fog: '🌫️', snow: '❄️',
  storm: '⛈️', starry: '✨', rainbow: '🌈', sand: '🌪️', aurora: '🌌',
  sleet: '🌨️', hail: '🧊', haze: '😶‍🌫️', blizzard: '❄️', meteor: '☄️'
};
// 每种天气对应的世界渲染模式
const WEATHER_OF = {
  day: 'clear', dusk: 'clear', night: 'clear', dawn: 'clear',
  rain: 'rain', overcast: 'overcast', fog: 'fog', snow: 'snow',
  storm: 'storm', starry: 'starry', rainbow: 'rainbow', sand: 'sand', aurora: 'aurora',
  sleet: 'sleet', hail: 'hail', haze: 'haze', blizzard: 'blizzard', meteor: 'meteor'
};
// ── 自动天气：按权重轮换，每次持续 AUTO_MIN~AUTO_MAX 分钟
const AUTO_WEIGHTS = [
  ['day', 30], ['overcast', 14], ['rain', 14], ['snow', 8], ['fog', 5],
  ['storm', 5], ['starry', 6], ['rainbow', 4], ['sand', 3], ['sleet', 4],
  ['hail', 2], ['haze', 3], ['blizzard', 2], ['meteor', 2]
];
const AUTO_SPAN_MS = [8 * 60_000, 20 * 60_000];
let autoSkyOn = localStorage.getItem('home-sky-auto') === '1';
let autoSkyTimer = null;
function pickAutoWeather(exclude) {
  const pool = AUTO_WEIGHTS.filter(([k]) => k !== exclude);
  const total = pool.reduce((a, [, w]) => a + w, 0);
  let r = Math.random() * total;
  for (const [k, w] of pool) { r -= w; if (r <= 0) return k; }
  return 'day';
}
function applyAutoWeather() {
  const next = pickAutoWeather(skyMode);
  skyMode = next;
  skyRealTime = false;
  localStorage.setItem('home-sky', next);
  localStorage.setItem('home-sky-time', '0');
  refreshSky?.();
  toast?.(`天气变成：${SKY_LABEL[next] || next}`);
  scheduleAutoWeather();
}
function scheduleAutoWeather() {
  clearTimeout(autoSkyTimer);
  if (!autoSkyOn) return;
  const [lo, hi] = AUTO_SPAN_MS;
  autoSkyTimer = setTimeout(applyAutoWeather, lo + Math.random() * (hi - lo));
}
// 降水/风力强度（0..1），影响粒子密度、下落速度、地面湿度
let weatherIntensity = Number(localStorage.getItem('home-wx-intensity') || 60) / 100;
if (!Number.isFinite(weatherIntensity)) weatherIntensity = 0.6;

const SKY_FROM_URL = params.get('sky');
// 地板上的房间名：默认关闭，用户可在「设置 → 房间名」打开
let roomLabelsOn = localStorage.getItem('home-labels') === '1';

let skyMode = SKY_FROM_URL || localStorage.getItem('home-sky') || 'day';
if (skyMode === 'auto' || !SKY_PRESETS[skyMode]) skyMode = 'day';
// 时段不再作为天气保存：老存档迁成晴天，时段交给时间
if (['dusk', 'night', 'dawn'].includes(skyMode)) skyMode = 'day';
let skyRealTime = SKY_FROM_URL ? false : (localStorage.getItem('home-sky-time') !== '0');

// 按小时推断当前时段（跟真实时间同步时用）
function hourToSky(h) {
  if (h < 5.2 || h >= 20.5) return 'night';
  if (h < 8) return 'dawn';
  if (h >= 16.8) return 'dusk';
  return 'day';
}
function currentSkyKey() {
  if (skyRealTime) return hourToSky(new Date().getHours() + new Date().getMinutes() / 60);
  return skyMode;
}
function skyLabelText() {
  const k = currentSkyKey();
  return `${SKY_ICON[k] || ''} ${SKY_LABEL[k] || ''}`.trim();
}

// 时间条：customHour 非空 = 手动拖到的时间；否则跟随服务端
let customHour = null;
let displayHour = null;      // 平滑过渡用
let lastSkyPush = 0;
let poolRippleAcc = 0;
let lastRealSync = 0;               // 上次与真实时间对齐的时刻
const REAL_SYNC_MS = 10 * 60_000;   // 真实时间每 10 分钟对齐一次

const HOUR_PARAM = params.get('hour');
if (HOUR_PARAM !== null && Number.isFinite(Number(HOUR_PARAM))) {
  customHour = ((Number(HOUR_PARAM) % 24) + 24) % 24;
}

function phaseOf(hour) {
  if (hour < 5) return '深夜';
  if (hour < 7) return '黎明';
  if (hour < 11) return '上午';
  if (hour < 14) return '正午';
  if (hour < 17) return '午后';
  if (hour < 19.5) return '黄昏';
  if (hour < 22.5) return '夜晚';
  return '深夜';
}

function fmtHour(hour) {
  const h = Math.floor(hour) % 24;
  const m = Math.round((hour - Math.floor(hour)) * 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function updateTimeUI() {
  const hour = displayHour ?? customHour ?? state?.hour ?? 12;
  const pct = (hour / 24) * 100;
  const fill = document.getElementById('timeFill');
  const knob = document.getElementById('timeKnob');
  const text = document.getElementById('timeText');
  if (fill) fill.style.width = `${pct}%`;
  if (knob) knob.style.left = `${pct}%`;
  if (text) text.textContent = `${fmtHour(hour)} ${phaseOf(hour)}`;
}

function bindTimeBar() {
  const bar = document.getElementById('timeBar');
  if (!bar) return;
  let dragging = false;
  const setFromEvent = (e) => {
    const r = bar.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    customHour = ratio * 24;
    skyRealTime = false;
    updateTimeUI();
  };
  bar.addEventListener('pointerdown', (e) => {
    dragging = true;
    bar.setPointerCapture?.(e.pointerId);
    setFromEvent(e);
  });
  bar.addEventListener('pointermove', (e) => { if (dragging) setFromEvent(e); });
  bar.addEventListener('pointerup', (e) => {
    dragging = false;
    bar.releasePointerCapture?.(e.pointerId);
    setFromEvent(e);
    applySkyPref();
  });
  // 双击：回到跟随真实时间
  bar.addEventListener('dblclick', () => {
    customHour = null;
    skyRealTime = true;
    applySkyPref();
  });
}

function skyOptions(hourOverride) {
  // 所有调用方都用同一个「平滑显示小时」，否则轮询/定时器会用真实时间再算一遍，
  // 两张不同的天空贴图交替上屏 → 看起来一闪一闪。
  const h = hourOverride != null
    ? hourOverride
    : (Number.isFinite(displayHour) ? displayHour : null);
  // 天气跟按钮保持一致：开真实时间后按钮显示的是「按小时推断的时段」，
  // 场景也必须用同一把 key 推天气，否则会出现「按钮变晴天、画面还在下雨」。
  const key = skyRealTime ? currentSkyKey() : skyMode;
  const weather = WEATHER_OF[key] || 'clear';
  if (h != null) {
    return { hour: h, realTime: false, weather };
  }
  if (skyRealTime) return { hour: null, realTime: true, weather };
  return {
    hour: SKY_PRESETS[skyMode],
    realTime: false,
    weather
  };
}

function applySkyPref() {
  updateTimeUI();
  const chip = $('skyChip');
  if (chip) {
    chip.classList.toggle('active', !skyRealTime);
    const st = $('skyState');
    if (st) st.textContent = skyLabelText();
  }
  const tchip = $('skyTimeChip');
  if (tchip) {
    tchip.setAttribute('aria-pressed', String(skyRealTime));
    tchip.classList.toggle('active', skyRealTime);
    const ts = $('skyTimeState');
    if (ts) ts.textContent = skyRealTime ? '开' : '关';
  }
}

// 雷雨：偶发整屏白闪
let stormFlashEl = null;
let stormNextAt = 0;
function stormFlashTick(now) {
  const wx = (typeof skyOptions === 'function' ? skyOptions().weather : 'clear');
  if (wx !== 'storm') return;
  if (!stormFlashEl) {
    stormFlashEl = document.createElement('div');
    stormFlashEl.style.cssText = 'position:fixed;inset:0;background:#fff;opacity:0;pointer-events:none;z-index:40;transition:opacity .08s';
    document.body.appendChild(stormFlashEl);
  }
  if (now < stormNextAt) return;
  stormNextAt = now + 2500 + Math.random() * 6000;
  stormFlashEl.style.opacity = '0.42';
  setTimeout(() => { if (stormFlashEl) stormFlashEl.style.opacity = '0'; }, 70 + Math.random() * 60);
  setTimeout(() => { if (stormFlashEl) stormFlashEl.style.opacity = '0.22'; }, 190);
  setTimeout(() => { if (stormFlashEl) stormFlashEl.style.opacity = '0'; }, 260);
}

function refreshSky() {
  try {
    world.updateEnvironment({
      ...skyOptions(), intensity: weatherIntensity,
      lamp: state?.env?.lamp !== false,
      asleep: state?.her?.asleep,
      kind: state?.her?.kind
    });
  } catch { /* 世界还没建好 */ }
}

function applyBubblePref() {
  const chip = $('bubbleChip');
  if (!chip) return;
  chip.classList.toggle('active', bubbleOn);
  chip.setAttribute('aria-pressed', String(bubbleOn));
  const st = $('bubbleState');
  if (st) st.textContent = bubbleOn ? '开' : '关';
  if (!bubbleOn) { $('bubble').classList.remove('show'); bubbleKind = ''; }
}

function applyClickMovePref(announce = false) {
  const chip = $('clickMoveChip');
  if (chip) {
    chip.classList.toggle('active', clickMoveOn);
    chip.setAttribute('aria-pressed', String(clickMoveOn));
    const st = $('clickMoveState');
    if (st) st.textContent = clickMoveOn ? '开' : '关';
  }
  canvas.classList.toggle('picking', clickMoveOn);
  if (announce) toast(clickMoveOn ? '点击地面，让她走过去' : '点击移动已关闭');
}

function applySoundPref() {
  const chip = $('soundChip');
  if (chip) {
    chip.classList.toggle('active', soundOn);
    chip.setAttribute('aria-pressed', String(soundOn));
    const st = $('soundState');
    if (st) st.textContent = soundOn ? '开' : '关';
  }
  if (!soundOn) {
    try { clickSfx.pause(); } catch { /* 忽略 */ }
  }
}

function applySpriteViewPref() {
  const chip = $('viewChip');
  if (!chip) return;
  chip.style.display = charMode === 'webm' ? '' : 'none';
  chip.classList.toggle('active', spriteView === 'free');
  chip.setAttribute('aria-pressed', String(spriteView === 'free'));
  const st = $('viewState');
  if (st) st.textContent = spriteView === 'free' ? '自由' : '正面';
}

function applyCameraModePref() {
  const chip = $('camModeChip');
  if (!chip) return;
  chip.querySelectorAll('button[data-cam-mode]').forEach((button) => {
    const active = button.dataset.camMode === cameraMode;
    button.classList.toggle('on', active);
    button.setAttribute('aria-pressed', String(active));
  });
  chip.classList.toggle('active', cameraMode !== 'left');
  canvas.classList.toggle('free-cam', cameraUsesKeyboard());
  if (!cameraUsesKeyboard()) clearOpenViewKeys();
  if (cameraUsesKeyboard()) {
    VIEW.follow = false;
    if (VIEW.mode !== 'overview') setMode('overview');
  }
}
function setCameraMode(next) {
  if (!CAMERA_MODES.has(next)) return;
  cameraMode = next;
  localStorage.setItem('home-camera-mode', cameraMode);
  localStorage.removeItem('home-free-cam');
  applyCameraModePref();
  const text = {
    open: '开放视角：WASD 移动，方向键转动视角，Shift 加速',
    left: '左键视角：按住鼠标左键拖动镜头',
    both: '组合视角：键盘和鼠标左键都能移动视角'
  }[cameraMode];
  toast(text);
}

function showClickMarker(pos) {
  clickMarker.position.set(pos[0], 0.13, pos[1]);
  clickMarker.visible = true;
  clickMarker.material.opacity = 0.95;
  clickMarker.scale.setScalar(1);
  clickMarkerUntil = performance.now() + 1300;
}

function floorPointAt(e) {
  ndc.x = (e.clientX / innerWidth) * 2 - 1;
  ndc.y = -(e.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  // 只对地面平面做投影：墙/家具不参与拾取，点到桌面也落到桌脚所在的地面。
  // 由服务端再做「必须在房间内、离墙 0.22m」的合法化。
  const hit = raycaster.intersectObject(pickFloor, false)[0];
  if (hit) {
    const p = [Math.round(hit.point.x * 1000) / 1000, Math.round(hit.point.z * 1000) / 1000];
    // 室内地板拾取面只覆盖房间；阳台/泳池露台用同一水平面兜底（见下）
    if (p[1] < 9.0) return p;
  }
  // 泳池露台：露台完成面与地板齐平，直接用 y=0 水平面接住
  {
    const ground = raycaster.ray.intersectPlane(
      new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3()
    );
    if (ground) {
      const gx = Math.round(ground.x * 1000) / 1000;
      const gz = Math.round(ground.z * 1000) / 1000;
      const inDeck = gx >= 0.15 && gx <= 13.2 && gz >= 9.0 && gz <= 13.5;
      const inStrip = gx >= 8.2 && gx <= 13.2 && gz >= 7.6 && gz < 9.0;  // 阳台东侧过渡带
      if (inDeck || inStrip) return [gx, gz];
    }
  }
  // 菜园地面不在小屋的木地板拾取面上；用同一水平面接住右键/拖拽落点。
  if (gardenController?.isOpen) {
    const ground = raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.12), new THREE.Vector3());
    if (ground) return [Math.round(ground.x * 1000) / 1000, Math.round(ground.z * 1000) / 1000];
  }
  return null;
}

function applyState(next) {
  if (!next) return;
  state = next;
  // 环境音跟随天气与所在房间
  try {
    ambience.setScene({ weather: currentSkyKey(), room: next.her?.room });
    const speech = next.her?.speech || '';
    if (speech && speech !== window.__ambSpeech) {
      window.__ambSpeech = speech;
      ambience.setSpeaking(true);
      clearTimeout(window.__ambSpeechT);
      window.__ambSpeechT = setTimeout(() => { try { ambience.setSpeaking(false); } catch { /* 忽略 */ } }, 2600);
    }
  } catch { /* 环境音失败不影响主流程 */ }
  roomView = next.room || roomView;
  if (next.her) {
    world.updateEnvironment({
      ...skyOptions(), lamp: next.env?.lamp !== false, asleep: next.her.asleep, kind: next.her.kind
    });
    world.setClock?.(next.hour || 0, 0);
    if (next.her.walking && Array.isArray(next.her.route) && next.her.route.length > 1) {
      walkPredict = {
        points: next.her.route,
        start: next.her.pos.slice(),
        at: performance.now(),
        speed: Math.max(0.5, Number(next.her.speed) || 1.05)
      };
    } else {
      walkPredict = null;
    }
    lastDisplayPos = next.her.pos.slice();
  }
  if (placeHold && next.her) {
    const hp = next.her.pos;
    if (next.her.spot === 'free' && Math.hypot(hp[0] - placeHold.pos[0], hp[1] - placeHold.pos[1]) < 0.2) {
      placeHold = null;
    }
  }
  renderHUD();
  if (!charDrag?.active) syncCharacter();
  if (SHOT) return;
  const bubbleText = state.her?.speech || state.her?.activity || '';
  if (bubbleOn && bubbleText) {
    const walking = state.her?.walking === true || state.her?.kind === 'walk';
    if (bubbleKind === 'action' && Date.now() - bubbleKindAt < 30_000) {
      // 动作类提示（「她朝你指的地方走过去」）只负责过渡：一旦到了/站定，
      // 下一次状态刷新就用真实 activity 覆盖，避免气泡停在过期的那句话上。
      if (!walking) {
        lastActivity = bubbleText;
        setBubble(bubbleText, 4200, { kind: 'activity' });
      }
    } else if (bubbleText !== lastActivity) {
      // 普通闲聊/活动气泡只记录变化，不在这里打断（她主动说的话要能说完）。
      lastActivity = bubbleText;
    }
  }
}

// 「现在能做什么」：把需求和现成的按钮接起来
function renderMoodTips(body) {
  const box = document.getElementById('moodTips');
  if (!box) return;
  if (!body) { box.hidden = true; box.innerHTML = ''; return; }

  const tips = [];
  const push = (label, act, weight) => tips.push({ label, act, weight });

  // 越难受给的权重越高，最后取前两个
  if ((body.hunger ?? 0) >= 0.45) push('喂小鱼干', 'feed', (body.hunger ?? 0));
  if ((body.thirst ?? 0) >= 0.40) push('去喝水', 'water', (body.thirst ?? 0));
  if ((body.energy ?? 1) <= 0.45) push('哄她睡', 'sleep', 1 - (body.energy ?? 1));
  if ((body.pain ?? 0) >= 0.15) push('关灯让她休息', 'lamp', (body.pain ?? 0) + 0.1);
  if ((body.bladder ?? 0) >= 0.6) push('去卫生间', 'toilet', (body.bladder ?? 0));
  if ((body.hygiene ?? 0) >= 0.5) push('去洗漱', 'wash', (body.hygiene ?? 0));
  const moodNow = Number(state?.emotion?.mood);
  if (Number.isFinite(moodNow) && moodNow < 50) push('摸摸头', 'pet', (50 - moodNow) / 100 + 0.2);
  if ((body.energy ?? 1) > 0.45 && (body.hunger ?? 0) < 0.45 && (body.thirst ?? 0) < 0.40) {
    push('陪她玩', 'play', 0.3);
    push('留句话', 'talk', 0.2);
  }

  if (!tips.length) { box.hidden = true; box.innerHTML = ''; return; }
  tips.sort((a, b) => b.weight - a.weight);
  const top = tips.slice(0, 2);

  box.hidden = false;
  box.innerHTML = '';
  const lab = document.createElement('span');
  lab.className = 'tip-label';
  lab.textContent = '现在可以';
  box.appendChild(lab);
  for (const t of top) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t.label;
    b.addEventListener('click', () => {
      if (t.act === 'toilet') { void act('command', { room: 'bathroom', spot: 'toilet' }); return; }
      if (t.act === 'wash') { void act('command', { room: 'bathroom', spot: 'sink' }); return; }
      const btn = document.querySelector(`[data-act="${t.act}"]`);
      if (btn) btn.click();
      else if (t.act === 'sleep') document.getElementById('sleep')?.click();
      else if (t.act === 'lamp') document.getElementById('lamp')?.click();
    });
    box.appendChild(b);
  }
}

function renderHUD() {
  if (!state?.her) return;
  const her = state.her;
  const body = state.body || state.mood || {};
  $('roomName').textContent = her.roomName || '';
  $('clock').textContent = state.clock || '--:--';
  $('spotLabel').textContent = her.spotLabel ? `${her.spotLabel} · ` : '';
  $('activityText').textContent = her.activity || '在发呆';
  $('barEnergy').style.width = `${Math.round((body.energy ?? 0) * 100)}%`;
  // 条表示「饱腹值」：越满越饱，所以取反
  $('barHunger').style.width = `${Math.round((1 - (body.hunger ?? 0)) * 100)}%`;
  $('barThirst').style.width = `${Math.round((body.thirst ?? 0) * 100)}%`;
  $('barPain').style.width = `${Math.round((body.pain ?? 0) * 100)}%`;
  // 心情值（0-100）与如厕值（bladder 0-1）
  const mood = Number(state?.emotion?.mood);
  const moodPct = Number.isFinite(mood) ? Math.round(Math.max(0, Math.min(100, mood))) : 70;
  const barMoodEl = $('barMood');
  if (barMoodEl) barMoodEl.style.width = `${moodPct}%`;
  const wordMoodEl = $('wordMood');
  if (wordMoodEl) {
    wordMoodEl.textContent = moodPct >= 78 ? '心情很好' : moodPct >= 60 ? '还不错'
      : moodPct >= 45 ? '有点闷' : moodPct >= 30 ? '心情低落' : '很难过';
  }
  // 健康值：由「疼痛 + 憋 + 没洗漱」共同决定，100 = 状态很好
  const bladder = Number(body.bladder) || 0;
  const hygiene = Number(body.hygiene) || 0;
  const pain = Number(body.pain) || 0;
  const health = Math.max(0, Math.min(100, Math.round(
    100 - pain * 45 - Math.max(0, bladder - 0.45) * 60 - hygiene * 45
  )));
  const barHealthEl = $('barBladder');
  if (barHealthEl) barHealthEl.style.width = `${health}%`;
  const wordHealthEl = $('wordBladder');
  if (wordHealthEl) {
    wordHealthEl.textContent = health >= 85 ? '状态很好' : health >= 70 ? '还不错'
      : health >= 55 ? '有点不适' : health >= 40 ? '不太舒服' : health >= 25 ? '明显不适' : '很难受';
  }
  renderMoodTips(body);
  $('wordEnergy').textContent = body.words?.energy || '';
  $('wordHunger').textContent = body.words?.hunger || '';
  $('wordThirst').textContent = body.words?.thirst || '';
  $('wordPain').textContent = body.words?.pain || '';

  const emo = state.emotion;
  const emoChip = $('emotionChip');
  if (emo && Number.isFinite(emo.mood)) {
    emoChip.textContent = `心情 · ${emo.label || ''}`;
    emoChip.title = '来自 dsh-feiyu-mood 的只读心情';
    emoChip.classList.toggle('low', emo.mood < 40);
    emoChip.classList.toggle('high', emo.mood >= 70);
  } else {
    emoChip.textContent = '';
    emoChip.title = '';
  }
  $('qqText').textContent = her.asleep ? '睡着了' : (state.env?.unread > 0 ? 'QQ 有人找' : '在家');
  $('qqChip').classList.toggle('active', !!state.env?.unread);

  $('sleep').textContent = her.asleep ? '叫她起来' : '哄她睡';
  $('lamp').textContent = state.env?.lamp ? '关灯' : '开灯';

  const aff = roomView?.affection;
  if (aff !== undefined && aff !== null) {
    $('affection').textContent = String(aff);
    $('affStage').textContent = roomView.stage || '';
  }

  // 同一句话 10 分钟内重复出现只留一条（历史日志里可能已经有噪音）
  const rawEvents = (state.events || []).slice(-60).reverse();
  const events = [];
  const seenKey = new Map();
  const typeCount = new Map();
  const CAPPED = new Set(['freestyle', 'depart', 'arrive', 'done']);
  for (const e of rawEvents) {
    const key = `${e.type}|${e.text}`;
    const lastAt = seenKey.get(key);
    if (lastAt !== undefined && Math.abs(lastAt - e.ago) < 10) continue;
    seenKey.set(key, e.ago);
    if (CAPPED.has(e.type) && e.ago <= 10) {
      const n = (typeCount.get(e.type) || 0) + 1;
      typeCount.set(e.type, n);
      if (n > 2) continue;          // 10 分钟内同类最多两条，避免「自己找了点事」刷屏
    }
    events.push(e);
    if (events.length >= 40) break;
  }
  const ICON = {
    pet: '🤚', feed: '🐟', water: '💧', play: '🎾', talk: '💬', lamp: '💡',
    sleep: '😴', wake: '⏰', visit: '🚪', command: '👉', go: '🚶', place: '📍',
    clip: '🎬', say: '💭', depart: '↗', arrive: '↓', done: '✓',
    freestyle: '✨', mood: '🫧', need_hunger: '🍚', need_thirst: '🥤',
    need_energy: '🔋', need_hygiene: '🫧', need_bladder: '🚻',
    eat: '🍚', drink: '🥤', toilet: '🚻', shower: '🚿', balcony: '🌬',
    tv: '📺', desk: '✍️', nap: '💤', laundry: '🧺', sick: '🤒', help: '🩹'
  };
  $('events').innerHTML = events.length
    ? events.map((e) => {
      const icon = ICON[e.type] || '·';
      const text = escapeHtml(toSecondPerson(e.text));
      return `<li><span>${fmtAgo(e.ago)}</span><b><i>${icon}</i>${text}</b></li>`;
    }).join('')
    : '<li class="empty">她刚回到家，还没发生什么。</li>';

  // 记忆板只读：优先用 QQ 会话里已有的 activeTopic（旧小屋同源），再补小屋留言。
  // 不写回任何记忆文件，也不在这里新建第二套记忆。
  const memTopics = Array.isArray(state.memory?.topics) ? state.memory.topics : [];
  const memLines = [
    ...memTopics.slice(-3).map((t) => String(t.text || '')).filter(Boolean),
    ...((roomView?.notes || []).slice(-2).map((n) => n.text))
  ];
  if (memLines.length) world.setMemoryNotes(memLines);
  updateRoomsUI();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function updateRoomsUI() {
  const boxes = state?.layout?.rooms || [];
  const el = $('rooms');
  if (!el.dataset.built) {
    el.dataset.built = '1';
    el.innerHTML = boxes.map((r) => `<button data-room="${r.id}">${r.name}</button>`).join('');
    el.querySelectorAll('button[data-room]').forEach((b) => {
      b.addEventListener('click', () => {
        if (b.dataset.room === 'garden' && gardenController) { gardenController.setOpen(true); return; }
        setMode('first', b.dataset.room);
      });
    });
  }
  el.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.room === VIEW.fpRoom && VIEW.mode === 'first'));
}

function viewDiff(her = state?.her) {
  if (!her) return 0;
  const p = lastDisplayPos || her.pos;
  const toCam = Math.atan2(camera.position.x - p[0], -(camera.position.z - p[1])) * 180 / Math.PI;
  const facing = Number(her.facing) || 0;
  return Math.abs(((facing - toCam + 540) % 360) - 180);
}
function isBackView() {
  if (charMode !== 'webm' || !state?.her) return false;
  // 「正面」只是待机偏好：站着时看镜头；一旦走路，必须按真实移动方向选背面/侧面，
  // 否则朝远处走时还播正面帧，看起来就是倒着走。
  if (spriteView !== 'free' && !state.her.walking) return false;
  // 进入用 108°，退出用 95°，避免镜头在边界附近抖动时来回切正/背面。
  return viewDiff() > (lastBackView ? 95 : 108);
}
/** 侧身跑只用在“镜头看到侧面”的区间；正面/背面不再套用左侧跑。 */
function isSideRun(her = state?.her) {
  if (!her?.walking || charMode !== 'webm') return false;
  if (VIEW.mode === 'first' || VIEW.mode === 'eyes') return false;
  // 背面奔跑已删除：镜头在背后时用侧跑帧，不再切 back_run。
  return viewDiff(her) >= 48;
}

function clipFor(her) {
  if (!her) return 'idle';
  // 行走优先级最高：只要在走，就必须是跑/走动画
  if (her.walking) {
    if (isSideRun(her)) return 'run_hurry';
    return 'run_happy';
  }
  if (petActionOverride && !her.asleep && Date.now() < petActionOverride.until) return petActionOverride.clip;
  if (her.asleep) {
    // 兜底：旧状态/异常状态下如果还没到床，绝不播睡眠动画。
    if (her.spot !== 'bed') return her.walking ? 'run_happy' : 'idle';
    return sleepPhase === 'loop' || sleepPhase === 'none' ? 'sleep_loop' : 'sleep_in';
  }
  if (her.walking) {
    // 背面跑 / 侧面跑 / 正面跑分开选，避免拿左侧跑帧去跑右侧方向。
    if (isSideRun(her)) return 'run_hurry';
    return 'run_happy'; // 正面只有 run_happy 是正面帧；walk_fast 是侧跑，不能当前面用
  }
  if (Date.now() < opinionUntil && opinionClip) return opinionClip;

  const k = her.kind || 'idle';
  if (k.startsWith('garden_')) {
    if (k === 'garden_till' || k === 'garden_plant' || k === 'garden_harvest') return 'desk_tap';
    return 'idle_look';
  }
  // 自由视角只在站立/自由落点/行走时用背面；坐着、吃饭、反应等仍保留正面动作。
  if (isBackView() && her.pose === 'stand' && (her.elev || 0) < 0.2 && (k === 'idle' || k === 'free')) return 'back_idle';
  const night = (state?.hour ?? 12) >= 19 || (state?.hour ?? 12) < 7;
  switch (k) {
    case 'eat': return (her.activity || '').includes('小鱼干') ? 'eat_snack' : '吃午餐';
    case 'drink': return '举杯敬酒';   // 新导入的完整喝水动作
    case 'freestyle': return her.clip || 'idle_look';   // 自主动作：由服务端抽好的 clip
    case 'swim': return '游泳';                         // 泳池里来回游
    case 'toilet': return 'mutter';
    case 'bath': return '晨间刷牙';
    case 'balcony': return night ? 'mooncake' : 'fan';
    case 'tv': return '原地专心玩魔方';
    case 'desk': return '写代码';
    case 'phone': return '熬夜刷手机';
    case 'nap': return 'nap';
    case 'laundry': return '叠衣服';
    case 'sick':
    case 'help': return 'sick';
    case 'react_happy': return 'react_happy';
    case 'react_shy': return 'react_shy';
    case 'react_scare': return 'react_scare';
    case 'idle_look': return 'idle_look';
    case 'wake': return 'stretch';
    case 'play': return 'dance';
    case 'idle':
    default: {
      if (her.pose === 'lie') return 'sleep_loop';
      if (her.pose === 'sit') return 'mutter';
      const hour = state?.hour ?? 12;
      if (hour >= 22 || hour < 6) return 'yawn';
      const mood = state?.emotion?.mood;
      if (Number.isFinite(mood) && mood < 40) return 'idle_look';
      const h = [...(her.spot || '')].reduce((n, c) => n + c.charCodeAt(0), 0) + (her.kind || '').length;
      if (Number.isFinite(mood) && mood >= 78 && h % 4 === 0) return 'dance';
      return h % 7 === 0 ? 'dance' : h % 3 === 0 ? 'idle_hum' : h % 2 === 0 ? 'idle_look' : 'idle';
    }
  }
}

// 调试预览：?preview=sit 或 ?preview=lie 直接把她的显示位置放在沙发/床上，
// 用来调坐姿下沉/躺姿高度，不改服务端状态。
// ── 沙发玩：走到沙发，到了就坐上去玩一会儿 ─────────────────────────────
const SOFA_POINT = [6.3, 5.12];
let sofaPlayUntil = 0;
// 躺椅玩：先走到躺椅前面 → 平滑“抬脚”坐上躺椅 → 播动作 → 结束再平滑下来
const CHAISE_POINT = [2.67, 8.22];   // 躺椅中心（坐上去的位置）
const CHAISE_STAGE = [3.55, 8.30];   // 躺椅前面的落脚点
const CHAISE_SEAT = 0.40;            // 座面高度
let chaisePhase = 'idle';            // idle | walk | up | play | down
let chaiseT0 = 0;
let chaisePlayUntil = 0;

function chaiseEase(t) {
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t); // smoothstep
}
const SEAT_PHASES = ['rise', 'enter', 'play', 'exit', 'lower'];

function chaisePlayHer(her) {
  if (!her) return her;
  const now = Date.now();
  const SEAT = CHAISE_SEAT;

  // 她已经（被服务端）走开了：立刻结束躺椅流程，不要顶着“玩耍”动作被拖走
  if (SEAT_PHASES.includes(chaisePhase) && (her.walking || her.kind === 'walk')) {
    chaisePhase = 'idle';
    return her;
  }

  if (chaisePhase === 'walk') {
    if (now - chaiseT0 > 20000) { chaisePhase = 'idle'; return her; }
    if (!her.walking) {
      const d = Math.hypot((her.pos?.[0] || 0) - CHAISE_STAGE[0], (her.pos?.[1] || 0) - CHAISE_STAGE[1]);
      if (d < 0.7) { chaisePhase = 'rise'; chaiseT0 = now; }
      else return her;
    } else return her;
  }
  // 先抬到座面高度（原地，像跳上去）
  if (chaisePhase === 'rise') {
    const t = chaiseEase((now - chaiseT0) / 600);
    if (t >= 1) { chaisePhase = 'enter'; chaiseT0 = now; }
    return { ...her, pos: CHAISE_STAGE.slice(), elev: SEAT * t, pose: 'sit', walking: false };
  }
  // 抬到位后再横向进入躺椅范围
  if (chaisePhase === 'enter') {
    const t = chaiseEase((now - chaiseT0) / 450);
    const pos = [
      CHAISE_STAGE[0] + (CHAISE_POINT[0] - CHAISE_STAGE[0]) * t,
      CHAISE_STAGE[1] + (CHAISE_POINT[1] - CHAISE_STAGE[1]) * t
    ];
    if (t >= 1) { chaisePhase = 'play'; chaiseT0 = now; }
    return { ...her, pos, elev: SEAT, pose: 'sit', walking: false };
  }
  if (chaisePhase === 'play') {
    if (now - chaiseT0 > 16000) { chaisePhase = 'exit'; chaiseT0 = now; }
    return { ...her, pos: CHAISE_POINT.slice(), elev: SEAT, pose: 'sit', walking: false };
  }
  // 先横向退出躺椅范围（保持座面高度）
  if (chaisePhase === 'exit') {
    const t = chaiseEase((now - chaiseT0) / 450);
    const pos = [
      CHAISE_POINT[0] + (CHAISE_STAGE[0] - CHAISE_POINT[0]) * t,
      CHAISE_POINT[1] + (CHAISE_STAGE[1] - CHAISE_POINT[1]) * t
    ];
    if (t >= 1) { chaisePhase = 'lower'; chaiseT0 = now; }
    return { ...her, pos, elev: SEAT, pose: 'sit', walking: false };
  }
  // 退出后再落回地面
  if (chaisePhase === 'lower') {
    const t = chaiseEase((now - chaiseT0) / 550);
    if (t >= 1) { chaisePhase = 'idle'; return her; }
    return { ...her, pos: CHAISE_STAGE.slice(), elev: SEAT * (1 - t), pose: 'sit', walking: false };
  }
  return her;
}
async function chaisePlay() {
  if (!state?.her) { toast('她还没出来'); return; }
  if (state.her.asleep) { toast('她睡着了，先叫醒'); return; }
  chaisePhase = 'walk';
  chaiseT0 = Date.now();
  toast(`${PET_NAME}去躺椅上玩`);
  // 走到躺椅前面，不直接走进躺椅里
  void act('go', { pos: CHAISE_STAGE });
}

// 上沙发：只能从两侧（绿框位置）上，坐到红框座面高度
const SOFA_STAGE_L = [5.12, 4.42];   // 沙发正前方·左角（只能从这里上）
const SOFA_STAGE_R = [7.48, 4.42];   // 沙发正前方·右角
const SOFA_SEAT = 0.48;              // 座面高度（红框）
let sofaPhase = 'idle';              // idle | walk | up | play | down
let sofaT0 = 0;
let sofaStage = SOFA_STAGE_L;

function sofaPlayHer(her) {
  if (!her) return her;
  const now = Date.now();
  const SEAT = SOFA_SEAT;

  if (SEAT_PHASES.includes(sofaPhase) && (her.walking || her.kind === 'walk')) {
    sofaPhase = 'idle';
    return her;
  }

  if (sofaPhase === 'walk') {
    if (now - sofaT0 > 20000) { sofaPhase = 'idle'; return her; }
    if (her.walking) return her;
    const d = Math.hypot((her.pos?.[0] || 0) - sofaStage[0], (her.pos?.[1] || 0) - sofaStage[1]);
    if (d < 0.7) { sofaPhase = 'rise'; sofaT0 = now; } else return her;
  }
  if (sofaPhase === 'rise') {
    const t = chaiseEase((now - sofaT0) / 600);
    if (t >= 1) { sofaPhase = 'enter'; sofaT0 = now; }
    return { ...her, pos: sofaStage.slice(), elev: SEAT * t, pose: 'sit', walking: false };
  }
  if (sofaPhase === 'enter') {
    const t = chaiseEase((now - sofaT0) / 450);
    const pos = [
      sofaStage[0] + (SOFA_POINT[0] - sofaStage[0]) * t,
      sofaStage[1] + (SOFA_POINT[1] - sofaStage[1]) * t
    ];
    if (t >= 1) { sofaPhase = 'play'; sofaT0 = now; }
    return { ...her, pos, elev: SEAT, pose: 'sit', walking: false };
  }
  if (sofaPhase === 'play') {
    if (now - sofaT0 > 15000) { sofaPhase = 'exit'; sofaT0 = now; }
    return { ...her, pos: SOFA_POINT.slice(), elev: SEAT, pose: 'sit', walking: false };
  }
  if (sofaPhase === 'exit') {
    const t = chaiseEase((now - sofaT0) / 450);
    const pos = [
      SOFA_POINT[0] + (sofaStage[0] - SOFA_POINT[0]) * t,
      SOFA_POINT[1] + (sofaStage[1] - SOFA_POINT[1]) * t
    ];
    if (t >= 1) { sofaPhase = 'lower'; sofaT0 = now; }
    return { ...her, pos, elev: SEAT, pose: 'sit', walking: false };
  }
  if (sofaPhase === 'lower') {
    const t = chaiseEase((now - sofaT0) / 550);
    if (t >= 1) { sofaPhase = 'idle'; return her; }
    return { ...her, pos: sofaStage.slice(), elev: SEAT * (1 - t), pose: 'sit', walking: false };
  }
  return her;
}
async function sofaPlay() {
  if (!state?.her) { toast('她还没出来'); return; }
  if (state.her.asleep) { toast('她睡着了，先叫醒'); return; }
  const p0 = state.her.pos || SOFA_POINT;
  const dl = Math.hypot(p0[0] - SOFA_STAGE_L[0], p0[1] - SOFA_STAGE_L[1]);
  const dr = Math.hypot(p0[0] - SOFA_STAGE_R[0], p0[1] - SOFA_STAGE_R[1]);
  sofaStage = dl <= dr ? SOFA_STAGE_L : SOFA_STAGE_R;
  sofaPhase = 'walk';
  sofaT0 = Date.now();
  toast(`${PET_NAME}去沙发上玩`);
  void act('go', { pos: sofaStage });
}

const PREVIEW = String(params.get('preview') || '');
const PREVIEW_TARGETS = {
  sit: { pos: [6.3, 5.12], elev: 0.48, pose: 'sit' },
  lie: { pos: [11.4, 1.32], elev: 0.54, pose: 'lie' }
};
// 调试：?pintest=1 把显示位置钉在固定点（对比两套素材的头宽）
const PIN_TEST = params.get('pintest') === '1';
// 调试读数：pintest 时把两套素材的头宽/缩放显示在左下角
function pinDebugTick() {
  if (!PIN_TEST) return;
}
setTimeout(pinDebugTick, 800);

function pinHer(her) {
  if (!PIN_TEST || !her) return her;
  return { ...her, pos: [4.2, 4.6], elev: 0, pose: 'stand', walking: false };
}

function previewHer(her) {
  const t = PREVIEW_TARGETS[PREVIEW];
  if (!t || !her) return her;
  return { ...her, pos: t.pos, elev: t.elev, pose: t.pose, walking: false, asleep: PREVIEW === 'lie' };
}

// 家具有高度：默认 45° 俯视时，坐垫/床沿会把低于它们上表面的身体挡住。
// 所以只要踩在家具上，统一抬高，让整个身体露出来（起床过渡、站姿也一样）。
const FURNITURE_RAISE = 0.45;
const BED_RAISE = 0.22;
// 脚下踩在家具顶面上时返回顶面高度（沙发 0.48 / 床 0.54 / 椅面 0.46）
function furnitureTopAt(pos) {
  const keep = NAV_DATA?.keepout || [];
  if (!pos) return 0;
  for (const item of keep) {
    if (!item.top) continue;
    const [x0, z0, x1, z1] = item.rect;
    if (pos[0] >= x0 - 0.06 && pos[0] <= x1 + 0.06 && pos[1] >= z0 - 0.06 && pos[1] <= z1 + 0.06) return item.top;
  }
  return 0;
}
function displayElevFor(her) {
  // 只有在“从家具上走下来”的过程中，才参考脚下家具高度（避免刚起步就掉到地板）；
  // 已经站定在普通地面时就按服务端给的高度，走路经过家具也不会突然升高。
  const transitLift = motionWalking ? furnitureTopAt(her.pos) : 0;
  const base = Math.max(her.elev || 0, transitLift);
  if (base < 0.2) return 0;
  if (her.spot === 'bed' || her.pose === 'lie') return base + BED_RAISE;
  if (her.spot === 'chair') return base;   // 躺椅：脚正好踩在座面上
  if (her.pose === 'sit') return base;   // 沙发的坐面高度就是座面（红框）
  return base;
}

const ONCE = new Set(['react_happy', 'react_shy', 'react_scare', 'stretch', 'curtsy']);
function syncCharacter() {
  const her = state?.her ? { ...state.her, walking: motionWalking } : null;
  if (!her) return;
  // 硬规则：只要人在移动，所有“表演类”覆盖立刻作废，
  // 动画必须和位移对应（否则会出现边播动作边滑走）。
  if (motionWalking) {
    petActionOverride = null;
      if (['rise', 'enter', 'play', 'exit', 'lower'].includes(chaisePhase)) chaisePhase = 'idle';
    if (['rise', 'enter', 'play', 'exit', 'lower'].includes(sofaPhase)) sofaPhase = 'idle';
  }
  // 喝水：现在 webm 里已经有「举杯敬酒」的完整动画，直接用视频素材，
  // 不再临时切精灵图（两套画风不一致会让画面跳一下）。
  {
    const fc = params.get('forceclip');
    if (fc) {
      if (actor.current !== fc) actor.setClip(fc);
      return;
    }
  }
  if (PIN_TEST) {
    if (!syncCharacter._pinned) { syncCharacter._pinned = true; void actor.setClip('idle'); }
    return;
  }
  if (sofaPhase === 'play' && !her.asleep) {
    if (actor.current !== 'dance') actor.setClip('dance');
    setBubble('沙发上玩', 5000);
    return;
  }
  if (['rise', 'enter', 'exit', 'lower'].includes(sofaPhase)) {
    if (actor.current !== 'mutter') actor.setClip('mutter');
    return;
  }
  if (chaisePhase === 'play' && !her.asleep) {
    if (actor.current !== 'dance') actor.setClip('dance');
    setBubble('躺椅上玩', 5000);
    return;
  }
  if (['rise', 'enter', 'exit', 'lower'].includes(chaisePhase)) {
    if (actor.current !== 'mutter') actor.setClip('mutter');
    return;
  }
  if (sofaPlayUntil && Date.now() < sofaPlayUntil && !her.walking && !her.asleep) {
    const dx = (her.pos?.[0] || 0) - SOFA_POINT[0];
    const dz = (her.pos?.[1] || 0) - SOFA_POINT[1];
    if (Math.hypot(dx, dz) <= 0.5) {
      if (actor.current !== 'dance') actor.setClip('dance');
      setBubble('沙发上玩', 5000);
      return;
    }
  }
  if (PREVIEW) {
    // 预览模式：强制播放坐/躺的片段，只看位置和高度
    const clip = PREVIEW === 'lie' ? 'sleep_loop' : 'mutter';
    if (actor.current !== clip) actor.setClip(clip);
    return;
  }
  if (her.asleep || her.room === 'garden') petActionOverride = null;
  const wasAsleep = lastSleep;
  lastSleep = her.asleep;

  if (her.asleep && her.spot !== 'bed') {
    // 还没进被窝：按移动/站立处理，不进入 sleep_in/sleep_loop。
    const name = her.walking ? 'run_happy' : 'idle';
    if (actor.current !== name) actor.setClip(name);
    return;
  }
  if (her.asleep && her.spot === 'bed') {
    if (!wasAsleep) {
      sleepPhase = 'in';
      actor.setClip('sleep_in', { once: true, onEnded: () => { if (lastSleep) { sleepPhase = 'loop'; actor.setClip('sleep_loop'); } } });
    } else if (sleepPhase === 'none') {
      sleepPhase = 'loop';
      actor.setClip('sleep_loop');
    }
    if (sleepPhase === 'out') sleepPhase = 'loop';
  } else if (!her.asleep && wasAsleep) {
    sleepPhase = 'out';
    actor.setClip('sleep_out', { once: true, onEnded: () => { sleepPhase = 'none'; actor.setClip(clipFor(state.her), { fade: true }); } });
  } else if (!her.asleep && sleepPhase !== 'none' && !her.walking) {
    sleepPhase = 'none';
  }

  if (her.asleep || sleepPhase === 'in' || sleepPhase === 'out') return;

  let name = clipFor(her);
  const once = ONCE.has(name);
  const key = `${name}:${her.activity}:${her.spot}`;
  if (once) {
    if (lastOnceKey === key && Date.now() - lastOnceAt < 9000) name = 'idle';
    else { lastOnceKey = key; lastOnceAt = Date.now(); }
  }
  if (actor.current !== name) {
    actor.setClip(name, { once, onEnded: () => { if (actor.current === name) actor.setClip(clipFor(state?.her), { fade: true }); } });
  }

  const pose = {
    pos: her.pos, elev: her.elev, pose: her.pose, kind: her.kind, walking: her.walking,
    facing: her.facing, asleep: her.asleep, activity: her.activity, runStyle: her.runStyle
  };
  model3d?.setPose(pose);
  if (chibi) chibi.setPose(pose);
}

// ── 动作栏 ────────────────────────────────────────────────────────────────
const PET_ACTION_DURATION = Object.freeze({
  dance: 6200, stretch: 4200, curtsy: 3800, game: 5200, fan: 5200,
  mooncake: 5200, eat_snack: 4800, yawn: 4200, nap: 7000,
  idle_look: 4200, brush: 4600, idle_hum: 4600
});
// ── 动作面板（基础 / 蓝毛 / 新包）────────────────────────────────────────
const BASE_LABELS = {
  idle: '待机', idle_look: '东张西望', idle_hum: '哼歌',
  walk: '走路', walk_fast: '快走', run_happy: '开心跑', run_hurry: '小跑', back_idle: '背身待机',
  sleep_in: '入睡', sleep_loop: '睡眠', sleep_out: '醒来',
  eat_rice: '吃饭', eat_snack: '吃小鱼干', wait_food: '等饭',
  brush: '刷牙', mirror: '照镜子',
  desk_code: '写代码', desk_tap: '敲键盘', desk_mutter: '桌前嘀咕',
  fan: '扇风', mooncake: '吃月饼', kite: '放风筝',
  react_happy: '开心', react_shy: '害羞', react_scare: '受惊',
  stretch: '伸懒腰', sick: '生病', game: '玩游戏', dance: '跳舞',
  nap: '打盹', curtsy: '行礼', yawn: '打哈欠', mutter: '碎碎念'
};
const GEN_ACTIONS = Object.keys(CLIPS)
  .filter((k) => /[\u4e00-\u9fa5]/.test(k))
  .map((clip) => ({ clip, label: clip }));
const BASE_ACTIONS = Object.keys(CLIPS)
  .filter((k) => !/[\u4e00-\u9fa5]/.test(k))
  .map((clip) => ({ clip, label: BASE_LABELS[clip] || clip }));
const PET_GROUPS = [
  { id: '__base', label: '基础' },
  ...ACTION_GROUPS.filter((g) => g.id !== '其它').map((g) => ({ id: g.id, label: g.label })),
  ...ACTION_GROUPS.filter((g) => g.id === '其它').map((g) => ({ id: g.id, label: g.label }))
];
const GROUP_ITEMS = new Map(ACTION_GROUPS.map((g) => [g.id, g.items]));
let petGroup = '__base';
let petCat = '全部';
// 调试/截图用：?petgroup=dsh1&petcat=吃喝 直接展开某个分组
const PET_GROUP_PARAM = new URLSearchParams(location.search).get('petgroup');
const PET_CAT_PARAM = new URLSearchParams(location.search).get('petcat');
if (PET_GROUP_PARAM) petGroup = PET_GROUP_PARAM === 'base' ? '__base' : PET_GROUP_PARAM;
if (PET_CAT_PARAM) petCat = PET_CAT_PARAM;
let nextSelfActionAt = Date.now() + 40000;

function itemsOfGroup(id) {
  return GROUP_ITEMS.get(id) || [];
}

// 右侧两张卡片：按动作面板的实际高度给事件面板算高度，保证永不互相遮挡
function layoutSideCards() {
  const rail = document.getElementById('sideRail');
  const ev = document.querySelector('.events-panel');
  const pa = document.getElementById('petActions');
  if (!rail || !ev || !pa) return;
  // 顶部胶囊在窄屏会换行，竖列要跟着顶栏底边往下让，别压住按钮
  const topRow = document.querySelector('.top');
  const topBottom = topRow ? topRow.getBoundingClientRect().bottom : 84;
  rail.style.top = `${Math.round(Math.max(84, topBottom + 8))}px`;
}

function renderPetPanel() {
  const tree = document.getElementById('petTree');
  const grid = document.getElementById('petActionGrid');
  if (!tree || !grid) return;

  // 左栏：分组（基础 + 自己归类的动作组）
  tree.innerHTML = '';
  for (const g of PET_GROUPS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pa-group' + (petGroup === g.id ? ' active' : '');
    b.textContent = g.label;
    b.title = g.label;
    b.addEventListener('click', () => { petGroup = g.id; renderPetPanel(); });
    tree.appendChild(b);
  }

  // 右栏：动作网格
  grid.innerHTML = '';
  const addButton = (label, onPick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pet-action';
    b.textContent = label;
    b.title = label;
    b.addEventListener('click', onPick);
    grid.appendChild(b);
  };

  const query = String(document.getElementById('petSearch')?.value || '').trim().toLowerCase();

  // 搜索：基础 + 全部组一起搜
  if (query) {
    const hits = [];
    for (const a of BASE_ACTIONS) {
      if (String(a.label).toLowerCase().includes(query)) hits.push(a);
    }
    for (const g of ACTION_GROUPS) {
      for (const name of g.items) {
        if (name.toLowerCase().includes(query)) hits.push({ clip: name, label: name });
      }
    }
    if (!hits.length) {
      const tip = document.createElement('div');
      tip.style.cssText = 'grid-column:1/-1;color:rgba(160,185,210,.7);font-size:11px;padding:6px 2px';
      tip.textContent = '没有匹配的动作';
      grid.appendChild(tip);
      return;
    }
    for (const a of hits) addButton(a.label, () => playPetAction(a.clip, a.label));
    return;
  }

  if (petGroup === '__base') {
    for (const a of BASE_ACTIONS) addButton(a.label, () => playPetAction(a.clip, a.label));
    return;
  }

  for (const name of itemsOfGroup(petGroup)) {
    addButton(name, () => playPetAction(name, name));
  }
  layoutSideCards();
}

function setPetStatus(text) {
  const el = document.getElementById('petActionStatus');
  if (el) el.textContent = text || '';
}


// 她自己的动作：空闲一段时间后随机来一段新动作包里的动作
function maybeSelfAction() {
  if (!state?.her || SHOT) return;
  if (state.her.asleep || state.her.walking || state.her.kind === 'sleep') return;
  if (petActionOverride) return;
  if (Date.now() < nextSelfActionAt) return;
  const pool = [];
  for (const g of ACTION_GROUPS) if (g.id !== '情绪') pool.push(...g.items);
  if (!pool.length) { nextSelfActionAt = Date.now() + 60000; return; }
  const name = pool[Math.floor(Math.random() * pool.length)];
  nextSelfActionAt = Date.now() + 90000 + Math.random() * 120000;
  playPetAction(name, name);
}

function playPetAction(clip, label) {
  if (!state?.her) { toast('她还没出来'); return; }
  if (charMode !== 'webm') { toast('动作栏目前只在立绘模式播放；先切到「立绘」'); return; }
  if (state.her.asleep) { toast('她睡着了，先叫醒再让她跳舞'); return; }
  // 只有在“真的在移动”且播放的是原地动作时，才把她定在原地；
  // 跑/走类动作本身就走位，不能再去 place，否则会出现「先跑去别处再跑回来」。
  const isRunClip = /^(run_|walk_)/.test(clip);
  const reallyMoving = motionWalking || (state.her.walking && (state.her.route?.length || 0) > 0);
  if (reallyMoving && !isRunClip) {
    let stopPos = Array.isArray(lastDisplayPos) ? lastDisplayPos.slice() : state.her.pos.slice();
    const base = state.her.pos;
    // 落点如果明显偏离她的真实位置（旧缓存/异常值），就不要用
    if (!Number.isFinite(stopPos?.[0]) || !Number.isFinite(stopPos?.[1])
      || Math.hypot(stopPos[0] - base[0], stopPos[1] - base[1]) > 2.5) {
      stopPos = base.slice();
    }
    void act('place', { pos: stopPos });
  }
  const duration = PET_ACTION_DURATION[clip] || 4800;
  const token = `${clip}:${Date.now()}`;
  petActionOverride = { clip, label, until: Date.now() + duration, token };
  try {
    actor.setClip(clip, {
      once: true,
      onEnded: () => {
        if (petActionOverride?.token === token) { petActionOverride = null; syncCharacter(); }
      }
    });
  } catch { petActionOverride = null; toast('这个动作没加载出来'); return; }
  setBubble(label, Math.min(duration, 6000));
  toast(`${PET_NAME}：${label}`);
  setTimeout(() => {
    if (petActionOverride?.token === token) { petActionOverride = null; syncCharacter(); flushPendingGo(); }
  }, duration + 120);
}

// ── 动作 ──────────────────────────────────────────────────────────────────
async function act(action, extra = {}) {
  if (pendingAction) return;
  pendingAction = action;
  try {
    const res = await fetch(withToken('/api/home/act'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...extra })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.changed === false) { toast(state?.her?.asleep ? '她睡着了，先叫醒她再点' : '这里去不了，换块地面试试'); return; }
    if (data.home) applyState(data.home);
    else await poll();
    const reactionText = data.event?.reaction;
    if (reactionText) setBubble(reactionText, 3800, { kind: 'reaction' });
    // 提示语气统一：toast 用「你」的视角（谁下的指令），气泡用「本鱼」的第一人称
    const toastMsg = {
      pet: '你摸了摸她的头', feed: '你喂了她一块小鱼干', water: '你让她去接水',
      play: '你陪她玩了一会儿', talk: '你把话留在了墙上', sleep: '你哄她睡着了',
      wake: '你把她叫醒了', lamp: '你动了一下灯', command: '你让她去那边',
      go: '你让她走了过去', place: '你把她放到这里'
    }[action];
    const bubbleMsg = {
      pet: '本鱼摸摸～', feed: '本鱼吃小鱼干！', water: '本鱼去喝口水',
      play: '嘿嘿，本鱼玩一会儿', talk: '本鱼记住啦', sleep: '本鱼睡了…',
      wake: '唔…本鱼醒啦', lamp: '灯…换了个状态？', command: '本鱼去那边',
      go: '本鱼过去啦', place: '本鱼落在这儿'
    }[action];
    if (toastMsg) toast(toastMsg);
    // 动作提示只活到下一次状态刷新：走到位后由 applyState 用真实 activity 覆盖。
    if (bubbleMsg) setBubble(bubbleMsg, 2400, { kind: 'action' });
  } catch (error) {
    toast(`没接上：${error.message}`);
  } finally {
    pendingAction = '';
  }
}

let talkOpen = false;
function openTalk() {
  talkOpen = !talkOpen;
  $('talk').classList.toggle('show', talkOpen);
  if (talkOpen) $('talkInput').focus();
}
async function sendTalk() {
  const text = $('talkInput').value.trim();
  if (!text) return;
  $('talkInput').value = '';
  $('talk').classList.remove('show');
  talkOpen = false;
  await act('talk', { text });
}

function showInfo(hs) {
  $('infoTitle').textContent = hs.title || '房间';
  $('infoKind').textContent = hs.label || '';
  $('infoSub').textContent = hs.sub || '';
  $('info').dataset.room = hs.room || '';
  $('info').dataset.spot = hs.spot || '';
  $('info').classList.remove('hide');
}
$('infoClose').addEventListener('click', () => $('info').classList.add('hide'));
$('infoGo').addEventListener('click', () => {
  const room = $('info').dataset.room;
  const spot = $('info').dataset.spot;
  $('info').classList.add('hide');
  if (room && spot) act('command', { room, spot });
});

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2600);
}
function setBubble(text, ms = 4500, opts = {}) {
  if (!bubbleOn || !text || SHOT || VIEW.mode === 'eyes') return;
  const el = $('bubble');
  el.textContent = text;
  el.classList.add('show');
  bubbleUntil = Date.now() + ms;
  bubbleKind = opts.kind || 'activity';
  bubbleKindAt = Date.now();
}

// 按钮
document.querySelectorAll('[data-act]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const a = btn.dataset.act;
    if (a === 'talk') { openTalk(); return; }
    if (a === 'sleep') { act(lastSleep ? 'wake' : 'sleep'); return; }
    if (a === 'lamp') { act('lamp', { on: !(state?.env?.lamp) }); return; }
    if (a === 'sofa_play') { void sofaPlay(); return; }
    if (a === 'chaise_play') { void chaisePlay(); return; }
    if (a === 'roomchat') { setRoomChatOpen(!chatOpen); return; }
    act(a);
  });
});
// ── 路网小地图：/room/?nav=1 直接看路点、连线、禁区、站位 ─────────────────
// ── 3D 导航调试层：地面红框（禁区）、黄点（路点）、蓝线（可走边）、青线（实时路线）──
let nav3dGroup = null;
let nav3dRoute = null;
let nav3dRoutePos = null;

// 3D 文字标签（canvas 贴图 → Sprite），用于导航调试层的编号/名字
function navLabel(text, color = '#ffd23f', size = 0.5) {
  const pad = 8;
  const font = 44;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  ctx.font = `bold ${font}px system-ui, "Microsoft YaHei", sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width) + pad * 2;
  const h = font + pad * 2;
  canvas.width = w;
  canvas.height = h;
  const c2 = canvas.getContext('2d');
  c2.font = `bold ${font}px system-ui, "Microsoft YaHei", sans-serif`;
  c2.textAlign = 'center';
  c2.textBaseline = 'middle';
  c2.fillStyle = 'rgba(6,10,16,0.72)';
  c2.fillRect(0, 0, w, h);
  c2.strokeStyle = color;
  c2.lineWidth = 3;
  c2.strokeRect(1.5, 1.5, w - 3, h - 3);
  c2.fillStyle = color;
  c2.fillText(text, w / 2, h / 2 + 1);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: true, depthWrite: false
  }));
  const aspect = w / h;
  sprite.scale.set(size * aspect, size, 1);
  sprite.renderOrder = 999;
  return sprite;
}

function buildNav3D() {
  if (nav3dGroup || !world?.scene) return;
  const g = new THREE.Group();
  g.name = 'nav3d';
  const gKeep = new THREE.Group(); gKeep.name = 'nav3d-keep';
  const gNodes = new THREE.Group(); gNodes.name = 'nav3d-nodes';
  const gSpots = new THREE.Group(); gSpots.name = 'nav3d-spots';
  g.add(gKeep, gNodes, gSpots);
  g.userData = { gKeep, gNodes, gSpots };
  const keepouts = NAV_DATA?.keepout || [];

  for (const k of keepouts) {
    const r = k.rect;
    if (!r) continue;
    const w = r[2] - r[0], d = r[3] - r[1];
    if (!(w > 0 && d > 0)) continue;
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(w, d),
      new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.2, depthWrite: false })
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.set((r[0] + r[2]) / 2, 0.035, (r[1] + r[3]) / 2);
    gKeep.add(plane);

    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(w, d)),
      new THREE.LineBasicMaterial({ color: 0xff6a5c, transparent: true, opacity: 0.95 })
    );
    edges.rotation.x = -Math.PI / 2;
    edges.position.copy(plane.position);
    edges.position.y = 0.038;
    gKeep.add(edges);

    {
      const idx = keepouts.indexOf(k) + 1;
      const lb = navLabel('K' + idx, '#ff8a7a', 0.22);
      lb.position.set(r[0] + 0.03, 0.1, r[1] + 0.03);
      gKeep.add(lb);
    }
    const top = Number(k.top) || 0;
    if (top > 0.05) {
      const pts = [];
      for (const [cx, cz] of [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]]) {
        pts.push(new THREE.Vector3(cx, 0.03, cz), new THREE.Vector3(cx, top, cz));
      }
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      gKeep.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xff8a7a, transparent: true, opacity: 0.7 })));
    }
  }

  const nodes = NAV_DATA?.nodes || {};
  // 黄色路点编号
  {
    const ids = Object.keys(nodes);
    ids.forEach((id, i) => {
      const [x, z] = nodes[id];
      const lb = navLabel('P' + (i + 1), '#ffd23f', 0.22);
      lb.position.set(x, 0.22, z);
      gNodes.add(lb);
    });
  }
  const nodePts = [];
  for (const id of Object.keys(nodes)) {
    const [x, z] = nodes[id];
    nodePts.push(new THREE.Vector3(x, 0.06, z));
  }
  if (nodePts.length) {
    const geo = new THREE.BufferGeometry().setFromPoints(nodePts);
    gNodes.add(new THREE.Points(geo, new THREE.PointsMaterial({
      color: 0xffd23f, size: 0.1, sizeAttenuation: true, depthWrite: false, transparent: true, opacity: 0.95
    })));
  }

  // 绿色站位点：名字 + 编号
  {
    const spots = NAV_DATA?.spots || [];
    spots.forEach((sp, i) => {
      if (!sp?.pos) return;
      const [x, z] = sp.pos;
      const dot = new THREE.Mesh(
        new THREE.CircleGeometry(0.1, 14),
        new THREE.MeshBasicMaterial({ color: 0x4ade80, transparent: true, opacity: 0.95, depthWrite: false })
      );
      dot.rotation.x = -Math.PI / 2;
      dot.position.set(x, 0.055, z);
      gSpots.add(dot);
      const lb = navLabel(`S${i + 1}·${sp.label || sp.id}`, '#4ade80', 0.24);
      lb.position.set(x, 0.38, z);
      gSpots.add(lb);
    });
  }

  const edgePts = [];
  for (const [a, b] of (NAV_DATA?.edges || [])) {
    const na = nodes[a], nb = nodes[b];
    if (!na || !nb) continue;
    edgePts.push(new THREE.Vector3(na[0], 0.045, na[1]), new THREE.Vector3(nb[0], 0.045, nb[1]));
  }
  if (edgePts.length) {
    const geo = new THREE.BufferGeometry().setFromPoints(edgePts);
    gNodes.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0x5aa9ff, transparent: true, opacity: 0.55 })));
  }

  const routeGeo = new THREE.BufferGeometry();
  nav3dRoutePos = new Float32Array(3 * 96);
  routeGeo.setAttribute('position', new THREE.BufferAttribute(nav3dRoutePos, 3));
  routeGeo.setDrawRange(0, 0);
  nav3dRoute = new THREE.Line(routeGeo, new THREE.LineBasicMaterial({ color: 0x6fffd2, transparent: true, opacity: 0.95 }));
  nav3dRoute.frustumCulled = false;
  g.add(nav3dRoute);

  g.visible = true;
  world.scene.add(g);
  nav3dGroup = g;
}

function setNav3D(on) {
  buildNav3D();
  if (nav3dGroup) nav3dGroup.visible = !!on;
  toast(on ? '导航调试层：开（N 键切换）' : '导航调试层：关');
}

function updateNav3DRoute() {
  if (!nav3dGroup || !nav3dGroup.visible || !nav3dRoute) return;
  const pts = (walkPredict && Array.isArray(walkPredict.points) && walkPredict.points.length > 1)
    ? walkPredict.points
    : (Array.isArray(state?.her?.route) ? state.her.route : null);
  if (!pts || pts.length < 2) {
    nav3dRoute.geometry.setDrawRange(0, 0);
    return;
  }
  const maxPts = Math.floor(nav3dRoutePos.length / 3);
  let n = 0;
  const start = state?.her?.pos;
  if (start) {
    nav3dRoutePos[n * 3] = start[0]; nav3dRoutePos[n * 3 + 1] = 0.09; nav3dRoutePos[n * 3 + 2] = start[1];
    n += 1;
  }
  for (const p of pts) {
    if (!p || n >= maxPts) break;
    nav3dRoutePos[n * 3] = p[0]; nav3dRoutePos[n * 3 + 1] = 0.09; nav3dRoutePos[n * 3 + 2] = p[1];
    n += 1;
  }
  nav3dRoute.geometry.attributes.position.needsUpdate = true;
  nav3dRoute.geometry.setDrawRange(0, n);
}

let navMapEl = null;
let devMode = false;

document.getElementById('roomLabelBtn')?.addEventListener('click', () => setRoomLabels(!roomLabelsOn));

function setDevMode(on) {
  devMode = !!on;
  // 开发模式同时打开「动作触发」浮层（原来的 ?animdbg=1）
  window.__ANIMDBG = devMode;
  if (!devMode) {
    const dbg = document.getElementById('__animdbg');
    if (dbg) dbg.remove();
  }
  if (devMode) {
    if (!navMapEl || !document.body.contains(navMapEl)) showNavMap();
    setNav3D(true);
  } else {
    if (navMapEl) { navMapEl.remove(); navMapEl = null; }
    if (nav3dGroup) nav3dGroup.visible = false;
  }
  const btn = document.getElementById('devModeBtn');
  if (btn) { btn.setAttribute('aria-pressed', String(devMode)); btn.textContent = devMode ? '开发模式：开' : '开发模式'; }
  const st = document.getElementById('settingsState');
  if (st) st.textContent = devMode ? '开发中' : '功能';
}

function positionSettingsMenu() {
  const chip = document.getElementById('settingsChip');
  const menu = document.getElementById('settingsMenu');
  if (!chip || !menu) return;
  const r = chip.getBoundingClientRect();
  menu.style.left = Math.round(Math.min(r.left, innerWidth - 170)) + 'px';
  menu.style.top = Math.round(r.bottom + 8) + 'px';
}

// 设置下拉菜单（开发模式）
{
  const chip = document.getElementById('settingsChip');
  const menu = document.getElementById('settingsMenu');
  if (chip && menu) {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = menu.hidden;
      menu.hidden = !open;
      if (open) positionSettingsMenu();
      chip.setAttribute('aria-expanded', String(open));
      chip.classList.toggle('active', open);
    });
    document.addEventListener('click', (e) => {
      if (!menu.hidden && !menu.contains(e.target) && e.target !== chip) {
        menu.hidden = true;
        chip.setAttribute('aria-expanded', 'false');
        chip.classList.remove('active');
      }
    });
    const dev = document.getElementById('devModeBtn');
    if (dev) dev.addEventListener('click', () => { setDevMode(!devMode); });
  }
}

let navMapBig = false;
function showNavMap(bigMode = navMapBig) {
  navMapBig = !!bigMode;
  const data = NAV_DATA;
  if (!data) { toast('没有路网数据'); return; }

  const W = navMapBig ? Math.min(innerWidth - 80, 1200) : 620;
  const H = navMapBig ? Math.min(innerHeight - 120, 820) : 430;
  const pad = 14;
  const size = data.size || { w: 13.2, d: 9 };
  const sc = Math.min((W - pad * 2) / size.w, (H - pad * 2) / size.d);
  const ox = (W - size.w * sc) / 2;
  const oz = (H - size.d * sc) / 2;
  const px = (x) => ox + x * sc;
  const pz = (z) => oz + z * sc;

  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const cv = document.createElement('canvas');
  cv.id = 'navMap';
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  cv.style.width = W + 'px';
  cv.style.height = H + 'px';
  const base = 'z-index:99999;background:rgba(10,16,26,.94);border:1px solid rgba(150,190,230,.35);border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.55);cursor:zoom-in;';
  cv.style.cssText = navMapBig
    ? 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);' + base + 'cursor:zoom-out;'
    : 'position:fixed;left:16px;bottom:16px;' + base;
  const old = document.getElementById('navMap');
  if (old) old.remove();
  document.body.appendChild(cv);
  navMapEl = cv;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  for (const r of data.rooms || []) {
    const [x0, z0, x1, z1] = r.bounds;
    ctx.fillStyle = 'rgba(90,140,190,.10)';
    ctx.fillRect(px(x0), pz(z0), (x1 - x0) * sc, (z1 - z0) * sc);
    ctx.strokeStyle = 'rgba(150,190,230,.4)';
    ctx.strokeRect(px(x0), pz(z0), (x1 - x0) * sc, (z1 - z0) * sc);
    ctx.fillStyle = 'rgba(200,220,240,.6)';
    ctx.font = '11px sans-serif';
    ctx.fillText(r.name, px(x0) + 4, pz(z0) + 13);
  }

  // 1 米网格，方便目测距离
  ctx.save();
  ctx.strokeStyle = 'rgba(120,170,220,.12)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let gx = 0; gx <= size.w + 0.001; gx += 1) {
    ctx.moveTo(px(gx), pz(0));
    ctx.lineTo(px(gx), pz(size.d));
  }
  for (let gz = 0; gz <= size.d + 0.001; gz += 1) {
    ctx.moveTo(px(0), pz(gz));
    ctx.lineTo(px(size.w), pz(gz));
  }
  ctx.stroke();
  ctx.restore();

  ctx.font = '8px sans-serif';
  (data.keepout || []).forEach((k, i) => {
    const [x0, z0, x1, z1] = k.rect;
    ctx.fillStyle = 'rgba(240,90,90,.18)';
    ctx.fillRect(px(x0), pz(z0), (x1 - x0) * sc, (z1 - z0) * sc);
    ctx.strokeStyle = 'rgba(240,90,90,.55)';
    ctx.strokeRect(px(x0), pz(z0), (x1 - x0) * sc, (z1 - z0) * sc);
    ctx.fillStyle = 'rgba(255,150,140,.95)';
    ctx.fillText('K' + (i + 1), px(x0) + 2, pz(z0) + 9);
  });

  ctx.strokeStyle = 'rgba(120,200,255,.5)';
  ctx.beginPath();
  for (const [a, b] of data.edges || []) {
    const na = (data.nodes || {})[a];
    const nb = (data.nodes || {})[b];
    if (!na || !nb) continue;
    ctx.moveTo(px(na[0]), pz(na[1]));
    ctx.lineTo(px(nb[0]), pz(nb[1]));
  }
  ctx.stroke();

  ctx.font = '8px sans-serif';
  (data.spots || []).forEach((sp, i) => {
    ctx.fillStyle = 'rgba(120,240,170,.9)';
    ctx.beginPath();
    ctx.arc(px(sp.pos[0]), pz(sp.pos[1]), 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(160,250,195,.9)';
    ctx.fillText(`S${i + 1}·${sp.label || sp.id}`, px(sp.pos[0]) + 4, pz(sp.pos[1]) + 3);
  });

  ctx.font = '8px sans-serif';
  Object.keys(data.nodes || {}).forEach((id, i) => {
    const p = data.nodes[id];
    ctx.fillStyle = '#ffd479';
    ctx.beginPath();
    ctx.arc(px(p[0]), pz(p[1]), 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,230,180,.85)';
    ctx.fillText('P' + (i + 1), px(p[0]) + 4, pz(p[1]) - 3);
  });

  ctx.font = '11px sans-serif';
  ctx.fillStyle = 'rgba(220,235,250,.85)';
  ctx.fillText('P=路点  S=站位  K=家具禁区  蓝线=可走边', 12, H - 12);

  // 比例尺：自动选 0.5 / 1 / 2 / 5 米里最合适的一档
  {
    const choices = [0.5, 1, 2, 5, 10];
    let meters = choices[0];
    for (const c of choices) if (c * sc <= 150) meters = c;
    const barPx = meters * sc;
    const bx = W - 20 - barPx;
    const by = H - 26;
    ctx.save();
    ctx.strokeStyle = 'rgba(220,235,250,.9)';
    ctx.fillStyle = 'rgba(220,235,250,.9)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx + barPx, by);
    ctx.moveTo(bx, by - 5);
    ctx.lineTo(bx, by + 5);
    ctx.moveTo(bx + barPx, by - 5);
    ctx.lineTo(bx + barPx, by + 5);
    ctx.stroke();
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`${meters} m`, bx + barPx / 2, by - 9);
    ctx.textAlign = 'left';
    ctx.restore();
  }
  cv.addEventListener('click', () => { showNavMap(!navMapBig); });
}
bindTimeBar();
updateTimeUI();
applyRoomLabels();
layoutSideCards();
window.addEventListener('resize', () => { try { layoutSideCards(); } catch {} });
if (params.get('skydebug') === '1') { window.__SKYDEBUG = true; }
if (params.get('animdbg') === '1') { window.__ANIMDBG = true; }   // 调试快捷方式；日常用「开发模式」即可
if (params.get('walkdbg') === '1') { window.__WALKDBG = true; }
if (params.get('nav') === '1') { setTimeout(() => setDevMode(true), 600); }
if (params.get('dev') === '1') setTimeout(() => setDevMode(true), 600);
if (params.get('navbig') === '1') setTimeout(() => { setDevMode(true); setTimeout(() => showNavMap(true), 300); }, 600);
if (params.get('devmenu') === '1') setTimeout(() => {
  const chip = document.getElementById('settingsChip');
  const menu = document.getElementById('settingsMenu');
  if (chip && menu) {
    menu.hidden = false;
    positionSettingsMenu();
    chip.setAttribute('aria-expanded', 'true');
    chip.classList.add('active');
  }
}, 1200);
if (params.get('sofaplay') === '1') setTimeout(() => { void sofaPlay(); }, 1200);
if (params.get('chaiseplay') === '1') setTimeout(() => { void chaisePlay(); }, 1200);
if (params.get('chaisesit') === '1') setTimeout(() => { chaisePhase = 'play'; chaiseT0 = Date.now(); }, 800);
if (params.get('sofasit') === '1') setTimeout(() => { sofaPhase = 'play'; sofaT0 = Date.now(); }, 800);
{
  const aw = Number(params.get('autowake') || 0);
  if (aw > 0) setTimeout(() => { void act('wake'); }, aw);
}
{
  const awalk = Number(params.get('autowalk') || 0);
  if (awalk > 0) setTimeout(() => { void act('go', { pos: [9.6, 3.2] }); }, awalk);
}


// 搜索框：输入即过滤
{
  const search = document.getElementById('petSearch');
  const pq = params.get('petq');
  if (search && pq) { search.value = pq; }

  search.dataset.bound = '1';
  if (search) search.addEventListener('input', () => renderPetPanel());
}
renderPetPanel();
// ?playaction=动作名：直接播同名 webm 动作
{
  const pa = params.get('playaction');
  if (pa) setTimeout(() => playPetAction(pa, pa), 1500);
}

$('talkSend').addEventListener('click', sendTalk);
$('talkInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendTalk(); });

document.querySelectorAll('#cams button').forEach((b) => {
  b.addEventListener('click', () => {
    if (b.dataset.cam === 'overview' && VIEW.follow) resetView();
    else setMode(b.dataset.cam);
  });
});
$('clickMoveChip')?.addEventListener('click', () => {
  clickMoveOn = !clickMoveOn;
  localStorage.setItem('home-click-move', clickMoveOn ? '1' : '0');
  applyClickMovePref(true);
  if (!clickMoveOn) $('info').classList.add('hide');
});

$('viewChip')?.addEventListener('click', () => {
  if (charMode !== 'webm') { toast('这个视角切换只在立绘模式可用'); return; }
  spriteView = spriteView === 'free' ? 'front' : 'free';
  localStorage.setItem('home-sprite-view', spriteView);
  applySpriteViewPref();
  lastBackView = null;
  lastViewZone = null;
  syncCharacter();
  toast(spriteView === 'free' ? '自由朝向：待机也会随镜头转身' : '正面待机：站着看镜头，走路仍按方向');
});

document.querySelectorAll('#camModeChip button[data-cam-mode]').forEach((button) => {
  button.addEventListener('click', () => setCameraMode(button.dataset.camMode));
});

function setTvOverlayMode(mode) {
  const overlay = $('tvOverlay');
  const video = $('tvOverlayVideo');
  if (!overlay) return;
  if (!tvStream) mode = 'off';
  if (!['off', '50', '80', 'full'].includes(mode)) mode = 'off';
  tvOverlayMode = mode;
  overlay.classList.remove('is-50', 'is-80', 'is-full');
  overlay.classList.toggle('on', mode !== 'off');
  if (mode !== 'off') overlay.classList.add(`is-${mode}`);
  if (video) {
    if (mode === 'off') {
      try { video.pause(); } catch {}
    } else {
      video.play().catch(() => {});
    }
  }
  const btn = $('tvSizeBtn');
  if (btn) {
    btn.textContent = mode === 'off' ? '电视 50%' : mode === '50' ? '电视 50%' : mode === '80' ? '电视 80%' : '电视 全屏';
    btn.classList.toggle('active', mode !== 'off');
  }
  overlay.setAttribute('aria-hidden', String(mode === 'off'));
}

function showTvQuote(text, ms = 6500) {
  const el = $('tvQuote');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  if (tvQuoteTimer) clearTimeout(tvQuoteTimer);
  tvQuoteTimer = setTimeout(() => {
    el.hidden = true;
    tvQuoteTimer = 0;
  }, ms);
}

function focusTvCompanion() {
  setMode('overview');
  VIEW.follow = false;
  VIEW.radius = 6.2;
  VIEW.az = 0;
  VIEW.elev = 0.44;
  VIEW.target.set(6.3, 0.95, 2.6);
}

function videoOpinionLine() {
  const mood = Number(state?.emotion?.mood);
  const high = [
    '这个好看，再看一个嘛。',
    '画面好漂亮，我记住了。',
    '你挑的？那我也觉得好看。'
  ];
  const mid = [
    '嗯，还行，挺下饭的。',
    '这个节奏有点慢，不过陪你看看。',
    '刚刚那个转场挺有意思。'
  ];
  const low = [
    '有点吵……我靠一会儿。',
    '这个我不太懂，但你喜欢就好。',
    '看一会儿就好，别熬太晚。'
  ];
  const pool = Number.isFinite(mood) && mood >= 70 ? high : Number.isFinite(mood) && mood < 38 ? low : mid;
  return pool[Math.floor(Math.random() * pool.length)];
}

function showVideoOpinion() {
  if (!tvStream) { toast('先把抖音投到电视上，再看观后感'); return; }
  if (state?.her?.asleep) { toast('她睡着了，先叫醒她'); return; }
  const mood = Number(state?.emotion?.mood);
  const line = videoOpinionLine();
  opinionClip = Number.isFinite(mood) && mood >= 70 ? 'react_happy' : Number.isFinite(mood) && mood < 38 ? 'idle_look' : 'react_shy';
  opinionUntil = Date.now() + 7000;
  lastOnceKey = '';
  lastOnceAt = 0;
  syncCharacter();
  setBubble(line, 7000, { kind: 'talk' });
  showTvQuote(`${PET_NAME}：${line}`, 7000);
  if (opinionTimer) clearTimeout(opinionTimer);
  opinionTimer = setTimeout(() => {
    opinionUntil = 0;
    opinionClip = '';
    opinionTimer = 0;
    syncCharacter();
  }, 7100);
}

async function watchTogether() {
  if (!tvStream) { toast('先把抖音投到电视上，再一起看'); return; }
  if (tvOverlayMode === 'off') setTvOverlayMode('50');
  focusTvCompanion();
  showTvQuote(`${PET_NAME}：我坐这儿，和你一起看。`, 5200);
  setBubble('我坐这儿，和你一起看。', 5200, { kind: 'talk' });
  if (state?.her?.asleep) {
    await act('wake');
    setTimeout(() => act('command', { room: 'living', spot: 'tv' }), 900);
  } else {
    act('command', { room: 'living', spot: 'tv' });
  }
}

$('tvSizeBtn')?.addEventListener('click', () => {
  if (!tvStream) { toast('先点右上角电视投屏'); return; }
  const next = tvOverlayMode === 'off' ? '50' : tvOverlayMode === '50' ? '80' : tvOverlayMode === '80' ? 'full' : 'off';
  setTvOverlayMode(next);
});
$('tvPrevBtn')?.addEventListener('click', () => {
  sendTvCommand('scroll', { deltaY: -1 }).then(() => toast('已切到上一个视频')).catch((error) => toast(error.message));
});
$('tvNextBtn')?.addEventListener('click', () => {
  sendTvCommand('scroll', { deltaY: 1 }).then(() => toast('已切到下一个视频')).catch((error) => toast(error.message));
});
$('tvControlBtn')?.addEventListener('click', () => {
  if (!tvStream) { toast('先打开电视投屏'); return; }
  if (!tvExtensionReady) { toast('没有检测到投屏控制扩展，请按 README 安装'); return; }
  tvControlOn = !tvControlOn;
  applyTvControlPref();
  toast(tvControlOn ? '投屏控制已开启：在电视画面里移动/点击/滚动鼠标' : '投屏控制已关闭');
});
$('tvOverlay')?.addEventListener('pointermove', (e) => {
  if (!tvControlOn || !tvExtensionReady) return;
  const now = performance.now();
  if (now - tvLastMoveAt < 55) return;
  tvLastMoveAt = now;
  const p = tvContentPoint(e);
  sendTvCommand('move', p).catch(() => {});
});
$('tvOverlay')?.addEventListener('pointerdown', (e) => {
  if (!tvControlOn || !tvExtensionReady) return;
  e.preventDefault();
  tvPointerStart = { x: e.clientX, y: e.clientY };
  try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch {}
});
$('tvOverlay')?.addEventListener('pointerup', (e) => {
  if (!tvControlOn || !tvExtensionReady || !tvPointerStart) return;
  const moved = Math.hypot(e.clientX - tvPointerStart.x, e.clientY - tvPointerStart.y);
  tvPointerStart = null;
  if (moved < 7) {
    const p = tvContentPoint(e);
    sendTvCommand('click', p).catch((error) => toast(error.message));
  }
});
$('tvOverlay')?.addEventListener('wheel', (e) => {
  if (!tvControlOn || !tvExtensionReady) return;
  e.preventDefault();
  const p = tvContentPoint(e);
  sendTvCommand('wheel', { ...p, deltaY: e.deltaY > 0 ? 1 : -1 }).catch(() => {});
}, { passive: false });
$('tvFollowBtn')?.addEventListener('click', () => {
  if (!tvStream) { toast('先打开电视投屏，再让她跟过来'); return; }
  tvFollowOn = !tvFollowOn;
  applyTvFollow();
  if (tvFollowOn) {
    void takeHerToTv();
    toast(`${PET_NAME}跟过来了：她在左下角陪你一起看电视`);
  } else {
    toast(`${PET_NAME}不再跟随；电视还在继续`);
  }
});
$('tvCompanionSize')?.addEventListener('input', (event) => {
  tvCompanionSize = Math.max(160, Math.min(520, Number(event.target.value) || 320));
  localStorage.setItem('home-tv-companion-size', String(tvCompanionSize));
  applyTvCompanionSize();
});
$('tvCompanionBubbleBtn')?.addEventListener('click', () => {
  tvBubbleOn = !tvBubbleOn;
  localStorage.setItem('home-tv-bubble', tvBubbleOn ? '1' : '0');
  applyTvBubblePref();
  syncTvOpinionTimer();
  if (tvBubbleOn && tvFollowOn && tvStream) requestTvOpinion(false);
  else if (!tvBubbleOn) toast(`${PET_NAME}的气泡已关闭`);
});
$('tvCompanionShotBtn')?.addEventListener('click', () => requestTvOpinion(true));
$('tvWatchBtn')?.addEventListener('click', watchTogether);
$('tvOpinionBtn')?.addEventListener('click', showVideoOpinion);
$('tvStopBtn')?.addEventListener('click', () => stopTvCast('电视已关闭'));

$('tvChip')?.addEventListener('click', () => {
  if (tvStream) { stopTvCast('已停止电视投屏'); return; }
  startTvCast();
});

$('soundChip')?.addEventListener('click', () => {
  soundOn = !soundOn;
  localStorage.setItem('home-sound', soundOn ? '1' : '0');
  applySoundPref();
  if (soundOn) {
    unlockAudio();
    playClick();
  }
});

// 立绘来源切换已合并进内部逻辑，不再有按钮

// ── 天空下拉菜单 ──────────────────────────────────────────────────────────
const skyMenu = $('skyMenu');
function closeSkyMenu() {
  if (!skyMenu) return;
  skyMenu.hidden = true;
  $('skyChip')?.classList.remove('open');
}
function openSkyMenu() {
  if (!skyMenu) return;
  const chip = $('skyChip');
  const r = chip?.getBoundingClientRect();
  if (r) {
    skyMenu.style.left = `${Math.round(Math.min(r.left, innerWidth - 150))}px`;
    skyMenu.style.top = `${Math.round(r.bottom + 8)}px`;
  }
  const active = currentSkyKey();
  skyMenu.querySelectorAll('button[data-sky]').forEach((b) => {
    b.classList.toggle('on', b.dataset.sky === active);
  });
  skyMenu.hidden = false;
  updateAutoBtn();
  chip?.classList.add('open');
}
$('skyChip')?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (skyMenu?.hidden === false) closeSkyMenu();
  else openSkyMenu();
});
function updateAutoBtn() {
  const b = document.getElementById('autoSkyBtn');
  if (!b) return;
  b.setAttribute('aria-pressed', autoSkyOn ? 'true' : 'false');
  b.classList.toggle('on', autoSkyOn);
  b.textContent = autoSkyOn ? '🎲 自动 · 开' : '🎲 自动';
}
document.getElementById('autoSkyBtn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  autoSkyOn = !autoSkyOn;
  localStorage.setItem('home-sky-auto', autoSkyOn ? '1' : '0');
  updateAutoBtn();
  if (autoSkyOn) {
    toast?.('自动天气：开（8–20 分钟换一次）');
    applyAutoWeather();
  } else {
    clearTimeout(autoSkyTimer);
    toast?.('自动天气：关');
  }
});
document.getElementById('wxIntensity')?.addEventListener('input', (e) => {
  const v = Math.max(0, Math.min(100, Number(e.target.value) || 0));
  weatherIntensity = v / 100;
  localStorage.setItem('home-wx-intensity', String(v));
  const st = document.getElementById('wxIntensityState');
  if (st) st.textContent = `${v}%`;
  refreshSky();
});

// 闪电：雷雨/冰雹时随机闪一下，并让环境音补一声雷
let lastFlashAt = 0;
function maybeLightning(now, weather) {
  if (!['storm', 'hail'].includes(weather)) return;
  if (now - lastFlashAt < 3500) return;
  if (Math.random() > 0.045) return;
  lastFlashAt = now;
  try { world?.flashLightning?.(0.5 + Math.random() * 0.8); } catch { /* 忽略 */ }
  try { ambience.thunder?.(); } catch { /* 忽略 */ }
}


skyMenu?.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-sky]');
  if (!btn) return;
  e.stopPropagation();
  skyMode = btn.dataset.sky;
  skyRealTime = false;
  if (autoSkyOn) {
    autoSkyOn = false;
    localStorage.setItem('home-sky-auto', '0');
    clearTimeout(autoSkyTimer);
    updateAutoBtn();
  }
  localStorage.setItem('home-sky', skyMode);
  localStorage.setItem('home-sky-time', '0');
  applySkyPref();
  refreshSky();
  closeSkyMenu();
  toast(`天空：${SKY_LABEL[skyMode]}`);
});
updateAutoBtn();
{
  const vol = document.getElementById('wxIntensity');
  const st = document.getElementById('wxIntensityState');
  const v = Math.round(weatherIntensity * 100);
  if (vol) vol.value = String(v);
  if (st) st.textContent = `${v}%`;
}
if (autoSkyOn) scheduleAutoWeather();

document.addEventListener('click', (e) => {
  if (skyMenu?.hidden === false && !e.target.closest('#skyMenu') && !e.target.closest('#skyChip')) closeSkyMenu();
});
document.addEventListener('keydown', (e) => {
  const k = e.key;
  // 1/2/3 分别开关 路点 / 禁区 / 站位
  if ((k === '1' || k === '2' || k === '3') && !e.ctrlKey && !e.metaKey && !e.altKey && nav3dGroup?.userData) {
    const tag = (e.target && e.target.tagName) || '';
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
      const key = k === '1' ? 'gNodes' : k === '2' ? 'gKeep' : 'gSpots';
      const grp = nav3dGroup.userData[key];
      if (grp) {
        grp.visible = !grp.visible;
        const names = { gNodes: '路点', gKeep: '禁区', gSpots: '站位' };
        toast(`${names[key]}：${grp.visible ? '显示' : '隐藏'}`);
        e.preventDefault();
        return;
      }
    }
  }
  if ((k === 'n' || k === 'N') && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const tag = (e.target && e.target.tagName) || '';
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
      e.preventDefault();
      setDevMode(!devMode);
      return;
    }
  }
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSkyMenu(); });
if (params.get('skymenu') === '1') setTimeout(openSkyMenu, 1500);

$('skyTimeChip')?.addEventListener('click', () => {
  skyRealTime = !skyRealTime;
  localStorage.setItem('home-sky-time', skyRealTime ? '1' : '0');
  if (!skyRealTime) skyMode = currentSkyKey() === 'rain' ? 'night' : currentSkyKey();
  applySkyPref();
  refreshSky();
  toast(skyRealTime ? '天空跟随电脑时间' : '天空固定为你选的时段');
});

$('bubbleChip')?.addEventListener('click', () => {
  bubbleOn = !bubbleOn;
  localStorage.setItem('home-bubble', bubbleOn ? '1' : '0');
  applyBubblePref();
  if (bubbleOn && (state?.her?.speech || state?.her?.activity)) setBubble(state.her.speech || state.her.activity, 3600);
});

document.querySelectorAll('#modeChip button').forEach((b) => {
  b.addEventListener('click', async () => {
    const next = b.dataset.mode;
    if (next === '3d' && !modelReady && !chibiReady) toast('正在加载 3D 模型…');
    charMode = next;
    if (charMode === '3d') {
      const ok = await ensure3d();
      if (!ok) {
        charMode = 'webm';
        toast('3D 模型没加载成功，先看立绘');
      } else {
        toast(modelReady ? '成品 3D 模型已就位' : '3D 占位模型已就位');
        focusCharacter();
      }
    }
    if (charMode === 'webm' && VIEW.follow) resetView();
    localStorage.setItem('home-char-mode', charMode);
    applySpriteViewPref();
    document.querySelectorAll('#modeChip button').forEach((x) => x.classList.toggle('on', x.dataset.mode === charMode));
$('modelQualityChip')?.addEventListener('click', switchModelQuality);
updateModelQualityChip(false);
applyBubblePref();
    applyCharVisibility();
    setMode(VIEW.mode);
  });
});
document.querySelectorAll('#modeChip button').forEach((x) => x.classList.toggle('on', x.dataset.mode === charMode));
applyBubblePref();
applyClickMovePref();
applySoundPref();
applySpriteViewPref();
applyCameraModePref();
applyTvCastChip();
applySkyPref();
refreshSky();

// ── 房间私聊：独立会话，不经过 QQ ──────────────────────────────────────────
const CHAT_KEY = 'home-room-chat-v1';
let chatHistory = [];
let chatSending = false;
let chatOpen = false;

function loadRoomChat() {
  try {
    const arr = JSON.parse(localStorage.getItem(CHAT_KEY) || '[]');
    if (Array.isArray(arr)) chatHistory = arr.filter((m) => m && (m.role === 'me' || m.role === 'her') && typeof m.text === 'string').slice(-80);
  } catch { chatHistory = []; }
}
function saveRoomChat() {
  try { localStorage.setItem(CHAT_KEY, JSON.stringify(chatHistory.slice(-80))); } catch {}
}
function chatLine(role, text, extra = '') {
  const el = document.createElement('div');
  el.className = `chat-msg ${role}${extra}`;
  el.textContent = text;
  $('chatLog').appendChild(el);
  $('chatLog').scrollTop = $('chatLog').scrollHeight;
  return el;
}
function renderRoomChat() {
  const log = $('chatLog');
  if (!log) return;
  log.replaceChildren();
  for (const m of chatHistory) chatLine(m.role, m.text);
  log.scrollTop = log.scrollHeight;
}
function addRoomChat(role, text, persist = true) {
  if (persist) {
    chatHistory.push({ role, text: String(text), at: Date.now() });
    chatHistory = chatHistory.slice(-80);
    saveRoomChat();
  }
  return chatLine(role, String(text));
}
function setRoomChatOpen(open) {
  chatOpen = !!open;
  $('roomChat').hidden = !chatOpen;
  $('chatToggle').classList.toggle('open', chatOpen);
  $('chatToggle').textContent = chatOpen ? '收起聊天' : '和她聊聊';
  if (chatOpen) {
    renderRoomChat();
    setTimeout(() => $('chatInput')?.focus(), 80);
  }
}

async function sendRoomChat() {
  if (chatSending) return;
  const input = $('chatInput');
  const text = String(input?.value || '').trim();
  if (!text) return;
  input.value = '';
  chatSending = true;
  $('chatSend').disabled = true;
  addRoomChat('me', text);
  const typing = chatLine('her', '她正在想…', ' typing');
  try {
    const res = await fetch(api('/api/room/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    addRoomChat('her', String(data.reply || '嗯。'));
  } catch (error) {
    chatLine('sys', `没接上：${error?.message || error}`);
  } finally {
    typing.remove();
    chatSending = false;
    $('chatSend').disabled = false;
    $('chatInput')?.focus();
  }
}

$('chatToggle')?.addEventListener('click', () => setRoomChatOpen(!chatOpen));
$('chatClose')?.addEventListener('click', () => setRoomChatOpen(false));
$('chatForm')?.addEventListener('submit', (event) => { event.preventDefault(); sendRoomChat(); });
loadRoomChat();
if (!chatHistory.length) {
  addRoomChat('her', '嗯？我在。想说什么就说吧。');
} else {
  renderRoomChat();
}

if (charMode === '3d') actor.setVisible(false);
applyCharVisibility();

// ── 轮询 ──────────────────────────────────────────────────────────────────
async function poll() {
  if (requestInFlight) return;
  requestInFlight = true;
  try {
    const res = await fetch(withToken('/api/home/state'), { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    applyState(data);
    $('qqChip').classList.add('online');
  } catch (error) {
    $('qqText').textContent = '连不上桥接';
    if (!state) {
      $('activityText').textContent = '桥接还没起来，先把房间亮着。';
    }
  } finally {
    requestInFlight = false;
  }
}

// ── 主循环 ────────────────────────────────────────────────────────────────
let lastEnvTick = 0;
let eyesPrev = null;                       // 她的视角上一帧位置（算移动方向用）
const eyesDir = { x: 0, z: -1 };           // 平滑后的视线方向
let prevT = performance.now();
let fpsAcc = 0;
let fpsN = 0;
let lastAdapt = 0;
let ratio = renderer.getPixelRatio();

// 动画层异常检测：重影（两层可见）/ 空白（全透明）都会立刻上报
let ghostWatch = { ghostSince: 0, blankSince: 0, lastReport: 0 };
function watchLayers(now) {
  const layers = actorWebm?.layers || [];
  if (!layers.length) return;
  const vis = layers.filter((l) => (l.material?.opacity || 0) > 0.5).length;
  const allHidden = layers.every((l) => (l.material?.opacity || 0) < 0.1);
  const report = (type, extra) => {
    if (now - ghostWatch.lastReport < 1500) return;
    ghostWatch.lastReport = now;
    try {
      fetch('/api/debug/client', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        keepalive: true,
        body: JSON.stringify({
          type, clip: actorWebm.current, ...extra,
          layers: layers.map((l) => ({ o: Number((l.material?.opacity || 0).toFixed(2)), t: l.target, v: l.mesh?.visible === true }))
        })
      }).catch(() => {});
    } catch { /* 忽略 */ }
  };
  if (vis >= 2) {
    if (!ghostWatch.ghostSince) ghostWatch.ghostSince = now;
    if (now - ghostWatch.ghostSince > 150) { report('ghost', { vis }); ghostWatch.ghostSince = 0; }
  } else ghostWatch.ghostSince = 0;
  if (allHidden) {
    if (!ghostWatch.blankSince) ghostWatch.blankSince = now;
    if (now - ghostWatch.blankSince > 250) { report('blank'); ghostWatch.blankSince = 0; }
  } else ghostWatch.blankSince = 0;
}

// 调试：?clipdebug=1 时每 1.1 秒强切一个动作，用来抓切换瞬间的帧
if (new URLSearchParams(location.search).has('clipdebug')) {
  const cycle = ['待机', '跳舞', '走路', '吃午餐', '游泳', '开心小跑'];
  let ci = 0;
  setInterval(() => {
    try {
      actor.setClip(cycle[ci % cycle.length]);
      ci += 1;
    } catch { /* 忽略 */ }
  }, 1100);
}

// 指南针：把「镜头相对目标点的方位」转成罗盘旋转，N 固定指向世界 -Z
const compassEl = document.getElementById('compassDial');
function updateCompass() {
  if (!compassEl) return;
  const t = VIEW.target;
  const dx = camera.position.x - t.x;
  const dz = camera.position.z - t.z;
  const deg = Math.atan2(dx, dz) * 180 / Math.PI;
  compassEl.style.transform = `rotate(${deg.toFixed(1)}deg)`;
}

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.06, (now - prevT) / 1000);
  prevT = now;
  gardenController?.tick(now);
  updateOpenView(dt);
  updateCamera(dt);
  updateCompass();
  watchLayers(now);
  maybeLightning(now, skyOptions().weather === 'storm' ? 'storm' : skyOptions().weather);
  // 每秒把天气/房间同步给环境音（切天气不一定伴随房间状态变化）
  if (now - (window.__ambSyncAt || 0) > 1000) {
    window.__ambSyncAt = now;
    try { ambience.setScene({ weather: currentSkyKey(), room: state?.her?.room }); } catch { /* 忽略 */ }
  }

  const her = state?.her;
  if (her) {
    let displayPos = her.pos;
    const swimmingNow = !!(her.swim && Date.now() < her.swim.until);
    if (swimmingNow) displayPos = swimHer(her).pos;
    if (walkPredict && her.walking && !swimmingNow) {
      const elapsed = Math.max(0, (performance.now() - walkPredict.at) / 1000);
      displayPos = advanceRoute(walkPredict.points, walkPredict.start, walkPredict.speed * elapsed);
    }
    const dragging = !!charDrag?.active;
    if (dragging) displayPos = charDrag.pos;
    else if (placeHold && performance.now() < placeHold.until) displayPos = placeHold.pos;
    // 按实际位移判定是否在走：开始移动立刻切跑动动画，停下立刻切回待机
    const movedDist = walkPrevPos
      ? Math.hypot(displayPos[0] - walkPrevPos[0], displayPos[1] - walkPrevPos[1])
      : 0;
    walkPrevPos = [displayPos[0], displayPos[1]];
    const movingNow = !swimmingNow && movedDist > 0.0035;
    stillMs = movingNow ? 0 : stillMs + dt * 1000;
    const derivedWalk = !dragging && !placeHold
      && (movingNow || (stillMs < 120 && (her.route?.length || 0) > 0));
    if (derivedWalk !== motionWalking) {
      motionWalking = derivedWalk;
      syncCharacter();
    }
    if (window.__ANIMDBG) {
      let el = document.getElementById('__animdbg');
      if (!el) {
        el = document.createElement('div');
        el.id = '__animdbg';
        el.style.cssText = 'position:fixed;right:12px;top:120px;z-index:99999;background:rgba(0,0,0,.78);color:#9fe8ff;font:12px/1.5 monospace;padding:8px 10px;border-radius:8px;white-space:pre;pointer-events:none;max-width:320px';
        document.body.appendChild(el);
      }
      const pick = her.freestylePick;
      const lines = [
        'animdbg',
        `kind=${her.kind} clip=${actor.current}`,
        `activity=${String(her.activity || '').slice(0, 20)}`,
        pick ? `触发=${pick.by}(${pick.group}) 走到点位=${pick.travel}` : '触发=需求/日程',
        pick ? `候选 ${pick.top.join('  ')}` : ''
      ];
      el.textContent = lines.filter(Boolean).join('\n');
    }
    if (window.__WALKDBG) {
      let el = document.getElementById('__walkdbg');
      if (!el) {
        el = document.createElement('div');
        el.id = '__walkdbg';
        el.style.cssText = 'position:fixed;left:12px;top:120px;z-index:99999;background:rgba(0,0,0,.78);color:#7dff9b;font:12px/1.5 monospace;padding:8px 10px;border-radius:8px;white-space:pre;pointer-events:none';
        document.body.appendChild(el);
      }
      el.textContent = `walkdbg\nchar=${charMode}\nmoving=${movingNow} derived=${derivedWalk}\nstateWalk=${her.walking} predict=${!!walkPredict}\nclip=${actor.current} kind=${her.kind} speed=${her.speed}\nsofa=${sofaPhase} chaise=${chaisePhase}`;
    }
    if (window.__PROBE) {
      window.__probe = {
        movingNow, derivedWalk, stateWalking: her.walking, hasPredict: !!walkPredict,
        clip: actor.current, kind: her.kind, speed: her.speed, asleep: her.asleep
      };
    }
    const walkingNow = derivedWalk;
    lastDisplayPos = displayPos;
    const backNow = isBackView();
    // 镜头从正面转到侧面时，虽然背面状态没变，也要切到侧跑帧。
    const viewZone = her.walking ? (isSideRun(her) ? 'side' : 'front') : (backNow ? 'back' : 'front');
    if (viewZone !== lastViewZone) {
      lastViewZone = viewZone;
      if (!dragging && !placeHold) syncCharacter();
    }
    lastBackView = backNow;
    world.updateCutaway(camera.position, new THREE.Vector3(displayPos[0], 1, displayPos[1]), VIEW.mode !== 'first' && VIEW.mode !== 'eyes');
    const facing = (her.facing || 0) * Math.PI / 180;
    gardenController?.updateCharacter(dragging || placeHold || VIEW.mode === 'eyes' ? { ...her, gardenWork: null } : her, { x: displayPos[0], y: her.elev || 0, z: displayPos[1] }, facing);
    // run_hurry 原片是“朝左跑”：只有侧面跑时按屏幕横向速度决定是否镜像；
    // 正面/背面/待机不镜像，避免左右脸和朝向突然翻面。
    let flip = flipState;
  // 游泳：原画头朝左，按「游动方向在屏幕上的左右」决定是否镜像，
  // 这样去程和回程的头都朝着前进方向。
  if (her.kind === 'swim' && her.swim && !dragging && !placeHold) {
    const leg = Math.max(1200, Number(her.swim.oneWayMs) || 5000);
    const phase = ((Date.now() - her.swim.startedAt) / leg) % 2;
    const dirX = phase < 1 ? 1 : -1;
    camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    flip = new THREE.Vector3(dirX, 0, 0).dot(right) > 0;
  }
    if (charMode === 'webm' && isSideRun(her) && !dragging && !placeHold) {
      camera.updateMatrixWorld();
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
      const move = new THREE.Vector3(Math.sin(facing), 0, -Math.cos(facing));
      const dot = move.dot(right);
      // 带滞回：只有横向分量足够明确才翻面，避免正对/背对镜头时来回抖
      if (dot > 0.22) flipState = true;
      else if (dot < -0.22) flipState = false;
      flip = flipState;
    }
  // 游泳：在泳池水面沿泳道来回游，位置由服务端给的 swim 描述插值
  function swimHer(h) {
    const sw = h.swim;
    if (!sw) return h;
    const t = Date.now();
    if (!(t > sw.startedAt) || (sw.until && t > sw.until)) return h;
    const leg = Math.max(1200, Number(sw.oneWayMs) || 6000);
    const phase = ((t - sw.startedAt) / leg) % 2;
    const k = phase < 1 ? phase : 2 - phase;
    const dir = phase < 1 ? 1 : -1;
    const x = sw.from[0] + (sw.to[0] - sw.from[0]) * k;
    return {
      ...h,
      pos: [x, sw.from[1]],
      facing: dir > 0 ? 90 : -90,
      walking: false,
      elev: 0,
      kind: 'swim',
      clip: h.clip || '游泳'
    };
  }

    const shownHer = pinHer(chaisePlayHer(sofaPlayHer(swimHer(PREVIEW ? previewHer(her) : her))));
    // 有“坐上去/躺上去”的覆盖时，位置也要跟着覆盖走，否则人会站在原地被抬高
    const seatedPhase = ['rise', 'enter', 'play', 'exit', 'lower'];
    const seatOverride = seatedPhase.includes(chaisePhase) || seatedPhase.includes(sofaPhase)
      || PREVIEW || PIN_TEST;
    bubbleAnchorPos = (seatOverride || her.kind === 'swim') ? shownHer.pos : null;
    bubbleAnchorElev = displayElevFor(shownHer);
    // 走路/站立时一律贴地：服务端 elev 偶尔会残留座面高度，导致她悬空
    // 高度完全由服务端（support 面 × 姿态）决定，这里不再二次猜测
    if (walkingNow) bubbleAnchorElev = 0;
    // ── 调试埋点：每 500ms 上报一次客户端状态（排查悬空/动画问题）
    if (now - (window.__dbgLast || 0) > 500) {
      window.__dbgLast = now;
      try {
        fetch('/api/debug/client', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          keepalive: true,
          body: JSON.stringify({
            clip: actorWebm.current,
            footFrac: actorWebm.layers[actorWebm.active]?.footFrac || null,
            layers: actorWebm.layers.map((l) => ({ o: Number((l.material?.opacity || 0).toFixed(2)), t: l.target, v: l.mesh?.visible === true })),
            footY: actorWebm.layers[actorWebm.active]?.mesh?.position?.y || null,
            room: her.room, spot: her.spot, pose: her.pose, kind: her.kind,
            elev: her.elev, walking: her.walking === true,
            serverPos: her.pos,
            shownPos: shownHer.pos, shownElev: shownHer.elev,
            displayElev: bubbleAnchorElev,
            chaise: chaisePhase, sofa: sofaPhase,
            seatOverride, walkingNow, model3d: !!modelReady
          })
        }).catch(() => {});
      } catch { /* 忽略 */ }
    }
    actor.update(dt, camera, {
      pos: seatOverride ? shownHer.pos : displayPos, elev: bubbleAnchorElev, walking: walkingNow, flip,
      drinking: her.kind === 'drink' && !her.asleep
    });
    const pose = {
      pos: displayPos, elev: her.elev, pose: her.pose, kind: her.kind, walking: walkingNow,
      facing: her.facing, asleep: her.asleep, activity: her.activity, runStyle: her.runStyle
    };
    if (modelReady && model3d) {
      model3d.setPose(pose);
      model3d.update(dt, camera, { mode: VIEW.mode, lookAtCamera: !walkingNow && !her.gardenWork });
    }
    if (chibiReady && chibi && !modelReady) {
      chibi.setPose(pose);
      chibi.update(dt, camera, { mode: VIEW.mode, lookAtCamera: !walkingNow && !her.gardenWork });
    }
    applyCharVisibility();
  }
  // ── 时间平滑 & 天空刷新（拖时间条时平滑过渡）──
  {
    const realNowHour = (() => { const d = new Date(); return d.getHours() + d.getMinutes() / 60; })();
    if (customHour != null) {
      // 手动时间：平滑追过去
      if (displayHour == null) displayHour = customHour;
      else {
        let d = customHour - displayHour;
        if (d > 12) d -= 24;
        if (d < -12) d += 24;
        displayHour = (displayHour + d * Math.min(1, dt * 2.2) + 24) % 24;
      }
    } else if (skyRealTime) {
      // 真实时间：平滑跟随系统时钟（不再每秒“跳”一次）；
      // 每 REAL_SYNC_MS 只做一次偏差校正，偏差小就不动。
      if (displayHour == null) {
        displayHour = realNowHour;
        lastRealSync = now;
      } else {
        let diff = realNowHour - displayHour;
        if (diff > 12) diff -= 24;
        if (diff < -12) diff += 24;
        if (now - lastRealSync >= REAL_SYNC_MS) {
          lastRealSync = now;
          if (Math.abs(diff) > 0.25) displayHour = realNowHour; // 偏差超过 15 分钟才硬对齐
        }
        // 缓慢追随，1 小时约走 1 小时，不会一顿一顿
        displayHour = (displayHour + diff * Math.min(1, dt * 0.8) + 24) % 24;
      }
    } else {
      const targetHour = Number.isFinite(Number(state?.hour)) ? Number(state.hour) : (displayHour ?? 12);
      if (displayHour == null) displayHour = targetHour;
      else {
        let d = targetHour - displayHour;
        if (d > 12) d -= 24;
        if (d < -12) d += 24;
        displayHour = (displayHour + d * Math.min(1, dt * 2.2) + 24) % 24;
      }
    }
    // 只有时间明显变化、或天气/灯状态变了才重算天空（避免频繁重画贴图）
    const skyKeyNow = `${Math.floor(displayHour * 30) | 0}`;
    const skyDirty = skyKeyNow !== world.__lastSkyHourKey
      || lastSkyPush === 0
      || now - lastSkyPush > 20_000;
    if (skyDirty) {
      lastSkyPush = now;
      world.__lastSkyHourKey = skyKeyNow;
      try {
        world.updateEnvironment({
          ...skyOptions(displayHour),
          lamp: state?.env?.lamp !== false,
          asleep: state?.her?.asleep,
          kind: state?.her?.kind
        });
      } catch { /* 世界还没建好 */ }
    }
    updateTimeUI();
  }
  try { world.updateSun?.(dt); } catch { /* 忽略 */ }
  // 泳池波纹：限制到 30Hz，顶点数很少，几乎不吃性能
  if (world.poolSurf) {
    poolRippleAcc += dt;
    if (poolRippleAcc >= 1 / 30) {
      try { world.poolSurf.update(poolRippleAcc); } catch { /* 忽略 */ }
      poolRippleAcc = 0;
    }
  }
  if (window.__SKYDEBUG) {
    window.__skyDebug = {
      hour: +displayHour.toFixed(3),
      sunI: +(world.sun?.intensity ?? 0).toFixed(3),
      hemiI: +(world.hemi?.intensity ?? 0).toFixed(3),
      sunY: +(world.sun?.position?.y ?? 0).toFixed(2),
      skyKey: world.lastSkyKey || '',
      envHour: world.__lastEnvHour,
      envRT: world.__lastEnvRealTime,
      envWx: world.__lastEnvWeather,
      lamps: (world.lamps || []).reduce((a, l) => a + l.intensity, 0).toFixed(2)
    };
  }
  updateBounce(now);
  updateNav3DRoute();

  // 气泡
  if (bubbleOn && !SHOT && state?.her && VIEW.mode !== 'eyes') {
    const show = Date.now() < bubbleUntil;
    const el = $('bubble');
    if (show) {
      // 气泡锚点必须和“画面里那个人”用同一套位置/高度，
      // 否则走路平滑、坐上沙发/躺椅时就会错位。
      const bp = bubbleAnchorPos || lastDisplayPos || state.her.pos;
      const belev = bubbleAnchorElev || state.her.elev || 0;
      const p = new THREE.Vector3(
        bp[0],
        belev + (state.her.asleep ? 0.75 : 1.72),
        bp[1]
      );
      p.project(camera);
      if (p.z < 1) {
        const x = (p.x * 0.5 + 0.5) * innerWidth;
        const y = (-p.y * 0.5 + 0.5) * innerHeight;
        // 气泡整体再往上抬 26~34px：站立抬满，坐着略少，躺着/睡着最少，避免压住头顶。
        const pose = state.her.pose;
        const lift = state.her.asleep || pose === 'lie' ? 26 : pose === 'sit' ? 30 : 34;
        el.style.left = `${x}px`;
        el.style.top = `${y - lift}px`;
        el.classList.add('show');
      } else el.classList.remove('show');
    } else el.classList.remove('show');
  } else { $('bubble').classList.remove('show'); bubbleKind = ''; }

  if (clickMarkerUntil) {
    const left = clickMarkerUntil - performance.now();
    if (left <= 0) {
      clickMarker.visible = false;
      clickMarkerUntil = 0;
    } else {
      const k = Math.min(1, left / 1300);
      clickMarker.material.opacity = 0.95 * k;
      clickMarker.scale.setScalar(1 + (1 - k) * 0.55);
    }
  }

  if (tvStream && tvMat) tvMat.emissiveIntensity = 0.95;
  if (world.sky) world.sky.position.copy(camera.position);
  world.updateRain?.(dt);
  world.updateSnow?.(dt);
  stormFlashTick(now);
  world.updateSand?.(dt);
  if (!SHOT) maybeSelfAction();
  if (now - lastEnvTick > 60000) {
    lastEnvTick = now;
    world.updateEnvironment({
      ...skyOptions(),
      lamp: state?.env?.lamp !== false,
      asleep: state?.her?.asleep,
      kind: state?.her?.kind
    });
    applySkyPref();
  }
  renderer.render(scene, camera);
  world.setClock?.(state?.hour || 0, 0);

  // 自适应：帧率低了降像素比，连续高了再升回来
  fpsAcc += dt; fpsN += 1;
  if (fpsN >= 60 && now - lastAdapt > 8000 && !SHOT) {
    const fps = fpsN / fpsAcc;
    fpsAcc = 0; fpsN = 0;
    lastAdapt = now;
    if (fps < 42 && ratio > 1.0) {
      ratio = Math.max(1.0, ratio - 0.2);
      renderer.setPixelRatio(ratio);
    } else if (fps > 57 && ratio < Math.min(devicePixelRatio || 1, 1.35)) {
      ratio = Math.min(Math.min(devicePixelRatio || 1, 1.35), ratio + 0.1);
      renderer.setPixelRatio(ratio);
    }
  }
}

// 灯影刷新：太阳角度变了才重画阴影
const origUpdateEnv = world.updateEnvironment;
world.updateEnvironment = (opts) => {
  const r = origUpdateEnv(opts);
  if (r?.shadowDirty) renderer.shadowMap.needsUpdate = true;
  return r;
};

function onResize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  if (gardenController?.isOpen) focusGarden();
}
addEventListener('resize', onResize);

// Garden camera looks back toward the house from the north yard.
function focusGarden() {
  const framing=getGardenFraming(innerWidth,innerHeight,$('garden-panel')?.getBoundingClientRect().left);
  setMode('overview');VIEW.follow=false;VIEW.az=framing.az;VIEW.elev=framing.elev;VIEW.radius=framing.radius;
  VIEW.target.set(...framing.target);world.setLabelsVisible(false);world.setCeilingVisible(false);
  camera.fov=framing.fov;camera.setViewOffset(innerWidth,innerHeight,framing.offsetX,framing.offsetY,innerWidth,innerHeight);
  $('info').classList.add('hide');
}
function gardenHomeAction(action) {
  if (action === 'talk') {
    const text = window.prompt('留一句话给她：');
    if (!text?.trim()) return;
    act('talk', { text: text.trim() });
    return;
  }
  if (action === 'lamp') {
    act('lamp', { on: !(state?.env?.lamp) });
    return;
  }
  act(action);
}
if (!SHOT) {
  gardenController=createGardenClient({world,renderer,camera,api,onOpen:focusGarden,onClose:()=>{camera.fov=40;camera.clearViewOffset();resetView();},onHomeAction:gardenHomeAction});
  $('gardenChip').addEventListener('click',()=>gardenController.toggle());
  window.__gardenDebug=()=>gardenController.inspect();
}

// ── 启动 ──────────────────────────────────────────────────────────────────
// 调试入口：无头截图/现场排查时可从控制台读取，不暴露用户数据。
window.__homeDebug = () => ({
  charMode, modelReady, chibiReady,
  actorVisible: !!actor?.visible,
  modelVisible: !!model3d?.group?.visible,
  modelPos: model3d?.group ? model3d.group.position.toArray().map((v) => +v.toFixed(2)) : null,
  statePos: state?.her?.pos || null,
  displayPos: lastDisplayPos || null,
  walking: !!state?.her?.walking,
  asleep: !!state?.her?.asleep,
  bounceY: +charWrap.scale.y.toFixed(3),
  spriteView, backView: lastBackView,
  tvCasting: !!tvStream,
  chatOpen, chatMessages: chatHistory.length,
  soundOn, soundState: document.getElementById('soundState')?.textContent || null,
  audioState: audioCtx?.state || null,
  clickSfxReady: clickSfx?.readyState ?? null,
  clickMoveOn, clickMoveState: document.getElementById('clickMoveState')?.textContent || null,
  cameraMode, cameraKeyboard: cameraUsesKeyboard(), cameraMouse: cameraUsesMouse(),
  bubbleOn, bubbleVisible: !!document.getElementById('bubble')?.classList.contains('show'),
  bubbleLabel: document.getElementById('bubbleState')?.textContent || null,
  bubbleClass: document.getElementById('bubbleChip')?.className || null,
  spot: state?.her?.spot || null,
  clip: actor?.current || null,
  wantClip: state?.her ? clipFor(state.her) : null,
  charScreen: (() => {
    const dp = lastDisplayPos || state?.her?.pos;
    if (!dp) return null;
    const p = new THREE.Vector3(dp[0], (state?.her?.elev || 0) + 0.85, dp[1]).project(camera);
    return { x: Math.round((p.x * 0.5 + 0.5) * innerWidth), y: Math.round((-p.y * 0.5 + 0.5) * innerHeight), z: p.z };
  })(),
  actorSrc: actor?.layers?.[actor.active]?.src || null,
  actorReadyState: actor?.layers?.[actor.active]?.video?.readyState ?? null,
  actorError: actor?.layers?.[actor.active]?.video?.error?.code ?? null,
  sleepPhase,
  clipLog: actor?.clipLog?.slice(-8) || [],
  loadLog: actor?.layers?.map((l, i) => ({ i, src: l.src, rs: l.video.readyState, log: l.loadLog.slice(-4) })) || [],
  runStyle: state?.her?.runStyle || null,
  herRoom: state?.her?.room || null,
  camera: camera.position.toArray().map((v) => +v.toFixed(2)),
  target: VIEW.target.toArray().map((v) => +v.toFixed(2)),
  camLook: camLook.toArray().map((v) => +v.toFixed(2)),
  cameraQuat: camera.quaternion.toArray().map((v) => +v.toFixed(2)),
  view: VIEW.mode,
  shotView: SHOT_VIEW,
  shotLook: SHOT_LOOK,
  follow: VIEW.follow, radius: +VIEW.radius.toFixed(2), az: +VIEW.az.toFixed(2), elev: +VIEW.elev.toFixed(2),
  loading: document.getElementById('loading')?.className || ''
});

async function boot() {
  if (HIDE_HUD) $('hud').style.display = 'none';
  if (SHOT) {
    document.body.classList.add('shot');
    VIEW.shot = true;
    world.setLabelsVisible(false);
    world.setCeilingVisible(false);
  }
  // 先 prime 再拉状态：否则首帧如果她已经在走，poll 会先切跑姿、
  // 紧接着 prime('idle') 又把 current 覆盖回 idle，造成“人在跑但播站立”。
  if (!SHOT) {
    await actor.prime('idle');
  }
  await poll();
  if (SHOT) {
    // A QQ room photograph can now be taken while she is outdoors. Build the
    // same garden without mounting controls, polling, or triggering any actions.
    let gardenShot = null;
    if (state?.her?.room === 'garden' || state?.her?.room === 'yard' || INITIAL_ROOM === 'garden') {
      gardenShot = createGardenWorld(world, renderer, { quality: tier });
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), 3500);
      try {
        const response = await fetch(api('/api/garden/state'), { cache: 'no-store', signal: timeout.signal });
        if (response.ok) { const data = await response.json(); if (data.garden) gardenShot.update(data.garden); }
      } catch { /* Keep the real garden structures visible if the snapshot is unavailable. */ }
      finally { clearTimeout(timer); }
    }
    charMode = CHAR_PARAM === '3d' ? '3d' : 'webm';
    if (charMode === '3d') {
      await Promise.race([ensure3d(), new Promise((r) => setTimeout(r, 12000))]);
      if (!modelReady && !chibiReady) charMode = 'webm';
    }
    if (charMode === '3d') {
      actor.setVisible(false);
      applyCharVisibility();
    }
    if (charMode !== '3d') {
      const n = clipFor(state?.her || { kind: 'idle', spot: 'sofa' });
      const ok = await actor.prepareShotPoster(n);
      if (!ok) await actor.prepareShot(n, 2.4);
      actor.setVisible(true);
    }
    world.updateEnvironment({
      ...skyOptions(), lamp: state?.env?.lamp !== false, asleep: state?.her?.asleep, kind: state?.her?.kind
    });
    // 截图模式：只画一帧，不启动渲染循环。
    // overview = 房间近景（含她）；eyes = 她的第一视角（隐藏她自己）。
    VIEW.shot = true;
    VIEW.follow = false;
    const her = state?.her;
    const pov = SHOT_VIEW === 'eyes' || SHOT_VIEW === 'first';
    if (pov) {
      VIEW.mode = 'eyes';
      // 第一视角用更宽的视场，避免只拍到眼前一件家具。
      camera.fov = 55;
      camera.updateProjectionMatrix();
      world.setCeilingVisible(true);
      world.setLabelsVisible(false);
      actor.setVisible(false);
      model3d?.setVisible(false);
      chibi?.setVisible(false);
      if (her) {
        const facing = (Number(her.facing) || 0) * Math.PI / 180;
        const eye = (her.asleep ? 0.86 : 1.22) + (her.elev || 0);
        camPos.set(
          her.pos[0] + Math.sin(facing) * 0.08,
          eye,
          her.pos[1] - Math.cos(facing) * 0.08
        );
        camLook.set(
          camPos.x + Math.sin(facing) * 4,
          eye - 0.35,
          camPos.z - Math.cos(facing) * 4
        );
        if (SHOT_LOOK === 'room' || SHOT_LOOK === 'center') {
          const roomDef = (state?.layout?.rooms || []).find((r) => r.id === her.room);
          if (roomDef?.bounds) {
            const [x0, z0, x1, z1] = roomDef.bounds;
            let tx = (x0 + x1) / 2;
            let tz = (z0 + z1) / 2;
            // 站在房间中央时，看中心会贴着茶几/墙；改看离她最远的角落，才能看到整间房。
            if (Math.hypot(tx - her.pos[0], tz - her.pos[1]) < 2.2) {
              const corners = [[x0, z0], [x0, z1], [x1, z0], [x1, z1]];
              let best = -1;
              for (const [cx, cz] of corners) {
                const d = Math.hypot(cx - her.pos[0], cz - her.pos[1]);
                if (d > best) { best = d; tx = cx; tz = cz; }
              }
            }
            camLook.set(tx, Math.max(0.85, eye - 0.18), tz);
          }
        }
        world.updateCutaway(camPos, camLook, true);
      } else {
        camPos.set(6.3, 1.5, 5.0);
        camLook.set(6.3, 1.2, 2.0);
      }
      camera.position.copy(camPos);
      camera.lookAt(camLook);
    } else {
      VIEW.mode = 'overview';
      const roomId = her?.room || 'living';
      const preset = ROOM_CAM[roomId] || ROOM_CAM.living;
      const focus = her?.pos || preset.center;
      let az = preset.az, elev = preset.elev, r = preset.r;
      if (params.get('focus') === '1') {
        const facing = (Number(her?.facing) || 0) * Math.PI / 180;
        VIEW.target.set(focus[0], (her?.elev || 0) + 0.8, focus[1]);
        az = Math.PI - facing + 0.42;
        elev = 0.6;
        r = 5.0;
      } else {
        VIEW.target.set(focus[0], 0.75, focus[1]);
      }
      const horiz = Math.cos(elev) * r;
      camPos.set(VIEW.target.x + Math.sin(az) * horiz, VIEW.target.y + Math.sin(elev) * r, VIEW.target.z + Math.cos(az) * horiz);
      camLook.copy(VIEW.target);
      camera.position.copy(camPos);
      camera.lookAt(camLook);
      const dbg = params.get('debug') || '';
      if (dbg === 'top') {
        camera.up.set(0, 0, -1);
        camera.fov = 20;
        camera.updateProjectionMatrix();
        camera.position.set(6.6, 55, 4.5);
        camera.lookAt(6.6, 0, 4.5);
        world.setCeilingVisible(false);
        world.setLabelsVisible(false);
      } else if (dbg === 'flat') {
        camera.fov = 42;
        camera.updateProjectionMatrix();
        camera.position.set(6.6, 21, 24);
        camera.lookAt(6.6, 0, 3.0);
      } else if (dbg.startsWith('cam:')) {
        // 自由机位：debug=cam:px,py,pz,tx,ty,tz
        const v = dbg.slice(4).split(',').map(Number);
        if (v.length >= 6 && v.every((n) => Number.isFinite(n))) {
          camera.fov = 45;
          camera.updateProjectionMatrix();
          camera.position.set(v[0], v[1], v[2]);
          camera.lookAt(v[3], v[4], v[5]);
          world.setCeilingVisible(false);
          world.setLabelsVisible(false);
        }
      } else if (dbg.startsWith('room:')) {
        const rid = dbg.slice(5);
        const def = (state?.layout?.rooms || []).find((r) => r.id === rid);
        if (def?.bounds) {
          const [x0, z0, x1, z1] = def.bounds;
          const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
          const span = Math.max(x1 - x0, z1 - z0);
          const d = Math.max(4.6, span * 0.9);
          camera.fov = 44;
          camera.updateProjectionMatrix();
          camera.position.set(cx, d * 1.9, cz + d * 0.55);
          camera.lookAt(cx, 0.2, cz);
          world.setCeilingVisible(false);
        }
      }
      if (her) {
        gardenShot?.updateCharacter(her, { x: her.pos[0], y: her.elev || 0, z: her.pos[1] }, (her.facing || 0) * Math.PI / 180);
        gardenShot?.animateCharacter(performance.now());
        actor.update(0.016, camera, { pos: her.pos, elev: her.elev || 0, walking: false, flip: false, snap: true, drinking: her.kind === 'drink' && !her.asleep });
        if (charMode === '3d' && modelReady && model3d) {
          model3d.setPose({ pos: her.pos, elev: her.elev, pose: her.pose, kind: her.kind, walking: false, facing: her.facing, asleep: her.asleep, activity: her.activity });
          model3d.setVisible(true);
          model3d.update(0.016, camera, { mode: 'overview', lookAtCamera: !her.gardenWork });
        } else if (charMode === '3d' && chibi && chibiReady) {
          chibi.setPose({ pos: her.pos, elev: her.elev, pose: her.pose, kind: her.kind, walking: false, facing: her.facing, asleep: her.asleep, activity: her.activity });
          chibi.update(0.016, camera, { mode: 'overview', lookAtCamera: !her.gardenWork });
        }
        world.updateCutaway(camera.position, new THREE.Vector3(her.pos[0], 1, her.pos[1]), true);
      }
    }
    renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, camera);
    setTimeout(() => {
      renderer.render(scene, camera);
      $('loading').classList.add('hide');
      document.title = 'HOME_READY';
    }, 350);
    return;
  }
  if (charMode === '3d') {
    const ok = await ensure3d();
    if (!ok) charMode = 'webm';
    applyCharVisibility();
    if (charMode === '3d') focusCharacter();
  }
  setMode('overview');
  // 3D 模式必须在 setMode 之后聚焦，否则会被默认全景机位盖住。
  if (charMode === '3d') focusCharacter();
  if (INITIAL_CAM === 'first') setMode('first', INITIAL_ROOM || state?.her?.room || 'living');
  else if (INITIAL_CAM === 'eyes') setMode('eyes');
  world.updateEnvironment({
    ...skyOptions(), lamp: state?.env?.lamp !== false, asleep: state?.her?.asleep, kind: state?.her?.kind
  });
  renderer.shadowMap.needsUpdate = true;
  // 先把相机吸附到当前机位，避免首帧/无头截图还停在默认全景。
  updateCamera(0.06);
  camPos.copy(desiredPos);
  camLook.copy(desiredLook);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
  renderer.info.reset();
  renderer.render(scene, camera);
  setTimeout(() => $('loading').classList.add('hide'), 250);
  setInterval(poll, 1200);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  if(params.get('garden')==='1') gardenController?.setOpen(true);
  requestAnimationFrame(frame);
}

boot();
