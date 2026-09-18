// gdiplus.dll flat API: bitmaps (file/scan0/HBITMAP sources, LockBits, palettes, HBITMAP export),
// graphics over DCs and images (image drawing with alpha, fills, lines), state setters.
// Images are stored as 32bpp ARGB surfaces in guest memory (same byte layout as PixelFormat32bppARGB),
// indexed images additionally keep their indices and palette so LockBits can hand them back.
import { allocSurface, freeSurface, Surface } from '../gfx/gdi/surface.js';
import { blit, fillRect, line, clipRect, rectEmpty } from '../gfx/gdi/raster.js';
import { parseBitmapInfo, dibSurface } from './gdi32.js';
import { decodeJpeg, isJpeg } from '../gfx/codecs/jpeg.js';
import { decodePng, isPng } from '../gfx/codecs/png.js';

const S = { Ok: 0, GenericError: 1, InvalidParameter: 2, OutOfMemory: 3, InsufficientBuffer: 5, NotImplemented: 6, Win32Error: 7, WrongState: 8, FileNotFound: 10, UnknownImageFormat: 12 };
const PF = { Indexed1: 0x30101, Indexed4: 0x30402, Indexed8: 0x30803, Gray16: 0x101004, RGB555: 0x21005, RGB565: 0x21006, ARGB1555: 0x61007, RGB24: 0x21808, RGB32: 0x22009, ARGB32: 0x26200a, PARGB32: 0xe200b, RGB48: 0x10300c, ARGB64: 0x34400d, PARGB64: 0x1a400e };
const bppOf = (pf) => (pf >> 8) & 0xff;
const ImageLockModeRead = 1, ImageLockModeWrite = 2, ImageLockModeUserInputBuf = 4;

/**
 * @param {import('./api.js').ApiRegistry} api
 * @param {import('../core/vm.js').Vm} vm
 */
export function registerGdiplus(api, vm) {
  const mem = vm.mem;
  const GP = {};
  /** @type {Map<number, any>} guest object pointer -> image / graphics / brush / pen ... */
  const objects = new Map();
  const heap = (c) => c.proc.processHeap;
  const newObject = (c, o) => { o.ptr = heap(c).alloc(16); mem.write32(o.ptr, 0x2b696447); mem.write32(o.ptr + 4, 0); objects.set(o.ptr, o); return o; };
  const deleteObject = (c, o) => { objects.delete(o.ptr); heap(c).free_(o.ptr); };
  const get = (c, i, kind) => { const o = objects.get(c.arg(i)); return o && o.kind === kind ? o : null; };
  const out = (c, i, v) => c.out32(i, v);
  const outF = (c, i, v) => { const a = c.arg(i); if (a) mem.writeF32(a, v); };

  // ---------------------------------------------------------------- images
  const newImage = (c, w, h, opts = {}) => {
    if (!(w > 0 && h > 0) || w > 32767 || h > 32767) return null;
    const surface = allocSurface(c.proc, w, h, 'gdiplus');
    return newObject(c, { kind: 'image', width: w, height: h, surface, format: opts.format ?? PF.ARGB32, palette: opts.palette ?? null, indices: opts.indices ?? null, hasAlpha: !!opts.hasAlpha, lock: null, external: null, dpi: 96 });
  };
  const disposeImage = (c, img) => { if (img.lock?.buf) heap(c).free_(img.lock.buf); freeSurface(c.proc, img.surface); deleteObject(c, img); };
  /** RGBA byte array -> image surface (ARGB u32) */
  const fromRgba = (img, rgba) => {
    const u = img.surface.u32, b = img.surface.base32, st = img.surface.stride32;
    let alpha = false;
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4; const a = rgba[i + 3];
      if (a !== 255) alpha = true;
      u[b + y * st + x] = ((a << 24) | (rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]) >>> 0;
    }
    return alpha;
  };
  /** decode file bytes into a new image (JPEG, PNG, BMP) */
  const decodeImage = (c, bytes) => {
    if (isJpeg(bytes)) {
      const d = decodeJpeg(bytes); const img = newImage(c, d.width, d.height, { format: PF.RGB24 }); if (!img) return null;
      fromRgba(img, d.data); return img;
    }
    if (isPng(bytes)) {
      const d = decodePng(bytes); const img = newImage(c, d.width, d.height); if (!img) return null;
      img.hasAlpha = fromRgba(img, d.data);
      img.format = d.ctype === 3 || d.ctype === 0 ? PF.Indexed8 : img.hasAlpha ? PF.ARGB32 : PF.RGB24;
      if (img.format === PF.Indexed8) {
        // palette + indices reconstructed from the decoded pixels (exact for <= 256 distinct colors)
        const pal = new Map(); const idx = new Uint8Array(img.width * img.height);
        const u = img.surface.u32, b = img.surface.base32, st = img.surface.stride32;
        for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
          const v = u[b + y * st + x] >>> 0; let k = pal.get(v);
          if (k === undefined) { k = pal.size; if (k >= 256) { pal.clear(); break; } pal.set(v, k); }
          idx[y * img.width + x] = k;
        }
        if (pal.size) { img.palette = Uint32Array.from(pal.keys()); img.indices = idx; } else img.format = img.hasAlpha ? PF.ARGB32 : PF.RGB24;
      }
      return img;
    }
    if (bytes.length > 54 && bytes[0] === 0x42 && bytes[1] === 0x4d) { // BMP: parse the DIB through a temporary guest copy
      const tmp = heap(c).alloc(bytes.length); mem.writeBytes(tmp, bytes);
      try {
        const info = parseBitmapInfo(mem, tmp + 14);
        const offBits = mem.read32(tmp + 10) || 14 + info.headerSize + info.colorsSize;
        const img = newImage(c, info.width, info.height, { format: info.bpp <= 8 ? PF.Indexed8 : info.bpp === 16 ? PF.RGB555 : info.bpp === 32 ? PF.RGB32 : PF.RGB24 });
        if (!img) return null;
        const src = dibSurface(mem, tmp + offBits, info);
        blit(img.surface, { l: 0, t: 0, r: img.width, b: img.height }, 0, 0, img.width, img.height, src, 0, 0);
        if (info.palette) { img.palette = Uint32Array.from(info.palette, (v) => (v | 0xff000000) >>> 0); img.indices = new Uint8Array(img.width * img.height); for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) img.indices[y * img.width + x] = info.bpp === 8 ? mem.u8[src.rowAddr(y) + x] : info.bpp === 4 ? (mem.u8[src.rowAddr(y) + (x >> 1)] >> (x & 1 ? 0 : 4)) & 15 : (mem.u8[src.rowAddr(y) + (x >> 3)] >> (7 - (x & 7))) & 1; }
        return img;
      } finally { heap(c).free_(tmp); }
    }
    return null;
  };
  const loadFile = (c, nameIdx, outIdx) => {
    const name = c.wstr(nameIdx);
    if (!name || !c.arg(outIdx)) return S.InvalidParameter;
    const path = c.proc.path(name);
    const bytes = vm.vfs.readFile(path);
    vm.log('file', `gdiplus load ${path} -> ${bytes ? bytes.length + ' bytes' : 'not found'}`);
    if (!bytes) { out(c, outIdx, 0); return S.FileNotFound; }
    let img = null;
    try { img = decodeImage(c, bytes); } catch (e) { vm.warn(`gdiplus: decoding ${path} failed: ${e.message}`); }
    if (!img) { out(c, outIdx, 0); return S.UnknownImageFormat; }
    out(c, outIdx, img.ptr);
    return S.Ok;
  };

  // ---- pixel format conversion between the ARGB surface and a guest buffer of another format
  const alphaOff = (img) => img.surface.u32; // helper to keep names short
  /** copy the image (or rect) into guest memory `dst` with `stride` in pixel format `pf` */
  const exportPixels = (img, rx, ry, rw, rh, dst, stride, pf) => {
    const u = img.surface.u32, b = img.surface.base32, st = img.surface.stride32;
    const bpp = bppOf(pf);
    for (let y = 0; y < rh; y++) {
      const row = (dst + y * stride) >>> 0, srow = b + (ry + y) * st + rx;
      switch (pf) {
        case PF.ARGB32: case PF.PARGB32: case PF.RGB32: for (let x = 0; x < rw; x++) mem.u32[(row >>> 2) + x] = pf === PF.RGB32 ? (u[srow + x] | 0xff000000) >>> 0 : u[srow + x]; break;
        case PF.RGB24: for (let x = 0; x < rw; x++) { const v = u[srow + x]; const p = row + 3 * x; mem.u8[p] = v & 0xff; mem.u8[p + 1] = (v >> 8) & 0xff; mem.u8[p + 2] = (v >> 16) & 0xff; } break;
        case PF.RGB565: for (let x = 0; x < rw; x++) { const v = u[srow + x]; mem.write16(row + 2 * x, ((v >> 8) & 0xf800) | ((v >> 5) & 0x7e0) | ((v >> 3) & 0x1f)); } break;
        case PF.RGB555: case PF.ARGB1555: for (let x = 0; x < rw; x++) { const v = u[srow + x]; mem.write16(row + 2 * x, (pf === PF.ARGB1555 && (v >>> 24) >= 128 ? 0x8000 : 0) | ((v >> 9) & 0x7c00) | ((v >> 6) & 0x3e0) | ((v >> 3) & 0x1f)); } break;
        case PF.Indexed8: case PF.Indexed4: case PF.Indexed1: {
          for (let x = 0; x < rw; x++) {
            const i = img.indices ? img.indices[(ry + y) * img.width + rx + x] : nearestIndex(img.palette, u[srow + x]);
            if (bpp === 8) mem.u8[row + x] = i; else if (bpp === 4) mem.u8[row + (x >> 1)] = x & 1 ? (mem.u8[row + (x >> 1)] & 0xf0) | (i & 15) : (i & 15) << 4; else mem.u8[row + (x >> 3)] = (mem.u8[row + (x >> 3)] & ~(0x80 >> (x & 7))) | ((i & 1) << (7 - (x & 7)));
          }
          break;
        }
        default: return false;
      }
    }
    return true;
  };
  /** copy guest pixels in format `pf` into the image (or rect) */
  const importPixels = (img, rx, ry, rw, rh, src, stride, pf) => {
    const u = img.surface.u32, b = img.surface.base32, st = img.surface.stride32;
    const bpp = bppOf(pf);
    for (let y = 0; y < rh; y++) {
      const row = (src + y * stride) >>> 0, drow = b + (ry + y) * st + rx;
      switch (pf) {
        case PF.ARGB32: case PF.PARGB32: for (let x = 0; x < rw; x++) u[drow + x] = mem.u32[(row >>> 2) + x]; break;
        case PF.RGB32: for (let x = 0; x < rw; x++) u[drow + x] = (mem.u32[(row >>> 2) + x] | 0xff000000) >>> 0; break;
        case PF.RGB24: for (let x = 0; x < rw; x++) { const p = row + 3 * x; u[drow + x] = (0xff000000 | (mem.u8[p + 2] << 16) | (mem.u8[p + 1] << 8) | mem.u8[p]) >>> 0; } break;
        case PF.RGB565: for (let x = 0; x < rw; x++) { const v = mem.read16(row + 2 * x); const r = (v >> 11) & 31, g = (v >> 5) & 63, bl = v & 31; u[drow + x] = (0xff000000 | (((r << 3) | (r >> 2)) << 16) | (((g << 2) | (g >> 4)) << 8) | ((bl << 3) | (bl >> 2))) >>> 0; } break;
        case PF.RGB555: case PF.ARGB1555: for (let x = 0; x < rw; x++) { const v = mem.read16(row + 2 * x); const r = (v >> 10) & 31, g = (v >> 5) & 31, bl = v & 31; const a = pf === PF.ARGB1555 && !(v & 0x8000) ? 0 : 0xff; u[drow + x] = ((a << 24) | (((r << 3) | (r >> 2)) << 16) | (((g << 3) | (g >> 2)) << 8) | ((bl << 3) | (bl >> 2))) >>> 0; } break;
        case PF.Indexed8: case PF.Indexed4: case PF.Indexed1: {
          const pal = img.palette ?? grayPalette(1 << bpp);
          for (let x = 0; x < rw; x++) {
            const i = bpp === 8 ? mem.u8[row + x] : bpp === 4 ? (mem.u8[row + (x >> 1)] >> (x & 1 ? 0 : 4)) & 15 : (mem.u8[row + (x >> 3)] >> (7 - (x & 7))) & 1;
            if (img.indices) img.indices[(ry + y) * img.width + rx + x] = i;
            u[drow + x] = pal[i] ?? 0xff000000;
          }
          break;
        }
        default: return false;
      }
    }
    return true;
  };
  const nearestIndex = (pal, v) => {
    if (!pal) return 0;
    let best = 0, bd = Infinity;
    const r = (v >> 16) & 0xff, g = (v >> 8) & 0xff, b = v & 0xff;
    for (let i = 0; i < pal.length; i++) { const p = pal[i]; const d = ((p >> 16 & 0xff) - r) ** 2 + ((p >> 8 & 0xff) - g) ** 2 + ((p & 0xff) - b) ** 2; if (d < bd) { bd = d; best = i; if (!d) break; } }
    return best;
  };
  const grayPalette = (n) => Uint32Array.from({ length: n }, (_, i) => (0xff000000 | (Math.round(255 * i / (n - 1)) * 0x010101)) >>> 0);
  const rowBytes = (w, pf) => ((w * bppOf(pf) + 31) >> 5) << 2;
  /** images created over a caller buffer (scan0) read from / write back to that buffer */
  const syncIn = (img) => { if (img.external) importPixels(img, 0, 0, img.width, img.height, img.external.scan0, img.external.stride, img.external.format); };
  const syncOut = (img) => { if (img.external) exportPixels(img, 0, 0, img.width, img.height, img.external.scan0, img.external.stride, img.external.format); };

  GP.GdiplusStartup = [3, (c) => {
    const input = c.arg(1);
    if (!c.arg(0) || !input) return S.InvalidParameter;
    const version = mem.read32(input);
    if (version !== 1 && version !== 2) return 4; // UnsupportedGdiplusVersion
    mem.write32(c.arg(0), 0x6770 + 1);
    if (c.arg(2)) { mem.write32(c.arg(2), api.thunkFor('gdiplus.dll', 'GdiplusNotificationHook')); mem.write32(c.arg(2) + 4, api.thunkFor('gdiplus.dll', 'GdiplusNotificationUnhook')); }
    return S.Ok;
  }];
  GP.GdiplusShutdown = [1, () => {}];
  GP.GdiplusNotificationHook = [1, (c) => { out(c, 0, 1); return S.Ok; }];
  GP.GdiplusNotificationUnhook = [1, () => {}];
  GP.GdipAlloc = [1, (c) => heap(c).alloc(c.arg(0))];
  GP.GdipFree = [1, (c) => { if (c.arg(0)) heap(c).free_(c.arg(0)); }];

  GP.GdipCreateBitmapFromFile = [2, (c) => loadFile(c, 0, 1)];
  GP.GdipCreateBitmapFromFileICM = GP.GdipCreateBitmapFromFile;
  GP.GdipLoadImageFromFile = GP.GdipCreateBitmapFromFile;
  GP.GdipLoadImageFromFileICM = GP.GdipCreateBitmapFromFile;
  GP.GdipCreateBitmapFromStream = [2, (c) => { vm.warn('gdiplus: IStream sources are not implemented'); out(c, 1, 0); return S.NotImplemented; }];
  GP.GdipCreateBitmapFromStreamICM = GP.GdipCreateBitmapFromStream; GP.GdipLoadImageFromStream = GP.GdipCreateBitmapFromStream; GP.GdipLoadImageFromStreamICM = GP.GdipCreateBitmapFromStream;
  GP.GdipCreateBitmapFromScan0 = [6, (c) => {
    const w = c.sarg(0), h = c.sarg(1), stride = c.sarg(2), pf = c.arg(3), scan0 = c.arg(4);
    if (!c.arg(5)) return S.InvalidParameter;
    if (scan0 && !stride) { out(c, 5, 0); return S.InvalidParameter; }
    const img = newImage(c, w, h, { format: pf, hasAlpha: pf === PF.ARGB32 || pf === PF.PARGB32 || pf === PF.ARGB1555 });
    if (!img) { out(c, 5, 0); return S.InvalidParameter; }
    if (bppOf(pf) <= 8) { img.palette = grayPalette(1 << bppOf(pf)); img.indices = new Uint8Array(w * h); }
    if (scan0) { img.external = { scan0, stride, format: pf }; if (!importPixels(img, 0, 0, w, h, scan0, stride, pf)) { disposeImage(c, img); out(c, 5, 0); return S.NotImplemented; } }
    out(c, 5, img.ptr);
    return S.Ok;
  }];
  GP.GdipCreateBitmapFromHBITMAP = [3, (c) => {
    const o = c.proc.handles.getAs(c.arg(0), 'gdi');
    if (!o || o.kind !== 'bitmap' || !c.arg(2)) return S.InvalidParameter;
    const img = newImage(c, o.width, o.height, { format: o.bpp <= 8 ? PF.Indexed8 : o.bpp === 16 ? PF.RGB555 : o.bpp === 24 ? PF.RGB24 : PF.RGB32 });
    if (!img) return S.OutOfMemory;
    blit(img.surface, { l: 0, t: 0, r: img.width, b: img.height }, 0, 0, img.width, img.height, o.surface, 0, 0);
    const u = img.surface.u32, b = img.surface.base32, st = img.surface.stride32;
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) u[b + y * st + x] |= 0xff000000;
    out(c, 2, img.ptr);
    return S.Ok;
  }];
  GP.GdipCreateHBITMAPFromBitmap = [3, (c) => {
    const img = get(c, 0, 'image'); if (!img || !c.arg(1)) return S.InvalidParameter;
    syncIn(img);
    const s = allocSurface(c.proc, img.width, img.height, 'bitmap');
    const bg = c.arg(2) >>> 0;
    const su = img.surface.u32, sb = img.surface.base32, sst = img.surface.stride32, du = s.u32, db = s.base32, dst = s.stride32;
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) du[db + y * dst + x] = img.hasAlpha ? blendOver(su[sb + y * sst + x], bg) : su[sb + y * sst + x] & 0xffffff;
    out(c, 1, c.proc.handles.create({ type: 'gdi', kind: 'bitmap', surface: s, width: img.width, height: img.height, bpp: 32 }));
    return S.Ok;
  }];
  GP.GdipCreateHICONFromBitmap = [2, (c) => { out(c, 1, 0); return S.NotImplemented; }];
  GP.GdipDisposeImage = [1, (c) => { const img = get(c, 0, 'image'); if (!img) return S.InvalidParameter; disposeImage(c, img); return S.Ok; }];
  GP.GdipCloneImage = [2, (c) => {
    const img = get(c, 0, 'image'); if (!img || !c.arg(1)) return S.InvalidParameter;
    syncIn(img);
    const n = newImage(c, img.width, img.height, { format: img.format, hasAlpha: img.hasAlpha, palette: img.palette && img.palette.slice(), indices: img.indices && img.indices.slice() });
    if (!n) return S.OutOfMemory;
    mem.copy(n.surface.addr, img.surface.addr, img.width * 4 * img.height);
    out(c, 1, n.ptr);
    return S.Ok;
  }];
  const cloneArea = (c, x, y, w, h, pf, src, outIdx) => {
    if (!src || !c.arg(outIdx)) return S.InvalidParameter;
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > src.width || y + h > src.height) { out(c, outIdx, 0); return S.InvalidParameter; }
    syncIn(src);
    const n = newImage(c, w, h, { format: pf || src.format, hasAlpha: src.hasAlpha, palette: src.palette && src.palette.slice() });
    if (!n) return S.OutOfMemory;
    blit(n.surface, { l: 0, t: 0, r: w, b: h }, 0, 0, w, h, src.surface, x, y);
    if (src.indices) { n.indices = new Uint8Array(w * h); for (let j = 0; j < h; j++) n.indices.set(src.indices.subarray((y + j) * src.width + x, (y + j) * src.width + x + w), j * w); }
    out(c, outIdx, n.ptr);
    return S.Ok;
  };
  GP.GdipCloneBitmapAreaI = [7, (c) => cloneArea(c, c.sarg(0), c.sarg(1), c.sarg(2), c.sarg(3), c.arg(4), get(c, 5, 'image'), 6)];
  GP.GdipCloneBitmapArea = [7, (c) => cloneArea(c, Math.round(c.argF32(0)), Math.round(c.argF32(1)), Math.round(c.argF32(2)), Math.round(c.argF32(3)), c.arg(4), get(c, 5, 'image'), 6)];

  GP.GdipGetImageWidth = [2, (c) => { const img = get(c, 0, 'image'); if (!img || !c.arg(1)) return S.InvalidParameter; out(c, 1, img.width); return S.Ok; }];
  GP.GdipGetImageHeight = [2, (c) => { const img = get(c, 0, 'image'); if (!img || !c.arg(1)) return S.InvalidParameter; out(c, 1, img.height); return S.Ok; }];
  GP.GdipGetImageDimension = [3, (c) => { const img = get(c, 0, 'image'); if (!img) return S.InvalidParameter; outF(c, 1, img.width); outF(c, 2, img.height); return S.Ok; }];
  GP.GdipGetImageBounds = [3, (c) => { const img = get(c, 0, 'image'); if (!img || !c.arg(1)) return S.InvalidParameter; const r = c.arg(1); mem.writeF32(r, 0); mem.writeF32(r + 4, 0); mem.writeF32(r + 8, img.width); mem.writeF32(r + 12, img.height); out(c, 2, 2); return S.Ok; }];
  GP.GdipGetImagePixelFormat = [2, (c) => { const img = get(c, 0, 'image'); if (!img || !c.arg(1)) return S.InvalidParameter; out(c, 1, img.format); return S.Ok; }];
  GP.GdipGetImageType = [2, (c) => { const img = get(c, 0, 'image'); if (!img || !c.arg(1)) return S.InvalidParameter; out(c, 1, 1); return S.Ok; }];
  GP.GdipGetImageFlags = [2, (c) => { const img = get(c, 0, 'image'); if (!img || !c.arg(1)) return S.InvalidParameter; out(c, 1, 0x1 | 0x20 | (img.hasAlpha ? 0x2 : 0) | (img.external ? 0 : 0x10000)); return S.Ok; }];
  GP.GdipGetImageRawFormat = [2, (c) => { const img = get(c, 0, 'image'); if (!img || !c.arg(1)) return S.InvalidParameter; const g = c.arg(1); mem.write32(g, 0xb96b3cab); mem.write16(g + 4, 0x0728); mem.write16(g + 6, 0x11d3); mem.writeBytes(g + 8, Uint8Array.from([0x9d, 0x7b, 0x00, 0x00, 0xf8, 0x1e, 0xf3, 0x2e])); return S.Ok; }];
  GP.GdipGetImageHorizontalResolution = [2, (c) => { const img = get(c, 0, 'image'); if (!img) return S.InvalidParameter; outF(c, 1, img.dpi); return S.Ok; }];
  GP.GdipGetImageVerticalResolution = GP.GdipGetImageHorizontalResolution;
  GP.GdipBitmapSetResolution = [3, (c) => { const img = get(c, 0, 'image'); if (!img) return S.InvalidParameter; img.dpi = c.argF32(1) || 96; return S.Ok; }];
  GP.GdipImageGetFrameCount = [3, (c) => { if (!get(c, 0, 'image')) return S.InvalidParameter; out(c, 2, 1); return S.Ok; }];
  GP.GdipImageGetFrameDimensionsCount = [2, (c) => { if (!get(c, 0, 'image')) return S.InvalidParameter; out(c, 1, 1); return S.Ok; }];
  GP.GdipImageGetFrameDimensionsList = [3, (c) => { if (!get(c, 0, 'image') || !c.arg(1)) return S.InvalidParameter; const g = c.arg(1); mem.write32(g, 0x7462dc86); mem.write16(g + 4, 0x6180); mem.write16(g + 6, 0x4c7e); mem.writeBytes(g + 8, Uint8Array.from([0x8e, 0x3f, 0xee, 0x73, 0x33, 0xa7, 0xa4, 0x83])); return S.Ok; }];
  GP.GdipImageSelectActiveFrame = [3, (c) => (get(c, 0, 'image') ? S.Ok : S.InvalidParameter)];
  GP.GdipImageForceValidation = [1, (c) => (get(c, 0, 'image') ? S.Ok : S.InvalidParameter)];
  GP.GdipImageRotateFlip = [2, (c) => {
    const img = get(c, 0, 'image'); if (!img) return S.InvalidParameter;
    const t = c.arg(1) & 7; if (t === 0) return S.Ok;
    syncIn(img);
    const rot = t & 3, flipX = !!(t & 4);
    const w = img.width, h = img.height, nw = rot & 1 ? h : w, nh = rot & 1 ? w : h;
    const src = img.surface, s = allocSurface(c.proc, nw, nh, 'gdiplus');
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let sx, sy;
      switch (rot) { case 0: sx = x; sy = y; break; case 1: sx = y; sy = h - 1 - x; break; case 2: sx = w - 1 - x; sy = h - 1 - y; break; default: sx = w - 1 - y; sy = x; }
      if (flipX) sx = w - 1 - sx;
      s.u32[s.base32 + y * s.stride32 + x] = src.u32[src.base32 + sy * src.stride32 + sx];
    }
    freeSurface(c.proc, src); img.surface = s; img.width = nw; img.height = nh; img.indices = null;
    syncOut(img);
    return S.Ok;
  }];

  // ---- palettes: ColorPalette { UINT Flags; UINT Count; ARGB Entries[Count]; }
  GP.GdipGetImagePaletteSize = [2, (c) => { const img = get(c, 0, 'image'); if (!img || !c.arg(1)) return S.InvalidParameter; out(c, 1, 8 + 4 * (img.palette ? img.palette.length : 0)); return S.Ok; }];
  GP.GdipGetImagePalette = [3, (c) => {
    const img = get(c, 0, 'image'); const p = c.arg(1), size = c.sarg(2);
    if (!img || !p) return S.InvalidParameter;
    const n = img.palette ? img.palette.length : 0;
    if (size < 8 + 4 * n) return S.InsufficientBuffer;
    mem.write32(p, img.format === PF.Indexed8 && img.palette && img.palette.every((v, i) => v === grayPalette(256)[i]) ? 2 : 0);
    mem.write32(p + 4, n);
    for (let i = 0; i < n; i++) mem.write32(p + 8 + 4 * i, img.palette[i]);
    return S.Ok;
  }];
  GP.GdipSetImagePalette = [2, (c) => {
    const img = get(c, 0, 'image'); const p = c.arg(1);
    if (!img || !p) return S.InvalidParameter;
    const n = mem.read32(p + 4); if (n > 256) return S.InvalidParameter;
    img.palette = new Uint32Array(n); for (let i = 0; i < n; i++) img.palette[i] = mem.read32(p + 8 + 4 * i);
    if (img.indices) { const u = img.surface.u32, b = img.surface.base32, st = img.surface.stride32; for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) u[b + y * st + x] = img.palette[img.indices[y * img.width + x]] ?? 0; }
    return S.Ok;
  }];

  // ---- LockBits / UnlockBits. BitmapData { UINT Width, Height; INT Stride; PixelFormat; void* Scan0; UINT_PTR Reserved; }
  GP.GdipBitmapLockBits = [5, (c) => {
    const img = get(c, 0, 'image'); const rect = c.arg(1), flags = c.arg(2), pf = c.arg(3), bd = c.arg(4);
    if (!img || !bd) return S.InvalidParameter;
    if (img.lock) return S.WrongState;
    let x = 0, y = 0, w = img.width, h = img.height;
    if (rect) { x = mem.readS32(rect); y = mem.readS32(rect + 4); w = mem.readS32(rect + 8); h = mem.readS32(rect + 12); }
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > img.width || y + h > img.height) return S.InvalidParameter;
    if (!bppOf(pf) || (bppOf(pf) > 32 && pf !== PF.Gray16)) return S.InvalidParameter;
    if (pf === PF.Gray16 || pf === PF.RGB48 || pf === PF.ARGB64 || pf === PF.PARGB64) return S.NotImplemented;
    syncIn(img);
    let scan0, stride, buf = 0;
    if (flags & ImageLockModeUserInputBuf) { scan0 = mem.read32(bd + 16); stride = mem.readS32(bd + 8); if (!scan0 || !stride) return S.InvalidParameter; }
    else if (img.external && pf === img.external.format && !img.lockCopy) { scan0 = (img.external.scan0 + y * img.external.stride + ((x * bppOf(pf)) >> 3)) >>> 0; stride = img.external.stride; }
    else if (pf === PF.ARGB32 || pf === PF.PARGB32 || pf === PF.RGB32) { scan0 = (img.surface.addr + y * img.surface.stride + x * 4) >>> 0; stride = img.surface.stride; }
    else { stride = rowBytes(w, pf); buf = heap(c).alloc(stride * h); if (!buf) return S.OutOfMemory; scan0 = buf; }
    if (flags & ImageLockModeRead || !(flags & ImageLockModeWrite)) {
      if (!(scan0 >= img.surface.addr && scan0 < img.surface.addr + img.surface.stride * img.height)) exportPixels(img, x, y, w, h, scan0, stride, pf);
    }
    mem.write32(bd, w); mem.write32(bd + 4, h); mem.write32(bd + 8, stride); mem.write32(bd + 12, pf); mem.write32(bd + 16, scan0); mem.write32(bd + 20, 0);
    img.lock = { x, y, w, h, pf, flags, scan0, stride, buf };
    return S.Ok;
  }];
  GP.GdipBitmapUnlockBits = [2, (c) => {
    const img = get(c, 0, 'image'); const bd = c.arg(1);
    if (!img || !bd) return S.InvalidParameter;
    const l = img.lock; if (!l) return S.WrongState;
    if (l.flags & ImageLockModeWrite) {
      const inPlace = l.scan0 >= img.surface.addr && l.scan0 < img.surface.addr + img.surface.stride * img.height;
      if (!inPlace) importPixels(img, l.x, l.y, l.w, l.h, l.scan0, l.stride, l.pf);
      if (!(img.external && l.scan0 >= img.external.scan0 && l.scan0 < img.external.scan0 + Math.abs(img.external.stride) * img.height)) syncOut(img);
      img.surface.generation++;
    }
    if (l.buf) heap(c).free_(l.buf);
    img.lock = null;
    return S.Ok;
  }];
  GP.GdipBitmapGetPixel = [4, (c) => { const img = get(c, 0, 'image'); const x = c.sarg(1), y = c.sarg(2); if (!img || !c.arg(3) || x < 0 || y < 0 || x >= img.width || y >= img.height) return S.InvalidParameter; syncIn(img); out(c, 3, img.surface.u32[img.surface.base32 + y * img.surface.stride32 + x]); return S.Ok; }];
  GP.GdipBitmapSetPixel = [4, (c) => { const img = get(c, 0, 'image'); const x = c.sarg(1), y = c.sarg(2); if (!img || x < 0 || y < 0 || x >= img.width || y >= img.height) return S.InvalidParameter; img.surface.u32[img.surface.base32 + y * img.surface.stride32 + x] = c.arg(3); if (img.indices) img.indices[y * img.width + x] = nearestIndex(img.palette, c.arg(3)); syncOut(img); return S.Ok; }];
  GP.GdipBitmapConvertFormat = [6, () => S.NotImplemented];
  GP.GdipGetImageThumbnail = [6, (c) => { out(c, 3, 0); return S.NotImplemented; }];
  GP.GdipSaveImageToFile = [4, () => S.NotImplemented];
  GP.GdipSaveImageToStream = [4, () => S.NotImplemented];
  GP.GdipGetImageEncodersSize = [2, (c) => { out(c, 0, 0); out(c, 1, 0); return S.Ok; }];
  GP.GdipGetImageDecodersSize = GP.GdipGetImageEncodersSize;
  GP.GdipGetImageEncoders = [3, () => S.Ok]; GP.GdipGetImageDecoders = [3, () => S.Ok];
  GP.GdipGetPropertyCount = [2, (c) => { out(c, 1, 0); return S.Ok; }];
  GP.GdipGetPropertyIdList = [3, () => S.Ok];
  GP.GdipGetPropertyItemSize = [3, () => 19]; // PropertyNotFound
  GP.GdipGetPropertyItem = [4, () => 19];

  // ---------------------------------------------------------------- graphics
  // { kind:'graphics', surface, clip, ox, oy, dc?, image? }
  const newGraphics = (c, surface, opts) => newObject(c, { kind: 'graphics', surface, clip: opts.clip ?? { l: 0, t: 0, r: surface.width, b: surface.height }, ox: opts.ox ?? 0, oy: opts.oy ?? 0, dc: opts.dc ?? null, image: opts.image ?? null, state: {} });
  GP.GdipCreateFromHDC = [2, (c) => {
    const dc = c.proc.handles.getAs(c.arg(0), 'gdi');
    if (!dc || dc.kind !== 'dc' || !dc.surface || !c.arg(1)) return S.InvalidParameter;
    out(c, 1, newGraphics(c, dc.surface, { clip: dc.clip, ox: dc.ox, oy: dc.oy, dc }).ptr);
    return S.Ok;
  }];
  GP.GdipCreateFromHDC2 = [3, (c) => GP.GdipCreateFromHDC[1]({ ...c, arg: (i) => c.arg(i === 1 ? 2 : i), out32: (i, v) => c.out32(i === 1 ? 2 : i, v) })];
  GP.GdipCreateFromHWND = [2, (c) => { vm.warn('gdiplus: GdipCreateFromHWND is not implemented'); out(c, 1, 0); return S.NotImplemented; }];
  GP.GdipGetImageGraphicsContext = [2, (c) => { const img = get(c, 0, 'image'); if (!img || !c.arg(1)) return S.InvalidParameter; syncIn(img); out(c, 1, newGraphics(c, img.surface, { image: img }).ptr); return S.Ok; }];
  GP.GdipDeleteGraphics = [1, (c) => { const g = get(c, 0, 'graphics'); if (!g) return S.InvalidParameter; if (g.image) syncOut(g.image); deleteObject(c, g); return S.Ok; }];
  GP.GdipGetDC = [2, (c) => { const g = get(c, 0, 'graphics'); if (!g || !c.arg(1)) return S.InvalidParameter; if (!g.dc) return S.NotImplemented; out(c, 1, g.dc.handle); return S.Ok; }];
  GP.GdipReleaseDC = [2, (c) => (get(c, 0, 'graphics') ? S.Ok : S.InvalidParameter)];
  GP.GdipFlush = [2, (c) => (get(c, 0, 'graphics') ? S.Ok : S.InvalidParameter)];
  const setter = (name) => [2, (c) => { const g = get(c, 0, 'graphics'); if (!g) return S.InvalidParameter; g.state[name] = c.arg(1); return S.Ok; }];
  const getter = (name, dflt) => [2, (c) => { const g = get(c, 0, 'graphics'); if (!g || !c.arg(1)) return S.InvalidParameter; out(c, 1, g.state[name] ?? dflt); return S.Ok; }];
  for (const n of ['InterpolationMode', 'SmoothingMode', 'CompositingMode', 'CompositingQuality', 'PixelOffsetMode', 'TextRenderingHint', 'TextContrast', 'PageUnit', 'PageScale']) { GP['GdipSet' + n] = setter(n); GP['GdipGet' + n] = getter(n, 0); }
  GP.GdipGetDpiX = [2, (c) => { if (!get(c, 0, 'graphics')) return S.InvalidParameter; outF(c, 1, 96); return S.Ok; }];
  GP.GdipGetDpiY = GP.GdipGetDpiX;
  GP.GdipSetRenderingOrigin = [3, () => S.Ok];
  GP.GdipGraphicsClear = [2, (c) => { const g = get(c, 0, 'graphics'); if (!g) return S.InvalidParameter; const argb = c.arg(1) >>> 0; const s = g.surface; const cc = clipRect(g.clip, { l: 0, t: 0, r: s.width, b: s.height }); for (let y = cc.t; y < cc.b; y++) for (let x = cc.l; x < cc.r; x++) s.u32[s.base32 + y * s.stride32 + x] = argb; s.generation++; return S.Ok; }];
  // clipping
  GP.GdipSetClipRectI = [6, (c) => { const g = get(c, 0, 'graphics'); if (!g) return S.InvalidParameter; const x = c.sarg(1) + g.ox, y = c.sarg(2) + g.oy; g.clip = clipRect({ l: 0, t: 0, r: g.surface.width, b: g.surface.height }, { l: x, t: y, r: x + c.sarg(3), b: y + c.sarg(4) }); return S.Ok; }];
  GP.GdipSetClipRect = [6, (c) => { const g = get(c, 0, 'graphics'); if (!g) return S.InvalidParameter; const x = Math.round(c.argF32(1)) + g.ox, y = Math.round(c.argF32(2)) + g.oy; g.clip = clipRect({ l: 0, t: 0, r: g.surface.width, b: g.surface.height }, { l: x, t: y, r: x + Math.round(c.argF32(3)), b: y + Math.round(c.argF32(4)) }); return S.Ok; }];
  GP.GdipResetClip = [1, (c) => { const g = get(c, 0, 'graphics'); if (!g) return S.InvalidParameter; g.clip = g.dc ? g.dc.clip : { l: 0, t: 0, r: g.surface.width, b: g.surface.height }; return S.Ok; }];
  GP.GdipGetClipBounds = [2, (c) => { const g = get(c, 0, 'graphics'); if (!g || !c.arg(1)) return S.InvalidParameter; const r = c.arg(1); mem.writeF32(r, g.clip.l - g.ox); mem.writeF32(r + 4, g.clip.t - g.oy); mem.writeF32(r + 8, g.clip.r - g.clip.l); mem.writeF32(r + 12, g.clip.b - g.clip.t); return S.Ok; }];
  GP.GdipGetVisibleClipBounds = GP.GdipGetClipBounds;
  // world transform: translation only (games use GDI+ for splash/UI blits)
  GP.GdipResetWorldTransform = [1, (c) => { const g = get(c, 0, 'graphics'); if (!g) return S.InvalidParameter; g.tx = 0; g.ty = 0; return S.Ok; }];
  GP.GdipTranslateWorldTransform = [4, (c) => { const g = get(c, 0, 'graphics'); if (!g) return S.InvalidParameter; g.tx = (g.tx ?? 0) + c.argF32(1); g.ty = (g.ty ?? 0) + c.argF32(2); return S.Ok; }];
  GP.GdipSetWorldTransform = [2, (c) => { const g = get(c, 0, 'graphics'); if (!g || !c.arg(1)) return S.InvalidParameter; const m = c.arg(1); g.tx = mem.readF32(m + 16); g.ty = mem.readF32(m + 20); return S.Ok; }];
  GP.GdipScaleWorldTransform = [4, () => S.Ok];
  GP.GdipRotateWorldTransform = [3, () => S.Ok];
  GP.GdipSaveGraphics = [2, (c) => { const g = get(c, 0, 'graphics'); if (!g) return S.InvalidParameter; g.saved = g.saved ?? []; g.saved.push({ clip: g.clip, tx: g.tx, ty: g.ty, state: { ...g.state } }); out(c, 1, g.saved.length); return S.Ok; }];
  GP.GdipRestoreGraphics = [2, (c) => { const g = get(c, 0, 'graphics'); if (!g) return S.InvalidParameter; const s = g.saved?.[c.arg(1) - 1]; if (s) { g.clip = s.clip; g.tx = s.tx; g.ty = s.ty; g.state = s.state; g.saved.length = c.arg(1) - 1; } return S.Ok; }];

  /** draw image rect (sx,sy,sw,sh) to (dx,dy,dw,dh) with nearest sampling and source-over alpha */
  const drawImage = (g, img, dx, dy, dw, dh, sx, sy, sw, sh) => {
    if (dw <= 0 || dh <= 0 || sw <= 0 || sh <= 0) return;
    syncIn(img);
    dx += g.ox + (g.tx ?? 0); dy += g.oy + (g.ty ?? 0);
    const d = g.surface, s = img.surface;
    const cc = clipRect(clipRect(g.clip, { l: Math.round(dx), t: Math.round(dy), r: Math.round(dx + dw), b: Math.round(dy + dh) }), { l: 0, t: 0, r: d.width, b: d.height });
    if (rectEmpty(cc)) return;
    const du = d.u32, su = s.u32;
    const fx = sw / dw, fy = sh / dh;
    for (let y = cc.t; y < cc.b; y++) {
      const syy = Math.min(s.height - 1, Math.max(0, Math.floor(sy + (y - dy) * fy)));
      const srow = s.base32 + syy * s.stride32, drow = d.base32 + y * d.stride32;
      for (let x = cc.l; x < cc.r; x++) {
        const sxx = Math.min(s.width - 1, Math.max(0, Math.floor(sx + (x - dx) * fx)));
        const v = su[srow + sxx];
        du[drow + x] = img.hasAlpha ? blendOver(v, du[drow + x]) : v;
      }
    }
    d.generation++;
    if (g.image) syncOut(g.image);
  };
  GP.GdipDrawImageI = [4, (c) => { const g = get(c, 0, 'graphics'), img = get(c, 1, 'image'); if (!g || !img) return S.InvalidParameter; drawImage(g, img, c.sarg(2), c.sarg(3), img.width, img.height, 0, 0, img.width, img.height); return S.Ok; }];
  GP.GdipDrawImage = [4, (c) => { const g = get(c, 0, 'graphics'), img = get(c, 1, 'image'); if (!g || !img) return S.InvalidParameter; drawImage(g, img, c.argF32(2), c.argF32(3), img.width, img.height, 0, 0, img.width, img.height); return S.Ok; }];
  GP.GdipDrawImageRectI = [6, (c) => { const g = get(c, 0, 'graphics'), img = get(c, 1, 'image'); if (!g || !img) return S.InvalidParameter; drawImage(g, img, c.sarg(2), c.sarg(3), c.sarg(4), c.sarg(5), 0, 0, img.width, img.height); return S.Ok; }];
  GP.GdipDrawImageRect = [6, (c) => { const g = get(c, 0, 'graphics'), img = get(c, 1, 'image'); if (!g || !img) return S.InvalidParameter; drawImage(g, img, c.argF32(2), c.argF32(3), c.argF32(4), c.argF32(5), 0, 0, img.width, img.height); return S.Ok; }];
  GP.GdipDrawImagePointRectI = [9, (c) => { const g = get(c, 0, 'graphics'), img = get(c, 1, 'image'); if (!g || !img) return S.InvalidParameter; drawImage(g, img, c.sarg(2), c.sarg(3), c.sarg(6), c.sarg(7), c.sarg(4), c.sarg(5), c.sarg(6), c.sarg(7)); return S.Ok; }];
  GP.GdipDrawImagePointRect = [9, (c) => { const g = get(c, 0, 'graphics'), img = get(c, 1, 'image'); if (!g || !img) return S.InvalidParameter; drawImage(g, img, c.argF32(2), c.argF32(3), c.argF32(6), c.argF32(7), c.argF32(4), c.argF32(5), c.argF32(6), c.argF32(7)); return S.Ok; }];
  GP.GdipDrawImageRectRectI = [11, (c) => { const g = get(c, 0, 'graphics'), img = get(c, 1, 'image'); if (!g || !img) return S.InvalidParameter; drawImage(g, img, c.sarg(2), c.sarg(3), c.sarg(4), c.sarg(5), c.sarg(6), c.sarg(7), c.sarg(8), c.sarg(9)); return S.Ok; }];
  GP.GdipDrawImageRectRect = [11, (c) => { const g = get(c, 0, 'graphics'), img = get(c, 1, 'image'); if (!g || !img) return S.InvalidParameter; drawImage(g, img, c.argF32(2), c.argF32(3), c.argF32(4), c.argF32(5), c.argF32(6), c.argF32(7), c.argF32(8), c.argF32(9)); return S.Ok; }];
  GP.GdipDrawImagePointsRectI = [11, (c) => { const g = get(c, 0, 'graphics'), img = get(c, 1, 'image'); if (!g || !img) return S.InvalidParameter; const p = c.arg(2); if (c.sarg(3) < 3) return S.InvalidParameter; const x0 = mem.readS32(p), y0 = mem.readS32(p + 4), x1 = mem.readS32(p + 8), y2 = mem.readS32(p + 20); drawImage(g, img, x0, y0, x1 - x0, y2 - y0, c.sarg(4), c.sarg(5), c.sarg(6), c.sarg(7)); return S.Ok; }];
  GP.GdipDrawImagePointsRect = [11, (c) => { const g = get(c, 0, 'graphics'), img = get(c, 1, 'image'); if (!g || !img) return S.InvalidParameter; const p = c.arg(2); if (c.sarg(3) < 3) return S.InvalidParameter; const x0 = mem.readF32(p), y0 = mem.readF32(p + 4), x1 = mem.readF32(p + 8), y2 = mem.readF32(p + 20); drawImage(g, img, x0, y0, x1 - x0, y2 - y0, c.argF32(4), c.argF32(5), c.argF32(6), c.argF32(7)); return S.Ok; }];
  GP.GdipCreateCachedBitmap = [3, (c) => { const img = get(c, 0, 'image'); if (!img || !get(c, 1, 'graphics') || !c.arg(2)) return S.InvalidParameter; out(c, 2, newObject(c, { kind: 'cached', image: img }).ptr); return S.Ok; }];
  GP.GdipDeleteCachedBitmap = [1, (c) => { const o = get(c, 0, 'cached'); if (!o) return S.InvalidParameter; deleteObject(c, o); return S.Ok; }];
  GP.GdipDrawCachedBitmap = [4, (c) => { const g = get(c, 0, 'graphics'), o = get(c, 1, 'cached'); if (!g || !o || !objects.has(o.image.ptr)) return S.InvalidParameter; drawImage(g, o.image, c.sarg(2), c.sarg(3), o.image.width, o.image.height, 0, 0, o.image.width, o.image.height); return S.Ok; }];

  // ---- brushes, pens, simple shapes
  GP.GdipCreateSolidFill = [2, (c) => { if (!c.arg(1)) return S.InvalidParameter; out(c, 1, newObject(c, { kind: 'brush', argb: c.arg(0) >>> 0 }).ptr); return S.Ok; }];
  GP.GdipSetSolidFillColor = [2, (c) => { const b = get(c, 0, 'brush'); if (!b) return S.InvalidParameter; b.argb = c.arg(1) >>> 0; return S.Ok; }];
  GP.GdipGetSolidFillColor = [2, (c) => { const b = get(c, 0, 'brush'); if (!b) return S.InvalidParameter; out(c, 1, b.argb); return S.Ok; }];
  GP.GdipDeleteBrush = [1, (c) => { const b = get(c, 0, 'brush'); if (!b) return S.InvalidParameter; deleteObject(c, b); return S.Ok; }];
  GP.GdipCloneBrush = [2, (c) => { const b = get(c, 0, 'brush'); if (!b || !c.arg(1)) return S.InvalidParameter; out(c, 1, newObject(c, { kind: 'brush', argb: b.argb }).ptr); return S.Ok; }];
  GP.GdipCreatePen1 = [4, (c) => { if (!c.arg(3)) return S.InvalidParameter; out(c, 3, newObject(c, { kind: 'pen', argb: c.arg(0) >>> 0, width: c.argF32(1) }).ptr); return S.Ok; }];
  GP.GdipCreatePen2 = [4, (c) => { const b = get(c, 0, 'brush'); if (!b || !c.arg(3)) return S.InvalidParameter; out(c, 3, newObject(c, { kind: 'pen', argb: b.argb, width: c.argF32(1) }).ptr); return S.Ok; }];
  GP.GdipDeletePen = [1, (c) => { const p = get(c, 0, 'pen'); if (!p) return S.InvalidParameter; deleteObject(c, p); return S.Ok; }];
  GP.GdipSetPenWidth = [2, (c) => { const p = get(c, 0, 'pen'); if (!p) return S.InvalidParameter; p.width = c.argF32(1); return S.Ok; }];
  GP.GdipSetPenColor = [2, (c) => { const p = get(c, 0, 'pen'); if (!p) return S.InvalidParameter; p.argb = c.arg(1) >>> 0; return S.Ok; }];
  for (const n of ['GdipSetPenDashStyle', 'GdipSetPenLineJoin', 'GdipSetPenStartCap', 'GdipSetPenEndCap', 'GdipSetPenMode', 'GdipSetPenBrushFill']) GP[n] = [2, (c) => (get(c, 0, 'pen') ? S.Ok : S.InvalidParameter)];
  const fillArgb = (g, l, t, r, b, argb) => {
    const s = g.surface; const cc = clipRect(clipRect(g.clip, { l, t, r, b }), { l: 0, t: 0, r: s.width, b: s.height });
    if (rectEmpty(cc)) return;
    const a = argb >>> 24;
    for (let y = cc.t; y < cc.b; y++) for (let x = cc.l; x < cc.r; x++) { const i = s.base32 + y * s.stride32 + x; s.u32[i] = a === 255 ? argb : blendOver(argb, s.u32[i]); }
    s.generation++;
    if (g.image) syncOut(g.image);
  };
  GP.GdipFillRectangleI = [6, (c) => { const g = get(c, 0, 'graphics'), b = get(c, 1, 'brush'); if (!g || !b) return S.InvalidParameter; const x = c.sarg(2) + g.ox + (g.tx ?? 0), y = c.sarg(3) + g.oy + (g.ty ?? 0); fillArgb(g, x, y, x + c.sarg(4), y + c.sarg(5), b.argb); return S.Ok; }];
  GP.GdipFillRectangle = [6, (c) => { const g = get(c, 0, 'graphics'), b = get(c, 1, 'brush'); if (!g || !b) return S.InvalidParameter; const x = Math.round(c.argF32(2) + g.ox + (g.tx ?? 0)), y = Math.round(c.argF32(3) + g.oy + (g.ty ?? 0)); fillArgb(g, x, y, x + Math.round(c.argF32(4)), y + Math.round(c.argF32(5)), b.argb); return S.Ok; }];
  GP.GdipDrawRectangleI = [6, (c) => { const g = get(c, 0, 'graphics'), p = get(c, 1, 'pen'); if (!g || !p) return S.InvalidParameter; const x = c.sarg(2) + g.ox + (g.tx ?? 0), y = c.sarg(3) + g.oy + (g.ty ?? 0), w = c.sarg(4), h = c.sarg(5), t = Math.max(1, Math.round(p.width)); fillArgb(g, x, y, x + w + 1, y + t, p.argb); fillArgb(g, x, y + h + 1 - t, x + w + 1, y + h + 1, p.argb); fillArgb(g, x, y + t, x + t, y + h + 1 - t, p.argb); fillArgb(g, x + w + 1 - t, y + t, x + w + 1, y + h + 1 - t, p.argb); return S.Ok; }];
  GP.GdipDrawRectangle = [6, (c) => GP.GdipDrawRectangleI[1]({ ...c, sarg: (i) => (i >= 2 ? Math.round(c.argF32(i)) : c.sarg(i)) })];
  GP.GdipDrawLineI = [6, (c) => { const g = get(c, 0, 'graphics'), p = get(c, 1, 'pen'); if (!g || !p) return S.InvalidParameter; line(g.surface, g.clip, c.sarg(2) + g.ox, c.sarg(3) + g.oy, c.sarg(4) + g.ox, c.sarg(5) + g.oy, p.argb & 0xffffff, Math.max(1, Math.round(p.width))); if (g.image) syncOut(g.image); return S.Ok; }];
  GP.GdipDrawLine = [6, (c) => GP.GdipDrawLineI[1]({ ...c, sarg: (i) => (i >= 2 ? Math.round(c.argF32(i)) : c.sarg(i)) })];
  GP.GdipDrawString = [7, (c) => { const g = get(c, 0, 'graphics'); if (!g) return S.InvalidParameter; vm.warn('gdiplus: GdipDrawString is not implemented (text skipped)'); return S.Ok; }];
  GP.GdipMeasureString = [8, (c) => { const g = get(c, 0, 'graphics'); if (!g) return S.InvalidParameter; const r = c.arg(5); if (r) { mem.writeF32(r, 0); mem.writeF32(r + 4, 0); mem.writeF32(r + 8, 8 * c.sarg(2)); mem.writeF32(r + 12, 16); } return S.Ok; }];
  // image attributes (color keys / matrices are accepted and ignored: the game's splash/UI blits do not depend on them)
  GP.GdipCreateImageAttributes = [1, (c) => { if (!c.arg(0)) return S.InvalidParameter; out(c, 0, newObject(c, { kind: 'imageattr' }).ptr); return S.Ok; }];
  GP.GdipDisposeImageAttributes = [1, (c) => { const o = get(c, 0, 'imageattr'); if (!o) return S.InvalidParameter; deleteObject(c, o); return S.Ok; }];
  GP.GdipSetImageAttributesColorKeys = [5, (c) => (get(c, 0, 'imageattr') ? S.Ok : S.InvalidParameter)];
  GP.GdipSetImageAttributesColorMatrix = [6, (c) => (get(c, 0, 'imageattr') ? S.Ok : S.InvalidParameter)];
  GP.GdipSetImageAttributesWrapMode = [4, (c) => (get(c, 0, 'imageattr') ? S.Ok : S.InvalidParameter)];

  api.define('gdiplus.dll', GP);
}

/** source-over composite of ARGB `src` on `dst` (dst alpha treated as opaque result) */
function blendOver(src, dst) {
  const a = src >>> 24;
  if (a === 255) return src >>> 0;
  if (a === 0) return dst >>> 0;
  const ia = 255 - a;
  const r = (((src >> 16) & 0xff) * a + ((dst >> 16) & 0xff) * ia + 127) / 255 | 0;
  const g = (((src >> 8) & 0xff) * a + ((dst >> 8) & 0xff) * ia + 127) / 255 | 0;
  const b = ((src & 0xff) * a + (dst & 0xff) * ia + 127) / 255 | 0;
  const da = dst >>> 24; const oa = a + ((da * ia + 127) / 255 | 0);
  return ((oa << 24) | (r << 16) | (g << 8) | b) >>> 0;
}

export { PF as PixelFormat, S as GpStatus };
