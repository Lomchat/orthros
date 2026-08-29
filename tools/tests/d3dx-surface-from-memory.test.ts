import { afterEach, describe, expect, test } from "bun:test";
import { d3dxLoadSurfaceFromMemory } from "../../src/worker/modules/d3d9/d3dx-bridge";
import { surfaceMeta } from "../../src/worker/modules/d3d9/resource-registry";
import { resourceToDevice } from "../../src/worker/modules/d3d9/shared-state";

const SURFACE = 0x1110;
const TEXTURE = 0x2220;

afterEach(() => {
    surfaceMeta.delete(SURFACE);
    resourceToDevice.delete(SURFACE);
});

describe("D3DX memory surface upload", () => {
    test("copies X8R8G8B8 through host pixels without allocating a guest LockRect", () => {
        const memory = new Uint8Array(0x400);
        const source = 0x100;
        memory.set([
            30, 20, 10, 0, 70, 60, 50, 0,
            110, 100, 90, 0, 150, 140, 130, 0,
        ], source);
        const pixels = new Uint8Array(16);
        let commits = 0;
        const device = {
            getTextureLevelPixels: () => ({ data: pixels, pitch: 8, width: 2, height: 2 }),
            setTextureLevelPixels: (_texture: number, _level: number, data: Uint8Array, pitch: number) => {
                expect(pitch).toBe(8);
                pixels.set(data);
                commits++;
                return true;
            },
            lockTexture: () => { throw new Error("host-direct upload must not LockRect"); },
        };
        resourceToDevice.set(SURFACE, device as any);
        surfaceMeta.set(SURFACE, {
            format: 21, type: 1, usage: 0, pool: 1, multiSampleType: 0,
            multiSampleQuality: 0, width: 2, height: 2, texturePtr: TEXTURE, level: 0,
        });

        expect(d3dxLoadSurfaceFromMemory(memory, SURFACE, 0, source, 22, 8, 0, 1, 0)).toBe(0);
        expect(Array.from(pixels)).toEqual([
            30, 20, 10, 255, 70, 60, 50, 255,
            110, 100, 90, 255, 150, 140, 130, 255,
        ]);
        expect(commits).toBe(1);
    });

    test("converts X8R8G8B8 into a DXT1 destination surface", () => {
        const memory = new Uint8Array(0x800);
        const source = 0x100;
        for (let i = 0; i < 16; i++) memory.set([0, 0, 255, 0], source + i * 4);
        const pixels = new Uint8Array(8);
        let commits = 0;
        const device = {
            getTextureLevelPixels: () => ({ data: pixels, pitch: 8, width: 4, height: 4 }),
            setTextureLevelPixels: (_texture: number, _level: number, data: Uint8Array, pitch: number) => {
                expect(pitch).toBe(8);
                pixels.set(data);
                commits++;
                return true;
            },
            lockTexture: () => { throw new Error("compressed upload must stay host-side"); },
        };
        resourceToDevice.set(SURFACE, device as any);
        surfaceMeta.set(SURFACE, {
            format: 0x31545844, type: 1, usage: 0, pool: 1, multiSampleType: 0,
            multiSampleQuality: 0, width: 4, height: 4, texturePtr: TEXTURE, level: 0,
        });

        expect(d3dxLoadSurfaceFromMemory(memory, SURFACE, 0, source, 22, 16, 0, 1, 0)).toBe(0);
        expect(commits).toBe(1);
        expect(pixels.some((byte) => byte !== 0)).toBe(true);
    });
});
