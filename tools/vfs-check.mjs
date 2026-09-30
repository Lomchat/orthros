#!/usr/bin/env node
// Byte-exactness of the served game folder: random ranges of random files fetched from the Orthros server (HTTP
// range requests, as the worker's VFS does) compared with direct reads of the same files. Bytes only — no file
// format is interpreted.
// Usage: node tools/vfs-check.mjs <manifest name | game folder> [samples]
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/host/server.js';
import { folderManifest } from '../src/host/manifest.js';
import { loadGameCatalog, defaultGameManifest } from '../src/host/game-catalog.js';
import { resolveGameFile } from '../src/host/game-files.js';

const arg = process.argv[2];
const samples = Number(process.argv[3] ?? 2000);
if (!arg) { console.error('usage: node tools/vfs-check.mjs <manifest | game folder> [samples]'); process.exit(2); }
let name = arg, manifest;
const extra = new Map();
if (fs.existsSync(arg) && fs.statSync(arg).isDirectory()) {
  manifest = fs.existsSync(path.join(arg, 'manifest.json'))
    ? defaultGameManifest(arg)
    : folderManifest(arg);
  name = 'check'; extra.set(name, manifest);
} else manifest = loadGameCatalog().get(arg);
if (!manifest) throw new Error(`unknown version: ${arg}`);

const server = createServer({ extra });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const tree = await (await fetch(`${base}/api/tree/${name}`)).json();
const files = [];
(function walk(node, rel) {
  for (const [n, f] of Object.entries(node.files ?? {})) files.push({ rel: rel ? `${rel}/${n}` : n, size: f.size });
  for (const [n, d] of Object.entries(node.dirs ?? {})) walk(d, rel ? `${rel}/${n}` : n);
})(tree, '');
const total = files.reduce((a, f) => a + f.size, 0);
let seed = 12345; const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
const pick = () => { let x = rnd() * total; for (const f of files) { if ((x -= f.size) < 0) return f; } return files[files.length - 1]; };
let bad = 0, bytes = 0;
for (let i = 0; i < samples; i++) {
  const f = i < files.length ? files[i] : pick(); // every file once, then weighted by size
  if (!f.size) continue;
  const len = Math.min(f.size, 1 + Math.floor(rnd() * (rnd() < 0.2 ? 4 << 20 : 65536)));
  const start = i < files.length && rnd() < 0.5 ? f.size - len : Math.floor(rnd() * (f.size - len + 1)); // (file ends included)
  const r = await fetch(`${base}/game/${name}/${f.rel.split('/').map(encodeURIComponent).join('/')}`, { headers: { Range: `bytes=${start}-${start + len - 1}` } });
  const got = new Uint8Array(await r.arrayBuffer());
  const want = Buffer.alloc(len); const fd = fs.openSync(resolveGameFile(manifest, f.rel), 'r'); fs.readSync(fd, want, 0, len, start); fs.closeSync(fd);
  bytes += len;
  if (r.status !== 206 || got.length !== len || Buffer.compare(Buffer.from(got), want) !== 0) { bad++; if (bad <= 10) console.log(`MISMATCH ${f.rel} [${start}, ${start + len}) status ${r.status} got ${got.length} bytes`); }
}
server.close();
console.log(`${files.length} files (${(total / 2 ** 20).toFixed(0)} MiB), ${samples} ranges, ${(bytes / 2 ** 20).toFixed(0)} MiB compared: ${bad} mismatch${bad === 1 ? '' : 'es'}`);
process.exit(bad ? 1 : 0);
