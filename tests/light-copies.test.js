// Light copies (src/host/light-copies.js, docs/slow-network.md "Light copies"): a DDS texture without its finest mip
// levels — the format's cases —, marked in a browser port's tree and served under .light/ (its ranges, its read reports).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lightDds, lightTga, tgaLight, lightCopy, readLight, esmZeroRanges, zeroWithin, LIGHT_SIDE, TGA_LIGHT_FROM, ESM_FORMAT, ESM_LIGHT_FROM } from '../src/host/light-copies.js';
import { listGameTree, resolveLightFile } from '../src/host/game-files.js';
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
  // (none: a smaller picture — a menu's, an icon —, a colour map, run-length encoded, interleaved, a strip thinner than
  // a block — its rows would be averaged with bytes past the picture —, cut short)
  const rle = tga({ w: 1024, h: 1024 }); rle[2] = 10;
  for (const [what, x] of [['small', tga({ w: 512, h: 512 })], ['colour map', tga({ w: 1024, h: 1024, bpp: 8, type: 1, cmap: 1 })],
    ['run-length', rle], ['interleaved', tga({ w: 1024, h: 1024, desc: 0x40 })], ['a ramp', tga({ w: 1024, h: 1, bpp: 32, pixel: () => 200 })],
    ['a tall strip', tga({ w: 3, h: 2048 })]]) assert.equal(lightTga(x, x.length), null, what);
  assert.equal(lightTga(tga({ w: 2048, h: 8 }), 18 + 2048 * 8 * 3).lh, 1, 'a strip as thick as a block: its one row');
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

/**
 * A WAD3 archive: miptex lumps [name, w, h] (each level's pixels a pattern of its own), then a lump of another type;
 * `again`: indices of lumps the directory lists a second time (another entry, the same bytes)
 */
function wad(textures, again = []) {
  const lumps = [];
  for (const [name, w, h] of textures) {
    const sizes = [w * h, (w * h) / 4, (w * h) / 16, (w * h) / 64], head = Buffer.alloc(40);
    head.write(name, 0, 'latin1'); head.writeUInt32LE(w, 16); head.writeUInt32LE(h, 20);
    let o = 40; for (let i = 0; i < 4; i++) { head.writeUInt32LE(o, 24 + i * 4); o += sizes[i]; }
    const levels = sizes.map((n, i) => Buffer.from(Array.from({ length: n }, (_, k) => (k * (i + 3) + (k >> 5)) & 0xff)));
    lumps.push([0x43, Buffer.concat([head, ...levels, Buffer.from([0, 1]), Buffer.alloc(768, 7), Buffer.alloc(2)])]);
  }
  lumps.push([0x42, Buffer.from('a qpic, left as it is')]);
  const parts = [Buffer.alloc(12)], dir = [];
  let at = 12;
  for (const [type, b] of lumps) { const e = Buffer.alloc(32); e.writeInt32LE(at, 0); e.writeInt32LE(b.length, 4); e.writeInt32LE(b.length, 8); e[12] = type; dir.push(e); parts.push(b); at += b.length; }
  for (const i of again) { const e = Buffer.from(dir[i]); e.write('again', 16, 'latin1'); dir.push(e); }
  parts[0].write('WAD3', 0, 'latin1'); parts[0].writeInt32LE(dir.length, 4); parts[0].writeInt32LE(at, 8);
  return Buffer.concat([...parts, ...dir]);
}

test('a WAD3 archive\'s light copy keeps its size and offsets, each texture\'s finest level redrawn from the next; any range of it reads the same', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-wad-'));
  try {
    const bytes = wad([['big', 128, 64], ['small', 32, 32], ['wide', 256, 128]]), f = path.join(dir, 'maps.WAD');
    fs.writeFileSync(f, bytes);
    const c = lightCopy(f, fs.statSync(f));
    assert.equal(c.size, bytes.length, 'the same size');
    assert.equal(c.mips.length, 8, 'two textures lightened: 32 × 32 is under WAD_LIGHT_FROM');
    const read = (a, b) => new Promise((res, rej) => { const buf = Buffer.alloc(b - a + 3); readLight(f, c, a, b, buf, 3, (e) => (e ? rej(e) : res(buf.subarray(3)))); });
    const all = await read(0, bytes.length);
    // (the expected copy: level 0 of each lightened texture from its level 1, pixel (x, y) from (x/2, y/2); the rest as it is)
    const want = Buffer.from(bytes);
    for (let k = 0; k < c.mips.length; k += 4) {
      const [d0, w, h, s1] = c.mips.slice(k, k + 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) want[d0 + y * w + x] = bytes[s1 + (y >> 1) * (w / 2) + (x >> 1)];
    }
    assert.deepEqual(all, want);
    assert.notDeepEqual(all, bytes);
    let s = 9;
    for (let i = 0; i < 40; i++) { s = (s * 1103515245 + 12345) >>> 0; const a = s % bytes.length; s = (s * 1103515245 + 12345) >>> 0; const b = a + 1 + (s % (bytes.length - a)); assert.deepEqual(await read(a, b), want.subarray(a, b), `${a}-${b}`); }
    // not a WAD3, or no texture to lighten: none
    const other = path.join(dir, 'other.wad'); fs.writeFileSync(other, Buffer.concat([Buffer.from('WAD2'), bytes.subarray(4)]));
    assert.equal(lightCopy(other, fs.statSync(other)), null);
    const tiny = path.join(dir, 'tiny.wad'); fs.writeFileSync(tiny, wad([['s', 16, 16]]));
    assert.equal(lightCopy(tiny, fs.statSync(tiny)), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a WAD3 archive whose directory lists a texture twice: each texture lightened once, the copy the same from any range', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-wad-again-'));
  try {
    const textures = [['big', 128, 64], ['wide', 256, 128]];
    const once = wad(textures), bytes = wad(textures, [1, 0]), f = path.join(dir, 'again.wad'), g = path.join(dir, 'once.wad');
    fs.writeFileSync(f, bytes); fs.writeFileSync(g, once);
    const c = lightCopy(f, fs.statSync(f)), c1 = lightCopy(g, fs.statSync(g));
    assert.equal(c.size, bytes.length);
    // (the same lumps at the same offsets: the archive differs only in its directory, after them)
    assert.deepEqual(c.mips, c1.mips, 'two textures, each once — level 0 overlapping another\'s is left out');
    assert.equal(c.mips.length, 8);
    for (let k = 4; k < c.mips.length; k += 4) assert.ok(c.mips[k] >= c.mips[k - 4] + c.mips[k - 3] * c.mips[k - 2], 'sorted, none overlapping');
    const read = (a, b) => new Promise((res, rej) => { const buf = Buffer.alloc(b - a); readLight(f, c, a, b, buf, 0, (e) => (e ? rej(e) : res(buf))); });
    const want = Buffer.from(bytes);
    for (let k = 0; k < c.mips.length; k += 4) {
      const [d0, w, h, s1] = c.mips.slice(k, k + 4);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) want[d0 + y * w + x] = bytes[s1 + (y >> 1) * (w / 2) + (x >> 1)];
    }
    assert.deepEqual(await read(0, bytes.length), want);
    assert.notDeepEqual(want, bytes);
    let s = 5;
    for (let i = 0; i < 40; i++) { s = (s * 1103515245 + 12345) >>> 0; const a = s % bytes.length; s = (s * 1103515245 + 12345) >>> 0; const b = a + 1 + (s % (bytes.length - a)); assert.deepEqual(await read(a, b), want.subarray(a, b), `${a}-${b}`); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/**
 * A BSP v30 map: lumps 0 (entities), 1 (planes) as filler bytes, lump 2 the textures — miptex [name, w, h] with their
 * pixels (each level a pattern of its own), [name, w, h, true] one its WAD holds (offsets 0), a -1 entry (left out) —,
 * then lumps 3-14 filler bytes.
 */
function bsp(textures) {
  const mips = [];
  for (const [name, w, h, external] of textures) {
    const head = Buffer.alloc(40); head.write(name, 0, 'latin1'); head.writeUInt32LE(w, 16); head.writeUInt32LE(h, 20);
    if (external) { mips.push(head); continue; }
    const sizes = [w * h, (w * h) / 4, (w * h) / 16, (w * h) / 64];
    let o = 40; for (let i = 0; i < 4; i++) { head.writeUInt32LE(o, 24 + i * 4); o += sizes[i]; }
    mips.push(Buffer.concat([head, ...sizes.map((n, i) => Buffer.from(Array.from({ length: n }, (_, k) => (k * (i + 5) + (k >> 6)) & 0xff))), Buffer.from([0, 1]), Buffer.alloc(768, 9), Buffer.alloc(2)]));
  }
  const n = mips.length + 1, dir = Buffer.alloc(4 + n * 4); dir.writeInt32LE(n, 0);
  let o = dir.length; mips.forEach((m, i) => { dir.writeInt32LE(o, 4 + i * 4); o += m.length; }); dir.writeInt32LE(-1, 4 + mips.length * 4);
  const lumps = Array.from({ length: 15 }, (_, i) => (i === 2 ? Buffer.concat([dir, ...mips]) : Buffer.from(Array.from({ length: 300 + i * 17 }, (_, k) => (k * 7 + i) & 0xff))));
  const head = Buffer.alloc(4 + 15 * 8); head.writeInt32LE(30, 0);
  let at = head.length; lumps.forEach((l, i) => { head.writeInt32LE(at, 4 + i * 8); head.writeInt32LE(l.length, 8 + i * 8); at += l.length; });
  return { bytes: Buffer.concat([head, ...lumps]), head };
}

test('a BSP v30 map has no light copy, its textures embedded or not: the engine checksums its texture lump in multiplayer (a client whose map differs from its server\'s is disconnected)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-bsp-'));
  try {
    const { bytes, head } = bsp([['wall', 128, 64], ['tiny', 32, 32], ['sky', 256, 256, true], ['floor', 64, 64]]);
    for (const name of ['c1a0.bsp', 'DE_DUST2.BSP']) {
      const f = path.join(dir, name); fs.writeFileSync(f, bytes);
      assert.equal(lightCopy(f, fs.statSync(f)), null, name);
    }
    // (what a GoldSrc page parses of a map — src/ports/goldsrc/bsp-reads.js — reads its lumps through the shared reader)
    const { bspLumps } = await import('../src/ports/goldsrc/bsp-reads.js');
    const lumps = bspLumps(bytes, bytes.length);
    assert.equal(lumps.length, 15);
    assert.deepEqual(lumps[2], { off: head.readInt32LE(4 + 2 * 8), len: head.readInt32LE(8 + 2 * 8) });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- TES3 content files

/** A TES3 subrecord: its name, its payload (a string's bytes, a buffer, or `n` bytes of `fill`). */
const sub = (name, data) => { const b = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'latin1'); const h = Buffer.alloc(8); h.write(name, 0, 'latin1'); h.writeUInt32LE(b.length, 4); return Buffer.concat([h, b]); };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const filled = (n, v) => Buffer.alloc(n, v);
/** A TES3 record: its name and subrecords. */
const rec = (name, subs) => { const body = Buffer.concat(subs), h = Buffer.alloc(16); h.write(name, 0, 'latin1'); h.writeUInt32LE(body.length, 4); return Buffer.concat([h, body]); };
/**
 * A TES3 file: its header, a LAND record, an exterior CELL with references (one with a key, one deleted, a moved
 * reference's group), an interior's, a dialogue's padding to `size`.
 */
function tes3(size = ESM_LIGHT_FROM + 4096) {
  const parts = [
    rec('TES3', [sub('HEDR', filled(300, 1))]),
    rec('CELL', [sub('NAME', 'Seyda Neen\0'), sub('DATA', filled(12, 2)), sub('RGNN', 'Bitter Coast\0'), sub('NAM0', u32(3)),
      sub('FRMR', u32(1)), sub('NAME', 'chest_small\0'), sub('XSCL', filled(4, 9)), sub('ANAM', 'fargoth\0'), sub('KNAM', 'key_chest\0'), sub('FLTV', u32(50)), sub('DATA', filled(24, 7)),
      sub('FRMR', u32(2)), sub('NAME', 'barrel_01\0'), sub('DELE', u32(0)), sub('DATA', filled(24, 8)),
      sub('MVRF', u32(5)), sub('CNDT', filled(8, 3)), sub('FRMR', u32(5)), sub('NAME', 'mudcrab\0'), sub('DATA', filled(24, 6)),
      sub('FRMR', u32(6)), sub('NAME', 'rock_01\0'), sub('DATA', filled(24, 5)), sub('XSCL', filled(4, 4))]),
    rec('LAND', [sub('INTV', filled(8, 1)), sub('DATA', u32(15)), sub('VNML', filled(12675, 0x41)), sub('VHGT', filled(4232, 0x42)),
      sub('WNAM', filled(81, 0x43)), sub('VCLR', filled(12675, 0x44)), sub('VTEX', filled(512, 0x45))]),
    rec('CELL', [sub('NAME', 'Arrille\'s Tradehouse\0'), sub('DATA', filled(12, 1)), sub('FRMR', u32(9)), sub('NAME', 'arrille\0'), sub('DATA', filled(24, 2)), sub('ANAM', 'x\0')]),
  ];
  const used = parts.reduce((n, b) => n + b.length, 0);
  parts.push(rec('INFO', [sub('INAM', filled(size - used - 24, 0x55))]));
  return Buffer.concat(parts);
}
/** The TES3 file's subrecords: [record, subrecord, payload offset, payload bytes], in order. */
function subsOf(b) {
  const out = [];
  for (let p = 0; p + 16 <= b.length;) {
    const r = b.toString('latin1', p, p + 4), e = p + 16 + b.readUInt32LE(p + 4);
    for (let s = p + 16; s + 8 <= e;) { const n = b.toString('latin1', s, s + 4), z = b.readUInt32LE(s + 4); out.push([r, n, s + 8, b.subarray(s + 8, s + 8 + z)]); s += 8 + z; }
    p = e;
  }
  return out;
}
/** A cell's references as the engine's content load counts them (ESMStore::countAllCellRefsAndMarkKeys): number, object, key, deleted. */
function refTuples(b) {
  const out = []; let cur = null;
  for (const [r, n, , d] of subsOf(b)) {
    if (r !== 'CELL') { cur = null; continue; }
    if (n === 'FRMR') out.push(cur = { num: d.readUInt32LE(0), id: '', key: '', deleted: false });
    else if (cur && n === 'NAME') cur.id = d.toString('latin1');
    else if (cur && n === 'KNAM') cur.key = d.toString('latin1');
    else if (cur && n === 'DELE') cur.deleted = true;
  }
  return out;
}

test('a TES3 content file\'s light copy: its size and offsets, the land payloads and the references\' details zeroed, what the content load reads kept', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-esm-'));
  try {
    const bytes = tes3(), f = path.join(dir, 'Morrowind.esm');
    fs.writeFileSync(f, bytes);
    const c = lightCopy(f, fs.statSync(f));
    assert.equal(c.size, bytes.length, 'the same size');
    assert.equal(c.format, ESM_FORMAT);
    const read = (a, b) => new Promise((res, rej) => { const buf = Buffer.alloc(b - a + 3); readLight(f, c, a, b, buf, 3, (e) => (e ? rej(e) : res(buf.subarray(3)))); });
    const all = await read(0, bytes.length);
    // (every record and subrecord header in place: the same subrecords at the same offsets)
    assert.deepEqual(subsOf(all).map(([r, n, at, d]) => [r, n, at, d.length]), subsOf(bytes).map(([r, n, at, d]) => [r, n, at, d.length]));
    const zeroed = (d) => d.every((x) => x === 0);
    const light = subsOf(all), real = subsOf(bytes);
    for (let i = 0; i < real.length; i++) {
      const [r, n] = real[i], kept = light[i][3].equals(real[i][3]);
      const what = `${r}.${n} #${i}`;
      if (r === 'LAND') assert.equal(kept, ['INTV', 'DATA', 'WNAM'].includes(n), what);
      if (r === 'LAND' && !kept) assert.ok(zeroed(light[i][3]), what);
    }
    // (a cell's own header kept; each reference's number, object, key and deleted flag kept, its details zeroed; a moved
    // reference's group kept whole — the content load reads it all: Store<Cell>::handleMovedCellRefs)
    const cell = (i) => light[i][3], at = (r, n, k = 0) => real.map((x, i) => [x, i]).filter(([x]) => x[0] === r && x[1] === n)[k][1];
    for (const n of ['NAME', 'DATA', 'RGNN', 'NAM0']) assert.ok(cell(at('CELL', n)).equals(real[at('CELL', n)][3]), `the header's ${n}`);
    assert.ok(zeroed(cell(at('CELL', 'XSCL'))) && zeroed(cell(at('CELL', 'ANAM'))) && zeroed(cell(at('CELL', 'FLTV'))), 'details of reference 1');
    assert.ok(zeroed(cell(at('CELL', 'DATA', 1))) && zeroed(cell(at('CELL', 'DATA', 2))), 'positions of references 1 and 2');
    assert.ok(cell(at('CELL', 'DATA', 3)).equals(real[at('CELL', 'DATA', 3)][3]), 'the moved reference\'s position kept');
    assert.ok(cell(at('CELL', 'CNDT')).equals(real[at('CELL', 'CNDT')][3]));
    assert.ok(zeroed(cell(at('CELL', 'DATA', 4))) && zeroed(cell(at('CELL', 'XSCL', 1))), 'the reference after the moved group: zeroed again');
    assert.ok(zeroed(cell(at('CELL', 'DATA', 6))) && zeroed(cell(at('CELL', 'ANAM', 1))), 'an interior\'s references too');
    assert.ok(cell(at('INFO', 'INAM')).equals(real[at('INFO', 'INAM')][3]), 'other records as they are');
    assert.deepEqual(refTuples(all), refTuples(bytes), 'the references the content load counts: the same');
    assert.deepEqual(refTuples(bytes).map((r) => [r.num, r.key, r.deleted]), [[1, 'key_chest\0', false], [2, '', true], [5, '', false], [6, '', false], [9, '', false]]);
    // (any range reads as the whole copy's bytes there; the map made once, sorted, its ranges merged)
    let seed = 7;
    for (let k = 0; k < 40; k++) {
      seed = (seed * 1103515245 + 12345) >>> 0; const a = seed % bytes.length; seed = (seed * 1103515245 + 12345) >>> 0;
      const b = Math.min(bytes.length, a + 1 + (seed % 40000));
      assert.deepEqual(await read(a, b), all.subarray(a, b), `${a}-${b}`);
    }
    const z = esmZeroRanges(bytes);
    for (let i = 2; i < z.length; i += 2) assert.ok(z[i] > z[i - 1], 'sorted, apart');
    // (a job's share: the ranges within a unit, clipped)
    const mid = (z[0] + z[1]) >> 1, w = zeroWithin(z, mid, z[3]);
    assert.deepEqual([...w], [mid, z[1], z[2], z[3]]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a TES3 file has a light copy from ESM_LIGHT_FROM on, by its header (not its name alone); its tree marks it only for an engine that reads it light', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-esm-'));
  try {
    fs.mkdirSync(path.join(dir, 'base'));
    fs.writeFileSync(path.join(dir, 'base', 'Big.esm'), tes3());
    fs.writeFileSync(path.join(dir, 'base', 'Small.esp'), tes3(64 << 10));
    fs.writeFileSync(path.join(dir, 'base', 'Fake.esm'), Buffer.alloc(ESM_LIGHT_FROM + 10, 1));
    const stat = (n) => fs.statSync(path.join(dir, 'base', n));
    assert.equal(lightCopy(path.join(dir, 'base', 'Big.esm'), stat('Big.esm')).size, stat('Big.esm').size);
    assert.equal(lightCopy(path.join(dir, 'base', 'Small.esp'), stat('Small.esp')), null, 'under ESM_LIGHT_FROM');
    assert.equal(lightCopy(path.join(dir, 'base', 'Fake.esm'), stat('Fake.esm')), null, 'no TES3 header');
    const man = { folder: path.join(dir, 'v'), baseFolder: path.join(dir, 'base'), lightCopies: true };
    assert.equal(listGameTree(man).files['Big.esm'].light, undefined, 'an engine that does not say it reads it light: not marked');
    assert.equal(listGameTree(man, null, null, { contentLight: true }).files['Big.esm'].light, stat('Big.esm').size);
    assert.equal(listGameTree({ ...man, lightCopies: false }, null, null, { contentLight: true }).files['Big.esm'].light, undefined, 'a Windows game');
    // (served the same way: resolveLightFile)
    assert.equal(resolveLightFile(man, '.light/Big.esm'), null, 'not served to an engine that reads the file');
    assert.equal(resolveLightFile(man, '.light/Big.esm', null, { contentLight: true }).copy.size, stat('Big.esm').size);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a TES3 copy\'s map made asynchronously, the same as esmZeroRanges\'; a file gone when it is made: the read fails, nothing thrown', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orthros-esm-map-'));
  try {
    // (records past ESM_WALK_SLICE: the walk resumed between turns of the event loop)
    const file = path.join(dir, 'Big.esm'), bytes = tes3(3 << 20); fs.writeFileSync(file, bytes);
    const c = lightCopy(file, fs.statSync(file));
    const z = await c.zeroMap();
    assert.deepEqual([...z], [...esmZeroRanges(bytes)]); assert.equal(c.zeroMap(), c.zeroMap(), 'made once');
    const gone = path.join(dir, 'Gone.esm'); fs.writeFileSync(gone, bytes);
    const g = lightCopy(gone, fs.statSync(gone)); fs.rmSync(gone);
    const err = await new Promise((r) => readLight(gone, g, 0, 100, Buffer.alloc(100), 0, r));
    assert.ok(err, 'the read fails');
    fs.writeFileSync(gone, bytes);
    assert.equal(await new Promise((r) => readLight(gone, g, 0, 100, Buffer.alloc(100), 0, r)), null, 'a failure not kept: made again');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
