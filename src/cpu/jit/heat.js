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
  /**
   * Fold the added ranges into lo/hi: the k new ranges are sorted by start (a native numeric sort of packed keys), then
   * merged in one linear pass with the sorted, coalesced lo/hi, coalescing overlapping or adjacent ranges —
   * O(n + k log k), the same lo/hi as sorting everything.
   */
  merge() {
    const k = this.addLo.length;
    if (!k) return;
    const aLo = this.addLo, aHi = this.addHi;
    // (key: start * 2^22 + index, exact below 2^53 — addresses < 2 GB, fewer than 4 M ranges per merge)
    const order = new Int32Array(k);
    if (k < SORT_PACK) {
      const keys = new Float64Array(k);
      for (let i = 0; i < k; i++) keys[i] = (aLo[i] | 0) * SORT_PACK + i;
      keys.sort();
      for (let i = 0; i < k; i++) { const x = keys[i]; order[i] = x - Math.floor(x / SORT_PACK) * SORT_PACK; }
    } else {
      for (let i = 0; i < k; i++) order[i] = i;
      order.sort((a, b) => (aLo[a] | 0) - (aLo[b] | 0));
    }
    const oLo = this.lo, oHi = this.hi, n = oLo.length;
    const lo = new Int32Array(n + k), hi = new Int32Array(n + k);
    let m = 0, i = 0, j = 0;
    const bulk = k * 32 < n; // (few new ranges: long runs between them)
    while (i < n || j < k) {
      // (a long run of old ranges before the next new one, the first not touching the last range out: copied as is — old
      // ranges neither overlap nor touch)
      if (bulk && i < n && (!m || oLo[i] > hi[m - 1])) {
        let p = n;
        if (j < k) { const x = aLo[order[j]] | 0; let l = i, h = n; while (l < h) { const c = (l + h) >> 1; if (oLo[c] <= x) l = c + 1; else h = c; } p = l; }
        if (p - i > 8) { lo.set(oLo.subarray(i, p), m); hi.set(oHi.subarray(i, p), m); m += p - i; i = p; continue; }
      }
      let L, H;
      if (j >= k || (i < n && oLo[i] <= (aLo[order[j]] | 0))) { L = oLo[i]; H = oHi[i]; i++; } else { const x = order[j++]; L = aLo[x] | 0; H = aHi[x] | 0; }
      if (m && L <= hi[m - 1]) { if (H > hi[m - 1]) hi[m - 1] = H; } else { lo[m] = L; hi[m] = H; m++; }
    }
    this.lo = m === n + k ? lo : lo.slice(0, m); this.hi = m === n + k ? hi : hi.slice(0, m);
    this.addLo = []; this.addHi = [];
    this.size = m;
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
/** (merge: sort keys pack a start and an index below 2^53) */
const SORT_PACK = 1 << 22;
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
