/**
 * A wall clock readable for the price of a memory load.
 *
 * performance.now() costs a few hundred nanoseconds in Chrome, and the runtime
 * reads it far more often than it needs a fresh value: v86 samples it twice per
 * slice, every slow-path thunk reads it for the virtual-time credit, every
 * switch and every yield stamps it. A helper thread stores the time into shared
 * memory twice per millisecond; readers load an integer. Every value is
 * milliseconds since this worker's own time origin, so a reading can be mixed
 * with performance.now() without a step, at half a millisecond of resolution.
 *
 * Until the helper runs (or where nested workers are unavailable) now() is
 * performance.now() itself.
 */

const SLOT_US = 0;
const SLOT_WAKE = 1;
const WRAP_US = 4294967296;

let ctl: Int32Array | null = null;
let helper: Worker | null = null;
let last = 0;
let wraps = 0;
let originEpochMs = 0;

const HELPER_SOURCE = `
self.onmessage = (e) => {
    const { sab, originEpochMs } = e.data;
    const ctl = new Int32Array(sab);
    const base = performance.timeOrigin - originEpochMs;
    for (;;) {
        Atomics.store(ctl, ${SLOT_US}, Math.round((base + performance.now()) * 1000) | 0);
        Atomics.wait(ctl, ${SLOT_WAKE}, 0, 0.5);
    }
};`;

/** Start the helper. Safe to call more than once. */
export function startSharedClock(): boolean {
    if (ctl) return true;
    if (typeof SharedArrayBuffer !== "function" || typeof Worker !== "function") return false;
    try {
        const sab = new SharedArrayBuffer(16);
        const arr = new Int32Array(sab);
        originEpochMs = performance.timeOrigin;
        // Seed with the current time so a reader never sees the clock at zero.
        Atomics.store(arr, SLOT_US, Math.round(performance.now() * 1000) | 0);
        last = Atomics.load(arr, SLOT_US) >>> 0;
        const url = URL.createObjectURL(new Blob([HELPER_SOURCE], { type: "text/javascript" }));
        helper = new Worker(url, { name: "shared-clock" });
        helper.postMessage({ sab, originEpochMs });
        URL.revokeObjectURL(url);
        ctl = arr;
        return true;
    } catch {
        ctl = null;
        helper = null;
        return false;
    }
}

/** Milliseconds since this worker's time origin, like performance.now(). */
export function sharedNow(): number {
    const c = ctl;
    if (!c) return performance.now();
    const v = Atomics.load(c, SLOT_US) >>> 0;
    if (v < last) wraps++;
    last = v;
    return (wraps * WRAP_US + v) / 1000;
}

export function sharedClockActive(): boolean { return ctl !== null; }

export function stopSharedClock(): void {
    helper?.terminate();
    helper = null;
    ctl = null;
}
