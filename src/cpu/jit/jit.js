// JIT executor: translates regions on demand, keeps the funcref table + hash table used by the
// WASM dispatcher, and exposes the same run() interface as the interpreter.
import { EXIT, ST, CpuState } from '../state.js';
import { THUNK_BASE, THUNK_END, THUNK_SIZE, JIT_HASH_BASE, JIT_HASH_BITS, SMC_MAP_BASE, SMC_CODE, SMC_WATCH, SMC_NEXT, SMC_NULL, JIT_ALT_BASE, JIT_ALT_SLOTS } from '../memory.js';
import { NULL_PAGE_END, USER_END } from '../nullpage.js';
import { d3dxFastId } from './fast-d3dx.js';
import { buildRuntime, materializeFlags, supportsReturnCall, EXIT_TRANSLATE, EXIT_FPUMODE, EXIT_STEP, HASH_ENTRY, HASH_PROBES, FAST_TABLE, FAST_NAMES, PROC_CONSTS, MATH_KERNELS, FID_DEFER, DEFER_SPEC, DEFER_SPECS, FID_ADDREF, FID_RELEASE, FID_PARAM_DESC, DEFER_RAW, DEFER_QUEUE } from './runtime.js';
import { translateRegion, buildRegionModule, JIT_PROF, PROF_OPS_BASE, JIT_DEFAULTS, profOffset, VisitSlots, x87ModeOf, X87_MODE_TOP } from './translate.js';
import { OP_NAMES, OP, OT, decode } from '../decoder.js';
import { RangeHeat, VISITED } from './heat.js';
import { acct, C as ACCT } from '../../core/frame-acct.js';
import './translate-x87.js';
import './translate-sse-float.js';
import './translate-sse-int.js';

const CONSOLIDATE_EVERY = 128;
/**
 * Cold tier (Jit.runCold): instructions interpreted from one missed entry before it is translated on this thread
 * (code that turns out hot); until then its translation is asked of the background worker.
 */
const COLD_LIMIT = 1500;
const COLD_CONTINUE = -1, COLD_TRANSLATE = -2;
/** instructions the cold tier never interprets (memory written outside their operands, or rare): translated */
const COLD_NEVER = new Uint8Array(Object.keys(OP).length);
for (const k of ['MOVS', 'STOS', 'CMPS', 'SCAS', 'LODS', 'INS', 'OUTS', 'FXSAVE', 'FXRSTOR', 'FLDENV', 'FNSTENV', 'FRSTOR', 'FNSAVE', 'MASKMOVQ', 'MASKMOVDQU', 'ENTER', 'SYSENTER', 'INT', 'INT3', 'INTO', 'IRET', 'CALLF', 'JMPF', 'RETF', 'HLT', 'UD2', 'INVALID']) if (OP[k] !== undefined) COLD_NEVER[OP[k]] = 1;
/** instructions writing below ESP (at most 32 bytes: PUSHA) */
const COLD_PUSHES = new Uint8Array(Object.keys(OP).length);
for (const k of ['PUSH', 'PUSHA', 'PUSHF', 'CALL']) if (OP[k] !== undefined) COLD_PUSHES[OP[k]] = 1;
const COLD_BITSTRING = new Set([OP.BT, OP.BTS, OP.BTR, OP.BTC]);
/** addresses the SMC map covers (one byte per 4 KiB page, 0x80000 pages) */
const SMC_MAP_LIMIT = 0x80000000;
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
    this.dbgLong = null; // (debugging, ORTHROS_LONG_STEP_MS: time of the current run by part)
    // cold tier (runCold): missed entries -> instructions interpreted from them; its decodes by address (with their
    // bytes); entries to ask of the background worker
    // (testing, Node: ORTHROS_JIT_RANDOM_HEAT=<seed> gives every Jit a pseudo-random heat — about a quarter of the
    // addresses never ran — so that whole test suites run with regions cut at cold exits, see heat.js)
    /** code heat shaping the regions (heat.js: RangeHeat, a Map of counts, or null) and this thread's visit flags */
    this.heat = null; this.visitSlots = new VisitSlots();
    const rh = globalThis.process?.env?.ORTHROS_JIT_RANDOM_HEAT;
    if (rh) { const k = Number(rh) | 0; const hot = (a) => ((Math.imul((a ^ k) >>> 0, 0x9e3779b1) >>> 29) & 3) !== 0; this.heat = { get: (a) => (hot(a) ? VISITED : 0), has: hot }; }
    this.coldTier = !!opts.coldTier; this.coldLimit = opts.coldLimit ?? COLD_LIMIT; this.cold = new Map(); this.coldDecodes = new Map(); this.coldQueue = [];
    this.table = new WebAssembly.Table({ initial: 4096, element: 'anyfunc' });
    this.shared = typeof SharedArrayBuffer !== 'undefined' && mem.memory.buffer instanceof SharedArrayBuffer; // (see bg-translate.js)
    const rtModule = new WebAssembly.Module(buildRuntime({ profile: !!opts.profile, shared: this.shared, countChains: opts.countChains, tailCalls: supportsReturnCall() }));
    this.runtime = new WebAssembly.Instance(rtModule, { env: { memory: mem.memory, table: this.table, now: opts.now ?? (() => 0), mmTime: opts.mmTime ?? opts.now ?? (() => 0), tickCount: opts.tickCount ?? opts.now ?? (() => 0) } }).exports;
    this.imports = {
      env: {
        memory: mem.memory,
        table: this.table,
        flags: this.runtime.flags,
        round24: this.runtime.round24,
        chain: this.runtime.chain,
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
    this.genericTop = new Set(); // (block addresses of regions translated testing the x87 stack top at run time: see EXIT_FPUMODE)
    /** region entries translated at a miss, [eip, x87 mode assumed (null: none / generic), ms since start] (learnRegions) */
    this.learned = null;
    this.nextFn = 0;
    this.stats = { regions: 0, blocks: 0, native: 0, fallback: 0, translateMs: 0, tEmit: 0, tBuild: 0, tModule: 0, tInstance: 0, tTableSet: 0, tConsolidate: 0, bytes: 0, misses: 0, invalidations: 0, dropped: 0, live: 0, fallbackSteps: 0, chained: 0, inlineApi: 0, consolidations: 0, bgInstallMs: 0, ifcvt: 0, fpuModeMisses: 0, fpuVersions: 0, genericTop: 0, dispatchBlocks: 0, reinserts: 0, steps: 0, prewarmMs: 0, prewarmed: 0, abSwitches: 0, interpRangeSteps: 0, prof: null }; // (every field declared: one hidden class, see Vm's constructor)
    this.fallbackHist = opts.fallbackHist ? new Map() : null; // mnemonic -> interpreter fallback executions (diagnostic)
    this.lastFault = null;
    this.boundaries = null; // extra region boundaries (tests)
    this.pageRegions = new Map(); // page -> Set(region)
    // (fields set later, declared here: one hidden class for the dispatcher's loads, see Vm's constructor)
    this.refFast = null; this.refFastOff = false; this.bg = null; this.stormAt = 0; this.stormCount = 0;
    this.abOpts = null; this.abEpoch = 0; this.watches = null;
    this.clearTables();
  }

  /** Mark a thunk slot as having a WASM fast path (called for every created thunk). */
  markFast(idx, key, def) {
    // (IUnknown::AddRef/Release of every interface Orthros implements: com.js keeps their counts in guest memory)
    const dx = def && this.opts.d3dxFast !== false ? d3dxFastId(key) : undefined;
    // (opts.kernelFast false: the kernel32 fast paths — critical sections, mutexes, TLS, Interlocked... — left to JavaScript, for A/B)
    const fid = !def ? undefined : (this.opts.kernelFast !== false ? FAST_NAMES[key] : undefined) ?? dx ?? (key.startsWith('com.dll!') && this.opts.comRefs !== false ? (key.endsWith('::AddRef') ? FID_ADDREF : key.endsWith('::Release') ? FID_RELEASE : undefined) : undefined);
    const defer = def && this.opts.deferCom !== false ? DEFER_SPECS[key.slice(key.indexOf('!') + 1)] : undefined;
    this.mem.u8[FAST_TABLE + idx] = fid ?? (defer !== undefined ? FID_DEFER : 0);
    this.mem.write32(DEFER_SPEC + 4 * idx, defer ?? 0);
    // (the fast paths of the API-layer work — D3DX math, effect parameter descriptions, raw values — switchable for
    // measurement: setD3dxFast)
    if (dx !== undefined || fid === FID_PARAM_DESC || (defer !== undefined && (defer & DEFER_RAW))) { (this.optFast ??= []).push([idx, this.mem.u8[FAST_TABLE + idx]]); if (this.d3dxFastOff) this.mem.u8[FAST_TABLE + idx] = 0; }
    if (fid === FID_ADDREF || fid === FID_RELEASE) { (this.refFast ??= []).push([idx, fid]); if (this.refFastOff) this.mem.u8[FAST_TABLE + idx] = 0; }
  }
  /** (measurement, Vm.setApiFastPaths) AddRef/Release of Orthros COM objects on the fast path or in JavaScript */
  setRefFast(on) {
    this.refFastOff = !on;
    for (const [idx, fid] of this.refFast ?? []) this.mem.u8[FAST_TABLE + idx] = on ? fid : 0;
  }
  /** (measurement, dbg:ORTHROS_D3DX_FAST_OFF / ORTHROS_API_OPT_OFF) D3DX math (fast-d3dx.js), effect parameter descriptions and raw values on the WASM fast path or in JavaScript */
  setD3dxFast(on) {
    this.d3dxFastOff = !on;
    for (const [idx, fid] of this.optFast ?? []) this.mem.u8[FAST_TABLE + idx] = on ? fid : 0;
    // (the bindings' issued-state filter: runtime.js DEFER_F_TEX / STREAM / IB — back on only once the queue has run: sets
    // queued while it was off did not update the shadow; Vm.drainDeferred ends optOnPending)
    this.optOnPending = on && this.mem.read32(DEFER_QUEUE) !== 0;
    this.mem.write32(PROC_CONSTS + 4, on && !this.optOnPending ? 0 : 1);
  }
  /** Per-process constants used by fast paths. */
  setProcessConsts(processHeapHandle) { this.mem.write32(PROC_CONSTS, processHeapHandle); }

  clearTables() {
    this.mem.fill(JIT_HASH_BASE, HASH_ENTRY << JIT_HASH_BITS, 0);
    this.mem.fill(SMC_MAP_BASE, 0x80000, 0);
    // (the pages never mapped: plain stores there leave their region, see Emitter.smcCheck — harmless for regions
    // translated without null-page checks, whose stores go on)
    this.mem.fill(SMC_MAP_BASE, NULL_PAGE_END >>> 12, SMC_NULL);
    this.mem.fill(SMC_MAP_BASE + (USER_END >>> 12), (0x80000000 - USER_END) >>> 12, SMC_NULL);
    this.regions = [];
    this.pending = [];
    this.blockMap.clear();
    this.byEntry.clear();
    this.pageRegions.clear();
    this.byFn?.clear();
    this.genericFpu?.clear();
    this.genericTop?.clear();
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
    // (frame accounting: a translation ahead of need — prewarm, while the game waits — stays in that category)
    const p = acct.enter(acct.cur === ACCT.ahead ? ACCT.ahead : ACCT.jit);
    try { return this.translateNow(eip, version, assume); } finally { acct.leave(p); }
  }
  translateNow(eip, version, assume) {
    const t0 = performance.now();
    // already translated (its hash entry was evicted): re-insert instead of retranslating
    const known = version ? null : this.blockMap.get(eip);
    if (known) { this.hashInsert(eip, known.region.fnIdx, known.block); this.stats.reinserts = (this.stats.reinserts ?? 0) + 1; return known.region; }
    // translation storm diagnostic: thousands of new regions per second means code is being retranslated
    if (!this.stormAt || t0 - this.stormAt > 1000) { this.stormAt = t0; this.stormCount = 0; }
    if (++this.stormCount === 2000 && this.opts.warn) this.opts.warn(`jit: translation storm (${this.stormCount} regions in ${(t0 - this.stormAt).toFixed(0)} ms) at ${eip.toString(16)}; stats ${JSON.stringify(this.stats)}`);
    // x87 regions are specialized for the precision/rounding control in force when they are first reached (and the
    // stack top: see x87ModeOf)
    let fpcAssume = version ? version.fpc : this.opts.fpuSpecialize === false || this.genericFpu.has(eip) ? null : assume !== undefined ? assume : x87ModeOf(this.mem, this.cpu.base, this.x87Top());
    if (fpcAssume !== null && (fpcAssume & X87_MODE_TOP) && this.genericTop.has(eip)) fpcAssume &= 0xf00;
    // (a version: the first version's blocks, see discoverRegion opts.onlyBlocks)
    const o = this.translateOpts(this.nextFn, fpcAssume);
    if (version) o.onlyBlocks = new Set(version.first.blocks.map((b) => b.eip));
    const { code, blocks, stats, fpcAssume: fpc } = translateRegion(this.mem, eip, o);
    const t1 = performance.now();
    if (stats.inlineApi) this.stats.inlineApi = (this.stats.inlineApi ?? 0) + stats.inlineApi; // (API call sites run inline, see translate.js inlineApiOf)
    if (stats.dispatchBlock) this.stats.dispatchBlocks++; // (regions whose dispatcher is no loop)
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

  /**
   * Measurement switch (harness dbg:ORTHROS_JIT_AB=<json>, empty: back to the defaults): translation options
   * overridden from now on, every translation dropped so that the code runs retranslated under them — an A/B of a
   * translation option within one session (same machine slot, same game state). Called between slices only.
   */
  switchOpts(over) {
    this.abOpts = over && Object.keys(over).length ? over : null;
    for (const r of this.regions) this.table.set(r.fnIdx, null); // (the old modules become garbage)
    this.clearTables();
    // (the cold tier starts over too: an entry it had already asked of the background worker would otherwise be
    // interpreted up to its limit and translated here, every switch adding translation work on this thread)
    this.cold.clear(); this.coldQueue = [];
    this.abEpoch = (this.abEpoch ?? 0) + 1; // (background batches translated before: not installed, see bgInstallNow)
    this.stats.abSwitches = (this.stats.abSwitches ?? 0) + 1;
  }
  /**
   * The x87 mode to translate a learned region for: as learned (an entry learned by an earlier build has no stack top:
   * translated testing it at run time — assuming one would drop and translate again, on the game's thread, every such
   * region entered with another top), without the top when the option is off.
   */
  learnedMode(fpc) {
    if (fpc === null || fpc === undefined) return fpc;
    return this.x87Top() ? fpc : fpc & 0xf00;
  }
  /** are x87 regions specialized for the stack top at their entry (opts.x87Top, see x87ModeOf)? */
  x87Top() { return !!(this.abOpts?.x87Top ?? this.opts.x87Top ?? JIT_DEFAULTS.x87Top); }
  /** the code-shape options of JIT_DEFAULTS given to this Jit (the translator applies the defaults to the others) */
  codeOpts() {
    const o = {};
    for (const k of Object.keys(JIT_DEFAULTS)) if (this.opts[k] !== undefined) o[k] = this.opts[k];
    return o;
  }
  /** translateRegion options of a region at table index `fnIdx` specialized for x87 mode `fpcAssume` (null: generic) */
  translateOpts(fnIdx, fpcAssume) {
    if (this.abOpts) return { ...this.translateOptsBase(fnIdx, fpcAssume), ...this.abOpts };
    return this.translateOptsBase(fnIdx, fpcAssume);
  }
  translateOptsBase(fnIdx, fpcAssume) {
    return { boundaries: this.boundaries, interpRanges: this.opts.interpRanges, smc: this.opts.smc !== false, chain: this.chaining, profile: this.opts.profile, fnIdx, fpcAssume, nestLoops: this.opts.nestLoops, countChains: this.opts.countChains, inlineApi: this.opts.inlineApi, blockCounts: this.opts.blockCounts, deadExitFlags: this.opts.deadExitFlags, heat: this.heat ?? null, visitSlots: this.visitSlots, ...this.codeOpts() };
  }
  /**
   * The live region holding `eip` (a region entry, else the region with a block starting there, else one whose block
   * covers it), or null — debugging listings.
   */
  regionAt(eip) {
    eip >>>= 0;
    const r = this.byEntry.get(eip) ?? this.blockMap.get(eip)?.region;
    if (r) return r;
    for (const x of this.byEntry.values()) if (x.blocks.some((b) => eip >= b.eip && eip < b.end)) return x;
    return null;
  }
  /**
   * Block heat (measurement, opts.coldExits): the guest instructions of the blocks that ran in the live translations
   * made with block counters, with their execution counts (summed over the regions holding them). Translations from
   * now on leave out of a region the successors a counted run never took (see discoverRegion). Returns the map's size.
   */
  collectHeat() {
    const heat = new Map();
    for (const r of this.regions) {
      const cs = this.blockCounts(r); if (!cs) continue;
      for (const b of r.blocks) {
        const n = cs[b.index]; if (!n) continue;
        for (let a = b.eip; a < b.end;) { heat.set(a, (heat.get(a) ?? 0) + n); try { a = decode(this.mem, a).next; } catch { break; } }
      }
    }
    this.heat = heat;
    return heat.size;
  }
  /**
   * Add [lo, hi) ranges (pairs) of code known to have run to the heat that shapes the regions translated from now on
   * (here and in the background translator).
   */
  heatAdd(pairs) {
    if (!pairs?.length) return;
    if (!(this.heat instanceof RangeHeat)) this.heat = new RangeHeat();
    this.heat.addPairs(pairs);
    this.bg?.port.postMessage({ type: 'heat', pairs: Int32Array.from(pairs) });
  }
  /**
   * The blocks whose visit flag (opts.visit) was set since the last call, as pairs lo, hi, ... (added to the heat);
   * each block is reported once.
   */
  harvestVisits() {
    const u8 = this.mem.u8, out = [], seen = new Set();
    for (const r of this.regions) {
      const v = r.visits; if (!v) continue;
      let left = 0;
      for (const e of v) {
        if (e[2] < 0) continue;
        if (u8[e[2]]) { if (!seen.has(e[0])) { seen.add(e[0]); out.push(e[0], e[1]); } e[2] = -1; } else left++;
      }
      if (!left) r.visits = null;
    }
    this.heatAdd(out);
    return out;
  }
  /** block execution counts of a region translated with opts.blockCounts (by block index), or null */
  blockCounts(region) {
    if (!(region.counters >= 0)) return null;
    const u32 = this.mem.u32, w = region.counters >>> 2;
    // (by block index — the emission order — while region.blocks is in address order)
    const out = new Array(region.blocks.length).fill(0);
    for (const b of region.blocks) out[b.index] = u32[w + b.index];
    return out;
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
    const region = { entry: eip, pages: [...pages], blocks, fnIdx, code, fpc, calls: stats.calls, counters: stats.counters ?? -1, visits: stats.visits ?? null, first: version?.first ?? null, versions: null };
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
      this.mem.u8[SMC_MAP_BASE + p] |= SMC_CODE; // (SMC_NEXT and a write watch kept)
      if (p > 0) this.mem.u8[SMC_MAP_BASE + p - 1] |= SMC_NEXT;
      let s = this.pageRegions.get(p); if (!s) { s = new Set(); this.pageRegions.set(p, s); } s.add(region);
    }
    this.stats.regions++; this.stats.blocks += blocks.length; this.stats.native += stats.native; this.stats.fallback += stats.fallback; this.stats.ifcvt += stats.ifcvt ?? 0;
    return region;
  }

  // ------------------------------------------------------------------ background translation
  /**
   * Translate ahead in another worker (bg-translate.js) that shares the guest memory: `port` is that worker. Regions
   * come back compiled, in batches (one module each), and are installed by bgInstall() when their code bytes still
   * equal the ones translated.
   */
  attachBackground(port, cache = null) {
    this.bg = { port, nextId: 1, inflight: new Map(), sent: 0, installed: 0, rejected: 0, covered: 0, bgMs: 0, compileMs: 0, translateMs: 0, cacheHits: 0, cache: null };
    // (`cache`: the persistent cache of translations, see code-cache.js — { name, sources }, or null)
    port.postMessage({ type: 'init', memory: this.mem.memory, cache, opts: { smc: this.opts.smc !== false, chain: this.chaining, profile: !!this.opts.profile, nestLoops: this.opts.nestLoops, countChains: this.opts.countChains, inlineApi: this.opts.inlineApi, interpRanges: this.opts.interpRanges, blockCounts: this.opts.blockCounts, deadExitFlags: this.opts.deadExitFlags, ...this.codeOpts() } });
    if (this.heat instanceof RangeHeat) port.postMessage({ type: 'heat', pairs: this.heat.pairs() }); // (the heat known so far)
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
      if (this.opts.interpRanges?.some(([lo, hi]) => eip >= lo && eip < hi)) continue; // (debugging: left to the interpreter)
      let mode = this.opts.fpuSpecialize === false || this.genericFpu.has(eip) ? null : this.learnedMode(fpc);
      if (mode !== null && mode !== undefined && this.genericTop.has(eip)) mode &= 0xf00;
      items.push({ eip, fpc: mode === null ? null : fpc, mode, fnIdx: this.reserveFn() }); // (fpc: as learned, for the reports below)
    }
    if (!items.length) return 0;
    const id = bg.nextId++;
    bg.inflight.set(id, items.length); bg.sent += items.length;
    (bg.epochOf ??= new Map()).set(id, this.abEpoch ?? 0); // (translated under the options of now: see switchOpts)
    bg.port.postMessage({ type: 'batch', id, items, over: this.abOpts }); // (the in-session options too: one block numbering for the versions of a region, see EXIT_FPUMODE)
    return items.length;
  }
  /** A batch from the background worker: each region whose bytes are unchanged and not translated meanwhile is installed. */
  bgInstall(m) {
    const p = acct.enter(ACCT.install);
    try { this.bgInstallNow(m); } finally { acct.leave(p); }
  }
  bgInstallNow(m) {
    const bg = this.bg; if (!bg || !bg.inflight.has(m.id)) return;
    bg.inflight.delete(m.id);
    bg.bgMs += m.ms ?? 0; bg.compileMs += m.compileMs ?? 0; bg.translateMs += m.translateMs ?? 0; bg.cacheHits += m.cacheHits ?? 0; if (m.cache) bg.cache = m.cache;
    const epoch = bg.epochOf?.get(m.id) ?? 0; bg.epochOf?.delete(m.id);
    // (a batch not installed as a whole: none of its regions covers its blocks for the worker any more)
    const dropAll = () => { const l = m.items.filter((it) => it.k >= 0).map((it) => [it.eip, it.blocks.map((b) => b.eip)]); if (l.length) bg.port.postMessage({ type: 'uncover', regions: l }); };
    // Entries the worker skipped as blocks of a region it translated before (see bg-translate.js), looked at once this
    // batch's regions are installed (a batch made only of them comes back without a module). Held by another region:
    // counted, and reported (the server need not list them). Not held — that region was not installed: its code
    // changed, or the entry was translated here first —: asked again, once (its own region). Held by its own region
    // (translated here at a miss meanwhile): a learned entry like any other.
    const covered = (uncover) => {
      let again = null;
      for (const it of m.items) {
        if (!it.covered) continue;
        const at = this.blockMap.get(it.eip);
        if (!at) {
          if (!(bg.again ??= new Set()).has(it.eip)) { bg.again.add(it.eip); (again ??= []).push([it.eip, it.fpc]); } else bg.covered++;
        } else {
          bg.covered++;
          if (at.region.entry !== it.eip) this.coveredLearned?.push([it.eip, it.fpc]);
        }
      }
      if (uncover) bg.port.postMessage({ type: 'uncover', regions: uncover });
      if (again) { bg.sent -= again.length; this.bgPrewarm(again); } // (after the 'uncover' above: the worker sees it first)
    };
    if (!m.module || epoch !== (this.abEpoch ?? 0)) { dropAll(); covered(null); return; }
    const t0 = performance.now();
    let inst;
    try { inst = new WebAssembly.Instance(m.module, this.imports); } catch (e) { dropAll(); covered(null); this.opts.warn?.(`jit: background batch failed: ${e.message}`); return; }
    const u8 = this.mem.u8;
    let uncover = null;
    for (const it of m.items) {
      if (it.covered || it.k < 0) continue; // (skipped: see above; not translatable)
      // translated here meanwhile (at a miss), or its code changed since the background worker read it
      let same = !this.blockMap.has(it.eip);
      for (let i = 0, o = 0; same && i < it.blocks.length; i++) { const b = it.blocks[i]; for (let a = b.eip; a < b.end; a++, o++) if (u8[a] !== it.snap[o]) { same = false; break; } }
      if (!same) { bg.rejected++; (uncover ??= []).push([it.eip, it.blocks.map((b) => b.eip)]); continue; }
      this.table.set(it.fnIdx, inst.exports['r' + it.k]);
      this.register(it.eip, it.blocks, it.fnIdx, null, it.fpc, it.stats);
      bg.installed++;
    }
    covered(uncover);
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
    if (this.opts.interpRanges?.some(([lo, hi]) => eip >= lo && eip < hi)) return false; // (debugging: left to the interpreter)
    const t0 = performance.now();
    try { this.translate(eip, null, this.learnedMode(fpc)); } catch { return false; } finally { this.stats.prewarmMs = (this.stats.prewarmMs ?? 0) + performance.now() - t0; }
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
  /**
   * SMC exit on a watched page: record the writer; returns true when handled (nothing to invalidate). A page that
   * gained translated code after its watch was set is not handled here: its code must be invalidated.
   */
  watchHit(addr, eip, len = 16, thread = null) {
    if (!this.watches) return false;
    for (let q = addr >>> 12; q <= (addr + len - 1) >>> 12; q++) if (this.pageRegions.has(q)) return false;
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
      if (s) { s.delete(r); if (!s.size) { this.pageRegions.delete(p); this.mem.u8[SMC_MAP_BASE + p] &= ~SMC_CODE; if (p > 0) this.mem.u8[SMC_MAP_BASE + p - 1] &= ~SMC_NEXT; } }
    }
    this.table.set(r.fnIdx, null);
    this.byFn.delete(r.fnIdx);
  }

  // ------------------------------------------------------------------ fallback
  fallback(eip) {
    // (frame accounting: a sample of the fallbacks is timed, the others counted)
    if (!acct.interpTimed()) return this.fallbackNow(eip);
    const p = acct.enter(ACCT.interp), a0 = acct.acc[ACCT.interp];
    try { return this.fallbackNow(eip); } finally { acct.interpEnd(p, a0); }
  }
  fallbackNow(eip) {
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

  // ------------------------------------------------------------------ cold tier
  /**
   * A miss at `eip` with a background translator (coldTier): instead of translating here — a frame of new code
   * (a menu opened, a unit selected) translated hundreds of regions on the game thread — the region is asked of the
   * background worker and its code interpreted until it is installed: from block to block while the next one is not
   * translated, up to COLD_LIMIT instructions per entry (the time of one translation); an entry that reaches the limit
   * (a loop, code called often) is translated here as before. The interpreter is exact; what it would not do exactly
   * here is left to translation: an instruction writing a page that holds translated code (no SMC exit from the
   * interpreter — its operands' and the stack's pages are checked before each one), string and state-saving
   * instructions (memory beyond their operands), bit strings. A decode the interpreter cached is checked against the
   * bytes it was decoded from (code rewritten where nothing is translated). Returns COLD_CONTINUE (dispatch on),
   * COLD_TRANSLATE (translate cpu.eip here) or an exit code.
   */
  runCold(eip) {
    const p = acct.enter(ACCT.interp);
    try { return this.runColdNow(eip); } finally { acct.leave(p); }
  }
  runColdNow(eip) {
    const cpu = this.cpu, m = this.mem, interp = this.interp, b4 = cpu.b4, cold = this.cold;
    let n = cold.get(eip);
    if (n === undefined) {
      if (this.coldSafe(eip) === null) return COLD_TRANSLATE; // (nothing to ask of the background worker: translated here)
      if (cold.size >= 0x40000) cold.clear();
      n = 0; cold.set(eip, 0);
      const fpc = x87ModeOf(m, cpu.base, this.x87Top());
      this.coldQueue.push([eip, fpc]);
      if (this.learned && this.learned.length < 65536) this.learned.push([eip, fpc, Math.round(performance.now())]);
      this.stats.coldEntries = (this.stats.coldEntries ?? 0) + 1;
    } else if (n >= this.coldLimit) { cold.delete(eip); this.stats.coldHot = (this.stats.coldHot ?? 0) + 1; return COLD_TRANSLATE; }
    interp.cpu = cpu;
    const budget = m.i32[b4 + ST.ICOUNT / 4], stopAt = m.u32[b4 + ST.STOP_AT / 4];
    let k = 0, s = EXIT.NONE;
    for (;;) {
      const insn = this.coldSafe(cpu.eip >>> 0);
      if (insn === null) break;
      cpu.exit = EXIT.NONE;
      s = interp.stepDecoded(insn); k++;
      if (s !== EXIT.NONE) break;
      if (k >= budget || n + k >= this.coldLimit) break;
      // (after a transfer: translated code, a thunk or the stop address end the interpretation; a fall-through into a
      // translated block goes on interpreting, as exact)
      const e = cpu.eip >>> 0;
      if (e !== insn.next && (e === stopAt || (e >= THUNK_BASE && e < THUNK_END) || this.blockMap.has(e))) break;
    }
    cold.set(eip, n + k);
    m.i32[b4 + ST.ICOUNT / 4] = budget - k;
    this.stats.coldSteps = (this.stats.coldSteps ?? 0) + k;
    if (s !== EXIT.NONE) { this.lastFault = interp.lastFault; return s; }
    if (k === 0) return COLD_TRANSLATE; // (the first instruction is not for the cold tier)
    if (k >= budget) { cpu.exit = EXIT.TIMESLICE; return EXIT.TIMESLICE; }
    return COLD_CONTINUE;
  }
  /** The instruction at `a` when the cold tier may interpret it now (see runCold), else null; its decode checked or redone. */
  coldSafe(a) {
    const u8 = this.mem.u8, decodes = this.coldDecodes;
    // the cold tier's own decodes (not the interpreter's cache), each with the bytes it was made from
    let d = decodes.get(a), insn = null;
    if (d !== undefined) {
      const r = d.raw;
      let same = true;
      for (let i = 0; i < r.length; i++) if (u8[a + i] !== r[i]) { same = false; break; }
      if (same) insn = d.insn;
    }
    if (insn === null) {
      try { insn = decode(this.mem, a); } catch { return null; } // (undecodable: the translation path reports it)
      if (insn.next <= a || insn.next - a > 15) return null;
      if (decodes.size >= 0x40000) decodes.clear(); // (bounded: decoded again)
      decodes.set(a, { insn, raw: u8.slice(a, insn.next) });
    }
    const interp = this.interp;
    const op = insn.op;
    if (COLD_NEVER[op]) return null;
    const map = SMC_MAP_BASE, bits = SMC_CODE | SMC_WATCH;
    for (const o of insn.ops) {
      if (o.t !== OT.MEM) continue;
      if (COLD_BITSTRING.has(op) && insn.ops[1]?.t !== OT.IMM) return null;
      const ea = interp.ea(o), end = (ea + Math.max(o.size, 16) - 1) >>> 0;
      if (end >= SMC_MAP_LIMIT || end < ea || ((u8[map + (ea >>> 12)] | u8[map + (end >>> 12)]) & bits)) return null; // (outside the map: a fault, reported by translated code)
    }
    if (COLD_PUSHES[op]) { const sp = this.cpu.esp >>> 0; if (sp < 32 || sp > SMC_MAP_LIMIT || ((u8[map + ((sp - 32) >>> 12)] | u8[map + ((sp - 1) >>> 12)]) & bits)) return null; }
    return insn;
  }
  /** The cold tier's entries since the last call to the background worker (the worker calls this between slices). */
  flushCold() {
    const q = this.coldQueue;
    if (!q.length || !this.bg) return 0;
    this.coldQueue = [];
    let sent = 0;
    for (let i = 0; i < q.length; i += 48) sent += this.bgPrewarm(q.slice(i, i + 48));
    this.stats.coldRequests = (this.stats.coldRequests ?? 0) + sent;
    return sent;
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
      JIT_PROF.forEach((k, i) => { const a = b4 + profOffset(i) / 4; p[k] += this.mem.u32[a]; this.mem.u32[a] = 0; });
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
      const dbg = this.dbgLong, tw = dbg ? performance.now() : 0, ew = dbg ? cpu.eip : 0;
      try {
        r = this.runtime.run(0, b4); // (the dispatcher reads EIP from the state block)
        if (dbg) { const d = performance.now() - tw; dbg.wasm += d; dbg.calls++; if (d > dbg.maxWasm) { dbg.maxWasm = d; dbg.maxWasmEip = ew; dbg.maxWasmExit = r; dbg.maxWasmEnd = cpu.eip; } }
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
          do { if (this.onInterpRange) this.onInterpRange(cpu.eip >>> 0, cpu); cpu.exit = EXIT.NONE; s = this.interp.step(); n++; } while (s === EXIT.NONE && n < Math.max(1, budget) && ranges.some(([lo, hi]) => cpu.eip >= lo && cpu.eip < hi));
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
        if (this.coldTier && this.bg) {
          const c = this.runCold(eip);
          if (c === COLD_CONTINUE) continue;
          if (c !== COLD_TRANSLATE) return c;
        }
        this.stats.misses++;
        const tt = this.dbgLong ? performance.now() : 0;
        try {
          this.translate(eip);
          if (this.dbgLong) { this.dbgLong.tr += performance.now() - tt; this.dbgLong.trN++; }
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
        let s;
        if (acct.interpTimed()) { const p = acct.enter(ACCT.interp), a0 = acct.acc[ACCT.interp]; try { s = this.interp.step(); } finally { acct.interpEnd(p, a0); } }
        else s = this.interp.step();
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
        // (the mode the guard met, with the region's stack top: EXIT_ARG, see translate.js x87ModeOf)
        let mode = this.mem.read32(cpu.base + ST.EXIT_ARG);
        if (!this.x87Top()) mode &= 0xf00;
        if (first && !first.first && first.fpc !== null && (mode & X87_MODE_TOP) && (first.versions ?? [first]).some((v) => v.fpc !== null && (v.fpc & X87_MODE_TOP) && (v.fpc & 0xf00) === (mode & 0xf00))) {
          // entered with another stack top under a control word it has a version for: translated again testing the
          // top at run time (entries with varying tops would otherwise run a failing guard before the right version)
          for (const b of first.blocks) this.genericTop.add(b.eip);
          this.dropRegion(first);
          this.stats.genericTop++;
          continue;
        }
        if (first && !first.first && first.fpc !== null && this.chaining && this.opts.fpuVersions !== false) {
          const versions = (first.versions ??= [first]);
          if (this.genericTop.has(first.entry)) mode &= 0xf00;
          if (versions.length < MAX_FPU_VERSIONS && !versions.some((v) => v.fpc === mode) && this.nextFn < JIT_ALT_SLOTS && versions.every((v) => v.fnIdx < JIT_ALT_SLOTS)) {
            const v = this.translate(first.entry, { first, fpc: mode });
            // (the same blocks under the same numbers: the guard of one version passes the block index it was entered
            // with to the next)
            if (v.blocks.length === first.blocks.length && v.blocks.every((b, i) => b.eip === first.blocks[i].eip && b.index === first.blocks[i].index)) {
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
      if (r === EXIT.SMC) {
        const pcAt = cpu.base + ST.EXIT_PC, pc = m.read32(pcAt) >>> 0, a = cpu.exitArg >>> 0;
        if (pc) {
          m.write32(pcAt, 0);
          if (m.u8[SMC_MAP_BASE + (a >>> 12)] & SMC_NULL) {
            // a plain store into a page never mapped (translate.js NC_STORE_SMC): undone — those pages stay zero — and
            // executed again by the interpreter, which raises the access violation at it
            const lenAt = cpu.base + ST.EXIT_LEN, len = m.read32(lenAt) || 16;
            m.write32(lenAt, 0);
            for (let k = a; k < a + len && k < 0x80000000; k++) if (m.u8[SMC_MAP_BASE + (k >>> 12)] & SMC_NULL) m.u8[k] = 0;
            // (an x87 store that pops has popped: the register it stored is still in its slot, valid again one place lower)
            const op = this.interp.fetch(pc).op;
            if (op === OP.FSTP || op === OP.FISTP || op === OP.FISTTP) {
              const top = (m.u8[cpu.base + ST.FPU_TOP] - 1) & 7;
              m.u8[cpu.base + ST.FPU_TOP] = top; m.write16(cpu.base + ST.FPU_TW, m.read16(cpu.base + ST.FPU_TW) | (1 << top));
            }
            cpu.eip = pc; cpu.exit = EXIT.NONE;
            this.interp.cpu = cpu;
            const s = this.interp.step();
            if (s !== EXIT.NONE) { this.lastFault = this.interp.lastFault; return s; }
            continue;
          }
        }
      }
      return r;
    }
  }
}
