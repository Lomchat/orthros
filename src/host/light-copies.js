// Light copies (docs/slow-network.md "Light copies"): a game file in a format Orthros knows how to lighten, served
// smaller beside it — a texture without its finest levels of detail — so that a slow link shows the game sooner; the
// file itself comes after, in the background, for the next time the engine loads it. Derived from the file at each
// request (head bytes of its own, then a run of the file's: nothing stored, the game files never changed), by format,
// for every game whose runtime reads them (manifest.lightCopies: the browser ports — a Windows game reads its files as
// they are). Served under LIGHT_DIR (/gamez/<manifest>/.light/<path>); the tree tells each file's light size (`light`).
import fs from 'node:fs';
import { LIGHT_DIR } from '../vfs/game-tree.js';

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
 * The light copy of `file` (`st`: its fs.Stats): { size, head, from } — its bytes: `head`, then the file's from `from`
 * on, up to `size` in all — or null (not a format Orthros lightens, or nothing to gain).
 */
export function lightCopy(file, st) {
  if (!/\.dds$/i.test(file)) return null;
  const key = `${file}\0${st.size}\0${st.mtimeMs}`;
  let c = known.get(key);
  if (c !== undefined) { known.delete(key); known.set(key, c); return c; }
  c = null;
  try {
    const fd = fs.openSync(file, 'r');
    try { const head = Buffer.alloc(148); const n = fs.readSync(fd, head, 0, 148, 0); c = lightDds(head.subarray(0, n), st.size); }
    finally { fs.closeSync(fd); }
  } catch { return null; } // (a failure to read it — a file being replaced, no descriptor left —: not remembered)
  known.set(key, c);
  if (known.size > MAX_KNOWN) known.delete(known.keys().next().value);
  return c;
}

/** Bytes [start, end) of a light copy (`c` of `file`), into `buf` at `at`; `done(err)`. */
export function readLight(file, c, start, end, buf, at, done) {
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
 * `size` bytes: its finest mip levels left out, down to LIGHT_SIDE — the same format, its header telling the smaller
 * size and the fewer levels, the remaining levels as they are. Null when the texture is small already, has no levels
 * below (a picture drawn as it is: a menu's), is a cube or a volume, or is not as its header says.
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
  let k = 0;
  while (k < mips - 1 && Math.max(w >>> k, h >>> k) > LIGHT_SIDE) k++;
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
