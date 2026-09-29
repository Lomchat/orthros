// JIT executor: translates regions on demand, keeps the funcref table + hash table used by the
// WASM dispatcher, and exposes the same run() interface as the interpreter.
import { EXIT, ST, CpuState } from '../state.js';
import { THUNK_BASE, THUNK_END, THUNK_SIZE, JIT_HASH_BASE, JIT_HASH_BITS, SMC_MAP_BASE, SMC_CODE, SMC_WATCH, SMC_NEXT, JIT_ALT_BASE, JIT_ALT_SLOTS } from '../memory.js';
import { buildRuntime, materializeFlags, supportsReturnCall, EXIT_TRANSLATE, EXIT_FPUMODE, EXIT_STEP, HASH_ENTRY, HASH_PROBES, FAST_TABLE, FAST_NAMES, PROC_CONSTS, MATH_KERNELS, FID_DEFER, DEFER_SPEC, DEFER_SPECS } from './runtime.js';
import { translateRegion, buildRegionModule, JIT_PROF, PROF_OPS_BASE } from './translate.js';
import { OP_NAMES } from '../decoder.js';
import './translate-x87.js';
import './translate-sse-float.js';
import './translate-sse-int.js';

const CONSOLIDATE_EVERY = 128;
/** x87-mode versions of a region before it is translated with the mode tested at run time */
const MAX_FPU_VERSIONS = 4; // (24/53-bit precision x nearest/truncation: the four modes seen for code shared by a game's threads)

/** Fold a pending lazy flag operation (left in the state block by JIT'd code) into the thread's EFLAGS. */
function foldLazyFlags(cpu) {
  const m = cpu.mem, b4 = cpu.b4;
  const op = m.u32[b4 + ST.LZ_OP / 4];
  if (!op) return;
  // (signed reads: materializeFlags masks its operands, and a small negative stays a small integer where an unsigned
  // value of 2^30 and more is boxed into a heap number per call — at every exit to JS, a top source of garbage)
  const ef = materializeFlags(op, m.i32[b4 + ST.LZ_RES / 4], m.i32[b4 + ST.LZ_SRC1 / 4], m.i32[b4 + ST.LZ_SRC2 / 4], m.i32[b4 + ST.EFLAGS / 4]);
  m.u32[b4 + ST.LZ_OP / 4] = 0;
  m.u32[b4 + ST.EFLAGS / 4] = ef;
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
    this.shared = typeof SharedArrayBuffer !== 'undefined' && mem.memory.buffer instanceof SharedArrayBuffer; // (see bg-translate.js)
    const rtModule = new WebAssembly.Module(buildRuntime({ profile: !!opts.profile, shared: this.shared }));
    this.runtime = new WebAssembly.Instance(rtModule, { env: { memory: mem.memory, table: this.table, now: opts.now ?? (() => 0) } }).exports;
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
    /** region entries translated at a miss, [eip, x87 mode assumed (null: none / generic), ms since start] (learnRegions) */
    this.learned = null;
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
  /**
   * Translate the region at `eip`. `version` ({ first, fpc }): another version of region `first` specialized for
   * x87 mode `fpc`, reached only through the entry guard of the previous version (not in the hash table).
   */
  translate(eip, version = null, assume = undefined) {
    const t0 = performance.now();
    // already translated (its hash entry was evicted): re-insert instead of retranslating
    const known = version ? null : this.blockMap.get(eip);
    if (known) { this.hashInsert(eip, known.region.fnIdx, known.block); this.stats.reinserts = (this.stats.reinserts ?? 0) + 1; return known.region; }
    // translation storm diagnostic: thousands of new regions per second means code is being retranslated
    if (!this.stormAt || t0 - this.stormAt > 1000) { this.stormAt = t0; this.stormCount = 0; }
    if (++this.stormCount === 2000 && this.opts.warn) this.opts.warn(`jit: translation storm (${this.stormCount} regions in ${(t0 - this.stormAt).toFixed(0)} ms) at ${eip.toString(16)}; stats ${JSON.stringify(this.stats)}`);
    // x87 regions are specialized for the precision/rounding control in force when they are first reached
    const fpcAssume = version ? version.fpc : this.opts.fpuSpecialize === false || this.genericFpu.has(eip) ? null : assume !== undefined ? assume : this.mem.read16(this.cpu.base + ST.FPU_CW) & 0xf00;
    const { code, blocks, stats, fpcAssume: fpc } = translateRegion(this.mem, eip, { boundaries: this.boundaries, interpRanges: this.opts.interpRanges, smc: this.opts.smc !== false, chain: this.chaining, profile: this.opts.profile, fnIdx: this.nextFn, fpcAssume, nestLoops: this.opts.nestLoops, countChains: this.opts.countChains, inlineApi: this.opts.inlineApi });
    const t1 = performance.now();
    if (stats.inlineApi) this.stats.inlineApi = (this.stats.inlineApi ?? 0) + stats.inlineApi; // (API call sites run inline, see translate.js inlineApiOf)
    const bytes = buildRegionModule([code], ['r_' + eip.toString(16)], this.shared);
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
    const fnIdx = this.reserveFn();
    const t4 = performance.now();
    this.table.set(fnIdx, inst.exports.r0);
    this.stats.tTableSet += performance.now() - t4;
    const region = this.register(eip, blocks, fnIdx, code, fpc, stats, version);
    // consolidation only after the region is registered: consolidate() keeps the pending regions
    // that byEntry still maps, so the one triggering it must already be there (or it would keep
    // its single-function instance forever)
    if (!version) this.pending.push(region); // (versions keep their own module: consolidation packs hash-reachable regions)
    if (this.pending.length >= this.consolidateEvery) { const tc = performance.now(); this.consolidate(); this.stats.tConsolidate += performance.now() - tc; }
    this.stats.bytes += bytes.length; this.stats.translateMs += performance.now() - t0;
    if (this.learned && !version && assume === undefined && this.learned.length < 65536) this.learned.push([eip, fpc, Math.round(t0)]);
    if (this.opts.log) this.opts.log(`jit: region ${eip.toString(16)} blocks=${blocks.length} native=${stats.native} fallback=${stats.fallback} bytes=${bytes.length}`);
    return region;
  }

  /** A table index for a new region (the table grows by doubling). */
  reserveFn() {
    if (this.nextFn >= this.table.length) this.table.grow(Math.max(4096, this.table.length));
    return this.nextFn++;
  }
  /**
   * Record a region whose function is at table index `fnIdx`: lookup structures, hash entries of its blocks (not for
   * an FPU-mode version, reached through its first version's guard), code pages flagged for SMC detection.
   */
  register(eip, blocks, fnIdx, code, fpc, stats, version = null) {
    // the code pages the blocks cover (a region can span distant functions: not every page in between)
    const pages = new Set();
    for (const b of blocks) for (let p = b.eip >>> 12; p <= (b.end - 1) >>> 12; p++) pages.add(p);
    const region = { entry: eip, pages: [...pages], blocks, fnIdx, code, fpc, calls: stats.calls, first: version?.first ?? null, versions: null };
    this.byFn.set(fnIdx, region);
    this.regions.push(region);
    this.stats.live = this.regions.length;
    if (fnIdx < JIT_ALT_SLOTS) this.mem.write32(JIT_ALT_BASE + 4 * fnIdx, 0); // (no next version yet)
    if (!version) {
      this.byEntry.set(eip, region);
      for (const b of blocks) { this.hashInsert(b.eip, fnIdx, b.index); this.blockMap.set(b.eip, { region, block: b.index }); }
    }
    // mark code pages for SMC detection (and the page before each: a store crossing into a code page, see smcCheck)
    for (const p of region.pages) {
      this.mem.u8[SMC_MAP_BASE + p] = (this.mem.u8[SMC_MAP_BASE + p] & SMC_NEXT) | SMC_CODE;
      if (p > 0) this.mem.u8[SMC_MAP_BASE + p - 1] |= SMC_NEXT;
      let s = this.pageRegions.get(p); if (!s) { s = new Set(); this.pageRegions.set(p, s); } s.add(region);
    }
    this.stats.regions++; this.stats.blocks += blocks.length; this.stats.native += stats.native; this.stats.fallback += stats.fallback;
    return region;
  }

  // ------------------------------------------------------------------ background translation
  /**
   * Translate ahead in another worker (bg-translate.js) that shares the guest memory: `port` is that worker. Regions
   * come back compiled, in batches (one module each), and are installed by bgInstall() when their code bytes still
   * equal the ones translated.
   */
  attachBackground(port) {
    this.bg = { port, nextId: 1, inflight: new Map(), sent: 0, installed: 0, rejected: 0, bgMs: 0 };
    port.postMessage({ type: 'init', memory: this.mem.memory, opts: { smc: this.opts.smc !== false, chain: this.chaining, profile: !!this.opts.profile, nestLoops: this.opts.nestLoops, countChains: this.opts.countChains, inlineApi: this.opts.inlineApi, interpRanges: this.opts.interpRanges } });
  }
  /** batches sent and not answered yet */
  bgPending() { return this.bg ? this.bg.inflight.size : 0; }
  /**
   * Ask the background worker for regions [eip, x87 mode (null: generic)] not translated yet; table indexes are
   * reserved now (an answer that is not installed leaves its index unused). Returns how many were sent.
   */
  bgPrewarm(list) {
    const bg = this.bg; if (!bg) return 0;
    const items = [];
    for (const [eip0, fpc] of list) {
      const eip = eip0 >>> 0;
      if (this.blockMap.has(eip) || !this.interp.executable(eip)) continue;
      items.push({ eip, fpc: this.opts.fpuSpecialize === false || this.genericFpu.has(eip) ? null : fpc, fnIdx: this.reserveFn() });
    }
    if (!items.length) return 0;
    const id = bg.nextId++;
    bg.inflight.set(id, items.length); bg.sent += items.length;
    bg.port.postMessage({ type: 'batch', id, items });
    return items.length;
  }
  /** A batch from the background worker: each region whose bytes are unchanged and not translated meanwhile is installed. */
  bgInstall(m) {
    const bg = this.bg; if (!bg || !bg.inflight.has(m.id)) return;
    bg.inflight.delete(m.id);
    bg.bgMs += m.ms ?? 0;
    if (!m.module) return;
    const t0 = performance.now();
    let inst;
    try { inst = new WebAssembly.Instance(m.module, this.imports); } catch (e) { this.opts.warn?.(`jit: background batch failed: ${e.message}`); return; }
    const u8 = this.mem.u8;
    for (const it of m.items) {
      if (it.k < 0) continue; // (not translatable)
      // translated here meanwhile (at a miss), or its code changed since the background worker read it
      let same = !this.blockMap.has(it.eip);
      for (let i = 0, o = 0; same && i < it.blocks.length; i++) { const b = it.blocks[i]; for (let a = b.eip; a < b.end; a++, o++) if (u8[a] !== it.snap[o]) { same = false; break; } }
      if (!same) { bg.rejected++; continue; }
      this.table.set(it.fnIdx, inst.exports['r' + it.k]);
      this.register(it.eip, it.blocks, it.fnIdx, null, it.fpc, it.stats);
      bg.installed++;
    }
    this.stats.bgInstallMs = (this.stats.bgInstallMs ?? 0) + performance.now() - t0;
  }

  /**
   * Pack the pending single-function modules into one module: V8 keeps ~50 KB of metadata per
   * instance, so thousands of one-region instances exhaust the JS heap. The packed functions
   * replace the table entries; the old instances become garbage.
   */
  /**
   * Translate the region at `eip` ahead of its first execution (a region earlier sessions reached, see the worker's
   * region prewarm), for x87 mode `fpc` (null: generic), unless it is already translated or has no memory. False when
   * nothing was done. A region translated from code that changes later is dropped like any other (SMC detection).
   */
  prewarm(eip, fpc) {
    eip >>>= 0;
    if (this.blockMap.has(eip) || !this.interp.executable(eip)) return false;
    const t0 = performance.now();
    try { this.translate(eip, null, fpc); } catch { return false; } finally { this.stats.prewarmMs = (this.stats.prewarmMs ?? 0) + performance.now() - t0; }
    this.stats.prewarmed = (this.stats.prewarmed ?? 0) + 1;
    return true;
  }

  consolidate() {
    const live = this.pending.filter((r) => r.code && this.byEntry.get(r.entry) === r);
    this.pending = [];
    if (!live.length) return;
    const t0 = performance.now();
    let inst;
    try { inst = new WebAssembly.Instance(new WebAssembly.Module(buildRegionModule(live.map((r) => r.code), live.map((r) => 'r_' + r.entry.toString(16)), this.shared)), this.imports); }
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
      if (this.mem.u8[SMC_MAP_BASE + p] & (SMC_CODE | SMC_WATCH)) continue;
      this.mem.u8[SMC_MAP_BASE + p] |= SMC_WATCH;
      this.watches.set(p, { label, hits: 0, max, sites: new Map(), lo: addr >>> 0, hi: (addr + len) >>> 0 });
    }
  }
  unwatch(label) {
    if (!this.watches) return [];
    const report = [];
    for (const [p, w] of this.watches) if (w.label === label) { this.mem.u8[SMC_MAP_BASE + p] &= ~SMC_WATCH; this.watches.delete(p); report.push(...w.sites); }
    return report;
  }
  /** SMC exit on a watched page: record the writer; returns true when handled (nothing to invalidate). */
  watchHit(addr, eip, len = 16, thread = null) {
    if (!this.watches) return false;
    let p = addr >>> 12, w = null;
    for (const last = (addr + len - 1) >>> 12; p <= last && !(w = this.watches.get(p)); p++);
    if (!w) return false;
    if (addr + len <= w.lo || addr >= w.hi) return true; // (another address of the watched page)
    // the writer's resume EIP, with the first words of its stack (a memcpy's return address)
    let key = eip;
    if (thread) { const sp = thread.cpu.esp; key = `t${thread.id}:` + [eip, ...[0, 4, 8, 12, 16].map((o) => this.mem.read32(sp + o))].map((x) => (x >>> 0).toString(16)).join('/'); }
    w.sites.set(key, (w.sites.get(key) ?? 0) + 1);
    if (++w.hits >= w.max) { this.mem.u8[SMC_MAP_BASE + p] &= ~SMC_WATCH; this.watches.delete(p); this.watchDone?.(w); }
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
  /** Drop a region with every FPU-mode version of it (the guard of one version may tail-call the next). */
  dropRegion(r) {
    const family = (r.first ?? r).versions;
    if (!family) { this.dropOne(r); return; }
    for (const v of family) this.dropOne(v);
    (r.first ?? r).versions = null;
  }
  dropOne(r) {
    if (r.fnIdx < JIT_ALT_SLOTS) this.mem.write32(JIT_ALT_BASE + 4 * r.fnIdx, 0);
    for (const b of r.blocks) { this.hashRemove(b.eip); const k = this.blockMap.get(b.eip); if (k && k.region === r) this.blockMap.delete(b.eip); }
    this.byEntry.delete(r.entry);
    const i = this.regions.indexOf(r); if (i >= 0) this.regions.splice(i, 1);
    for (const p of r.pages) {
      const s = this.pageRegions.get(p);
      if (s) { s.delete(r); if (!s.size) { this.pageRegions.delete(p); this.mem.u8[SMC_MAP_BASE + p] &= SMC_NEXT; if (p > 0) this.mem.u8[SMC_MAP_BASE + p - 1] &= ~SMC_NEXT; } }
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
  remaining() { return this.mem.i32[this.cpu.b4 + ST.ICOUNT / 4]; }

  /** Fold the thread's chained-transition counter into the stats. */
  /** @param {number} b4 the state block's address / 4 (CpuState.b4) */
  harvest(b4) {
    const n = this.mem.u32[b4 + ST.TRANSITIONS / 4];
    if (n) { this.stats.chained += n; this.mem.u32[b4 + ST.TRANSITIONS / 4] = 0; }
    if (this.opts.profile) {
      const p = (this.stats.prof ??= Object.fromEntries(JIT_PROF.map((k) => [k, 0])));
      JIT_PROF.forEach((k, i) => { const a = b4 + ST.PROF / 4 + i; p[k] += this.mem.u32[a]; this.mem.u32[a] = 0; });
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
    const m = this.mem, b4 = cpu.b4; // (the state block by its word index, a small integer: see CpuState.b4)
    m.i32[b4 + ST.ICOUNT / 4] = Math.min(opts.maxInsns ?? 1e9, 0x7fffffff);
    m.u32[b4 + ST.LZ_OP / 4] = 0;
    m.i32[b4 + ST.STOP_AT / 4] = stopAt; // -1 (0xffffffff) when unused: never a jump target
    cpu.exit = EXIT.NONE;
    for (;;) {
      let r;
      try {
        r = this.runtime.run(0, b4); // (the dispatcher reads EIP from the state block)
      } catch (e) {
        // WASM trap: treat as a memory fault at an unknown instruction inside the current region
        // (the state block holds the registers as of the last dispatcher entry / non-chained exit)
        this.harvest(b4);
        this.materialize();
        this.lastFault = e;
        cpu.exit = EXIT.FAULT; cpu.exitArg = 14;
        return EXIT.FAULT;
      }
      this.harvest(b4);
      // Flags are folded eagerly at every exit to JS: leaving them pending in memory while JS runs made the
      // game's startup spin in an SEH continuation loop (root cause not isolated; the on-demand fold in
      // CpuState.eflags stays as a safety net).
      this.materialize();
      if (r === EXIT_TRANSLATE) {
        const eip = cpu.eip;
        if (eip >= THUNK_BASE && eip < THUNK_END) { cpu.exit = EXIT.THUNK; cpu.exitArg = ((eip - THUNK_BASE) / THUNK_SIZE) | 0; return EXIT.THUNK; }
        // debugging (--interp-range): code in these ranges runs in the reference interpreter, charged to the budget
        const ranges = this.opts.interpRanges;
        if (ranges && ranges.some(([lo, hi]) => eip >= lo && eip < hi)) {
          this.interp.cpu = cpu;
          let n = 0, s = EXIT.NONE;
          const budget = m.read32(cpu.base + ST.ICOUNT) | 0;
          do { cpu.exit = EXIT.NONE; s = this.interp.step(); n++; } while (s === EXIT.NONE && n < Math.max(1, budget) && ranges.some(([lo, hi]) => cpu.eip >= lo && cpu.eip < hi));
          m.write32(cpu.base + ST.ICOUNT, budget - n);
          this.stats.interpRangeSteps = (this.stats.interpRangeSteps ?? 0) + n;
          if (s !== EXIT.NONE) { this.lastFault = this.interp.lastFault; return s; }
          if ((budget - n) <= 0) { cpu.exit = EXIT.TIMESLICE; return EXIT.TIMESLICE; }
          continue;
        }
        if (!this.interp.executable(eip)) { // (no memory there: an access violation at the target, see Interp.executable)
          this.lastFault = { message: `execution at 0x${(eip >>> 0).toString(16)}: no memory there`, vector: 14, faultAddr: eip >>> 0 };
          cpu.exit = EXIT.FAULT; cpu.exitArg = 14;
          return EXIT.FAULT;
        }
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
        if (this.stepHist) { const k = cpu.eip >>> 0; this.stepHist.set(k, (this.stepHist.get(k) ?? 0) + 1); this.stepSample?.(cpu); } // (diagnostics: which instructions)
        const s = this.interp.step();
        this.stats.steps = (this.stats.steps ?? 0) + 1;
        if (s !== EXIT.NONE) { this.lastFault = this.interp.lastFault; return s; }
        continue;
      }
      if (r === EXIT_FPUMODE) {
        // a region specialized for one x87 mode entered under another (code shared by threads in different modes:
        // the C runtime, a sound decoder): add a version specialized for this mode behind the last one (up to
        // MAX_FPU_VERSIONS), else replace the region by one testing the mode at run time
        this.stats.fpuModeMisses = (this.stats.fpuModeMisses ?? 0) + 1;
        const h = this.hashLookup(cpu.eip), first = h && this.byFn.get(h.fnIdx);
        const mode = this.mem.read16(cpu.base + ST.FPU_CW) & 0xf00;
        if (first && !first.first && first.fpc !== null && this.chaining && this.opts.fpuVersions !== false) {
          const versions = (first.versions ??= [first]);
          if (versions.length < MAX_FPU_VERSIONS && !versions.some((v) => v.fpc === mode) && this.nextFn < JIT_ALT_SLOTS && versions.every((v) => v.fnIdx < JIT_ALT_SLOTS)) {
            const v = this.translate(first.entry, { first, fpc: mode });
            if (v.blocks.length === first.blocks.length && v.blocks.every((b, i) => b.eip === first.blocks[i].eip)) {
              this.mem.write32(JIT_ALT_BASE + 4 * versions[versions.length - 1].fnIdx, v.fnIdx + 1);
              versions.push(v);
              this.stats.fpuVersions = (this.stats.fpuVersions ?? 0) + 1;
              continue;
            }
            versions.push(v); // (different blocks: dropped with the family below)
          }
        }
        this.opts.warn?.(`x87 region ${cpu.eip.toString(16)} now tests the FPU mode at run time: entered under mode 0x${mode.toString(16)}, ${first ? `versions for ${(first.versions ?? [first]).map((v) => v.fpc === null ? 'generic' : '0x' + v.fpc.toString(16)).join(', ')}${first.first ? ' (entered through a version)' : ''}` : 'no region found for this address'}`);
        if (first) { for (const b of first.blocks) this.genericFpu.add(b.eip); this.dropRegion(first); }
        else this.genericFpu.add(cpu.eip);
        continue;
      }
      if (r === EXIT.NONE) { // a region returned EIP 0 (jump/call/ret to address 0): access violation
        this.lastFault = { message: 'execution at 0x0: no memory there', vector: 14, faultAddr: 0 };
        cpu.exit = EXIT.FAULT; cpu.exitArg = 14;
        return EXIT.FAULT;
      }
      if (r === EXIT.HALT && stopAt === -1 && (cpu.eip >>> 0) === 0xffffffff) { // a transfer to 0xffffffff (the unused stop address; a HLT reports its own address): nothing there either
        this.lastFault = { message: 'execution at 0xffffffff: no memory there', vector: 14, faultAddr: 0xffffffff };
        cpu.exit = EXIT.FAULT; cpu.exitArg = 14;
        return EXIT.FAULT;
      }
      if (r === EXIT.FAULT && !this.lastFault) this.lastFault = { message: `fault ${cpu.exitArg} at ${cpu.eip.toString(16)}`, vector: cpu.exitArg };
      return r;
    }
  }
}
