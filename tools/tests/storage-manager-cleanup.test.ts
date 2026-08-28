import { afterAll, describe, expect, test } from "bun:test";
import { evictPartialDownloads } from "../../src/storage-manager";

class FakeFileHandle {
    kind = "file" as const;
    constructor(public readonly size: number) {}
    async getFile() { return { size: this.size }; }
}

class FakeDirectory {
    kind = "directory" as const;
    files = new Map<string, FakeFileHandle>();
    dirs = new Map<string, FakeDirectory>();

    async getDirectoryHandle(name: string): Promise<FakeDirectory> {
        const dir = this.dirs.get(name);
        if (!dir) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
        return dir;
    }

    async removeEntry(name: string): Promise<void> {
        if (!this.files.delete(name)) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
    }

    async *entries(): AsyncGenerator<[string, FakeFileHandle | FakeDirectory]> {
        for (const entry of this.files) yield entry;
        for (const entry of this.dirs) yield entry;
    }
}

const originalNavigator = globalThis.navigator;

describe("storage manager partial cleanup", () => {
    test("removes only resumable artifacts and reports the reclaimed bytes", async () => {
        const root = new FakeDirectory();
        const orthros = new FakeDirectory();
        const cache = new FakeDirectory();
        root.dirs.set("orthros", orthros);
        orthros.dirs.set("wgb-cache", cache);
        cache.files.set("bfme.wgb", new FakeFileHandle(3_000));
        cache.files.set("bfme.wgb.part", new FakeFileHandle(2_000));
        cache.files.set("bfme.wgb.part.map", new FakeFileHandle(20));
        cache.files.set("bfme.wgb.verified-sha", new FakeFileHandle(0));

        Object.defineProperty(globalThis, "navigator", {
            configurable: true,
            value: { storage: { getDirectory: async () => root } },
        });

        expect(await evictPartialDownloads()).toEqual({
            removedFiles: 2,
            freedBytes: 2_020,
            failedFiles: 0,
        });
        expect(cache.files.has("bfme.wgb.part")).toBe(false);
        expect(cache.files.has("bfme.wgb.part.map")).toBe(false);
        expect(cache.files.has("bfme.wgb")).toBe(true);
        expect(cache.files.has("bfme.wgb.verified-sha")).toBe(true);
    });
});

afterAll(() => {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
});
