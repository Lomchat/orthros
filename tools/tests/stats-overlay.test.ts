import { describe, expect, test } from "bun:test";
import { StatsOverlay, type StatsOverlaySnapshot } from "../../src/worker/core/stats-overlay";

describe("low-overhead stats overlay meter", () => {
    test("stays inert while disabled", () => {
        const reports: StatsOverlaySnapshot[] = [];
        let now = 0;
        const meter = new StatsOverlay((report) => reports.push(report), () => now, 1000);

        for (now = 0; now <= 2000; now += 100) meter.updateMetrics(40);

        expect(reports).toEqual([]);
    });

    test("reports the true rate from accumulated present intervals", () => {
        const reports: StatsOverlaySnapshot[] = [];
        let now = 0;
        const meter = new StatsOverlay((report) => reports.push(report), () => now, 1000);
        meter.setEnabled(true);

        meter.updateMetrics(900); // interval began before enable: deliberately ignored
        now = 1;
        meter.updateMetrics(40);
        now = 501;
        meter.updateMetrics(40);
        now = 1001;
        meter.updateMetrics(40);

        expect(reports).toHaveLength(1);
        expect(reports[0]).toEqual({ fps: 25, frameMs: 40, sampleCount: 3, windowMs: 120 });
    });

    test("resets its partial window across disable and re-enable", () => {
        const reports: StatsOverlaySnapshot[] = [];
        let now = 0;
        const meter = new StatsOverlay((report) => reports.push(report), () => now, 1000);
        meter.setEnabled(true);
        meter.updateMetrics(900);
        now = 1;
        meter.updateMetrics(100);

        now = 900;
        meter.setEnabled(false);
        meter.setEnabled(true);
        meter.updateMetrics(900);
        now = 901;
        meter.updateMetrics(50);
        now = 1901;
        meter.updateMetrics(50);

        expect(reports).toHaveLength(1);
        expect(reports[0]).toEqual({ fps: 20, frameMs: 50, sampleCount: 2, windowMs: 100 });
    });
});
