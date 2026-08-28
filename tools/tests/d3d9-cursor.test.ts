import { describe, expect, test } from "bun:test";
import {
  computeD3D9CursorBlitRect,
  premultiplyD3D9CursorRgba,
} from "../../src/worker/backends/webgpu/d3d9/d3d9-cursor";

describe("D3D9 hardware cursor helpers", () => {
  test("subtracts the hotspot and preserves a fully visible cursor", () => {
    expect(computeD3D9CursorBlitRect(100, 80, 32, 24, 4, 6, 800, 600)).toEqual({
      x: 96, y: 74, width: 32, height: 24,
      u0: 0, v0: 0, u1: 1, v1: 1,
    });
  });

  test("clips the cursor and adjusts source UVs at screen edges", () => {
    expect(computeD3D9CursorBlitRect(1, 2, 8, 4, 3, 3, 800, 600)).toEqual({
      x: 0, y: 0, width: 6, height: 3,
      u0: 0.25, v0: 0.25, u1: 1, v1: 1,
    });
    expect(computeD3D9CursorBlitRect(-20, -20, 8, 8, 0, 0, 800, 600)).toBeNull();
  });

  test("premultiplies straight D3D alpha exactly once", () => {
    const pixels = new Uint8Array([
      200, 100, 50, 128,
      1, 2, 3, 255,
      90, 80, 70, 0,
    ]);
    premultiplyD3D9CursorRgba(pixels);
    expect(Array.from(pixels)).toEqual([
      100, 50, 25, 128,
      1, 2, 3, 255,
      0, 0, 0, 0,
    ]);
  });
});
