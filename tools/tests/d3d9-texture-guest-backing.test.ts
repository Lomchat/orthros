import { describe, expect, test } from "bun:test";
import { TextureStore } from "../../src/worker/backends/webgpu/d3d9/d3d9-resources";

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
});
