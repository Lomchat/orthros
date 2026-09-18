// Virtual address space bookkeeping (the guest memory itself is always present, see D002).
// Tracks reservations/commits at page granularity so VirtualAlloc/VirtualFree/VirtualQuery
// and the loader/heaps/stacks can share the 2 GB space without overlapping.
import { JIT_HASH_BASE } from '../cpu/memory.js';
import { PAGE_SIZE, THUNK_BASE, PRIVATE_BASE } from '../cpu/memory.js';

export const PAGE_NOACCESS = 0x01, PAGE_READONLY = 0x02, PAGE_READWRITE = 0x04, PAGE_WRITECOPY = 0x08;
export const PAGE_EXECUTE = 0x10, PAGE_EXECUTE_READ = 0x20, PAGE_EXECUTE_READWRITE = 0x40, PAGE_GUARD = 0x100;
export const MEM_COMMIT = 0x1000, MEM_RESERVE = 0x2000, MEM_DECOMMIT = 0x4000, MEM_RELEASE = 0x8000;
export const MEM_FREE = 0x10000, MEM_PRIVATE = 0x20000, MEM_MAPPED = 0x40000, MEM_IMAGE = 0x1000000, MEM_TOP_DOWN = 0x100000;

const GRANULARITY = 0x10000;
const STATE_FREE = 0, STATE_RESERVED = 1, STATE_COMMITTED = 2;

export class VMem {
  /** @param {number} [top] end of the usable address space */
  constructor(top = JIT_HASH_BASE) {
    this.top = top;
    this.pages = top / PAGE_SIZE;
    /** page state */
    this.state = new Uint8Array(this.pages);
    /** page protection */
    this.prot = new Uint8Array(this.pages);
    /** reservations: base -> { size, tag } */
    this.regions = new Map();
    /** page -> reservation base (only for reserved/committed pages), stored as page index of base */
    this.owner = new Int32Array(this.pages).fill(-1);
    // Never hand out the null page area.
    this.reserve(0x10000, 0, 'null-page');
    this.lowest = 0x10000;
  }

  pageOf(a) { return (a >>> 0) / PAGE_SIZE | 0; }

  /** Is [base, base+size) entirely free? */
  isFree(base, size) {
    base >>>= 0;
    if (base + size > this.top || base % PAGE_SIZE) return false;
    const p0 = this.pageOf(base), p1 = this.pageOf(base + size - 1);
    for (let p = p0; p <= p1; p++) if (this.state[p] !== STATE_FREE) return false;
    return true;
  }

  /**
   * Reserve `size` bytes at `preferred` (64 KB aligned) or anywhere. Returns base or 0.
   * @param {number} size
   * @param {number} [preferred]
   * @param {string} [tag]
   * @param {{ topDown?: boolean, minAddr?: number }} [opts]
   */
  reserve(size, preferred = 0, tag = '', opts = {}) {
    size = alignUp(size, PAGE_SIZE);
    let base = 0;
    if (preferred) {
      const b = preferred & ~(GRANULARITY - 1);
      const end = alignUp(preferred + size, PAGE_SIZE);
      if (this.isFree(b, end - b)) { base = b; size = end - b; }
    }
    if (!base) base = this.findFree(size, opts.topDown, opts.minAddr ?? this.lowest);
    if (!base) return 0;
    const p0 = this.pageOf(base), n = size / PAGE_SIZE;
    for (let p = p0; p < p0 + n; p++) { this.state[p] = STATE_RESERVED; this.prot[p] = PAGE_NOACCESS; this.owner[p] = p0; }
    this.regions.set(base, { size, tag });
    return base;
  }

  findFree(size, topDown, minAddr) {
    const n = size / PAGE_SIZE;
    const step = GRANULARITY / PAGE_SIZE;
    if (!topDown) {
      for (let p = alignUp(minAddr, GRANULARITY) / PAGE_SIZE; p + n <= this.pages; p += step) {
        let ok = true;
        for (let k = 0; k < n; k++) if (this.state[p + k] !== STATE_FREE) { ok = false; p += (k / step | 0) * step; break; }
        if (ok) return p * PAGE_SIZE;
      }
    } else {
      for (let p = ((this.pages - n) / step | 0) * step; p >= minAddr / PAGE_SIZE; p -= step) {
        let ok = true;
        for (let k = 0; k < n; k++) if (this.state[p + k] !== STATE_FREE) { ok = false; break; }
        if (ok) return p * PAGE_SIZE;
      }
    }
    return 0;
  }

  /** Commit pages inside a reservation (or reserve+commit if free). Returns base or 0. */
  commit(base, size, prot = PAGE_READWRITE) {
    base >>>= 0;
    const b = base & ~(PAGE_SIZE - 1);
    const end = alignUp(base + size, PAGE_SIZE);
    const p0 = this.pageOf(b), p1 = this.pageOf(end - 1);
    // all pages must be reserved/committed within one region, or all free
    const owner = this.owner[p0];
    for (let p = p0; p <= p1; p++) {
      if (this.state[p] === STATE_FREE) return 0;
      if (this.owner[p] !== owner) return 0;
    }
    for (let p = p0; p <= p1; p++) { this.state[p] = STATE_COMMITTED; this.prot[p] = prot; }
    return b;
  }

  /** Reserve and commit in one go (VirtualAlloc(MEM_RESERVE|MEM_COMMIT) / internal allocations). */
  alloc(size, prot = PAGE_READWRITE, tag = '', preferred = 0, opts = {}) {
    const base = this.reserve(size, preferred, tag, opts);
    if (!base) return 0;
    this.commit(base, size, prot);
    return base;
  }

  decommit(base, size) {
    base >>>= 0;
    const b = base & ~(PAGE_SIZE - 1);
    const end = size ? alignUp(base + size, PAGE_SIZE) : b + (this.regions.get(this.owner[this.pageOf(b)] * PAGE_SIZE)?.size ?? 0);
    for (let p = this.pageOf(b); p < this.pageOf(end); p++) if (this.state[p] === STATE_COMMITTED) { this.state[p] = STATE_RESERVED; this.prot[p] = PAGE_NOACCESS; }
    return true;
  }

  /** Release a whole reservation (base must be the reservation base). */
  release(base) {
    base >>>= 0;
    const r = this.regions.get(base);
    if (!r) return false;
    const p0 = this.pageOf(base), n = r.size / PAGE_SIZE;
    for (let p = p0; p < p0 + n; p++) { this.state[p] = STATE_FREE; this.prot[p] = 0; this.owner[p] = -1; }
    this.regions.delete(base);
    return true;
  }

  protect(base, size, prot) {
    base >>>= 0;
    const b = base & ~(PAGE_SIZE - 1);
    const end = alignUp(base + size, PAGE_SIZE);
    let old = this.prot[this.pageOf(b)];
    for (let p = this.pageOf(b); p < this.pageOf(end); p++) { if (this.state[p] === STATE_FREE) return -1; this.prot[p] = prot; }
    return old;
  }

  /** VirtualQuery-like info for the run of pages with the same state/protection starting at addr. */
  query(addr) {
    addr >>>= 0;
    if (addr >= this.top) return { base: addr & ~(PAGE_SIZE - 1), allocBase: 0, size: 0, state: MEM_FREE, protect: PAGE_NOACCESS, type: 0 };
    const p0 = this.pageOf(addr);
    const st = this.state[p0], pr = this.prot[p0], ow = this.owner[p0];
    let p1 = p0;
    while (p1 + 1 < this.pages && this.state[p1 + 1] === st && this.prot[p1 + 1] === pr && this.owner[p1 + 1] === ow) p1++;
    const region = ow >= 0 ? this.regions.get(ow * PAGE_SIZE) : null;
    return {
      base: p0 * PAGE_SIZE,
      allocBase: ow >= 0 ? ow * PAGE_SIZE : 0,
      size: (p1 - p0 + 1) * PAGE_SIZE,
      state: st === STATE_FREE ? MEM_FREE : st === STATE_RESERVED ? MEM_RESERVE : MEM_COMMIT,
      protect: st === STATE_FREE ? PAGE_NOACCESS : pr,
      allocProtect: st === STATE_FREE ? 0 : PAGE_READWRITE,
      type: st === STATE_FREE ? 0 : region && region.tag.startsWith('image:') ? MEM_IMAGE : MEM_PRIVATE,
    };
  }

  isCommitted(addr, size = 1) {
    const p0 = this.pageOf(addr), p1 = this.pageOf(addr + size - 1);
    if (p1 >= this.pages) return false;
    for (let p = p0; p <= p1; p++) if (this.state[p] !== STATE_COMMITTED) return false;
    return true;
  }
}

export function alignUp(v, a) { return (v + a - 1) & ~(a - 1); }
export { PRIVATE_BASE };
