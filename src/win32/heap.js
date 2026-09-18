// Win32 heaps (HeapCreate/HeapAlloc...): a first-fit allocator with coalescing over chunks of
// guest address space obtained from VMem. Block header (8 bytes) precedes each allocation:
//   +0 u32 size of the user area, +4 u32 magic|flags. Free blocks are tracked host-side.
import { PAGE_READWRITE, alignUp } from './vmem.js';

const HDR = 8;
const MAGIC_USED = 0x4f524855; // 'UHRO'
const MAGIC_FREE = 0x46524855;
const MIN_CHUNK = 0x100000; // 1 MB growth

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
    /** free list: array of {addr, size} (user areas including header at addr-HDR) sorted by addr */
    this.free = [];
    /** used blocks addr -> size */
    this.used = new Map();
    this.chunks = [];
    this.grow(Math.max(opts.initial ?? MIN_CHUNK, MIN_CHUNK));
  }

  grow(size) {
    size = alignUp(size, 0x10000);
    const base = this.vmem.alloc(size, PAGE_READWRITE, 'heap:' + this.tag);
    if (!base) return false;
    this.chunks.push({ base, size });
    this.insertFree(base + HDR, size - HDR);
    return true;
  }

  insertFree(addr, size) {
    // keep sorted, coalesce with neighbours
    const f = this.free;
    let lo = 0, hi = f.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (f[m].addr < addr) lo = m + 1; else hi = m; }
    let block = { addr, size };
    // merge with previous
    if (lo > 0) {
      const p = f[lo - 1];
      if (p.addr + p.size + HDR === addr) { p.size += size + HDR; block = p; lo--; f.splice(lo, 1); }
    }
    // merge with next
    if (lo < f.length) {
      const n = f[lo];
      if (block.addr + block.size + HDR === n.addr) { block.size += n.size + HDR; f.splice(lo, 1); }
    }
    f.splice(lo, 0, block);
    this.mem.write32(block.addr - HDR, block.size);
    this.mem.write32(block.addr - 4, MAGIC_FREE);
  }

  /** @returns {number} user pointer or 0 */
  alloc(size, zero = false) {
    size = alignUp(Math.max(size, 1), 8);
    for (let attempt = 0; attempt < 2; attempt++) {
      const f = this.free;
      for (let i = 0; i < f.length; i++) {
        const b = f[i];
        if (b.size < size) continue;
        const remain = b.size - size;
        let addr = b.addr;
        if (remain >= HDR + 16) {
          // split: keep the tail free
          f[i] = { addr: b.addr + size + HDR, size: remain - HDR };
          this.mem.write32(f[i].addr - HDR, f[i].size);
          this.mem.write32(f[i].addr - 4, MAGIC_FREE);
        } else {
          size = b.size;
          f.splice(i, 1);
        }
        this.mem.write32(addr - HDR, size);
        this.mem.write32(addr - 4, MAGIC_USED);
        this.used.set(addr, size);
        if (zero) this.mem.fill(addr, size, 0);
        return addr;
      }
      if (this.max && this.chunks.reduce((a, c) => a + c.size, 0) + size > this.max) return 0;
      if (!this.grow(size + HDR + MIN_CHUNK)) return 0;
    }
    return 0;
  }

  free_(addr) {
    const size = this.used.get(addr);
    if (size === undefined) return false;
    this.used.delete(addr);
    this.insertFree(addr, size);
    return true;
  }

  size(addr) {
    const s = this.used.get(addr);
    return s === undefined ? -1 : s;
  }

  realloc(addr, size, zero = false, inPlaceOnly = false) {
    const old = this.used.get(addr);
    if (old === undefined) return 0;
    size = alignUp(Math.max(size, 1), 8);
    if (size <= old) {
      // shrink: keep block size (simple), no split
      return addr;
    }
    if (inPlaceOnly) return 0;
    const n = this.alloc(size, false);
    if (!n) return 0;
    this.mem.copy(n, addr, old);
    if (zero) this.mem.fill(n + old, size - old, 0);
    this.free_(addr);
    return n;
  }

  validate(addr) { return addr === 0 || this.used.has(addr); }

  destroy() {
    for (const c of this.chunks) this.vmem.release(c.base);
    this.chunks = []; this.free = []; this.used.clear();
  }
}
