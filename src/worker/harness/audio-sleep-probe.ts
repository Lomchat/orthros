/**
 * Opt-in probe for NFSU-style audio-thread Sleep deadline loops.
 * ESI histogram from guest EDI - timeGetTime() at Sleep entry (no EIP bp / JIT flush).
 */

import { System } from "../core/system";
import { TimeService } from "../runtime/time";

/** RVAs in Speed.exe (image base 0x400000). */
/** Pump thread loop RVAs — actual Sleep return is 0x654b2f (not 0x654b83). */
const RVA_SLEEP_RET_MIN = 0x254a90;
const RVA_SLEEP_RET_MAX = 0x254bff;

export type EsiBucket = "neg" | "b0_10" | "b10_200" | "gt200";
export type DeltaBucket = "lt1" | "b1_3" | "b3_10" | "gt10";

export interface AudioSleepProbeSnapshot {
    active: boolean;
    imageBase: number;
    sleepRetRange: [number, number];
    esiHist: Record<EsiBucket | "total", number>;
    sleepRequested: { eq1: number; b2_10: number; b11_200: number; other: number; total: number };
    guestDeltaMs: Record<DeltaBucket | "total", number>;
    clampFromNeg: number;
    clampFromGt200: number;
    coherentSleep: number;
    underSlept: number;
    overSlept: number;
    virtualTimeActive: boolean;
    guestNowMs: number;
    wallNowMs: number;
    pendingSleep: number;
    sleepAny: number;
    retAddrTop: Record<string, number>;
}

class AudioSleepProbeImpl {
    active = false;
    imageBase = 0x400000;
    retMin = 0;
    retMax = 0;

    esiHist = { neg: 0, b0_10: 0, b10_200: 0, gt200: 0, total: 0 };
    sleepRequested = { eq1: 0, b2_10: 0, b11_200: 0, other: 0, total: 0 };
    guestDeltaMs = { lt1: 0, b1_3: 0, b3_10: 0, gt10: 0, total: 0 };
    sleepAny = 0;
    retAddrSamples: Record<string, number> = {};
    clampFromNeg = 0;
    clampFromGt200 = 0;
    coherentSleep = 0;
    underSlept = 0;
    overSlept = 0;

    private pending = new Map<number, { t0: number; requested: number; ret: number; rawEsi: number }>();

    resolveImageBase(): number {
        const reg = System.getInstance().process?.moduleRegistry;
        const hit = reg?.getModuleContainingAddress?.(0x654000);
        if (hit) return hit.baseAddress;
        const main = reg?.getMainExecutableBase?.();
        if (main) return main;
        return 0x400000;
    }

    install(imageBase?: number): void {
        this.imageBase = imageBase ?? this.resolveImageBase();
        this.retMin = (this.imageBase + RVA_SLEEP_RET_MIN) >>> 0;
        this.retMax = (this.imageBase + RVA_SLEEP_RET_MAX) >>> 0;
        this.reset();
        this.active = true;
    }

    stop(): void {
        this.active = false;
    }

    reset(): void {
        this.esiHist = { neg: 0, b0_10: 0, b10_200: 0, gt200: 0, total: 0 };
        this.sleepRequested = { eq1: 0, b2_10: 0, b11_200: 0, other: 0, total: 0 };
        this.guestDeltaMs = { lt1: 0, b1_3: 0, b3_10: 0, gt10: 0, total: 0 };
        this.sleepAny = 0;
        this.retAddrSamples = {};
        this.clampFromNeg = 0;
        this.clampFromGt200 = 0;
        this.coherentSleep = 0;
        this.underSlept = 0;
        this.overSlept = 0;
        this.pending.clear();
    }

    private bucketEsi(esi: number): void {
        const v = esi | 0;
        if (v < 0) this.esiHist.neg++;
        else if (v <= 10) this.esiHist.b0_10++;
        else if (v <= 200) this.esiHist.b10_200++;
        else this.esiHist.gt200++;
        this.esiHist.total++;
    }

    /** guestEdi = audio-thread deadline (EDI) at Sleep; raw gap = EDI - timeGetTime(). */
    onSleepEntry(returnAddr: number, requestedMs: number, threadId: number, guestEdi: number): void {
        if (!this.active) return;
        this.sleepAny++;
        const ret = returnAddr >>> 0;
        const key = `0x${ret.toString(16)}`;
        this.retAddrSamples[key] = (this.retAddrSamples[key] ?? 0) + 1;

        const now = TimeService.getInstance().nowMs() | 0;
        const rawEsi = ((guestEdi | 0) - now) | 0;

        if (ret < this.retMin || ret > this.retMax) return;

        this.bucketEsi(rawEsi);

        const req = requestedMs >>> 0;
        this.sleepRequested.total++;
        if (req === 1) {
            this.sleepRequested.eq1++;
            if (rawEsi < 0) this.clampFromNeg++;
            else if (rawEsi > 200) this.clampFromGt200++;
        } else if (req >= 2 && req <= 10) this.sleepRequested.b2_10++;
        else if (req >= 11 && req <= 200) this.sleepRequested.b11_200++;
        else this.sleepRequested.other++;

        this.pending.set(threadId, {
            t0: TimeService.getInstance().nowMs(),
            requested: req,
            ret,
            rawEsi,
        });
    }

    onSleepDone(threadId: number): void {
        if (!this.active) return;
        const p = this.pending.get(threadId);
        if (!p) return;
        const delta = TimeService.getInstance().nowMs() - p.t0;
        this.recordDelta(p.requested, delta);
        this.pending.delete(threadId);
    }

    private recordDelta(requested: number, delta: number): void {
        this.guestDeltaMs.total++;
        if (delta < 1) this.guestDeltaMs.lt1++;
        else if (delta < 3) this.guestDeltaMs.b1_3++;
        else if (delta < 10) this.guestDeltaMs.b3_10++;
        else this.guestDeltaMs.gt10++;

        if (Math.abs(delta - requested) < 1) this.coherentSleep++;
        if (requested >= 2 && delta < 1) this.underSlept++;
        if (delta > requested + 3) this.overSlept++;
    }

    snapshot(): AudioSleepProbeSnapshot {
        const ts = TimeService.getInstance();
        return {
            active: this.active,
            imageBase: this.imageBase,
            sleepRetRange: [this.retMin, this.retMax],
            esiHist: { ...this.esiHist },
            sleepRequested: { ...this.sleepRequested },
            guestDeltaMs: { ...this.guestDeltaMs },
            clampFromNeg: this.clampFromNeg,
            clampFromGt200: this.clampFromGt200,
            coherentSleep: this.coherentSleep,
            underSlept: this.underSlept,
            overSlept: this.overSlept,
            virtualTimeActive: ts.isVirtualTimeActive(),
            guestNowMs: ts.nowMs(),
            wallNowMs: ts.wallClockMs(),
            pendingSleep: this.pending.size,
            sleepAny: this.sleepAny,
            retAddrTop: Object.fromEntries(
                Object.entries(this.retAddrSamples).sort((a, b) => b[1] - a[1]).slice(0, 12),
            ),
        };
    }
}

export const audioSleepProbe = new AudioSleepProbeImpl();
(globalThis as typeof globalThis & { __audioSleepProbe?: AudioSleepProbeImpl }).__audioSleepProbe = audioSleepProbe;
