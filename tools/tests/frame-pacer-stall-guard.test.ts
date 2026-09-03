import { describe, expect, test } from "bun:test";

// A Worker's requestAnimationFrame stops with its document's compositor. The
// pacer must then grant the permit from a timer, not sleep the guest forever.
describe("frame pacer stall guard", () => {
    test("a Present waiting for a permit is released by the timer when no rAF fires", async () => {
        let armed = 0;
        (globalThis as any).requestAnimationFrame = (_cb: () => void) => { armed++; return armed; };
        const { framePacer } = await import("../../src/worker/core/frame-pacer");
        framePacer.start();
        const before = framePacer.getStats();
        expect(before.running).toBe(true);
        const t0 = performance.now();
        await framePacer.waitForFrameSlot();
        const elapsed = performance.now() - t0;
        const after = framePacer.getStats();
        expect(after.rafStalls).toBe(before.rafStalls + 1);
        expect(after.waiting).toBe(false);
        // The guard waits at least 50 ms and at most a few rAF intervals.
        expect(elapsed).toBeGreaterThanOrEqual(45);
        expect(elapsed).toBeLessThan(2_000);
        framePacer.stop();
    });

    test("a firing rAF grants the permit without a stall", async () => {
        const callbacks: Array<() => void> = [];
        (globalThis as any).requestAnimationFrame = (cb: () => void) => { callbacks.push(cb); return callbacks.length; };
        const { framePacer } = await import("../../src/worker/core/frame-pacer");
        framePacer.start();
        const before = framePacer.getStats();
        const wait = framePacer.waitForFrameSlot();
        // Fire the pending rAF like the compositor would.
        expect(callbacks.length).toBeGreaterThan(0);
        callbacks.shift()!();
        await wait;
        const after = framePacer.getStats();
        expect(after.rafStalls).toBe(before.rafStalls);
        expect(after.rafTick).toBe(before.rafTick + 1);
        framePacer.stop();
    });
});
