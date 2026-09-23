// Cursor files (.cur / .ani) and the GDI text engine's TrueType header reader.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCursorFile } from '../src/gfx/gdi/cursor.js';
import { parseFontFile } from '../src/gfx/gdi/ttf.js';

/** A 4x4 cursor, 1 bpp (black/white palette) with an AND mask, hotspot (1, 2). */
function makeCur() {
  const w = 4, h = 4;
  const bih = 40, pal = 8, xorStride = 4, andStride = 4;
  const img = new Uint8Array(bih + pal + xorStride * h + andStride * h);
  const dv = new DataView(img.buffer);
  dv.setUint32(0, 40, true); dv.setInt32(4, w, true); dv.setInt32(8, 2 * h, true); dv.setUint16(12, 1, true); dv.setUint16(14, 1, true);
  img.set([0, 0, 0, 0, 255, 255, 255, 0], bih); // palette: black, white
  // XOR rows (bottom-up): top row (y=0) white pixels at x=0,1; others black
  const xor = bih + pal, and = xor + xorStride * h;
  img[xor + 3 * xorStride] = 0b11000000; // y = 0 stored last
  // AND mask: transparent everywhere except x=0..1 of the top row and x=0 of y=1
  for (let r = 0; r < h; r++) img[and + r * andStride] = 0xff;
  img[and + 3 * andStride] = 0b00111111; // y = 0: x=0,1 opaque
  img[and + 2 * andStride] = 0b01111111; // y = 1: x=0 opaque (black)
  const file = new Uint8Array(6 + 16 + img.length);
  const fv = new DataView(file.buffer);
  fv.setUint16(2, 2, true); fv.setUint16(4, 1, true);
  file[6] = w; file[7] = h; fv.setUint16(10, 1, true); fv.setUint16(12, 2, true); fv.setUint32(14, img.length, true); fv.setUint32(18, 22, true);
  file.set(img, 22);
  return file;
}

test('cursor: .cur with 1 bpp colors, AND mask transparency and hotspot', () => {
  const c = parseCursorFile(makeCur());
  assert.ok(c);
  const f = c.frames[0];
  assert.deepEqual([f.w, f.h, f.hotX, f.hotY], [4, 4, 1, 2]);
  const px = (x, y) => Array.from(f.rgba.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4));
  assert.deepEqual(px(0, 0), [255, 255, 255, 255]);
  assert.deepEqual(px(1, 0), [255, 255, 255, 255]);
  assert.deepEqual(px(0, 1), [0, 0, 0, 255], 'AND 0 + black = opaque black');
  assert.equal(px(3, 3)[3], 0, 'AND 1 + black = transparent');
});

test('cursor: .ani frames, rate and sequence', () => {
  const cur = makeCur();
  const chunk = (id, body) => { const b = new Uint8Array(8 + body.length + (body.length & 1)); b.set([...id].map((ch) => ch.charCodeAt(0)), 0); new DataView(b.buffer).setUint32(4, body.length, true); b.set(body, 8); return b; };
  const anih = new Uint8Array(36); const av = new DataView(anih.buffer); av.setUint32(0, 36, true); av.setUint32(4, 2, true); av.setUint32(8, 3, true); av.setUint32(28, 6, true); av.setUint32(32, 3, true);
  const rate = new Uint8Array(12); const rv = new DataView(rate.buffer); rv.setUint32(0, 6, true); rv.setUint32(4, 12, true); rv.setUint32(8, 30, true);
  const seq = new Uint8Array(12); const sv = new DataView(seq.buffer); sv.setUint32(0, 0, true); sv.setUint32(4, 1, true); sv.setUint32(8, 0, true);
  const fram = [...'fram'].map((ch) => ch.charCodeAt(0));
  const list = chunk('LIST', new Uint8Array([...fram, ...chunk('icon', cur), ...chunk('icon', cur)]));
  const body = new Uint8Array([...[...'ACON'].map((ch) => ch.charCodeAt(0)), ...chunk('anih', anih), ...chunk('rate', rate), ...chunk('seq ', seq), ...list]);
  const riff = new Uint8Array([...chunk('RIFF', body)]);
  const c = parseCursorFile(riff);
  assert.ok(c);
  assert.equal(c.frames.length, 2);
  assert.deepEqual(c.steps, [{ frame: 0, ms: 100 }, { frame: 1, ms: 200 }, { frame: 0, ms: 500 }]);
});

test('ttf: family and Windows metrics from a minimal sfnt header', () => {
  // offset table + head, hhea, OS/2, name tables
  const tables = {};
  const head = new Uint8Array(54); new DataView(head.buffer).setUint16(18, 2048); tables.head = head;
  const hhea = new Uint8Array(36); const hv = new DataView(hhea.buffer); hv.setInt16(4, 1854); hv.setInt16(6, -434); hv.setInt16(8, 67); tables.hhea = hhea;
  const os2 = new Uint8Array(96); const ov = new DataView(os2.buffer); ov.setInt16(2, 904); ov.setUint16(4, 700); ov.setUint16(74, 1854); ov.setUint16(76, 434); tables['OS/2'] = os2;
  const fam = 'Test Face'; const u16 = new Uint8Array(fam.length * 2); for (let i = 0; i < fam.length; i++) u16[2 * i + 1] = fam.charCodeAt(i);
  const name = new Uint8Array(6 + 12 + u16.length); const nv = new DataView(name.buffer); nv.setUint16(2, 1); nv.setUint16(4, 18); nv.setUint16(6, 3); nv.setUint16(8, 1); nv.setUint16(10, 0x409); nv.setUint16(12, 1); nv.setUint16(14, u16.length); nv.setUint16(16, 0); name.set(u16, 18); tables.name = name;
  const tags = Object.keys(tables); let off = 12 + 16 * tags.length; const parts = [];
  const hdr = new Uint8Array(off); const dv = new DataView(hdr.buffer); dv.setUint32(0, 0x00010000); dv.setUint16(4, tags.length);
  tags.forEach((t, i) => { for (let k = 0; k < 4; k++) hdr[12 + 16 * i + k] = t.charCodeAt(k); dv.setUint32(12 + 16 * i + 8, off); dv.setUint32(12 + 16 * i + 12, tables[t].length); parts.push(tables[t]); off += tables[t].length; });
  const file = new Uint8Array(off); file.set(hdr, 0); let p = hdr.length; for (const t of parts) { file.set(t, p); p += t.length; }
  const [f] = parseFontFile(file);
  assert.equal(f.family, 'Test Face');
  assert.equal(f.unitsPerEm, 2048);
  assert.deepEqual([f.winAscent, f.winDescent, f.avgCharWidth, f.weight], [1854, 434, 904, 700]);
});
