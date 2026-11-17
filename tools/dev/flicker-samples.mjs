// The flicker samples a session logged (src/gfx/flicker-probe.js: `d3d-webgl: flicker sample: ...`, sent with the
// telemetry) as pictures: the first frame's luminance (32x24, scaled x16) with the pixels that went A-B-A (64x48) in red.
// Usage: node tools/dev/flicker-samples.mjs <telemetry .jsonl> [--session <id>] [--out <dir>]   (default out: the
// current directory; one PNG per sample: flicker-<session>-<n>.png)
import fs from 'node:fs';
import path from 'node:path';
import { encodePng } from '../../src/gfx/codecs/png.js';

const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : null; };
const file = args[0], only = opt('session'), out = opt('out') ?? '.';
if (!file) { console.error('usage: node tools/dev/flicker-samples.mjs <telemetry .jsonl> [--session <id>] [--out <dir>]'); process.exit(2); }
const K = 8; // (output pixels per mask pixel)
let n = 0;
for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!line.includes('flicker sample')) continue;
  let rec; try { rec = JSON.parse(line); } catch { continue; }
  if (only && rec.session !== only) continue;
  for (const s of rec.samples ?? [rec]) {
    const m = /flicker sample: (.*?); mask (\d+)x(\d+) ([0-9a-f]+); lum (\d+)x(\d+) ([0-9a-f]+)/.exec(s.msg ?? '');
    if (!m) continue;
    const [, what, mw, mh, mask, lw, lh, lum] = m, W = +mw, H = +mh, LW = +lw;
    const px = new Uint8Array(W * K * H * K * 4);
    for (let y = 0; y < H * K; y++) for (let x = 0; x < W * K; x++) {
      const my = H - 1 - Math.floor(y / K), mx = Math.floor(x / K), i = my * W + mx; // (rows were sent bottom first)
      const l = parseInt(lum[Math.floor(my / (H / +lh)) * LW + Math.floor(mx / (W / LW))], 16) * 17;
      const f = (parseInt(mask[i >> 2], 16) >> (3 - (i & 3))) & 1, o = 4 * (y * W * K + x);
      px[o] = f ? 255 : l; px[o + 1] = f ? 0 : l; px[o + 2] = f ? 0 : l; px[o + 3] = 255;
    }
    const f = path.join(out, `flicker-${rec.session ?? 'x'}-${n++}.png`);
    fs.writeFileSync(f, encodePng(px, W * K, H * K));
    console.log(`${f}: ${what}${s.t ? ` at ${new Date(s.t).toISOString()}` : ''}`);
  }
}
if (!n) console.log('no flicker sample in that file');
