// Minimal TrueType/OpenType header reader for fonts registered by applications (AddFontResource):
// family and face names, weight/style, and the vertical metrics GDI derives a font's cell from
// (head.unitsPerEm, OS/2 usWinAscent/usWinDescent, hhea line gap, xAvgCharWidth). Glyph outlines
// are left to the rasterizer (the browser's font engine). Written from the public OpenType spec.

/**
 * @typedef {{ family: string, subfamily: string, fullName: string, unitsPerEm: number, winAscent: number,
 *   winDescent: number, typoAscender: number, typoDescender: number, typoLineGap: number, hheaAscender: number,
 *   hheaDescender: number, hheaLineGap: number, avgCharWidth: number, weight: number, italic: boolean,
 *   fixedPitch: boolean, firstChar: number, lastChar: number, offset: number }} FontInfo
 */

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
