// Hot-code footprint experiment (measurement, off by default; docs/jit-code-shape.md "Hot-code footprint").
//
// In play the translated code that runs is far larger than the instruction caches (the study of 2026-11-12: ~100 KB of
// hot x86 as 15-30 MB of machine code over ~1 500 regions). This module tries to shrink and pack it, with no new kind of
// transition (tier 2 showed that WASM calls between functions cost more than they save):
// - a profile window (`hotProfile`) counts executions by block address, as tier 2's does (translate.js CountSlots: every
//   region translated again with counters), for `hotWindow` guest instructions;
// - at its end every region is translated again (in every arm: the control does the same work) and, with
//   - `hotOnly`: the regions are shaped by the window's counts instead of the learned heat — a branch successor that did
//     not run in the window (code of the loading screens, the menus, or simply not taken in play) is left out of the
//     region (translate.js discoverRegion's cold exits): it exits to the ordinary tier, which translates it at a miss;
//     `hotRatio: n` also leaves out a successor that ran n times less than its branch;
//   - `hotOwn: n` (Jit.hotBounds): a block that ran at least n times and that a live region holds already is a boundary
//     of the next translations — one copy of each hot block, the others chain to it; `hotOwnCalls: n`: direct call
//     targets only;
//   - `hotHints`: guest conditional branches whose one side ran at least `hotHintRatio` times more than the other in the
//     heat (counts, or learned ranges: one side never ran) are hinted, so that TurboFan places the rare side after the
//     function's hot code (deferred blocks): hot code contiguous within each region;
//   - `hotLayout`: the regions that ran in the window are translated again at once, hottest first, into a few modules
//     of `hotLayoutChunk` regions compiled in that order (each called once, as the background translator's bgCompile
//     does): the hot regions' machine code contiguous, in a few code spaces, instead of scattered over modules of 128
//     regions in translation order.
// Any heat, boundary and order are exact (only the regions' extent and the code's placement change). Measured on RotWK
// and AotR play: no-go (the footprint falls only with the copies, and the transitions that replace them cost more).
import { decode } from '../decoder.js';
import { CountSlots, JIT_DEFAULTS } from './translate.js';

export class HotWindow {
  /**
   * @param {import('./jit.js').Jit} jit
   * @param {{ window?: number }} [o] the profile window in guest instructions
   */
  constructor(jit, o = {}) {
    this.jit = jit;
    this.state = 'profile';
    this.window = o.window ?? 2e9;
    this.counted = 0;
    this.countSlots = new CountSlots();
  }
  /** guest instructions run (Jit.run); the window over, the regions are translated again */
  tick(n) {
    if (this.state !== 'profile') return;
    this.counted += n;
    if (this.counted >= this.window) this.finish();
  }

  /** execution counts by instruction address from the window's block counters: { get(a), has(a), size } */
  countsHeat() {
    const jit = this.jit, mem = jit.mem, u32 = mem.u32;
    // (a block start's extent: the longest among the live regions holding it — a shorter copy stops where another
    // block starts, whose own counter covers the rest; the max keeps either)
    const ends = new Map();
    for (const r of jit.regions) for (const b of r.blocks) { const e = ends.get(b.eip); if (e === undefined || b.end > e) ends.set(b.eip, b.end); }
    const counts = new Map();
    for (const [a0, slot] of this.countSlots.map) {
      const n = u32[slot >>> 2]; if (!n) continue;
      const end = ends.get(a0);
      if (end === undefined) { const c = counts.get(a0); if (c === undefined || c < n) counts.set(a0, n); continue; } // (a dropped region's block: its start only)
      for (let a = a0, k = 0; a < end && k < 1000; k++) {
        const c = counts.get(a); if (c === undefined || c < n) counts.set(a, n);
        try { a = decode(mem, a).next; } catch { break; }
      }
    }
    return { get: (a) => counts.get(a), has: (a) => (counts.get(a) ?? 0) > 0, size: counts.size, counts };
  }

  /** the regions that ran in the window, hottest first: [entry, x87 mode, weight] (weight: counted bytes of their blocks) */
  hotRegions(heat) {
    const out = [];
    for (const r of this.jit.regions) {
      if (r.first) continue; // (x87-mode versions: reached through their first version)
      let w = 0;
      for (const b of r.blocks) w += (heat.get(b.eip) ?? 0) * (b.end - b.eip);
      if (w > 0) out.push([r.entry, r.fpc ?? null, w]);
    }
    return out.sort((x, y) => y[2] - x[2]);
  }

  /** the end of the window: every region translated again (counters gone), under the arm's options */
  finish() {
    const jit = this.jit, t0 = performance.now();
    const opt = (k) => jit.abOpts?.[k] ?? jit.opts[k] ?? JIT_DEFAULTS[k];
    const heat = this.countsHeat();
    const hot = this.hotRegions(heat);
    const old = jit.regions.slice(); // (before the switch drops them: the stats below)
    const total = hot.reduce((n, x) => n + x[2], 0);
    const over = { ...(jit.abOpts ?? {}) }; delete over.hotProfile;
    jit.hot = null;
    jit.switchOpts(over, true);
    this.state = 'off';
    if (opt('hotOnly')) jit.hotHeat = heat;
    let layout = null;
    if (opt('hotLayout')) {
      // the regions making `hotLayoutShare` of the counted bytes, hottest first
      const share = opt('hotLayoutShare') ?? 0.99, list = [];
      let acc = 0;
      for (const x of hot) { if (acc >= share * total) break; list.push([x[0], x[1]]); acc += x[2]; }
      layout = jit.translateGroups(list, opt('hotLayoutChunk') ?? 1024);
    }
    // (the regions making 90 % of the counted bytes: their blocks' guest bytes, and the distinct ones — the copies)
    let acc = 0, n90 = 0, bytes90 = 0;
    const uniq = new Map();
    const byEntry = new Map(old.map((r) => [r.entry, r]));
    for (const x of hot) {
      if (acc >= 0.9 * total) break;
      acc += x[2]; n90++;
      for (const b of byEntry.get(x[0])?.blocks ?? []) { bytes90 += b.end - b.eip; uniq.set(b.eip, Math.max(uniq.get(b.eip) ?? 0, b.end - b.eip)); }
    }
    const uniq90 = [...uniq.values()].reduce((n, x) => n + x, 0);
    const st = { counted: this.counted, addresses: heat.size, regionsRan: hot.length, regions90: n90, guestBytes90: bytes90, distinctGuestBytes90: uniq90, hotOnly: !!opt('hotOnly'), hotHints: !!opt('hotHints'), layout, ms: +(performance.now() - t0).toFixed(1) };
    jit.hotStats = st;
    if (globalThis.process?.env?.ORTHROS_HOT_LOG) console.log(`[hot] ${JSON.stringify(st)}`);
  }
}
