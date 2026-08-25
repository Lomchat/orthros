import { describe, expect, test } from "bun:test";
import { shouldUseDirectD3D9Presentation } from "../../src/worker/backends/webgpu/d3d9/presentation-policy";

describe("D3D9 presentation policy", () => {
    test("uses direct swapchain presentation on a normal desktop browser", () => {
        expect(shouldUseDirectD3D9Presentation(
            undefined,
            "Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36",
        )).toBe(true);
    });

    test("keeps the CPU bridge for HeadlessChrome", () => {
        expect(shouldUseDirectD3D9Presentation(
            undefined,
            "Mozilla/5.0 HeadlessChrome/150.0.0.0 Safari/537.36",
        )).toBe(false);
    });

    test("honours both explicit diagnostic overrides", () => {
        expect(shouldUseDirectD3D9Presentation(true, "HeadlessChrome/150")).toBe(true);
        expect(shouldUseDirectD3D9Presentation(false, "Chrome/150")).toBe(false);
    });
});
