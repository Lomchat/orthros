/**
 * VFS exact-stat fast path: statEntry() + O(1) directoryExists().
 *
 * Covers the FindFirstFile/GetFileAttributes "existence check" idiom that used to
 * scan the whole ROM index per call (e.g. Morrowind probing Data Files\*.esm).
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { VirtualFileSystem } from "../../src/worker/runtime/filesystem/vfs";
import type { ZipArchive, ZipEntry } from "@bottleship/formats/zip";

function file(name: string, size: number): [string, ZipEntry] {
    return [
        name,
        { name, compressedSize: size, uncompressedSize: size, compression: 0, localHeaderOffset: 0, isDirectory: false },
    ];
}

function mountFixture(): VirtualFileSystem {
    const vfs = new VirtualFileSystem();
    const index = new Map<string, ZipEntry>([
        file("Data Files/Bloodmoon.esm", 123),
        file("Data Files/Morrowind.esm", 456),
        file("Data Files/Music/title.mp3", 789),
        file("Morrowind.exe", 1000),
    ]);
    // statEntry/directoryExists never touch archive content, so a null stub is fine.
    vfs.mountRom(null as unknown as ZipArchive, "", index);
    return vfs;
}

describe("VFS statEntry / directoryExists fast path", () => {
    let vfs: VirtualFileSystem;
    beforeEach(() => {
        vfs = mountFixture();
    });

    test("exact file is found with original-case name and size", () => {
        const e = vfs.statEntry("C:\\Data Files\\Bloodmoon.esm");
        expect(e).not.toBeNull();
        expect(e!.kind).toBe("file");
        expect(e!.name).toBe("Bloodmoon.esm");
        expect(e!.size).toBe(123);
        expect(e!.source).toBe("rom");
    });

    test("lookup is case-insensitive but preserves stored case", () => {
        const e = vfs.statEntry("C:\\data files\\BLOODMOON.ESM");
        expect(e).not.toBeNull();
        expect(e!.name).toBe("Bloodmoon.esm");
    });

    test("missing exact file returns null (cheap not-found probe)", () => {
        expect(vfs.statEntry("C:\\Data Files\\Tribunal.esm")).toBeNull();
    });

    test("top-level file resolves", () => {
        const e = vfs.statEntry("C:\\Morrowind.exe");
        expect(e!.kind).toBe("file");
        expect(e!.name).toBe("Morrowind.exe");
    });

    test("directory resolves as dir with original-case name", () => {
        const e = vfs.statEntry("C:\\Data Files");
        expect(e!.kind).toBe("dir");
        expect(e!.name).toBe("Data Files");
        const nested = vfs.statEntry("C:\\Data Files\\Music");
        expect(nested!.kind).toBe("dir");
        expect(nested!.name).toBe("Music");
    });

    test("directoryExists is true for intermediate parents, false otherwise", () => {
        expect(vfs.directoryExists("C:\\")).toBe(true);
        expect(vfs.directoryExists("C:\\Data Files")).toBe(true);
        expect(vfs.directoryExists("C:\\Data Files\\Music")).toBe(true);
        expect(vfs.directoryExists("C:\\Nope")).toBe(false);
        // A plain file must not be mistaken for a directory.
        expect(vfs.directoryExists("C:\\Morrowind.exe")).toBe(false);
        expect(vfs.directoryExists("C:\\Data Files\\Bloodmoon.esm")).toBe(false);
    });
});
