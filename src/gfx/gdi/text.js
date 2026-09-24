// Text engine of the software GDI. A LOGFONT is *realized* into a pixel em size, GDI metrics
// (TEXTMETRIC: ascent/descent from the font's Windows metrics, internal/external leading, average and
// maximum widths) and integer per-character advances; strings are rasterized to 8-bit coverage and
// blended into DC surfaces with the text color, like GDI's grayscale font smoothing.
//
// Two rasterizers: the browser's font engine through an OffscreenCanvas 2D context (outline fonts —
// the ones an application registers with AddFontResource(Ex), read from its own files, and the host's
// system fonts standing in for the Windows ones), or the built-in bitmap font when no canvas exists
// (Node: tests and the CLI), whose output is unchanged from the original GDI text path.
import { parseFontFile } from './ttf.js';
import { drawText as drawBitmapText, CELL_W, CELL_H } from './font.js';

/** Windows face names -> CSS families of the host (metric-compatible stand-ins first). */
const SYSTEM_FACES = {
  'arial': 'Arial, "Liberation Sans", Arimo, Helvetica, sans-serif',
  'arial black': '"Arial Black", Arial, "Liberation Sans", sans-serif',
  'arial narrow': '"Arial Narrow", "Liberation Sans Narrow", Arial, sans-serif',
  'times new roman': '"Times New Roman", "Liberation Serif", Tinos, Times, serif',
  'times': '"Times New Roman", "Liberation Serif", Times, serif',
  'courier new': '"Courier New", "Liberation Mono", Cousine, Courier, monospace',
  'courier': '"Courier New", "Liberation Mono", Courier, monospace',
  'lucida console': '"Lucida Console", "Liberation Mono", "DejaVu Sans Mono", monospace',
  'consolas': 'Consolas, "Liberation Mono", monospace',
  'tahoma': 'Tahoma, Verdana, "DejaVu Sans", sans-serif',
  'verdana': 'Verdana, "DejaVu Sans", sans-serif',
  'ms sans serif': '"Microsoft Sans Serif", Tahoma, Arial, "Liberation Sans", sans-serif',
  'microsoft sans serif': '"Microsoft Sans Serif", Tahoma, Arial, "Liberation Sans", sans-serif',
  'ms shell dlg': 'Tahoma, "Microsoft Sans Serif", Arial, sans-serif',
  'ms shell dlg 2': 'Tahoma, Arial, sans-serif',
  'ms serif': '"Times New Roman", "Liberation Serif", serif',
  'system': 'Arial, "Liberation Sans", sans-serif',
  'fixedsys': '"Courier New", "Liberation Mono", monospace',
  'terminal': '"Courier New", "Liberation Mono", monospace',
  'comic sans ms': '"Comic Sans MS", "Comic Neue", cursive',
  'georgia': 'Georgia, "Liberation Serif", serif',
  'trebuchet ms': '"Trebuchet MS", "DejaVu Sans", sans-serif',
  'impact': 'Impact, "Arial Black", sans-serif',
  'palatino linotype': '"Palatino Linotype", Palatino, "Liberation Serif", serif',
  'book antiqua': '"Book Antiqua", Palatino, serif',
  'garamond': 'Garamond, "Liberation Serif", serif',
  'lucida sans unicode': '"Lucida Sans Unicode", "Lucida Grande", "DejaVu Sans", sans-serif',
  'segoe ui': '"Segoe UI", Tahoma, Arial, sans-serif',
};
/** Windows fonts reported by font enumeration besides the registered ones (TrueType, ANSI). */
export const ENUMERATED_SYSTEM_FACES = ['Arial', 'Courier New', 'Times New Roman', 'Tahoma', 'Verdana', 'Lucida Console', 'Microsoft Sans Serif', 'Georgia', 'Trebuchet MS', 'Comic Sans MS'];

/** LOGFONT quality values */
const NONANTIALIASED_QUALITY = 3;
const FW_NORMAL = 400;

/**
 * @typedef {{ height: number, width?: number, weight?: number, italic?: number, underline?: number, strike?: number,
 *   charset?: number, quality?: number, pitchAndFamily?: number, face?: string, escapement?: number }} LogFont
 * @typedef {{ key: string, bitmap: boolean, css: string, em: number, hscale: number, ascent: number, descent: number,
 *   height: number, internalLeading: number, externalLeading: number, aveCharWidth: number, maxCharWidth: number,
 *   weight: number, italic: boolean, underline: boolean, strike: boolean, charset: number, fixedPitch: boolean,
 *   face: string, antialias: boolean, scale: number, adv: Map<number, number>, family: number }} RealFont
 */

export class TextEngine {
  constructor() {
    /** registered faces: lower-case family / full name -> { info, css } */
    this.faces = new Map();
    this.pending = 0; // font files still being decoded by the browser
    this.version = 0; // bumped when a registered face finishes loading (realized fonts are recomputed)
    this.canvas = null; this.ctx = null;
    this.hasCanvas = typeof OffscreenCanvas !== 'undefined' && typeof FontFace !== 'undefined';
    this.fontSet = this.hasCanvas ? (globalThis.fonts ?? globalThis.document?.fonts ?? null) : null;
    this.files = new Map(); // registered path (lower case) -> families
  }

  /** Ready to measure: no registered font file is still loading (a thread may wait on this after AddFontResource). */
  get ready() { return this.pending === 0; }

  /**
   * AddFontResource(Ex): register the faces of a font file (TrueType/OpenType/collection).
   * @param {string} path identifies the file (registering twice is a no-op)
   * @param {Uint8Array} bytes
   * @returns {number} number of faces added (0: not a font this engine can use)
   */
  registerFontFile(path, bytes) {
    const k = path.toLowerCase();
    if (this.files.has(k)) return this.files.get(k).length;
    const infos = parseFontFile(bytes);
    this.files.set(k, infos.map((i) => i.family));
    for (const info of infos) {
      const css = `"${info.family.replace(/"/g, '')}"`;
      const entry = { info, css };
      if (!this.faces.has(info.family.toLowerCase()) || !/bold|italic/i.test(info.subfamily)) this.faces.set(info.family.toLowerCase(), entry);
      if (info.fullName) this.faces.set(info.fullName.toLowerCase(), entry);
      if (this.hasCanvas && this.fontSet) {
        try {
          const desc = { weight: String(info.weight), style: info.italic ? 'italic' : 'normal' };
          // a collection face is its own sfnt starting at `offset`: the browser needs the single font
          const data = info.offset ? extractFace(bytes, info.offset) : bytes;
          const face = new FontFace(info.family, data.slice().buffer, desc);
          this.pending++;
          face.load().then(() => { this.fontSet.add(face); }, () => {}).finally(() => { this.pending--; this.version++; if (!this.pending) this.onReady?.(); });
        } catch { /* unusable font data: the face falls back to a system family */ }
      }
    }
    return infos.length;
  }

  /** Families registered through AddFontResource, for font enumeration. */
  registeredFamilies() { const out = new Map(); for (const e of this.faces.values()) out.set(e.info.family, e.info); return [...out.values()]; }

  /** Does a face name resolve to a registered or known system font? */
  knows(face) { const f = (face ?? '').toLowerCase(); return this.faces.has(f) || f in SYSTEM_FACES; }

  /**
   * Realize a GDI font object (cached on it until a registered font finishes loading).
   * @param {LogFont} lf
   * @returns {RealFont}
   */
  realize(lf) {
    if (lf._real && lf._realVersion === this.version) return lf._real;
    const r = this.hasCanvas ? this.realizeCanvas(lf) : realizeBitmap(lf);
    lf._real = r; lf._realVersion = this.version;
    return r;
  }

  realizeCanvas(lf) {
    const faceName = (lf.face ?? '').trim();
    const reg = this.faces.get(faceName.toLowerCase());
    const pf = lf.pitchAndFamily ?? 0;
    const generic = (pf & 3) === 1 || (pf & 0xf0) === 0x30 ? 'monospace' : (pf & 0xf0) === 0x10 ? 'serif' : 'sans-serif';
    const css = reg ? `${reg.css}, ${generic}` : SYSTEM_FACES[faceName.toLowerCase()] ?? (generic === 'monospace' ? SYSTEM_FACES['courier new'] : generic === 'serif' ? SYSTEM_FACES['times new roman'] : SYSTEM_FACES.arial);
    const weight = lf.weight > 0 ? Math.min(1000, lf.weight) : FW_NORMAL;
    const italic = !!lf.italic;
    const ctx = this.context();
    // vertical metrics per unit of em: the font's Windows metrics when we have its file, else the browser's font box
    let asc, desc, lineGapExt, avg, fixed;
    if (reg) {
      const i = reg.info, u = i.unitsPerEm;
      asc = i.winAscent / u; desc = i.winDescent / u;
      lineGapExt = Math.max(0, i.hheaLineGap - ((i.winAscent + i.winDescent) - (i.hheaAscender - i.hheaDescender))) / u;
      avg = i.avgCharWidth > 0 ? i.avgCharWidth / u : 0; fixed = i.fixedPitch;
    } else {
      ctx.font = `${italic ? 'italic ' : ''}${weight} 100px ${css}`;
      const m = ctx.measureText('Hg');
      asc = (m.fontBoundingBoxAscent ?? 91) / 100; desc = (m.fontBoundingBoxDescent ?? 21) / 100; lineGapExt = 0.03;
      avg = 0; fixed = generic === 'monospace';
    }
    let em;
    const h = lf.height | 0;
    if (h < 0) em = -h; else if (h > 0) em = h / (asc + desc); else em = 12 / (asc + desc) * 1.0; // lfHeight 0: the default 12-pixel cell
    const ascent = Math.round(asc * em), descent = Math.round(desc * em);
    const height = ascent + descent;
    const font = `${italic ? 'italic ' : ''}${weight} ${em}px ${css}`;
    ctx.font = font;
    const xw = ctx.measureText('x').width;
    let aveCharWidth = avg ? Math.round(avg * em) : Math.round(measureAverage(ctx));
    if (aveCharWidth <= 0) aveCharWidth = Math.max(1, Math.round(xw));
    const hscale = lf.width > 0 ? lf.width / aveCharWidth : 1;
    if (lf.width > 0) aveCharWidth = lf.width;
    const r = {
      key: font + '|' + hscale, bitmap: false, css, em, hscale, font, ascent, descent, height,
      internalLeading: Math.max(0, height - Math.round(em)), externalLeading: Math.round(lineGapExt * em),
      aveCharWidth, maxCharWidth: 0, weight, italic, underline: !!lf.underline, strike: !!lf.strike, charset: lf.charset ?? 0,
      fixedPitch: fixed, face: reg ? reg.info.family : faceName || 'Arial', antialias: (lf.quality ?? 0) !== NONANTIALIASED_QUALITY,
      scale: 1, adv: new Map(), family: pf & 0xf0 || (generic === 'serif' ? 0x10 : generic === 'monospace' ? 0x30 : 0x20),
    };
    r.maxCharWidth = Math.max(aveCharWidth, Math.round(ctx.measureText('W').width * hscale), Math.round(ctx.measureText('M').width * hscale));
    return r;
  }

  context() {
    if (!this.ctx) { this.canvas = new OffscreenCanvas(256, 64); this.ctx = this.canvas.getContext('2d', { willReadFrequently: true }); }
    return this.ctx;
  }

  /** Integer advance of one character (GDI positions every glyph on whole pixels). */
  advance(r, code) {
    let a = r.adv.get(code);
    if (a !== undefined) return a;
    if (r.bitmap) a = CELL_W * r.scale;
    else { const ctx = this.context(); ctx.font = r.font; a = Math.round(ctx.measureText(String.fromCharCode(code)).width * r.hscale); }
    r.adv.set(code, a);
    return a;
  }

  /** Advances of every character of `text` (plus `extra` per character, SetTextCharacterExtra). */
  advances(r, text, extra = 0) {
    const out = new Int32Array(text.length);
    for (let i = 0; i < text.length; i++) out[i] = this.advance(r, text.charCodeAt(i)) + extra;
    return out;
  }

  /** GetTextExtentPoint: total advance and cell height. */
  extent(r, text, extra = 0) { let w = 0; for (let i = 0; i < text.length; i++) w += this.advance(r, text.charCodeAt(i)) + extra; return { w, h: r.height }; }

  /** ABC widths of a character: A = left bearing, B = ink width, C = right bearing (A + B + C = advance). */
  abc(r, code) {
    const adv = this.advance(r, code);
    if (r.bitmap) return { a: 0, b: adv, c: 0 };
    const ctx = this.context(); ctx.font = r.font;
    const m = ctx.measureText(String.fromCharCode(code));
    const left = Math.floor(-(m.actualBoundingBoxLeft ?? 0) * r.hscale), right = Math.ceil((m.actualBoundingBoxRight ?? adv) * r.hscale);
    const b = Math.max(1, right - left);
    return { a: left, b, c: adv - left - b };
  }

  /**
   * Draw a string with its character cell's top-left corner at (x, y) in device pixels.
   * @param {import('./surface.js').Surface} surf
   * @param {{l:number,t:number,r:number,b:number}} clip
   * @param {RealFont} r
   * @param {Int32Array} adv per-character advances (the caller's lpDx or the font's)
   * @param {number|null} bg opaque cell background (OPAQUE background mode), 0xRRGGBB
   */
  draw(surf, clip, x, y, text, r, color, adv, bg = null) {
    let total = 0; for (let i = 0; i < adv.length; i++) total += adv[i];
    if (bg !== null) fill(surf, clip, x, y, x + total, y + r.height, bg);
    if (r.bitmap) { let px = x; for (let i = 0; i < text.length; i++) { drawBitmapText(surf, clip, px, y, text[i], color, r.scale, null); px += adv[i]; } return; }
    if (!text.length) return;
    // rasterize the whole run once (glyphs on their integer pen positions), then blend the coverage
    const pad = Math.ceil(r.em * 0.5) + 2;
    const w = Math.min(8192, total + 2 * pad), h = r.height + 2 * pad;
    const ctx = this.context();
    if (this.canvas.width < w || this.canvas.height < h) { this.canvas.width = Math.max(this.canvas.width, w); this.canvas.height = Math.max(this.canvas.height, h); }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = r.font; ctx.fillStyle = '#fff'; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    if ('fontKerning' in ctx) ctx.fontKerning = 'none';
    let pen = pad;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch !== ' ' && ch !== '\t') {
        if (r.hscale !== 1) { ctx.setTransform(r.hscale, 0, 0, 1, pen, 0); ctx.fillText(ch, 0, pad + r.ascent); ctx.setTransform(1, 0, 0, 1, 0, 0); }
        else ctx.fillText(ch, pen, pad + r.ascent);
      }
      pen += adv[i];
    }
    const thick = Math.max(1, Math.round(r.em / 14));
    if (r.underline) ctx.fillRect(pad, pad + r.ascent + Math.max(1, Math.round(r.descent / 2)) - (thick >> 1), total, thick);
    if (r.strike) ctx.fillRect(pad, pad + r.ascent - Math.round(r.ascent / 3), total, thick);
    const img = ctx.getImageData(0, 0, w, h).data;
    const cr = (color >> 16) & 0xff, cg = (color >> 8) & 0xff, cb = color & 0xff;
    const ox = x - pad, oy = y - pad;
    const x0 = Math.max(clip.l, ox, 0), x1 = Math.min(clip.r, ox + w, surf.width), y0 = Math.max(clip.t, oy, 0), y1 = Math.min(clip.b, oy + h, surf.height);
    for (let py = y0; py < y1; py++) {
      const row = (py - oy) * w;
      for (let px = x0; px < x1; px++) {
        let a = img[(row + (px - ox)) * 4 + 3];
        if (!a) continue;
        if (!r.antialias) { if (a < 128) continue; a = 255; }
        if (a === 255) { surf.setPixel(px, py, color); continue; }
        const d = surf.getPixel(px, py), ia = 255 - a;
        const nr = (cr * a + ((d >> 16) & 0xff) * ia + 127) / 255 | 0, ng = (cg * a + ((d >> 8) & 0xff) * ia + 127) / 255 | 0, nb = (cb * a + (d & 0xff) * ia + 127) / 255 | 0;
        surf.setPixel(px, py, (nr << 16) | (ng << 8) | nb);
      }
    }
  }

  /**
   * GetGlyphOutline bitmap formats: one character's coverage in its black box.
   * @returns {{ w: number, h: number, originX: number, originY: number, advance: number, data: Uint8Array }}
   */
  glyph(r, code) {
    const adv = this.advance(r, code);
    if (r.bitmap) {
      const w = CELL_W * r.scale, h = CELL_H * r.scale, data = new Uint8Array(w * h);
      const s = { width: w, height: h, setPixel: (x, y) => { data[y * w + x] = 255; }, getPixel: () => 0 };
      drawBitmapText(s, { l: 0, t: 0, r: w, b: h }, 0, 0, String.fromCharCode(code), 0xffffff, r.scale, null);
      return trimGlyph(data, w, h, 0, r.ascent, adv);
    }
    const pad = Math.ceil(r.em) + 2, w = adv + 2 * pad, h = r.height + 2 * pad;
    const ctx = this.context();
    if (this.canvas.width < w || this.canvas.height < h) { this.canvas.width = Math.max(this.canvas.width, w); this.canvas.height = Math.max(this.canvas.height, h); }
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, w, h);
    ctx.font = r.font; ctx.fillStyle = '#fff'; ctx.textBaseline = 'alphabetic';
    if (r.hscale !== 1) ctx.setTransform(r.hscale, 0, 0, 1, pad, 0); else ctx.setTransform(1, 0, 0, 1, pad, 0);
    ctx.fillText(String.fromCharCode(code), 0, pad + r.ascent);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const img = ctx.getImageData(0, 0, w, h).data, data = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) data[i] = r.antialias ? img[i * 4 + 3] : (img[i * 4 + 3] >= 128 ? 255 : 0);
    return trimGlyph(data, w, h, pad, pad + r.ascent, adv);
  }
}

/** Font realization without a canvas: the built-in 8x12 bitmap font, integer-scaled (original GDI behaviour). */
function realizeBitmap(lf) {
  const scale = Math.max(1, Math.round(Math.abs(lf.height | 0) / 12));
  const height = CELL_H * scale;
  return { key: 'bitmap' + scale, bitmap: true, css: '', em: height - 3 * scale, hscale: 1, font: '', ascent: height - 3 * scale, descent: 3 * scale, height, internalLeading: 2 * scale, externalLeading: 0, aveCharWidth: CELL_W * scale, maxCharWidth: CELL_W * scale, weight: lf.weight || FW_NORMAL, italic: !!lf.italic, underline: !!lf.underline, strike: !!lf.strike, charset: lf.charset ?? 0, fixedPitch: true, face: lf.face || 'System', antialias: false, scale, adv: new Map(), family: 0x30 };
}

/** Letter-frequency weights of the OpenType OS/2 xAvgCharWidth definition (versions 0-2): a..z, then space. */
const AVG_WEIGHTS = [64, 14, 27, 35, 100, 20, 14, 42, 63, 3, 6, 35, 20, 56, 56, 17, 4, 49, 56, 71, 31, 10, 18, 3, 18, 2, 166];
function measureAverage(ctx) {
  // tmAveCharWidth for fonts without their OS/2 table at hand: the frequency-weighted width of 'a'..'z' and space
  let sum = 0;
  for (let i = 0; i < 27; i++) sum += ctx.measureText(i < 26 ? String.fromCharCode(97 + i) : ' ').width * AVG_WEIGHTS[i];
  return sum / 1000;
}

function fill(surf, clip, l, t, r, b, color) {
  const x0 = Math.max(l, clip.l, 0), x1 = Math.min(r, clip.r, surf.width), y0 = Math.max(t, clip.t, 0), y1 = Math.min(b, clip.b, surf.height);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) surf.setPixel(x, y, color);
}

/** Crop a glyph coverage image to its ink box; origin = ink box top-left relative to the pen point on the baseline. */
function trimGlyph(data, w, h, penX, baseY, advance) {
  let l = w, r = -1, t = h, b = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[y * w + x]) { if (x < l) l = x; if (x > r) r = x; if (y < t) t = y; if (y > b) b = y; }
  if (r < 0) return { w: 1, h: 1, originX: 0, originY: 0, advance, data: new Uint8Array(1) };
  const gw = r - l + 1, gh = b - t + 1, out = new Uint8Array(gw * gh);
  for (let y = 0; y < gh; y++) out.set(data.subarray((t + y) * w + l, (t + y) * w + l + gw), y * gw);
  return { w: gw, h: gh, originX: l - penX, originY: baseY - t, advance, data: out };
}

/** One face of a TrueType collection as a standalone sfnt (table directory rebased, tables copied). */
function extractFace(bytes, off) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint16(off + 4);
  const tables = [];
  for (let i = 0; i < n; i++) { const r = off + 12 + 16 * i; tables.push({ rec: bytes.subarray(r, r + 16), offset: dv.getUint32(r + 8), length: dv.getUint32(r + 12) }); }
  let size = 12 + 16 * n; for (const t of tables) size += (t.length + 3) & ~3;
  const out = new Uint8Array(size), odv = new DataView(out.buffer);
  out.set(bytes.subarray(off, off + 12), 0);
  let p = 12 + 16 * n;
  tables.forEach((t, i) => { out.set(t.rec, 12 + 16 * i); odv.setUint32(12 + 16 * i + 8, p); out.set(bytes.subarray(t.offset, t.offset + t.length), p); p += (t.length + 3) & ~3; });
  return out;
}
