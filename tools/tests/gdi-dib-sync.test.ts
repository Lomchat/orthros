import { describe, expect, test } from "bun:test";
import { copyCanvasRgbaToDib } from "../../src/worker/modules/gdi32/dib-sync";

describe("Canvas RGBA to DIB conversion", () => {
    test("compacts 24-bit BGR rows with deterministic padding", () => {
        const rgba = new Uint8ClampedArray([
            1, 2, 3, 4, 5, 6, 7, 8,
            9, 10, 11, 12, 13, 14, 15, 16,
        ]);
        const mem = new Uint8Array(32).fill(0xaa);
        copyCanvasRgbaToDib(mem, 4, rgba, 2, 2, 8, 24, true);
        expect([...mem.slice(4, 20)]).toEqual([
            3, 2, 1, 7, 6, 5, 0, 0,
            11, 10, 9, 15, 14, 13, 0, 0,
        ]);
    });

    test("reverses bottom-up 24-bit rows", () => {
        const rgba = new Uint8ClampedArray([
            1, 2, 3, 255,
            4, 5, 6, 255,
        ]);
        const mem = new Uint8Array(16).fill(0xaa);
        copyCanvasRgbaToDib(mem, 0, rgba, 1, 2, 4, 24, false);
        expect([...mem.slice(0, 8)]).toEqual([6, 5, 4, 0, 3, 2, 1, 0]);
    });

    test("swaps red and blue for aligned 32-bit DIBs", () => {
        const rgba = new Uint8ClampedArray([
            1, 2, 3, 4, 5, 6, 7, 8,
            9, 10, 11, 12, 13, 14, 15, 16,
        ]);
        const mem = new Uint8Array(24).fill(0xaa);
        copyCanvasRgbaToDib(mem, 4, rgba, 2, 2, 8, 32, false);
        expect([...mem.slice(4, 20)]).toEqual([
            11, 10, 9, 12, 15, 14, 13, 16,
            3, 2, 1, 4, 7, 6, 5, 8,
        ]);
    });
});
