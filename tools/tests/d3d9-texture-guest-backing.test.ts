import { describe, expect, test } from "bun:test";
import {
    TextureStore,
    getD3D9TextureLockRegion,
} from "../../src/worker/backends/webgpu/d3d9/d3d9-resources";
import {
    registerSurfaceLockInlineMapping,
    syncSurfaceLockInlineTexture,
    unregisterSurfaceLockInlineTexture,
    writeSurfaceLockInlineTrampolines,
} from "../../src/worker/modules/d3d9/capture-trampolines";

describe("D3D9 transient texture guest backing", () => {
    test("keeps pixels host-side and attaches guest memory only while locked", () => {
        const store = new TextureStore();
        const index = store.create(0x1234, 2, 2, 1, 21, -1); // A8R8G8B8: 16 bytes
        const memory = new Uint8Array(0x200);

        expect(store.getGuestPtr(index)).toBe(-1);
        expect(store.lock(index)).toBeNull();

        const first = store.attachGuestBacking(index, 0x40, memory);
        expect(first).toEqual({ ptr: 0x40, pitch: 8 });
        memory.set([1, 2, 3, 4], 0x40);
        store.unlock(index, memory);
        expect(store.detachGuestBacking(index)).toBe(0x40);
        expect(store.getGuestPtr(index)).toBe(-1);
        expect(Array.from(store.getData(index)!.subarray(0, 4))).toEqual([1, 2, 3, 4]);

        const second = store.attachGuestBacking(index, 0x80, memory);
        expect(second).toEqual({ ptr: 0x80, pitch: 8 });
        expect(Array.from(memory.subarray(0x80, 0x84))).toEqual([1, 2, 3, 4]);
        store.unlock(index, memory);
        expect(store.detachGuestBacking(index)).toBe(0x80);
    });

    test("rejects overlapping or out-of-range attachments", () => {
        const store = new TextureStore();
        const index = store.create(0x5678, 4, 4, 1, 21, -1);
        const memory = new Uint8Array(0x100);

        expect(store.attachGuestBacking(index, 0xe0, memory)).toBeNull();
        expect(store.attachGuestBacking(index, 0x20, memory)).not.toBeNull();
        expect(store.attachGuestBacking(index, 0x80, memory)).toBeNull();
    });

    test("copies only a partial LockRect and can retain its lazy guest backing", () => {
        const store = new TextureStore();
        const index = store.create(0x9abc, 4, 4, 1, 21, -1);
        const memory = new Uint8Array(0x200).fill(0xee);
        const host = store.getData(index)!;
        for (let i = 0; i < host.length; i++) host[i] = i;
        const region = getD3D9TextureLockRegion(21, 4, 4, {
            left: 2, top: 1, right: 3, bottom: 2,
        })!;
        expect(region).toEqual({ offset: 24, rowBytes: 4, rows: 1 });

        expect(store.attachGuestBacking(index, 0x80, memory, region)).toEqual({ ptr: 0x80, pitch: 16 });
        expect(Array.from(memory.subarray(0x80 + 24, 0x80 + 28))).toEqual([24, 25, 26, 27]);
        expect(memory[0x80 + 23]).toBe(0xee);
        memory.set([200, 201, 202, 203], 0x80 + 24);
        memory[0x80 + 23] = 99;
        store.unlock(index, memory, region);
        expect(store.detachGuestBacking(index, true)).toBe(0x80);
        expect(Array.from(host.subarray(24, 28))).toEqual([200, 201, 202, 203]);
        expect(host[23]).toBe(23);

        // A retained pointer can be attached again; READONLY-style writeBack=false
        // leaves the authoritative host pixels unchanged.
        expect(store.attachGuestBacking(index, 0x80, memory, region)).toEqual({ ptr: 0x80, pitch: 16 });
        memory.set([1, 1, 1, 1], 0x80 + 24);
        store.unlock(index, memory, region, false);
        expect(store.detachGuestBacking(index)).toBe(0x80);
        expect(Array.from(host.subarray(24, 28))).toEqual([200, 201, 202, 203]);
    });

    test("computes block-compressed LockRect rows without copying unrelated blocks", () => {
        const dxt1 = 0x31545844;
        expect(getD3D9TextureLockRegion(dxt1, 16, 16, {
            left: 4, top: 4, right: 8, bottom: 8,
        })).toEqual({ offset: 40, rowBytes: 8, rows: 1 });
        expect(getD3D9TextureLockRegion(21, 4, 4, {
            left: 3, top: 3, right: 5, bottom: 4,
        })).toBeNull();
    });

    test("defers guest-authoritative inline writes until one host synchronization", () => {
        const memory = new Uint8Array(0x20000);
        let bump = 0x1000;
        const allocator = { alloc: (size: number) => {
            const out = bump;
            bump = (bump + size + 15) & ~15;
            return out;
        } };
        const emitted = writeSurfaceLockInlineTrampolines(allocator, () => memory, 7, 8);
        const surface = 0x700;
        const texture = 0x710;
        const guestPtr = 0x12000;
        expect(registerSurfaceLockInlineMapping(surface, texture, guestPtr, 16, 4, 4, 4)).toBe(true);
        const slot = (surface >>> 3) & 1023;
        const stateAddr = emitted.tableBase + slot * 32 + 28;
        new DataView(memory.buffer).setUint32(stateAddr, 2, true);
        memory.set([9, 8, 7, 6], guestPtr);
        const host = new Uint8Array(64);
        expect(syncSurfaceLockInlineTexture(texture, host, memory)).toBe(true);
        expect(Array.from(host.subarray(0, 4))).toEqual([9, 8, 7, 6]);
        expect(new DataView(memory.buffer).getUint32(stateAddr, true)).toBe(0);
        expect(syncSurfaceLockInlineTexture(texture, host, memory)).toBe(false);
        const collidingSurface = surface + 1024 * 8;
        const collidingTexture = texture + 0x100;
        const collidingGuest = guestPtr + 0x100;
        expect(registerSurfaceLockInlineMapping(
            collidingSurface, collidingTexture, collidingGuest, 16, 4, 4, 4,
        )).toBe(true);
        const collidingStateAddr = emitted.tableBase + (slot + 1) * 32 + 28;
        new DataView(memory.buffer).setUint32(collidingStateAddr, 2, true);
        memory.set([5, 4, 3, 2], collidingGuest);
        const collidingHost = new Uint8Array(64);
        expect(syncSurfaceLockInlineTexture(collidingTexture, collidingHost, memory)).toBe(true);
        expect(Array.from(collidingHost.subarray(0, 4))).toEqual([5, 4, 3, 2]);
        unregisterSurfaceLockInlineTexture(collidingTexture);
        unregisterSurfaceLockInlineTexture(texture);
        expect(new DataView(memory.buffer).getUint32(emitted.tableBase + slot * 32, true)).toBe(0);
    });
});
