// 走廊画廊墙的自定义画面。
//
// 缘起：走廊有 4 幅画（x=10.05/10.77/11.49/12.21，z=4.52），每幅配一盏壁灯。
// 用户想「通过 QQ 让她换画」—— 所以要有一条从对话落到画布的通路。
//
// 设计要点：
//   · 存「图片」而不是「代码」：拿到 base64/URL 后落盘成文件，
//     前端只按 URL 加载，避免每换一次就往 state JSON 里塞几百 KB。
//   · 单幅独立：4 幅各自有 id（1~4），可以只换其中一幅。
//   · 可回退：没设置过就返回 null，前端继续用程序化生成的 artTexture。
//   · 尺寸限制：只收常见图片格式，<= 4MB（够 Q 群压过的图）。
import fs from 'node:fs';
import path from 'node:path';

export const GALLERY_SLOTS = Object.freeze([1, 2, 3, 4]);
export const GALLERY_MAX_BYTES = 4 * 1024 * 1024;

const EXT_BY_MIME = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif'
};

function galleryDir(stateDir) {
  return path.join(stateDir, 'gallery');
}

function manifestPath(stateDir) {
  return path.join(galleryDir(stateDir), 'manifest.json');
}

/** 读清单。坏文件当空处理，不阻塞房间启动。 */
export function loadGallery(stateDir) {
  try {
    const raw = fs.readFileSync(manifestPath(stateDir), 'utf8');
    const data = JSON.parse(raw);
    const out = {};
    for (const slot of GALLERY_SLOTS) {
      const item = data?.[slot];
      if (!item || typeof item !== 'object') continue;
      const file = String(item.file || '');
      // 只认 gallery 目录下的纯文件名，挡掉 ../ 之类的路径穿越
      if (!file || file !== path.basename(file)) continue;
      const abs = path.join(galleryDir(stateDir), file);
      if (!fs.existsSync(abs)) continue;
      out[slot] = {
        file,
        url: `/room/gallery/${encodeURIComponent(file)}`,
        at: Number(item.at) || 0,
        by: String(item.by || '').slice(0, 24),
        caption: String(item.caption || '').slice(0, 60)
      };
    }
    return out;
  } catch {
    return {};
  }
}

function saveGallery(stateDir, data) {
  const dir = galleryDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${manifestPath(stateDir)}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, manifestPath(stateDir));
}

/**
 * 写入某一幅画的图片。
 *
 * @param {string} stateDir  状态目录（服务端 STATE_DIR）
 * @param {number} slot      1~4
 * @param {Buffer} buffer    图片二进制
 * @param {string} mime      image/png 之类
 * @param {object} meta      { by, caption, at }
 * @returns {{ok:boolean, error?:string, slot?:object}}
 */
export function setGalleryImage(stateDir, slot, buffer, mime, meta = {}) {
  const id = Number(slot);
  if (!GALLERY_SLOTS.includes(id)) return { ok: false, error: `slot 只能是 ${GALLERY_SLOTS.join('/')}` };
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { ok: false, error: '没有收到图片数据' };
  if (buffer.length > GALLERY_MAX_BYTES) {
    return { ok: false, error: `图片太大（${(buffer.length / 1024 / 1024).toFixed(1)}MB，上限 4MB）` };
  }
  const ext = EXT_BY_MIME[String(mime || '').toLowerCase()];
  if (!ext) return { ok: false, error: `不支持的图片格式：${mime || '未知'}` };

  const dir = galleryDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  const data = loadGallery(stateDir);

  // 新文件用时间戳命名，天然避开浏览器缓存（URL 变了就会重新加载）
  const file = `art-${id}-${Date.now()}${ext}`;
  fs.writeFileSync(path.join(dir, file), buffer);

  // 删掉这幅画之前用的旧文件，避免目录里越堆越多
  const prev = data[id];
  if (prev?.file) {
    try { fs.unlinkSync(path.join(dir, prev.file)); } catch { /* 已经没了就算了 */ }
  }

  data[id] = {
    file,
    at: Number(meta.at) || Date.now(),
    by: String(meta.by || '').slice(0, 24),
    caption: String(meta.caption || '').slice(0, 60)
  };
  saveGallery(stateDir, data);
  return {
    ok: true,
    slot: {
      slot: id,
      file,
      url: `/room/gallery/${encodeURIComponent(file)}`,
      at: data[id].at,
      by: data[id].by,
      caption: data[id].caption
    }
  };
}

/** 清掉某一幅（回到程序化生成的默认画）。 */
export function clearGalleryImage(stateDir, slot) {
  const id = Number(slot);
  if (!GALLERY_SLOTS.includes(id)) return { ok: false, error: `slot 只能是 ${GALLERY_SLOTS.join('/')}` };
  const data = loadGallery(stateDir);
  const prev = data[id];
  if (!prev) return { ok: true, cleared: false };
  try { fs.unlinkSync(path.join(galleryDir(stateDir), prev.file)); } catch { /* 忽略 */ }
  delete data[id];
  saveGallery(stateDir, data);
  return { ok: true, cleared: true };
}

/**
 * 把清单包成客户端/提示词能用的形状。
 * 客户端用 slots 决定哪幅加载图片、哪幅用默认画。
 */
export function galleryView(stateDir) {
  const data = loadGallery(stateDir);
  return {
    slots: GALLERY_SLOTS.map((slot) => ({
      slot,
      custom: !!data[slot],
      url: data[slot]?.url || null,
      at: data[slot]?.at || 0,
      by: data[slot]?.by || '',
      caption: data[slot]?.caption || ''
    }))
  };
}

/** 给提示词用的一行摘要（让她知道自己墙上挂了什么）。 */
export function buildGalleryPromptLine(stateDir) {
  const data = loadGallery(stateDir);
  const has = GALLERY_SLOTS.filter((s) => data[s]);
  if (!has.length) return '';
  const parts = has.map((s) => {
    const c = data[s].caption || '';
    return c ? `第${s}幅是「${c}」` : `第${s}幅换过了`;
  });
  return `走廊画廊墙：${parts.join('，')}`;
}