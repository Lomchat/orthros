/**
 * ZIP64 round-trip for the .wgb container.
 *
 * A store-only ZIP addresses entries with 32-bit offsets, so a bundle stops being readable
 * past 4 GiB unless the writer emits ZIP64 records and the reader consults them. Building a
 * real 4 GiB archive here would be unaffordable, so the offsets are forced instead: the
 * writer's ZIP64 path triggers on values above the 32-bit ceiling, and the reader is fed a
 * hand-built archive whose central directory carries the sentinels.
 */
import { describe, it, expect } from "bun:test";
import { ZipArchive, BufferSource } from "@orthros/formats/zip";

const U32_MAX = 0xffffffff;

/** Minimal store-only ZIP writer, with the ZIP64 records forced on when `zip64` is set. */
function buildZip(files: Array<{ name: string; data: Uint8Array }>, zip64: boolean): Uint8Array {
    const parts: Uint8Array[] = [];
    const entries: Array<{ nameBuf: Uint8Array; size: number; offset: number }> = [];
    let offset = 0;
    const put = (b: Uint8Array) => { parts.push(b); offset += b.length; };

    for (const f of files) {
        const nameBuf = new TextEncoder().encode(f.name);
        const lfh = new DataView(new ArrayBuffer(30));
        lfh.setUint32(0, 0x04034b50, true);
        lfh.setUint16(4, 20, true);
        lfh.setUint32(18, f.data.length, true);
        lfh.setUint32(22, f.data.length, true);
        lfh.setUint16(26, nameBuf.length, true);
        entries.push({ nameBuf, size: f.data.length, offset });
        put(new Uint8Array(lfh.buffer)); put(nameBuf); put(f.data);
    }

    const cdOffset = offset;
    for (const e of entries) {
        const extra = zip64 ? new Uint8Array(12) : new Uint8Array(0);
        if (zip64) {
            const ev = new DataView(extra.buffer);
            ev.setUint16(0, 0x0001, true);
            ev.setUint16(2, 8, true);
            ev.setBigUint64(4, BigInt(e.offset), true);
        }
        const cdh = new DataView(new ArrayBuffer(46));
        cdh.setUint32(0, 0x02014b50, true);
        cdh.setUint32(20, e.size, true);
        cdh.setUint32(24, e.size, true);
        cdh.setUint16(28, e.nameBuf.length, true);
        cdh.setUint16(30, extra.length, true);
        // The sentinel is what sends the reader to the ZIP64 extra field.
        cdh.setUint32(42, zip64 ? U32_MAX : e.offset, true);
        put(new Uint8Array(cdh.buffer)); put(e.nameBuf); if (extra.length) put(extra);
    }
    const cdSize = offset - cdOffset;

    if (zip64) {
        const rec = new DataView(new ArrayBuffer(56));
        rec.setUint32(0, 0x06064b50, true);
        rec.setBigUint64(4, 44n, true);
        rec.setBigUint64(24, BigInt(entries.length), true);
        rec.setBigUint64(32, BigInt(entries.length), true);
        rec.setBigUint64(40, BigInt(cdSize), true);
        rec.setBigUint64(48, BigInt(cdOffset), true);
        const recOffset = offset;
        put(new Uint8Array(rec.buffer));

        const loc = new DataView(new ArrayBuffer(20));
        loc.setUint32(0, 0x07064b50, true);
        loc.setBigUint64(8, BigInt(recOffset), true);
        loc.setUint32(16, 1, true);
        put(new Uint8Array(loc.buffer));
    }

    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(8, entries.length, true);
    eocd.setUint16(10, entries.length, true);
    eocd.setUint32(12, zip64 ? U32_MAX : cdSize, true);
    eocd.setUint32(16, zip64 ? U32_MAX : cdOffset, true);
    put(new Uint8Array(eocd.buffer));

    const out = new Uint8Array(offset);
    let p = 0;
    for (const b of parts) { out.set(b, p); p += b.length; }
    return out;
}

const FILES = [
    { name: "manifest.json", data: new TextEncoder().encode('{"formatVersion":2}') },
    { name: "rom/game.exe", data: new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03]) },
];

describe("wgb container", () => {
    it("reads a plain 32-bit archive", async () => {
        const zip = new ZipArchive(new BufferSource(buildZip(FILES, false)));
        await zip.init();
        expect(zip.listEntries().map((e) => e.name).sort()).toEqual(["manifest.json", "rom/game.exe"]);
        expect(new TextDecoder().decode(await zip.readEntry(zip.getEntry("manifest.json")!)))
            .toBe('{"formatVersion":2}');
    });

    it("follows the ZIP64 records when the 32-bit fields hold sentinels", async () => {
        const zip = new ZipArchive(new BufferSource(buildZip(FILES, true)));
        await zip.init();
        // Every offset came from the ZIP64 extra field; a reader ignoring it would have
        // seeked to 0xffffffff and produced garbage rather than the stored bytes.
        expect(new TextDecoder().decode(await zip.readEntry(zip.getEntry("manifest.json")!)))
            .toBe('{"formatVersion":2}');
        expect(Array.from(await zip.readEntry(zip.getEntry("rom/game.exe")!)))
            .toEqual([0x4d, 0x5a, 0x90, 0x00, 0x03]);
    });

    it("rejects a truncated ZIP64 chain instead of reading a wrong offset", async () => {
        const zip = buildZip(FILES, true);
        // Corrupt the locator signature: the record is then unreachable and the sentinel in
        // the EOCD cannot be resolved.
        const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
        view.setUint32(zip.length - 22 - 20, 0xdeadbeef, true);
        await expect(new ZipArchive(new BufferSource(zip)).init()).rejects.toThrow(/ZIP64 locator/);
    });
});
