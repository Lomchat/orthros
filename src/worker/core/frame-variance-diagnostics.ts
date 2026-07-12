/**
 * Frame Variance Diagnostics
 *
 * Specialized instrumentation for diagnosing FPS variance root causes.
 * Tracks frame time distribution, idle subcategories, and event correlations.
 *
 * Phase 1: Diagnose FPS variance.
 * - Capture frame time distribution (min/max/avg/stddev)
 * - Instrument idle sources (frame pacer, Sleep(0), quantum)
 * - Correlate variance with events (texture loads, Sleep(0) yields, context switches)
 * - Test frame pacer stability
 */

import { Logger, LogCategory } from './logger';
import { frameProfiler } from './frame-profiler';

export type IdleSource = 'raf_wait' | 'yield' | 'hlt' | 'frame_pacer' | 'sleep_zero' | 'quantum' | 'unknown';

export type FrameEvent = {
    timestamp: number;
    frameNumber: number;
    eventType: 'texture_load' | 'texture_lock' | 'texture_unlock' |
               'sleep_zero_yield' | 'context_switch' | 'jit_compile' | 'frame_pacer_wait';
    details?: string;
    durationMs?: number;
};

export type FrameTimeStats = {
    count: number;
    minMs: number;
    maxMs: number;
    avgMs: number;
    stddevMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    variance: number;
};

export type IdleBreakdown = {
    rafWaitMs: number;
    yieldMs: number;
    hltMs: number;
    framePacerMs: number;
    sleepZeroMs: number;
    quantumMs: number;
    unknownMs: number;
    totalMs: number;
};

function createIdleBreakdown(): IdleBreakdown {
    return {
        rafWaitMs: 0,
        yieldMs: 0,
        hltMs: 0,
        framePacerMs: 0,
        sleepZeroMs: 0,
        quantumMs: 0,
        unknownMs: 0,
        totalMs: 0,
    };
}

function cloneIdleBreakdown(idle: IdleBreakdown): IdleBreakdown {
    return { ...idle };
}

export type FrameCorrelation = {
    frameNumber: number;
    frameMs: number;
    events: FrameEvent[];
    idleBreakdown: IdleBreakdown;
    timestamp: number;
};

export type DiagnosticsSnapshot = {
    enabled: boolean;
    captureCount: number;
    frameTimeStats: FrameTimeStats;
    idleBreakdown: IdleBreakdown;
    recentCorrelations: FrameCorrelation[];
    rafWaitTimes: number[]; // Last N rAF wait times
    rafIntervals: number[]; // Last N actual rAF intervals
};

class FrameVarianceDiagnostics {
    private enabled = false;
    private frameNumber = 0;

    // Frame time tracking
    private frameTimes: number[] = [];
    private readonly MAX_FRAME_TIMES = 1000;

    // Idle subcategory tracking (ms accumulated for current frame)
    private currentIdleBreakdown: IdleBreakdown = createIdleBreakdown();
    private totalIdleBreakdown: IdleBreakdown = createIdleBreakdown();

    // Event tracking
    private currentFrameEvents: FrameEvent[] = [];
    private correlations: FrameCorrelation[] = [];
    private readonly MAX_CORRELATIONS = 100;

    // rAF tracking
    private rafWaitTimes: number[] = [];
    private rafIntervals: number[] = [];
    private readonly MAX_RAF_SAMPLES = 200;
    private lastRafTimestamp = 0;

    // Per-frame timing
    private lastFrameTimestamp = 0;

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        if (enabled) {
            Logger.log(LogCategory.SYSTEM, '[FrameVariance] Diagnostics ENABLED');
            this.reset();
        } else {
            Logger.log(LogCategory.SYSTEM, '[FrameVariance] Diagnostics DISABLED');
        }
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    reset(): void {
        this.frameNumber = 0;
        this.frameTimes = [];
        this.correlations = [];
        this.rafWaitTimes = [];
        this.rafIntervals = [];
        this.lastRafTimestamp = 0;
        this.lastFrameTimestamp = 0;
        this.totalIdleBreakdown = createIdleBreakdown();
        this.resetCurrentFrame();
    }

    private resetCurrentFrame(): void {
        this.currentIdleBreakdown = createIdleBreakdown();
        this.currentFrameEvents = [];
    }

    /**
     * Record idle time with specific source categorization.
     * Called from scheduler/frame pacer when yielding.
     */
    recordIdleTime(source: IdleSource, ms: number): void {
        if (!(ms > 0) || !Number.isFinite(ms)) return;

        this.addIdleTime(this.totalIdleBreakdown, source, ms);
        if (!this.enabled) return;
        this.addIdleTime(this.currentIdleBreakdown, source, ms);
    }

    private addIdleTime(target: IdleBreakdown, source: IdleSource, ms: number): void {
        switch (source) {
            case 'raf_wait':
            case 'frame_pacer':
                target.rafWaitMs += ms;
                target.framePacerMs += ms;
                break;
            case 'yield':
            case 'sleep_zero':
                target.yieldMs += ms;
                target.sleepZeroMs += ms;
                break;
            case 'quantum':
                target.yieldMs += ms;
                target.quantumMs += ms;
                break;
            case 'hlt':
                target.hltMs += ms;
                break;
            case 'unknown':
                target.unknownMs += ms;
                break;
        }
        target.totalMs += ms;
    }

    /**
     * Record rAF wait time and interval.
     * Called from frame pacer when rAF fires.
     */
    recordRafWait(waitMs: number, rafTimestamp: number): void {
        if (!this.enabled) return;

        // Record wait time
        this.rafWaitTimes.push(waitMs);
        if (this.rafWaitTimes.length > this.MAX_RAF_SAMPLES) {
            this.rafWaitTimes.shift();
        }

        // Record interval (time between rAF fires)
        if (this.lastRafTimestamp > 0) {
            const interval = rafTimestamp - this.lastRafTimestamp;
            this.rafIntervals.push(interval);
            if (this.rafIntervals.length > this.MAX_RAF_SAMPLES) {
                this.rafIntervals.shift();
            }
        }
        this.lastRafTimestamp = rafTimestamp;
    }

    /**
     * Record an event that occurred during the current frame.
     */
    recordEvent(
        eventType: FrameEvent['eventType'],
        details?: string,
        durationMs?: number
    ): void {
        if (!this.enabled) return;

        this.currentFrameEvents.push({
            timestamp: performance.now(),
            frameNumber: this.frameNumber,
            eventType,
            details,
            durationMs,
        });
    }

    /**
     * Mark the end of a frame and capture statistics.
     * Called from frame profiler after markFrame.
     */
    markFrameEnd(frameMs: number): void {
        if (!this.enabled) return;

        const now = performance.now();
        this.frameNumber++;

        // Store frame time
        this.frameTimes.push(frameMs);
        if (this.frameTimes.length > this.MAX_FRAME_TIMES) {
            this.frameTimes.shift();
        }

        // Store correlation if frame had events or significant idle time
        const hasEvents = this.currentFrameEvents.length > 0;
        const hasSignificantIdle = this.currentIdleBreakdown.totalMs > 5;
        const isSlowFrame = frameMs > 25; // > 40 FPS threshold

        if (hasEvents || hasSignificantIdle || isSlowFrame) {
            this.correlations.push({
                frameNumber: this.frameNumber,
                frameMs,
                events: [...this.currentFrameEvents],
                idleBreakdown: cloneIdleBreakdown(this.currentIdleBreakdown),
                timestamp: now,
            });

            if (this.correlations.length > this.MAX_CORRELATIONS) {
                this.correlations.shift();
            }
        }

        this.lastFrameTimestamp = now;
        this.resetCurrentFrame();
    }

    /**
     * Get comprehensive diagnostics snapshot.
     */
    getSnapshot(): DiagnosticsSnapshot {
        return {
            enabled: this.enabled,
            captureCount: this.frameTimes.length,
            frameTimeStats: this.computeFrameTimeStats(),
            idleBreakdown: this.getIdleSummary(),
            recentCorrelations: this.correlations.slice(-20), // Last 20 frames
            rafWaitTimes: [...this.rafWaitTimes],
            rafIntervals: [...this.rafIntervals],
        };
    }

    getIdleSummary(): IdleBreakdown {
        return cloneIdleBreakdown(this.totalIdleBreakdown);
    }

    /**
     * Log diagnostics summary to console.
     */
    logSummary(): void {
        if (!this.enabled || this.frameTimes.length === 0) {
            Logger.log(LogCategory.SYSTEM, '[FrameVariance] No data captured');
            return;
        }

        const stats = this.computeFrameTimeStats();
        const idle = this.computeTotalIdleBreakdown();
        const rafStats = this.computeRafStats();

        Logger.log(LogCategory.SYSTEM, `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  FRAME VARIANCE DIAGNOSTICS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FRAME TIME STATISTICS (${stats.count} frames)
  Min:     ${stats.minMs.toFixed(2)}ms
  Max:     ${stats.maxMs.toFixed(2)}ms
  Average: ${stats.avgMs.toFixed(2)}ms (${(1000 / stats.avgMs).toFixed(1)} FPS)
  Stddev:  ${stats.stddevMs.toFixed(2)}ms
  P50:     ${stats.p50Ms.toFixed(2)}ms
  P95:     ${stats.p95Ms.toFixed(2)}ms
  P99:     ${stats.p99Ms.toFixed(2)}ms
  Variance: ${stats.variance.toFixed(2)}

IDLE TIME BREAKDOWN (total since reset)
  rAF wait:    ${idle.rafWaitMs.toFixed(1)}ms (${this.formatPct(idle.rafWaitMs, idle.totalMs)})
  Yield:       ${idle.yieldMs.toFixed(1)}ms (${this.formatPct(idle.yieldMs, idle.totalMs)})
  HLT/blocked: ${idle.hltMs.toFixed(1)}ms (${this.formatPct(idle.hltMs, idle.totalMs)})
  Unknown:     ${idle.unknownMs.toFixed(1)}ms (${this.formatPct(idle.unknownMs, idle.totalMs)})
  TOTAL:       ${idle.totalMs.toFixed(1)}ms

RAF TIMING (${rafStats.waitCount} samples)
  Wait Time - Avg: ${rafStats.avgWaitMs.toFixed(2)}ms, Stddev: ${rafStats.waitStddevMs.toFixed(2)}ms
  Interval  - Avg: ${rafStats.avgIntervalMs.toFixed(2)}ms, Stddev: ${rafStats.intervalStddevMs.toFixed(2)}ms
  Expected Interval: ${rafStats.expectedIntervalMs.toFixed(2)}ms (based on avg)

EVENT CORRELATIONS (last 10 frames with events/slow)
${this.formatRecentCorrelations()}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
        `);
    }

    private computeFrameTimeStats(): FrameTimeStats {
        if (this.frameTimes.length === 0) {
            return {
                count: 0,
                minMs: 0,
                maxMs: 0,
                avgMs: 0,
                stddevMs: 0,
                p50Ms: 0,
                p95Ms: 0,
                p99Ms: 0,
                variance: 0,
            };
        }

        const sorted = [...this.frameTimes].sort((a, b) => a - b);
        const count = sorted.length;
        const sum = sorted.reduce((a, b) => a + b, 0);
        const avg = sum / count;

        // Variance and stddev
        const variance = sorted.reduce((acc, val) => acc + Math.pow(val - avg, 2), 0) / count;
        const stddev = Math.sqrt(variance);

        // Percentiles
        const p50 = sorted[Math.floor(count * 0.50)];
        const p95 = sorted[Math.floor(count * 0.95)];
        const p99 = sorted[Math.floor(count * 0.99)];

        return {
            count,
            minMs: sorted[0],
            maxMs: sorted[count - 1],
            avgMs: avg,
            stddevMs: stddev,
            p50Ms: p50,
            p95Ms: p95,
            p99Ms: p99,
            variance,
        };
    }

    private computeTotalIdleBreakdown(): IdleBreakdown {
        return this.getIdleSummary();
    }

    private formatPct(value: number, total: number): string {
        return total > 0 ? `${((value / total) * 100).toFixed(1)}%` : '0.0%';
    }

    private computeRafStats() {
        const waitCount = this.rafWaitTimes.length;
        const intervalCount = this.rafIntervals.length;

        if (waitCount === 0) {
            return {
                waitCount: 0,
                avgWaitMs: 0,
                waitStddevMs: 0,
                avgIntervalMs: 0,
                intervalStddevMs: 0,
                expectedIntervalMs: 16.67,
            };
        }

        const avgWait = this.rafWaitTimes.reduce((a, b) => a + b, 0) / waitCount;
        const waitVariance = this.rafWaitTimes.reduce((acc, val) => acc + Math.pow(val - avgWait, 2), 0) / waitCount;
        const waitStddev = Math.sqrt(waitVariance);

        let avgInterval = 16.67;
        let intervalStddev = 0;
        if (intervalCount > 0) {
            avgInterval = this.rafIntervals.reduce((a, b) => a + b, 0) / intervalCount;
            const intervalVariance = this.rafIntervals.reduce((acc, val) => acc + Math.pow(val - avgInterval, 2), 0) / intervalCount;
            intervalStddev = Math.sqrt(intervalVariance);
        }

        return {
            waitCount,
            avgWaitMs: avgWait,
            waitStddevMs: waitStddev,
            avgIntervalMs: avgInterval,
            intervalStddevMs: intervalStddev,
            expectedIntervalMs: avgInterval,
        };
    }

    private formatRecentCorrelations(): string {
        const recent = this.correlations.slice(-10);
        if (recent.length === 0) {
            return '  (none)';
        }

        return recent.map(corr => {
            const eventSummary = corr.events.length === 0
                ? 'no events'
                : corr.events.map(e => {
                    const dur = e.durationMs ? ` (${e.durationMs.toFixed(1)}ms)` : '';
                    return `${e.eventType}${dur}`;
                }).join(', ');

            const idleSummary = `idle=${corr.idleBreakdown.totalMs.toFixed(1)}ms ` +
                `(raf=${corr.idleBreakdown.rafWaitMs.toFixed(1)}, ` +
                `yield=${corr.idleBreakdown.yieldMs.toFixed(1)}, ` +
                `hlt=${corr.idleBreakdown.hltMs.toFixed(1)})`;

            return `  Frame ${corr.frameNumber}: ${corr.frameMs.toFixed(2)}ms — ${eventSummary}, ${idleSummary}`;
        }).join('\n');
    }
}

export const frameVarianceDiagnostics = new FrameVarianceDiagnostics();
