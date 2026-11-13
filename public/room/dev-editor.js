// 开发用模型编辑器：?edit=1 打开
// 右键选中（整组/单个）→ 方向键或 WASD 在地面平面移动，Q/E 旋转，Shift+W/S 升降
// 地板会显示网格，方便对齐。改动存 localStorage，可一键复制补丁。
import * as THREE from './vendor/three.module.js';

const STORE_KEY = 'home-edit-patches';
const SNAP = 0.05;          // 移动吸附（米）
const SPEED = 1.9;          // 按住方向键的速度（米/秒）
const SPEED_Y = 0.9;        // 升降速度
const ROT_STEP = Math.PI / 12;   // 15°

function loadPatches() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}
function savePatches(p) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch { /* 忽略 */ }
}

function labelOf(obj) {
  const g = obj.geometry;
  const type = g?.type ? g.type.replace('Geometry', '') : (obj.isGroup ? 'Group' : 'Object');
  return obj.isGroup ? `${type}×${obj.children.length}` : type;
}

// 并查集：把「贴在一起」的零件聚成一件家具
function makeUnion(n) {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  return { find, union };
}

function boxGap(a, b) {
  const dx = Math.max(0, Math.max(a.min.x - b.max.x, b.min.x - a.max.x));
  const dy = Math.max(0, Math.max(a.min.y - b.max.y, b.min.y - a.max.y));
  const dz = Math.max(0, Math.max(a.min.z - b.max.z, b.min.z - a.max.z));
  return Math.hypot(dx, dy, dz);
}

export function createDevEditor({ world, camera, canvas, view }) {
  const patches = loadPatches();
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const ignore = new Set([world.sky, world.poolWater, world.poolBody, world.tvScreen].filter(Boolean));

  let enabled = false;
  let selected = null;      // { pivot, members, label, base: {x,y,z,ry}, idx }
  let helper = null;
  let grid = null;
  const keys = new Set();
  let rafId = 0;
  let lastT = 0;
  const trace = [];
  let frames = 0;

  // ── 聚类：整组选择 ────────────────────────────────────────
  const clusters = new Map();       // mesh -> cluster 数组
  const flatIgnore = new Set();     // 地板/墙/天花板这类大平面：不参与聚类，也不给点选
  function buildClusters() {
    const items = [];
    let nextEid = 0;
    world.root.updateMatrixWorld(true);
    world.root.traverse((o) => {
      if (!o.isMesh || o.isInstancedMesh) return;
      if (ignore.has(o) || o.userData?.ignorePick) return;
      const mat = o.material;
      if (mat?.transparent && (mat.opacity ?? 1) < 0.5) return;
      if (!Number.isFinite(o.userData.eid)) o.userData.eid = nextEid++;
      const box = new THREE.Box3().setFromObject(o);
      if (!isFinite(box.min.x)) return;
      const sx = box.max.x - box.min.x;
      const sz = box.max.z - box.min.z;
      const sy = box.max.y - box.min.y;
      // 大平面（地板/墙/地毯/天花板）单独处理，避免把整间房并成一坨
      if (sx * sz > 2.2 || sy < 0.006) { flatIgnore.add(o); return; }
      items.push({ o, box });
    });

    const uf = makeUnion(items.length);
    for (let i = 0; i < items.length; i += 1) {
      const a = items[i].box;
      for (let j = i + 1; j < items.length; j += 1) {
        if (boxGap(a, items[j].box) <= 0.035) uf.union(i, j);
      }
    }
    const groups = new Map();
    items.forEach((it, i) => {
      const r = uf.find(i);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(it.o);
    });
    for (const members of groups.values()) {
      const arr = members.filter((m) => !ignore.has(m));
      if (arr.length < 3) continue;
      for (const m of arr) clusters.set(m, arr);
    }
  }

  function pick(ev) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(world.root, true);
    for (const h of hits) {
      const o = h.object;
      if (ignore.has(o) || flatIgnore.has(o) || o.userData?.ignorePick) continue;
      if (o.material?.transparent && (o.material.opacity ?? 1) < 0.5) continue;
      return o;
    }
    return null;
  }

  // 最近的房间热点名，用来给整组起个中文名
  function unitKey(members) {
    const eids = members.map((m) => m.userData.eid).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    if (!eids.length) return 'x';
    const sum = eids.reduce((a, b) => a + b, 0) % 1000003;
    return `${eids[0]}:${members.length}:${sum}`;
  }

  function nearestHotspotName(pos) {
    let best = null;
    let bestD = 1.4;
    for (const h of world.hotspots || []) {
      const d = h.position.distanceTo(pos);
      if (d < bestD) { bestD = d; best = h.userData?.hotspot?.title || null; }
    }
    return best;
  }

  function makePivot(members) {
    const box = new THREE.Box3();
    for (const m of members) box.expandByObject(m);
    const center = box.getCenter(new THREE.Vector3());
    const pivot = new THREE.Group();
    pivot.position.copy(center);
    world.root.add(pivot);
    for (const m of members) pivot.attach(m);   // attach 保留世界变换
    return pivot;
  }

  function releasePivot(pivot, members) {
    for (const m of members) world.root.attach(m);
    world.root.remove(pivot);
  }

  // 重载后把保存的改动套回去：按「成员 eid 签名」精确匹配，避免张冠李戴
  function applySavedPatches() {
    const entries = Object.values(patches).filter((p) => p && typeof p.key === 'string');
    if (!entries.length) return;
    const map = new Map();
    const seen = new Set();
    for (const arr of clusters.values()) {
      if (seen.has(arr)) continue;
      seen.add(arr);
      map.set(unitKey(arr), arr);
    }
    for (const pt of entries) {
      const members = map.get(pt.key);
      if (!members) continue;
      const pivot = makePivot(members);
      pivot.position.set(pt.x, pt.y, pt.z);
      pivot.rotation.y = pt.ry || 0;
      releasePivot(pivot, members);
    }
  }

  function beginSelection(mesh) {
    if (selected) endSelection();
    const members = clusters.get(mesh) || [mesh];
    const pivot = makePivot(members);
    const center = pivot.position;

    const base = { x: pivot.position.x, y: pivot.position.y, z: pivot.position.z, ry: 0 };
    const name = members.length > 3 ? (nearestHotspotName(center) || `组合×${members.length}`) : labelOf(mesh);
    selected = { pivot, members, label: name, base, idx: -1 };
    helper = new THREE.BoxHelper(pivot, 0xffcc55);
    helper.material.depthTest = false;
    helper.renderOrder = 999;
    world.scene.add(helper);
    setInfo();
  }

  function endSelection() {
    if (!selected) return;
    for (const m of selected.members) world.root.attach(m);
    world.root.remove(selected.pivot);
    if (helper) { helper.geometry.dispose?.(); helper.material?.dispose?.(); world.scene.remove(helper); helper = null; }
    selected = null;
    setInfo();
  }

  function record() {
    if (!selected) return;
    const p = selected.pivot;
    const ref = selected.base;
    const key = unitKey(selected.members);
    selected.key = key;
    patches[key] = {
      label: selected.label,
      x: +p.position.x.toFixed(3),
      y: +p.position.y.toFixed(3),
      z: +p.position.z.toFixed(3),
      ry: +p.rotation.y.toFixed(4),
      ref: [+ref.x.toFixed(3), +ref.y.toFixed(3), +ref.z.toFixed(3)],
      n: selected.members.length,
      key
    };
    savePatches(patches);
  }

  // ── 键盘移动（相机相对的地面方向） ───────────────────────
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const MOVE_KEYS = new Set([
    'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'
  ]);

  function tick(t) {
    rafId = requestAnimationFrame(tick);
    if (!enabled) { lastT = t; return; }
    if (!selected) { panCamera(t); lastT = t; return; }
    const dt = Math.min(0.05, (t - (lastT || t)) / 1000);
    lastT = t;
    frames += 1;
    if (!dt) return;

    const p = selected.pivot;
    // 屏幕方向 → 地面方向：相机矩阵的 +Y（屏幕向上）与 +X（屏幕向右）投影到 XZ
    camera.updateMatrixWorld();
    fwd.setFromMatrixColumn(camera.matrixWorld, 1);   // 屏幕上方
    fwd.y = 0;
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
    fwd.normalize();
    right.setFromMatrixColumn(camera.matrixWorld, 0);  // 屏幕右方
    right.y = 0;
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();

    let dx = 0, dz = 0, dy = 0;
    const up = keys.has('KeyW') || keys.has('ArrowUp');
    const down = keys.has('KeyS') || keys.has('ArrowDown');
    const left = keys.has('KeyA') || keys.has('ArrowLeft');
    const rgt = keys.has('KeyD') || keys.has('ArrowRight');
    const height = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const wantY = height;

    if (wantY) {
      if (up) dy += SPEED_Y * dt;
      if (down) dy -= SPEED_Y * dt;
    } else {
      if (up) { dx += fwd.x * SPEED * dt; dz += fwd.z * SPEED * dt; }
      if (down) { dx -= fwd.x * SPEED * dt; dz -= fwd.z * SPEED * dt; }
      if (left) { dx -= right.x * SPEED * dt; dz -= right.z * SPEED * dt; }
      if (rgt) { dx += right.x * SPEED * dt; dz += right.z * SPEED * dt; }
    }
    if (dx || dy || dz) {
      p.position.x = Math.round((p.position.x + dx) / SNAP) * SNAP;
      p.position.y = Math.round((p.position.y + dy) / SNAP) * SNAP;
      p.position.z = Math.round((p.position.z + dz) / SNAP) * SNAP;
      if (trace.length < 8) trace.push({ dt: +dt.toFixed(3), dx: +dx.toFixed(3), dy: +dy.toFixed(3), dz: +dz.toFixed(3), keys: [...keys], frames });
      helper?.update();
      setInfo();
    }
  }

  // 未选中模型时：WASD/方向键平移镜头（贴着地面走）
  function panCamera(t) {
    const dt = Math.min(0.05, (t - (lastT || t)) / 1000);
    if (!dt || !view) return;
    const up = keys.has('KeyW') || keys.has('ArrowUp');
    const down = keys.has('KeyS') || keys.has('ArrowDown');
    const left = keys.has('KeyA') || keys.has('ArrowLeft');
    const rgt = keys.has('KeyD') || keys.has('ArrowRight');
    if (!up && !down && !left && !rgt) return;
    const az = view.az || 0;
    // 屏幕方向的水平投影
    const fx = -Math.sin(az), fz = -Math.cos(az);
    const rx = Math.cos(az), rz = -Math.sin(az);
    const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 8 : 3.6) * dt;
    const tgt = view.target;
    if (up) { tgt.x += fx * speed; tgt.z += fz * speed; }
    if (down) { tgt.x -= fx * speed; tgt.z -= fz * speed; }
    if (left) { tgt.x -= rx * speed; tgt.z -= rz * speed; }
    if (rgt) { tgt.x += rx * speed; tgt.z += rz * speed; }
    tgt.x = Math.max(-4, Math.min(17, tgt.x));
    tgt.z = Math.max(-8, Math.min(15, tgt.z));
    setInfo();
  }

  function resetView() {
    if (!view) return;
    view.mode = 'overview';
    view.follow = false;
    view.target.set(6.6, 0.3, 4.8);
    view.az = 0;
    view.elev = 1.45;      // 接近正俯视
    view.radius = 20;
    setInfo();
  }

  // ── 网格地板 ─────────────────────────────────────────────
  function buildGrid() {
    const g = new THREE.GridHelper(30, 120, 0xffcc55, 0x6f8ea8);
    g.position.set(6.6, 0.012, 4.8);
    g.material.transparent = true;
    g.material.opacity = 0.55;
    g.material.depthTest = false;
    g.renderOrder = 998;
    world.scene.add(g);
    return g;
  }

  // ── UI ──────────────────────────────────────────────────
  const ui = document.createElement('div');
  ui.id = 'devEditor';
  ui.style.cssText = [
    'position:fixed', 'right:14px', 'bottom:74px', 'z-index:60', 'width:280px',
    'background:rgba(18,22,28,.92)', 'border:1px solid rgba(255,204,85,.45)',
    'border-radius:12px', 'padding:10px 12px', 'color:#e8eef5',
    'font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace',
    'box-shadow:0 10px 28px rgba(0,0,0,.45)', 'display:none'
  ].join(';');
  ui.innerHTML = `
    <div style="font-weight:700;color:#ffcc55;margin-bottom:6px">模型编辑模式</div>
    <div id="deInfo" style="min-height:66px;white-space:pre-wrap"></div>
    <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
      <button id="deView" style="flex:1;padding:4px 6px">重置视角</button>
      <button id="deCopy" style="flex:1;padding:4px 6px">复制补丁</button>
      <button id="deReset" style="flex:1;padding:4px 6px">复位</button>
      <button id="deClear" style="flex:1;padding:4px 6px">清空全部</button>
    </div>
    <div style="margin-top:6px;color:#93a4b6">右键点选｜WASD/方向键移动（未选中时平移镜头）｜Q/E 旋转｜Shift+W/S 升降｜Esc 取消</div>
  `;
  document.body.appendChild(ui);
  const info = ui.querySelector('#deInfo');
  function setInfo() {
    if (!selected) {
      const tg = view?.target;
      const camLine = tg ? `\n镜头中心 ${tg.x.toFixed(1)}, ${tg.z.toFixed(1)}` : '';
      info.textContent = '右键点选模型（相邻零件会整组选中）' + camLine;
      return;
    }
    const p = selected.pivot.position;
    const ry = Math.round(THREE.MathUtils.radToDeg(selected.pivot.rotation.y));
    info.textContent = `${selected.label}  (${selected.members.length} 件)\npos  ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}\nrotY ${ry}°`;
  }

  // ── 事件 ────────────────────────────────────────────────
  const onDown = (ev) => {
    if (!enabled) return;
    if (ev.button === 2) {
      ev.preventDefault();
      ev.stopPropagation();
      const hit = pick(ev);
      if (hit) beginSelection(hit);
      else endSelection();
      return;
    }
    // 左键不选中：只用于拖镜头；如果已选中，左键也不触发"点地走过去"
    if (ev.button === 0 && selected) {
      ev.stopPropagation();
    }
  };

  const onKeyDown = (ev) => {
    if (!enabled) return;
    const tag = String(ev.target?.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || ev.target?.isContentEditable) return;
    if (ev.code === 'Escape') { endSelection(); return; }
    if (ev.code === 'ShiftLeft' || ev.code === 'ShiftRight') { keys.add(ev.code); return; }
    if (!selected) {
      if (MOVE_KEYS.has(ev.code)) { ev.preventDefault(); keys.add(ev.code); }
      return;
    }
    const isRotate = ev.code === 'KeyQ' || ev.code === 'KeyE';
    const isMove = MOVE_KEYS.has(ev.code) || isRotate;
    if (!isMove) return;
    ev.preventDefault();
    ev.stopPropagation();
    keys.add(ev.code);
    if (isRotate && !ev.repeat) {
      const step = ev.shiftKey ? Math.PI / 36 : ROT_STEP;
      selected.pivot.rotation.y += ev.code === 'KeyQ' ? step : -step;
      helper?.update();
      setInfo();
      record();
    }
  };

  const onKeyUp = (ev) => {
    keys.delete(ev.code);
    if (!ev.shiftKey) { keys.delete('ShiftLeft'); keys.delete('ShiftRight'); }
    if (enabled && selected && (MOVE_KEYS.has(ev.code) || ev.code === 'KeyQ' || ev.code === 'KeyE')) {
      // 松开方向键时存一次
      record();
    }
  };

  const onContext = (ev) => {
    if (!enabled) return;
    ev.preventDefault();
  };

  canvas.addEventListener('pointerdown', onDown, true);
  canvas.addEventListener('contextmenu', onContext);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', () => keys.clear());

  ui.querySelector('#deView')?.addEventListener('click', () => resetView());

  // 兼容 http 页面：navigator.clipboard 在非 https/localhost 下不可用
  function legacyCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    return ok;
  }

  function showDump(text) {
    let box = document.getElementById('deDump');
    if (!box) {
      box = document.createElement('div');
      box.id = 'deDump';
      box.style.cssText = [
        'position:fixed', 'left:50%', 'top:50%', 'transform:translate(-50%,-50%)',
        'z-index:80', 'width:min(560px,86vw)', 'background:rgba(18,22,28,.97)',
        'border:1px solid rgba(255,204,85,.5)', 'border-radius:12px', 'padding:12px',
        'box-shadow:0 16px 40px rgba(0,0,0,.55)', 'display:none'
      ].join(';');
      box.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <b style="color:#ffcc55;font:13px ui-monospace,monospace">补丁 JSON（全选复制）</b>
          <button id="deDumpClose" style="padding:2px 8px">关闭</button>
        </div>
        <textarea id="deDumpText" spellcheck="false" style="width:100%;height:300px;box-sizing:border-box;
          background:#0e1218;color:#d7e3ef;border:1px solid #2b3644;border-radius:8px;padding:8px;
          font:11px/1.5 ui-monospace,monospace"></textarea>`;
      document.body.appendChild(box);
      box.querySelector('#deDumpClose').addEventListener('click', () => { box.style.display = 'none'; });
    }
    box.querySelector('#deDumpText').value = text;
    box.style.display = 'block';
    const ta = box.querySelector('#deDumpText');
    ta.focus();
    ta.select();
  }

  ui.querySelector('#deCopy')?.addEventListener('click', async () => {
    const text = JSON.stringify(patches, null, 2);
    const n = Object.keys(patches).length;
    info.textContent = `准备复制 ${n} 条补丁…`;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        info.textContent = `已复制 ${n} 条补丁到剪贴板`;
        return;
      }
    } catch { /* 走备用方案 */ }
    if (legacyCopy(text)) {
      info.textContent = `已复制 ${n} 条补丁（备用方案）`;
      return;
    }
    console.log('[dev-editor] patches', text);
    showDump(text);
    info.textContent = '浏览器禁止写剪贴板，已弹出文本框，Ctrl+A / Ctrl+C 复制';
  });
  ui.querySelector('#deReset')?.addEventListener('click', () => {
    if (!selected) return;
    const p = selected.pivot;
    p.position.set(selected.base.x, selected.base.y, selected.base.z);
    p.rotation.y = selected.base.ry;
    delete patches[selected.key || unitKey(selected.members)];
    savePatches(patches);
    helper?.update();
    setInfo();
  });
  ui.querySelector('#deClear')?.addEventListener('click', () => {
    Object.keys(patches).forEach((k) => delete patches[k]);
    savePatches(patches);
    info.textContent = '已清空全部改动（刷新后恢复原状）';
  });

  // ── 启停 ────────────────────────────────────────────────
  function pruneLegacyPatches() {
    let dropped = 0;
    for (const [k, v] of Object.entries(patches)) {
      if (!v || typeof v.key !== 'string') { delete patches[k]; dropped += 1; }
    }
    if (dropped) {
      savePatches(patches);
      console.info(`[dev-editor] 清理 ${dropped} 条旧格式补丁（旧版本按名字/索引存，会互相冲突）`);
    }
  }

  function setEnabled(next) {
    enabled = next;
    ui.style.display = next ? 'block' : 'none';
    if (next) {
      if (!grid) grid = buildGrid();
      grid.visible = true;
      if (!clusters.size) { pruneLegacyPatches(); buildClusters(); applySavedPatches(); }
      setInfo();
      rafId = requestAnimationFrame(tick);
    } else {
      if (grid) grid.visible = false;
      cancelAnimationFrame(rafId);
      endSelection();
      keys.clear();
    }
  }

  window.addEventListener('keydown', (ev) => {
    if (ev.code === 'KeyE' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      setEnabled(!enabled);
    }
  });

  const api = {
    setEnabled,
    get enabled() { return enabled; },
    busy: () => false,
    selectObject: (o) => { if (enabled && o) beginSelection(o); },
    trace: () => ({ frames, trace: trace.slice() }),
    debug: () => ({ keys: [...keys], fwd: fwd.toArray().map((v) => +v.toFixed(2)), right: right.toArray().map((v) => +v.toFixed(2)), az: view?.az, elev: view?.elev }),
    pivotPos: () => selected ? [selected.pivot.position.x, selected.pivot.position.y, selected.pivot.position.z] : null,
    label: () => selected ? selected.label : null,
    blockClick: () => enabled && !!selected,
    dragging: () => false,
    patches,
    clusters
  };
  window.__devEditor = api;
  return api;
}
