// The table-driven inflate and the PNG decoder's row-at-a-time unfiltering / 8-bit unpacking against references:
// inflate against Node's zlib on streams of every block kind (stored, fixed, dynamic with codes longer than the fast
// table, stored blocks after compressed ones in one stream: the realignment of the buffered bits), and decodePng
// against a byte-at-a-time implementation of the PNG specification (the decoder as it was before the fast paths) on
// random images of every colour type, bit depth, interlace, filter type (unknown ones included), palette and tRNS size.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { inflate } from '../src/gfx/codecs/inflate.js';
import { decodePng } from '../src/gfx/codecs/png.js';

function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }
const eq = (got, want, what) => {
  assert.equal(got.length, want.length, `${what}: length`);
  for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) assert.fail(`${what}: byte ${i}: ${got[i]} vs ${want[i]}`);
};

/** Test data of several kinds: text-like, runs, skewed symbol frequencies (long Huffman codes), noise, repeats. */
function corpus(r, kind, n) {
  const b = new Uint8Array(n);
  if (kind === 0) for (let i = 0; i < n; i++) b[i] = 97 + Math.floor(r() * r() * 26);
  else if (kind === 1) for (let i = 0; i < n;) { const v = Math.floor(r() * 256), l = 1 + Math.floor(r() * 300); for (let j = 0; j < l && i < n; j++) b[i++] = v; }
  else if (kind === 2) for (let i = 0; i < n; i++) { let v = 0; while (v < 255 && r() < 0.8) v++; b[i] = v; } // (geometric: code lengths up to 15)
  else if (kind === 3) for (let i = 0; i < n; i++) b[i] = Math.floor(r() * 256);
  else for (let i = 0; i < n; i++) b[i] = i >= 4 && r() < 0.9 ? b[i - 1 - Math.floor(r() * Math.min(i, 40000))] : Math.floor(r() * 256);
  return b;
}

test('inflate = zlib: every level and strategy, zlib and raw streams, output growth', () => {
  const r = rng(5);
  const { Z_FILTERED, Z_HUFFMAN_ONLY, Z_RLE, Z_FIXED, Z_DEFAULT_STRATEGY } = zlib.constants;
  for (let kind = 0; kind < 5; kind++) {
    for (const n of [0, 1, 7, 300, 5000, 70000]) {
      const data = corpus(r, kind, n);
      for (const level of [0, 1, 6, 9]) {
        for (const strategy of [Z_DEFAULT_STRATEGY, Z_FILTERED, Z_HUFFMAN_ONLY, Z_RLE, Z_FIXED]) {
          if (level === 0 && strategy !== Z_DEFAULT_STRATEGY) continue;
          const what = `kind ${kind} n ${n} level ${level} strategy ${strategy}`;
          eq(inflate(zlib.deflateSync(data, { level, strategy })), data, what);
          eq(inflate(zlib.deflateRawSync(data, { level, strategy }), { zlib: false, sizeHint: 1 }), data, what + ' raw, tiny size hint');
        }
      }
    }
  }
});

test('inflate: stored blocks between compressed ones (sync / full flushes, level changes mid-stream)', async () => {
  const r = rng(9);
  for (let round = 0; round < 12; round++) {
    const parts = [], d = zlib.createDeflate({ level: 6 });
    const chunks = [];
    d.on('data', (c) => chunks.push(c));
    for (let i = 0; i < 6; i++) {
      const p = corpus(r, i % 5, 1 + Math.floor(r() * 3000)); parts.push(p);
      d.write(p);
      if (i === 2) await new Promise((res) => d.params(0, zlib.constants.Z_DEFAULT_STRATEGY, res)); // (stored from here)
      if (i === 4) await new Promise((res) => d.params(9, zlib.constants.Z_DEFAULT_STRATEGY, res));
      await new Promise((res) => d.flush(r() < 0.5 ? zlib.constants.Z_SYNC_FLUSH : zlib.constants.Z_FULL_FLUSH, res));
    }
    await new Promise((res) => { d.on('end', res); d.end(); }); // (all the output delivered)
    const stream = Buffer.concat(chunks), want = Buffer.concat(parts);
    eq(inflate(new Uint8Array(stream)), want, `round ${round}`);
  }
});

test('inflate: a truncated stream decodes what it holds and ends (no endless zero-bit symbols), or fails', () => {
  const r = rng(2);
  let decoded = 0;
  for (const [kind, level] of [[0, 6], [3, 6], [1, 9], [0, 0]]) {
    const data = corpus(r, kind, 20000);
    const z = zlib.deflateSync(data, { level });
    for (const cut of [3, 10, z.length >> 2, z.length >> 1, z.length - 5]) {
      let got;
      try { got = inflate(z.subarray(0, cut), { sizeHint: 1 }); } catch (e) { assert.match(e.message, /^inflate: bad/); continue; } // (zeros read as an invalid code: an error, fine too)
      assert.ok(got.length < 1e6, `kind ${kind} level ${level} cut ${cut}: ${got.length} bytes`);
      const good = Math.min(got.length, data.length, Math.max(0, cut * (level ? 1 : 0.9) - 600) | 0); // (a prefix is exact)
      eq(got.subarray(0, good), data.subarray(0, good), `kind ${kind} level ${level} cut ${cut}: prefix`);
      decoded++;
    }
  }
  assert.ok(decoded >= 12, `${decoded} truncated streams decoded`);
});

// ---- PNG

/** The PNG decoder as the specification reads (byte at a time, per-pixel sample fetch): the reference. */
function referencePng(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0, height = 0, depth = 8, ctype = 6, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  while (pos + 8 <= bytes.length) {
    const len = dv.getUint32(pos); const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { width = dv.getUint32(pos + 8); height = dv.getUint32(pos + 12); depth = bytes[pos + 16]; ctype = bytes[pos + 17]; interlace = bytes[pos + 20]; }
    else if (type === 'PLTE') palette = data.slice();
    else if (type === 'tRNS') trns = data.slice();
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  const bpp = Math.max(1, (channels * depth) >> 3);
  const raw = new Uint8Array(zlib.inflateSync(Buffer.concat(idat)));
  const out = new Uint8Array(width * height * 4);
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  let rp = 0;
  for (const [sx, sy, dx, dy] of passes) {
    const pw = Math.ceil((width - sx) / dx), ph = Math.ceil((height - sy) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const rowBytes = Math.ceil(pw * channels * depth / 8);
    let prev = new Uint8Array(rowBytes);
    for (let y = 0; y < ph; y++) {
      const filter = raw[rp++];
      const row = raw.slice(rp, rp + rowBytes); rp += rowBytes;
      for (let i = 0; i < rowBytes; i++) {
        const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        let v = row[i];
        switch (filter) { case 1: v += a; break; case 2: v += b; break; case 3: v += (a + b) >> 1; break; case 4: { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; break; } }
        row[i] = v & 0xff;
      }
      prev = row;
      for (let x = 0; x < pw; x++) {
        const oi = ((sy + y * dy) * width + sx + x * dx) * 4;
        const samp = (k) => {
          const idx = x * channels + k;
          if (depth === 8) return row[idx];
          if (depth === 16) return row[idx * 2];
          const bitPos = idx * depth; const byte = row[bitPos >> 3]; const shift = 8 - depth - (bitPos & 7);
          const v = (byte >> shift) & ((1 << depth) - 1);
          return ctype === 3 ? v : (v * 255) / ((1 << depth) - 1);
        };
        switch (ctype) {
          case 0: { const g = samp(0); out[oi] = out[oi + 1] = out[oi + 2] = g; out[oi + 3] = trns && trns.length >= 2 && ((trns[0] << 8) | trns[1]) === (depth === 16 ? (row[x * 2] << 8) | row[x * 2 + 1] : Math.round(g * ((1 << depth) - 1) / 255)) ? 0 : 255; break; }
          case 2: { out[oi] = samp(0); out[oi + 1] = samp(1); out[oi + 2] = samp(2); out[oi + 3] = 255; if (trns && trns.length >= 6 && out[oi] === trns[1] && out[oi + 1] === trns[3] && out[oi + 2] === trns[5]) out[oi + 3] = 0; break; }
          case 3: { const i = samp(0); out[oi] = palette ? palette[i * 3] : 0; out[oi + 1] = palette ? palette[i * 3 + 1] : 0; out[oi + 2] = palette ? palette[i * 3 + 2] : 0; out[oi + 3] = trns && i < trns.length ? trns[i] : 255; break; }
          case 4: { const g = samp(0); out[oi] = out[oi + 1] = out[oi + 2] = g; out[oi + 3] = samp(1); break; }
          case 6: { out[oi] = samp(0); out[oi + 1] = samp(1); out[oi + 2] = samp(2); out[oi + 3] = samp(3); break; }
        }
      }
    }
  }
  return { width, height, data: out };
}

function crc32(b) { let c = ~0; for (let i = 0; i < b.length; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; }
function chunk(type, data) {
  const b = Buffer.alloc(12 + data.length);
  b.writeUInt32BE(data.length, 0); b.write(type, 4, 'latin1'); Buffer.from(data).copy(b, 8);
  b.writeUInt32BE(crc32(b.subarray(4, 8 + data.length)), 8 + data.length);
  return b;
}
/** A PNG whose filtered rows are random bytes (every filter type, sometimes an unknown one): any such stream is valid. */
function randomPng(r, ctype, depth, interlace, w, h) {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype];
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
  const raw = [];
  const smooth = r() < 0.5; // (small residuals: filtered values that stay near their predictors, like real images)
  for (const [sx, sy, dx, dy] of passes) {
    const pw = Math.ceil((w - sx) / dx), ph = Math.ceil((h - sy) / dy);
    if (pw <= 0 || ph <= 0) continue;
    const rowBytes = Math.ceil(pw * channels * depth / 8);
    for (let y = 0; y < ph; y++) {
      raw.push(r() < 0.03 ? 5 + Math.floor(r() * 251) : Math.floor(r() * 5));
      for (let i = 0; i < rowBytes; i++) raw.push(smooth ? (Math.floor(r() * 7) - 3) & 255 : Math.floor(r() * 256));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = depth; ihdr[9] = ctype; ihdr[12] = interlace;
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)];
  if (ctype === 3) parts.push(chunk('PLTE', Buffer.from(Array.from({ length: 3 * (1 + Math.floor(r() * 256)) }, () => Math.floor(r() * 256)))));
  if (r() < 0.6) {
    const t = ctype === 3 ? Array.from({ length: Math.floor(r() * 257) }, () => Math.floor(r() * 256))
      : ctype === 0 ? [0, r() < 0.5 ? 0 : Math.floor(r() * 256)] : ctype === 2 ? [0, 3, 0, 250, 0, 7] : null;
    if (t) parts.push(chunk('tRNS', Buffer.from(t)));
  }
  const z = zlib.deflateSync(Buffer.from(raw));
  const cut = Math.floor(r() * z.length); // (IDAT split in two)
  parts.push(chunk('IDAT', z.subarray(0, cut)), chunk('IDAT', z.subarray(cut)), chunk('IEND', Buffer.alloc(0)));
  return new Uint8Array(Buffer.concat(parts));
}

test('png = the byte-at-a-time reference: every colour type, bit depth, interlace, filter, palette, tRNS', () => {
  const r = rng(17);
  const kinds = [[0, 1], [0, 2], [0, 4], [0, 8], [0, 16], [2, 8], [2, 16], [3, 1], [3, 2], [3, 4], [3, 8], [4, 8], [4, 16], [6, 8], [6, 16]];
  for (let n = 0; n < 600; n++) {
    const [ctype, depth] = kinds[n % kinds.length];
    const interlace = (n >> 4) & 1, w = 1 + Math.floor(r() * 45), h = 1 + Math.floor(r() * 23);
    const png = randomPng(r, ctype, depth, interlace, w, h);
    const got = decodePng(png), want = referencePng(png);
    assert.equal(got.width, w); assert.equal(got.height, h);
    eq(got.data, want.data, `case ${n}: ctype ${ctype} depth ${depth} interlace ${interlace} ${w}x${h}`);
  }
});
