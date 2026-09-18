// Pixel surfaces for the software GDI. Pixels live in guest memory so that DIB sections are
// directly writable by the guest and every blit source/destination shares one representation.
//
// 32 bpp is the native format: u32 = 0x00RRGGBB (little-endian bytes B,G,R,X = Windows 32bpp DIB).
// 24/16/8 bpp DIBs are supported through slower per-pixel accessors.
import { PAGE_READWRITE } from '../../win32/vmem.js';

export class Surface {
  /**
   * @param {import('../../cpu/memory.js').GuestMemory} mem
   * @param {number} addr byte address of row 0 (top row in drawing coordinates)
   * @param {number} width
   * @param {number} height
   * @param {number} strideBytes bytes between rows (negative for bottom-up DIBs)
   * @param {number} [bpp]
   * @param {{ palette?: Uint32Array, masks?: number[] }} [opts]
   */
  constructor(mem, addr, width, height, strideBytes, bpp = 32, opts = {}) {
    this.mem = mem;
    this.addr = addr >>> 0;
    this.width = width;
    this.height = height;
    this.stride = strideBytes;
    this.bpp = bpp;
    this.palette = opts.palette ?? null;
    this.masks = opts.masks ?? null; // [r,g,b] bit masks for 16/32 bpp BI_BITFIELDS
    this.generation = 0; // bumped on writes (for presentation)
    this.is32 = bpp === 32 && (this.addr & 3) === 0 && (strideBytes & 3) === 0;
    this.u32 = mem.u32;
    this.base32 = this.addr >>> 2;
    this.stride32 = strideBytes >> 2;
  }

  /** Row byte address. */
  rowAddr(y) { return (this.addr + y * this.stride) >>> 0; }

  getPixel(x, y) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    if (this.is32) return this.u32[this.base32 + y * this.stride32 + x] & 0xffffff;
    const m = this.mem, a = this.rowAddr(y);
    switch (this.bpp) {
      case 24: { const p = a + 3 * x; return m.u8[p] | (m.u8[p + 1] << 8) | (m.u8[p + 2] << 16); }
      case 16: return this.from16(m.read16(a + 2 * x));
      case 8: return this.palette ? this.palette[m.u8[a + x]] & 0xffffff : m.u8[a + x] * 0x010101;
      case 4: { const b = m.u8[a + (x >> 1)]; const i = x & 1 ? b & 15 : b >> 4; return this.palette ? this.palette[i] & 0xffffff : i * 0x111111; }
      case 1: { const b = m.u8[a + (x >> 3)]; const i = (b >> (7 - (x & 7))) & 1; return this.palette ? this.palette[i] & 0xffffff : i ? 0xffffff : 0; }
      default: return this.u32[(a >>> 2) + x] & 0xffffff;
    }
  }

  setPixel(x, y, c) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.generation++;
    if (this.is32) { this.u32[this.base32 + y * this.stride32 + x] = c & 0xffffff; return; }
    const m = this.mem, a = this.rowAddr(y);
    switch (this.bpp) {
      case 24: { const p = a + 3 * x; m.u8[p] = c & 0xff; m.u8[p + 1] = (c >> 8) & 0xff; m.u8[p + 2] = (c >> 16) & 0xff; return; }
      case 16: m.write16(a + 2 * x, this.to16(c)); return;
      case 8: m.u8[a + x] = this.nearestIndex(c); return;
      default: this.u32[(a >>> 2) + x] = c & 0xffffff;
    }
  }

  from16(v) {
    if (this.masks && this.masks[1] === 0x7e0) { // 565
      const r = (v >> 11) & 31, g = (v >> 5) & 63, b = v & 31;
      return ((r << 3 | r >> 2) << 16) | ((g << 2 | g >> 4) << 8) | (b << 3 | b >> 2);
    }
    const r = (v >> 10) & 31, g = (v >> 5) & 31, b = v & 31; // 555
    return ((r << 3 | r >> 2) << 16) | ((g << 3 | g >> 2) << 8) | (b << 3 | b >> 2);
  }
  to16(c) {
    const r = (c >> 16) & 0xff, g = (c >> 8) & 0xff, b = c & 0xff;
    if (this.masks && this.masks[1] === 0x7e0) return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
    return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
  }
  nearestIndex(c) {
    if (!this.palette) return c & 0xff;
    let best = 0, bd = Infinity;
    const r = (c >> 16) & 0xff, g = (c >> 8) & 0xff, b = c & 0xff;
    for (let i = 0; i < this.palette.length; i++) {
      const p = this.palette[i];
      const d = (((p >> 16) & 0xff) - r) ** 2 + (((p >> 8) & 0xff) - g) ** 2 + ((p & 0xff) - b) ** 2;
      if (d < bd) { bd = d; best = i; if (d === 0) break; }
    }
    return best;
  }

  /** Copy a row of pixels into a Uint32Array (0x00RRGGBB). */
  readRow(y, x0, n, out) {
    if (this.is32) { const b = this.base32 + y * this.stride32 + x0; for (let i = 0; i < n; i++) out[i] = this.u32[b + i] & 0xffffff; }
    else for (let i = 0; i < n; i++) out[i] = this.getPixel(x0 + i, y);
  }
  writeRow(y, x0, n, src) {
    this.generation++;
    if (this.is32) { const b = this.base32 + y * this.stride32 + x0; for (let i = 0; i < n; i++) this.u32[b + i] = src[i] & 0xffffff; }
    else for (let i = 0; i < n; i++) this.setPixel(x0 + i, y, src[i]);
  }

  /** Bytes per row for a DIB of the given format (DWORD aligned). */
  static rowBytes(width, bpp) { return ((width * bpp + 31) >> 5) << 2; }
}

/** Allocate a 32bpp surface in guest address space. */
export function allocSurface(proc, width, height, tag = 'gdi') {
  const stride = width * 4;
  const size = Math.max(stride * height, 4096);
  const addr = proc.vmem.alloc(size, PAGE_READWRITE, 'surface:' + tag);
  if (!addr) throw new Error('out of address space for surface');
  proc.mem.fill(addr, size, 0);
  const s = new Surface(proc.mem, addr, width, height, stride, 32);
  s.owned = { base: addr };
  return s;
}

export function freeSurface(proc, s) {
  if (s?.owned) { proc.vmem.release(s.owned.base); s.owned = null; }
}
