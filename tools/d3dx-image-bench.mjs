#!/usr/bin/env node
// D3DX image microbenchmark (src/win32/d3dx9-image.js: the work behind D3DXLoadSurfaceFromMemory, D3DXFilterTexture and
// D3DXCreateTexture*FromFileInMemory while maps load): ms per operation (its output hashed outside the timing) on synthetic texture-like images (gradients,
// grain, hard edges, holes in the alpha), median of R runs after a warm-up, on this thread (the browser splits large
// DXT encodes with helper workers, dxt-pool.js: every block is encoded by the same function). The output bytes of
// every operation are hashed: two trees must print the same hashes (bit-identical results).
// --dir <path> loads d3dx9-image.js from another tree's src/win32 (a detached worktree of the base: before/after in one
// session; alternate the two runs to cancel the machine's load).
// Usage: node tools/d3dx-image-bench.mjs [--dir <tree>/src/win32] [--runs 9] [filter substring]
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); if (i < 0) return def; const v = args[i + 1]; args.splice(i, 2); return v; };
const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(opt('--dir', path.join(here, '../src/win32')));
const runs = +opt('--runs', 9);
const filter = args[0] ?? '';
const img = await import(pathToFileURL(path.join(dir, 'd3dx9-image.js')).href);
const { FMT } = await import(pathToFileURL(path.join(dir, 'd3d8.js')).href);

/** deterministic texture-like RGBA8: smooth gradients, grain, a few hard edges; alpha: 'opaque' | 'holes' | 'ramp' */
function texture(w, h, seed, alpha = 'opaque') {
  let s = seed >>> 0; const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 24; };
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = 4 * (y * w + x), edge = ((x >> 5) + (y >> 4)) & 1 ? 40 : 0, g = rnd() >> 4;
    px[i] = Math.min(255, (x * 200 / w + edge + g) | 0); px[i + 1] = Math.min(255, (y * 180 / h + g + 30) | 0); px[i + 2] = Math.min(255, (((x + y) * 90 / (w + h)) + edge + (g >> 1) + 60) | 0);
    px[i + 3] = alpha === 'opaque' ? 255 : alpha === 'holes' ? (((x * 7 + y * 3) % 23) < 4 ? 0 : 255) : Math.min(255, (x * 255 / w + g) | 0);
  }
  return px;
}
/** the same image as Direct3D's A8R8G8B8 bytes (B, G, R, A) */
const toBgra = (rgba) => { const o = new Uint8Array(rgba.length); for (let i = 0; i < rgba.length; i += 4) { o[i] = rgba[i + 2]; o[i + 1] = rgba[i + 1]; o[i + 2] = rgba[i]; o[i + 3] = rgba[i + 3]; } return o; };
const fnv = (u8, h = 0x811c9dc5) => { for (let i = 0; i < u8.length; i++) h = Math.imul(h ^ u8[i], 16777619) >>> 0; return h; };
/** the mip chain below a w x h RGBA8 image as D3DXFilterTexture builds it (box filter 2:1, each level from the previous one's RGBA) */
const mips = (fmt, rgba, w, h) => { const out = []; let from = rgba; for (; w > 1 || h > 1;) { const nw = Math.max(1, w >> 1), nh = Math.max(1, h >> 1); from = img.resizeRgba(from, w, h, nw, nh); out.push(img.fromRgba(fmt, from, nw, nh)); w = nw; h = nh; } return out; };
/** a TGA file (uncompressed 32-bit, bottom-up) of an RGBA8 image */
const tga = (rgba, w, h) => { const b = new Uint8Array(18 + w * h * 4); b[2] = 2; b[12] = w & 255; b[13] = w >> 8; b[14] = h & 255; b[15] = h >> 8; b[16] = 32; b[17] = 8; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const s = 4 * ((h - 1 - y) * w + x), d = 18 + 4 * (y * w + x); b[d] = rgba[s + 2]; b[d + 1] = rgba[s + 1]; b[d + 2] = rgba[s]; b[d + 3] = rgba[s + 3]; } return b; };

const T256 = texture(256, 256, 1), H256 = texture(256, 256, 2, 'holes'), R256 = texture(256, 256, 3, 'ramp'), T512 = texture(512, 512, 4);
const X256 = toBgra(T256), A256 = toBgra(R256), X512 = toBgra(T512);
const DXT1_256 = img.fromRgba(FMT.DXT1, T256, 256, 256), DXT5_256 = img.fromRgba(FMT.DXT5, R256, 256, 256);
const R565_256 = img.fromRgba(FMT.R5G6B5, T256, 256, 256), A4_256 = img.fromRgba(FMT.A4R4G4B4, R256, 256, 256);
const TGA256 = tga(R256, 256, 256);
const cases = [
  // D3DXLoadSurfaceFromMemory X8R8G8B8 256 x 256 -> DXT1 (the source read in place with its pitch, then encoded)
  ['load X8R8G8B8 256 -> DXT1', () => (img.fromRgba(FMT.DXT1, img.toRgbaRows(FMT.X8R8G8B8, X256, 256, 256, 1024), 256, 256))],
  ['load A8R8G8B8 256 -> DXT5', () => (img.fromRgba(FMT.DXT5, img.toRgbaRows(FMT.A8R8G8B8, A256, 256, 256, 1024), 256, 256))],
  ['load A8R8G8B8 256 -> DXT3', () => (img.fromRgba(FMT.DXT3, img.toRgbaRows(FMT.A8R8G8B8, A256, 256, 256, 1024), 256, 256))],
  ['load X8R8G8B8 512 -> DXT1', () => (img.fromRgba(FMT.DXT1, img.toRgbaRows(FMT.X8R8G8B8, X512, 512, 512, 2048), 512, 512))],
  ['encode DXT1 256 (holes)', () => (img.fromRgba(FMT.DXT1, H256, 256, 256))],
  // D3DXFilterTexture: the levels below 256 x 256 from the RGBA kept at the load
  ['mips DXT1 from 256', () => mips(FMT.DXT1, T256, 256, 256)],
  ['mips DXT5 from 256', () => mips(FMT.DXT5, R256, 256, 256)],
  ['mips A8R8G8B8 from 256', () => mips(FMT.A8R8G8B8, R256, 256, 256)],
  // ... from a compressed level (no RGBA kept)
  ['decode DXT1 256', () => (img.toRgba(FMT.DXT1, DXT1_256, 256, 256))],
  ['decode DXT5 256', () => (img.toRgba(FMT.DXT5, DXT5_256, 256, 256))],
  ['decode R5G6B5 256', () => (img.toRgba(FMT.R5G6B5, R565_256, 256, 256))],
  ['decode A4R4G4B4 256', () => (img.toRgba(FMT.A4R4G4B4, A4_256, 256, 256))],
  ['encode R5G6B5 256', () => (img.fromRgba(FMT.R5G6B5, T256, 256, 256))],
  ['resize 256 -> 200x100', () => (img.resizeRgba(T256, 256, 256, 200, 100))],
  ['TGA 256 image info', () => { const i = img.parseImageInfo(TGA256); return Uint32Array.of(i.width, i.height, i.depth, i.mips, i.infoFmt, i.fileFormat); }],
  ['TGA 256 parse', () => img.parseImage(TGA256).images[0][0]],
].filter(([n]) => n.includes(filter));

console.log(`d3dx9-image: ${dir}`);
let total = 0;
for (const [name, f] of cases) {
  const hash = (v) => (Array.isArray(v) ? v : [v]).reduce((h, a) => fnv(a, h), 0x811c9dc5);
  const h = hash(f());
  for (let w = 0, t0 = performance.now(); w < 3 || performance.now() - t0 < 300; w++) f(); // (warm-up: the optimizing tier)
  const t = [];
  for (let r = 0; r < runs; r++) { const t0 = performance.now(); const v = f(); t.push(performance.now() - t0); if (r === runs - 1 && hash(v) !== h) throw new Error(`${name}: result changed between runs`); }
  t.sort((a, b) => a - b);
  total += t[runs >> 1];
  console.log(`${name.padEnd(28)} ${t[runs >> 1].toFixed(3).padStart(8)} ms  (${t[0].toFixed(3)}-${t[runs - 1].toFixed(3)})  hash ${(h >>> 0).toString(16).padStart(8, '0')}`);
}
console.log(`total of medians: ${total.toFixed(2)} ms`);
