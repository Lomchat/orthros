import { describe, expect, test } from "bun:test";
import {
    CPU_PRESENT_BACKOFF_AFTER,
    CPU_PRESENT_BACKOFF_BASE_MS,
    CPU_PRESENT_BACKOFF_MAX_MS,
    cpuPresentBackoffMs,
} from "../../src/worker/backends/webgpu/d3d9/presentation-policy";

describe("CPU readback presentation back-off", () => {
    test("no pause before the third consecutive timeout", () => {
        for (let n = 0; n < CPU_PRESENT_BACKOFF_AFTER; n++) expect(cpuPresentBackoffMs(n)).toBe(0);
    });

    test("pauses 30 s at the third timeout, doubling afterwards, capped at five minutes", () => {
        expect(cpuPresentBackoffMs(CPU_PRESENT_BACKOFF_AFTER)).toBe(CPU_PRESENT_BACKOFF_BASE_MS);
        expect(cpuPresentBackoffMs(CPU_PRESENT_BACKOFF_AFTER + 1)).toBe(CPU_PRESENT_BACKOFF_BASE_MS * 2);
        expect(cpuPresentBackoffMs(CPU_PRESENT_BACKOFF_AFTER + 2)).toBe(CPU_PRESENT_BACKOFF_BASE_MS * 4);
        expect(cpuPresentBackoffMs(CPU_PRESENT_BACKOFF_AFTER + 4)).toBe(CPU_PRESENT_BACKOFF_MAX_MS);
        expect(cpuPresentBackoffMs(1_000)).toBe(CPU_PRESENT_BACKOFF_MAX_MS);
    });
});
