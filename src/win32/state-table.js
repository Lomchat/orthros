// Device state words (render / texture stage / sampler states) by small integer key: the Map interface the
// Direct3D devices and the WebGL backend use (get, set, has, iteration in first-set order, keys, size) over a
// plain array, as a draw reads dozens of them. Keys outside [0, capacity) (never set by well-formed code) go to a
// Map so that a stray value does not turn the array into a dictionary.
export class StateTable {
  /** @param {number} capacity @param {Iterable<[number, number]>} [init] */
  constructor(capacity, init) {
    this.v = new Array(capacity).fill(undefined);
    this.order = [];
    this.extra = null;
    /** a recorder told of every set (render worker: the device's state changes, see gfx/d3d-recorder.js), or null */
    this.rec = null;
    /** moves at every set (a consumer caching what it derived from the table compares it, with the table's identity) */
    this.ver = 0;
    /** shadow entries in guest memory (runtime.js DEFER_F_*): u32 view, word index of key 0, number of keys */
    this.sh = null; this.shBase = 0; this.shN = 0;
    /**
     * watched key groups (watchKeys): per key in [0, capacity) a bit per group, and per group a counter moving at every
     * set of one of its keys — a consumer deriving something from a few keys compares that counter instead of `ver`
     */
    this.watch = null; this.wv = null;
    if (init) for (const [k, x] of init) this.set(k, x);
  }
  /** Watch `keys` as group `g` (0..7): `wv[g]` moves at every set of one of them from now on. */
  watchKeys(g, keys) {
    this.watch ??= new Uint8Array(this.v.length); this.wv ??= new Uint32Array(8);
    for (const k of keys) if (k >= 0 && k < this.v.length) this.watch[k] |= 1 << g;
  }
  /**
   * Mirror keys [0, n) into guest memory from `addr` as (known, value) word pairs — the issued-state filter of the
   * JIT's fast path reads them: every change made here is written there (a value that is not a 32-bit word: unknown).
   */
  attachShadow(u32, addr, n) {
    this.sh = u32; this.shBase = addr >>> 2; this.shN = n;
    for (let k = 0; k < n; k++) this.writeShadow(k, this.get(k));
  }
  writeShadow(k, x) {
    const i = this.shBase + 2 * k;
    if (x !== undefined && x === x >>> 0) { this.sh[i] = 1; this.sh[i + 1] = x; } else this.sh[i] = 0;
  }
  get(k) { return k >= 0 && k < this.v.length ? this.v[k] : this.extra?.get(k); }
  has(k) { return this.get(k) !== undefined; }
  set(k, x) {
    this.ver++;
    if (k >= 0 && k < this.v.length) { if (this.v[k] === undefined) this.order.push(k); this.v[k] = x; }
    else { if (!(this.extra ??= new Map()).has(k)) this.order.push(k); this.extra.set(k, x); }
    if (this.rec !== null) this.rec.noteSet(this, k);
    if (this.watch !== null && k >= 0 && k < this.watch.length) { const b = this.watch[k]; if (b !== 0) for (let g = 0; g < 8; g++) if (b & (1 << g)) this.wv[g]++; }
    if (this.sh && k >= 0 && k < this.shN) this.writeShadow(k, x);
    return this;
  }
  get size() { return this.order.length; }
  keys() { return this.order.values(); }
  *entries() { for (const k of this.order) yield [k, this.get(k)]; }
  [Symbol.iterator]() { return this.entries(); }
}
