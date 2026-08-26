// Unit tests for the ISO9660 / BIN+CUE disc-image reader (packages/formats/src/iso).
// Pure: builds a tiny synthetic ISO9660 image in memory (PVD + Joliet SVD +
// nested directories) and asserts layout detection, directory walking, name
// decoding, extent reads, and the raw-sector (MODE1/2352) framing. Plus a CUE
// parse covering single-bin multi-track data+audio.

import { describe, it, expect } from "bun:test";
import { BufferSource } from "@orthros/formats/unpack/source";
import {
    IsoImage,
    detectSectorLayout,
    parseIso9660,
    extractIsoToMap,
    parseCue,
    LAYOUT_ISO,
    LAYOUT_MODE1_2352,
} from "@orthros/formats/iso";

const SECTOR = 2048;
const enc = new TextEncoder();

// --- minimal ISO9660 builder ------------------------------------------------

interface BFile { name: string; data: Uint8Array; }
interface BDir { name: string; dirs: BDir[]; files: BFile[]; }

function dirRecord(name: string, lba: number, size: number, isDir: boolean, joliet: boolean): Uint8Array {
    // Special "."/".." pass name "\0"/"\x01"; otherwise encode + ";1" version.
    let nameBytes: Uint8Array;
    if (name === "\0" || name === "\x01") {
        nameBytes = enc.encode(name === "\0" ? "\0" : "\x01");
    } else if (isDir) {
        nameBytes = joliet ? utf16be(name) : enc.encode(name.toUpperCase());
    } else {
        nameBytes = joliet ? utf16be(name + ";1") : enc.encode(name.toUpperCase() + ";1");
    }
    let len = 33 + nameBytes.length;
    if (len % 2 === 1) len += 1; // pad to even
    const rec = new Uint8Array(len);
    const dv = new DataView(rec.buffer);
    rec[0] = len;
    dv.setUint32(2, lba, true); dv.setUint32(6, lba, false);     // extent LBA both-endian
    dv.setUint32(10, size, true); dv.setUint32(14, size, false); // size both-endian
    rec[25] = isDir ? 0x02 : 0x00;                                // flags
    rec[32] = nameBytes.length;
    rec.set(nameBytes, 33);
    return rec;
}

function utf16be(s: string): Uint8Array {
    const out = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        out[i * 2] = (c >> 8) & 0xff;
        out[i * 2 + 1] = c & 0xff;
    }
    return out;
}

/**
 * Lay out a directory tree into 2048-byte sectors starting at `startLba`.
 * Returns the sector image (plain ISO logical blocks) plus the root dir LBA.
 */
function buildTree(root: BDir, startLba: number, joliet: boolean): { blocks: Uint8Array[]; rootLba: number } {
    const blocks: Uint8Array[] = [];
    let nextLba = startLba;
    const alloc = () => nextLba++;

    // Allocate file extents first so directories can reference their LBAs.
    const fileLba = new Map<BFile, number>();
    const collectFiles = (d: BDir) => {
        for (const f of d.files) {
            const lba = nextLba;
            const n = Math.max(1, Math.ceil(f.data.length / SECTOR));
            nextLba += n;
            fileLba.set(f, lba);
        }
        for (const sub of d.dirs) collectFiles(sub);
    };
    // Reserve one dir-extent sector per directory up front (BFS), then files.
    const dirLba = new Map<BDir, number>();
    const assignDirs = (d: BDir) => { dirLba.set(d, alloc()); for (const sub of d.dirs) assignDirs(sub); };
    assignDirs(root);
    collectFiles(root);

    // Emit blocks for each LBA in order.
    const total = nextLba - startLba;
    const sectorData = new Map<number, Uint8Array>();

    const emitDir = (d: BDir, selfLba: number, parentLba: number) => {
        const recs: Uint8Array[] = [
            dirRecord("\0", selfLba, SECTOR, true, joliet),
            dirRecord("\x01", parentLba, SECTOR, true, joliet),
        ];
        for (const sub of d.dirs) recs.push(dirRecord(sub.name, dirLba.get(sub)!, SECTOR, true, joliet));
        for (const f of d.files) recs.push(dirRecord(f.name, fileLba.get(f)!, f.data.length, false, joliet));
        const sec = new Uint8Array(SECTOR);
        let p = 0;
        for (const r of recs) {
            if (p + r.length > SECTOR) throw new Error("test dir too big for one sector");
            sec.set(r, p); p += r.length;
        }
        sectorData.set(selfLba, sec);
    };
    const walk = (d: BDir, parentLba: number) => {
        const selfLba = dirLba.get(d)!;
        emitDir(d, selfLba, parentLba);
        for (const f of d.files) {
            const lba = fileLba.get(f)!;
            const n = Math.max(1, Math.ceil(f.data.length / SECTOR));
            const buf = new Uint8Array(n * SECTOR);
            buf.set(f.data);
            for (let i = 0; i < n; i++) sectorData.set(lba + i, buf.subarray(i * SECTOR, (i + 1) * SECTOR));
        }
        for (const sub of d.dirs) walk(sub, selfLba);
    };
    walk(root, dirLba.get(root)!);

    for (let i = 0; i < total; i++) {
        blocks.push(sectorData.get(startLba + i) ?? new Uint8Array(SECTOR));
    }
    return { blocks, rootLba: dirLba.get(root)! };
}

function volumeDescriptor(type: number, rootLba: number, rootSize: number, joliet: boolean): Uint8Array {
    const vd = new Uint8Array(SECTOR);
    vd[0] = type;
    vd.set(enc.encode("CD001"), 1);
    vd[6] = 1;
    // Volume identifier @ 40 (32 bytes).
    const vid = joliet ? utf16be("TEST") : enc.encode("TEST");
    vd.set(vid.subarray(0, 32), 40);
    if (joliet) vd.set([0x25, 0x2f, 0x45], 88); // "%/E" Joliet level 3
    // Root directory record @ 156.
    vd.set(dirRecord("\0", rootLba, rootSize, true, joliet), 156);
    return vd;
}

/** Build a plain-ISO image with both a primary and a Joliet tree. */
function buildIso(): Uint8Array {
    const tree: BDir = {
        name: "", dirs: [
            { name: "res", dirs: [], files: [{ name: "inner.bin", data: new Uint8Array([1, 2, 3, 4, 5]) }] },
        ],
        files: [
            { name: "readme.txt", data: enc.encode("hello iso world") },
            { name: "big.dat", data: new Uint8Array(SECTOR + 100).fill(0xab) },
        ],
    };

    // Trees start after the 16 system sectors + 2 VDs + 1 terminator = LBA 19.
    // Build primary first, then Joliet right after it.
    const primary = buildTree(tree, 19, false);
    const jolietStart = 19 + primary.blocks.length;
    const joliet = buildTree(tree, jolietStart, true);

    const totalSectors = jolietStart + joliet.blocks.length;
    const img = new Uint8Array(totalSectors * SECTOR);
    const put = (lba: number, b: Uint8Array) => img.set(b, lba * SECTOR);

    put(16, volumeDescriptor(1, primary.rootLba, SECTOR, false));
    put(17, volumeDescriptor(2, joliet.rootLba, SECTOR, true));
    const term = new Uint8Array(SECTOR); term[0] = 255; term.set(enc.encode("CD001"), 1);
    put(18, term);

    primary.blocks.forEach((b, i) => put(19 + i, b));
    joliet.blocks.forEach((b, i) => put(jolietStart + i, b));
    return img;
}

/** Re-frame plain logical blocks into MODE1/2352 raw sectors (data @ +16). */
function toMode1_2352(plain: Uint8Array): Uint8Array {
    const n = plain.length / SECTOR;
    const out = new Uint8Array(n * 2352);
    for (let i = 0; i < n; i++) {
        // sync pattern so a fingerprint-based detector would also recognize it
        out.set([0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x00], i * 2352);
        out.set(plain.subarray(i * SECTOR, (i + 1) * SECTOR), i * 2352 + 16);
    }
    return out;
}

describe("ISO sector layout detection", () => {
    it("detects a plain 2048-byte ISO", () => {
        const src = new BufferSource(buildIso());
        expect(detectSectorLayout(src)).toEqual(LAYOUT_ISO);
    });

    it("detects MODE1/2352 raw framing", () => {
        const src = new BufferSource(toMode1_2352(buildIso()));
        expect(detectSectorLayout(src)).toEqual(LAYOUT_MODE1_2352);
    });

    it("returns null for non-ISO data", () => {
        expect(detectSectorLayout(new BufferSource(new Uint8Array(40000)))).toBeNull();
    });
});

describe("ISO9660 directory walk", () => {
    it("walks the Joliet tree and reads file extents", () => {
        const image = IsoImage.mount(new BufferSource(buildIso()));
        const fs = parseIso9660(image);
        expect(fs.joliet).toBe(true);
        const paths = fs.files.map((f) => f.path).sort();
        expect(paths).toEqual(["big.dat", "readme.txt", "res/inner.bin"]);

        const map = extractIsoToMap(image);
        expect(new TextDecoder().decode(map.get("readme.txt")!)).toBe("hello iso world");
        expect(Array.from(map.get("res/inner.bin")!)).toEqual([1, 2, 3, 4, 5]);
        // multi-sector file trimmed exactly to its declared size
        expect(map.get("big.dat")!.length).toBe(SECTOR + 100);
        expect(map.get("big.dat")!.every((b) => b === 0xab)).toBe(true);
    });

    it("reads identical bytes through MODE1/2352 framing", () => {
        const image = IsoImage.mount(new BufferSource(toMode1_2352(buildIso())));
        const map = extractIsoToMap(image);
        expect(new TextDecoder().decode(map.get("readme.txt")!)).toBe("hello iso world");
        expect(map.get("big.dat")!.length).toBe(SECTOR + 100);
    });

    it("streams an extent in chunks", () => {
        const image = IsoImage.mount(new BufferSource(buildIso()));
        const entry = parseIso9660(image).files.find((f) => f.path === "big.dat")!;
        const chunks: number[] = [];
        let total = 0;
        image.readExtentChunked(entry.lba, entry.size, (c) => { chunks.push(c.length); total += c.length; }, 1);
        expect(total).toBe(entry.size);
        expect(chunks.length).toBe(2); // 2148 bytes over 1-block (2048) chunks
    });
});

describe("CUE parsing", () => {
    it("finds the data track in a single-bin data+audio sheet", () => {
        const cue = [
            'FILE "game.bin" BINARY',
            "  TRACK 01 MODE1/2352",
            "    INDEX 01 00:00:00",
            "  TRACK 02 AUDIO",
            "    INDEX 00 55:58:00",
            "    INDEX 01 55:60:00",
        ].join("\n");
        const sheet = parseCue(cue);
        expect(sheet.files).toEqual(["game.bin"]);
        expect(sheet.tracks.length).toBe(2);
        expect(sheet.dataTrack?.number).toBe(1);
        expect(sheet.dataTrack?.layout).toEqual(LAYOUT_MODE1_2352);
        expect(sheet.dataTrack?.byteOffsetInFile).toBe(0);
    });

    it("computes a track byte offset from INDEX 01 for plain ISO mode", () => {
        const cue = [
            'FILE "disc.bin" BINARY',
            "  TRACK 01 MODE1/2048",
            "    INDEX 01 00:00:02", // 2 frames in
        ].join("\n");
        const sheet = parseCue(cue);
        expect(sheet.dataTrack?.layout).toEqual(LAYOUT_ISO);
        expect(sheet.dataTrack?.byteOffsetInFile).toBe(2 * 2048);
    });

    it("normalizes a windows-path FILE reference to a basename", () => {
        const sheet = parseCue('FILE "C:\\dump\\game.bin" BINARY\n  TRACK 01 MODE2/2352\n    INDEX 01 00:00:00');
        expect(sheet.files).toEqual(["game.bin"]);
    });
});
