/**
 * Stage-5 test: per-container save export → import round-trip (save-export.ts).
 * Uses an in-memory OPFS fake (no OPFS under bun) + the real store-only zip writer/reader.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { exportContainer, importContainer } from "../../src/worker/runtime/filesystem/save-export";
import { getContainerDir } from "../../src/worker/runtime/filesystem/container-store";

function notFound(): Error { const e = new Error("nf"); (e as any).name = "NotFoundError"; return e; }
class FakeFileHandle {
    kind = "file" as const; data = new Uint8Array(0);
    constructor(public name: string) {}
    async getFile() { const d = this.data; return { size: d.length, arrayBuffer: async () => d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) }; }
    async createWritable() { const self = this; return { async write(x: any) { self.data = x instanceof Uint8Array ? new Uint8Array(x) : new Uint8Array(x); }, async close() {}, async abort() {} }; }
}
class FakeDirHandle {
    kind = "directory" as const; children = new Map<string, FakeDirHandle | FakeFileHandle>();
    constructor(public name: string) {}
    async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
        let c = this.children.get(name);
        if (!c) { if (!opts?.create) throw notFound(); c = new FakeDirHandle(name); this.children.set(name, c); }
        return c as FakeDirHandle;
    }
    async getFileHandle(name: string, opts?: { create?: boolean }) {
        let c = this.children.get(name);
        if (!c) { if (!opts?.create) throw notFound(); c = new FakeFileHandle(name); this.children.set(name, c); }
        return c as FakeFileHandle;
    }
    async *entries() { yield* this.children.entries(); }
}

let root: FakeDirHandle;
const orig = (globalThis as any).navigator;
beforeEach(() => { root = new FakeDirHandle(""); (globalThis as any).navigator = { storage: { getDirectory: async () => root } }; });
afterAll(() => { (globalThis as any).navigator = orig; });

async function seed(gameId: string) {
    const c = await getContainerDir(gameId, true);
    const reg = await c!.getFileHandle("registry.json", { create: true });
    await (await reg.createWritable()).write(new TextEncoder().encode('{"v":2}'));
    const overlay = await c!.getDirectoryHandle("overlay", { create: true });
    const saves = await overlay.getDirectoryHandle("saves", { create: true });
    const slot = await saves.getFileHandle("slot1.sav", { create: true });
    await (await slot.createWritable()).write(new Uint8Array([1, 2, 3, 4, 5]));
}

describe("container save export/import", () => {
    test("exports the persistent layer (registry + overlay tree)", async () => {
        await seed("app:game-a");
        const zip = await exportContainer("app:game-a");
        expect(zip).not.toBeNull();
        expect(zip!.length).toBeGreaterThan(0);
    });

    test("export of an unknown game is null", async () => {
        expect(await exportContainer("app:never")).toBeNull();
    });

    test("round-trips into a different container", async () => {
        await seed("app:src");
        const zip = await exportContainer("app:src");
        const n = await importContainer("app:dst", zip!);
        expect(n).toBe(2); // registry.json + overlay/saves/slot1.sav

        const dst = await getContainerDir("app:dst", false);
        const slot = await (await (await dst!.getDirectoryHandle("overlay")).getDirectoryHandle("saves")).getFileHandle("slot1.sav");
        const bytes = new Uint8Array(await (await slot.getFile()).arrayBuffer());
        expect(Array.from(bytes)).toEqual([1, 2, 3, 4, 5]);
    });
});
