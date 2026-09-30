// Win32 heaps (HeapCreate/HeapAlloc...): segregated free lists with boundary tags, entirely in
// guest memory (no host object per block: games allocate millions of blocks). Block layout:
//   [u32 user size][u32 magic] user area (8-aligned) [u32 user size (footer)]
// Free blocks keep a doubly linked list in their user area (next, prev) per size class; chunks
// obtained from VMem start and end with used sentinel blocks so coalescing stops at their edges.
import { PAGE_READWRITE, alignUp } from './vmem.js';

// (FTR: the footer's 4 bytes and 4 of padding — header and footer together 16 bytes, so every user address stays
// 8-aligned, as HeapAlloc's are on Windows; with a 4-byte footer every other block was only 4-aligned)
const HDR = 8, FTR = 8;
const MAGIC_USED = 0x4f524855; // 'UHRO'
const MAGIC_FREE = 0x46524855;
const MIN_CHUNK = 0x100000; // 1 MB growth
const MIN_USER = 16, SPLIT_MIN = HDR + FTR + MIN_USER;
const CLASSES = 128;
/** a free-list link that can be followed: 0 (end) or an address of the user space (cheap: no chunk search per step) */
const plausible = (p) => p === 0 || (p >= 0x10000 && p < 0x7eb00000 && (p & 7) === 0);

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
    this.stats = {}; // (brokenLists: free lists cut at a block that was not one, see alloc)
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
    // start sentinel: a used block with an empty user area (its footer, 0, stops backward merges); the first real
    // block's user address is base + 24: 8-aligned
    m.write32(base, 0); m.write32(base + 4, MAGIC_USED); m.write32(base + 8, 0);
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
    const m = this.mem;
    let next = m.read32(b), prev = m.read32(b + 4);
    // (links overwritten by a program using a freed block: dropped rather than followed out of the address space)
    if (!plausible(next)) next = 0;
    if (!plausible(prev)) prev = 0;
    if (prev) m.write32(prev, next); else if (this.heads[c] === b) this.heads[c] = next;
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
        let b = this.heads[c], prev = 0;
        while (b) {
          const bs = m.read32(b - 8);
          // (a free block is used only if it is one: inside this heap, marked free, header and footer agreeing — a link
          // the program overwrote after freeing a block can point anywhere, even into another heap or a thread's
          // stack, with any size: the rest of that list is dropped (leaked) rather than handed out)
          if (!this.freeBlockOk(b, bs)) { if (prev) m.write32(prev, 0); else this.heads[c] = 0; this.stats.brokenLists = (this.stats.brokenLists ?? 0) + 1; break; }
          if (bs >= size) {
            this.unlink(b, c);
            const rem = bs - size;
            if (rem >= SPLIT_MIN) {
              m.write32(b - 8, size); m.write32(b + size, size);
              this.setFree(b + size + FTR + HDR, rem - FTR - HDR);
            }
            m.write32(b - 4, MAGIC_USED);
            if (zero) m.fill(b, m.read32(b - 8), 0);
            if (globalThis.ORTHROS_HEAP_WATCH && (b >>> 0) === (globalThis.ORTHROS_HEAP_WATCH >>> 0)) this.watchLog?.(`heap ${this.tag}: alloc(${size}) -> ${b.toString(16)} from free block of ${bs} in class ${c} (chunk ${JSON.stringify(this.chunkOf(b))})`);
            return b;
          }
          prev = b; b = m.read32(b);
          if (!plausible(b)) break; // (a list overwritten by the program: its rest ignored)
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
    const ch = this.chunkOf(addr);
    if (!ch || m.read32(addr - 4) !== MAGIC_USED) return false;
    let size = m.read32(addr - 8);
    const lo = ch.base + 8, hi = ch.base + ch.size; // (user addresses of the chunk's two sentinels)
    if (addr + size + FTR + HDR > hi) return false; // (a header overwritten by the program)
    m.write32(addr - 4, MAGIC_FREE);
    // Neighbours are merged only when their boundary tags agree (header size = footer size, inside the chunk): a
    // program writing a few bytes past its block overwrites the footer, which Windows' heap would not notice either.
    // coalesce forward
    const nextU = addr + size + FTR + HDR;
    if (nextU < hi && m.read32(nextU - 4) === MAGIC_FREE) {
      const ns = m.read32(nextU - 8);
      if (nextU + ns + FTR <= hi - 8 && m.read32(nextU + ns) === ns) { this.unlink(nextU, classIndex(ns)); size += FTR + HDR + ns; }
    }
    // coalesce backward
    const ps = m.read32(addr - HDR - FTR);
    const prevU = addr - HDR - FTR - ps;
    if (ps && prevU > lo && m.read32(prevU - 4) === MAGIC_FREE && m.read32(prevU - 8) === ps) { this.unlink(prevU, classIndex(ps)); size += ps + FTR + HDR; addr = prevU; }
    this.setFree(addr, size);
    return true;
  }

  /** whether user address `b` with header size `bs` is a free block of this heap (see alloc) */
  freeBlockOk(b, bs) {
    const m = this.mem, ch = this.chunkOf(b);
    return !!ch && m.read32(b - 4) === MAGIC_FREE && bs >= MIN_USER && (bs & 7) === 0 && b + bs + FTR + HDR <= ch.base + ch.size && m.read32(b + bs) === bs;
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
    if (m.read32(nextU - 4) === MAGIC_FREE && this.freeBlockOk(nextU, m.read32(nextU - 8))) {
      const ns = m.read32(nextU - 8);
      const avail = old + FTR + HDR + ns;
      if (avail >= size) {
        this.unlink(nextU, classIndex(ns));
        const rem = avail - size;
        if (rem >= SPLIT_MIN) { m.write32(addr - 8, size); m.write32(addr + size, size); this.setFree(addr + size + FTR + HDR, rem - FTR - HDR); }
        else { m.write32(addr - 8, avail); m.write32(addr + avail, avail); }
        if (zero) m.fill(addr + old, m.read32(addr - 8) - old, 0);
        if (globalThis.ORTHROS_HEAP_WATCH && (addr >>> 0) === (globalThis.ORTHROS_HEAP_WATCH >>> 0)) this.watchLog?.(`heap ${this.tag}: realloc in place ${addr.toString(16)} ${old} -> ${size} with next free ${nextU.toString(16)} of ${ns} (chunk ${JSON.stringify(this.chunkOf(addr))})`);
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

  inHeap(addr) { return this.chunkOf(addr) !== null; }
  /** the chunk holding user address `addr` (between its sentinels), or null */
  chunkOf(addr) {
    for (const c of this.chunks) if (addr >= c.base + 16 + HDR && addr < c.base + c.size - 8) return c;
    return null;
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
    this.stats = {}; // (brokenLists: free lists cut at a block that was not one, see alloc)
    this.heads.fill(0);
  }
}
