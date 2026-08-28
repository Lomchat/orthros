import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { WgbCache } from "../../src/worker/runtime/filesystem/wgb-cache";
import type { WgbIntegrityManifest } from "../../src/worker/runtime/filesystem/wgb-integrity";

class FakeFile { constructor(public bytes = new Uint8Array(0)) {} }
class FakeSyncHandle {
    constructor(private readonly file: FakeFile) {}
    getSize() { return this.file.bytes.byteLength; }
    truncate(size: number) { const n = new Uint8Array(size); n.set(this.file.bytes.subarray(0, size)); this.file.bytes = n; }
    read(out: Uint8Array, options?: { at?: number }) {
        const at = options?.at ?? 0;
        const n = Math.max(0, Math.min(out.byteLength, this.file.bytes.byteLength - at));
        out.set(this.file.bytes.subarray(at, at + n));
        return n;
    }
    write(input: Uint8Array, options?: { at?: number }) {
        const at = options?.at ?? 0;
        if (at + input.byteLength > this.file.bytes.byteLength) this.truncate(at + input.byteLength);
        this.file.bytes.set(input, at);
        return input.byteLength;
    }
    flush() {}
    close() {}
}
class FakeFileHandle {
    kind = "file" as const;
    constructor(public name: string, private readonly file: FakeFile, private readonly files: Map<string, FakeFile>) {}
    createSyncAccessHandle() { return Promise.resolve(new FakeSyncHandle(this.file)); }
    getFile() {
        const bytes = this.file.bytes.slice();
        return Promise.resolve({ size: bytes.byteLength, arrayBuffer: () => Promise.resolve(bytes.buffer) });
    }
    async move(name: string) { this.files.delete(this.name); this.files.set(name, this.file); this.name = name; }
}
class FakeDirectory {
    kind = "directory" as const;
    files = new Map<string, FakeFile>();
    dirs = new Map<string, FakeDirectory>();
    async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        let value = this.dirs.get(name);
        if (!value && options?.create) { value = new FakeDirectory(); this.dirs.set(name, value); }
        if (!value) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
        return value;
    }
    async getFileHandle(name: string, options?: { create?: boolean }) {
        let value = this.files.get(name);
        if (!value && options?.create) { value = new FakeFile(); this.files.set(name, value); }
        if (!value) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
        return new FakeFileHandle(name, value, this.files);
    }
    async removeEntry(name: string) {
        if (!this.files.delete(name)) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
    }
    async *entries(): AsyncGenerator<[string, FakeFileHandle]> {
        for (const [name, file] of this.files) yield [name, new FakeFileHandle(name, file, this.files)];
    }
}

const originalNavigator = globalThis.navigator;
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const descriptor = (bytes: Uint8Array, chunkSize = 4): WgbIntegrityManifest => ({
    version: 1,
    algorithm: "sha256",
    size: bytes.byteLength,
    sha256: digest(bytes),
    chunkSize,
    chunks: Array.from({ length: Math.ceil(bytes.byteLength / chunkSize) }, (_, i) =>
        digest(bytes.subarray(i * chunkSize, Math.min(bytes.byteLength, (i + 1) * chunkSize)))),
    segmentSize: chunkSize,
    segments: Array.from({ length: Math.ceil(bytes.byteLength / chunkSize) }, (_, i) =>
        digest(bytes.subarray(i * chunkSize, Math.min(bytes.byteLength, (i + 1) * chunkSize)))),
});

describe("WgbCache integrity adoption", () => {
    test("verifies an existing full copy once and records its global identity", async () => {
        const root = new FakeDirectory();
        const orthros = await root.getDirectoryHandle("orthros", { create: true });
        const cache = await orthros.getDirectoryHandle("wgb-cache", { create: true });
        const bytes = new TextEncoder().encode("a valid cached WGB payload");
        cache.files.set("test.wgb", new FakeFile(bytes));
        cache.files.set("test.wgb.part", new FakeFile(new Uint8Array(64)));
        cache.files.set("test.wgb.part.map", new FakeFile(new Uint8Array(8)));
        cache.files.set("other.wgb.part", new FakeFile(new Uint8Array(32)));
        Object.defineProperty(globalThis, "navigator", {
            configurable: true,
            value: { storage: { getDirectory: async () => root } },
        });

        const integrity = descriptor(bytes);
        const source = await WgbCache.openSyncSourceForUrl("/apps/test.wgb", integrity);
        expect(source?.size).toBe(bytes.byteLength);
        expect(cache.files.has(`test.wgb.verified-${integrity.sha256}`)).toBe(true);
        expect(cache.files.has("test.wgb")).toBe(true);
        expect(cache.files.has("test.wgb.part")).toBe(false);
        expect(cache.files.has("test.wgb.part.map")).toBe(false);
        expect(cache.files.has("other.wgb.part")).toBe(true);
        WgbCache.releaseMountedSource();
    });
});

afterAll(() => {
    WgbCache.releaseMountedSource();
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
});
