/**
 * Worker-side GPU stats overlay.
 * Collects frame metrics and renders to an OffscreenCanvas (160×90)
 * that gets composited into the WebGPU present pass at top-right.
 */

const HISTORY_SIZE = 300;
const SPARKLINE_SAMPLES = 90;
const CANVAS_W = 160;
const CANVAS_H = 90;
const REDRAW_INTERVAL_MS = 100; // ~10 redraws/sec

class StatsOverlay {
    private enabled = false;
    private canvas: OffscreenCanvas | null = null;
    private ctx: OffscreenCanvasRenderingContext2D | null = null;
    private dirty = false;

    // Circular buffer of frame times (ms)
    private frameTimes = new Float64Array(HISTORY_SIZE);
    private frameIdx = 0;
    private frameCount = 0;

    // Sparkline FPS history (downsampled)
    private sparkline = new Float64Array(SPARKLINE_SAMPLES);
    private sparklineIdx = 0;
    private sparklineCount = 0;

    // Throttle redraws
    private lastRedrawTime = 0;

    // Cached sort buffer (avoid alloc per percentile calc)
    private sortBuf = new Float64Array(HISTORY_SIZE);

    setEnabled(on: boolean): void {
        this.enabled = on;
        if (on && !this.canvas) {
            this.canvas = new OffscreenCanvas(CANVAS_W, CANVAS_H);
            this.ctx = this.canvas.getContext("2d");
            this.dirty = true;
        }
        if (!on) {
            this.dirty = false;
        }
    }

    isEnabled(): boolean {
        return this.enabled;
    }

    getCanvas(): OffscreenCanvas | null {
        return this.canvas;
    }

    isDirty(): boolean {
        return this.dirty;
    }

    clearDirty(): void {
        this.dirty = false;
    }

    /**
     * Called once per present with the frame duration in ms.
     */
    updateMetrics(frameMs: number): void {
        if (!this.enabled) return;

        // Push to circular buffer
        this.frameTimes[this.frameIdx] = frameMs;
        this.frameIdx = (this.frameIdx + 1) % HISTORY_SIZE;
        if (this.frameCount < HISTORY_SIZE) this.frameCount++;

        // Push to sparkline (one entry per call — most recent SPARKLINE_SAMPLES)
        const fps = frameMs > 0 ? 1000 / frameMs : 0;
        this.sparkline[this.sparklineIdx] = fps;
        this.sparklineIdx = (this.sparklineIdx + 1) % SPARKLINE_SAMPLES;
        if (this.sparklineCount < SPARKLINE_SAMPLES) this.sparklineCount++;

        // Throttle canvas redraws
        const now = performance.now();
        if (now - this.lastRedrawTime >= REDRAW_INTERVAL_MS) {
            this.lastRedrawTime = now;
            this.redraw();
        }
    }

    private computeStats(): { avg: number; p99: number; p999: number } {
        const n = this.frameCount;
        if (n === 0) return { avg: 0, p99: 0, p999: 0 };

        // Copy valid entries into sort buffer
        const buf = this.sortBuf;
        let sum = 0;
        for (let i = 0; i < n; i++) {
            const v = this.frameTimes[i];
            buf[i] = v;
            sum += v;
        }
        const avg = sum / n;

        // Sort ascending (sub-microsecond for 300 entries)
        const slice = buf.subarray(0, n);
        slice.sort();

        const p99Idx = Math.min(Math.floor(n * 0.99), n - 1);
        const p999Idx = Math.min(Math.floor(n * 0.999), n - 1);

        return {
            avg,
            p99: slice[p99Idx],
            p999: slice[p999Idx],
        };
    }

    private redraw(): void {
        const ctx = this.ctx;
        if (!ctx) return;

        const { avg, p99, p999 } = this.computeStats();
        const fpsAvg = avg > 0 ? 1000 / avg : 0;
        const fps1Low = p99 > 0 ? 1000 / p99 : 0;
        const fps01Low = p999 > 0 ? 1000 / p999 : 0;

        const W = CANVAS_W;
        const H = CANVAS_H;

        // Clear
        ctx.clearRect(0, 0, W, H);

        // Background
        ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
        ctx.roundRect(0, 0, W, H, 4);
        ctx.fill();

        // FPS color
        const fpsColor = fpsAvg >= 55 ? "#4ade80" : fpsAvg >= 30 ? "#facc15" : "#f87171";

        // Row 1: FPS + frame time
        ctx.font = "bold 13px monospace";
        ctx.fillStyle = "#94a3b8";
        ctx.fillText("FPS", 6, 16);
        ctx.fillStyle = fpsColor;
        ctx.font = "bold 15px monospace";
        ctx.fillText(Math.round(fpsAvg).toString(), 38, 16);

        ctx.fillStyle = "#94a3b8";
        ctx.font = "11px monospace";
        ctx.fillText("ft", 80, 16);
        ctx.fillStyle = "#e2e8f0";
        ctx.fillText(avg.toFixed(1) + "ms", 96, 16);

        // Row 2: 1% low + 0.1% low
        ctx.fillStyle = "#94a3b8";
        ctx.font = "11px monospace";
        ctx.fillText("1%", 6, 32);
        ctx.fillStyle = fps1Low >= 30 ? "#86efac" : "#fca5a5";
        ctx.fillText(Math.round(fps1Low).toString(), 26, 32);

        ctx.fillStyle = "#94a3b8";
        ctx.fillText("0.1%", 60, 32);
        ctx.fillStyle = fps01Low >= 20 ? "#86efac" : "#fca5a5";
        ctx.fillText(Math.round(fps01Low).toString(), 96, 32);

        // Sparkline (bottom area: y=40 to y=85)
        const sparkH = 45;
        const sparkY = H - sparkH - 2;
        const n = this.sparklineCount;
        if (n < 2) {
            this.dirty = true;
            return;
        }

        // Find min/max for scaling
        let lo = Infinity, hi = -Infinity;
        for (let i = 0; i < n; i++) {
            const v = this.sparkline[i];
            if (v < lo) lo = v;
            if (v > hi) hi = v;
        }
        // Ensure minimum range
        if (hi - lo < 5) {
            const mid = (hi + lo) / 2;
            lo = mid - 2.5;
            hi = mid + 2.5;
        }

        const range = hi - lo;
        const stepX = (W - 12) / (SPARKLINE_SAMPLES - 1);

        // Draw sparkline fill
        ctx.beginPath();
        const startIdx = (this.sparklineIdx - n + SPARKLINE_SAMPLES) % SPARKLINE_SAMPLES;
        for (let i = 0; i < n; i++) {
            const idx = (startIdx + i) % SPARKLINE_SAMPLES;
            const x = 6 + i * stepX;
            const y = sparkY + sparkH - ((this.sparkline[idx] - lo) / range) * sparkH;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        // Close fill area
        ctx.lineTo(6 + (n - 1) * stepX, sparkY + sparkH);
        ctx.lineTo(6, sparkY + sparkH);
        ctx.closePath();

        const grad = ctx.createLinearGradient(0, sparkY, 0, sparkY + sparkH);
        grad.addColorStop(0, "rgba(74, 222, 128, 0.3)");
        grad.addColorStop(1, "rgba(74, 222, 128, 0.02)");
        ctx.fillStyle = grad;
        ctx.fill();

        // Draw sparkline stroke
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
            const idx = (startIdx + i) % SPARKLINE_SAMPLES;
            const x = 6 + i * stepX;
            const y = sparkY + sparkH - ((this.sparkline[idx] - lo) / range) * sparkH;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = fpsColor;
        ctx.lineWidth = 1.5;
        ctx.stroke();

        this.dirty = true;
    }
}

export const statsOverlay = new StatsOverlay();
