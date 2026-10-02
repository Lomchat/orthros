// Block heat for region formation (translate.js discoverRegion, opts.coldExits): which guest code has run. A region
// leaves out a successor of a branch that ran when that successor never did — that edge becomes an exit, so the
// region's blocks are those a run actually goes through (fewer values live across merges and exits, less code, more
// room for hot blocks within the size limits). Any heat is exact: only the regions' extent changes.
//
// Sources: the visit flags of translations (opts.visit: one byte per block not known to have run, set at its entry;
// Jit.harvestVisits), kept across sessions per game by the server (/api/heat/<manifest>, module + offset ranges), and
// for measurements the block counters of profiling translations (Jit.collectHeat, a Map of instruction addresses).

/** Address ranges of code known to have run: get(a) is VISITED for an address inside one, else 0. */
export class RangeHeat {
  constructor() {
    this.lo = new Int32Array(0); this.hi = new Int32Array(0); // (merged, sorted, unsigned order: addresses < 2 GB)
    this.addLo = []; this.addHi = [];
    this.size = 0;
  }
  /** [lo, hi) has run */
  add(lo, hi) { if (hi > lo) { this.addLo.push(lo); this.addHi.push(hi); } }
  /** pairs lo, hi, ... */
  addPairs(pairs) { for (let i = 0; i + 1 < pairs.length; i += 2) this.add(pairs[i], pairs[i + 1]); }
  merge() {
    if (!this.addLo.length) return;
    const n = this.lo.length + this.addLo.length, idx = new Array(n), L = new Float64Array(n), H = new Float64Array(n);
    for (let i = 0; i < this.lo.length; i++) { L[i] = this.lo[i]; H[i] = this.hi[i]; }
    for (let i = 0; i < this.addLo.length; i++) { L[this.lo.length + i] = this.addLo[i]; H[this.lo.length + i] = this.addHi[i]; }
    for (let i = 0; i < n; i++) idx[i] = i;
    idx.sort((a, b) => L[a] - L[b]);
    const lo = [], hi = [];
    for (const i of idx) {
      if (lo.length && L[i] <= hi[hi.length - 1]) { if (H[i] > hi[hi.length - 1]) hi[hi.length - 1] = H[i]; } else { lo.push(L[i]); hi.push(H[i]); }
    }
    this.lo = Int32Array.from(lo); this.hi = Int32Array.from(hi); this.addLo = []; this.addHi = [];
    this.size = lo.length;
  }
  get(a) {
    this.merge();
    const lo = this.lo; let l = 0, h = lo.length - 1, k = -1;
    while (l <= h) { const m = (l + h) >> 1; if (lo[m] <= a) { k = m; l = m + 1; } else h = m - 1; }
    return k >= 0 && a < this.hi[k] ? VISITED : 0;
  }
  has(a) { return this.get(a) !== 0; }
  /** the merged ranges as pairs lo, hi, ... */
  pairs() { this.merge(); const out = new Int32Array(2 * this.lo.length); for (let i = 0; i < this.lo.length; i++) { out[2 * i] = this.lo[i]; out[2 * i + 1] = this.hi[i]; } return out; }
}
/** the count a visited address reports (above any opts.coldMin) */
export const VISITED = 0x7fffffff;

/**
 * Learned heat of a game (per module: offset ranges that ran in earlier sessions), applied to a Jit's heat as the
 * modules are found loaded: `apply(modules)` returns the ranges of the modules ({ name, base, size } each) not applied
 * yet as absolute pairs lo, hi, ... (Jit.heatAdd), or null when nothing was new.
 */
export class LearnedHeat {
  /** @param {Record<string, number[]>} byModule module name (lower case) -> rva, length, rva, length, ... */
  constructor(byModule) { this.byModule = byModule ?? {}; this.applied = new Set(); }
  apply(modules) {
    let out = null;
    for (const m of modules) {
      const name = m.name.toLowerCase();
      if (this.applied.has(name) || !m.base) continue;
      this.applied.add(name);
      const list = this.byModule[name]; if (!Array.isArray(list)) continue;
      out ??= [];
      for (let i = 0; i + 1 < list.length; i += 2) {
        const rva = list[i] >>> 0, len = list[i + 1] >>> 0;
        if (!len || (m.size && rva + len > m.size)) continue;
        out.push(m.base + rva, m.base + rva + len);
      }
    }
    return out;
  }
}
