// Guest memory: a single WebAssembly.Memory identity-mapped onto the 32-bit guest address
// space (guest address == byte offset). See DECISIONS.md D002.
//
// The full 2 GB user-mode space is reserved up front; pages are committed lazily by the OS,
// so this is cheap. Reads of never-written memory return zero (no page-fault emulation in v1).

export const GUEST_SPACE = 0x80000000; // 2 GB user space (0x00000000 - 0x7FFFFFFF)
export const PAGE_SIZE = 0x1000;
export const WASM_PAGE = 0x10000;

// Emulator-private region at the top of user space (never handed to the guest allocator):
//   0x7fc00000  thread CPU states (256 x 0x400)
//   0x7fc40000  mutexes for the JIT's fast paths (runtime.js fastApi, translate.js emitInlineApi): the address of the
//               mutex's state per handle / 4 (0: not a mutex), then at 0x7fc80000 the states (kernel32.js Mutex)
//   0x7fd00000  JIT: next FPU-mode version of each region (4 bytes per table index)
//   0x7fd50000  JIT scratch (fast API table, deferred COM calls, profiling counters)
//   0x7fe00000  self-modifying-code page map (1 byte per 4 KB page of the 2 GB space: nonzero = translated code)
//   0x7ffde000  TEBs (downwards, one page per thread), 0x7ffdf000 PEB, 0x7ffe0000 KUSER_SHARED_DATA
export const PRIVATE_BASE = 0x7fc00000;
export const PRIVATE_END = 0x80000000;
/** handles below MUTEX_HANDLE_END have an entry in MUTEX_HANDLES; MUTEX_STATE_COUNT states of MUTEX_STATE_SIZE bytes */
export const MUTEX_HANDLES = 0x7fc40000, MUTEX_HANDLE_END = 0x40000;
export const MUTEX_STATES = 0x7fc80000, MUTEX_STATE_SIZE = 16, MUTEX_STATE_COUNT = 0x4000;
// EIP -> (function, block) hash table of the JIT: 2^20 entries of 16 bytes just below the thunks
// (the user address space ends at JIT_HASH_BASE)
export const JIT_HASH_BITS = 20;
export const JIT_HASH_BASE = 0x7fb00000 - (16 << JIT_HASH_BITS);
// SMC map: one byte per 4 KB page, tested by translated code after its stores (Emitter.smcCheck): SMC_CODE the page
// holds translated code, SMC_WATCH a write watch (debugging), SMC_NEXT the next page holds translated code (a store
// ending past the last byte of this page writes it: found without a second lookup on the store's hot path)
export const SMC_MAP_BASE = 0x7fe00000;
export const SMC_CODE = 1, SMC_WATCH = 2, SMC_NEXT = 4;
export const JIT_SCRATCH_BASE = 0x7fd50000;
// FPU-mode versions of a region: for each table index, the table index + 1 of the next version of the same region
// (specialized for another x87 mode), 0 for none (see Jit: EXIT_FPUMODE)
export const JIT_ALT_BASE = 0x7fd00000;
export const JIT_ALT_SLOTS = (JIT_SCRATCH_BASE - JIT_ALT_BASE) >> 2;
// Import thunks: each imported symbol gets a slot here; jumping/calling into this region is
// how guest code reaches host (JS) implementations.
export const THUNK_BASE = 0x7fb00000;
export const THUNK_END = 0x7fc00000;
export const THUNK_SIZE = 16;

export class GuestMemory {
  /**
   * @param {{ sizeBytes?: number, shared?: boolean, memory?: WebAssembly.Memory }} [opts]
   */
  constructor(opts = {}) {
    const sizeBytes = opts.sizeBytes ?? GUEST_SPACE;
    const pages = Math.ceil(sizeBytes / WASM_PAGE);
    this.memory =
      opts.memory ??
      new WebAssembly.Memory({ initial: pages, maximum: pages, shared: !!opts.shared });
    this.size = this.memory.buffer.byteLength;
    this.refresh();
  }

  /** Re-create typed views (needed if the memory ever grows). */
  refresh() {
    const b = this.memory.buffer;
    this.buffer = b;
    this.u8 = new Uint8Array(b);
    this.i8 = new Int8Array(b);
    this.dv = new DataView(b);
    this.u32 = new Uint32Array(b);
    this.i32 = new Int32Array(b);
    this.f32 = new Float32Array(b);
    this.f64 = new Float64Array(b);
  }

  // ---- scalar access (little endian, unaligned ok) ----
  /** @param {number} a */ read8(a) { return this.u8[a >>> 0]; }
  /** @param {number} a */ read16(a) { return this.dv.getUint16(a >>> 0, true); }
  /** @param {number} a */ read32(a) { return this.dv.getUint32(a >>> 0, true); }
  /** @param {number} a */ read64(a) { return this.dv.getBigUint64(a >>> 0, true); }
  /** @param {number} a */ readS8(a) { return this.i8[a >>> 0]; }
  /** @param {number} a */ readS16(a) { return this.dv.getInt16(a >>> 0, true); }
  /** @param {number} a */ readS32(a) { return this.dv.getInt32(a >>> 0, true); }
  /** @param {number} a */ readF32(a) { return this.dv.getFloat32(a >>> 0, true); }
  /** @param {number} a */ readF64(a) { return this.dv.getFloat64(a >>> 0, true); }

  /** @param {number} a @param {number} v */ write8(a, v) { this.u8[a >>> 0] = v; }
  /** @param {number} a @param {number} v */ write16(a, v) { this.dv.setUint16(a >>> 0, v, true); }
  /** @param {number} a @param {number} v */ write32(a, v) { this.dv.setUint32(a >>> 0, v >>> 0, true); }
  /** @param {number} a @param {bigint} v */ write64(a, v) { this.dv.setBigUint64(a >>> 0, BigInt.asUintN(64, v), true); }
  /** @param {number} a @param {number} v */ writeF32(a, v) { this.dv.setFloat32(a >>> 0, v, true); }
  /** @param {number} a @param {number} v */ writeF64(a, v) { this.dv.setFloat64(a >>> 0, v, true); }

  // ---- bulk access ----
  /** @param {number} a @param {number} n @returns {Uint8Array} view (not a copy) */
  bytes(a, n) { return this.u8.subarray(a >>> 0, (a >>> 0) + n); }
  /** @param {number} a @param {Uint8Array|ArrayLike<number>} src */
  writeBytes(a, src) { this.u8.set(src, a >>> 0); }
  /** @param {number} a @param {number} n @param {number} [v] */
  fill(a, n, v = 0) { this.u8.fill(v, a >>> 0, (a >>> 0) + n); }
  /** @param {number} dst @param {number} src @param {number} n */
  copy(dst, src, n) { this.u8.copyWithin(dst >>> 0, src >>> 0, (src >>> 0) + n); }

  // ---- strings ----
  /** NUL-terminated ANSI (Latin-1) string. @param {number} a @param {number} [max] */
  readCString(a, max = 0x10000) {
    a >>>= 0;
    let end = a;
    const lim = Math.min(a + max, this.size);
    while (end < lim && this.u8[end] !== 0) end++;
    let s = '';
    for (let i = a; i < end; i++) s += String.fromCharCode(this.u8[i]);
    return s;
  }
  /** Exactly `n` bytes as a Latin-1 string, NULs included (counted-length API arguments). */
  readCStringN(a, n) {
    a >>>= 0; let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.u8[a + i]);
    return s;
  }
  /** Exactly `n` UTF-16 units, NULs included (counted-length API arguments: a count is not a terminator). */
  readWStringN(a, n) {
    a >>>= 0; let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.dv.getUint16(a + 2 * i, true));
    return s;
  }
  /** NUL-terminated UTF-16LE string. @param {number} a @param {number} [max] chars */
  readWString(a, max = 0x10000) {
    a >>>= 0;
    let s = '';
    for (let i = 0; i < max; i++) {
      const c = this.dv.getUint16(a + 2 * i, true);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  /** @param {number} a @param {string} s @param {number} [maxBytes] incl. NUL; returns bytes written incl. NUL */
  writeCString(a, s, maxBytes = Infinity) {
    a >>>= 0;
    const n = Math.min(s.length, maxBytes - 1);
    for (let i = 0; i < n; i++) this.u8[a + i] = s.charCodeAt(i) & 0xff;
    this.u8[a + n] = 0;
    return n + 1;
  }
  /** @param {number} a @param {string} s @param {number} [maxChars] incl. NUL; returns chars written incl. NUL */
  writeWString(a, s, maxChars = Infinity) {
    a >>>= 0;
    const n = Math.min(s.length, maxChars - 1);
    for (let i = 0; i < n; i++) this.dv.setUint16(a + 2 * i, s.charCodeAt(i), true);
    this.dv.setUint16(a + 2 * n, 0, true);
    return n + 1;
  }
}
