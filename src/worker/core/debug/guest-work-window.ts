/**
 * Guest-work odometer and fixed-work benchmark windows.
 *
 * ms/frame is not a usable A/B metric here: a live RTS scene is non-stationary
 * (AI, unit count, streaming) and warm screens are clamped by the engine's own
 * 30 FPS pacing loop, so codegen wins are invisible by construction. Retired
 * guest instructions are the stationary unit — independent of pacing, GPU and
 * the host present fallback.
 *
 * Metric selection matters:
 *  - MIPS (fixed-work window) is for codegen / dispatch / scheduler changes,
 *    where both arms execute the SAME instruction stream.
 *  - Instructions-to-milestone (odometer) is for HLE work. An HLE hook that
 *    replaces a guest loop with a native handler legitimately LOWERS MIPS while
 *    making the game faster; judging it by MIPS inverts the verdict.
 *
 * Neither is perfectly invariant: `Sleep(1)` polling loops spin more when the
 * host is slow, so a faster host retires fewer instructions to the same
 * milestone. Both are still far more stable than frame timing.
 */

/** Wrap-safe accumulation state for the free-running odometer. */
let odometerTotal = 0;
let odometerLast = 0;
let odometerPrimed = false;
let odometerTicks = 0;

export interface WorkWindowReport {
    /** A window is armed and has not yet reached its target. */
    armed: boolean;
    /** The armed window reached its target and the numbers below are final. */
    done: boolean;
    /** Guest instructions requested for this window. */
    targetInstructions: number;
    /** Guest instructions actually retired inside the window. */
    instructions: number;
    /** Wall-clock milliseconds spent retiring them. */
    wallMs: number;
    /** Retired guest instructions per second, in millions. The headline number. */
    mips: number;
    /** `main_loop()` round trips consumed by the window. */
    ticks: number;
    /** Mean guest instructions per round trip; a low value means the scheduler is
     *  cutting the JIT off early, which is itself a finding. */
    instructionsPerTick: number;
    /** Free-running odometer value, for instructions-to-milestone comparisons. */
    odometerInstructions: number;
}

let windowArmed = false;
let windowDone = false;
let windowStarted = false;
let windowTarget = 0;
let windowInstructions = 0;
let windowStartMs = 0;
let windowEndMs = 0;
let windowTicks = 0;

/**
 * Sample the guest instruction counter. Called once per `main_loop()` round trip
 * from `tick_hooks_after`. `raw` is `cpu.instruction_counter[0] >>> 0`.
 *
 * The counter is a u32 and wraps roughly every 4.29e9 instructions. A single
 * round trip is bounded by the scheduler's cycle limit (orders of magnitude
 * below that), so the `>>> 0` delta below is always the true delta.
 */
export function sampleGuestWorkCounter(raw: number, nowMs: number): void {
    const current = raw >>> 0;
    if (!odometerPrimed) {
        odometerPrimed = true;
        odometerLast = current;
        return;
    }
    const delta = (current - odometerLast) >>> 0;
    odometerLast = current;
    odometerTotal += delta;
    odometerTicks++;

    if (!windowArmed) return;
    windowInstructions += delta;
    windowTicks++;
    if (windowInstructions >= windowTarget) {
        windowArmed = false;
        windowDone = true;
        windowEndMs = nowMs;
    }
}

/** True while a fixed-work window is collecting. */
export function isGuestWorkWindowArmed(): boolean {
    return windowArmed;
}

/**
 * Start a fixed-work window. The window closes on its own once `targetInstructions`
 * guest instructions have retired; no timer and no frame count is involved.
 */
export function armGuestWorkWindow(targetInstructions: number, nowMs: number): WorkWindowReport {
    windowTarget = Math.max(1, Math.floor(targetInstructions));
    windowInstructions = 0;
    windowTicks = 0;
    windowStartMs = nowMs;
    windowEndMs = 0;
    windowDone = false;
    windowArmed = true;
    windowStarted = true;
    return readGuestWorkWindow(nowMs);
}

/** Abandon an in-flight window without recording a result. */
export function cancelGuestWorkWindow(): void {
    windowArmed = false;
    windowDone = false;
    windowStarted = false;
    windowInstructions = 0;
    windowTicks = 0;
}

export function readGuestWorkWindow(nowMs: number): WorkWindowReport {
    const endMs = windowDone ? windowEndMs : nowMs;
    // `windowStarted`, not `windowStartMs > 0`: a window armed at t=0 is legitimate
    // and must not silently report 0 ms / 0 MIPS.
    const wallMs = windowStarted ? Math.max(0, endMs - windowStartMs) : 0;
    return {
        armed: windowArmed,
        done: windowDone,
        targetInstructions: windowTarget,
        instructions: windowInstructions,
        wallMs: Math.round(wallMs * 100) / 100,
        mips: wallMs > 0 ? Math.round((windowInstructions / wallMs) / 1000 * 1000) / 1000 : 0,
        ticks: windowTicks,
        instructionsPerTick: windowTicks > 0 ? Math.round(windowInstructions / windowTicks) : 0,
        odometerInstructions: odometerTotal,
    };
}

export interface OdometerReport {
    /** Guest instructions retired since the Worker started (or since the last reset). */
    instructions: number;
    /** Round trips sampled. */
    ticks: number;
    /** Mean guest instructions per round trip since the last reset. */
    instructionsPerTick: number;
}

export function readGuestOdometer(): OdometerReport {
    return {
        instructions: odometerTotal,
        ticks: odometerTicks,
        instructionsPerTick: odometerTicks > 0 ? Math.round(odometerTotal / odometerTicks) : 0,
    };
}

/**
 * Reset the odometer to zero, returning the value it had. Used to mark a phase
 * boundary ("instructions retired between clicking Play and the first present").
 */
export function resetGuestOdometer(): OdometerReport {
    const previous = readGuestOdometer();
    odometerTotal = 0;
    odometerTicks = 0;
    return previous;
}

/**
 * Drop all state. Called when v86 is recreated: the guest counter restarts from a
 * different value and the previous accumulation belongs to a dead process.
 */
export function resetGuestWorkTracking(): void {
    odometerTotal = 0;
    odometerLast = 0;
    odometerPrimed = false;
    odometerTicks = 0;
    cancelGuestWorkWindow();
    windowStartMs = 0;
    windowEndMs = 0;
    windowTarget = 0;
}
