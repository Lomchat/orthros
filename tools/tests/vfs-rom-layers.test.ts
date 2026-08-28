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

function bigFile(name: string, content: string): Uint8Array {
  const encodedName = new TextEncoder().encode(name);
  const payload = new TextEncoder().encode(content);
  const headerSize = 16 + 8 + encodedName.length + 1;
  const bytes = new Uint8Array(headerSize + payload.length);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("BIG4"), 0);
  view.setUint32(4, bytes.length, false);
  view.setUint32(8, 1, false);
  view.setUint32(12, headerSize, false);
  view.setUint32(16, headerSize, false);
  view.setUint32(20, payload.length, false);
  bytes.set(encodedName, 24);
  bytes.set(payload, headerSize);
  return bytes;
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

  test("falls through partial same-named BIG overlays for a requested nested file", async () => {
    const baseBytes = bigFile("Window\\IMECandidateWindow.wnd", "BASE-IME");
    const expansionBytes = bigFile("Window\\ExpansionOnly.wnd", "EXPANSION");
    const baseWindow = entry("window.big", 1, baseBytes.length);
    const expansionWindow = entry("window.big", 2, expansionBytes.length);
    const vfs = new VirtualFileSystem();

    vfs.mountRomLayers([
      { archive: archive(new Map([[1, baseBytes]])), index: new Map([[baseWindow.name, baseWindow]]) },
      { archive: archive(new Map([[2, expansionBytes]])), index: new Map([[expansionWindow.name, expansionWindow]]) },
    ], "rom");

    const requested = "C:\\Window\\IMECandidateWindow.wnd";
    expect(vfs.canMaterializeBigEntry(requested)).toBe(true);
    expect(await vfs.materializeBigEntry(requested)).toBe(true);
    const handle = vfs.openSync(requested, 0x80000000, 3);
    expect(handle).not.toBeNull();
    expect(new TextDecoder().decode(vfs.readSync(handle!, 32)!)).toBe("BASE-IME");
    expect(vfs.getFileSize(requested)).toBe(8);
  });
});
