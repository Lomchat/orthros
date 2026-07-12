// busy-wait-detector.ts
// Detects guest busy-wait loops that spam benign polling thunks (timeGetTime,
// GetTickCount, QueryPerformanceCounter) without virtual time advancing, so the
// dispatcher can yield instead of letting the loop burn a full quantum.

import { System } from '../system';
import { TARGET_INSN_PER_MS } from '../scheduler/timing';

export class BusyWaitDetector {
    private lastCheckInsn = 0;
    private callCount = 0;
    private lastVirtualTime = 0;
    private benignThunks = new Set<string>();
    // Tuning parameters
    private readonly CHECK_INTERVAL_MS = 2; // Check more frequently (was 5ms)
    private readonly CHECK_MASK = 0x3F;    // Check every 64 calls (was 512). Responsive enough for 2ms quantum.
    private readonly RATE_THRESHOLD = 80.0; // Lower threshold (was 120). 80 calls/ms is plenty to detect a spin loop.
    private readonly VIRTUAL_PROGRESS_MIN = 0.5; // Virtual time must advance at least 0.5ms (was 1.0ms)

    constructor() {
        // Thunks that are commonly spam-called in busy loops
        this.benignThunks.add('winmm:timeGetTime');
        this.benignThunks.add('kernel32:GetTickCount');
        this.benignThunks.add('kernel32:QueryPerformanceCounter');
        // REMOVED: PeekMessage/IsIconic (UI lag)
        // REMOVED: Enter/LeaveCriticalSection (Causes LAG during heavy rendering loops)
    }

    reset() {
        // lastCheckInsn=0 self-corrects: the first window's delta is large, so rate ≈ 0 and
        // the detector cannot false-fire before the first real check window closes.
        this.lastCheckInsn = 0;
        this.callCount = 0;
        this.lastVirtualTime = 0;
    }

    /**
     * @param insnNow retired-instruction counter (cpu.instruction_counter[0] >>> 0)
     * @returns true if busy-wait detected and we should yield
     *
     * Rate is measured against RETIRED INSTRUCTIONS, not performance.now(): the poll interval
     * is derived from the guest's own instruction count (insnDelta / TARGET_INSN_PER_MS), so the
     * calls-per-ms rate — and therefore the yield decision — is a function of deterministic guest
     * state, identical on a fast Mac and a slow PC. A wall-clock denominator inflated the rate on
     * fast hosts (more guest insns per wall-ms → more polls per wall-ms), firing at a different
     * guest-loop iteration count per machine (same platform-dependent-interleaving disease the
     * scheduler quantum was moved off wall-clock to cure).
     */
    check(thunkName: string, insnNow: number): boolean {
        // Only track "benign" polling thunks
        if (!this.benignThunks.has(thunkName)) return false;

        this.callCount++;

        // Optimization: Don't compute the rate every call
        if ((this.callCount & this.CHECK_MASK) !== 0) return false;

        const insnDelta = (insnNow - this.lastCheckInsn) >>> 0;
        const virtualMs = insnDelta / TARGET_INSN_PER_MS; // deterministic, platform-independent

        if (virtualMs > this.CHECK_INTERVAL_MS) {
            const timeService = System.getInstance().services.time;
            const vTime = timeService ? timeService.nowMs() : 0;

            const rate = this.callCount / virtualMs; // calls per virtual-ms
            const isHighRate = rate > this.RATE_THRESHOLD;
            // Only trigger if virtual time is STALLED relative to instruction progress.
            // If vTime is moving as fast as instructions, it might be a fast loop,
            // but if it's polling 100+ times per ms, it's definitely a busy wait.
            const vDelta = vTime - this.lastVirtualTime;
            const isStalled = vDelta < this.VIRTUAL_PROGRESS_MIN || rate > 200;

            this.lastCheckInsn = insnNow;
            this.callCount = 0;
            this.lastVirtualTime = vTime;

            if (isHighRate && isStalled) {
                return true;
            }
        }
        return false;
    }
}
