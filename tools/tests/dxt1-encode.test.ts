import { describe, expect, test } from "bun:test";
import { D3DFMT_DXT1, decodeDxtToRgba, encodeRgbaToDxt1 } from "../../src/worker/backends/webgpu/shared/dxt";

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
