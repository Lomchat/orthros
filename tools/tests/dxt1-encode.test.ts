import { describe, expect, test } from "bun:test";
import { D3DFMT_DXT1, D3DFMT_DXT3, D3DFMT_DXT5, decodeDxtToRgba, encodeRgbaToDxt, encodeRgbaToDxt1 } from "../../src/worker/backends/webgpu/shared/dxt";

describe("BC2/BC3 encoders", () => {
    test("BC3 round-trips a smooth alpha ramp within the interpolated palette's step", () => {
        const rgba = new Uint8Array(4 * 4 * 4);
        for (let i = 0; i < 16; i++) rgba.set([200, 40, 90, i * 17], i * 4);
        const encoded = new Uint8Array(16);
        expect(encodeRgbaToDxt(D3DFMT_DXT5, rgba, 4, 4, encoded, 16)).toBe(true);
        const decoded = new Uint8Array(rgba.length);
        decodeDxtToRgba(D3DFMT_DXT5, encoded, 16, 4, 4, decoded);
        for (let i = 0; i < 16; i++) {
            expect(Math.abs(decoded[i * 4 + 3] - rgba[i * 4 + 3])).toBeLessThanOrEqual(20);
            expect(Math.abs(decoded[i * 4] - 200)).toBeLessThanOrEqual(12);
            expect(Math.abs(decoded[i * 4 + 2] - 90)).toBeLessThanOrEqual(12);
        }
        expect(decoded[3]).toBe(0);
        expect(decoded[15 * 4 + 3]).toBe(255);
    });

    test("BC2 stores alpha at 4-bit precision and keeps the colour", () => {
        const rgba = new Uint8Array(4 * 4 * 4);
        for (let i = 0; i < 16; i++) rgba.set([10, 250, 30, i * 16 + 8], i * 4);
        const encoded = new Uint8Array(16);
        expect(encodeRgbaToDxt(D3DFMT_DXT3, rgba, 4, 4, encoded, 16)).toBe(true);
        const decoded = new Uint8Array(rgba.length);
        decodeDxtToRgba(D3DFMT_DXT3, encoded, 16, 4, 4, decoded);
        for (let i = 0; i < 16; i++) {
            expect(Math.abs(decoded[i * 4 + 3] - rgba[i * 4 + 3])).toBeLessThanOrEqual(8);
            expect(Math.abs(decoded[i * 4 + 1] - 250)).toBeLessThanOrEqual(12);
        }
    });

    test("a block whose texels share one alpha keeps it exactly in BC3", () => {
        const rgba = new Uint8Array(4 * 4 * 4);
        for (let i = 0; i < 16; i++) rgba.set([i * 16, 128, 255 - i * 16, 77], i * 4);
        const encoded = new Uint8Array(16);
        expect(encodeRgbaToDxt(D3DFMT_DXT5, rgba, 4, 4, encoded, 16)).toBe(true);
        const decoded = new Uint8Array(rgba.length);
        decodeDxtToRgba(D3DFMT_DXT5, encoded, 16, 4, 4, decoded);
        for (let i = 0; i < 16; i++) expect(decoded[i * 4 + 3]).toBe(77);
    });

    test("refuses a format without an encoder", () => {
        expect(encodeRgbaToDxt(0x15, new Uint8Array(64), 4, 4, new Uint8Array(16), 16)).toBe(false);
    });
});

describe("BC1/DXT1 encoder", () => {
    test("round-trips an opaque four-colour block with bounded channel error", () => {
        const rgba = new Uint8Array(4 * 4 * 4);
        const colours = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]];
        for (let i = 0; i < 16; i++) rgba.set([...colours[i & 3]!, 255], i * 4);
        const encoded = new Uint8Array(8);
        expect(encodeRgbaToDxt1(rgba, 4, 4, encoded)).toBe(true);
        const decoded = new Uint8Array(rgba.length);
        decodeDxtToRgba(D3DFMT_DXT1, encoded, 8, 4, 4, decoded);
        let totalError = 0;
        for (let i = 0; i < rgba.length; i += 4) {
            totalError += Math.abs(rgba[i] - decoded[i]);
            totalError += Math.abs(rgba[i + 1] - decoded[i + 1]);
            totalError += Math.abs(rgba[i + 2] - decoded[i + 2]);
            expect(decoded[i + 3]).toBe(255);
        }
        expect(totalError / (16 * 3)).toBeLessThan(130);
    });

    test("encodes a fully transparent block with selector three", () => {
        const rgba = new Uint8Array(4 * 4 * 4);
        const encoded = new Uint8Array(8);
        expect(encodeRgbaToDxt1(rgba, 4, 4, encoded)).toBe(true);
        expect(Array.from(encoded)).toEqual([0, 0, 0, 0, 255, 255, 255, 255]);
        const decoded = new Uint8Array(rgba.length);
        decodeDxtToRgba(D3DFMT_DXT1, encoded, 8, 4, 4, decoded);
        for (let i = 3; i < decoded.length; i += 4) expect(decoded[i]).toBe(0);
    });
});
