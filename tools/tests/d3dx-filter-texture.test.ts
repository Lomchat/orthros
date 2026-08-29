import { afterEach, describe, expect, test } from "bun:test";
import { d3dxFilterTexture } from "../../src/worker/modules/d3d9/d3dx-bridge";
import { textureMeta } from "../../src/worker/modules/d3d9/resource-registry";
import { resourceToDevice } from "../../src/worker/modules/d3d9/shared-state";
import {
    D3DFMT_DXT1,
    decodeDxtToRgba,
    encodeRgbaToDxt1,
} from "../../src/worker/backends/webgpu/shared/dxt";

const TEXTURE = 0x3340;

afterEach(() => {
    textureMeta.delete(TEXTURE);
    resourceToDevice.delete(TEXTURE);
});

describe("D3DXFilterTexture", () => {
    test("returns immediately when the texture has no destination mip level", () => {
        const device = {
            getTextureLevelPixels: () => { throw new Error("single-level filtering must not read pixels"); },
            setTextureLevelPixels: () => { throw new Error("single-level filtering must not write pixels"); },
        };
        textureMeta.set(TEXTURE, { width: 256, height: 256, levels: 1, usage: 0, pool: 1, format: D3DFMT_DXT1 });
        resourceToDevice.set(TEXTURE, device as any);

        expect(d3dxFilterTexture(TEXTURE, 0xffffffff, 0xffffffff)).toBe(0);
    });

    test("accepts D3DX_DEFAULT and builds a DXT1 mip chain", () => {
        const baseRgba = new Uint8Array(4 * 4 * 4);
        for (let i = 0; i < 16; i++) baseRgba.set([240, 16, 8, 255], i * 4);
        const levels = new Map<number, { data: Uint8Array; pitch: number; width: number; height: number }>();
        const base = new Uint8Array(8);
        expect(encodeRgbaToDxt1(baseRgba, 4, 4, base)).toBe(true);
        levels.set(0, { data: base, pitch: 8, width: 4, height: 4 });
        levels.set(1, { data: new Uint8Array(8), pitch: 8, width: 2, height: 2 });
        levels.set(2, { data: new Uint8Array(8), pitch: 8, width: 1, height: 1 });

        const committed: number[] = [];
        const device = {
            getTextureLevelPixels: (_texture: number, level: number) => levels.get(level) ?? null,
            setTextureLevelPixels: (_texture: number, level: number, data: Uint8Array, pitch: number) => {
                const target = levels.get(level)!;
                expect(pitch).toBe(target.pitch);
                target.data.set(data);
                committed.push(level);
                return true;
            },
        };
        textureMeta.set(TEXTURE, { width: 4, height: 4, levels: 3, usage: 0, pool: 1, format: D3DFMT_DXT1 });
        resourceToDevice.set(TEXTURE, device as any);

        expect(d3dxFilterTexture(TEXTURE, 0xffffffff, 0xffffffff)).toBe(0);
        expect(committed).toEqual([1, 2]);
        for (const level of [1, 2]) {
            const stored = levels.get(level)!;
            const decoded = new Uint8Array(stored.width * stored.height * 4);
            decodeDxtToRgba(D3DFMT_DXT1, stored.data, stored.pitch, stored.width, stored.height, decoded);
            expect(decoded[0]).toBeGreaterThan(200);
            expect(decoded[1]).toBeLessThan(40);
            expect(decoded[2]).toBeLessThan(40);
        }
    });
});
