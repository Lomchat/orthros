/**
 * audio — audio-pump rate instrumentation over the harness RPC.
 *
 * The NFSU-class perf question "is the guest's DSound streaming pump waking up
 * faithfully (~few times/frame) or storming (hundreds/s)?" needs RATES, not the
 * raw monotonic counters that dsound.dbgAudioCalls / winmm.dbgTimerStats already
 * keep. audioPump({ms}) snapshots both plus the scheduler's round-trip/FPU-switch
 * counters, waits a wall-clock window, snapshots again and returns deltas/sec —
 * one POJO that answers "wakeups/s, locks/s, bytes-per-lock, timer fires/s,
 * context switches/s" without grepping the log firehose.
 */

import type { HarnessService } from "../service";
import { sys, getModule, symbolize } from "../serialize";

interface PumpSnapshot {
    tMs: number;
    dsound: Record<string, number> | null;
    timer: Record<string, number> | null;
    sched: { realSwitch: number; selfReschedule: number; ticks: number; urgentTicks: number } | null;
    fpu: { saves: number; savesSkippedClean: number; restores: number } | null;
    threadCpuMs: Record<number, number> | null;
}

function snapshot(): PumpSnapshot {
    const ds: any = getModule("dsound");
    const mm: any = getModule("winmm");
    const sched: any = sys().scheduler as any;
    const rt = sched?.roundTripStats;
    const fp = sched?.fpuSwitchStats;
    return {
        tMs: performance.now(),
        dsound: ds?.dbgAudioCalls ? { ...ds.dbgAudioCalls } : null,
        timer: mm?.dbgTimerStats ? { ...mm.dbgTimerStats } : null,
        sched: rt ? { realSwitch: rt.realSwitch, selfReschedule: rt.selfReschedule, ticks: rt.ticks, urgentTicks: rt.urgentTicks } : null,
        fpu: fp ? { saves: fp.saves, savesSkippedClean: fp.savesSkippedClean, restores: fp.restores } : null,
        threadCpuMs: sched?.getThreadCpuMs?.() ?? null,
    };
}

/** Per-second deltas between two counter records (keys present in both). */
function ratesPerSec(a: Record<string, number> | null, b: Record<string, number> | null, dtSec: number): Record<string, number> | null {
    if (!a || !b || dtSec <= 0) return null;
    const out: Record<string, number> = {};
    for (const k of Object.keys(b)) {
        const va = a[k], vb = b[k];
        if (typeof va !== "number" || typeof vb !== "number") continue;
        const d = vb - va;
        if (d !== 0) out[k] = Math.round((d / dtSec) * 10) / 10;
    }
    return out;
}

export function registerAudioCommands(svc: HarnessService): void {
    /** audioPump({ms?=2000}) — sample audio-pump + timer + scheduler counter rates
     *  over a wall-clock window. Rates are deltas/sec; zero-delta keys are omitted.
     *  bytesPerLock/lockedBytesPerSec quantify the streaming granularity: a faithful
     *  pump locks a few KB a few times per frame; a storming pump shows locksPerSec
     *  in the hundreds with tiny bytesPerLock. */
    svc.register("audioPump", async (args) => {
        const opts = (args[0] ?? {}) as { ms?: number };
        const windowMs = Math.min(30_000, Math.max(100, opts.ms ?? 2000));
        const before = snapshot();
        await new Promise((r) => setTimeout(r, windowMs));
        const after = snapshot();
        const dtSec = (after.tMs - before.tMs) / 1000;

        const dsoundRates = ratesPerSec(before.dsound, after.dsound, dtSec);
        const timerRates = ratesPerSec(before.timer, after.timer, dtSec);
        const schedRates = ratesPerSec(before.sched as any, after.sched as any, dtSec);
        const fpuRates = ratesPerSec(before.fpu as any, after.fpu as any, dtSec);

        // Streaming granularity: bytes actually written per Unlock in the window.
        const dLocks = (after.dsound?.lock ?? 0) - (before.dsound?.lock ?? 0);
        const dUnlockBytes = (after.dsound?.bytesUnlocked ?? 0) - (before.dsound?.bytesUnlocked ?? 0);
        const ds: any = getModule("dsound");
        const lockTrace = ds?.getAudioDebugState?.()?.lockTrace?.slice(-8) ?? null;

        // Per-thread worker-time share over the window: who actually consumed the CPU.
        // startAddress is symbolized so the audio-service thread is tellable from main.
        let threads: Array<{ id: number; ms: number; pct: number; start: string | null }> | null = null;
        if (before.threadCpuMs && after.threadCpuMs) {
            const sched: any = sys().scheduler as any;
            const list = sched?.getAllThreads?.() ?? sched?.threads ?? null;
            const startOf = (id: number): string | null => {
                const t = Array.isArray(list) ? list.find((x: any) => x?.id === id)
                    : list?.get?.(id) ?? null;
                const sa = t?.startAddress;
                return typeof sa === "number" && sa > 0 ? (symbolize(sa) ?? `0x${(sa >>> 0).toString(16)}`) : null;
            };
            threads = Object.keys(after.threadCpuMs)
                .map((k) => {
                    const id = Number(k);
                    const ms = (after.threadCpuMs![id] ?? 0) - (before.threadCpuMs![id] ?? 0);
                    return { id, ms: Math.round(ms * 10) / 10, pct: Math.round((ms / (dtSec * 1000)) * 1000) / 10, start: startOf(id) };
                })
                .filter((t) => t.ms > 0.5)
                .sort((a, b) => b.ms - a.ms);
        }

        return {
            windowMs: Math.round(dtSec * 1000),
            perSec: {
                dsound: dsoundRates,
                timer: timerRates,
                scheduler: schedRates,
                fpu: fpuRates,
            },
            bytesPerLock: dLocks > 0 ? Math.round(dUnlockBytes / dLocks) : null,
            threads,
            recentLocks: lockTrace,
        };
    });

    /** audioBuffers() — full per-buffer dsound snapshot (id/ptr, isPlaying, isLooping,
     *  bytes, sabState, cursors). The lever for the "stuck looping sample" class: after a
     *  looping-music change, a buffer left isPlaying/sabState=PLAYING with the guest no
     *  longer feeding it is the drone. Pairs with a race→menu repro. */
    svc.register("audioBuffers", async () => {
        const ds: any = getModule("dsound");
        return ds?.getAudioDebugState?.() ?? { error: "no dsound module" };
    });

    /** mssAudio() — Miles Sound System samples/streams plus evidence that the
     *  browser AudioWorklet is advancing their authoritative play cursors. */
    svc.register("mssAudio", async () => {
        const mss: any = getModule("mss32");
        return mss?.getAudioDebugState?.() ?? { error: "no mss32 module" };
    });
}
