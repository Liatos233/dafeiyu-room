#!/usr/bin/env node
// 生成 public/room/assets 的内容清单（相对路径 → sha256），用于部署时对资产做增量上传。
// 用法：
//   node scripts/build-asset-manifest.mjs --out <manifest.json>
//        [--server <server-manifest.json> --changed <changed-list.txt>]
//   --out      把本地完整清单写到指定文件（不带 --out 则打印到 stdout）
//   --server   服务器旧清单文件路径（可选；不存在/空/坏 JSON 视为“无旧清单”→ 全量）
//   --changed  本地相对服务器新增/变更的文件列表（相对 public/room/assets，用 / 分隔，一行一个）
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const ASSETS = join(ROOT, 'public', 'room', 'assets');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.isFile()) out.push(p);
  }
  return out;
}

const files = walk(ASSETS);
const manifest = {};
for (const f of files) {
  const rel = relative(ASSETS, f).split(sep).join('/');
  manifest[rel] = createHash('sha256').update(readFileSync(f)).digest('hex');
}
const sorted = Object.fromEntries(Object.keys(manifest).sort().map((k) => [k, manifest[k]]));

const out = arg('--out');
const json = JSON.stringify(sorted, null, 2) + '\n';
if (out) writeFileSync(out, json, 'utf8');
else console.log(json);

const serverFile = arg('--server');
const changedFile = arg('--changed');
if (serverFile && changedFile) {
  let server = {};
  try {
    const txt = readFileSync(serverFile, 'utf8').trim();
    if (txt) server = JSON.parse(txt);
  } catch { /* 空或坏清单 → 视为无旧清单 → 全量 */ }
  const changed = [];
  for (const [rel, hash] of Object.entries(sorted)) {
    if (server[rel] !== hash) changed.push(rel);
  }
  // 删除不做自动清理（资产几乎不会删；即使删了，服务器残留一份也不影响运行）。
  writeFileSync(changedFile, changed.length ? changed.join('\n') + '\n' : '', 'utf8');
}
