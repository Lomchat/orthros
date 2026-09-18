// Win32 heaps (HeapCreate/HeapAlloc...): segregated free lists with boundary tags, entirely in
// guest memory (no host object per block: games allocate millions of blocks). Block layout:
//   [u32 user size][u32 magic] user area (8-aligned) [u32 user size (footer)]
// Free blocks keep a doubly linked list in their user area (next, prev) per size class; chunks
// obtained from VMem start and end with used sentinel blocks so coalescing stops at their edges.
import { PAGE_READWRITE, alignUp } from './vmem.js';

const HDR = 8, FTR = 4;
const MAGIC_USED = 0x4f524855; // 'UHRO'
const MAGIC_FREE = 0x46524855;
const MIN_CHUNK = 0x100000; // 1 MB growth
const MIN_USER = 16, SPLIT_MIN = HDR + FTR + MIN_USER;
const CLASSES = 128;

/** size class of an 8-aligned user size: exact classes up to 512 bytes, then powers of two */
function classIndex(size) {
  if (size <= 512) return size >> 3;
  let c = 65;
  for (let s = 1024; s < size && c < CLASSES - 1; s <<= 1) c++;
  return c;
}

export class Heap {
  /**
   * @param {import('./process.js').Process} proc
   * @param {{ initial?: number, max?: number, tag?: string }} [opts]
   */
  constructor(proc, opts = {}) {
    this.proc = proc;
    this.mem = proc.mem;
    this.vmem = proc.vmem;
    this.type = 'heap';
    this.tag = opts.tag ?? 'heap';
    this.max = opts.max ?? 0; // 0 = growable
    this.heads = new Uint32Array(CLASSES);
    this.chunks = [];
    this.total = 0;
    this.grow(Math.max(opts.initial ?? MIN_CHUNK, MIN_CHUNK));
  }

  grow(size) {
    size = alignUp(size + 64, 0x10000);
    if (this.max && this.total + size > Math.max(this.max, 0x10000)) return false;
    const base = this.vmem.alloc(size, PAGE_READWRITE, 'heap:' + this.tag);
    if (!base) return false;
    this.chunks.push({ base, size });
    this.total += size;
    const m = this.mem;
    // start sentinel: a used block with a 4-byte user area so the first real block's user address is 8-aligned
    m.write32(base, 4); m.write32(base + 4, MAGIC_USED); m.write32(base + 12, 4);
    // end sentinel header (8 bytes at the very end)
    m.write32(base + size - 8, 0); m.write32(base + size - 4, MAGIC_USED);
    const user = base + 16 + HDR;
    this.setFree(user, size - 16 - HDR - FTR - 8);
    return true;
  }

  link(b, c) {
    const m = this.mem, next = this.heads[c];
    m.write32(b, next); m.write32(b + 4, 0);
    if (next) m.write32(next + 4, b);
    this.heads[c] = b;
  }
  unlink(b, c) {
    const m = this.mem, next = m.read32(b), prev = m.read32(b + 4);
    if (prev) m.write32(prev, next); else this.heads[c] = next;
    if (next) m.write32(next + 4, prev);
  }
  setFree(b, size) {
    const m = this.mem;
    m.write32(b - 8, size); m.write32(b - 4, MAGIC_FREE); m.write32(b + size, size);
    this.link(b, classIndex(size));
  }

  /** @returns {number} user address or 0 */
  alloc(size, zero = false) {
    size = Math.max(MIN_USER, alignUp(size >>> 0, 8));
    if (size > 0x7fffffff) return 0;
    const m = this.mem;
    for (let attempt = 0; attempt < 2; attempt++) {
      for (let c = classIndex(size); c < CLASSES; c++) {
        let b = this.heads[c];
        while (b) {
          const bs = m.read32(b - 8);
          if (bs >= size) {
            this.unlink(b, c);
            const rem = bs - size;
            if (rem >= SPLIT_MIN) {
              m.write32(b - 8, size); m.write32(b + size, size);
              this.setFree(b + size + FTR + HDR, rem - FTR - HDR);
            }
            m.write32(b - 4, MAGIC_USED);
            if (zero) m.fill(b, m.read32(b - 8), 0);
            return b;
          }
          b = m.read32(b);
        }
      }
      if (!this.grow(size + HDR + FTR + 32)) return 0;
    }
    return 0;
  }

  /** @returns {boolean} */
  free_(addr) {
    const m = this.mem;
    addr >>>= 0;
    if (!this.inHeap(addr) || m.read32(addr - 4) !== MAGIC_USED) return false;
    let size = m.read32(addr - 8);
    m.write32(addr - 4, MAGIC_FREE);
    // coalesce forward
    const nextU = addr + size + FTR + HDR;
    if (m.read32(nextU - 4) === MAGIC_FREE) { const ns = m.read32(nextU - 8); this.unlink(nextU, classIndex(ns)); size += FTR + HDR + ns; }
    // coalesce backward
    const ps = m.read32(addr - HDR - FTR);
    const prevU = addr - HDR - FTR - ps;
    if (ps && m.read32(prevU - 4) === MAGIC_FREE) { this.unlink(prevU, classIndex(ps)); size += ps + FTR + HDR; addr = prevU; }
    this.setFree(addr, size);
    return true;
  }

  /** user size of a used block, -1 if not a live block */
  size(addr) {
    addr >>>= 0;
    if (!this.inHeap(addr) || this.mem.read32(addr - 4) !== MAGIC_USED) return -1;
    return this.mem.read32(addr - 8);
  }

  realloc(addr, size, zero = false, inPlaceOnly = false) {
    const m = this.mem;
    if (!addr) return inPlaceOnly ? 0 : this.alloc(size, zero);
    const old = this.size(addr);
    if (old < 0) return 0;
    size = Math.max(MIN_USER, alignUp(size >>> 0, 8));
    if (size <= old) return addr; // shrinking keeps the block (its size stays valid for HeapSize)
    // grow into a following free block when possible
    const nextU = addr + old + FTR + HDR;
    if (m.read32(nextU - 4) === MAGIC_FREE) {
      const ns = m.read32(nextU - 8);
      const avail = old + FTR + HDR + ns;
      if (avail >= size) {
        this.unlink(nextU, classIndex(ns));
        const rem = avail - size;
        if (rem >= SPLIT_MIN) { m.write32(addr - 8, size); m.write32(addr + size, size); this.setFree(addr + size + FTR + HDR, rem - FTR - HDR); }
        else { m.write32(addr - 8, avail); m.write32(addr + avail, avail); }
        if (zero) m.fill(addr + old, m.read32(addr - 8) - old, 0);
        return addr;
      }
    }
    if (inPlaceOnly) return 0;
    const n = this.alloc(size, false);
    if (!n) return 0;
    m.copy(n, addr, old);
    if (zero) m.fill(n + old, size - old, 0);
    this.free_(addr);
    return n;
  }

  inHeap(addr) {
    for (const c of this.chunks) if (addr >= c.base + 16 + HDR && addr < c.base + c.size - 8) return true;
    return false;
  }
  validate(addr) { return addr === 0 || this.size(addr) >= 0; }

  /** Walk all blocks: callback(userAddr, size, used) */
  walk(fn) {
    const m = this.mem;
    for (const c of this.chunks) {
      let u = c.base + 16 + HDR;
      const end = c.base + c.size - 8;
      while (u < end) { const s = m.read32(u - 8), magic = m.read32(u - 4); if (magic !== MAGIC_USED && magic !== MAGIC_FREE) break; fn(u, s, magic === MAGIC_USED); u = u + s + FTR + HDR; }
    }
  }

  destroy() {
    for (const c of this.chunks) this.vmem.release(c.base);
    this.chunks = [];
    this.heads.fill(0);
  }
}
