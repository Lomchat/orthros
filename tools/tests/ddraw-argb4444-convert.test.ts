import { describe, expect, test } from "bun:test";
import { convertSurfaceToRGBA, type FormatInfo } from "../../src/worker/modules/ddraw/gpu-texture-utils";

const A4R4G4B4: FormatInfo = { flags: 0, bpp: 16, rMask: 0x0F00, gMask: 0x00F0, bMask: 0x000F, aMask: 0xF000 };
const X4R4G4B4: FormatInfo = { flags: 0, bpp: 16, rMask: 0x0F00, gMask: 0x00F0, bMask: 0x000F, aMask: 0 };

/** Reference: each 4-bit channel expanded to 8 bits exactly, RGBA byte order. */
function reference(mem: Uint8Array, ptr: number, w: number, h: number, pitch: number, alpha: boolean): Uint8Array {
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const p = mem[ptr + y * pitch + x * 2] | (mem[ptr + y * pitch + x * 2 + 1] << 8);
        const o = (y * w + x) * 4;
        out[o] = ((p >> 8) & 0xF) * 17; out[o + 1] = ((p >> 4) & 0xF) * 17; out[o + 2] = (p & 0xF) * 17;
        out[o + 3] = alpha ? ((p >> 12) & 0xF) * 17 : 255;
    }
    return out;
}

describe("A4R4G4B4 / X4R4G4B4 → RGBA fast path", () => {
    test("matches the exact expansion on random data with a padded pitch", () => {
        const w = 37, h = 11, pitch = 96, ptr = 64;
        const mem = new Uint8Array(ptr + pitch * h + 16);
        let seed = 12345;
        for (let i = 0; i < mem.length; i++) { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; mem[i] = seed >>> 24; }
        expect(Array.from(convertSurfaceToRGBA(mem, ptr, w, h, pitch, A4R4G4B4))).toEqual(Array.from(reference(mem, ptr, w, h, pitch, true)));
        expect(Array.from(convertSurfaceToRGBA(mem, ptr, w, h, pitch, X4R4G4B4))).toEqual(Array.from(reference(mem, ptr, w, h, pitch, false)));
    });
    test("out-of-bounds rows are opaque black instead of a read past memory", () => {
        const w = 8, h = 4, pitch = 16, ptr = 0;
        const mem = new Uint8Array(pitch * 2); // only two of four rows exist
        const out = convertSurfaceToRGBA(mem, ptr, w, h, pitch, A4R4G4B4);
        const px = new Uint32Array(out.buffer, out.byteOffset, w * h);
        expect(px[w * 3]).toBe(0xFF000000);
    });
});
