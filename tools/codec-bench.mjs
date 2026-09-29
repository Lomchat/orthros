#!/usr/bin/env node
// Image codec microbenchmark (the JPEG / PNG / inflate decoders D3DX and GDI+ use to load textures): ms per decode of
// synthetic texture-like images (tools/gen/codec_images.py: gradients, grain, hard edges; 256/512/1024 squared; JPEG
// q50-q90 4:2:0 / 4:2:2 / 4:4:4 / progressive / gray; PNG RGB / RGBA / palette / smooth RGBA), median of R runs after
// a warm-up, and the difference to PIL's decode of the same file (max and mean absolute per channel: 0 for PNG, the
// IDCT's rounding for JPEG). --dir <path> loads jpeg.js / png.js from another directory (a copy of the previous
// version, for before/after in one session; alternate the two to cancel the machine's load).
// Usage: node tools/codec-bench.mjs [--dir src/gfx/codecs] [--runs 7] [--images /tmp/imgbench] [filter substring]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(opt('--dir', path.join(here, '../src/gfx/codecs')));
const runs = +opt('--runs', 7);
const images = opt('--images', '/tmp/orthros-codec-images');
const filter = args[0] ?? '';
if (!fs.existsSync(path.join(images, 't1024_ui.png.rgba'))) {
  const r = spawnSync('python3', [path.join(here, 'gen/codec_images.py'), images], { stdio: 'inherit' });
  if (r.status) process.exit(1);
}
const { decodeJpeg } = await import(pathToFileURL(path.join(dir, 'jpeg.js')).href);
const { decodePng } = await import(pathToFileURL(path.join(dir, 'png.js')).href);

const names = fs.readdirSync(images).filter((n) => /\.(jpg|png)$/.test(n) && n.includes(filter)).sort((a, b) => {
  const sa = +a.match(/^t(\d+)/)[1], sb = +b.match(/^t(\d+)/)[1];
  return sa - sb || a.localeCompare(b);
});
let total = 0;
console.log(`codecs: ${dir}`);
for (const n of names) {
  const bytes = new Uint8Array(fs.readFileSync(path.join(images, n)));
  const ref = fs.readFileSync(path.join(images, n + '.rgba'));
  const dec = n.endsWith('.jpg') ? decodeJpeg : decodePng;
  let img = dec(bytes); // (warm-up: until the optimizing tier has settled)
  for (let w = 0, t0 = performance.now(); w < 3 || performance.now() - t0 < 400; w++) img = dec(bytes);
  const t = [];
  for (let r = 0; r < runs; r++) { const t0 = performance.now(); img = dec(bytes); t.push(performance.now() - t0); }
  t.sort((a, b) => a - b);
  let max = 0, sum = 0;
  for (let i = 0; i < ref.length; i++) { const d = Math.abs(img.data[i] - ref[i]); if (d > max) max = d; sum += d; }
  total += t[runs >> 1];
  console.log(`${n.padEnd(20)} ${(bytes.length / 1024).toFixed(0).padStart(5)} KB  ${t[runs >> 1].toFixed(2).padStart(8)} ms  (${t[0].toFixed(2)}-${t[runs - 1].toFixed(2)})  vs PIL max ${max} mean ${(sum / ref.length).toFixed(3)}`);
}
console.log(`total of medians: ${total.toFixed(1)} ms`);
