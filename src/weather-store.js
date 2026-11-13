// 天气的「服务端事实源」：客户端把当前天气同步过来，菜园/对话都读这里
// 注意：天气本身由页面决定（UI 选择或自动轮换），服务端只保存快照。
import fs from 'node:fs';

export const WEATHER_KEYS = [
  'clear', 'rain', 'storm', 'overcast', 'fog', 'snow',
  'sleet', 'hail', 'haze', 'blizzard', 'sand', 'rainbow',
  'starry', 'aurora', 'meteor'
];

const WET = new Set(['rain', 'storm', 'sleet', 'hail']);
const SNOWY = new Set(['snow', 'blizzard', 'sleet', 'hail']);

let snapshot = { key: 'clear', intensity: 0.6, at: 0 };
let filePath = '';

export function loadWeather(path) {
  filePath = path;
  try {
    const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (raw && typeof raw.key === 'string') {
      snapshot = {
        key: WEATHER_KEYS.includes(raw.key) ? raw.key : 'clear',
        intensity: Math.max(0, Math.min(1, Number(raw.intensity) || 0.6)),
        at: Number(raw.at) || 0
      };
    }
  } catch { /* 首次没有文件 */ }
  return snapshot;
}

export function getWeather() {
  return snapshot;
}

export function setWeather(key, intensity) {
  const k = WEATHER_KEYS.includes(key) ? key : 'clear';
  const v = Math.max(0, Math.min(1, Number(intensity)));
  snapshot = { key: k, intensity: Number.isFinite(v) ? v : 0.6, at: Date.now() };
  if (filePath) {
    try { fs.writeFileSync(filePath, JSON.stringify(snapshot)); } catch { /* 忽略 */ }
  }
  return snapshot;
}

export const isWetWeather = (k = snapshot.key) => WET.has(k);
export const isSnowWeather = (k = snapshot.key) => SNOWY.has(k);
export const isStormyWeather = (k = snapshot.key) => k === 'storm' || k === 'hail';

export const WEATHER_LABEL = {
  clear: '晴天', rain: '下雨', storm: '雷雨', overcast: '阴天', fog: '有雾',
  snow: '下雪', sleet: '雨夹雪', hail: '下冰雹', haze: '有霾',
  blizzard: '暴雪', sand: '沙尘', rainbow: '有彩虹',
  starry: '星空', aurora: '极光', meteor: '流星雨'
};
