/**
 * Present-stall freeze watchdog — auto-capture for intermittent UE1-style livelocks.
 *
 * The freeze is a LIVELOCK, not a mutex deadlock: live forensics showed one guest thread
 * pegged in the UE1 script VM (FFrame::Step + execEndFunctionParms), vtime advancing 1:1,
 * audio alive. The stuck loop can be a script float countdown whose exit never fires because
 * a float operand is a degenerate tiny value while DeltaTime is normal → x never reaches
 * target → infinite spin.
 *
 * Two candidate roots (both timing-dependent → match a "random" symptom):
 *   (a) relaxed-FPU mis-compiles an op → denormal/garbage (perf-costing fix), or
 *   (b) FPU/SSE register state leaked across a context switch (free, correctness-only fix).
 * The discriminator is the value's trajectory: a value that was healthy then suddenly
 * collapsed = a discrete corruption event (state-leak); degenerate from the first script-VM
 * entry = computed wrong (relaxed-FPU). This watchdog records both the approach (continuous
 * low-rate trajectory) and a dense capture at the moment of freeze.
 *
 * Arm once after loading a bundle (`window.dbg.stallwatch()`), play until it freezes, and it
 * auto-dumps a structured report to the console + log stream + globalThis.__hpFreezeReport.
 *
 * UE1 calibration notes: GNames = core.dll export `?names@fname@@...`; FNameEntry text @ +0xC
 * UTF-16; UObject.Name @ +0x4 (FName idx), state-FName @ +0x14; FFrame in ESI =
 * {vtable, Node+0x4, Object+0x8, Code+0xC, Locals+0x10}. Layout varies by build — extend
 * per-title if needed (some builds use ANSI names at +0x20).
 */

import { System } from '../system';
import { TimeService } from '../../runtime/time';
import { Logger, LogCategory } from '../logger';
import { ioTraceRing } from './io-trace-ring';

interface WatchOpts {
    /** Present-stall (ms) with no flip that counts as a freeze. */
    freezeMs: number;
    /** Continuous trajectory poll interval (ms). */
    pollMs: number;
    /** Dense capture duration after a freeze is detected (ms). */
    burstMs: number;
    /** Bytes of the FFrame.Locals region to scan for degenerate floats. */
    localsScan: number;
    /** |float| below this (and != 0), or non-finite, is "degenerate". */
    tinyThresh: number;
    /** Trajectory ring capacity. */
    trajCap: number;
}

const DEFAULTS: WatchOpts = {
    freezeMs: 3000,
    pollMs: 200,
    burstMs: 1500,
    localsScan: 0x800,   // 2048 B = 512 floats; covers the prior 0x72c smoking-gun offset
    tinyThresh: 1e-12,   // catches 3e-30 / 1.7e-27 / 2.6e-38; ignores normal gameplay floats
    trajCap: 600,
};

interface TrajSample {
    wall: number;       // performance.now()
    vt: number;         // virtual (game) time
    inVM: boolean;      // guest currently inside FFrame::Step
    obj: string | null; // stuck Object name
    state: string | null;
    degen: number;      // count of degenerate locals this sample
    worstOff: number;   // offset of the most-degenerate local (rel. to Locals base)
    worstVal: number;
}

interface FFrameView {
    eip: number;
    esi: number;
    sym: string;
    node: string | null;
    obj: string | null;
    state: string | null;
    localsPtr: number;
    codePtr: number;
    codeHex: string;
}

function f32hex(v: number): string {
    // Show both the float and its raw bits so a denormal/NaN pattern is unambiguous in the log.
    const b = new ArrayBuffer(4); new DataView(b).setFloat32(0, v, true);
    return `${v} (0x${(new DataView(b).getUint32(0, true) >>> 0).toString(16).padStart(8, '0')})`;
}

class HpFreezeWatchdogImpl {
    private armed = false;
    private timer: ReturnType<typeof setInterval> | null = null;
    private opts: WatchOpts = { ...DEFAULTS };

    private lastSerial = -1;
    private lastSerialChangeWall = 0;
    private freezeLatched = false;
    private bursting = false;

    private traj: TrajSample[] = [];
    private gnames = 0;          // cached GNames address (per v86 load)
    private gnamesData = 0;
    private gnamesNum = 0;

    private lastReport: unknown = null;

    arm(userOpts?: Partial<WatchOpts>): void {
        this.opts = { ...DEFAULTS, ...(userOpts || {}) };
        this.reset();
        ioTraceRing.enable(1024);   // capture the file-read storm; disabled on stop() → zero overhead otherwise
        this.armed = true;
        this.timer = setInterval(() => { try { this.poll(); } catch (e) { /* never let the watchdog throw in the loop */ void e; } }, this.opts.pollMs);
        console.log(`[stallwatch] ARMED — freezeMs=${this.opts.freezeMs} poll=${this.opts.pollMs}ms ` +
            `burst=${this.opts.burstMs}ms localsScan=0x${this.opts.localsScan.toString(16)} tiny<${this.opts.tinyThresh}. ` +
            `Play until it freezes; report auto-dumps to console + log + globalThis.__hpFreezeReport. Stop: dbg.stallwatchStop().`);
    }

    stop(): void {
        this.armed = false;
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
        ioTraceRing.disable();
        console.log('[stallwatch] disarmed.');
    }

    /** Re-print the last captured freeze report (or current live state if none yet). */
    report(): void {
        if (this.lastReport) { console.log('[stallwatch] last freeze report:\n' + JSON.stringify(this.lastReport, null, 2)); return; }
        const m = this.mem();
        const stall = m ? (performance.now() - this.lastSerialChangeWall) : 0;
        console.log(`[stallwatch] no freeze captured yet. armed=${this.armed} presentSerial=${m ? System.getInstance().services.render.getPresentSerial() : '?'} ` +
            `present-stall=${stall.toFixed(0)}ms trajSamples=${this.traj.length}`);
    }

    // --- internals ---

    private reset(): void {
        this.lastSerial = -1;
        this.lastSerialChangeWall = performance.now();
        this.freezeLatched = false;
        this.traj = [];
        this.gnames = this.gnamesData = this.gnamesNum = 0;
    }

    private mem(): { dv: DataView; d: any; mr: any } | null {
        const sys = System.getInstance();
        const d: any = sys.process?.dispatcher;
        const mr: any = sys.process?.moduleRegistry;
        const dv: DataView | undefined = d?.cachedDataView;
        if (!d || !mr || !dv) return null;
        return { dv, d, mr };
    }

    private resolveGNames(dv: DataView, mr: any): boolean {
        if (this.gnames) return true;
        const core = mr.getByName('core');
        for (const [n, a] of (core?.exports ?? [])) {
            if (typeof n === 'string' && n.startsWith('?names@fname@@')) { this.gnames = a >>> 0; break; }
        }
        if (!this.gnames || this.gnames + 8 > dv.byteLength) { this.gnames = 0; return false; }
        this.gnamesData = dv.getUint32(this.gnames, true) >>> 0;
        this.gnamesNum = dv.getUint32(this.gnames + 4, true) >>> 0;
        return true;
    }

    private nameStr(dv: DataView, idx: number): string | null {
        if (!idx || idx >= this.gnamesNum) return null;
        const ea = (this.gnamesData + idx * 4) >>> 0;
        if (ea + 4 > dv.byteLength) return null;
        const e = dv.getUint32(ea, true) >>> 0;
        // Bound the entry + its 64-char (128-byte) text window before any getUint16 read.
        if (!e || e < 0x100000 || (e + 0x0c + 128) > dv.byteLength) return null;
        let s = '';
        for (let i = 0; i < 64; i++) {
            const c = dv.getUint16((e + 0x0c + i * 2) >>> 0, true);
            if (c === 0) break;
            if (c < 32 || c > 126) return null;
            s += String.fromCharCode(c);
        }
        return s || null;
    }

    private objName(dv: DataView, p: number): string | null {
        if (p <= 0x100000 || p >= 0x60000000 || (p + 8) > dv.byteLength) return null;
        return this.nameStr(dv, dv.getUint32((p + 4) >>> 0, true) >>> 0);
    }

    /** If the guest is in FFrame::Step right now, resolve the FFrame. Else null. */
    private catchFFrame(dv: DataView, d: any, mr: any): FFrameView | null {
        const eip = (d.cachedIpRaw?.[0] ?? 0) >>> 0;
        const esi = (d.cachedReg32Raw?.[6] ?? 0) >>> 0;
        const sym = mr.resolveAddress(eip) ?? '';
        if (!/fframe|execendfunctionparms|core\.dll/i.test(sym) || esi <= 0x100000 || (esi + 20) > dv.byteLength) return null;
        if (!this.resolveGNames(dv, mr)) return null;
        const node = dv.getUint32((esi + 4) >>> 0, true) >>> 0;
        const obj = dv.getUint32((esi + 8) >>> 0, true) >>> 0;
        const code = dv.getUint32((esi + 12) >>> 0, true) >>> 0;
        const locals = dv.getUint32((esi + 16) >>> 0, true) >>> 0;
        const nN = this.objName(dv, node), oN = this.objName(dv, obj);
        if (!nN && !oN) return null;
        const state = (obj > 0x100000 && (obj + 0x18) <= dv.byteLength) ? this.nameStr(dv, dv.getUint32((obj + 0x14) >>> 0, true) >>> 0) : null;
        let codeHex = '';
        if (code > 0x100000 && code + 24 < dv.byteLength) {
            for (let i = 0; i < 24; i++) codeHex += dv.getUint8(code + i).toString(16).padStart(2, '0') + ' ';
        }
        return { eip, esi, sym, node: nN, obj: oN, state, localsPtr: locals, codePtr: code, codeHex };
    }

    /** Scan the FFrame.Locals window for degenerate floats. */
    private scanLocals(dv: DataView, localsPtr: number): { list: Array<{ off: number; val: number }>; worstOff: number; worstVal: number } {
        const list: Array<{ off: number; val: number }> = [];
        let worstOff = -1, worstAbs = Infinity, worstVal = 0;
        if (localsPtr <= 0x10000 || localsPtr + this.opts.localsScan > dv.byteLength) return { list, worstOff, worstVal };
        for (let off = 0; off < this.opts.localsScan; off += 4) {
            const v = dv.getFloat32((localsPtr + off) >>> 0, true);
            const bad = !Number.isFinite(v) || (v !== 0 && Math.abs(v) < this.opts.tinyThresh);
            if (!bad) continue;
            list.push({ off, val: v });
            const a = Number.isFinite(v) ? Math.abs(v) : -1; // non-finite sorts worst
            if (a < worstAbs) { worstAbs = a; worstOff = off; worstVal = v; }
        }
        return { list, worstOff, worstVal };
    }

    private poll(): void {
        if (!this.armed || this.bursting) return;
        const m = this.mem();
        if (!m) return;
        const { dv, d, mr } = m;
        const now = performance.now();
        const serial = System.getInstance().services.render.getPresentSerial() >>> 0;

        if (serial !== this.lastSerial) {
            if (this.freezeLatched) {
                const stalled = now - this.lastSerialChangeWall;
                console.log(`[stallwatch] presents RESUMED after ${stalled.toFixed(0)}ms (freeze self-cleared or was a long stall).`);
                Logger.log(LogCategory.SYSTEM, `[stallwatch] presents resumed after ${stalled.toFixed(0)}ms`);
            }
            this.lastSerial = serial;
            this.lastSerialChangeWall = now;
            this.freezeLatched = false;
        }

        // Continuous trajectory: when in the script VM, record degenerate-local stats so we
        // can see WHEN a local first collapsed (the state-leak-vs-relaxed-FPU discriminator).
        const ff = this.catchFFrame(dv, d, mr);
        const vt = (() => { try { return TimeService.getInstance().nowMs(); } catch { return 0; } })();
        if (ff) {
            const s = this.scanLocals(dv, ff.localsPtr);
            this.pushTraj({ wall: now, vt, inVM: true, obj: ff.obj, state: ff.state, degen: s.list.length, worstOff: s.worstOff, worstVal: s.worstVal });
        } else {
            this.pushTraj({ wall: now, vt, inVM: false, obj: null, state: null, degen: 0, worstOff: -1, worstVal: 0 });
        }

        const stall = now - this.lastSerialChangeWall;
        if (!this.freezeLatched && stall >= this.opts.freezeMs) {
            this.freezeLatched = true;
            void this.captureFreeze(stall);
        }
    }

    private pushTraj(s: TrajSample): void {
        this.traj.push(s);
        if (this.traj.length > this.opts.trajCap) this.traj.shift();
    }

    /** Dense capture: EIP histogram + FFrame + per-offset degenerate-local trajectory across the burst. */
    private async captureFreeze(stallAtDetect: number): Promise<void> {
        this.bursting = true;
        try {
        const t0 = performance.now();
        const vt0 = (() => { try { return TimeService.getInstance().nowMs(); } catch { return 0; } })();
        console.log(`[stallwatch] 🧊 FREEZE detected — no flip for ${stallAtDetect.toFixed(0)}ms. Capturing ${this.opts.burstMs}ms…`);
        Logger.log(LogCategory.SYSTEM, `[stallwatch] FREEZE detected (present-stall ${stallAtDetect.toFixed(0)}ms) — capturing`);

        const eipHist = new Map<number, number>();
        let eipSamples = 0;
        // Holder (not a bare `let`) so TS control-flow doesn't narrow the closure-assigned value to `never`.
        const snapHolder: { v: FFrameView | null } = { v: null };
        // per-offset value history (relative to Locals base) to classify stuck vs stepping
        const offHist = new Map<number, number[]>();
        let localScans = 0;
        let lastLocalsScanWall = 0;

        const deadline = t0 + this.opts.burstMs;
        await new Promise<void>((resolve) => {
            const tick = () => {
                try {
                    const m = this.mem();
                    if (m) {
                        const { dv, d, mr } = m;
                        const eip = (d.cachedIpRaw?.[0] ?? 0) >>> 0;
                        if (eip) { eipHist.set(eip, (eipHist.get(eip) ?? 0) + 1); eipSamples++; }
                        const ff = this.catchFFrame(dv, d, mr);
                        if (ff && !snapHolder.v) snapHolder.v = ff;
                        // Scan locals ~every 25ms (cheaper than every tick) and only when we have a frame.
                        const nowW = performance.now();
                        if (ff && nowW - lastLocalsScanWall >= 25) {
                            lastLocalsScanWall = nowW;
                            localScans++;
                            const s = this.scanLocals(dv, ff.localsPtr);
                            for (const { off, val } of s.list) {
                                let h = offHist.get(off); if (!h) { h = []; offHist.set(off, h); }
                                h.push(val);
                            }
                        }
                    }
                } catch (e) { /* a stray OOB read must never abort the capture */ void e; }
                if (performance.now() < deadline) setTimeout(tick, 5);
                else resolve();
            };
            tick();
        });

        // --- analyze ---
        const top = [...eipHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
        const m2 = this.mem();
        const eipTop = top.map(([eip, n]) => ({
            eip: '0x' + eip.toString(16),
            pct: +(100 * n / Math.max(1, eipSamples)).toFixed(1),
            sym: m2 ? (m2.mr.resolveAddress(eip) ?? '?') : '?',
        }));

        // A "tiny float" in the Locals window is AMBIGUOUS: the Locals region is a MIXED struct
        // (objects/ints/floats/vectors), and a guest pointer (0x13xxxxxx) or small int read as a
        // float32 looks like a denormal (~1e-27). So tag each by whether its raw bits look like a
        // guest pointer — only the NON-pointer, finite ones are candidate genuine-float bugs.
        const f32bits = (v: number) => { const b = new ArrayBuffer(4); new DataView(b).setFloat32(0, v, true); return new DataView(b).getUint32(0, true) >>> 0; };
        const looksLikePtr = (u: number) => u >= 0x00400000 && u < 0x90000000; // guest image/heap/module/stack
        const degenOffsets = [...offHist.entries()]
            .map(([off, vals]) => {
                const first = vals[0], last = vals[vals.length - 1];
                let anyNonFinite = false;
                for (const v of vals) { if (!Number.isFinite(v)) { anyNonFinite = true; } }
                const stepping = Number.isFinite(first) && Number.isFinite(last) && first !== last;
                const rawLooksLikePtr = Number.isFinite(last) && looksLikePtr(f32bits(last));
                return {
                    off: '0x' + off.toString(16),
                    samples: vals.length,
                    first: f32hex(first),
                    last: f32hex(last),
                    nonFinite: anyNonFinite,
                    rawLooksLikePtr,
                    classification: rawLooksLikePtr ? 'likely POINTER/INT local (not a float — ignore)'
                        : anyNonFinite ? 'NaN/Inf'
                            : (stepping ? 'stepping-by-~0 (candidate countdown that never converges)' : 'stuck (Δ=0)'),
                };
            })
            .sort((a, b) => b.samples - a.samples)
            .slice(0, 24);
        // Only the non-pointer, finite, tiny ones are real float-bug candidates.
        const floatLikeDegens = degenOffsets.filter(d => !d.rawLooksLikePtr && !d.nonFinite);

        // File-I/O share of the hot loop: hp.dll loader (SetFilePointer/ReadFile storm at +0x79xx/
        // +0x7axx) → a high % means a RESOURCE-LOAD retry loop, not a float-countdown.
        let fileIoSamples = 0;
        if (m2) for (const [eip, n] of eipHist) { const s = m2.mr.resolveAddress(eip) ?? ''; if (/hp\.dll/i.test(s)) fileIoSamples += n; }
        const fileIoPct = +(100 * fileIoSamples / Math.max(1, eipSamples)).toFixed(1);

        // Loop-condition opcode at FFrame.Code: the bytecode the spin is wedged on.
        const EEXPR: Record<number, string> = {
            0x04: 'EX_Return', 0x06: 'EX_Jump', 0x07: 'EX_JumpIfNot (conditional loop back-edge)',
            0x0a: 'EX_Assert', 0x0b: 'EX_Case', 0x0f: 'EX_Let', 0x16: 'EX_EndFunctionParms',
            0x1b: 'EX_VirtualFunction', 0x1c: 'EX_FinalFunction',
        };
        let loopCondition: string | null = null;
        if (snapHolder.v && snapHolder.v.codeHex) {
            const b0 = parseInt(snapHolder.v.codeHex.slice(0, 2), 16) || 0;
            loopCondition = `0x${b0.toString(16)} ${EEXPR[b0] ?? (b0 >= 0x70 ? `Native[0x${b0.toString(16)}]` : '(unknown token)')}`;
        }

        // Wakeup-case probe (read-only). Two waiter classes need DIFFERENT readiness tests:
        //  - handle-based wait (event/sem/mutex): checkWait — satisfiable-but-not-woken = LOST SetEvent.
        //  - ASYNC_THUNK park (handles=[]): checkWait is meaningless (empty → trivially ready).
        //    The real test is the async-restore state from the dispatcher:
        //      hasPendingAsyncRestoreForThread = op DONE, restore queued but NOT applied → A-BLOCKED
        //        (tryApplyPendingAsyncRestoreAtSafePoint not draining it while the spinner runs).
        //      in activeAsyncThunks (no pending restore) = op still IN-FLIGHT (Promise unresolved or
        //        its completion .then starved by the busy worker) → A-STARVED / B.
        let waiters: Array<{ id: number; reason: string; handles: string[]; satisfiable: boolean; result: number; async?: { pendingRestore: boolean; inFlight: boolean; name: string | null; ageMs: number | null } }> = [];
        try { waiters = (System.getInstance().scheduler as any).diagnoseWaiters?.() ?? []; } catch { /* optional */ }
        const disp: any = System.getInstance().process?.dispatcher;
        const active: any[] = (() => { try { return disp?.getActiveAsyncThunks?.() ?? []; } catch { return []; } })();
        const nowW = performance.now();
        waiters = waiters.map(w => {
            if (w.reason !== 'ASYNC_THUNK') return w;
            let pendingRestore = false;
            try { pendingRestore = !!disp?.hasPendingAsyncRestoreForThread?.(w.id); } catch { /* optional */ }
            // For an IN-FLIGHT thunk, surface WHICH async WinAPI it's parked on + how long (age). A
            // large/growing age = the Promise genuinely never resolves (stuck I/O) vs a brief age =
            // its completion .then is merely starved. This is the key unknown for CASE B / A-STARVED.
            const thunk = active.find(t => ((t?.threadId ?? -1) >>> 0) === (w.id >>> 0));
            const inFlight = !!thunk;
            return { ...w, async: { pendingRestore, inFlight, name: thunk?.functionName ?? null, ageMs: thunk ? +(nowW - thunk.startTime).toFixed(0) : null } };
        });
        // GetMessage/PeekMessage/MsgWait async-parks are BENIGN: a thread idle-waiting for input
        // blocks indefinitely by design — its age growing is NORMAL, not a stall cause.
        const BENIGN_ASYNC = /getmessage|peekmessage|msgwait|waitmessage|getqueuestatus/i;
        const aBlocked = waiters.filter(w => w.async?.pendingRestore);
        const aInflightStuck = waiters.filter(w => w.async?.inFlight && !w.async?.pendingRestore && !BENIGN_ASYNC.test(w.async?.name ?? ''));
        const aInflightBenign = waiters.filter(w => w.async?.inFlight && !w.async?.pendingRestore && BENIGN_ASYNC.test(w.async?.name ?? ''));
        const handleSat = waiters.filter(w => w.reason !== 'ASYNC_THUNK' && w.satisfiable);
        const unsigEvents = waiters.filter(w => w.reason === 'SINGLE_OBJECT' && !w.satisfiable).map(w => w.handles.join(''));
        // The genuine livelock subject: the current thread RUNNING (state 2) at a non-spin EIP.
        const curT = (() => { try { return (System.getInstance().scheduler as any).getCurrentThread?.(); } catch { return null; } })();
        const runningSpinner = (curT && curT.state === 2)
            ? { id: curT.id, topSym: eipTop[0]?.sym ?? '?', topPct: eipTop[0]?.pct ?? 0 }
            : null;
        const wakeupCase =
            aBlocked.length > 0
                ? `CASE A-BLOCKED: T${aBlocked.map(w => w.id).join(',')} — async completion DONE (restore QUEUED) but NOT applied this tick. As of the two-phase per-thread drain this should resolve within ~1 tick. If it PERSISTS, the per-thread drain regressed or canApplyCurrentThreadRestore is blocking the resume.`
            : handleSat.length > 0
                ? `CASE A-LOST: T${handleSat.map(w => w.id).join(',')} — handle-wait ALREADY satisfiable but not woken → lost SetEvent wakeup. FIX = wakeup-backstop. winmm-timer-cadence class.`
            : runningSpinner
                ? `LIVELOCK (real): T${runningSpinner.id} RUNNING/spinning at ${runningSpinner.topSym} (${runningSpinner.topPct}% of samples). Benign idle async-waits (GetMessage etc.) are NOT the cause. Likely busy-waiting on a condition a PEER should set — but peers ${waiters.filter(w => w.reason === 'SINGLE_OBJECT' && !w.satisfiable).map(w => 'T' + w.id).join(',')} are long-blocked on un-signalled events [${unsigEvents.join(',')}] (check dumpThreads quantumMs for wait-age). FIND who SetEvents those handles + why it doesn't run. Producer-consumer stall, NOT async-I/O.`
            : aInflightStuck.length > 0
                ? `CASE B / A-STARVED: ${aInflightStuck.map(w => `T${w.id}[${w.async?.name ?? '?'} age=${w.async?.ageMs ?? '?'}ms]`).join(', ')} — non-benign async thunk(s) IN-FLIGHT (Promise unresolved). age≫burst = the async op GENUINELY never resolves (stuck I/O) → fix the async I/O impl; age≈small = completion .then starved.`
            : aInflightBenign.length > 0 || unsigEvents.length > 0
                ? `ALL-IDLE/BLOCKED: no RUNNING spinner; only benign idle waits (${aInflightBenign.map(w => 'T' + w.id + '[' + (w.async?.name ?? '?') + ']').join(',') || 'none'}) + handle-waiters on un-signalled events [${unsigEvents.join(',')}]. The stall is a never-signalled event — find its producer (who should SetEvent + why it doesn't run/exited).`
                : 'no WAITING threads at freeze — re-examine eipTop.';

        // File-I/O trace (v3): WHICH file + offset is the spinning script hammering? The ring is
        // armed at arm() so by freeze it holds the most-recent ops. A single package re-seeked
        // across a wide offset range = a RESOURCE HUNT (script looping to find a not-found resource).
        const ioOps = ioTraceRing.snapshot();
        const base = (p: string) => p.split(/[\\/]/).pop() || p;
        const ioByFile: Record<string, { ops: number; reads: number; seeks: number; minPos: number; maxPos: number; bytes: number }> = {};
        for (const e of ioOps) {
            const k = base(e.path);
            const r = ioByFile[k] ?? (ioByFile[k] = { ops: 0, reads: 0, seeks: 0, minPos: Infinity, maxPos: -Infinity, bytes: 0 });
            r.ops++; if (e.op === 'read') r.reads++; else if (e.op === 'seek') r.seeks++;
            if (e.pos < r.minPos) r.minPos = e.pos; if (e.pos > r.maxPos) r.maxPos = e.pos; r.bytes += e.size;
        }
        const ioRecent = ioOps.slice(-30).map(e => ({
            dtMs: +(e.wall - t0).toFixed(0), op: e.op, file: base(e.path), pos: e.pos, size: e.size, ret: e.ret,
        }));
        const fileIo = {
            totalOps: ioOps.length,
            byFile: ioByFile,
            recent: ioRecent,
            note: ioOps.length === 0
                ? 'ring empty — storm not hitting the kernel32 fast paths (overlapped/slow path?) or no file I/O this freeze'
                : 'a single file with seeks≫1 over a wide [minPos..maxPos] range = resource-hunt loop (the likely root)',
        };

        const vt1 = (() => { try { return TimeService.getInstance().nowMs(); } catch { return 0; } })();
        const wallDelta = performance.now() - t0;
        const vtDelta = vt1 - vt0;
        // vtime advancing during a present-stall = LIVELOCK (engine clock runs, nothing draws).
        // vtime frozen = candidate DEADLOCK (all threads blocked) → different bug class.
        const vtimeAdvancing = vtDelta > wallDelta * 0.2;

        // Trajectory tail: when did degenerate locals first appear (approach to the freeze)?
        const tail = this.traj.slice(-40).map(s => ({
            dtMs: +(s.wall - t0).toFixed(0),    // negative = before freeze detect
            inVM: s.inVM, obj: s.obj, state: s.state, degen: s.degen,
            worst: s.worstOff >= 0 ? { off: '0x' + s.worstOff.toString(16), val: f32hex(s.worstVal) } : null,
        }));
        const firstDegenIdx = this.traj.findIndex(s => s.degen > 0);
        const firstDegenAtMs = firstDegenIdx >= 0 ? +(this.traj[firstDegenIdx].wall - t0).toFixed(0) : null;

        const report = {
            kind: 'hp-freeze',
            detectedStallMs: +stallAtDetect.toFixed(0),
            burstMs: this.opts.burstMs,
            eipSamples,
            localScans,
            verdict: {
                deadlockVsLivelock: vtimeAdvancing
                    ? 'LIVELOCK — vtime advancing while presents stalled (one thread spinning). Confirm one EIP-top is FFrame::Step/execEndFunctionParms below.'
                    : 'vtime NOT advancing — possible DEADLOCK (all threads WAITING). Check thread dump below; if so this is a different bug than the script-spin.',
                wakeupCase,
                loopCondition,
                fileIoPct,
                // The Locals scan is TYPE-BLIND: pointers/ints look like denormal floats, so do NOT
                // infer relaxed-FPU from the raw degen count. Only floatLikeDegens (non-pointer,
                // finite, tiny) are real float-bug candidates.
                floatBugCandidates: floatLikeDegens.length === 0
                    ? 'NONE once pointer/int locals are excluded → NO evidence for a float/relaxed-FPU root this run. Likely a RESOURCE-LOAD retry loop (see fileIoPct + loopCondition) rather than a float countdown.'
                    : `${floatLikeDegens.length} candidate non-pointer tiny float local(s): ${floatLikeDegens.map(d => d.off).join(',')} — inspect these + decode the loopCondition operands before suspecting relaxed-FPU.`,
            },
            vtime: { wallDeltaMs: +wallDelta.toFixed(0), vtDeltaMs: +vtDelta.toFixed(0), advancing: vtimeAdvancing },
            stuckFrame: snapHolder.v ? {
                eip: '0x' + snapHolder.v.eip.toString(16), sym: snapHolder.v.sym,
                node: snapHolder.v.node, object: snapHolder.v.obj, state: snapHolder.v.state,
                localsPtr: '0x' + snapHolder.v.localsPtr.toString(16),
                codePtr: '0x' + snapHolder.v.codePtr.toString(16), codeBytes: snapHolder.v.codeHex.trim(),
            } : null,
            eipTop,
            waiters,
            fileIo,
            degenOffsets,
            trajectory: { firstDegenAtMs, samples: this.traj.length, tail },
        };

        this.lastReport = report;
        (globalThis as any).__hpFreezeReport = report;
        const json = JSON.stringify(report, null, 2);
        console.log('[stallwatch] ===== FREEZE REPORT =====\n' + json + '\n[stallwatch] ===== END =====');
        Logger.log(LogCategory.SYSTEM, '[stallwatch] FREEZE REPORT ' + JSON.stringify(report));

        // Thread states (logs separately) — confirms one-thread-pegged (livelock) vs all-WAITING (deadlock).
        try { (globalThis as any).dumpThreads?.(); } catch { /* optional */ }
        } catch (e) {
            console.warn('[stallwatch] capture error (report may be partial):', e);
        } finally {
            // Stay latched; poll() clears the latch + re-arms detection when presents resume.
            this.bursting = false;
        }
    }
}

export const hpFreezeWatchdog = new HpFreezeWatchdogImpl();
