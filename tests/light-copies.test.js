// Light copies (src/host/light-copies.js, docs/slow-network.md "Light copies"): a DDS texture without its finest mip
// levels — the format's cases —, marked in a browser port's tree and served under .light/ (its ranges, its read reports).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lightDds, lightTga, tgaLight, lightCopy, readLight, LIGHT_SIDE, TGA_LIGHT_FROM } from '../src/host/light-copies.js';
import { listGameTree } from '../src/host/game-files.js';
import { createServer } from '../src/host/server.js';

/** A DDS texture: its header (DX10's too when `dxgi`), then its levels' bytes (each level's bytes its own value). */
export function dds({ w, h, mips, four = 'DXT1', bits = 0, rgb = false, dxgi = 0, caps2 = 0, pitch = false, cut = 0 }) {
  const head = Buffer.alloc(dxgi ? 148 : 128);
  head.write('DDS ', 0, 'latin1'); head.writeUInt32LE(124, 4);
  head.writeUInt32LE(0x1007 | 0x20000 | (pitch ? 0x8 : 0x80000), 8); head.writeUInt32LE(h, 12); head.writeUInt32LE(w, 16); head.writeUInt32LE(mips, 28);
  head.writeUInt32LE(32, 76); head.writeUInt32LE(rgb ? 0x41 : 0x4, 80);
  if (!rgb) head.write(dxgi ? 'DX10' : four, 84, 'latin1'); else head.writeUInt32LE(bits, 88);
  head.writeUInt32LE(caps2, 112);
  if (dxgi) { head.writeUInt32LE(dxgi, 128); head.writeUInt32LE(3, 132); head.writeUInt32LE(1, 140); }
  const unit = rgb ? bits / 8 : dxgi ? 16 : four === 'DXT1' ? 8 : 16, levels = [];
  for (let i = 0; i < mips; i++) {
    const lw = Math.max(1, w >> i), lh = Math.max(1, h >> i);
    levels.push(Buffer.alloc(rgb ? lw * lh * unit : Math.ceil(lw / 4) * Math.ceil(lh / 4) * unit, i + 1));
  }
  const all = Buffer.concat([head, ...levels]);
  return { bytes: all.subarray(0, all.length - cut), levels, head };
}

test('a large DDS texture\'s light copy leaves its finest levels out: the same format, the header telling the smaller size', () => {
  assert.equal(LIGHT_SIDE, 256);
  const t = dds({ w: 1024, h: 1024, mips: 11 }), c = lightDds(t.bytes.subarray(0, 148), t.bytes.length), cut = t.levels[0].length + t.levels[1].length;
  assert.equal(c.from, 128 + cut); assert.equal(c.size, t.bytes.length - cut);
  assert.equal(c.head.readUInt32LE(16), 256); assert.equal(c.head.readUInt32LE(12), 256); assert.equal(c.head.readUInt32LE(28), 9);
  assert.equal(c.head.readUInt32LE(20), t.levels[2].length, 'the linear size of its first level');
  // (a long texture: its longest side down to LIGHT_SIDE, its levels as they are)
  const long = dds({ w: 2048, h: 8192, mips: 14, four: 'DXT5' }), cl = lightDds(long.bytes, long.bytes.length);
  assert.deepEqual([cl.head.readUInt32LE(16), cl.head.readUInt32LE(12), cl.head.readUInt32LE(28)], [64, 256, 9]);
  assert.deepEqual(long.bytes.subarray(cl.from, cl.from + 16), Buffer.alloc(16, 6), 'from its sixth level on');
  // (uncompressed, its pitch; DX10 with a block-compressed format)
  const rgba = dds({ w: 1024, h: 512, mips: 3, rgb: true, bits: 32, pitch: true }), cr = lightDds(rgba.bytes, rgba.bytes.length);
  assert.deepEqual([cr.head.readUInt32LE(16), cr.head.readUInt32LE(12), cr.head.readUInt32LE(20), cr.head.readUInt32LE(28)], [512, 256, 2048, 2], 'two levels kept at least');
  // (a short chain: two levels kept, its side above LIGHT_SIDE then)
  const short = dds({ w: 2048, h: 2048, mips: 4 }), cs = lightDds(short.bytes, short.bytes.length);
  assert.deepEqual([cs.head.readUInt32LE(16), cs.head.readUInt32LE(28)], [512, 2]);
  const bc7 = dds({ w: 2048, h: 2048, mips: 12, dxgi: 98 }), c7 = lightDds(bc7.bytes, bc7.bytes.length);
  assert.equal(c7.head.length, 148); assert.equal(c7.from, 148 + bc7.levels.slice(0, 3).reduce((n, l) => n + l.length, 0));
  // (nothing to gain, or not as its header says: none)
  for (const [what, x] of [['small', dds({ w: 256, h: 256, mips: 9 })], ['no levels below', dds({ w: 2048, h: 2048, mips: 1 })], ['two levels only', dds({ w: 1024, h: 1024, mips: 2 })],
    ['a cube', dds({ w: 1024, h: 1024, mips: 11, caps2: 0x200 })], ['cut short', dds({ w: 1024, h: 1024, mips: 11, cut: 9 })]]) assert.equal(lightDds(x.bytes, x.bytes.length), null, what);
  assert.equal(lightDds(Buffer.from('not a texture at all, not at all, no'), 36), null);
});

test('a browser port\'s tree tells its textures\' light size, served under .light/ and learned from read reports; a Windows game\'s does not', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-light-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const games = path.join(root, 'games'), engines = path.join(root, 'engines'), game = path.join(games, 'mw');
  fs.mkdirSync(path.join(game, 'base/Textures'), { recursive: true }); fs.mkdirSync(path.join(game, 'versions/1'), { recursive: true });
  const big = dds({ w: 1024, h: 1024, mips: 11 });
  fs.writeFileSync(path.join(game, 'base/Textures/big.dds'), big.bytes); fs.writeFileSync(path.join(game, 'base/Textures/small.dds'), dds({ w: 256, h: 256, mips: 9 }).bytes);
  fs.writeFileSync(path.join(game, 'base/Game.esm'), 'esm');
  fs.writeFileSync(path.join(game, 'manifest.json'), JSON.stringify({ schemaVersion: 1, id: 'mw', name: 'MW', defaultVersion: 'mw-1', defaults: { runtime: 'openmw' },
    versions: [{ id: 'mw-1', dir: '1', version: '1', openmw: { engine: 'e1', files: ['Game.esm'] } }] }));
  fs.mkdirSync(path.join(engines, 'e1/moddata'), { recursive: true });
  const server = createServer({ gamesDir: games, enginesDir: engines });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const cut = big.levels[0].length + big.levels[1].length, tree = await (await fetch(base + '/api/tree/mw-1')).json(), light = big.bytes.length - cut;
  assert.equal(tree.dirs.Textures.files['big.dds'].light, light); assert.equal(tree.dirs.Textures.files['small.dds'].light, undefined);
  const got = Buffer.from(await (await fetch(`${base}/gamez/mw-1/.light/Textures/big.dds?r=100-${light}`)).arrayBuffer());
  const want = Buffer.concat([lightDds(big.bytes, big.bytes.length).head, big.bytes.subarray(128 + cut)]);
  assert.deepEqual(got, want.subarray(100));
  assert.equal((await fetch(`${base}/gamez/mw-1/.light/Textures/small.dds?r=0-10`)).status, 404);
  assert.equal((await fetch(`${base}/gamez/mw-1/.light/Game.esm?r=0-3`)).status, 404);
  const prefetch = `${base}/api/prefetch/mw-1`;
  await fetch(prefetch, { method: 'POST', body: JSON.stringify({ session: 's', reads: [['.light/Textures/big.dds', 0, light, 5], ['.light/Textures/big.dds', 0, light + 1, 6]] }) });
  assert.deepEqual(await (await fetch(prefetch)).json(), [['.light/Textures/big.dds', 0, (1 << Math.ceil(light / 65536)) - 1, 5]], 'its pieces; a read past its end left out');
  // (a Windows game reads its files as they are)
  assert.equal(listGameTree({ folder: path.join(game, 'versions/1'), baseFolder: path.join(game, 'base'), lightCopies: false }).dirs.Textures.files['big.dds'].light, undefined);
});

/** An uncompressed TGA picture: its header (an image ID of `id` bytes), then its pixels (`pixel(x, y, c)`). */
function tga({ w, h, bpp = 24, type = 2, id = 0, desc = 0, cmap = 0, pixel = (x, y, c) => (x + 2 * y + 3 * c) & 255 }) {
  const px = bpp / 8, head = Buffer.alloc(18 + id);
  head[0] = id; head[1] = cmap; head[2] = type; head.writeUInt16LE(w, 12); head.writeUInt16LE(h, 14); head[16] = bpp; head[17] = desc;
  const pixels = Buffer.alloc(w * h * px);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < px; c++) pixels[(y * w + x) * px + c] = pixel(x, y, c);
  return Buffer.concat([head, pixels]);
}

test('a TGA picture of a screen\'s size has a light copy: a smaller TGA of its own, each pixel the mean of those it stands for', async (t) => {
  assert.equal(TGA_LIGHT_FROM, 1024);
  // (Morrowind's loading screens: 1024 × 1024, 24-bit, 3 MB — 256 × 256, 192 KB)
  const big = tga({ w: 1024, h: 1024, id: 5, desc: 0x20, pixel: (x, y, c) => (c === 0 ? (x % 4) * 20 : c === 1 ? 200 : (y >> 2) & 255) });
  const shape = lightTga(big, big.length);
  assert.deepEqual([shape.lw, shape.lh, shape.step, shape.size], [256, 256, 4, 18 + 256 * 256 * 3]);
  const light = tgaLight(big, shape);
  assert.equal(light.length, shape.size);
  assert.deepEqual([light[0], light[2], light.readUInt16LE(12), light.readUInt16LE(14), light[16], light[17]], [0, 2, 256, 256, 24, 0x20], 'no image ID, the same format and origin');
  // (pixel (x, y): the mean of its 4 × 4 — blue (x % 4) * 20 → 30, green 200, red the row's)
  for (const [x, y] of [[0, 0], [17, 3], [255, 255]]) assert.deepEqual([...light.subarray(18 + (y * 256 + x) * 3, 18 + (y * 256 + x) * 3 + 3)], [30, 200, y], `pixel ${x}, ${y}`);
  // (32-bit with alpha, a long one; greyscale)
  const rgba = lightTga(tga({ w: 2048, h: 512, bpp: 32, pixel: () => 7 }), 18 + 2048 * 512 * 4);
  assert.deepEqual([rgba.lw, rgba.lh, rgba.step, rgba.px], [256, 64, 8, 4]);
  const grey = tga({ w: 1024, h: 768, bpp: 8, type: 3, pixel: (x) => (x & 1 ? 100 : 0) });
  assert.deepEqual([...tgaLight(grey, lightTga(grey, grey.length)).subarray(18, 22)], [50, 50, 50, 50]);
  // (none: a smaller picture — a menu's, an icon —, a colour map, run-length encoded, interleaved, cut short)
  const rle = tga({ w: 1024, h: 1024 }); rle[2] = 10;
  for (const [what, x] of [['small', tga({ w: 512, h: 512 })], ['colour map', tga({ w: 1024, h: 1024, bpp: 8, type: 1, cmap: 1 })],
    ['run-length', rle], ['interleaved', tga({ w: 1024, h: 1024, desc: 0x40 })]]) assert.equal(lightTga(x, x.length), null, what);
  assert.equal(lightTga(big, big.length - 1), null, 'cut short');
  // (the server's copy: all of it made from the file, read by ranges)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-light-tga-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'Splash_A.tga'); fs.writeFileSync(file, big);
  const c = lightCopy(file, fs.statSync(file));
  assert.equal(c.size, shape.size); assert.equal(c.from, big.length);
  const buf = Buffer.alloc(1000);
  await new Promise((resolve, reject) => readLight(file, c, 5000, 6000, buf, 0, (err) => (err ? reject(err) : resolve())));
  assert.deepEqual(buf, light.subarray(5000, 6000));
});
