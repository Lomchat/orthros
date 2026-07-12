/**
 * ROM underlay for sparse/stale overlay files (overlay EOF < ROM size).
 * GTA III: a partial models/txd.img in OPFS shadowed the baked ROM cache →
 * ReadFile at txd offsets returned 0 bytes and the loader spun forever.
 *
 * Equal-size overlay+ROM (e.g. engine.ini) must NOT use underlay merge — that
 * path previously padded reads to the request length and broke ReadFile loops.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { VirtualFileSystem } from "../../src/worker/runtime/filesystem/vfs";
import type { ZipArchive, ZipEntry } from "@bottleship/formats/zip";

function romFile(name: string, size: number): [string, ZipEntry] {
    return [
        name,
        { name, compressedSize: size, uncompressedSize: size, compression: 0, localHeaderOffset: 0, isDirectory: false },
    ];
}

describe("VFS ROM underlay sizing", () => {
    let vfs: VirtualFileSystem;
    beforeEach(() => {
        vfs = new VirtualFileSystem();
        vfs.mountRom(null as unknown as ZipArchive, "rom", new Map([
            romFile("models/txd.img", 100_000_000),
            romFile("engine.ini", 252),
        ]));
    });

    test("getFileSize reports ROM size when only ROM exists", () => {
        expect(vfs.getFileSize("C:\\models\\txd.img")).toBe(100_000_000);
    });

    test("getFileSize reports ROM size for rom-only engine.ini", () => {
        expect(vfs.getFileSize("C:\\engine.ini")).toBe(252);
    });

    test("fileExists finds rom-only files", () => {
        expect(vfs.fileExists("engine.ini")).toBe(true);
        expect(vfs.fileExists("C:\\missing.dat")).toBe(false);
    });
});
