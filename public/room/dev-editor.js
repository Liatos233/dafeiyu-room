// 开发用模型编辑器：?edit=1 打开
// 鼠标点选（可选中 Group 或单个网格）→ 拖拽在 XZ 平面移动（Shift 拖拽上下）
// Q/E 旋转 15°（Shift 微调 5°），改动存 localStorage，可一键复制补丁。
import * as THREE from './vendor/three.module.js';

const STORE_KEY = 'home-edit-patches';

function loadPatches() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}
function savePatches(patches) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(patches)); } catch { /* 忽略 */ }
}

function labelOf(obj) {
  const g = obj.geometry;
  const type = g?.type ? g.type.replace('Geometry', '') : (obj.isGroup ? 'Group' : 'Object');
  const kids = obj.isGroup ? `×${obj.children.length}` : '';
  return `${type}${kids}`;
}

export function createDevEditor({ world, camera, canvas }) {
  const patches = loadPatches();
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hitPoint = new THREE.Vector3();
  const ignore = new Set([world.sky, world.poolWater, world.poolBody, world.tvScreen].filter(Boolean));

  let enabled = false;
  let selected = null;
  let helper = null;
  let drag = null;

  // ── 面板 ────────────────────────────────────────────────
  const ui = document.createElement('div');
  ui.id = 'devEditor';
  ui.style.cssText = [
    'position:fixed', 'right:14px', 'bottom:74px', 'z-index:60', 'width:270px',
    'background:rgba(18,22,28,.92)', 'border:1px solid rgba(255,204,85,.45)',
    'border-radius:12px', 'padding:10px 12px', 'color:#e8eef5',
    'font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace',
    'box-shadow:0 10px 28px rgba(0,0,0,.45)', 'display:none'
  ].join(';');
  ui.innerHTML = `
    <div style="font-weight:700;color:#ffcc55;margin-bottom:6px">模型编辑模式</div>
    <div id="deInfo" style="min-height:54px;white-space:pre-wrap"></div>
    <div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
      <button id="deCopy" style="flex:1;padding:4px 6px">复制补丁</button>
      <button id="deReset" style="flex:1;padding:4px 6px">复位此件</button>
      <button id="deClear" style="flex:1;padding:4px 6px">清空全部</button>
    </div>
    <div style="margin-top:6px;color:#93a4b6">点选 → 拖拽移动｜Shift 拖拽上下｜Q/E 旋转｜Alt 关吸附</div>
  `;
  document.body.appendChild(ui);
  const info = ui.querySelector('#deInfo');

  const setInfo = (text) => { info.textContent = text; };

  function refreshHelper() {
    if (helper) { helper.geometry.dispose?.(); helper.material?.dispose?.(); world.scene.remove(helper); helper = null; }
    if (!selected) return;
    helper = new THREE.BoxHelper(selected, 0xffcc55);
    helper.material.depthTest = false;
    helper.renderOrder = 999;
    world.scene.add(helper);
  }

  function describe() {
    if (!selected) return '未选中';
    const p = selected.position;
    const ry = Math.round(THREE.MathUtils.radToDeg(selected.rotation.y));
    const idx = world.root.children.indexOf(selected);
    return `#${idx}  ${labelOf(selected)}\npos  ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}\nrotY ${ry}°`;
  }

  function updateInfo() { setInfo(describe()); }

  function pick(ev) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(world.root, true);
    for (const h of hits) {
      const o = h.object;
      if (ignore.has(o)) continue;
      if (o.userData?.ignorePick) continue;
      if (o.material?.transparent && (o.material.opacity ?? 1) < 0.5) continue;
      let unit = o;
      while (unit.parent && unit.parent !== world.root) unit = unit.parent;
      return unit;
    }
    return null;
  }

  function applyPatch(obj, idx) {
    const p = patches[idx];
    if (!p) return;
    obj.position.set(p.x, p.y, p.z);
    obj.rotation.y = p.ry || 0;
  }

  function record() {
    if (!selected) return;
    const idx = world.root.children.indexOf(selected);
    if (idx < 0) return;
    patches[idx] = {
      x: +selected.position.x.toFixed(3),
      y: +selected.position.y.toFixed(3),
      z: +selected.position.z.toFixed(3),
      ry: +selected.rotation.y.toFixed(4)
    };
    savePatches(patches);
  }

  // ── 事件 ────────────────────────────────────────────────
  const onDown = (ev) => {
    if (!enabled || ev.button !== 0) return;
    const unit = pick(ev);
    if (!unit) return;
    ev.preventDefault();
    ev.stopPropagation();
    selected = unit;
    refreshHelper();
    updateInfo();

    const baseY = unit.position.y;
    plane.set(new THREE.Vector3(0, 1, 0), -baseY);
    raycaster.ray.intersectPlane(plane, hitPoint);
    drag = {
      y: ev.clientY,
      start: unit.position.clone(),
      startHit: hitPoint.clone()
    };
    try { canvas.setPointerCapture?.(ev.pointerId); } catch { /* 合成事件没有真实指针 */ }
    canvas.style.cursor = 'grabbing';
  };

  const onMove = (ev) => {
    if (!drag || !selected) return;
    ev.preventDefault();
    ev.stopPropagation();
    const snap = ev.altKey ? 0.001 : 0.05;
    if (ev.shiftKey) {
      selected.position.y = drag.start.y + (drag.y - ev.clientY) * 0.01;
      selected.position.y = Math.round(selected.position.y / snap) * snap;
    } else {
      raycaster.setFromCamera(pointer, camera);
      const rect = canvas.getBoundingClientRect();
      pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointer, camera);
      if (raycaster.ray.intersectPlane(plane, hitPoint)) {
        const dx = hitPoint.x - drag.startHit.x;
        const dz = hitPoint.z - drag.startHit.z;
        selected.position.x = Math.round((drag.start.x + dx) / snap) * snap;
        selected.position.z = Math.round((drag.start.z + dz) / snap) * snap;
      }
    }
    helper?.update();
    updateInfo();
  };

  const onUp = (ev) => {
    if (!drag) return;
    ev.preventDefault();
    ev.stopPropagation();
    drag = null;
    canvas.style.cursor = 'grab';
    record();
    refreshHelper();
    updateInfo();
  };

  const onHover = (ev) => {
    if (!enabled || drag) return;
    canvas.style.cursor = pick(ev) ? 'pointer' : 'grab';
  };

  const onKey = (ev) => {
    if (!enabled) return;
    const tag = String(ev.target?.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || ev.target?.isContentEditable) return;
    if (ev.code === 'Escape') {
      selected = null;
      refreshHelper();
      setInfo('已取消选中（可以拖镜头了）');
      return;
    }
    if (!selected) return;
    const fine = ev.shiftKey ? 5 : 15;
    const rad = THREE.MathUtils.degToRad(fine);
    if (ev.code === 'KeyQ') { selected.rotation.y += rad; }
    else if (ev.code === 'KeyE') { selected.rotation.y -= rad; }
    else if (ev.code === 'Delete' || ev.code === 'Backspace') {
      selected.visible = false;
    } else if (ev.code === 'KeyR' && ev.altKey) {
      selected.rotation.y = 0;
    } else return;
    ev.preventDefault();
    helper?.update();
    updateInfo();
    record();
  };

  canvas.addEventListener('pointerdown', onDown, true);
  canvas.addEventListener('pointermove', onMove, true);
  canvas.addEventListener('pointerup', onUp, true);
  canvas.addEventListener('pointermove', onHover);
  window.addEventListener('keydown', onKey);

  ui.querySelector('#deCopy')?.addEventListener('click', async () => {
    const list = Object.entries(patches).map(([i, p]) => {
      const o = world.root.children[Number(i)];
      return { idx: Number(i), label: o ? labelOf(o) : '?', x: p.x, y: p.y, z: p.z, ry: p.ry };
    });
    const text = JSON.stringify(list, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setInfo('已复制 ' + list.length + ' 条补丁到剪贴板');
    } catch {
      console.log('[dev-editor] patches', text);
      setInfo('复制失败，已打印到控制台');
    }
  });

  ui.querySelector('#deReset')?.addEventListener('click', () => {
    if (!selected) return;
    const idx = world.root.children.indexOf(selected);
    delete patches[idx];
    savePatches(patches);
    setInfo('已清除 #' + idx + ' 的改动（重新加载后恢复原位）');
  });

  ui.querySelector('#deClear')?.addEventListener('click', () => {
    Object.keys(patches).forEach((k) => delete patches[k]);
    savePatches(patches);
    setInfo('已清空全部改动');
  });

  // ── 启动 ────────────────────────────────────────────────
  function setEnabled(next) {
    enabled = next;
    ui.style.display = next ? 'block' : 'none';
    if (!next) {
      selected = null;
      refreshHelper();
    } else {
      // 应用已保存的补丁
      for (const [k, p] of Object.entries(patches)) {
        const obj = world.root.children[Number(k)];
        if (obj) applyPatch(obj, Number(k));
      }
      setInfo('点击任意模型选中；拖拽移动');
      canvas.style.cursor = 'grab';
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
    busy: () => enabled && (!!drag || !!selected),
    dragging: () => !!drag,
    patches
  };
  window.__devEditor = api;
  return api;
}
