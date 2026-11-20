// ── 动画转移图（开发模式可视化）────────────────────────────────────────────
// 状态变化的流程图：每个动画片段是一个圆点，带箭头的连线指向切换方向，
// 类似元胞自动机的状态转移图。数据源是 window.__clipLog（app.js 每次真实
// 片段切换都会 push {t, from, to}，保留最近 200 条）。
//
// 打开方式：
//   · 开发菜单 → 「动画图」按钮
//   · URL ?animgraph=1
//
// 与 ANIMATION.md 的 clipFor() 决策表对齐：每个片段按决策分支归类染色，
// 打开图就能看出「决策逻辑长什么样、实际又跑了什么」。
//
// 特性：
//   · 有向图：节点 = 片段，边 = from→to（计数 + 最近一次切换时间）
//   · 自研 Verlet 力导向布局（斥力 + 边引力 + 向心力），无外部依赖
//   · 节点拖拽 / 滚轮缩放 / 空白处拖拽平移
//   · 当前片段高亮 + 脉冲；切换瞬间边闪烁
//   · 侧栏：当前状态 + 切换统计 + 最近切换日志
//   · 暂停物理 / 重置布局 / 按类别收拢

const OPEN_FLAG = '__animGraph';

// ── 片段分类（对齐 app.js clipFor 决策表的判定层级，从上到下）────────────
const CLIP_CLASSES = [
  {
    id: 'motion', name: '运动', color: '#6fd7d0',
    desc: 'walking → run_happy / run_hurry（最高优先级）',
    clips: ['run_happy', 'run_hurry', 'walk', 'walk_fast'],
  },
  {
    id: 'sleep', name: '睡眠', color: '#8f9bff',
    desc: 'asleep → sleep_in → sleep_loop → sleep_out；未到床回 idle',
    clips: ['sleep_in', 'sleep_loop', 'sleep_out', 'nap'],
  },
  {
    id: 'seat', name: '坐具/上座', color: '#ffc36e',
    desc: '上座由服务端两段式完成（mounting/dismounting）；坐姿无专用帧，用 dance 兜底、过渡用 mutter',
    clips: ['dance', 'mutter'],
  },
  {
    id: 'meal', name: '就餐/饮水', color: '#ff9a5c',
    desc: 'eat → 吃午餐/eat_snack；drink → 举杯敬酒',
    clips: ['eat_snack', '吃午餐', '举杯敬酒', 'wait_food'],
    clipMatch: [/^吃/, /^喝/, /^大口吃/, /^品/],
  },
  {
    id: 'hygiene', name: '盥洗', color: '#9fe0c8',
    desc: 'bath → 晨间刷牙；toilet → mutter；照镜子',
    clips: ['晨间刷牙', '照镜子'],
    clipMatch: [/^刷牙/, /^洗脸/, /^洗澡/],
  },
  {
    id: 'desk', name: '书桌/工位', color: '#8fc1ff',
    desc: 'desk → 写代码；phone → 熬夜刷手机；garden_till/plant/harvest → desk_tap',
    clips: ['写代码', 'desk_tap', '熬夜刷手机'],
  },
  {
    id: 'tv', name: '电视/休闲', color: '#c8a2ff',
    desc: 'tv → 原地专心玩魔方；balcony → mooncake(夜)/fan(昼)；laundry → 叠衣服',
    clips: ['原地专心玩魔方', 'mooncake', 'fan', '叠衣服'],
  },
  {
    id: 'once', name: '一次性反应', color: '#ff9db0',
    desc: 'ONCE 集合：播完自动回 clipFor；同 key 9 秒内不重复',
    clips: ['react_happy', 'react_shy', 'react_scare', 'stretch', 'curtsy'],
  },
  {
    id: 'sick', name: '病/求助', color: '#ff6e6e',
    desc: 'sick / help → sick',
    clips: ['sick'],
  },
  {
    id: 'idle_variant', name: '待机变体', color: '#a4b8cc',
    desc: 'idle 兜底：深夜 yawn / 心情低 idle_look / 哈希分派 dance·idle_hum·idle_look·idle',
    clips: ['idle', 'idle_look', 'idle_hum', 'back_idle', 'yawn'],
  },
  {
    id: 'freestyle', name: '自主动作/场景', color: '#e8e8a0',
    desc: 'freestyle → her.clip（服务端 90–180s 抽一次）；以及 游泳 等场景固定片段',
    clips: ['游泳'],
    clipMatch: [/.*/],   // 兜底：268 个生成片段都归这里
  },
  {
    id: 'start', name: '初始', color: '#7e93ad',
    desc: '页面加载后的第一段（clipLog 里 from 为空）',
    clips: ['(初始)'],
  },
];

function classifyClip(name) {
  if (!name) return null;
  for (const c of CLIP_CLASSES) {
    if (c.clips.includes(name)) return c;
  }
  for (const c of CLIP_CLASSES) {
    if (c.clipMatch?.some((re) => re.test(name))) return c;
  }
  return null;
}

// ── 自包含 UI ─────────────────────────────────────────────────────────────
const CSS_TEXT = `
clip-graph{position:fixed;inset:0;z-index:80;display:none;pointer-events:none}
clip-graph.on{display:block;pointer-events:auto}
clip-graph .cg-root{position:absolute;inset:0 270px 0 0;background:rgba(7,11,17,.88)}
clip-graph .cg-topbar{position:absolute;left:0;top:0;right:0;height:44px;display:flex;align-items:center;gap:10px;
  padding:0 14px;border-bottom:1px solid rgba(143,193,255,.16);background:rgba(11,16,24,.92)}
clip-graph .cg-title{font:600 13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#8fc1ff;letter-spacing:.08em}
clip-graph .cg-topbar .spacer{flex:1}
clip-graph .cg-btn{border:1px solid rgba(143,193,255,.3);background:rgba(143,193,255,.12);color:#dfeeff;
  border-radius:8px;padding:5px 10px;font:12px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;cursor:pointer}
clip-graph .cg-btn:hover{background:rgba(143,193,255,.24)}
clip-graph .cg-btn.on{background:#8fc1ff;color:#0b1622;font-weight:600}
clip-graph .cg-svg{position:absolute;left:0;top:44px;right:0;bottom:0;cursor:grab;touch-action:none;overflow:hidden}
clip-graph .cg-svg.dragging{cursor:grabbing}
clip-graph .cg-node{cursor:grab}
clip-graph .cg-node.current .ring{animation:cg-pulse 1.2s ease-out infinite}
@keyframes cg-pulse{0%{stroke-opacity:.9;stroke-width:4}70%{stroke-opacity:0;stroke-width:10}100%{stroke-opacity:0;stroke-width:10}}
clip-graph .cg-edge{cursor:pointer}
clip-graph .cg-edge.flash path{stroke:#fff;stroke-opacity:.95}
clip-graph .cg-side{position:absolute;right:0;top:0;bottom:0;width:270px;padding:12px 14px;overflow:auto;
  border-left:1px solid rgba(143,193,255,.16);background:rgba(11,16,24,.96);
  font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#c9d8ea;
  scrollbar-width:thin;scrollbar-color:rgba(150,190,230,.35) transparent}
clip-graph .cg-side h4{margin:10px 0 6px;font-size:11px;letter-spacing:.18em;color:#8fc1ff;font-weight:600}
clip-graph .cg-side h4:first-child{margin-top:0}
clip-graph .cg-side .now{display:flex;align-items:center;gap:7px;padding:8px 9px;margin-bottom:10px;border-radius:9px;
  background:rgba(143,193,255,.1);border:1px solid rgba(143,193,255,.22)}
clip-graph .cg-side .now .dot{width:9px;height:9px;border-radius:50%;flex:none}
clip-graph .cg-side .now b{font-size:12.5px;color:#eaf4ff}
clip-graph .cg-side .now small{display:block;font-size:10px;color:#9db0c8}
clip-graph .cg-stat{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:4px}
clip-graph .cg-stat div{padding:6px 8px;border-radius:8px;background:rgba(255,255,255,.05)}
clip-graph .cg-stat b{display:block;font-size:13px;color:#eaf4ff}
clip-graph .cg-stat span{font-size:9.5px;color:#9db0c8}
clip-graph .cg-log{list-style:none;margin:0;padding:0;display:grid;gap:4px}
clip-graph .cg-log li{display:grid;grid-template-columns:auto 1fr;gap:6px;align-items:baseline;font-size:10.5px;color:#c9d8ea}
clip-graph .cg-log li span{color:#7e93ad;font-variant-numeric:tabular-nums}
clip-graph .cg-log li b{font-weight:500;overflow-wrap:anywhere}
clip-graph .cg-log li i{font-style:normal;color:#5f738c;margin:0 2px}
clip-graph .cg-log li i.to{color:#8fc1ff}
clip-graph .cg-legend{display:flex;flex-wrap:wrap;gap:5px 10px}
clip-graph .cg-legend .lg{display:flex;align-items:center;gap:5px;font-size:10px;color:#aebfd2;cursor:help}
clip-graph .cg-legend .lg i{width:8px;height:8px;border-radius:50%}
clip-graph .cg-selinfo{position:sticky;bottom:0;margin-top:10px;padding:8px 9px;border-radius:8px;
  background:rgba(143,193,255,.12);border:1px solid rgba(143,193,255,.25);color:#dfeeff;
  opacity:0;transition:opacity .3s;font-size:10.5px;white-space:pre-wrap;pointer-events:none}
`;

let rootEl = null;
let rafId = 0;
let opened = false;

// 图数据
const nodes = new Map();   // name -> {x,y,vx,vy,cls,inN,outN,playedAt,r}
const edges = new Map();   // "from→to" -> {from,to,count,last,flash}
// __clipLog 条目按对象引用去重（log 头部会被裁剪）；重置数据时换一个集合，
// 让全部条目重新入图。WeakSet 不能遍历，所以用「代次」方案：每代一个新 Set。
let seenEntries = new Set();

// 视图变换
const view = { x: 0, y: 0, k: 1 };
let viewInited = false;   // 首次打开时把图坐标原点放到画布中心
let dragNode = null;
let dragPan = null;
let lastNow = 0;
let currentClip = null;
let currentSince = 0;
let sideNext = 0;          // 侧栏节流

function nodeFor(name) {
  if (!nodes.has(name)) {
    const i = nodes.size;
    const ang = (i * 137.5) * Math.PI / 180;   // 黄金角撒开
    // 螺旋外扩：clip 可能有三百多个，全挤在几百像素里物理要很久才散得开。
    // 按 sqrt(i) 铺到更大范围，物理预热几十帧就能稳定。
    const r = 70 + 55 * Math.sqrt(i);
    nodes.set(name, {
      name, cls: classifyClip(name),
      x: Math.cos(ang) * r, y: Math.sin(ang) * r,
      vx: 0, vy: 0, inN: 0, outN: 0, playedAt: 0, r: 12,
    });
  }
  return nodes.get(name);
}

function edgeFor(from, to) {
  const key = `${from}→${to}`;
  if (!edges.has(key)) edges.set(key, { from, to, count: 0, last: 0, flash: 0 });
  return edges.get(key);
}

// ── 数据摄入：__clipLog 是追加式环形缓冲（超 200 条从头裁剪），
//    所以按「对象引用」判增量，不能按索引。
function ingest(log) {
  if (!Array.isArray(log) || !log.length) return;
  for (const e of log) {
    if (!e || seenEntries.has(e) || typeof e.to !== 'string') continue;
    seenEntries.add(e);
    const from = e.from || '(初始)';
    nodeFor(e.to);
    nodeFor(from);
    const ed = edgeFor(from, e.to);
    ed.count += 1;
    ed.last = e.t || Date.now();
    ed.flash = 1.4;
    nodes.get(from).outN += 1;
    const tn = nodes.get(e.to);
    tn.inN += 1;
    tn.playedAt = ed.last;
    currentClip = e.to;
    currentSince = performance.now();
  }
}

// ── 物理（Verlet 力导向）─────────────────────────────────────────────────
function stepPhysics(dt) {
  const list = [...nodes.values()];
  const n = list.length;
  if (!n) return;
  // 这套参数是为「几十上百个节点、要能摊开看清」调的：
  //   斥力大 + 向心力弱 → 节点会真正散开，不会挤成一团；
  //   边更长 → 有转移关系的两个片段之间留出放标签的余地；
  //   SOFT_R 是软边界，防止几个孤立节点被斥力推到天边。
  const REPUL = 26000;     // 节点间斥力（原来 5200，太小 → 挤一堆）
  const SPRING = 0.02;     // 边引力
  const CENTER = 0.012;    // 向心力（原来 0.15，太大 → 全被吸到原点）
  const DAMP = 0.86;
  const MAX_D2 = 900 * 900;
  const SOFT_R = 900;      // 软边界半径

  for (let i = 0; i < n; i++) {
    const a = list[i];
    a.vx *= DAMP; a.vy *= DAMP;
    for (let j = i + 1; j < n; j++) {
      const b = list[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1e-4) { dx = Math.random() - .5; dy = Math.random() - .5; d2 = dx * dx + dy * dy; }
      if (d2 > MAX_D2) continue;   // 太远不斥（省 CPU）
      const d = Math.sqrt(d2);
      const f = REPUL / d2;
      const fx = (dx / d) * f, fy = (dy / d) * f;
      a.vx += fx * dt; a.vy += fy * dt;
      b.vx -= fx * dt; b.vy -= fy * dt;
    }
  }
  for (const ed of edges.values()) {
    const a = nodes.get(ed.from); const b = nodes.get(ed.to);
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.hypot(dx, dy) || 1;
    const want = 150 + Math.min(90, ed.count * 12);   // 常走的边更松弛
    const f = (d - want) * SPRING;
    const fx = (dx / d) * f, fy = (dy / d) * f;
    a.vx += fx * dt; a.vy += fy * dt;
    b.vx -= fx * dt; b.vy -= fy * dt;
  }
  for (const nd of list) {
    nd.vx -= nd.x * CENTER * dt;
    nd.vy -= nd.y * CENTER * dt;
    // 软边界：超出 SOFT_R 就拉回来（系数不能太小，否则斥力会把节点推到很远，
    // 图幅一大，fitView 只能缩到 0.4 倍，节点和标签就糊成一片了）
    const rr = Math.hypot(nd.x, nd.y);
    if (rr > SOFT_R) {
      const pull = (rr - SOFT_R) * 0.9 * dt;
      nd.vx -= (nd.x / rr) * pull;
      nd.vy -= (nd.y / rr) * pull;
    }
    if (dragNode?.node === nd) { nd.x = dragNode.x; nd.y = dragNode.y; nd.vx = nd.vy = 0; continue; }
    nd.x += nd.vx * dt; nd.y += nd.vy * dt;
    const sp = Math.hypot(nd.vx, nd.vy);
    if (sp > 700) { nd.vx *= 700 / sp; nd.vy *= 700 / sp; }
  }
}

// ── SVG 渲染 ──────────────────────────────────────────────────────────────
let svg = null, gEdges = null, gNodes = null, gLabels = null;
let sideNow = null, sideStats = null, sideLog = null, selInfo = null;

function ensureSvg() {
  if (svg) return;
  const root = rootEl.querySelector('.cg-root');
  svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'cg-svg');
  svg.innerHTML = `<defs>
    <marker id="cg-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7"
      orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="context-stroke"/></marker>
  </defs>`;
  // context-stroke 兼容性兜底：不支持时按边自身颜色画（渲染时逐边覆盖 fill）
  const markerPath = svg.querySelector('#cg-arrow path');
  markerPath.setAttribute('fill', '#8fc1ff');
  gEdges = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  gNodes = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  gLabels = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  svg.append(gEdges, gNodes, gLabels);
  root.appendChild(svg);
  svg.__edge = new Map();
  svg.__node = new Map();
  svg.__label = new Map();
  bindPointer();
}

function edgePath(x1, y1, x2, y2, r1, r2) {
  const dx = x2 - x1, dy = y2 - y1;
  const d = Math.hypot(dx, dy) || 1;
  const ux = dx / d, uy = dy / d;
  const a1x = x1 + ux * (r1 + 3), a1y = y1 + uy * (r1 + 3);
  const a2x = x2 - ux * (r2 + 1), a2y = y2 - uy * (r2 + 1);   // 箭头 refX=8，贴到节点边
  // 轻微弓形：双向边（A→B 与 B→A）在视觉上分开。
  // 弓高按距离比例，但设上限 —— 边变长之后大弓会互相穿插，看着更乱。
  const bow = Math.min(26, d * 0.045);
  const mx = (a1x + a2x) / 2 - uy * bow;
  const my = (a1y + a2y) / 2 + ux * bow;
  return `M ${a1x.toFixed(1)} ${a1y.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${a2x.toFixed(1)} ${a2y.toFixed(1)}`;
}

function render() {
  if (!svg) return;
  const seen = new Set();
  for (const ed of edges.values()) {
    const a = nodes.get(ed.from); const b = nodes.get(ed.to);
    if (!a || !b) continue;
    seen.add(ed);
    let el = svg.__edge.get(ed);
    if (!el) {
      el = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      el.classList.add('cg-edge');
      el.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'path'));
      el.addEventListener('click', (ev) => { ev.stopPropagation(); selectEdge(ed); });
      svg.__edge.set(ed, el);
      gEdges.appendChild(el);
    }
    const path = el.firstChild;
    const opacity = 0.3 + Math.min(0.55, ed.count * 0.12);
    const width = Math.min(5, 1 + ed.count * 0.45);
    path.setAttribute('d', edgePath(a.x, a.y, b.x, b.y, a.r, b.r));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', b.cls?.color || '#8fc1ff');
    path.setAttribute('stroke-width', width);
    path.setAttribute('opacity', opacity);
    path.setAttribute('marker-end', 'url(#cg-arrow)');
    if (ed.flash > 0) {
      el.classList.add('flash');
      el.style.opacity = Math.min(1, 0.4 + ed.flash);
      ed.flash -= 0.03;
      if (ed.flash <= 0) { ed.flash = 0; el.classList.remove('flash'); }
    } else {
      el.style.opacity = '';
      el.classList.remove('flash');
    }
  }
  for (const [ed, el] of svg.__edge) {
    if (!seen.has(ed)) { el.remove(); svg.__edge.delete(ed); }
  }

  const seenN = new Set();
  for (const nd of nodes.values()) {
    seenN.add(nd);
    let el = svg.__node.get(nd);
    if (!el) {
      el = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      el.classList.add('cg-node');
      el.innerHTML = `<circle class="ring" fill="none" stroke="transparent" stroke-width="4" r="15"/>
        <circle class="body"/><circle class="halo" fill="none" stroke-width="1.5"/>`;
      el.addEventListener('pointerdown', (ev) => startNodeDrag(ev, nd));
      el.addEventListener('click', (ev) => { ev.stopPropagation(); selectNode(nd); });
      svg.__node.set(nd, el);
      gNodes.appendChild(el);
    }
    const color = nd.cls?.color || '#8fc1ff';
    const isCurrent = currentClip === nd.name;
    const body = el.querySelector('.body');
    const ring = el.querySelector('.ring');
    const halo = el.querySelector('.halo');
    nd.r = 12 + Math.min(14, (nd.inN + nd.outN) * 1.1);   // 活跃度 → 半径
    body.setAttribute('cx', nd.x); body.setAttribute('cy', nd.y);
    body.setAttribute('r', nd.r);
    body.setAttribute('fill', color);
    body.setAttribute('fill-opacity', isCurrent ? 0.95 : 0.55);
    body.setAttribute('stroke', isCurrent ? '#fff' : color);
    body.setAttribute('stroke-width', isCurrent ? 2.5 : 1);
    ring.setAttribute('cx', nd.x); ring.setAttribute('cy', nd.y);
    ring.setAttribute('r', nd.r + 2);
    ring.setAttribute('stroke', isCurrent ? color : 'transparent');
    el.classList.toggle('current', isCurrent);
    halo.setAttribute('cx', nd.x); halo.setAttribute('cy', nd.y);
    halo.setAttribute('r', nd.r + 3.5);
    halo.setAttribute('stroke', color);
    halo.setAttribute('stroke-opacity', '0.3');
  }
  for (const [nd, el] of svg.__node) {
    if (!seenN.has(nd)) { el.remove(); svg.__node.delete(nd); }
  }

  const seenL = new Set();
  // 节点多的时候只给「活跃度高」的节点画标签：几十上百个标签叠在一起看不清，
  // 留着节点形状 + 颜色（类别）已经足够看出结构。当前片段永远显示标签。
  const labelLimit = (() => {
    const n = nodes.size;
    if (n <= 60) return -1;   // 数量不多，全显示
    const acts = [...nodes.values()].map((d) => d.inN + d.outN).sort((a, b) => b - a);
    return acts[Math.min(acts.length - 1, Math.round(acts.length * 0.5))] || 0;
  })();
  for (const nd of nodes.values()) {
    seenL.add(nd);
    const isCur = currentClip === nd.name;
    const showLabel = labelLimit < 0 || isCur || (nd.inN + nd.outN) >= labelLimit;
    let t = svg.__label.get(nd);
    if (!showLabel) {
      if (t) t.style.display = 'none';
      continue;
    }
    if (!t) {
      t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      t.setAttribute('text-anchor', 'middle');
      t.setAttribute('font-size', '10.5');
      t.setAttribute('paint-order', 'stroke');
      t.setAttribute('stroke', 'rgba(7,11,17,.9)');
      t.setAttribute('stroke-width', '3px');
      t.style.pointerEvents = 'none';
      t.textContent = nd.name;
      svg.__label.set(nd, t);
      gLabels.appendChild(t);
    }
    if (t.style.display === 'none') t.style.display = '';
    t.setAttribute('x', nd.x);
    t.setAttribute('y', nd.y + nd.r + 11);
    t.setAttribute('fill', isCur ? '#fff' : '#cfe0f2');
    t.setAttribute('font-weight', isCur ? '700' : '500');
  }
  for (const [nd, t] of svg.__label) {
    if (!seenL.has(nd)) { t.remove(); svg.__label.delete(nd); }
  }
}

// ── 侧栏（节流 250ms）─────────────────────────────────────────────────────
function renderSide() {
  if (!sideNow) return;
  const now = performance.now();
  if (now < sideNext) return;
  sideNext = now + 250;
  const cls = classifyClip(currentClip);
  const dwell = currentClip ? ((now - currentSince) / 1000).toFixed(1) : '0.0';
  sideNow.innerHTML = `<span class="dot" style="background:${cls?.color || '#8fc1ff'}"></span>
    <div><b>${currentClip || '—'}</b><small>${cls ? cls.name + ' · ' : ''}已驻留 ${dwell}s</small></div>`;
  const total = [...edges.values()].reduce((s, e) => s + e.count, 0);
  sideStats.innerHTML = `
    <div><b>${nodes.size}</b><span>片段节点</span></div>
    <div><b>${edges.size}</b><span>转移边</span></div>
    <div><b>${total}</b><span>切换总次数</span></div>
    <div><b>${dwell}</b><span>当前驻留(s)</span></div>`;
  const log = (window.__clipLog || []).slice(-14).reverse();
  sideLog.innerHTML = log.map((e) => {
    const c = classifyClip(e.to);
    const ago = e.t ? Math.max(0, (Date.now() - e.t) / 1000).toFixed(0) : '—';
    return `<li><span>${ago}s前</span><b><i>${e.from || '(初始)'}</i><i class="to">→</i><i style="color:${c?.color || ''}">${e.to}</i></b></li>`;
  }).join('') || '<li><b>等待第一次切换…</b></li>';
}

// ── 选中信息 ──────────────────────────────────────────────────────────────
function selectNode(nd) {
  showInfo(`「${nd.name}」${nd.cls ? ' · ' + nd.cls.name : ''}
${nd.cls?.desc || ''}
入 ${nd.inN} 次 · 出 ${nd.outN} 次${nd.playedAt ? ` · 最近播放 ${((Date.now() - nd.playedAt) / 1000).toFixed(0)}s 前` : ' · 尚未播放'}`);
}
function selectEdge(ed) {
  showInfo(`转移 ${ed.from} → ${ed.to}
次数 ${ed.count} · 最近 ${ed.last ? ((Date.now() - ed.last) / 1000).toFixed(0) + 's 前' : '—'}`);
}
function showInfo(text) {
  if (!selInfo) return;
  selInfo.textContent = text;
  selInfo.style.opacity = '1';
  clearTimeout(showInfo._t);
  showInfo._t = setTimeout(() => { if (selInfo) selInfo.style.opacity = '0'; }, 5000);
}

// ── 交互：拖拽/缩放/平移 ─────────────────────────────────────────────────
function svgPoint(ev) {
  const rect = svg.getBoundingClientRect();
  return {
    x: (ev.clientX - rect.left - view.x) / view.k,
    y: (ev.clientY - rect.top - view.y) / view.k,
  };
}
function startNodeDrag(ev, nd) {
  ev.preventDefault(); ev.stopPropagation();
  const p = svgPoint(ev);
  const el = ev.currentTarget;   // 节点 g 元素：capture 抓在它身上，click 仍会落到节点
  let dragged = false;
  dragNode = { node: nd, x: p.x, y: p.y };
  el.setPointerCapture(ev.pointerId);
  svg.classList.add('dragging');
  const move = (ev2) => {
    const p2 = svgPoint(ev2);
    if (Math.hypot(p2.x - p.x, p2.y - p.y) > 3) dragged = true;
    dragNode.x = p2.x; dragNode.y = p2.y;
  };
  const up = () => {
    dragNode = null;
    svg.classList.remove('dragging');
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  // 拖动后不弹选中信息（pointerup 后紧跟 click，捕获阶段拦掉一次）
  svg.addEventListener('click', (e2) => { if (dragged) { e2.stopPropagation(); e2.preventDefault(); } }, { capture: true, once: true });
}
function bindPointer() {
  svg.addEventListener('pointerdown', (ev) => {
    if (ev.target.closest?.('.cg-node') || ev.target.closest?.('.cg-edge')) return;
    // 平移用「屏幕坐标」做增量（view.x/y 就是屏幕像素平移量），
    // 不能混用图坐标：缩放后图坐标增量会反向。
    const sx = ev.clientX, sy = ev.clientY;
    const start = { vx: view.x, vy: view.y };
    let moved = false;
    svg.classList.add('dragging');
    const move = (ev2) => {
      moved = true;
      view.x = start.vx + (ev2.clientX - sx);
      view.y = start.vy + (ev2.clientY - sy);
    };
    const up = () => {
      dragPan = null;
      svg.classList.remove('dragging');
      svg.removeEventListener('pointermove', move);
      svg.removeEventListener('pointerup', up);
    };
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerup', up);
  });
  svg.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = svg.getBoundingClientRect();
    const cx = ev.clientX - rect.left, cy = ev.clientY - rect.top;
    const old = view.k;
    view.k = Math.min(3, Math.max(0.3, view.k * (ev.deltaY < 0 ? 1.12 : 0.9)));
    view.x = cx - (cx - view.x) * view.k / old;
    view.y = cy - (cy - view.y) * view.k / old;
  }, { passive: false });
  svg.addEventListener('click', () => { if (selInfo) selInfo.style.opacity = '0'; });
}

// ── 主循环 ────────────────────────────────────────────────────────────────
function tick(now) {
  if (!opened) return;
  const dt = Math.min(0.05, (now - lastNow) / 1000 || 0.016);
  lastNow = now;
  ingest(window.__clipLog);
  // 权威当前片段：__drawState.clip = actor.current（每帧更新）
  if (window.__drawState?.clip && window.__drawState.clip !== currentClip) {
    currentClip = window.__drawState.clip;
    currentSince = performance.now();
  }
  stepPhysics(dt);
  render();
  renderSide();
  applyView();
  rafId = requestAnimationFrame(tick);
}
/** 把整张图整体缩放到目标半径（力导向的平衡半径不可控，预热后归一化最稳）。 */
function normalizeLayout(targetR) {
  const list = [...nodes.values()];
  let maxR = 0;
  for (const nd of list) maxR = Math.max(maxR, Math.hypot(nd.x, nd.y));
  if (maxR < 1) return;
  const s = targetR / maxR;
  if (Math.abs(s - 1) < 0.02) return;
  for (const nd of list) {
    nd.x *= s; nd.y *= s;
    nd.vx = 0; nd.vy = 0;
  }
}

/** 把整张图缩放到刚好放进画布（居中）。 */
function fitView(w, h, padding = 70) {
  const list = [...nodes.values()];
  if (!w || !h || !list.length) return;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const nd of list) {
    // 节点圆 + 下方标签都要算进去，否则标签会被裁掉
    minX = Math.min(minX, nd.x - nd.r - 40);
    maxX = Math.max(maxX, nd.x + nd.r + 40);
    minY = Math.min(minY, nd.y - nd.r - 24);
    maxY = Math.max(maxY, nd.y + nd.r + 46);
  }
  const gw = Math.max(1, maxX - minX);
  const gh = Math.max(1, maxY - minY);
  const k = Math.min(2, Math.max(0.25, Math.min((w - padding * 2) / gw, (h - padding * 2) / gh)));
  view.k = k;
  // 图坐标 cx 映射到画布中心：px = gx*k + view.x  →  view.x = w/2 - cx*k
  view.x = w / 2 - ((minX + maxX) / 2) * k;
  view.y = h / 2 - ((minY + maxY) / 2) * k;
}

function applyView() {
  if (!svg) return;
  const rect = svg.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  // 容器刚 display:block 时可能还量到 0 —— 等下一帧再算，别用一个假尺寸去居中
  // （这正是「打开后图跑到左上角」的原因：首帧拿到 0，view.x/y 被设成兜底值）。
  if (!(w > 50 && h > 50)) return;
  if (!viewInited) {
    if (!nodes.size) return;   // 还没有节点，等 ingest 之后再做
    viewInited = true;
    // 先让物理跑几百步把布局摊开，再归一化到目标半径，最后居中等比适配。
    // 否则第一眼看到的是所有节点还挤在原点附近的一坨。
    for (let i = 0; i < 260; i += 1) stepPhysics(1 / 60);
    // 节点越多，需要的半径越大；但也不能太大，否则 fitView 缩放后节点糊成一片。
    normalizeLayout(150 + 14.5 * Math.sqrt(nodes.size));
    fitView(w, h);
  }
  svg.setAttribute('viewBox', `${(-view.x / view.k).toFixed(2)} ${(-view.y / view.k).toFixed(2)} ${(w / view.k).toFixed(2)} ${(h / view.k).toFixed(2)}`);
}

// ── 构建 DOM ──────────────────────────────────────────────────────────────
function build() {
  if (rootEl) return;
  rootEl = document.createElement('clip-graph');
  rootEl.innerHTML = `
    <div class="cg-root">
      <div class="cg-topbar">
        <span class="cg-title">ANIM GRAPH · 动画转移图</span>
        <span class="spacer"></span>
        <button class="cg-btn" data-cg="reset">重置数据</button>
        <button class="cg-btn" data-cg="cluster">按类收拢</button>
        <button class="cg-btn" data-cg="fit">居中适配</button>
        <button class="cg-btn" data-cg="close">✕ 关闭</button>
      </div>
    </div>
    <div class="cg-side">
      <h4>当前状态</h4>
      <div class="now"></div>
      <div class="cg-stat"></div>
      <h4>图例（对齐 clipFor 决策表）</h4>
      <div class="cg-legend">${CLIP_CLASSES.map((c) =>
        `<span class="lg" title="${c.desc}"><i style="background:${c.color}"></i>${c.name}</span>`).join('')}</div>
      <h4>最近切换</h4>
      <ul class="cg-log"></ul>
      <div class="cg-selinfo"></div>
    </div>`;
  const st = document.createElement('style');
  st.textContent = CSS_TEXT;
  document.head.appendChild(st);
  document.body.appendChild(rootEl);
  ensureSvg();
  sideNow = rootEl.querySelector('.now');
  sideStats = rootEl.querySelector('.cg-stat');
  sideLog = rootEl.querySelector('.cg-log');
  selInfo = rootEl.querySelector('.cg-selinfo');

  rootEl.querySelector('[data-cg="close"]').addEventListener('click', () => setAnimGraphOpen(false));
  // 「居中适配」：手动把整张图缩放到刚好放进画布（滚轮缩放/拖动之后想回到全景时用）
  rootEl.querySelector('[data-cg="fit"]').addEventListener('click', () => {
    viewInited = false;   // 让 applyView 重新算一次
    applyView();
  });
  rootEl.querySelector('[data-cg="reset"]').addEventListener('click', () => {
    nodes.clear(); edges.clear();
    seenEntries = new Set();   // 换代：已消费的条目重新入图
    svg.__edge?.forEach((el) => el.remove()); svg.__edge?.clear();
    svg.__node?.forEach((el) => el.remove()); svg.__node?.clear();
    svg.__label?.forEach((t) => t.remove()); svg.__label?.clear();
    currentClip = null;
    ingest(window.__clipLog);
    // 重建后立刻刷一帧
    render();
  });
  rootEl.querySelector('[data-cg="cluster"]').addEventListener('click', () => {
    // 同类节点收拢到各自小圆上，物理引擎随后自然稳定
    const byCls = new Map();
    for (const nd of nodes.values()) {
      const c = nd.cls?.id || 'freestyle';
      if (!byCls.has(c)) byCls.set(c, []);
      byCls.get(c).push(nd);
    }
    let ci = 0;
    for (const list of byCls.values()) {
      const ang = (ci++ * 47) * Math.PI / 180;
      const cx = Math.cos(ang) * 130, cy = Math.sin(ang) * 130;
      list.forEach((nd, i) => {
        const a2 = (i * 137.5) * Math.PI / 180;
        nd.x = cx + Math.cos(a2) * 30; nd.y = cy + Math.sin(a2) * 30;
        nd.vx = nd.vy = 0;
      });
    }
  });
}

// ── 开关 ──────────────────────────────────────────────────────────────────
export function setAnimGraphOpen(on) {
  if (typeof document === 'undefined') return;   // 无头测试环境：DOM 不存在时不真正开
  if (on) {
    build();
    if (!opened) {
      opened = true;
      rootEl.classList.add('on');
      lastNow = performance.now();
      // 每次打开都重新做「居中适配」：上次可能拖过/缩过，再打开还留在那个视角
      // 会让人以为「图跑到左上角去了」。用户也可以随时点「居中适配」手动回全景。
      viewInited = false;
      ingest(window.__clipLog);
      rafId = requestAnimationFrame(tick);
    }
  } else if (opened) {
    opened = false;
    cancelAnimationFrame(rafId);
    rootEl.classList.remove('on');
  }
  if (typeof window !== 'undefined') window[OPEN_FLAG] = opened;
}

export function isAnimGraphOpen() { return !!opened; }

export function toggleAnimGraph() { setAnimGraphOpen(!opened); }

// URL 参数直开：?animgraph=1（模块加载时 DOM 可能尚未就绪，两种时机都兜住）。
// typeof 守卫：无头测试/Node 环境直接 import 本模块时不炸。
if (typeof location !== 'undefined' && typeof document !== 'undefined') {
  const urlParams = new URLSearchParams(location.search);
  if (urlParams.get('animgraph') === '1') {
    if (document.readyState === 'loading') {
      window.addEventListener('DOMContentLoaded', () => setAnimGraphOpen(true));
    } else {
      setAnimGraphOpen(true);
    }
  }
}
