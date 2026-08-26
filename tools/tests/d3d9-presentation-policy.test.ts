import { describe, expect, test } from "bun:test";
import {
    d3d9PresentSourceTextureUsage,
    shouldUseDirectD3D9Presentation,
} from "../../src/worker/backends/webgpu/d3d9/presentation-policy";

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

    test("the shared framebuffer supports render, CPU copy and desktop sampling", () => {
        const bits = {
            COPY_SRC: 0x01,
            TEXTURE_BINDING: 0x04,
            RENDER_ATTACHMENT: 0x10,
        };
        const actual = d3d9PresentSourceTextureUsage(bits);
        expect(actual).toBe(0x15);
        expect(actual & bits.COPY_SRC).toBe(bits.COPY_SRC);
        expect(actual & bits.TEXTURE_BINDING).toBe(bits.TEXTURE_BINDING);
        expect(actual & bits.RENDER_ATTACHMENT).toBe(bits.RENDER_ATTACHMENT);
    });
});
