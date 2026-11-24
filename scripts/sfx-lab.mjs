#!/usr/bin/env node
// 打开音效试听台。
//
// 为什么不走 bridge：bridge 的 /room/ 优先发 dist/room 里的构建产物，
// 而试听页是开发工具、不进 vite 构建（vite 的 input 只有 index.html），
// 所以 /room/sfx-lab.html 会 404。这里单独起一个小服务器伺候 public/room，
// 好处是改 sfx.js 刷新就生效，不用 npm run build。
//
// 跑法：npm run sfx:lab
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, extname, dirname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', 'public', 'room');
const PORT = Number(process.env.SFX_LAB_PORT) || 5199;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const srv = createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const rel = normalize(urlPath.replace(/^\/+/, '') || 'sfx-lab.html');
  const file = join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  if (!existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`404 ${rel}\n（试听页在 public/room/sfx-lab.html）`);
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
    'access-control-allow-origin': '*',
  });
  createReadStream(file).pipe(res);
});

srv.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/sfx-lab.html`;
  console.log(`音效试听台：${url}`);
  console.log('改 sfx.js / 加素材后刷新即可生效，不用 build。Ctrl+C 退出。');
  // 有 GUI 就顺手打开；没有（CI/远程）就只打印地址
  if (!process.env.SFX_LAB_NO_OPEN) {
    try {
      if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
      else if (process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
      else spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    } catch { /* 打不开就算了，地址已经打印了 */ }
  }
});