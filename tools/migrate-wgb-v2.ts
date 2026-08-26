#!/usr/bin/env bun
/**
 * migrate-wgb-v2: re-stamp a v1 WGB bundle to v2 in place — add a namespaced `gameId`, `title`, and
 * `formatVersion: 2` — WITHOUT decompressing or fully buffering the archive (bundles run to 3+ GB).
 *
 * WGB is a store-only ZIP. We only change manifest.json (which grows), which shifts every byte after
 * it, so we rewrite the archive. To stay within bounded RAM we do zip surgery streaming:
 *   1. Parse the End-Of-Central-Directory + central directory (targeted small reads).
 *   2. Read + rewrite manifest.json (small).
 *   3. Stream-copy every other entry's raw [local header + stored data] verbatim, tracking new offsets.
 *   4. Emit a fresh central directory (original records, relative-offset patched; manifest record's
 *      crc/sizes patched) + EOCD.
 * Output goes to <file>.v2.tmp then atomically renames over the original.
 *
 * Usage:
 *   bun tools/migrate-wgb-v2.ts <file.wgb> [--game-id <id>] [--dry-run] [--keep-backup]
 *   bun tools/migrate-wgb-v2.ts --dir <dir> [...]        # migrate every *.wgb in a dir
 */
import { openSync, readSync, writeSync, closeSync, fstatSync, statSync, readdirSync, renameSync, copyFileSync, existsSync, unlinkSync } from "fs";
import { join, basename } from "path";
import { inflateRawSync } from "zlib";
import { isValidGameId, slugify } from "@orthros/formats/wgb/container-id";

/**
 * Migration gameId = `app:<slug(filename)>`. The bundle FILENAME is the reliable distinct identity:
 * manifest `name` collides (demo vs full both "Starcraft") and is sometimes mislabeled, while the
 * filename is unique AND identical for the public/apps copy and its external drop-folder original (so they share one
 * save container, as intended). Override per-bundle with --game-id.
 */
function gameIdFromFilename(file: string): string {
    return `app:${slugify(basename(file).replace(/\.wgb$/i, ""))}`;
}

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

function crc32(data: Uint8Array): number {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[i] = c >>> 0; }
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) crc = t[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

function readAt(fd: number, pos: number, len: number): Buffer {
    const buf = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) {
        const n = readSync(fd, buf, got, len - got, pos + got);
        if (n <= 0) break;
        got += n;
    }
    return got === len ? buf : buf.subarray(0, got);
}

interface CenEntry {
    name: string;
    method: number;
    crc: number;
    compSize: number;
    uncompSize: number;
    localOffset: number;
    /** Raw central-directory record bytes (46 + name + extra + comment). */
    record: Buffer;
    /** Total bytes of the local entry (header + name + extra + data) in the source file. */
    localTotal: number;
}

function parseCentralDir(fd: number, size: number): { entries: CenEntry[]; cdOffset: number } {
    // EOCD lives in the last 22..(22+65535) bytes. Read a bounded tail.
    const tailLen = Math.min(size, 22 + 65535);
    const tail = readAt(fd, size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
        if (tail.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("EOCD not found — not a zip");
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);

    const cd = readAt(fd, cdOffset, cdSize);
    const entries: CenEntry[] = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
        if (cd.readUInt32LE(p) !== SIG_CEN) throw new Error(`bad central record #${i}`);
        const method = cd.readUInt16LE(p + 10);
        const crc = cd.readUInt32LE(p + 16);
        const compSize = cd.readUInt32LE(p + 20);
        const uncompSize = cd.readUInt32LE(p + 24);
        const nameLen = cd.readUInt16LE(p + 28);
        const extraLen = cd.readUInt16LE(p + 30);
        const commentLen = cd.readUInt16LE(p + 32);
        const localOffset = cd.readUInt32LE(p + 42);
        const recLen = 46 + nameLen + extraLen + commentLen;
        const record = cd.subarray(p, p + recLen);
        const name = record.subarray(46, 46 + nameLen).toString("latin1");
        entries.push({ name, method, crc, compSize, uncompSize, localOffset, record: Buffer.from(record), localTotal: 0 });
        p += recLen;
    }
    // localTotal = (next localOffset or cdOffset) - this localOffset.
    const sorted = [...entries].sort((a, b) => a.localOffset - b.localOffset);
    for (let i = 0; i < sorted.length; i++) {
        const end = i + 1 < sorted.length ? sorted[i + 1].localOffset : cdOffset;
        sorted[i].localTotal = end - sorted[i].localOffset;
    }
    return { entries, cdOffset };
}

function buildLocalHeader(name: string, crc: number, size: number): Buffer {
    const nameBytes = Buffer.from(name, "latin1");
    const h = Buffer.alloc(30 + nameBytes.length);
    h.writeUInt32LE(SIG_LOC, 0);
    h.writeUInt16LE(20, 4);   // version needed
    h.writeUInt16LE(0, 6);    // flags
    h.writeUInt16LE(0, 8);    // method = store
    h.writeUInt16LE(0, 10);   // modtime
    h.writeUInt16LE(0x21, 12);// moddate (1980-01-01)
    h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(size, 18);
    h.writeUInt32LE(size, 22);
    h.writeUInt16LE(nameBytes.length, 26);
    h.writeUInt16LE(0, 28);   // extra len
    nameBytes.copy(h, 30);
    return h;
}

const COPY_CHUNK = 8 * 1024 * 1024;
function streamCopy(srcFd: number, srcPos: number, len: number, outFd: number): void {
    const buf = Buffer.allocUnsafe(Math.min(COPY_CHUNK, len));
    let done = 0;
    while (done < len) {
        const want = Math.min(buf.length, len - done);
        const n = readSync(srcFd, buf, 0, want, srcPos + done);
        if (n <= 0) throw new Error("unexpected EOF during copy");
        writeSync(outFd, buf, 0, n);
        done += n;
    }
}

interface MigrateOpts { gameId?: string; dryRun?: boolean; keepBackup?: boolean; }

function migrate(file: string, opts: MigrateOpts): void {
    const fd = openSync(file, "r");
    let outFd = -1;
    const tmp = file + ".v2.tmp";
    try {
        const size = fstatSync(fd).size;
        const { entries } = parseCentralDir(fd, size);

        const manEntry = entries.find((e) => e.name.replace(/\\/g, "/").toLowerCase() === "manifest.json");
        if (!manEntry) throw new Error("manifest.json not found in bundle");

        // Read + parse manifest (data starts after its local header). Some bundles deflate it —
        // inflate to read; we always re-emit it STORED.
        const lh = readAt(fd, manEntry.localOffset, 30);
        const lhNameLen = lh.readUInt16LE(26);
        const lhExtraLen = lh.readUInt16LE(28);
        const dataPos = manEntry.localOffset + 30 + lhNameLen + lhExtraLen;
        const raw = readAt(fd, dataPos, manEntry.compSize);
        let manBytes: Buffer;
        if (manEntry.method === 0) manBytes = raw;
        else if (manEntry.method === 8) manBytes = inflateRawSync(raw);
        else throw new Error(`manifest.json unsupported compression method ${manEntry.method}`);
        const manifest = JSON.parse(manBytes.toString("utf8"));

        if (manifest.formatVersion >= 2 && isValidGameId(manifest.gameId)) {
            console.log(`  • ${file}  already v2 (gameId=${manifest.gameId}) — skipped`);
            return;
        }

        const gameId = opts.gameId ?? gameIdFromFilename(file);
        if (!isValidGameId(gameId)) throw new Error(`resolved gameId "${gameId}" is invalid`);
        manifest.formatVersion = 2;
        manifest.gameId = gameId;
        if (!manifest.title && manifest.name) manifest.title = manifest.name;

        const newManBytes = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
        const newCrc = crc32(newManBytes);

        console.log(`  • ${file}\n      name="${manifest.name}" → gameId="${gameId}" (manifest ${manEntry.uncompSize}→${newManBytes.length}B)`);
        if (opts.dryRun) return;

        outFd = openSync(tmp, "w");

        // 1) Write all entries in original local order, substituting the manifest's local entry.
        const ordered = [...entries].sort((a, b) => a.localOffset - b.localOffset);
        const newLocalOffset = new Map<CenEntry, number>();
        let cursor = 0;
        for (const e of ordered) {
            newLocalOffset.set(e, cursor);
            if (e === manEntry) {
                const header = buildLocalHeader("manifest.json", newCrc, newManBytes.length);
                writeSync(outFd, header);
                writeSync(outFd, newManBytes);
                cursor += header.length + newManBytes.length;
            } else {
                streamCopy(fd, e.localOffset, e.localTotal, outFd);
                cursor += e.localTotal;
            }
        }

        // 2) Central directory: re-emit each record (original order) with patched relOffset; the
        //    manifest record also gets new crc + sizes.
        const cdStart = cursor;
        for (const e of entries) {
            const rec = Buffer.from(e.record);
            rec.writeUInt32LE(newLocalOffset.get(e)!, 42);
            if (e === manEntry) {
                rec.writeUInt16LE(0, 10);  // re-emitted STORED
                rec.writeUInt32LE(newCrc, 16);
                rec.writeUInt32LE(newManBytes.length, 20);
                rec.writeUInt32LE(newManBytes.length, 24);
            }
            writeSync(outFd, rec);
            cursor += rec.length;
        }
        const cdSize = cursor - cdStart;

        // 3) EOCD.
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(SIG_EOCD, 0);
        eocd.writeUInt16LE(entries.length, 8);
        eocd.writeUInt16LE(entries.length, 10);
        eocd.writeUInt32LE(cdSize, 12);
        eocd.writeUInt32LE(cdStart, 16);
        writeSync(outFd, eocd);

        closeSync(outFd); outFd = -1;
        closeSync(fd);

        if (opts.keepBackup) copyFileSync(file, file + ".v1.bak");
        renameSync(tmp, file);
        console.log(`      ✓ migrated`);
        return;
    } finally {
        try { if (outFd >= 0) closeSync(outFd); } catch { /* */ }
        try { closeSync(fd); } catch { /* already closed */ }
        try { if (existsSync(tmp) && statSync(tmp).size === 0) unlinkSync(tmp); } catch { /* */ }
    }
}

// --- CLI ---
const argv = process.argv.slice(2);
const opts: MigrateOpts = {
    dryRun: argv.includes("--dry-run"),
    keepBackup: argv.includes("--keep-backup"),
};
const gi = argv.indexOf("--game-id"); if (gi >= 0) opts.gameId = argv[gi + 1];
const di = argv.indexOf("--dir");
const targets: string[] = [];
if (di >= 0) {
    const dir = argv[di + 1];
    for (const f of readdirSync(dir)) if (f.toLowerCase().endsWith(".wgb")) targets.push(join(dir, f));
} else {
    for (const a of argv) if (a.toLowerCase().endsWith(".wgb")) targets.push(a);
}
if (targets.length === 0) { console.error("no .wgb targets (pass files or --dir <dir>)"); process.exit(1); }

console.log(`migrate-wgb-v2: ${targets.length} bundle(s)${opts.dryRun ? " [dry-run]" : ""}`);
let ok = 0, fail = 0;
for (const f of targets) {
    try { migrate(f, opts); ok++; }
    catch (e) { console.error(`  ✗ ${f}: ${(e as Error).message}`); fail++; }
}
console.log(`done: ${ok} processed, ${fail} failed`);
