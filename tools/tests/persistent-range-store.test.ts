import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
    PersistentRangeStore,
    RangeChunkIntegrityError,
} from "../../src/worker/runtime/filesystem/persistent-range-store";
import type { WgbIntegrityManifest } from "../../src/worker/runtime/filesystem/wgb-integrity";

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

function hash(bytes: number[]): string {
    return createHash("sha256").update(Uint8Array.from(bytes)).digest("hex");
}

function integrity(): WgbIntegrityManifest {
    return {
        version: 1,
        algorithm: "sha256",
        size: 10,
        sha256: hash([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
        chunkSize: 4,
        chunks: [hash([1, 2, 3, 4]), hash([5, 6, 7, 8]), hash([9, 10])],
        segmentSize: 8,
        segments: [hash([1, 2, 3, 4, 5, 6, 7, 8]), hash([9, 10])],
    };
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

        const cache = await (await root.getDirectoryHandle("orthros")).getDirectoryHandle("wgb-cache");
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

    test("marks only SHA-256 verified chunks and promotes with a global-identity marker", async () => {
        const root = installFakeOpfs();
        const descriptor = integrity();
        const store = await PersistentRangeStore.open("/apps/test.wgb", 10, 4, descriptor);
        expect(store).not.toBeNull();

        await expect(store!.writeChunk(0, new Uint8Array([1, 2, 3, 99])))
            .rejects.toBeInstanceOf(RangeChunkIntegrityError);
        expect(store!.hasChunk(0)).toBe(false);
        expect(store!.progress().loadedBytes).toBe(0);

        await store!.writeChunk(0, new Uint8Array([1, 2, 3, 4]));
        await store!.writeChunk(1, new Uint8Array([5, 6, 7, 8]));
        await store!.writeChunk(2, new Uint8Array([9, 10]));

        const cache = await (await root.getDirectoryHandle("orthros")).getDirectoryHandle("wgb-cache");
        expect(cache.files.has(`test.wgb.verified-${descriptor.sha256}`)).toBe(true);
        expect(store!.progress().complete).toBe(true);
    });

    test("counts a foreground/background race for the same verified chunk once", async () => {
        installFakeOpfs();
        const store = await PersistentRangeStore.open("/apps/test.wgb", 10, 4, integrity());
        await Promise.all([
            store!.writeChunk(0, new Uint8Array([1, 2, 3, 4])),
            store!.writeChunk(0, new Uint8Array([1, 2, 3, 4])),
        ]);
        expect(store!.progress()).toEqual({ loadedBytes: 4, totalBytes: 10, complete: false });
    });

    test("re-hashes old partial chunks before reusing them under another global identity", async () => {
        installFakeOpfs();
        const firstIntegrity = integrity();
        const first = await PersistentRangeStore.open("/apps/test.wgb", 10, 4, firstIntegrity);
        await first!.writeChunk(0, new Uint8Array([1, 2, 3, 4]));
        first!.close();

        const changed = { ...firstIntegrity, sha256: "f".repeat(64) };
        const reopened = await PersistentRangeStore.open("/apps/test.wgb", 10, 4, changed);
        expect(reopened!.hasChunk(0)).toBe(true);
        reopened!.close();

        const incompatible = {
            ...changed,
            sha256: "e".repeat(64),
            chunks: [hash([9, 9, 9, 9]), ...changed.chunks.slice(1)],
        };
        const rejected = await PersistentRangeStore.open("/apps/test.wgb", 10, 4, incompatible);
        expect(rejected!.hasChunk(0)).toBe(false);
    });
});
