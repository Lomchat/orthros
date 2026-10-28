// Light copies (docs/slow-network.md "Light copies"): a game file in a format Orthros knows how to lighten, served
// smaller beside it — a texture without its finest levels of detail — so that a slow link shows the game sooner; the
// file itself comes after, in the background, for the next time the engine loads it. Derived from the file at each
// request (head bytes of its own, then a run of the file's: nothing stored, the game files never changed), by format,
// for every game whose runtime reads them (manifest.lightCopies: the browser ports — a Windows game reads its files as
// they are). Served under LIGHT_DIR (/gamez/<manifest>/.light/<path>); the tree tells each file's light size (`light`).
import fs from 'node:fs';
import { LIGHT_DIR, isLightContent } from '../vfs/game-tree.js';
import { WAD_ENTRY, WAD_MIPTEX, MIPTEX_HEADER, MIP_LIGHT_FROM, wadEntries, wadHeader, miptexLevels, redrawFinest } from '../vfs/wad3.js';

export { LIGHT_DIR };
/**
 * A light texture's longest side, at most: the size of a game's own textures in the early 2000s, a texture pack's being
 * 1024 to 4096 (measured on a texture pack's first reads, 363 MB: light copies of 199 MB at 1024, 78 MB at 512, 24 MB
 * at 256).
 */
export const LIGHT_SIDE = 256;
/** Light copies found, by file version: least recently used out first. */
const MAX_KNOWN = 65536;
const known = new Map();

/**
 * The light copy of `file` (`st`: its fs.Stats): { size, head, from, mips? } — its bytes: `head`, then the file's from
 * `from` on, up to `size` in all; with `mips` (a WAD3's, see lightWad), the file's own bytes with those finest levels
 * redrawn from the next ones — or null (not a format Orthros lightens, or nothing to gain).
 * Never a GoldSrc map's (.bsp), although its texture lump is WAD3's miptex: the engine checksums a map's lumps from the
 * planes on, the textures' among them, when it plays with more than one player (Xash3D CRC32_MapFile) and a client
 * whose map differs from its server's is disconnected; the page's server and client open the map each on its own, and
 * which copy each read would follow the link, the store's state — a light map is no light copy.
 */
export function lightCopy(file, st) {
  const dds = /\.dds$/i.test(file), wad = !dds && /\.wad$/i.test(file), esm = !dds && !wad && isLightContent(file);
  if (!dds && !wad && !esm && !/\.tga$/i.test(file)) return null;
  const key = `${file}\0${st.size}\0${st.mtimeMs}`;
  let c = known.get(key);
  if (c !== undefined) { known.delete(key); known.set(key, c); return c; }
  c = null;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(148); const n = fs.readSync(fd, head, 0, 148, 0);
      if (wad) c = mipCopy(lightWad(fd, head.subarray(0, n), st.size), st.size);
      else if (esm) c = lightEsm(head.subarray(0, n), st.size) ? esmCopy(file, st) : null;
      else if (dds) c = lightDds(head.subarray(0, n), st.size);
      else { const t = lightTga(head.subarray(0, n), st.size); if (t) c = tgaCopy(file, st, t); }
    } finally { fs.closeSync(fd); }
  } catch { return null; } // (a failure to read it — a file being replaced, no descriptor left —: not remembered)
  known.set(key, c);
  if (known.size > MAX_KNOWN) known.delete(known.keys().next().value);
  return c;
}

/** Bytes [start, end) of a light copy (`c` of `file`), into `buf` at `at`; `done(err)`. */
export function readLight(file, c, start, end, buf, at, done) {
  if (c.mips) return readMipLight(file, c, start, end, buf, at, done);
  if (c.format === ESM_FORMAT) return readEsmLight(file, c, start, end, buf, at, done);
  const h = c.head.length;
  if (start < h) c.head.copy(buf, at, start, Math.min(end, h));
  if (end <= h) return done(null);
  const from = Math.max(start, h), len = end - from;
  fs.open(file, 'r', (err, fd) => {
    if (err) return done(err);
    fs.read(fd, buf, at + from - start, len, c.from + from - h, (err2, n) => {
      fs.close(fd, () => {});
      done(err2 ?? (n === len ? null : new Error('short read')));
    });
  });
}

// ---------------------------------------------------------------- DDS: a texture with its mip levels

const DDSD_PITCH = 0x8, DDSD_LINEARSIZE = 0x80000, DDSD_DEPTH = 0x800000;
const DDPF_ALPHA = 0x2, DDPF_FOURCC = 0x4, DDPF_RGB = 0x40, DDPF_LUMINANCE = 0x20000;
const DDSCAPS2_CUBEMAP = 0x200, DDSCAPS2_VOLUME = 0x200000;
/** Bytes per 4×4 block of the compressed formats (FourCC; DXGI formats of a DX10 header below). */
const FOURCC_BLOCK = { DXT1: 8, DXT2: 16, DXT3: 16, DXT4: 16, DXT5: 16, ATI1: 8, BC4U: 8, BC4S: 8, ATI2: 16, BC5U: 16, BC5S: 16 };
/** DXGI format → [bytes per block (compressed) or per pixel, compressed] */
function dxgi(f) {
  if (f >= 70 && f <= 72) return [8, true];      // BC1
  if (f >= 73 && f <= 78) return [16, true];     // BC2, BC3
  if (f >= 79 && f <= 81) return [8, true];      // BC4
  if (f >= 82 && f <= 84) return [16, true];     // BC5
  if (f >= 94 && f <= 99) return [16, true];     // BC6H, BC7
  if ((f >= 27 && f <= 32) || (f >= 87 && f <= 93)) return [4, false]; // R8G8B8A8, B8G8R8A8/X8
  return null;
}

/**
 * The light copy of a DDS texture whose file starts with `head` (its first 148 bytes at least, when there are) and has
 * `size` bytes: its finest mip levels left out, down to LIGHT_SIDE and two levels left at least — the same format, its
 * header telling the smaller size and the fewer levels, the remaining levels as they are. Null when the texture is
 * small already, has fewer than three levels (a picture drawn as it is: a menu's), is a cube or a volume, or is not as
 * its header says.
 */
export function lightDds(head, size) {
  if (head.length < 128 || head.toString('latin1', 0, 4) !== 'DDS ' || head.readUInt32LE(4) !== 124) return null;
  const flags = head.readUInt32LE(8), h = head.readUInt32LE(12), w = head.readUInt32LE(16), mips = head.readUInt32LE(28);
  const pf = head.readUInt32LE(80), four = head.toString('latin1', 84, 88), bits = head.readUInt32LE(88), caps2 = head.readUInt32LE(112);
  if (!w || !h || mips < 2 || mips > 32 || caps2 & (DDSCAPS2_CUBEMAP | DDSCAPS2_VOLUME) || (flags & DDSD_DEPTH && head.readUInt32LE(24) > 1)) return null;
  let headLen = 128, unit, compressed;
  if (pf & DDPF_FOURCC && four === 'DX10') {
    if (head.length < 148) return null;
    const d = dxgi(head.readUInt32LE(128)), dim = head.readUInt32LE(132), misc = head.readUInt32LE(136), arr = head.readUInt32LE(140);
    if (!d || dim !== 3 || misc & 0x4 || arr !== 1) return null; // (a 2D texture, one of it, not a cube)
    [unit, compressed] = d; headLen = 148;
  } else if (pf & DDPF_FOURCC) {
    unit = FOURCC_BLOCK[four]; compressed = true;
    if (!unit) return null;
  } else if (pf & (DDPF_RGB | DDPF_LUMINANCE | DDPF_ALPHA) && bits && bits % 8 === 0 && bits <= 128) { unit = bits / 8; compressed = false; }
  else return null;
  const levelBytes = (i) => {
    const lw = Math.max(1, w >>> i), lh = Math.max(1, h >>> i);
    return compressed ? Math.max(1, Math.ceil(lw / 4)) * Math.max(1, Math.ceil(lh / 4)) * unit : lw * lh * unit;
  };
  // (two levels kept at least: an engine meeting a compressed texture without stored levels may stop mipmapping it for
  // good — a mipmapping filter turned off — even once its file replaces the light copy in place)
  let k = 0;
  while (k < mips - 2 && Math.max(w >>> k, h >>> k) > LIGHT_SIDE) k++;
  if (k === 0) return null;
  let total = 0, skipped = 0;
  for (let i = 0; i < mips; i++) { const n = levelBytes(i); total += n; if (i < k) skipped += n; }
  if (headLen + total > size) return null; // (fewer bytes than its levels: not as its header says)
  const out = Buffer.from(head.subarray(0, headLen));
  const lw = Math.max(1, w >>> k), lh = Math.max(1, h >>> k);
  out.writeUInt32LE(lh, 12); out.writeUInt32LE(lw, 16); out.writeUInt32LE(mips - k, 28);
  if (flags & DDSD_LINEARSIZE) out.writeUInt32LE(levelBytes(k), 20);
  else if (flags & DDSD_PITCH) out.writeUInt32LE(compressed ? Math.max(1, Math.ceil(lw / 4)) * unit : lw * unit, 20);
  return { size: headLen + total - skipped, head: out, from: headLen + skipped };
}

// ---------------------------------------------------------------- TGA: a picture of a screen's size, uncompressed

/**
 * A TGA picture is lightened from this longest side on: a picture of a screen's size, 3 MB and more as it is (a loading
 * screen's, a map's) — a smaller one may be a picture drawn at its own size (a menu's, an icon), left as it is.
 */
export const TGA_LIGHT_FROM = 1024;
/** The generated light pictures kept (bytes), least recently used out first: made again from the file when needed. */
const TGA_KEPT_BYTES = 32 << 20;
const tgaKept = new Map();
let tgaKeptBytes = 0;

/**
 * The light shape of an uncompressed TGA picture whose file starts with `head` (its first 18 bytes at least) and has
 * `size` bytes: { w, h, px, at, step, lw, lh, size } — the picture `step` times smaller on each side (a power of two),
 * its longest side LIGHT_SIDE at most, `size` bytes as a TGA of its own (the same pixel format and origin, no image ID) —
 * or null: not a truecolour (24/32-bit) or greyscale (8-bit) picture stored as it is (a colour map, run-length encoding,
 * interleaved rows), smaller than TGA_LIGHT_FROM, or not as its header says.
 */
export function lightTga(head, size) {
  if (head.length < 18) return null;
  const idLen = head[0], cmap = head[1], type = head[2], w = head.readUInt16LE(12), h = head.readUInt16LE(14), bpp = head[16], desc = head[17];
  if (cmap !== 0 || !(type === 2 ? bpp === 24 || bpp === 32 : type === 3 && bpp === 8) || desc & 0xc0) return null;
  if (!w || !h || Math.max(w, h) < TGA_LIGHT_FROM) return null;
  const px = bpp / 8, at = 18 + idLen;
  if (at + w * h * px > size) return null;
  let step = 1; while (Math.max(w, h) / step > LIGHT_SIDE) step *= 2;
  if (Math.min(w, h) < step) return null; // (a strip thinner than a block — 1024 × 1, a ramp —: left as it is)
  const lw = Math.floor(w / step), lh = Math.floor(h / step);
  return { w, h, px, at, step, lw, lh, size: 18 + lw * lh * px };
}

/**
 * The light picture of a TGA (`t`: its lightTga shape, `bytes`: the file): its header (no image ID), then each pixel the
 * mean of the `step` × `step` pixels it stands for, channel by channel, the rows in the file's order.
 */
export function tgaLight(bytes, t) {
  const out = Buffer.alloc(t.size), { w, px, at, step, lw, lh } = t, n = step * step;
  bytes.copy(out, 0, 0, 18); out[0] = 0;
  out.writeUInt16LE(0, 8); out.writeUInt16LE(0, 10); out.writeUInt16LE(lw, 12); out.writeUInt16LE(lh, 14);
  const sum = new Uint32Array(lw * px);
  for (let y = 0; y < lh; y++) {
    sum.fill(0);
    for (let dy = 0; dy < step; dy++) {
      let i = at + ((y * step + dy) * w) * px;
      for (let x = 0; x < lw; x++) for (let dx = 0; dx < step; dx++) for (let c = 0; c < px; c++) sum[x * px + c] += bytes[i++];
    }
    const row = 18 + y * lw * px;
    for (let k = 0; k < lw * px; k++) out[row + k] = Math.round(sum[k] / n);
  }
  return out;
}

/** A TGA's light copy for readLight: all of it in `head`, made from the file when read (kept a while: tgaKept). */
function tgaCopy(file, st, t) {
  const key = `${file}\0${st.size}\0${st.mtimeMs}`;
  return {
    size: t.size, from: st.size,
    get head() {
      let b = tgaKept.get(key);
      if (b) { tgaKept.delete(key); tgaKept.set(key, b); return b; }
      b = tgaLight(fs.readFileSync(file), t);
      tgaKept.set(key, b); tgaKeptBytes += b.length;
      for (const [k, v] of tgaKept) { if (tgaKeptBytes <= TGA_KEPT_BYTES || k === key) break; tgaKept.delete(k); tgaKeptBytes -= v.length; }
      return b;
    },
  };
}

// ---------------------------------------------------------------- WAD3: GoldSrc's texture archives

/** A WAD texture is lightened from this many pixels on (64 × 64: smaller ones save nothing worth their detail). */
export const WAD_LIGHT_FROM = MIP_LIGHT_FROM;
const EMPTY = Buffer.alloc(0);

/**
 * The light shape of a WAD3 archive (GoldSrc's textures, 8-bit palette indices with four mip levels each) whose file
 * starts with `head` and has `size` bytes, its directory read from `fd`: the copy keeps the file's size and every
 * offset — the same archive, so that an engine that reads part of it as one and part as the other still reads a valid
 * archive —, each texture's finest level redrawn from the next one (each pixel of level 1 twice as wide and high:
 * half the detail, and bytes brotli finds again and again: halflife.wad 0.62 → 0.35 of its bytes, Counter-Strike's map
 * WADs 0.70-0.89 → 0.35-0.43). `mips`: [level 0 offset, width, height, level 1 offset, …] (file offsets), sorted. Null:
 * not a WAD3, or no texture to lighten (uncompressed miptex of WAD_LIGHT_FROM pixels or more, its levels in order
 * inside its lump).
 */
export function lightWad(fd, head, size) {
  const hd = wadHeader(head, size); if (!hd) return null;
  const d = Buffer.alloc(hd.n * WAD_ENTRY);
  if (fs.readSync(fd, d, 0, d.length, hd.dir) !== d.length) return null;
  const lumps = wadEntries(d, hd.n, size).filter((e) => e.type === WAD_MIPTEX && e.comp === 0 && e.disk >= MIPTEX_HEADER).map((e) => [e.pos, e.disk]);
  return mipsOf(fd, lumps);
}

/**
 * The textures to lighten among the miptex at `lumps` ([file offset, bytes of the file its own from there]): their
 * miptexLevels, sorted by level 0's offset, none whose level 0 overlaps another's (an archive's directory pointing
 * twice into the same bytes: left as it is) — or null when none.
 */
function mipsOf(fd, lumps) {
  const found = [], mt = Buffer.alloc(MIPTEX_HEADER);
  for (const [pos, span] of lumps.sort((a, b) => a[0] - b[0])) {
    if (fs.readSync(fd, mt, 0, MIPTEX_HEADER, pos) !== MIPTEX_HEADER) return null;
    const m = miptexLevels(mt, pos, span); if (m) found.push(m);
  }
  found.sort((a, b) => a[0] - b[0]);
  const mips = [];
  let after = 0;
  for (const m of found) { if (m[0] < after) continue; mips.push(...m); after = m[0] + m[1] * m[2]; }
  return mips.length ? mips : null;
}
function mipCopy(mips, size) { return mips ? { size, head: EMPTY, from: 0, mips } : null; }

/** Bytes [start, end) of a WAD's light copy: the file's, with the finest levels inside the range redrawn. */
function readMipLight(file, c, start, end, buf, at, done) {
  const m = c.mips;
  // (the textures whose finest level the range overlaps; their next level lies after it in the file: one read of the
  // range and of what those levels need past it)
  let lo = 0, hi = m.length / 4;
  while (lo < hi) { const k = (lo + hi) >> 1; if (m[k * 4] + m[k * 4 + 1] * m[k * 4 + 2] <= start) lo = k + 1; else hi = k; }
  let readEnd = end;
  for (let k = lo; k < m.length / 4 && m[k * 4] < end; k++) readEnd = Math.max(readEnd, m[k * 4 + 3] + (m[k * 4 + 1] / 2) * (m[k * 4 + 2] / 2));
  readEnd = Math.min(readEnd, c.size);
  const tmp = readEnd > end ? Buffer.alloc(readEnd - start) : null, into = tmp ?? buf, base = tmp ? 0 : at;
  fs.open(file, 'r', (err, fd) => {
    if (err) return done(err);
    fs.read(fd, into, base, readEnd - start, start, (err2, n) => {
      fs.close(fd, () => {});
      if (err2 || n !== readEnd - start) return done(err2 ?? new Error('short read'));
      for (let k = lo; k < m.length / 4 && m[k * 4] < end; k++) redrawFinest(into, base, start, end, m[k * 4], m[k * 4 + 1], m[k * 4 + 2], m[k * 4 + 3] - start + base);
      if (tmp) tmp.copy(buf, at, 0, end - start);
      done(null);
    });
  });
}

// ---------------------------------------------------------------- TES3: the content files of Morrowind's engine

/**
 * A TES3 content file (game-tree.js isLightContent: .esm, .esp, .omwaddon, .omwgame) has a light copy from this size on
 * (a plugin of a few records saves nothing worth a second copy of its pieces).
 */
export const ESM_LIGHT_FROM = 1 << 20;
/** The most bytes of a TES3 file read to make its light copy's map (one read of the whole file: ~80 MB for Morrowind.esm). */
const ESM_LIGHT_MAX = 512 << 20;
/** The light copy's format in br-cache.js's key: a version of its rules (another rule, other units). */
export const ESM_FORMAT = 'tes3-1';
const fourcc = (b, at) => b.readUInt32LE(at);
const cc = (s) => Buffer.from(s, 'latin1').readUInt32LE(0);
const LAND = cc('LAND'), CELL = cc('CELL'), FRMR = cc('FRMR'), MVRF = cc('MVRF');
/** a LAND record's payloads the engine reads only when its cell loads (OpenMW's ESM::Land::load skips them: loadData) */
const LAND_LATER = new Set(['VNML', 'VHGT', 'VCLR', 'VTEX'].map(cc));
/**
 * a cell reference's subrecords the content load reads (ESMStore::countAllCellRefsAndMarkKeys: the reference's number,
 * its object, its key, deleted or not; Store<Cell>::handleMovedCellRefs: a moved reference's target) — the others
 * (position, scale, owner, lock, …) only when the cell loads (CellStore::loadRefs)
 */
const REF_KEPT = new Set(['FRMR', 'NAME', 'KNAM', 'DELE', 'MVRF', 'CNDT'].map(cc));

/** The file whose first bytes are `head` (16 at least) and of `size` bytes is a TES3 content file worth a light copy. */
export function lightEsm(head, size) {
  return head.length >= 16 && head.toString('latin1', 0, 4) === 'TES3' && size >= ESM_LIGHT_FROM && size <= ESM_LIGHT_MAX;
}

/**
 * The payloads a TES3 file's light copy leaves zeroed (`bytes`: the whole file): [start0, end0, start1, end1, …] (file
 * offsets, sorted, end exclusive) — every byte else as in the file: its records, their headers and every subrecord's
 * 8-byte header, so the copy has the file's size and offsets and parses as the same records (an engine that reads part
 * of it as one and part as the other reads a valid file). Zeroed, the bytes an engine of Morrowind's content reads only
 * when a cell loads, not at its content load (docs/slow-network.md "Content files light before the menu"):
 * - a LAND record's VNML, VHGT, VCLR and VTEX (normals, heights, colours, texture indices; its INTV, DATA and WNAM —
 *   the global map's — kept): 38 of Morrowind.esm's 80 MB;
 * - in a CELL record, from its first reference on (its own header kept: name, flags, region, water, ambient light),
 *   each reference's subrecords but FRMR, NAME, KNAM, DELE (what the content load counts: number, object, key,
 *   deleted), a moved reference's group (MVRF, its target, the FRMR group after them) kept whole — the content load
 *   reads all of it (handleMovedCellRefs).
 * A record cut short by the file's end ends the walk (what follows kept as it is).
 */
export function esmZeroRanges(bytes) {
  const out = [];
  esmZeroWalk(bytes, 0, Infinity, out);
  return Uint32Array.from(out);
}

/**
 * esmZeroRanges' walk of `bytes` from the record at `pos`, the records starting before `until`: their ranges appended to
 * `out` (merged with its last); the next record's offset, `bytes.length` once the walk is over (a record cut short too).
 */
function esmZeroWalk(bytes, pos, until, out) {
  const n = bytes.length;
  const zero = (a, b) => { if (b > a) { if (out.length && out[out.length - 1] === a) out[out.length - 1] = b; else out.push(a, b); } };
  for (; pos + 16 <= n && pos < until;) {
    const name = fourcc(bytes, pos), end = pos + 16 + bytes.readUInt32LE(pos + 4);
    if (end > n) return n;
    if (name === LAND || name === CELL) {
      // (in a CELL: refs — a reference seen —, moved — an MVRF since the last FRMR —, keep — this group kept whole)
      let refs = false, moved = false, keep = false;
      for (let s = pos + 16; s + 8 <= end;) {
        const sub = fourcc(bytes, s), e = s + 8 + bytes.readUInt32LE(s + 4);
        if (e > end) break;
        if (name === LAND) { if (LAND_LATER.has(sub)) zero(s + 8, e); }
        else if (sub === MVRF) { refs = true; moved = true; keep = true; }
        else if (sub === FRMR) { refs = true; keep = moved; moved = false; }
        else if (refs && !keep && !REF_KEPT.has(sub)) zero(s + 8, e);
        s = e;
      }
    }
    pos = end;
  }
  return pos + 16 <= n ? pos : n;
}

/** The bytes esmZeroMap walks between two turns of the server's event loop (~1 ms of the walk). */
const ESM_WALK_SLICE = 1 << 20;

/**
 * esmZeroRanges of the file `file` (`st`: its fs.Stats), made off the server's thread's way: the file read
 * asynchronously, its records walked ESM_WALK_SLICE bytes at a time between other work (the whole of Morrowind.esm held
 * the event loop ~130 ms, measured: every game's requests waited). A file no longer of its size: no ranges (its bytes as
 * they are — a superset of its copy's; a changed file is another copy: lightCopy's key).
 */
async function esmZeroMap(file, st) {
  const bytes = await fs.promises.readFile(file);
  if (bytes.length !== st.size) return new Uint32Array(0);
  const out = [];
  for (let pos = 0; pos < bytes.length;) {
    pos = esmZeroWalk(bytes, pos, pos + ESM_WALK_SLICE, out);
    if (pos < bytes.length) await new Promise((resolve) => setImmediate(resolve));
  }
  return Uint32Array.from(out);
}

/** The first range of `zero` (esmZeroRanges') that ends after `at`: its index (even). */
function zeroFrom(zero, at) {
  let lo = 0, hi = zero.length / 2;
  while (lo < hi) { const k = (lo + hi) >> 1; if (zero[k * 2 + 1] <= at) lo = k + 1; else hi = k; }
  return lo * 2;
}
/** The ranges of `zero` within [start, end), clipped (a job's share for br-cache-worker.js: its readLight). */
export function zeroWithin(zero, start, end) {
  const out = [];
  for (let i = zeroFrom(zero, start); i < zero.length && zero[i] < end; i += 2) out.push(Math.max(start, zero[i]), Math.min(end, zero[i + 1]));
  return Uint32Array.from(out);
}

/**
 * A TES3 file's light copy for readLight: its file's bytes, its map's ranges zeroed — `zeroMap()`: a promise of the map
 * (esmZeroMap), made at its first use and kept with the copy (lightCopy's cache; a failure not kept: made again at the
 * next use), not at the tree's listing (a stat and 16 bytes there).
 */
function esmCopy(file, st) {
  let zero = null;
  return {
    size: st.size, head: EMPTY, from: 0, format: ESM_FORMAT,
    zeroMap() { return (zero ??= esmZeroMap(file, st).catch((err) => { zero = null; throw err; })); },
  };
}

/** Bytes [start, end) of a TES3 file's light copy: the file's, its zeroed payloads within the range zeroed. */
// (its map first: a failure to make it is the read's — `done(err)`, never thrown from a callback; a br-cache job's copy
// brings its range's share of it, `zero`: br-cache-worker.js)
function readEsmLight(file, c, start, end, buf, at, done) {
  (c.zeroMap ? c.zeroMap() : Promise.resolve(c.zero ?? new Uint32Array(0))).then((z) => fs.open(file, 'r', (err, fd) => {
    if (err) return done(err);
    fs.read(fd, buf, at, end - start, start, (err2, n) => {
      fs.close(fd, () => {});
      if (err2 || n !== end - start) return done(err2 ?? new Error('short read'));
      for (let i = zeroFrom(z, start); i < z.length && z[i] < end; i += 2) buf.fill(0, at + Math.max(start, z[i]) - start, at + Math.min(end, z[i + 1]) - start);
      done(null);
    });
  }), done);
}
