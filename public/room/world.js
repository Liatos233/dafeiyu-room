// 小蓝鱼的大平层 —— 表现层几何。
//
// 这一层只做一件事：把 home-state.js 的状态画出来。
// 家具位置、站位、门洞尺寸与 src/home-state.js 的 HOME_LAYOUT 对齐（1 单位 = 1 米）。
// 不在这里做行为决定，也不改任何状态。
import * as THREE from './vendor/three.module.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const W = 13.2;
const D = 9.0;
const H = 2.8;
const T = 0.16; // 墙厚

// ── 小工具 ────────────────────────────────────────────────────────────────
function rndFactory(seed = 7) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const rnd = rndFactory(20261106);

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: opts.roughness ?? 0.85,
    metalness: opts.metalness ?? 0,
    envMapIntensity: opts.env ?? 0.45,
    ...opts.extra
  });
}
function metal(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color, roughness: opts.roughness ?? 0.32, metalness: opts.metalness ?? 0.85, envMapIntensity: 1
  });
}

function canvasTex(w, h, draw, opts = {}) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = opts.anisotropy ?? 8;
  if (opts.smooth === false) {
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
  }
  if (opts.repeat) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(opts.repeat[0], opts.repeat[1]);
  }
  return t;
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function roundedGeo(w, h, d, r = 0.03) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  const rr = Math.min(r, w / 2 - 0.001, h / 2 - 0.001);
  s.moveTo(x + rr, y);
  s.lineTo(x + w - rr, y);
  s.quadraticCurveTo(x + w, y, x + w, y + rr);
  s.lineTo(x + w, y + h - rr);
  s.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  s.lineTo(x + rr, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - rr);
  s.lineTo(x, y + rr);
  s.quadraticCurveTo(x, y, x + rr, y);
  const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false, curveSegments: 5 });
  g.translate(0, 0, -d / 2);
  return g;
}

function addMesh(parent, geo, material, x = 0, y = 0, z = 0, ry = 0, name = '') {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  if (ry) m.rotation.y = ry;
  m.castShadow = true;
  m.receiveShadow = true;
  if (name) m.name = name;
  parent.add(m);
  return m;
}
function box(parent, w, h, d, material, x, y, z, ry = 0) {
  return addMesh(parent, new THREE.BoxGeometry(w, h, d), material, x, y, z, ry);
}
function rbox(parent, w, h, d, r, material, x, y, z, ry = 0) {
  return addMesh(parent, roundedGeo(w, h, d, r), material, x, y, z, ry);
}
function cyl(parent, rTop, rBottom, h, material, x, y, z, seg = 16) {
  return addMesh(parent, new THREE.CylinderGeometry(rTop, rBottom, h, seg), material, x, y, z);
}

// Refined furniture primitives: dimensions include the bevel, so layout bounds stay stable.
function furnitureSoftBox(parent, w, h, d, r, material, x, y, z, ry = 0) {
  const bevel = Math.min(r * 0.5, w * 0.2, h * 0.2, d * 0.2);
  const iw = w - bevel * 2; const ih = h - bevel * 2;
  const cr = Math.max(0.001, Math.min(r - bevel, iw / 2 - 0.001, ih / 2 - 0.001));
  const shape = new THREE.Shape();
  const left = -iw / 2; const bottom = -ih / 2;
  shape.moveTo(left + cr, bottom);
  shape.lineTo(left + iw - cr, bottom);
  shape.quadraticCurveTo(left + iw, bottom, left + iw, bottom + cr);
  shape.lineTo(left + iw, bottom + ih - cr);
  shape.quadraticCurveTo(left + iw, bottom + ih, left + iw - cr, bottom + ih);
  shape.lineTo(left + cr, bottom + ih);
  shape.quadraticCurveTo(left, bottom + ih, left, bottom + ih - cr);
  shape.lineTo(left, bottom + cr);
  shape.quadraticCurveTo(left, bottom, left + cr, bottom);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: d - bevel * 2, steps: 1, bevelEnabled: true,
    bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 5
  });
  geometry.translate(0, 0, -d / 2 + bevel);
  return addMesh(parent, geometry, material, x, y, z, ry);
}

// A single continuous seam, instead of many tiny stitch meshes.
function furniturePiping(parent, w, h, r, material, x, y, z, tube = 0.004) {
  const points = [];
  for (const [cx, cy, angle] of [[w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, Math.PI / 2], [-w / 2 + r, -h / 2 + r, Math.PI], [w / 2 - r, -h / 2 + r, Math.PI * 1.5]]) {
    for (let i = 0; i <= 5; i++) {
      const a = angle + i / 5 * Math.PI / 2;
      points.push(new THREE.Vector3(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 0));
    }
  }
  const curve = new THREE.CatmullRomCurve3(points, true, 'centripetal');
  return addMesh(parent, new THREE.TubeGeometry(curve, 64, tube, 4, true), material, x, y, z);
}

function furnitureTop(parent, w, d, h, r, material, x, y, z) {
  const top = furnitureSoftBox(parent, w, d, h, r, material, x, y, z);
  top.rotation.x = -Math.PI / 2;
  return top;
}

// A continuous textile surface with restrained folds; used for a draped sofa throw.
function furnitureThrow(parent, material, x, y, z) {
  const geometry = new THREE.PlaneGeometry(0.48, 0.8, 12, 18);
  const positions = geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    const u = positions.getX(i); const v = positions.getY(i);
    const hang = Math.max(0, -v - 0.1);
    positions.setXYZ(i, u, -hang * 1.05 + 0.009 * Math.sin(u * 54) + 0.006 * Math.cos(v * 24), -v + hang * 0.15);
  }
  geometry.computeVertexNormals();
  const mesh = addMesh(parent, geometry, material, x, y, z);
  mesh.rotation.y = Math.PI + 0.06;
  return mesh;
}

// ── 贴图 ──────────────────────────────────────────────────────────────────
// Shared, deterministic detail maps: built once, never in the render loop.
function furnitureSurfaces(M, quality) {
  const random = rndFactory(4318);
  const grain = canvasTex(256, 512, (ctx, w, h) => {
    ctx.fillStyle = '#f4f0e9'; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 145; i++) {
      const x = random() * w;
      ctx.strokeStyle = `rgba(92,65,39,${0.025 + random() * 0.065})`;
      ctx.lineWidth = 0.5 + random() * 1.4;
      ctx.beginPath(); ctx.moveTo(x, 0);
      ctx.bezierCurveTo(x + 12, h * 0.3, x - 10, h * 0.7, x + 3, h);
      ctx.stroke();
    }
  });
  const weave = canvasTex(128, 128, (ctx, w, h) => {
    ctx.fillStyle = '#f6f3ee'; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < w; i += 4) {
      ctx.fillStyle = 'rgba(65,57,48,.07)'; ctx.fillRect(i, 0, 1, h);
      ctx.fillStyle = 'rgba(65,57,48,.05)'; ctx.fillRect(0, i, w, 1);
      for (let j = 0; j < h; j += 4) {
        ctx.fillStyle = `rgba(255,255,255,${0.15 + random() * 0.3})`;
        ctx.fillRect(i + ((j / 4) % 2), j, 2, 1);
      }
    }
  }, {repeat: [3, 3]});
  for (const key of ['oak', 'oakLight', 'walnut', 'darkWood']) {
    M[key].map = grain;
    if (quality !== 'low') { M[key].bumpMap = grain; M[key].bumpScale = 0.003; }
  }
  for (const key of ['linen', 'linenBlue', 'fabric', 'fabricBlue', 'fabricCream', 'fabricOchre']) {
    M[key].map = weave;
    if (quality !== 'low') { M[key].bumpMap = weave; M[key].bumpScale = 0.004; }
  }
}

function woodFloorTexture() {
  return canvasTex(1024, 1024, (ctx, w, h) => {
    ctx.fillStyle = '#c9a97c';
    ctx.fillRect(0, 0, w, h);
    const plank = 128;
    for (let y = 0; y < h; y += plank) {
      const offset = (y / plank) % 2 ? 0 : 190;
      for (let x = -offset; x < w; x += 360) {
        const shade = 190 + Math.floor(rnd() * 32);
        ctx.fillStyle = `rgb(${shade + 8},${Math.floor(shade * 0.78)},${Math.floor(shade * 0.52)})`;
        ctx.fillRect(x, y, 358, plank - 2);
        ctx.strokeStyle = 'rgba(88,58,32,.22)';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, 358, plank - 2);
        // 木纹
        for (let i = 0; i < 14; i++) {
          ctx.strokeStyle = `rgba(100,64,32,${0.03 + rnd() * 0.05})`;
          ctx.lineWidth = 1 + rnd() * 1.4;
          ctx.beginPath();
          const yy = y + 8 + rnd() * (plank - 16);
          ctx.moveTo(x + 8, yy);
          ctx.bezierCurveTo(x + 100, yy + rnd() * 6 - 3, x + 240, yy + rnd() * 8 - 4, x + 350, yy + rnd() * 4 - 2);
          ctx.stroke();
        }
      }
    }
    // 整体压暗一点点
    ctx.fillStyle = 'rgba(60,40,20,.04)';
    ctx.fillRect(0, 0, w, h);
  }, { repeat: [1.6, 1.1] });
}

function tileTexture(base, line, n = 4) {
  return canvasTex(512, 512, (ctx, w, h) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);
    const s = w / n;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        ctx.fillStyle = `rgba(255,255,255,${0.012 + rnd() * 0.03})`;
        ctx.fillRect(x * s + 2, y * s + 2, s - 4, s - 4);
      }
    }
    ctx.strokeStyle = line;
    ctx.lineWidth = 3;
    for (let i = 0; i <= n; i++) {
      ctx.beginPath(); ctx.moveTo(i * s, 0); ctx.lineTo(i * s, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * s); ctx.lineTo(w, i * s); ctx.stroke();
    }
  }, { repeat: [3, 3] });
}

function rugTexture(main, border, accent) {
  return canvasTex(512, 384, (ctx, w, h) => {
    ctx.fillStyle = main; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = border; ctx.fillRect(12, 12, w - 24, h - 24);
    ctx.fillStyle = main; ctx.fillRect(26, 26, w - 52, h - 52);
    ctx.strokeStyle = accent; ctx.lineWidth = 3;
    for (let i = 0; i < 4; i++) {
      ctx.strokeRect(44 + i * 12, 44 + i * 9, w - 88 - i * 24, h - 88 - i * 18);
    }
    // 织纹
    for (let i = 0; i < 2500; i++) {
      ctx.fillStyle = `rgba(255,255,255,${0.015 + rnd() * 0.03})`;
      ctx.fillRect(rnd() * w, rnd() * h, 1.5, 1.5);
    }
  });
}

function artTexture(kind = 0) {
  return canvasTex(512, 384, (ctx, w, h) => {
    const sky = ['#cfe2ee', '#e8d5bd', '#1d3b57', '#e3e8e2'][kind % 4];
    ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
    if (kind % 4 === 0) {
      // 海面与鲸
      ctx.fillStyle = '#9dbfd6'; ctx.fillRect(0, h * 0.52, w, h * 0.48);
      ctx.fillStyle = '#6f93ad'; ctx.beginPath();
      ctx.ellipse(w * 0.57, h * 0.58, 92, 30, -0.08, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.moveTo(w * 0.78, h * 0.54); ctx.lineTo(w * 0.9, h * 0.42); ctx.lineTo(w * 0.9, h * 0.63); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#f4f0e8'; ctx.beginPath(); ctx.arc(w * 0.2, h * 0.22, 34, 0, TAU); ctx.fill();
    } else if (kind % 4 === 1) {
      ctx.fillStyle = '#b9785c'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ead5b8'; ctx.beginPath(); ctx.arc(w * 0.52, h * 0.46, 96, 0, TAU); ctx.fill();
      ctx.fillStyle = '#2c3e50'; ctx.fillRect(w * 0.18, h * 0.72, w * 0.64, 14);
    } else if (kind % 4 === 2) {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#16263d'); g.addColorStop(1, '#3f5d78');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 90; i++) {
        ctx.fillStyle = `rgba(255,255,255,${0.2 + rnd() * 0.7})`;
        ctx.fillRect(rnd() * w, rnd() * h * 0.8, 1.6, 1.6);
      }
      ctx.fillStyle = '#f7df9b'; ctx.beginPath(); ctx.arc(w * 0.72, h * 0.24, 36, 0, TAU); ctx.fill();
    } else {
      ctx.fillStyle = '#e9e3d8'; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#8b9b86'; ctx.lineWidth = 2;
      for (let i = 0; i < 7; i++) {
        ctx.beginPath(); ctx.moveTo(60 + i * 58, h - 40); ctx.quadraticCurveTo(90 + i * 58, 90, 70 + i * 58, 30); ctx.stroke();
      }
      ctx.fillStyle = '#5f7d59';
      for (let i = 0; i < 9; i++) { ctx.beginPath(); ctx.ellipse(70 + i * 46, 90 + rnd() * 130, 26, 9, rnd() * 2, 0, TAU); ctx.fill(); }
    }
    ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 10; ctx.strokeRect(5, 5, w - 10, h - 10);
  });
}

function noteTexture() {
  return canvasTex(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#f2e7c9'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#d9c7a0'; ctx.fillRect(0, 0, w, 16);
    ctx.fillStyle = '#5b5b5b';
    ctx.font = '20px "PingFang SC", sans-serif';
    ctx.fillText('今天也要好好吃饭', 18, 62);
    ctx.fillText('冰箱里有小鱼干', 18, 100);
    ctx.fillStyle = '#d77a7a';
    ctx.beginPath(); ctx.arc(w - 38, h - 42, 9, 0, TAU); ctx.fill();
  });
}

function screenTexture(kind = 'tv') {
  return canvasTex(kind === 'tv' ? 512 : 384, kind === 'tv' ? 288 : 240, (ctx, w, h) => {
    if (kind === 'tv') {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#22415f'); g.addColorStop(0.6, '#4e7f9c'); g.addColorStop(1, '#c7a06b');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.beginPath(); ctx.ellipse(w * 0.68, h * 0.34, 50, 20, -0.2, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(20,40,60,.6)';
      ctx.beginPath(); ctx.ellipse(w * 0.42, h * 0.62, 92, 26, 0.05, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.16)';
      ctx.fillRect(0, h * 0.78, w, h * 0.22);
    } else {
      ctx.fillStyle = '#101820'; ctx.fillRect(0, 0, w, h);
      const colors = ['#7fd1ff', '#ffd37f', '#8ef2c8', '#ff9db5'];
      ctx.font = '14px monospace';
      for (let i = 0; i < 16; i++) {
        ctx.fillStyle = colors[i % colors.length];
        const indent = 12 + (i % 3) * 18;
        ctx.fillText(`${'  '.repeat(i % 3)}${['const', 'let', 'function', 'return', 'if', 'await'][i % 6]} ${['home', 'fish', 'warm', 'sleep', 'love', 'sea'][i % 6]}${i}`, indent, 26 + i * 14);
      }
    }
  });
}

function memoryBoardTexture(lines = []) {
  return canvasTex(512, 384, (ctx, w, h) => {
    ctx.fillStyle = '#6b5742'; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 60; i++) {
      ctx.fillStyle = `rgba(0,0,0,${0.02 + rnd() * 0.03})`;
      ctx.fillRect(rnd() * w, rnd() * h, 2, 2);
    }
    const colors = ['#f4e7c9', '#f7d6d0', '#d9e8d2', '#d7e2f2'];
    const text = lines.length ? lines : ['她的小屋', '今天也要好好吃饭', '记得回消息'];
    text.slice(-4).forEach((t, i) => {
      const x = 44 + (i % 2) * 220;
      const y = 52 + Math.floor(i / 2) * 150;
      ctx.save();
      ctx.translate(x + 80, y + 50);
      ctx.rotate((i % 2 ? -1 : 1) * 0.025);
      ctx.fillStyle = colors[i % colors.length];
      ctx.fillRect(-80, -48, 160, 108);
      ctx.fillStyle = '#55504a';
      ctx.font = '17px "PingFang SC", sans-serif';
      wrapText(ctx, String(t).slice(0, 30), 0, -18, 138, 22, 3);
      ctx.fillStyle = 'rgba(0,0,0,.15)';
      ctx.beginPath(); ctx.arc(0, 45, 3, 0, TAU); ctx.fill();
      ctx.restore();
    });
  });
}
function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
  let line = '';
  let n = 0;
  for (const ch of Array.from(text)) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x - maxWidth / 2, y);
      line = ch;
      y += lineHeight;
      n += 1;
      if (n >= maxLines) return;
    } else line = test;
  }
  if (line) ctx.fillText(line, x - maxWidth / 2, y);
}

function skyTexture(hour, weather = 'clear') {
  const mode = weather === true ? 'rain' : String(weather || 'clear');
  const h = ((hour % 24) + 24) % 24;
  const nightBase = h < 5 || h >= 21;
  const dawnBase = h >= 5 && h < 7.5;
  const duskBase = h >= 17.5 && h < 21;

  // 每种天气的固定观感；clear 仍按小时走
  const W = {
    clear: null,
    rain: { top: '#3f4a56', mid: '#67737f', low: '#8d99a3', sea: ['#3a4650', '#222b33'], clouds: 20, rain: true, stars: 0, sun: 'none', mountain: 'rgba(60,72,84,.55)', fog: 0x7c8a95 },
    storm: { top: '#20262f', mid: '#333d49', low: '#4c5764', sea: ['#232b33', '#141a20'], clouds: 26, rain: true, stars: 0, sun: 'none', mountain: 'rgba(28,34,42,.72)', fog: 0x39434d },
    overcast: { top: '#6b7783', mid: '#8f9aa4', low: '#c3ccd4', sea: ['#6a7884', '#3d474f'], clouds: 16, rain: false, stars: 0, sun: 'soft', mountain: 'rgba(96,108,120,.42)', fog: 0x9aa6b1 },
    fog: { top: '#b7c2cb', mid: '#cfd8de', low: '#e9edf0', sea: ['#bcc7cf', '#9aa7b0'], clouds: 10, rain: false, stars: 0, sun: 'soft', mountain: 'rgba(180,190,198,.28)', fog: 0xd3dae0 },
    snow: { top: '#8fa2b4', mid: '#b9c8d4', low: '#e8eef4', sea: ['#9fb1bf', '#71808c'], clouds: 20, rain: false, stars: 0, snow: true, sun: 'soft', mountain: 'rgba(150,166,180,.45)', fog: 0xc3d0da },
    sand: { top: '#a9834f', mid: '#c49f6c', low: '#e0c8a1', sea: ['#b08a56', '#7d6037'], clouds: 6, rain: false, stars: 0, sun: 'dusty', mountain: 'rgba(150,116,66,.55)', fog: 0xc9a469 },
    rainbow: { top: '#5b7fa6', mid: '#8fb3cc', low: '#d8e6ee', sea: ['#5b7d94', '#33505f'], clouds: 8, rain: false, stars: 0, sun: 'soft', rainbow: true, mountain: 'rgba(70,96,110,.32)', fog: 0x9fb6c6 },
    starry: { top: '#03060f', mid: '#070f22', low: '#101d33', sea: ['#081525', '#03080f'], clouds: 3, rain: false, stars: 1400, sun: 'moon', night: true, mountain: 'rgba(6,12,22,.8)', fog: 0x081324 },
    sleet: { top: '#5c6b78', mid: '#8896a2', low: '#c2ccd5', sea: ['#4a5866', '#2c3742'], clouds: 22, rain: true, snow: true },
    hail: { top: '#39434f', mid: '#5f6b78', low: '#9aa6b2', sea: ['#39434f', '#232c35'], clouds: 26, rain: true },
    haze: { top: '#a89a86', mid: '#c9bda9', low: '#e3dccd', sea: ['#a99b86', '#7d7161'], clouds: 8 },
    blizzard: { top: '#7f8fa0', mid: '#aebcc9', low: '#e6edf3', sea: ['#8b9aa8', '#5f6d7a'], clouds: 30 },
    meteor: { top: '#050a14', mid: '#0a1526', low: '#152238', sea: ['#08131f', '#03070d'], clouds: 2, night: true },
    typhoon: { top: '#1d2730', mid: '#33414c', low: '#5d6d78', sea: ['#223039', '#101a20'], clouds: 32, rain: true, night: true },
    aurora: { top: '#040a14', mid: '#08182a', low: '#0d2438', sea: ['#071827', '#030a12'], clouds: 2, rain: false, stars: 900, sun: 'moon', aurora: true, night: true, mountain: 'rgba(6,14,24,.78)', fog: 0x0a1a2c }
  };
  const spec = W[mode];
  const night = spec ? !!spec.night : nightBase;
  const dawn = spec ? false : dawnBase;
  const dusk = spec ? false : duskBase;

  return canvasTex(4096, 2048, (ctx, w, hgt) => {
    let top; let mid; let low;
    if (spec) { top = spec.top; mid = spec.mid; low = spec.low; }
    else if (night) { top = '#050b17'; mid = '#0b1930'; low = '#1a2c44'; }
    else if (dawn) { top = '#3d4f78'; mid = '#a9778f'; low = '#f0b07c'; }
    else if (dusk) { top = '#4e5b7d'; mid = '#c58a7a'; low = '#f4c08a'; }
    else { top = '#6fa9d8'; mid = '#b9d8ee'; low = '#e8f1f4'; }
    const g = ctx.createLinearGradient(0, 0, 0, hgt * 0.66);
    g.addColorStop(0, top); g.addColorStop(0.55, mid); g.addColorStop(1, low);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, hgt * 0.66);

    // 海
    const sea0 = spec ? spec.sea[0] : (night ? '#0b1a2b' : (dawn || dusk ? '#5f728e' : '#4c7d99'));
    const sea1 = spec ? spec.sea[1] : (night ? '#050d16' : '#1b3d52');
    const sea = ctx.createLinearGradient(0, hgt * 0.62, 0, hgt);
    sea.addColorStop(0, sea0);
    sea.addColorStop(1, sea1);
    ctx.fillStyle = sea; ctx.fillRect(0, hgt * 0.62, w, hgt * 0.38);
    ctx.fillStyle = night ? 'rgba(120,170,220,.12)' : 'rgba(255,235,200,.35)';
    if (spec && night) ctx.fillStyle = 'rgba(120,170,220,.12)';
    ctx.fillRect(0, hgt * 0.615, w, 3);
    for (let i = 0; i < 80; i++) {
      ctx.strokeStyle = `rgba(255,255,255,${0.03 + rnd() * 0.06})`;
      ctx.lineWidth = 1;
      const y = hgt * 0.66 + rnd() * hgt * 0.32;
      const x = rnd() * w;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 8 + rnd() * 40, y); ctx.stroke();
    }

    // 极光：整片天空偏绿 + 几条横向柔光带（在球面贴图上更明显）
    if (spec?.aurora) {
      const wash = ctx.createLinearGradient(0, 0, 0, hgt * 0.62);
      wash.addColorStop(0, 'rgba(70,240,190,.30)');
      wash.addColorStop(0.45, 'rgba(60,200,170,.16)');
      wash.addColorStop(1, 'rgba(40,140,130,0)');
      ctx.fillStyle = wash;
      ctx.fillRect(0, 0, w, hgt * 0.62);
      for (let i = 0; i < 4; i++) {
        const y0 = hgt * (0.06 + i * 0.11);
        const band = ctx.createLinearGradient(0, y0, 0, y0 + hgt * 0.16);
        band.addColorStop(0, 'rgba(160,255,225,0)');
        band.addColorStop(0.45, `rgba(120,255,210,${0.34 - i * 0.05})`);
        band.addColorStop(1, 'rgba(90,220,190,0)');
        ctx.fillStyle = band;
        ctx.fillRect(0, y0, w, hgt * 0.16);
      }
    }

    // 彩虹：半透明弧
    if (spec?.rainbow) {
      const cx = w * 0.5; const cy = hgt * 0.66; const r0 = hgt * 0.42;
      const bands = ['#ff6b6b', '#ffb86b', '#ffe66b', '#7bdc7b', '#6bc4ff', '#8f7bff', '#d67bff'];
      bands.forEach((col, i) => {
        ctx.strokeStyle = col;
        ctx.globalAlpha = 0.16;
        ctx.lineWidth = hgt * 0.014;
        ctx.beginPath();
        ctx.arc(cx, cy, r0 + i * hgt * 0.014, Math.PI * 1.12, Math.PI * 1.88);
        ctx.stroke();
      });
      ctx.globalAlpha = 1;
    }

    // 太阳/月亮
    const t = (h - 6) / 12;
    const sunMode = spec ? spec.sun : (night ? 'moon' : 'sun');
    if (sunMode === 'moon') {
      ctx.fillStyle = 'rgba(235,240,255,.92)';
      ctx.beginPath(); ctx.arc(w * 0.72, hgt * 0.22, 20, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(235,240,255,.12)';
      ctx.beginPath(); ctx.arc(w * 0.72, hgt * 0.22, 44, 0, TAU); ctx.fill();
    } else if (sunMode === 'sun' || sunMode === 'soft' || sunMode === 'dusty') {
      const sx = w * (0.12 + t * 0.76);
      const sy = hgt * (0.5 - Math.sin(Math.max(0.02, Math.min(1, t)) * Math.PI) * 0.34);
      const warm = dawn || dusk || sunMode === 'dusty';
      const alpha = sunMode === 'soft' ? 0.35 : 0.9;
      const glow = ctx.createRadialGradient(sx, sy, 2, sx, sy, warm ? 120 : 80);
      glow.addColorStop(0, warm ? `rgba(255,220,160,${alpha})` : `rgba(255,250,230,${alpha})`);
      glow.addColorStop(1, 'rgba(255,220,160,0)');
      ctx.fillStyle = glow; ctx.fillRect(sx - 140, sy - 140, 280, 280);
      ctx.fillStyle = warm ? '#ffe1ad' : '#fff8e8';
      ctx.beginPath(); ctx.arc(sx, sy, warm ? 26 : 18, 0, TAU); ctx.fill();
    }

    // 星空（普通夜晚 420，星空/极光更多 + 淡银河）
    const stars = spec ? (spec.stars || 0) : (night ? 420 : 0);
    if (stars > 0) {
      if (stars > 800) {
        const mw = ctx.createLinearGradient(0, hgt * 0.05, w, hgt * 0.42);
        mw.addColorStop(0, 'rgba(190,210,255,0)');
        mw.addColorStop(0.5, 'rgba(200,215,255,.10)');
        mw.addColorStop(1, 'rgba(190,210,255,0)');
        ctx.fillStyle = mw;
        ctx.save();
        ctx.translate(w * 0.5, hgt * 0.24);
        ctx.rotate(-0.22);
        ctx.fillRect(-w * 0.5, -hgt * 0.05, w, hgt * 0.12);
        ctx.restore();
      }
      for (let i = 0; i < stars; i++) {
        const sx = rnd() * w;
        const sy = rnd() * hgt * 0.55;
        const r = 1.0 + rnd() * 1.6;
        ctx.fillStyle = `rgba(255,255,255,${0.35 + rnd() * 0.6})`;
        ctx.beginPath(); ctx.arc(sx, sy, r, 0, TAU); ctx.fill();
        if (rnd() > 0.9) {
          ctx.fillStyle = 'rgba(190,215,255,.22)';
          ctx.beginPath(); ctx.arc(sx, sy, r * 3, 0, TAU); ctx.fill();
        }
      }
    }

    // 云
    const cloudCount = spec ? spec.clouds : 10;
    if (cloudCount > 0) {
      for (let i = 0; i < cloudCount; i++) {
        const cx = rnd() * w;
        const cy = hgt * (0.08 + rnd() * 0.3);
        const cw = 110 + rnd() * 240;
        const cloudColor = spec
          ? (mode === 'sand' ? `rgba(210,175,120,${0.3 + rnd() * 0.3})`
            : mode === 'fog' ? `rgba(235,240,244,${0.25 + rnd() * 0.25})`
              : mode === 'snow' ? `rgba(230,238,246,${0.4 + rnd() * 0.3})`
                : mode === 'storm' ? `rgba(26,32,40,${0.55 + rnd() * 0.3})`
                  : `rgba(150,162,174,${0.3 + rnd() * 0.3})`)
          : (night ? 'rgba(160,190,230,.07)' : `rgba(255,255,255,${0.12 + rnd() * 0.16})`);
        ctx.fillStyle = cloudColor;
        ctx.beginPath();
        ctx.ellipse(cx, cy, cw, 10 + rnd() * 12, 0, 0, TAU);
        ctx.ellipse(cx + cw * 0.4, cy - 8, cw * 0.55, 8 + rnd() * 10, 0, 0, TAU);
        ctx.fill();
      }
    }

    // 雨丝
    if (spec?.rain) {
      const n = mode === 'storm' ? 1500 : 900;
      for (let i = 0; i < n; i++) {
        const x = rnd() * w;
        const y = rnd() * hgt * 0.7;
        const len = 16 + rnd() * 46;
        ctx.strokeStyle = `rgba(210,225,238,${0.05 + rnd() * 0.12})`;
        ctx.lineWidth = 1 + rnd();
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - 6, y + len); ctx.stroke();
      }
    }

    // 远山
    ctx.fillStyle = spec ? spec.mountain : (night ? 'rgba(10,20,34,.7)' : 'rgba(70,96,110,.28)');
    ctx.beginPath();
    ctx.moveTo(0, hgt * 0.63);
    for (let x = 0; x <= w; x += 60) ctx.lineTo(x, hgt * 0.63 - Math.sin(x * 0.008) * 16 - rnd() * 7);
    ctx.lineTo(w, hgt * 0.65); ctx.lineTo(0, hgt * 0.65); ctx.closePath(); ctx.fill();
  }, { anisotropy: 8, smooth: false });
}

// ── 世界构建 ──────────────────────────────────────────────────────────────
export function createWorld(renderer, { quality = 'balanced' } = {}) {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x9db6c9, 38, 100);
  const root = new THREE.Group();
  scene.add(root);

  const textures = {
    wood: woodFloorTexture(),
    tileKitchen: tileTexture('#e7e2d8', '#c8c0b2', 4),
    tileBath: tileTexture('#dfe5e5', '#b9c4c4', 5),
    tileBalcony: tileTexture('#cbbba4', '#a8937a', 5),
    rugLiving: rugTexture('#8d9ba8', '#5d6b78', '#d9d2c4'),
    rugBed: rugTexture('#b3a5a0', '#7c6d6b', '#e9dfd2'),
    note: noteTexture(),
    tv: screenTexture('tv'),
    desk: screenTexture('desk'),
    memory: memoryBoardTexture(),
    sky: skyTexture(14)
  };

  const M = {
    wall: mat(0xe9e2d6, { roughness: 0.94, env: 0.25 }),
    wallWarm: mat(0xe4dacb, { roughness: 0.94, env: 0.2 }),
    ceiling: mat(0xf3eee6, { roughness: 0.95 }),
    base: mat(0xd6cbbb, { roughness: 0.9 }),
    oak: mat(0xb98d5f, { roughness: 0.72 }),
    oakLight: mat(0xcda87a, { roughness: 0.76 }),
    walnut: mat(0x6d4c35, { roughness: 0.66 }),
    darkWood: mat(0x4a3326, { roughness: 0.7 }),
    white: mat(0xf5f2ec, { roughness: 0.82 }),
    cream: mat(0xe8dfd0, { roughness: 0.92 }),
    linen: mat(0xd9d0c2, { roughness: 0.96 }),
    linenBlue: mat(0x8fa3b8, { roughness: 0.95 }),
    navy: mat(0x283a52, { roughness: 0.88 }),
    blue: mat(0x5279a3, { roughness: 0.86 }),
    teal: mat(0x4d7f7c, { roughness: 0.88 }),
    brass: metal(0xb9965c, { roughness: 0.36 }),
    steel: metal(0xb8c0c5, { roughness: 0.3 }),
    black: mat(0x1a1c20, { roughness: 0.6 }),
    dark: mat(0x2c2e33, { roughness: 0.7 }),
    stone: mat(0xd8d2c8, { roughness: 0.55 }),
    stoneDark: mat(0x8f8b84, { roughness: 0.6 }),
    plant: mat(0x4f7a52, { roughness: 0.9 }),
    plantLight: mat(0x6d9a63, { roughness: 0.9 }),
    soil: mat(0x44362a, { roughness: 1 }),
    terracotta: mat(0xb2745a, { roughness: 0.9 }),
    ceramic: mat(0xdfe7e4, { roughness: 0.35 }),
    fabric: mat(0x9aa3a8, { roughness: 0.98 }),
    fabricBlue: mat(0x6f89a5, { roughness: 0.98 }),
    fabricCream: mat(0xe1d6c4, { roughness: 0.98 }),
    fabricOchre: mat(0xc99a62, { roughness: 0.97 }),
    glass: new THREE.MeshPhysicalMaterial({
      color: 0xbfe3ff, transparent: true, opacity: 0.14, roughness: 0.06, metalness: 0,
      side: THREE.DoubleSide, depthWrite: false, envMapIntensity: 1
    }),
    glassFrost: new THREE.MeshPhysicalMaterial({
      color: 0xd7e6e4, transparent: true, opacity: 0.42, roughness: 0.5, metalness: 0,
      side: THREE.DoubleSide, depthWrite: false
    }),
    mirror: metal(0xe8f2f7, { roughness: 0.18, metalness: 0.55, env: 1.4 }),
    wallGhost: new THREE.MeshStandardMaterial({
      color: 0xe9e2d6, roughness: 0.95, metalness: 0, transparent: true, opacity: 0.78,
      depthWrite: false, side: THREE.DoubleSide
    }),
    screen: new THREE.MeshStandardMaterial({
      map: textures.tv, emissive: 0xffffff, emissiveMap: textures.tv, emissiveIntensity: 0.55,
      roughness: 0.35, metalness: 0.2
    }),
    deskScreen: new THREE.MeshStandardMaterial({
      map: textures.desk, emissive: 0xffffff, emissiveMap: textures.desk, emissiveIntensity: 0.35,
      roughness: 0.35
    }),
    bulb: new THREE.MeshBasicMaterial({ color: 0xffd9a0 }),
    bulbOff: new THREE.MeshBasicMaterial({ color: 0xbfb6a8 }),
    bulbWarm: new THREE.MeshBasicMaterial({ color: 0xffe3b8 })
  };

  furnitureSurfaces(M, quality);

  const world = {
    scene,
    root,
    textures,
    mats: M,
    hotspots: [],
    walls: [],
    labels: new THREE.Group(),
    lamps: [],
    lampMaterials: [],
    sun: null,
    hemi: null,
    sky: null,
    quality,
    roomCenters: {},
    ceiling: null,
    tvScreen: null,
    deskScreen: null,
    clockHands: [],
    memoryMesh: null,
    lastSkyKey: ''
  };
  scene.add(world.labels);

  buildShell(world, M, textures);
  buildKitchen(world, M);
  buildDining(world, M);
  buildLiving(world, M, textures);
  buildBedroom(world, M, textures);
  buildBathroom(world, M);
  buildCorridor(world, M);
  buildLaundry(world, M);
  buildBalcony(world, M);
  buildPoolDeck(world, M);
  buildFoundation(world, M);
  buildFoyer(world, M);
  buildSky(world, M, renderer);
  buildLights(world, M);
  buildLabels(world, M);
  buildRain(world);
  buildSnow(world);
  buildSand(world);

  world.setCeilingVisible = (visible) => {
    if (world.ceiling) world.ceiling.visible = visible;
  };
  world.setLabelsVisible = (visible) => { world.labels.visible = visible; };
  // 俯瞰时把挡在镜头和角色之间的墙变成半透明，像一个剖开的娃娃屋。
  // 第一人称/她的视角保持实体墙，遮挡由 3D 深度自然处理。
  world._ghostUntil = new Map();
  world.updateCutaway = (cameraPos, focus, enabled = true) => {
    for (const w of world.walls) {
      let blocked = false;
      if (enabled) {
        const near = w.axis === 'x'
          ? Math.abs(cameraPos.z - w.fixed) < 3.0
          : Math.abs(cameraPos.x - w.fixed) < 3.0;
        if (w.axis === 'x') {
          blocked = near && (cameraPos.z - w.fixed) * (focus.z - w.fixed) < 0
            && focus.x > w.from - 0.05 && focus.x < w.to + 0.05;
        } else {
          blocked = near && (cameraPos.x - w.fixed) * (focus.x - w.fixed) < 0
            && focus.z > w.from - 0.05 && focus.z < w.to + 0.05;
        }
      }
      // 墙体始终正常显示（不再做剖切/隐藏），避免任何“闪一下变透明”的观感
      w.mesh.visible = true;
      w.mesh.castShadow = true;
    }
  };

/**
 * 静态装饰合批：把大量 box/cyl 小件按材质合并成少量 draw call。
 * 只处理「不透明、无贴图、非动态」的网格；玻璃/水面/屏幕/灯具/墙体都跳过。
 */
function mergeStaticDecor(world) {
  const DYNAMIC = new Set([
    world.sky, world.poolWater, world.poolBody, world.tvScreen
  ].filter(Boolean));
  const skipMaterials = new Set(
    (world.lampMaterials || []).concat((world.walls || []).map((w) => w.mesh)).filter(Boolean)
  );

  const buckets = new Map();
  const victims = [];
  world.root.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || o.isSprite) return;
    if (DYNAMIC.has(o) || skipMaterials.has(o)) return;
    if (o.userData.dynamic) return;
    const m = o.material;
    if (!m || Array.isArray(m)) return;
    if (m.transparent || m.alphaTest > 0) return;
    if (m.map || m.emissiveMap) return;
    if (!o.geometry?.attributes?.position) return;
    if (!o.geometry.attributes.normal || !o.geometry.attributes.uv) return;
    const key = m.uuid;
    if (!buckets.has(key)) buckets.set(key, { material: m, items: [] });
    buckets.get(key).items.push(o);
  });

  const mergeGeoms = (items) => {
    let vCount = 0, iCount = 0;
    for (const o of items) {
      const g = o.geometry;
      vCount += g.attributes.position.count;
      iCount += g.index ? g.index.count : g.attributes.position.count;
    }
    const pos = new Float32Array(vCount * 3);
    const nor = new Float32Array(vCount * 3);
    const uv = new Float32Array(vCount * 2);
    const idx = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
    let vo = 0, io = 0;
    const v = new THREE.Vector3();
    const nm = new THREE.Matrix3();
    for (const o of items) {
      o.updateMatrixWorld(true);
      const g = o.geometry;
      const p = g.attributes.position, n = g.attributes.normal, u = g.attributes.uv;
      nm.getNormalMatrix(o.matrixWorld);
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
        pos[(vo + i) * 3] = v.x; pos[(vo + i) * 3 + 1] = v.y; pos[(vo + i) * 3 + 2] = v.z;
        v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
        nor[(vo + i) * 3] = v.x; nor[(vo + i) * 3 + 1] = v.y; nor[(vo + i) * 3 + 2] = v.z;
        uv[(vo + i) * 2] = u ? u.getX(i) : 0;
        uv[(vo + i) * 2 + 1] = u ? u.getY(i) : 0;
      }
      if (g.index) {
        for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.getX(i) + vo;
      } else {
        for (let i = 0; i < p.count; i++) idx[io++] = vo + i;
      }
      vo += p.count;
    }
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    out.setIndex(new THREE.BufferAttribute(idx, 1));
    out.computeBoundingSphere();
    return out;
  };

  let merged = 0;
  for (const { material, items } of buckets.values()) {
    if (items.length < 6) continue;
    try {
      const geo = mergeGeoms(items);
      const mesh = new THREE.Mesh(geo, material);
      mesh.castShadow = items.some((o) => o.castShadow);
      mesh.receiveShadow = items.some((o) => o.receiveShadow);
      mesh.userData.merged = true;
      world.root.add(mesh);
      for (const o of items) {
        o.parent && o.parent.remove(o);
        try { o.geometry.dispose(); } catch { /* 忽略 */ }
        victims.push(o);
      }
      merged += items.length;
    } catch { /* 合并失败就保留原样 */ }
  }
  world.stats = { mergedMeshes: merged, callsBefore: 0 };
  return merged;
}

  // ── 地面材质（地板/地砖/露台）：用于「湿反光」与「积雪」 ──────────
  world.collectGroundMats = () => {
    if (world._groundMats) return world._groundMats;
    const out = [];
    const pos = new THREE.Vector3();
    world.scene.traverse((o) => {
      if (!o.isMesh || !o.material || Array.isArray(o.material)) return;
      const g = o.geometry;
      if (!g) return;
      if (!g.boundingBox) g.computeBoundingBox?.();
      if (!g.boundingBox) return;
      const sx = g.boundingBox.max.x - g.boundingBox.min.x;
      const sz = g.boundingBox.max.z - g.boundingBox.min.z;
      const sy = g.boundingBox.max.y - g.boundingBox.min.y;
      o.getWorldPosition(pos);
      // 贴地、面积大、很薄 → 视为地面
      if (pos.y > 0.35 || pos.y < -0.4) return;
      if (sx * sz < 2.5 || sy > 0.3) return;
      const m = o.material;
      if (!m.color || m.__wxOrig) return;
      m.__wxOrig = m.color.clone();
      m.__wxRough = typeof m.roughness === 'number' ? m.roughness : 0.8;
      out.push(m);
    });
    world._groundMats = out;
    return out;
  };

  // wet: 0..1 湿滑反光；snow: 0..1 积雪覆盖
  world.setGroundWeather = (wet, snow) => {
    const mats = world.collectGroundMats();
    const w = Math.max(0, Math.min(1, wet || 0));
    const sn = Math.max(0, Math.min(1, snow || 0));
    world._groundWet = w;
    world._groundSnow = sn;
    for (const m of mats) {
      const c = m.__wxOrig.clone();
      if (w > 0) c.lerp(new THREE.Color(0x1b2430), w * 0.38);
      if (sn > 0) c.lerp(new THREE.Color(0xf1f6fb), sn * 0.78);
      m.color.copy(c);
      m.roughness = Math.max(0.05, (m.__wxRough || 0.8) * (1 - w * 0.72) + sn * 0.35);
      if ('metalness' in m) m.metalness = Math.min(0.35, w * 0.3);
      m.needsUpdate = false;
    }
  };

  // 闪电：短时间内抬高环境光，再衰减
  world.flashLightning = (power = 1) => {
    world._flash = Math.max(world._flash || 0, Math.max(0.2, Math.min(2, power)));
  };

  world.updateEnvironment = (opts = {}) => updateEnvironment(world, opts);
  // 太阳/半球光平滑过渡（每帧调用）
  try { mergeStaticDecor(world); } catch { /* 合批失败不影响画面 */ }
  world.updateSun = (dt = 0.016) => {
    if (!world.sun) return;
    const k = Math.min(1, dt * 2.4);
    if (world.sunTargetPos) world.sun.position.lerp(world.sunTargetPos, k);
    if (world.sunTargetColor) world.sun.color.lerp(world.sunTargetColor, k);
    if (typeof world.sunTargetIntensity === 'number') {
      world.sun.intensity += (world.sunTargetIntensity - world.sun.intensity) * k;
    }
    if (world.hemi && typeof world.hemiTargetIntensity === 'number') {
      world.hemi.intensity += (world.hemiTargetIntensity - world.hemi.intensity) * k;
    }
    // 雾的距离与颜色也做平滑，天气切换不再硬跳
    const fog = world.scene?.fog;
    if (fog) {
      if (typeof world.fogTargetNear === 'number') fog.near += (world.fogTargetNear - fog.near) * Math.min(1, dt * 1.6);
      if (typeof world.fogTargetFar === 'number') fog.far += (world.fogTargetFar - fog.far) * Math.min(1, dt * 1.6);
      if (world.fogTargetColor && fog.color) fog.color.lerp(world.fogTargetColor, Math.min(1, dt * 1.6));
    }
    // 闪电：给环境光与太阳光叠一层瞬时亮度
    if (world._flash > 0.001) {
      const f = world._flash;
      const boost = f * 2.6;
      if (world.hemi) world.hemi.intensity += boost;
      if (world.sun) world.sun.intensity += boost * 0.6;
      world._flash = Math.max(0, f - dt * 5.2);
    }
  };
  world.setMemoryNotes = (lines) => setMemoryNotes(world, lines);
  world.setScreenState = (kind, on) => setScreenState(world, kind, on);
  world.setClock = (hour, minute) => setClock(world, hour, minute);

  return world;
}

// 墙 + 门洞/窗洞
function buildShell(world, M, textures) {
  const p = world.root;

  // 地板
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({
    map: textures.wood, roughness: 0.78, metalness: 0, envMapIntensity: 0.18
  }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(W / 2, 0, D / 2);
  floor.receiveShadow = true;
  p.add(floor);

  // 不同房间的地砖（略高于木地板）
  const tilePlane = (x0, z0, x1, z1, tex, repX, repY) => {
    const t = tex.clone();
    t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repX, repY);
    t.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), new THREE.MeshStandardMaterial({ map: t, roughness: 0.66, metalness: 0.02, envMapIntensity: 0.3 }));
    m.rotation.x = -Math.PI / 2;
    m.position.set((x0 + x1) / 2, 0.008, (z0 + z1) / 2);
    m.receiveShadow = true;
    p.add(m);
  };
  tilePlane(0, 0, 4.2, 3.6, textures.tileKitchen, 4, 3.4);
  tilePlane(10.8, 5.6, 13.2, 8.2, textures.tileBath, 2.6, 2.8);
  tilePlane(8.4, 5.6, 10.8, 7.6, textures.tileKitchen, 2.4, 2.0);
  tilePlane(0, 7.6, 8.2, 9.0, textures.tileBalcony, 8, 1.4);

  // 建筑外不再放地面/海面平面：改由天空球接管背景，避免露出矩形边。

  // 基础墙体：holes = {from,to,sill,head,type}
  const wallX = (z, from, to, holes = []) => {
    // 两端各外扩半个墙厚：和垂直方向的墙在转角处重叠，避免拼缝
    from -= T / 2; to += T / 2;
    const hs = holes.slice().sort((a, b) => a.from - b.from);
    let cursor = from;
    const seg = (a, b, y0, y1) => {
      if (b - a < 0.001 || y1 - y0 < 0.001) return;
      // 顶面比纵向墙低 4mm：转角处两块墙相交时不会共面打架（避免出现发丝缝）
      const top = y1 >= H - 0.001 ? H - 0.004 : y1;
      if (top - y0 < 0.001) return;
      const mesh = box(p, b - a, top - y0, T, M.wall, (a + b) / 2, (y0 + top) / 2, z);
      world.walls.push({ mesh, axis: 'x', fixed: z, from: a, to: b, material: M.wall });
    };
    for (const h of hs) {
      seg(cursor, h.from, 0, H);
      seg(h.from, h.to, 0, h.sill || 0);
      seg(h.from, h.to, h.head ?? H, H);
      cursor = h.to;
    }
    seg(cursor, to, 0, H);
    for (const h of hs) addOpeningX(world, M, z, h);
  };
  const wallZ = (x, from, to, holes = []) => {
    from -= T / 2; to += T / 2;
    const hs = holes.slice().sort((a, b) => a.from - b.from);
    let cursor = from;
    const seg = (a, b, y0, y1) => {
      if (b - a < 0.001 || y1 - y0 < 0.001) return;
      const mesh = box(p, T, y1 - y0, b - a, M.wall, x, (y0 + y1) / 2, (a + b) / 2);
      world.walls.push({ mesh, axis: 'z', fixed: x, from: a, to: b, material: M.wall });
    };
    for (const h of hs) {
      seg(cursor, h.from, 0, H);
      seg(h.from, h.to, 0, h.sill || 0);
      seg(h.from, h.to, h.head ?? H, H);
      cursor = h.to;
    }
    seg(cursor, to, 0, H);
    for (const h of hs) addOpeningZ(world, M, x, h);
  };

  // 外墙
  wallX(0, 0, W, [
    { from: 0.9, to: 2.5, sill: 0.95, head: 2.25, type: 'window' },
    { from: 10.2, to: 11.9, sill: 1.55, head: 2.35, type: 'window' }
  ]);
  wallX(7.6, 0, 4.8, [{ from: 1.0, to: 2.7, sill: 0.85, head: 2.35, type: 'window' }]);
  wallX(7.6, 7.8, 8.4);
  wallX(8.2, 10.8, 13.2);
  wallX(7.6, 8.4, 10.8, [{ from: 9.2, to: 10.0, sill: 1.05, head: 2.2, type: 'window' }]);
  // 阳台推拉门（整面玻璃）
  addSlider(world, M, 4.8, 7.8, 7.6);
  // 推拉门上方的过梁：补上墙洞，避免出现缺口矩形
  box(world.root, 3.0, H - 2.24, T, M.wall, 6.3, (2.24 + H) / 2, 7.6);
  wallZ(0, 0, 7.6, [
    { from: 5.8, to: 6.7, sill: 0, head: 2.1, type: 'door' }
  ]);
  wallZ(13.2, 0, 8.2, [
    { from: 1.0, to: 3.0, sill: 0.75, head: 2.35, type: 'window' },
    { from: 5.65, to: 6.05, sill: 1.6, head: 2.2, type: 'windowFrost' }
  ]);
  // 内墙
  wallZ(8.4, 0, 4.4);
  wallZ(8.4, 5.6, 7.6);
  wallX(4.4, 8.4, 13.2, [{ from: 8.7, to: 9.6, sill: 0, head: 2.1, type: 'door' }]);
  wallZ(10.8, 5.6, 8.2);
  wallX(5.6, 10.8, 13.2, [{ from: 11.9, to: 12.8, sill: 0, head: 2.1, type: 'door' }]);
  // 家政间北墙（原来的缺口），带门洞
  wallX(5.6, 8.4, 10.8, [{ from: 9.15, to: 9.95, sill: 0, head: 2.1, type: 'door' }]);

  // 天花板（俯瞰时隐藏）
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ color: 0xf4efe6, roughness: 0.96, side: THREE.DoubleSide }));
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(W / 2, H, D / 2);
  ceil.receiveShadow = true;
  ceil.visible = false;
  p.add(ceil);
  world.ceiling = ceil;

  // 踢脚线：主要墙脚一圈（薄、深色）
  const skirt = (x0, z0, x1, z1) => box(p, x1 - x0 || 0.025, 0.09, z1 - z0 || 0.025, M.base, (x0 + x1) / 2, 0.045, (z0 + z1) / 2);
  skirt(0.02, 0.02, W - 0.02, 0.035);
  skirt(0.02, 0.02, 0.035, 7.58);
  skirt(0.02, 7.58, 4.8, 7.585);
  skirt(8.42, 4.38, 13.18, 4.405);  // 只做 z=4.4 实墙那一段，别横穿客厅
  skirt(8.42, 5.62, 10.78, 5.645);
  skirt(10.82, 5.62, 13.18, 5.645);

  // 门外的小平台（视觉锚点）
  const threshold = box(p, 0.9, 0.02, 0.18, M.stoneDark, 0.08, 0.01, 6.25);
  threshold.receiveShadow = true;
}

function addOpeningX(world, M, z, h) {
  if (!h.type || h.type === 'door') return addDoorFrame(world, M, 'x', z, h);
  addWindow(world, M, 'x', z, h);
}
function addOpeningZ(world, M, x, h) {
  if (!h.type || h.type === 'door') return addDoorFrame(world, M, 'z', x, h);
  addWindow(world, M, 'z', x, h);
}

function addDoorFrame(world, M, axis, fixed, h) {
  const p = world.root;
  const frame = M.oak;
  const w = h.to - h.from;
  const head = h.head ?? 2.1;
  const t = 0.05;
  if (axis === 'x') {
    box(p, w, t, T + 0.03, frame, (h.from + h.to) / 2, head + t / 2, fixed);
    box(p, t, head, T + 0.03, frame, h.from + t / 2, head / 2, fixed);
    box(p, t, head, T + 0.03, frame, h.to - t / 2, head / 2, fixed);
  } else {
    box(p, T + 0.03, t, w, frame, fixed, head + t / 2, (h.from + h.to) / 2);
    box(p, T + 0.03, head, t, frame, fixed, head / 2, h.from + t / 2);
    box(p, T + 0.03, head, t, frame, fixed, head / 2, h.to - t / 2);
  }
}

function addWindow(world, M, axis, fixed, h) {
  const p = world.root;
  const glass = h.type === 'windowFrost' ? M.glassFrost : M.glass;
  const w = h.to - h.from;
  const hh = h.head - h.sill;
  const cy = (h.sill + h.head) / 2;
  const frame = M.dark;
  const t = 0.045;
  if (axis === 'x') {
    const cx = (h.from + h.to) / 2;
    const glassMesh = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.04, hh - 0.04), glass);
    glassMesh.position.set(cx, cy, fixed);
    p.add(glassMesh);
    box(p, w + 0.06, t, 0.08, frame, cx, h.sill, fixed);
    box(p, w + 0.06, t, 0.08, frame, cx, h.head, fixed);
    box(p, t, hh, 0.08, frame, h.from, cy, fixed);
    box(p, t, hh, 0.08, frame, h.to, cy, fixed);
    box(p, 0.03, hh, 0.03, frame, cx, cy, fixed);
    box(p, w + 0.1, 0.035, 0.2, M.base, cx, h.sill - 0.02, fixed);
  } else {
    const cz = (h.from + h.to) / 2;
    const glassMesh = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.04, hh - 0.04), glass);
    glassMesh.rotation.y = Math.PI / 2;
    glassMesh.position.set(fixed, cy, cz);
    p.add(glassMesh);
    box(p, 0.08, t, w + 0.06, frame, fixed, h.sill, cz);
    box(p, 0.08, t, w + 0.06, frame, fixed, h.head, cz);
    box(p, 0.08, hh, t, frame, fixed, cy, h.from);
    box(p, 0.08, hh, t, frame, fixed, cy, h.to);
    box(p, 0.03, hh, 0.03, frame, fixed, cy, cz);
    box(p, 0.2, 0.035, w + 0.1, M.base, fixed, h.sill - 0.02, cz);
  }
}

function addSlider(world, M, x0, x1, z) {
  const p = world.root;
  const frame = M.dark;
  const w = (x1 - x0) / 2;          // 每扇宽度 = 门洞一半，两扇合起来正好是开宽
  const H0 = 2.12;                   // 门扇高度
  const glassMat = M.glass.clone();
  glassMat.side = THREE.DoubleSide;

  // 上下轨道 + 两侧立框
  box(p, x1 - x0 + 0.1, 0.05, 0.13, frame, (x0 + x1) / 2, 0.025, z);
  box(p, x1 - x0 + 0.1, 0.05, 0.13, frame, (x0 + x1) / 2, 2.245, z);
  box(p, 0.05, 2.245, 0.13, frame, x0, 1.1225, z);
  box(p, 0.05, 2.245, 0.13, frame, x1, 1.1225, z);

  // 单扇门：四边框 + 整块玻璃（玻璃尺寸正好嵌在框内）
  const panel = (cx, cz) => {
    const f = 0.05;
    box(p, w, f, 0.045, frame, cx, 0.06 + f / 2, cz);
    box(p, w, f, 0.045, frame, cx, 0.06 + H0 - f / 2, cz);
    box(p, f, H0, 0.045, frame, cx - w / 2 + f / 2, 0.06 + H0 / 2, cz);
    box(p, f, H0, 0.045, frame, cx + w / 2 - f / 2, 0.06 + H0 / 2, cz);
    const g = new THREE.Mesh(new THREE.PlaneGeometry(w - 2 * f, H0 - 2 * f), glassMat);
    g.position.set(cx, 0.06 + H0 / 2, cz);
    p.add(g);
  };

  // 两扇都往左收：左扇关在左侧，右扇再往左叠一点，
  // 右侧 x≈6.45~7.8 全部留作门洞（约 1.35 米）
  panel(x0 + w / 2, z + 0.032);
  panel(x0 + w / 2 + 0.15, z - 0.032);
}

// ── 家具 ──────────────────────────────────────────────────────────────────
function addHotspot(world, x, z, radius, data) {
  const geo = new THREE.CylinderGeometry(radius, radius, 1.25, 10);
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
  m.position.set(x, 0.62, z);
  m.userData.hotspot = data;
  m.name = `hotspot:${data.title}`;
  world.root.add(m);
  world.hotspots.push(m);
  return m;
}

function buildKitchen(world, M) {
  const p = world.root;
  // Joinery stays inside the original worktop footprint. The reveals, inset
  // doors and recessed plinth give the cabinet mass a readable construction.
  const panel = (parent, width, height, x, y, z) => {
    rbox(parent, width, height, 0.034, 0.016, M.cream, x, y, z);
    rbox(parent, width - 0.085, height - 0.085, 0.008, 0.012, M.white, x, y, z + 0.019);
    box(parent, 0.2, 0.018, 0.025, M.brass, x, y + height * 0.33, z + 0.044);
  };
  const ring = (radius, tube, material, x, y, z) => {
    const mesh = addMesh(p, new THREE.TorusGeometry(radius, tube, 6, 24), material, x, y, z);
    mesh.rotation.x = -Math.PI / 2;
    return mesh;
  };
  const counterTop = M.stone;
  box(p, 3.6, 0.56, 0.58, M.cream, 2.1, 0.43, 0.58);
  box(p, 3.6, 0.16, 0.025, M.cream, 2.1, 0.79, 0.3025);
  for (const x of [0.3125, 3.8875]) box(p, 0.025, 0.16, 0.58, M.cream, x, 0.79, 0.58);
  box(p, 3.46, 0.13, 0.47, M.darkWood, 2.1, 0.085, 0.53);
  // Four stone pieces form a real sink opening instead of covering the bowl.
  rbox(p, 0.59, 0.045, 0.62, 0.009, counterTop, 0.585, 0.9, 0.58);
  rbox(p, 2.39, 0.045, 0.62, 0.009, counterTop, 2.715, 0.9, 0.58);
  box(p, 0.64, 0.045, 0.09, counterTop, 1.2, 0.9, 0.315);
  box(p, 0.64, 0.045, 0.11, counterTop, 1.2, 0.9, 0.835);
  box(p, 3.6, 0.09, 0.025, counterTop, 2.1, 0.96, 0.286);
  // A fine shadow gap separates the counter and doors; every front is aligned.
  box(p, 3.55, 0.022, 0.018, M.darkWood, 2.1, 0.855, 0.878);
  for (let i = 0; i < 4; i++) panel(p, 0.872, 0.65, 0.765 + i * 0.89, 0.5, 0.885);

  // Recessed stainless basin, separate rolled rim, drain and gooseneck faucet.
  rbox(p, 0.61, 0.018, 0.4, 0.008, M.steel, 1.2, 0.785, 0.57);
  box(p, 0.018, 0.125, 0.4, M.steel, 0.9, 0.848, 0.57);
  box(p, 0.018, 0.125, 0.4, M.steel, 1.5, 0.848, 0.57);
  box(p, 0.6, 0.125, 0.018, M.steel, 1.2, 0.848, 0.375);
  box(p, 0.6, 0.125, 0.018, M.steel, 1.2, 0.848, 0.765);
  for (const x of [0.886, 1.514]) box(p, 0.032, 0.013, 0.436, M.steel, x, 0.929, 0.57);
  for (const z of [0.36, 0.78]) box(p, 0.6, 0.013, 0.032, M.steel, 1.2, 0.929, z);
  cyl(p, 0.032, 0.032, 0.004, M.dark, 1.2, 0.797, 0.57, 20);
  ring(0.029, 0.004, M.steel, 1.2, 0.802, 0.57);
  cyl(p, 0.039, 0.039, 0.018, M.brass, 1.2, 0.934, 0.31, 20);
  const tapCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(1.2, 0.94, 0.31), new THREE.Vector3(1.2, 1.17, 0.31),
    new THREE.Vector3(1.2, 1.24, 0.4), new THREE.Vector3(1.2, 1.2, 0.52),
    new THREE.Vector3(1.2, 1.12, 0.53)
  ]);
  addMesh(p, new THREE.TubeGeometry(tapCurve, 16, 0.017, 8, false), M.brass, 0, 0, 0);
  rbox(p, 0.075, 0.018, 0.024, 0.006, M.brass, 1.26, 1.0, 0.31);

  // Flush induction top with a narrow brushed trim and readable cooking zones.
  rbox(p, 0.74, 0.018, 0.51, 0.008, M.steel, 2.9, 0.93, 0.58);
  box(p, 0.71, 0.012, 0.48, M.black, 2.9, 0.944, 0.58);
  for (let ix = 0; ix < 2; ix++) for (let iz = 0; iz < 2; iz++) {
    ring(0.075, 0.003, M.stoneDark, 2.74 + ix * 0.3, 0.953, 0.46 + iz * 0.23);
  }
  for (let i = 0; i < 3; i++) box(p, 0.032, 0.002, 0.009, M.steel, 2.82 + i * 0.075, 0.953, 0.77);
  // Hood now has its own opening between the upper cabinets, not through them.
  rbox(p, 0.82, 0.12, 0.48, 0.02, M.steel, 2.9, 1.72, 0.4);
  rbox(p, 0.27, 0.86, 0.25, 0.012, M.steel, 2.9, 2.19, 0.4);
  box(p, 0.73, 0.012, 0.35, M.dark, 2.9, 1.654, 0.42);
  box(p, 0.53, 0.008, 0.22, M.steel, 2.9, 1.646, 0.4);
  for (const x of [2.59, 3.21]) cyl(p, 0.028, 0.028, 0.008, M.bulbWarm, x, 1.646, 0.56);
  // 吊柜缩短到窗左侧，别把北墙的窗整个挡住
  box(p, 0.62, 0.72, 0.34, M.cream, 0.39, 1.94, 0.25);
  panel(p, 0.674, 0.674, 0.39, 1.94, 0.44);
  box(p, 0.52, 0.72, 0.34, M.cream, 3.64, 1.94, 0.42);
  panel(p, 0.494, 0.674, 3.64, 1.94, 0.6);
  box(p, 0.66, 0.025, 0.36, M.oak, 0.40, 1.57, 0.25);
  box(p, 0.5, 0.025, 0.36, M.oak, 3.64, 1.57, 0.42);

  // West return: the same fronts turned toward the aisle.
  box(p, 0.6, 0.72, 1.4, M.cream, 0.58, 0.51, 1.55);
  box(p, 0.48, 0.13, 1.34, M.darkWood, 0.53, 0.085, 1.55);
  rbox(p, 0.64, 0.045, 1.44, 0.009, counterTop, 0.58, 0.9, 1.55);
  for (let i = 0; i < 2; i++) {
    const front = new THREE.Group();
    front.position.set(0.885, 0, 1.2 + i * 0.7);
    front.rotation.y = Math.PI / 2;
    p.add(front);
    panel(front, 0.674, 0.65, 0, 0.5, 0);
  }
  // Compact espresso machine: inset brewing bay and a separate drip tray.
  rbox(p, 0.28, 0.36, 0.26, 0.025, M.steel, 0.56, 1.1, 1.3);
  rbox(p, 0.215, 0.22, 0.013, 0.012, M.black, 0.56, 1.075, 1.437);
  box(p, 0.235, 0.018, 0.13, M.steel, 0.56, 0.94, 1.43);
  box(p, 0.16, 0.055, 0.06, M.dark, 0.56, 1.16, 1.465);
  cyl(p, 0.018, 0.018, 0.02, M.brass, 0.63, 1.24, 1.44).rotation.x = Math.PI / 2;
  cyl(p, 0.036, 0.032, 0.073, M.ceramic, 0.56, 0.985, 1.45, 20);
  ring(0.034, 0.004, M.ceramic, 0.56, 1.023, 1.45);
  // Open shelf with two discrete brass brackets.
  rbox(p, 0.18, 0.035, 1.3, 0.008, M.oak, 0.5, 1.52, 1.55);
  for (const z of [1.05, 2.05]) {
    box(p, 0.16, 0.018, 0.025, M.brass, 0.47, 1.49, z);
    box(p, 0.018, 0.13, 0.025, M.brass, 0.395, 1.43, z);
  }
  for (let i = 0; i < 5; i++) {
    const mugMat = i % 2 ? M.ceramic : M.fabricBlue;
    cyl(p, 0.045, 0.038, 0.09, mugMat, 0.5, 1.585, 1.05 + i * 0.24, 16);
    cyl(p, 0.035, 0.035, 0.002, M.dark, 0.5, 1.632, 1.05 + i * 0.24, 16);
  }
  // Refrigerator has a recessed gasket, separate door leaves and two handles.
  rbox(p, 0.72, 1.9, 0.7, 0.035, M.cream, 0.66, 0.95, 2.7);
  box(p, 0.02, 1.78, 0.66, M.dark, 1.023, 0.96, 2.7);
  rbox(p, 0.035, 0.88, 0.642, 0.012, M.steel, 1.045, 1.42, 2.7);
  rbox(p, 0.035, 0.83, 0.642, 0.012, M.steel, 1.045, 0.53, 2.7);
  for (const y of [1.32, 0.63]) {
    rbox(p, 0.035, 0.32, 0.028, 0.008, M.brass, 1.09, y, 2.45);
    for (const dy of [-0.12, 0.12]) box(p, 0.036, 0.018, 0.024, M.brass, 1.072, y + dy, 2.45);
  }
  box(p, 0.024, 0.045, 0.51, M.dark, 1.028, 0.04, 2.7);
  const notes = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.24), new THREE.MeshBasicMaterial({ map: world.textures.note, transparent: true }));
  notes.rotation.y = Math.PI / 2;
  notes.position.set(1.064, 1.42, 2.8);
  p.add(notes);
  for (let i = 0; i < 3; i++) {
    const dot = cyl(p, 0.02, 0.02, 0.008, [M.terracotta, M.blue, M.fabricOchre][i], 1.067, 1.62 + (i % 2) * 0.09, 2.83 - i * 0.15);
    dot.rotation.z = Math.PI / 2;
  }
  // Everyday countertop objects, deliberately sparse at room scale.
  cyl(p, 0.1, 0.065, 0.065, M.ceramic, 3.5, 0.96, 0.62, 24);
  for (let i = 0; i < 4; i++) {
    addMesh(p, new THREE.SphereGeometry(0.045, 10, 8), i % 2 ? M.terracotta : M.fabricOchre,
      3.44 + (i % 2) * 0.08, 1.005, 0.58 + Math.floor(i / 2) * 0.07);
  }
  rbox(p, 0.32, 0.022, 0.23, 0.01, M.oak, 2.0, 0.945, 0.62, 0.2);
  rbox(p, 0.14, 0.25, 0.1, 0.012, M.darkWood, 0.62, 1.055, 2.05);
  addHotspot(world, 1.5, 2.7, 0.45, { title: '冰箱', sub: '门上贴着一张便利贴：今天也要好好吃饭', room: 'kitchen', spot: 'fridge', label: '冰箱前' });
  addHotspot(world, 1.3, 1.45, 0.4, { title: '水槽', sub: '水龙头有点松，杯子倒扣在沥水架上', room: 'kitchen', spot: 'sink', label: '水槽前' });
  addHotspot(world, 2.85, 1.45, 0.4, { title: '灶台', sub: '锅还热着，台面上有一小撮盐', room: 'kitchen', spot: 'stove', label: '灶台前' });
}

function buildDining(world, M) {
  const p = world.root;
  // Rotate the rounded profile into the tabletop plane; regular rbox rounds XY.
  const slab = (parent, w, d, h, radius, material, x, y, z) => {
    const mesh = rbox(parent, w, d, h, radius, material, x, y, z);
    mesh.rotation.x = -Math.PI / 2;
    return mesh;
  };
  const rod = (parent, a, b, radius, material, bottomRadius = radius) => {
    const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b);
    const axis = to.clone().sub(from);
    const center = from.clone().add(to).multiplyScalar(0.5);
    const mesh = cyl(parent, radius, bottomRadius, axis.length(), material, center.x, center.y, center.z, 12);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.normalize());
    return mesh;
  };
  // A softly rounded oak top, dark edge shadow, four aprons and tapered legs.
  slab(p, 1.47, 0.87, 0.035, 0.11, M.walnut, 2.1, 0.713, 4.9);
  slab(p, 1.5, 0.9, 0.055, 0.12, M.oak, 2.1, 0.74, 4.9);
  for (const dz of [-0.32, 0.32]) box(p, 1.15, 0.095, 0.035, M.walnut, 2.1, 0.654, 4.9 + dz);
  for (const dx of [-0.57, 0.57]) box(p, 0.035, 0.095, 0.62, M.walnut, 2.1 + dx, 0.654, 4.9);
  for (const [x, z] of [[1.45, 4.53], [2.75, 4.53], [1.45, 5.27], [2.75, 5.27]]) {
    const top = [x + (2.1 - x) * 0.1, 0.708, z + (4.9 - z) * 0.14];
    rod(p, [x, 0.025, z], top, 0.038, M.walnut, 0.024);
    cyl(p, 0.025, 0.025, 0.028, M.brass, x, 0.02, z, 12);
  }
  // Bent plywood backs and upholstered seats replace the block chair backs.
  // Both anchors and seat elevation remain aligned to the original layout.
  const diningChair = (x, z, ry) => {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = ry; p.add(g);
    slab(g, 0.44, 0.44, 0.047, 0.07, M.oak, 0, 0.449, 0);
    slab(g, 0.39, 0.37, 0.025, 0.065, M.linen, 0, 0.482, 0.018);
    slab(g, 0.374, 0.355, 0.036, 0.064, M.fabricCream, 0, 0.498, 0.018);
    for (const side of [-1, 1]) {
      rod(g, [side * 0.185, 0.025, 0.185], [side * 0.15, 0.43, 0.145], 0.024, M.walnut, 0.017);
      rod(g, [side * 0.185, 0.025, -0.195], [side * 0.17, 0.75, -0.17], 0.021, M.walnut, 0.018);
      box(g, 0.025, 0.057, 0.31, M.walnut, side * 0.165, 0.4, 0);
    }
    box(g, 0.32, 0.057, 0.025, M.walnut, 0, 0.4, 0.155);
    // Closed annular profile creates an actual 22 mm thick curved backrest.
    const shape = new THREE.Shape();
    for (let i = 0; i <= 16; i++) {
      const a = -0.64 + i / 16 * 1.28;
      const x = Math.sin(a) * 0.36, y = Math.cos(a) * 0.36 - 0.16;
      if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
    }
    for (let i = 16; i >= 0; i--) {
      const a = -0.64 + i / 16 * 1.28;
      shape.lineTo(Math.sin(a) * 0.338, Math.cos(a) * 0.338 - 0.16);
    }
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.22, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 1, steps: 1, curveSegments: 1 });
    geo.translate(0, 0, -0.11);
    const back = addMesh(g, geo, M.oak, 0, 0.77, 0);
    back.rotation.x = -Math.PI / 2;
  };
  diningChair(2.1, 4.28, 0);
  diningChair(2.1, 5.53, Math.PI);
  // Woven runner and ceramic place settings; no floating or intersecting dishes.
  slab(p, 1.12, 0.24, 0.005, 0.018, M.linenBlue, 2.1, 0.771, 4.9);
  cyl(p, 0.065, 0.095, 0.18, M.ceramic, 2.05, 0.865, 4.88, 24);
  cyl(p, 0.04, 0.065, 0.07, M.ceramic, 2.05, 0.99, 4.88, 24);
  for (let i = 0; i < 3; i++) {
    rod(p, [2.05, 0.99, 4.88], [2.05 + (i - 1) * 0.06, 1.19 - Math.abs(i - 1) * 0.025, 4.88], 0.006, M.plant);
    addMesh(p, new THREE.SphereGeometry(0.035, 10, 8), i % 2 ? M.fabricOchre : M.fabricBlue,
      2.05 + (i - 1) * 0.06, 1.19 - Math.abs(i - 1) * 0.025, 4.88);
  }
  for (const z of [4.6, 5.2]) {
    slab(p, 0.48, 0.28, 0.005, 0.022, M.linen, 2.1, 0.772, z);
    cyl(p, 0.113, 0.095, 0.012, M.ceramic, 2.1, 0.782, z, 24);
    const rim = addMesh(p, new THREE.TorusGeometry(0.111, 0.009, 6, 24), M.ceramic, 2.1, 0.79, z);
    rim.rotation.x = -Math.PI / 2;
    box(p, 0.013, 0.006, 0.155, M.steel, 1.92, 0.78, z);
    box(p, 0.014, 0.006, 0.16, M.steel, 2.28, 0.78, z);
  }
  // Layered pendant with inner lining, a rolled lip and ceiling rose.
  const shadeMat = M.dark.clone(); shadeMat.side = THREE.DoubleSide;
  const shade = addMesh(p, new THREE.ConeGeometry(0.24, 0.22, 24, 1, true), shadeMat, 2.1, 2.02, 4.9);
  const liningMat = M.cream.clone(); liningMat.side = THREE.DoubleSide;
  addMesh(p, new THREE.ConeGeometry(0.226, 0.203, 24, 1, true), liningMat, 2.1, 2.02, 4.9);
  const lip = addMesh(p, new THREE.TorusGeometry(0.235, 0.009, 6, 32), M.brass, 2.1, 1.912, 4.9);
  lip.rotation.x = -Math.PI / 2;
  const bulb = addMesh(p, new THREE.SphereGeometry(0.055, 12, 8), M.bulb, 2.1, 1.96, 4.9);
  cyl(p, 0.006, 0.006, 0.7, M.dark, 2.1, 2.5, 4.9);
  cyl(p, 0.065, 0.065, 0.025, M.dark, 2.1, 2.78, 4.9);
  world.lampMaterials.push(bulb.material);
  addHotspot(world, 2.1, 5.9, 0.42, { title: '餐桌', sub: '桌上有半杯凉掉的水，花瓶里的花该换了', room: 'kitchen', spot: 'dining', label: '餐桌边' });
}

function chair(world, x, z, ry, M) {
  const p = world.root;
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  p.add(g);
  rbox(g, 0.44, 0.06, 0.44, 0.03, M.oak, 0, 0.45, 0);
  for (const [dx, dz] of [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]]) {
    cyl(g, 0.018, 0.022, 0.45, M.walnut, dx, 0.225, dz);
  }
  rbox(g, 0.42, 0.42, 0.05, 0.03, M.oak, 0, 0.68, -0.2);
  rbox(g, 0.36, 0.06, 0.3, 0.02, M.fabricCream, 0, 0.49, 0.02);
}

function buildLiving(world, M, textures) {
  const p = world.root;
  // 地毯
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 2.4), new THREE.MeshStandardMaterial({ map: textures.rugLiving, roughness: 0.98, envMapIntensity: 0.12 }));
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(6.3, 0.014, 3.55);
  rug.receiveShadow = true;
  p.add(rug);

  // 电视柜：细边橡木框、内退底座与奶油色分格门板。
  for (const x of [5.35, 7.25]) for (const z of [0.23, 0.49]) cyl(p, 0.018, 0.023, 0.12, M.walnut, x, 0.06, z, 10);
  furnitureSoftBox(p, 2.2, 0.30, 0.42, 0.025, M.oak, 6.3, 0.27, 0.36);
  furnitureTop(p, 2.22, 0.44, 0.035, 0.04, M.oakLight, 6.3, 0.437, 0.36);
  box(p, 2.08, 0.25, 0.012, M.darkWood, 6.3, 0.27, 0.577);
  for (const x of [5.60, 7.0]) {
    furnitureSoftBox(p, 0.63, 0.245, 0.025, 0.012, M.cream, x, 0.27, 0.589);
    box(p, 0.22, 0.014, 0.018, M.brass, x, 0.33, 0.61);
  }
  // 中间的开放格与层板，书脊从阴影槽里露出。
  box(p, 0.68, 0.018, 0.035, M.oakLight, 6.3, 0.25, 0.592);
  for (let i = 0; i < 3; i++) box(p, 0.29 - i * 0.015, 0.024, 0.025, [M.teal, M.linen, M.terracotta][i], 6.21, 0.28 + i * 0.026, 0.598);
  furnitureSoftBox(p, 0.18, 0.045, 0.035, 0.008, M.black, 6.49, 0.29, 0.60);
  // 电视
  box(p, 1.78, 1.02, 0.055, M.black, 6.3, 1.2, 0.27);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.68, 0.92), M.screen);
  screen.position.set(6.3, 1.2, 0.3);
  p.add(screen);
  world.tvScreen = screen;
  box(p, 0.075, 0.28, 0.045, M.dark, 6.3, 0.59, 0.28);
  furnitureTop(p, 0.48, 0.22, 0.025, 0.035, M.dark, 6.3, 0.468, 0.3);
  // 音箱
  for (const x of [5.2, 7.4]) {
    cyl(p, 0.05, 0.06, 0.5, M.dark, x, 0.25, 0.3);
  }

  // 沙发：独立软包、退台底框、连续包边。坐垫顶面仍为 y=0.48。
  const sx = 6.3; const sz = 5.18;
  furnitureSoftBox(p, 2.0, 0.25, 0.86, 0.055, M.navy, sx, 0.245, sz);
  furnitureSoftBox(p, 1.92, 0.055, 0.78, 0.018, M.walnut, sx, 0.105, sz);
  furnitureSoftBox(p, 2.08, 0.46, 0.16, 0.06, M.navy, sx, 0.5, sz + 0.4);
  for (let i = 0; i < 2; i++) {
    const cx = sx - 0.48 + i * 0.96;
    furnitureSoftBox(p, 0.925, 0.18, 0.72, 0.075, M.fabricBlue, cx, 0.39, sz - 0.055);
    const seam = furniturePiping(p, 0.927, 0.722, 0.05, M.linenBlue, cx, 0.405, sz - 0.055);
    seam.rotation.x = -Math.PI / 2;
    const back = new THREE.Group(); back.position.set(cx, 0.585, sz + 0.29); back.rotation.x = 0.10; p.add(back);
    furnitureSoftBox(back, 0.925, 0.36, 0.19, 0.07, M.fabricBlue, 0, 0, 0);
    furniturePiping(back, 0.86, 0.30, 0.055, M.linenBlue, 0, 0, -0.097, 0.003);
  }
  for (const dx of [-1.02, 1.02]) {
    furnitureSoftBox(p, 0.16, 0.5, 0.82, 0.05, M.navy, sx + dx, 0.4, sz);
    furnitureSoftBox(p, 0.20, 0.08, 0.86, 0.035, M.fabricBlue, sx + dx, 0.66, sz);
  }
  for (const [dx, dz] of [[-0.85, -0.32], [0.85, -0.32], [-0.85, 0.32], [0.85, 0.32]]) {
    cyl(p, 0.027, 0.018, 0.12, M.walnut, sx + dx, 0.06, sz + dz, 10);
    cyl(p, 0.019, 0.019, 0.025, M.brass, sx + dx, 0.015, sz + dz, 10);
  }
  // 抱枕有滚边，薄毯沿坐垫前缘自然垂下。
  for (const [dx, angle, fabric] of [[-0.59, -0.14, M.fabricOchre], [0.58, 0.13, M.fabricCream]]) {
    const pillow = new THREE.Group(); pillow.position.set(sx + dx, 0.625, sz + 0.17); pillow.rotation.set(-0.12, angle, angle * 0.5); p.add(pillow);
    furnitureSoftBox(pillow, 0.36, 0.34, 0.13, 0.08, fabric, 0, 0, 0);
    furniturePiping(pillow, 0.31, 0.29, 0.055, M.linen, 0, 0, -0.066, 0.003);
  }
  // 搭毯已移除
  // 落地灯
  const lampBase = cyl(p, 0.16, 0.18, 0.03, M.dark, 4.55, 0.015, 5.12);
  cyl(p, 0.015, 0.02, 1.55, M.brass, 4.55, 0.78, 5.12);
  const shade2 = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.22, 0.26, 24, 1, true), M.fabricCream);
  shade2.position.set(4.55, 1.6, 5.12);
  shade2.material.side = THREE.DoubleSide;
  p.add(shade2);
  const bulb2 = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), M.bulb);
  bulb2.position.set(4.55, 1.56, 5.12);
  p.add(bulb2);
  world.lampMaterials.push(bulb2.material);

  // 茶几：椭圆角实木桌面、内退边线与下层置物板。
  furnitureTop(p, 1.16, 0.6, 0.055, 0.13, M.oakLight, 6.3, 0.4, 3.85);
  furnitureTop(p, 1.04, 0.48, 0.025, 0.10, M.walnut, 6.3, 0.363, 3.85);
  furnitureTop(p, 0.93, 0.40, 0.026, 0.08, M.oak, 6.3, 0.15, 3.85);
  for (const [dx, dz] of [[-0.43, -0.18], [0.43, -0.18], [-0.43, 0.18], [0.43, 0.18]]) cyl(p, 0.028, 0.018, 0.36, M.walnut, 6.3 + dx, 0.19, 3.85 + dz, 12);
  // 独立封面、书页、杯口与杯柄。
  for (const [x, y, z, angle, cover] of [[6.05, 0.451, 3.78, 0.18, M.terracotta], [6.07, 0.486, 3.79, -0.08, M.fabricBlue]]) {
    const book = new THREE.Group(); book.position.set(x, y, z); book.rotation.y = angle; p.add(book);
    box(book, 0.25, 0.026, 0.18, M.linen, 0, 0, 0);
    box(book, 0.265, 0.005, 0.195, cover, 0, 0.016, 0);
    box(book, 0.265, 0.005, 0.195, cover, 0, -0.016, 0);
    box(book, 0.009, 0.032, 0.195, cover, -0.13, 0, 0);
  }
  cyl(p, 0.069, 0.066, 0.009, M.ceramic, 6.55, 0.435, 3.9, 24);
  cyl(p, 0.045, 0.038, 0.085, M.ceramic, 6.55, 0.48, 3.9, 24);
  cyl(p, 0.036, 0.036, 0.002, M.darkWood, 6.55, 0.523, 3.9, 24);
  const handle = addMesh(p, new THREE.TorusGeometry(0.029, 0.008, 6, 16), M.ceramic, 6.601, 0.486, 3.9);
  furnitureSoftBox(p, 0.16, 0.02, 0.06, 0.012, M.dark, 6.5, 0.439, 3.72, -0.2);
  // 小植物
  const pot = cyl(p, 0.055, 0.045, 0.09, M.terracotta, 6.0, 0.46, 4.02);
  for (let i = 0; i < 4; i++) {
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), M.plantLight);
    leaf.scale.set(0.5, 1.3, 0.5);
    leaf.position.set(6.0 + Math.cos(i) * 0.04, 0.56 + i * 0.015, 4.02 + Math.sin(i) * 0.03);
    leaf.rotation.z = (i - 1.5) * 0.3;
    p.add(leaf);
  }

  // 书架（东墙）：开放的柜体，背板在东侧，书脊朝向客厅。
  const bx = 8.2; const bz = 1.75;
  box(p, 0.024, 2.08, 1.42, M.darkWood, bx + 0.135, 1.075, bz);
  for (const z of [bz - 0.705, bz + 0.705]) box(p, 0.3, 2.15, 0.04, M.oak, bx, 1.075, z);
  box(p, 0.3, 0.04, 1.45, M.oakLight, bx, 2.13, bz);
  box(p, 0.3, 0.07, 1.45, M.oak, bx, 0.07, bz);
  for (let i = 0; i < 4; i++) {
    const shelfY = 0.35 + i * 0.48;
    box(p, 0.3, 0.032, 1.38, M.oak, bx, shelfY, bz);
    let cursor = bz - 0.58;
    for (let j = 0; j < 6; j++) {
      const bw = 0.045 + rnd() * 0.035; const bh = 0.20 + rnd() * 0.11;
      const colors = [M.terracotta, M.blue, M.fabricOchre, M.teal, M.linen, M.navy];
      box(p, 0.20, bh, bw, colors[(i + j) % colors.length], bx - 0.02, shelfY + bh / 2 + 0.017, cursor + bw / 2);
      box(p, 0.004, 0.012, bw * 0.65, M.linen, bx - 0.122, shelfY + bh - 0.026, cursor + bw / 2);
      cursor += bw + 0.014;
    }
    if (i % 2 === 0) {
      box(p, 0.19, 0.045, 0.27, M.teal, bx - 0.02, shelfY + 0.040, bz + 0.39);
      box(p, 0.18, 0.035, 0.24, M.linen, bx - 0.025, shelfY + 0.08, bz + 0.37);
    }
  }
  cyl(p, 0.045, 0.075, 0.18, M.ceramic, bx - 0.02, 1.90, bz + 0.43, 24);
  cyl(p, 0.035, 0.035, 0.025, M.ceramic, bx - 0.02, 2.0, bz + 0.43, 24);
  // 饮水机（挪到餐厅西北角，靠墙）
  box(p, 0.4, 0.95, 0.4, M.white, 0.66, 0.48, 3.26);
  box(p, 0.34, 0.06, 0.34, M.steel, 0.66, 0.98, 3.26);
  cyl(p, 0.12, 0.14, 0.3, M.blue, 0.66, 1.15, 3.26);
  cyl(p, 0.04, 0.04, 0.06, M.ceramic, 0.84, 0.9, 3.26);
  for (let i = 0; i < 2; i++) cyl(p, 0.035, 0.035, 0.09, M.ceramic, 0.66 + (i ? 0.1 : -0.1), 0.85, 3.38);
  // 大绿植
  plant(world, 7.9, 0.52, 0.95);   // 电视柜右侧
  plant(world, 4.62, 0.52, 0.95);   // 电视柜左侧

  // 挂画（卧室墙外侧）
  const art = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.75), new THREE.MeshStandardMaterial({ map: artTexture(0), roughness: 0.8 }));
  art.rotation.y = -Math.PI / 2;
  art.position.set(8.405, 1.65, 3.35);
  p.add(art);
  box(p, 0.04, 0.8, 1.05, M.walnut, 8.39, 1.65, 3.35);

  addHotspot(world, 6.3, 5.12, 0.55, { title: '沙发', sub: '靠垫陷下去一小块，毯子卷在扶手上', room: 'living', spot: 'sofa', label: '沙发上' });
  addHotspot(world, 0.66, 3.26, 0.4, { title: '饮水机', sub: '温水按键有点松，杯架上只剩一只杯子', room: 'living', spot: 'water', label: '饮水机旁' });
  addHotspot(world, 7.85, 1.75, 0.45, { title: '书架', sub: '第三层夹着一张手写的便签', room: 'living', spot: 'shelf', label: '书架前' });
  addHotspot(world, 6.3, 3.0, 0.5, { title: '电视', sub: '屏幕里在放海，声音开得很小', room: 'living', spot: 'tv', label: '电视前' });
  addHotspot(world, 6.3, 3.8, 0.4, { title: '茶几', sub: '杯子剩半杯，书翻到一半扣着', room: 'living', spot: 'sofa', label: '茶几旁' });
}

function buildBedroom(world, M, textures) {
  const p = world.root;
  // 地毯
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 1.7), new THREE.MeshStandardMaterial({ map: textures.rugBed, roughness: 0.98, envMapIntensity: 0.1 }));
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(11.5, 0.014, 2.95);
  rug.receiveShadow = true;
  p.add(rug);

  // 床：退台底框、床垫包边与分层床品，维持原有床面高度。
  furnitureSoftBox(p, 2.3, 0.20, 2.15, 0.025, M.walnut, 11.5, 0.21, 1.25);
  box(p, 2.14, 0.09, 1.99, M.darkWood, 11.5, 0.09, 1.25);
  furnitureSoftBox(p, 2.1, 0.22, 1.95, 0.08, M.linen, 11.5, 0.43, 1.3);
  for (const y of [0.385, 0.475]) {
    const seam = furniturePiping(p, 2.102, 1.952, 0.055, M.white, 11.5, y, 1.3, 0.005);
    seam.rotation.x = -Math.PI / 2;
  }
  furnitureSoftBox(p, 2.16, 0.14, 1.45, 0.07, M.fabricCream, 11.5, 0.57, 1.62);
  // 一片连续布面形成细小褶皱；褶皱高度限制在一厘米以内。
  const quiltGeo = new THREE.PlaneGeometry(2.08, 1.37, 24, 20);
  const quiltPositions = quiltGeo.attributes.position;
  for (let i = 0; i < quiltPositions.count; i++) {
    const u = quiltPositions.getX(i); const v = quiltPositions.getY(i);
    const fade = Math.sin((u / 2.08 + 0.5) * Math.PI) * Math.sin((v / 1.37 + 0.5) * Math.PI);
    quiltPositions.setXYZ(i, u, 0.008 * Math.sin(u * 19 + v * 8) * fade, -v);
  }
  quiltGeo.computeVertexNormals();
  addMesh(p, quiltGeo, M.fabricCream, 11.5, 0.641, 1.62);
  furnitureSoftBox(p, 2.16, 0.035, 0.20, 0.015, M.white, 11.5, 0.65, 0.97);
  furnitureSoftBox(p, 2.16, 0.05, 0.55, 0.04, M.fabricOchre, 11.5, 0.665, 2.10);
  for (const z of [1.91, 2.28]) box(p, 2.08, 0.003, 0.014, M.linen, 11.5, 0.692, z);
  for (let i = 0; i < 2; i++) {
    const pillow = new THREE.Group(); pillow.position.set(11.04 + i * 0.90, 0.655, 0.60); pillow.rotation.y = i ? -0.04 : 0.035; p.add(pillow);
    furnitureSoftBox(pillow, 0.72, 0.18, 0.42, 0.085, M.white, 0, 0, 0);
    const seam = furniturePiping(pillow, 0.722, 0.422, 0.065, M.linen, 0, 0.0, 0, 0.003);
    seam.rotation.x = -Math.PI / 2;
  }
  // 床头木框内嵌竖向软包，不增加床头占地。
  furnitureSoftBox(p, 2.34, 1.0, 0.1, 0.045, M.walnut, 11.5, 0.62, 0.2);
  for (let i = 0; i < 6; i++) furnitureSoftBox(p, 0.36, 0.77, 0.075, 0.055, M.fabricBlue, 10.55 + i * 0.38, 0.68, 0.235);
  for (const x of [10.5, 12.5]) for (const z of [0.3, 2.28]) cyl(p, 0.03, 0.025, 0.15, M.walnut, x, 0.075, z, 12);
  // 鲸鱼玩偶
  const wh = new THREE.Group();
  wh.position.set(12.15, 0.72, 1.05);
  wh.rotation.y = -0.6;
  p.add(wh);
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.16, 18, 14), M.fabricBlue);
  body.scale.set(1.3, 0.9, 0.85);
  wh.add(body);
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12), M.linen);
  belly.scale.set(1.0, 0.62, 0.55);
  belly.position.set(0.01, -0.06, 0.06);
  wh.add(belly);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.22, 3), M.fabricBlue);
  tail.rotation.z = Math.PI / 2;
  tail.position.set(-0.22, 0.03, 0);
  wh.add(tail);
  for (const dz of [-0.065, 0.065]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), M.black);
    eye.position.set(0.14, 0.02, dz);
    wh.add(eye);
  }
  // 床头柜：薄桌面、抽屉阴缝与实木脚。
  furnitureSoftBox(p, 0.46, 0.37, 0.46, 0.024, M.oak, 10.1, 0.305, 0.55);
  furnitureTop(p, 0.48, 0.48, 0.025, 0.04, M.oakLight, 10.1, 0.502, 0.55);
  box(p, 0.415, 0.30, 0.008, M.darkWood, 10.1, 0.305, 0.783);
  for (const y of [0.225, 0.385]) {
    furnitureSoftBox(p, 0.397, 0.142, 0.018, 0.01, M.cream, 10.1, y, 0.791);
    box(p, 0.11, 0.012, 0.018, M.brass, 10.1, y + 0.025, 0.81);
  }
  for (const x of [9.93, 10.27]) for (const z of [0.38, 0.72]) cyl(p, 0.016, 0.013, 0.13, M.walnut, x, 0.065, z, 10);
  // 台灯
  cyl(p, 0.06, 0.08, 0.22, M.ceramic, 10.1, 0.59, 0.55);
  const shade3 = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.15, 0.2, 20, 1, true), M.fabricCream);
  shade3.position.set(10.1, 0.76, 0.55);
  shade3.material.side = THREE.DoubleSide;
  p.add(shade3);
  const bulb3 = new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), M.bulb);
  bulb3.position.set(10.1, 0.72, 0.55);
  p.add(bulb3);
  world.lampMaterials.push(bulb3.material);
  // 书、杯子（床边水）
  box(p, 0.2, 0.03, 0.15, M.terracotta, 9.98, 0.53, 0.72, 0.3);
  cyl(p, 0.035, 0.032, 0.1, M.glass, 10.3, 0.56, 0.65);

  // 书桌（北墙角落，紧挨床头柜）：横向加宽，显示器靠墙朝南
  const DKX = 9.17, DKZ = 0.66;
  furnitureTop(p, 1.30, 0.62, 0.05, 0.07, M.oakLight, DKX, 0.74, DKZ);
  box(p, 1.16, 0.08, 0.035, M.walnut, DKX, 0.675, DKZ - 0.26);
  box(p, 1.16, 0.08, 0.035, M.walnut, DKX, 0.675, DKZ + 0.26);
  for (const [x, z] of [[DKX - 0.56, DKZ - 0.25], [DKX + 0.56, DKZ - 0.25], [DKX - 0.56, DKZ + 0.25], [DKX + 0.56, DKZ + 0.25]]) cyl(p, 0.026, 0.018, 0.72, M.walnut, x, 0.36, z, 12);
  furnitureSoftBox(p, 0.40, 0.12, 0.33, 0.012, M.oak, DKX + 0.38, 0.65, DKZ - 0.02);
  box(p, 0.16, 0.014, 0.018, M.brass, DKX + 0.38, 0.665, DKZ - 0.02);
  furnitureTop(p, 0.26, 0.20, 0.018, 0.025, M.dark, DKX, 0.775, DKZ - 0.12);
  box(p, 0.05, 0.16, 0.04, M.dark, DKX, 0.85, DKZ - 0.18);
  furnitureSoftBox(p, 0.50, 0.36, 0.035, 0.016, M.black, DKX, 1.06, DKZ - 0.20);
  const dscreen = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.31), M.deskScreen);
  dscreen.position.set(DKX, 1.06, DKZ - 0.182);
  p.add(dscreen);
  world.deskScreen = dscreen;
  furnitureTop(p, 0.50, 0.32, 0.005, 0.035, M.navy, DKX, 0.769, DKZ + 0.05);
  furnitureTop(p, 0.30, 0.15, 0.018, 0.012, M.dark, DKX, 0.784, DKZ + 0.05);
  for (let row = 0; row < 4; row++) box(p, 0.26, 0.004, 0.018, M.steel, DKX, 0.796, DKZ + row * 0.032 - 0.01);
  cyl(p, 0.045, 0.04, 0.1, M.ceramic, DKX + 0.50, 0.82, DKZ + 0.02, 20);
  cyl(p, 0.035, 0.035, 0.002, M.darkWood, DKX + 0.50, 0.871, DKZ + 0.02, 20);
  box(p, 0.20, 0.025, 0.14, M.terracotta, DKX - 0.50, 0.78, DKZ + 0.15, 0.12);
  box(p, 0.19, 0.018, 0.13, M.linen, DKX - 0.50, 0.784, DKZ + 0.15, 0.12);
  chair(world, DKX, DKZ + 0.92, Math.PI, M);
  cyl(p, 0.06, 0.07, 0.02, M.dark, DKX - 0.54, 0.78, DKZ - 0.16);
  cyl(p, 0.012, 0.014, 0.4, M.brass, DKX - 0.54, 0.98, DKZ - 0.16);
  const shade4 = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.14, 18, 1, true), M.fabricCream);
  shade4.position.set(DKX - 0.54, 1.16, DKZ - 0.18);
  p.add(shade4);
  // 衣柜（南墙）：实木外框与内嵌门板，窄阴缝、长拉手。
  furnitureSoftBox(p, 1.6, 2.15, 0.36, 0.02, M.oak, 12.15, 1.075, 4.13);
  box(p, 1.45, 0.09, 0.29, M.darkWood, 12.15, 0.05, 4.13);
  box(p, 1.50, 2.0, 0.01, M.darkWood, 12.15, 1.08, 4.015);
  for (let i = 0; i < 2; i++) {
    const x = 11.77 + i * 0.76;
    furnitureSoftBox(p, 0.735, 1.97, 0.025, 0.013, M.white, x, 1.08, 4.005);
    furnitureSoftBox(p, 0.64, 1.76, 0.009, 0.008, M.cream, x, 1.1, 3.986);
    box(p, 0.018, 0.34, 0.024, M.brass, 12.1 + i * 0.10, 1.1, 3.965);
  }
  box(p, 1.57, 0.025, 0.02, M.oakLight, 12.15, 2.13, 4.005);
  // 窗帘
  for (const z of [0.95, 3.05]) {
    const cur = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 2.2), new THREE.MeshStandardMaterial({ color: 0xa9b8c8, roughness: 0.98, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }));
    cur.rotation.y = Math.PI / 2;
    cur.position.set(13.08, 1.5, z + (z < 2 ? 0.25 : -0.25));
    p.add(cur);
  }
  cyl(p, 0.018, 0.018, 2.4, M.brass, 13.08, 2.45, 2.0).rotation.x = Math.PI / 2;
  // 挂画、洞洞板
  const art = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.68), new THREE.MeshStandardMaterial({ map: artTexture(2), roughness: 0.8 }));
  art.rotation.y = Math.PI / 2;
  art.position.set(8.405, 1.65, 1.1);
  p.add(art);
  box(p, 0.04, 0.74, 0.98, M.walnut, 8.39, 1.65, 1.1);
  // 记忆板（走廊/房间的旧留言）
  const mem = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.6), new THREE.MeshStandardMaterial({ map: textures.memory, roughness: 0.9 }));
  mem.rotation.y = Math.PI / 2;
  mem.position.set(8.41, 1.45, 3.85);
  p.add(mem);
  world.memoryMesh = mem;

  addHotspot(world, 11.4, 1.32, 0.6, { title: '床', sub: '被子有点皱，鲸鱼玩偶在左边，床头放着半杯水', room: 'her_room', spot: 'bed', label: '床上' });
  addHotspot(world, 9.7, 0.9, 0.45, { title: '书桌', sub: '屏幕还亮着，杯子里剩半杯凉茶', room: 'her_room', spot: 'desk', label: '书桌前' });
  addHotspot(world, 12.1, 3.4, 0.4, { title: '衣柜', sub: '柜门没关严，露出一截蓝白的裙角', room: 'her_room', spot: 'wardrobe', label: '衣柜前' });
  addHotspot(world, 12.55, 2.75, 0.4, { title: '窗边', sub: '能看见海，窗台上有一小盆多肉', room: 'her_room', spot: 'window', label: '窗边' });
}

function buildBathroom(world, M) {
  const p = world.root;
  // 洗手台
  box(p, 0.65, 0.82, 1.0, M.cream, 12.82, 0.41, 6.5);
  box(p, 0.7, 0.05, 1.05, M.stone, 12.82, 0.86, 6.5);
  box(p, 0.48, 0.08, 0.55, M.ceramic, 12.78, 0.92, 6.5);
  box(p, 0.4, 0.02, 0.42, M.steel, 12.8, 0.96, 6.5);
  cyl(p, 0.018, 0.02, 0.24, M.brass, 13.02, 1.06, 6.5);
  const spout2 = cyl(p, 0.015, 0.015, 0.2, M.brass, 12.92, 1.16, 6.5);
  spout2.rotation.z = Math.PI / 2;
  box(p, 0.016, 0.65, 0.91, M.darkWood, 12.488, 0.43, 6.5);
  for (const y of [0.27, 0.585]) {
    rbox(p, 0.025, 0.295, 0.88, 0.009, M.oakLight, 12.47, y, 6.5);
    box(p, 0.035, 0.016, 0.23, M.brass, 12.445, y + 0.09, 6.5);
  }
  // 镜子
  box(p, 0.04, 0.9, 0.8, M.brass, 13.18, 1.55, 6.5);
  const mirror = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.82), M.mirror);
  mirror.rotation.y = -Math.PI / 2;
  mirror.position.set(13.15, 1.55, 6.5);
  p.add(mirror);
  // 马桶（西侧）
  box(p, 0.42, 0.4, 0.6, M.ceramic, 11.25, 0.2, 6.15);
  const bowl = new THREE.Mesh(new THREE.SphereGeometry(0.26, 18, 12), M.ceramic);
  bowl.scale.set(1, 0.55, 0.8);
  bowl.position.set(11.3, 0.38, 6.15);
  p.add(bowl);
  const seat = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.035, 8, 22), M.ceramic);
  seat.rotation.x = -Math.PI / 2;
  seat.position.set(11.32, 0.47, 6.15);
  p.add(seat);
  box(p, 0.12, 0.75, 0.45, M.ceramic, 10.98, 0.375, 6.15);
  box(p, 0.1, 0.05, 0.42, M.ceramic, 11.0, 0.78, 6.15);
  // 淋浴
  box(p, 0.02, 2.1, 0.95, M.glass, 12.0, 1.05, 7.6);
  box(p, 0.95, 2.1, 0.02, M.glass, 11.5, 1.05, 7.13);
  box(p, 0.04, 2.15, 0.04, M.steel, 12.0, 1.07, 7.13);
  box(p, 0.04, 2.15, 0.04, M.steel, 12.0, 1.07, 8.1);
  cyl(p, 0.02, 0.025, 0.5, M.steel, 11.05, 1.9, 7.6);
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.02, 20), M.steel);
  head.position.set(11.35, 2.1, 7.6);
  head.rotation.z = 0.15;
  p.add(head);
  box(p, 0.9, 0.03, 0.85, M.stoneDark, 11.5, 0.015, 7.6);
  // 毛巾
  for (const z of [5.95, 6.35]) {
    const towel = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.55, 0.3), M.linenBlue);
    towel.position.set(10.88, 1.3, z);
    p.add(towel);
    box(p, 0.02, 0.02, 0.36, M.steel, 10.9, 1.6, z);
  }
  // 浴室垫、小植物
  const bathmat = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.5), new THREE.MeshStandardMaterial({ color: 0xc8d2d0, roughness: 1 }));
  bathmat.rotation.x = -Math.PI / 2;
  bathmat.position.set(12.3, 0.015, 6.55);
  p.add(bathmat);
  plant(world, 12.78, 7.05, 0.5);

  addHotspot(world, 12.0, 6.45, 0.4, { title: '洗手台', sub: '镜子上有一点水汽，牙杯里插着两支牙刷', room: 'bathroom', spot: 'sink', label: '洗手台前' });
  addHotspot(world, 11.9, 6.2, 0.38, { title: '马桶', sub: '旁边放着手机，看来刚才在这里坐了一会儿', room: 'bathroom', spot: 'toilet', label: '马桶边' });
  addHotspot(world, 11.5, 7.1, 0.4, { title: '淋浴', sub: '喷头还挂着水珠，地漏上有一小撮头发', room: 'bathroom', spot: 'shower', label: '淋浴间' });
}

function buildCorridor(world, M) {
  const p = world.root;
  // （去掉走廊那条蓝色长地毯）
  // 画廊墙（整体右移 0.2 米，避开左侧门洞）
  const arts = [1, 3, 0, 2];
  for (let i = 0; i < 4; i++) {
    const x = 10.05 + i * 0.72;
    const art = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.42), new THREE.MeshStandardMaterial({ map: artTexture(arts[i]), roughness: 0.8 }));
    art.position.set(x, 1.55, 4.52);
    p.add(art);
    box(p, 0.64, 0.5, 0.03, M.walnut, x, 1.55, 4.5);
  }
  // 边柜 + 花瓶
  rbox(p, 0.9, 0.5, 0.2, 0.02, M.oak, 12.15, 0.25, 5.48);
  cyl(p, 0.07, 0.09, 0.24, M.ceramic, 12.15, 0.62, 5.48);
  for (let i = 0; i < 5; i++) {
    const twig = cyl(p, 0.006, 0.008, 0.36, M.darkWood, 12.15 + (i - 2) * 0.02, 0.88, 5.48);
    twig.rotation.z = (i - 2) * 0.12;
  }
  // 壁灯：每幅画一盏，位置与画中心对齐
  for (let i = 0; i < 4; i++) {
    const x = 10.05 + i * 0.72;
    box(p, 0.18, 0.045, 0.06, M.brass, x, 2.04, 4.50);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.028, 10, 8), M.bulbWarm);
    bulb.position.set(x, 1.99, 4.51);
    p.add(bulb);
    world.lampMaterials.push(bulb.material);
  }
  addHotspot(world, 9.8, 4.68, 0.5, { title: '画廊墙', sub: '四幅画，最右边那幅是蓝鲸，画框有点歪', room: 'corridor', spot: 'gallery', label: '画廊墙前' });
}

function buildLaundry(world, M) {
  const p = world.root;
  // 洗衣机
  box(p, 0.6, 0.86, 0.6, M.white, 10.4, 0.43, 6.15);
  const door = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.035, 8, 24), M.steel);
  door.rotation.y = Math.PI / 2;
  door.position.set(10.09, 0.5, 6.15);
  p.add(door);
  const glass = new THREE.Mesh(new THREE.CircleGeometry(0.16, 24), M.glass);
  glass.rotation.y = -Math.PI / 2;
  glass.position.set(10.08, 0.5, 6.15);
  p.add(glass);
  box(p, 0.02, 0.14, 0.3, M.dark, 10.08, 0.82, 6.15);
  // 洗衣液（放在洗衣机顶上，别浮在半空）
  for (let i = 0; i < 3; i++) {
    cyl(p, 0.042, 0.046, 0.19, [M.blue, M.terracotta, M.teal][i], 10.24 + i * 0.155, 0.955, 6.15);
    cyl(p, 0.016, 0.016, 0.03, M.dark, 10.24 + i * 0.155, 1.065, 6.15);
  }
  // 晾衣架
  // 晾衣架：贴着西墙摆，长度收短，两端都不穿墙、也不挡窗
  const rack = new THREE.Group();
  rack.position.set(8.86, 0, 7.45);
  p.add(rack);
  box(rack, 0.66, 0.02, 0.02, M.steel, 0, 1.5, 0);
  box(rack, 0.66, 0.02, 0.02, M.steel, 0, 1.1, 0);
  for (const dx of [-0.31, 0.31]) {
    box(rack, 0.02, 1.5, 0.02, M.steel, dx, 0.75, 0);
    box(rack, 0.02, 0.02, 0.14, M.steel, dx, 1.5, 0.07);
  }
  for (let i = 0; i < 3; i++) {
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 0.32), new THREE.MeshStandardMaterial({ color: [0x8fa3b8, 0xe1d6c4, 0x6f89a5][i], roughness: 0.98, side: THREE.DoubleSide }));
    cloth.position.set(-0.22 + i * 0.22, 1.28, 0.03);
    rack.add(cloth);
  }
  // 家政间小窗
  addHotspot(world, 9.7, 6.5, 0.55, { title: '洗衣机', sub: '还有二十多分钟才洗完，滚筒里转着几件蓝白色的衣服', room: 'laundry', spot: 'washer', label: '洗衣机前' });
}

function buildBalcony(world, M) {
  const p = world.root;
  // 玻璃栏板
  const railGlass = M.glass;
  for (let x = 0.1; x < 8.1; x += 1.0) {
    const g = new THREE.Mesh(new THREE.PlaneGeometry(0.98, 1.0), railGlass);
    g.position.set(x + 0.49, 0.55, 8.96);
    p.add(g);
    box(p, 0.035, 1.0, 0.035, M.steel, x, 0.55, 8.96);
  }
  box(p, 8.1, 0.05, 0.05, M.steel, 4.05, 1.06, 8.96);
  // 西侧栏板：补上原来缺失的一段（玻璃 + 两端立柱 + 通长扶手）
  const westGlass = new THREE.Mesh(new THREE.PlaneGeometry(1.34, 1.0), railGlass);
  westGlass.rotation.y = Math.PI / 2;
  westGlass.position.set(0.06, 0.55, 8.3);
  p.add(westGlass);
  for (const z of [7.65, 8.95]) box(p, 0.035, 1.0, 0.035, M.steel, 0.06, 0.55, z);
  box(p, 0.05, 0.05, 1.36, M.steel, 0.06, 1.06, 8.3);

  // 东侧栏板：一整片玻璃，两端立柱 + 通长扶手
  // 东侧栏板：中间留一个 0.9 米宽的门洞，通往泳池露台
  for (const [zc, hgt] of [[7.72, 0.42], [8.94, 0.42]]) {
    const seg = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 1.0), railGlass);
    seg.rotation.y = Math.PI / 2;
    seg.position.set(8.16, 0.55, zc);
    p.add(seg);
    box(p, 0.05, 0.05, 0.42, M.steel, 8.16, 1.06, zc);
  }
  for (const z of [7.65, 7.93, 8.73, 8.95]) box(p, 0.035, 1.0, 0.035, M.steel, 8.16, 0.55, z);
  // 躺椅
  const lounge = new THREE.Group();
  lounge.position.set(2.67, 0, 8.22);
  lounge.rotation.y = -0.3;
  p.add(lounge);
  // Slatted timber chaise, raised backrest and fitted outdoor cushion.
  for (const z of [-0.235, 0.235]) rbox(lounge, 1.35, 0.09, 0.055, 0.018, M.oak, 0, 0.3, z);
  for (let i = 0; i < 9; i++) rbox(lounge, 0.13, 0.035, 0.48, 0.012, M.oakLight, -0.6 + i * 0.15, 0.35, 0);
  for (const [dx, dz] of [[-0.55, -0.2], [0.55, -0.2], [-0.55, 0.2], [0.55, 0.2]]) {
    cyl(lounge, 0.033, 0.022, 0.29, M.oak, dx, 0.16, dz, 10);
    cyl(lounge, 0.024, 0.024, 0.026, M.brass, dx, 0.025, dz, 10);
  }
  rbox(lounge, 0.9, 0.075, 0.46, 0.03, M.fabricCream, 0.16, 0.4, 0);
  const back = new THREE.Group(); back.position.set(-0.28, 0.38, 0); back.rotation.z = -0.48; lounge.add(back);
  rbox(back, 0.43, 0.045, 0.48, 0.018, M.oak, -0.215, 0, 0);
  rbox(back, 0.42, 0.08, 0.45, 0.035, M.fabricCream, -0.215, 0.055, 0);
  rbox(back, 0.15, 0.075, 0.36, 0.035, M.fabricBlue, -0.32, 0.125, 0);
  rbox(lounge, 0.28, 0.018, 0.48, 0.008, M.fabricBlue, 0.37, 0.447, 0);
  for (const z of [-0.252, 0.252]) rbox(lounge, 0.6, 0.035, 0.035, 0.012, M.oak, 0.05, 0.52, z);
  // 小边桌
  cyl(p, 0.22, 0.22, 0.035, M.oak, 1.95, 0.55, 8.6);
  cyl(p, 0.03, 0.05, 0.55, M.steel, 1.95, 0.28, 8.6);
  cyl(p, 0.045, 0.04, 0.09, M.ceramic, 1.95, 0.62, 8.6);
  // 植物
  plant(world, 0.75, 8.25, 1.3);
  plant(world, 1.45, 8.8, 0.95);
  // 串灯
  const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffdca8 });
  for (let i = 0; i < 20; i++) {
    const x = 0.35 + i * 0.39;
    const y = 2.2 - Math.sin((i / 19) * Math.PI) * 0.18 - 0.12;
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.022, 6, 5), bulbMat);
    b.position.set(x, y, 8.93);
    p.add(b);
  }
  // 晒衣绳
  const line = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 4.0, 4), M.steel);
  line.rotation.z = Math.PI / 2;
  line.position.set(4.2, 2.0, 8.85);
  p.add(line);
  addHotspot(world, 3.0, 8.45, 0.5, { title: '阳台栏杆', sub: '风从海那边过来，栏杆上有一点盐霜', room: 'balcony', spot: 'chair', label: '栏杆边' });
  addHotspot(world, 2.67, 8.22, 0.5, { title: '躺椅', sub: '搭着一条蓝毯子，扶手上放着半杯柠檬水', room: 'balcony', spot: 'chair', label: '躺椅上' });
  addHotspot(world, 1.2, 8.2, 0.45, { title: '花盆', sub: '薄荷长得有点疯，叶子上还挂着水', room: 'balcony', spot: 'plant', label: '花盆边' });
}

// 户外泳池露台：从阳台东侧往外延伸出去，无墙、朝海
// 户外泳池露台：一条和房子同长的贴瓷砖大泳池，长边与阳台栏杆平行
function buildPoolDeck(world, M) {
  const p = world.root;
  // 露台范围：x 方向与房子等长；z 方向从栏杆外侧一直铺到海边
  const DECK_X0 = 0.15, DECK_X1 = 13.2;   // 右边界对齐房子东墙
  const DECK_Z0 = 9.0, DECK_Z1 = 13.5;
  const POOL_X0 = 1.0, POOL_X1 = 10.2;      // 长度 ≈ 9.2 米：左侧泳池，右侧休息区
  const POOL_Z0 = 10.05, POOL_Z1 = 12.55;   // 宽度 2.5 米
  const POOL_DEPTH = 1.35;
  const DECK_TOP = -0.002;   // 完成面与地板齐平（下沉 2mm，避免共面闪烁）
  const DECK_THICK = 0.32;   // 板厚（埋在下面）

  // ── 瓷砖贴图：细缝 + 轻微色差 ─────────────────────────────
  const makeTileTexture = (base, grout, cells, repeatX, repeatZ) => {
    const size = 512;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const g = cv.getContext('2d');
    g.fillStyle = grout;
    g.fillRect(0, 0, size, size);
    const cell = size / cells;
    const pad = Math.max(1, cell * 0.055);
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        const jitter = ((x * 37 + y * 91) % 7) / 7;
        const shade = 0.94 + jitter * 0.12;
        const c = new THREE.Color(base).multiplyScalar(shade);
        g.fillStyle = `#${c.getHexString()}`;
        g.fillRect(x * cell + pad, y * cell + pad, cell - pad * 2, cell - pad * 2);
        // 瓷砖高光
        g.fillStyle = 'rgba(255,255,255,0.10)';
        g.fillRect(x * cell + pad, y * cell + pad, cell - pad * 2, Math.max(1, cell * 0.08));
      }
    }
    const tex = new THREE.CanvasTexture(cv);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(repeatX, repeatZ);
    tex.anisotropy = 4;
    return tex;
  };

  const deckTile = makeTileTexture('#e8e2d6', '#bdb5a6', 8, 16, 4.8);
  const poolTile = makeTileTexture('#7fd2ea', '#cfeeff', 10, 14, 3);
  const wallTile = makeTileTexture('#59b6d8', '#bfe8f6', 10, 14, 2);

  const deckMat = new THREE.MeshStandardMaterial({ map: deckTile, roughness: 0.72 });
  const floorMat = new THREE.MeshStandardMaterial({ map: poolTile, roughness: 0.32 });
  const wallMat = new THREE.MeshStandardMaterial({ map: wallTile, roughness: 0.3 });

  // 阳台东侧这块（原来露出的是室内木地板）铺成和阳台同款地砖
  {
    // 和阳台地面完全一致：同样的贴图、重复次数、高度、材质参数
    const t = world.textures.tileBalcony.clone();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(4.88, 1.4);
    t.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(13.2 - 8.2, 9.0 - 7.6),
      new THREE.MeshStandardMaterial({ map: t, roughness: 0.66, metalness: 0.02, envMapIntensity: 0.3 })
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set((8.2 + 13.2) / 2, 0.008, (7.6 + 9.0) / 2);
    m.receiveShadow = true;
    p.add(m);
  }

  // ── 露台地面：只铺四块，中间留出泳池开口（不能铺整块，否则就是“盖板”）──
  const deckW = DECK_X1 - DECK_X0, deckD = DECK_Z1 - DECK_Z0;
  const pw = POOL_X1 - POOL_X0, pd = POOL_Z1 - POOL_Z0;
  const stripMat = deckMat;
  const strips = [
    // 北侧（靠栏杆）一条
    [(DECK_X0 + DECK_X1) / 2, (DECK_Z0 + POOL_Z0) / 2, deckW, POOL_Z0 - DECK_Z0],
    // 南侧（靠海）一条
    [(DECK_X0 + DECK_X1) / 2, (POOL_Z1 + DECK_Z1) / 2, deckW, DECK_Z1 - POOL_Z1],
    // 西侧
    [(DECK_X0 + POOL_X0) / 2, (POOL_Z0 + POOL_Z1) / 2, POOL_X0 - DECK_X0, pd],
    // 东侧
    [(POOL_X1 + DECK_X1) / 2, (POOL_Z0 + POOL_Z1) / 2, DECK_X1 - POOL_X1, pd]
  ];
  for (const [cx, cz, w, d] of strips) {
    if (w <= 0.01 || d <= 0.01) continue;
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, DECK_THICK, d), stripMat);
    m.position.set(cx, DECK_TOP - DECK_THICK / 2, cz);
    m.receiveShadow = true;
    p.add(m);
  }

  // ── 池内：瓷砖池底 + 四壁 ────────────────────────────────
  const floor = new THREE.Mesh(new THREE.BoxGeometry(pw, 0.08, pd), floorMat);
  floor.position.set((POOL_X0 + POOL_X1) / 2, -POOL_DEPTH, (POOL_Z0 + POOL_Z1) / 2);
  p.add(floor);

  const walls = [
    [(POOL_X0 + POOL_X1) / 2, POOL_Z0, pw, 0.12],
    [(POOL_X0 + POOL_X1) / 2, POOL_Z1, pw, 0.12],
    [POOL_X0, (POOL_Z0 + POOL_Z1) / 2, 0.12, pd],
    [POOL_X1, (POOL_Z0 + POOL_Z1) / 2, 0.12, pd]
  ];
  for (const [cx, cz, w, d] of walls) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, POOL_DEPTH, d), wallMat);
    m.position.set(cx, -POOL_DEPTH / 2 - 0.012, cz);
    p.add(m);
  }

  // 池沿压边（浅色石材）
  const copingMat = new THREE.MeshStandardMaterial({ color: 0xf1ece1, roughness: 0.55 });
  for (const [cx, cz, w, d] of [
    [(POOL_X0 + POOL_X1) / 2, POOL_Z0 - 0.09, pw + 0.36, 0.2],
    [(POOL_X0 + POOL_X1) / 2, POOL_Z1 + 0.09, pw + 0.36, 0.2],
    [POOL_X0 - 0.09, (POOL_Z0 + POOL_Z1) / 2, 0.2, pd + 0.36],
    [POOL_X1 + 0.09, (POOL_Z0 + POOL_Z1) / 2, 0.2, pd + 0.36]
  ]) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.06, d), copingMat);
    m.position.set(cx, DECK_TOP + 0.033, cz);
    p.add(m);
  }

  // ── 水体：一整箱半透明水 + 会起波纹的水面 ────────────────
  // 水体：让池壁瓷砖透出来，看起来是“装满水”而不是盖了一层板
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x2b9dc4, roughness: 0.35, metalness: 0.0,
    transparent: true, opacity: 0.42, depthWrite: false
  });
  const waterBody = new THREE.Mesh(
    new THREE.BoxGeometry(pw - 0.16, POOL_DEPTH - 0.1, pd - 0.16),
    bodyMat
  );
  waterBody.position.set(
    (POOL_X0 + POOL_X1) / 2,
    -0.1 - (POOL_DEPTH - 0.1) / 2,
    (POOL_Z0 + POOL_Z1) / 2
  );
  waterBody.renderOrder = 1;
  p.add(waterBody);

  // 水面：低分段网格 + 正弦位移（约 700 顶点，开销很小）
  const SURF_SEG_X = 28, SURF_SEG_Z = 18;
  // 水面只是薄薄一层反光，本体透明——要能直接看见池底瓷砖
  const surfMat = new THREE.MeshStandardMaterial({
    color: 0xd6f4ff, roughness: 0.12, metalness: 0.0,
    transparent: true, opacity: 0.3, depthWrite: false,
    side: THREE.DoubleSide
  });
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(pw - 0.1, pd - 0.1, SURF_SEG_X, SURF_SEG_Z),
    surfMat
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set((POOL_X0 + POOL_X1) / 2, -0.106, (POOL_Z0 + POOL_Z1) / 2);
  water.renderOrder = 2;
  p.add(water);
  world.poolWater = water;
  world.poolBody = waterBody;

  // 记录基准高度，供每帧波纹复用
  const surfGeo = water.geometry;
  const basePos = surfGeo.attributes.position.array.slice();
  world.poolSurf = {
    geo: surfGeo,
    base: basePos,
    t: 0,
    amp: 0.02,
    update(dt) {
      this.t += dt;
      const arr = this.geo.attributes.position.array;
      const t1 = this.t * 1.6, t2 = this.t * 2.3;
      for (let i = 0; i < arr.length; i += 3) {
        const x = this.base[i], y = this.base[i + 1];
        // 两组不同方向的正弦叠加，形成缓慢起伏
        arr[i + 2] = Math.sin(x * 2.1 + t1) * this.amp
          + Math.sin(y * 3.4 - t2) * this.amp * 0.7
          + Math.sin((x + y) * 1.3 + t1 * 0.7) * this.amp * 0.45;
      }
      this.geo.attributes.position.needsUpdate = true;
    }
  };


  // ── 泳池梯：在北岸（正对房子这侧），管端压进法兰、螺栓咬住法兰 ──
  {
    const LX = 9.0;                            // 北岸偏东（绿框位置）
    const WALL_Z = POOL_Z0 + 0.10;             // 贴北侧池壁内侧
    const DECK_Z = POOL_Z0 - 0.28;             // 露台这一侧
    const RAIL_X = 0.26;
    const R_TOP = 0.94;
    const tubeMat = M.steel;
    const FLANGE_Y = 0.014;                    // 法兰中心高度
    const FLANGE_T = 0.024;                    // 法兰厚度

    for (const dx of [-RAIL_X, RAIL_X]) {
      const x = LX + dx;
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(x, -1.15, WALL_Z),
        new THREE.Vector3(x, -0.4, WALL_Z),
        new THREE.Vector3(x, R_TOP - 0.16, WALL_Z),
        new THREE.Vector3(x, R_TOP, WALL_Z - 0.10),
        new THREE.Vector3(x, R_TOP - 0.02, POOL_Z0 - 0.06),
        new THREE.Vector3(x, R_TOP - 0.22, DECK_Z),
        // 关键：管端一直落到法兰顶面，不留缝
        new THREE.Vector3(x, FLANGE_Y + FLANGE_T / 2, DECK_Z)
      ], false, 'catmullrom', 0.35);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, 44, 0.024, 8, false), tubeMat);
      tube.castShadow = true;
      p.add(tube);

      // 管脚与法兰之间的加强环（把两者视觉上“焊”在一起）
      const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.033, 0.033, 0.05, 10), tubeMat);
      collar.position.set(x, FLANGE_Y + FLANGE_T / 2 + 0.026, DECK_Z);
      p.add(collar);

      // 法兰
      const flange = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.058, FLANGE_T, 14), tubeMat);
      flange.position.set(x, FLANGE_Y, DECK_Z);
      p.add(flange);

      // 螺栓：穿过法兰、露一点头，位置贴着法兰面
      for (const [ox, oz] of [[0.036, 0], [-0.036, 0], [0, 0.036], [0, -0.036]]) {
        const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.0075, 0.0075, FLANGE_T + 0.012, 6), tubeMat);
        bolt.position.set(x + ox, FLANGE_Y + 0.002, DECK_Z + oz);
        p.add(bolt);
      }

      // 池壁支撑座
      const seat = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.1, 0.05), tubeMat);
      seat.position.set(x, -0.5, WALL_Z - 0.035);
      p.add(seat);
    }

    // 水下踏板
    for (let i = 0; i < 3; i++) {
      const y = -0.28 - i * 0.34;
      const tread = new THREE.Mesh(new THREE.BoxGeometry(RAIL_X * 2 + 0.06, 0.028, 0.2), tubeMat);
      tread.position.set(LX, y, WALL_Z - 0.02);
      p.add(tread);
      const grip = new THREE.Mesh(new THREE.BoxGeometry(RAIL_X * 2 + 0.02, 0.014, 0.035), tubeMat);
      grip.position.set(LX, y + 0.012, WALL_Z - 0.10);
      p.add(grip);
    }
  }

  // ── 北侧（靠栏杆）的躺椅、遮阳伞、绿植 ──────────────────
  const makeLounger = (x, z, rotY) => {
    const g = new THREE.Group();
    g.position.set(x, DECK_TOP, z);
    g.rotation.y = rotY;
    p.add(g);
    for (const dz of [-0.26, 0.26]) rbox(g, 1.5, 0.07, 0.06, 0.02, M.oak, 0, 0.32, dz);
    for (let i = 0; i < 10; i++) rbox(g, 0.14, 0.03, 0.52, 0.01, M.oakLight || M.oak, -0.66 + i * 0.145, 0.36, 0);
    for (const [dx, dz] of [[-0.62, -0.22], [0.62, -0.22], [-0.62, 0.22], [0.62, 0.22]]) {
      cyl(g, 0.03, 0.02, 0.3, M.oak, dx, 0.16, dz, 8);
    }
    rbox(g, 1.0, 0.07, 0.5, 0.03, M.fabricCream, 0.12, 0.41, 0);
    rbox(g, 0.16, 0.06, 0.38, 0.03, M.fabricBlue, -0.34, 0.46, 0);
    return g;
  };
  // 右侧休息区：躺椅靠东贴边，各自一把大伞（异形伞面）压在自己头顶
  const POOL_MID_Z = (POOL_Z0 + POOL_Z1) / 2;
  const LOUNGER_X = 12.42;          // 椅背贴到露台东缘（13.2），背后不留空
  const LOUNGER_DZ = 0.72;
  const UMB_X = 12.30;
  const UMB_R = 0.95;

  makeLounger(LOUNGER_X, POOL_MID_Z - LOUNGER_DZ, Math.PI);
  makeLounger(LOUNGER_X, POOL_MID_Z + LOUNGER_DZ, Math.PI);

  // ── 遮阳伞：分片伞面 + 伞骨/撑杆 + 顶饰 + 配重底座 ─────────────
  {
    const px = 12.42;
    const pz = POOL_MID_Z;
    const g = new THREE.Group();
    g.position.set(px, DECK_TOP, pz);
    g.scale.set(0.92, 1, 1.52);   // 伞面向南北拉长，罩住两张躺椅
    p.add(g);

    // 两个点之间的一根圆杆（伞骨/撑杆都用它）
    const rod = (a, b, radius, mat) => {
      const dir = new THREE.Vector3().subVectors(b, a);
      const len = dir.length();
      const m = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 6), mat);
      m.position.copy(a).addScaledVector(dir, 0.5);
      m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
      m.castShadow = true;
      g.add(m);
      return m;
    };

    const EDGE_Y = 1.56;
    const APEX_Y = 2.02;
    const POLE_TOP = 1.62;     // 伞面以下露出的杆高
    const R = 1.0;

    // 底座：配重盘 + 收颈
    cyl(g, 0.19, 0.21, 0.055, M.steel, 0, 0.027, 0, 18);
    cyl(g, 0.085, 0.11, 0.09, M.steel, 0, 0.10, 0, 14);

    // 立杆
    cyl(g, 0.027, 0.032, POLE_TOP - 0.12, M.steel, 0, (POLE_TOP + 0.12) / 2, 0, 12);

    // 伞面：外布 + 内衬（开口锥，双面渲染）
    const canopy = new THREE.Mesh(
      new THREE.ConeGeometry(R, APEX_Y - EDGE_Y, 16, 1, true),
      new THREE.MeshStandardMaterial({
        color: 0xf2ead8, roughness: 0.82, metalness: 0.02, side: THREE.DoubleSide
      })
    );
    canopy.position.set(0, (EDGE_Y + APEX_Y) / 2, 0);
    canopy.castShadow = true;
    g.add(canopy);

    const liner = new THREE.Mesh(
      new THREE.ConeGeometry(R * 0.965, (APEX_Y - EDGE_Y) * 0.92, 16, 1, true),
      new THREE.MeshStandardMaterial({
        color: 0xb9cbe0, roughness: 0.9, metalness: 0.0, side: THREE.BackSide
      })
    );
    liner.position.set(0, (EDGE_Y + APEX_Y) / 2 - 0.015, 0);
    g.add(liner);

    // 伞骨：顶端到每一条分片缝
    const ribTop = new THREE.Vector3(0, APEX_Y - 0.015, 0);
    for (let i = 0; i < 8; i += 1) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      const edge = new THREE.Vector3(Math.cos(a) * R, EDGE_Y + 0.005, Math.sin(a) * R);
      rod(ribTop, edge, 0.0085, M.fabricBlue);
      // 撑杆：杆身中段 → 伞骨中点
      const mid = ribTop.clone().lerp(edge, 0.52);
      rod(new THREE.Vector3(0, 1.30, 0), mid, 0.006, M.steel);
    }

    // 顶饰：顶帽 + 小球
    cyl(g, 0.032, 0.05, 0.045, M.steel, 0, APEX_Y + 0.02, 0, 10);
    const finial = new THREE.Mesh(new THREE.SphereGeometry(0.028, 10, 8), M.steel);
    finial.position.set(0, APEX_Y + 0.075, 0);
    finial.castShadow = true;
    g.add(finial);

    // 伞沿包边 + 一圈垂边（每片一个小三角，形成波浪感）
    const hem = new THREE.Mesh(new THREE.TorusGeometry(R, 0.011, 6, 32), M.fabricBlue);
    hem.rotation.x = Math.PI / 2;
    hem.position.y = EDGE_Y;
    g.add(hem);
    for (let i = 0; i < 16; i += 1) {
      const a = (i / 16) * Math.PI * 2 + Math.PI / 16;
      const drop = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.075, 4, 1, false), M.fabricBlue);
      drop.position.set(Math.cos(a) * (R - 0.03), EDGE_Y - 0.038, Math.sin(a) * (R - 0.03));
      drop.rotation.y = -a;
      drop.rotation.x = Math.PI;
      g.add(drop);
    }
  }

  // 南侧绿植 + 救生圈（台阶已去掉：泳池从扶梯下水）
  // 救生圈 + 木支架：立柱插在露台上，圈挂在立柱正面
  {
    const BX = 12.85, BZ = 9.18;
    // 立柱
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, 1.5, 0.07), M.oak);
    post.position.set(BX, DECK_TOP + 0.75, BZ);
    p.add(post);
    // 底座
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.05, 0.24), M.oak);
    foot.position.set(BX, DECK_TOP + 0.025, BZ);
    p.add(foot);
    // 两个挂钩
    for (const dy of [0.28, -0.28]) {
      const hook = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.1, 8), M.steel);
      hook.rotation.x = Math.PI / 2;
      hook.position.set(BX, DECK_TOP + 1.02 + dy, BZ - 0.06);
      p.add(hook);
    }
    // 圈：贴着立柱挂，朝向露台外侧
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.235, 0.055, 10, 22), M.fabricCream);
    ring.position.set(BX, DECK_TOP + 1.02, BZ - 0.12);
    ring.rotation.y = Math.PI / 2;
    ring.rotation.z = Math.PI / 2;
    p.add(ring);
    // 圈上的橙白条纹块
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.235, 0.058, 8, 8, Math.PI / 3), M.fabricBlue);
    band.position.copy(ring.position);
    band.rotation.copy(ring.rotation);
    p.add(band);
  }

  addHotspot(world, 10.4, 8.3, 0.2, { title: '露台入口', sub: '从阳台出来这里铺了同款地砖', room: 'pool', spot: 'gate', label: '露台入口' });
  addHotspot(world, 3.2, 9.4, 0.2, { title: '泳池边', sub: '瓷砖被晒得温热，脚踩上去有点烫', room: 'pool', spot: 'deck_w', label: '泳池边' });
  addHotspot(world, 12.7, 11.0, 0.2, { title: '休息区', sub: '躺椅、遮阳伞，还有一点柠檬水的味道', room: 'pool', spot: 'deck_e', label: '休息区' });
  addHotspot(world, 5.8, 11.3, 0.2, { title: '泳池', sub: '整池浅蓝瓷砖，水是温的，池底晃着一条一条的光', room: 'pool', spot: 'water', label: '泳池里' });
  addHotspot(world, 12.42, 10.58, 0.6, { title: '沙滩躺椅', sub: '躺椅侧对着泳池，扶手上搭着毛巾', room: 'pool', spot: 'lounger', label: '躺椅上' });
  addHotspot(world, 9.0, 9.85, 0.6, { title: '泳池梯', sub: '不锈钢扶手被太阳晒得温热，踏板伸进水里', room: 'pool', spot: 'ladder', label: '泳池梯旁' });
}



function buildFoyer(world, M) {
  const p = world.root;
  // 鞋柜
  box(p, 0.3, 0.9, 0.8, M.cream, 0.25, 0.45, 5.3);
  box(p, 0.32, 0.04, 0.82, M.oak, 0.25, 0.92, 5.3);
  // Inset fronts and shadow reveals on the entry shoe cabinet.
  box(p, 0.014, 0.76, 0.74, M.darkWood, 0.405, 0.46, 5.3);
  for (const z of [5.115, 5.485]) {
    rbox(p, 0.025, 0.716, 0.35, 0.008, M.cream, 0.42, 0.46, z);
    box(p, 0.035, 0.015, 0.13, M.brass, 0.448, 0.67, z);
  }
  box(p, 0.25, 0.07, 0.73, M.darkWood, 0.25, 0.045, 5.3);
  // 镜子
  const mirror = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.9), M.mirror);
  mirror.rotation.y = Math.PI / 2;
  mirror.position.set(0.098, 1.52, 7.18);
  p.add(mirror);
  box(p, 0.03, 0.96, 0.61, M.walnut, 0.1, 1.52, 7.18);
  // （去掉玄关那块蓝色地垫）
  // 钥匙碗
  cyl(p, 0.07, 0.06, 0.035, M.ceramic, 0.25, 0.94, 5.1);
  // （去掉原先挂在窗前的高位挂钩与外套：浮空横杆会挡住窗）
  addHotspot(world, 0.95, 6.25, 0.5, { title: '门口', sub: '门垫上有一点点沙，钥匙挂在旁边的钩子上', room: 'foyer', spot: 'door', label: '门口' });
  addHotspot(world, 0.85, 5.4, 0.4, { title: '鞋柜', sub: '最上层放着一双白色小皮鞋，鞋尖朝外', room: 'foyer', spot: 'shoe', label: '鞋柜旁' });
}

// ── 植物 ──────────────────────────────────────────────────────────────────
function plant(world, x, z, scale = 1) {
  const p = world.root;
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.scale.setScalar(scale);
  p.add(g);
  const potH = 0.3;
  cyl(g, 0.16, 0.2, potH, M_forPot(world), 0, potH / 2, 0);
  cyl(g, 0.165, 0.165, 0.02, M_soil(world), 0, potH + 0.005, 0);
  const n = 7 + Math.floor(rnd() * 4);
  const up = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rnd() * 0.5;
    const len = 0.34 + rnd() * 0.3;
    const dir = new THREE.Vector3(Math.cos(a) * 0.55, 1.15 + rnd() * 0.25, Math.sin(a) * 0.55).normalize();
    const base = new THREE.Vector3(Math.cos(a) * 0.035, potH, Math.sin(a) * 0.035);
    const tip = base.clone().addScaledVector(dir, len);
    const mid = base.clone().addScaledVector(dir, len / 2);
    const stem = cyl(g, 0.006, 0.009, len, M_stem(world), mid.x, mid.y, mid.z);
    stem.quaternion.setFromUnitVectors(up, dir);
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.085 + rnd() * 0.055, 10, 7), i % 3 ? M_leaf(world) : M_leafLight(world));
    leaf.scale.set(1.35, 0.2, 0.8);
    leaf.position.copy(tip).addScaledVector(dir, 0.03);
    leaf.rotation.y = -a;
    leaf.rotation.z = 0.22 * (rnd() - 0.5);
    leaf.castShadow = true;
    g.add(leaf);
  }
}
function M_forPot(world) { return world.mats.terracotta; }
function M_soil(world) { return world.mats.soil; }
function M_stem(world) { return world.mats.plant; }
function M_leaf(world) { return world.mats.plant; }
function M_leafLight(world) { return world.mats.plantLight; }

// ── 天空、灯光、标签 ──────────────────────────────────────────────────────
function buildSky(world, M, renderer) {
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(260, 32, 20),
    new THREE.MeshBasicMaterial({ map: world.textures.sky, side: THREE.BackSide, depthWrite: false, fog: false })
  );
  sky.rotation.y = Math.PI * 0.6;
  sky.renderOrder = -100;
  world.scene.add(sky);
  world.sky = sky;

  // 用天空做一个便宜的 PMREM 环境贴图：金属/玻璃有东西可反射。
  if (world.quality !== 'low') try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    const envSky = new THREE.Mesh(
      new THREE.SphereGeometry(30, 24, 16),
      new THREE.MeshBasicMaterial({ map: world.textures.sky, side: THREE.BackSide })
    );
    envScene.add(envSky);
    const warm = new THREE.Mesh(new THREE.PlaneGeometry(8, 5), new THREE.MeshBasicMaterial({ color: 0xffe0b0 }));
    warm.position.set(-10, 8, 8);
    warm.lookAt(0, 0, 0);
    envScene.add(warm);
    const rt = pmrem.fromScene(envScene, 0.06);
    world.scene.environment = rt.texture;
    world.envTexture = rt.texture;
    pmrem.dispose();
  } catch { /* 没有环境贴图也能看 */ }
}

// 房子整体底座：和菜园地面差不多厚的薄板，房子不再“浮”在水上
function buildFoundation(world, M) {
  const p = world.root;
  const T = 0.06;                       // 厚度（菜园地台是 0.05）
  const mat = M.earth || M.cream;
  // 主体：x 0~13.2，z 0~9.0（含阳台），顶面与室内地板齐平
  // 顶面比地板/露台低 6mm，避免和它们共面闪烁
  const GAP = 0.006;
  const body = new THREE.Mesh(new THREE.BoxGeometry(13.2, T, 9.0), mat);
  body.position.set(6.6, -T / 2 - GAP, 4.5);
  body.receiveShadow = true;
  p.add(body);
  // 边缘一圈薄压边，视觉上像石砌勒脚
  const lip = new THREE.Mesh(new THREE.BoxGeometry(13.2, 0.02, 9.0), M.ceramic || M.cream);
  lip.position.set(6.6, -T - GAP, 4.5);
  p.add(lip);
}

function buildLights(world, M) {
  const scene = world.scene;
  const hemi = new THREE.HemisphereLight(0xbcd7f0, 0x8a7a66, 0.5);
  scene.add(hemi);
  world.hemi = hemi;

  const sun = new THREE.DirectionalLight(0xfff0d8, 2.0);
  sun.position.set(10, 16, 12);
  sun.target.position.set(6.4, 0, 4.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(world.quality === 'low' ? 1024 : 2048, world.quality === 'low' ? 1024 : 2048);
  sun.shadow.camera.left = -14;
  sun.shadow.camera.right = 14;
  sun.shadow.camera.top = 15;
  sun.shadow.camera.bottom = -15;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 45;
  sun.shadow.bias = -0.00035;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  scene.add(sun.target);
  world.sun = sun;

  // 室内灯：只开一组，全部由「灯开着/关着」控制。
  const specs = [
    ['living', 6.3, 2.46, 2.6, 14],
    ['living2', 6.3, 2.46, 5.2, 8],
    ['kitchen', 2.1, 2.5, 1.4, 12],
    ['dining', 2.1, 2.05, 4.9, 7],
    ['bedroom', 10.9, 2.5, 2.0, 11],
    ['corridor', 10.2, 2.5, 5.0, 6],
    ['bathroom', 12.0, 2.5, 6.9, 7],
    ['laundry', 9.6, 2.5, 6.5, 5],
    ['balcony', 4.2, 2.45, 8.3, 5]
  ];
  for (const [name, x, y, z, intensity] of specs) {
    const light = new THREE.PointLight(0xffd6a6, 0, 7.5, 2);
    light.position.set(x, y, z);
    light.userData.baseIntensity = intensity;
    scene.add(light);
    world.lamps.push(light);
  }
  // 落地灯/床头灯/台灯/吊灯的点光
  for (const [name, x, y, z, intensity] of [
    ['floor', 7.82, 1.56, 4.7, 6],
    ['bedside', 10.1, 0.8, 0.55, 3.2],
    ['desk', 8.62, 1.15, 3.48, 3],
    ['pendant', 2.1, 1.9, 4.9, 5]
  ]) {
    const light = new THREE.PointLight(0xffc98c, 0, 4.5, 2);
    light.position.set(x, y, z);
    light.userData.baseIntensity = intensity;
    scene.add(light);
    world.lamps.push(light);
  }

  // 天花板上的嵌入式筒灯（只做视觉）
  for (const [x, z] of [[6.3, 2.6], [6.3, 5.2], [2.1, 1.4], [2.1, 4.9], [10.9, 2.0], [10.2, 5.0], [12.0, 6.9], [9.6, 6.5]]) {
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.02, 18), M.bulbOff);
    disc.position.set(x, 2.785, z);
    world.root.add(disc);
    world.lampMaterials.push(disc.material);
  }
}

function buildLabels(world, M) {
  const rooms = [
    ['客厅', 6.3, 4.2, 1.3],
    ['厨房', 2.1, 1.6, 1.1],
    ['餐厅', 2.1, 6.0, 1.0],
    ['她的房间', 11.5, 2.95, 1.4],
    ['走廊', 11.2, 5.0, 0.9],
    ['卫生间', 12.0, 7.0, 1.0],
    ['家政间', 9.5, 6.6, 0.9],
    ['阳台', 4.3, 8.3, 1.0],
    ['玄关', 0.9, 6.0, 0.7]
  ];
  for (const [text, x, z, scale] of rooms) {
    const tex = canvasTex(512, 160, (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(248,244,236,.02)';
      ctx.fillRect(0, 0, w, h);
      ctx.font = '600 64px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(44,48,52,.42)';
      ctx.fillText(text, w / 2 + 2, h / 2 + 2);
      ctx.fillStyle = 'rgba(250,248,242,.9)';
      ctx.fillText(text, w / 2, h / 2);
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1.3 * scale, 0.4 * scale), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = 0;
    m.position.set(x, 0.022, z);
    world.labels.add(m);
  }
}

// ── 雨 ────────────────────────────────────────────────────────────────────
function buildRain(world) {
  const COUNT = 900;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(COUNT * 6);   // 每滴雨两个端点
  // 只落在室外：阳台外侧（z>7.6）与屋外/菜园那一侧（z<0），室内不下雨
  for (let i = 0; i < COUNT; i++) {
    const x = -1.2 + rnd() * 15;
    const y = rnd() * 7;
    const z = i % 2 === 0 ? (7.62 + rnd() * 6) : (-8 + rnd() * 7.6);
    pos[i * 6] = x; pos[i * 6 + 1] = y; pos[i * 6 + 2] = z;
    pos[i * 6 + 3] = x - 0.03; pos[i * 6 + 4] = y - 0.22; pos[i * 6 + 5] = z;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.LineBasicMaterial({ color: 0xc8dbeb, transparent: true, opacity: 0.45, depthWrite: false, fog: false });
  const rain = new THREE.LineSegments(geo, mat);
  rain.visible = false;
  rain.frustumCulled = false;
  world.scene.add(rain);
  world.rain = rain;
  world.updateRain = (dt) => {
    if (!rain.visible) return;
    const arr = geo.attributes.position.array;
    const fall = (world.rainSpeed || 11) * Math.min(dt, 0.05);
    const slant = world.rainSlant || 0;
    for (let i = 0; i < COUNT; i++) {
      arr[i * 6 + 1] -= fall;
      arr[i * 6 + 4] -= fall;
      if (slant) {
        arr[i * 6] -= slant * fall;
        arr[i * 6 + 3] -= slant * fall;
      }
      if (arr[i * 6 + 4] < 0) {
        const top = 6.5 + rnd() * 0.5;
        const x = -1.2 + rnd() * 15;
        arr[i * 6] = x;
        arr[i * 6 + 3] = x - 0.03;
        arr[i * 6 + 1] = top;
        arr[i * 6 + 4] = top - 0.22;
      }
    }
    geo.attributes.position.needsUpdate = true;
  };
}

// 雪：慢速飘落的白色点；风：横着扫的沙粒
function buildSnow(world) {
  const COUNT = 700;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(COUNT * 3);
  const seed = new Float32Array(COUNT);
  for (let i = 0; i < COUNT; i++) {
    const x = -1.2 + rnd() * 15;
    const y = rnd() * 7;
    const z = i % 2 === 0 ? (7.62 + rnd() * 6) : (-8 + rnd() * 7.6);
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    seed[i] = rnd() * TAU;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: 0xffffff, size: 0.055, transparent: true, opacity: 0.85, depthWrite: false, fog: false, sizeAttenuation: true });
  const snow = new THREE.Points(geo, mat);
  snow.visible = false;
  snow.frustumCulled = false;
  world.scene.add(snow);
  world.snow = snow;
  world._snowT = 0;
  world.updateSnow = (dt) => {
    if (!snow.visible) return;
    world._snowT += dt;
    const arr = geo.attributes.position.array;
    const fall = 0.85 * Math.min(dt, 0.05) * (world.snowSpeedMul || 1) * (0.7 + (world.weatherIntensity ?? 0.6) * 0.6);
    for (let i = 0; i < COUNT; i++) {
      arr[i * 3 + 1] -= fall * (0.7 + (seed[i] % 1));
      arr[i * 3] += Math.sin(world._snowT * 1.3 + seed[i]) * dt * 0.18;
      if (arr[i * 3 + 1] < 0) {
        const top = 6.5 + rnd() * 0.5;
        arr[i * 3 + 1] = top;
        arr[i * 3] = -1.2 + rnd() * 15;
      }
    }
    geo.attributes.position.needsUpdate = true;
  };
}

function buildSand(world) {
  const COUNT = 600;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(COUNT * 3);
  for (let i = 0; i < COUNT; i++) {
    pos[i * 3] = -1.2 + rnd() * 16;
    pos[i * 3 + 1] = 0.2 + rnd() * 4.2;
    pos[i * 3 + 2] = i % 2 === 0 ? (7.62 + rnd() * 6) : (-8 + rnd() * 7.6);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: 0xd8b47a, size: 0.045, transparent: true, opacity: 0.55, depthWrite: false, fog: false });
  const sand = new THREE.Points(geo, mat);
  sand.visible = false;
  sand.frustumCulled = false;
  world.scene.add(sand);
  world.sand = sand;
  world.updateSand = (dt) => {
    if (!sand.visible) return;
    const arr = geo.attributes.position.array;
    const drift = 7.5 * Math.min(dt, 0.05);
    for (let i = 0; i < COUNT; i++) {
      arr[i * 3] += drift;
      if (arr[i * 3] > 15.5) arr[i * 3] = -1.2;
    }
    geo.attributes.position.needsUpdate = true;
  };
}

// ── 时间/灯/屏幕 ──────────────────────────────────────────────────────────
function updateEnvironment(world, { hour = null, lamp = true, asleep = false, kind = 'idle', realTime = true, weather = 'clear', rain: rainFlag = null, intensity = null } = {}) {
  const inten = Math.max(0, Math.min(1, intensity == null ? (world.weatherIntensity ?? 0.6) : intensity));
  world.weatherIntensity = inten;
  let srcHour = hour;
  if (srcHour === null || srcHour === undefined || realTime) {
    const d = new Date();
    srcHour = d.getHours() + d.getMinutes() / 60;
  }
  const h = ((Number(srcHour) % 24) + 24) % 24;
  world.__lastEnvHour = h;
  world.__lastEnvRealTime = !!realTime;
  world.__lastEnvWeather = String(weather || 'clear');
  const night = h < 6.5 || h >= 20.5;
  const dusk = h >= 16.8 && h < 20.5;
  const dawn = h >= 5.2 && h < 8;
  const day = !night && !dusk && !dawn;

  const wx = rainFlag === true ? 'rain' : (rainFlag === false ? 'clear' : String(weather || 'clear'));
  const rainy = ['rain', 'storm', 'sleet', 'hail', 'typhoon'].includes(wx);
  const snowy = ['snow', 'sleet', 'blizzard', 'hail'].includes(wx);
  const sandy = wx === 'sand';
  const gloomy = rainy || wx === 'overcast' || wx === 'fog' || wx === 'storm';
  // ── 太阳 / 月亮：按小时走真实弧线，并按天气衰减 ─────────────────
  // 6 点东升、12 点最高、18 点西落；夜里换月亮（反向、冷色、较弱）
  const isDaytime = h >= 6.2 && h < 18.2;
  const dayT = (h - 6.2) / 12;                       // 0..1 日出→日落
  const arc = Math.max(0, Math.sin(Math.max(0, Math.min(1, dayT)) * Math.PI));
  const azim = Math.max(0, Math.min(1, dayT)) * Math.PI; // 0 东 → π 西
  const radius = 22;
  const sunX = 6.4 + Math.cos(azim) * radius;        // 东(+x) → 西(-x)
  const sunY = 3 + arc * 20;                          // 最高约 23
  const sunZ = 4.4 + 6 - arc * 4;                     // 稍微偏南，正午更靠中
  // 天气对阳光的遮挡
  const weatherDim = ({
    storm: 0.22, rain: 0.38, overcast: 0.5, fog: 0.55, sand: 0.62, snow: 0.7,
    sleet: 0.45, hail: 0.3, haze: 0.5, blizzard: 0.32, meteor: 1, typhoon: 0.2
  })[wx] ?? 1;
  const sunI = isDaytime ? (0.5 + arc * 1.9) * weatherDim : 0;
  const moonI = isDaytime ? 0 : 0.35 * weatherDim;
  // 低角度偏暖
  const warmT = isDaytime ? Math.max(0, 1 - arc * 1.6) : 0;
  const sunColor = isDaytime
    ? new THREE.Color().setHSL(0.10 + warmT * 0.02, 0.35 + warmT * 0.45, 0.72 + warmT * 0.04)
    : new THREE.Color(0x9fb8e8);
  const hemiI = isDaytime ? (0.28 + arc * 0.42) * weatherDim : 0.18;

  if (!world.sunTargetColor) world.sunTargetColor = new THREE.Color();
  world.sunTargetColor.copy(sunColor);
  world.sunTargetIntensity = isDaytime ? sunI : moonI;
  world.sunTargetPos = new THREE.Vector3(
    isDaytime ? sunX : 6.4 - sunX * 0.6,
    isDaytime ? sunY : 14,
    isDaytime ? sunZ : 8
  );
  world.hemiTargetIntensity = hemiI;

  // 每种天气都固定住自己的配色（clear 才跟着小时走）
  const skyKey = `${wx === 'clear' ? Math.floor(h * 20) : 'fix'}|${wx}`;
  let shadowDirty = false;
  if (skyKey !== world.lastSkyKey) {
    world.lastSkyKey = skyKey;
    world.textures.sky.dispose();
    world.textures.sky = skyTexture(h, wx);
    world.sky.material.map = world.textures.sky;
    world.sky.material.needsUpdate = true;
    shadowDirty = true;
  }
  if (world.rain) world.rain.visible = rainy;
  if (world.snow) {
    world.snow.visible = snowy;
    if (world.snow.material) {
      world.snow.material.size = wx === 'hail' ? 0.14 : wx === 'blizzard' ? 0.085 : 0.055;
    }
    world.snowSpeedMul = wx === 'hail' ? 2.4 : wx === 'blizzard' ? 1.8 : 1;
  }
  if (world.sand) world.sand.visible = sandy || wx === 'blizzard' || wx === 'typhoon';

  // 降水强度：影响不透明度、下落速度、颗粒大小
  if (world.rain?.material) world.rain.material.opacity = 0.22 + inten * 0.5;
  world.rainSpeed = (wx === 'typhoon' ? 14 : 7) + inten * 7;
  world.rainSlant = wx === 'typhoon' ? 0.55 : 0;
  if (world.sand?.material) world.sand.material.opacity = 0.3 + inten * 0.45;

  // 地面湿滑（雨天）与积雪（雪天），随强度缩放
  const wetKind = ['rain', 'storm', 'sleet', 'hail', 'typhoon'].includes(wx);
  const snowKind = ['snow', 'blizzard', 'sleet'].includes(wx);
  const wet = wetKind ? 0.35 + inten * 0.65 : 0;
  const snowCover = snowKind ? (wx === 'blizzard' ? 1 : 0.45 + inten * 0.5) : 0;
  if (world.setGroundWeather) world.setGroundWeather(wet, snowCover);
  // 雾的浓度按天气分档
  const fogRange = {
    fog: [10, 42], sand: [16, 58], storm: [22, 64], snow: [22, 66],
    rain: [28, 80], overcast: [30, 86], clear: [38, 100],
    sleet: [24, 70], hail: [20, 60], haze: [8, 34], blizzard: [12, 44], meteor: [30, 90], typhoon: [10, 42]
  }[wx] || [38, 100];
  world.fogTargetNear = fogRange[0];
  world.fogTargetFar = fogRange[1];

  // 太阳/半球光由上面的「太阳弧线」统一给目标值（updateSun 平滑插值），
  // 这里只补雾色和阴影开关，不再直接写 sun.position/intensity，
  // 否则会和插值打架，表现为画面一亮一暗地闪。
  if (rainy) {
    world.scene.fog.color.set(0x7c8a95);
  } else if (night) {
    world.scene.fog.color.set(0x0c1828);
    world.scene.background = null;
  } else if (dawn) {
    world.scene.fog.color.set(0xcbb7b0);
  } else if (dusk) {
    world.scene.fog.color.set(0xc9a99a);
  } else {
    world.scene.fog.color.set(0xa8c0d2);
  }
  const fogByWeather = {
    overcast: 0x9aa6b1, fog: 0xd3dae0, snow: 0xc3d0da, sand: 0xc9a469,
    rainbow: 0x9fb6c6, storm: 0x39434d, starry: 0x081324, aurora: 0x0a1a2c,
    sleet: 0x8a97a3, hail: 0x4a5563, haze: 0xc9bda9, blizzard: 0xd7e2ea, meteor: 0x0a1526, typhoon: 0x2c3a44
  };
  if (fogByWeather[wx] !== undefined) world.scene.fog.color.set(fogByWeather[wx]);
  if (!world.fogTargetColor) world.fogTargetColor = world.scene.fog.color.clone();
  world.fogTargetColor.copy(world.scene.fog.color);

  const sunNowI = typeof world.sunTargetIntensity === 'number' ? world.sunTargetIntensity : world.sun.intensity;
  world.sun.castShadow = !night && world.quality !== 'low' && !gloomy && sunNowI > 0.5;

  // 室内灯：白天只留一点，夜里按开关；睡着时全暗。
  const indoor = asleep ? 0 : lamp ? (night ? 1 : day ? 0.1 : 0.45) : 0;
  for (const light of world.lamps) {
    light.intensity = (light.userData.baseIntensity || 0) * indoor;
  }
  for (const m of world.lampMaterials) {
    if (m.color) m.color.set(indoor > 0.15 ? 0xffd9a0 : 0x8f8b84);
  }
  // 电视/显示器：她真的在看时才亮（表现层只读 kind）。
  if (world.tvScreen) {
    const on = kind === 'tv' || kind === 'game' || kind === 'phone';
    world.tvScreen.material.emissiveIntensity = on ? 0.75 : 0.12;
  }
  if (world.deskScreen) {
    const on = kind === 'desk' || kind === 'help';
    world.deskScreen.material.emissiveIntensity = on ? 0.65 : 0.1;
  }
  return { shadowDirty };
}

function setMemoryNotes(world, lines) {
  if (!world.memoryMesh) return;
  const old = world.memoryMesh.material.map;
  const tex = memoryBoardTexture(Array.isArray(lines) ? lines : []);
  world.memoryMesh.material.map = tex;
  world.memoryMesh.material.needsUpdate = true;
  try { old?.dispose(); } catch { /* 忽略 */ }
}

function setScreenState(world, kind, on) {
  if (kind === 'tv' && world.tvScreen) world.tvScreen.material.emissiveIntensity = on ? 0.75 : 0.12;
  if (kind === 'desk' && world.deskScreen) world.deskScreen.material.emissiveIntensity = on ? 0.65 : 0.1;
}

function setClock(world, hour, minute) {
  if (world.clockHands.length < 2) return;
  const [h, m] = world.clockHands;
  h.rotation.z = -((hour % 12) + minute / 60) / 12 * TAU;
  m.rotation.z = -(minute / 60) * TAU;
}

// 让页面能根据 layout 画一个「相机预设」用的中心
export function roomCenter(id) {
  const map = {
    living: [6.3, 4.0], kitchen: [2.1, 1.8], dining: [2.1, 5.4], her_room: [10.8, 2.2],
    corridor: [10.8, 5.0], bathroom: [12.0, 6.9], laundry: [9.6, 6.6], balcony: [4.2, 8.3], foyer: [1.0, 6.2]
  };
  return map[id] || [6.3, 4.0];
}
