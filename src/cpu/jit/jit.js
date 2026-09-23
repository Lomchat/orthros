// JIT executor: translates regions on demand, keeps the funcref table + hash table used by the
// WASM dispatcher, and exposes the same run() interface as the interpreter.
import { EXIT, ST, CpuState } from '../state.js';
import { THUNK_BASE, THUNK_END, THUNK_SIZE, JIT_HASH_BASE, JIT_HASH_BITS, SMC_MAP_BASE } from '../memory.js';
import { buildRuntime, materializeFlags, supportsReturnCall, EXIT_TRANSLATE, EXIT_FPUMODE, EXIT_STEP, HASH_ENTRY, HASH_PROBES, FAST_TABLE, FAST_NAMES, PROC_CONSTS, MATH_KERNELS, FID_DEFER, DEFER_SPEC, DEFER_SPECS } from './runtime.js';
import { translateRegion, buildRegionModule, JIT_PROF, PROF_OPS_BASE } from './translate.js';
import { OP_NAMES } from '../decoder.js';
import './translate-x87.js';
import './translate-sse-float.js';
import './translate-sse-int.js';

const CONSOLIDATE_EVERY = 128;

/** Fold a pending lazy flag operation (left in the state block by JIT'd code) into the thread's EFLAGS. */
function foldLazyFlags(cpu) {
  const m = cpu.mem, b = cpu.base;
  const op = m.read32(b + ST.LZ_OP);
  if (!op) return;
  const ef = materializeFlags(op, m.read32(b + ST.LZ_RES), m.read32(b + ST.LZ_SRC1), m.read32(b + ST.LZ_SRC2), m.read32(b + ST.EFLAGS));
  m.write32(b + ST.LZ_OP, 0);
  m.write32(b + ST.EFLAGS, ef >>> 0);
}
CpuState.foldLazyFlags = foldLazyFlags;

export class Jit {
  /**
   * @param {import('../memory.js').GuestMemory} mem
   * @param {import('../interp.js').Interp} interp fallback interpreter (shares the memory)
   * @param {{ smc?: boolean, chain?: boolean, log?: (msg: string) => void, warn?: (msg: string) => void }} [opts]
   */
  constructor(mem, interp, opts = {}) {
    this.mem = mem;
    this.interp = interp;
    this.opts = opts;
    this.cpu = null;
    this.table = new WebAssembly.Table({ initial: 4096, element: 'anyfunc' });
    const rtModule = new WebAssembly.Module(buildRuntime());
    this.runtime = new WebAssembly.Instance(rtModule, { env: { memory: mem.memory, table: this.table } }).exports;
    this.imports = {
      env: {
        memory: mem.memory,
        table: this.table,
        flags: this.runtime.flags,
        round24: this.runtime.round24,
        fallback: (eip) => this.fallback(eip),
      },
    };
    // transcendental kernels (pure WASM functions of the runtime module: no JS on the path, D004)
    for (const [name] of MATH_KERNELS) this.imports.env[name] = this.runtime[name];
    // Region chaining needs WASM tail calls (return_call_indirect); without them regions always
    // return to the dispatcher (slower transitions, same semantics).
    const tailCalls = supportsReturnCall();
    this.chaining = opts.chain !== false && tailCalls;
    if (!tailCalls && opts.warn) opts.warn('jit: return_call_indirect not supported by this engine, region chaining disabled');
    if (opts.log) opts.log(`jit: region chaining ${this.chaining ? 'on' : 'off'}`);
    /** @type {Array<{entry: number, start: number, end: number, blocks: any[], fnIdx: number}>} */
    this.regions = [];
    this.pending = []; // regions still living in their own single-function module
    this.blockMap = new Map(); // block eip -> { region, block } for every live region (re-insertion after hash eviction)
    this.consolidateEvery = opts.consolidateEvery ?? CONSOLIDATE_EVERY;
    this.byEntry = new Map();
    this.byFn = new Map(); // table index -> live region
    // block eips of regions that were entered under another x87 mode than the one they were specialized
    // for: translated from then on with the precision/rounding control tested at run time
    this.genericFpu = new Set();
    this.nextFn = 0;
    this.stats = { regions: 0, blocks: 0, native: 0, fallback: 0, translateMs: 0, tEmit: 0, tBuild: 0, tModule: 0, tInstance: 0, tTableSet: 0, tConsolidate: 0, bytes: 0, misses: 0, invalidations: 0, dropped: 0, live: 0, fallbackSteps: 0, chained: 0 };
    this.fallbackHist = opts.fallbackHist ? new Map() : null; // mnemonic -> interpreter fallback executions (diagnostic)
    this.lastFault = null;
    this.boundaries = null; // extra region boundaries (tests)
    this.pageRegions = new Map(); // page -> Set(region)
    this.clearTables();
  }

  /** Mark a thunk slot as having a WASM fast path (called for every created thunk). */
  markFast(idx, key, def) {
    const fid = def ? FAST_NAMES[key] : undefined;
    const defer = def && this.opts.deferCom !== false ? DEFER_SPECS[key.slice(key.indexOf('!') + 1)] : undefined;
    this.mem.u8[FAST_TABLE + idx] = fid ?? (defer !== undefined ? FID_DEFER : 0);
    this.mem.write32(DEFER_SPEC + 4 * idx, defer ?? 0);
  }
  /** Per-process constants used by fast paths. */
  setProcessConsts(processHeapHandle) { this.mem.write32(PROC_CONSTS, processHeapHandle); }

  clearTables() {
    this.mem.fill(JIT_HASH_BASE, HASH_ENTRY << JIT_HASH_BITS, 0);
    this.mem.fill(SMC_MAP_BASE, 0x80000, 0);
    this.regions = [];
    this.pending = [];
    this.blockMap.clear();
    this.byEntry.clear();
    this.pageRegions.clear();
    this.byFn?.clear();
    this.genericFpu?.clear();
  }

  /** Drop every translation (e.g. between conformance cases). */
  reset() { this.clearTables(); }

  // ------------------------------------------------------------------ hash table
  hashInsert(eip, fnIdx, block) {
    const m = this.mem;
    let idx = Math.imul(eip, 0x9e3779b1) >>> (32 - JIT_HASH_BITS);
    for (let p = 0; p < HASH_PROBES; p++) {
      const e = JIT_HASH_BASE + ((idx + p) & ((1 << JIT_HASH_BITS) - 1)) * HASH_ENTRY;
      const cur = m.read32(e);
      if (cur === 0 || cur === eip) { m.write32(e, eip); m.write32(e + 4, fnIdx); m.write32(e + 8, block); return; }
    }
    // evict the first slot
    const e = JIT_HASH_BASE + (idx & ((1 << JIT_HASH_BITS) - 1)) * HASH_ENTRY;
    m.write32(e, eip); m.write32(e + 4, fnIdx); m.write32(e + 8, block);
  }
  hashRemove(eip) {
    const m = this.mem;
    const idx = Math.imul(eip, 0x9e3779b1) >>> (32 - JIT_HASH_BITS);
    for (let p = 0; p < HASH_PROBES; p++) {
      const e = JIT_HASH_BASE + ((idx + p) & ((1 << JIT_HASH_BITS) - 1)) * HASH_ENTRY;
      if (m.read32(e) === eip) { m.write32(e, 0); return; }
    }
  }
  hashLookup(eip) {
    const m = this.mem;
    const idx = Math.imul(eip, 0x9e3779b1) >>> (32 - JIT_HASH_BITS);
    for (let p = 0; p < HASH_PROBES; p++) {
      const e = JIT_HASH_BASE + ((idx + p) & ((1 << JIT_HASH_BITS) - 1)) * HASH_ENTRY;
      if (m.read32(e) === eip) return { fnIdx: m.read32(e + 4), block: m.read32(e + 8) };
    }
    return null;
  }

  // ------------------------------------------------------------------ translation
  translate(eip) {
    const t0 = performance.now();
    // already translated (its hash entry was evicted): re-insert instead of retranslating
    const known = this.blockMap.get(eip);
    if (known) { this.hashInsert(eip, known.region.fnIdx, known.block); this.stats.reinserts = (this.stats.reinserts ?? 0) + 1; return known.region; }
    // translation storm diagnostic: thousands of new regions per second means code is being retranslated
    if (!this.stormAt || t0 - this.stormAt > 1000) { this.stormAt = t0; this.stormCount = 0; }
    if (++this.stormCount === 2000 && this.opts.warn) this.opts.warn(`jit: translation storm (${this.stormCount} regions in ${(t0 - this.stormAt).toFixed(0)} ms) at ${eip.toString(16)}; stats ${JSON.stringify(this.stats)}`);
    // x87 regions are specialized for the precision/rounding control in force when they are first reached
    const fpcAssume = this.opts.fpuSpecialize === false || this.genericFpu.has(eip) ? null : this.mem.read16(this.cpu.base + ST.FPU_CW) & 0xf00;
    const { code, blocks, stats, fpcAssume: fpc } = translateRegion(this.mem, eip, { boundaries: this.boundaries, smc: this.opts.smc !== false, chain: this.chaining, profile: this.opts.profile, fnIdx: this.nextFn, fpcAssume, nestLoops: this.opts.nestLoops, countChains: this.opts.countChains });
    const t1 = performance.now();
    const bytes = buildRegionModule([code], ['r_' + eip.toString(16)]);
    const t2 = performance.now();
    let inst;
    try {
      const mod = new WebAssembly.Module(bytes);
      this.stats.tModule += performance.now() - t2;
      const t3 = performance.now();
      inst = new WebAssembly.Instance(mod, this.imports);
      this.stats.tInstance += performance.now() - t3;
    } catch (e) {
      throw new Error(`JIT module for ${eip.toString(16)} failed: ${e.message}`);
    }
    this.stats.tEmit += t1 - t0; this.stats.tBuild += t2 - t1;
    if (this.nextFn >= this.table.length) this.table.grow(Math.max(4096, this.table.length));
    const fnIdx = this.nextFn++;
    const t4 = performance.now();
    this.table.set(fnIdx, inst.exports.r0);
    this.stats.tTableSet += performance.now() - t4;
    // the code pages the blocks cover (a region can span distant functions: not every page in between)
    const pages = new Set();
    for (const b of blocks) for (let p = b.eip >>> 12; p <= (b.end - 1) >>> 12; p++) pages.add(p);
    const region = { entry: eip, pages: [...pages], blocks, fnIdx, code, fpc };
    this.byFn.set(fnIdx, region);
    this.regions.push(region);
    this.stats.live = this.regions.length;
    this.byEntry.set(eip, region);
    for (const b of blocks) { this.hashInsert(b.eip, fnIdx, b.index); this.blockMap.set(b.eip, { region, block: b.index }); }
    // mark code pages for SMC detection
    for (const p of region.pages) {
      this.mem.u8[SMC_MAP_BASE + p] = 1;
      let s = this.pageRegions.get(p); if (!s) { s = new Set(); this.pageRegions.set(p, s); } s.add(region);
    }
    // consolidation only after the region is registered: consolidate() keeps the pending regions
    // that byEntry still maps, so the one triggering it must already be there (or it would keep
    // its single-function instance forever)
    this.pending.push(region);
    if (this.pending.length >= this.consolidateEvery) { const tc = performance.now(); this.consolidate(); this.stats.tConsolidate += performance.now() - tc; }
    this.stats.regions++; this.stats.blocks += blocks.length; this.stats.native += stats.native; this.stats.fallback += stats.fallback;
    this.stats.bytes += bytes.length; this.stats.translateMs += performance.now() - t0;
    if (this.opts.log) this.opts.log(`jit: region ${eip.toString(16)} blocks=${blocks.length} native=${stats.native} fallback=${stats.fallback} bytes=${bytes.length}`);
    return region;
  }

  /**
   * Pack the pending single-function modules into one module: V8 keeps ~50 KB of metadata per
   * instance, so thousands of one-region instances exhaust the JS heap. The packed functions
   * replace the table entries; the old instances become garbage.
   */
  consolidate() {
    const live = this.pending.filter((r) => r.code && this.byEntry.get(r.entry) === r);
    this.pending = [];
    if (!live.length) return;
    const t0 = performance.now();
    let inst;
    try { inst = new WebAssembly.Instance(new WebAssembly.Module(buildRegionModule(live.map((r) => r.code), live.map((r) => 'r_' + r.entry.toString(16)))), this.imports); }
    catch (e) { if (this.opts.log) this.opts.log(`jit: consolidation failed: ${e.message}`); return; }
    live.forEach((r, i) => { if (this.byEntry.get(r.entry) === r) this.table.set(r.fnIdx, inst.exports['r' + i]); r.code = null; });
    this.stats.consolidations = (this.stats.consolidations ?? 0) + 1;
    this.stats.translateMs += performance.now() - t0;
  }

  /**
   * Debugging aid: report which translated code writes into [addr, addr + len) — the pages are flagged in the
   * SMC map, so a store there leaves its region (EXIT.SMC) and watchHit() records the writer (distinct resume
   * EIPs, at most `max` hits per page). Pages that hold translated code are not watched.
   */
  watchWrites(addr, len, label, max = 64) {
    this.watches ??= new Map();
    for (let p = addr >>> 12; p <= (addr + len - 1) >>> 12; p++) {
      if (this.mem.u8[SMC_MAP_BASE + p]) continue;
      this.mem.u8[SMC_MAP_BASE + p] = 2;
      this.watches.set(p, { label, hits: 0, max, sites: new Map() });
    }
  }
  unwatch(label) {
    if (!this.watches) return [];
    const report = [];
    for (const [p, w] of this.watches) if (w.label === label) { if (this.mem.u8[SMC_MAP_BASE + p] === 2) this.mem.u8[SMC_MAP_BASE + p] = 0; this.watches.delete(p); report.push(...w.sites); }
    return report;
  }
  /** SMC exit on a watched page: record the writer; returns true when handled (nothing to invalidate). */
  watchHit(addr, eip) {
    const p = addr >>> 12, w = this.watches?.get(p);
    if (!w) return false;
    w.sites.set(eip, (w.sites.get(eip) ?? 0) + 1);
    if (++w.hits >= w.max) { this.mem.u8[SMC_MAP_BASE + p] = 0; this.watches.delete(p); this.watchDone?.(w); }
    return true;
  }

  /** Invalidate translations overlapping [addr, addr+len). */
  invalidate(addr, len) {
    const p0 = addr >>> 12, p1 = (addr + len - 1) >>> 12;
    const victims = new Set();
    for (let p = p0; p <= p1; p++) { const s = this.pageRegions.get(p); if (s) for (const r of s) victims.add(r); }
    if (victims.size) this.stats.invalidations++;
    for (const r of victims) this.dropRegion(r);
    this.stats.dropped += victims.size;
  }
  dropRegion(r) {
    for (const b of r.blocks) { this.hashRemove(b.eip); const k = this.blockMap.get(b.eip); if (k && k.region === r) this.blockMap.delete(b.eip); }
    this.byEntry.delete(r.entry);
    const i = this.regions.indexOf(r); if (i >= 0) this.regions.splice(i, 1);
    for (const p of r.pages) {
      const s = this.pageRegions.get(p);
      if (s) { s.delete(r); if (!s.size) { this.pageRegions.delete(p); this.mem.u8[SMC_MAP_BASE + p] = 0; } }
    }
    this.table.set(r.fnIdx, null);
    this.byFn.delete(r.fnIdx);
  }

  // ------------------------------------------------------------------ fallback
  fallback(eip) {
    const cpu = this.cpu;
    this.interp.cpu = cpu;
    this.materialize();
    cpu.eip = eip;
    cpu.exit = EXIT.NONE;
    const r = this.interp.step();
    this.stats.fallbackSteps = (this.stats.fallbackSteps ?? 0) + 1;
    if (this.fallbackHist) { const op = this.interp.lastOp; this.fallbackHist.set(op, (this.fallbackHist.get(op) ?? 0) + 1); }
    if (r !== EXIT.NONE) { this.lastFault = this.interp.lastFault; return r; }
    return 0;
  }

  /** Fold pending lazy flags into EFLAGS. */
  /** Fold the pending lazy flag operation of the current thread into EFLAGS (normally lazy: CpuState's getter does it on demand). */
  materialize() { foldLazyFlags(this.cpu); }

  // ------------------------------------------------------------------ execution
  /**
   * Same contract as Interp.run(): runs until an exit. maxInsns bounds the budget.
   * @param {{ stopAt?: number, maxInsns?: number }} opts
   */
  /** instructions left from the last run()'s budget (negative after a time slice) */
  remaining() { return this.mem.readS32(this.cpu.base + ST.ICOUNT); }

  /** Fold the thread's chained-transition counter into the stats. */
  harvest(base) {
    const n = this.mem.u32[(base + ST.TRANSITIONS) >>> 2];
    if (n) { this.stats.chained += n; this.mem.u32[(base + ST.TRANSITIONS) >>> 2] = 0; }
    if (this.opts.profile) {
      const p = (this.stats.prof ??= Object.fromEntries(JIT_PROF.map((k) => [k, 0])));
      JIT_PROF.forEach((k, i) => { const a = (base + ST.PROF + 4 * i) >>> 2; p[k] += this.mem.u32[a]; this.mem.u32[a] = 0; });
    }
  }
  /** flags helper calls per x86 mnemonic since the last call (profiling translations), sorted */
  flagsByOp() {
    const out = [];
    for (let op = 0; op < OP_NAMES.length; op++) { const a = (PROF_OPS_BASE >>> 2) + op; const n = this.mem.u32[a]; if (n) { out.push([OP_NAMES[op], n]); this.mem.u32[a] = 0; } }
    return out.sort((x, y) => y[1] - x[1]);
  }

  run(opts = {}) {
    const cpu = this.cpu;
    const stopAt = opts.stopAt ?? -1;
    const m = this.mem;
    m.write32(cpu.base + ST.ICOUNT, Math.min(opts.maxInsns ?? 1e9, 0x7fffffff));
    m.write32(cpu.base + ST.LZ_OP, 0);
    m.write32(cpu.base + ST.STOP_AT, stopAt >>> 0); // 0xffffffff when unused: never a jump target
    cpu.exit = EXIT.NONE;
    for (;;) {
      let r;
      try {
        r = this.runtime.run(cpu.eip, cpu.base);
      } catch (e) {
        // WASM trap: treat as a memory fault at an unknown instruction inside the current region
        // (the state block holds the registers as of the last dispatcher entry / non-chained exit)
        this.harvest(cpu.base);
        this.materialize();
        this.lastFault = e;
        cpu.exit = EXIT.FAULT; cpu.exitArg = 14;
        return EXIT.FAULT;
      }
      this.harvest(cpu.base);
      // Flags are folded eagerly at every exit to JS: leaving them pending in memory while JS runs made the
      // game's startup spin in an SEH continuation loop (root cause not isolated; the on-demand fold in
      // CpuState.eflags stays as a safety net).
      this.materialize();
      if (r === EXIT_TRANSLATE) {
        const eip = cpu.eip;
        if (eip >= THUNK_BASE && eip < THUNK_END) { cpu.exit = EXIT.THUNK; cpu.exitArg = ((eip - THUNK_BASE) / THUNK_SIZE) | 0; return EXIT.THUNK; }
        this.stats.misses++;
        try {
          this.translate(eip);
        } catch (e) {
          // translation failure (e.g. undecodable): run one instruction in the interpreter
          this.interp.cpu = cpu;
          cpu.exit = EXIT.NONE; // (the state block still holds the dispatcher's exit code)
          const s = this.interp.step();
          if (s !== EXIT.NONE) { this.lastFault = this.interp.lastFault; return s; }
        }
        continue;
      }
      if (r === EXIT_STEP) { // an instruction the translation leaves to the interpreter in rare cases
        this.interp.cpu = cpu;
        cpu.exit = EXIT.NONE;
        const s = this.interp.step();
        this.stats.steps = (this.stats.steps ?? 0) + 1;
        if (s !== EXIT.NONE) { this.lastFault = this.interp.lastFault; return s; }
        continue;
      }
      if (r === EXIT_FPUMODE) {
        // a region specialized for one x87 mode entered under another: replace it by one testing the mode
        const h = this.hashLookup(cpu.eip), region = h && this.byFn.get(h.fnIdx);
        if (region) { for (const b of region.blocks) this.genericFpu.add(b.eip); this.dropRegion(region); }
        else this.genericFpu.add(cpu.eip);
        this.stats.fpuModeMisses = (this.stats.fpuModeMisses ?? 0) + 1;
        continue;
      }
      if (r === EXIT.NONE) { // a region returned EIP 0 (jump/call/ret to address 0): access violation
        this.lastFault = { message: 'jump to address 0', vector: 14, faultAddr: 0 };
        cpu.exit = EXIT.FAULT; cpu.exitArg = 14;
        return EXIT.FAULT;
      }
      if (r === EXIT.FAULT && !this.lastFault) this.lastFault = { message: `fault ${cpu.exitArg} at ${cpu.eip.toString(16)}`, vector: cpu.exitArg };
      return r;
    }
  }
}
