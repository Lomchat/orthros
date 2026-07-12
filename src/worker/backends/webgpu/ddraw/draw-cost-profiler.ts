/**
 * Per-draw cost profiler.
 *
 * The measured spikes are `DrawPrimitiveVB×N` at ~0.5–0.6 ms per call. Before designing
 * the batch we must know WHERE that 0.6 ms goes rather than guess. This splits each draw
 * into sub-phases and accumulates them over a window:
 *
 *   resolve   handleDrawPrimitive: COM/viewport/texture/render-state resolution (pre-executor)
 *   prepare   executor.prepareDraw: GPU-resource ensure + CPU→GPU sync + pipeline + state interp
 *   vconvert  VertexConverter: marshal+transform guest verts → output layout
 *   ringup    ringBufferManager.allocateVertexData: copy converted verts into the GPU ring
 *   submit    batch decision / flushBatch / setupPipeline / draw()
 *   tail      handleDrawPrimitive: VTX-DIAG + updateFrameSnapshotOnDraw (post-executor)
 *
 * Singleton, like frameProfiler. ZERO overhead when disabled: every call site reads the
 * public `enabled` boolean first, and `now()` returns 0 when off so `add()` early-outs.
 * Measurement overhead when ON is ~12 performance.now() + 6 adds per draw (~0.1–0.2 ms/frame
 * at a few-hundred draws) — fine for a scoped A/B window, never on by default.
 *
 * Drive from the worker console: drawCostEnable() / drawCostReport() / drawCostReset().
 */

export const DRAW_COST_PHASES = [
    "resolve",
    "prepare",
    "vconvert",
    "ringup",
    "submit",
    "tail",
] as const;
export type DrawCostPhase = typeof DRAW_COST_PHASES[number];

/** Phase indices — used at call sites to avoid string lookups in the hot path. */
export const DC = {
    resolve: 0,
    prepare: 1,
    vconvert: 2,
    ringup: 3,
    submit: 4,
    tail: 5,
} as const;

const N = DRAW_COST_PHASES.length;

class DrawCostProfiler {
    /** Public so hot-path sites can branch on it without a method call. */
    enabled = false;

    private readonly sum = new Float64Array(N); // total ms per phase over the window
    private readonly max = new Float64Array(N); // worst single-draw ms per phase
    private draws = 0;
    private indexedDraws = 0;
    private windowStart = 0;

    enable(): void {
        this.reset();
        this.enabled = true;
    }

    disable(): void {
        this.enabled = false;
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    reset(): void {
        this.sum.fill(0);
        this.max.fill(0);
        this.draws = 0;
        this.indexedDraws = 0;
        this.windowStart = performance.now();
    }

    /** Phase-start timestamp. Returns 0 when disabled so add() is a no-op. */
    now(): number {
        return this.enabled ? performance.now() : 0;
    }

    /** Accumulate elapsed since `start` into phase index `phase`. */
    add(phase: number, start: number): void {
        if (!this.enabled || start === 0) return;
        const d = performance.now() - start;
        if (d > 0) {
            this.sum[phase] += d;
            if (d > this.max[phase]) this.max[phase] = d;
        }
    }

    /** Count one completed draw (call once per draw that reaches submission). */
    countDraw(indexed: boolean): void {
        if (!this.enabled) return;
        this.draws++;
        if (indexed) this.indexedDraws++;
    }

    report() {
        const draws = this.draws || 1;
        const windowMs = performance.now() - this.windowStart;
        let totalMs = 0;
        for (let i = 0; i < N; i++) totalMs += this.sum[i];

        const phases = DRAW_COST_PHASES.map((name, i) => ({
            phase: name,
            totalMs: +this.sum[i].toFixed(2),
            perDrawUs: +((this.sum[i] / draws) * 1000).toFixed(2),
            maxUs: +(this.max[i] * 1000).toFixed(2),
            pct: +((this.sum[i] / (totalMs || 1)) * 100).toFixed(1),
        })).sort((a, b) => b.totalMs - a.totalMs);

        return {
            draws: this.draws,
            indexedDraws: this.indexedDraws,
            windowMs: +windowMs.toFixed(1),
            measuredMs: +totalMs.toFixed(2),
            perDrawUs: +((totalMs / draws) * 1000).toFixed(2),
            phases,
        };
    }
}

export const drawCostProfiler = new DrawCostProfiler();
