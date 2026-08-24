import { afterEach, describe, expect, test } from "bun:test";
import { PersistentRangeStore } from "../../src/worker/runtime/filesystem/persistent-range-store";

class FakeFile {
    bytes = new Uint8Array(0);
}

class FakeSyncHandle {
    constructor(private file: FakeFile) {}
    getSize(): number { return this.file.bytes.byteLength; }
    truncate(size: number): void {
        const next = new Uint8Array(size);
        next.set(this.file.bytes.subarray(0, size));
        this.file.bytes = next;
    }
    read(target: Uint8Array, options?: { at?: number }): number {
        const at = options?.at ?? 0;
        const n = Math.max(0, Math.min(target.byteLength, this.file.bytes.byteLength - at));
        target.set(this.file.bytes.subarray(at, at + n));
        return n;
    }
    write(source: Uint8Array, options?: { at?: number }): number {
        const at = options?.at ?? 0;
        if (at + source.byteLength > this.file.bytes.byteLength) this.truncate(at + source.byteLength);
        this.file.bytes.set(source, at);
        return source.byteLength;
    }
    flush(): void {}
    close(): void {}
}

class FakeFileHandle {
    kind = "file" as const;
    constructor(public name: string, private file: FakeFile, private files: Map<string, FakeFile>) {}
    async createSyncAccessHandle(): Promise<FakeSyncHandle> { return new FakeSyncHandle(this.file); }
    async move(name: string): Promise<void> {
        this.files.delete(this.name);
        this.files.set(name, this.file);
        this.name = name;
    }
}

class FakeDirectory {
    kind = "directory" as const;
    files = new Map<string, FakeFile>();
    dirs = new Map<string, FakeDirectory>();
    async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FakeDirectory> {
        let dir = this.dirs.get(name);
        if (!dir && options?.create) { dir = new FakeDirectory(); this.dirs.set(name, dir); }
        if (!dir) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
        return dir;
    }
    async getFileHandle(name: string, options?: { create?: boolean }): Promise<FakeFileHandle> {
        let file = this.files.get(name);
        if (!file && options?.create) { file = new FakeFile(); this.files.set(name, file); }
        if (!file) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
        return new FakeFileHandle(name, file, this.files);
    }
    async removeEntry(name: string): Promise<void> {
        if (!this.files.delete(name) && !this.dirs.delete(name)) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
    }
}

const originalNavigator = globalThis.navigator;

function installFakeOpfs(): FakeDirectory {
    const root = new FakeDirectory();
    Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: {
            storage: {
                getDirectory: async () => root,
                estimate: async () => ({ usage: 0, quota: 10 * 1024 ** 3 }),
            },
        },
    });
    return root;
}

afterEach(() => {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
});

describe("PersistentRangeStore", () => {
    test("persists out-of-order chunks, resumes, and atomically promotes when complete", async () => {
        const root = installFakeOpfs();
        const url = "/apps/test.wgb";
        const total = 10;
        const chunk = 4;

        const first = await PersistentRangeStore.open(url, total, chunk);
        expect(first).not.toBeNull();
        await first!.writeChunk(1, new Uint8Array([5, 6, 7, 8]));
        expect(first!.progress()).toEqual({ loadedBytes: 4, totalBytes: 10, complete: false });
        first!.close();

        const resumed = await PersistentRangeStore.open(url, total, chunk);
        expect(resumed!.hasChunk(1)).toBe(true);
        expect([...resumed!.readChunk(1)!]).toEqual([5, 6, 7, 8]);
        await resumed!.writeChunk(0, new Uint8Array([1, 2, 3, 4]));
        await resumed!.writeChunk(2, new Uint8Array([9, 10]));
        expect(resumed!.progress()).toEqual({ loadedBytes: 10, totalBytes: 10, complete: true });

        const cache = await (await root.getDirectoryHandle("bottleship")).getDirectoryHandle("wgb-cache");
        expect(cache.files.has("test.wgb")).toBe(true);
        expect(cache.files.has("test.wgb.part")).toBe(false);
        expect(cache.files.has("test.wgb.part.map")).toBe(false);
        expect([...resumed!.readChunk(0)!]).toEqual([1, 2, 3, 4]);
    });

    test("declines a new local copy when browser quota is too small", async () => {
        const root = new FakeDirectory();
        Object.defineProperty(globalThis, "navigator", {
            configurable: true,
            value: {
                storage: {
                    getDirectory: async () => root,
                    estimate: async () => ({ usage: 0, quota: 64 * 1024 ** 2 }),
                },
            },
        });
        expect(await PersistentRangeStore.open("/apps/huge.wgb", 3 * 1024 ** 3, 2 * 1024 ** 2)).toBeNull();
    });
});
