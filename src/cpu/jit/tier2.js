// Tier 2 (prototype, off by default: ORTHROS_JIT_AB={"tier2":true}): the hot core of the guest's code translated once,
// by guest function, into one WebAssembly module whose functions call each other with WASM calls.
//
// Tier 1 (translate.js regions) copies a hot block into every region reaching it (~3 copies) and leaves a region at
// every call and return that is not inline (a chained tail call moving 16 values, ~23 ns per call/return pair). Here:
// - a profile window counts executions by block address (CountSlots, every region translated again with counters);
// - the blocks making `share` of the counted guest instructions (weighted by their instructions) are the hot set;
// - function entries are found automatically: the targets of the hot code's direct calls, and every `call rel32` target
//   and aligned dword of the loaded images (code and data: vtables, import slots) that is a hot block; a hot block no
//   entry reaches becomes an entry itself. No per-game data: any partition is exact (see below), only its speed varies;
// - each function is the region translator's code (the same instruction emitters) for its hot blocks only; a guest
//   CALL to another tier-2 function — direct, or through an import slot holding it — is a WASM `call` passing the
//   registers, lazy flags and budget and getting them back (with tV / t2: how the callee left); a jump to one (tail
//   calls, import stubs) a WASM `return_call`; a RET returns to the WASM caller, which goes on at its return site when
//   the address is that site, else leaves as the callee did (a RET elsewhere — SEH, longjmp, a replaced return
//   address — is a jump there). Cold blocks, indirect transfers, faults, APIs, the budget: every exit unwinds the WASM
//   calls (each caller passes the callee's exit up) to the function's region-signature entry, which leaves as a region
//   does (chained); the dispatcher then resumes in tier 1. Every block of a function is enterable from the dispatcher
//   and chains (hash entries), x87 functions too (specialized for the x87 mode of their tier-1 region: entered under
//   another mode, EXIT_T2MODE at their entry hands their hash entries back to tier 1);
// - tier-1 regions translated afterwards stop at tier-2 blocks (discoverRegion boundaries) and chain into them.
// Code written over (SMC) on a page holding tier-2 code drops all of tier 2 (tier 1 takes over).
import { decode, OP, OT } from '../decoder.js';
import { CountSlots, discoverRegion, translateT2, emitT2Entry, buildT2Module, T2_FIRST_FUNC } from './translate.js';
import { SMC_MAP_BASE, SMC_CODE, SMC_NEXT } from '../memory.js';

/** nested tier-2 calls at most (the WASM stack), deeper calls leave to tier 1 */
const MAX_DEPTH = 48;
/** blocks of one function at most (TurboFan's compile time is superlinear); the rest becomes other functions */
const MAX_FN_BLOCKS = 300;
/** blocks of tier 2 at most (the functions chosen, then their callees) */
const MAX_T2_BLOCKS = 6000;

export class Tier2 {
  /**
   * @param {import('./jit.js').Jit} jit
   * @param {{ window?: number, share?: number }} [o] the profile window in guest instructions, the share of the counted
   *   instructions the hot set covers
   */
  constructor(jit, o = {}) {
    this.jit = jit;
    this.state = 'profile';
    this.window = o.window ?? 1e9; this.share = o.share ?? 0.5;
    this.counted = 0;
    this.countSlots = new CountSlots();
    this.blocks = new Map(); // block eip -> { fnIdx, block }: tier 2's hash entries
    this.bounds = null; // (tier-1 discovery stops at those blocks)
    this.pages = new Set();
    this.marker = { t2: this }; // (in jit.pageRegions: a store into tier-2 code drops tier 2, see Jit.invalidate)
    this.fnIdxs = [];
    this.fnOf = new Map(); // function entry -> { fnIdx, blocks }
    this.stats = null;
  }
  /** guest instructions run (Jit.run); the window over, the tier is built */
  tick(n) {
    if (this.state !== 'profile') return;
    this.counted += n;
    if (this.counted >= this.window) this.finish();
  }

  /** the end of the profile window: the hot set selected, tier 1 translated again without counters, tier 2 installed */
  finish() {
    const jit = this.jit, build = !!jit.tier2Opt();
    const t0 = performance.now();
    let plan = null;
    // (the selection made in the control arm too: the same work, its figures reported)
    try { plan = this.select(); } catch (e) { jit.opts.warn?.(`tier 2: selection failed: ${e.message}`); }
    const t1 = performance.now();
    const report = (st) => { jit.t2Stats = st; if (globalThis.process?.env?.ORTHROS_TIER2_LOG) console.log(`[tier2] ${JSON.stringify(st)}`); };
    // tier 1 starts over (the counters gone) in both arms, so that the control compares the same work
    const over = { ...(jit.abOpts ?? {}) }; delete over.tier2Profile;
    jit.t2 = null;
    jit.switchOpts(over, true);
    this.state = 'off';
    const sel = plan ? { hotBlocks: plan.hot, warmBlocks: plan.warm, cover: +plan.cover.toFixed(3), functions: plan.fns.length, entriesFromCalls: plan.entriesFromCalls, entriesFromImages: plan.entriesFromImages, orphans: plan.orphans, countedInsns: plan.counted, selectMs: +(t1 - t0).toFixed(1) } : null;
    if (!plan || !build) { report({ built: false, ...sel }); return; }
    jit.t2 = this;
    try { this.install(plan); } catch (e) { jit.opts.warn?.(`tier 2: build failed: ${e.message}`); this.discard(); jit.t2 = null; }
    report({ ...sel, ...(this.stats ?? { built: false }) });
  }

  /** the hot set, its functions and their translations ({ fns, cover }) */
  select() {
    const jit = this.jit, mem = jit.mem, u8 = mem.u8, u32 = mem.u32;
    const cache = new Map();
    const dec = (a) => { let i = cache.get(a); if (!i) { i = decode(mem, a); cache.set(a, i); } return i; };
    // block starts of the live regions (the shortest extent from each)
    const ends = new Map();
    for (const r of jit.regions) for (const b of r.blocks) { const e = ends.get(b.eip); if (e === undefined || b.end < e) ends.set(b.eip, b.end); }
    const starts = [...ends.keys()].sort((x, y) => x - y);
    const items = [], weight = new Map();
    let total = 0;
    for (let i = 0; i < starts.length; i++) {
      const a0 = starts[i], slot = this.countSlots.map.get(a0);
      const n = slot === undefined ? 0 : u32[slot >>> 2];
      if (!n) continue;
      const end = Math.min(ends.get(a0), i + 1 < starts.length ? starts[i + 1] : Infinity);
      let k = 0;
      for (let a = a0; a < end; k++) { try { a = dec(a).next; } catch { break; } }
      const w = n * k;
      items.push([a0, w]); weight.set(a0, w); total += w;
    }
    items.sort((x, y) => y[1] - x[1]);
    // the hot seeds: the blocks making `share` of the counted instructions; the functions are made of every block that
    // ran in the window (a block cut out of a function for being only warm would be an exit taken often)
    const warm = new Set(weight.keys()), seeds = new Set();
    let acc = 0;
    for (const [a, w] of items) { if (acc >= this.share * total) break; seeds.add(a); acc += w; }
    // entries: the direct call targets of the code that ran, then the images' call rel32 targets and dwords
    const entries = new Set();
    let fromCalls = 0, fromImages = 0;
    for (const a0 of warm) {
      for (let a = a0, n = 0; n < 200; n++) {
        let insn; try { insn = dec(a); } catch { break; }
        if (insn.op === OP.CALL && insn.ops[0].t === OT.REL && warm.has(insn.ops[0].v >>> 0) && !entries.has(insn.ops[0].v >>> 0)) { entries.add(insn.ops[0].v >>> 0); fromCalls++; }
        if (insn.op === OP.JMP || insn.op === OP.JCC || insn.op === OP.CALL || insn.op === OP.RET || insn.op === OP.INVALID) break;
        a = insn.next;
        if (ends.has(a)) break;
      }
    }
    for (const m of jit.opts.images?.() ?? []) {
      const lo = m.base >>> 0, hi = Math.min((m.base + m.size) >>> 0, 0x7fb00000);
      for (let a = lo; a + 5 <= hi; a++) {
        if (u8[a] === 0xe8) {
          const t = (a + 5 + (u8[a + 1] | (u8[a + 2] << 8) | (u8[a + 3] << 16) | (u8[a + 4] << 24))) >>> 0;
          if (warm.has(t) && !entries.has(t)) { entries.add(t); fromImages++; }
        }
      }
      for (let a = (lo + 3) & ~3; a + 4 <= hi; a += 4) { const v = u32[a >>> 2]; if (warm.has(v) && !entries.has(v)) { entries.add(v); fromImages++; } }
    }
    // functions: discovered from each entry within the blocks that ran, stopping at the other entries; the hot seeds no
    // entry reached become entries in turn (hottest first)
    const isEntry = (a) => entries.has(a);
    const onlyFor = (e) => ({ has: (t) => t === e || (warm.has(t) && !isEntry(t)) });
    const fnOpts = (e) => ({ onlyBlocks: onlyFor(e), maxBlocks: MAX_FN_BLOCKS, maxInsns: 20000, inlineApi: jit.opts.inlineApi, jumpTables: jit.abOpts?.jumpTables });
    // (the counted instructions of a block: the starts it covers)
    const lowerBound = (x) => { let l = 0, h = starts.length; while (l < h) { const m = (l + h) >> 1; if (starts[m] < x) l = m + 1; else h = m; } return l; };
    const wOf = (b) => { let w = 0; for (let i = lowerBound(b.eip); i < starts.length && starts[i] < b.end; i++) w += weight.get(starts[i]) ?? 0; return w; };
    const byEntry = new Map(), reached = new Set();
    const add = (e) => {
      if (byEntry.has(e)) return;
      let blocks;
      try { ({ blocks } = discoverRegion(mem, e, fnOpts(e))); } catch { return; }
      if (!blocks.length) return;
      const f = { entry: e, fpc: null, w: blocks.reduce((n, b) => n + wOf(b), 0), blocks: blocks.length, callees: new Set() };
      for (const b of blocks) {
        reached.add(b.eip);
        for (const insn of b.insns) {
          const o = insn.ops[0];
          if ((insn.op === OP.CALL || insn.op === OP.JMP || insn.op === OP.JCC) && o?.t === OT.REL && entries.has(o.v >>> 0)) f.callees.add(o.v >>> 0);
          if ((insn.op === OP.CALL || insn.op === OP.JMP) && o?.t === OT.MEM && o.base < 0 && o.index < 0) { const v = u32[(o.disp >>> 0) >>> 2]; if ((o.disp & 3) === 0 && entries.has(v)) f.callees.add(v); }
        }
      }
      byEntry.set(e, f);
    };
    for (const e of entries) add(e);
    let orphans = 0;
    for (const [a] of items) { if (seeds.has(a) && !reached.has(a)) { entries.add(a); orphans++; add(a); reached.add(a); } }
    // the functions holding the most counted instructions up to `share`, then the functions they call or jump to that ran
    // (a call to a function left out leaves tier 2), up to MAX_T2_BLOCKS blocks
    const all = [...byEntry.values()].sort((x, y) => y.w - x.w);
    const chosen = new Set();
    let cw = 0, nb = 0;
    for (const f of all) { if (cw >= this.share * total || nb >= MAX_T2_BLOCKS) break; chosen.add(f); cw += f.w; nb += f.blocks; }
    const queue = [...chosen];
    while (queue.length && nb < MAX_T2_BLOCKS) {
      const f = queue.shift();
      for (const c of f.callees) { const g = byEntry.get(c); if (g && !chosen.has(g) && g.w > 0) { chosen.add(g); cw += g.w; nb += g.blocks; queue.push(g); } }
    }
    const fns = [...chosen];
    // the x87 mode of each function: its tier-1 region's (x87 functions are specialized for it)
    for (const f of fns) { const k = jit.blockMap.get(f.entry); f.fpc = k ? k.region.fpc ?? null : null; }
    return { fns, onlyFor, fnOpts, cover: cw / Math.max(1, total), hot: seeds.size, warm: warm.size, entriesFromCalls: fromCalls, entriesFromImages: fromImages, orphans, counted: total };
  }

  /** translate the plan's functions into one module and enter them in the tables */
  install(plan) {
    const jit = this.jit, mem = jit.mem;
    const t0 = performance.now();
    let fns = plan.fns, out = null, failed = 0;
    for (let round = 0; round < 4 && !out; round++) {
      const calls = new Map(fns.map((f, i) => [f.entry, T2_FIRST_FUNC + i]));
      const t2 = { calls, depth: 0, maxDepth: MAX_DEPTH };
      const res = [], bad = new Set();
      for (const f of fns) {
        const o = { ...jit.translateOpts(-1, f.fpc), ...plan.fnOpts(f.entry), t2, visit: false, blockCounts: false, countSlots: null, boundaries: null, fnIdx: -1 };
        try { res.push(translateT2(mem, f.entry, o)); } catch (e) { bad.add(f); failed++; jit.opts.log?.(`tier 2: ${f.entry.toString(16)}: ${e.message}`); }
      }
      if (bad.size) { fns = fns.filter((f) => !bad.has(f)); continue; }
      out = res;
    }
    if (!out) throw new Error('translations keep failing');
    const t1 = performance.now();
    if (globalThis.ORTHROS_TIER2_DUMP) out.forEach((r, i) => jit.opts.log?.(`tier 2 fn ${fns[i].entry.toString(16)} x87 ${r.usesX87} blocks ${r.blocks.map((b) => `${b.eip.toString(16)}-${b.end.toString(16)}#${b.index}`).join(' ')}`));
    const names = fns.map((f) => f.entry.toString(16));
    const reg = out.map((r, i) => i); // (every function enterable from tier 1, the x87 ones too: see unhash)
    const entryOpts = jit.translateOpts(-1, null);
    const entryCodes = reg.map((i) => emitT2Entry(mem, T2_FIRST_FUNC + i, 0, entryOpts));
    const bytes = buildT2Module(out.map((r) => r.code), names, entryCodes, reg.map((i) => names[i]), jit.shared);
    const t2 = performance.now();
    const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), jit.imports);
    const t3 = performance.now();
    reg.forEach((i, k) => {
      const fnIdx = jit.reserveFn();
      jit.table.set(fnIdx, inst.exports['e' + k]);
      this.fnIdxs.push(fnIdx);
      for (const b of out[i].blocks) if (!this.blocks.has(b.eip)) { this.blocks.set(b.eip, { fnIdx, block: b.index }); jit.hashInsert(b.eip, fnIdx, b.index); }
      this.fnOf.set(fns[i].entry, { fnIdx, blocks: out[i].blocks.map((b) => b.eip) });
    });
    this.bounds = new Set(this.blocks.keys());
    const u8 = mem.u8;
    for (const r of out) for (const b of r.blocks) for (let p = b.eip >>> 12; p <= (b.end - 1) >>> 12; p++) this.pages.add(p);
    for (const p of this.pages) {
      u8[SMC_MAP_BASE + p] |= SMC_CODE;
      if (p > 0) u8[SMC_MAP_BASE + p - 1] |= SMC_NEXT;
      let s = jit.pageRegions.get(p); if (!s) { s = new Set(); jit.pageRegions.set(p, s); } s.add(this.marker);
    }
    const sum = (k) => out.reduce((n, r) => n + (r.stats[k] ?? 0), 0);
    this.stats = {
      built: true, functions: fns.length, x87Functions: out.filter((r) => r.usesX87).length, failed, blocks: out.reduce((n, r) => n + r.blocks.length, 0), hotBlocks: plan.hot,
      cover: +plan.cover.toFixed(3), entriesFromCalls: plan.entriesFromCalls, entriesFromImages: plan.entriesFromImages, orphans: plan.orphans,
      directCallSites: sum('t2Calls'), tailCallSites: sum('t2Tails'), bytes: bytes.length, translateMs: +(t1 - t0).toFixed(1), compileMs: +(t3 - t2).toFixed(1), pages: this.pages.size,
    };
  }

  /**
   * An x87 function entered under another x87 mode (EXIT_T2MODE at its entry `eip`): its blocks' hash entries go back to
   * tier 1 (translated there for the mode met), so that the dispatcher no longer enters it; WASM calls still do.
   */
  unhash(eip) {
    const jit = this.jit, e0 = this.blocks.get(eip);
    // (`eip`: the function's entry or the block the dispatcher entered it at)
    let entry = -1;
    for (const [k, f] of this.fnOf) if (k === eip || (e0 && f.fnIdx === e0.fnIdx)) { entry = k; break; }
    const f = this.fnOf.get(entry);
    if (!f) return;
    this.fnOf.delete(entry);
    for (const a of f.blocks) {
      const e = this.blocks.get(a); if (!e || e.fnIdx !== f.fnIdx) continue;
      this.blocks.delete(a); this.bounds?.delete(a);
      jit.hashRemove(a); const k = jit.blockMap.get(a); if (k) jit.hashInsert(a, k.region.fnIdx, k.block);
    }
    if (jit.t2Stats) jit.t2Stats.unhashed = (jit.t2Stats.unhashed ?? 0) + 1;
  }
  /** does tier 2 hold the hash entry of `eip`? */
  owns(eip) { return this.blocks.has(eip); }
  /** the hash entry of a tier-2 block, re-inserted (after an eviction); false when not one */
  reinsert(eip) {
    const e = this.blocks.get(eip);
    if (!e) return false;
    this.jit.hashInsert(eip, e.fnIdx, e.block);
    return true;
  }
  /** tables cleared anyway (Jit.clearTables): the functions' table slots freed */
  discard() {
    for (const i of this.fnIdxs) this.jit.table.set(i, null);
    this.fnIdxs = []; this.blocks.clear(); this.pages.clear(); this.bounds = null; this.state = 'off';
  }
  /** code written over on a tier-2 page: all of tier 2 dropped, the tier-1 entries back in the hash table */
  drop() {
    const jit = this.jit, u8 = jit.mem.u8;
    for (const eip of this.blocks.keys()) { jit.hashRemove(eip); const k = jit.blockMap.get(eip); if (k) jit.hashInsert(eip, k.region.fnIdx, k.block); }
    for (const p of this.pages) {
      const s = jit.pageRegions.get(p);
      if (s) { s.delete(this.marker); if (!s.size) { jit.pageRegions.delete(p); u8[SMC_MAP_BASE + p] &= ~SMC_CODE; if (p > 0) u8[SMC_MAP_BASE + p - 1] &= ~SMC_NEXT; } }
    }
    if (jit.t2Stats) jit.t2Stats.dropped = (jit.t2Stats.dropped ?? 0) + 1;
    this.discard();
    jit.t2 = null;
  }
}
