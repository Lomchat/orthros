import { afterEach, describe, expect, test } from "bun:test";
import { d3dxLoadSurfaceFromRgba } from "../../src/worker/modules/d3d9/d3dx-bridge";
import { surfaceMeta } from "../../src/worker/modules/d3d9/resource-registry";
import { resourceToDevice } from "../../src/worker/modules/d3d9/shared-state";

const SURFACE = 0x1110;
const TEXTURE = 0x2220;

afterEach(() => {
    surfaceMeta.delete(SURFACE);
    resourceToDevice.delete(SURFACE);
});

describe("D3DX decoded image surface upload", () => {
    test("writes decoded RGBA pixels to an A8R8G8B8 surface in BGRA order", () => {
        const memory = new Uint8Array(0x200);
        let unlocks = 0;
        const device = {
            lockTexture: (texture: number, level: number) => {
                expect(texture).toBe(TEXTURE);
                expect(level).toBe(0);
                return { ptr: 0x100, pitch: 8 };
            },
            unlockTexture: () => { unlocks++; return 0; },
        };
        resourceToDevice.set(SURFACE, device as any);
        surfaceMeta.set(SURFACE, {
            format: 21,
            type: 1,
            usage: 0,
            pool: 1,
            multiSampleType: 0,
            multiSampleQuality: 0,
            width: 2,
            height: 2,
            texturePtr: TEXTURE,
            level: 0,
        });

        const rgba = new Uint8Array([
            10, 20, 30, 40,   50, 60, 70, 80,
            90, 100, 110, 120, 130, 140, 150, 160,
        ]);
        expect(d3dxLoadSurfaceFromRgba(memory, SURFACE, 0, rgba, 2, 2, 0, 0, 0)).toBe(0);
        expect(Array.from(memory.subarray(0x100, 0x110))).toEqual([
            30, 20, 10, 40,   70, 60, 50, 80,
            110, 100, 90, 120, 150, 140, 130, 160,
        ]);
        expect(unlocks).toBe(1);
    });

    test("rejects a source rectangle outside the decoded image", () => {
        const memory = new Uint8Array(0x200);
        const rect = 0x20;
        new DataView(memory.buffer).setInt32(rect + 8, 3, true);
        new DataView(memory.buffer).setInt32(rect + 12, 2, true);
        const device = { lockTexture: () => ({ ptr: 0x100, pitch: 8 }), unlockTexture: () => 0 };
        resourceToDevice.set(SURFACE, device as any);
        surfaceMeta.set(SURFACE, {
            format: 21, type: 1, usage: 0, pool: 1, multiSampleType: 0,
            multiSampleQuality: 0, width: 2, height: 2, texturePtr: TEXTURE, level: 0,
        });

        expect(d3dxLoadSurfaceFromRgba(memory, SURFACE, 0, new Uint8Array(16), 2, 2, rect, 0, 0))
            .toBe(0x8876086c);
    });
});
