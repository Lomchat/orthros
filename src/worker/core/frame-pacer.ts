/**
 * Frame Pacer — rAF-driven presentation throttle.
 *
 * Prevents the emulator from generating frames faster than the display
 * can present. Does NOT manipulate virtual time — the spin loop (JMP $)
 * that runs during async thunk waits naturally advances instruction-based
 * time at the correct rate (~100K insn/ms = ~1ms/tick).
 *
 * Architecture:
 * - A requestAnimationFrame loop issues one "permit" per display refresh.
 * - waitForFrameSlot() awaits the next permit (blocking mode for Flip).
 * - Fast path: if rAF already fired (game slower than display), returns immediately.
 * - Non-blocking mode: for Blt-to-primary games that issue many Blts per
 *   visual frame, yields at most once per rAF cycle (12ms cooldown).
 *
 * Enabled by default. Adapts to any display refresh rate (60 Hz, 144 Hz, etc.)
 * with sub-millisecond precision (no setTimeout jitter).
 */

import { Logger, LogCategory } from "./logger";
import { frameVarianceDiagnostics } from "./frame-variance-diagnostics";
import { debugSession } from "./debug/debug-session";

export type FramePacerStats = {
    enabled: boolean;
    frameSlotBusy: boolean;
    totalWaits: number;
    totalWaitTimeMs: number;
    currentWaitStartMs: number;
};

class FramePacerImpl {
    private enabled = true;  // Enabled by default
    private running = false;

    // Single-waiter queue: at most one Flip/Present awaits the next rAF permit.
    private waiter: (() => void) | null = null;

    // Per-frame callbacks: fired once per rAF, synchronized with display refresh.
    // Used by THRASH auto-presenter and other subsystems that need frame-boundary events.
    private frameCallbacks: Set<() => void> = new Set();

    // Pre-queued permit: if rAF fires while no one is waiting, save it.
    // Next waitForFrameSlot() returns immediately instead of blocking until NEXT rAF.
    private permitAvailable = false;

    // Non-blocking cooldown: for Blt-to-primary games that issue many Blts per
    // visual frame, yield at most once per rAF cycle (skip if < cooldown).
    private lastYieldTime = 0;

    // Adaptive cooldown: measure actual rAF interval and use 85% as cooldown.
    // Handles 60Hz (16.6ms → 14.1ms cooldown), 144Hz (6.9ms → 5.9ms), etc.
    private rAfInterval = 16.67;  // default 60Hz
    private lastRafTime = 0;

    // Sleep coordination: skip rAF wait if game already self-throttled via Sleep(N)
    private recentSleepMs = 0;
    private recentSleepTime = 0;

    // Stats
    private totalWaits = 0;
    private totalWaitTimeMs = 0;
    private currentWaitStartMs = 0;
    private slotBusy = false;

    // Adaptive smooth-pacing (opt-in via setPacingMode('smooth')). A sub-refresh guest
    // (~23 FPS on 60 Hz) otherwise lands each frame at an arbitrary phase → held 2 or 3
    // vsyncs irregularly = pulldown judder. Smooth mode holds each present a STEADY integer
    // number of vsyncs (guest rate snapped to a refresh divisor), killing the 2↔3 flap.
    // Reuses the rAF-wait path (virtual time unaffected). Default off — no behavior change.
    private pacingMode: 'off' | 'vsync' | 'smooth' = 'off';
    private lastSlotReturnMs = 0;
    private guestIntervalEma = 42; // ms, EMA of the guest's INTRINSIC frame interval (excl. our hold)
    // Grid-locked smooth pacing: hold each present a STEADY integer number of vsyncs, anchored
    // to the actual vsync grid (rafTick) rather than a free-running wall-clock accumulator.
    // The old accumulator only re-anchored when it fell BEHIND, so on frames that snapped to a
    // shorter hold it drifted AHEAD ~1 vsync/frame and compounded into 6–7-vsync (100ms+) holds
    // = the "14-FPS collapse". Anchoring to rafTick bounds every hold to exactly smoothVsyncs.
    private rafTick = 0;            // monotonic vsync counter, incremented once per rAF (onFrame)
    private smoothReleaseTick = -1; // rafTick at the last present (the cadence anchor)
    private smoothVsyncs = 0;       // current steady hold count (0 = uninitialised), hysteresis below

    /** Start the rAF loop. Call once after v86 initialization. */
    start(): void {
        if (this.running || !this.enabled) return;
        this.running = true;
        this.scheduleNext();
        Logger.log(LogCategory.SYSTEM, `[FramePacer] Started rAF loop`);
    }

    /** Stop the rAF loop (e.g. on emulator teardown). */
    stop(): void {
        this.running = false;
        // Release any blocked waiter so it doesn't hang forever
        if (this.waiter) {
            this.waiter();
            this.waiter = null;
        }
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        if (enabled && !this.running) {
            this.start();
        }
        if (!enabled) {
            // Release any blocked waiter
            if (this.waiter) {
                this.waiter();
                this.waiter = null;
            }
        }
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    /**
     * Called by Flip()/Present() before submitting a frame.
     *
     * Virtual time is NOT manipulated here. During the rAF wait, v86
     * continues executing the spin loop (JMP $, 0xEB 0xFE), which naturally
     * advances the instruction counter at ~100K insn/ms. This produces
     * correct instruction-based virtual time (~1ms per tick) without
     * explicit pause/compensate logic that caused:
     * - Re-Volt jitter (lump-sum 16ms compensation between smooth 1ms ticks)
     * - HoMM3 speed-up (multiple compensations per visual frame)
     *
     * Fast path: if rAF already fired (game slower than display refresh),
     * returns immediately.
     *
     * Options:
     * - nonBlocking: if true, only yield if we haven't yielded recently
     *   (cooldown). Used by Blt-to-primary games that issue many Blts
     *   per visual frame — prevents 16ms stall on each Blt.
     */
    /**
     * Notify the pacer that the game called Sleep(N).
     * If N >= 5ms, the next Flip can skip the rAF wait — game is self-throttling.
     */
    notifySleep(ms: number): void {
        if (ms >= 5) {
            this.recentSleepMs = ms;
            this.recentSleepTime = performance.now();
        }
    }

    async waitForFrameSlot(options?: { nonBlocking?: boolean }): Promise<void> {
        if (!this.enabled || !this.running) return;

        // Smooth pacing: enforce a steady inter-present cadence (opt-in).
        if (this.pacingMode === 'smooth' && !options?.nonBlocking) {
            return this.waitSmooth();
        }

        // Vsync-lock (faithful) pacing: release every present on a FRESH vsync edge so the
        // present phase is pinned to the grid (opt-in). Unlike 'off' this deliberately ignores
        // both the self-throttle skip and the pre-queued stale permit, since either releases at
        // an arbitrary sub-vsync phase — the exact jitter that turns a self-limited guest's clean
        // 3:2 cadence into a 2↔3 flap. Native rate preserved (no hold count), one present per
        // edge → honest pull-up. Costs up to one vsync of latency vs 'off'.
        if (this.pacingMode === 'vsync' && !options?.nonBlocking) {
            return this.waitVsync();
        }

        // If the game recently slept >= 5ms, it's self-throttling — skip rAF wait.
        // The 20ms staleness window covers one full frame at ~50+ FPS.
        if (this.recentSleepMs >= 5 && (performance.now() - this.recentSleepTime) < 20) {
            this.recentSleepMs = 0;
            this.totalWaits++;
            return;
        }

        // Fast path: rAF already fired while we were rendering → no wait needed.
        if (this.permitAvailable) {
            this.permitAvailable = false;
            this.totalWaits++;
            return;
        }

        // Non-blocking mode: skip yield if we yielded recently.
        // Prevents Blt-to-primary games from stalling 16ms on every Blt call.
        if (options?.nonBlocking) {
            const now = performance.now();
            if (now - this.lastYieldTime < this.yieldCooldownMs) {
                return;
            }
        }

        // Slow path: game is faster than display refresh. Yield until next rAF.
        this.slotBusy = true;
        const wallBefore = performance.now();
        this.currentWaitStartMs = wallBefore;
        this.totalWaits++;

        // Wait for the next rAF permit
        await new Promise<void>(resolve => {
            this.waiter = resolve;
        });

        const wallElapsed = performance.now() - wallBefore;
        this.totalWaitTimeMs += wallElapsed;
        this.slotBusy = false;
        this.lastYieldTime = performance.now();

        // Record display-bound idle for diagnostics.
        frameVarianceDiagnostics.recordIdleTime('raf_wait', wallElapsed);
    }

    setPacingMode(mode: 'off' | 'vsync' | 'smooth'): void {
        this.pacingMode = mode;
        this.lastSlotReturnMs = 0;
        this.smoothReleaseTick = -1;
        this.smoothVsyncs = 0;
        Logger.log(LogCategory.SYSTEM, `[FramePacer] pacing mode = ${mode}`);
    }

    getPacingMode(): 'off' | 'vsync' | 'smooth' {
        return this.pacingMode;
    }

    /**
     * Vsync-lock wait (mode A / faithful): block until the NEXT rAF edge, deliberately
     * discarding any pre-queued permit so the release lands on a real vsync boundary rather
     * than whatever sub-vsync phase the guest happened to finish at. Native rate is untouched
     * (no hold count) — the guest's frame interval simply rounds up to the next grid edge,
     * yielding a phase-clean 3:2 cadence instead of the 'off' path's drifting 2↔3 flap.
     */
    private async waitVsync(): Promise<void> {
        this.totalWaits++;
        // Drop the stale permit: we want a fresh edge, not an immediate return at an arbitrary phase.
        this.permitAvailable = false;
        this.slotBusy = true;
        const wallBefore = performance.now();
        this.currentWaitStartMs = wallBefore;
        await new Promise<void>(resolve => { this.waiter = resolve; });
        const wallElapsed = performance.now() - wallBefore;
        this.totalWaitTimeMs += wallElapsed;
        this.slotBusy = false;
        this.lastYieldTime = performance.now();
        frameVarianceDiagnostics.recordIdleTime('raf_wait', wallElapsed);
    }

    /** Await exactly one rAF permit (fast-path the pre-queued one). */
    private awaitRafPermit(): Promise<void> {
        if (this.permitAvailable) { this.permitAvailable = false; return Promise.resolve(); }
        return new Promise<void>(resolve => { this.waiter = resolve; });
    }

    /**
     * Smooth-pacing wait: hold each present a STEADY integer number of vsyncs so a sub-refresh
     * guest presents on a regular cadence instead of a juddery 2↔3 flap. The hold count is
     * chosen as the smallest integer of vsyncs that fits the guest's measured frame time
     * (ceil, clamped 2..4) with hysteresis to avoid flip-flopping at a boundary; HP (~44ms)
     * → a steady 3 vsyncs = 50ms = 20 FPS, stddev ≈ 0.
     *
     * Crucially the cadence is anchored to the actual vsync grid via rafTick, NOT a wall-clock
     * accumulator: each present is released exactly `smoothVsyncs` vsyncs after the previous
     * one. A guest that overran its budget (stall) is already past the target tick → it passes
     * straight through; we never lengthen a stall, and the hold can never drift/compound.
     */
    private async waitSmooth(): Promise<void> {
        const entry = performance.now();
        this.totalWaits++;

        // Measure the guest's INTRINSIC frame time = time since we released the last present
        // (excludes our own hold). Using the paced inter-request interval instead feeds back
        // on our output and ratchets the rate down — that bug locked HP to a steady 15 FPS.
        if (this.lastSlotReturnMs > 0) {
            const work = entry - this.lastSlotReturnMs;
            // Ignore stall outliers (>80ms): a one-off hitch must NOT inflate the hold count.
            if (work > 2 && work < 80) this.guestIntervalEma = this.guestIntervalEma * 0.85 + work * 0.15;
        }

        // Fast guest (> ~43 FPS): present as ready — never cap.
        if (this.guestIntervalEma < this.rAfInterval * 1.4) {
            this.smoothVsyncs = 0;
            await this.awaitRafPermit();
            this.lastSlotReturnMs = performance.now();
            this.smoothReleaseTick = this.rafTick;
            return;
        }

        // Choose the steady hold count = ceil(guestInterval / refresh), clamped 2..4, with a
        // hysteresis band so noise near a vsync boundary doesn't reintroduce a 2↔3 flap.
        const ratio = this.guestIntervalEma / this.rAfInterval;
        let v = this.smoothVsyncs;
        if (v < 2) {
            v = Math.max(2, Math.min(4, Math.ceil(ratio - 0.05)));
        } else if (ratio > v + 0.15) {
            v = Math.min(4, v + 1);        // guest got heavier → hold one more vsync
        } else if (ratio < v - 1.15) {
            v = Math.max(2, v - 1);        // guest comfortably fits a shorter hold
        }
        this.smoothVsyncs = v;

        // Hold until `v` vsyncs have elapsed since the last present (grid-locked, bounded).
        if (this.smoothReleaseTick < 0) this.smoothReleaseTick = this.rafTick;
        let guard = 0;
        while (this.rafTick - this.smoothReleaseTick < v && guard++ < v + 3) {
            await this.awaitRafPermit();
        }
        this.lastSlotReturnMs = performance.now();
        this.smoothReleaseTick = this.rafTick;
        frameVarianceDiagnostics.recordIdleTime('raf_wait', 0);
    }

    /**
     * Register a callback to be called once per rAF frame, synchronized with display refresh.
     * Returns an unregister function. Safe to call before start().
     */
    registerOnFrame(cb: () => void): () => void {
        this.frameCallbacks.add(cb);
        return () => this.frameCallbacks.delete(cb);
    }

    /**
     * No-op — kept for API compatibility with existing call sites.
     * The rAF loop handles pacing; no explicit reserve/release needed.
     */
    reserveFrameSlot(): void {
        // no-op
    }

    /**
     * No-op — kept for API compatibility with existing call sites.
     */
    releaseFrameSlot(): void {
        // no-op
    }

    /**
     * Check if frame slot is available (for diagnostics).
     */
    isFrameSlotAvailable(): boolean {
        return !this.slotBusy;
    }

    getStats(): FramePacerStats {
        return {
            enabled: this.enabled,
            frameSlotBusy: this.slotBusy,
            totalWaits: this.totalWaits,
            totalWaitTimeMs: this.totalWaitTimeMs,
            currentWaitStartMs: this.currentWaitStartMs,
        };
    }

    resetStats(): void {
        this.totalWaits = 0;
        this.totalWaitTimeMs = 0;
        this.currentWaitStartMs = 0;
    }

    // --- Internal ---

    private scheduleNext(): void {
        if (!this.running) return;
        requestAnimationFrame(() => this.onFrame());
    }

    /** Adaptive cooldown = 85% of measured rAF interval. */
    private get yieldCooldownMs(): number {
        return this.rAfInterval * 0.85;
    }

    private onFrame(): void {
        if (!this.running) return;

        // Monotonic vsync counter — the anchor for grid-locked smooth pacing (waitSmooth).
        this.rafTick++;

        // Measure actual rAF interval (EMA smoothing)
        const now = performance.now();
        if (this.lastRafTime > 0) {
            const measured = now - this.lastRafTime;
            // Only incorporate reasonable intervals (3ms-50ms) to filter outliers
            if (measured > 3 && measured < 50) {
                this.rAfInterval = this.rAfInterval * 0.9 + measured * 0.1;

                // Record rAF interval for diagnostics
                if (frameVarianceDiagnostics.isEnabled()) {
                    frameVarianceDiagnostics.recordRafWait(0, now); // Will calculate interval internally
                }
            }
        }
        this.lastRafTime = now;

        // Grant the permit: release the waiting Flip/Present
        if (this.waiter) {
            const resolve = this.waiter;
            this.waiter = null;

            // Record the actual wait time for diagnostics
            if (frameVarianceDiagnostics.isEnabled() && this.currentWaitStartMs > 0) {
                const waitMs = now - this.currentWaitStartMs;
                frameVarianceDiagnostics.recordRafWait(waitMs, now);
                frameVarianceDiagnostics.recordEvent('frame_pacer_wait', undefined, waitMs);
            }

            resolve();
        } else {
            // No one waiting — queue one permit for next waitForFrameSlot().
            // Only one permit queued at a time (no accumulation).
            this.permitAvailable = true;
        }

        // Fire per-frame callbacks (e.g. THRASH auto-presenter)
        for (const cb of this.frameCallbacks) {
            cb();
        }

        // Poll debug session memory watches (~60Hz, zero-cost when disabled)
        debugSession.pollMemWatches();

        this.scheduleNext();
    }
}

export const framePacer = new FramePacerImpl();
