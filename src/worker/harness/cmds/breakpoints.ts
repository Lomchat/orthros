/**
 * Breakpoints & execution control. Three address-breakpoint kinds —
 * don't conflate them: raw EIP, export (moduleRegistry.getExportAddress), and
 * symbol (sidecar map). Plus API breakpoints (JS layer, NO JIT-off) and memory
 * watches. Awaitable: each blocking break resolves on first hit with a
 * fault-grade snapshot, or stays continuous and streams events.
 *
 * Hard constraint (documented loudly): EIP/export/symbol/watch breakpoints
 * require JIT OFF — breakOn auto-calls dbg.enable() and warns that perf
 * collapses while armed. API breakpoints do NOT need JIT off → prefer them for
 * bring-up. Addresses inside the async-park spin loop are refused.
 */

import type { HarnessService, HarnessCtx } from "../service";
import { HarnessError, HarnessErrorCode } from "../rpc";
import { sys, proc } from "../serialize";
import { dbg } from "../../core/debug/dbg-commands";
import { apiBreaks } from "../api-breaks";
import { eipBreaks, type BreakWhen } from "../eip-breaks";
import { symbolMap } from "../symbol-map";

function toAddr(x: number | string): number {
    if (typeof x === "number") return x >>> 0;
    const s = String(x).trim();
    return (s.startsWith("0x") || s.startsWith("0X") ? parseInt(s.slice(2), 16) : parseInt(s, 16)) >>> 0;
}

/** Refuse EIP breakpoints inside the async-park spin loop. */
function assertNotSpinLoop(addr: number): void {
    const sched: any = sys().scheduler as any;
    const base = (sched?.spinLoopBase ?? 0) >>> 0;
    const end = (sched?.spinLoopEnd ?? 0) >>> 0;
    if (base > 0 && end > base && addr >= base && addr < end) {
        throw new HarnessError(`0x${addr.toString(16)} is inside the async-park spin loop [0x${base.toString(16)}..0x${end.toString(16)}) — refusing`, HarnessErrorCode.BAD_ARGS);
    }
}

/** Arm an awaitable EIP breakpoint (auto JIT-off). Resolves on hit, or returns
 *  immediately when continuous. */
function armEip(addr: number, ctx: HarnessCtx, opts: { continuous?: boolean; pause?: boolean; when?: BreakWhen; fast?: boolean }, extra: Record<string, unknown>): Promise<unknown> {
    assertNotSpinLoop(addr);
    let warning: string;
    if (opts.fast) {
        // Keep JIT ON; the cpu.rs page-gate keeps ONLY the bp's page interpreted. Lets a bp fire
        // deep in a long boot at full speed (no global JIT-off crawl). Requires the v86 build with
        // page_contains_bp (public/v86.wasm).
        dbg.bpFast(addr);
        warning = "FAST bp: JIT stays ON, only the bp's 4KiB page is interpreted (page-gate). Near-full speed.";
    } else {
        dbg.enable();        // JIT OFF (required) — perf collapses while armed
        dbg.bp(addr);        // arm the wasm interpreter breakpoint (persists across reloads via cfg)
        warning = "JIT is OFF while this breakpoint is armed — emulator perf collapses. clearBreaks() to restore.";
    }
    return new Promise((resolve) => {
        const id = eipBreaks.arm(addr, {
            runId: ctx.runId,
            once: !opts.continuous,
            pause: opts.pause !== false,
            when: opts.when,
            onHit: opts.continuous ? undefined : (snap) => resolve({ hit: snap, addr: addr >>> 0, warning, ...extra }),
        });
        if (opts.continuous) resolve({ armed: true, id, addr: addr >>> 0, continuous: true, warning, ...extra });
        ctx.signal.addEventListener("abort", () => eipBreaks.disarm(id), { once: true });
    });
}

export function registerBreakpointCommands(svc: HarnessService): void {
    /** breakOn(eip, opts) — raw linear EIP. */
    svc.register("breakOn", (args, ctx) => {
        const addr = toAddr(args[0] as number | string);
        return armEip(addr, ctx, (args[1] ?? {}) as any, { kind: "eip" });
    });

    /** breakOnExport('d3d9.dll!Direct3DCreate9') — resolve via the export table. */
    svc.register("breakOnExport", (args, ctx) => {
        const name = String(args[0] ?? "");
        const bang = name.indexOf("!");
        if (bang < 0) throw new HarnessError("breakOnExport expects 'module!Export'", HarnessErrorCode.BAD_ARGS);
        const mod = name.slice(0, bang).replace(/\.dll$/i, "");
        const exp = name.slice(bang + 1);
        const mr: any = proc()?.moduleRegistry as any;
        const addr = mr?.getExportAddress?.(mod, exp);
        if (addr === undefined) throw new HarnessError(`export ${mod}!${exp} not found (module loaded yet?)`, HarnessErrorCode.NOT_FOUND);
        return armEip(addr >>> 0, ctx, (args[1] ?? {}) as any, { kind: "export", export: name, addr: addr >>> 0 });
    });

    /** breakOnSymbol('core!UInput::ReadInput') — resolve via the sidecar map. */
    svc.register("breakOnSymbol", (args, ctx) => {
        const name = String(args[0] ?? "");
        const addr = symbolMap.resolve(name);
        if (addr === undefined) throw new HarnessError(`symbol '${name}' not in any loaded symbol map (loadSymbols first)`, HarnessErrorCode.NOT_FOUND);
        return armEip(addr, ctx, (args[1] ?? {}) as any, { kind: "symbol", symbol: name });
    });

    /** breakOnApi('d3d9.*' | '*DrawPrimitive*' | 'Direct3DCreate9') — JS layer, no JIT off. */
    svc.register("breakOnApi", (args, ctx) => {
        const pattern = String(args[0] ?? "");
        if (!pattern) throw new HarnessError("breakOnApi expects a pattern", HarnessErrorCode.BAD_ARGS);
        const opts = (args[1] ?? {}) as { continuous?: boolean };
        return new Promise((resolve) => {
            const id = apiBreaks.arm(pattern, {
                runId: ctx.runId,
                continuous: !!opts.continuous,
                onHit: opts.continuous ? undefined : (snap) => resolve({ hit: snap, pattern }),
            });
            if (opts.continuous) resolve({ armed: true, id, pattern, continuous: true });
            ctx.signal.addEventListener("abort", () => apiBreaks.disarm(id), { once: true });
        });
    });

    /** watchMem(addr, {indirect?}) — arm a wasm memory watch (value logged in [DBG]
     *  traces; observe via streamLogs). Requires JIT off. */
    svc.register("watchMem", (args) => {
        const addr = toAddr(args[0] as number | string);
        const opts = (args[1] ?? {}) as { indirect?: boolean };
        dbg.enable();
        dbg.watch(addr, !!opts.indirect);
        return { armed: true, addr, note: "watched value appears in [DBG] traces — use streamLogs(['SYSTEM']) to observe; JIT is OFF" };
    });

    /** headWatch(headAddr, loEip, hiEip) — TEMP crash-hunt: snapshot a guest list head
     *  across context switches, log switch-outs mid-mutation and torn (0) states.
     *  JIT stays ON (deterministic-preserving). headWatch(0) disarms. */
    svc.register("headWatch", (args) => {
        const headAddr = toAddr(args[0] as number | string);
        const loEip = args[1] != null ? toAddr(args[1] as number | string) : 0;
        const hiEip = args[2] != null ? toAddr(args[2] as number | string) : 0;
        const sched: any = sys().scheduler as any;
        if (typeof sched?.setDebugHeadWatch !== "function") throw new HarnessError("scheduler.setDebugHeadWatch unavailable", HarnessErrorCode.BAD_ARGS);
        sched.setDebugHeadWatch(headAddr, loEip, hiEip);
        const disp: any = proc()?.dispatcher as any;   // also sample this dword per-hypercall (report.lastHypercalls)
        if (disp) {
            disp.hcWatchAddr = headAddr >>> 0;
            disp.hcRingEnabled = !!headAddr;            // arm/disarm the hot-path hypercall ring with the watch
        }
        return { armed: !!headAddr, headAddr, loEip, hiEip, note: "events captured to scheduler ring — read with `headWatchDump`; head sampled per-hypercall in report.lastHypercalls" };
    });

    /** xlate(vaddr) — compare physical (identity) read vs CPU paged translation of a guest
     *  linear address. If pa !== va (non-identity) or paVal !== physVal, the CPU sees a
     *  different physical page than identity — a paging/CoW view inconsistency. */
    svc.register("xlate", (args) => {
        const va = toAddr(args[0] as number | string) >>> 0;
        const p: any = proc();
        const cpu: any = p?.v86?.cpu ?? p?.v86?.v86?.cpu;
        if (!cpu) throw new HarnessError("no cpu", HarnessErrorCode.BAD_ARGS);
        const cpuMem: Uint8Array = cpu.mem8;
        const dv: DataView = new DataView(cpuMem.buffer, cpuMem.byteOffset, cpuMem.byteLength);
        const physVal = dv.getUint32(va, true) >>> 0;
        let pa = -1, paVal = -1, err: string | null = null;
        try { pa = cpu.translate_address_system_read(va) >>> 0; paVal = dv.getUint32(pa, true) >>> 0; }
        catch (e) { err = String(e); }
        let cpuVal: number | null = null;
        let cpuReadError: string | null = null;
        try {
            // read32s is the same paged/TLB-aware primitive used by interpreted
            // guest instructions. It can disagree with the raw physical view if a
            // stale or corrupt TLB entry is steering the CPU at another page.
            cpuVal = (cpu.read32s(va) >>> 0);
        } catch (e) {
            cpuReadError = String(e);
        }
        const cr0 = (cpu.cr?.[0] ?? 0) >>> 0, cr3 = (cpu.cr?.[3] ?? 0) >>> 0;
        const h = (n: number) => "0x" + (n >>> 0).toString(16);
        return {
            va: h(va), physVal: h(physVal), pa: pa < 0 ? null : h(pa), paVal: paVal < 0 ? null : h(paVal),
            cpuVal: cpuVal == null ? null : h(cpuVal), cpuReadError,
            identity: pa === va, viewMismatch: pa >= 0 && paVal !== physVal,
            cr0: h(cr0), cr3: h(cr3), paging: !!(cr0 & 0x80000000), err,
        };
    });

    /** headWatchDump() — return captured headWatch events (survives the crash).
     *  `zeroFlips` = per-tick snapshots of the list head flipping to/from 0 (the writer). */
    svc.register("headWatchDump", () => {
        const sched: any = sys().scheduler as any;
        const log: string[] = typeof sched?.getDebugHeadWatchLog === "function" ? sched.getDebugHeadWatchLog() : [];
        const zeros: string[] = typeof sched?.getDebugHeadZeroSnaps === "function" ? sched.getDebugHeadZeroSnaps() : [];
        return { count: log.length, events: log, zeroFlips: zeros };
    });

    /** step(n) — arm an interpreter trace of the next N instructions (-> [DBG] log). */
    svc.register("step", (args) => {
        const n = Math.max(1, Number(args[0] ?? 1) | 0);
        dbg.enable();
        dbg.step(n);
        return { armed: n, note: "instruction trace appears in [DBG] traces (console.error) — observe via streamLogs" };
    });

    /** loadSymbols(module, {name:rva,...}) — install a sidecar symbol map for breakOnSymbol. */
    svc.register("loadSymbols", (args) => {
        const mod = String(args[0] ?? "");
        const entries = (args[1] ?? {}) as Record<string, number>;
        const n = symbolMap.load(mod, entries);
        return { module: mod, symbols: n };
    });

    /** pause() / resume() — stop/run the guest loop via the canonical path (sets the
     *  module-level isPaused; a bare v86.stop() is undone by the 1ms scheduler). */
    svc.register("pause", () => {
        if (!proc()?.v86) throw new HarnessError("no v86 instance", HarnessErrorCode.NO_PROCESS);
        const fn = (globalThis as any).__harnessPause;
        if (!fn) throw new HarnessError("pause hook not installed", HarnessErrorCode.UNSUPPORTED);
        fn();
        return { paused: true };
    });
    svc.register("resume", () => {
        if (!proc()?.v86) throw new HarnessError("no v86 instance", HarnessErrorCode.NO_PROCESS);
        const fn = (globalThis as any).__harnessResume;
        if (!fn) throw new HarnessError("resume hook not installed", HarnessErrorCode.UNSUPPORTED);
        fn();
        return { paused: false };
    });

    /** breaks() — list all armed breakpoints. */
    svc.register("breaks", () => ({ api: apiBreaks.list(), eip: eipBreaks.list(), symbolMaps: symbolMap.loaded() }));

    /** clearBreaks() — disarm everything (and restore JIT via dbg.clear()). */
    svc.register("clearBreaks", () => {
        const api = apiBreaks.clear();
        const eip = eipBreaks.clear();
        dbg.clear();
        return { clearedApi: api, clearedEip: eip, note: "wasm bps/watches cleared; JIT stays off until reload (dbg.jitOn() to re-enable)" };
    });
}
