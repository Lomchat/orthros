import { afterEach, describe, expect, test } from 'bun:test';
import { registerFastPathD3D9Functions } from '../../src/worker/modules/d3d9/fast-path';
import { devices, resourceToDevice } from '../../src/worker/modules/d3d9/shared-state';
import { surfaceMeta } from '../../src/worker/modules/d3d9/resource-registry';

type FastHandler = (cpu: any, mem: Uint8Array, mem32: Uint32Array, view: DataView) => number | null;

function collectHandlers(): Map<string, FastHandler> {
    const handlers = new Map<string, FastHandler>();
    registerFastPathD3D9Functions({
        registerFastPath: (_dll: string, name: string, handler: FastHandler) => handlers.set(name, handler),
        registerWriteBufferFunction: () => {},
        registerShadowedWriteBufferFunction: () => {},
    });
    return handlers;
}

function stackFor(args: number[]) {
    const mem = new Uint8Array(0x1000);
    const view = new DataView(mem.buffer);
    const esp = 0x100;
    args.forEach((value, index) => view.setUint32(esp + 4 + index * 4, value, true));
    return { cpu: { reg32: new Int32Array([0, 0, 0, 0, esp]) }, mem, view };
}

afterEach(() => {
    devices.clear();
    resourceToDevice.clear();
    surfaceMeta.clear();
});

describe('D3D9 dynamic-buffer fast paths', () => {
    test('vertex lock writes the guest pointer and unlock forwards current memory', () => {
        const handlers = collectHandlers();
        const bufferPtr = 0x500;
        const outPtr = 0x300;
        let unlockedWith: Uint8Array | null = null;
        resourceToDevice.set(bufferPtr, {
            lockVertexBuffer: (ptr: number, offset: number, size: number) => {
                expect([ptr, offset, size]).toEqual([bufferPtr, 12, 48]);
                return 0x880;
            },
            unlockVertexBuffer: (_ptr: number, mem: Uint8Array) => { unlockedWith = mem; },
        } as any);

        const lock = stackFor([bufferPtr, 12, 48, outPtr, 0x2000]);
        expect(handlers.get('IDirect3DVertexBuffer9_Lock')!(lock.cpu, lock.mem, new Uint32Array(lock.mem.buffer), lock.view)).toBe(0);
        expect(lock.view.getUint32(outPtr, true)).toBe(0x880);

        const unlock = stackFor([bufferPtr]);
        expect(handlers.get('IDirect3DVertexBuffer9_Unlock')!(unlock.cpu, unlock.mem, new Uint32Array(unlock.mem.buffer), unlock.view)).toBe(0);
        expect(unlockedWith).toBe(unlock.mem);
    });

    test('index lock falls back to the diagnostic slow path on invalid resources', () => {
        const handlers = collectHandlers();
        const lock = stackFor([0xdead, 0, 0, 0x300, 0]);
        expect(handlers.get('IDirect3DIndexBuffer9_Lock')!(lock.cpu, lock.mem, new Uint32Array(lock.mem.buffer), lock.view)).toBeNull();
    });

    test('transform and surface-description reads write directly to guest memory', () => {
        const handlers = collectHandlers();
        const devicePtr = 0x600;
        devices.set(devicePtr, {
            getTransform: (state: number) => {
                expect(state).toBe(7);
                return Float32Array.from({ length: 16 }, (_, i) => i + 0.5);
            },
        } as any);

        const transform = stackFor([devicePtr, 7, 0x400]);
        expect(handlers.get('IDirect3DDevice9_GetTransform')!(transform.cpu, transform.mem, new Uint32Array(transform.mem.buffer), transform.view)).toBe(0);
        expect(transform.view.getFloat32(0x400 + 15 * 4, true)).toBe(15.5);

        const surfacePtr = 0x700;
        surfaceMeta.set(surfacePtr, {
            format: 21, type: 1, usage: 2, pool: 3,
            multiSampleType: 4, multiSampleQuality: 5, width: 1280, height: 720,
        });
        const desc = stackFor([surfacePtr, 0x500]);
        expect(handlers.get('IDirect3DSurface9_GetDesc')!(desc.cpu, desc.mem, new Uint32Array(desc.mem.buffer), desc.view)).toBe(0);
        expect(Array.from({ length: 8 }, (_, i) => desc.view.getUint32(0x500 + i * 4, true)))
            .toEqual([21, 1, 2, 3, 4, 5, 1280, 720]);
    });
});
