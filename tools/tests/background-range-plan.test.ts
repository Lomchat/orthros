import { describe, expect, test } from "bun:test";
import { planBackgroundSpans } from "../../src/worker/runtime/filesystem/background-range-plan";

describe("background WGB range planning", () => {
    test("coalesces a mostly-empty 64 MiB run into one transfer", () => {
        const present = new Set([2, 7]);
        expect(planBackgroundSpans(0, 32, (i) => present.has(i))).toEqual([[0, 32]]);
    });

    test("fetches only sparse missing holes from an almost-complete run", () => {
        const missing = new Set([3, 4, 18]);
        expect(planBackgroundSpans(0, 32, (i) => !missing.has(i))).toEqual([[3, 5], [18, 19]]);
    });

    test("returns no transfer for a complete run", () => {
        expect(planBackgroundSpans(32, 64, () => true)).toEqual([]);
    });
});
