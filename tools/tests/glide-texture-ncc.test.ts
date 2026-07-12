import { describe, expect, test } from "bun:test";
import {
    parseNccTable,
    decodeGlideTexture,
    GLIDE_TEXFMT_YIQ_422,
    GLIDE_TEXFMT_AYIQ_8422,
    estimateTextureSizeBytes,
} from "../../src/worker/backends/webgpu/glide/glide-texture-decoder";

// Build a 112-byte GuNccTable: FxU8 yRGB[16]; FxI16 iRGB[4][3]; FxI16 qRGB[4][3]; FxU32 packed[12].
function buildNccBytes(yRGB: number[], iRGB: number[], qRGB: number[]): Uint8Array {
    const bytes = new Uint8Array(112);
    const dv = new DataView(bytes.buffer);
    for (let i = 0; i < 16; i++) bytes[i] = yRGB[i] ?? 0;
    for (let i = 0; i < 12; i++) dv.setInt16(16 + i * 2, iRGB[i] ?? 0, true);
    for (let i = 0; i < 12; i++) dv.setInt16(40 + i * 2, qRGB[i] ?? 0, true);
    return bytes;
}

describe("glide NCC / YIQ texture decode", () => {
    test("size: YIQ_422 = 1 byte/texel, AYIQ_8422 = 2 bytes/texel", () => {
        expect(estimateTextureSizeBytes(8, 8, GLIDE_TEXFMT_YIQ_422)).toBe(64);
        expect(estimateTextureSizeBytes(8, 8, GLIDE_TEXFMT_AYIQ_8422)).toBe(128);
    });

    test("parseNccTable reads yRGB / iRGB / qRGB with correct offsets + signedness", () => {
        const ncc = parseNccTable(buildNccBytes(
            [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160],
            [-5, 0, 5, 1, 2, 3, 4, 5, 6, 7, 8, 9],
            [100, -100, 50, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        ));
        expect(ncc.yRGB[0]).toBe(10);
        expect(ncc.yRGB[15]).toBe(160);
        expect(ncc.iRGB[0]).toBe(-5);
        expect(ncc.iRGB[2]).toBe(5);
        expect(ncc.qRGB[1]).toBe(-100);
    });

    test("YIQ_422 texel: Y from high 4 bits, I=bits[3:2], Q=bits[1:0]; pure luminance when chroma=0", () => {
        // yRGB[5] = 128, all chroma zero. Texel with Y index 5 (5<<4 = 0x50) -> gray 128.
        const yRGB = new Array(16).fill(0);
        yRGB[5] = 128;
        const ncc = parseNccTable(buildNccBytes(yRGB, [], []));
        const tex = new Uint8Array([0x50]); // Y=5, I=0, Q=0
        const rgba = decodeGlideTexture(tex, 0, 1, 1, GLIDE_TEXFMT_YIQ_422, null, ncc);
        expect([rgba[0], rgba[1], rgba[2], rgba[3]]).toEqual([128, 128, 128, 255]);
    });

    test("YIQ_422 adds chroma offsets per I/Q index and clamps", () => {
        const yRGB = new Array(16).fill(0);
        yRGB[1] = 100; // Y index 1 -> 100
        // I index 2 -> iRGB[2*3..] = (+50, -20, 0); Q index 3 -> qRGB[3*3..] = (+10, +10, +300)
        const iRGB = new Array(12).fill(0);
        iRGB[6] = 50; iRGB[7] = -20; iRGB[8] = 0;
        const qRGB = new Array(12).fill(0);
        qRGB[9] = 10; qRGB[10] = 10; qRGB[11] = 300;
        const ncc = parseNccTable(buildNccBytes(yRGB, iRGB, qRGB));
        // texel: Y=1, I=2, Q=3 -> (1<<4)|(2<<2)|3 = 0x1b
        const tex = new Uint8Array([0x1b]);
        const rgba = decodeGlideTexture(tex, 0, 1, 1, GLIDE_TEXFMT_YIQ_422, null, ncc);
        // R = 100+50+10=160, G = 100-20+10=90, B = clamp(100+0+300)=255
        expect([rgba[0], rgba[1], rgba[2], rgba[3]]).toEqual([160, 90, 255, 255]);
    });

    test("AYIQ_8422 takes alpha from the high byte", () => {
        const yRGB = new Array(16).fill(0);
        yRGB[2] = 64;
        const ncc = parseNccTable(buildNccBytes(yRGB, [], []));
        // 16-bit LE: low byte = YIQ index (Y=2 -> 0x20), high byte = alpha (0xC0)
        const tex = new Uint8Array([0x20, 0xc0]);
        const rgba = decodeGlideTexture(tex, 0, 1, 1, GLIDE_TEXFMT_AYIQ_8422, null, ncc);
        expect([rgba[0], rgba[1], rgba[2], rgba[3]]).toEqual([64, 64, 64, 0xc0]);
    });
});
