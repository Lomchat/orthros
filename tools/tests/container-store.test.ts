/**
 * Stage-1 isolation harness for per-game containers (container-store.ts).
 *
 * OPFS isn't available under `bun test`, so we inject a minimal in-memory FileSystem Access fake and
 * assert the #5 invariant at the store level: each gameId gets its own container subtree, a file
 * written into game A's container is NOT visible in game B's, and list/remove behave.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
    getContainerDir,
    listContainerDirs,
    removeContainer,
} from "../../src/worker/runtime/filesystem/container-store";

// --- minimal in-memory OPFS fake -------------------------------------------------
function notFound(): Error { const e = new Error("not found"); (e as any).name = "NotFoundError"; return e; }
function typeMismatch(): Error { const e = new Error("type"); (e as any).name = "TypeMismatchError"; return e; }

class FakeFileHandle {
    kind = "file" as const;
    data = new Uint8Array(0);
    constructor(public name: string) {}
    async getFile() { return { size: this.data.length, arrayBuffer: async () => this.data.buffer, text: async () => new TextDecoder().decode(this.data) }; }
    async createWritable() {
        const self = this;
        return { async write(d: any) { self.data = typeof d === "string" ? new TextEncoder().encode(d) : new Uint8Array(d); }, async close() {}, async abort() {} };
    }
}
class FakeDirHandle {
    kind = "directory" as const;
    children = new Map<string, FakeDirHandle | FakeFileHandle>();
    constructor(public name: string) {}
    async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
        let c = this.children.get(name);
        if (!c) { if (!opts?.create) throw notFound(); c = new FakeDirHandle(name); this.children.set(name, c); }
        if (c.kind !== "directory") throw typeMismatch();
        return c as FakeDirHandle;
    }
    async getFileHandle(name: string, opts?: { create?: boolean }) {
        let c = this.children.get(name);
        if (!c) { if (!opts?.create) throw notFound(); c = new FakeFileHandle(name); this.children.set(name, c); }
        if (c.kind !== "file") throw typeMismatch();
        return c as FakeFileHandle;
    }
    async removeEntry(name: string, _opts?: { recursive?: boolean }) {
        if (!this.children.has(name)) throw notFound();
        this.children.delete(name);
    }
    async *entries() { yield* this.children.entries(); }
}

let root: FakeDirHandle;
const origNavigator = (globalThis as any).navigator;

beforeEach(() => {
    root = new FakeDirHandle("");
    (globalThis as any).navigator = { storage: { getDirectory: async () => root } };
});
afterAll(() => { (globalThis as any).navigator = origNavigator; });

async function writeFileInContainer(gameId: string, name: string, text: string) {
    const dir = await getContainerDir(gameId, true);
    const fh = await dir!.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
}

describe("container isolation (#5)", () => {
    test("each gameId gets its own container subtree", async () => {
        const a = await getContainerDir("app:re-volt", true);
        const b = await getContainerDir("gog:1207658691", true);
        expect(a).not.toBeNull();
        expect(b).not.toBeNull();
        expect(a).not.toBe(b);
    });

    test("a file written in game A's container is NOT visible in game B's", async () => {
        await writeFileInContainer("app:game-a", "registry.json", "AAA");
        const bDir = await getContainerDir("app:game-b", true);
        await expect(bDir!.getFileHandle("registry.json")).rejects.toThrow();
        // …but A still has it.
        const aDir = await getContainerDir("app:game-a", false);
        const fh = await aDir!.getFileHandle("registry.json");
        expect(await (await fh.getFile()).text()).toBe("AAA");
    });

    test("getContainerDir(create=false) returns null for an unknown game", async () => {
        expect(await getContainerDir("app:never-launched", false)).toBeNull();
    });

    test("listContainerDirs enumerates created containers", async () => {
        await getContainerDir("app:re-volt", true);
        await getContainerDir("gog:1207658691", true);
        const dirs = await listContainerDirs();
        expect(dirs.sort()).toEqual(["app-re-volt", "gog-1207658691"]);
    });

    test("removeContainer drops the whole container", async () => {
        await writeFileInContainer("app:doomed", "registry.json", "x");
        expect(await listContainerDirs()).toContain("app-doomed");
        await removeContainer("app:doomed");
        expect(await listContainerDirs()).not.toContain("app-doomed");
    });
});
