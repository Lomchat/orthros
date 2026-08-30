import { describe, expect, test } from "bun:test";
import {
    estimateTextureStorageBytes,
    type TextureMeta,
} from "../../src/worker/modules/d3d9/resource-registry";

const D3DFMT_A8R8G8B8 = 21;
const D3DFMT_DXT1 = 0x31545844;

function meta(partial: Partial<TextureMeta>): TextureMeta {
    return {
        width: 1,
        height: 1,
        levels: 1,
        usage: 0,
        pool: 1,
        format: D3DFMT_A8R8G8B8,
        ...partial,
    };
}

describe("D3D9 texture memory estimates", () => {
    test("sums every uncompressed mip", () => {
        expect(estimateTextureStorageBytes(meta({ width: 8, height: 4, levels: 4 }))).toBe(
            8 * 4 * 4 + 4 * 2 * 4 + 2 * 1 * 4 + 1 * 1 * 4,
        );
    });

    test("uses block storage for DXT and six faces for cubes", () => {
        expect(estimateTextureStorageBytes(meta({ width: 8, height: 8, levels: 2, format: D3DFMT_DXT1 }))).toBe(40);
        expect(estimateTextureStorageBytes(meta({ width: 4, height: 4, format: D3DFMT_DXT1, isCube: true }))).toBe(48);
    });
});
