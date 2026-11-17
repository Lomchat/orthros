// CFF outlines (the 'CFF ' table of OpenType fonts with PostScript outlines), from the public Adobe specifications
// (Technical Notes #5176, the Compact Font Format, and #5177, Type 2 charstrings): the table's structures, a Type 2
// charstring interpreter giving a glyph's outline, and `flattenSeac`, the font as the browser's rasterizer receives it.
//
// Why flattenSeac: Type 2 keeps Type 1's accented-character composition as a deprecated form of endchar ("adx ady bchar
// achar endchar": the glyph is the StandardEncoding glyph `bchar` with `achar` placed at (adx, ady)). Fonts converted
// from Type 1 use it for every accented letter (Age of the Ring's Albertus MT: à é ó ù and the others). The browser's
// rasterizer does not draw such glyphs the same way everywhere: Chrome on Windows (owner's machine, 2026-11-17) cut
// them at the accent's right edge ("ó" drawn as "ć", "où" as "oì"), while Linux's draws them whole. The font handed to
// the browser therefore has those glyphs as ordinary outlines — the same contours, base then accent at its offset —
// and nothing else changed (the application's own file and every metric GDI reports come from the original bytes).

/** CFF INDEX at `p` (absolute): [start, end) of each entry, and the offset past the INDEX. */
export function cffIndex(dv, p) {
  const count = dv.getUint16(p);
  if (!count) return { items: [], end: p + 2 };
  const size = dv.getUint8(p + 2), offs = [];
  for (let i = 0; i <= count; i++) { let v = 0; for (let k = 0; k < size; k++) v = v * 256 + dv.getUint8(p + 3 + i * size + k); offs.push(v); }
  const data = p + 3 + (count + 1) * size - 1;
  return { items: offs.slice(0, -1).map((o, i) => [data + o, data + offs[i + 1]]), end: data + offs[count] };
}

/** A CFF INDEX's bytes holding `items` (Uint8Arrays). */
export function cffIndexBytes(items) {
  if (!items.length) return new Uint8Array(2);
  let total = 1; for (const it of items) total += it.length;
  const size = total < 0x100 ? 1 : total < 0x10000 ? 2 : total < 0x1000000 ? 3 : 4;
  const out = new Uint8Array(3 + (items.length + 1) * size + total - 1);
  out[0] = items.length >> 8; out[1] = items.length & 0xff; out[2] = size;
  let off = 1, p = 3 + (items.length + 1) * size;
  const put = (i, v) => { for (let k = size - 1; k >= 0; k--, v = Math.floor(v / 256)) out[3 + i * size + k] = v & 0xff; };
  items.forEach((it, i) => { put(i, off); out.set(it, p); p += it.length; off += it.length; });
  put(items.length, off);
  return out;
}

/**
 * A DICT's entries in order: operator (12 x as 1200 + x), operands, and the entry's byte range [start, end).
 * @returns {{ op: number, args: number[], start: number, end: number }[]}
 */
export function parseDict(dv, s, e) {
  const out = []; let args = [], start = s;
  for (let p = s; p < e;) {
    const b = dv.getUint8(p);
    if (b <= 21) { const op = b === 12 ? 1200 + dv.getUint8(p + 1) : b; p += b === 12 ? 2 : 1; out.push({ op, args, start, end: p }); args = []; start = p; }
    else if (b === 28) { args.push(dv.getInt16(p + 1)); p += 3; }
    else if (b === 29) { args.push(dv.getInt32(p + 1)); p += 5; }
    else if (b === 30) { // real: nibbles 0-9, '.', 'E', 'E-', -, end
      let str = ''; p++;
      for (let done = false; p < e && !done;) { const n = dv.getUint8(p++); for (const d of [n >> 4, n & 15]) { if (d === 15) { done = true; break; } str += d < 10 ? d : ['.', 'E', 'E-', '', '-'][d - 10]; } }
      args.push(Number(str) || 0);
    }
    else if (b >= 32 && b <= 246) { args.push(b - 139); p++; }
    else if (b >= 247 && b <= 250) { args.push((b - 247) * 256 + dv.getUint8(p + 1) + 108); p += 2; }
    else if (b >= 251 && b <= 254) { args.push(-(b - 251) * 256 - dv.getUint8(p + 1) - 108); p += 2; }
    else p++;
  }
  return out;
}

const dictGet = (dict, op) => dict.find((d) => d.op === op)?.args;
const subrBias = (n) => (n < 1240 ? 107 : n < 33900 ? 1131 : 32768);

/**
 * The font program of a CFF table (non-CID, Type 2 charstrings) at `base` (absolute) in `dv`, or null.
 * @returns {null | { base: number, hdrSize: number, names: any, tops: any, strings: any, gsubrs: any, top: any[],
 *   charStrings: any, subrs: any, privateAt: number, charsetAt: number, numGlyphs: number }}
 */
export function readCff(dv, base) {
  const hdrSize = dv.getUint8(base + 2);
  const names = cffIndex(dv, base + hdrSize), tops = cffIndex(dv, names.end), strings = cffIndex(dv, tops.end), gsubrs = cffIndex(dv, strings.end);
  if (tops.items.length !== 1) return null;
  const top = parseDict(dv, ...tops.items[0]);
  if (dictGet(top, 1230) || dictGet(top, 1236) || (dictGet(top, 1206)?.[0] ?? 2) !== 2) return null; // CID-keyed, Type 1 charstrings
  const cs = dictGet(top, 17), priv = dictGet(top, 18);
  if (!cs) return null;
  const charStrings = cffIndex(dv, base + cs[0]);
  let subrs = { items: [] }, privateAt = -1;
  if (priv && priv.length >= 2) {
    privateAt = base + priv[1];
    const sub = dictGet(parseDict(dv, privateAt, privateAt + priv[0]), 19);
    if (sub) subrs = cffIndex(dv, privateAt + sub[0]);
  }
  return { base, hdrSize, names, tops, strings, gsubrs, top, charStrings, subrs, privateAt, charsetAt: dictGet(top, 15)?.[0] ?? 0, numGlyphs: charStrings.items.length };
}

/**
 * Run glyph `gid`'s charstring: its outline as absolute path commands (['M', x, y], ['L', x, y], ['C', x1, y1, x2, y2,
 * x, y]) offset by (ox, oy), its width operand (null: the font's default width) and, for a seac glyph, its
 * [adx, ady, bchar, achar] (the components are not drawn: see glyphOutline). Throws on what Type 2 does not allow.
 */
export function runCharString(dv, cff, gid, ox = 0, oy = 0) {
  const path = [], stack = [];
  let x = ox, y = oy, stems = 0, sawWidth = false, width = null, seac = null, ended = false, depth = 0;
  const lbias = subrBias(cff.subrs.items.length), gbias = subrBias(cff.gsubrs.items.length);
  const takeWidth = (has) => { if (!sawWidth) { sawWidth = true; if (has) width = stack.shift(); } };
  const lineTo = (nx, ny) => { x = nx; y = ny; path.push(['L', x, y]); };
  const curveTo = (x1, y1, x2, y2, x3, y3) => { x = x3; y = y3; path.push(['C', x1, y1, x2, y2, x3, y3]); };
  const run = ([s, e]) => {
    if (++depth > 11) throw new Error('subroutines nested too deep');
    for (let p = s; p < e && !ended;) {
      const b = dv.getUint8(p);
      if (b >= 32) { if (b <= 246) { stack.push(b - 139); p++; } else if (b <= 250) { stack.push((b - 247) * 256 + dv.getUint8(p + 1) + 108); p += 2; } else if (b <= 254) { stack.push(-(b - 251) * 256 - dv.getUint8(p + 1) - 108); p += 2; } else { stack.push(dv.getInt32(p + 1) / 65536); p += 5; } continue; }
      if (b === 28) { stack.push(dv.getInt16(p + 1)); p += 3; continue; }
      p++;
      const a = stack, n = a.length;
      switch (b) {
        case 1: case 3: case 18: case 23: takeWidth(n & 1); stems += a.length >> 1; a.length = 0; break; // hstem vstem hstemhm vstemhm
        case 19: case 20: takeWidth(n & 1); stems += a.length >> 1; a.length = 0; p += (stems + 7) >> 3; break; // hintmask cntrmask
        case 21: takeWidth(n > 2); x += a[0]; y += a[1]; path.push(['M', x, y]); a.length = 0; break; // rmoveto
        case 22: takeWidth(n > 1); x += a[0]; path.push(['M', x, y]); a.length = 0; break; // hmoveto
        case 4: takeWidth(n > 1); y += a[0]; path.push(['M', x, y]); a.length = 0; break; // vmoveto
        case 5: for (let i = 0; i + 1 < n; i += 2) lineTo(x + a[i], y + a[i + 1]); a.length = 0; break; // rlineto
        case 6: case 7: for (let i = 0; i < n; i++) { if ((i & 1) === (b === 6 ? 0 : 1)) lineTo(x + a[i], y); else lineTo(x, y + a[i]); } a.length = 0; break; // hlineto vlineto
        case 8: for (let i = 0; i + 5 < n; i += 6) curveTo(x + a[i], y + a[i + 1], x + a[i] + a[i + 2], y + a[i + 1] + a[i + 3], x + a[i] + a[i + 2] + a[i + 4], y + a[i + 1] + a[i + 3] + a[i + 5]); a.length = 0; break; // rrcurveto
        case 24: { let i = 0; for (; i + 7 < n; i += 6) curveTo(x + a[i], y + a[i + 1], x + a[i] + a[i + 2], y + a[i + 1] + a[i + 3], x + a[i] + a[i + 2] + a[i + 4], y + a[i + 1] + a[i + 3] + a[i + 5]); lineTo(x + a[i], y + a[i + 1]); a.length = 0; break; } // rcurveline
        case 25: { let i = 0; for (; i + 7 < n; i += 2) lineTo(x + a[i], y + a[i + 1]); curveTo(x + a[i], y + a[i + 1], x + a[i] + a[i + 2], y + a[i + 1] + a[i + 3], x + a[i] + a[i + 2] + a[i + 4], y + a[i + 1] + a[i + 3] + a[i + 5]); a.length = 0; break; } // rlinecurve
        case 26: { let i = 0, dx1 = 0; if (n & 1) dx1 = a[i++]; for (; i + 3 < n; i += 4) { const x1 = x + dx1, y1 = y + a[i]; dx1 = 0; curveTo(x1, y1, x1 + a[i + 1], y1 + a[i + 2], x1 + a[i + 1], y1 + a[i + 2] + a[i + 3]); } a.length = 0; break; } // vvcurveto
        case 27: { let i = 0, dy1 = 0; if (n & 1) dy1 = a[i++]; for (; i + 3 < n; i += 4) { const x1 = x + a[i], y1 = y + dy1; dy1 = 0; curveTo(x1, y1, x1 + a[i + 1], y1 + a[i + 2], x1 + a[i + 1] + a[i + 3], y1 + a[i + 2]); } a.length = 0; break; } // hhcurveto
        case 30: case 31: { // vhcurveto hvcurveto: alternating tangents, the last curve with an optional extra delta
          let h = b === 31;
          for (let i = 0; i + 3 < n; h = !h) {
            const last = n - i === 5, d = last ? a[i + 4] : 0;
            if (h) { const x1 = x + a[i], y1 = y, x2 = x1 + a[i + 1], y2 = y1 + a[i + 2]; curveTo(x1, y1, x2, y2, x2 + d, y2 + a[i + 3]); }
            else { const x1 = x, y1 = y + a[i], x2 = x1 + a[i + 1], y2 = y1 + a[i + 2]; curveTo(x1, y1, x2, y2, x2 + a[i + 3], y2 + d); }
            i += last ? 5 : 4;
          }
          a.length = 0; break;
        }
        case 10: { const i = a.pop() + lbias; if (!(i >= 0 && i < cff.subrs.items.length)) throw new Error('bad subr'); run(cff.subrs.items[i]); break; } // callsubr
        case 29: { const i = a.pop() + gbias; if (!(i >= 0 && i < cff.gsubrs.items.length)) throw new Error('bad gsubr'); run(cff.gsubrs.items[i]); break; } // callgsubr
        case 11: depth--; return; // return
        case 14: takeWidth(n === 1 || n === 5); if (a.length >= 4) seac = a.slice(-4); a.length = 0; ended = true; break; // endchar
        case 12: {
          const e2 = dv.getUint8(p++), s0x = x, s0y = y;
          if (e2 === 35) { curveTo(x + a[0], y + a[1], x + a[0] + a[2], y + a[1] + a[3], x + a[0] + a[2] + a[4], y + a[1] + a[3] + a[5]); curveTo(x + a[6], y + a[7], x + a[6] + a[8], y + a[7] + a[9], x + a[6] + a[8] + a[10], y + a[7] + a[9] + a[11]); } // flex
          else if (e2 === 34) { const x1 = x + a[0], x2 = x1 + a[1], y2 = y + a[2], x3 = x2 + a[3]; curveTo(x1, y, x2, y2, x3, y2); const x4 = x + a[4], x5 = x4 + a[5]; curveTo(x4, y2, x5, s0y, x5 + a[6], s0y); } // hflex
          else if (e2 === 36) { const x1 = x + a[0], y1 = y + a[1], x2 = x1 + a[2], y2 = y1 + a[3], x3 = x2 + a[4]; curveTo(x1, y1, x2, y2, x3, y2); const x4 = x + a[5], x5 = x4 + a[6], y5 = y2 + a[7]; curveTo(x4, y2, x5, y5, x5 + a[8], s0y); } // hflex1
          else if (e2 === 37) { // flex1
            const x1 = x + a[0], y1 = y + a[1], x2 = x1 + a[2], y2 = y1 + a[3], x3 = x2 + a[4], y3 = y2 + a[5];
            curveTo(x1, y1, x2, y2, x3, y3);
            const x4 = x + a[6], y4 = y + a[7], x5 = x4 + a[8], y5 = y4 + a[9], dx = x5 - s0x, dy = y5 - s0y;
            if (Math.abs(dx) > Math.abs(dy)) curveTo(x4, y4, x5, y5, x5 + a[10], s0y); else curveTo(x4, y4, x5, y5, s0x, y5 + a[10]);
          } else throw new Error(`charstring operator 12 ${e2}`); // (the arithmetic operators: no font of this kind uses them)
          a.length = 0; break;
        }
        default: throw new Error(`charstring operator ${b}`);
      }
    }
    depth--;
  };
  if (gid < 0 || gid >= cff.numGlyphs) throw new Error('no such glyph');
  run(cff.charStrings.items[gid]);
  return { path, width, seac };
}

// StandardEncoding (CFF specification, appendix B): code -> standard string id, as runs [first code, first SID, count]
const STANDARD_ENCODING = new Uint16Array(256);
for (const [c, s, n] of [[32, 1, 95], [161, 96, 15], [177, 111, 4], [182, 115, 8], [191, 123, 1], [193, 124, 8], [202, 132, 2], [205, 134, 4], [225, 138, 1], [227, 139, 1], [232, 140, 4], [241, 144, 1], [245, 145, 1], [248, 146, 4]]) for (let i = 0; i < n; i++) STANDARD_ENCODING[c + i] = s + i;

/** The glyph whose name is StandardEncoding's for `code` (through the font's charset), or -1. */
function standardGlyph(dv, cff, code) {
  const sid = STANDARD_ENCODING[code & 0xff];
  if (!sid) return -1;
  const at = cff.charsetAt;
  if (at === 0) return sid < cff.numGlyphs ? sid : -1; // ISOAdobe: glyph i is string i
  if (at <= 2) return -1; // (Expert charsets: no StandardEncoding letter)
  const p0 = cff.base + at, fmt = dv.getUint8(p0);
  let gid = 1, p = p0 + 1;
  while (gid < cff.numGlyphs) {
    if (fmt === 0) { if (dv.getUint16(p) === sid) return gid; p += 2; gid++; }
    else if (fmt === 1 || fmt === 2) {
      const first = dv.getUint16(p), left = fmt === 1 ? dv.getUint8(p + 2) : dv.getUint16(p + 2);
      if (sid >= first && sid <= first + left) return gid + sid - first;
      gid += left + 1; p += fmt === 1 ? 3 : 4;
    } else return -1;
  }
  return -1;
}

/** Glyph `gid`'s outline (seac composites drawn as their base and accent) and width operand. */
export function glyphOutline(dv, cff, gid) {
  const g = runCharString(dv, cff, gid);
  if (!g.seac) return g;
  const [adx, ady, bchar, achar] = g.seac, bg = standardGlyph(dv, cff, bchar), ag = standardGlyph(dv, cff, achar);
  if (bg < 0 || ag < 0) throw new Error('seac component missing');
  const base = runCharString(dv, cff, bg), accent = runCharString(dv, cff, ag, adx, ady);
  if (base.seac || accent.seac) throw new Error('nested seac');
  return { path: [...base.path, ...accent.path], width: g.width, seac: g.seac };
}

/** Type 2 charstring of an outline: relative movetos, lines and curves, no hints, the width operand first. */
function encodeCharString(path, width) {
  const out = [];
  const num = (v) => {
    if (Number.isInteger(v) && v >= -107 && v <= 107) out.push(v + 139);
    else if (Number.isInteger(v) && v >= 108 && v <= 1131) { const w = v - 108; out.push((w >> 8) + 247, w & 0xff); }
    else if (Number.isInteger(v) && v >= -1131 && v <= -108) { const w = -v - 108; out.push((w >> 8) + 251, w & 0xff); }
    else if (Number.isInteger(v) && v >= -32768 && v <= 32767) out.push(28, (v >> 8) & 0xff, v & 0xff);
    else { const f = Math.round(v * 65536) | 0; out.push(255, (f >>> 24) & 0xff, (f >>> 16) & 0xff, (f >>> 8) & 0xff, f & 0xff); }
  };
  let x = 0, y = 0, first = true;
  for (const c of path) {
    if (c[0] === 'M') { if (first && width !== null) num(width); first = false; num(c[1] - x); num(c[2] - y); out.push(21); x = c[1]; y = c[2]; }
    else if (c[0] === 'L') { num(c[1] - x); num(c[2] - y); out.push(5); x = c[1]; y = c[2]; }
    else { num(c[1] - x); num(c[2] - y); num(c[3] - c[1]); num(c[4] - c[2]); num(c[5] - c[3]); num(c[6] - c[4]); out.push(8); x = c[5]; y = c[6]; }
  }
  if (first && width !== null) num(width);
  out.push(14);
  return new Uint8Array(out);
}

/** A DICT entry re-encoded with 5-byte integer operands (an offset's size then no longer depends on its value). */
function dictEntry(op, args) {
  const out = [];
  for (const v of args) out.push(29, (v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  if (op >= 1200) out.push(12, op - 1200); else out.push(op);
  return out;
}

/** Table directory of an sfnt: tag -> { offset, length }, in the directory's order. */
function sfntTables(dv) {
  const n = dv.getUint16(4), out = new Map();
  for (let i = 0; i < n; i++) { const r = 12 + 16 * i; out.set(String.fromCharCode(dv.getUint8(r), dv.getUint8(r + 1), dv.getUint8(r + 2), dv.getUint8(r + 3)), { offset: dv.getUint32(r + 8), length: dv.getUint32(r + 12) }); }
  return out;
}

/**
 * The font `sfnt` (one OpenType face) with every seac glyph of its CFF table rewritten as an ordinary outline (see the
 * top of this file); null when there is none (or the font is not one this handles: it is then used as it is).
 * @param {Uint8Array} sfnt
 * @returns {Uint8Array|null}
 */
export function flattenSeac(sfnt) {
  try {
    const dv = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
    if (sfnt.length < 12 || dv.getUint32(0) !== 0x4f54544f) return null; // 'OTTO'
    const tables = sfntTables(dv), t = tables.get('CFF ');
    if (!t) return null;
    const cff = readCff(dv, t.offset);
    if (!cff) return null;
    // the glyphs to rewrite
    const rewritten = new Map();
    for (let gid = 0; gid < cff.numGlyphs; gid++) {
      let g; try { g = glyphOutline(dv, cff, gid); } catch { continue; } // (a glyph this cannot read stays as it is)
      if (g.seac) rewritten.set(gid, encodeCharString(g.path, g.width));
    }
    if (!rewritten.size) return null;
    // the new table: header, Name INDEX, Top DICT (offsets as 5-byte integers), String and Global Subr INDEXes, then
    // everything that followed them unchanged (shifted), then the new CharStrings INDEX
    const u8 = sfnt.subarray(t.offset, t.offset + t.length), base = t.offset;
    const restAt = cff.gsubrs.end - base;
    const offsetOps = new Set([15, 16, 17, 1236, 1237]);
    const topSize = cff.top.reduce((s, d) => s + (offsetOps.has(d.op) || d.op === 18 ? 5 * d.args.length + (d.op >= 1200 ? 2 : 1) : d.end - d.start), 0);
    const newTopIndexLen = cffIndexBytes([new Uint8Array(topSize)]).length;
    const delta = newTopIndexLen - (cff.tops.end - cff.names.end); // (what follows the Top DICT INDEX moves by this)
    const shift = (off) => { if (off < restAt) throw new Error('data before the subroutines'); return off + delta; };
    const csIndex = cffIndexBytes([...Array(cff.numGlyphs).keys()].map((g) => rewritten.get(g) ?? u8.subarray(cff.charStrings.items[g][0] - base, cff.charStrings.items[g][1] - base)));
    const newCsAt = t.length + delta;
    const top = [];
    for (const d of cff.top) {
      if (d.op === 17) top.push(...dictEntry(17, [newCsAt]));
      else if (d.op === 15 && d.args[0] > 2 || d.op === 16 && d.args[0] > 1 || d.op === 1236 || d.op === 1237) top.push(...dictEntry(d.op, [shift(d.args[0])]));
      else if (d.op === 15 || d.op === 16) top.push(...dictEntry(d.op, d.args));
      else if (d.op === 18) top.push(...dictEntry(18, [d.args[0], shift(d.args[1])]));
      else top.push(...u8.subarray(d.start - base, d.end - base));
    }
    const topIndex = cffIndexBytes([new Uint8Array(top)]);
    if (topIndex.length !== newTopIndexLen) throw new Error('Top DICT size');
    const head = u8.subarray(0, cff.names.end - base), mid = u8.subarray(cff.tops.end - base, restAt), rest = u8.subarray(restAt);
    const table = new Uint8Array(head.length + topIndex.length + mid.length + rest.length + csIndex.length);
    let p = 0;
    for (const part of [head, topIndex, mid, rest, csIndex]) { table.set(part, p); p += part.length; }
    return replaceTable(sfnt, tables, 'CFF ', table);
  } catch { return null; }
}

/** `sfnt` with table `tag` replaced by `data`: tables 4-byte aligned in their former order, checksums recomputed. */
function replaceTable(sfnt, tables, tag, data) {
  const n = tables.size, entries = [...tables.entries()].map(([k, v], i) => ({ tag: k, i, data: k === tag ? data : sfnt.subarray(v.offset, v.offset + v.length), at: v.offset }));
  let size = 12 + 16 * n; for (const e of entries) size += (e.data.length + 3) & ~3;
  const out = new Uint8Array(size), odv = new DataView(out.buffer);
  out.set(sfnt.subarray(0, 12), 0);
  let p = 12 + 16 * n;
  for (const e of [...entries].sort((a, b) => a.at - b.at)) { e.offset = p; out.set(e.data, p); p += (e.data.length + 3) & ~3; }
  const sum = (s, len) => { let c = 0; for (let k = 0; k < len; k += 4) c = (c + odv.getUint32(s + k)) >>> 0; return c; };
  const headE = entries.find((e) => e.tag === 'head');
  if (headE && headE.data.length >= 12) odv.setUint32(headE.offset + 8, 0); // checkSumAdjustment, computed below
  for (const e of entries) {
    const r = 12 + 16 * e.i;
    for (let k = 0; k < 4; k++) out[r + k] = e.tag.charCodeAt(k);
    odv.setUint32(r + 4, sum(e.offset, (e.data.length + 3) & ~3)); odv.setUint32(r + 8, e.offset); odv.setUint32(r + 12, e.data.length);
  }
  if (headE && headE.data.length >= 12) odv.setUint32(headE.offset + 8, (0xb1b0afba - sum(0, size)) >>> 0);
  return out;
}
