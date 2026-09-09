import { describe, expect, test } from "bun:test";
import { resolveStretchRects } from "../../src/worker/backends/webgpu/d3d9/stretch-rect-math";

describe("StretchRect rectangle arithmetic", () => {
    test("NULL rects copy whole surfaces, scaled to the destination", () => {
        expect(resolveStretchRects(800, 600, null, 400, 300, null))
            .toEqual({ sx: 0, sy: 0, sw: 800, sh: 600, dx: 0, dy: 0, dw: 400, dh: 300 });
    });
    test("a source rectangle outside its surface is clipped and the destination follows the scale", () => {
        expect(resolveStretchRects(100, 100, { left: -20, top: 0, right: 80, bottom: 100 }, 200, 200, { left: 0, top: 0, right: 200, bottom: 200 }))
            .toEqual({ sx: 0, sy: 0, sw: 80, sh: 100, dx: 40, dy: 0, dw: 160, dh: 200 });
    });
    test("a destination rectangle outside its surface clips the source correspondingly", () => {
        expect(resolveStretchRects(100, 100, null, 100, 100, { left: 50, top: 50, right: 150, bottom: 150 }))
            .toEqual({ sx: 0, sy: 0, sw: 50, sh: 50, dx: 50, dy: 50, dw: 50, dh: 50 });
    });
    test("empty or inverted rectangles copy nothing", () => {
        expect(resolveStretchRects(100, 100, { left: 10, top: 10, right: 10, bottom: 40 }, 100, 100, null)).toBeNull();
        expect(resolveStretchRects(100, 100, null, 100, 100, { left: 120, top: 0, right: 140, bottom: 10 })).toBeNull();
    });
});
