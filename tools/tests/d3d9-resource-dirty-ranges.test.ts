import { describe, expect, test } from "bun:test";
import {
    IndexBufferStore,
    VertexBufferStore,
} from "../../src/worker/backends/webgpu/d3d9/d3d9-resources";

describe("D3D9 buffer dirty ranges", () => {
    test("vertex buffers retain only the union of unlocked ranges", () => {
        const store = new VertexBufferStore(1);
        const index = store.create(0x1000, 256, 0, 32);
        const memory = new Uint8Array(512);

        expect(store.getDirtyStart(index)).toBe(0);
        expect(store.getDirtyEnd(index)).toBe(256);
        store.setDirty(index, false);

        store.lock(index, 40, 12);
        store.unlock(index, memory);
        store.lock(index, 80, 8);
        store.unlock(index, memory);

        expect(store.isDirty(index)).toBe(true);
        expect(store.getDirtyStart(index)).toBe(40);
        expect(store.getDirtyEnd(index)).toBe(88);
    });

    test("index-buffer clean and full-dirty transitions reset the range", () => {
        const store = new IndexBufferStore(1);
        const index = store.create(0x2000, 128, 16, 64);

        store.setDirty(index, false);
        expect(store.isDirty(index)).toBe(false);
        expect(store.getDirtyEnd(index)).toBe(0);

        store.setDirty(index, true);
        expect(store.getDirtyStart(index)).toBe(0);
        expect(store.getDirtyEnd(index)).toBe(128);
    });
});
