// Minimal TrueType/OpenType header reader for fonts registered by applications (AddFontResource):
// family and face names, weight/style, and the vertical metrics GDI derives a font's cell from
// (head.unitsPerEm, OS/2 usWinAscent/usWinDescent, hhea line gap, xAvgCharWidth). Glyph outlines
// are left to the rasterizer (the browser's font engine). Written from the public OpenType spec.

/**
 * @typedef {{ family: string, subfamily: string, fullName: string, unitsPerEm: number, winAscent: number,
 *   winDescent: number, typoAscender: number, typoDescender: number, typoLineGap: number, hheaAscender: number,
 *   hheaDescender: number, hheaLineGap: number, avgCharWidth: number, weight: number, italic: boolean,
 *   fixedPitch: boolean, firstChar: number, lastChar: number, offset: number, bboxWidth: number }} FontInfo
 * @typedef {{ advance: number, box: { xMin: number, yMin: number, xMax: number, yMax: number } | null }} NotdefGlyph
 *   glyph 0 in font units: its advance and the box of its outline (null: no outline, a blank)
 * @typedef {{ toGlyph: Map<number, number>, toChar: Map<number, number>, defaultChar: number, unitsPerEm: number,
 *   notdef: NotdefGlyph }} CharMap
 *   defaultChar: OS/2 usDefaultChar, the character drawn for those the font lacks (0: glyph 0, .notdef)
 */

/**
 * The Unicode character map of the face at `offset` (cmap formats 4 and 12, Windows or Unicode platform): character
 * code -> glyph index (GetGlyphIndices) and glyph index -> first character code (the glyph-index text calls); with what
 * the font draws for a character it lacks: its default character and its glyph 0.
 * @param {Uint8Array} bytes
 * @returns {CharMap|null}
 */
export function parseCmap(bytes, offset = 0) { try { return parseCmapUnsafe(bytes,offset); } catch { return null; } } // (a malformed table: no cmap, the font's glyphs by code)
function parseCmapUnsafe(bytes, offset = 0) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numTables = dv.getUint16(offset + 4);
  const dir = new Map();
  for (let i = 0; i < numTables; i++) {
    const r = offset + 12 + 16 * i;
    dir.set(dv.getUint32(r), { offset: dv.getUint32(r + 8), length: dv.getUint32(r + 12) });
  }
  const cmap = dir.get(0x636d6170)?.offset ?? -1; // 'cmap'
  if (cmap < 0 || cmap + 4 > bytes.length) return null;
  // best subtable: Windows UCS-4 (3,10) / Unicode full (0,4..6) format 12, else Windows BMP (3,1) / Unicode (0,x) format 4
  let best = -1, bestScore = -1;
  const n = dv.getUint16(cmap + 2);
  for (let i = 0; i < n; i++) {
    const p = cmap + 4 + 8 * i, platform = dv.getUint16(p), enc = dv.getUint16(p + 2), sub = cmap + dv.getUint32(p + 4);
    if (sub + 2 > bytes.length) continue;
    const fmt = dv.getUint16(sub);
    const score = fmt === 12 && (platform === 3 || platform === 0) ? 3 : fmt === 4 && platform === 3 && enc === 1 ? 2 : fmt === 4 && platform === 0 ? 1 : -1;
    if (score > bestScore) { best = sub; bestScore = score; }
  }
  if (best < 0) return null;
  const toGlyph = new Map(), toChar = new Map();
  const put = (c, g) => { if (!g) return; toGlyph.set(c, g); if (!toChar.has(g)) toChar.set(g, c); };
  try {
    if (dv.getUint16(best) === 4) {
      const segs = dv.getUint16(best + 6) >> 1, ends = best + 14, starts = ends + 2 * segs + 2, deltas = starts + 2 * segs, ranges = deltas + 2 * segs;
      for (let s = 0; s < segs; s++) {
        const end = dv.getUint16(ends + 2 * s), start = dv.getUint16(starts + 2 * s), delta = dv.getUint16(deltas + 2 * s), ro = dv.getUint16(ranges + 2 * s);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          if (!ro) put(c, (c + delta) & 0xffff);
          else { const g = dv.getUint16(ranges + 2 * s + ro + 2 * (c - start)); put(c, g ? (g + delta) & 0xffff : 0); }
        }
      }
    } else {
      const groups = dv.getUint32(best + 12);
      for (let i = 0; i < groups; i++) {
        const p = best + 16 + 12 * i, start = dv.getUint32(p), end = Math.min(dv.getUint32(p + 4), start + 0xffff), g0 = dv.getUint32(p + 8);
        for (let c = start; c <= end; c++) put(c, g0 + (c - start));
      }
    }
  } catch { /* truncated table: what was read */ }
  const head = dir.get(0x68656164), os2 = dir.get(0x4f532f32); // 'head', 'OS/2'
  const unitsPerEm = head ? dv.getUint16(head.offset + 18) || 2048 : 2048;
  // usDefaultChar (OS/2 version 2 and later): "a default glyph if a requested character is not supported in the font;
  // zero: glyph ID 0" (OpenType spec)
  const defaultChar = os2 && os2.length >= 96 && dv.getUint16(os2.offset) >= 2 ? dv.getUint16(os2.offset + 90) : 0;
  let notdef = { advance: Math.round(unitsPerEm / 2), box: null };
  try { notdef = parseNotdef(dv, dir, unitsPerEm) ?? notdef; } catch { /* truncated tables: a blank half-em */ }
  return { toGlyph, toChar, defaultChar, unitsPerEm, notdef };
}

/** Glyph 0 (.notdef): advance (hmtx) and outline box (glyf header, or for CFF outlines an estimate when not empty). */
function parseNotdef(dv, dir, unitsPerEm) {
  const tag = (s) => dir.get((s.charCodeAt(0) << 24 | s.charCodeAt(1) << 16 | s.charCodeAt(2) << 8 | s.charCodeAt(3)) >>> 0);
  const hmtx = tag('hmtx'), head = tag('head'), glyf = tag('glyf'), loca = tag('loca'), cff = tag('CFF '), os2 = tag('OS/2');
  if (!hmtx) return null;
  const advance = dv.getUint16(hmtx.offset), lsb = dv.getInt16(hmtx.offset + 2);
  if (glyf && loca && head) {
    const long = dv.getInt16(head.offset + 50) !== 0;
    const a = long ? dv.getUint32(loca.offset) : dv.getUint16(loca.offset) * 2, b = long ? dv.getUint32(loca.offset + 4) : dv.getUint16(loca.offset + 2) * 2;
    if (b <= a) return { advance, box: null };
    const g = glyf.offset + a;
    return { advance, box: { xMin: dv.getInt16(g + 2), yMin: dv.getInt16(g + 4), xMax: dv.getInt16(g + 6), yMax: dv.getInt16(g + 8) } };
  }
  if (cff && !cffGlyphEmpty(dv, cff.offset, 0)) {
    // a drawn CFF .notdef (usually a box): its side bearings from hmtx, the height of the capitals
    const cap = os2 && os2.length >= 96 && dv.getUint16(os2.offset) >= 2 ? dv.getInt16(os2.offset + 88) : 0;
    return { advance, box: { xMin: lsb, yMin: 0, xMax: Math.max(lsb + 1, advance - lsb), yMax: cap > 0 ? cap : Math.round(unitsPerEm * 0.7) } };
  }
  return { advance, box: null };
}

/** CFF INDEX at `p`: [start, end) of each entry, and the offset past the INDEX. */
function cffIndex(dv, p) {
  const count = dv.getUint16(p);
  if (!count) return { items: [], end: p + 2 };
  const size = dv.getUint8(p + 2), offs = [];
  for (let i = 0; i <= count; i++) { let v = 0; for (let k = 0; k < size; k++) v = v * 256 + dv.getUint8(p + 3 + i * size + k); offs.push(v); }
  const data = p + 3 + (count + 1) * size - 1;
  return { items: offs.slice(0, -1).map((o, i) => [data + o, data + offs[i + 1]]), end: data + offs[count] };
}

/** Does glyph `gid` of the CFF table at `cff` draw nothing (no moveto before its endchar)? */
function cffGlyphEmpty(dv, cff, gid) {
  const names = cffIndex(dv, cff + dv.getUint8(cff + 2)), top = cffIndex(dv, names.end);
  const [ts, te] = top.items[0];
  // Top DICT: the CharStrings offset (operator 17)
  let charStrings = -1; const args = [];
  for (let p = ts; p < te;) {
    const b = dv.getUint8(p);
    if (b <= 21) { const op = b === 12 ? 1200 + dv.getUint8(p + 1) : b; p += b === 12 ? 2 : 1; if (op === 17) charStrings = args[0]; args.length = 0; }
    else if (b === 28) { args.push(dv.getInt16(p + 1)); p += 3; }
    else if (b === 29) { args.push(dv.getInt32(p + 1)); p += 5; }
    else if (b === 30) { p++; while (p < te) { const n = dv.getUint8(p++); if ((n & 15) === 15 || n >> 4 === 15) break; } args.push(0); }
    else if (b <= 246) { args.push(b - 139); p++; }
    else if (b <= 250) { args.push((b - 247) * 256 + dv.getUint8(p + 1) + 108); p += 2; }
    else if (b <= 254) { args.push(-(b - 251) * 256 - dv.getUint8(p + 1) - 108); p += 2; }
    else p++;
  }
  if (charStrings < 0) return true;
  const glyphs = cffIndex(dv, cff + charStrings);
  if (gid >= glyphs.items.length) return true;
  // Type 2 charstring: stems are counted for the hintmask bytes; a moveto starts an outline
  const [s, e] = glyphs.items[gid];
  let n = 0, stems = 0;
  for (let p = s; p < e;) {
    const b = dv.getUint8(p);
    if (b === 28) { n++; p += 3; } else if (b === 255) { n++; p += 5; } else if (b >= 32) { n++; p += b <= 246 ? 1 : 2; }
    else if (b === 21 || b === 22 || b === 4) return false; // rmoveto, hmoveto, vmoveto
    else if (b === 14) return true; // endchar
    else if (b === 1 || b === 3 || b === 18 || b === 23) { stems += n >> 1; n = 0; p++; }
    else if (b === 19 || b === 20) { stems += n >> 1; n = 0; p += 1 + ((stems + 7) >> 3); }
    else if (b === 10 || b === 29) return false; // subroutines: assume they draw
    else { n = 0; p += b === 12 ? 2 : 1; }
  }
  return true;
}

/**
 * Parse every face of a .ttf/.otf file or a .ttc collection.
 * @param {Uint8Array} bytes
 * @returns {FontInfo[]} empty when the data is not an sfnt font
 */
export function parseFontFile(bytes) {
  if (bytes.length < 12) return [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = dv.getUint32(0);
  if (tag === 0x74746366) { // 'ttcf'
    const n = dv.getUint32(8), out = [];
    for (let i = 0; i < n && 12 + 4 * i + 4 <= bytes.length; i++) { const f = parseFace(dv, dv.getUint32(12 + 4 * i)); if (f) out.push(f); }
    return out;
  }
  const f = parseFace(dv, 0);
  return f ? [f] : [];
}

/** @returns {FontInfo|null} */
function parseFace(dv, off) {
  const ver = dv.getUint32(off);
  if (ver !== 0x00010000 && ver !== 0x4f54544f /* OTTO */ && ver !== 0x74727565 /* true */) return null;
  const numTables = dv.getUint16(off + 4);
  const tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const r = off + 12 + 16 * i;
    if (r + 16 > dv.byteLength) return null;
    const t = String.fromCharCode(dv.getUint8(r), dv.getUint8(r + 1), dv.getUint8(r + 2), dv.getUint8(r + 3));
    tables.set(t, { offset: dv.getUint32(r + 8), length: dv.getUint32(r + 12) });
  }
  const head = tables.get('head'), hhea = tables.get('hhea'), os2 = tables.get('OS/2'), name = tables.get('name'), post = tables.get('post');
  if (!head || !hhea) return null;
  const info = { family: '', subfamily: '', fullName: '', unitsPerEm: dv.getUint16(head.offset + 18) || 2048, winAscent: 0, winDescent: 0, typoAscender: 0, typoDescender: 0, typoLineGap: 0, hheaAscender: dv.getInt16(hhea.offset + 4), hheaDescender: dv.getInt16(hhea.offset + 6), hheaLineGap: dv.getInt16(hhea.offset + 8), avgCharWidth: 0, weight: 400, italic: (dv.getUint16(head.offset + 44) & 2) !== 0, fixedPitch: false, firstChar: 32, lastChar: 255, offset: off };
  if (os2 && os2.length >= 78) {
    const o = os2.offset;
    info.avgCharWidth = dv.getInt16(o + 2); info.weight = dv.getUint16(o + 4) || 400;
    const fsSelection = dv.getUint16(o + 62); if (fsSelection & 1) info.italic = true;
    info.firstChar = dv.getUint16(o + 64); info.lastChar = dv.getUint16(o + 66);
    info.typoAscender = dv.getInt16(o + 68); info.typoDescender = dv.getInt16(o + 70); info.typoLineGap = dv.getInt16(o + 72);
    info.winAscent = dv.getUint16(o + 74); info.winDescent = dv.getUint16(o + 76);
  }
  // font bounding box width (GDI's tmMaxCharWidth)
  info.bboxWidth = dv.getInt16(head.offset + 40) - dv.getInt16(head.offset + 36);
  if (!info.winAscent && !info.winDescent) { info.winAscent = info.hheaAscender; info.winDescent = -info.hheaDescender; }
  if (post && post.length >= 16) info.fixedPitch = dv.getUint32(post.offset + 12) !== 0;
  if (name) {
    const base = name.offset, count = dv.getUint16(base + 2), strings = base + dv.getUint16(base + 4);
    const best = {}; // nameID -> [score, string]
    for (let i = 0; i < count; i++) {
      const r = base + 6 + 12 * i;
      const platform = dv.getUint16(r), encoding = dv.getUint16(r + 2), lang = dv.getUint16(r + 4), id = dv.getUint16(r + 6), len = dv.getUint16(r + 8), so = strings + dv.getUint16(r + 10);
      if (id !== 1 && id !== 2 && id !== 4 && id !== 16) continue;
      if (so + len > dv.byteLength) continue;
      let s = '', score;
      if (platform === 3 || platform === 0) { for (let k = 0; k + 1 < len; k += 2) s += String.fromCharCode(dv.getUint16(so + k)); score = platform === 3 && lang === 0x409 ? 3 : platform === 3 ? 2 : 1; void encoding; }
      else if (platform === 1) { for (let k = 0; k < len; k++) s += String.fromCharCode(dv.getUint8(so + k)); score = 0; }
      else continue;
      if (!best[id] || best[id][0] < score) best[id] = [score, s];
    }
    // GDI names a face by its Windows family name (nameID 1), not the typographic family (16)
    info.family = best[1]?.[1] ?? best[16]?.[1] ?? '';
    info.subfamily = best[2]?.[1] ?? '';
    info.fullName = best[4]?.[1] ?? info.family;
  }
  return info.family ? info : null;
}
