// 单测：雨天自动补水、雪天暂停生长
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createGardenCaretaker } from '../src/garden-autonomy.js';
import { loadHomeState, saveHomeState } from '../src/home-state.js';
import { loadGarden as loadGardenFile, saveGarden as saveGardenFile } from '../src/garden-store.js';
import { setWeather } from '../src/weather-store.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'garden-wx-'));
const gardenFile = path.join(tmp, 'garden.json');
const homeFile = path.join(tmp, 'home.json');

// 造一块种着胡萝卜、缺水的地
const garden = {
  coins: 100,
  seeds: { carrot: 3 },
  stock: {},
  plots: Array.from({ length: 8 }, (_, i) => ({
    id: i,
    tilled: i === 0,
    cropId: i === 0 ? 'carrot' : null,
    progress: i === 0 ? 0.3 : 0,
    moisture: i === 0 ? 0.1 : 0,
    fertilized: false
  })),
  care: { autoEnabled: false, queue: [], task: null, nextPlanAt: 0, rotation: 0, status: '' },
  log: [],
  updatedAt: Date.now()
};
fs.writeFileSync(gardenFile, JSON.stringify(garden));
// 用真实 home.json 作模板，保证 normalize 后字段齐全
const homeTpl = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'state', 'home.json'), 'utf8'));
homeTpl.room = 'garden';
homeTpl.spot = 'plot0';
homeTpl.route = null;
homeTpl.dwell = null;
homeTpl.updatedAt = Date.now();
fs.writeFileSync(homeFile, JSON.stringify(homeTpl));

const storage = {
  loadHomeState: (f, now) => loadHomeState(f, now),
  saveHomeState: (f, s, now) => saveHomeState(f, s, now),
  loadGarden: (f, now) => loadGardenFile(f, now),
  saveGarden: (f, g) => saveGardenFile(f, g)
};

const caretaker = createGardenCaretaker({ homeFile, gardenFile, getEnv: () => ({}), storage });

setWeather('rain', 0.8);
caretaker.tick(Date.now());
let g = JSON.parse(fs.readFileSync(gardenFile, 'utf8'));
console.log('rain -> plot0 moisture:', g.plots[0].moisture.toFixed(2), '(期望 >= 0.6)');

// 雪天：推进 10 分钟后进度不应增长
g.plots[0].moisture = 1;
g.plots[0].progress = 0.3;
g.updatedAt = Date.now() - 10 * 60_000;
fs.writeFileSync(gardenFile, JSON.stringify(g));
setWeather('snow', 0.8);
caretaker.tick(Date.now());
g = JSON.parse(fs.readFileSync(gardenFile, 'utf8'));
console.log('snow -> plot0 progress:', g.plots[0].progress.toFixed(3), '(期望 ≈ 0.300，不生长)');

// 晴天对照：同样 10 分钟应该长一点
g.plots[0].moisture = 1;
g.plots[0].progress = 0.3;
g.updatedAt = Date.now() - 10 * 60_000;
fs.writeFileSync(gardenFile, JSON.stringify(g));
setWeather('clear', 0.6);
caretaker.tick(Date.now());
g = JSON.parse(fs.readFileSync(gardenFile, 'utf8'));
console.log('clear -> plot0 progress:', g.plots[0].progress.toFixed(3), '(期望 > 0.300)');

fs.rmSync(tmp, { recursive: true, force: true });
