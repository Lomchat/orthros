// gdi32.dll: device contexts, GDI objects, software rasterization onto Surfaces.
import { E } from './errors.js';
import { Surface, allocSurface, freeSurface } from '../gfx/gdi/surface.js';
import { fillRect, opRect, blit, stretchBlit, line, ellipse, polygon, clipRect, rectEmpty, ROPS } from '../gfx/gdi/raster.js';
import { TextEngine, ENUMERATED_SYSTEM_FACES } from '../gfx/gdi/text.js';
import { PAGE_READWRITE } from './vmem.js';

export const SRCCOPY = 0x00cc0020;

/** Per-process GDI state. */
export class GdiState {
  constructor(proc) {
    this.proc = proc;
    this.stock = new Map();
    this.screenDC = null;
  }
}

export function gdiOf(proc) { return proc.gdi ?? (proc.gdi = new GdiState(proc)); }

export function makeDC(proc, surface, opts = {}) {
  const dc = {
    type: 'gdi', kind: 'dc', surface, hwnd: opts.hwnd ?? 0, window: opts.window ?? null,
    ox: opts.ox ?? 0, oy: opts.oy ?? 0, // device origin of logical (0,0)
    clip: opts.clip ?? (surface ? { l: 0, t: 0, r: surface.width, b: surface.height } : { l: 0, t: 0, r: 0, b: 0 }),
    pen: stockHandle(proc, 7), brush: stockHandle(proc, 0), font: stockHandle(proc, 13), bitmap: 0, palette: stockHandle(proc, 15),
    bkColor: 0xffffff, textColor: 0, bkMode: 2, rop2: 13, stretchMode: 3, textAlign: 0, mapMode: 1,
    cur: { x: 0, y: 0 }, saved: [], memory: !!opts.memory, ownsBitmap: opts.ownsBitmap ?? null, polyFill: 1,
    vpOrg: { x: 0, y: 0 }, wndOrg: { x: 0, y: 0 }, brushOrg: { x: 0, y: 0 }, clipRgn: null,
  };
  dc.handle = proc.handles.create(dc);
  return dc;
}

function stockHandle(proc, i) {
  const g = gdiOf(proc);
  let h = g.stock.get(i);
  if (h !== undefined) return h;
  let o;
  const brush = (color, style = 0) => ({ type: 'gdi', kind: 'brush', style, color, stock: true });
  const pen = (color) => ({ type: 'gdi', kind: 'pen', style: 0, width: 1, color, stock: true });
  const font = (h, face, weight = 400, pf = 0) => ({ type: 'gdi', kind: 'font', height: h, width: 0, weight, italic: 0, underline: 0, strike: 0, charset: 0, quality: 0, pitchAndFamily: pf, face, stock: true });
  switch (i) {
    case 0: o = brush(0xffffff); break; // WHITE_BRUSH
    case 1: o = brush(0xc0c0c0); break; // LTGRAY
    case 2: o = brush(0x808080); break; // GRAY
    case 3: o = brush(0x404040); break; // DKGRAY
    case 4: o = brush(0x000000); break; // BLACK
    case 5: o = brush(0, 1); break; // NULL_BRUSH (hollow)
    case 6: o = pen(0xffffff); break; // WHITE_PEN
    case 7: o = pen(0x000000); break; // BLACK_PEN
    case 8: o = { type: 'gdi', kind: 'pen', style: 5, width: 1, color: 0, stock: true }; break; // NULL_PEN
    case 10: o = font(12, 'Terminal', 400, 0x31); break; // OEM_FIXED_FONT
    case 11: o = font(13, 'Courier', 400, 0x31); break; // ANSI_FIXED_FONT
    case 12: o = font(13, 'MS Sans Serif', 400, 0x22); break; // ANSI_VAR_FONT
    case 13: case 14: o = font(16, 'System', 700, 0x22); break; // SYSTEM_FONT, DEVICE_DEFAULT_FONT
    case 16: o = font(15, 'Fixedsys', 400, 0x31); break; // SYSTEM_FIXED_FONT
    case 17: o = font(-11, 'MS Shell Dlg', 400, 0x22); break; // DEFAULT_GUI_FONT
    case 15: o = { type: 'gdi', kind: 'palette', entries: defaultPalette(), stock: true }; break;
    default: o = brush(0xffffff);
  }
  h = proc.handles.create(o);
  g.stock.set(i, h);
  return h;
}

let defaultPal = null;
function defaultPalette() {
  if (defaultPal) return defaultPal;
  const p = new Uint32Array(256);
  const sys = [0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xc0c0c0, 0xc0dcc0, 0xa6caf0];
  const sys2 = [0xfffbf0, 0xa0a0a4, 0x808080, 0xff0000, 0x00ff00, 0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff];
  for (let i = 0; i < 10; i++) { p[i] = sys[i]; p[246 + i] = sys2[i]; }
  for (let i = 10; i < 246; i++) { const k = i - 10; p[i] = (((k >> 4) & 3) * 85) << 16 | (((k >> 2) & 3) * 85) << 8 | ((k & 3) * 85); }
  return (defaultPal = p);
}

/** COLORREF (0x00BBGGRR) -> internal 0x00RRGGBB. */
export function crToRgb(cr) { return ((cr & 0xff) << 16) | (cr & 0xff00) | ((cr >> 16) & 0xff); }
export function rgbToCr(c) { return ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff); }

/** Parse a BITMAPINFO in guest memory. */
export function parseBitmapInfo(mem, addr, usage = 0) {
  const size = mem.read32(addr);
  let width, height, bpp, compression, clrUsed, headerSize = size;
  if (size === 12) { // BITMAPCOREHEADER
    width = mem.read16(addr + 4); height = mem.readS16(addr + 6); bpp = mem.read16(addr + 10); compression = 0; clrUsed = 0;
  } else {
    width = mem.readS32(addr + 4); height = mem.readS32(addr + 8); bpp = mem.read16(addr + 14); compression = mem.read32(addr + 16); clrUsed = mem.read32(addr + 32);
  }
  const topDown = height < 0;
  height = Math.abs(height);
  let palette = null, masks = null, colorsSize = 0;
  if (bpp <= 8) {
    const n = clrUsed || (1 << bpp);
    palette = new Uint32Array(1 << bpp);
    const entry = size === 12 ? 3 : 4;
    for (let i = 0; i < n && i < palette.length; i++) {
      const p = addr + headerSize + i * entry;
      palette[i] = usage === 1 ? defaultPalette()[mem.read16(p) & 0xff] : mem.u8[p] | (mem.u8[p + 1] << 8) | (mem.u8[p + 2] << 16);
    }
    colorsSize = n * entry;
  } else if (compression === 3) {
    masks = [mem.read32(addr + headerSize), mem.read32(addr + headerSize + 4), mem.read32(addr + headerSize + 8)];
    colorsSize = 12;
    if (size >= 52) colorsSize = 0; // BITMAPV4+: masks inside the header
  } else if (bpp === 16) masks = [0x7c00, 0x3e0, 0x1f];
  return { width, height, topDown, bpp, compression, palette, masks, headerSize, colorsSize, rowBytes: Surface.rowBytes(width, bpp) };
}

/** Surface over existing DIB bits in guest memory. */
export function dibSurface(mem, bits, info) {
  const addr = info.topDown ? bits : bits + (info.height - 1) * info.rowBytes;
  return new Surface(mem, addr, info.width, info.height, info.topDown ? info.rowBytes : -info.rowBytes, info.bpp, { palette: info.palette, masks: info.masks });
}

/**
 * @param {import('./api.js').ApiRegistry} api
 * @param {import('../core/vm.js').Vm} vm
 */
/** The realized font selected into a DC (text engine of gfx/gdi/text.js, shared by gdi32 and user32). */
export function dcFont(vm, proc, dc) {
  const engine = vm.textEngine ?? (vm.textEngine = new TextEngine());
  const f = proc.handles.getAs(dc.font, 'gdi');
  return { engine, font: engine.realize(f && f.kind === 'font' ? f : { height: 16, weight: 700, face: 'System' }) };
}

export function registerGdi32(api, vm) {
  const mem = vm.mem;
  const G = {};
  const obj = (c, h) => c.proc.handles.getAs(h, 'gdi');
  const dcOf = (c, h) => { const o = obj(c, h); return o && o.kind === 'dc' ? o : null; };
  const readRect = (a) => ({ l: mem.readS32(a), t: mem.readS32(a + 4), r: mem.readS32(a + 8), b: mem.readS32(a + 12) });
  const writeRect = (a, r) => { mem.write32(a, r.l); mem.write32(a + 4, r.t); mem.write32(a + 8, r.r); mem.write32(a + 12, r.b); };
  const dev = (dc, x, y) => ({ x: x + dc.ox + dc.vpOrg.x - dc.wndOrg.x, y: y + dc.oy + dc.vpOrg.y - dc.wndOrg.y });
  const brushColor = (c, dc) => { const b = obj(c, dc.brush); if (!b || b.kind !== 'brush' || b.style === 1) return null; return b.color; };
  const penColor = (c, dc) => { const p = obj(c, dc.pen); if (!p || p.kind !== 'pen' || p.style === 5) return null; return p.color; };
  const penWidth = (c, dc) => { const p = obj(c, dc.pen); return p ? Math.max(1, p.width) : 1; };
  const touched = (dc) => { if (dc.window) vm.wm?.touch(dc.window); };
  const engine = () => vm.textEngine ?? (vm.textEngine = new TextEngine());
  /** The realized font selected into a DC (see gfx/gdi/text.js). */
  const loggedFonts = new Set();
  const realFont = (c, dc) => {
    const f = obj(c, dc.font);
    const r = engine().realize(f && f.kind === 'font' ? f : { height: 16, weight: 700, face: 'System' });
    if (!loggedFonts.has(r.key) && loggedFonts.size < 64) { loggedFonts.add(r.key); vm.log('gfx', `font: "${f?.face ?? ''}" height ${f?.height} weight ${f?.weight} quality ${f?.quality ?? 0} -> ${r.bitmap ? 'built-in bitmap' : r.font} ascent ${r.ascent} descent ${r.descent} ave ${r.aveCharWidth}`); }
    return r;
  };
  /** ANSI (Windows-1252) text as Unicode for the font engine: 0x80-0x9F are typographic characters, not controls. */
  const CP1252 = [0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178];
  const ansi = (s) => (/[\x80-\x9f]/.test(s) ? s.replace(/[\x80-\x9f]/g, (ch) => String.fromCharCode(CP1252[ch.charCodeAt(0) - 0x80])) : s);
  const ansiCode = (code) => (code >= 0x80 && code <= 0x9f ? CP1252[code - 0x80] : code);

  // ---------------------------------------------------------------- objects
  G.GetStockObject = [1, (c) => stockHandle(c.proc, c.arg(0))];
  G.CreateSolidBrush = [1, (c) => c.proc.handles.create({ type: 'gdi', kind: 'brush', style: 0, color: crToRgb(c.arg(0)) })];
  G.CreateBrushIndirect = [1, (c) => { const p = c.arg(0); const style = mem.read32(p); return c.proc.handles.create({ type: 'gdi', kind: 'brush', style: style === 1 ? 1 : 0, color: crToRgb(mem.read32(p + 4)) }); }];
  G.CreateHatchBrush = [2, (c) => c.proc.handles.create({ type: 'gdi', kind: 'brush', style: 0, color: crToRgb(c.arg(1)) })];
  G.CreatePatternBrush = [1, (c) => { const bm = obj(c, c.arg(0)); return c.proc.handles.create({ type: 'gdi', kind: 'brush', style: 3, color: bm?.surface?.getPixel(0, 0) ?? 0, bitmap: c.arg(0) }); }];
  G.CreateDIBPatternBrushPt = [2, (c) => c.proc.handles.create({ type: 'gdi', kind: 'brush', style: 3, color: 0x808080 })];
  G.CreatePen = [3, (c) => c.proc.handles.create({ type: 'gdi', kind: 'pen', style: c.arg(0) & 0xf, width: c.arg(1), color: crToRgb(c.arg(2)) })];
  G.CreatePenIndirect = [1, (c) => { const p = c.arg(0); return c.proc.handles.create({ type: 'gdi', kind: 'pen', style: mem.read32(p) & 0xf, width: mem.read32(p + 4), color: crToRgb(mem.read32(p + 12)) }); }];
  G.ExtCreatePen = [5, (c) => c.proc.handles.create({ type: 'gdi', kind: 'pen', style: c.arg(0) & 0xf, width: c.arg(1), color: crToRgb(mem.read32(c.arg(2) + 4)) })];
  const fontFromLogfont = (c, p, wide) => {
    const face = wide ? mem.readWString(p + 28, 32) : mem.readCString(p + 28, 32);
    return { type: 'gdi', kind: 'font', height: mem.readS32(p), width: mem.readS32(p + 4), escapement: mem.readS32(p + 8), orientation: mem.readS32(p + 12), weight: mem.readS32(p + 16), italic: mem.read8(p + 20), underline: mem.read8(p + 21), strike: mem.read8(p + 22), charset: mem.read8(p + 23), outPrecision: mem.read8(p + 24), clipPrecision: mem.read8(p + 25), quality: mem.read8(p + 26), pitchAndFamily: mem.read8(p + 27), face };
  };
  const fontFromArgs = (c, face) => ({ type: 'gdi', kind: 'font', height: c.sarg(0), width: c.sarg(1), escapement: c.sarg(2), orientation: c.sarg(3), weight: c.sarg(4), italic: c.arg(5) & 0xff, underline: c.arg(6) & 0xff, strike: c.arg(7) & 0xff, charset: c.arg(8) & 0xff, outPrecision: c.arg(9) & 0xff, clipPrecision: c.arg(10) & 0xff, quality: c.arg(11) & 0xff, pitchAndFamily: c.arg(12) & 0xff, face: face ?? '' });
  /** LOGFONTA/W (60/92 bytes) of a font object. */
  const writeLogfont = (p, o, wide) => {
    mem.fill(p, wide ? 92 : 60, 0);
    mem.write32(p, o.height | 0); mem.write32(p + 4, o.width | 0); mem.write32(p + 8, o.escapement | 0); mem.write32(p + 12, o.orientation | 0); mem.write32(p + 16, o.weight | 0);
    mem.write8(p + 20, o.italic ?? 0); mem.write8(p + 21, o.underline ?? 0); mem.write8(p + 22, o.strike ?? 0); mem.write8(p + 23, o.charset ?? 0);
    mem.write8(p + 24, o.outPrecision ?? 0); mem.write8(p + 25, o.clipPrecision ?? 0); mem.write8(p + 26, o.quality ?? 0); mem.write8(p + 27, o.pitchAndFamily ?? 0);
    if (wide) mem.writeWString(p + 28, o.face ?? '', 32); else mem.writeCString(p + 28, o.face ?? '', 32);
  };
  G.CreateFontIndirectA = [1, (c) => c.proc.handles.create(fontFromLogfont(c, c.arg(0), false))];
  G.CreateFontIndirectW = [1, (c) => c.proc.handles.create(fontFromLogfont(c, c.arg(0), true))];
  G.CreateFontA = [14, (c) => c.proc.handles.create(fontFromArgs(c, c.str(13)))];
  G.CreateFontW = [14, (c) => c.proc.handles.create(fontFromArgs(c, c.wstr(13)))];
  G.CreateFontIndirectExA = [1, (c) => c.proc.handles.create(fontFromLogfont(c, c.arg(0), false))]; // ENUMLOGFONTEXDV starts with the LOGFONT
  G.CreateFontIndirectExW = [1, (c) => c.proc.handles.create(fontFromLogfont(c, c.arg(0), true))];
  G.CreatePalette = [1, (c) => { const p = c.arg(0); const n = mem.read16(p + 2); const entries = new Uint32Array(Math.max(n, 1)); for (let i = 0; i < n; i++) { const e = p + 4 + 4 * i; entries[i] = (mem.u8[e] << 16) | (mem.u8[e + 1] << 8) | mem.u8[e + 2]; } return c.proc.handles.create({ type: 'gdi', kind: 'palette', entries }); }];
  G.CreateRectRgn = [4, (c) => c.proc.handles.create({ type: 'gdi', kind: 'region', rects: [{ l: c.sarg(0), t: c.sarg(1), r: c.sarg(2), b: c.sarg(3) }] })];
  G.CreateRectRgnIndirect = [1, (c) => c.proc.handles.create({ type: 'gdi', kind: 'region', rects: [readRect(c.arg(0))] })];
  G.CreateEllipticRgn = [4, (c) => c.proc.handles.create({ type: 'gdi', kind: 'region', rects: [{ l: c.sarg(0), t: c.sarg(1), r: c.sarg(2), b: c.sarg(3) }] })];
  G.CombineRgn = [4, (c) => { const d = obj(c, c.arg(0)), a = obj(c, c.arg(1)), b = obj(c, c.arg(2)); if (!d || !a) return 0; const mode = c.arg(3); if (mode === 1) d.rects = a.rects.map((r) => ({ ...r })); else if (mode === 2 && b) d.rects = [...a.rects, ...b.rects]; else if (mode === 5) d.rects = a.rects.map((r) => ({ ...r })); else if (b) { const x = clipRect(a.rects[0], b.rects[0]); d.rects = rectEmpty(x) ? [] : [x]; } return d.rects.length ? 2 : 1; }];
  G.SetRectRgn = [5, (c) => { const d = obj(c, c.arg(0)); if (!d) return 0; d.rects = [{ l: c.sarg(1), t: c.sarg(2), r: c.sarg(3), b: c.sarg(4) }]; return 1; }];
  G.GetRgnBox = [2, (c) => { const d = obj(c, c.arg(0)); if (!d) return 0; const r = d.rects[0] ?? { l: 0, t: 0, r: 0, b: 0 }; writeRect(c.arg(1), r); return d.rects.length ? 2 : 1; }];
  G.PtInRegion = [3, (c) => { const d = obj(c, c.arg(0)); const x = c.sarg(1), y = c.sarg(2); return d?.rects.some((r) => x >= r.l && x < r.r && y >= r.t && y < r.b) ? 1 : 0; }];
  G.OffsetRgn = [3, (c) => { const d = obj(c, c.arg(0)); if (!d) return 0; for (const r of d.rects) { r.l += c.sarg(1); r.r += c.sarg(1); r.t += c.sarg(2); r.b += c.sarg(2); } return 2; }];
  G.CreateBitmap = [5, (c) => {
    const w = c.sarg(0), h = c.sarg(1), bpp = c.arg(3), bits = c.arg(4);
    const s = allocSurface(c.proc, Math.max(w, 1), Math.max(h, 1), 'bitmap');
    if (bits && bpp) { const info = { width: w, height: h, topDown: true, bpp, rowBytes: ((w * bpp + 15) >> 4) << 1, palette: bpp === 1 ? new Uint32Array([0, 0xffffff]) : null, masks: null }; const src = dibSurface(mem, bits, info); blit(s, { l: 0, t: 0, r: w, b: h }, 0, 0, w, h, src, 0, 0); }
    return c.proc.handles.create({ type: 'gdi', kind: 'bitmap', surface: s, width: w, height: h, bpp: 32, mono: bpp === 1 });
  }];
  G.CreateBitmapIndirect = [1, (c) => { const p = c.arg(0); const w = mem.readS32(p + 4), h = mem.readS32(p + 8); const s = allocSurface(c.proc, Math.max(w, 1), Math.max(h, 1), 'bitmap'); return c.proc.handles.create({ type: 'gdi', kind: 'bitmap', surface: s, width: w, height: h, bpp: 32 }); }];
  G.CreateCompatibleBitmap = [3, (c) => { const w = c.sarg(1), h = c.sarg(2); const s = allocSurface(c.proc, Math.max(w, 1), Math.max(h, 1), 'bitmap'); return c.proc.handles.create({ type: 'gdi', kind: 'bitmap', surface: s, width: w, height: h, bpp: 32 }); }];
  G.CreateDiscardableBitmap = G.CreateCompatibleBitmap;
  G.CreateDIBSection = [6, (c) => {
    const info = parseBitmapInfo(mem, c.arg(1), c.arg(2));
    const size = info.rowBytes * info.height;
    const bits = c.proc.vmem.alloc(Math.max(size, 4096), PAGE_READWRITE, 'dibsection');
    if (!bits) return c.fail(E.NOT_ENOUGH_MEMORY);
    mem.fill(bits, size, 0);
    c.out32(3, bits);
    const s = dibSurface(mem, bits, info);
    s.owned = { base: bits };
    return c.proc.handles.create({ type: 'gdi', kind: 'bitmap', surface: s, width: info.width, height: info.height, bpp: info.bpp, bits, info, dib: true });
  }];
  G.CreateDIBitmap = [6, (c) => {
    const hdr = c.arg(1); const w = mem.readS32(hdr + 4), h = Math.abs(mem.readS32(hdr + 8));
    const s = allocSurface(c.proc, Math.max(w, 1), Math.max(h, 1), 'bitmap');
    if ((c.arg(2) & 4) && c.arg(3) && c.arg(4)) { const info = parseBitmapInfo(mem, c.arg(4), c.arg(5)); const src = dibSurface(mem, c.arg(3), info); blit(s, { l: 0, t: 0, r: w, b: h }, 0, 0, w, h, src, 0, 0); }
    return c.proc.handles.create({ type: 'gdi', kind: 'bitmap', surface: s, width: w, height: h, bpp: 32 });
  }];
  G.DeleteObject = [1, (c) => {
    const o = obj(c, c.arg(0));
    if (!o || o.stock) return o ? 1 : 0;
    if (o.kind === 'dc') return 0;
    if (o.kind === 'bitmap') freeSurface(c.proc, o.surface);
    c.proc.handles.map.delete(c.arg(0));
    return 1;
  }];
  G.GetObjectA = [3, (c) => {
    const o = obj(c, c.arg(0)); if (!o) return 0;
    const n = c.arg(1), p = c.arg(2);
    if (o.kind === 'bitmap') {
      const bm = () => { mem.write32(p, 0); mem.write32(p + 4, o.width); mem.write32(p + 8, o.height); mem.write32(p + 12, o.dib ? o.info.rowBytes : o.width * 4); mem.write16(p + 16, 1); mem.write16(p + 18, o.bpp); mem.write32(p + 20, o.bits ?? 0); };
      if (!p) return o.dib ? 84 : 24;
      if (n >= 24) bm();
      if (o.dib && n >= 84) { mem.write32(p + 24, 40); mem.write32(p + 28, o.width); mem.write32(p + 32, o.info.topDown ? -o.height : o.height); mem.write16(p + 36, 1); mem.write16(p + 38, o.bpp); mem.write32(p + 40, o.info.compression); mem.write32(p + 44, o.info.rowBytes * o.height); mem.fill(p + 48, 36, 0); if (o.info.masks) { mem.write32(p + 64, o.info.masks[0]); mem.write32(p + 68, o.info.masks[1]); mem.write32(p + 72, o.info.masks[2]); } return 84; }
      return 24;
    }
    if (o.kind === 'font') { if (!p) return 60; if (n < 60) return 0; writeLogfont(p, o, false); return 60; }
    if (o.kind === 'brush') { if (!p) return 12; mem.write32(p, o.style); mem.write32(p + 4, rgbToCr(o.color)); mem.write32(p + 8, 0); return 12; }
    if (o.kind === 'pen') { if (!p) return 16; mem.write32(p, o.style); mem.write32(p + 4, o.width); mem.write32(p + 8, 0); mem.write32(p + 12, rgbToCr(o.color)); return 16; }
    if (o.kind === 'palette') { if (!p) return 2; mem.write16(p, o.entries.length); return 2; }
    return 0;
  }];
  G.GetObjectW = [3, (c) => { const o = obj(c, c.arg(0)); if (o?.kind === 'font') { const p = c.arg(2); if (!p) return 92; if (c.arg(1) < 92) return 0; writeLogfont(p, o, true); return 92; } return G.GetObjectA[1](c); }];
  G.GetObjectType = [1, (c) => { const o = obj(c, c.arg(0)); if (!o) return 0; return { pen: 1, brush: 2, dc: o?.memory ? 10 : 3, palette: 5, font: 6, bitmap: 7, region: 8 }[o.kind] ?? 0; }];
  G.GetCurrentObject = [2, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; switch (c.arg(1)) { case 1: return dc.pen; case 2: return dc.brush; case 5: return dc.palette; case 6: return dc.font; case 7: return dc.bitmap; default: return 0; } }];

  // ---------------------------------------------------------------- DCs
  G.CreateCompatibleDC = [1, (c) => {
    const s = allocSurface(c.proc, 1, 1, 'memdc');
    const bm = c.proc.handles.create({ type: 'gdi', kind: 'bitmap', surface: s, width: 1, height: 1, bpp: 32, defaultBitmap: true });
    const dc = makeDC(c.proc, s, { memory: true });
    dc.bitmap = bm; dc.ownsBitmap = bm;
    return dc.handle;
  }];
  G.CreateDCA = [4, (c) => vm.wm?.screenDC(c) ?? 0];
  G.CreateDCW = G.CreateDCA;
  G.CreateICA = G.CreateDCA;
  G.DeleteDC = [1, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; if (dc.ownsBitmap) { const bm = obj(c, dc.ownsBitmap); if (bm) freeSurface(c.proc, bm.surface); c.proc.handles.map.delete(dc.ownsBitmap); } c.proc.handles.map.delete(c.arg(0)); return 1; }];
  G.SelectObject = [2, (c) => {
    const dc = dcOf(c, c.arg(0)); const o = obj(c, c.arg(1));
    if (!dc || !o) return 0;
    switch (o.kind) {
      case 'pen': { const p = dc.pen; dc.pen = c.arg(1); return p; }
      case 'brush': { const p = dc.brush; dc.brush = c.arg(1); return p; }
      case 'font': { const p = dc.font; dc.font = c.arg(1); return p; }
      case 'bitmap': { if (!dc.memory) return 0; const p = dc.bitmap; dc.bitmap = c.arg(1); dc.surface = o.surface; dc.clip = { l: 0, t: 0, r: o.surface.width, b: o.surface.height }; return p; }
      case 'region': { dc.clipRgn = o; const r = o.rects[0]; dc.clip = r ? clipRect({ l: 0, t: 0, r: dc.surface.width, b: dc.surface.height }, { l: r.l + dc.ox, t: r.t + dc.oy, r: r.r + dc.ox, b: r.b + dc.oy }) : { l: 0, t: 0, r: 0, b: 0 }; return o.rects.length ? 2 : 1; }
      default: return 0;
    }
  }];
  G.SelectPalette = [3, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; const p = dc.palette; dc.palette = c.arg(1); return p; }];
  G.RealizePalette = [1, () => 0];
  G.GetSystemPaletteEntries = [4, (c) => { const n = c.arg(2), p = c.arg(3); const pal = defaultPalette(); for (let i = 0; i < n; i++) { const e = pal[(c.arg(1) + i) & 255]; mem.write32(p + 4 * i, ((e >> 16) & 0xff) | (e & 0xff00) | ((e & 0xff) << 16)); } return n; }];
  G.GetPaletteEntries = [4, (c) => { const o = obj(c, c.arg(0)); const n = c.arg(2), p = c.arg(3); if (!o?.entries) return 0; for (let i = 0; i < n; i++) { const e = o.entries[(c.arg(1) + i) % o.entries.length]; mem.write32(p + 4 * i, ((e >> 16) & 0xff) | (e & 0xff00) | ((e & 0xff) << 16)); } return n; }];
  G.SetPaletteEntries = [4, (c) => { const o = obj(c, c.arg(0)); const n = c.arg(2), p = c.arg(3); if (!o?.entries) return 0; for (let i = 0; i < n; i++) { const e = p + 4 * i; if (c.arg(1) + i < o.entries.length) o.entries[c.arg(1) + i] = (mem.u8[e] << 16) | (mem.u8[e + 1] << 8) | mem.u8[e + 2]; } return n; }];
  G.AnimatePalette = [4, () => 1];
  G.ResizePalette = [2, () => 1];
  G.UnrealizeObject = [1, () => 1];
  G.GetNearestPaletteIndex = [2, () => 0];
  G.GetNearestColor = [2, (c) => c.arg(1)];
  G.GetSystemPaletteUse = [1, () => 1];
  G.SetSystemPaletteUse = [2, () => 1];
  G.SaveDC = [1, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; dc.saved.push({ pen: dc.pen, brush: dc.brush, font: dc.font, bkColor: dc.bkColor, textColor: dc.textColor, bkMode: dc.bkMode, rop2: dc.rop2, clip: { ...dc.clip }, vpOrg: { ...dc.vpOrg }, wndOrg: { ...dc.wndOrg }, textAlign: dc.textAlign }); return dc.saved.length; }];
  G.RestoreDC = [2, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; let n = c.sarg(1); if (n < 0) n = dc.saved.length + n + 1; if (n < 1 || n > dc.saved.length) return 0; const s = dc.saved[n - 1]; dc.saved.length = n - 1; Object.assign(dc, s); return 1; }];
  G.GetDeviceCaps = [2, (c) => {
    const dc = dcOf(c, c.arg(0));
    const scr = vm.wm?.screen ?? { width: 1024, height: 768 };
    const w = dc?.surface?.width ?? scr.width, h = dc?.surface?.height ?? scr.height;
    switch (c.arg(1)) {
      case 0: return 0x400; case 2: return 1; case 4: return 320; case 6: return 240; case 8: return dc?.memory ? w : scr.width; case 10: return dc?.memory ? h : scr.height;
      case 12: return 32; case 14: return 1; case 16: return 1; case 18: return 1; case 20: return 1; case 22: return 0; case 24: return 0xffffffff;
      case 26: return 0; case 28: return 1; case 30: return 1; case 32: return 0; case 34: return 0; case 36: return 1;
      case 38: return 0x1c9 | 0x800 | 0x2000; case 40: return 0xff; case 42: return 0x7f; case 44: return 0x1fff; case 88: return 96; case 90: return 96;
      case 104: return 0; case 106: return 0; case 108: return 24; case 116: return 60; case 117: return 0; case 118: return 0; case 119: return 0; case 120: return 0;
      default: return 0;
    }
  }];
  G.GdiFlush = [0, () => 1];
  G.GdiSetBatchLimit = [1, () => 1];
  G.SetStretchBltMode = [2, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; const o = dc.stretchMode; dc.stretchMode = c.arg(1); return o; }];
  G.GetStretchBltMode = [1, (c) => dcOf(c, c.arg(0))?.stretchMode ?? 0];
  G.SetBkColor = [2, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0xffffffff; const o = dc.bkColor; dc.bkColor = crToRgb(c.arg(1)); return rgbToCr(o); }];
  G.GetBkColor = [1, (c) => { const dc = dcOf(c, c.arg(0)); return dc ? rgbToCr(dc.bkColor) : 0xffffffff; }];
  G.SetTextColor = [2, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0xffffffff; const o = dc.textColor; dc.textColor = crToRgb(c.arg(1)); return rgbToCr(o); }];
  G.GetTextColor = [1, (c) => { const dc = dcOf(c, c.arg(0)); return dc ? rgbToCr(dc.textColor) : 0xffffffff; }];
  G.SetBkMode = [2, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; const o = dc.bkMode; dc.bkMode = c.arg(1); return o; }];
  G.GetBkMode = [1, (c) => dcOf(c, c.arg(0))?.bkMode ?? 0];
  G.SetROP2 = [2, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; const o = dc.rop2; dc.rop2 = c.arg(1); return o; }];
  G.GetROP2 = [1, (c) => dcOf(c, c.arg(0))?.rop2 ?? 0];
  G.SetTextAlign = [2, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0xffffffff; const o = dc.textAlign; dc.textAlign = c.arg(1); return o; }];
  G.GetTextAlign = [1, (c) => dcOf(c, c.arg(0))?.textAlign ?? 0];
  G.SetMapMode = [2, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; const o = dc.mapMode; dc.mapMode = c.arg(1); return o; }];
  G.GetMapMode = [1, (c) => dcOf(c, c.arg(0))?.mapMode ?? 0];
  G.SetPolyFillMode = [2, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; const o = dc.polyFill; dc.polyFill = c.arg(1); return o; }];
  G.SetViewportOrgEx = [4, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; if (c.arg(3)) { mem.write32(c.arg(3), dc.vpOrg.x); mem.write32(c.arg(3) + 4, dc.vpOrg.y); } dc.vpOrg = { x: c.sarg(1), y: c.sarg(2) }; return 1; }];
  G.GetViewportOrgEx = [2, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; mem.write32(c.arg(1), dc.vpOrg.x); mem.write32(c.arg(1) + 4, dc.vpOrg.y); return 1; }];
  G.SetWindowOrgEx = [4, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; if (c.arg(3)) { mem.write32(c.arg(3), dc.wndOrg.x); mem.write32(c.arg(3) + 4, dc.wndOrg.y); } dc.wndOrg = { x: c.sarg(1), y: c.sarg(2) }; return 1; }];
  G.GetWindowOrgEx = [2, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; mem.write32(c.arg(1), dc.wndOrg.x); mem.write32(c.arg(1) + 4, dc.wndOrg.y); return 1; }];
  G.SetViewportExtEx = [4, () => 1]; G.SetWindowExtEx = [4, () => 1];
  G.GetViewportExtEx = [2, (c) => { mem.write32(c.arg(1), 1); mem.write32(c.arg(1) + 4, 1); return 1; }];
  G.GetWindowExtEx = G.GetViewportExtEx;
  G.OffsetViewportOrgEx = [4, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; dc.vpOrg.x += c.sarg(1); dc.vpOrg.y += c.sarg(2); return 1; }];
  G.SetBrushOrgEx = [4, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; dc.brushOrg = { x: c.sarg(1), y: c.sarg(2) }; return 1; }];
  G.DPtoLP = [3, () => 1]; G.LPtoDP = [3, () => 1];
  G.GetClipBox = [2, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; const k = dc.clip; writeRect(c.arg(1), { l: k.l - dc.ox, t: k.t - dc.oy, r: k.r - dc.ox, b: k.b - dc.oy }); return rectEmpty(k) ? 1 : 2; }];
  G.GetClipRgn = [2, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc || !dc.clipRgn) return 0; const d = obj(c, c.arg(1)); if (d) d.rects = dc.clipRgn.rects.map((r) => ({ ...r })); return 1; }];
  G.SelectClipRgn = [2, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; const o = c.arg(1) ? obj(c, c.arg(1)) : null; if (!o) { dc.clipRgn = null; dc.clip = dc.baseClip ?? { l: 0, t: 0, r: dc.surface.width, b: dc.surface.height }; return 2; } return G.SelectObject[1](c); }];
  G.ExtSelectClipRgn = [3, (c) => G.SelectClipRgn[1](c)];
  G.IntersectClipRect = [5, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; const a = dev(dc, c.sarg(1), c.sarg(2)), b = dev(dc, c.sarg(3), c.sarg(4)); dc.clip = clipRect(dc.clip, { l: a.x, t: a.y, r: b.x, b: b.y }); return rectEmpty(dc.clip) ? 1 : 2; }];
  G.ExcludeClipRect = [5, () => 2];
  G.GetDCOrgEx = [2, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; mem.write32(c.arg(1), dc.ox); mem.write32(c.arg(1) + 4, dc.oy); return 1; }];
  G.GetPixelFormat = [1, () => 1];
  G.ChoosePixelFormat = [2, () => 1];
  G.SetPixelFormat = [3, () => 1];
  G.DescribePixelFormat = [4, (c) => { const p = c.arg(3); if (p && c.arg(2) >= 40) { mem.fill(p, 40, 0); mem.write16(p, 40); mem.write16(p + 2, 1); mem.write32(p + 4, 0x25); mem.write8(p + 8, 0); mem.write8(p + 9, 32); mem.write8(p + 23, 24); mem.write8(p + 24, 8); } return 1; }];
  G.SwapBuffers = [1, () => 1];
  G.GetDeviceGammaRamp = [2, (c) => { const p = c.arg(1); if (vm.gammaRamp) { mem.writeBytes(p, vm.gammaRamp); return 1; } for (let i = 0; i < 256; i++) { const v = i * 257; mem.write16(p + 2 * i, v); mem.write16(p + 512 + 2 * i, v); mem.write16(p + 1024 + 2 * i, v); } return 1; }];
  G.SetDeviceGammaRamp = [2, (c) => { if (!c.arg(1)) return 0; const ramp = mem.bytes(c.arg(1), 1536).slice(); vm.gammaRamp = ramp; vm.d3dDevice?.gfx?.setGamma?.(ramp); return 1; }];

  // ---------------------------------------------------------------- drawing
  G.SetPixel = [4, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0xffffffff; const p = dev(dc, c.sarg(1), c.sarg(2)); const k = dc.clip; if (p.x >= k.l && p.x < k.r && p.y >= k.t && p.y < k.b) { dc.surface.setPixel(p.x, p.y, crToRgb(c.arg(3))); touched(dc); } return c.arg(3) & 0xffffff; }];
  G.SetPixelV = [4, (c) => { G.SetPixel[1](c); return 1; }];
  G.GetPixel = [3, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0xffffffff; const p = dev(dc, c.sarg(1), c.sarg(2)); const k = dc.clip; if (p.x < k.l || p.x >= k.r || p.y < k.t || p.y >= k.b) return 0xffffffff; return rgbToCr(dc.surface.getPixel(p.x, p.y)); }];
  G.MoveToEx = [4, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; if (c.arg(3)) { mem.write32(c.arg(3), dc.cur.x); mem.write32(c.arg(3) + 4, dc.cur.y); } dc.cur = { x: c.sarg(1), y: c.sarg(2) }; return 1; }];
  G.GetCurrentPositionEx = [2, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; mem.write32(c.arg(1), dc.cur.x); mem.write32(c.arg(1) + 4, dc.cur.y); return 1; }];
  G.LineTo = [3, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; const col = penColor(c, dc); const a = dev(dc, dc.cur.x, dc.cur.y), b = dev(dc, c.sarg(1), c.sarg(2)); if (col !== null) { line(dc.surface, dc.clip, a.x, a.y, b.x, b.y, col, penWidth(c, dc)); touched(dc); } dc.cur = { x: c.sarg(1), y: c.sarg(2) }; return 1; }];
  G.Polyline = [3, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; const col = penColor(c, dc); if (col === null) return 1; const n = c.arg(2), p = c.arg(1); for (let i = 0; i + 1 < n; i++) { const a = dev(dc, mem.readS32(p + 8 * i), mem.readS32(p + 8 * i + 4)), b = dev(dc, mem.readS32(p + 8 * i + 8), mem.readS32(p + 8 * i + 12)); line(dc.surface, dc.clip, a.x, a.y, b.x, b.y, col, penWidth(c, dc)); } touched(dc); return 1; }];
  G.PolylineTo = [3, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; const col = penColor(c, dc); const n = c.arg(2), p = c.arg(1); let cur = dc.cur; for (let i = 0; i < n; i++) { const nx = mem.readS32(p + 8 * i), ny = mem.readS32(p + 8 * i + 4); if (col !== null) { const a = dev(dc, cur.x, cur.y), b = dev(dc, nx, ny); line(dc.surface, dc.clip, a.x, a.y, b.x, b.y, col, penWidth(c, dc)); } cur = { x: nx, y: ny }; } dc.cur = cur; touched(dc); return 1; }];
  G.Polygon = [3, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; const n = c.arg(2), p = c.arg(1); const pts = []; for (let i = 0; i < n; i++) pts.push(dev(dc, mem.readS32(p + 8 * i), mem.readS32(p + 8 * i + 4))); polygon(dc.surface, dc.clip, pts, brushColor(c, dc), penColor(c, dc)); touched(dc); return 1; }];
  G.PolyPolygon = [4, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; let p = c.arg(1); const counts = c.arg(2), n = c.arg(3); for (let k = 0; k < n; k++) { const cnt = mem.read32(counts + 4 * k); const pts = []; for (let i = 0; i < cnt; i++) { pts.push(dev(dc, mem.readS32(p), mem.readS32(p + 4))); p += 8; } polygon(dc.surface, dc.clip, pts, brushColor(c, dc), penColor(c, dc)); } touched(dc); return 1; }];
  G.Rectangle = [5, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; const a = dev(dc, c.sarg(1), c.sarg(2)), b = dev(dc, c.sarg(3), c.sarg(4)); const f = brushColor(c, dc), o = penColor(c, dc); if (f !== null) fillRect(dc.surface, dc.clip, a.x + 1, a.y + 1, b.x - 1, b.y - 1, f); if (o !== null) { const w = penWidth(c, dc); fillRect(dc.surface, dc.clip, a.x, a.y, b.x, a.y + w, o); fillRect(dc.surface, dc.clip, a.x, b.y - w, b.x, b.y, o); fillRect(dc.surface, dc.clip, a.x, a.y, a.x + w, b.y, o); fillRect(dc.surface, dc.clip, b.x - w, a.y, b.x, b.y, o); } touched(dc); return 1; }];
  G.RoundRect = [7, (c) => G.Rectangle[1](c)];
  G.Ellipse = [5, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; const a = dev(dc, c.sarg(1), c.sarg(2)), b = dev(dc, c.sarg(3), c.sarg(4)); ellipse(dc.surface, dc.clip, a.x, a.y, b.x, b.y, brushColor(c, dc), penColor(c, dc)); touched(dc); return 1; }];
  G.PatBlt = [6, (c) => {
    const dc = dcOf(c, c.arg(0)); if (!dc) return 0;
    const p = dev(dc, c.sarg(1), c.sarg(2)); const w = c.sarg(3), h = c.sarg(4); const rop = c.arg(5) >>> 0;
    const l = w < 0 ? p.x + w : p.x, t = h < 0 ? p.y + h : p.y, r = l + Math.abs(w), b = t + Math.abs(h);
    const pat = brushColor(c, dc) ?? 0;
    if (rop === 0x00f00021) fillRect(dc.surface, dc.clip, l, t, r, b, pat);
    else { const fn = ROPS[rop] ?? ((s, d) => d); opRect(dc.surface, dc.clip, l, t, r, b, (d) => fn(0, d, pat)); }
    touched(dc); return 1;
  }];
  G.BitBlt = [9, (c) => {
    const dc = dcOf(c, c.arg(0)); if (!dc) return 0;
    const src = dcOf(c, c.arg(5)); const rop = c.arg(8) >>> 0;
    const d = dev(dc, c.sarg(1), c.sarg(2)); const w = c.sarg(3), h = c.sarg(4);
    if (!src) { if (rop === 0x00f00021 || rop === 0x00000042 || rop === 0x00ff0062 || rop === 0x00550009) { const fn = ROPS[rop]; const pat = brushColor(c, dc) ?? 0; opRect(dc.surface, dc.clip, d.x, d.y, d.x + w, d.y + h, (x) => fn(0, x, pat)); touched(dc); return 1; } return 0; }
    const s = dev(src, c.sarg(6), c.sarg(7));
    blit(dc.surface, dc.clip, d.x, d.y, w, h, src.surface, s.x, s.y, rop, brushColor(c, dc) ?? 0);
    touched(dc); return 1;
  }];
  G.StretchBlt = [11, (c) => {
    const dc = dcOf(c, c.arg(0)), src = dcOf(c, c.arg(5)); if (!dc || !src) return 0;
    const d = dev(dc, c.sarg(1), c.sarg(2)), s = dev(src, c.sarg(6), c.sarg(7));
    stretchBlit(dc.surface, dc.clip, d.x, d.y, c.sarg(3), c.sarg(4), src.surface, s.x, s.y, c.sarg(8), c.sarg(9), c.arg(10) >>> 0);
    touched(dc); return 1;
  }];
  G.MaskBlt = [12, (c) => { const dc = dcOf(c, c.arg(0)), src = dcOf(c, c.arg(5)); if (!dc || !src) return 0; const d = dev(dc, c.sarg(1), c.sarg(2)), s = dev(src, c.sarg(6), c.sarg(7)); blit(dc.surface, dc.clip, d.x, d.y, c.sarg(3), c.sarg(4), src.surface, s.x, s.y, c.arg(11) & 0x00ffffff | 0x00cc0020); touched(dc); return 1; }];
  G.TransparentBlt = [11, (c) => {
    const dc = dcOf(c, c.arg(0)), src = dcOf(c, c.arg(5)); if (!dc || !src) return 0;
    const key = crToRgb(c.arg(10)); const d = dev(dc, c.sarg(1), c.sarg(2)), s = dev(src, c.sarg(6), c.sarg(7));
    const dw = c.sarg(3), dh = c.sarg(4), sw = c.sarg(8), sh = c.sarg(9);
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) { const px = src.surface.getPixel(s.x + Math.floor(x * sw / dw), s.y + Math.floor(y * sh / dh)); if (px !== key) { const X = d.x + x, Y = d.y + y; if (X >= dc.clip.l && X < dc.clip.r && Y >= dc.clip.t && Y < dc.clip.b) dc.surface.setPixel(X, Y, px); } }
    touched(dc); return 1;
  }];
  const dibBlit = (c, dc, dx, dy, dw, dh, sx, sy, sw, sh, bits, bmi, usage, rop) => {
    const info = parseBitmapInfo(mem, bmi, usage);
    const src = dibSurface(mem, bits, info);
    const d = dev(dc, dx, dy);
    if (sw < 0) sw = info.width; if (sh < 0) sh = info.height;
    stretchBlit(dc.surface, dc.clip, d.x, d.y, dw, dh, src, sx, sy, sw, sh, rop);
    touched(dc);
    return info;
  };
  G.SetDIBitsToDevice = [12, (c) => {
    const dc = dcOf(c, c.arg(0)); if (!dc) return 0;
    const w = c.arg(3), h = c.arg(4), startScan = c.arg(6), numScans = c.arg(7);
    const info = parseBitmapInfo(mem, c.arg(9), c.arg(10));
    // the bits pointer covers scan lines [startScan, startScan+numScans) of a bottom-up DIB
    const src = dibSurface(mem, c.arg(8), { ...info, height: numScans, topDown: info.topDown });
    const d = dev(dc, c.sarg(1), c.sarg(2));
    const srcY = c.sarg(5) - (info.topDown ? 0 : 0);
    blit(dc.surface, dc.clip, d.x, d.y, w, h, src, c.sarg(4) ? c.sarg(4) : 0, 0, SRCCOPY);
    void srcY; void startScan;
    touched(dc); return numScans;
  }];
  G.StretchDIBits = [13, (c) => {
    const dc = dcOf(c, c.arg(0)); if (!dc) return 0;
    const bits = c.arg(9), bmi = c.arg(10); if (!bits || !bmi) return 0;
    const info = dibBlit(c, dc, c.sarg(1), c.sarg(2), c.sarg(3), c.sarg(4), c.sarg(5), c.sarg(6), c.sarg(7), c.sarg(8), bits, bmi, c.arg(11), c.arg(12) >>> 0);
    return info.height;
  }];
  G.SetDIBits = [7, (c) => {
    const bm = obj(c, c.arg(1)); if (!bm || bm.kind !== 'bitmap') return 0;
    const info = parseBitmapInfo(mem, c.arg(5), c.arg(6)); const src = dibSurface(mem, c.arg(4), { ...info, height: c.arg(3) });
    const start = c.arg(2), n = c.arg(3);
    const dy = info.topDown ? start : bm.height - start - n;
    blit(bm.surface, { l: 0, t: 0, r: bm.width, b: bm.height }, 0, dy, info.width, n, src, 0, 0);
    return n;
  }];
  G.GetDIBits = [7, (c) => {
    const bm = obj(c, c.arg(1)); if (!bm || bm.kind !== 'bitmap') return 0;
    const bmi = c.arg(5); const bits = c.arg(4);
    const hdrBpp = mem.read16(bmi + 14);
    if (!bits || hdrBpp === 0) { mem.write32(bmi + 4, bm.width); mem.write32(bmi + 8, bm.height); mem.write16(bmi + 12, 1); mem.write16(bmi + 14, 32); mem.write32(bmi + 16, 0); mem.write32(bmi + 20, bm.width * bm.height * 4); return bm.height; }
    const info = parseBitmapInfo(mem, bmi, c.arg(6));
    const start = c.arg(2), n = Math.min(c.arg(3), info.height);
    const dst = dibSurface(mem, bits, { ...info, height: n });
    const sy = info.topDown ? start : bm.height - start - n;
    blit(dst, { l: 0, t: 0, r: info.width, b: n }, 0, 0, info.width, n, bm.surface, 0, sy);
    return n;
  }];
  G.GetBitmapBits = [3, (c) => { const bm = obj(c, c.arg(0)); if (!bm?.surface) return 0; const n = Math.min(c.arg(1), bm.width * bm.height * 4); const row = new Uint32Array(bm.width); let off = 0; for (let y = 0; y < bm.height && off < n; y++) { bm.surface.readRow(y, 0, bm.width, row); for (let x = 0; x < bm.width && off < n; x++, off += 4) mem.write32(c.arg(2) + off, row[x]); } return off; }];
  G.SetBitmapBits = [3, (c) => { const bm = obj(c, c.arg(0)); if (!bm?.surface) return 0; const n = Math.min(c.arg(1), bm.width * bm.height * 4); const row = new Uint32Array(bm.width); let off = 0; for (let y = 0; y < bm.height && off < n; y++) { for (let x = 0; x < bm.width && off < n; x++, off += 4) row[x] = mem.read32(c.arg(2) + off); bm.surface.writeRow(y, 0, bm.width, row); } return off; }];
  G.GetBitmapDimensionEx = [2, (c) => { mem.write32(c.arg(1), 0); mem.write32(c.arg(1) + 4, 0); return 1; }];
  G.SetBitmapDimensionEx = [4, () => 1];

  // ---------------------------------------------------------------- text (gfx/gdi/text.js)
  /**
   * TextOut/ExtTextOut: reference point from the text alignment (TA_LEFT/RIGHT/CENTER x TA_TOP/BASELINE/BOTTOM,
   * TA_UPDATECP), OPAQUE background cells or an ETO_OPAQUE rectangle, optional clipping rectangle and
   * caller-supplied advances (lpDx).
   */
  const textOut = (c, dc, x, y, s, opts = {}) => {
    const r = realFont(c, dc);
    const adv = opts.dx ?? engine().advances(r, s, dc.charExtra ?? 0);
    let w = 0; for (let i = 0; i < adv.length; i++) w += adv[i];
    const ucp = (dc.textAlign & 1) !== 0;
    const lx = ucp ? dc.cur.x : x, ly = ucp ? dc.cur.y : y;
    const p = dev(dc, lx, ly);
    let px = p.x, py = p.y;
    const ha = dc.textAlign & 6;
    if (ha === 6) px -= w >> 1; else if (ha === 2) px -= w;
    const va = dc.textAlign & 24;
    if (va === 24) py -= r.ascent; else if (va === 8) py -= r.height;
    const clip = opts.clip ? clipRect(dc.clip, opts.clip) : dc.clip;
    if (opts.opaque) fillRect(dc.surface, clip, opts.opaque.l, opts.opaque.t, opts.opaque.r, opts.opaque.b, dc.bkColor);
    if (dc.surface) engine().draw(dc.surface, clip, px, py, s, r, dc.textColor, adv, dc.bkMode === 2 && !opts.opaque ? dc.bkColor : null);
    if (ucp) dc.cur = { x: ha === 2 ? lx - w : ha === 6 ? lx : lx + w, y: ly };
    touched(dc);
  };
  G.TextOutA = [5, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; textOut(c, dc, c.sarg(1), c.sarg(2), ansi(mem.readCStringN(c.arg(3), c.arg(4)))); return 1; }];
  G.TextOutW = [5, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; textOut(c, dc, c.sarg(1), c.sarg(2), mem.readWStringN(c.arg(3), c.arg(4))); return 1; }];
  let glyphIndexWarned = false;
  const extTextOut = (c, wide) => {
    const dc = dcOf(c, c.arg(0)); if (!dc) return 0;
    const opt = c.arg(3), rp = c.arg(4), n = c.arg(6), dxp = c.arg(7);
    if ((opt & 0x10) && !glyphIndexWarned) { glyphIndexWarned = true; vm.warn('ExtTextOut: ETO_GLYPH_INDEX strings are drawn as character codes'); }
    let s = '';
    if (c.arg(5)) { if (wide || (opt & 0x10)) { for (let i = 0; i < n; i++) s += String.fromCharCode(mem.read16(c.arg(5) + 2 * i)); } else { for (let i = 0; i < n; i++) s += String.fromCharCode(mem.read8(c.arg(5) + i)); s = ansi(s); } }
    const o = {};
    if (rp) { const r = readRect(rp); const a = dev(dc, r.l, r.t), b = dev(dc, r.r, r.b); const dr = { l: a.x, t: a.y, r: b.x, b: b.y }; if (opt & 2) o.opaque = dr; if (opt & 4) o.clip = dr; }
    if (dxp && n) { const step = opt & 0x2000 ? 8 : 4; o.dx = new Int32Array(n); for (let i = 0; i < n; i++) o.dx[i] = mem.readS32(dxp + step * i); } // ETO_PDY: (dx, dy) pairs
    textOut(c, dc, c.sarg(1), c.sarg(2), s, o);
    return 1;
  };
  G.ExtTextOutA = [8, (c) => extTextOut(c, false)];
  G.ExtTextOutW = [8, (c) => extTextOut(c, true)];
  const textExtent = (c, s) => { const dc = dcOf(c, c.arg(0)); if (!dc || !c.arg(3)) return 0; const e = engine().extent(realFont(c, dc), s, dc.charExtra ?? 0); mem.write32(c.arg(3), e.w); mem.write32(c.arg(3) + 4, e.h); return 1; };
  G.GetTextExtentPoint32A = [4, (c) => textExtent(c, ansi(mem.readCStringN(c.arg(1), c.arg(2))))];
  G.GetTextExtentPointA = G.GetTextExtentPoint32A;
  G.GetTextExtentPoint32W = [4, (c) => textExtent(c, mem.readWStringN(c.arg(1), c.arg(2)))];
  G.GetTextExtentPointW = G.GetTextExtentPoint32W;
  const textExtentEx = (c, s) => {
    const dc = dcOf(c, c.arg(0)); if (!dc) return 0;
    const r = realFont(c, dc), adv = engine().advances(r, s, dc.charExtra ?? 0), max = c.sarg(3);
    let fit = 0, x = 0;
    for (let i = 0; i < adv.length; i++) { x += adv[i]; if (c.arg(5)) mem.write32(c.arg(5) + 4 * i, x); if (x <= max) fit = i + 1; }
    if (c.arg(4)) mem.write32(c.arg(4), fit);
    if (c.arg(6)) { mem.write32(c.arg(6), x); mem.write32(c.arg(6) + 4, r.height); }
    return 1;
  };
  G.GetTextExtentExPointA = [7, (c) => textExtentEx(c, ansi(mem.readCStringN(c.arg(1), c.arg(2))))];
  G.GetTextExtentExPointW = [7, (c) => textExtentEx(c, mem.readWStringN(c.arg(1), c.arg(2)))];
  const charWidths = (c, wide) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; const r = realFont(c, dc); for (let i = c.arg(1); i <= c.arg(2); i++) mem.write32(c.arg(3) + 4 * (i - c.arg(1)), engine().advance(r, wide ? i : ansiCode(i))); return 1; };
  G.GetCharWidthA = [4, (c) => charWidths(c, false)]; G.GetCharWidth32A = G.GetCharWidthA;
  G.GetCharWidthW = [4, (c) => charWidths(c, true)]; G.GetCharWidth32W = G.GetCharWidthW;
  const abcWidths = (c, wide) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; const r = realFont(c, dc); for (let i = c.arg(1); i <= c.arg(2); i++) { const p = c.arg(3) + 12 * (i - c.arg(1)); const w = engine().abc(r, wide ? i : ansiCode(i)); mem.write32(p, w.a); mem.write32(p + 4, w.b); mem.write32(p + 8, w.c); } return 1; };
  G.GetCharABCWidthsA = [4, (c) => abcWidths(c, false)];
  G.GetCharABCWidthsW = [4, (c) => abcWidths(c, true)];
  G.GetCharABCWidthsFloatA = [4, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; const r = realFont(c, dc); for (let i = c.arg(1); i <= c.arg(2); i++) { const p = c.arg(3) + 12 * (i - c.arg(1)); const w = engine().abc(r, ansiCode(i)); mem.writeF32(p, w.a); mem.writeF32(p + 4, w.b); mem.writeF32(p + 8, w.c); } return 1; }];
  G.GetCharABCWidthsFloatW = [4, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; const r = realFont(c, dc); for (let i = c.arg(1); i <= c.arg(2); i++) { const p = c.arg(3) + 12 * (i - c.arg(1)); const w = engine().abc(r, i); mem.writeF32(p, w.a); mem.writeF32(p + 4, w.b); mem.writeF32(p + 8, w.c); } return 1; }];
  /** TEXTMETRICA (56 bytes) / TEXTMETRICW (60 bytes) of a realized font. */
  const writeTextMetric = (p, r, wide) => {
    mem.write32(p, r.height); mem.write32(p + 4, r.ascent); mem.write32(p + 8, r.descent); mem.write32(p + 12, r.internalLeading); mem.write32(p + 16, r.externalLeading);
    mem.write32(p + 20, r.aveCharWidth); mem.write32(p + 24, r.maxCharWidth); mem.write32(p + 28, r.weight); mem.write32(p + 32, 0); mem.write32(p + 36, 96); mem.write32(p + 40, 96);
    // TMPF_FIXED_PITCH (bit 0) is set for *variable* pitch fonts; TMPF_VECTOR | TMPF_TRUETYPE for outline fonts
    const pf = (r.fixedPitch ? 0 : 1) | (r.bitmap ? 0 : 6) | (r.family & 0xf0);
    const tail = wide ? p + 44 : p + 44;
    if (wide) { mem.write16(tail, 0x20); mem.write16(tail + 2, 0xfffc); mem.write16(tail + 4, 0x1f); mem.write16(tail + 6, 0x20); mem.write8(tail + 8, r.italic ? 1 : 0); mem.write8(tail + 9, r.underline ? 1 : 0); mem.write8(tail + 10, r.strike ? 1 : 0); mem.write8(tail + 11, pf); mem.write8(tail + 12, r.charset); }
    else { mem.write8(tail, 0x20); mem.write8(tail + 1, 0xff); mem.write8(tail + 2, 0x1f); mem.write8(tail + 3, 0x20); mem.write8(tail + 4, r.italic ? 1 : 0); mem.write8(tail + 5, r.underline ? 1 : 0); mem.write8(tail + 6, r.strike ? 1 : 0); mem.write8(tail + 7, pf); mem.write8(tail + 8, r.charset); }
  };
  const textMetrics = (c, wide) => { const dc = dcOf(c, c.arg(0)); if (!dc || !c.arg(1)) return 0; writeTextMetric(c.arg(1), realFont(c, dc), wide); return 1; };
  G.GetTextMetricsA = [2, (c) => textMetrics(c, false)];
  G.GetTextMetricsW = [2, (c) => textMetrics(c, true)];
  G.GetTextFaceA = [3, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; const s = realFont(c, dc).face; if (c.arg(2)) { mem.writeCString(c.arg(2), s, c.arg(1)); return Math.min(s.length, c.arg(1) - 1); } return s.length + 1; }];
  G.GetTextFaceW = [3, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; const s = realFont(c, dc).face; if (c.arg(2)) { mem.writeWString(c.arg(2), s, c.arg(1)); return Math.min(s.length, c.arg(1) - 1); } return s.length + 1; }];
  G.GetTextCharset = [1, (c) => { const dc = dcOf(c, c.arg(0)); return dc ? realFont(c, dc).charset : 0; }];
  G.GetTextCharsetInfo = [3, (c) => { if (c.arg(1)) mem.fill(c.arg(1), 24, 0); const dc = dcOf(c, c.arg(0)); return dc ? realFont(c, dc).charset : 0; }];
  G.SetTextCharacterExtra = [2, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0x80000000; const o = dc.charExtra ?? 0; dc.charExtra = c.sarg(1); return o; }];
  G.GetTextCharacterExtra = [1, (c) => dcOf(c, c.arg(0))?.charExtra ?? 0];
  G.SetTextJustification = [3, () => 1];
  /**
   * Font enumeration: the faces registered with AddFontResource then the Windows system faces, each reported once
   * (ANSI charset, TrueType) to the callback with an ENUMLOGFONTEX and a NEWTEXTMETRICEX from its realization.
   */
  const enumFonts = (c, wide, filterFace, cbIdx, lparamIdx) => {
    const cb = c.arg(cbIdx), lp = c.arg(lparamIdx);
    if (!cb) return 0;
    const names = [...engine().registeredFamilies().map((i) => i.family), ...ENUMERATED_SYSTEM_FACES];
    const seen = new Set(); let ret = 1;
    const lfSize = wide ? 92 : 60, elfSize = wide ? 92 + 64 * 2 + 32 * 2 + 32 * 2 : 60 + 64 + 32 + 32, tmSize = (wide ? 60 : 56) + 24;
    const buf = c.proc.processHeap.alloc(elfSize + tmSize + 16, true);
    if (!buf) return 1;
    try {
      for (const face of names) {
        const k = face.toLowerCase(); if (seen.has(k)) continue; seen.add(k);
        if (filterFace && filterFace.toLowerCase() !== k) continue;
        const lf = { height: -16, width: 0, weight: 400, face, charset: 0, pitchAndFamily: 0, outPrecision: 3, clipPrecision: 2, quality: 1 };
        const r = engine().realize({ ...lf });
        lf.height = r.height; lf.width = r.aveCharWidth; lf.pitchAndFamily = (r.fixedPitch ? 1 : 2) | (r.family & 0xf0);
        mem.fill(buf, elfSize + tmSize, 0);
        writeLogfont(buf, lf, wide);
        if (wide) { mem.writeWString(buf + lfSize, face, 64); mem.writeWString(buf + lfSize + 128, 'Regular', 32); mem.writeWString(buf + lfSize + 192, 'Western', 32); }
        else { mem.writeCString(buf + lfSize, face, 64); mem.writeCString(buf + lfSize + 64, 'Regular', 32); mem.writeCString(buf + lfSize + 96, 'Western', 32); }
        const tm = buf + elfSize;
        writeTextMetric(tm, r, wide);
        ret = vm.callGuest(c.thread, cb, [buf, tm, 4 /* TRUETYPE_FONTTYPE */, lp]) | 0;
        if (!ret) break;
      }
    } finally { c.proc.processHeap.free_(buf); }
    return ret;
  };
  G.EnumFontFamiliesA = [4, (c) => enumFonts(c, false, c.arg(1) ? mem.readCString(c.arg(1), 64) : '', 2, 3)];
  G.EnumFontFamiliesW = [4, (c) => enumFonts(c, true, c.arg(1) ? mem.readWString(c.arg(1), 64) : '', 2, 3)];
  G.EnumFontFamiliesExA = [5, (c) => enumFonts(c, false, c.arg(1) ? mem.readCString(c.arg(1) + 28, 32) : '', 2, 3)];
  G.EnumFontFamiliesExW = [5, (c) => enumFonts(c, true, c.arg(1) ? mem.readWString(c.arg(1) + 28, 32) : '', 2, 3)];
  G.EnumFontsA = [4, (c) => enumFonts(c, false, c.arg(1) ? mem.readCString(c.arg(1), 64) : '', 2, 3)];
  G.EnumFontsW = [4, (c) => enumFonts(c, true, c.arg(1) ? mem.readWString(c.arg(1), 64) : '', 2, 3)];
  /**
   * AddFontResource(Ex): the application's own font files become available to CreateFont under their family names.
   * The browser decodes the font asynchronously: the calling thread waits (parked) until it is usable, so text
   * measured right after registration already uses it.
   */
  const addFontResource = (c, name) => {
    if (!name) return 0;
    const path = c.proc.path(name);
    let bytes = vm.vfs.readFile(path);
    if (!bytes && !/[\\/:]/.test(name)) bytes = vm.vfs.readFile('C:\\Windows\\Fonts\\' + name);
    if (!bytes) { vm.log('gfx', `AddFontResource(${name}): file not found`); return 0; }
    const n = engine().registerFontFile(path, bytes);
    // (the host runs the scheduler again as soon as the browser is done: the wait lasts the decoding, not the timeout)
    if (!engine().ready) { engine().onReady = () => vm.host?.wake?.(); vm.sched.block(c.thread, () => engine().ready, 5000, 'font load'); }
    vm.log('gfx', `AddFontResource(${name}): ${n} face(s)${n ? ' ' + engine().files.get(path.toLowerCase()).join(', ') : ''}`);
    return n;
  };
  G.AddFontResourceA = [1, (c) => addFontResource(c, c.str(0))];
  G.AddFontResourceW = [1, (c) => addFontResource(c, c.wstr(0))];
  G.AddFontResourceExA = [3, (c) => addFontResource(c, c.str(0))];
  G.AddFontResourceExW = [3, (c) => addFontResource(c, c.wstr(0))];
  G.RemoveFontResourceA = [1, () => 1]; G.RemoveFontResourceW = [1, () => 1];
  G.RemoveFontResourceExA = [3, () => 1]; G.RemoveFontResourceExW = [3, () => 1];
  G.GetKerningPairsA = [3, () => 0]; G.GetKerningPairsW = [3, () => 0];
  /**
   * GetGlyphOutline: GGO_METRICS and the bitmap formats (GGO_BITMAP 1 bpp, GGO_GRAY2/4/8 with 5/17/65 levels);
   * outline formats (native/bezier) are not available (GDI_ERROR).
   */
  const glyphOutline = (c, wide) => {
    const dc = dcOf(c, c.arg(0)); if (!dc) return 0xffffffff;
    const fmt = c.arg(2) & 0x7f, gm = c.arg(3), size = c.arg(4), buf = c.arg(5);
    if (fmt === 2 || fmt === 3) return 0xffffffff;
    let code = c.arg(1); if (!wide) code = ansiCode(code & 0xffff);
    const r = realFont(c, dc), g = engine().glyph(r, code);
    const blank = g.w <= 1 && g.h <= 1 && !g.data[0];
    if (gm) { mem.write32(gm, blank ? 0 : g.w); mem.write32(gm + 4, blank ? 0 : g.h); mem.write32(gm + 8, g.originX); mem.write32(gm + 12, g.originY); mem.write16(gm + 16, g.advance); mem.write16(gm + 18, 0); }
    if (fmt === 0 || blank) return fmt === 0 ? 1 : 0;
    const levels = fmt === 4 ? 4 : fmt === 5 ? 16 : fmt === 6 ? 64 : 1;
    const pitch = fmt === 1 ? ((g.w + 31) >> 5) << 2 : (g.w + 3) & ~3, need = pitch * g.h;
    if (!buf || !size) return need;
    if (size < need) return 0xffffffff;
    mem.fill(buf, need, 0);
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) {
      const a = g.data[y * g.w + x];
      if (fmt === 1) { if (a >= 128) mem.u8[buf + y * pitch + (x >> 3)] |= 0x80 >> (x & 7); }
      else mem.u8[buf + y * pitch + x] = Math.round(a * levels / 255);
    }
    return need;
  };
  G.GetGlyphOutlineA = [7, (c) => glyphOutline(c, false)];
  G.GetGlyphOutlineW = [7, (c) => glyphOutline(c, true)];
  G.GetOutlineTextMetricsA = [3, () => 0];
  G.GetOutlineTextMetricsW = [3, () => 0];
  G.GetFontData = [5, () => 0xffffffff];
  G.GetRasterizerCaps = [2, (c) => { mem.write32(c.arg(0), 4); mem.write32(c.arg(0) + 4, 1); return 1; }];
  G.GetColorAdjustment = [2, () => 0];
  G.GetBoundsRect = [3, () => 0];
  G.PlayEnhMetaFile = [3, () => 0];
  G.CreateEnhMetaFileA = [4, () => 0];
  G.SetLayout = [2, () => 0];
  G.GetLayout = [1, () => 0];
  G.SetMiterLimit = [3, () => 1];
  G.SetArcDirection = [2, () => 1];
  G.SetGraphicsMode = [2, () => 1];
  G.AbortDoc = [1, () => 1];
  G.ExtEscape = [6, () => 0];
  G.Escape = [5, () => 0];
  G.GetRegionData = [3, () => 0];
  G.ExtCreateRegion = [3, (c) => c.proc.handles.create({ type: 'gdi', kind: 'region', rects: [] })];
  G.FrameRgn = [5, () => 1];
  G.FillRgn = [3, (c) => { const dc = dcOf(c, c.arg(0)); const rg = obj(c, c.arg(1)), br = obj(c, c.arg(2)); if (!dc || !rg || !br) return 0; for (const r of rg.rects) { const a = dev(dc, r.l, r.t), b = dev(dc, r.r, r.b); fillRect(dc.surface, dc.clip, a.x, a.y, b.x, b.y, br.color); } touched(dc); return 1; }];
  G.PaintRgn = [2, (c) => { const dc = dcOf(c, c.arg(0)); const rg = obj(c, c.arg(1)); if (!dc || !rg) return 0; const col = brushColor(c, dc); if (col !== null) for (const r of rg.rects) { const a = dev(dc, r.l, r.t), b = dev(dc, r.r, r.b); fillRect(dc.surface, dc.clip, a.x, a.y, b.x, b.y, col); } touched(dc); return 1; }];
  G.InvertRgn = [2, () => 1];
  G.EqualRgn = [2, () => 0];
  G.RectInRegion = [2, () => 1];
  G.GdiAlphaBlend = [11, (c) => G.StretchBlt[1](c)];
  G.GdiTransparentBlt = G.TransparentBlt;
  G.GdiGradientFill = [6, (c) => 1];
  G.GetBrushOrgEx = [2, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; mem.write32(c.arg(1), dc.brushOrg.x); mem.write32(c.arg(1) + 4, dc.brushOrg.y); return 1; }];
  G.Arc = [9, () => 1];
  G.Pie = [9, (c) => G.Ellipse[1](c)];
  G.Chord = [9, (c) => G.Ellipse[1](c)];
  G.FloodFill = [4, () => 1];
  G.ExtFloodFill = [5, () => 1];
  G.PolyBezier = [3, (c) => G.Polyline[1](c)];
  G.PolyBezierTo = [3, (c) => G.PolylineTo[1](c)];
  G.BeginPath = [1, () => 1]; G.EndPath = [1, () => 1]; G.StrokePath = [1, () => 1]; G.FillPath = [1, () => 1]; G.CloseFigure = [1, () => 1];
  G.SetWorldTransform = [2, () => 1]; G.ModifyWorldTransform = [3, () => 1]; G.GetWorldTransform = [2, () => 1];
  G.GetCharABCWidthsI = [5, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; const r = realFont(c, dc); for (let i = 0; i < c.arg(2); i++) { const p = c.arg(4) + 12 * i; const g = c.arg(3) ? mem.read16(c.arg(3) + 2 * i) : c.arg(1) + i; const w = engine().abc(r, g); mem.write32(p, w.a); mem.write32(p + 4, w.b); mem.write32(p + 8, w.c); } return 1; }];
  G.GetGlyphIndicesW = [5, (c) => { for (let i = 0; i < c.arg(2); i++) mem.write16(c.arg(3) + 2 * i, mem.read16(c.arg(1) + 2 * i)); return c.arg(2); }];
  G.GetTextExtentPointI = [4, (c) => { const dc = dcOf(c, c.arg(0)); if (!dc) return 0; let t = ''; for (let i = 0; i < c.arg(2); i++) t += String.fromCharCode(mem.read16(c.arg(1) + 2 * i)); const e = engine().extent(realFont(c, dc), t); mem.write32(c.arg(3), e.w); mem.write32(c.arg(3) + 4, e.h); return 1; }];
  G.SetDIBColorTable = [4, (c) => { const dc = dcOf(c, c.arg(0)); const bm = dc ? obj(c, dc.bitmap) : null; if (!bm?.surface?.palette) return 0; const n = c.arg(2); for (let i = 0; i < n; i++) { const e = c.arg(3) + 4 * i; const idx = c.arg(1) + i; if (idx < bm.surface.palette.length) bm.surface.palette[idx] = (mem.u8[e + 2] << 16) | (mem.u8[e + 1] << 8) | mem.u8[e]; } return n; }];
  G.GetDIBColorTable = [4, (c) => { const dc = dcOf(c, c.arg(0)); const bm = dc ? obj(c, dc.bitmap) : null; if (!bm?.surface?.palette) return 0; const n = c.arg(2); for (let i = 0; i < n; i++) { const p = bm.surface.palette[(c.arg(1) + i) % bm.surface.palette.length]; mem.write32(c.arg(3) + 4 * i, ((p >> 16) & 0xff) | (p & 0xff00) | ((p & 0xff) << 16)); } return n; }];

  api.define('gdi32.dll', G);
}

export { fillRect, blit, stretchBlit };
