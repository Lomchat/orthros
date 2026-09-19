// JIT executor: translates regions on demand, keeps the funcref table + hash table used by the
// WASM dispatcher, and exposes the same run() interface as the interpreter.
import { EXIT, ST } from '../state.js';
import { THUNK_BASE, THUNK_END, THUNK_SIZE, JIT_HASH_BASE, JIT_HASH_BITS, SMC_BITMAP_BASE } from '../memory.js';
import { buildRuntime, materializeFlags, supportsReturnCall, EXIT_TRANSLATE, HASH_ENTRY, HASH_PROBES, FAST_TABLE, FAST_NAMES, PROC_CONSTS } from './runtime.js';
import { translateRegion, buildRegionModule } from './translate.js';
import './translate-x87.js';
import './translate-sse-float.js';
import './translate-sse-int.js';

const CONSOLIDATE_EVERY = 128;

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
    this.nextFn = 0;
    this.stats = { regions: 0, blocks: 0, native: 0, fallback: 0, translateMs: 0, bytes: 0, misses: 0, invalidations: 0, dropped: 0, live: 0, fallbackSteps: 0, chained: 0 };
    this.fallbackHist = opts.fallbackHist ? new Map() : null; // mnemonic -> interpreter fallback executions (diagnostic)
    this.lastFault = null;
    this.boundaries = null; // extra region boundaries (tests)
    this.pageRegions = new Map(); // page -> Set(region)
    this.clearTables();
  }

  /** Mark a thunk slot as having a WASM fast path (called for every created thunk). */
  markFast(idx, key, def) {
    const fid = def ? FAST_NAMES[key] : undefined;
    this.mem.u8[FAST_TABLE + idx] = fid ?? 0;
  }
  /** Per-process constants used by fast paths. */
  setProcessConsts(processHeapHandle) { this.mem.write32(PROC_CONSTS, processHeapHandle); }

  clearTables() {
    this.mem.fill(JIT_HASH_BASE, HASH_ENTRY << JIT_HASH_BITS, 0);
    this.mem.fill(SMC_BITMAP_BASE, 0x10000, 0);
    this.regions = [];
    this.pending = [];
    this.blockMap.clear();
    this.byEntry.clear();
    this.pageRegions.clear();
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
    const { code, blocks, stats } = translateRegion(this.mem, eip, { boundaries: this.boundaries, smc: this.opts.smc !== false, chain: this.chaining });
    const bytes = buildRegionModule([code]);
    let inst;
    try {
      inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), this.imports);
    } catch (e) {
      throw new Error(`JIT module for ${eip.toString(16)} failed: ${e.message}`);
    }
    if (this.nextFn >= this.table.length) this.table.grow(Math.max(4096, this.table.length));
    const fnIdx = this.nextFn++;
    this.table.set(fnIdx, inst.exports.r0);
    let start = Infinity, end = 0;
    for (const b of blocks) { start = Math.min(start, b.eip); end = Math.max(end, b.end); }
    const region = { entry: eip, start, end, blocks, fnIdx, code };
    this.regions.push(region);
    this.stats.live = this.regions.length;
    this.pending.push(region);
    if (this.pending.length >= this.consolidateEvery) this.consolidate();
    this.byEntry.set(eip, region);
    for (const b of blocks) { this.hashInsert(b.eip, fnIdx, b.index); this.blockMap.set(b.eip, { region, block: b.index }); }
    // mark code pages for SMC detection
    for (let p = start >>> 12; p <= (end - 1) >>> 12; p++) {
      this.mem.u8[SMC_BITMAP_BASE + (p >>> 3)] |= 1 << (p & 7);
      let s = this.pageRegions.get(p); if (!s) { s = new Set(); this.pageRegions.set(p, s); } s.add(region);
    }
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
    try { inst = new WebAssembly.Instance(new WebAssembly.Module(buildRegionModule(live.map((r) => r.code))), this.imports); }
    catch (e) { if (this.opts.log) this.opts.log(`jit: consolidation failed: ${e.message}`); return; }
    live.forEach((r, i) => { if (this.byEntry.get(r.entry) === r) this.table.set(r.fnIdx, inst.exports['r' + i]); r.code = null; });
    this.stats.consolidations = (this.stats.consolidations ?? 0) + 1;
    this.stats.translateMs += performance.now() - t0;
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
    for (let p = r.start >>> 12; p <= (r.end - 1) >>> 12; p++) {
      const s = this.pageRegions.get(p);
      if (s) { s.delete(r); if (!s.size) { this.pageRegions.delete(p); this.mem.u8[SMC_BITMAP_BASE + (p >>> 3)] &= ~(1 << (p & 7)); } }
    }
    this.table.set(r.fnIdx, null);
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
  materialize() {
    const cpu = this.cpu;
    const m = this.mem, b = cpu.base;
    const op = m.read32(b + ST.LZ_OP);
    if (op) {
      cpu.eflags = materializeFlags(op, m.read32(b + ST.LZ_RES), m.read32(b + ST.LZ_SRC1), m.read32(b + ST.LZ_SRC2), cpu.eflags);
      m.write32(b + ST.LZ_OP, 0);
    }
  }

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
      if (r === EXIT_TRANSLATE) {
        const eip = cpu.eip;
        if (eip >= THUNK_BASE && eip < THUNK_END) { cpu.exit = EXIT.THUNK; cpu.exitArg = ((eip - THUNK_BASE) / THUNK_SIZE) | 0; return EXIT.THUNK; }
        this.stats.misses++;
        try {
          this.translate(eip);
        } catch (e) {
          // translation failure (e.g. undecodable): run one instruction in the interpreter
          this.interp.cpu = cpu;
          this.materialize();
          const s = this.interp.step();
          if (s !== EXIT.NONE) { this.lastFault = this.interp.lastFault; return s; }
        }
        continue;
      }
      this.materialize();
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
