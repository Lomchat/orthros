/**
 * Guest debugger command surface (worker side).
 *
 * Thin JS wrapper over the v86 wasm debug primitives (cpu.rs: dbg_*). Drives
 * guest-EIP breakpoints, step-tracing, watch addresses and memory reads. Output
 * is emitted to the console with a `[DBG]`/`[dbg]` prefix so it can be grepped
 * out of the log stream.
 *
 * Reachable two ways:
 *   - directly in the worker DevTools context: `dbg.bp("0x1309e110")`, `dbg.step(200)`, ...
 *   - from the page (and from tooling) via `window.dbg.<cmd>(...)` which posts a
 *     `{type:"dbg"}` message handled in emulator.worker.ts -> handleDbgCommand().
 *
 * Note:
 *   - Breakpoints/step-trace only fire while the JIT is OFF (guest runs through
 *     cycle_internal, where dbg_on_instruction is hooked). dbg.enable() turns JIT off.
 *   - v86 is re-created on each game load, which clears the wasm debug statics.
 *     We keep the intended config here and RE-APPLY it on every v86 init via
 *     globalThis.__applyDbgConfig (called from PreemptionManager.initialize). So
 *     the recommended flow is: set up the config FIRST, then load the game:
 *        dbg.enable(); dbg.bp("0x1309e110"); dbg.stepOnBp(300); dbg.maxDumps(5000);
 *        // then window.loadApp('/apps/ut_demo.wgb')
 */

import { System } from '../system';
import { Galaxy } from '../../modules/galaxy';
import { libHleManager } from '../hle-lib/lib-hle-manager';
import { TimeService } from '../../runtime/time';
import { Logger } from '../logger';
import { EmulatorConfig } from '../emulator-config-manager';
import type { QualityConfig } from '../quality-config';
import { getD3D9PerfSnapshot, resetD3D9Perf } from '../../modules/d3d9/d3d9-perf';
import { devices, stateBlocks } from '../../modules/d3d9/shared-state';
import { d3d9WasmArena, isWasmPathEnabled, setWasmPathEnabled, setArenaVerifyDrainEnabled, setWasmBlocksEnabled } from '../../backends/webgpu/d3d9/d3d9-wasm-arena';
import { windows, getAbsoluteWindowPosition, controlImageHandles, WindowInfo } from '../../modules/user32/shared-state';
import { resolveBitmapRgba } from '../../modules/gdi32/bitmap-resolve';
import { dialogNeedsPointMouseRouting } from '../../modules/user32/dialog-overlay';
import { repaintDialogOverlayIfVisible } from '../../modules/user32/dialog';
import { isGdiSurfaceHidden } from '../../modules/ddraw/gdi-visibility';
import { hpFreezeWatchdog } from './hp-freeze-watchdog';
import { ioTraceRing } from './io-trace-ring';
import { setGuestMemoryStaleGuard, isGuestMemoryStaleGuardEnabled } from '../memory/guest-memory';
import { MEM_GUARD_BASE, MEM_GUARD_SIZE } from '../cpu/emulator-config';
import { getBfmeDxtEncodeCacheFallbacks } from '../hle-lib/libs/bfme/dxt-encode-cache';
import { getD3dxAssembleShaderSamples } from '../../modules/d3dx9';
import { getSurfaceLockDiagnostics, setSurfaceLockDiagnostics } from '../../modules/d3d9/resources';
import {
    getDxCompressedTextureAdvertisement,
    getDxCompressedTextureNegotiationStats,
    setDxCompressedTextureAdvertisement,
} from '../../backends/webgpu/shared/dx-format-support';
import { getD3D9TextureMemoryReport } from '../../modules/d3d9/resource-registry';
import {
    armGuestWorkWindow,
    cancelGuestWorkWindow,
    readGuestOdometer,
    readGuestWorkWindow,
    resetGuestOdometer,
} from './guest-work-window';

interface DbgConfig {
    enabled: boolean;
    bps: number[];
    watches: number[];
    indirect: boolean;
    stepOnBp: number;
    maxDumps: number;
}

const cfg: DbgConfig = {
    enabled: false,
    bps: [],
    watches: [],
    indirect: false,
    stepOnBp: 0,
    maxDumps: 4000,
};

function wasm(): any {
    const p = (globalThis as any).preemption;
    const ex = p?.getWasmExports?.() ?? null;
    if (!ex?.dbg_enable) {
        console.warn("[dbg] wasm debug exports missing — rebuild vendor/v86 (build-wasm.sh)");
        return null;
    }
    return ex;
}

function toAddr(x: number | string): number {
    if (typeof x === "number") return x >>> 0;
    const s = String(x).trim();
    return (s.startsWith("0x") || s.startsWith("0X") ? parseInt(s.slice(2), 16) : parseInt(s, 16)) >>> 0;
}

function addBreakpoint(addr: number): boolean {
    const a = addr >>> 0;
    if (!cfg.bps.includes(a)) {
        cfg.bps.push(a);
    }
    const w = wasm();
    w?.dbg_add_bp(a);
    return true;
}

/** Re-apply the whole stored config onto a (possibly fresh) wasm instance. */
export function applyDbgConfig(w: any): void {
    if (!w?.dbg_enable || !cfg.enabled) return;
    if (w.set_jit_config) { w.set_jit_config(0, 1); if (w.jit_clear_cache_js) w.jit_clear_cache_js(); }
    w.dbg_clear();
    w.dbg_set_max_dumps(cfg.maxDumps >>> 0);
    w.dbg_set_step_on_bp(cfg.stepOnBp >>> 0);
    if (cfg.indirect) w.dbg_set_indirect(1);
    for (const bp of cfg.bps) w.dbg_add_bp(bp >>> 0);
    for (const a of cfg.watches) w.dbg_add_watch(a >>> 0);
    w.dbg_enable(1);
    const jitDisabled = w.get_jit_config ? (w.get_jit_config(0) >>> 0) : -1;
    console.log(`[dbg] re-applied config on v86 init/restart: ${cfg.bps.length} bp, ${cfg.watches.length} watch, stepOnBp=${cfg.stepOnBp}, maxDumps=${cfg.maxDumps}, JIT_DISABLED=${jitDisabled}`);
}

export const dbg = {
    /** Opt-in path/offset trace for Win32 reads and seeks. Disabled by default. */
    ioTrace(on = true, cap = 1024): { enabled: boolean; cap: number } {
        const bounded = Math.max(16, Math.min(16_384, Math.floor(cap)));
        if (on) ioTraceRing.enable(bounded);
        else ioTraceRing.disable();
        return { enabled: on, cap: bounded };
    },
    /** Return the current I/O ring and optionally disable it after the snapshot. */
    ioTraceReport(disable = true): ReturnType<typeof ioTraceRing.snapshot> {
        const rows = ioTraceRing.snapshot();
        if (disable) ioTraceRing.disable();
        return rows;
    },
    romCacheStats(): ReturnType<ReturnType<typeof System.getInstance>['fileSystem']['romCacheStats']> {
        return System.getInstance().fileSystem.romCacheStats();
    },
    /** Enable the debugger. Turns JIT OFF (required) and clears the JIT cache. */
    enable(): void {
        cfg.enabled = true;
        const w = wasm(); if (!w) return;
        if (w.set_jit_config) { w.set_jit_config(0, 1); if (w.jit_clear_cache_js) w.jit_clear_cache_js(); }
        w.dbg_set_max_dumps(cfg.maxDumps >>> 0);
        w.dbg_enable(1);
        console.log("[dbg] ENABLED (JIT off). Config persists across game loads. Commands: bp(eip) stepOnBp(n) step(n) watch(addr,indirect?) read(addr) mem(addr,len) maxDumps(n) clear() disable()");
    },
    /** Targeted breakpoint that KEEPS JIT ON. Relies on the cpu.rs page-gate (page_contains_bp)
     *  to keep only the bp's 4 KiB page interpreted (so dbg_on_instruction fires the <BP>), while
     *  the rest of the guest stays JIT-fast. Lets a bp fire deep in a long boot without the global
     *  JIT-off (dbg.enable) that makes the whole guest crawl. Clears the JIT cache once so any
     *  pre-compiled copy of the bp page is dropped and re-interpreted. */
    bpFast(addr: number | string): boolean {
        const a = (typeof addr === "string" ? parseInt(addr.replace(/^0x/i, ""), 16) : addr) >>> 0;
        cfg.enabled = true;
        if (!cfg.bps.includes(a)) cfg.bps.push(a);
        const w = wasm(); if (!w) return false;
        w.dbg_set_max_dumps((cfg.maxDumps || 1_000_000) >>> 0);
        w.dbg_add_bp(a);
        if (w.jit_clear_cache_js) w.jit_clear_cache_js();   // drop any pre-compiled copy of the bp page
        w.dbg_enable(1);                                     // enable the <BP> dump (does NOT touch JIT)
        console.log(`[dbg] bpFast 0x${a.toString(16)} — JIT stays ON; only the bp page is interpreted (page-gate).`);
        return true;
    },
    /** Disable dumping (JIT stays off until reload). */
    disable(): void { cfg.enabled = false; const w = wasm(); w?.dbg_enable(0); console.log("[dbg] disabled"); },
    /** Clear all breakpoints, watches and the step counter (both config and wasm). */
    clear(): void {
        cfg.bps = []; cfg.watches = []; cfg.indirect = false; cfg.stepOnBp = 0;
        const w = wasm(); w?.dbg_clear(); console.log("[dbg] cleared bps/watches/step");
    },
    /**
     * Get or set graphics quality live (AF, gamma/brightness/contrast/sat, integer/aspect
     * scaling, FXAA/tonemap/vignette, scanlines/crt). No arg = print current; pass a partial
     * to merge + apply on the next frame. Examples:
     *   dbg.quality()                         // show current
     *   dbg.quality({ anisotropy: 16 })       // force 16x AF
     *   dbg.quality({ brightness: 1.3, contrast: 1.1 })
     *   dbg.quality({ aspectMode: 'pillarbox' })
     *   dbg.quality({ crt: true })            // example post-fx
     */
    quality(partial?: Partial<QualityConfig>): QualityConfig {
        const c = EmulatorConfig.getInstance();
        if (partial && typeof partial === "object") c.applyQuality(partial);
        console.log(`[QUALITY] ${JSON.stringify(c.quality)}`);
        return c.quality;
    },
    /** Current guest display configuration, useful when validating a WGB
     *  resolution independently from the host canvas scaling. */
    resolution(): unknown {
        const c = EmulatorConfig.getInstance();
        const out = {
            screen: { ...c.screenResolution },
            supported: c.supportedResolutions.map((mode) => ({ ...mode })),
        };
        console.log(`[dbg][resolution][JSON] ${JSON.stringify(out)}`);
        return out;
    },
    /** Scheduler async-restore history is intentionally opt-in: recording it
     *  formats thread/CPU snapshots on a very hot path. Enable only around a
     *  scheduler investigation, then disable to restore production performance. */
    asyncRestoreTrace(on?: boolean): unknown {
        const scheduler = System.getInstance().scheduler;
        if (!scheduler) return { enabled: false, entries: [] };
        if (typeof on === "boolean") scheduler.setAsyncRestoreTraceEnabled(on);
        const out = {
            enabled: scheduler.isAsyncRestoreTraceEnabled(),
            entries: scheduler.getAsyncRestoreTrace(),
        };
        console.log(`[dbg][asyncRestoreTrace][JSON] ${JSON.stringify(out)}`);
        return out;
    },
    /** Add a breakpoint at a guest linear EIP (number or hex string). */
    bp(eip: number | string): void {
        const a = toAddr(eip);
        addBreakpoint(a);
        console.log(`[dbg] bp @ 0x${a.toString(16)}`);
    },
    /** Quake 2 Z_Free bad-magic breakpoint. Run before launching Q2.
     *  The bad branch is at quake2.exe+0x19600 (0x419600). On the [BP] line,
     *  EAX is the original Z_Free(ptr); after two traced instructions ESI is ptr-0x10.
     */
    q2zfree(step = 18): string {
        (dbg as any).enable();
        const addrs = [
            0x4195f0, // Z_Free entry: mov eax, [esp+4]
            0x4195fe, // bad-magic conditional branch
            0x419600, // push "Z_Free: bad magic"
            0x419607, // call Com_Error
            0x41960c, // Com_Error return address visible on the later stack
        ];
        for (const addr of addrs) {
            addBreakpoint(addr);
            console.log(`[dbg] bp @ 0x${addr.toString(16)}`);
        }
        (dbg as any).stepOnBp(step);
        const msg = `[dbg][q2zfree] Armed Quake2 Z_Free breakpoints: entry=0x4195f0, bad-branch=0x419600, call=0x419607. stepOnBp=${step}. On entry, EAX becomes Z_Free(ptr); at bad branch, EAX is still ptr and ESI is ptr-0x10.`;
        console.log(msg);
        return msg;
    },
    /** Re-apply the stored debugger config onto the live wasm instance. */
    reapply(): void {
        const w = wasm();
        if (!w) return;
        applyDbgConfig(w);
    },
    /** On each breakpoint hit, auto-trace the next N instructions. */
    stepOnBp(n: number): void { cfg.stepOnBp = n >>> 0; const w = wasm(); w?.dbg_set_step_on_bp(n >>> 0); console.log(`[dbg] step-on-bp = ${n}`); },
    /** Immediately arm a trace of the next N interpreted instructions. */
    step(n: number): void { const w = wasm(); w?.dbg_arm_step(n >>> 0); console.log(`[dbg] armed step-trace = ${n}`); },
    /** Watch a guest address: each dump appends its u32. indirect=true also logs *(value) byte. */
    watch(a: number | string, indirect = false): void {
        const x = toAddr(a); cfg.watches.push(x); if (indirect) cfg.indirect = true;
        const w = wasm(); if (w) { w.dbg_add_watch(x); if (indirect) w.dbg_set_indirect(1); }
        console.log(`[dbg] watch [0x${x.toString(16)}]${indirect ? " (indirect: logs *value + byte)" : ""}`);
    },
    /** Cap on total dump lines (runaway-trace guard). Default 4000. */
    maxDumps(n: number): void { cfg.maxDumps = n >>> 0; const w = wasm(); w?.dbg_set_max_dumps(n >>> 0); console.log(`[dbg] maxDumps = ${n}`); },
    /** Read a u32 from guest memory (logs + returns; via postMessage the return is not seen, read the log). */
    read(a: number | string): number {
        const w = wasm(); if (!w) return 0; const x = toAddr(a);
        const v = (w.dbg_read_u32(x) >>> 0);
        console.log(`[dbg] [0x${x.toString(16)}] = 0x${v.toString(16)}`); return v;
    },
    /** Hex-dump len bytes of guest memory from addr. */
    mem(a: number | string, len = 64): void {
        const w = wasm(); if (!w) return; const base = toAddr(a);
        const rows = Math.ceil(len / 16);
        let out = "";
        for (let row = 0; row < rows; row++) {
            let line = `[dbg] 0x${((base + row * 16) >>> 0).toString(16).padStart(8, "0")}:`;
            let ascii = "";
            for (let j = 0; j < 16 && row * 16 + j < len; j++) {
                const b = w.dbg_read_u8((base + row * 16 + j) >>> 0) & 0xff;
                line += " " + b.toString(16).padStart(2, "0");
                ascii += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".";
            }
            out += line + "  " + ascii + "\n";
        }
        console.log(out.trimEnd());
    },
    /** Write a u32 to guest memory (diagnostic poke). Logs old→new. */
    poke32(a: number | string, val: number | string): void {
        try {
            const mem: Uint8Array | undefined = System.getInstance().process?.getCurrentMemory?.();
            if (!mem) { console.warn('[dbg] poke32: no guest memory'); return; }
            const addr = toAddr(a); const v = toAddr(val) >>> 0;
            if (addr + 4 > mem.length) { console.warn('[dbg] poke32: oob'); return; }
            const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const old = dv.getUint32(addr, true) >>> 0;
            dv.setUint32(addr, v, true);
            console.log(`[dbg] poke32 [0x${addr.toString(16)}] 0x${old.toString(16)} -> 0x${v.toString(16)}`);
        } catch (e) { console.warn('[dbg] poke32 err', e); }
    },
    /** Write a f32 to guest memory (diagnostic poke). Logs old→new. */
    pokef32(a: number | string, val: number): void {
        try {
            const mem: Uint8Array | undefined = System.getInstance().process?.getCurrentMemory?.();
            if (!mem) { console.warn('[dbg] pokef32: no guest memory'); return; }
            const addr = toAddr(a);
            if (addr + 4 > mem.length) { console.warn('[dbg] pokef32: oob'); return; }
            const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
            const old = dv.getFloat32(addr, true);
            dv.setFloat32(addr, +val, true);
            console.log(`[dbg] pokef32 [0x${addr.toString(16)}] ${old} -> ${+val}`);
        } catch (e) { console.warn('[dbg] pokef32 err', e); }
    },

    /** Query the live wasm JIT state (1 = JIT disabled = debugger hook active). */
    jit(): void {
        const w = wasm(); if (!w) return;
        const d = w.get_jit_config ? (w.get_jit_config(0) >>> 0) : -1;
        const rf = w.get_relaxed_fpu ? (w.get_relaxed_fpu() >>> 0) : -1;
        console.log(`[dbg] live JIT_DISABLED=${d} (1=off/hook-active, 0=on) relaxedFpu=${rf}`);
    },
    /** Bisection control: toggle the JIT on/off WITHOUT touching the dbg
     *  instruction hook. Clears the cache so the change takes effect on hot blocks.
     *  Unlike enable()/disable() this leaves DBG_ENABLED alone. */
    jitOn(): void {
        const w = wasm(); if (!w) return;
        if (w.set_jit_config) w.set_jit_config(0, 0);
        if (w.jit_clear_cache_js) w.jit_clear_cache_js();
        console.log("[dbg] JIT ON + cache cleared");
    },
    jitOff(): void {
        const w = wasm(); if (!w) return;
        if (w.set_jit_config) w.set_jit_config(0, 1);
        if (w.jit_clear_cache_js) w.jit_clear_cache_js();
        console.log("[dbg] JIT OFF + cache cleared");
    },
    /** Clear the JIT block cache without changing JIT on/off (stale-cache test). */
    jitClear(): void {
        const w = wasm(); if (!w) return;
        if (w.jit_clear_cache_js) w.jit_clear_cache_js();
        console.log("[dbg] JIT cache cleared (JIT state unchanged)");
    },
    /** Generic set_jit_config(index,value) + clear cache, for bisecting JIT knobs.
     *  index: 0=JIT_DISABLED 1=MAX_PAGES 2=JIT_USE_LOOP_SAFETY 3=MAX_EXTRA_BASIC_BLOCKS
     *  4=JIT_BLOCK_CHAINING 5=JIT_DEAD_FLAG_ELISION 6=JIT_INDIRECT_REGIONS
     *  7=JIT_INDIRECT_REGION_MIN_SHARE(%) 8=JIT_INDIRECT_REGION_MAX_PAGES
     *  9=JIT_FASTMEM_READS 10=JIT_X87_LOCALS 11=JIT_PUSH_RUN_COALESCING
     *  12=JIT_RET_CHAINING 13=JIT_RET_SPECULATION 14=JIT_RET_SPEC_MAX_INSTR
     *  30=JIT_DYNAMIC_CHAIN_SITE_PIC
     *  15=JIT_TIER2_THRESHOLD 16=JIT_TIER2_RET_SPEC_MAX_INSTR
     *  17=JIT_TIER2_MAX_PAGES 18=JIT_FASTMEM_READ_SPLIT
     *  19=JIT_FASTMEM_WRITES 20=JIT_TIER2_PAGE_SET_CAP 21=JIT_FLAG_LOCALS
     *  22=JIT_INLINE_INTRA_MODULE_DISPATCH 23=JIT_TIER2_REGIONS
     *  24=JIT_TIER2_ADAPTIVE 25=JIT_MAX_PENDING_COMPILES
     *  26=JIT_THRESHOLD 27=JIT_TIER2_LEAF_CALL_FUSION.
     *  35=JIT_REP_MOVS_REDUCED_SPILL 36=JIT_SYNC_BOUNDARY_CONTINUATION
     *  37=JIT_DEFERRED_COMPILE_QUEUE 38=JIT_CONTIGUOUS_CROSS_PAGE_INSTRUCTIONS
     *  39=JIT_X87_WRITEBACK 40=JIT_FPU_ORDERED_COMPARE_FIRST
     *  41=JIT_DYNAMIC_CHAIN_BUDGET_FAST_EXIT.
     *  Then reads all knobs back. */
    jitcfg(index: number, value: number): void {
        const w = wasm(); if (!w) return;
        if (w.set_jit_config) w.set_jit_config(index >>> 0, value >>> 0);
        if (w.jit_clear_cache_js) w.jit_clear_cache_js();
        const g = (i: number) => (w.get_jit_config ? (w.get_jit_config(i) >>> 0) : -1);
        console.log(`[dbg] set_jit_config(${index},${value}) + clear. now: DISABLED=${g(0)} MAX_PAGES=${g(1)} LOOP_SAFETY=${g(2)} MAX_EXTRA_BB=${g(3)} BLOCK_CHAINING=${g(4)} DEAD_FLAG_ELISION=${g(5)} INDIRECT_REGIONS=${g(6)} REGION_PAGES=${g(8)} FASTMEM_READS=${g(9)} X87_LOCALS=${g(10)} PUSH_RUN=${g(11)} INLINE_DISPATCH=${g(22)} X87_WRITEBACK=${g(39)} FPU_ORDERED_COMPARE=${g(40)} DYNAMIC_BUDGET_FAST_EXIT=${g(41)}`);
    },
    /** Avoid the redundant shared-resolver call after generated code has already
     *  observed an exhausted scheduler budget (JIT config 41). */
    jitDynamicBudgetFastExit(on = true): { enabled: number } | null {
        const w = wasm(); if (!w?.set_jit_config) return null;
        const pm = (globalThis as any).preemption;
        if (pm?.setDynamicChainBudgetFastExit) pm.setDynamicChainBudgetFastExit(on);
        else { w.set_jit_config(41, on ? 1 : 0); if (w.jit_clear_cache_js) w.jit_clear_cache_js(); }
        const report = { enabled: w.get_jit_config ? (w.get_jit_config(41) >>> 0) : -1 };
        console.log(`[dbg][jitDynamicBudgetFastExit][JSON] ${JSON.stringify(report)} (authoritative) + cache cleared`);
        return report;
    },
    /** Synchronize requestImmediateExit() with generated JIT edge guards. This
     *  is authoritative and does not require a JIT cache rebuild. */
    jitImmediateExitCacheSync(on = true): { enabled: boolean } {
        const pm = (globalThis as any).preemption;
        pm?.setImmediateExitCacheSync?.(on);
        const report = { enabled: !!pm?.isImmediateExitCacheSyncEnabled?.() };
        console.log(`[dbg][jitImmediateExitCacheSync][JSON] ${JSON.stringify(report)} (authoritative)`);
        return report;
    },
    /** Current-module RET/indirect lookup emitted directly into generated wasm
     *  (set_jit_config idx 22). Default ON; OFF keeps the historical call into the
     *  base Rust/WASM module for controlled A/B. Routed through PreemptionManager
     *  so the selection survives a game reload. */
    jitInlineDispatch(on = true): void {
        const w = wasm(); if (!w?.set_jit_config) return;
        const pm = (globalThis as any).preemption;
        if (pm?.setInlineIntraModuleDispatch) pm.setInlineIntraModuleDispatch(on);
        else { w.set_jit_config(22, on ? 1 : 0); if (w.jit_clear_cache_js) w.jit_clear_cache_js(); }
        const enabled = w.get_jit_config ? (w.get_jit_config(22) >>> 0) : -1;
        const sites = w.jit_inline_dispatch_sites_compiled ? (w.jit_inline_dispatch_sites_compiled() >>> 0) : -1;
        console.log(`[dbg][jit] inlineDispatch=${enabled} compiledSites=${sites} (authoritative - survives reload) + cache cleared`);
    },
    /** Direct JMP/Jcc cross-module tail chaining (set_jit_config idx 4).
     *  The PreemptionManager applies the browser tail-call feature gate and keeps
     *  the selection across a game reload. Default OFF during BFME evaluation. */
    jitBlockChain(on = true): {
        enabled: number; supported: boolean; compiledSites: number;
        exactInserts: number; exactHits: number; exactMisses: number; exactOverflows: number;
        memoHighWater: number; memoOverflows: number;
    } | void {
        const w = wasm(); if (!w?.set_jit_config) return;
        const pm = (globalThis as any).preemption;
        if (pm?.setDirectBlockChaining) pm.setDirectBlockChaining(on);
        else { w.set_jit_config(4, on ? 1 : 0); if (w.jit_clear_cache_js) w.jit_clear_cache_js(); }
        const report = {
            enabled: w.get_jit_config ? (w.get_jit_config(4) >>> 0) : -1,
            supported: pm?.isDirectBlockChainingSupported?.() ?? true,
            compiledSites: w.jit_block_chain_sites_compiled ? (w.jit_block_chain_sites_compiled() >>> 0) : -1,
            exactInserts: w.jit_exact_dispatch_inserts ? (w.jit_exact_dispatch_inserts() >>> 0) : -1,
            exactHits: w.jit_exact_dispatch_hits ? (w.jit_exact_dispatch_hits() >>> 0) : -1,
            exactMisses: w.jit_exact_dispatch_misses ? (w.jit_exact_dispatch_misses() >>> 0) : -1,
            exactOverflows: w.jit_exact_dispatch_overflows ? (w.jit_exact_dispatch_overflows() >>> 0) : -1,
            memoHighWater: w.jit_chain_memo_high_water ? (w.jit_chain_memo_high_water() >>> 0) : -1,
            memoOverflows: w.jit_chain_memo_overflows ? (w.jit_chain_memo_overflows() >>> 0) : -1,
        };
        console.log(`[dbg][jit] blockChain=${report.enabled} supported=${report.supported ? 1 : 0} compiledSites=${report.compiledSites} exact=${report.exactHits}/${report.exactMisses} inserts=${report.exactInserts} overflows=${report.exactOverflows} memos=${report.memoHighWater}/${report.memoOverflows} (authoritative - survives reload) + cache cleared`);
        return report;
    },
    /** RET/AbsoluteEip dynamic chaining (set_jit_config idx 12). Default OFF — routed through
     *  PreemptionManager so the choice survives a game reload. Clears the JIT cache so
     *  blocks recompile with/without the chain attempt. Read hit/miss via
     *  dbg.dispatchStats() (retChainHit/retChainMiss, needs dispatchStatsEnable). */
    jitRetChain(on = true): void {
        const w = wasm(); if (!w?.set_jit_config) return;
        const pm = (globalThis as any).preemption;
        if (pm?.setRetChaining) pm.setRetChaining(on);
        else { w.set_jit_config(12, on ? 1 : 0); if (w.jit_clear_cache_js) w.jit_clear_cache_js(); }
        const g = w.get_jit_config ? (w.get_jit_config(12) >>> 0) : -1;
        console.log(`[dbg] JIT_RET_CHAINING=${g} (authoritative — survives reload) + cache cleared`);
    },
    /** Monomorphic inline cache per generated AbsoluteEip site (config idx 30,
     *  production default ON). Only affects dynamic chaining after an in-module
     *  dispatch miss. */
    jitDynamicChainSitePic(on = true): { enabled: number; compiledSites: number; highWater: number; overflows: number } | null {
        const w = wasm(); if (!w?.set_jit_config) return null;
        const pm = (globalThis as any).preemption;
        if (pm?.setDynamicChainSitePic) pm.setDynamicChainSitePic(on);
        else { w.set_jit_config(30, on ? 1 : 0); if (w.jit_clear_cache_js) w.jit_clear_cache_js(); }
        const report = {
            enabled: w.get_jit_config ? (w.get_jit_config(30) >>> 0) : -1,
            compiledSites: w.jit_dynamic_chain_site_pic_compiled?.() >>> 0,
            highWater: w.jit_dynamic_chain_site_pic_high_water?.() >>> 0,
            overflows: w.jit_dynamic_chain_site_pic_overflows?.() >>> 0,
        };
        console.log(`[dbg][jit] dynamicChainSitePic=${report.enabled} compiledSites=${report.compiledSites} memos=${report.highWater}/${report.overflows} + cache cleared`);
        return report;
    },
    /** Classify only existing site-PIC misses and simulate a shadow second way.
     *  This does not clear or rebuild JIT code and adds no work to generated hits. */
    jitDynamicChainSitePicDiag(on = true, reset = true): {
        enabled: number; calls: number; targetMisses: number; secondWayHits: number;
        thirdWayHits: number; fourthWayHits: number;
        epochMisses: number; guardMisses: number; resolverHits: number;
    } | null {
        const w = wasm(); if (!w?.set_jit_config) return null;
        if (reset && w.jit_dynamic_chain_site_pic_diag_reset) {
            w.jit_dynamic_chain_site_pic_diag_reset();
        }
        w.set_jit_config(31, on ? 1 : 0);
        const numeric = (value: unknown): number =>
            typeof value === "bigint" ? Number(value) : Number(value ?? 0);
        const report = {
            enabled: w.get_jit_config ? (w.get_jit_config(31) >>> 0) : -1,
            calls: numeric(w.jit_dynamic_chain_site_pic_diag_calls?.()),
            targetMisses: numeric(w.jit_dynamic_chain_site_pic_diag_target_misses?.()),
            secondWayHits: numeric(w.jit_dynamic_chain_site_pic_diag_second_way_hits?.()),
            thirdWayHits: numeric(w.jit_dynamic_chain_site_pic_diag_third_way_hits?.()),
            fourthWayHits: numeric(w.jit_dynamic_chain_site_pic_diag_fourth_way_hits?.()),
            epochMisses: numeric(w.jit_dynamic_chain_site_pic_diag_epoch_misses?.()),
            guardMisses: numeric(w.jit_dynamic_chain_site_pic_diag_guard_misses?.()),
            resolverHits: numeric(w.jit_dynamic_chain_site_pic_diag_resolver_hits?.()),
        };
        console.log(`[dbg][jit] sitePicDiag=${report.enabled} calls=${report.calls} targetMisses=${report.targetMisses} ways=${report.secondWayHits}/${report.thirdWayHits}/${report.fourthWayHits} epochMisses=${report.epochMisses} guardMisses=${report.guardMisses} resolverHits=${report.resolverHits}`);
        return report;
    },
    /** Second positive target checked only after a primary miss (config idx 32).
     *  Enabled by default; this command remains the persistent A/B kill switch. */
    jitDynamicChainSitePicSecondWay(on = true): { enabled: number } | null {
        const w = wasm(); if (!w?.set_jit_config) return null;
        const pm = (globalThis as any).preemption;
        if (pm?.setDynamicChainSitePicSecondWay) pm.setDynamicChainSitePicSecondWay(on);
        else w.set_jit_config(32, on ? 1 : 0);
        const report = {
            enabled: w.get_jit_config ? (w.get_jit_config(32) >>> 0) : -1,
        };
        console.log(`[dbg][jit] sitePicSecondWay=${report.enabled} (authoritative; no cache clear)`);
        return report;
    },
    /** Third/fourth miss-arm targets (config idx 33). Primary and secondary
     *  generated hits are unchanged. Enabled by default after generic and BFME
     *  A/B validation; this command remains the persistent kill switch. */
    jitDynamicChainSitePicFourWay(on = true): { enabled: number } | null {
        const w = wasm(); if (!w?.set_jit_config) return null;
        const pm = (globalThis as any).preemption;
        if (pm?.setDynamicChainSitePicFourWay) pm.setDynamicChainSitePicFourWay(on);
        else w.set_jit_config(33, on ? 1 : 0);
        const report = {
            enabled: w.get_jit_config ? (w.get_jit_config(33) >>> 0) : -1,
        };
        console.log(`[dbg][jit] sitePicFourWay=${report.enabled} (authoritative; no cache clear)`);
        return report;
    },
    /** RET-target speculation / superblock lite (set_jit_config idx 13,
     *  budget idx 14 = max leaf instructions). Default OFF — routed through PreemptionManager.
     *  Effect shows as a drop in dispatchStats().abseipDispatch. Clears the JIT cache. */
    jitRetSpec(on = true, maxInstr = 0): void {
        const w = wasm(); if (!w?.set_jit_config) return;
        if (maxInstr > 0) w.set_jit_config(14, maxInstr >>> 0);
        const pm = (globalThis as any).preemption;
        if (pm?.setRetSpeculation) pm.setRetSpeculation(on);
        else { w.set_jit_config(13, on ? 1 : 0); if (w.jit_clear_cache_js) w.jit_clear_cache_js(); }
        const g = (i: number) => (w.get_jit_config ? (w.get_jit_config(i) >>> 0) : -1);
        console.log(`[dbg] JIT_RET_SPECULATION=${g(13)} maxInstr=${g(14)} (authoritative — survives reload) + cache cleared`);
    },
    /** Tier-2 tiny direct-CALL leaf fusion (set_jit_config idx 27). The exact E8
     *  call and C3 leaf execute with normal stack semantics; only the guarded RET
     *  dispatch is shortened. Routed through PreemptionManager to survive reload. */
    jitLeafCallFusion(on = true): { enabled: number; sitesCompiled: number } | null {
        const w = wasm(); if (!w?.set_jit_config) return null;
        const pm = (globalThis as any).preemption;
        if (pm?.setLeafCallFusion) pm.setLeafCallFusion(on);
        else { w.set_jit_config(27, on ? 1 : 0); if (w.jit_clear_cache_js) w.jit_clear_cache_js(); }
        const report = {
            enabled: w.get_jit_config ? (w.get_jit_config(27) >>> 0) : -1,
            sitesCompiled: w.jit_leaf_call_fusion_sites_compiled
                ? (w.jit_leaf_call_fusion_sites_compiled() >>> 0)
                : -1,
        };
        console.log(`[dbg][jit] tier2LeafFusion=${report.enabled} sitesCompiled=${report.sitesCompiled} + cache cleared`);
        return report;
    },
    /** Keep a fused C3 leaf's architectural return EIP in a wasm local until
     *  its guarded continuation succeeds (idx 28). The mismatch path restores
     *  instruction_pointer before using the legacy resolver. */
    jitLeafReturnLocal(on = true): { enabled: number } | null {
        const w = wasm(); if (!w?.set_jit_config) return null;
        const pm = (globalThis as any).preemption;
        if (pm?.setLeafReturnLocal) pm.setLeafReturnLocal(on);
        else { w.set_jit_config(28, on ? 1 : 0); if (w.jit_clear_cache_js) w.jit_clear_cache_js(); }
        const report = {
            enabled: w.get_jit_config ? (w.get_jit_config(28) >>> 0) : -1,
        };
        console.log(`[dbg][jit] leafReturnLocal=${report.enabled} + cache cleared`);
        return report;
    },
    /** REP MOVS reduced-spill/direct-continuation kill-switch (JIT config 35). */
    jitRepMovsBridge(on = true): unknown {
        const w = wasm(); if (!w?.set_jit_config) return null;
        const pm = (globalThis as any).preemption;
        if (pm?.setRepMovsBridge) pm.setRepMovsBridge(on);
        else { w.set_jit_config(35, on ? 1 : 0); if (w.jit_clear_cache_js) w.jit_clear_cache_js(); }
        const report = { enabled: w.get_jit_config ? (w.get_jit_config(35) >>> 0) : -1 };
        console.log(`[dbg][jitRepMovsBridge][JSON] ${JSON.stringify(report)} (authoritative) + cache cleared`);
        return report;
    },
    /** Guarded in-module continuation after a synchronous block boundary
     *  (JIT config 36). Validated default; false is the persistent kill-switch. */
    jitSyncBoundaryContinuation(on = true): unknown {
        const w = wasm(); if (!w?.set_jit_config) return null;
        const pm = (globalThis as any).preemption;
        if (pm?.setSyncBoundaryContinuation) pm.setSyncBoundaryContinuation(on);
        else { w.set_jit_config(36, on ? 1 : 0); if (w.jit_clear_cache_js) w.jit_clear_cache_js(); }
        const report = {
            enabled: w.get_jit_config ? (w.get_jit_config(36) >>> 0) : -1,
            sitesCompiled: w.jit_sync_boundary_continuation_sites_compiled
                ? (w.jit_sync_boundary_continuation_sites_compiled() >>> 0)
                : -1,
        };
        console.log(`[dbg][jitSyncBoundaryContinuation][JSON] ${JSON.stringify(report)} (authoritative) + cache cleared`);
        return report;
    },
    /** Queue a hot page once while the async JIT compile window is full and
     *  start it when a slot completes (config 37). ON by default, kill-switch retained. */
    jitDeferredCompileQueue(on = true): unknown {
        const pm = (globalThis as any).preemption;
        const w = wasm();
        if (pm?.setDeferredCompileQueue) pm.setDeferredCompileQueue(on);
        else if (w?.set_jit_config) {
            w.set_jit_config(37, on ? 1 : 0);
            if (w.jit_clear_cache_js) w.jit_clear_cache_js();
        }
        else return null;
        const report = {
            enabled: w?.get_jit_config
                ? (w.get_jit_config(37) >>> 0)
                : (pm?.isDeferredCompileQueueEnabled?.() ? 1 : 0),
            applied: !!w?.set_jit_config,
        };
        console.log(`[dbg][jitDeferredCompileQueue][JSON] ${JSON.stringify(report)} (authoritative; persisted before v86 init)`);
        return report;
    },
    /** Compile an ordinary instruction spanning two guest pages only after the
     *  JIT proves that their current physical mappings are contiguous. Both
     *  pages remain invalidation dependencies (config 38). */
    jitCrossPageInstructions(on = true): unknown {
        const pm = (globalThis as any).preemption;
        const w = wasm();
        if (pm?.setContiguousCrossPageInstructions) {
            pm.setContiguousCrossPageInstructions(on);
        }
        else if (w?.set_jit_config) {
            w.set_jit_config(38, on ? 1 : 0);
            w.jit_clear_cache_js?.();
        }
        else return null;
        const report = {
            enabled: w?.get_jit_config
                ? (w.get_jit_config(38) >>> 0)
                : (pm?.isContiguousCrossPageInstructionsEnabled?.() ? 1 : 0),
            compiled: w?.jit_contiguous_cross_page_instructions_compiled
                ? (w.jit_contiguous_cross_page_instructions_compiled() >>> 0)
                : -1,
        };
        console.log(`[dbg][jitCrossPageInstructions][JSON] ${JSON.stringify(report)} (authoritative) + cache cleared`);
        return report;
    },
    /** Hotness tiering (set_jit_config idx 15 = per-module re-entry threshold, 0=off;
     *  idx 16 = tier-2 RET-spec budget; idx 17 = tier-2 module page budget). Default ON
     *  (300K) via the Rust static — the promotion invalidation bug (ret-memo/dispatch
     *  pointing at freed entries → "null function" trap) is
     *  fixed in the fork (flush in free_wasm_table_index + epoch key). Routed through
     *  the PreemptionManager when it exposes setTier2Threshold so the choice survives a
     *  game reload. Pure runtime knob: changing it needs NO cache clear (promotion
     *  happens organically as modules cross the threshold). */
    jitTier2(threshold = 300000, specBudget = 0, maxPages = 0, pageSetCap = 0): void {
        const w = wasm(); if (!w?.set_jit_config) return;
        if (specBudget > 0) w.set_jit_config(16, specBudget >>> 0);
        if (maxPages > 0) w.set_jit_config(17, maxPages >>> 0); // tier-2 module page budget (idx 17)
        if (pageSetCap > 0) w.set_jit_config(20, pageSetCap >>> 0); // retained hot-page capacity
        const pm = (globalThis as any).preemption;
        if (pm?.setTier2Threshold) pm.setTier2Threshold(threshold);
        else w.set_jit_config(15, threshold >>> 0);
        const g = (i: number) => (w.get_jit_config ? (w.get_jit_config(i) >>> 0) : -1);
        console.log(`[dbg] JIT_TIER2_THRESHOLD=${g(15)} tier2SpecBudget=${g(16)} tier2MaxPages=${g(17)} pageSetCap=${g(20)} (runtime knob, no cache clear)`);
    },
    /** Profile-guided Tier-2 module coalescing (idx 23). Resets Tier-2 history
     *  and the JIT cache so ON/OFF comparisons start from equivalent cold state. */
    jitTier2Regions(on = true): void {
        const w = wasm(); if (!w?.set_jit_config) return;
        const pm = (globalThis as any).preemption;
        if (pm?.setTier2Regions) pm.setTier2Regions(on);
        else {
            w.set_jit_config(23, on ? 1 : 0);
            w.jit_reset_tier2_state?.();
            w.jit_clear_cache_js?.();
        }
        console.log(`[dbg] JIT_TIER2_REGIONS=${w.get_jit_config?.(23) ?? -1} + tier2/profile/cache reset`);
    },
    /** Adaptive bounded Tier-2 hot-set replacement (idx 24). Existing compiled
     *  code stays valid and the retained-page capacity does not change. */
    jitTier2Adaptive(on = true): void {
        const w = wasm(); if (!w?.set_jit_config) return;
        const pm = (globalThis as any).preemption;
        if (pm?.setTier2Adaptive) pm.setTier2Adaptive(on);
        else w.set_jit_config(24, on ? 1 : 0);
        console.log(`[dbg] JIT_TIER2_ADAPTIVE=${w.get_jit_config?.(24) ?? -1} (live, bounded)`);
    },
    /** Maximum asynchronous wasm compilations in flight (idx 25, 1..8).
     *  Live and reversible; 1 is the historical globally serialized path. */
    jitPendingCompiles(maxPending = 2): number {
        // Record the intent even before v86 exists: a cold-boot A/B has to set
        // this at t=0, and bailing out on a missing WASM export would silently
        // leave the default in place for the whole run being measured.
        const bounded = Math.max(1, Math.min(8, maxPending >>> 0));
        const pm = (globalThis as any).preemption;
        if (pm?.setJitMaxPendingCompiles) pm.setJitMaxPendingCompiles(bounded);
        const w = wasm();
        if (!pm?.setJitMaxPendingCompiles && w?.set_jit_config) w.set_jit_config(25, bounded);
        const applied = w?.get_jit_config?.(25);
        console.log(`[dbg] JIT_MAX_PENDING_COMPILES=${bounded} applied=${applied ?? "pending-wasm"}`);
        return applied === undefined ? bounded : (applied >>> 0);
    },
    /** Tier-1 page hotness before compilation (idx 26). Clears generated code
     *  because existing modules otherwise bias cold-start comparisons. */
    jitBaseThreshold(threshold = 200_000): number {
        // Same reasoning as jitPendingCompiles: the interesting experiment sets
        // this before the guest starts, so it must survive a missing WASM export.
        const bounded = Math.max(10_000, Math.min(2_000_000, threshold >>> 0));
        const pm = (globalThis as any).preemption;
        if (pm?.setJitBaseThreshold) pm.setJitBaseThreshold(bounded);
        const w = wasm();
        if (!pm?.setJitBaseThreshold && w?.set_jit_config) {
            w.set_jit_config(26, bounded);
            w.jit_clear_cache_js?.();
        }
        const applied = w?.get_jit_config?.(26);
        console.log(`[dbg] JIT_BASE_THRESHOLD=${bounded} applied=${applied ?? "pending-wasm"}`);
        return applied === undefined ? bounded : (applied >>> 0);
    },
    /** Cold/warm JIT compilation observability. Times include browser compile
     *  latency and event-loop scheduling until the module is published. */
    jitCompileStats(reset = false): Record<string, number> | null {
        const w = wasm(); if (!w?.jit_get_compile_started) return null;
        if (reset) w.jit_reset_compile_stats?.();
        const s = {
            maxPending: w.get_jit_config?.(25) ?? 1,
            started: w.jit_get_compile_started() >>> 0,
            completed: w.jit_get_compile_completed?.() >>> 0,
            pending: w.jit_get_compile_pending?.() >>> 0,
            pendingHighWater: w.jit_get_compile_pending_high_water?.() >>> 0,
            capSkips: w.jit_get_compile_cap_skips?.() >>> 0,
            deferredQueued: w.jit_get_compile_deferred_queued?.() >>> 0,
            deferredStarted: w.jit_get_compile_deferred_started?.() >>> 0,
            deferredDropped: w.jit_get_compile_deferred_dropped?.() >>> 0,
            deferredPending: w.jit_get_compile_deferred_pending?.() >>> 0,
            totalMs: (w.jit_get_compile_total_us?.() ?? 0) / 1000,
            maxMs: (w.jit_get_compile_max_us?.() ?? 0) / 1000,
            crossPageInstructions: w.jit_contiguous_cross_page_instructions_compiled?.() ?? 0,
        };
        console.log(`[dbg] jit compile: pending=${s.pending}/${s.maxPending} highWater=${s.pendingHighWater} started=${s.started} completed=${s.completed} capSkips=${s.capSkips} deferred=${s.deferredStarted}/${s.deferredQueued} pending=${s.deferredPending} dropped=${s.deferredDropped} totalMs=${s.totalMs.toFixed(1)} maxMs=${s.maxMs.toFixed(1)}`);
        return s;
    },
    /** Hotness-tiering observability: pages currently tier-2-marked, successful promotions,
     *  and promotions REFUSED because the page-set cap was full. blockedByCap > 0
     *  with a saturated pageCount means the hot set outgrew the cap — the exact failure
     *  mode that makes threshold changes read as "no effect" (see the in-race NFSU A/B). */
    tier2Stats(): { pageCount: number; pageSetCap: number; promotions: number; blockedByCap: number; threshold: number; regions: number; adaptive: number; maintenanceSamples: number; pageEvictions: number; profiledExits: number; regionPromotions: number; regionSeeds: number; regionCandidates: number; regionRejectedTarget: number; regionRejectedBudget: number } | null {
        const w = wasm(); if (!w?.jit_get_tier2_page_count) {
            console.warn("[dbg] jit_get_tier2_page_count missing — rebuild vendor/v86 (build-wasm.sh)");
            return null;
        }
        const s = {
            pageCount: w.jit_get_tier2_page_count() >>> 0,
            pageSetCap: w.get_jit_config ? (w.get_jit_config(20) >>> 0) : 256,
            promotions: w.jit_get_tier2_promotions() >>> 0,
            blockedByCap: w.jit_get_tier2_blocked_by_cap() >>> 0,
            threshold: w.get_jit_config ? (w.get_jit_config(15) >>> 0) : -1,
            regions: w.get_jit_config ? (w.get_jit_config(23) >>> 0) : 0,
            adaptive: w.get_jit_config ? (w.get_jit_config(24) >>> 0) : 0,
            maintenanceSamples: w.jit_get_tier2_maintenance_samples?.() ?? 0,
            pageEvictions: w.jit_get_tier2_page_evictions?.() ?? 0,
            profiledExits: w.jit_get_tier2_profiled_exits?.() ?? 0,
            regionPromotions: w.jit_get_tier2_region_promotions?.() ?? 0,
            regionSeeds: w.jit_get_tier2_region_seeds?.() ?? 0,
            regionCandidates: w.jit_get_tier2_region_candidates?.() ?? 0,
            regionRejectedTarget: w.jit_get_tier2_region_rejected_target?.() ?? 0,
            regionRejectedBudget: w.jit_get_tier2_region_rejected_budget?.() ?? 0,
        };
        console.log(`[dbg] tier2: pages=${s.pageCount}/${s.pageSetCap} promotions=${s.promotions} blockedByCap=${s.blockedByCap} threshold=${s.threshold} regions=${s.regions} adaptive=${s.adaptive} maintenance=${s.maintenanceSamples} evictions=${s.pageEvictions} profiledExits=${s.profiledExits} regionPromotions=${s.regionPromotions} regionSeeds=${s.regionSeeds} candidates=${s.regionCandidates} rejectedTarget=${s.regionRejectedTarget} rejectedBudget=${s.regionRejectedBudget}`);
        return s;
    },
    /** Fastmem read speculation. Default ON; clears JIT cache so blocks recompile. */
    fastmemReads(on = true): void {
        const w = wasm(); if (!w?.set_jit_config) return;
        // Assert the Rust-side red-zone constants mirror the TS memory layout
        // (single source: emulator-config.ts). A mismatch means the raw-load range
        // check would let a red-zone read through — refuse to enable speculation.
        if (on && w.fastmem_get_guard_base && w.fastmem_get_guard_size && w.fastmem_get_low_mem_end) {
            const gb = w.fastmem_get_guard_base() >>> 0;
            const gs = w.fastmem_get_guard_size() >>> 0;
            const lm = w.fastmem_get_low_mem_end() >>> 0;
            if (gb !== (MEM_GUARD_BASE >>> 0) || gs !== (MEM_GUARD_SIZE >>> 0) || lm !== 0x00100000) {
                console.error(`[dbg][fastmem] REFUSING enable: guard mismatch wasm(base=0x${gb.toString(16)},size=0x${gs.toString(16)},low=0x${lm.toString(16)}) vs TS(base=0x${(MEM_GUARD_BASE>>>0).toString(16)},size=0x${(MEM_GUARD_SIZE>>>0).toString(16)},low=0x100000)`);
                return;
            }
        }
        // Route through PreemptionManager so the choice survives a game reload
        // (default is ON; a kill-switch here must stick). Falls back to a direct set.
        const pm = (globalThis as any).preemption;
        if (pm?.setFastmemReads) pm.setFastmemReads(on);
        else { w.set_jit_config(9, on ? 1 : 0); if (w.jit_clear_cache_js) w.jit_clear_cache_js(); }
        const g = w.get_jit_config ? (w.get_jit_config(9) >>> 0) : -1;
        const gen = w.fastmem_get_generation ? (w.fastmem_get_generation() >>> 0) : -1;
        console.log(`[dbg][fastmem] reads=${g} generation=${gen} (authoritative - survives reload) + cache cleared`);
    },
    /** Split-range fastmem read shape (idx 18). Same acceptance set as the legacy
     *  4-compare shape; OFF = legacy, for in-race A/B. Clears the JIT cache to recompile. */
    fastmemReadSplit(on = true): void {
        const w = wasm(); if (!w?.set_jit_config) return;
        const pm = (globalThis as any).preemption;
        if (pm?.setFastmemReadSplit) pm.setFastmemReadSplit(on);
        else { w.set_jit_config(18, on ? 1 : 0); if (w.jit_clear_cache_js) w.jit_clear_cache_js(); }
        const g = w.get_jit_config ? (w.get_jit_config(18) >>> 0) : -1;
        console.log(`[dbg][fastmem] readSplit=${g} (authoritative - survives reload) + cache cleared`);
    },
    /** Fastmem WRITES (idx 19). Default OFF. Rebuilds the write map
     *  (region-intent ∩ PTE present+RW) BEFORE enabling — a wrong bit0 on a decommitted/
     *  RO/code page is silent corruption, an all-zero map is merely all-slow — then flips
     *  idx 19 + clears the JIT cache. Refuses to enable on a guard-constant mismatch. */
    fastmemWrites(on = true): void {
        const w = wasm(); if (!w?.set_jit_config) return;
        if (on && w.fastmem_get_guard_base && w.fastmem_get_guard_size && w.fastmem_get_low_mem_end) {
            const gb = w.fastmem_get_guard_base() >>> 0;
            const gs = w.fastmem_get_guard_size() >>> 0;
            const lm = w.fastmem_get_low_mem_end() >>> 0;
            if (gb !== (MEM_GUARD_BASE >>> 0) || gs !== (MEM_GUARD_SIZE >>> 0) || lm !== 0x00100000) {
                console.error(`[dbg][fastmem] REFUSING write enable: guard mismatch wasm(base=0x${gb.toString(16)},size=0x${gs.toString(16)},low=0x${lm.toString(16)}) vs TS(base=0x${(MEM_GUARD_BASE>>>0).toString(16)},size=0x${(MEM_GUARD_SIZE>>>0).toString(16)},low=0x100000)`);
                return;
            }
        }
        if (on) {
            // Authoritative rebuild before enabling (see method doc). Skipped rebuild = the
            // fresh/stale map stays all-slow = safe, so warn but don't hard-fail.
            const proc: any = System.getInstance().process;
            const ptm = proc?.pageTableManager, as = proc?.addressSpace;
            if (ptm?.rebuildWriteMap && as?.getFastWritableRanges) {
                ptm.rebuildWriteMap(as.getFastWritableRanges());
            } else {
                console.warn('[dbg][fastmem] write map rebuild unavailable (process not ready) — stores stay slow');
            }
        }
        const pm = (globalThis as any).preemption;
        if (pm?.setFastmemWrites) pm.setFastmemWrites(on);
        else { w.set_jit_config(19, on ? 1 : 0); if (w.jit_clear_cache_js) w.jit_clear_cache_js(); }
        const g = w.get_jit_config ? (w.get_jit_config(19) >>> 0) : -1;
        console.log(`[dbg][fastmem] writes=${g} (authoritative - survives reload)${on ? ' + map rebuilt' : ''} + cache cleared`);
    },
    /** Fastmem-write safety net: scan marked pages, assert bit0 ⇒ PTE present+RW and
     *  not THUNK_CODE. Any `danger` count is a corruption-class blocker — run in every soak. */
    fastmemWriteAudit(maxReport = 32): any {
        const proc: any = System.getInstance().process;
        const ptm = proc?.pageTableManager;
        if (!ptm?.auditWriteMap) { console.warn('[dbg][fastmem] audit unavailable (process/wasm not ready)'); return null; }
        const r = ptm.auditWriteMap(maxReport);
        if (!r) { console.warn('[dbg][fastmem] audit: wasm export missing'); return null; }
        const level = r.danger > 0 ? 'error' : 'log';
        (console as any)[level](`[dbg][fastmem][audit] base0Pages=${r.base0Pages} danger=${r.danger} maxPage=${r.maxPage}${r.danger ? ' ⚠ CORRUPTION-CLASS (blocker)' : ' ✓ clean'}`);
        if (r.danger > 0) console.error(`[dbg][fastmem][audit][JSON] ${JSON.stringify(r.samples)}`);
        return r;
    },
    /** Lazy-flag tuple in wasm locals (idx 21). Default OFF. Kills per-ALU-op flag stores +
     *  their TurboFan aliasing barriers. Clears the JIT cache — toggle PARKED only. */
    flagLocals(on = true): void {
        const w = wasm(); if (!w?.set_jit_config) return;
        const pm = (globalThis as any).preemption;
        if (pm?.setFlagLocals) pm.setFlagLocals(on);
        else { w.set_jit_config(21, on ? 1 : 0); if (w.jit_clear_cache_js) w.jit_clear_cache_js(); }
        const g = w.get_jit_config ? (w.get_jit_config(21) >>> 0) : -1;
        console.log(`[dbg][flaglocals] enabled=${g} (authoritative - survives reload) + cache cleared`);
    },
    /** Attribute HeapAlloc calls that escaped the inline x86/WASM slab. Keep this
     *  opt-in so the caller histogram itself never taxes normal gameplay. */
    heapAllocDiag(on = true, reset = true): any {
        const fn = (globalThis as any).setHeapAllocFallbackDiagnostics;
        const result = typeof fn === 'function' ? fn(!!on, !!reset) : null;
        console.log(`[dbg][heap] fallback diagnostics ${on ? 'enabled' : 'disabled'}${reset ? ' + reset' : ''}`);
        return result;
    },
    heapAllocDiagReport(): any {
        const fn = (globalThis as any).getHeapAllocFallbackDiagnostics;
        const result = typeof fn === 'function' ? fn() : null;
        console.log(`[dbg][heap][JSON] ${JSON.stringify(result)}`);
        return result;
    },
    heapSlabReport(): any {
        const fn = (globalThis as any).getSlabReport;
        const result = typeof fn === 'function' ? fn() : null;
        console.log(`[dbg][heap-slab][JSON] ${JSON.stringify(result)}`);
        return result;
    },
    /** Attribute D3D9 Surface::LockRect bursts by surface, flags, rectangle and
     *  guest caller. Disabled by default because it intentionally counts calls. */
    surfaceLockDiag(on = true, reset = true): any {
        const result = setSurfaceLockDiagnostics(!!on, !!reset);
        console.log(`[dbg][surface-lock] diagnostics ${on ? 'enabled' : 'disabled'}${reset ? ' + reset' : ''}`);
        return result;
    },
    surfaceLockDiagReport(): any {
        const result = getSurfaceLockDiagnostics();
        console.log(`[dbg][surface-lock][JSON] ${JSON.stringify(result)}`);
        return result;
    },
    /** Advertise or hide DXT/BC texture formats during D3D8/9 capability
     * negotiation. Direct resource creation remains supported. OFF is an
     * experimental CPU-for-memory tradeoff for engines with an uncompressed
     * fallback; the choice persists across game reloads in this Worker. */
    dxtAdvertise(on = true): any {
        setDxCompressedTextureAdvertisement(!!on);
        const result = getDxCompressedTextureNegotiationStats(false);
        console.log(`[dbg][dxt-advertise][JSON] ${JSON.stringify(result)}`);
        return result;
    },
    dxtAdvertiseReport(reset = false): any {
        const result = getDxCompressedTextureNegotiationStats(!!reset);
        result.advertised = getDxCompressedTextureAdvertisement();
        console.log(`[dbg][dxt-advertise][JSON] ${JSON.stringify(result)}`);
        return result;
    },
    d3d9TextureMemory(): any {
        const result = getD3D9TextureMemoryReport();
        console.log(`[dbg][d3d9-texture-memory][JSON] ${JSON.stringify(result)}`);
        return result;
    },
    /**
     * Run the guest until `instructions` guest instructions have retired, then
     * freeze and report the wall time. This is the stationary replacement for
     * "average ms/frame over N presentations": the amount of guest work is fixed
     * by construction, so two windows are directly comparable even though the
     * simulation keeps evolving. Poll `workWindowReport()` until `done` is true.
     *
     * Use for codegen / dispatch / scheduler A/Bs, where both arms execute the
     * same instruction stream. Do NOT use it to judge an HLE hook that replaces
     * guest code with a native handler: such a hook legitimately lowers MIPS.
     */
    workWindow(instructions = 1_000_000_000): any {
        const result = armGuestWorkWindow(Number(instructions) || 1, performance.now());
        console.log(`[dbg][work-window] armed target=${result.targetInstructions}`);
        return result;
    },
    workWindowReport(): any {
        const result = readGuestWorkWindow(performance.now());
        console.log(`[dbg][work-window][JSON] ${JSON.stringify(result)}`);
        return result;
    },
    workWindowCancel(): any {
        cancelGuestWorkWindow();
        console.log('[dbg][work-window] cancelled');
        return true;
    },
    /** Share of retired guest instructions that ran in the interpreter rather
     *  than a compiled module. This is the number that decides JIT-threshold and
     *  compile-bandwidth experiments: lowering the threshold can only help to the
     *  extent that a phase is still interpreted. */
    interpretedShare(reset = false): any {
        const w = wasm();
        const odo = readGuestOdometer();
        const interpreted = Number(w?.profiler_interpreted_steps_get?.() ?? 0);
        const result = {
            interpreted,
            retired: odo.instructions,
            interpretedPct: odo.instructions > 0
                ? Math.round((interpreted / odo.instructions) * 10_000) / 100
                : 0,
        };
        if (reset) {
            w?.profiler_interpreted_steps_reset?.();
            resetGuestOdometer();
        }
        console.log(`[dbg][interpreted-share][JSON] ${JSON.stringify(result)}`);
        return result;
    },
    /** Free-running retired-guest-instruction odometer. `reset` marks a phase
     *  boundary and returns the value the previous phase accumulated, which is the
     *  right denominator for "instructions to reach this milestone" comparisons. */
    guestOdometer(reset = false): any {
        const result = reset ? resetGuestOdometer() : readGuestOdometer();
        console.log(`[dbg][odometer][JSON] ${JSON.stringify(result)}`);
        return result;
    },
    /** Toggle the byte-exact BFME DXT encoder memoization path. This is hot-
     * switchable so the same cold transition can be profiled with the cache
     * disabled; disabling it makes every lookup execute the original encoder. */
    dxtCache(on = true): any {
        const w = wasm();
        if (!w?.bfme_dxt_cache_set_enabled) return null;
        w.bfme_dxt_cache_set_enabled(on ? 1 : 0);
        const result = !!(w.bfme_dxt_cache_get_enabled?.() >>> 0);
        console.log(`[dbg][dxt-cache] enabled=${result ? 1 : 0}`);
        return result;
    },
    /** Toggle the native-WASM BC1 fit used for cache misses during BFME's
     * cold texture load. Kept independent from memoization for controlled A/B. */
    dxtFast(on = true): any {
        const w = wasm();
        if (!w?.bfme_dxt_fast_set_enabled) return null;
        w.bfme_dxt_fast_set_enabled(on ? 1 : 0);
        const result = !!(w.bfme_dxt_fast_get_enabled?.() >>> 0);
        console.log(`[dbg][dxt-fast] enabled=${result ? 1 : 0}`);
        return result;
    },
    /** Compare the fast BC1 fit against the title's own encoder on every cache
     *  miss, without changing what the guest receives. Answers whether the fast
     *  path is a viable default: "the bytes differ" is not a quality argument for
     *  texture data, the pixel magnitude is. */
    dxtShadow(on = true, reset = true): any {
        const w = wasm();
        if (!w?.bfme_dxt_shadow_set_enabled) return null;
        if (reset) w.bfme_dxt_shadow_reset_stats?.();
        w.bfme_dxt_shadow_set_enabled(on ? 1 : 0);
        console.log(`[dbg][dxt-shadow] ${on ? 'armed' : 'disarmed'}${reset ? ' + reset' : ''}`);
        return !!(w.bfme_dxt_shadow_get_enabled?.() >>> 0);
    },
    dxtShadowReport(): any {
        const w = wasm();
        if (!w?.bfme_dxt_shadow_get_stat) return null;
        const stat = (i: number) => Number(w.bfme_dxt_shadow_get_stat(i));
        const blocks = stat(0);
        const exact = stat(1);
        const sumAbs = stat(6);
        const samples = stat(7);
        const result = {
            enabled: !!(w.bfme_dxt_shadow_get_enabled?.() >>> 0),
            blocks,
            exact,
            exactPct: blocks ? Math.round((exact * 10_000) / blocks) / 100 : 0,
            // 8-bit channel units: "worst" is the largest single-channel error
            // observed on any texel of any block.
            worstChannelDelta: stat(2),
            blocksOver4: stat(3),
            blocksOver16: stat(4),
            alphaMismatch: stat(5),
            meanChannelDelta: samples ? Math.round((sumAbs / samples) * 10_000) / 10_000 : 0,
        };
        console.log(`[dbg][dxt-shadow][JSON] ${JSON.stringify(result)}`);
        return result;
    },
    dxtCacheReport(reset = false): any {
        const w = wasm();
        if (!w?.bfme_dxt_cache_get_stat) return null;
        const lookups = w.bfme_dxt_cache_get_stat(0) >>> 0;
        const hits = w.bfme_dxt_cache_get_stat(1) >>> 0;
        const result = {
            enabled: !!(w.bfme_dxt_cache_get_enabled?.() >>> 0),
            lookups,
            hits,
            hitPct: lookups ? Math.round((hits * 10_000) / lookups) / 100 : 0,
            inserts: w.bfme_dxt_cache_get_stat(2) >>> 0,
            replacements: w.bfme_dxt_cache_get_stat(3) >>> 0,
            bypasses: w.bfme_dxt_cache_get_stat(4) >>> 0,
            fastEnabled: !!(w.bfme_dxt_fast_get_enabled?.() >>> 0),
            fastEncodes: w.bfme_dxt_cache_get_stat(5) >>> 0,
            fallbacks: getBfmeDxtEncodeCacheFallbacks(reset),
        };
        if (reset) w.bfme_dxt_cache_reset_stats?.();
        console.log(`[dbg][dxt-cache][JSON] ${JSON.stringify(result)}`);
        return result;
    },
    rgb24Report(reset = false): any {
        const w = wasm();
        if (!w?.bfme_rgb24_stat) return null;
        const result = {
            enabled: !!(w.bfme_rgb24_get_enabled?.() >>> 0),
            calls: w.bfme_rgb24_stat(0) >>> 0,
            pixels: w.bfme_rgb24_stat(1) >>> 0,
            attempts: w.bfme_rgb24_stat(2) >>> 0,
            lastSource: `0x${(w.bfme_rgb24_stat(3) >>> 0).toString(16)}`,
            lastDestination: `0x${(w.bfme_rgb24_stat(4) >>> 0).toString(16)}`,
            lastEnd: `0x${(w.bfme_rgb24_stat(5) >>> 0).toString(16)}`,
            lastCount: w.bfme_rgb24_stat(6) >>> 0,
            lastFailure: w.bfme_rgb24_stat(7) >>> 0,
        };
        if (reset) w.bfme_rgb24_stat_reset?.();
        console.log(`[dbg][rgb24][JSON] ${JSON.stringify(result)}`);
        return result;
    },
    rgb24Fast(on = true): any {
        const w = wasm();
        if (!w?.bfme_rgb24_set_enabled) return null;
        w.bfme_rgb24_set_enabled(on ? 1 : 0);
        const result = !!(w.bfme_rgb24_get_enabled?.() >>> 0);
        console.log(`[dbg][rgb24] enabled=${result ? 1 : 0}`);
        return result;
    },
    sparseFloat4Fast(on = true): any {
        const w = wasm();
        if (!w?.bfme_sparse_float4_set_enabled) return null;
        w.bfme_sparse_float4_set_enabled(on ? 1 : 0);
        const result = !!(w.bfme_sparse_float4_get_enabled?.() >>> 0);
        console.log(`[dbg][sparse-float4] enabled=${result ? 1 : 0}`);
        return result;
    },
    sparseFloat4Report(reset = false): any {
        const w = wasm();
        if (!w?.bfme_sparse_float4_stat) return null;
        const result = {
            enabled: !!(w.bfme_sparse_float4_get_enabled?.() >>> 0),
            attempts: w.bfme_sparse_float4_stat(0) >>> 0,
            calls: w.bfme_sparse_float4_stat(1) >>> 0,
            items: w.bfme_sparse_float4_stat(2) >>> 0,
            lastFailure: w.bfme_sparse_float4_stat(3) >>> 0,
        };
        if (reset) w.bfme_sparse_float4_stat_reset?.();
        console.log(`[dbg][sparse-float4][JSON] ${JSON.stringify(result)}`);
        return result;
    },
    /** Attribute opt-in GDI canvas readbacks without taxing normal gameplay. */
    gdiDibSyncDiag(on = true, reset = true): any {
        const gdi = System.getInstance().gdiContext;
        const result = gdi?.setDibSyncDiagnostics?.(!!on, !!reset) ?? null;
        console.log(`[dbg][gdi-dib-sync] diagnostics ${on ? 'enabled' : 'disabled'}${reset ? ' + reset' : ''}`);
        return result;
    },
    gdiDibSyncReport(): any {
        const result = System.getInstance().gdiContext?.getDibSyncDiagnostics?.() ?? null;
        console.log(`[dbg][gdi-dib-sync][JSON] ${JSON.stringify(result)}`);
        return result;
    },
    /** Fastmem counters: generation, compiled raw-load sites, lazy deopts, source bump counts. */
    fastmemStats(): any {
        const w = wasm(); if (!w?.fastmem_get_generation) return null;
        const sourceNames = [
            'tlbFullClear',
            'tlbClear',
            'invlpg',
            'addressProtect',
            'addressRelease',
            'ptDecommit',
            'ptCommit',
            'ptProtect',
            'writeWatch',
            'manual',
        ];
        const bumps: Record<string, number> = {};
        for (let i = 0; i < sourceNames.length; i++) {
            bumps[sourceNames[i]] = w.fastmem_get_bump_count ? (w.fastmem_get_bump_count(i) >>> 0) : 0;
        }
        const s = {
            enabled: w.get_jit_config ? !!(w.get_jit_config(9) >>> 0) : false,
            generation: w.fastmem_get_generation() >>> 0,
            speculatedLoadsCompiled: w.fastmem_get_speculated_loads_compiled ? (w.fastmem_get_speculated_loads_compiled() >>> 0) : 0,
            deoptRecompiles: w.fastmem_get_deopt_recompiles ? (w.fastmem_get_deopt_recompiles() >>> 0) : 0,
            thrashLatched: w.fastmem_get_thrash_latched ? !!(w.fastmem_get_thrash_latched() >>> 0) : false,
            bumps,
            // Fastmem-write map (bit0 base, bit1 code, bit2 watch; accept = byte==1).
            writesEnabled: w.get_jit_config ? !!(w.get_jit_config(19) >>> 0) : false,
            speculatedStoresCompiled: w.fastmem_get_speculated_stores_compiled ? (w.fastmem_get_speculated_stores_compiled() >>> 0) : 0,
            writeMap: w.fastmem_write_map_count ? {
                acceptPages: w.fastmem_write_map_count(0) >>> 0,
                basePages: w.fastmem_write_map_count(1) >>> 0,
                codePages: w.fastmem_write_map_count(2) >>> 0,
                watchPages: w.fastmem_write_map_count(4) >>> 0,
                maxPage: w.fastmem_write_map_max_page ? (w.fastmem_write_map_max_page() >>> 0) : 0,
            } : null,
            // DOD dispatch SoA: slab-pool health.
            // overflows>0 = pages left unpublished (correct but interpreted) — raise pool size.
            dispatchSlabs: w.dispatch_slab_high_water ? {
                highWater: w.dispatch_slab_high_water() >>> 0,
                overflows: w.dispatch_slab_overflows() >>> 0,
            } : null,
        };
        console.log(`[dbg][fastmem][JSON] ${JSON.stringify(s)}`);
        return s;
    },
    /** Relaxed x87 ST read-through locals. Default ON; clears JIT cache. */
    x87Locals(on = true): void {
        const w = wasm(); if (!w?.set_jit_config) return;
        const pm = (globalThis as any).preemption;
        if (pm?.setX87Locals) pm.setX87Locals(on);
        else { w.set_jit_config(10, on ? 1 : 0); if (w.jit_clear_cache_js) w.jit_clear_cache_js(); }
        console.log(`[dbg][x87] locals=${w.get_jit_config ? (w.get_jit_config(10) >>> 0) : (on ? 1 : 0)} (authoritative - survives reload) + cache cleared`);
    },
    /** Keep relaxed x87 results in block-scoped locals until an architectural
     *  boundary. Experimental; guarded by config 39 and clears compiled code. */
    x87Writeback(on = true): void {
        const w = wasm(); if (!w?.set_jit_config) return;
        const pm = (globalThis as any).preemption;
        if (pm?.setX87Writeback) pm.setX87Writeback(on);
        else { w.set_jit_config(39, on ? 1 : 0); w.jit_clear_cache_js?.(); }
        console.log(`[dbg][x87] writeback=${w.get_jit_config ? (w.get_jit_config(39) >>> 0) : (on ? 1 : 0)} (authoritative - survives reload) + cache cleared`);
    },
    /** Classify ordinary ordered x87 comparisons before the rare NaN case.
     *  IEEE-754 semantics are unchanged; config 40 permits a live A/B. */
    x87OrderedCompare(on = true): void {
        const w = wasm(); if (!w?.set_jit_config) return;
        w.set_jit_config(40, on ? 1 : 0);
        w.jit_clear_cache_js?.();
        console.log(`[dbg][x87] orderedCompare=${w.get_jit_config ? (w.get_jit_config(40) >>> 0) : (on ? 1 : 0)} + cache cleared`);
    },
    x87LocalStats(): any {
        const w = wasm(); if (!w) return null;
        const s = {
            enabled: w.get_jit_config ? !!(w.get_jit_config(10) >>> 0) : false,
            // Compile-site counts (not runtime hit/fill — see the Rust comment).
            cacheLoadSitesCompiled: w.x87_locals_get_cache_load_sites_compiled ? (w.x87_locals_get_cache_load_sites_compiled() >>> 0) : 0,
            cacheStoresCompiled: w.x87_locals_get_cache_stores_compiled ? (w.x87_locals_get_cache_stores_compiled() >>> 0) : 0,
            cacheInvalidatesCompiled: w.x87_locals_get_cache_invalidates_compiled ? (w.x87_locals_get_cache_invalidates_compiled() >>> 0) : 0,
        };
        console.log(`[dbg][x87][JSON] ${JSON.stringify(s)}`);
        return s;
    },
    /** 32-bit flat-stack push write coalescing. Default ON; clears JIT cache. */
    pushRunCoalescing(on = true): void {
        const w = wasm(); if (!w?.set_jit_config) return;
        const pm = (globalThis as any).preemption;
        if (pm?.setPushRunCoalescing) pm.setPushRunCoalescing(on);
        else { w.set_jit_config(11, on ? 1 : 0); if (w.jit_clear_cache_js) w.jit_clear_cache_js(); }
        console.log(`[dbg][pushrun] coalescing=${w.get_jit_config ? (w.get_jit_config(11) >>> 0) : (on ? 1 : 0)} (authoritative - survives reload) + cache cleared`);
    },
    pushRunStats(): any {
        const w = wasm(); if (!w) return null;
        const s = {
            enabled: w.get_jit_config ? !!(w.get_jit_config(11) >>> 0) : false,
            sitesCompiled: w.push_run_get_sites_compiled ? (w.push_run_get_sites_compiled() >>> 0) : 0,
            reuseBranchesCompiled: w.push_run_get_reuse_branches_compiled ? (w.push_run_get_reuse_branches_compiled() >>> 0) : 0,
        };
        console.log(`[dbg][pushrun][JSON] ${JSON.stringify(s)}`);
        return s;
    },
    /** Bisection control: toggle dead-flag elision. Routes through PreemptionManager
     *  so the choice survives game reload. Clears JIT cache. */
    deadFlagElision(on = true): void {
        const pm = (globalThis as any).preemption;
        if (pm?.setDeadFlagElision) {
            pm.setDeadFlagElision(on);
            console.log(`[dbg] deadFlagElision=${on ? 1 : 0} (authoritative — survives game reload) + cache cleared`);
            return;
        }
        const w = wasm(); if (!w) return;
        if (w.set_jit_config) w.set_jit_config(5, on ? 1 : 0);
        if (w.jit_clear_cache_js) w.jit_clear_cache_js();
        console.log(`[dbg] deadFlagElision=${on ? 1 : 0} + cache cleared (fallback; preemption mgr missing)`);
    },
    /** Bisection control: toggle relaxed-FPU mode (our v86 mod) and clear the
     *  JIT cache so FPU-bearing blocks recompile. on=false = accurate F80. */
    relaxedFpu(on = true): void {
        // Route through PreemptionManager — the SINGLE source of truth. It stores the
        // desired state so the NEXT v86 init (per game load) boots with it, AND applies
        // it live + clears the JIT cache. A bare set_relaxed_fpu() here would be undone
        // by preemption-manager's re-apply on the next load → false-positive A/B.
        const pm = (globalThis as any).preemption;
        if (pm?.setRelaxedFpu) {
            pm.setRelaxedFpu(on);
            console.log(`[dbg] relaxedFpu=${on ? 1 : 0} (authoritative — survives game reload) + cache cleared`);
            return;
        }
        const w = wasm(); if (!w) return;
        if (w.set_relaxed_fpu) w.set_relaxed_fpu(on ? 1 : 0);
        if (w.jit_clear_cache_js) w.jit_clear_cache_js();
        console.log(`[dbg] relaxedFpu=${on ? 1 : 0} + cache cleared (fallback; preemption mgr missing)`);
    },
    /** Toggle relaxed-FPU hit/fallback counter collection and clear the JIT cache
     *  so FPU-bearing blocks recompile with/without the counter increment. OFF by
     *  default in production (the increment is a per-op tax on the hottest T&L loop);
     *  turn it ON only while measuring fast-path hit-rate, then read dbg.fpuStats(). */
    fpuStatsEnable(on = true): void {
        const w = wasm(); if (!w) return;
        const setter = w["set_fpu_relaxed_stats"];
        if (typeof setter === "function") setter(on ? 1 : 0);
        if (w["profiler_init"]) w["profiler_init"]();
        if (w.jit_clear_cache_js) w.jit_clear_cache_js();
        console.log(`[dbg] fpuStatsEnable=${on ? 1 : 0} (counters reset + JIT cache cleared)`);
    },
    /** Read relaxed-FPU JIT fast-path counters. Counts are only collected for blocks
     *  compiled while dbg.fpuStatsEnable(true) was active. */
    fpuStats(): { relaxed: number; statsEnabled: number; hit: number; fallback: number; total: number; hitRate: number } | null {
        const w = wasm(); if (!w) return null;
        const hitGetter = w["profiler_fpu_relaxed_hit_get"];
        const fallbackGetter = w["profiler_fpu_relaxed_fallback_get"];
        const hit = typeof hitGetter === "function" ? Number(hitGetter()) : 0;
        const fallback = typeof fallbackGetter === "function" ? Number(fallbackGetter()) : 0;
        const total = hit + fallback;
        const hitRate = total > 0 ? hit / total : 0;
        const relaxed = w.get_relaxed_fpu ? (w.get_relaxed_fpu() >>> 0) : -1;
        const statsGetter = w["get_fpu_relaxed_stats"];
        const statsEnabled = typeof statsGetter === "function" ? (statsGetter() >>> 0) : -1;
        const stats = { relaxed, statsEnabled, hit, fallback, total, hitRate };
        const hint = statsEnabled === 0 && total === 0 ? "  (call dbg.fpuStatsEnable(true) first)" : "";
        console.log(`[dbg] fpu relaxed=${relaxed} statsEnabled=${statsEnabled} hit=${hit} fallback=${fallback} total=${total} hitRate=${(hitRate * 100).toFixed(1)}%${hint}`);
        return stats;
    },
    /** Dispatch-characterisation counters: toggle them
     *  and clear the JIT cache so hot modules recompile WITH the counter increments. OFF by default
     *  (zero cost on the production path). The codegen-emitted counters only land in blocks compiled
     *  while this was ON — so enable it BEFORE driving the workload, then read dbg.dispatchStats(). */
    dispatchStatsEnable(on = true): void {
        const w = wasm(); if (!w) return;
        const setter = w["set_dispatch_stats"];
        if (typeof setter === "function") setter(on ? 1 : 0);
        if (w["profiler_init"]) w["profiler_init"]();
        if (w["jit_dynamic_chain_resolver_diag_reset"]) {
            w["jit_dynamic_chain_resolver_diag_reset"]();
        }
        if (w.jit_clear_cache_js) w.jit_clear_cache_js();
        console.log(`[dbg] dispatchStatsEnable=${on ? 1 : 0} (counters reset + JIT cache cleared). Drive the workload, then dbg.dispatchStats().`);
    },
    /** Read the block-chaining dispatch counters. CHAINABLE FRACTION = chainable/reentry is
     *  the go/no-go number: the share of the per-module dispatch tax a WASM tail-call could
     *  remove. Counts only cover blocks compiled while dbg.dispatchStatsEnable() was active. */
    dispatchStats(): {
        enabled: number; blockExec: number; reentry: number; intraEdge: number;
        chainable: number; dynamic: number; indirect: number; other: number; chainableFraction: number;
        chainedEdge: number; chainBudgetExit: number; chainMiss: number;
        abseipDispatch: number; retChainHit: number; retChainMiss: number;
        syncBoundaryContinue: number;
        dynamicResolver: {
            budgetMisses: number; noMetaMisses: number; stateMisses: number;
            noEntryMisses: number; memoHits: number; metaHits: number;
        };
    } | null {
        const w = wasm(); if (!w) return null;
        const dget = w["profiler_dispatch_stat_get"];
        if (typeof dget !== "function") {
            console.warn("[dbg] profiler_dispatch_stat_get missing — rebuild vendor/v86 (build-wasm.sh)");
            return null;
        }
        const blockExec = Number(dget(0));
        const reentry = Number(dget(1));
        const chainable = Number(dget(2));
        const dynamic = Number(dget(3));
        const indirect = Number(dget(4));
        const chainedEdge = Number(dget(5));
        const chainBudgetExit = Number(dget(6));
        const chainMiss = Number(dget(7));
        const abseipDispatch = Number(dget(10));
        const retChainHit = Number(dget(11));
        const retChainMiss = Number(dget(12));
        const syncBoundaryContinue = Number(dget(13));
        const dynamicResolver = {
            budgetMisses: Number(w["jit_dynamic_chain_resolver_diag_budget_misses"]?.() ?? 0),
            noMetaMisses: Number(w["jit_dynamic_chain_resolver_diag_no_meta_misses"]?.() ?? 0),
            stateMisses: Number(w["jit_dynamic_chain_resolver_diag_state_misses"]?.() ?? 0),
            noEntryMisses: Number(w["jit_dynamic_chain_resolver_diag_no_entry_misses"]?.() ?? 0),
            memoHits: Number(w["jit_dynamic_chain_resolver_diag_memo_hits"]?.() ?? 0),
            metaHits: Number(w["jit_dynamic_chain_resolver_diag_meta_hits"]?.() ?? 0),
        };
        const intraEdge = Math.max(0, blockExec - reentry - chainedEdge);
        const baselineReentry = reentry + chainedEdge;
        const chainableTotal = chainable + chainedEdge;
        const other = Math.max(0, reentry - chainable - dynamic - indirect);
        const chainableFraction = baselineReentry > 0 ? chainableTotal / baselineReentry : 0;
        const getter = w["get_dispatch_stats"];
        const enabled = typeof getter === "function" ? (getter() >>> 0) : -1;
        const pct = (n: number, d: number) => d > 0 ? (n / d * 100).toFixed(1) + "%" : "n/a";
        const hint = enabled === 0 && reentry === 0 ? "  (call dbg.dispatchStatsEnable() first)" : "";
        console.log(
            `[dbg] dispatch enabled=${enabled} blockExec=${blockExec} reentry=${reentry} intraEdge=${intraEdge}\n` +
            `      exits: chainableFallback=${chainable}(${pct(chainable, reentry)}) dynamic=${dynamic}(${pct(dynamic, reentry)}) ` +
            `indirect=${indirect}(${pct(indirect, reentry)}) other=${other}(${pct(other, reentry)})\n` +
            `      chaining: chainedEdge=${chainedEdge} budgetExit=${chainBudgetExit} miss=${chainMiss}\n` +
            `      absEip: dispatch=${abseipDispatch} retChainHit=${retChainHit} retChainMiss=${retChainMiss}\n` +
            `      dynamic resolver: budget=${dynamicResolver.budgetMisses} noMeta=${dynamicResolver.noMetaMisses} ` +
            `state=${dynamicResolver.stateMisses} noEntry=${dynamicResolver.noEntryMisses} ` +
            `memoHit=${dynamicResolver.memoHits} metaHit=${dynamicResolver.metaHits}\n` +
            `      syncBoundary: continued=${syncBoundaryContinue}\n` +
            `      >>> CHAINABLE FRACTION = ${pct(chainableTotal, baselineReentry)} (baseline includes chained edges)${hint}`
        );
        return {
            enabled, blockExec, reentry, intraEdge, chainable, dynamic, indirect, other, chainableFraction,
            chainedEdge, chainBudgetExit, chainMiss, abseipDispatch, retChainHit, retChainMiss,
            syncBoundaryContinue, dynamicResolver,
        };
    },
    /** Round-trip cause split. Answers "why does the
     *  scheduler return to JS main_loop so often" — distinguishes honest 1ms-quantum exits (no free
     *  lunch) from urgent-exits / self-reschedules (potentially recoverable). Pass true to reset. */
    roundTrips(reset = false): any {
        const sched = (System.getInstance() as any).scheduler;
        const s = sched?.roundTripStats;
        const fpu = sched?.fpuSwitchStats ?? null;
        if (!s) { console.warn("[dbg] scheduler.roundTripStats missing — reload worker for new build"); return null; }
        const pct = (n: number, d: number) => d > 0 ? (n / d * 100).toFixed(1) + "%" : "n/a";
        const honestQuantum = Math.max(0, s.ticks - s.urgentTicks);
        const out = { ...s, honestQuantum, fpu,
            urgentPct: pct(s.urgentTicks, s.ticks),
            urgentNoReadyPct: pct(s.urgentNoReady, s.ticks),
            selfReschedulePct: pct(s.selfReschedule, s.selfReschedule + s.realSwitch),
            honestQuantumPct: pct(honestQuantum, s.ticks) };
        console.log(
            `[dbg] round-trips ticks=${s.ticks}\n` +
            `      urgent(WAITING sched)=${s.urgentTicks}(${out.urgentPct}) of which NO-other-READY=${s.urgentNoReady}(${out.urgentNoReadyPct} of ticks) <-- pure recoverable waste\n` +
            `      honest-quantum(urgentExit=false)=${honestQuantum}(${out.honestQuantumPct}) <-- irrecoverable (lengthening quantum hurts latency)\n` +
            `      switches: self-reschedule=${s.selfReschedule}(${out.selfReschedulePct}) real=${s.realSwitch} noRunnable=${s.noRunnable}\n` +
            `      fpu/simd: saves=${fpu?.saves ?? "n/a"} skippedClean=${fpu?.savesSkippedClean ?? "n/a"} ` +
            `dirty=${fpu?.savesDirty ?? "n/a"} noFlag=${fpu?.savesNoDirtyFlag ?? "n/a"} ` +
            `restores=${fpu?.restores ?? "n/a"} skippedOwner=${fpu?.restoresSkippedOwner ?? "n/a"} ` +
            `timerNoFpuSkipped=${fpu?.timerNoFpuRestoreSkipped ?? "n/a"} ` +
            `eligible=${fpu?.timerNoFpuEligible ?? "n/a"} dirty=${fpu?.timerNoFpuDirty ?? "n/a"}`
        );
        if (reset) {
            s.ticks = 0; s.urgentTicks = 0; s.urgentNoReady = 0; s.selfReschedule = 0; s.realSwitch = 0; s.noRunnable = 0;
            if (fpu) {
                fpu.saves = 0; fpu.savesSkippedClean = 0; fpu.savesDirty = 0; fpu.savesNoDirtyFlag = 0; fpu.savesNoCachedState = 0;
                fpu.restores = 0; fpu.restoresSkippedOwner = 0; fpu.restoresNoState = 0;
                fpu.timerNoFpuWarmupClean = 0; fpu.timerNoFpuDirty = 0; fpu.timerNoFpuEligible = 0;
                fpu.timerNoFpuRestoreSkipped = 0; fpu.timerNoFpuBorrowedSave = 0; fpu.timerNoFpuDisabled = 0;
            }
            console.log("[dbg] roundTripStats reset");
        }
        return out;
    },
    /** Per-window scheduler attribution. Unlike boundary EIP sampling this
     *  measures wall time charged to each guest thread, so parked-thread return
     *  addresses cannot masquerade as CPU hotspots. */
    schedulerPerf(reset = false): unknown {
        const sched = (System.getInstance() as any).scheduler;
        if (!sched) return null;
        const out = {
            threadCpuMs: sched.getThreadCpuMs?.() ?? {},
            roundTrips: { ...(sched.roundTripStats ?? {}) },
            sleepPaths: { ...(sched.sleepPathStats ?? {}) },
            threadSummary: sched.getThreadSummary?.() ?? null,
        };
        if (reset) {
            sched.resetThreadCpuMs?.();
            const s = sched.roundTripStats;
            if (s) {
                s.ticks = 0; s.urgentTicks = 0; s.urgentNoReady = 0;
                s.selfReschedule = 0; s.realSwitch = 0; s.noRunnable = 0;
            }
            const p = sched.sleepPathStats;
            if (p) { p.soleRunnableYield = 0; p.blockedWait = 0; }
        }
        console.log(`[dbg][schedulerPerf] ${JSON.stringify(out)}`);
        return out;
    },
    /** Toggle the guest-memory stale-view guard. When ON, every guest-memory view
     *  handed out at a dispatch/accessor boundary (thunk `mem`, Mem.*, AddressSpace)
     *  is wrapped in a Proxy that THROWS on access if its ArrayBuffer was detached by
     *  a WASM growth — i.e. it was field-cached or closure-captured across a re-entry
     *  into the guest (the SetEvent/scheduler stale-view deadlock class). Slow (dev
     *  only). Flip ON before a canary run (e.g. NFS-PU) to prove the no-stale invariant,
     *  then OFF for the fast plain path. */
    memGuard(on = true): void {
        setGuestMemoryStaleGuard(on);
        console.log(`[dbg] memGuard=${on ? 1 : 0} (guest-memory stale-view guard ${on ? "ON — slow, throws on stale access" : "OFF — fast plain views"})`);
    },
    /** Report whether the guest-memory stale-view guard is currently enabled. */
    memGuardStatus(): boolean {
        const on = isGuestMemoryStaleGuardEnabled();
        console.log(`[dbg] memGuard=${on ? 1 : 0}`);
        return on;
    },
    /** Enable static-lib HLE (must run before loadApp so PE-load hooks fire). */
    hleEnable(logOnly = true): void {
        (globalThis as any).hleEnable?.(logOnly);
    },
    hleDisable(): void {
        (globalThis as any).hleDisable?.();
    },
    hleStatus(): void {
        (globalThis as any).hleStatus?.();
    },
    hleReport(): unknown {
        try {
            const rows = (globalThis as any).hleReport?.() ?? [];
            (self as any).postMessage?.({ type: 'dbg_hle_report', ok: true, data: rows });
            return rows;
        } catch (e) {
            (self as any).postMessage?.({ type: 'dbg_hle_report', ok: false, error: String(e) });
            throw e;
        }
    },
    /** Guarded Inner-Loop HLE: per-hook shadow-validation status table
     *  (state / clean calls / guard fails / mismatches). */
    hleHooks(): unknown {
        const rows = libHleManager.getShadowStatuses();
        if (rows.length === 0) { console.log('[dbg][hle] no shadow hooks registered'); return rows; }
        for (const r of rows) {
            console.log(
                `[dbg][hle] ${r.libId}:${r.functionName} state=${r.state} ` +
                `clean=${r.cleanCalls}/${r.targetCalls} guardFails=${r.guardFails} ` +
                `mismatches=${r.mismatches}${r.lastMismatch ? ` last="${r.lastMismatch}"` : ''}`);
        }
        return rows;
    },
    /** Re-arm shadow validation for a hook (or all): dbg.hleShadow('eagl','shader_const_convert',256).
     *  Disabled hooks stay disabled — their patch is gone until reload. */
    hleShadow(libId?: string, fnName?: string, n?: number): number {
        const count = libHleManager.rearmShadow(libId, fnName, n);
        console.log(`[dbg][hle] re-armed ${count} shadow hook(s)`);
        return count;
    },
    /** Manual bail-out: restore a hook's original bytes (A/B lever). */
    hleUnpatch(libId: string, fnName: string): boolean {
        const ok = libHleManager.unpatch(libId, fnName);
        console.log(`[dbg][hle] unpatch ${libId}:${fnName} → ${ok}`);
        return ok;
    },
    /** Galaxy full-module HLE patch stats (exports + vtable slots). */
    galaxyReport(): unknown {
        const inst = System.getInstance().process?.getModule('galaxy') as Galaxy | undefined;
        const stats = inst?.getPatchStats?.() ?? null;
        (self as any).postMessage?.({ type: 'dbg_galaxy_report', ok: true, data: stats });
        return stats;
    },
    /** Force-read live mix/convert kernel pointers (after native Init). */
    galaxyMixerProbe(): unknown {
        const inst = System.getInstance().process?.getModule('galaxy') as Galaxy | undefined;
        const probe = inst?.probeMixer?.() ?? null;
        (self as any).postMessage?.({ type: 'dbg_galaxy_mixer_probe', ok: true, data: probe });
        return probe;
    },
    /** Correlate the hot JIT blocks to guest addr + module:rva (delegates to the
     *  diagnostics global). Reveals exactly which compiled block is spinning. */
    async hotJit(durationMs = 2000, intervalMs = 5, top = 20, threadId = 0): Promise<unknown> {
        // Return the promise so harness/dbgCall can await the sampling window and
        // receive the address table. Fire-and-forget made automated cold-transition
        // profiles race the report and lose the only reliable JIT→guest mapping.
        const rows = await (globalThis as any).dumpHotJitBlocks?.(durationMs, intervalMs, top, threadId);
        if (!Array.isArray(rows)) return null;
        return {
            threadId: threadId >>> 0,
            rows: rows.slice(0, Math.max(1, top | 0)),
            topEips: Array.isArray((rows as any).topEips) ? (rows as any).topEips : [],
        };
    },
    /** Emit hot-blocks INTO the active trace as a UserTiming mark (Level-3 self-symbolizing trace). */
    hotMark(durationMs = 3000, intervalMs = 5): void {
        (globalThis as any).captureHotBlocksMark?.(durationMs, intervalMs);
    },
    /** EIP histogram over a sampling window (delegates to diagnostics eipSample). */
    eipHist(durationMs = 3000, intervalMs = 5): void {
        (globalThis as any).eipSample?.(durationMs, intervalMs);
    },
    /** UE1 script-VM frame inspector: when the guest is inside FFrame::Step (catch it
     *  via eipHist — the two hottest core.dll EIPs), ESI holds the FFrame. Resolves the
     *  executing Node/Object/state names through GNames and prints the bytecode window.
     *  Layout (one UE1 build): UObject.Name@+0x4 (FName index),
     *  FFrame {vtable, Node+0x4, Object+0x8, Code+0xC, Locals+0x10}; GNames = core.dll
     *  export ?names@fname@@...; FNameEntry text at +0xC, UTF-16. Other builds differ
     *  (e.g. ANSI names at +0x20) — extend per-title if needed. */
    uframe(sampleMs = 2000): void {
        const sys = System.getInstance();
        const d: any = sys.process?.dispatcher;
        const mr: any = sys.process?.moduleRegistry;
        const dv: DataView | undefined = d?.cachedDataView;
        if (!d || !mr || !dv) { console.warn("[dbg] uframe: dispatcher/memory unavailable"); return; }
        const u32 = (a: number) => dv.getUint32(a >>> 0, true) >>> 0;
        const core = mr.getByName("core");
        let gnames = 0;
        for (const [n, a] of (core?.exports ?? [])) {
            if (n.startsWith("?names@fname@@")) { gnames = a >>> 0; break; }
        }
        if (!gnames) { console.warn("[dbg] uframe: core.dll fname::Names export not found"); return; }
        const data = u32(gnames), num = u32(gnames + 4);
        const nameStr = (idx: number): string | null => {
            if (!idx || idx >= num) return null;
            const e = u32(data + idx * 4);
            if (!e || e < 0x100000) return null;
            let s = "";
            for (let i = 0; i < 64; i++) {
                const c = dv.getUint16(e + 0x0c + i * 2, true);
                if (c === 0) break;
                if (c < 32 || c > 126) return null;
                s += String.fromCharCode(c);
            }
            return s || null;
        };
        const objName = (p: number): string | null =>
            (p > 0x100000 && p < 0x60000000) ? nameStr(u32(p + 4)) : null;
        const deadline = performance.now() + sampleMs;
        const tick = () => {
            const eip = (d.cachedIpRaw?.[0] ?? 0) >>> 0;
            const esi = (d.cachedReg32Raw?.[6] ?? 0) >>> 0;
            const sym = mr.resolveAddress(eip) ?? "";
            if (/fframe|execendfunctionparms|core\.dll/i.test(sym) && esi > 0x100000) {
                const node = u32(esi + 4), obj = u32(esi + 8), code = u32(esi + 12), locals = u32(esi + 16);
                const nN = objName(node), oN = objName(obj);
                if (nN || oN) {
                    const state = obj > 0x100000 ? nameStr(u32(obj + 0x14)) : null;
                    let hex = "";
                    for (let i = 0; i < 24; i++) hex += dv.getUint8(code + i).toString(16).padStart(2, "0") + " ";
                    console.log(`[dbg] uframe @eip=0x${eip.toString(16)} (${sym})\n` +
                        `  FFrame=0x${esi.toString(16)} Node=0x${node.toString(16)}<${nN ?? "?"}> ` +
                        `Object=0x${obj.toString(16)}<${oN ?? "?"}> state=<${state ?? "?"}> Locals=0x${locals.toString(16)}\n` +
                        `  Code=0x${code.toString(16)}: ${hex}`);
                    return;
                }
            }
            if (performance.now() < deadline) setTimeout(tick, 5);
            else console.log(`[dbg] uframe: no valid FFrame caught in ${sampleMs}ms (guest not in script VM?)`);
        };
        tick();
    },
    /** Present-stall watchdog. Arm after loading a title; auto-dumps on present-stall
     *  (deadlock vs livelock, thread dump, EIP histogram) to console/log/globalThis.__hpFreezeReport.
     *  Opts: {freezeMs, pollMs, burstMs, localsScan, tinyThresh, trajCap}. */
    stallwatch(opts?: Record<string, number>): void { hpFreezeWatchdog.arm(opts as any); },
    stallwatchStop(): void { hpFreezeWatchdog.stop(); },
    stallwatchReport(): void { hpFreezeWatchdog.report(); },
    /** @deprecated Use stallwatch */
    hpwatch(opts?: Record<string, number>): void { hpFreezeWatchdog.arm(opts as any); },
    /** @deprecated Use stallwatchStop */
    hpwatchStop(): void { hpFreezeWatchdog.stop(); },
    /** @deprecated Use stallwatchReport */
    hpwatchReport(): void { hpFreezeWatchdog.report(); },
    /** Read & log a UE1 UFunction's key fields (Name@+0x20, Outer@+0x18, Func@+0x7c) + a raw
     *  window (+0x60..+0x94) so iNative/ParmsSize/FunctionFlags can be eyeballed. */
    ufn(a: number | string): void {
        const w = wasm(); if (!w) return; const p = toAddr(a);
        const r = (o: number) => (w.dbg_read_u32((p + o) >>> 0) >>> 0);
        console.log(`[dbg] UFunction @0x${p.toString(16)} vtable=0x${r(0).toString(16)} Name=0x${r(0x20).toString(16)} Outer=0x${r(0x18).toString(16)} Func=0x${r(0x7c).toString(16)}`);
        (dbg as any).mem((p + 0x60) >>> 0, 0x34);
    },
    /** Replicate UE1 FindFunction: walk class hierarchy from classAddr via SuperField(+0x28),
     *  scanning each class's Children(+0x38) linked by Next(+0x2c) for a UFunction
     *  (vtable 0x130e46d4) whose Name(+0x20)==nameIdx. Logs + dumps the match. */
    findfn(classAddr: number | string, nameIdx: number | string): void {
        const w = wasm(); if (!w) return;
        const r = (a: number) => (w.dbg_read_u32(a >>> 0) >>> 0);
        const want = toAddr(nameIdx) >>> 0;
        const UFVT = 0x130e46d4;
        let cls = toAddr(classAddr) >>> 0, depth = 0;
        const chain: string[] = [];
        while (cls && depth < 20) {
            chain.push(`0x${cls.toString(16)}(n=0x${r(cls + 0x20).toString(16)})`);
            let child = r(cls + 0x38), n = 0;
            while (child && n < 6000) {
                if (r(child) === UFVT && r(child + 0x20) === want) {
                    console.log(`[dbg] findfn FOUND name=0x${want.toString(16)} @0x${child.toString(16)} definedIn=0x${cls.toString(16)} chain: ${chain.join(" -> ")}`);
                    (dbg as any).ufn(child);
                    return;
                }
                child = r(child + 0x2c); n++;
            }
            cls = r(cls + 0x28); depth++;
        }
        console.log(`[dbg] findfn name=0x${want.toString(16)} NOT FOUND; walked: ${chain.join(" -> ")}`);
    },
    /** Dump all guest threads (state + wait reason/handles). Delegates to the
     *  diagnostics-commands global so it's drivable from the page via window.dbg. */
    dumpThreads(): void { (globalThis as any).dumpThreads?.(); },
    /** Describe a kernel handle (event sig/manual, mutex owner, thread state, …). */
    dumpHandle(h: number | string): void { (globalThis as any).dumpHandle?.(h); },
    /** Force-signal an event handle (diagnostic — does the guest unblock?). */
    signalEvent(h: number | string): void { (globalThis as any).signalEvent?.(h); },

    /** Log guest virtual time (the source for GetTickCount/QPC) + wall clock.
     *  Call twice with a delay to measure whether game time is advancing
     *  (rate = Δvirtual/Δwall). rate≈0 → time-gated game logic is frozen. */
    gtime(): void {
        try {
            const ts = TimeService.getInstance();
            console.log(`[dbg] gtime virtual=${ts.nowMs().toFixed(1)} wall=${performance.now().toFixed(1)} vtActive=${ts.isVirtualTimeActive()}`);
        } catch (e) { console.warn('[dbg] gtime err', e); }
    },
    /** Force an overlay repaint of a window (hwnd) — drives paintDialogToOverlay so
     *  you can observe Z-order compositing (e.g. an owner repaint under a live modal)
     *  without waiting for a WM_PAINT burst. Handy to verify owned-popup restamp. */
    repaint(hwnd: number): void {
        try {
            repaintDialogOverlayIfVisible(hwnd >>> 0);
            console.log(`[dbg][repaint] 0x${(hwnd >>> 0).toString(16)}`);
        } catch (e) { console.warn('[dbg] repaint err', e); }
    },
    /** Dump user32 WindowInfo map: class names, visibility, dialog routing flags, children.
     *  Use to find stale visible #32770 or invisible windows stealing mouse routing. */
    u32wins(): void {
        try {
            const wm = System.getInstance().windowManager;
            const active = wm.getActiveHwnd?.() ?? 0;
            const ddraw = (System.getInstance().process?.getModule('ddraw') as any)?.context;
            const gdiHidden = isGdiSurfaceHidden(ddraw);
            const list: any[] = [];
            for (const [hwnd, w] of windows) {
                const abs = getAbsoluteWindowPosition(w);
                list.push({
                    hwnd: `0x${(hwnd >>> 0).toString(16)}`,
                    class: w.nativeClassName ?? '',
                    title: (w.title ?? '').slice(0, 32),
                    visible: !!w.visible,
                    pendingDestroy: !!w.pendingDestroy,
                    abs: [abs.x, abs.y, w.width, w.height],
                    local: [w.x, w.y, w.width, w.height],
                    parent: w.parent ? `0x${w.parent.toString(16)}` : null,
                    children: w.children.length,
                    style: `0x${((w.style ?? 0) >>> 0).toString(16)}`,
                    guestPaint: !!w.guestCustomPaint,
                    overlayFlip: !!w.overlayOnFlipScreen,
                    dialogInit: !!w.dialogInitInProgress,
                    createInProgress: !!w.createInProgress,
                    routeMouse: dialogNeedsPointMouseRouting(w),
                    active: hwnd === active,
                    systemControl: !!w.isSystemControl,
                });
            }
            const routeAny = list.some((w) => w.routeMouse);
            console.log(`[dbg][u32wins][JSON] ${JSON.stringify({
                active: `0x${active.toString(16)}`,
                gdiHidden,
                pointRoutingActive: routeAny,
                count: list.length,
                visible: list.filter((w) => w.visible).length,
                dialogs32770: list.filter((w) => w.class === '#32770').length,
                routeMouse: list.filter((w) => w.routeMouse).map((w) => w.hwnd),
                windows: list,
            })}`);
        } catch (e) { console.warn('[dbg] u32wins err', e); }
    },
    /** Dump the GDI overlay canvas to logs/debug/overlay.png + report render/composite state
     *  and, for each IDB_* dialog static, whether its bitmap still resolves to pixels and what
     *  the overlay holds at its center. Diagnoses "control painted then vanished from overlay". */
    dumpOverlay(): void {
        try {
            const sys = System.getInstance();
            const gdi: any = sys.gdiContext;
            const oc: any = gdi?.getOverlayCanvas?.();
            const render: any = (sys as any).services?.render;
            const ra: any = render?.getActive?.();
            const ddraw: any = (sys.process?.getModule('ddraw') as any)?.context;
            console.log(`[dbg][dumpOverlay] overlay=${oc ? oc.width + 'x' + oc.height : 'null'} hasContent=${gdi?.hasOverlayContent?.()} dirty=${gdi?.isOverlayDirty?.()} renderActive=${!!ra} suppressGdiOverlay=${!!ra?.suppressGdiOverlay} backend=${!!render?.getBackend?.()} ddrawCoopFlags=0x${((ddraw?.cooperative?.flags) ?? 0).toString(16)} gdiSurfaceVisible=${ddraw?.gdiSurfaceVisible}`);
            const mem = (sys.process as any)?.v86?.mem8 ?? (sys.process as any)?.v86?.v86?.cpu?.mem8;
            const octx2 = oc?.getContext?.('2d');
            for (const [hwnd, w] of windows) {
                if (!(w as any).isSystemControl || !(w.title ?? '').startsWith('IDB_')) continue;
                const hb = controlImageHandles.get(hwnd);
                const r = hb ? resolveBitmapRgba(hb, mem) : null;
                const abs = getAbsoluteWindowPosition(w);
                const cx = abs.x + Math.floor((w.width ?? 0) / 2), cy = abs.y + Math.floor((w.height ?? 0) / 2);
                let px = 'n/a';
                try { if (octx2) { const d = octx2.getImageData(cx, cy, 1, 1).data; px = `[${d[0]},${d[1]},${d[2]},${d[3]}]`; } } catch {}
                console.log(`[dbg][dumpOverlay]   "${w.title}" 0x${hwnd.toString(16)} vis=${w.visible} rect=(${abs.x},${abs.y},${w.width},${w.height}) hImg=0x${(hb ?? 0).toString(16)} resolves=${r ? r.width + 'x' + r.height : 'NULL'} overlayPx(${cx},${cy})=${px}`);
            }
            if (oc?.convertToBlob) {
                oc.convertToBlob({ type: 'image/png' }).then((b: Blob) => b.arrayBuffer()).then((ab: ArrayBuffer) => {
                    const bytes = new Uint8Array(ab);
                    let bin = '';
                    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
                    (self as any).postMessage({ type: 'debug_png_dump', name: 'overlay', base64: btoa(bin) });
                    console.log('[dbg][dumpOverlay] posted overlay.png');
                }).catch(() => {});
            }
        } catch (e) { console.warn('[dbg][dumpOverlay] err', e); }
    },
    /** Enumerate every window/dialog control: handle, id, class, GLOBAL rect + click center,
     *  and flags. Use to drive game launchers from a loop — find the button you want, then
     *  dbg.dlgClick(it). Pair with an MCP/canvas screenshot when buttons have no readable title
     *  (match by the center coords printed here). */
    dlgList(): void {
        try {
            const data: DlgControlInfo[] = [];
            for (const [hwnd, w] of windows) data.push(describeDlgControl(hwnd, w));
            // Post back to the page so tooling can read it (window.dbg.lastEvent('dlgList'));
            // worker console.log is invisible to the page console / log stream.
            (self as any).postMessage({ type: 'dbg_event', event: 'dlgList', data });
            console.log(`[dbg][dlgList] ${data.length} windows/controls (posted dbg_event)`);
        } catch (e) { console.warn('[dbg][dlgList] err', e); }
    },
    /** Faithfully click a dialog/launcher control by title substring (case-insensitive), HWND,
     *  or control id. Synthesizes a real WM_MOUSEMOVE/LBUTTONDOWN/LBUTTONUP at the control's
     *  GLOBAL center via InputManager.poll — the same path a canvas click takes — so it drives
     *  JS system controls AND guest-painted launcher hit-zones delivered to the guest wndProc. */
    dlgClick(target: string | number): void {
        try {
            const found = findDlgControl(target);
            if (!found) {
                console.warn(`[dbg][dlgClick] no control matching ${JSON.stringify(target)} — try dbg.dlgList()`);
                (self as any).postMessage({ type: 'dbg_event', event: 'dlgClick', data: { ok: false, target } });
                return;
            }
            const c = describeDlgControl(found.hwnd, found.win);
            const injected = System.getInstance().inputManager.injectClickAtScreen(c.cx, c.cy);
            (self as any).postMessage({ type: 'dbg_event', event: 'dlgClick', data: { ok: injected, ...c } });
            console.log(`[dbg][dlgClick] 0x${found.hwnd.toString(16)} id=${c.id ?? '-'} "${c.title}" @global(${c.cx},${c.cy}) injected=${injected}`);
        } catch (e) { console.warn('[dbg][dlgClick] err', e); }
    },
    /** Dump all HLE windows: hwnd, rect, clientOffset, style bits, active/focus state.
     *  First stop for coordinate-mismatch bugs (WM_MOUSEMOVE lParam vs GetCursorPos). */
    wins(): void {
        try {
            const wm = System.getInstance().windowManager as any;
            const active = wm.getActiveHwnd?.() ?? 0;
            const list: any[] = [];
            for (const [hwnd, w] of (wm.windows ?? new Map())) {
                list.push({
                    hwnd: `0x${(hwnd >>> 0).toString(16)}`,
                    title: (w.title ?? '').slice(0, 24),
                    rect: w.rect ? [w.rect.x, w.rect.y, w.rect.w ?? w.rect.width, w.rect.h ?? w.rect.height] : null,
                    clientOff: [w.clientOffsetX ?? 0, w.clientOffsetY ?? 0],
                    style: `0x${((w.style ?? 0) >>> 0).toString(16)}`,
                    parent: w.parent ? `0x${w.parent.toString(16)}` : null,
                    visible: !!w.visible,
                    active: hwnd === active,
                });
            }
            console.log(`[dbg][wins][JSON] ${JSON.stringify({ active: `0x${active.toString(16)}`, count: list.length, windows: list })}`);
        } catch (e) { console.warn('[dbg] wins err', e); }
    },
    /** Dump + reset the PeekMessage fast-path histogram (__peekDiag in message.ts):
     *  ret0/ret1 counts and dequeued-message-id frequencies since last call. The direct
     *  window into "what message floods the pump". */
    peekstats(): void {
        try {
            (globalThis as any).__peekDiagEnabled = true;
            const d = (globalThis as any).__peekDiag;
            console.log(`[dbg][peekstats][JSON] ${JSON.stringify(d ?? { err: 'no data yet' })}`);
            if (d) { d.ret0 = 0; d.ret1 = 0; d.byMsg = {}; }
        } catch (e) { console.warn('[dbg] peekstats err', e); }
    },
    /** Resolve a THUNK_CODE stub address to its functionId + dll:function name
     *  (reads the MOV EAX,imm32 at the stub head + dispatcher.namesTable). */
    stub(a: number | string): unknown {
        try {
            const addr = toAddr(a);
            const sys = System.getInstance();
            const mem = sys.process?.getCurrentMemory?.();
            const d = sys.process?.dispatcher as any;
            if (!mem || !d) { const report = { err: 'no mem/dispatcher' }; console.log(`[dbg][stub][JSON] ${JSON.stringify(report)}`); return report; }
            const op = mem[addr];
            const id = (mem[addr + 1] | (mem[addr + 2] << 8) | (mem[addr + 3] << 16) | (mem[addr + 4] << 24)) >>> 0;
            const name = op === 0xb8 ? (d.namesTable?.[id] ?? null) : null;
            const bytes = Array.from(mem.subarray(addr, addr + 16)).map((b: number) => b.toString(16).padStart(2, '0')).join(' ');
            const report = { addr: `0x${addr.toString(16)}`, opcode: `0x${op.toString(16)}`, functionId: op === 0xb8 ? id : null, name, bytes };
            console.log(`[dbg][stub][JSON] ${JSON.stringify(report)}`);
            return report;
        } catch (e) { console.warn('[dbg] stub err', e); return { err: String(e) }; }
    },
    /** Disable all WASM hypercall dispatch entries for one handler id (e.g. 17 = _ftol)
     *  so those calls fall through to the JS fallback — which dbg.fastpath() can see and
     *  which can be diffed against the WASM behavior. Live A/B for "is the WASM tier of
     *  this function broken in the built wasm". Re-register via hcon(). */
    hcoff(handlerId: number): void {
        try {
            const hc = (globalThis as any).hypercall;
            if (!hc?.view || hc.hpBase == null) { console.log('[dbg][hcoff][JSON] {"err":"no hypercall manager"}'); return; }
            let n = 0;
            for (const [fid, hid] of hc.registeredEntries as Map<number, number>) {
                if (hid === handlerId) { hc.view.setUint8(hc.hpBase + 0x100 + fid, 0); n++; }
            }
            console.log(`[dbg][hcoff][JSON] ${JSON.stringify({ handlerId, zeroed: n })}`);
        } catch (e) { console.warn('[dbg] hcoff err', e); }
    },
    /** Re-write the full dispatch table from registeredEntries (undo hcoff). */
    hcon(): void {
        try {
            const hc = (globalThis as any).hypercall;
            if (!hc?.view || hc.hpBase == null) { console.log('[dbg][hcon][JSON] {"err":"no hypercall manager"}'); return; }
            let n = 0;
            for (const [fid, hid] of hc.registeredEntries as Map<number, number>) { hc.view.setUint8(hc.hpBase + 0x100 + fid, hid); n++; }
            console.log(`[dbg][hcon][JSON] ${JSON.stringify({ restored: n })}`);
        } catch (e) { console.warn('[dbg] hcon err', e); }
    },
    /** Scan a guest memory range for f32 values within [val-tol, val+tol]. Logs up to
     *  100 matching addresses as JSON. Default range covers the UE1 object heap. */
    scanf32(val: number, tol = 0.0, start: number | string = 0x9000000, end: number | string = 0xa000000): void {
        try {
            const mem = System.getInstance().process?.getCurrentMemory?.();
            if (!mem) { console.warn('[dbg] scanf32: no guest memory'); return; }
            const s = toAddr(start), e = Math.min(toAddr(end), mem.length);
            const dv = new DataView(mem.buffer, mem.byteOffset);
            const hits: string[] = [];
            for (let a = s; a + 4 <= e && hits.length < 100; a += 4) {
                const f = dv.getFloat32(a, true);
                if (f >= val - tol && f <= val + tol) hits.push(`0x${a.toString(16)}:${f}`);
            }
            console.log(`[dbg][scanf32][JSON] ${JSON.stringify({ val, tol, range: [`0x${s.toString(16)}`, `0x${e.toString(16)}`], count: hits.length, hits })}`);
        } catch (e) { console.warn('[dbg] scanf32 err', e); }
    },
    /** Measure the guest-visible RDTSC rate against wall clock (read_tsc wasm export,
     *  the same counter the RDTSC instruction returns). Healthy = ~4.295e9/s (2^32).
     *  A rate far below that (or ~0) means frozen guest DeltaTime for engines that
     *  compute time from rdtsc×GSecondsPerCycle (UE1). */
    tsc(gapMs = 250): void {
        const w = wasm(); if (!w?.read_tsc) { console.log('[dbg][tsc][JSON] {"err":"no read_tsc export"}'); return; }
        const t0 = performance.now(); const s0 = BigInt(w.read_tsc());
        setTimeout(() => {
            const t1 = performance.now(); const s1 = BigInt(w.read_tsc());
            const d = Number(s1 - s0), wall = (t1 - t0) / 1000;
            console.log(`[dbg][tsc][JSON] ${JSON.stringify({ wallMs: +(t1 - t0).toFixed(2), tscDelta: d, ratePerSec: +(d / wall).toExponential(3), healthyRate: 4.295e9 })}`);
        }, gapMs);
    },
    /** Compare the exact millisecond value produced by the inline
     * GetTickCount/timeGetTime x86 formula against the authoritative virtual
     * clock over a short interval. Deltas (not epochs) must agree. */
    async timeInlineAudit(gapMs = 250): Promise<unknown> {
        const w = wasm();
        if (!w?.read_tsc) return { err: 'no read_tsc export' };
        const sample = () => {
            const tsc = BigInt(w.read_tsc());
            const inlineMs = Number((tsc * 1000n >> 32n) & 0xffff_ffffn) >>> 0;
            return {
                wallMs: performance.now(),
                virtualMs: TimeService.getInstance().nowMs(),
                inlineMs,
            };
        };
        const before = sample();
        await new Promise<void>((resolve) => setTimeout(resolve, Math.max(1, gapMs | 0)));
        const after = sample();
        const out = {
            wallDeltaMs: +(after.wallMs - before.wallMs).toFixed(2),
            virtualDeltaMs: +(after.virtualMs - before.virtualMs).toFixed(2),
            inlineDeltaMs: (after.inlineMs - before.inlineMs) >>> 0,
        };
        console.log(`[dbg][timeInlineAudit][JSON] ${JSON.stringify(out)}`);
        return out;
    },
    /** Dump the HypercallDataManager state + the HYPERCALL_PAGE time fields. Diagnoses why the
     *  unified clock / RDTSC is broken: if initialized=false or hasView=false, the manager never
     *  set up; if page.mips==0 / page.perf_lo==0, updateTimeData never populated the time base so
     *  v86 read_tsc falls back to raw wall clock (frozen per-frame delta). vtActive=false means
     *  enableVirtualTime() never ran. Existence of THIS command confirms the latest worker TS is
     *  loaded (rules out a stale worker bundle). JSON. */
    hcstate(): void {
        try {
            const hc = (globalThis as any).hypercall;
            const ts = TimeService.getInstance();
            if (!hc) { console.log('[dbg][hcstate][JSON] {"err":"no hypercall manager on globalThis"}'); return; }
            const out: any = {
                initialized: hc.initialized ?? null,
                enabled: hc.enabled ?? null,
                enablePending: hc.enablePending ?? null,
                hpBase: hc.hpBase != null ? `0x${(hc.hpBase >>> 0).toString(16)}` : null,
                hasView: !!hc.view,
                registeredCount: hc.registeredEntries?.size ?? hc.getRegisteredCount?.() ?? null,
                vtActive: ts.isVirtualTimeActive(),
                nowMs: +ts.nowMs().toFixed(1),
            };
            if (hc.view && hc.hpBase != null) {
                const v = hc.view, b = hc.hpBase >>> 0;
                out.page = {
                    hc_enabled: v.getUint32(b + 0x008, true),
                    tick_count: v.getUint32(b + 0x010, true),
                    perf_lo: v.getUint32(b + 0x014, true) >>> 0,
                    perf_hi: v.getUint32(b + 0x018, true) >>> 0,
                    insn_at_update: v.getUint32(b + 0x02c, true) >>> 0,
                    mips: v.getUint32(b + 0x030, true) >>> 0,
                };
            }
            console.log(`[dbg][hcstate][JSON] ${JSON.stringify(out)}`);
        } catch (e) { console.warn('[dbg] hcstate err', e); }
    },
    /** Dump the last N WinAPI calls from the dispatcher ring buffer — reveals
     *  what the guest is spinning on while a screen won't advance. */
    lastCalls(n = 30): void {
        try {
            const d = System.getInstance().process?.dispatcher as any;
            const calls = d?.getLastWinApiCalls?.(n) ?? [];
            console.log(`[dbg] lastCalls(${n}): ${JSON.stringify(calls)}`);
        } catch (e) { console.warn('[dbg] lastCalls err', e); }
    },
    /** Dump the FULL dispatcher ring (rich, INCLUDING noisy ddraw/d3d/blt calls
     *  that lastCalls() hides) as JSON. Logs a name-frequency histogram + the raw
     *  last `seq` call names in order, so the real per-frame cycle (Flip/Lock/etc.)
     *  is visible past the rand flood. n caps at the 256-entry ring. */
    ring(n = 256, seq = 48): void {
        try {
            const d = System.getInstance().process?.dispatcher as any;
            const rich = d?.getLastWinApiCallsRich?.(n) ?? [];
            const hist: Record<string, number> = {};
            for (const e of rich) hist[e.name] = (hist[e.name] ?? 0) + 1;
            const sorted = Object.entries(hist).sort((a, b) => b[1] - a[1]);
            const tail = rich.slice(Math.max(0, rich.length - seq)).map((e: any) => e.name);
            console.log(`[dbg][ring][JSON] ${JSON.stringify({ total: rich.length, hist: sorted, tail })}`);
        } catch (e) { console.warn('[dbg] ring err', e); }
    },
    /** Dump in-flight async thunks (Promises parked at the spin loop, per thread)
     *  + the pending-restore FIFO (resolved but not yet applied). A thread stuck
     *  for a long `ageMs` is an async op whose Promise never settled — the likely
     *  cause of a thread WAITING(ASYNC_THUNK) forever. Logs JSON. */
    async(): void {
        try {
            const d = System.getInstance().process?.dispatcher as any;
            const now = performance.now();
            const active = Array.from((d?.activeAsyncThunks ?? new Map()).values()).map((t: any) => ({
                tid: t.threadId,
                fn: t.functionName ?? `id_0x${(t.functionId >>> 0).toString(16)}`,
                ageMs: Math.round(now - t.startTime),
                esp: `0x${(t.esp >>> 0).toString(16)}`,
                returnAddr: `0x${(t.returnAddr >>> 0).toString(16)}`,
                callerModuleBase: `0x${(t.callerModuleBase >>> 0).toString(16)}`,
            }));
            const pending = (d?.pendingAsyncRestores ?? []).map((p: any) => ({
                tid: p.info?.threadId,
                name: p.completionName,
                returnValue: `0x${(p.returnValue >>> 0).toString(16)}`,
                returnAddr: `0x${(p.info?.returnAddr >>> 0).toString(16)}`,
                err: !!p.errorFlag,
            }));
            console.log(`[dbg][async][JSON] ${JSON.stringify({ activeCount: active.length, active, pendingCount: pending.length, pending })}`);
        } catch (e) { console.warn('[dbg] async err', e); }
    },
    /** Dump the winmm multimedia-timer subsystem: registered timers (mode/period),
     *  pending-callback queue, fire counters by mode, and the scheduler's
     *  timer-thread dispatch stats (invoked vs empty/deferred/eip-guard). Reveals
     *  whether the Galaxy audio timer fires AND whether its guest callback is
     *  actually invoked on the timer thread. Logs JSON. */
    timers(): void {
        try {
            const sys = System.getInstance();
            const winmm = sys.process?.getModule?.('winmm') as any;
            const sched = sys.scheduler as any;
            const cbMgr = (sys.process as any)?.dispatcher?.callbackManager;
            const out = {
                winmm: winmm?.getTimerDebugState?.() ?? null,
                dispatch: sched?.timerDispatchStats ?? null,
                idlePump: sched?.idlePumpStats ?? null,
                wheelFiredByKind: sched?.timerWheel?.firedByKind
                    ? Array.from(sched.timerWheel.firedByKind as readonly number[]) : null,
                callbackSlots: cbMgr?.getPendingSlotSummary?.() ?? null,
                pinActive: sched?.timerCallbackPinActive ?? null,
                trace: (sched?.timerThreadTrace as string[] | undefined)?.slice(-48) ?? null,
            };
            console.log(`[dbg][timers][JSON] ${JSON.stringify(out)}`);
        } catch (e) { console.warn('[dbg] timers err', e); }
    },
    /** Captured source passed to the still-unimplemented legacy D3DX assembler. */
    d3dxAssembleSamples(): readonly string[] {
        const samples = getD3dxAssembleShaderSamples();
        console.log(`[dbg][d3dxAssembleSamples][JSON] ${JSON.stringify(samples)}`);
        return samples;
    },
    /** D3D9 API call-mix, redundant-setter skips, pipeline cache + executor counters.
     *  dbg.d3d9Perf(1) resets global + per-device subsystem counters first. Logs JSON. */
    d3d9Perf(reset = false): unknown {
        try {
            if (reset) {
                resetD3D9Perf();
                for (const dev of devices.values()) dev.resetSubsystemPerf();
                const dispatcher = System.getInstance().process?.dispatcher as { resetWbufStats?: () => void } | undefined;
                dispatcher?.resetWbufStats?.();
            }
            const snap = getD3D9PerfSnapshot();
            const stateTracker: Record<string, number> = {};
            const backendExtra: Record<string, number> = {};
            for (const dev of devices.values()) {
                const sub = dev.collectSubsystemPerf();
                for (const [k, v] of Object.entries(sub.stateTracker)) {
                    stateTracker[k] = (stateTracker[k] ?? 0) + v;
                }
                for (const [k, v] of Object.entries(sub.backend)) {
                    backendExtra[k] = (backendExtra[k] ?? 0) + v;
                }
            }
            for (const [k, v] of Object.entries(backendExtra)) {
                snap.backend[k] = (snap.backend[k] ?? 0) + v;
            }
            snap.stateTracker = stateTracker;
            snap.stateBlocks.liveBlocks = stateBlocks.size;
            snap.devices = devices.size;
            const d = System.getInstance().process?.dispatcher as {
                getWbufStats?: () => { hits: number; outTrapHits: number; coalescedSkips: number; registered: number };
                getShadowStats?: () => Record<string, number> | null;
            } | undefined;
            snap.wbuf = d?.getWbufStats?.() ?? null;
            // Guest-side setter-shadow skip counters (redundant SetRenderState/SetSamplerState
            // short-circuited in guest code — invisible to the api/skip counters above).
            snap.setterShadow = d?.getShadowStats?.() ?? null;
            console.log(`[dbg][d3d9Perf][JSON] ${JSON.stringify(snap)}`);
            return snap;
        } catch (e) { console.warn('[dbg] d3d9Perf err', e); return null; }
    },
    /** Enumerate created D3D9 vertex/pixel shaders across all devices with a compact
     *  disassembly. Per pixel shader it reports projectedTex/biasedTex counts (texldp/texldb
     *  usage) so we can confirm whether a title relies on projected texture sampling
     *  (projected spotlights / planar reflections) without a one-off probe. Logs JSON;
     *  pass true to also dump each shader's full opcode list. */
    d3d9DumpShaders(full = false): void {
        try {
            let devIdx = 0;
            for (const dev of devices.values()) {
                const dump = (dev as { dumpShaders?: () => unknown }).dumpShaders?.();
                if (!dump) continue;
                const d = dump as {
                    vs: Array<Record<string, unknown>>;
                    ps: Array<{ disasm: string[] } & Record<string, unknown>>;
                    projectedStageKey: number;
                    projectedStages: number[];
                    projectedSetCount: number;
                    projectedFlagsSeen: number;
                };
                const psSummary = d.ps.map(p => {
                    const { disasm, ...rest } = p;
                    return full ? { ...rest, disasm } : rest;
                });
                console.log(`[dbg][d3d9DumpShaders][JSON] ${JSON.stringify({
                    device: devIdx++, vsCount: d.vs.length, psCount: d.ps.length,
                    projectedShaders: d.ps.filter(p => (p.projectedTex as number) > 0).length,
                    projectedStageKey: d.projectedStageKey, projectedStages: d.projectedStages,
                    projectedSetCount: d.projectedSetCount, projectedFlagsSeen: d.projectedFlagsSeen,
                    vs: d.vs, ps: psSummary,
                })}`);
            }
        } catch (e) { console.warn('[dbg] d3d9DumpShaders err', e); }
    },
    /** WASM-resident D3D9 arena stats: command/bump
     *  high-water marks, overflow/ffpFallback/mismatch counters, + (if dbg.d3dWasmPath(true) is
     *  on) the executor's verify-only drain counters aggregated across devices. */
    d3dArenaStats(): void {
        try {
            const stats = d3d9WasmArena.stats();
            const drain = {
                setPipelineCount: 0, pipelineHits: 0, pipelineMisses: 0,
                bindProgrammableCount: 0, drawCount: 0, drawIndexedCount: 0,
                drawUPCount: 0, drawIndexedUPCount: 0,
            };
            for (const dev of devices.values()) {
                const s = dev.getArenaDrainStats();
                for (const k of Object.keys(drain) as (keyof typeof drain)[]) {
                    drain[k] += s[k];
                }
            }
            console.log(`[dbg][d3dArenaStats][JSON] ${JSON.stringify({ ...stats, wasmPathEnabled: isWasmPathEnabled(), drain })}`);
        } catch (e) { console.warn('[dbg] d3dArenaStats err', e); }
    },
    /** Real bypass: programmable-draw pipeline cache key is resolved via the WASM arena
     *  instead of the legacy template-string key. RenderFrame ordering/clears/FFP path are
     *  untouched — see memory d3d9-wasm-arena-phase-ab for the design rationale. */
    d3dWasmPath(on = true): void {
        setWasmPathEnabled(!!on);
        console.log(`[dbg] d3dWasmPath=${on ? 1 : 0} (real bypass: arena-keyed pipeline cache for programmable draws)`);
    },
    /** Optional diagnostic-only exercise of the executor's arena-drain code path (never
     *  touches a GPU encoder). Decoupled from d3dWasmPath — leave OFF for a clean bypass
     *  perf reading; only enable when diagnosing the arena's command-SoA decode path itself. */
    d3dArenaVerifyDrain(on = true): void {
        setArenaVerifyDrainEnabled(!!on);
        console.log(`[dbg] d3dArenaVerifyDrain=${on ? 1 : 0} (diagnostic only, adds overhead — leave off for perf measurement)`);
    },
    /** State-block arena slots (Block A): coverable blocks live in the d3d9-webgpu WASM
     *  arena — Capture = WASM memcpy from the mirror, Apply = WASM diff + delta replay
     *  through the ordinary setters. Default ON. Checked at block CREATION only: flipping
     *  off stops NEW blocks from taking slots; existing slotted blocks keep working (their
     *  values refresh on every Capture, so this is always safe). d3d9Perf().stateBlocks
     *  wasmApplies/wasmCaptures show the served share. */
    d3dWasmBlocks(on = true): void {
        setWasmBlocksEnabled(!!on);
        console.log(`[dbg] d3dWasmBlocks=${on ? 1 : 0} (affects newly created state blocks)`);
    },
    // ── Tier-2 trace-compiler ──────────
    /** Watch the 4 KiB code page(s) containing the given guest addr(s) — Tier-1 recompiles
     *  them with per-block exec counters + indirect-target recording. Accepts a single addr
     *  or an array; hex strings ok. Zero cost for unwatched pages. */
    trace2Watch(addr: number | string | Array<number | string>): void {
        const w = wasm(); if (!w?.trace2_watch_page) { console.warn('[dbg] trace2 exports missing — rebuild v86'); return; }
        const list = Array.isArray(addr) ? addr : [addr];
        for (const a of list) {
            const p = toAddr(a);
            const ok = w.trace2_watch_page(p) >>> 0;
            console.log(`[dbg][trace2] watch page 0x${(p & ~0xFFF).toString(16)} → ${ok ? 'armed' : 'already-watched/full'}`);
        }
    },
    /** Watch the tier-2-promoted pages (known-hot by construction — they crossed the
     *  re-entry threshold) under trace2, up to the 64-page watch cap. This is the
     *  page-selection answer for the region-recompiler flow when no hot-page list is known a
     *  priori: EIP sampling can't see inside cycle slices (JS timers only fire at
     *  yield points → 100% idle-EIP samples). Flow: trace2WatchTier2() → play ~10s →
     *  jitRegions(true). Returns {watched, tier2Total}. */
    trace2WatchTier2(max = 64): { watched: number; tier2Total: number } | null {
        const w = wasm(); if (!w?.trace2_watch_page || !w?.jit_get_tier2_page_at) {
            console.warn('[dbg] trace2/tier2 exports missing — rebuild v86 (build-wasm.sh)');
            return null;
        }
        const total = w.jit_get_tier2_page_count ? (w.jit_get_tier2_page_count() >>> 0) : 0;
        let watched = 0;
        for (let i = 0; i < total && watched < max; i++) {
            const addr = w.jit_get_tier2_page_at(i) >>> 0;
            if (!addr) break;
            if (w.trace2_watch_page(addr) >>> 0) watched++;
        }
        console.log(`[dbg][trace2] watching ${watched}/${total} tier-2 pages (cap ${max})`);
        return { watched, tier2Total: total };
    },
    /** Disable trace2 recording, clear all counters/CFG, de-instrument watched pages. */
    trace2Reset(): void {
        const w = wasm(); if (!w?.trace2_reset) return;
        w.trace2_reset();
        console.log('[dbg][trace2] reset (recording off, pages de-instrumented)');
    },
    /** Stop recording and de-instrument watched pages but KEEP the
     *  collected indirect-target histograms, so the next recompile (with
     *  jitRegions(true)) can grow regions across the recorded indirect edges. */
    trace2UnwatchAll(): void {
        const w = wasm(); if (!w?.trace2_unwatch_all) { console.warn('[dbg] trace2_unwatch_all missing — rebuild v86'); return; }
        w.trace2_unwatch_all();
        console.log('[dbg][trace2] unwatched all (histograms KEPT for region formation)');
    },
    /** Live wasm-table pressure (ungated jit_debug_* — the profiler-gated
     *  jit_get_* accessors are no-ops in the release build). free = free slots of
     *  WASM_TABLE_SIZE(900); modules = live page-groups; hidden = stuck
     *  hidden_wasm_table_indices entries (region-overlap pile-up); maxRegionPages =
     *  largest module's page count. Call it before/after jitRegions to watch churn. */
    jitTable(): Record<string, number> {
        const w = wasm(); if (!w?.jit_debug_free_slots) { console.warn('[dbg] jit_debug_* missing — rebuild v86'); return {}; }
        const s = {
            free: w.jit_debug_free_slots() >>> 0,
            modules: w.jit_debug_module_count() >>> 0,
            pages: w.jit_debug_page_count() >>> 0,
            hidden: w.jit_debug_hidden_count() >>> 0,
            maxRegionPages: w.jit_debug_max_region_pages() >>> 0,
        };
        console.log(`[dbg][jitTable][JSON] ${JSON.stringify(s)}`);
        return s;
    },
    /** Profile-guided region growth across indirect edges.
     *  Flow: trace2Watch(hot pages) → play ~10s → jitRegions(true) → it unwatches
     *  (keeping histograms), enables JIT_INDIRECT_REGIONS, clears the JIT cache;
     *  hot dispatcher code recompiles into indirect-aware regions.
     *  IMPORTANT: does NOT raise the global MAX_PAGES — a separate region page
     *  budget (config idx 8, default 8) caps region growth so only dispatchers
     *  grow. Raising the global cap bloats EVERY module via direct-jump chains
     *  and OOMs V8 (large functions/br_tables). regionPages tunes the budget.
     *  jitRegions(false) restores defaults. Kill-switch: config idx 6. */
    jitRegions(on = true, regionPages = 8, minSharePercent = 2): void {
        const w = wasm(); if (!w?.set_jit_config) return;
        if (on) {
            if (w.trace2_unwatch_all) w.trace2_unwatch_all();
            w.set_jit_config(6, 1);
            w.set_jit_config(7, minSharePercent >>> 0);
            w.set_jit_config(8, regionPages >>> 0);
        } else {
            w.set_jit_config(6, 0);
        }
        if (w.jit_clear_cache_js) w.jit_clear_cache_js();
        const g = (i: number) => (w.get_jit_config ? (w.get_jit_config(i) >>> 0) : -1);
        console.log(`[dbg][trace2] jitRegions=${on ? 'ON' : 'OFF'} MAX_PAGES=${g(1)} INDIRECT_REGIONS=${g(6)} MIN_SHARE=${g(7)}% REGION_PAGES=${g(8)} + cache cleared`);
    },
    trace2Stats(): void {
        const w = wasm(); if (!w?.trace2_enabled) return;
        console.log(`[dbg][trace2][JSON] ${JSON.stringify({
            enabled: !!(w.trace2_enabled() >>> 0),
            watchedPages: w.trace2_watched_page_count() >>> 0,
            slotOverflow: w.trace2_slot_overflow() >>> 0,
            indirectOverflow: w.trace2_indirect_overflow() >>> 0,
        })}`);
    },
    /** Dump the hottest recorded basic blocks (exec counts + static CFG edges). */
    trace2Blocks(top = 40): unknown {
        const w = wasm(); if (!w?.trace2_block_snapshot) return null;
        const n = Math.min(w.trace2_block_snapshot() >>> 0, top);
        const kinds = ['normal', 'cond', 'indirect', 'exit'];
        const rows: any[] = [];
        for (let i = 0; i < n; i++) {
            rows.push({
                addr: '0x' + (w.trace2_block_addr(i) >>> 0).toString(16),
                exec: w.trace2_block_exec(i) >>> 0,
                kind: kinds[w.trace2_block_kind(i) >>> 0] ?? '?',
                ins: w.trace2_block_instructions(i) >>> 0,
                fall: '0x' + (w.trace2_block_succ_fallthrough(i) >>> 0).toString(16),
                taken: '0x' + (w.trace2_block_succ_taken(i) >>> 0).toString(16),
                entry: !!(w.trace2_block_is_entry(i) >>> 0),
            });
        }
        console.log(`[dbg][trace2Blocks][JSON] ${JSON.stringify(rows)}`);
        return rows;
    },
    /** Per-page block-length histogram from the trace2 recorder — the superblock gate:
     *  short avg blocks
     *  (< ~15 instr) on hot pages mean leaf inlining pays. Static avg counts each block
     *  once; weighted avg weights by exec count (what execution actually sees). */
    trace2PageHistogram(): unknown {
        const w = wasm(); if (!w?.trace2_block_snapshot) return null;
        const n = w.trace2_block_snapshot() >>> 0;
        const pages = new Map<number, { blocks: number; ins: number; exec: number; wIns: number }>();
        for (let i = 0; i < n; i++) {
            const addr = w.trace2_block_addr(i) >>> 0;
            const ins = w.trace2_block_instructions(i) >>> 0;
            const exec = w.trace2_block_exec(i) >>> 0;
            const page = addr >>> 12;
            let p = pages.get(page);
            if (!p) { p = { blocks: 0, ins: 0, exec: 0, wIns: 0 }; pages.set(page, p); }
            p.blocks++;
            p.ins += ins;
            p.exec += exec;
            p.wIns += ins * exec;
        }
        const rows = [...pages.entries()]
            .sort((a, b) => b[1].exec - a[1].exec)
            .map(([page, p]) => ({
                page: '0x' + page.toString(16),
                blocks: p.blocks,
                exec: p.exec,
                avgIns: p.blocks > 0 ? +(p.ins / p.blocks).toFixed(1) : 0,
                weightedAvgIns: p.exec > 0 ? +(p.wIns / p.exec).toFixed(1) : 0,
            }));
        console.log(`[dbg][trace2PageHistogram][JSON] ${JSON.stringify(rows)}`);
        return rows;
    },
    /** Dump the recorded indirect-branch target histogram (monomorphism check). */
    trace2Indirects(top = 40): unknown {
        const w = wasm(); if (!w?.trace2_indirect_snapshot) return null;
        const n = Math.min(w.trace2_indirect_snapshot() >>> 0, top);
        const rows: any[] = [];
        for (let i = 0; i < n; i++) {
            rows.push({
                from: '0x' + (w.trace2_indirect_from(i) >>> 0).toString(16),
                target: '0x' + (w.trace2_indirect_target(i) >>> 0).toString(16),
                hits: w.trace2_indirect_hits(i) >>> 0,
            });
        }
        console.log(`[dbg][trace2Indirects][JSON] ${JSON.stringify(rows)}`);
        return rows;
    },
    /** Descriptor builder (print-only): greedy hot-spine traces from the hottest
     *  recorded blocks, following edges whose derived bias ≥ minBias. Stops at indirects,
     *  exits, rejoins, unknown successors, or the trace caps (32 blocks / 256 instrs).
     *  Edge counts are derived from successor block exec counts; marked exact only when
     *  the successor has a single static predecessor. */
    trace2Candidates(top = 8, minBias = 0.85): void {
        const w = wasm(); if (!w?.trace2_block_snapshot) return;
        const n = w.trace2_block_snapshot() >>> 0;
        type Blk = { addr: number; lastIns: number; exec: number; kind: number; cond: number; fall: number; taken: number; ins: number; entry: boolean };
        const blocks = new Map<number, Blk>();
        for (let i = 0; i < n; i++) {
            const b: Blk = {
                addr: w.trace2_block_addr(i) >>> 0,
                lastIns: w.trace2_block_last_ins_addr(i) >>> 0,
                exec: w.trace2_block_exec(i) >>> 0,
                kind: w.trace2_block_kind(i) >>> 0,
                cond: w.trace2_block_condition(i) >>> 0,
                fall: w.trace2_block_succ_fallthrough(i) >>> 0,
                taken: w.trace2_block_succ_taken(i) >>> 0,
                ins: w.trace2_block_instructions(i) >>> 0,
                entry: !!(w.trace2_block_is_entry(i) >>> 0),
            };
            blocks.set(b.addr, b);
        }
        // Static predecessor counts (for exact-vs-estimated edge attribution).
        const preds = new Map<number, number>();
        for (const b of blocks.values()) {
            if (b.fall) preds.set(b.fall, (preds.get(b.fall) ?? 0) + 1);
            if (b.taken) preds.set(b.taken, (preds.get(b.taken) ?? 0) + 1);
        }
        const hottest = [...blocks.values()].sort((a, b) => b.exec - a.exec).slice(0, top);
        const candidates: any[] = [];
        for (const seed of hottest) {
            const spine: any[] = [];
            const visited = new Set<number>();
            let cur: Blk | undefined = seed;
            let totalIns = 0, stop = '', backedge = false;
            while (cur) {
                spine.push({ addr: '0x' + cur.addr.toString(16), exec: cur.exec, ins: cur.ins, kind: cur.kind });
                visited.add(cur.addr);
                totalIns += cur.ins;
                if (spine.length >= 32) { stop = 'cap-blocks'; break; }
                if (totalIns >= 256) { stop = 'cap-instructions'; break; }
                let next = 0;
                if (cur.kind === 0) { // normal
                    next = cur.fall;
                    if (!next) { stop = 'direct-jmp-out-of-module'; break; }
                } else if (cur.kind === 1) { // conditional
                    const f = blocks.get(cur.fall), t = blocks.get(cur.taken);
                    const fc = f?.exec ?? 0, tc = t?.exec ?? 0;
                    if (fc + tc === 0) { stop = 'no-edge-data'; break; }
                    const hot = tc > fc ? cur.taken : cur.fall;
                    const bias = Math.max(fc, tc) / (fc + tc);
                    const exact = (preds.get(hot) ?? 0) === 1;
                    spine[spine.length - 1].bias = +bias.toFixed(3);
                    spine[spine.length - 1].biasExact = exact;
                    if (bias < minBias) { stop = 'weak-bias'; break; }
                    next = hot;
                } else if (cur.kind === 2) { stop = 'indirect'; break; }
                else { stop = 'exit'; break; }
                if (next === seed.addr) { backedge = true; stop = 'backedge-to-entry'; break; }
                if (visited.has(next)) { stop = 'rejoin'; break; }
                const nb = blocks.get(next);
                if (!nb) { stop = 'successor-not-recorded'; break; }
                cur = nb;
            }
            candidates.push({
                entry: '0x' + seed.addr.toString(16), entryExec: seed.exec,
                blocks: spine.length, instructions: totalIns, backedge, stop, spine,
            });
        }
        console.log(`[dbg][trace2Candidates][JSON] ${JSON.stringify(candidates)}`);
    },
    /** Diagnose the guest-side setter-shadow: compare each guest shadow[State] against the JS
     *  state-of-record (stateTracker.renderStates). Any mismatch (shadow != tracker, excluding the
     *  never-set SENTINEL) is a wrong-skip desync — the shadow would skip a SetRenderState the
     *  tracker has NOT got, leaving stale GPU state. Run with `__setterShadow=true` after repro. */
    shadowDiff(): unknown {
        try {
            const disp = System.getInstance().process?.dispatcher as {
                flushWriteBufferForDiagnostics?: () => void;
                dumpShadowValues?: (dll: string, fn: string) => number[] | null;
                getShadowStats?: () => Record<string, number> | null;
                shadowOwnerGlobal?: number;
            } | undefined;
            // Setter trampolines update their shadow when they enqueue the ring
            // entry, while the tracker changes at the next OUT-triggered drain.
            // Flush first so the diagnostic never mistakes that safe lead for a
            // stale-shadow divergence.
            disp?.flushWriteBufferForDiagnostics?.();
            const rsShadow = disp?.dumpShadowValues?.('d3d9', 'IDirect3DDevice9_SetRenderState') ?? null;
            const ssShadow = disp?.dumpShadowValues?.('d3d9', 'IDirect3DDevice9_SetSamplerState') ?? null;
            const tssShadow = disp?.dumpShadowValues?.('d3d9', 'IDirect3DDevice9_SetTextureStageState') ?? null;
            const texShadow = disp?.dumpShadowValues?.('d3d9', 'IDirect3DDevice9_SetTexture') ?? null;
            const fvfShadow = disp?.dumpShadowValues?.('d3d9', 'IDirect3DDevice9_SetFVF') ?? null;
            const dev = [...devices.values()][0] as unknown as {
                stateTracker?: { renderStates?: Int32Array; getFVF?: () => number };
                samplerStates?: Map<number, number>;
                textureStageStates?: Map<number, number>;
                boundTexturePtrs?: Uint32Array | number[];
            } | undefined;
            const trackerRS = dev?.stateTracker?.renderStates;
            const samplerStates = dev?.samplerStates;
            const textureStageStates = dev?.textureStageStates;
            const boundTexturePtrs = dev?.boundTexturePtrs;
            const SENT = -2147483648; // 0x80000000
            const mism: Array<{ state: number; shadow: number; tracker: number }> = [];
            if (rsShadow && trackerRS) {
                for (let st = 0; st < 256; st++) {
                    const shadowV = rsShadow[st] | 0;
                    if (shadowV === SENT) continue; // never-set in shadow → always passes → safe
                    const trackerV = trackerRS[st] | 0;
                    if (shadowV !== trackerV) mism.push({ state: st, shadow: shadowV >>> 0, tracker: trackerV >>> 0 });
                }
            }
            // SS: shadow slot = (sampler<<4)|type; tracker key = (sampler<<16)|type. A shadow value
            // with NO tracker entry is the smoking gun (shadow recorded a set the device never got).
            const ssMism: Array<{ sampler: number; type: number; shadow: number; tracker: number | null }> = [];
            if (ssShadow && samplerStates) {
                for (let idx = 0; idx < 256; idx++) {
                    const shadowV = ssShadow[idx] | 0;
                    if (shadowV === SENT) continue;
                    const sampler = idx >> 4, type = idx & 0xf;
                    const tv = samplerStates.get(((sampler & 0xffff) << 16) | (type & 0xffff));
                    if (tv === undefined || (tv | 0) !== shadowV) {
                        ssMism.push({ sampler, type, shadow: shadowV >>> 0, tracker: tv === undefined ? null : (tv >>> 0) });
                    }
                }
            }
            // TSS: shadow slot = (stage<<6)|type; tracker key remains (stage<<16)|type.
            const tssMism: Array<{ stage: number; type: number; shadow: number; tracker: number | null }> = [];
            if (tssShadow && textureStageStates) {
                for (let idx = 0; idx < 512; idx++) {
                    const shadowV = tssShadow[idx] | 0;
                    if (shadowV === SENT) continue;
                    const stage = idx >> 6, type = idx & 0x3f;
                    const tv = textureStageStates.get(((stage & 0xffff) << 16) | (type & 0xffff));
                    if (tv === undefined || (tv | 0) !== shadowV) {
                        tssMism.push({ stage, type, shadow: shadowV >>> 0, tracker: tv === undefined ? null : (tv >>> 0) });
                    }
                }
            }
            const texMism: Array<{ stage: number; shadow: number; tracker: number }> = [];
            if (texShadow && boundTexturePtrs) {
                for (let stage = 0; stage < Math.min(16, boundTexturePtrs.length); stage++) {
                    const shadowV = texShadow[stage] | 0;
                    if (shadowV === SENT) continue;
                    const trackerV = (boundTexturePtrs[stage] ?? 0) | 0;
                    if (shadowV !== trackerV) texMism.push({ stage, shadow: shadowV >>> 0, tracker: trackerV >>> 0 });
                }
            }
            const fvfTracker = dev?.stateTracker?.getFVF?.();
            const fvfMismatch = !!fvfShadow && fvfTracker !== undefined && (fvfShadow[0] | 0) !== SENT
                && (fvfShadow[0] | 0) !== (fvfTracker | 0);
            const out = {
                ownerGlobal: disp?.shadowOwnerGlobal, skips: disp?.getShadowStats?.() ?? null,
                hasShadow: { renderState: !!rsShadow, samplerState: !!ssShadow, textureStageState: !!tssShadow, texture: !!texShadow, fvf: !!fvfShadow },
                hasTracker: { renderState: !!trackerRS, samplerState: !!samplerStates, textureStageState: !!textureStageStates, texture: !!boundTexturePtrs, fvf: fvfTracker !== undefined },
                rsMismatchCount: mism.length, rsMismatches: mism,
                ssMismatchCount: ssMism.length, ssMismatches: ssMism.slice(0, 40),
                tssMismatchCount: tssMism.length, tssMismatches: tssMism.slice(0, 40),
                textureMismatchCount: texMism.length, textureMismatches: texMism,
                fvfMismatchCount: fvfMismatch ? 1 : 0,
                fvfMismatch: fvfMismatch ? { shadow: fvfShadow![0] >>> 0, tracker: fvfTracker! >>> 0 } : null,
            };
            console.log(`[dbg][shadowDiff][JSON] ${JSON.stringify(out)}`);
            return out;
        } catch (e) {
            console.warn('[dbg] shadowDiff err', e);
            return null;
        }
    },
    /** Dump dsound playback state (per-buffer isPlaying/cursors/notifications) +
     *  the PostThreadMessage counters. Tests the "splash waits on audio" theory:
     *  a buffer the game thinks is playing with a frozen SAB cursor → notifications
     *  never fire; or zero PostThreadMessage(0x400) → audio streaming thread never
     *  serviced. Logs JSON. */
    audio(resetStats = 0): void {
        try {
            const sys = System.getInstance();
            const ds = sys.process?.getModule?.('dsound') as any;
            // Worklet signal stats: SAB written by the AudioWorklet (clip/limited/
            // discontinuity/underrun counters; see audio-ring-buffer.ts STATS_*).
            // dbg.audio(1) → request a counter reset (worklet wipes on next block).
            const statsSab = (globalThis as any).__audioStatsSab as SharedArrayBuffer | undefined;
            let worklet: any = null;
            if (statsSab) {
                const s = new Int32Array(statsSab, 0, 16);
                worklet = {
                    proc: Atomics.load(s, 0), frames: Atomics.load(s, 1),
                    activeRing: Atomics.load(s, 2), activeLegacy: Atomics.load(s, 10),
                    clip: Atomics.load(s, 3), limited: Atomics.load(s, 4),
                    peakMilli: Atomics.load(s, 5),
                    disc: Atomics.load(s, 6), maxJumpMilli: Atomics.load(s, 7),
                    underrunMid: Atomics.load(s, 8), starvedBlocks: Atomics.load(s, 9),
                };
                if (resetStats) Atomics.store(s, 15, 1);
            }
            const out = {
                dsound: ds?.getAudioDebugState?.() ?? null,
                postThread: (globalThis as any).__dbgPostThread ?? { count: 0 },
                worklet,
                statsReset: !!resetStats,
            };
            console.log(`[dbg][audio][JSON] ${JSON.stringify(out)}`);
        } catch (e) { console.warn('[dbg] audio err', e); }
    },
    /** Toggle sole-runnable Sleep virtual-time credit (NFSU audio pump cadence fix).
     *  Default ON; pass false or set globalThis.__noSleepVirtualCredit=true for A/B baseline. */
    sleepCredit(on = true): void {
        (globalThis as any).__noSleepVirtualCredit = !on;
        const s = System.getInstance().scheduler as any;
        console.log(`[dbg][sleepCredit] sole-runnable Sleep virtual credit ${on ? 'ON' : 'OFF (baseline)'} stats=${JSON.stringify(s?.soleRunnableSleepStats ?? null)}`);
    },
    /** Enable opt-in DDraw verbose logs (VTX dump, texture sync, blend sampling). */
    ddrawDiag(on = true): void {
        (globalThis as any).__ddrawVerboseDiag = on;
        (globalThis as any).__vtxDiagEnabled = on;
        if (on) console.log('[dbg] DDraw verbose diagnostics enabled (__ddrawVerboseDiag / __vtxDiagEnabled)');
        else console.log('[dbg] DDraw verbose diagnostics disabled');
    },
    /** Executor render stats: cumulative counters over every draw-losing path
     *  (ring overflow, bad range, no RT) + batching/pass/flush activity.
     *  Sample twice over an interval to get rates. */
    rstats(): void {
        try {
            const dd = System.getInstance().process?.getModule?.('ddraw') as any;
            const exec = dd?.context?.executor ?? (globalThis as any).__ddrawExecutor;
            const stats = exec?.getRenderStats?.() ?? null;
            console.log(`[dbg][rstats][JSON] ${JSON.stringify(stats)}`);
        } catch (e) { console.warn('[dbg] rstats err', e); }
    },
    /** Per-frame renderStats deltas + ring high-water marks for the last n frames
     *  (newest last). One call after a visual glitch answers: did the draw count DROP
     *  (engine stopped emitting) or did skip counters / lightsOvf RISE (we dropped or
     *  degraded), and was any ring at capacity. Returns data (read via harness dbgCall). */
    fstats(n: number = 120): unknown {
        try {
            const dd = System.getInstance().process?.getModule?.('ddraw') as any;
            const exec = dd?.context?.executor ?? (globalThis as any).__ddrawExecutor;
            return exec?.getFrameStats?.(n) ?? null;
        } catch (e) { console.warn('[dbg] fstats err', e); return null; }
    },
    /** One-frame GPU op log. gpuops() arms recording for the next n frames;
     *  gpuops(0) returns the recorded sequence (pass creations with depth loadOp,
     *  immediate draws, batch accumulation/flushes, clears). */
    gpuops(n: number = 1): unknown {
        try {
            const dd = System.getInstance().process?.getModule?.('ddraw') as any;
            const exec = dd?.context?.executor ?? (globalThis as any).__ddrawExecutor;
            if (!exec) return null;
            if (n > 0) { exec.armOpLog(n); return { armed: n }; }
            return exec.getOpLog();
        } catch (e) { console.warn('[dbg] gpuops err', e); return null; }
    },
    /** Dump all DirectDraw surfaces (pixel ptr/dims/caps/mode/GPU state). */
    surfs(): void {
        try {
            const dd = System.getInstance().process?.getModule?.('ddraw') as any;
            console.log(`[dbg][surfs][JSON] ${JSON.stringify(dd?.dbgListSurfaces?.() ?? null)}`);
        } catch (e) { console.warn('[dbg] surfs err', e); }
    },
    /** GPU-readback a surface's texture by PIXEL ptr (see dbg.frame rtSurfacePtr).
     *  Logs min/max/avg luminance + 8x8 RGB grid — ground truth for whether draws
     *  landed on the texture. Async; result logged when the map resolves. */
    surfpix(ptr: number | string): void {
        try {
            const dd = System.getInstance().process?.getModule?.('ddraw') as any;
            dd?.dbgReadSurfacePixels?.(ptr)?.then(
                (r: any) => console.log(`[dbg][surfpix][JSON] ${JSON.stringify(r)}`),
                (e: any) => console.warn('[dbg] surfpix err', e),
            );
        } catch (e) { console.warn('[dbg] surfpix err', e); }
    },
    /** Record FAST-PATH thunk calls over a window (these bypass the WinApi ring:
     *  GetTickCount/QPC/timeGetTime/PeekMessage/CS/etc). Reveals the per-frame polls
     *  the intro uses to decide whether to advance + what value we return. Logs JSON.
     *  lastRet: 0x.. numeric, 0xffffffff(-1)=null/fallthrough, 0xfffffffe(-2)=ctx-switch. */
    fastpath(durationMs = 1500): void {
        const d = System.getInstance().process?.dispatcher as any;
        if (!d?.dbgFastPathStart) { console.warn('[dbg] fastpath: dispatcher missing'); return; }
        d.dbgFastPathStart();
        setTimeout(() => {
            const rows = d.dbgFastPathDump();
            d.dbgFastPathStop();
            console.log(`[dbg][fastpath][JSON] ${JSON.stringify({ windowMs: durationMs, rows })}`);
        }, durationMs);
    },
    /** Dump all loaded PE modules (name/base/size, sorted by base) as JSON. If `addr`
     *  is given, also resolve which module+RVA it falls in. Use to identify an opaque
     *  code address (e.g. a thunk caller) → module:rva for Ghidra. */
    mods(addr?: number | string): void {
        try {
            const mreg = System.getInstance().process?.moduleRegistry as any;
            const map: Map<string, any> = mreg?.modules;
            if (!map) { console.log('[dbg][mods] no moduleRegistry'); return; }
            const list = Array.from(map.values()).map((m: any) => ({
                name: m.name,
                base: `0x${(m.baseAddress >>> 0).toString(16)}`,
                end: `0x${((m.baseAddress + m.size) >>> 0).toString(16)}`,
                size: m.size,
                real: !!m.isRealDll,
            })).sort((a, b) => parseInt(a.base) - parseInt(b.base));
            let hit: any = null;
            if (addr !== undefined) {
                const a = toAddr(addr);
                const m = mreg.getModuleContainingAddress?.(a);
                hit = m ? { addr: `0x${a.toString(16)}`, module: m.name, rva: `0x${((a - m.baseAddress) >>> 0).toString(16)}` } : { addr: `0x${a.toString(16)}`, module: '(none)' };
            }
            console.log(`[dbg][mods][JSON] ${JSON.stringify({ count: list.length, resolve: hit, modules: list })}`);
        } catch (e) { console.warn('[dbg] mods err', e); }
    },
    /** Dump a guest memory range as base64 (one console line) so a packed/unparseable
     *  module's RUNTIME (unpacked) image can be reconstructed offline and fed to Ghidra
     *  at its load base. len capped at 256 KB. */
    dumpb64(a: number | string, len = 0x2000): void {
        try {
            const base = toAddr(a);
            len = Math.min(len >>> 0, 0x40000);
            const mem: Uint8Array | undefined = System.getInstance().process?.getCurrentMemory?.();
            if (!mem) { console.warn('[dbg] dumpb64: no guest memory'); return; }
            if (base + len > mem.length) { console.warn(`[dbg] dumpb64: range exceeds mem (${mem.length})`); return; }
            const slice = mem.subarray(base, base + len);
            // base64 in chunks (String.fromCharCode arg-count limit)
            let bin = '';
            const CH = 0x8000;
            for (let i = 0; i < slice.length; i += CH) {
                bin += String.fromCharCode.apply(null, slice.subarray(i, Math.min(i + CH, slice.length)) as any);
            }
            const b64 = (globalThis as any).btoa(bin);
            console.log(`[dbg][dumpb64][JSON] ${JSON.stringify({ base: `0x${base.toString(16)}`, len, b64 })}`);
        } catch (e) { console.warn('[dbg] dumpb64 err', e); }
    },
    /** Capture the wide-string PAIRS passed to wcscmp/_wcsicmp/wcsstr over a window
     *  (what names the intro VM compares each frame). Logs a frequency histogram JSON.
     *  Reveals if the intro is repeatedly searching for a name it never finds. */
    strcap(durationMs = 1500, top = 40): void {
        const m = System.getInstance().process?.getModule?.('msvcrt') as any;
        if (!m?.dbgStrCapStart) { console.warn('[dbg] strcap: msvcrt missing'); return; }
        m.dbgStrCapStart();
        setTimeout(() => {
            const out = m.dbgStrCapDump(top);
            m.dbgStrCapStop();
            console.log(`[dbg][strcap][JSON] ${JSON.stringify({ windowMs: durationMs, ...out })}`);
        }, durationMs);
    },
    /** Capture ONE full D3D frame — every DrawPrimitive/DrawIndexedPrimitive AND every
     *  Clear — at the next Flip/Present, logged as JSON (built-in RenderDoc). The first
     *  tool to reach for on a "renders black/blank" screen.
     *  Per CLEAR: bg colour the RT is wiped to (clearsTarget/Z/stencil, rects).
     *  Per DRAW: FVF, vert count + first verts, RT, texture0/1 (size/gpuFormat/hasGpuView/
     *  srcColorKey/gpuDirty), blend src/dst, alpha-test func+ref, colorkey, Z, cull,
     *  lighting, fog, stage0 color/alpha ops+args, raw/effective sampler state,
     *  POINT UV-bias application, derived flags, and warnings.
     *  Drivable from the page via window.dbg.frame(); read the JSON from the worker
     *  console (Chrome MCP list_console_messages). Resolves on the next present; logs a
     *  warning if none happens within timeoutMs (guest not presenting). */
    frame(timeoutMs = 4000): void {
        const ddraw = System.getInstance().process?.getModule?.('ddraw') as any;
        if (!ddraw?.captureNextFrame) {
            console.warn('[dbg] frame: ddraw module / captureNextFrame missing (is a DDraw/D3D7 game running?)');
            return;
        }
        let done = false;
        const to = setTimeout(() => {
            if (done) return; done = true;
            console.warn(`[dbg][frame] timed out after ${timeoutMs}ms — no Flip/Present captured. Guest may not be presenting; check dbg.ring for Flip.`);
        }, timeoutMs);
        ddraw.captureNextFrame().then((frame: any) => {
            if (done) return; done = true; clearTimeout(to);
            // Black-screen-focused one-line summary first (skim-friendly), then full JSON.
            const clears = (frame.clears ?? []).map((c: any) =>
                `{idx${c.index} ${c.clearsTarget ? `col=0x${(c.color >>> 0).toString(16).padStart(8, '0')}` : 'no-col'}${c.clearsZ ? ' +Z' : ''}${c.clearsStencil ? ' +S' : ''}${c.rectCount ? ` rects=${c.rectCount}` : ''} rt=0x${(c.rtSurfacePtr >>> 0).toString(16)} ${c.rtWidth}x${c.rtHeight}}`);
            const draws = (frame.drawCalls ?? []).map((d: any) =>
                `#${d.index} ${d.primitiveTypeName} fvf=0x${(d.vertexType >>> 0).toString(16)} n=${d.vertexCount}${d.indexCount ? `/${d.indexCount}i` : ''} ` +
                `tex=${d.tex0 ? `0x${(d.tex0.surfacePtr >>> 0).toString(16)}(${d.tex0.width}x${d.tex0.height},${d.tex0.gpuTextureFormat ?? '?'},view=${d.tex0.hasGpuView ? 'Y' : 'N'},dirty=${d.tex0.gpuDirty ? 'Y' : 'N'})` : 'none'} ` +
                `blend=${d.alphaBlendEnabled ? `${d.srcBlend}/${d.dstBlend}` : 'off'} atest=${d.alphaTestEnabled ? `${d.alphaFunc}@${d.alphaRef}` : 'off'} ` +
                `z=${d.zEnable}/${d.zWrite} cull=${d.cullMode} light=${d.lightingEnabled} cop=${d.colorOp} aop=${d.alphaOp} ` +
                `sampler=${d.effectiveSamplerState ? `${d.effectiveSamplerState.minFilter}/${d.effectiveSamplerState.magFilter}/${d.effectiveSamplerState.mipFilter}@${d.effectiveSamplerState.addressU}/${d.effectiveSamplerState.addressV}` : 'n/a'} ` +
                `uvbias=${d.pointUvBiasApplied === null ? 'n/a' : d.pointUvBiasApplied ? 'Y' : 'N'}${d.warnings?.length ? ` WARN[${d.warnings.join('; ')}]` : ''}`);
            console.log(`[dbg][frame] frame#${frame.frameId} draws=${frame.drawCalls?.length ?? 0} clears=${frame.clears?.length ?? 0}\n  CLEARS:\n    ${clears.join('\n    ') || '(none)'}\n  DRAWS:\n    ${draws.join('\n    ') || '(none)'}`);
            console.log(`[dbg][frame][JSON] ${JSON.stringify(frame)}`);
        }).catch((e: any) => {
            if (done) return; done = true; clearTimeout(to);
            console.warn('[dbg] frame err', e);
        });
    },
    /** Watch thunks matching a glob pattern (delegates to diagnostics watchThunk). */
    wt(pattern: string, opts?: any): void { (globalThis as any).watchThunk?.(pattern, opts); },
    /** Slow-path thunk frequency report (delegates to diagnostics slowPathReport). */
    slow(): void { (globalThis as any).slowPathReport?.(); },

    /** Snapshot the live CPU GP registers (mid-loop `this`/counters). Uses the
     *  dispatcher's cached reg32 Int32Array (live view into v86 regs). */
    regs(): void {
        const d = System.getInstance().process?.dispatcher as any;
        const r = d?.cachedReg32 ?? d?.cpu?.reg32;
        if (!r) { console.log('[dbg] regs: no reg32'); return; }
        const n = ['eax', 'ecx', 'edx', 'ebx', 'esp', 'ebp', 'esi', 'edi'];
        console.log('[dbg] ' + n.map((x, i) => `${x}=0x${(r[i] >>> 0).toString(16)}`).join(' '));
    },

    /** Walk the live PEB/TEB chain exactly as the guest does (fs base -> TEB, TEB+0x30 -> PEB,
     *  PEB+0x10 -> ProcessParameters, +8 -> Flags) and compare to what TebManager set up.
     *  Diagnoses the unreal-gold PEB-walk AV at unreal+0x1e113 (PEB+0x10 read returns 0x57b8
     *  garbage -> #PF). Also dumps the live SEH chain head (fs:[0]) with loop detection. */
    peb(): void {
        const sys = System.getInstance();
        const proc = sys.process as any;
        const sched = sys.scheduler as any;
        const mem: Uint8Array | undefined = proc?.getCurrentMemory?.();
        if (!mem) { console.log('[dbg][peb] no guest memory'); return; }
        const dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
        const u32 = (a: number): number => (a >= 0 && a + 4 <= mem.length) ? (dv.getUint32(a, true) >>> 0) : 0xdeadbeef;
        const hx = (v: number): string => '0x' + ((v >>> 0).toString(16));
        const cpu = proc?.dispatcher?.cpu ?? proc?.v86?.cpu ?? proc?.v86?.v86?.cpu;
        const fsbase = (cpu?.segment_offsets?.[4] ?? 0) >>> 0;
        const eip = (cpu?.instruction_pointer?.[0] ?? 0) >>> 0;
        const teb = sched?.tebManager;
        const curTid = sched?.currentThreadId ?? sched?.getCurrentThreadId?.();
        const mgrPeb = (teb?.getPebAddress?.() ?? 0) >>> 0;
        const mgrTeb = (teb?.getTebAddress?.(curTid) ?? 0) >>> 0;
        const fsSelf = u32(fsbase + 0x18);
        const fsPeb = u32(fsbase + 0x30);
        console.log(`[dbg][peb] eip=${hx(eip)} curTid=${curTid} fsbase=${hx(fsbase)} fs:[0x18]self=${hx(fsSelf)} fs:[0x30]PEB=${hx(fsPeb)}`);
        console.log(`[dbg][peb] mgr: pebAddr=${hx(mgrPeb)} tebAddr=${hx(mgrTeb)} [mgrTeb+0x30]=${hx(u32(mgrTeb + 0x30))}`);
        const guestPeb = fsPeb >>> 0;
        const ppGuest = u32(guestPeb + 0x10);
        const ppMgr = u32(mgrPeb + 0x10);
        console.log(`[dbg][peb] guestPEB=${hx(guestPeb)} +0x08(imgBase)=${hx(u32(guestPeb + 0x08))} +0x10(ProcParams)=${hx(ppGuest)}`);
        console.log(`[dbg][peb] mgrPEB +0x08(imgBase)=${hx(u32(mgrPeb + 0x08))} +0x10(ProcParams)=${hx(ppMgr)}`);
        if (ppGuest && ppGuest !== 0xdeadbeef) {
            console.log(`[dbg][peb] *ProcParams +0=${hx(u32(ppGuest))} +8(Flags)=${hx(u32(ppGuest + 8))} (read of +8 is the faulting access)`);
        }
        let head = u32(fsbase + 0); let n = 0; let line = ''; const seen = new Set<number>(); let loop = false;
        while (head !== 0xffffffff && head !== 0 && n < 24) {
            if (seen.has(head)) { loop = true; break; }
            seen.add(head);
            line += ` [${n}]${hx(head)}->h=${hx(u32(head + 4))}`;
            head = u32(head); n++;
        }
        console.log(`[dbg][peb] SEH head=${hx(u32(fsbase))} (${n} frames${loop ? ', LOOP@' + hx(head) : ''}):${line}`);
    },

    /** Print the current intended config. */
    status(): void {
        console.log(`[dbg] enabled=${cfg.enabled} bps=[${cfg.bps.map((b) => "0x" + b.toString(16)).join(",")}] watches=[${cfg.watches.map((b) => "0x" + b.toString(16)).join(",")}] indirect=${cfg.indirect} stepOnBp=${cfg.stepOnBp} maxDumps=${cfg.maxDumps}`);
    },

    /** One-shot runtime snapshot for automation (MCP / page console). Posts JSON back
     *  to the main thread via dbg_snapshot so callers don't need worker DevTools. */
    snapshot(): void {
        try {
            const sys = System.getInstance();
            const proc = sys.process as any;
            const d = proc?.dispatcher;
            const sched = sys.scheduler as any;
            const now = performance.now();

            const rich = d?.getLastWinApiCallsRich?.(256) ?? [];
            const hist: Record<string, number> = {};
            for (const e of rich) hist[e.name] = (hist[e.name] ?? 0) + 1;
            const ringHist = Object.entries(hist).sort((a, b) => b[1] - a[1]);
            const ringTail = rich.slice(Math.max(0, rich.length - 64)).map((e: any) => e.name);

            const activeAsync = Array.from((d?.activeAsyncThunks ?? new Map()).values()).map((t: any) => ({
                tid: t.threadId,
                fn: t.functionName ?? `id_0x${(t.functionId >>> 0).toString(16)}`,
                ageMs: Math.round(now - t.startTime),
                esp: `0x${(t.esp >>> 0).toString(16)}`,
                returnAddr: `0x${(t.returnAddr >>> 0).toString(16)}`,
            }));
            const pendingAsync = (d?.pendingAsyncRestores ?? []).map((p: any) => ({
                tid: p.info?.threadId,
                name: p.completionName,
                returnValue: `0x${(p.returnValue >>> 0).toString(16)}`,
                err: !!p.errorFlag,
            }));

            const threads: any[] = [];
            const snap = sched?.getThreadStoreSnapshot?.();
            if (snap?.entries?.length) {
                for (const t of snap.entries) {
                    threads.push({
                        id: t.threadId,
                        current: snap.currentThreadId === t.threadId,
                        state: t.state,
                        waitReason: t.waitReason,
                        eip: t.context?.eip != null ? `0x${(t.context.eip >>> 0).toString(16)}` : null,
                        esp: t.context?.esp != null ? `0x${(t.context.esp >>> 0).toString(16)}` : null,
                    });
                }
            } else {
                const cpu = proc?.v86?.cpu || proc?.v86?.v86?.cpu;
                const cur = sched?.currentThreadId ?? null;
                for (const [id, t] of (sched?.threads ?? new Map()) as Map<number, any>) {
                    const isCpu = cur === id && !!cpu;
                    threads.push({
                        id,
                        current: cur === id,
                        state: t.state,
                        waitReason: t.waitInfo?.reason ?? null,
                        eip: isCpu
                            ? `0x${(cpu.instruction_pointer?.[0] >>> 0).toString(16)}`
                            : (t.context?.eip != null ? `0x${(t.context.eip >>> 0).toString(16)}` : null),
                        esp: isCpu
                            ? `0x${(cpu.reg32?.[4] >>> 0).toString(16)}`
                            : (t.context?.esp != null ? `0x${(t.context.esp >>> 0).toString(16)}` : null),
                    });
                }
            }

            const winmm = proc?.getModule?.('winmm');
            const ds = proc?.getModule?.('dsound');
            const mreg = proc?.moduleRegistry;
            const mods = mreg?.modules
                ? Array.from(mreg.modules.values()).map((m: any) => m.name).sort()
                : [];

            const logKeys = /MSS|AIL|waveOut|Sound|MessageBox|Shutdown|Rebel|WINMM|mss32|quick_startup|ExitProcess/i;
            const recentLogs = Logger.getRecentEntries(5000)
                .filter((e) => logKeys.test(e.message))
                .slice(-80)
                .map((e) => ({ c: e.category, m: e.message }));

            const v86 = proc?.v86;
            const data = {
                ts: Date.now(),
                v86Running: !!(v86?.running ?? v86?.v86?.running),
                ring: { total: rich.length, hist: ringHist.slice(0, 30), tail: ringTail },
                async: { active: activeAsync, pending: pendingAsync },
                threads,
                timers: winmm?.getTimerDebugState?.() ?? null,
                audio: {
                    dsound: ds?.getAudioDebugState?.() ?? null,
                    postThread: (globalThis as any).__dbgPostThread ?? { count: 0 },
                },
                mods,
                logs: recentLogs,
            };

            console.log(`[dbg][snapshot][JSON] ${JSON.stringify(data)}`);
            (self as any).postMessage?.({ type: 'dbg_snapshot', ok: true, data });
        } catch (e) {
            console.warn('[dbg] snapshot err', e);
            (self as any).postMessage?.({ type: 'dbg_snapshot', ok: false, error: String(e) });
        }
    },
};

/** Routed from the page bridge: window.dbg.<cmd>(...args) -> {type:"dbg"} -> here. */
export function handleDbgCommand(cmd: string, args: any[]): void {
    const fn = (dbg as any)[cmd];
    if (typeof fn === "function") {
        try { fn(...(args || [])); } catch (e) { console.warn(`[dbg] error in ${cmd}:`, e); }
    } else {
        console.warn(`[dbg] unknown command: ${cmd}`);
    }
}

/** One row of dbg.dlgList / a dbg.dlgClick target description (GLOBAL/screen coords). */
export interface DlgControlInfo {
    hwnd: number;
    id: number | null;
    title: string;
    cls: string;
    x: number; y: number; w: number; h: number;
    cx: number; cy: number;
    visible: boolean;
    customPaint: boolean;
}

export function describeDlgControl(hwnd: number, w: WindowInfo): DlgControlInfo {
    const abs = getAbsoluteWindowPosition(w);
    const width = w.width ?? 0, height = w.height ?? 0;
    return {
        hwnd,
        id: w.controlId ?? null,
        title: w.title ?? '',
        cls: w.systemControlClass || w.nativeClassName || (w.children?.length ? 'window' : ''),
        x: abs.x, y: abs.y, w: width, h: height,
        cx: abs.x + (width >> 1), cy: abs.y + (height >> 1),
        visible: !!w.visible,
        customPaint: !!w.guestCustomPaint,
    };
}

/** Resolve a dlgClick target: HWND or control id (number), or title substring (string). */
export function findDlgControl(target: string | number): { hwnd: number; win: WindowInfo } | undefined {
    if (typeof target === 'number') {
        const t = target >>> 0;
        const byHwnd = windows.get(t);
        if (byHwnd) return { hwnd: t, win: byHwnd };
        for (const [hwnd, w] of windows) if ((w.controlId ?? -1) === target) return { hwnd, win: w };
        return undefined;
    }
    const needle = String(target).trim().toLowerCase();
    let hidden: { hwnd: number; win: WindowInfo } | undefined;
    for (const [hwnd, w] of windows) {
        if (!(w.title ?? '').toLowerCase().includes(needle)) continue;
        if (w.visible) return { hwnd, win: w };
        if (!hidden) hidden = { hwnd, win: w };
    }
    return hidden;
}

/** Collect a dialog's descendant controls (depth-first) with GLOBAL coords. */
export function collectDialogControls(rootHwnd: number): DlgControlInfo[] {
    const out: DlgControlInfo[] = [];
    const visit = (hwnd: number, depth: number): void => {
        if (depth > 8) return;
        const w = windows.get(hwnd);
        if (!w) return;
        for (const childHwnd of w.children) {
            const child = windows.get(childHwnd);
            if (!child) continue;
            out.push(describeDlgControl(childHwnd, child));
            visit(childHwnd, depth + 1);
        }
    };
    visit(rootHwnd, 0);
    return out;
}

/**
 * Emit a 'dialogShow' dbg_event (dialog + its controls with GLOBAL coords) so tooling/loops
 * can `await window.dbg.waitForEvent('dialogShow')` to catch a game launcher the moment it
 * appears, then `window.dbg.dlgClick('Play Game')`. Called by the user32 dialog manager once
 * a modal dialog finishes WM_INITDIALOG. Title-less buttons → correlate by the printed coords
 * against a canvas screenshot.
 */
export function emitDialogShow(rootHwnd: number): void {
    try {
        const w = windows.get(rootHwnd);
        if (!w) return;
        const abs = getAbsoluteWindowPosition(w);
        const data = {
            hwnd: rootHwnd,
            title: w.title ?? '',
            customPaint: !!w.guestCustomPaint,
            rect: { x: abs.x, y: abs.y, w: w.width ?? 0, h: w.height ?? 0 },
            controls: collectDialogControls(rootHwnd),
        };
        (self as any).postMessage({ type: 'dbg_event', event: 'dialogShow', data });
        console.log(`[dbg][dialogShow] 0x${rootHwnd.toString(16)} "${data.title}" controls=${data.controls.length}`);
    } catch (e) { console.warn('[dbg][emitDialogShow] err', e); }
}

(globalThis as any).dbg = dbg;
(globalThis as any).__applyDbgConfig = applyDbgConfig;
