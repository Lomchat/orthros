import { describe, expect, test } from "bun:test";
import { VirtualFileSystem } from "../../src/worker/runtime/filesystem/vfs";
import type { ZipArchive, ZipEntry } from "@orthros/formats/zip";

function entry(name: string, id: number, size: number): ZipEntry {
  return {
    name,
    compressedSize: size,
    uncompressedSize: size,
    compression: 0,
    localHeaderOffset: id,
    isDirectory: false,
  };
}

function archive(contents: Map<number, Uint8Array>): ZipArchive {
  return {
    readEntryRangeSync(item: ZipEntry, offset: number, length: number) {
      const bytes = contents.get(item.localHeaderOffset)!;
      return bytes.subarray(offset, Math.min(bytes.length, offset + length));
    },
    async readEntry(item: ZipEntry) {
      return contents.get(item.localHeaderOffset)!;
    },
    async readEntryRange(item: ZipEntry, offset: number, length: number) {
      const bytes = contents.get(item.localHeaderOffset)!;
      return bytes.subarray(offset, Math.min(bytes.length, offset + length));
    },
  } as unknown as ZipArchive;
}

describe("VFS layered read-only bundles", () => {
  test("keeps base-only files and lets the highest layer replace collisions", () => {
    const encoder = new TextEncoder();
    const baseOnly = entry("data/base.dat", 1, 4);
    const baseShared = entry("data/shared.dat", 2, 4);
    const expansionShared = entry("data/shared.dat", 3, 9);
    const expansionOnly = entry("data/expansion.dat", 4, 3);
    const base = archive(new Map([
      [1, encoder.encode("BASE")],
      [2, encoder.encode("OLD!")],
    ]));
    const expansion = archive(new Map([
      [3, encoder.encode("EXPANSION")],
      [4, encoder.encode("NEW")],
    ]));

    const vfs = new VirtualFileSystem();
    vfs.mountRomLayers([
      { archive: base, index: new Map([[baseOnly.name, baseOnly], [baseShared.name, baseShared]]) },
      { archive: expansion, index: new Map([[expansionShared.name, expansionShared], [expansionOnly.name, expansionOnly]]) },
    ], "rom");

    const read = (path: string, length: number) => {
      const handle = vfs.openSync(path, 0, 3);
      expect(handle).not.toBeNull();
      return new TextDecoder().decode(vfs.readSync(handle!, length));
    };

    expect(read("C:\\data\\base.dat", 4)).toBe("BASE");
    expect(read("C:\\data\\shared.dat", 9)).toBe("EXPANSION");
    expect(read("C:\\data\\expansion.dat", 3)).toBe("NEW");
    expect(vfs.getFileSize("C:\\data\\shared.dat")).toBe(9);
  });
});
