/**
 * Low-overhead present-rate meter for the host-side stats HUD.
 *
 * This deliberately does not own a canvas or any GPU resources. The old
 * implementation uploaded an OffscreenCanvas into every present pass, which
 * made the act of measuring FPS alter FPS dramatically (especially on
 * SwiftShader). We now aggregate real inter-present intervals in O(1) and send
 * one tiny message to the host roughly once per second. React renders that
 * summary as ordinary DOM outside the game canvas.
 */

export const STATS_OVERLAY_REPORT_INTERVAL_MS = 1000;

export type StatsOverlaySnapshot = {
    fps: number;
    frameMs: number;
    sampleCount: number;
    windowMs: number;
};

type SnapshotEmitter = (snapshot: StatsOverlaySnapshot) => void;
type Clock = () => number;

function emitToHost(snapshot: StatsOverlaySnapshot): void {
    const scope = globalThis as typeof globalThis & {
        postMessage?: (message: unknown) => void;
    };
    scope.postMessage?.({ type: "stats_overlay_update", ...snapshot });
}

export class StatsOverlay {
    private enabled = false;
    private sampleCount = 0;
    private intervalTotalMs = 0;
    private reportStartedAt = 0;
    private skipNextSample = false;

    constructor(
        private readonly emit: SnapshotEmitter = emitToHost,
        private readonly now: Clock = () => performance.now(),
        private readonly reportIntervalMs = STATS_OVERLAY_REPORT_INTERVAL_MS,
    ) {}

    setEnabled(on: boolean): void {
        if (this.enabled === on) return;
        this.enabled = on;
        this.skipNextSample = on;
        this.resetWindow();
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    /** Called once per real present with its inter-present duration. */
    updateMetrics(frameMs: number): void {
        if (!this.enabled || !Number.isFinite(frameMs) || frameMs <= 0) return;
        // The first interval may have started before the user enabled the HUD.
        // Dropping it ensures every reported interval belongs wholly to the
        // measurement window.
        if (this.skipNextSample) {
            this.skipNextSample = false;
            return;
        }

        const now = this.now();
        if (this.sampleCount === 0) this.reportStartedAt = now;
        this.sampleCount += 1;
        this.intervalTotalMs += frameMs;

        if (now - this.reportStartedAt < this.reportIntervalMs) return;

        // The sum of inter-present intervals is the authoritative measurement
        // window. Dividing frame intervals by their own elapsed duration avoids
        // rAF/display-refresh assumptions and remains correct below 1 FPS.
        const sampleCount = this.sampleCount;
        const windowMs = this.intervalTotalMs;
        this.emit({
            fps: sampleCount * 1000 / windowMs,
            frameMs: windowMs / sampleCount,
            sampleCount,
            windowMs,
        });
        this.resetWindow();
    }

    private resetWindow(): void {
        this.sampleCount = 0;
        this.intervalTotalMs = 0;
        this.reportStartedAt = 0;
    }
}

export const statsOverlay = new StatsOverlay();
